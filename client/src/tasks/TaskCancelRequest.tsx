import type { CancelRequest, TaskCreateWarning, TaskStatus } from '../../../shared/model';
import { formatAgo } from '../format';
import { locale, t } from '../i18n';
import { askerName, cancelBadgeText, cancelDelivery, deciderName } from './cancelRequest';

// Pedido de cancelamento de quem pediu a tarefa (`Task.cancelRequest`): selo no cartão e bloco no detalhe, no padrão da dúvida do funcionário.
// E o aviso de possível duplicata devolvido ao criar a tarefa (`TaskCreateResult.warnings`). Os textos saem dos campos (não do `reason`/`message` do
// servidor, que vêm só em pt-BR), então seguem o idioma da tela.

type NameOf = (id: string | null) => string | null;

const DELIVERY_KEY = {
  delivered: 'tasks.cancelReqDelivered',
  waiting: 'tasks.cancelReqWaiting',
  retry: 'tasks.cancelReqRetry',
  sending: 'tasks.cancelReqSending',
} as const;

/** Selo do cartão: "Pedido de cancelamento de <quem pediu>" (esperando o responsável) ou "Cancelamento recusado". Neutro: a decisão é do responsável, não sua. */
export function CancelRequestBadge({ request, nameOf }: { request?: CancelRequest; nameOf: NameOf }) {
  const text = cancelBadgeText(request, nameOf);
  if (!request || !text) return null;
  // Passando o mouse: o motivo do pedido, ou o porquê da recusa.
  const why = request.status === 'pending' ? request.reason : request.answer;
  const title = why ? `${text}: ${why}` : text;
  return (
    <span className="task-badge task-cancelreq small" title={title}>
      {text}
    </span>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Bloco do detalhe: quem pediu, o motivo e quando; onde o pedido está (só esperando) ou a decisão do responsável (aceito, recusado com o porquê, sem efeito).
 * `open`: a tarefa ainda não está pronta nem cancelada (só então "Cancelar tarefa" ainda faz sentido). `staffName`: o responsável pela tarefa.
 */
export function CancelRequestBlock({
  request,
  staffName,
  nameOf,
  now,
  open,
}: {
  request?: CancelRequest;
  staffName: string | null;
  nameOf: NameOf;
  now: number;
  open: boolean;
}) {
  if (!request) return null;
  const asker = askerName(request, nameOf);
  const worker = staffName ?? t('tasks.ownerFallback');
  const ago = (iso: string) => formatAgo(now - Date.parse(iso));
  const status = request.status;
  const label =
    status === 'pending'
      ? t('tasks.cancelReqStatusPending', { name: worker })
      : status === 'accepted'
        ? t('tasks.cancelReqStatusAccepted')
        : status === 'refused'
          ? t('tasks.cancelReqStatusRefused')
          : t('tasks.cancelReqStatusMoot');
  return (
    <section className={`task-cancelreq-box${status === 'pending' ? '' : ' is-decided'}`} aria-label={t('tasks.cancelReqTitle')}>
      <header className="task-doubt-head">
        <b>{t('tasks.cancelReqTitle')}</b>
        <span className="task-badge small">{label}</span>
      </header>
      <p className="muted small" title={when(request.at)}>
        {t('tasks.cancelReqAsked', { name: asker, ago: ago(request.at) })}
      </p>
      <p className="task-doubt-text">{t('tasks.cancelReqReason', { reason: request.reason })}</p>
      {status === 'pending' && (
        <>
          <p className="muted small">{t(DELIVERY_KEY[cancelDelivery(request)], { name: worker })}</p>
          {open && <p className="muted small">{t('tasks.cancelReqPendingHint')}</p>}
        </>
      )}
      {status === 'accepted' && (
        <p className="muted small" title={request.decidedAt && when(request.decidedAt)}>
          {t('tasks.cancelReqAccepted', { name: deciderName(request, nameOf), ago: request.decidedAt ? ago(request.decidedAt) : '' }).trim()}
        </p>
      )}
      {status === 'refused' && (
        <div className="task-doubt-answer">
          <p className="small muted" title={request.decidedAt && when(request.decidedAt)}>
            {t('tasks.cancelReqRefused', { name: deciderName(request, nameOf), ago: request.decidedAt ? ago(request.decidedAt) : '' }).trim()}
          </p>
          {request.answer && <p className="task-doubt-text">{t('tasks.cancelReqAnswer', { answer: request.answer })}</p>}
          {request.notifyRetry && <p className="muted small">{t('tasks.cancelReqNotifyRetry', { name: asker })}</p>}
          {open && <p className="muted small">{t('tasks.cancelReqRefusedHint')}</p>}
        </div>
      )}
      {status === 'moot' && <p className="muted small">{t('tasks.cancelReqMoot')}</p>}
    </section>
  );
}

/**
 * Aviso de possível duplicata, depois de criar a tarefa na tela: o mesmo solicitante passou há pouco uma tarefa de título parecido ao mesmo responsável. A tarefa
 * nova foi criada mesmo assim; o aviso só põe as duas lado a lado para você cancelar a que for engano. Amarelo (é você quem decide), como "Você aprova ou reprova".
 */
export function DuplicateNote({
  warnings,
  now,
  statusLabel,
  onOpen,
  onClose,
  createdId,
}: {
  warnings: TaskCreateWarning[];
  now: number;
  statusLabel: (status: TaskStatus) => string;
  onOpen: (taskId: string) => void;
  onClose: () => void;
  /** A tarefa que acabou de ser criada. */
  createdId: string | null;
}) {
  if (!warnings.length) return null;
  return (
    <section className="task-dup" role="status" aria-label={t('tasks.dupTitle')}>
      <p>{t('tasks.dupTitle')}</p>
      <ul>
        {warnings.map((w) => (
          <li key={w.taskId}>
            <span>{t('tasks.dupLine', { title: w.title, status: statusLabel(w.status), ago: formatAgo(now - Date.parse(w.createdAt)) })}</span>{' '}
            <button type="button" className="link" onClick={() => onOpen(w.taskId)}>
              {t('tasks.dupOpen')}
            </button>
          </li>
        ))}
      </ul>
      <p className="small">{t('tasks.dupHint')}</p>
      <p className="actions">
        {createdId && (
          <button type="button" className="btn-secondary" onClick={() => onOpen(createdId)}>
            {t('tasks.dupOpenNew')}
          </button>
        )}
        <button type="button" className="btn-secondary" onClick={onClose}>
          {t('tasks.dupDismiss')}
        </button>
      </p>
    </section>
  );
}
