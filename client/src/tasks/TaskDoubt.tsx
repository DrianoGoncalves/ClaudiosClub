import type { TaskQuestion } from '../../../shared/model';
import { formatAgo } from '../format';
import { t } from '../i18n';

// Dúvida do funcionário numa tarefa pedida por gestor: selo no cartão e bloco no detalhe.
// `open` = com o gestor; `escalated` = com você; `answered` = resolvida (sem selo).

/** Nome do gestor que pediu a tarefa (sem ficha na lista, o id; sem gestor, o texto genérico). */
const managerName = (requestedBy: string | null | undefined, nameOf: (id: string | null) => string | null) =>
  (requestedBy && (nameOf(requestedBy) ?? requestedBy)) || t('tasks.doubtManagerFallback');

/** Selo do cartão: "Dúvida · aguardando <gestor>" (neutro) ou "… aguardando você" (amarelo, é com você). Respondida: nada. */
export function DoubtBadge({
  question,
  requestedBy,
  nameOf,
}: {
  question?: TaskQuestion;
  requestedBy?: string | null;
  nameOf: (id: string | null) => string | null;
}) {
  if (!question || question.status === 'answered') return null;
  const mine = question.status === 'escalated';
  const text = mine ? t('tasks.doubtBadgeUser') : t('tasks.doubtBadgeManager', { name: managerName(requestedBy, nameOf) });
  return (
    <span className={`task-badge task-doubt small ${mine ? 'is-waiting' : ''}`} title={text} role={mine ? 'status' : undefined}>
      {text}
    </span>
  );
}

/** Bloco do detalhe: a pergunta (opções ou texto), o status e, se respondida, quem respondeu e o resumo. */
export function DoubtBlock({
  question,
  requestedBy,
  nameOf,
  now,
}: {
  question?: TaskQuestion;
  requestedBy?: string | null;
  nameOf: (id: string | null) => string | null;
  now: number;
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
  return (
    <section className={`task-doubt-box ${question.status === 'escalated' ? 'is-escalated' : ''}`} aria-label={t('tasks.doubtTitle')}>
      <header className="task-doubt-head">
        <b>{t('tasks.doubtTitle')}</b>
        <span className={`task-badge small ${question.status === 'escalated' ? 'is-waiting' : question.status === 'answered' ? 'is-approved' : ''}`}>{status}</span>
      </header>
      {question.questions?.map((q, i) => (
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
      <p className="muted small">{t('tasks.doubtAsked', { ago: ago(question.askedAt) })}</p>
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
