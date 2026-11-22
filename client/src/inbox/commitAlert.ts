import type { CommitLeftFile, CommitLeftState, InboxItem } from '../../../shared/model';
import { t } from '../i18n';
import type { Tr } from './secretText';

// O aviso de commit automático parcial na caixa (`InboxItem.autoCommit`, ver server/inboxItems.ts e server/commitLeft.ts). O servidor entrega o estado:
//   ready:  o card que travava as sobras fechou e os arquivos seguem sem commit: decisão do dono (revisar e commitar, ou ignorar). Âmbar.
//   failed: o git falhou ou o repositório não estava em condição: abrir o card ou ignorar. Vermelho.
// `waiting` nunca vira item (só selo no cartão e a contagem no topo da caixa). Sem estado (item com `resolvedAt`) a frase é a do servidor. Os caminhos e a nota são texto de arquivo e de
// erro do git: a tela os mostra como texto puro.

export interface CommitAlert {
  taskId: string;
  taskTitle: string;
  state: Exclude<CommitLeftState, 'waiting'>;
  sha: string | null;
  files: CommitLeftFile[];
  note?: string;
}

/** O aviso de commit com decisão ou erro do item (null: não é um aviso de commit, ou já passou e o item só espera ser ignorado). */
export function commitAlertOf(item: Pick<InboxItem, 'autoCommit'> & { kind?: InboxItem['kind'] }): CommitAlert | null {
  const a = item.autoCommit;
  if (item.kind !== 'error' || !a || (a.state !== 'ready' && a.state !== 'failed')) return null;
  return { taskId: a.taskId, taskTitle: a.taskTitle, state: a.state, sha: a.sha ?? null, files: a.files ?? [], ...(a.note && { note: a.note }) };
}

/** O motivo de agora de um arquivo de fora. Em `ready` o card que o travava já fechou: o "ainda não terminou" da hora do commit não vale mais. */
export function leftWhy(f: CommitLeftFile, state: CommitAlert['state'], tr: Tr = t): string {
  return f.why === 'shared' && state === 'ready' ? tr('inbox.commit.whyReadyShared') : tr(`tasks.commitWhy.${f.why}`, { task: f.by.join(', ') });
}

/** A frase do item: o que aconteceu e o que se pede (revisar as sobras ou ignorar; abrir o card ou ignorar). */
export function commitText(item: Pick<InboxItem, 'autoCommit'> & { kind?: InboxItem['kind'] }, tr: Tr = t): string | null {
  const a = commitAlertOf(item);
  if (!a) return null;
  if (a.state === 'failed') return a.note ? tr('inbox.commit.sentenceFailed', { task: a.taskTitle, note: a.note }) : tr('inbox.commit.sentenceFailedBare', { task: a.taskTitle });
  const n = a.files.length;
  return a.sha ? tr('inbox.commit.sentenceReady', { task: a.taskTitle, sha: a.sha, n }) : tr('inbox.commit.sentenceReadyNoSha', { task: a.taskTitle, n });
}

/** Quantos arquivos o item lista na caixa; o resto vai no "…e mais N" (o painel de "Revisar sobras" mostra todos). */
export const COMMIT_FILES_SHOWN = 5;
