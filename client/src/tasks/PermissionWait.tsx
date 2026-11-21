import type { InboxItem, PermissionWait, Task } from '../../../shared/model';
import { formatAgo } from '../format';
import { t } from '../i18n';
import { cardTone } from '../inbox/alertTone';

// A conversa da tarefa espera VOCÊ responder um pedido de permissão (`Task.permissionWait`, derivado do processo no servidor).
// Passados 15 min o servidor marca `stuck` e a tarefa conta como parada. O motivo em pt-BR que ele monta (`stuckState`) não vai na listagem:
// o texto daqui sai de `tool` + `since`, no idioma da tela.

export interface PermissionText {
  /** Passou de 15 min: a tarefa está parada. */
  stuck: boolean;
  /** A linha do selo: o que espera e há quanto tempo. */
  head: string;
  /** A frase inteira, para o `title` e o detalhe. */
  hint: string;
}

/**
 * Os textos do aviso, ou null (sem pedido; `tool` ilegível). `planWaiting`: o cartão já diz "Plano para aprovar", então só a parada repete o aviso.
 * `staffName` é o dono da tarefa (null = sem ficha na lista).
 */
export function permissionText(wait: PermissionWait | undefined, staffName: string | null, now: number, planWaiting = false): PermissionText | null {
  if (!wait || typeof wait.tool !== 'string' || !wait.tool) return null;
  const stuck = wait.stuck === true;
  if (planWaiting && !stuck) return null;
  const since = Date.parse(wait.since);
  const ago = Number.isFinite(since) ? ` · ${formatAgo(Math.max(0, now - since))}` : '';
  const tool = wait.tool === 'ExitPlanMode' ? t('tasks.permPlanTool') : wait.tool;
  const name = staffName ?? t('tasks.pauseStaffFallback');
  return {
    stuck,
    head: t(stuck ? 'tasks.permStuckHead' : 'tasks.permWaitHead', { tool, ago }),
    hint: t(stuck ? 'tasks.permStuckHint' : 'tasks.permWaitHint', { name, tool }),
  };
}

/**
 * O item da caixa que leva ao cartão do pedido na conversa da tarefa: o real (traz `itemId`, a conversa rola até o cartão) ou, enquanto a caixa
 * ainda não o leu, um item só com a conversa (abre nela, no fim). Sem conversa, null.
 */
export function permissionTarget(task: Pick<Task, 'id' | 'staffId' | 'sessionId'>, items: InboxItem[], project: { id: string; name: string }): InboxItem | null {
  const sessionId = task.sessionId;
  if (!sessionId) return null;
  const real = items.find((i) => i.sessionId === sessionId && (i.kind === 'permission' || i.kind === 'plan'));
  if (real) return real;
  return { id: `perm-wait:${task.id}`, kind: 'permission', projectId: project.id, projectName: project.name, sessionId, staffId: task.staffId, name: '', summary: '', at: null };
}

/**
 * Selo do cartão (família do "na fila"): sempre amarelo (tom owner, o mesmo de permission na caixa): a permissão espera o dono decidir.
 * Parada (`is-stuck`): borda grossa e fundo mais forte, além da palavra "Parada" no texto.
 */
export function PermissionWaitBadge({ text }: { text: PermissionText | null }) {
  if (!text) return null;
  return (
    <span className={`task-queue task-permission ${cardTone('owner')}${text.stuck ? ' is-stuck' : ''} small`} title={text.hint}>
      {text.head}
    </span>
  );
}

/** O atalho do cartão: fica fora do botão do cartão (botão não cabe dentro de botão), logo abaixo dele. */
export function PermissionGo({ onOpen }: { onOpen?: () => void }) {
  if (!onOpen) return null;
  return (
    <button className="btn-secondary task-perm-go" onClick={onOpen} title={t('tasks.permOpenTitle')}>
      {t('tasks.permOpen')}
    </button>
  );
}

/** Cartão do pedido no detalhe: o que espera e a regra. O botão que abre o cartão do pedido no chat fica no rodapé fixo do painel. */
export function PermissionWaitBlock({ text }: { text: PermissionText | null }) {
  if (!text) return null;
  return (
    <div className={`task-perm${text.stuck ? ' is-stuck' : ''}`}>
      <b>{text.head}</b>
      <p className="small">{text.hint}</p>
    </div>
  );
}
