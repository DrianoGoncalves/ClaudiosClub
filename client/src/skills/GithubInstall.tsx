import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type GithubChoose, type GithubPreview, type GithubTarget } from '../api';
import { useEscape } from '../chat/usageWarning';
import { t } from '../i18n';
import { errorText, folderNameOk, githubError, hasDanger, repoLabel, shortSha, type GithubErrorKind } from './githubSkill';
import { AlertList, FileList, Sha } from './GithubParts';

// Instalar uma skill de um link do GitHub: URL → (escolher, se o link tem várias) → prévia → Instalar. A prévia mostra o
// SKILL.md, todos os arquivos e os alertas ANTES de gravar; o Instalar é um botão à parte e, com alerta de perigo, só vale
// com a ciência marcada. Instalar não ativa a skill (ninguém a usa até marcar na ficha). Mesmo fluxo nos três escopos.

const SCOPE_LABEL = { library: 'gh.scopeLibrary', user: 'gh.scopeUser', project: 'gh.scopeProject' } as const;

interface PreviewProps {
  preview: GithubPreview;
  scope: GithubTarget['scope'];
  name: string;
  ack: boolean;
  busy: boolean;
  error: GithubErrorKind | null;
  onName: (name: string) => void;
  onAck: (ack: boolean) => void;
  onInstall: () => void;
  onRefresh: () => void;
  onBack: () => void;
  onCancel: () => void;
}

/** A prévia (sem rede, testável por renderização): origem, alertas, SKILL.md, arquivos, nome e o Instalar. */
export function PreviewView({ preview, scope, name, ack, busy, error, onName, onAck, onInstall, onRefresh, onBack, onCancel }: PreviewProps) {
  const danger = hasDanger(preview.alerts);
  const nameOk = folderNameOk(scope, name);
  const { source } = preview;
  return (
    <>
      <section className="gh-source">
        <h3>{t('gh.source')}</h3>
        <p className="mono">{t('gh.sourceLine', { repo: `${source.owner}/${source.repo}`, ref: source.ref, sha: shortSha(source.sha) })}</p>
        <p className="muted small">{t('gh.sourceFolder', { path: source.path || t('gh.sourceRoot') })}</p>
      </section>
      <AlertList alerts={preview.alerts} />
      <section>
        <h3>{t('gh.skillMdTitle')}</h3>
        <pre className="gh-md gh-scroll" tabIndex={0} aria-label={t('gh.skillMdTitle')}>
          {preview.skillMd}
        </pre>
      </section>
      <FileList files={preview.files} totalBytes={preview.totalBytes} />
      <label className="gh-name">
        {t('gh.nameLabel')}
        <input value={name} onChange={(e) => onName(e.target.value)} maxLength={64} required aria-invalid={!nameOk} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
      </label>
      {!nameOk && <p className="error small">{t('gh.nameInvalid')}</p>}
      <p className="gh-note" role="note">
        {scope === 'library' ? t('gh.notActiveLibrary', { name }) : t('gh.notActiveFolder')}
      </p>
      {danger && (
        <label className="check gh-ack">
          <input type="checkbox" checked={ack} onChange={(e) => onAck(e.target.checked)} /> {t('gh.ack')}
        </label>
      )}
      {error && (
        <p className="error" role="alert">
          {errorText(error)}
        </p>
      )}
      <div className="gh-actions">
        {error?.kind === 'changed' ? (
          <button type="button" className="btn-primary" disabled={busy} onClick={onRefresh}>
            {t('gh.refresh')}
          </button>
        ) : (
          <button type="button" className="btn-primary" disabled={busy || !nameOk || (danger && !ack)} onClick={onInstall}>
            {busy ? t('gh.installing') : t('gh.installBtn')}
          </button>
        )}
        <button type="button" className="btn-secondary" disabled={busy} onClick={onBack}>
          {t('gh.back')}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
          {t('gh.cancel')}
        </button>
      </div>
    </>
  );
}

/** O link tinha várias skills: uma linha clicável por skill, com a descrição. */
export function ChooseView({ choose, busy, onPick }: { choose: GithubChoose; busy: boolean; onPick: (path: string) => void }) {
  return (
    <section className="gh-choose">
      <h3>{t('gh.chooseTitle', { n: choose.skills.length })}</h3>
      <ul className="plain">
        {choose.skills.map((s) => (
          <li key={s.path}>
            <button type="button" className="gh-pick" disabled={busy} onClick={() => onPick(s.path)}>
              <strong>{s.name}</strong>
              <span className="mono muted">{s.path}</span>
              <span className="gh-desc">{s.description || t('gh.chooseNoDesc')}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

type Step = { kind: 'url' } | { kind: 'choose'; choose: GithubChoose } | { kind: 'preview'; preview: GithubPreview; from: 'url' | 'choose'; choose?: GithubChoose } | { kind: 'done'; name: string; sha: string };

interface Props {
  target: GithubTarget;
  onClose: () => void;
  /** Instalou: quem chamou relê a lista (a skill nova aparece). */
  onInstalled: () => void;
}

export function GithubInstall({ target, onClose, onInstalled }: Props) {
  const [url, setUrl] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'url' });
  const [name, setName] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GithubErrorKind | null>(null);
  // O que a prévia atual usa para instalar (o link como colado e a pasta escolhida).
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const modal = useRef<HTMLDivElement>(null);
  useEscape(!busy, onClose);
  // Cada etapa abre no topo (a lista de skills rolada não pode deixar a prévia começando no meio).
  useEffect(() => {
    // Bloco, não seta: em navegador novo o scrollTo devolve uma promessa e o React não aceita devolução que não seja a limpeza.
    modal.current?.scrollTo(0, 0);
  }, [step.kind]);

  const fail = (e: unknown) => setError(githubError(e));

  const showPreview = async (path: string | undefined, choose?: GithubChoose) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.githubPreview(url.trim(), path);
      if (res.kind === 'choose') {
        setStep({ kind: 'choose', choose: res });
      } else {
        setPicked(path);
        setName(res.name);
        setAck(false);
        setStep({ kind: 'preview', preview: res, from: choose ? 'choose' : 'url', ...(choose && { choose }) });
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const install = async (preview: GithubPreview) => {
    setBusy(true);
    setError(null);
    try {
      const { source } = preview;
      const done = await api.githubInstall(target, { url: url.trim(), path: source.path, ref: source.ref, sha: source.sha, digest: preview.digest, name });
      setStep({ kind: 'done', name: done.name, sha: done.sha });
      onInstalled();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const back = () => {
    setError(null);
    if (step.kind === 'preview' && step.from === 'choose' && step.choose) setStep({ kind: 'choose', choose: step.choose });
    else setStep({ kind: 'url' });
  };

  // No body: o vidro do painel lateral (backdrop-filter) prenderia o modal dentro dele. Clique fora só fecha na primeira etapa.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && step.kind === 'url' && !url && !busy && onClose()}>
      <div ref={modal} className="modal gh-modal" role="dialog" aria-modal="true" aria-labelledby="gh-title">
        <button type="button" className="drawer-close" onClick={onClose} aria-label={t('gh.close')}>
          ×
        </button>
        <p className="kicker">{t('gh.kicker', { scope: t(SCOPE_LABEL[target.scope]) })}</p>
        <h2 id="gh-title">{t('gh.title')}</h2>

        {step.kind === 'url' && (
          <form
            className="gh-url"
            onSubmit={(e) => {
              e.preventDefault();
              void showPreview(undefined);
            }}
          >
            <label>
              {t('gh.urlLabel')}
              <input
                type="text"
                inputMode="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t('gh.urlPlaceholder')}
                maxLength={500}
                required
                autoFocus
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-describedby="gh-url-help"
              />
            </label>
            <p id="gh-url-help" className="muted small">
              {t('gh.urlHelp')}
            </p>
            {error && (
              <p className="error" role="alert">
                {errorText(error)}
              </p>
            )}
            <div className="gh-actions">
              <button type="submit" className="btn-primary" disabled={busy || !url.trim()}>
                {busy ? t('gh.previewing') : t('gh.preview')}
              </button>
              <button type="button" className="btn-secondary" onClick={onClose}>
                {t('gh.cancel')}
              </button>
            </div>
          </form>
        )}

        {step.kind === 'choose' && (
          <>
            <ChooseView choose={step.choose} busy={busy} onPick={(path) => void showPreview(path, step.choose)} />
            {busy && <p className="muted small">{t('gh.previewing')}</p>}
            {error && (
              <p className="error" role="alert">
                {errorText(error)}
              </p>
            )}
            <div className="gh-actions">
              <button type="button" className="btn-secondary" disabled={busy} onClick={back}>
                {t('gh.back')}
              </button>
            </div>
          </>
        )}

        {step.kind === 'preview' && (
          <PreviewView
            preview={step.preview}
            scope={target.scope}
            name={name}
            ack={ack}
            busy={busy}
            error={error}
            onName={setName}
            onAck={setAck}
            onInstall={() => void install(step.preview)}
            onRefresh={() => void showPreview(picked, step.choose)}
            onBack={back}
            onCancel={onClose}
          />
        )}

        {step.kind === 'done' && (
          <>
            <section className="gh-done" role="status">
              <h3>{t('gh.doneTitle', { name: step.name })}</h3>
              <p>{target.scope === 'library' ? t('gh.doneLibraryText', { sha: shortSha(step.sha), name: step.name }) : t('gh.doneText', { sha: shortSha(step.sha) })}</p>
              {repoLabel(url.trim()) && (
                <p className="muted small">
                  {repoLabel(url.trim())} · <Sha sha={step.sha} />
                </p>
              )}
            </section>
            <div className="gh-actions">
              <button type="button" className="btn-primary" autoFocus onClick={onClose}>
                {t('gh.close')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
