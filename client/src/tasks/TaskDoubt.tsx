import { useState } from 'react';
import type { TaskQuestion } from '../../../shared/model';
import { ApiError, api, isPairingError } from '../api';
import { formatAgo } from '../format';
import { t } from '../i18n';
import { ANSWER_MAX, answerBody, canAnswer, emptyPicks, togglePick } from './doubtAnswer';
import { waitClass } from './waitTone';
import { cardTone } from '../inbox/alertTone';

// Dúvida do funcionário numa tarefa pedida por gestor: selo no cartão e bloco no detalhe.
// `open` = com o gestor; `escalated` = com você (o bloco traz como responder); `answered` = resolvida (sem selo).

/** Nome do gestor que pediu a tarefa (sem ficha na lista, o id; sem gestor, o texto genérico). */
const managerName = (requestedBy: string | null | undefined, nameOf: (id: string | null) => string | null) =>
  (requestedBy && (nameOf(requestedBy) ?? requestedBy)) || t('tasks.doubtManagerFallback');

/** Selo do cartão: "Dúvida · aguardando <gestor>" (laranja só com `warm`, na fila A fazer; nas outras colunas, neutro) ou "… aguardando você" (amarelo, é com você). Respondida: nada. */
export function DoubtBadge({
  question,
  requestedBy,
  nameOf,
  warm,
}: {
  question?: TaskQuestion;
  requestedBy?: string | null;
  nameOf: (id: string | null) => string | null;
  warm?: boolean;
}) {
  if (!question || question.status === 'answered') return null;
  const mine = question.status === 'escalated';
  const text = mine ? t('tasks.doubtBadgeUser') : t('tasks.doubtBadgeManager', { name: managerName(requestedBy, nameOf) });
  return (
    <span className={`task-badge task-doubt small${mine ? ` ${cardTone('owner')}` : waitClass(warm)}`} title={text} role={mine ? 'status' : undefined}>
      {text}
    </span>
  );
}

/** Onde a resposta vai e o que fazer depois dela (reler a tarefa). */
export interface DoubtAnswerTarget {
  projectId: string;
  taskId: string;
  onAnswered: () => void;
}

/** Bloco do detalhe: a pergunta (opções ou texto), o status e, se respondida, quem respondeu e o resumo. Com `answer`, a dúvida que está com você se responde aqui. */
export function DoubtBlock({
  question,
  requestedBy,
  nameOf,
  now,
  answer,
}: {
  question?: TaskQuestion;
  requestedBy?: string | null;
  nameOf: (id: string | null) => string | null;
  now: number;
  answer?: DoubtAnswerTarget;
}) {
  if (!question) return null;
  const manager = managerName(requestedBy, nameOf);
  const status =
    question.status === 'escalated'
      ? t('tasks.doubtStatusUser')
      : question.status === 'open'
        ? t('tasks.doubtStatusManager', { name: manager })
        : t('tasks.doubtStatusAnswered');
  const ago = (iso: string) => formatAgo(now - Date.parse(iso));
  const mine = question.status === 'escalated';
  const answerable = mine && !!answer && canAnswer(question);
  return (
    <section className={`task-doubt-box ${mine ? 'is-escalated' : ''}`} aria-label={t('tasks.doubtTitle')}>
      <header className="task-doubt-head">
        <b>{t('tasks.doubtTitle')}</b>
        <span className={`task-badge small ${mine ? cardTone('owner') : question.status === 'answered' ? cardTone('approved') : ''}`}>{status}</span>
      </header>
      <p className="muted small">{t('tasks.doubtAsked', { ago: ago(question.askedAt) })}</p>
      {/* Pergunta por opções com você: as opções viram escolha (no DoubtAnswer); fora disso, só a lista. */}
      {!(answerable && question.source === 'ask') &&
        question.questions?.map((q, i) => (
          <div key={i} className="task-doubt-q">
            <p>{q.question}</p>
            {q.options.length > 0 && (
              <ul className="small">
                {q.options.map((o, j) => (
                  <li key={j}>{o}</li>
                ))}
              </ul>
            )}
            {q.multiSelect && <p className="muted small">{t('tasks.doubtMulti')}</p>}
          </div>
        ))}
      {question.text && <p className="task-doubt-text">{question.text}</p>}
      {answerable && <DoubtAnswer key={question.id} question={question} target={answer} />}
      {question.status === 'answered' && (
        <div className="task-doubt-answer">
          <p className="small muted">
            {question.answeredBy === 'user' ? t('tasks.doubtAnsweredByUser') : t('tasks.doubtAnsweredByManager', { name: manager })}
            {question.answeredAt && ` · ${ago(question.answeredAt)}`}
          </p>
          {question.answer && <p className="task-doubt-text">{question.answer}</p>}
        </div>
      )}
    </section>
  );
}

/**
 * A resposta da dúvida que está com você: opções para marcar (dúvida por opções) ou um campo de texto (dúvida escrita). Responder
 * manda à rota do servidor, que fecha a dúvida e entrega a resposta ao funcionário; o erro do servidor aparece aqui, no lugar.
 */
function DoubtAnswer({ question, target }: { question: TaskQuestion; target: DoubtAnswerTarget }) {
  const [picks, setPicks] = useState(() => emptyPicks(question));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = answerBody(question, picks, text);

  const send = async () => {
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.answerTaskQuestion(target.projectId, target.taskId, body);
      target.onAnswered();
    } catch (e) {
      // Sem pareamento o aviso do App já explica (o erro vem sem texto).
      setError(isPairingError(e) ? null : (e as Error).message);
      // 409: outra resposta chegou antes (o gestor) ou a tarefa mudou: relê, e o bloco passa a mostrar o que aconteceu.
      if (e instanceof ApiError && e.status === 409) target.onAnswered();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="task-doubt-reply">
      {question.source === 'ask' ? (
        question.questions?.map((q, i) => (
          <div key={i} className="task-doubt-q" role="group" aria-label={q.question}>
            <p>{q.question}</p>
            {q.multiSelect && <p className="muted small">{t('tasks.doubtMulti')}</p>}
            <div className="q-options">
              {q.options.map((o) => {
                const on = picks[i]?.includes(o) ?? false;
                return (
                  <button
                    type="button"
                    key={o}
                    className={`q-option${on ? ' is-on' : ''}${q.multiSelect ? ' is-multi' : ''}`}
                    aria-pressed={on}
                    disabled={busy}
                    onClick={() => setPicks((all) => togglePick(all, i, o, !!q.multiSelect))}
                  >
                    <b>{o}</b>
                  </button>
                );
              })}
            </div>
          </div>
        ))
      ) : (
        <label className="task-doubt-field">
          {t('tasks.doubtReplyLabel')}
          <textarea
            className="q-field"
            rows={3}
            value={text}
            maxLength={ANSWER_MAX}
            placeholder={t('tasks.doubtReplyPlaceholder')}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      )}
      <p className="actions">
        <button className="btn-primary" disabled={!body || busy} onClick={() => void send()}>
          {t('tasks.doubtReply')}
        </button>
      </p>
      <p className="muted small">{t('tasks.doubtReplyHint')}</p>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
