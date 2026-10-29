import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { LiveSession, Session } from '../../../shared/model';
import { isInjectedUserText } from '../../chat/items';
import { listDir, readHeadTail, tryJson } from './fsutil';
import { encodeProjectDir } from './paths';

// ~/.claude/sessions/<pid>.json. Só os campos abaixo saem daqui; o resto (sockets, ids de ponte) é descartado.
const LiveFile = z.object({
  pid: z.number(),
  sessionId: z.string(),
  cwd: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  entrypoint: z.string().optional(),
  kind: z.string().optional(),
  startedAt: z.number().optional(),
  statusUpdatedAt: z.number().optional(),
});

const TranscriptLine = z.object({
  type: z.string().optional(),
  timestamp: z.string().optional(),
  entrypoint: z.string().optional(),
  version: z.string().optional(),
  gitBranch: z.string().optional(),
  customTitle: z.string().optional(),
  agentName: z.string().optional(),
  cwd: z.string().optional(),
  // Solto: um formato inesperado aqui não pode derrubar a linha inteira (data, origem, branch).
  message: z.unknown().optional(),
});
type TranscriptLine = z.infer<typeof TranscriptLine>;

const CustomTitleFile = z.object({ customTitle: z.string() });

export async function readLiveSessions(claudeHome: string): Promise<LiveSession[]> {
  const dir = path.join(claudeHome, 'sessions');
  // Os arquivos `<pid>.<hash>.key` ao lado são chaves de processo: nunca ler.
  const files = (await listDir(dir)).filter((e) => e.isFile() && /^\d+\.json$/.test(e.name));
  const sessions = await Promise.all(
    files.map(async (e): Promise<LiveSession | null> => {
      const raw = await fs.readFile(path.join(dir, e.name), 'utf8').catch(() => null);
      const parsed = raw === null ? null : LiveFile.safeParse(tryJson(raw));
      if (!parsed?.success) return null;
      const s = parsed.data;
      const alive = isPidAlive(s.pid);
      return {
        sessionId: s.sessionId,
        pid: s.pid,
        cwd: s.cwd ?? null,
        name: s.name ?? null,
        status: s.status ?? null,
        alive,
        entrypoint: s.entrypoint ?? null,
        kind: s.kind ?? null,
        startedAt: iso(s.startedAt),
        statusUpdatedAt: iso(s.statusUpdatedAt),
        activeAgents: alive && s.cwd ? await activeSubagents(claudeHome, s.cwd, s.sessionId) : [],
      };
    }),
  );
  return sessions.filter((s): s is LiveSession => s !== null);
}

/** Um subagent cujo transcript mudou há menos que isso está trabalhando. */
const ACTIVE_MS = 20_000;

/**
 * Subagents trabalhando agora para a sessão: o transcript de cada um
 * (`<sessão>/subagents/agent-*.jsonl`) foi escrito há poucos segundos. Só `stat`, sem ler conteúdo.
 */
export async function activeSubagents(claudeHome: string, cwd: string, sessionId: string, now = Date.now()): Promise<string[]> {
  const dir = path.join(claudeHome, 'projects', encodeProjectDir(path.resolve(cwd)), sessionId, 'subagents');
  const types = new Set<string>();
  for (const e of await listDir(dir)) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const st = await fs.stat(path.join(dir, e.name)).catch(() => null);
    if (!st || now - st.mtimeMs > ACTIVE_MS) continue;
    const meta = await fs.readFile(path.join(dir, e.name.replace(/\.jsonl$/, '.meta.json')), 'utf8').catch(() => null);
    const type = (tryJson(meta ?? '') as { agentType?: unknown } | null)?.agentType;
    types.add(typeof type === 'string' ? type : 'subagent');
  }
  return [...types].sort();
}

/** Lista os transcripts de uma pasta de projeto em ~/.claude/projects, do mais recente ao mais antigo. */
export async function readProjectSessions(
  projectDir: string,
  live: ReadonlyMap<string, LiveSession>,
): Promise<Session[]> {
  const files = (await listDir(projectDir)).filter((e) => e.isFile() && e.name.endsWith('.jsonl'));
  const sessions = await Promise.all(
    files.map((e) => readSession(projectDir, path.basename(e.name, '.jsonl'), live).catch(() => null)),
  );
  return sessions
    .filter((s): s is Session => s !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function readSession(
  projectDir: string,
  id: string,
  live: ReadonlyMap<string, LiveSession>,
): Promise<Session> {
  const file = path.join(projectDir, `${id}.jsonl`);
  const [stat, { head, tail }] = await Promise.all([fs.stat(file), readHeadTail(file)]);
  const headLines = head.map(parseLine);
  const tailLines = tail.map(parseLine).reverse();

  const origin = headLines.find((l) => l.entrypoint);
  const started = headLines.find((l) => l.timestamp);
  const titleLine = tailLines.find((l) => l.type === 'custom-title' && l.customTitle);
  const agentLine = tailLines.find((l) => l.type === 'agent-name' && l.agentName);
  const liveInfo = live.get(id) ?? null;

  return {
    id,
    title:
      (await readCustomTitle(path.join(projectDir, id))) ??
      titleLine?.customTitle ??
      agentLine?.agentName ??
      liveInfo?.name ??
      null,
    topic: sessionTopic(headLines),
    entrypoint: origin?.entrypoint ?? liveInfo?.entrypoint ?? null,
    gitBranch: origin?.gitBranch ?? null,
    version: origin?.version ?? null,
    startedAt: started?.timestamp ?? null,
    updatedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
    subagentCount: await countSubagents(path.join(projectDir, id, 'subagents')),
    live: liveInfo,
  };
}

/** Primeiro `cwd` registrado no transcript: é a única forma confiável de saber o caminho do projeto. */
export async function readTranscriptCwd(projectDir: string): Promise<string | null> {
  const files = (await listDir(projectDir)).filter((e) => e.isFile() && e.name.endsWith('.jsonl'));
  for (const f of files) {
    const { head } = await readHeadTail(path.join(projectDir, f.name), 16 * 1024).catch(() => ({ head: [] }));
    const cwd = head.map(parseLine).find((l) => l.cwd)?.cwd;
    if (cwd) return cwd;
  }
  return null;
}

const TOPIC_MAX = 80;

/**
 * Assunto da conversa, do começo do transcript: a tarefa do quadro que a abriu (`[Tarefa "…"]`) ou
 * a 1ª linha da 1ª mensagem sua. Pula o que o Claude Code ou o Claudio’s Club injetam e a saudação
 * de sessão nova ("Olá, X. Leia sua memória…"), que não diz o assunto.
 */
export function sessionTopic(lines: TranscriptLine[]): string | null {
  for (const l of lines) {
    if (l.type !== 'user' || !l.message || typeof l.message !== 'object') continue;
    const content = (l.message as { content?: unknown }).content;
    const texts =
      typeof content === 'string'
        ? [content]
        : Array.isArray(content)
          ? content.flatMap((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string' ? [(b as { text: string }).text] : []))
          : [];
    for (const raw of texts) {
      const text = raw.trim();
      const task = /^\[Tarefa "(.+?)"\]/.exec(text);
      if (task) return clipTopic(task[1]!);
      if (!text || isInjectedUserText(text) || text.startsWith('[MyCo]') || /^Olá, [^.]+\. Leia sua (memória|ficha)/.test(text)) continue;
      return clipTopic(text.split(/\r?\n/)[0]!);
    }
  }
  return null;
}

function clipTopic(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > TOPIC_MAX ? `${one.slice(0, TOPIC_MAX - 1)}…` : one;
}

function parseLine(line: string): TranscriptLine {
  const parsed = TranscriptLine.safeParse(tryJson(line));
  return parsed.success ? parsed.data : {};
}

async function readCustomTitle(sessionDir: string): Promise<string | null> {
  const raw = await fs.readFile(path.join(sessionDir, 'custom-title.json'), 'utf8').catch(() => null);
  if (raw === null) return null;
  const parsed = CustomTitleFile.safeParse(tryJson(raw));
  return parsed.success ? parsed.data.customTitle : null;
}

async function countSubagents(dir: string): Promise<number> {
  return (await listDir(dir)).filter((e) => e.name.endsWith('.meta.json')).length;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: o processo existe, mas pertence a outro usuário.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function iso(ms: number | undefined): string | null {
  return ms === undefined ? null : new Date(ms).toISOString();
}
