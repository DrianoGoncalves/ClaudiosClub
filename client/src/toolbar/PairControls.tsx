import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { t } from '../i18n';

/** De quanto em quanto a aba pergunta se o terminal já aprovou (o pedido vale 10 min no servidor). */
const POLL_MS = 2000;

/**
 * "Parear este navegador" (server/pairing.ts): pede um código, e o servidor abre um terminal com `npm run pair CÓDIGO`
 * pronto (se não abrir, a tela mostra o comando para copiar). A aba pergunta até o terminal aprovar; a resposta da
 * aprovação grava o cookie nela. Vale para qualquer navegador.
 */
export function PairControls({ onPaired }: { onPaired?: () => void }) {
  const [state, setState] = useState<'unknown' | 'idle' | 'waiting' | 'paired' | 'expired'>('unknown');
  const [code, setCode] = useState('');
  const [terminal, setTerminal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    api.serverInfo().then((s) => alive.current && setState(s.paired ? 'paired' : 'idle'), () => alive.current && setState('idle'));
    return () => {
      alive.current = false;
    };
  }, []);

  const paired = () => {
    setState('paired');
    onPaired?.();
  };

  const pair = async () => {
    setError(null);
    setCopied(false);
    let id: string;
    try {
      const r = await api.pairRequest();
      if (r.paired) return paired();
      id = r.id;
      setCode(r.code);
      setTerminal(r.terminal);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setState('waiting');
    while (alive.current) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        if ((await api.pairClaim(id)).paired) return alive.current && paired();
      } catch (e) {
        if (e instanceof ApiError && e.code === 'pair-gone') return alive.current && setState('expired');
        // Rede ou servidor reiniciando: tenta de novo no próximo giro.
      }
    }
  };

  const command = `npm run pair ${code}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (state === 'unknown') return null;
  if (state === 'paired') return <span className="muted small">✓ {t('toolbar.pairPaired')}</span>;
  return (
    <>
      {state === 'waiting' ? (
        <span className="pair-command">
          {terminal && (
            <span className="small">
              {t('toolbar.pairTerminal')} <b className="mono">{code}</b>
            </span>
          )}
          <span className={terminal ? 'muted small' : 'small'}>{t(terminal ? 'toolbar.pairRunFallback' : 'toolbar.pairRun')}</span>
          <span className="setting-buttons">
            <code className="mono">{command}</code>
            <button type="button" className="btn-secondary" onClick={() => void copy()}>
              {copied ? t('toolbar.pairCopied') : t('toolbar.pairCopy')}
            </button>
          </span>
          <span className="muted small">{t('toolbar.pairWaiting')}</span>
        </span>
      ) : (
        <span className="setting-buttons">
          <button type="button" className="btn-secondary" onClick={() => void pair()}>
            {t('toolbar.pairBtn')}
          </button>
        </span>
      )}
      {state === 'expired' && <span className="muted small">{t('toolbar.pairExpired')}</span>}
      {error && <span className="error small">{error}</span>}
    </>
  );
}
