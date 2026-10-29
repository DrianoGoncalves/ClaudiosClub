import { readFileSync } from 'node:fs';
import { writeAtomic } from './staff/store';

// O que a caixa "precisa de mim" lembra entre reinícios do Claudio’s Club: as perguntas que esperam você
// (um funcionário terminou o turno perguntando algo) e os avisos que você marcou como "não é
// segredo" (não voltam a aparecer). Sem arquivo (testes), fica só na memória.

interface Data {
  questions: Record<string, { text: string; at: string }>;
  muted: string[];
  /** Sessões esperando você em outro lugar que você dispensou: sessionId → statusUpdatedAt visto ('' = sem data). */
  waitingDismissed: Record<string, string>;
}

const MAX_MUTED = 500;
const MAX_WAITING = 500;

export class InboxState {
  private data: Data = { questions: {}, muted: [], waitingDismissed: {} };
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly file: string | null = null) {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as Partial<Data>;
      const questions = raw.questions && typeof raw.questions === 'object' ? raw.questions : {};
      for (const [id, q] of Object.entries(questions)) {
        if (q && typeof q.text === 'string' && typeof q.at === 'string') this.data.questions[id] = { text: q.text.slice(0, 200), at: q.at };
      }
      this.data.muted = Array.isArray(raw.muted) ? raw.muted.filter((m): m is string => typeof m === 'string').slice(-MAX_MUTED) : [];
      const waiting = raw.waitingDismissed && typeof raw.waitingDismissed === 'object' ? raw.waitingDismissed : {};
      for (const [sid, at] of Object.entries(waiting)) {
        if (typeof at === 'string') this.data.waitingDismissed[sid] = at;
      }
    } catch {
      // sem arquivo (ou corrompido): começa vazio
    }
  }

  questions(): Array<{ sessionId: string; text: string; at: string }> {
    return Object.entries(this.data.questions).map(([sessionId, q]) => ({ sessionId, ...q }));
  }

  setQuestion(sessionId: string, q: { text: string; at: string } | null) {
    const had = sessionId in this.data.questions;
    if (q) this.data.questions[sessionId] = q;
    else delete this.data.questions[sessionId];
    if (q || had) this.save();
  }

  isMuted(id: string): boolean {
    return this.data.muted.includes(id);
  }

  mute(id: string) {
    if (this.isMuted(id)) return;
    this.data.muted = [...this.data.muted, id].slice(-MAX_MUTED);
    this.save();
  }

  /** "Dispensar" numa sessão que espera você em outro lugar: some até o status mudar (outro `statusUpdatedAt`). */
  dismissWaiting(sessionId: string, statusUpdatedAt: string | null) {
    const rest = Object.entries(this.data.waitingDismissed).filter(([sid]) => sid !== sessionId);
    this.data.waitingDismissed = Object.fromEntries([...rest, [sessionId, statusUpdatedAt ?? '']].slice(-MAX_WAITING));
    this.save();
  }

  isWaitingDismissed(sessionId: string, statusUpdatedAt: string | null): boolean {
    return this.data.waitingDismissed[sessionId] === (statusUpdatedAt ?? '');
  }

  /** Grava em fila: duas mudanças juntas não se atropelam. */
  private save() {
    if (!this.file) return;
    const file = this.file;
    const text = JSON.stringify(this.data, null, 2) + '\n';
    this.saving = this.saving.then(() => writeAtomic(file, text)).catch(() => {});
  }

  /** Para os testes: espera a última gravação. */
  flush(): Promise<void> {
    return this.saving;
  }
}
