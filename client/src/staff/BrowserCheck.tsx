import { useEffect, useState } from 'react';
import type { BrowserStatus } from '../../../shared/model';
import { api } from '../api';

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
          A extensão Claude in Chrome não está instalada. Sem ela, este funcionário não consegue usar o navegador.{' '}
          <a href={status.installUrl} target="_blank" rel="noreferrer">
            Instalar na Chrome Web Store
          </a>{' '}
          e entrar com a mesma conta do Claude.
        </span>
      ) : (
        <span>
          A extensão está instalada, mas a ponte com o CLI ainda não: rode <code>claude --chrome</code> uma vez num terminal e feche.
        </span>
      )}{' '}
      <button type="button" className="link" onClick={() => void recheck()} disabled={checking}>
        {checking ? 'conferindo…' : 'conferir de novo'}
      </button>
    </div>
  );
}
