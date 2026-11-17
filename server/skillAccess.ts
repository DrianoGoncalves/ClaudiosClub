import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolAdapter } from './adapters/types';
import { parseFrontmatter, str } from './adapters/claude/frontmatter';
import { NAME } from './adapters/claude/skillWrite';

// Skills da ficha com escopo. `global:<nome>` é a Global (`~/.claude/skills`, com as da conta e as sincronizadas) e
// `project:<nome>` é a do projeto (`<projeto>/.claude/skills`). A ficha só carrega as que marca (ver planSkills).
// Nome antigo, sem prefixo, é convertido ao salvar (ver resolveLegacySkill).

export type SkillScopeName = 'global' | 'project';

export interface SkillRef {
  scope: SkillScopeName;
  name: string;
}

/** Uma skill que existe agora: o nome da pasta e onde ela está. */
export interface SkillSource {
  name: string;
  dir: string;
}

export interface KnownSkillNames {
  globalNames: string[];
  projectNames: string[];
}

/** O que a conversa faz com as skills da ficha (ver planSkills). */
export interface SkillPlan {
  /** As refs marcadas, já convertidas (nome antigo vira ref). */
  marked: string[];
  /** Nomes com `skillOverrides: off` no settings: somem do Claude Code nesta conversa. */
  off: string[];
  /** Refs que aparecem nativas (pelo nome). */
  native: string[];
  /** Skills do projeto que entram no plugin da sessão como `myco:<nome>` (sombra de uma Global de mesmo nome). */
  plugin: Array<SkillSource & { ref: string }>;
  /** Refs marcadas que existem, com a pasta e a descrição (o Codex lê o SKILL.md daí). */
  present: Array<SkillSource & { ref: string; scope: SkillScopeName; description: string }>;
  /** Refs marcadas que não existem (ou não dá para ler): a ficha avisa. */
  missing: string[];
}

const DESCRIPTION_MAX = 300;

export function formatSkillRef(scope: SkillScopeName, name: string): string {
  return `${scope}:${name}`;
}

/** A ref `global:<nome>` ou `project:<nome>`; `null` se não tem escopo ou o nome não é válido. */
export function parseSkillRef(raw: string): SkillRef | null {
  const i = raw.indexOf(':');
  if (i < 0) return null;
  const scope = raw.slice(0, i);
  const name = raw.slice(i + 1);
  if ((scope !== 'global' && scope !== 'project') || !NAME.test(name)) return null;
  return { scope, name };
}

/** Já tem escopo (ref), mesmo que o nome seja inválido: a ref não é convertida de novo. */
export const isSkillRef = (s: string): boolean => s.startsWith('global:') || s.startsWith('project:');

/** Nome antigo (sem prefixo): Global se existe lá; senão Projeto, se existe lá; senão Global (a ficha avisa que não existe). */
export function resolveLegacySkill(name: string, known: KnownSkillNames): string {
  if (known.globalNames.includes(name)) return formatSkillRef('global', name);
  if (known.projectNames.includes(name)) return formatSkillRef('project', name);
  return formatSkillRef('global', name);
}

/**
 * Converte os nomes antigos da lista (cada um vira uma ref; nenhum ganha outra). Refs já com escopo ficam como estão.
 * Repetido vira um só. `changed`: a lista mudou (para regravar só quando precisa).
 */
export function convertSkills(skills: string[], known: KnownSkillNames): { skills: string[]; changed: boolean } {
  const out: string[] = [];
  let changed = false;
  for (const s of skills) {
    const next = isSkillRef(s) ? s : resolveLegacySkill(s, known);
    if (next !== s) changed = true;
    if (out.includes(next)) {
      changed = true;
      continue;
    }
    out.push(next);
  }
  return { skills: out, changed };
}

/**
 * O que a conversa faz com as skills marcadas, dado o que existe (puro: quem chama lê as pastas). Por nome n:
 * - `global:n` marcada e existe Global → nativa; `project:n` marcada, sem Global n → nativa.
 * - `project:n` marcada e existe Global n (sombra, o Claude Code só carrega a Global) → plugin `myco:n`, da pasta do projeto.
 * - Global n existe e não está marcada → `off`. Projeto n existe sem Global, não marcado → `off`.
 * - Marcada e não existe → `missing`.
 */
export function planSkills(marked: string[], globalSkills: SkillSource[], projectSkills: SkillSource[]): SkillPlan {
  const globals = new Map<string, string>();
  for (const s of globalSkills) if (!globals.has(s.name)) globals.set(s.name, s.dir);
  // Numa worktree, a pasta do projeto vem antes da worktree: se as duas têm o nome, vale a primeira.
  const projects = new Map<string, string>();
  for (const s of projectSkills) if (!projects.has(s.name)) projects.set(s.name, s.dir);

  const wantGlobal = new Set<string>();
  const wantProject = new Set<string>();
  const refs = [...new Set(marked)];
  const present: SkillPlan['present'] = [];
  const missing: string[] = [];
  for (const raw of refs) {
    const ref = parseSkillRef(raw);
    if (!ref) {
      missing.push(raw);
      continue;
    }
    const dir = (ref.scope === 'global' ? globals : projects).get(ref.name);
    if (!dir) {
      missing.push(raw);
      continue;
    }
    (ref.scope === 'global' ? wantGlobal : wantProject).add(ref.name);
    present.push({ ref: formatSkillRef(ref.scope, ref.name), scope: ref.scope, name: ref.name, dir, description: '' });
  }

  const off: string[] = [];
  const native: string[] = [];
  const plugin: SkillPlan['plugin'] = [];
  const names = [...new Set([...globals.keys(), ...projects.keys()])].sort();
  for (const n of names) {
    const inG = globals.has(n);
    const inP = projects.has(n);
    const g = wantGlobal.has(n);
    const p = wantProject.has(n);
    if (inG && !g) off.push(n);
    if (!inG && inP && !p) off.push(n);
    if (g && inG) native.push(formatSkillRef('global', n));
    if (p && inP) {
      if (inG) plugin.push({ ref: formatSkillRef('project', n), name: n, dir: projects.get(n)! });
      else native.push(formatSkillRef('project', n));
    }
  }
  return { marked: refs, off, native, plugin, present, missing };
}

/**
 * O plano da conversa com as descrições (lidas do SKILL.md, cortadas) e os nomes antigos convertidos antes. É o que a ficha
 * e o lançamento usam.
 */
/** As skills que existem agora: a Global (conta e sincronizadas) e a do projeto, pelo adaptador. Erro de leitura sai como erro. */
export async function skillSourcesOf(
  adapter: Pick<ToolAdapter, 'getProjectInventory' | 'getUserScope'>,
  projectId: string,
): Promise<{ globalSkills: SkillSource[]; projectSkills: SkillSource[] }> {
  const [inventory, account] = await Promise.all([adapter.getProjectInventory(projectId), adapter.getUserScope()]);
  const toSource = (s: { name: string; dirPath: string }): SkillSource => ({ name: s.name, dir: s.dirPath });
  return { globalSkills: account.skills.map(toSource), projectSkills: (inventory?.skills ?? []).map(toSource) };
}

/** Os nomes que existem, para converter nome antigo (ver resolveLegacySkill). */
export function knownNamesOf(o: { globalSkills: SkillSource[]; projectSkills: SkillSource[] }): KnownSkillNames {
  return { globalNames: o.globalSkills.map((s) => s.name), projectNames: o.projectSkills.map((s) => s.name) };
}

export async function skillPlanOf(skills: string[], o: { globalSkills: SkillSource[]; projectSkills: SkillSource[] }): Promise<SkillPlan> {
  const marked = convertSkills(skills, knownNamesOf(o)).skills;
  const plan = planSkills(marked, o.globalSkills, o.projectSkills);
  const present = await Promise.all(plan.present.map(async (p) => ({ ...p, description: await describeSkill(p.dir) })));
  return { ...plan, present };
}

/** As skills de uma pasta de skills (`<root>/<nome>/SKILL.md`), com nome válido. Pasta inexistente = nenhuma. */
export async function listSkillDirs(root: string): Promise<SkillSource[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const out: SkillSource[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || !NAME.test(e.name)) continue;
    if (!(e.isDirectory() || e.isSymbolicLink())) continue;
    const dir = path.join(root, e.name);
    const isFile = await fs.stat(path.join(dir, 'SKILL.md')).then((s) => s.isFile(), () => false);
    if (isFile) out.push({ name: e.name, dir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A descrição do frontmatter, cortada. Sem SKILL.md legível, vazio. */
async function describeSkill(dir: string): Promise<string> {
  const text = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8').catch(() => null);
  if (text === null) return '';
  let raw: string | null;
  try {
    raw = str(parseFrontmatter(text).data.description);
  } catch {
    return ''; // frontmatter quebrado: a skill existe (é carregada), só não tem descrição para a lista
  }
  const desc = (raw ?? '').replace(/\s+/g, ' ').trim();
  return desc.length > DESCRIPTION_MAX ? `${desc.slice(0, DESCRIPTION_MAX - 1)}…` : desc;
}
