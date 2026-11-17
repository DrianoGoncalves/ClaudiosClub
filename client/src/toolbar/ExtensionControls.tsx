import { useEffect, useRef, useState } from 'react';
import { api, type ExtensionInfo, type ExtensionPairing } from '../api';
import { formatAgo } from '../format';
import { t } from '../i18n';
import { askConfirm } from '../lib/dialogStore';
import { canGenerate, cleanLabel, codeSecondsLeft, countdown, DOWNLOAD_NAME, MAX_PAIRINGS, newPairing, PAIR_POLL_MS } from './extensionView';

// Configurações → Geral → Extensão do Chrome: baixar o .zip, as instruções de instalação, o código de pareamento (a extensão o troca por um
// token que fica só no Chrome) e a lista de pareadas, com revogar. O servidor é o de server/extension/ (rotas /api/extension).

export interface ExtensionViewProps {
  /** null: ainda lendo, ou o servidor não tem a rota (`error` diz qual). */
  info: ExtensionInfo | null;
  error: string | null;
  /** O código gerado e quantos segundos faltam para vencer. */
  code: { value: string; left: number } | null;
  copied: boolean;
  /** Nome digitado para o próximo pareamento. */
  label: string;
  /** O que está em andamento: baixar, gerar o código, ou o id do pareamento sendo revogado. */
  busy: 'download' | 'pair' | string | null;
  /** Nome do pareamento que acabou de acontecer (a extensão trocou o código). */
  justPaired: string | null;
  now: number;
  onLabel: (value: string) => void;
  onDownload: () => void;
  onPair: () => void;
  onCopy: () => void;
  onRevoke: (pairing: ExtensionPairing) => void;
}

function Pairings({ list, busy, now, onRevoke }: { list: ExtensionPairing[]; busy: string | null; now: number; onRevoke: (p: ExtensionPairing) => void }) {
  if (list.length === 0) return <p className="muted ext-note">{t('ext.none')}</p>;
  return (
    <ul className="ext-list">
      {list.map((p) => (
        <li key={p.id}>
          <div className="ext-who">
            <b>{p.label}</b>
            <span className="muted">
              {t('ext.pairedAt', { when: formatAgo(now - Date.parse(p.createdAt)) })} ·{' '}
              {p.lastUsedAt ? t('ext.lastUsed', { when: formatAgo(now - Date.parse(p.lastUsedAt)) }) : t('ext.neverUsed')}
            </span>
          </div>
          <button type="button" className="btn-secondary is-danger" disabled={busy === p.id} onClick={() => onRevoke(p)}>
            {t('ext.revoke')}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A tela, sem estado e sem rede (testável por renderização no servidor). */
export function ExtensionView(p: ExtensionViewProps) {
  const { info } = p;
  const full = !!info && info.pairings.length >= MAX_PAIRINGS;
  return (
    <div className="ext">
      {p.error && (
        <p className="error ext-note" role="alert">
          {p.error}
        </p>
      )}
      {info && (
        <>
          <div className="ext-block">
            <h5 className="ext-sub">{t('ext.stepsTitle')}</h5>
            <ol className="ext-steps">
              <li>
                {t('ext.step1')}{' '}
                <button type="button" className="btn-secondary" disabled={!info.available || p.busy === 'download'} onClick={p.onDownload}>
                  {p.busy === 'download' ? t('ext.downloading') : t('ext.download')}
                </button>
                {!info.available && <span className="muted ext-note"> {t('ext.notPackaged')}</span>}
              </li>
              <li>
                {t('ext.step2Before')} <code className="mono ext-url">chrome://extensions</code> {t('ext.step2After')}
              </li>
              <li>{t('ext.step3')}</li>
              <li>{t('ext.step4')}</li>
            </ol>
            <p className="muted ext-note">{t('ext.update')}</p>
          </div>

          <div className="ext-block">
            <h5 className="ext-sub">{t('ext.pairTitle')}</h5>
            <div className="ext-pair">
              <label className="ext-field">
                <span className="muted">{t('ext.labelLabel')}</span>
                <input
                  className="q-field"
                  type="text"
                  maxLength={40}
                  value={p.label}
                  placeholder={t('ext.labelPlaceholder')}
                  autoComplete="off"
                  onChange={(e) => p.onLabel(e.target.value)}
                />
              </label>
              <button type="button" className="btn-secondary" disabled={!canGenerate(info) || p.busy === 'pair'} onClick={p.onPair}>
                {p.busy === 'pair' ? t('ext.pairing') : t('ext.pair')}
              </button>
            </div>
            {full && <p className="muted ext-note">{t('ext.full', { max: MAX_PAIRINGS })}</p>}
            {p.code &&
              (p.code.left > 0 ? (
                <div className="ext-code" role="status">
                  <span className="muted">{t('ext.codeLabel')}</span>
                  <span className="ext-code-row">
                    <code className="ext-code-value">{p.code.value}</code>
                    <button type="button" className="btn-secondary" onClick={p.onCopy}>
                      {p.copied ? t('ext.copied') : t('ext.copy')}
                    </button>
                  </span>
                  <span className="muted ext-note">{t('ext.codeLeft', { time: countdown(p.code.left) })}</span>
                </div>
              ) : (
                <p className="muted ext-note" role="status">
                  {t('ext.codeExpired')}
                </p>
              ))}
            {p.justPaired && (
              <p className="ext-ok" role="status">
                {t('ext.justPaired', { label: p.justPaired })}
              </p>
            )}
          </div>

          <div className="ext-block">
            <h5 className="ext-sub">{t('ext.pairings', { n: info.pairings.length, max: MAX_PAIRINGS })}</h5>
            <Pairings list={info.pairings} busy={p.busy} now={p.now} onRevoke={p.onRevoke} />
          </div>
        </>
      )}
    </div>
  );
}

/** Entrega o .zip como download do navegador (a rota é POST: um link direto não serviria). */
function saveBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = DOWNLOAD_NAME;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ExtensionControls() {
  const [info, setInfo] = useState<ExtensionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [code, setCode] = useState<{ value: string; expiresAt: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [justPaired, setJustPaired] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Os ids pareados quando o código foi gerado: o que aparecer a mais é a extensão que digitou o código. */
  const before = useRef<string[]>([]);
  const alive = useRef(true);

  const load = () =>
    api.extension().then(
      (next) => {
        if (!alive.current) return null;
        setInfo(next);
        return next;
      },
      () => {
        if (alive.current) setError(t('ext.unavailable'));
        return null;
      },
    );

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, []);

  // Com um código na tela: o relógio anda, e a lista é relida até a extensão trocar o código por um token.
  const waiting = !!code && code.expiresAt > now;
  useEffect(() => {
    if (!code) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [code]);
  useEffect(() => {
    if (!waiting) return;
    const poll = setInterval(() => {
      void load().then((next) => {
        const fresh = next && newPairing(before.current, next.pairings);
        if (!fresh) return;
        setJustPaired(fresh.label);
        setCode(null);
      });
    }, PAIR_POLL_MS);
    return () => clearInterval(poll);
  }, [waiting]);

  const run = async (what: string, action: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message || null);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  return (
    <ExtensionView
      info={info}
      error={error}
      code={code ? { value: code.value, left: codeSecondsLeft(code.expiresAt, now) } : null}
      copied={copied}
      label={label}
      busy={busy}
      justPaired={justPaired}
      now={now}
      onLabel={setLabel}
      onDownload={() => void run('download', async () => saveBlob(await api.extensionDownload()))}
      onPair={() =>
        void run('pair', async () => {
          const made = await api.extensionPair(cleanLabel(label) || undefined);
          before.current = info?.pairings.map((p) => p.id) ?? [];
          setNow(Date.now());
          setCode({ value: made.code, expiresAt: Date.parse(made.expiresAt) });
          setCopied(false);
          setJustPaired(null);
        })
      }
      onCopy={() => {
        if (!code) return;
        navigator.clipboard.writeText(code.value).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
      onRevoke={(p) =>
        void (async () => {
          if (!(await askConfirm(t('ext.revokeAsk', { label: p.label })))) return;
          await run(p.id, async () => {
            await api.extensionRevoke(p.id);
            await load();
          });
        })()
      }
    />
  );
}
