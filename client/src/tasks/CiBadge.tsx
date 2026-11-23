import { useCallback, useEffect, useRef, useState } from 'react';
import type { CiCheck, CiState, CiStatus, PrCi } from '../../../shared/ci';
import { t } from '../i18n';
import { pollVisible } from '../usePoll';

// Status do CI do GitHub (ver server/ciStatus.ts) na página da versão, no histórico e no cartão com PR. Lê ao montar e, só enquanto o CI roda, de minuto em
// minuto (o servidor ainda guarda e não vai ao GitHub mais de uma vez por minuto por commit). Sem token ou sem rede: "status do CI indisponível", nunca erro.

/** Enquanto o CI roda, a tela relê a cada isto. */
export const CI_POLL_MS = 60_000;

const STATE_KEY: Record<CiState, Parameters<typeof t>[0]> = {
  success: 'release.ciSuccess',
  failure: 'release.ciFailure',
  pending: 'release.ciPending',
  none: 'release.ciNone',
  unavailable: 'release.ciUnavailable',
};
const CHECK_KEY: Record<CiCheck['state'], Parameters<typeof t>[0]> = {
  success: 'release.ciSuccess',
  failure: 'release.ciFailure',
  pending: 'release.ciPending',
  neutral: 'release.ciNeutral',
};

type CiData = PrCi | CiStatus | null;
const isPr = (d: CiData): d is PrCi => !!d && 'head' in d;
/** Algum dos status ainda roda (só aí a tela relê). */
export const ciPending = (d: CiData | undefined): boolean =>
  !!d && (isPr(d) ? d.head?.state === 'pending' || d.merge?.state === 'pending' || (d.pr?.state === 'merged' && !d.merge) : d.state === 'pending');

/** Lê o CI com `load` ao montar (e quando `k` muda) e, enquanto roda, a cada CI_POLL_MS. `load` pode mudar a cada render: vale o último. */
export function useCi<T extends CiData>(k: string, load: () => Promise<T>): [T | null | undefined, () => void] {
  const [data, setData] = useState<T | null | undefined>(undefined);
  const loadRef = useRef(load);
  loadRef.current = load;
  const run = useCallback(() => {
    loadRef.current().then(setData, () => setData(null));
    // `k` é a identidade do que se lê: outro PR ou commit, outra leitura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k]);
  useEffect(run, [run]);
  const pending = ciPending(data ?? undefined);
  useEffect(() => (pending ? pollVisible(run, CI_POLL_MS) : undefined), [pending, run]);
  return [data, run];
}

function Line({ label, s }: { label: string; s: CiStatus }) {
  return (
    <div className="ci-line" data-state={s.state}>
      <span className="ci-dot" aria-hidden="true" />
      <span title={s.reason}>
        {label}: <b>{t(STATE_KEY[s.state])}</b>
      </span>
      {s.checks.length > 0 && (
        <details className="ci-checks">
          <summary className="small">{t('release.ciChecks', { n: s.checks.length })}</summary>
          <ul className="small">
            {s.checks.map((c) => (
              <li key={c.name} data-state={c.state}>
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noopener noreferrer">
                    {c.name}
                  </a>
                ) : (
                  c.name
                )}{' '}
                · {t(CHECK_KEY[c.state])}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** O que a tela mostra de um status já lido (sem PR: nada). */
export function CiSummary({ data }: { data: CiData | undefined }) {
  if (data === undefined) return <p className="muted small">{t('release.ciLoading')}</p>;
  if (data === null) return <p className="muted small">{t('release.ciUnavailable')}</p>;
  if (!isPr(data)) return <Line label={t('release.ciCommit')} s={data} />;
  if (!data.head) return null;
  return (
    <div className="ci-summary">
      <Line label={t('release.ciPr')} s={data.head} />
      {data.merge && <Line label={t('release.ciMerge')} s={data.merge} />}
    </div>
  );
}

/** Lê e mostra o CI (cartão com PR, entrada do histórico). */
export function CiBadge({ k, load }: { k: string; load: () => Promise<CiData> }) {
  const [data] = useCi(k, load);
  return <CiSummary data={data} />;
}
