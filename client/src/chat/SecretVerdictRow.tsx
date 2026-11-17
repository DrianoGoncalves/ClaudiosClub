import type { InboxItem } from '../../../shared/model';
import { t } from '../i18n';
import { secretVerdictOf } from '../inbox/secretVerdict';

/**
 * O palpite do servidor sobre o aviso de segredo, numa linha: o selo com o estado (escrito, com um símbolo de reforço: não depende só da cor), a dica
 * mascarada do valor ao lado e o "por quê?", que abre o motivo que o servidor já calculou (o `<details>` nativo: sem estado, sem chamada nova, com teclado).
 * Aviso sem o palpite (servidor antigo, chave do .mcp.json) não ganha linha: fica como antes. Serve ao balão do chat e ao item da caixa.
 */
export function SecretVerdictRow({ item }: { item: Pick<InboxItem, 'secret'> }) {
  const v = secretVerdictOf(item);
  if (!v) return null;
  return (
    <div className="secret-verdict-row" data-verdict={v.verdict}>
      <span className={`secret-verdict is-${v.verdict}`}>
        <span className="secret-verdict-glyph" aria-hidden="true">{v.glyph}</span>
        {v.label}
      </span>
      {v.hint && (
        <span className="secret-hint" title={t('chat.secretHint.title')}>
          <span className="muted">{t('chat.secretHint.label')}:</span>{' '}
          {v.hint.masked && <code>{v.hint.masked}</code>}
          {v.hint.masked && v.hint.note && ', '}
          {v.hint.note}
        </span>
      )}
      {v.why && (
        <details className="secret-why">
          <summary title={t('chat.secretWhyTitle')}>{t('chat.secretWhy')}</summary>
          <p>{v.why}</p>
          <p className="muted">{t('chat.secretWhyNote')}</p>
        </details>
      )}
    </div>
  );
}
