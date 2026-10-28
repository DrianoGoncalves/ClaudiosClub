import { useEffect, useRef, useState } from 'react';
import type { ModelBenchmarks, ModelVariant } from '../../../shared/model';
import { api } from '../api';
import { formatAgo } from '../format';

// Botão "modelos" no topo do quadro: os modelos de maior índice de código do Artificial Analysis,
// em barras, com uma aba por métrica (índice e preço). Cada modelo aparece no esforço padrão;
// clicar nele abre todos os esforços. Cada clique que abre o botão busca de novo (o servidor segura
// 1 min entre buscas, por causa da cota diária da chave).

type Metric = 'index' | 'price';

const decimals = (v: number, digits: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const METRICS: Record<Metric, { label: string; value: (m: ModelVariant) => number; format: (v: number) => string; order: 1 | -1 }> = {
  index: { label: 'Coding Index', value: (m) => m.codingIndex, format: (v) => decimals(v, 1), order: -1 },
  price: { label: 'Preço', value: (m) => m.priceBlended, format: (v) => `US$ ${decimals(v, v < 1 ? 2 : 1)}`, order: 1 },
};

const FOOTNOTE: Record<Metric, string> = {
  index: 'Índice de código do modelo (não de agentes).',
  price: 'US$ por 1M tokens, 3 de entrada para 1 de saída.',
};

export function ModelsMenu() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ModelBenchmarks | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>('index');
  const [expanded, setExpanded] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // Fecha ao clicar fora ou apertar Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

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

  // A lista abre embaixo do botão; no celular, com a barra quebrando em linhas, puxa para a
  // esquerda o quanto for preciso para caber na tela.
  const [shift, setShift] = useState(0);
  const toggle = () => {
    if (!open) {
      const left = root.current?.getBoundingClientRect().left ?? 0;
      setShift(Math.min(0, window.innerWidth - 12 - Math.min(460, window.innerWidth - 24) - left));
      load();
    }
    setOpen(!open);
  };

  return (
    <div className="inbox" ref={root}>
      <button aria-haspopup="dialog" aria-expanded={open} onClick={toggle} title="Ranking de modelos para código (Artificial Analysis)">
        modelos
      </button>
      {open && (
        <div className="inbox-menu models-menu" role="dialog" aria-label="Ranking de modelos para código" style={{ left: shift }}>
          <div className="models-head">
            <div className="models-tabs" role="tablist">
              {(Object.keys(METRICS) as Metric[]).map((k) => (
                <button key={k} role="tab" aria-selected={metric === k} className={metric === k ? 'is-active' : ''} onClick={() => setMetric(k)}>
                  {METRICS[k].label}
                </button>
              ))}
            </div>
            <button onClick={load} disabled={loading} title="Buscar de novo">
              {loading ? 'buscando…' : 'atualizar'}
            </button>
          </div>
          <ModelsBody data={data} loading={loading} failed={failed} metric={metric} expanded={expanded} onExpand={setExpanded} />
        </div>
      )}
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
  if (!data) return <p className={`muted small models-note ${failed ? 'error' : ''}`}>{failed ?? (loading ? 'Buscando…' : '')}</p>;
  if (!data.configured) {
    return (
      <div className="small models-note">
        <p>
          Para ver o ranking, crie uma chave gratuita na{' '}
          <a href="https://artificialanalysis.ai/api-reference" target="_blank" rel="noopener noreferrer">
            API do Artificial Analysis
          </a>{' '}
          e ponha no arquivo <code>.env</code> da pasta do MyCo:
        </p>
        <pre className="models-env">ARTIFICIAL_ANALYSIS_API_KEY=sua-chave</pre>
        <p className="muted">Não precisa reiniciar: a chave fica só no servidor e é lida na próxima busca.</p>
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
    `Coding Index ${METRICS.index.format(v.codingIndex)} · ${METRICS.price.format(v.priceBlended)} por 1M tokens`;
  const error = failed ?? data.error;
  return (
    <>
      {error && <p className="small error models-note">{error}</p>}
      {rows.length > 0 ? (
        <ol className="models-chart" aria-label={`${m.label}, ${m.order === 1 ? 'menor' : 'maior'} primeiro`}>
          {rows.map((r) => {
            const isOpen = expanded === r.id;
            return (
              <li key={r.id}>
                <button
                  className="models-row"
                  aria-expanded={isOpen}
                  onClick={() => onExpand(isOpen ? null : r.id)}
                  title={`${r.name}${r.creator ? ` (${r.creator})` : ''}${r.effort ? `, esforço ${r.effort}` : ''}\n${numbers(r)}`}
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
                  <ul className="models-variants" aria-label={`Esforços de ${r.name}`}>
                    {r.variants.map((v) => (
                      <li key={v.id} className="models-row models-variant" title={`${v.effort ?? 'esforço não informado'}: ${numbers(v)}`}>
                        <span className="models-name">
                          {v.effort ?? '—'}
                          {v.id === r.id && <span className="muted"> · padrão</span>}
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
        !error && <p className="muted small models-note">A API não trouxe modelos com índice e preço.</p>
      )}
      <p className="muted small models-foot">
        {FOOTNOTE[metric]} No esforço padrão do AA; clique num modelo para ver os outros.
        {data.fetchedAt && ` Lido ${formatAgo(Date.now() - Date.parse(data.fetchedAt))}.`} Dados:{' '}
        <a href="https://artificialanalysis.ai/" target="_blank" rel="noopener noreferrer">
          Artificial Analysis
        </a>
      </p>
    </>
  );
}
