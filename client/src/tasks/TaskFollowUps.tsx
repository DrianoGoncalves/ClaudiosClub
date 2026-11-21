import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { FollowUp, FollowUpCardResult, Task } from '../../../shared/model';
import { ApiError, api } from '../api';
import { formatAgo } from '../format';
import { locale, t } from '../i18n';
import { cardTone } from '../inbox/alertTone';
import { FollowUpFieldsView } from './FollowUpFields';
import { decisionErrorText, followUpAuthor, followUpState, followUpsOf, openFollowUps, type FollowUpDecision } from './followUp';
import {
  DISCARD_REASONS,
  cardBody,
  cardDraft,
  concludeDecision,
  discardDecision,
  discardReasonLabel,
  discardReasonText,
  followUpSummary,
  followUpTitle,
  hasFields,
  taskFinished,
  whoWouldDo,
  type CardBody,
  type DiscardReason,
  type TeamMember,
} from './followUpNotice';

// Follow-up de revisão (`Task.followUps`, ver ./followUp.ts): selo no cartão, bloco no detalhe e, em cada aberto, as duas saídas: "Criar card" (com responsável e texto editáveis) ou
// "Descartar" (com o motivo); com a tarefa já Finalizada, "Revisar" (o mesmo card) ou "Concluir" (encerra sem card). O balão da conversa de trabalho e a caixa "precisa de mim" usam as mesmas
// saídas (`FollowUpDecide`). Quem decide pela tela é você; o gestor decide pela conversa dele.

type NameOf = (id: string | null) => string | null;

const when = (iso: string) => new Date(iso).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Selo do cartão: "2 follow-ups, 1 vale fazer". Ocupa o lugar do "Aprovada" enquanto houver follow-up aberto. Amarelo quando algum espera você; senão neutro. Só texto: o cartão é um botão. */
export function FollowUpBadge({ task }: { task: Pick<Task, 'followUps'> }) {
  const open = openFollowUps(task);
  if (!open.length) return null;
  const mine = open.some((f) => f.to === 'owner');
  return (
    <span className={`task-badge task-followup small${mine ? ` ${cardTone('owner')}` : ''}`} title={t(mine ? 'tasks.fuBadgeMineHint' : 'tasks.fuBadgeHint')}>
      {followUpSummary(open)}
    </span>
  );
}

/** O que o envio de uma decisão deixou: o erro a mostrar (null se deu certo) e se foi o 409 (já decidido por outro caminho). */
export interface DecisionOutcome {
  error: string | null;
  gone: boolean;
}

/**
 * Roda a chamada de decidir (`call`) e depois `onDone`. Nunca rejeita: quem chama reabilita os botões depois dela, falhe o que falhar. Com 409 roda `onDone` também, para a lista largar o
 * follow-up, e devolve `gone`: a releitura tira o follow-up de cena (a caixa e o balão o perdem; o detalhe o troca por "decidido"), e com ele o `FollowUpDecide` e o erro que ele guardava;
 * quem mostra o aviso é o pai (`FollowUpGoneNote`). Se `onDone` falha depois de decidir, o erro dele é o mostrado. `value`: o que a chamada devolveu.
 */
async function runDecision<T>(call: () => Promise<T>, onDone: () => void | Promise<void>): Promise<DecisionOutcome & { value?: T }> {
  let value: T;
  try {
    value = await call();
  } catch (err) {
    const gone = err instanceof ApiError && err.status === 409;
    if (gone) {
      try {
        await onDone();
      } catch {
        // O erro a mostrar é o da decisão; a lista se corrige na próxima leitura.
      }
    }
    return { error: decisionErrorText(err), gone };
  }
  try {
    await onDone();
    return { error: null, gone: false, value };
  } catch (err) {
    return { error: decisionErrorText(err), gone: false };
  }
}

type Ref = { projectId: string; taskId: string; followUpId: string };

/** Descartar (com ou sem motivo) ou marcar "virou card": a rota `resolve`. */
export async function sendDecision(ref: Ref, decision: FollowUpDecision, onDone: () => void | Promise<void>): Promise<DecisionOutcome> {
  const { error, gone } = await runDecision(() => api.resolveFollowUp(ref.projectId, ref.taskId, ref.followUpId, decision), onDone);
  return { error, gone };
}

/** Criar o card em um passo: a rota `card`. Devolve também o card criado (para dizer qual é). */
export async function sendCard(ref: Ref, body: CardBody, onDone: () => void | Promise<void>): Promise<DecisionOutcome & { card: FollowUpCardResult['task'] | null }> {
  const { error, gone, value } = await runDecision(() => api.createFollowUpCard(ref.projectId, ref.taskId, ref.followUpId, body), onDone);
  return { error, gone, card: value?.task ?? null };
}

/** Onde o envio de uma decisão deixa o que aconteceu: os estados do formulário (`setBusy`, `setError`) e os avisos do pai (`onGone`, `onDecided`). */
export interface SubmitSetters {
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  onGone?: (message: string | null) => void;
  onDecided?: (message: string | null) => void;
}

/**
 * O que o formulário faz ao confirmar, com os setters de fora (como `sendDecision`, para se testar sem tela): ocupado e avisos limpos; roda `go`; o 409 (`gone`) sobe como aviso para o pai
 * (`onGone`), e sem `onGone` fica sob o formulário; outro erro fica sob o formulário; deu certo, a frase do que foi feito sobe por `onDecided`. Ocupado volta ao fim, falhe o que falhar.
 */
export async function submitDecision(go: () => Promise<DecisionOutcome & { note?: string }>, set: SubmitSetters): Promise<void> {
  set.setBusy(true);
  set.setError(null);
  set.onGone?.(null);
  set.onDecided?.(null);
  try {
    const out = await go();
    if (out.gone && set.onGone) set.onGone(out.error);
    else if (out.error !== null) set.setError(out.error);
    else set.onDecided?.(out.note ?? null);
  } finally {
    set.setBusy(false);
  }
}

/** O aviso de "já decidido por outro caminho". Vive no pai do follow-up (o bloco do detalhe, o balão, o menu da caixa), não no item: a releitura que acompanha o 409 desmonta o item. */
export function FollowUpGoneNote({ message, className }: { message: string | null; className: string }) {
  if (!message) return null;
  return (
    <p className={`error small ${className}`} role="alert">
      {message}
    </p>
  );
}

/** O que a decisão fez ("Card t-… criado…", "Follow-up descartado."): também no pai, porque o item decidido some da conversa e da caixa. */
export function FollowUpDoneNote({ message, className }: { message: string | null; className: string }) {
  if (!message) return null;
  return (
    <p className={`small ${className}`} role="status">
      {message}
    </p>
  );
}

interface DecideProps {
  projectId: string;
  taskId: string;
  /** O follow-up a decidir; `text` é o achado inteiro (o da caixa vem cortado: quem chama passa o da tarefa quando já a leu). */
  followUp: Pick<FollowUp, 'id' | 'title' | 'text' | 'staffId'>;
  /** A tarefa de origem, se já lida: com ela Finalizada as saídas são "Revisar" e "Concluir", e o responsável do card sai dela. */
  task?: Pick<Task, 'status' | 'staffId'> | null;
  /** A equipe do projeto: quem pode receber o card. */
  team?: readonly TeamMember[];
  onDone: () => void | Promise<void>;
  onGone?: (message: string | null) => void;
  /** O que a decisão fez, em uma frase (para o pai mostrar depois que o item sumir). */
  onDecided?: (message: string | null) => void;
  onOpenCard?: () => void;
  /** Na caixa: botões de texto (`link`) no lugar de botões cheios. */
  compact?: boolean;
  /** A tarefa de origem ainda não foi lida (ou a leitura falhou): sem ela não se sabe se está Finalizada (as saídas mudam) nem o achado inteiro. As saídas esperam uma leitura que dê certo. */
  loading?: boolean;
}

/**
 * As saídas de um follow-up aberto. Tarefa aberta: "Criar card" (responsável, título e descrição já preenchidos e editáveis; um clique em confirmar) e "Descartar" (motivos prontos, ou texto
 * livre). Tarefa Finalizada: "Revisar" (o mesmo card, para o responsável da tarefa) e "Concluir" (um clique: encerra sem card, pela rota de descarte com o motivo "concluído sem ajuste").
 * Decidido uma vez não se desfaz (409). Com 409 (já decidido por outro caminho) roda `onDone` também e o aviso sobe por `onGone` (com `null` ao tentar de novo): o erro daqui sumiria junto
 * com este componente, que a releitura desmonta. Sem `onGone`, o aviso fica aqui mesmo. Os outros erros (rede, recusa) ficam sob o formulário, que segue aberto.
 */
export function FollowUpDecide({ projectId, taskId, followUp, task = null, team = [], onDone, onGone, onDecided, onOpenCard, compact = false, loading = false }: DecideProps) {
  const finished = taskFinished(task);
  const [mode, setMode] = useState<'card' | 'discard' | null>(null);
  const [edits, setEdits] = useState<Partial<{ staffId: string; title: string; description: string }>>({});
  const [reason, setReason] = useState<DiscardReason | null>(null);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const btn = compact ? 'link small' : 'btn-secondary';
  const main = compact ? 'link small' : 'btn-primary';
  const form = useRef<HTMLFormElement>(null);
  const ref: Ref = { projectId, taskId, followUpId: followUp.id };

  // O que o dono ainda não mexeu acompanha o que chega depois (a tarefa e a equipe podem ser lidas com o formulário já aberto).
  const initial = useMemo(() => cardDraft(followUp, { taskStaffId: task?.staffId ?? null, finished, team }), [followUp, task?.staffId, finished, team]);
  const draft = { ...initial, ...edits };

  // O formulário abre embaixo dos botões: no celular, dentro da lista rolável da conversa, da caixa ou do detalhe, ele nasce fora da tela; traz para a vista.
  // "Outro motivo" abre um campo e empurra os botões para baixo: traz de novo.
  useEffect(() => {
    if (mode) form.current?.scrollIntoView?.({ block: 'nearest' });
  }, [mode, reason]);

  const pick = (next: 'card' | 'discard') => {
    setMode(mode === next ? null : next);
    setError(null);
  };

  /** Roda o envio: erro e 409 no lugar certo, e a frase do que foi feito sobe para o pai. */
  const send = (go: () => Promise<DecisionOutcome & { note?: string }>) => submitDecision(go, { setBusy, setError, onGone, onDecided });

  const createCard = async (e: FormEvent) => {
    e.preventDefault();
    await send(async () => {
      const out = await sendCard(ref, cardBody(draft, initial), onDone);
      return { ...out, note: t('tasks.fuNoteCard', { id: out.card?.id ?? '', title: out.card?.title ?? draft.title }) };
    });
  };
  const discard = async (e: FormEvent) => {
    e.preventDefault();
    const decision = discardDecision(reason, other);
    if (!decision) return;
    await send(async () => ({ ...(await sendDecision(ref, decision, onDone)), note: t('tasks.fuNoteDiscarded') }));
  };
  const conclude = () => send(async () => ({ ...(await sendDecision(ref, concludeDecision(), onDone)), note: t('tasks.fuNoteConcluded') }));

  return (
    <div className={`task-fu-decide${compact ? ' is-compact' : ''}`}>
      <p className="task-fu-actions">
        {onOpenCard && (
          <button type="button" className={btn} title={t('tasks.fuOpenCardTitle')} onClick={onOpenCard}>
            {t('tasks.fuOpenCard')}
          </button>
        )}
        <button
          type="button"
          className={main}
          aria-expanded={mode === 'card'}
          title={t(finished ? 'tasks.fuReviewTitle' : 'tasks.fuCreateTitle')}
          disabled={busy || loading}
          onClick={() => pick('card')}
        >
          {t(finished ? 'tasks.fuReviewBtn' : 'tasks.fuCreateBtn')}
        </button>
        {finished ? (
          <button type="button" className={btn} title={t('tasks.fuConcludeTitle')} disabled={busy || loading} onClick={() => void conclude()}>
            {t('tasks.fuConcludeBtn')}
          </button>
        ) : (
          <button type="button" className={btn} aria-expanded={mode === 'discard'} title={t('tasks.fuDiscardTitle')} disabled={busy || loading} onClick={() => pick('discard')}>
            {t('tasks.fuDiscardBtn')}
          </button>
        )}
      </p>
      {loading && <p className="muted small">{t('tasks.fuLoading')}</p>}
      {mode === 'card' && (
        <form ref={form} className="task-fu-form" onSubmit={(e) => void createCard(e)}>
          <label className="task-doubt-field">
            {t('tasks.fuCardOwner')}
            <select value={draft.staffId} disabled={busy} onChange={(e) => setEdits({ ...edits, staffId: e.target.value })}>
              <option value="">{t('tasks.fuCardOwnerNone')}</option>
              {team.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="task-doubt-field">
            {t('tasks.fuCardTitleField')}
            <input value={draft.title} maxLength={120} disabled={busy} onChange={(e) => setEdits({ ...edits, title: e.target.value })} />
          </label>
          <label className="task-doubt-field">
            {t('tasks.fuCardDescField')}
            <textarea rows={6} value={draft.description} maxLength={7500} disabled={busy} onChange={(e) => setEdits({ ...edits, description: e.target.value })} />
          </label>
          <p className="muted small">{t('tasks.fuCreateHint')}</p>
          <p className="actions">
            <button type="submit" className="btn-primary" disabled={busy || !draft.title.trim()}>
              {t(finished ? 'tasks.fuReviewConfirm' : 'tasks.fuCreateConfirm')}
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => pick('card')}>
              {t('tasks.fuBack')}
            </button>
          </p>
        </form>
      )}
      {mode === 'discard' && (
        <form ref={form} className="task-fu-form" onSubmit={(e) => void discard(e)}>
          <fieldset className="task-fu-why">
            <legend>{t('tasks.fuWhy')}</legend>
            {DISCARD_REASONS.map((r) => (
              <label key={r} className="check">
                <input type="radio" name={`fu-why-${followUp.id}`} checked={reason === r} disabled={busy} onChange={() => setReason(r)} /> {discardReasonLabel(r)}
              </label>
            ))}
          </fieldset>
          {reason === 'other' && <input value={other} maxLength={300} placeholder={t('tasks.fuReasonPlaceholder')} aria-label={t('tasks.fuReasonOther')} disabled={busy} onChange={(e) => setOther(e.target.value)} />}
          <p className="muted small">{t('tasks.fuDiscardHint')}</p>
          <p className="actions">
            <button type="submit" className="btn-primary" disabled={busy || !discardReasonText(reason, other)}>
              {t('tasks.fuDiscardConfirm')}
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => pick('discard')}>
              {t('tasks.fuBack')}
            </button>
          </p>
        </form>
      )}
      {error && (
        <p className="error small task-fu-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface ItemProps {
  task: Task;
  followUp: FollowUp;
  tasks: Task[];
  team: readonly TeamMember[];
  nameOf: NameOf;
  now: number;
  projectId: string;
  /** O follow-up espera na conversa de trabalho (há item da caixa com a conversa): lá é que se decide. */
  inChat: boolean;
  onOpenTask: (id: string) => void;
  onChanged: () => void;
  onGone: (message: string | null) => void;
  onDecided: (message: string | null) => void;
}

/**
 * Um follow-up da lista. Antigo (sem os campos do revisor): o texto. Com os campos (aberto ou já decidido): o selo, o título e o "se não fizer" (o texto técnico fica recolhido).
 * Aberto, a regra é uma só para os dois: o servidor deixa decidir quem pediu a tarefa OU você, pela tela, então se espera na conversa de trabalho o detalhe só aponta para lá; senão
 * decide-se aqui, com as mesmas saídas do balão, e se o aviso está com o gestor a nota diz que ele também pode decidir.
 */
function FollowUpItem({ task, followUp: f, tasks, team, nameOf, now, projectId, inChat, onOpenTask, onChanged, onGone, onDecided }: ItemProps) {
  const state = followUpState(f, { requestedBy: task.requestedBy, nameOf, now });
  const card = f.cardId ? tasks.find((x) => x.id === f.cardId) : undefined;
  const open = state.kind === 'open';
  const structured = hasFields(f);
  const decide = (
    <FollowUpDecide projectId={projectId} taskId={task.id} followUp={f} task={task} team={team} onDone={onChanged} onGone={onGone} onDecided={onDecided} />
  );
  return (
    <li className={`task-fu${open ? '' : ' is-decided'}`}>
      <div className="task-doubt-head">
        <span className="small">
          <b>{followUpAuthor(f, nameOf)}</b>
          {' · '}
          <span className="muted" title={when(f.at)}>
            {formatAgo(now - Date.parse(f.at))}
          </span>
        </span>
        <span className={`task-badge small${open && f.to === 'owner' ? ` ${cardTone('owner')}` : ''}`}>{state.badge}</span>
      </div>
      {structured ? (
        <FollowUpFieldsView
          recommendation={f.recommendation}
          title={followUpTitle(f)}
          impact={f.impact}
          size={f.size}
          who={whoWouldDo(f, team)}
          by={t('tasks.fuMetaBy', { name: followUpAuthor(f, nameOf), ago: formatAgo(now - Date.parse(f.at)) })}
          text={f.text}
        />
      ) : (
        <p className="task-doubt-text">{f.text}</p>
      )}
      {state.lines.map((line) => (
        <p key={line} className="muted small">
          {line}
        </p>
      ))}
      {state.kind === 'card' &&
        (f.cardId ? (
          <p className="small">
            <button type="button" className="link small" onClick={() => onOpenTask(f.cardId!)}>
              {card?.title ?? f.cardId}
            </button>
            {!card && <span className="muted small"> · {t('tasks.subOfGoneStatus')}</span>}
          </p>
        ) : (
          <p className="muted small">{t('tasks.fuCardNoId')}</p>
        ))}
      {open && inChat && <p className="muted small">{t('tasks.fuInChat')}</p>}
      {open && !inChat && f.to === 'manager' && <p className="muted small">{t('tasks.fuAtManager')}</p>}
      {open && !inChat && decide}
    </li>
  );
}

interface BlockProps {
  task: Task;
  tasks: Task[];
  /** A equipe do projeto (quem pode receber o card do follow-up). */
  team?: readonly TeamMember[];
  nameOf: NameOf;
  now: number;
  projectId: string;
  /** Os ids dos follow-ups que esperam na conversa de trabalho (há item da caixa que leva a ela). */
  chatIds?: ReadonlySet<string>;
  /** Abre a conversa de trabalho da tarefa; sem ele (ou sem follow-up lá), o botão não aparece. */
  onOpenChat?: () => void;
  onOpenTask: (id: string) => void;
  onChanged: () => void;
}

/**
 * Bloco do detalhe: o resumo ("2 follow-ups, 1 vale fazer") e, por follow-up, o que importa para decidir, no padrão da dúvida e do pedido de cancelamento; o botão leva à conversa onde
 * eles esperam. Sem nenhum, nada. `tasks`: as do projeto (para abrir o card em que virou); `onChanged` relê o quadro depois de decidir. Guarda o aviso de "já decidido por outro caminho" e a
 * frase do que a decisão fez: a releitura troca o follow-up por "decidido" e os dois têm de sobreviver a isso.
 */
export function FollowUpBlock(props: BlockProps) {
  const [gone, setGone] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return <FollowUpBlockView {...props} gone={gone} onGone={setGone} done={done} onDecided={setDone} />;
}

/** O bloco sem estado (os avisos vêm de fora): o que a tela mostra, dado o que o pai guarda. */
export function FollowUpBlockView({
  task,
  tasks,
  team = [],
  nameOf,
  now,
  projectId,
  chatIds,
  onOpenChat,
  onOpenTask,
  onChanged,
  gone,
  onGone,
  done,
  onDecided,
}: BlockProps & { gone: string | null; onGone: (message: string | null) => void; done: string | null; onDecided: (message: string | null) => void }) {
  const all = followUpsOf(task);
  if (!all.length) return null;
  const open = openFollowUps(task);
  const inChat = open.some((f) => chatIds?.has(f.id));
  return (
    <section className="task-fu-box" aria-label={t('tasks.fuTitle')}>
      <header className="task-doubt-head">
        <b>{t('tasks.fuTitle')}</b>
        <span className="task-badge small">{open.length ? followUpSummary(open) : t('tasks.fuAllDecided')}</span>
      </header>
      <FollowUpGoneNote message={gone} className="task-fu-error" />
      <FollowUpDoneNote message={done} className="task-fu-done" />
      {open.length > 0 && <p className="muted small">{t('tasks.fuHint')}</p>}
      {inChat && onOpenChat && (
        <p className="task-fu-actions">
          <button type="button" className="btn-primary" title={t('tasks.fuOpenChatTitle')} onClick={onOpenChat}>
            {t('tasks.fuOpenChat')}
          </button>
        </p>
      )}
      <ul className="task-fu-list">
        {all.map((f) => (
          <FollowUpItem
            key={f.id}
            task={task}
            followUp={f}
            tasks={tasks}
            team={team}
            nameOf={nameOf}
            now={now}
            projectId={projectId}
            inChat={!!chatIds?.has(f.id)}
            onOpenTask={onOpenTask}
            onChanged={onChanged}
            onGone={onGone}
            onDecided={onDecided}
          />
        ))}
      </ul>
    </section>
  );
}
