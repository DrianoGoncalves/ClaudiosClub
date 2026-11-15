import { useEffect, useRef, useState } from 'react';
import { isClosed, type InboxItem, type StaffProfile, type Task } from '../../../shared/model';
import { api, withUsageConfirm } from '../api';
import { formatAgo } from '../format';
import { t } from '../i18n';
import { TaskCloseDialog } from '../tasks/TaskCloseDialog';
import { inboxText, inboxWho } from './inboxText';
import type { InboxView } from './useInbox';

// Botão "precisa de mim" no topo do quadro, com o contador, e a lista que abre embaixo dele.
// Clicar num item abre o painel de quem está esperando.

const KIND_LABEL: Record<InboxItem['kind'], string> = {
  plan: t('inbox.kindPlan'),
  permission: t('inbox.kindPermission'),
  secret: t('inbox.kindSecret'),
  waiting: t('inbox.kindWaiting'),
  error: t('inbox.kindError'),
  routine: t('inbox.kindRoutine'),
  orphan: t('inbox.kindOrphan'),
  usage: t('inbox.kindUsage'),
  blocked: t('inbox.kindBlocked'),
  notStarted: t('inbox.kindNotStarted'),
};

/** O que fazer com quem espera uma tarefa cancelada (item 'blocked'), na ordem dos botões. */
const BLOCKER_ACTIONS = [
  { action: 'release', label: t('inbox.blockerRelease'), title: t('inbox.blockerReleaseTitle') },
  { action: 'cancel', label: t('inbox.blockerCancel'), title: t('inbox.blockerCancelTitle') },
  { action: 'wait', label: t('inbox.blockerWait'), title: t('inbox.blockerWaitTitle') },
] as const;

/** Itens que só se dispensam ganham um X no canto; o title explica o que o X faz. Segredo tem duas ações, com texto. */
function dismissTitleOf(item: InboxItem): string | null {
  if (item.id.startsWith('question:')) return t('office.questionSeenTitle');
  if (item.id.startsWith('waiting:')) return t('inbox.dismissWaitingTitle');
  if (item.kind === 'routine') return t('inbox.dismissTitle');
  return null;
}

export function InboxMenu({
  inbox,
  topicOf,
  staff = [],
  onOpen,
}: {
  inbox: InboxView;
  /** Assunto da conversa por sessionId; sem assunto conhecido, o item não mostra a linha. */
  topicOf: ReadonlyMap<string, string>;
  /** As fichas (de todos os projetos): o diálogo de cancelar mostra o nome de quem cuida de cada tarefa que espera. */
  staff?: ReadonlyArray<Pick<StaffProfile, 'id' | 'name' | 'projectId'>>;
  onOpen: (item: InboxItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLDivElement>(null);
  const count = inbox.items.length;
  /** O item com uma ação de tarefa em andamento e o último erro dela (a tarefa pode ter mudado entre a leitura e o clique). */
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null);
  /** Cancelar um cartão esquecido: o mesmo diálogo do quadro (motivo e o que fazer com quem espera), nunca um clique solto. */
  const [closing, setClosing] = useState<{ item: InboxItem; task: Task; tasks: Task[] } | null>(null);

  /** Lê o quadro do projeto (para achar quem espera a tarefa) e abre o diálogo de cancelar. */
  const askCancel = (item: InboxItem) =>
    run(item, async () => {
      const tasks = (await api.tasks(item.projectId)) ?? [];
      const task = tasks.find((x) => x.id === item.notStarted!.taskId);
      // Sumiu ou já fechou entre a leitura da caixa e o clique: `run` relê a caixa e o item se vai.
      if (task && !isClosed(task)) setClosing({ item, task, tasks });
    });

  /** Roda a ação de tarefa do item e relê a caixa; o erro aparece no próprio item. */
  const run = async (item: InboxItem, call: () => Promise<unknown>) => {
    setBusy(item.id);
    setFailed(null);
    try {
      await call();
      await inbox.refresh();
    } catch (e) {
      setFailed({ id: item.id, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  // Fecha ao clicar fora ou apertar Esc; o "há X min" acompanha o relógio.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      clearInterval(timer);
    };
  }, [open]);

  return (
    <div className="inbox" ref={root}>
      <button
        className={`inbox-button ${count ? 'inbox-has' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={count ? t(count === 1 ? 'inbox.countOne' : 'inbox.countOther', { count }) : t('inbox.nothingTitle')}
        onClick={() => setOpen(!open)}
      >
        {t('inbox.button')}
        {count > 0 && <span className="inbox-count">{count}</span>}
      </button>
      {open && (
        <div className="inbox-menu" role="menu">
          {count === 0 ? (
            <p className="muted small inbox-empty">{t('inbox.nothingBody')}</p>
          ) : (
            <ul className="inbox-list">
              {inbox.items.map((item) => {
                const dismissTitle = dismissTitleOf(item);
                const topic = topicOf.get(item.sessionId);
                return (
                <li key={item.id} className={dismissTitle ? 'inbox-has-x' : undefined}>
                  <button
                    role="menuitem"
                    className={`inbox-item inbox-${item.kind}`}
                    onClick={() => {
                      setOpen(false);
                      onOpen(item);
                    }}
                  >
                    <span className="inbox-kind">{KIND_LABEL[item.kind]}</span>
                    <span className="inbox-who">
                      <b>{inboxWho(item)}</b>
                      {item.name && item.projectName && <span className="muted"> · {item.projectName}</span>}
                    </span>
                    {topic && <span className="inbox-topic" title={topic}>{topic}</span>}
                    <span className="inbox-summary" title={item.kind === 'blocked' || item.kind === 'notStarted' ? inboxText(item) : undefined}>{inboxText(item)}</span>
                    {item.at && <span className="muted small inbox-at">{formatAgo(now - Date.parse(item.at))}</span>}
                  </button>
                  {item.kind === 'secret' && (
                    <span className="inbox-dismiss">
                      <button className="link small" title={t('inbox.secretTitle')} onClick={() => void inbox.dismiss(item)}>
                        {t('inbox.secretDone')}
                      </button>
                      <button className="link small" title={t('office.notSecretTitle')} onClick={() => void inbox.dismiss(item, { notSecret: true })}>
                        {t('office.notSecret')}
                      </button>
                    </span>
                  )}
                  {item.kind === 'blocked' && item.blocked?.blockerStatus === 'cancelled' && (
                    <span className="inbox-dismiss">
                      {BLOCKER_ACTIONS.map(({ action, label, title }) => (
                        <button
                          key={action}
                          className="link small"
                          title={title}
                          disabled={busy === item.id}
                          onClick={() => void run(item, () => api.taskBlocker(item.projectId, item.blocked!.taskId, item.blocked!.blockerId, action))}
                        >
                          {label}
                        </button>
                      ))}
                      {failed?.id === item.id && <span className="error small" role="alert">{failed.message}</span>}
                    </span>
                  )}
                  {item.kind === 'notStarted' && item.notStarted && (
                    <span className="inbox-dismiss">
                      <button
                        className="link small"
                        title={item.notStarted.staffId ? t('inbox.notStartedStartTitle') : t('tasks.pickOwner')}
                        disabled={busy === item.id || !item.notStarted.staffId}
                        onClick={() => void run(item, () => withUsageConfirm((force) => api.startTask(item.projectId, item.notStarted!.taskId, force)))}
                      >
                        {t('inbox.notStartedStart')}
                      </button>
                      <button
                        className="link small"
                        title={t('inbox.notStartedCancelTitle')}
                        disabled={busy === item.id}
                        onClick={() => void askCancel(item)}
                      >
                        {t('inbox.notStartedCancel')}
                      </button>
                      {failed?.id === item.id && <span className="error small" role="alert">{failed.message}</span>}
                    </span>
                  )}
                  {dismissTitle && (
                    <button className="drawer-close inbox-x" title={dismissTitle} aria-label={t('inbox.dismiss')} onClick={() => void inbox.dismiss(item)}>
                      ×
                    </button>
                  )}
                </li>
                );
              })}
            </ul>
          )}
          {inbox.canNotify && (
            <label
              className="check small inbox-notify"
              title={t('inbox.notifyTitle')}
            >
              <input type="checkbox" checked={inbox.notify} onChange={(e) => void inbox.setNotify(e.target.checked)} /> {t('inbox.notifyLabel')}
            </label>
          )}
        </div>
      )}
      {closing && (
        <TaskCloseDialog
          key={closing.task.id}
          mode="cancel"
          task={closing.task}
          tasks={closing.tasks}
          nameOf={(id) => staff.find((s) => s.projectId === closing.item.projectId && s.id === id)?.name ?? null}
          onConfirm={async (input) => {
            const dependents = Object.keys(input.dependents).length ? input.dependents : undefined;
            await api.cancelTask(closing.item.projectId, closing.task.id, { ...(input.reason && { reason: input.reason }), ...(dependents && { dependents }) });
            await inbox.refresh();
          }}
          onClose={() => setClosing(null)}
        />
      )}
    </div>
  );
}
