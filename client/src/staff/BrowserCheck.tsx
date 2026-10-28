import { useEffect, useState } from 'react';
import type { BrowserStatus } from '../../../shared/model';
import { api } from '../api';
import { t } from '../i18n';

// Aviso quando o funcionário usa o navegador e falta a extensão Claude in Chrome ou a ponte do CLI.
// Não mostra nada se está tudo certo.

export function BrowserCheck() {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api.browser().then(setStatus, () => {});
  }, []);

  const recheck = async () => {
    setChecking(true);
    await api.browser(true).then(setStatus, () => {});
    setChecking(false);
  };

  if (!status || (status.extension !== false && status.bridge !== false)) return null;
  return (
    <div className="badge warn browser-check" role="alert">
      {status.extension === false ? (
        <span>
          {t('staff.extMissing')}{' '}
          <a href={status.installUrl} target="_blank" rel="noreferrer">
            {t('staff.installLink')}
          </a>{' '}
          {t('staff.signInHint')}
        </span>
      ) : (
        <span>
          {t('staff.bridgeA')}<code>claude --chrome</code>{t('staff.bridgeB')}
        </span>
      )}{' '}
      <button type="button" className="link" onClick={() => void recheck()} disabled={checking}>
        {checking ? t('staff.checking') : t('staff.recheck')}
      </button>
    </div>
  );
}
