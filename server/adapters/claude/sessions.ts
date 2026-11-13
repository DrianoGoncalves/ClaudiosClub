import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { LiveSession, Session } from '../../../shared/model';
import { hasCheckpoint, isInjectedUserText } from '../../chat/items';
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

export interface SessionListOptions {
  /** Dias sem atividade a partir dos quais a conversa fica de fora da lista (0 ou ausente = sem corte). */
  archiveAfterDays?: number;
  /** Lista também as antigas (o modo "incluir antigas", `?old=1`). */
  includeOld?: boolean;
  /** Sessões que a retenção nunca arquiva (ver server/retention.ts): ficam mesmo paradas além do prazo. */
  keep?: ReadonlySet<string>;
  /** Relógio (só os testes trocam). */
  now?: number;
}

const DAY_MS = 86_400_000;

/**
 * Lista os transcripts de uma pasta de projeto em ~/.claude/projects, do mais recente ao mais antigo. Com `archiveAfterDays`
 * (e sem `includeOld`), a conversa sem atividade há mais dias que isso fica de fora SEM ler o arquivo: só `stat` do
 * transcript e da pasta `subagents`. Sessão ao vivo entra sempre.
 */
export async function readProjectSessions(
  projectDir: string,
  live: ReadonlyMap<string, LiveSession>,
  opts: SessionListOptions = {},
): Promise<Session[]> {
  const cutoff = archiveCutoff(opts);
  const files = (await listDir(projectDir)).filter((e) => e.isFile() && e.name.endsWith('.jsonl'));
  const sessions = await Promise.all(
    files.map(async (e): Promise<Session | null> => {
      const id = path.basename(e.name, '.jsonl');
      // Ao vivo = processo vivo agora (a entrada de um processo morto não protege). Protegida pela retenção: fica sempre.
      if (cutoff !== null && live.get(id)?.alive !== true && !opts.keep?.has(id) && !(await recentlyActive(projectDir, id, cutoff))) return null;
      return readSession(projectDir, id, live).catch(() => null);
    }),
  );
  return sessions
    .filter((s): s is Session => s !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Instante antes do qual a conversa é antiga (null = sem corte: `includeOld`, ou `archiveAfterDays` desligado). */
function archiveCutoff(opts: SessionListOptions): number | null {
  if (opts.includeOld || !opts.archiveAfterDays || opts.archiveAfterDays <= 0) return null;
  return (opts.now ?? Date.now()) - opts.archiveAfterDays * DAY_MS;
}

/** A atividade (transcript ou subagent) foi depois do corte? Só `stat`: o transcript primeiro, a pasta `subagents` depois. */
async function recentlyActive(projectDir: string, id: string, cutoff: number): Promise<boolean> {
  const st = await fs.stat(path.join(projectDir, `${id}.jsonl`)).catch(() => null);
  if (st && st.mtimeMs >= cutoff) return true;
  const sub = path.join(projectDir, id, 'subagents');
  let last = (await fs.stat(sub).catch(() => null))?.mtimeMs ?? 0;
  for (const e of await listDir(sub)) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const s = await fs.stat(path.join(sub, e.name)).catch(() => null);
    if (s && s.mtimeMs > last) last = s.mtimeMs;
  }
  return last >= cutoff;
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
    // Arquivo pequeno: head e tail são o mesmo array (não entra duas vezes).
    topic: sessionTopic(headLines, head === tail ? [] : tail.map(parseLine)),
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
 * Assunto da conversa: o da última virada de assunto. Virada = a tarefa do quadro que a puxou (`[Tarefa "…"]`)
 * ou a próxima mensagem sua substantiva depois de um ponto de corte (`hasCheckpoint`). Sem virada, é a 1ª
 * mensagem sua. Pula o que o Claude Code ou o Claudio’s Club injetam, a saudação de sessão nova ("Olá, X. Leia
 * sua memória…") e, depois do ponto de corte, a confirmação curta ("ok", "pode seguir").
 * `head` e `tail` em ordem cronológica e sem sobreposição (o tail vazio quando o arquivo é pequeno).
 */
export function sessionTopic(head: TranscriptLine[], tail: TranscriptLine[] = []): string | null {
  let topic: string | null = null;
  // Depois de um ponto de corte, o próximo assunto é a próxima mensagem substantiva.
  let waiting = false;
  for (const l of [...head, ...tail]) {
    if (l.type === 'assistant') {
      if (textsOf(l).some((t) => hasCheckpoint(t))) waiting = true;
      continue;
    }
    if (l.type !== 'user') continue;
    for (const raw of textsOf(l)) {
      const text = raw.trim();
      const task = /^\[Tarefa "(.+?)"\]/.exec(text);
      if (task) {
        topic = clipTopic(task[1]!);
        waiting = false;
        break;
      }
      if (!text || isInjectedUserText(text) || text.startsWith('[MyCo]') || /^Olá, [^.]+\. Leia sua (memória|ficha)/.test(text)) continue;
      if (waiting) {
        if (isShortConfirmation(text)) continue;
        topic = clipTopic(text.split(/\r?\n/)[0]!);
        waiting = false;
        break;
      }
      // Sem virada: a 1ª mensagem sua (só a primeira define).
      if (topic === null) {
        topic = clipTopic(text.split(/\r?\n/)[0]!);
        break;
      }
    }
  }
  return topic;
}

/** Os textos de uma mensagem (string ou blocos de texto). */
function textsOf(l: TranscriptLine): string[] {
  if (!l.message || typeof l.message !== 'object') return [];
  const content = (l.message as { content?: unknown }).content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) =>
    b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string' ? [(b as { text: string }).text] : [],
  );
}

/** Palavras de confirmação (pt/en/es), sem acento. Lista fechada: "Corrige o bug" é assunto, "ok, valeu" não. */
const CONFIRMATION_WORDS = new Set(
  'ok okay oks blz beleza certo certinho perfeito otimo show top valeu vlw obrigado obrigada brigado grato sim nao pode seguir segue siga continua continue manda bora aprovado aprovada entendi combinado feito isso fechado thanks thank you yes no go ahead great nice gracias si vale perfecto listo de acordo'.split(' '),
);

/** "ok", "obrigado", "pode seguir": só palavras de confirmação, sem pergunta. Não é um assunto novo. */
function isShortConfirmation(text: string): boolean {
  if (text.includes('?')) return false;
  const words = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  return words.length <= 4 && words.every((w) => CONFIRMATION_WORDS.has(w));
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
