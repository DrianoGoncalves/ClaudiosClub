import { t } from '../i18n';

// Aviso depois de salvar senha ou valor de MCP quando o chaveiro do sistema não serviu e foi para arquivo sem cifra.
export function VaultWarning({ text, onDone }: { text: string; onDone: () => void }) {
  return (
    <div className="conn-warn vault-warn" role="alert">
      <strong>{t('vault.warnTitle')}</strong>
      <p className="small">{text}</p>
      <p className="muted small">{t('vault.warnHelp')}</p>
      <p className="actions">
        <button type="button" className="btn-primary" onClick={onDone}>
          {t('vault.warnOk')}
        </button>
      </p>
    </div>
  );
}
