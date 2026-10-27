import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import { linkInfo, listDir } from './fsutil';
import { parseFrontmatter, str, strList } from './frontmatter';

// Criar e editar agents (subagents) do Claude Code: `<pasta>/.claude/agents/<nome>.md` ou
// `~/.claude/agents/<nome>.md`. O `model` do frontmatter é o que permite o padrão
// orquestrador/executores: quem chama roda num modelo grande, o agent num menor.

export class AgentError extends Error {}

export const AgentInput = z.object({
  /** Nome atual, quando é edição (o arquivo continua o mesmo, mesmo que o nome mude). */
  originalName: z.string().max(60).optional(),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,49}$/, 'nome: letras minúsculas, números e hífen (2 a 50)'),
  description: z.string().trim().min(10, 'descreva quando usar este agent (o Claude decide a delegação por aqui)').max(1_000),
  /** `null` ou ausente = o modelo de quem chama (inherit). */
  model: z
    .string()
    .regex(/^(inherit|opus|sonnet|haiku|fable|[\w.[\]-]{3,60})$/, 'modelo inválido')
    .nullable()
    .default(null),
  /** `null` = todas as ferramentas de quem chama. */
  tools: z.array(z.string().trim().regex(/^[\w*().:,\s/-]{1,120}$/, 'ferramenta inválida')).max(60).nullable().default(null),
  prompt: z.string().trim().min(1, 'escreva as instruções do agent').max(50_000),
});
export type AgentInputParsed = z.infer<typeof AgentInput>;

export interface AgentSource {
  name: string;
  description: string | null;
  model: string | null;
  tools: string[] | null;
  prompt: string;
  filePath: string;
  linked: boolean;
}

async function findByName(dir: string, name: string): Promise<string | null> {
  for (const e of await listDir(dir)) {
    if (!e.name.endsWith('.md') || !(e.isFile() || e.isSymbolicLink())) continue;
    const file = path.join(dir, e.name);
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;
    if ((str(parseFrontmatter(text).data.name) ?? e.name.slice(0, -3)) === name) return file;
  }
  return null;
}

export async function readAgentSource(dir: string, name: string): Promise<AgentSource | null> {
  const file = await findByName(dir, name);
  if (!file) return null;
  const { data, body } = parseFrontmatter(await fs.readFile(file, 'utf8'));
  const link = await linkInfo(file).catch(() => ({ kind: 'file' as const }));
  return {
    name: str(data.name) ?? name,
    description: str(data.description),
    model: str(data.model),
    tools: strList(data.tools),
    prompt: body.trim(),
    filePath: file,
    linked: link.kind !== 'file',
  };
}

/**
 * Grava o agent. Edição preserva chaves desconhecidas do frontmatter (ex.: `color`) e escreve no
 * próprio arquivo, ou no destino dele quando é vinculado (symlink): trocar o arquivo por outro
 * quebraria o vínculo. A versão anterior vai para `backupDir`.
 */
export async function saveAgent(dir: string, input: AgentInputParsed, backupDir: string): Promise<AgentSource> {
  const existing = input.originalName ? await findByName(dir, input.originalName) : null;
  if (input.originalName && !existing) throw new AgentError('agent não encontrado');
  const clash = await findByName(dir, input.name);
  if (clash && clash !== existing) throw new AgentError(`já existe um agent chamado ${input.name} aqui`);

  let data: Record<string, unknown> = {};
  if (existing) {
    const previous = await fs.readFile(existing, 'utf8');
    data = parseFrontmatter(previous).data;
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, `${input.originalName}.${new Date().toISOString().replace(/[:.]/g, '-')}.md`), previous);
  }
  data = { ...data, name: input.name, description: input.description };
  if (input.tools && input.tools.length) data.tools = input.tools.join(', ');
  else delete data.tools;
  if (input.model && input.model !== 'inherit') data.model = input.model;
  else delete data.model;

  const text = `---\n${stringify(data, { lineWidth: 0 }).trimEnd()}\n---\n\n${input.prompt.trim()}\n`;
  const target = existing ? await fs.realpath(existing) : path.join(dir, `${input.name}.md`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // No lugar (não renomeia): mantém hardlinks e o arquivo que o symlink aponta.
  await fs.writeFile(target, text, existing ? undefined : { flag: 'wx' });
  return (await readAgentSource(dir, input.name))!;
}
