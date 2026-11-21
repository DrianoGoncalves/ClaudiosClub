import { useEffect, useRef, useState } from 'react';
import { isClosed, type InboxItem, type InboxKind, type StaffProfile, type Task } from '../../../shared/model';
import { api, filesApi, withUsageConfirm } from '../api';
import { fixNoteOf, fixTargetOf, runFix, type FixNote, type FixTarget } from '../chat/fixSecret';
import { secretFileOf } from '../chat/secretAlerts';
import { SecretVerdictRow } from '../chat/SecretVerdictRow';
import { formatAgo } from '../format';
import { t } from '../i18n';
import { RecommendationBadge } from '../tasks/FollowUpFields';
import { followUpHasMore } from '../tasks/followUp';
import { fullText, hasFields, taskFinished } from '../tasks/followUpNotice';
import { giveBackBody, giveBackHeldNote } from '../tasks/noCode';
import { FollowUpDecide, FollowUpDoneNote, FollowUpGoneNote } from '../tasks/TaskFollowUps';
import { TaskCloseDialog } from '../tasks/TaskCloseDialog';
import { taskIn, useProjectTasks } from '../tasks/useProjectTasks';
import { isInsideDialog } from '../lib/dialogStore';
import { isLocalPage } from '../office/folderPick';
import { sandboxOf } from './codexSandbox';
import { CARD_TONE, INBOX_TONE, cardTone, toneClass } from './alertTone';
import { deniedAction } from './deniedAlert';
import { inboxText, inboxWho } from './inboxText';
import { ReviewShortcutForm } from './ReviewShortcut';
import { reviewShortcutOf } from './delegateReview';
import { SandboxFix } from './SandboxFix';
import { secretVerdictOf } from './secretVerdict';
import { alertAction, stuckNoCodeOf, stuckOf, type InboxOpen } from './taskAlerts';
import { isResolved, pendingOf } from './resolved';
import type { InboxView } from './useInbox';

// Botão "precisa de mim" no topo do quadro, com o contador, e a lista que abre embaixo dele.
// Clicar num item abre o painel de quem está esperando (ou o card da tarefa, nos itens de tarefa).

const KIND_LABEL: Record<InboxKind, string> = {
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
  question: t('inbox.kindQuestion'),
  stuck: t('inbox.kindStuck'),
  followUp: t('inbox.kindFollowUp'),
  denied: t('inbox.kindDenied'),
};

/** O que fazer com quem espera uma tarefa cancelada (item 'blocked'), na ordem dos botões. */
const BLOCKER_ACTIONS = [
  { action: 'release', label: t('inbox.blockerRelease'), title: t('inbox.blockerReleaseTitle') },
  { action: 'cancel', label: t('inbox.blockerCancel'), title: t('inbox.blockerCancelTitle') },
  { action: 'wait', label: t('inbox.blockerWait'), title: t('inbox.blockerWaitTitle') },
] as const;

/** Itens que só se dispensam ganham um X no canto; o title explica o que o X faz. Segredo tem duas ações, com texto. */
function dismissTitleOf(item: InboxItem): string | null {
  // Só a pergunta achada no texto do chat (kind 'waiting'): a dúvida de tarefa (kind 'question') não se dispensa, some quando é respondida.
  if (item.kind === 'waiting' && item.id.startsWith('question:')) return t('office.questionSeenTitle');
  if (item.id.startsWith('waiting:')) return t('inbox.dismissWaitingTitle');
  if (item.kind === 'routine') return t('inbox.dismissTitle');
  // Erro (`error:`/`cap:`): o servidor guarda o carimbo, então outro erro da mesma conversa volta a avisar. O aviso do sandbox do Codex só volta se a política passar a 0 e falhar de novo.
  if (item.kind === 'error') return t(item.codexSandbox ? 'inbox.sandbox.dismissTitle' : 'inbox.dismissTitle');
  // Ação barrada: o servidor guarda o turno ignorado, então só uma negação de turno novo volta a avisar.
  if (item.kind === 'denied') return t('inbox.denied.dismissTitle');
  return null;
}

export function InboxMenu({
  inbox,
  titleOf,
  staff = [],
  onOpen,
  onOpenFile,
  onOpenSheet,
  initialOpen = false,
  initialTasks,
}: {
  /** Só teste: a renderização sem efeitos não clica no botão nem lê o quadro, então o menu já nasce aberto e com as tarefas lidas. */
  initialOpen?: boolean;
  initialTasks?: ReadonlyMap<string, Task[]>;
  inbox: InboxView;
  /** Título da conversa por sessionId (manual, gerado ou assunto); sem título conhecido, o item não mostra a linha. */
  titleOf: ReadonlyMap<string, string>;
  /** As fichas (de todos os projetos): o diálogo de cancelar mostra o nome de quem cuida de cada tarefa que espera, e o atalho "Delegar revisão" oferece as do projeto. */
  staff?: ReadonlyArray<StaffProfile>;
  onOpen: InboxOpen;
  /** Abre o arquivo comum do aviso de segredo na aba Arquivos do projeto do item (na linha, se vier); sem ele, só o arquivo de segredo tem "corrigir" (abre fora do Club). */
  onOpenFile?: (item: InboxItem, path: string, line?: number) => void;
  /** Abre a ficha de quem foi barrado (atalho do aviso de ação barrada); sem ele, o atalho que leva à ficha não aparece. */
  onOpenSheet?: (item: InboxItem) => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLDivElement>(null);
  // Só o que espera o dono entra no número; o erro já resolvido fica na lista, com selo, até ser ignorado.
  const count = pendingOf(inbox.items).length;
  /** O item com uma ação de tarefa em andamento e o último erro dela (a tarefa pode ter mudado entre a leitura e o clique). */
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null);
  /** "Já decidido por outro caminho" (409 do follow-up): a releitura tira o item da lista, então o aviso fica aqui, no menu, até fechar ou nova tentativa. */
  const [followUpGone, setFollowUpGone] = useState<string | null>(null);
  /** O que a última decisão de follow-up fez ("Card t-… criado…"): o item decidido some da lista, então a frase fica aqui, no menu, até fechar ou nova decisão. */
  const [followUpDone, setFollowUpDone] = useState<string | null>(null);
  /** O item de segredo cujo "corrigir" está abrindo o arquivo, e o que o último clique deu (a frase fica no item até fechar o menu). */
  const [fixing, setFixing] = useState<string | null>(null);
  /** O card sem código cujo "Devolver" deixou a mensagem guardada (nada falhou): aviso neutro no item, até fechar o menu ou novo clique. */
  const [heldNote, setHeldNote] = useState<{ id: string; text: string } | null>(null);
  const [fixNote, setFixNote] = useState<({ id: string } & FixNote) | null>(null);
  /** Cancelar um cartão esquecido ou sem código: o mesmo diálogo do quadro (motivo e o que fazer com quem espera), nunca um clique solto. */
  const [closing, setClosing] = useState<{ item: InboxItem; task: Task; tasks: Task[] } | null>(null);
  /** O item da revisão parada com o seletor de "Delegar revisão" aberto. */
  const [delegating, setDelegating] = useState<string | null>(null);
  /** Quem recebeu a revisão pedida pelo atalho: o item some da lista, então a frase fica aqui, no menu, até fechar ou novo pedido. */
  const [reviewAsked, setReviewAsked] = useState<string | null>(null);
  const [reviewReadError, setReviewReadError] = useState<string | null>(null);
  // O follow-up pede a tarefa de origem (Finalizado?, o responsável dela, o texto inteiro) e o atalho "Delegar revisão" o estado da revisão (status, quem revisou):
  // lê o quadro dos projetos que têm um desses itens, só com o menu aberto.
  const fuProjects = inbox.items.filter((i) => (i.kind === 'followUp' && i.followUp) || stuckOf(i)?.humanAction === 'review').map((i) => i.projectId);
  const fuTasks = useProjectTasks(fuProjects, open && fuProjects.length > 0, initialTasks);

  /** Lê o quadro do projeto (para achar quem espera a tarefa) e abre o diálogo de cancelar a tarefa `taskId` do item. */
  const askCancel = (item: InboxItem, taskId: string) =>
    run(item, async () => {
      const tasks = (await api.tasks(item.projectId)) ?? [];
      const task = tasks.find((x) => x.id === taskId);
      // Sumiu ou já fechou entre a leitura da caixa e o clique: `run` relê a caixa e o item se vai.
      if (task && !isClosed(task)) setClosing({ item, task, tasks });
    });

  /** Devolve o card sem código ao responsável: uma mensagem na conversa de trabalho dele, que tira a marca; sem a conversa, o erro diz para cancelar. */
  const giveBack = (item: InboxItem, taskId: string) =>
    run(item, async () => {
      setHeldNote(null);
      const task = ((await api.tasks(item.projectId)) ?? []).find((x) => x.id === taskId);
      const body = giveBackBody(task);
      if (!body) throw new Error(t('tasks.noCodeNoSession'));
      const held = giveBackHeldNote(await withUsageConfirm((force) => api.chatSend(item.projectId, { ...body, force })));
      if (held) setHeldNote({ id: item.id, text: held });
    });

  /** "Corrigir" do aviso de segredo: arquivo comum abre a aba Arquivos (e o menu fecha); arquivo de segredo abre no editor do computador e a frase fica no item. */
  const fix = async (item: InboxItem, target: FixTarget) => {
    if (fixing) return;
    setFixing(item.id);
    setFixNote(null);
    try {
      const openFiles = onOpenFile && ((path: string, line?: number) => {
        setOpen(false);
        onOpenFile(item, path, line);
      });
      const outcome = await runFix(target, { projectId: item.projectId, local: isLocalPage(window.location.hostname), openEditor: filesApi.openEditor, openFiles });
      const note = fixNoteOf(outcome);
      setFixNote(note && { id: item.id, ...note });
    } finally {
      setFixing(null);
    }
  };

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
    if (!open) {
      setFollowUpGone(null);
      setFollowUpDone(null);
      setDelegating(null);
      setReviewAsked(null);
      setReviewReadError(null);
      setFixNote(null);
      setHeldNote(null);
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node) && !isInsideDialog(e.target)) setOpen(false);
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
          <FollowUpGoneNote message={followUpGone} className="inbox-fu-gone" />
          <FollowUpDoneNote message={followUpDone} className="inbox-fu-done" />
          <FollowUpDoneNote message={reviewAsked} className="inbox-fu-done" />
          {reviewReadError && (
            <p className="error small inbox-fu-done" role="alert">
              {reviewReadError}
            </p>
          )}
          {inbox.items.length === 0 ? (
            <p className="muted small inbox-empty">{t('inbox.nothingBody')}</p>
          ) : (
            <ul className="inbox-list">
              {inbox.items.map((item) => {
                const dismissTitle = dismissTitleOf(item);
                const topic = titleOf.get(item.sessionId);
                const secretFile = item.kind === 'secret' ? secretFileOf(item) : null;
                const fixTarget = item.kind === 'secret' ? fixTargetOf(item, !!onOpenFile) : null;
                const secretVerdict = item.kind === 'secret' ? secretVerdictOf(item) : null;
                const action = alertAction(item);
                const denied = deniedAction(item);
                const noCode = stuckNoCodeOf(item);
                const fu = item.kind === 'followUp' ? item.followUp : undefined;
                const fuTask = fu ? taskIn(fuTasks.byProject, item.projectId, fu.taskId) : null;
                const stuck = stuckOf(item);
                const stuckTask = stuck ? taskIn(fuTasks.byProject, item.projectId, stuck.taskId) : null;
                const delegate = stuckTask ? reviewShortcutOf(item, stuckTask, staff) : null;
                const sandbox = sandboxOf(item);
                const tone = toneClass(isResolved(item) ? CARD_TONE.resolved : INBOX_TONE[item.kind]);
                const row = (
                  <>
                    <span className="inbox-kind">{KIND_LABEL[item.kind]}</span>
                    <span className="inbox-who">
                      <b>{inboxWho(item)}</b>
                      {item.name && item.projectName && <span className="muted"> · {item.projectName}</span>}
                      {isResolved(item) && <span className={`task-badge small inbox-resolved ${cardTone('resolved')}`}>{t('inbox.resolved')}</span>}
                    </span>
                    {topic && <span className="inbox-topic" title={topic}>{topic}</span>}
                    <span className="inbox-summary" title={inboxText(item)}>{inboxText(item)}</span>
                    {item.at && <span className="muted small inbox-at">{formatAgo(now - Date.parse(item.at))}</span>}
                  </>
                );
                return (
                <li key={item.id} className={[dismissTitle && 'inbox-has-x', isResolved(item) && 'is-resolved'].filter(Boolean).join(' ') || undefined}>
                  {item.codexSandbox ? (
                    // Aviso da máquina (sem projeto nem conversa): não há para onde ir, então a linha não é botão; o que se faz está logo abaixo (copiar o comando) e o × ignora.
                    <div className={`inbox-item inbox-${item.kind} inbox-sandbox ${tone}`}>{row}</div>
                  ) : (
                    <button
                      role="menuitem"
                      className={`inbox-item inbox-${item.kind} ${tone}`}
                      onClick={() => {
                        setOpen(false);
                        onOpen(item);
                      }}
                    >
                      {row}
                    </button>
                  )}
                  {sandbox && <SandboxFix alert={sandbox} className="inbox-sandbox-fix" />}
                  {item.kind === 'secret' && secretVerdict && (
                    <div className="inbox-secret-verdict">
                      <SecretVerdictRow item={item} />
                    </div>
                  )}
                  {item.kind === 'secret' && (
                    <span className="inbox-dismiss">
                      {secretFile && fixTarget && (
                        <button
                          className="link small"
                          disabled={fixing === item.id}
                          title={t(secretFile.blocked ? 'chat.secretOpenEditorTitle' : 'chat.secretOpenFileTitle', { path: secretFile.path })}
                          onClick={() => void fix(item, fixTarget)}
                        >
                          {t('inbox.secretOpenFile')}
                        </button>
                      )}
                      <button className="link small" title={t('inbox.secretTitle')} onClick={() => void inbox.dismiss(item)}>
                        {t('inbox.secretDone')}
                      </button>
                      <button className="link small" title={t(secretVerdict?.verdict === 'exposed' ? 'office.notSecretExposedTitle' : 'office.notSecretTitle')} onClick={() => void inbox.dismiss(item, { notSecret: true })}>
                        {t('office.notSecret')}
                      </button>
                      {fixNote?.id === item.id && (
                        <span className={fixNote.ok ? 'small inbox-fix-ok' : 'error small'} role={fixNote.ok ? 'status' : 'alert'}>
                          {fixNote.text}
                        </span>
                      )}
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
                        onClick={() => void askCancel(item, item.notStarted!.taskId)}
                      >
                        {t('inbox.notStartedCancel')}
                      </button>
                      {failed?.id === item.id && <span className="error small" role="alert">{failed.message}</span>}
                    </span>
                  )}
                  {fu && (
                    <>
                      {/* O que importa para decidir, à vista: a recomendação e, com a tarefa já Finalizada, o selo. */}
                      <div className="inbox-fu-meta">
                        <RecommendationBadge recommendation={fu.recommendation} />
                        {taskFinished(fuTask) && <span className={`task-badge small fu-done ${cardTone('resolved')}`}>{t('tasks.statusDone')}</span>}
                      </div>
                      {hasFields(fu) ? (
                        fu.impact && (
                          <p className="small inbox-fu-impact">
                            <b>{t('tasks.fuImpact')}</b> {fu.impact}
                          </p>
                        )
                      ) : (
                        /* Follow-up antigo, sem os campos do revisor: o achado inteiro (até 600 caracteres) só quando a linha do item não o mostra por completo. */
                        followUpHasMore(fu.text) && (
                          <details className="inbox-fu-text">
                            <summary>{t('inbox.followUp.seeText')}</summary>
                            <p>{fu.text}</p>
                          </details>
                        )
                      )}
                      <FollowUpDecide
                        compact
                        projectId={item.projectId}
                        taskId={fu.taskId}
                        followUp={{ id: fu.followUpId, title: fu.title, text: fullText(fuTask, fu.followUpId, fu.text), staffId: fu.staffId }}
                        task={fuTask}
                        loading={!fuTasks.byProject.has(item.projectId)}
                        team={staff.filter((s) => s.projectId === item.projectId)}
                        onDone={async () => {
                          await inbox.refresh();
                          await fuTasks.reload();
                        }}
                        onGone={setFollowUpGone}
                        onDecided={setFollowUpDone}
                        onOpenCard={() => {
                          setOpen(false);
                          onOpen(item, { taskId: fu.taskId });
                        }}
                      />
                    </>
                  )}
                  {noCode && (
                    <>
                      {/* A análise ou a resposta que o responsável deu ao terminar costuma estar aqui: é o que se lê para decidir. */}
                      {noCode.summary && (
                        <details className="inbox-fu-text">
                          <summary>{t('inbox.noCode.seeSaid')}</summary>
                          <p>{noCode.summary}</p>
                        </details>
                      )}
                      <span className="inbox-dismiss">
                        <button className="link small" title={t('tasks.noCodeCancelTitle')} disabled={busy === item.id} onClick={() => void askCancel(item, noCode.taskId)}>
                          {t('tasks.noCodeCancel')}
                        </button>
                        <button className="link small" title={t('tasks.noCodeGiveBackTitle')} disabled={busy === item.id} onClick={() => void giveBack(item, noCode.taskId)}>
                          {t('tasks.noCodeGiveBack')}
                        </button>
                        {heldNote?.id === item.id && <span className="small inbox-fix-ok" role="status">{heldNote.text}</span>}
                        {failed?.id === item.id && <span className="error small" role="alert">{failed.message}</span>}
                      </span>
                    </>
                  )}
                  {action && (
                    <span className="inbox-dismiss">
                      <button
                        className="link small"
                        title={action.title}
                        disabled={busy === item.id}
                        onClick={() => {
                          // Reenviar o ajuste roda aqui mesmo (a caixa relê e o item some se foi); as outras ações abrem o card.
                          if (action.direct) return void run(item, () => api.resendHeld(item.projectId, action.taskId));
                          setOpen(false);
                          onOpen(item, { taskId: action.taskId });
                        }}
                      >
                        {action.label}
                      </button>
                      {delegate && (
                        <button className="link small inbox-delegate" title={t('inbox.act.delegateTitle')} aria-expanded={delegating === item.id} aria-controls={`inbox-review-${item.id}`} onClick={() => setDelegating(delegating === item.id ? null : item.id)}>
                          {t('tasks.reviewDelegate')}
                        </button>
                      )}
                      {action.direct && failed?.id === item.id && <span className="error small" role="alert">{failed.message}</span>}
                    </span>
                  )}
                  {delegate && stuckTask && delegating === item.id && (
                    <ReviewShortcutForm
                      id={`inbox-review-${item.id}`}
                      projectId={item.projectId}
                      task={stuckTask}
                      reviewers={delegate.reviewers}
                      onAsked={async (name) => {
                        setReviewAsked(t('inbox.act.delegated', { name }));
                        setReviewReadError(null);
                        setDelegating(null);
                        // O seletor já saiu da tela: um erro da releitura não tem onde aparecer ali, vai para o topo do menu.
                        try {
                          await inbox.refresh();
                          await fuTasks.reload();
                        } catch (e) {
                          setReviewReadError((e as Error).message);
                        }
                      }}
                    />
                  )}
                  {denied && (denied.to === 'chat' || onOpenSheet) && (
                    <span className="inbox-dismiss">
                      <button
                        className="link small"
                        title={denied.title}
                        onClick={() => {
                          setOpen(false);
                          // A conversa é o alvo do próprio item; a ficha, a de quem foi barrado.
                          if (denied.to === 'sheet') onOpenSheet?.(item);
                          else onOpen(item);
                        }}
                      >
                        {denied.label}
                      </button>
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
