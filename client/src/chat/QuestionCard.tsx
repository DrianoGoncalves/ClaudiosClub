import { useState } from 'react';
import type { AskedQuestion, ChatItem } from '../../../shared/model';
import type { PermissionOpts } from '../api';
import { t } from '../i18n';
import { MsgTime } from './MsgTime';
import { answerOf, answerText, collectAnswers, initialDrafts, numberState, previewDoc, previewOption, type Draft } from './questionAnswers';

// Pergunta com opções do Claude (ferramenta AskUserQuestion): você escolhe, escreve ou pula, e as
// respostas voltam para ele. É um balão próprio: amarelo enquanto espera você; depois de respondido,
// vira o balão neutro das mensagens automáticas e mostra o que foi escolhido, só leitura.

type Permission = Extract<ChatItem, { kind: 'permission' }>;

export function QuestionCard({
  item,
  questions,
  onAnswer,
}: {
  item: Permission;
  questions: AskedQuestion[];
  onAnswer: (requestId: string, allow: boolean, opts?: PermissionOpts) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() => initialDrafts(questions));
  const [busy, setBusy] = useState(false);
  const requestId = item.id.replace(/^p:/, '');
  const pending = item.status === 'pending';
  const given = item.answers ?? {};
  const { answers, annotations, invalid } = collectAnswers(questions, drafts);
  const none = Object.keys(answers).length === 0;

  const patch = (i: number, d: Partial<Draft>) => setDrafts((all) => all.map((x, j) => (j === i ? { ...x, ...d } : x)));
  const send = async (skip: boolean) => {
    setBusy(true);
    await onAnswer(requestId, true, skip ? { answers: {} } : { answers, annotations });
    setBusy(false);
  };

  const status = pending
    ? t('chat.qPending')
    : item.status === 'denied'
      ? t('chat.qNotAnswered')
      : Object.keys(given).length
        ? t('chat.qAnswered')
        : t('chat.qSkipped');

  return (
    <div className={`msg permission-question ${pending ? 'msg-question' : 'msg-system'}`} data-item-id={item.id}>
      <p className="permission-title">
        <b>{t('chat.qTitle')}</b> <span className="muted small">{status}</span>
      </p>
      {questions.map((q, i) => {
        const d = drafts[i] ?? { picked: [], typed: '' };
        const shown = previewOption(q, d);
        return (
          <div className="q-block" key={q.question} role="group" aria-label={q.question}>
            {q.header && <span className="q-header">{q.header}</span>}
            <p className="q-text">{q.question}</p>
            {q.description && <p className="small muted">{q.description}</p>}
            {!pending ? (
              <p className="q-given small">{answerText(answerOf(given, q.question)) ?? <span className="muted">{t('chat.qNoAnswer')}</span>}</p>
            ) : q.kind === 'text' ? (
              <textarea
                className="q-field"
                rows={3}
                value={d.typed}
                placeholder={q.placeholder ?? t('chat.qTextPlaceholder')}
                disabled={busy}
                onChange={(e) => patch(i, { typed: e.target.value })}
              />
            ) : q.kind === 'number' ? (
              <div className="q-number">
                <input
                  className="q-field"
                  type="number"
                  min={q.min}
                  max={q.max}
                  step={q.step ?? 'any'}
                  value={d.typed}
                  disabled={busy}
                  aria-label={q.question}
                  onChange={(e) => patch(i, { typed: e.target.value })}
                />
                {q.unit && <span>{q.unit}</span>}
                <span className="muted small">{t('chat.qNumberRange', { min: q.min ?? '', max: q.max ?? '' })}</span>
                {numberState(q, d.typed) === 'invalid' && <span className="q-warn small">{t('chat.qNumberInvalid', { min: q.min ?? '', max: q.max ?? '' })}</span>}
              </div>
            ) : (
              <>
                {q.multiSelect && <p className="small muted">{t('chat.qMultiHint')}</p>}
                <div className="q-options">
                  {q.options.map((o) => {
                    const on = d.picked.includes(o.label);
                    const toggle = () =>
                      q.multiSelect
                        ? patch(i, { picked: on ? d.picked.filter((x) => x !== o.label) : [...d.picked, o.label] })
                        : patch(i, { picked: on ? [] : [o.label], typed: '' });
                    return (
                      <button type="button" key={o.label} className={`q-option${on ? ' is-on' : ''}${q.multiSelect ? ' is-multi' : ''}`} aria-pressed={on} disabled={busy} onClick={toggle}>
                        <b>{o.label}</b>
                        {o.description && <span className="muted small">{o.description}</span>}
                      </button>
                    );
                  })}
                </div>
                <input
                  className="q-field"
                  type="text"
                  value={d.typed}
                  placeholder={t('chat.qOther')}
                  aria-label={t('chat.qOther')}
                  disabled={busy}
                  onChange={(e) => patch(i, q.multiSelect ? { typed: e.target.value } : { typed: e.target.value, picked: e.target.value.trim() ? [] : d.picked })}
                />
                {shown?.preview && <iframe className="q-preview" sandbox="" srcDoc={previewDoc(shown.preview)} title={t('chat.qPreview')} />}
              </>
            )}
          </div>
        );
      })}
      {pending && (
        <div className="actions">
          <button className="btn-primary" disabled={busy || none || invalid} onClick={() => void send(false)}>
            {t('chat.qAnswer')}
          </button>
          <button className="btn-secondary" disabled={busy} onClick={() => void send(true)} title={t('chat.qSkipHelp')}>
            {t('chat.qSkip')}
          </button>
        </div>
      )}
      <MsgTime at={item.at} />
    </div>
  );
}
