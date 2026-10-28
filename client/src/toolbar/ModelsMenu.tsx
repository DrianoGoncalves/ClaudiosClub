import { useEffect, useState } from 'react';
import type { ModelBenchmarks, ModelVariant } from '../../../shared/model';
import { api } from '../api';
import { formatAgo } from '../format';
import { locale, t } from '../i18n';

// Abas "Coding Index" e "Preço" do ranking (painel lateral): os modelos de maior índice de código do
// Artificial Analysis, em barras. Cada modelo aparece no esforço padrão; clicar nele abre todos os
// esforços. Abrir a aba busca de novo (o servidor segura 1 min entre buscas, por causa da cota
// diária da chave).

export type Metric = 'index' | 'price';

const decimals = (v: number, digits: number) => v.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });

const METRICS: Record<Metric, { label: string; value: (m: ModelVariant) => number; format: (v: number) => string; order: 1 | -1 }> = {
  index: { label: 'Coding Index', value: (m) => m.codingIndex, format: (v) => decimals(v, 1), order: -1 },
  price: { label: t('toolbar.priceLabel'), value: (m) => m.priceBlended, format: (v) => `US$ ${decimals(v, v < 1 ? 2 : 1)}`, order: 1 },
};

const FOOTNOTE: Record<Metric, string> = {
  index: t('toolbar.footIndex'),
  price: t('toolbar.footPrice'),
};

export const METRIC_LABEL: Record<Metric, string> = { index: METRICS.index.label, price: METRICS.price.label };

export function ModelsChart({ metric }: { metric: Metric }) {
  const [data, setData] = useState<ModelBenchmarks | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api
      .models(true)
      .then(
        (d) => {
          setData(d);
          setFailed(null);
        },
        (e: Error) => setFailed(e.message),
      )
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  return (
    <div className="models">
      <button className="btn-secondary models-refresh" onClick={load} disabled={loading} title={t('toolbar.searchAgain')}>
        {loading ? t('toolbar.searching') : t('toolbar.refresh')}
      </button>
      <ModelsBody data={data} loading={loading} failed={failed} metric={metric} expanded={expanded} onExpand={setExpanded} />
    </div>
  );
}

interface BodyProps {
  data: ModelBenchmarks | null;
  loading: boolean;
  failed: string | null;
  metric: Metric;
  /** Modelo aberto mostrando os esforços. */
  expanded: string | null;
  onExpand: (id: string | null) => void;
}

function ModelsBody({ data, loading, failed, metric, expanded, onExpand }: BodyProps) {
  if (!data) return <p className={`muted small models-note ${failed ? 'error' : ''}`}>{failed ?? (loading ? t('toolbar.searching') : '')}</p>;
  if (!data.configured) {
    return (
      <div className="small models-note">
        <p>
          {t('toolbar.keyIntro1')}{' '}
          <a href="https://artificialanalysis.ai/api-reference" target="_blank" rel="noopener noreferrer">
            {t('toolbar.aaApi')}
          </a>{' '}
          {t('toolbar.keyIntro2')} <code>.env</code> {t('toolbar.keyIntro3')}
        </p>
        <pre className="models-env">ARTIFICIAL_ANALYSIS_API_KEY={t('toolbar.keyPlaceholder')}</pre>
        <p className="muted">{t('toolbar.keyNoRestart')}</p>
      </div>
    );
  }

  const m = METRICS[metric];
  const rows = [...data.models].sort((a, b) => m.order * (m.value(a) - m.value(b)));
  // A mesma escala para os modelos e os esforços abertos: dá para comparar as barras entre si.
  const max = Math.max(...rows.flatMap((r) => r.variants.map(m.value)), 0);
  const bar = (v: ModelVariant) => (
    <span className="models-track">
      <span className="models-bar" style={{ width: `${max ? (m.value(v) / max) * 100 : 0}%` }} />
    </span>
  );
  const numbers = (v: ModelVariant) =>
    t('toolbar.numbersLine', { index: METRICS.index.format(v.codingIndex), price: METRICS.price.format(v.priceBlended) });
  const error = failed ?? data.error;
  return (
    <>
      {error && <p className="small error models-note">{error}</p>}
      {rows.length > 0 ? (
        <ol
          className="models-chart"
          aria-label={t(m.order === 1 ? 'toolbar.sortLowFirst' : 'toolbar.sortHighFirst', { label: m.label })}
        >
          {rows.map((r) => {
            const isOpen = expanded === r.id;
            return (
              <li key={r.id}>
                <button
                  className="models-row"
                  aria-expanded={isOpen}
                  onClick={() => onExpand(isOpen ? null : r.id)}
                  title={`${r.name}${r.creator ? ` (${r.creator})` : ''}${r.effort ? `, ${t('toolbar.effortWith', { effort: r.effort })}` : ''}\n${numbers(r)}`}
                >
                  <span className="models-name">
                    <span className="models-caret" aria-hidden>
                      {isOpen ? '▾' : '▸'}
                    </span>
                    {r.name}
                    {r.effort && <span className="models-effort">{r.effort}</span>}
                    {r.creator && <span className="muted"> · {r.creator}</span>}
                  </span>
                  {bar(r)}
                  <span className="models-value">{m.format(m.value(r))}</span>
                </button>
                {isOpen && (
                  <ul className="models-variants" aria-label={t('toolbar.effortsOf', { name: r.name })}>
                    {r.variants.map((v) => (
                      <li
                        key={v.id}
                        className="models-row models-variant"
                        title={`${v.effort ?? t('toolbar.effortUnknown')}: ${numbers(v)}`}
                      >
                        <span className="models-name">
                          {v.effort ?? '—'}
                          {v.id === r.id && <span className="muted"> · {t('toolbar.defaultLabel')}</span>}
                        </span>
                        {bar(v)}
                        <span className="models-value">{m.format(m.value(v))}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        !error && <p className="muted small models-note">{t('toolbar.noModels')}</p>
      )}
      <p className="muted small models-foot">
        {FOOTNOTE[metric]} {t('toolbar.footDefault')}
        {data.fetchedAt && ` ${t('toolbar.fetchedAgo', { ago: formatAgo(Date.now() - Date.parse(data.fetchedAt)) })}`} {t('toolbar.dataFrom')}{' '}
        <a href="https://artificialanalysis.ai/" target="_blank" rel="noopener noreferrer">
          Artificial Analysis
        </a>
      </p>
    </>
  );
}
