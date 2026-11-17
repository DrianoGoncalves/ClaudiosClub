import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, str } from './adapters/claude/frontmatter';
import { MYCO_HOME } from './config';
import { writeAtomic } from './staff/store';

// A biblioteca do Club (`~/.myco/skills`) virou Global (`~/.claude/skills`, ver skillMigration.ts). Esta pasta só guarda
// as sobras da migração (conflitos): a leitura de uma delas segue na rota `GET /api/skills/library/<nome>`. Aqui também
// ficam o nome válido, o erro de skill, o plugin da sessão (`myco:<nome>`) e a versão das pastas para o registro de execuções.

export const LIBRARY_DIR = path.join(MYCO_HOME, 'skills');
/** Nome do plugin da sessão: o prefixo das skills (`myco:<nome>`). */
export const PLUGIN_NAME = 'myco';

export class SkillError extends Error {}

export const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED = new Set(['name', 'description']);

const skillFile = (dir: string, name: string) => path.join(dir, name, 'SKILL.md');

/** Uma skill de uma pasta da biblioteca (só leitura): nome, descrição, corpo e os outros arquivos. Sem SKILL.md, null. */
export async function readLibrarySkill(name: string, dir = LIBRARY_DIR) {
  if (!NAME.test(name)) return null;
  const file = skillFile(dir, name);
  const [text, st] = await Promise.all([fs.readFile(file, 'utf8').catch(() => null), fs.stat(file).catch(() => null)]);
  if (text === null || !st) return null;
  const fm = parseFrontmatter(text);
  const files = (await listFiles(path.join(dir, name))).filter((f) => f !== 'SKILL.md');
  return { name, description: str(fm.data.description) ?? '', body: fm.body.replace(/^\n+/, ''), files, updatedAt: st.mtime.toISOString(), extra: extraOf(fm.data) };
}

/**
 * O plugin da sessão (`myco:<nome>`): só as skills dadas (nome e pasta de origem; ver skillAccess.planSkills). Sempre apaga a
 * pasta antiga antes, mesmo sem skill: senão a sessão carregaria o plugin de uma ficha anterior. Vazio = null (nada de `--plugin-dir`).
 */
export async function buildSkillPlugin(items: Array<{ name: string; dir: string }>, target: string): Promise<{ dir: string; skills: string[] } | null> {
  await fs.rm(target, { recursive: true, force: true });
  if (!items.length) return null;
  await writeAtomic(
    path.join(target, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: PLUGIN_NAME, version: '1.0.0', description: 'Skills do Claudio’s Club para este funcionário', author: { name: 'Claudio’s Club' } }, null, 2) + '\n',
  );
  for (const s of items) await fs.cp(s.dir, path.join(target, 'skills', s.name), { recursive: true });
  return { dir: target, skills: items.map((s) => s.name) };
}

/**
 * A versão de cada skill marcada, para o registro de execuções (ver tasks.ts): sha256 (12 primeiros caracteres hex) de TODO o
 * pacote da pasta, com os caminhos relativos em ordem (com `/`) e o conteúdo de cada arquivo. A chave é a ref (`global:x`).
 * Pasta sem SKILL.md ou com erro de leitura fica de fora (um hash sem um arquivo seria uma versão falsa); não derruba as outras.
 */
export async function hashSkillFolders(entries: Array<{ key: string; dir: string }>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const { key, dir } of entries) {
    try {
      const files = (await allFiles(dir)).sort();
      if (!files.includes('SKILL.md')) continue;
      const h = createHash('sha256');
      for (const rel of files) {
        const body = await fs.readFile(path.join(dir, rel));
        h.update(`${rel}\n${body.length}\n`);
        h.update(body);
      }
      out[key] = h.digest('hex').slice(0, 12);
    } catch {
      // Sem ler a pasta inteira, não há versão: fica de fora.
    }
  }
  return out;
}

/** Todos os arquivos da pasta, em qualquer profundidade, com caminho relativo e `/` (sem limite de quantidade). */
async function allFiles(root: string, rel = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await allFiles(root, p)));
    else out.push(p);
  }
  return out;
}

/** Os campos do frontmatter que o Claudio’s Club não edita (allowed-tools, disable-model-invocation…). */
function extraOf(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([k]) => !RESERVED.has(k)));
}

async function listFiles(root: string, rel = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, p)));
    else out.push(p);
    if (out.length > 200) break;
  }
  return out;
}
