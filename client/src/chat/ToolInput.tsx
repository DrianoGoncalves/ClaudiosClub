import { t } from '../i18n';
import { readAsk } from './askInput';

/** A entrada de uma ferramenta nos detalhes: AskUserQuestion vira texto para ler; o resto continua como veio. */
export function ToolInput({ tool, input }: { tool: string; input: string }) {
  const asked = tool === 'AskUserQuestion' ? readAsk(input) : null;
  if (!asked) return <pre className="tool-io">{input}</pre>;
  return (
    <div className="tool-ask">
      {asked.map((q) => (
        <div className="q-block" key={q.question}>
          {q.header && <span className="q-header">{q.header}</span>}
          <p className="q-text">{q.question}</p>
          {q.description && <p className="small muted">{q.description}</p>}
          {q.options.length > 0 && (
            <>
              {q.multiSelect && <p className="small muted">{t('chat.qMultiHint')}</p>}
              <ul className="tool-ask-options">
                {q.options.map((o) => (
                  <li key={o.label}>
                    <b>{o.label}</b>
                    {o.description && <span className="muted small"> — {o.description}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {q.kind === 'text' && <p className="small muted">{q.placeholder ?? t('chat.qTextPlaceholder')}</p>}
          {q.kind === 'number' && q.min !== undefined && q.max !== undefined && (
            <p className="small muted">
              {t('chat.qNumberRange', { min: q.min, max: q.max })}
              {q.unit ? ` ${q.unit}` : ''}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
