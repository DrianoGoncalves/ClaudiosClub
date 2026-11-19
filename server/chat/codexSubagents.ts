import { promises as fs } from 'node:fs';
import type { BackgroundTask } from '../../shared/model';

// O `codex exec --json` não avisa quando um subagent nasce ou acaba; quem registra isso é o rollout da conversa (JSONL em ~/.codex/sessions):
//   {"type":"event_msg","payload":{"type":"item_completed","item":{"type":"SubAgentActivity","kind":"started"|"completed","agent_thread_id":"<filho>","agent_path":"/root/nome"}}}
// O papel (agent_type do spawn) está na 1ª linha do rollout do filho (`session_meta`). Daqui sai a lista de "em segundo plano", como no Claude.
// O mesmo vigia entrega cada linha completa nova do rollout do pai a `onLine` (a recusa do `apply_patch` só aparece ali, ver `codexRolloutDenial`).

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});

export interface SubAgentEvent {
  kind: 'started' | 'completed';
  threadId: string;
  /** Último pedaço do agent_path (`/root/editar_alvo` → `editar_alvo`). */
  task: string;
}

/** Uma linha do rollout do pai como início/fim de subagent; null para qualquer outra coisa (ou JSON quebrado). */
export function parseSubAgentActivity(line: string): SubAgentEvent | null {
  if (!line.includes('SubAgentActivity')) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const payload = rec(rec(obj).payload);
  const item = rec(payload.item);
  if (payload.type !== 'item_completed' || item.type !== 'SubAgentActivity') return null;
  if ((item.kind !== 'started' && item.kind !== 'completed') || typeof item.agent_thread_id !== 'string' || !item.agent_thread_id) return null;
  const path = typeof item.agent_path === 'string' ? item.agent_path : '';
  return { kind: item.kind, threadId: item.agent_thread_id, task: path.split('/').filter(Boolean).at(-1) ?? 'agent' };
}

/** O `agent_role` da 1ª linha (`session_meta`) do rollout de um filho; null se foi um agent sem tipo ou a linha não é essa. */
export function roleFromChildMeta(firstLine: string): string | null {
  let obj: unknown;
  try {
    obj = JSON.parse(firstLine);
  } catch {
    return null;
  }
  if (rec(obj).type !== 'session_meta') return null;
  const payload = rec(rec(obj).payload);
  const role = payload.agent_role ?? rec(rec(rec(payload.source).subagent).thread_spawn).agent_role;
  return typeof role === 'string' && role.trim() ? role.trim() : null;
}

/** Primeira linha de um arquivo (o `session_meta` traz as instruções e pode ter dezenas de KB: lê em blocos, até 512 KB). */
export async function firstLineOf(file: string): Promise<string | null> {
  const fh = await fs.open(file, 'r');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(32 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, total);
      if (!bytesRead) break;
      const part = buf.subarray(0, bytesRead);
      const nl = part.indexOf(0x0a);
      if (nl !== -1) {
        chunks.push(part.subarray(0, nl));
        break;
      }
      chunks.push(part);
      total += bytesRead;
      if (total >= 512 * 1024) break;
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    return text || null;
  } finally {
    await fh.close();
  }
}

export interface CodexSubagentWatchOptions {
  /** O rollout de uma conversa pelo id (ver findRollout). */
  find: (threadId: string) => Promise<string | null>;
  readFirstLine: (file: string) => Promise<string | null>;
  onChange: (tasks: BackgroundTask[]) => void;
  /**
   * Cada linha completa nova do rollout do pai (sem o que já estava lá numa retomada). `stop()` ainda lê o que sobrou até o fim do arquivo, sem esperar a próxima volta, e
   * entrega por aqui (a linha dos últimos instantes do turno não se perde). Erro de quem recebe não derruba o vigia.
   */
  onLine?: (line: string) => void;
  intervalMs?: number;
}

interface Tracked {
  task: string;
  /** undefined: o rollout do filho ainda não existe (tenta de novo); null: o agent foi lançado sem tipo. */
  role: string | null | undefined;
  tries: number;
}

const MAX_ROLE_TRIES = 20;
/** Bytes lidos por volta: um rollout grande (ou um backlog) é consumido aos poucos, sem prender o processo. */
const MAX_READ = 2 * 1024 * 1024;

/** As linhas completas não vazias do buffer; o que vem depois do último \n é uma linha pela metade (`rest`): espera o resto. */
function completeLines(all: Buffer): { lines: string[]; rest: Buffer } {
  const lastNl = all.lastIndexOf(0x0a);
  if (lastNl === -1) return { lines: [], rest: all };
  const lines = all.subarray(0, lastNl).toString('utf8').split('\n').filter((l) => l.trim());
  return { lines, rest: all.subarray(lastNl + 1) };
}

/**
 * Vigia o rollout do pai durante a execução e mantém a lista dos subagents ativos. Lê só os bytes novos; erro de leitura é ignorado
 * (a conversa nunca cai por causa disto). `onChange` só dispara quando a lista muda.
 */
export class CodexSubagentWatch {
  private timer: NodeJS.Timeout | null = null;
  private parent: string | null = null;
  private file: string | null = null;
  /** null: ainda não sabe onde começar (retomada: começa do fim do arquivo, sem reaplicar turnos antigos). */
  private offset: number | null = null;
  private partial: Buffer = Buffer.alloc(0);
  private readonly tracked = new Map<string, Tracked>();
  private emitted = '[]';
  private reading = false;
  /** Muda a cada start/stop: uma leitura que ficou para trás não aplica nada. */
  private generation = 0;

  constructor(private readonly opts: CodexSubagentWatchOptions) {}

  /** `fromStart`: conversa nova (o rollout acabou de nascer, nada a pular). Sem ele, começa do fim atual do arquivo. */
  start(parentThreadId: string, fromStart = false) {
    this.reset();
    this.parent = parentThreadId;
    this.offset = fromStart ? 0 : null;
    const ms = this.opts.intervalMs ?? 1500;
    this.timer = setInterval(() => void this.tick(), ms);
    this.timer.unref();
    void this.tick();
  }

  stop() {
    const rest = this.opts.onLine && this.parent && this.file && this.offset !== null ? { file: this.file, from: this.offset, partial: this.partial } : null;
    this.reset();
    if (rest) void this.drain(rest.file, rest.from, rest.partial);
  }

  /** Última leitura do que ficou entre a última volta e o fim do arquivo (só `onLine`; a lista de subagents já foi zerada). Erro de leitura é ignorado. */
  private async drain(file: string, from: number, partial: Buffer) {
    try {
      const fh = await fs.open(file, 'r');
      let buf: Buffer;
      try {
        const length = Math.min((await fh.stat()).size - from, MAX_READ);
        if (length <= 0) return;
        buf = Buffer.alloc(length);
        buf = buf.subarray(0, (await fh.read(buf, 0, length, from)).bytesRead);
      } finally {
        await fh.close();
      }
      for (const line of completeLines(Buffer.concat([partial, buf])).lines) this.deliver(line);
    } catch {
      // arquivo sumiu ou está preso: o que passou pela última volta já foi entregue
    }
  }

  private deliver(line: string) {
    try {
      this.opts.onLine?.(line);
    } catch {
      // quem escuta não derruba o vigia
    }
  }

  private reset() {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.parent = null;
    this.file = null;
    this.offset = null;
    this.partial = Buffer.alloc(0);
    this.tracked.clear();
    this.emit();
  }

  private emit() {
    const tasks: BackgroundTask[] = [...this.tracked].map(([id, t]) => ({ id, kind: 'agent', label: `${t.role ?? 'agent'}: ${t.task}` }));
    const sig = JSON.stringify(tasks);
    if (sig === this.emitted) return;
    this.emitted = sig;
    try {
      this.opts.onChange(tasks);
    } catch {
      // quem escuta não derruba o vigia
    }
  }

  private async tick() {
    if (this.reading || !this.parent) return;
    this.reading = true;
    const gen = this.generation;
    try {
      await this.readNew(gen);
      await this.resolveRoles(gen);
    } catch {
      // arquivo sumiu, busy, permissão: tenta na próxima volta
    } finally {
      this.reading = false;
    }
    if (gen === this.generation) this.emit();
  }

  private async readNew(gen: number) {
    const parent = this.parent;
    if (!parent) return;
    this.file ??= await this.opts.find(parent);
    const file = this.file;
    if (!file || gen !== this.generation) return;
    const fh = await fs.open(file, 'r');
    let buf: Buffer;
    try {
      const size = (await fh.stat()).size;
      if (this.offset === null || size < this.offset) {
        // Retomada, ou o arquivo encolheu (foi reescrito): começa do fim.
        this.offset = size;
        this.partial = Buffer.alloc(0);
        return;
      }
      const length = Math.min(size - this.offset, MAX_READ);
      if (length <= 0) return;
      buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, this.offset);
      buf = buf.subarray(0, bytesRead);
      if (gen !== this.generation) return;
      this.offset += bytesRead;
    } finally {
      await fh.close();
    }
    const { lines, rest } = completeLines(Buffer.concat([this.partial, buf]));
    this.partial = rest;
    for (const line of lines) {
      this.deliver(line);
      const ev = parseSubAgentActivity(line);
      if (!ev) continue;
      if (ev.kind === 'completed') this.tracked.delete(ev.threadId);
      else this.tracked.set(ev.threadId, { task: ev.task, role: this.tracked.get(ev.threadId)?.role, tries: 0 });
    }
  }

  /** O papel vem do rollout do filho, que pode nascer depois do `started`: enquanto não existe, mostra 'agent' e tenta de novo. */
  private async resolveRoles(gen: number) {
    for (const [id, t] of this.tracked) {
      if (t.role !== undefined || t.tries >= MAX_ROLE_TRIES) continue;
      t.tries++;
      try {
        const file = await this.opts.find(id);
        const first = file ? await this.opts.readFirstLine(file) : null;
        if (gen !== this.generation) return;
        if (first) t.role = roleFromChildMeta(first);
      } catch {
        // tenta na próxima volta
      }
    }
  }
}
