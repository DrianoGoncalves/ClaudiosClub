import { promises as fs } from 'node:fs';
import { feedSubject, initialSubjectState, subjectView, type SubjectEvent, type SubjectState, type SubjectView } from './subject';

// Assunto de um arquivo de conversa, lido por inteiro uma vez e depois só o que foi acrescentado. Só as conversas do
// Club passam por aqui: o assunto delas precisa achar a virada mesmo no meio de um transcript grande.

/** Acima disso o arquivo não é lido por inteiro: quem chama cai nas janelas do começo e do fim (como antes). */
export const TRACK_MAX_BYTES = 50 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

/** As mensagens de uma linha (`pos` = byte em que a linha começa, usado só se a linha não tem id). */
export type EventsOf = (line: string, pos: number) => SubjectEvent[];

interface Track {
  state: SubjectState;
  /** Até onde o arquivo foi lido: só até o último `\n` (a linha no fim, ainda sendo escrita, espera). */
  offset: number;
  size: number;
  mtimeMs: number;
  ino: number;
}

/**
 * Um rastreador por processo. Por arquivo, guarda o estado e até onde leu. Leituras do mesmo arquivo são serializadas:
 * duas ao mesmo tempo consumiriam as mesmas linhas duas vezes.
 */
export class SubjectTracker {
  private readonly tracks = new Map<string, Track>();
  private readonly queues = new Map<string, Promise<unknown>>();

  /**
   * Assunto atual do arquivo. `readZst` lê um rollout compactado (`.zst`) por inteiro; sem ele, `.zst` não é lido. Null se o
   * arquivo não existe, passa de TRACK_MAX_BYTES, não lê ou não tem como ler: quem chama usa o caminho antigo.
   */
  read(file: string, events: EventsOf, readZst?: (file: string) => Promise<Buffer | null>): Promise<SubjectView | null> {
    const run = (this.queues.get(file) ?? Promise.resolve()).catch(() => undefined).then(() => this.advance(file, events, readZst));
    this.queues.set(file, run);
    return run.catch(() => {
      this.tracks.delete(file);
      return null;
    });
  }

  private async advance(file: string, events: EventsOf, readZst?: (file: string) => Promise<Buffer | null>): Promise<SubjectView | null> {
    const st = await fs.stat(file).catch(() => null);
    if (!st) {
      this.tracks.delete(file);
      return null;
    }
    if (file.endsWith('.zst')) return this.advanceZst(file, st, events, readZst);
    if (st.size > TRACK_MAX_BYTES) {
      this.tracks.delete(file);
      return null;
    }
    let t = this.tracks.get(file);
    // Encolheu ou foi trocado (outro arquivo no mesmo caminho): começa de novo.
    if (!t || st.size < t.offset || st.ino !== t.ino) {
      t = { state: initialSubjectState(), offset: 0, size: 0, mtimeMs: 0, ino: st.ino };
      this.tracks.set(file, t);
    }
    if (st.size > t.offset) await this.consume(file, t, st.size, events);
    t.size = st.size;
    t.mtimeMs = st.mtime.getTime();
    return subjectView(t.state);
  }

  /** Lê de `t.offset` até `end` em pedaços, aplica as linhas completas e avança o offset só por elas. */
  private async consume(file: string, t: Track, end: number, events: EventsOf): Promise<void> {
    const fh = await fs.open(file, 'r');
    try {
      let base = t.offset;
      let pending = Buffer.alloc(0);
      let pos = t.offset;
      while (pos < end) {
        const len = Math.min(CHUNK_BYTES, end - pos);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        pending = Buffer.concat([pending, buf.subarray(0, bytesRead)]);
        let from = 0;
        for (let nl = pending.indexOf(0x0a); nl !== -1; nl = pending.indexOf(0x0a, from)) {
          const line = pending.subarray(from, nl).toString('utf8');
          if (line.trim()) for (const ev of events(line, base + from)) feedSubject(t.state, ev);
          from = nl + 1;
        }
        base += from;
        pending = pending.subarray(from);
        t.offset = base;
      }
    } finally {
      await fh.close();
    }
  }

  /** Rollout compactado: não cresce, então só se relê quando o tamanho ou a data mudam. */
  private async advanceZst(
    file: string,
    st: { size: number; mtime: Date; ino: number },
    events: EventsOf,
    readZst?: (file: string) => Promise<Buffer | null>,
  ): Promise<SubjectView | null> {
    const hit = this.tracks.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtime.getTime()) return subjectView(hit.state);
    const text = readZst ? await readZst(file) : null;
    if (!text) {
      this.tracks.delete(file);
      return null;
    }
    const state = initialSubjectState();
    let pos = 0;
    for (const line of text.toString('utf8').split('\n')) {
      if (line.trim()) for (const ev of events(line, pos)) feedSubject(state, ev);
      pos += Buffer.byteLength(line, 'utf8') + 1;
    }
    this.tracks.set(file, { state, offset: 0, size: st.size, mtimeMs: st.mtime.getTime(), ino: st.ino });
    return subjectView(state);
  }
}

/** O rastreador compartilhado pelo adaptador (sessões do Club) e pelo gerador de título. */
export const subjectTracker = new SubjectTracker();
