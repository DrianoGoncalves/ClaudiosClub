import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { LiveSession, Session } from '../../../shared/model';
import { bootTime, startedBeforeBoot } from '../../procIdentity';
import { feedSubject, initialSubjectState, reviewTaskOf, type SubjectEvent, type SubjectView } from '../../titles/subject';
import { subjectTracker } from '../../titles/tracker';
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
  // Id da mensagem: o gerador de título o usa para ver se o assunto ainda é o mesmo (ver titles/generator.ts).
  uuid: z.string().optional(),
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

export async function readLiveSessions(claudeHome: string, boot = bootTime()): Promise<LiveSession[]> {
  const dir = path.join(claudeHome, 'sessions');
  // Os arquivos `<pid>.<hash>.key` ao lado são chaves de processo: nunca ler.
  const files = (await listDir(dir)).filter((e) => e.isFile() && /^\d+\.json$/.test(e.name));
  const sessions = await Promise.all(
    files.map(async (e): Promise<LiveSession | null> => {
      const raw = await fs.readFile(path.join(dir, e.name), 'utf8').catch(() => null);
      const parsed = raw === null ? null : LiveFile.safeParse(tryJson(raw));
      if (!parsed?.success) return null;
      const s = parsed.data;
      // Arquivo de antes do boot (o PC reiniciou com a sessão aberta): o Claude não apagou, e o sistema pode ter dado o pid a outro processo.
      const alive = isPidAlive(s.pid) && !startedBeforeBoot(s.startedAt, boot);
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
  /** Conversas que o Club lançou: o assunto delas vem do rastreador incremental (titles/tracker.ts), não de head/tail. */
  club?: ReadonlySet<string>;
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
  forgetGoneTranscripts(projectDir, new Set(files.map((e) => e.name)));
  const sessions = await Promise.all(
    files.map(async (e): Promise<Session | null> => {
      const id = path.basename(e.name, '.jsonl');
      // Ao vivo = processo vivo agora (a entrada de um processo morto não protege). Protegida pela retenção: fica sempre.
      if (cutoff !== null && live.get(id)?.alive !== true && !opts.keep?.has(id) && !(await recentlyActive(projectDir, id, cutoff))) return null;
      return readSession(projectDir, id, live, opts.club?.has(id) === true).catch(() => null);
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

/** O que sai do começo e do fim de um transcript (só texto: o guardado é dividido entre leitores e nunca alterado). */
interface TranscriptFacts {
  entrypoint: string | null;
  gitBranch: string | null;
  version: string | null;
  startedAt: string | null;
  customTitle: string | null;
  agentName: string | null;
  topic: string | null;
}

/**
 * Transcript mexido há menos que isso não é guardado: o mtime do Windows anda em degraus de ~15,6 ms, e duas gravações seguidas de mesmo tamanho
 * dariam a mesma versão (a mesma regra do `tasks.json`, SPEC "Desempenho" 1).
 */
export const TRANSCRIPT_RACY_MS = 3_000;
/** Arquivo do transcript → o que foi lido dele e a versão (mtime, ctime, tamanho, inode) em que foi lido. */
const factsCache = new Map<string, { version: string; facts: TranscriptFacts }>();

/** Quantos transcripts estão guardados (só os testes olham). */
export const transcriptCacheSize = (): number => factsCache.size;

const transcriptVersion = (st: Stats): string => `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;

/**
 * Começo e fim do transcript, lidos uma vez por versão do arquivo (SPEC "Desempenho" 2): o `/api/board` passa por todo transcript recente, e
 * reler 2 × 64 KB de cada um a cada montagem ocupava o HDD. O que muda sem mexer no transcript (ao vivo, `custom-title.json`, subagents)
 * fica fora daqui e é lido a cada vez.
 */
async function transcriptFacts(file: string, st: Stats, now = Date.now()): Promise<TranscriptFacts> {
  const version = transcriptVersion(st);
  const hit = factsCache.get(file);
  if (hit && hit.version === version) return hit.facts;
  const { head, tail } = await readHeadTail(file);
  const headLines = head.map(parseLine);
  // Arquivo pequeno: head e tail são o mesmo array (não entra duas vezes no assunto).
  const tailLines = head === tail ? headLines : tail.map(parseLine);
  const newestFirst = [...tailLines].reverse();
  const origin = headLines.find((l) => l.entrypoint);
  const facts: TranscriptFacts = {
    entrypoint: origin?.entrypoint ?? null,
    gitBranch: origin?.gitBranch ?? null,
    version: origin?.version ?? null,
    startedAt: headLines.find((l) => l.timestamp)?.timestamp ?? null,
    customTitle: newestFirst.find((l) => l.type === 'custom-title' && l.customTitle)?.customTitle ?? null,
    agentName: newestFirst.find((l) => l.type === 'agent-name' && l.agentName)?.agentName ?? null,
    topic: sessionTopic(headLines, head === tail ? [] : tailLines),
  };
  if (now - st.mtimeMs >= TRANSCRIPT_RACY_MS) factsCache.set(file, { version, facts });
  else factsCache.delete(file);
  return facts;
}

/** Esquece os transcripts que sumiram da pasta (apagados pela retenção ou à mão): o guardado não cresce sem fim. */
function forgetGoneTranscripts(projectDir: string, present: ReadonlySet<string>): void {
  for (const file of factsCache.keys()) {
    if (path.dirname(file) === projectDir && !present.has(path.basename(file))) factsCache.delete(file);
  }
}

async function readSession(
  projectDir: string,
  id: string,
  live: ReadonlyMap<string, LiveSession>,
  club: boolean,
): Promise<Session> {
  const file = path.join(projectDir, `${id}.jsonl`);
  const stat = await fs.stat(file);
  const facts = await transcriptFacts(file, stat);
  // Do Club: o rastreador lê o transcript inteiro (incremental), então acha a virada mesmo no meio. Grande demais: head/tail.
  const tracked = club ? await claudeSubject(file) : null;
  const liveInfo = live.get(id) ?? null;

  return {
    id,
    title: (await readCustomTitle(path.join(projectDir, id))) ?? facts.customTitle ?? facts.agentName ?? liveInfo?.name ?? null,
    topic: tracked ? tracked.topic : facts.topic,
    // Conversa de revisão do Club (sem IA, sem texto traduzido: a tela compõe com o rótulo da coluna). Sem o rastreador, fica ausente.
    ...(tracked && { reviewTask: reviewTaskOf(tracked) }),
    entrypoint: facts.entrypoint ?? liveInfo?.entrypoint ?? null,
    gitBranch: facts.gitBranch,
    version: facts.version,
    startedAt: facts.startedAt,
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

/**
 * Assunto da conversa (regra em titles/subject.ts). `head` e `tail` em ordem cronológica e sem sobreposição (o tail
 * vazio quando o arquivo é pequeno).
 */
export function sessionTopic(head: TranscriptLine[], tail: TranscriptLine[] = []): string | null {
  const st = initialSubjectState();
  [...head, ...tail].forEach((l, i) => {
    for (const ev of claudeEvents(l, i)) feedSubject(st, ev);
  });
  return st.topic;
}

/** As mensagens de texto de uma linha do transcript, na ordem. `pos` (posição da linha) só serve de chave se não houver uuid. */
function claudeEvents(l: TranscriptLine, pos: number): SubjectEvent[] {
  if (l.type !== 'user' && l.type !== 'assistant') return [];
  const key = l.uuid ?? `p:${pos}`;
  const role = l.type === 'assistant' ? 'assistant' : 'user';
  return textsOf(l).map((text) => ({ role, text, key }));
}

/** Assunto atual de um transcript do Club (incremental, ver titles/tracker.ts). Null se não dá para ler por inteiro. */
export function claudeSubject(file: string): Promise<SubjectView | null> {
  return subjectTracker.read(file, (line, pos) => {
    const parsed = parseLine(line);
    return claudeEvents(parsed, pos);
  });
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
