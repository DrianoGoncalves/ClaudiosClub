import { readFileSync } from 'node:fs';
import type { TurnCapHit } from '../shared/model';
import { writeAtomic } from './staff/store';

// O que a caixa "precisa de mim" lembra entre reinícios do Claudio’s Club: as perguntas que esperam você
// (um funcionário terminou o turno perguntando algo), os avisos que você marcou como "não é
// segredo" (não voltam a aparecer) e os turnos que pararam no teto (ver turnCap.ts). Sem arquivo (testes), fica só na memória.

interface Data {
  questions: Record<string, { text: string; at: string; itemId?: string }>;
  muted: string[];
  /** Sessões esperando você em outro lugar que você dispensou: sessionId → statusUpdatedAt visto ('' = sem data). */
  waitingDismissed: Record<string, string>;
  /** Turnos que pararam no teto e ainda não receberam mensagem nova (sai com a próxima mensagem). */
  caps: Record<string, TurnCapHit & { at: string }>;
}

const MAX_MUTED = 500;
const MAX_WAITING = 500;

export class InboxState {
  private data: Data = { questions: {}, muted: [], waitingDismissed: {}, caps: {} };
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly file: string | null = null) {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as Partial<Data>;
      const questions = raw.questions && typeof raw.questions === 'object' ? raw.questions : {};
      for (const [id, q] of Object.entries(questions)) {
        if (q && typeof q.text === 'string' && typeof q.at === 'string') {
          this.data.questions[id] = { text: q.text.slice(0, 200), at: q.at, ...(typeof q.itemId === 'string' && { itemId: q.itemId }) };
        }
      }
      this.data.muted = Array.isArray(raw.muted) ? raw.muted.filter((m): m is string => typeof m === 'string').slice(-MAX_MUTED) : [];
      const waiting = raw.waitingDismissed && typeof raw.waitingDismissed === 'object' ? raw.waitingDismissed : {};
      for (const [sid, at] of Object.entries(waiting)) {
        if (typeof at === 'string') this.data.waitingDismissed[sid] = at;
      }
      const caps = raw.caps && typeof raw.caps === 'object' ? raw.caps : {};
      for (const [sid, c] of Object.entries(caps)) {
        if (c && (c.kind === 'tools' || c.kind === 'minutes') && typeof c.limit === 'number' && typeof c.at === 'string') {
          this.data.caps[sid] = { kind: c.kind, limit: c.limit, at: c.at };
        }
      }
    } catch {
      // sem arquivo (ou corrompido): começa vazio
    }
  }

  questions(): Array<{ sessionId: string; text: string; at: string; itemId?: string }> {
    return Object.entries(this.data.questions).map(([sessionId, q]) => ({ sessionId, ...q }));
  }

  /** `itemId`: o balão da resposta onde a pergunta foi achada (a caixa rola até ele). */
  setQuestion(sessionId: string, q: { text: string; at: string; itemId?: string } | null) {
    const had = sessionId in this.data.questions;
    if (q) this.data.questions[sessionId] = q;
    else delete this.data.questions[sessionId];
    if (q || had) this.save();
  }

  /** O turno parou no teto: fica na caixa (e na tarefa) até você mandar mensagem nova. `null` tira. */
  setTurnCap(sessionId: string, cap: (TurnCapHit & { at: string }) | null) {
    const had = sessionId in this.data.caps;
    if (cap) this.data.caps[sessionId] = cap;
    else delete this.data.caps[sessionId];
    if (cap || had) this.save();
  }

  turnCaps(): Array<TurnCapHit & { sessionId: string; at: string }> {
    return Object.entries(this.data.caps).map(([sessionId, c]) => ({ ...c, sessionId }));
  }

  /** O motivo do teto desta conversa (se o turno dela parou no teto e ninguém mandou mensagem depois). */
  turnCapOf(sessionId: string): TurnCapHit | null {
    const c = this.data.caps[sessionId];
    return c ? { kind: c.kind, limit: c.limit } : null;
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
