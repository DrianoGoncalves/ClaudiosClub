import type { Engine, Task } from '../../../shared/model';
import { isClosed } from '../../../shared/model';
import { t } from '../i18n';
import { engineName } from '../staff/fallbackEngine';

// A tarefa que trocou de motor por limite volta ao principal em conversa nova na próxima retomada da conversa de trabalho (ver `moveToPrimary` em
// server/tasks.ts), se o limite já liberou. Não há campo novo: `Task.fallback` some (o selo "no secundário" some junto) e o servidor grava a volta no histórico, em pt. A tela lê a nota de
// volta para mostrar o selo e escrever no idioma dela. Nota que não bate (servidor mudou o texto) fica como veio, e sem selo.

type History = Task['history'][number];

/** O que o histórico conta da volta: ela aconteceu, ou o principal liberou mas a conversa nova não abriu (a tarefa segue no secundário). */
export type PrimaryNote = { kind: 'back'; engine: Engine } | { kind: 'failed'; engine: Engine; reason: string } | { kind: 'queue'; who: string; acked: boolean };

const ENGINES: Record<string, Engine> = { Claude: 'claude', Codex: 'codex' };

export function parsePrimaryNote(note: string | undefined): PrimaryNote | null {
  const back = /^motor principal liberado: voltou ao (Claude|Codex) em conversa nova, com o resumo da anterior$/.exec(note ?? '');
  if (back) return { kind: 'back', engine: ENGINES[back[1]!]! };
  const failed = /^motor principal liberado, mas a conversa nova no (Claude|Codex) não abriu \((.*)\); segue na conversa do secundário$/s.exec(note ?? '');
  if (failed) return { kind: 'failed', engine: ENGINES[failed[1]!]!, reason: failed[2]! };
  // O sufixo opcional é o `cutAck` do servidor (você levou o card para "a fazer"): fica fora de `who`, que é só o nome, e a tela o escreve no idioma dela.
  const queue = /^retomada na fila, em conversa nova no motor principal, com (.+?)(; você tinha confirmado a retomada, sem a checagem de ação cortada)?$/.exec(note ?? '');
  if (queue) return { kind: 'queue', who: queue[1]!, acked: !!queue[2] };
  return null;
}

/** A linha do histórico para a nota da volta, no idioma da tela; null = não é nota da volta (a linha segue como as outras). */
export function primaryNoteText(note: string | undefined): string | null {
  const n = parsePrimaryNote(note);
  if (!n) return null;
  if (n.kind === 'queue') return t('tasks.primaryNoteQueue', { who: n.who }) + (n.acked ? `; ${t('tasks.primaryNoteQueueAck')}` : '');
  const engine = t(engineName(n.engine));
  return n.kind === 'back' ? t('tasks.primaryNoteBack', { engine }) : t('tasks.primaryNoteFailed', { engine, reason: n.reason });
}

/** A última volta da tarefa: quando e a que motor. */
export interface PrimaryReturn {
  at: string;
  engine: Engine;
}

/**
 * A volta que o selo mostra: a mais recente do histórico, enquanto a tarefa está aberta e fora do secundário (`Task.fallback` ausente; trocou de novo,
 * o selo é o do secundário). Depois de encerrada a tarefa deixa de ser notícia: o histórico segue contando. Reaberta (pronta ou cancelada que voltou a
 * andar), a volta só conta se for posterior ao último encerramento: a de antes dele é de um trabalho que já acabou.
 */
export function primaryReturnOf(task: Pick<Task, 'status' | 'fallback' | 'history'>): PrimaryReturn | null {
  if (task.fallback || isClosed(task)) return null;
  for (let i = task.history.length - 1; i >= 0; i--) {
    const h: History = task.history[i]!;
    const n = parsePrimaryNote(h.note);
    if (n?.kind === 'back') return { at: h.at, engine: n.engine };
    if (isClosed(h)) return null;
  }
  return null;
}
