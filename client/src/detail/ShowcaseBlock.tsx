import { useEffect, useRef, useState } from 'react';
import { api, isPairingError, type ShowcaseStatus } from '../api';
import { t } from '../i18n';
import { SHOWCASE_POLL_MS, shouldPollShowcase, showcaseCost, showcaseDoneKey } from './showcaseStatus';

/**
 * Vitrine do projeto (VITRINE.html): quem gera é um gerador oculto do servidor, sem funcionário nem conversa.
 * O botão pede e o painel acompanha o andamento (a cada ~3 s, só com a aba à vista); ao terminar, `onDone` relê o guia
 * e o "Abrir vitrine" aparece. O estado do servidor é em memória: depois de reiniciar volta a "parado".
 */
export function ShowcaseBlock({
  projectId,
  exists,
  onDone,
}: {
  projectId: string;
  /** Já existe um VITRINE.html (vem do GET /guide). */
  exists: boolean;
  /** A geração acabou: relê o guia (para `exists` e a data da última conferência). */
  onDone: () => void;
}) {
  const [status, setStatus] = useState<ShowcaseStatus | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Aviso que não é erro: nada mudou desde a última vitrine, então nada foi gerado. Texto do servidor.
  const [note, setNote] = useState<string | null>(null);
  const handled = useRef<string | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const fetchStatus = (alive: () => boolean = () => true) =>
    api.showcaseStatus(projectId).then(
      (s) => {
        if (alive()) setStatus(s);
      },
      // Servidor sem a rota (ou reiniciando): segue como está, sem erro na tela.
      () => {},
    );

  // Ao abrir o painel (ou trocar de projeto): uma consulta, porque pode já estar gerando.
  useEffect(() => {
    let alive = true;
    setStatus(null);
    setError(null);
    setNote(null);
    handled.current = null;
    void fetchStatus(() => alive);
    return () => {
      alive = false;
    };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Enquanto gera: pergunta a cada ~3 s. Para ao terminar, ao sair do painel (cleanup) e com a aba escondida;
  // ao voltar à aba, pergunta logo.
  const generating = status?.state === 'running';
  useEffect(() => {
    if (!generating) return;
    let alive = true;
    let pending = false;
    const tick = () => {
      if (pending || !shouldPollShowcase('running', document.hidden)) return;
      pending = true;
      void fetchStatus(() => alive).finally(() => {
        pending = false;
      });
    };
    const timer = window.setInterval(tick, SHOWCASE_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [generating, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Terminou: relê o guia uma vez por conclusão (o "Abrir vitrine" depende do `showcase.exists` dele).
  const doneKey = showcaseDoneKey(status);
  useEffect(() => {
    if (!doneKey || handled.current === doneKey) return;
    handled.current = doneKey;
    onDoneRef.current();
  }, [doneKey]);

  const start = async () => {
    setAsking(true);
    setError(null);
    setNote(null);
    setStatus(null);
    try {
      const r = await api.runShowcase(projectId);
      if ('skipped' in r) {
        setNote(r.reason);
        onDoneRef.current();
      } else {
        setStatus({ state: 'running' });
      }
    } catch (e) {
      if (isPairingError(e)) return;
      // 409 (já gerando), 429 (limite de uso), 503 (sem recursos/reiniciando): o texto é do servidor.
      setError((e as Error).message);
      // No 409 outra aba (ou antes de recarregar) já pediu: relê para o botão acompanhar.
      void fetchStatus();
    } finally {
      setAsking(false);
    }
  };

  return (
    <ShowcaseView
      url={api.showcaseUrl(projectId)}
      exists={exists}
      status={status}
      busy={asking || generating}
      note={note}
      error={error}
      onStart={() => void start()}
    />
  );
}

/** A tela da vitrine, só com o que recebe (o estado e o polling ficam no `ShowcaseBlock`). */
export function ShowcaseView({
  url,
  exists,
  status,
  busy,
  note,
  error,
  onStart,
}: {
  url: string;
  exists: boolean;
  status: ShowcaseStatus | null;
  /** Pedido em andamento ou geração rodando: o botão fica desabilitado em "Gerando…". */
  busy: boolean;
  note: string | null;
  error: string | null;
  onStart: () => void;
}) {
  const cost = showcaseCost(status);

  return (
    <section className="section">
      <h3>{t('detail.showcaseHeading')}</h3>
      <p className="muted small">{t('detail.showcaseHint')}</p>
      <p className="actions guide-actions">
        <button className={exists ? 'btn-secondary' : 'btn-primary'} onClick={onStart} disabled={busy} aria-busy={busy || undefined}>
          {busy ? t('detail.showcaseRunning') : t(exists ? 'detail.showcaseUpdate' : 'detail.showcaseCreate')}
        </button>
        {exists && (
          <a className="btn-secondary guide-link" href={url} target="_blank" rel="noopener noreferrer">
            {t('detail.showcaseOpen')}
          </a>
        )}
      </p>
      {status?.state === 'done' && (
        <p className="guide-since small" role="status">
          {cost ? t('detail.showcaseDoneCost', { cost }) : t('detail.showcaseDone')}
        </p>
      )}
      {note && (
        <p className="guide-since small" role="status">
          {note}
        </p>
      )}
      {status?.state === 'failed' && <p className="error small">{status.error || t('detail.showcaseFailed')}</p>}
      {error && <p className="error small">{error}</p>}
      <ul className="guide-hints muted small">
        <li>{t('detail.showcaseWork')}</li>
      </ul>
    </section>
  );
}
