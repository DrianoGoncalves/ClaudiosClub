import { useEffect, useState } from 'react';
import { api, type GithubCheck, type GithubSkillStatus, type GithubTarget } from '../api';
import { locale, t } from '../i18n';
import { diffCounts, errorText, frontmatterText, githubError, hasDanger, hasNewVersion, repoLabel, safeRepoUrl, shortSha, type GithubErrorKind } from './githubSkill';
import { AlertList, DiffList, Sha } from './GithubParts';

// A origem de uma skill instalada por link do GitHub: de onde veio, selo de versão nova, verificar (com o diff de todos os
// arquivos), aplicar com confirmação (aviso forte se foi mexida aqui) e voltar à versão anterior. Nada é trocado sem o clique.

/** As etiquetas de uma skill com origem no GitHub: o selo, "há versão nova" e "modificada aqui". */
export function GithubBadges({ status }: { status: GithubSkillStatus }) {
  return (
    <>
      <span className="badge gh-badge">{t('gh.badge')}</span>
      {hasNewVersion(status) && <span className="badge gh-badge is-new">{t('gh.badgeNew')}</span>}
      {status.modified && <span className="badge gh-badge is-modified">{t('gh.badgeModified')}</span>}
    </>
  );
}

export type OriginPhase = 'idle' | 'checking' | 'applying' | 'rolling';

interface ViewProps {
  name: string;
  status: GithubSkillStatus;
  check: GithubCheck | null;
  phase: OriginPhase;
  /** Qual confirmação está aberta. */
  confirm: 'apply' | 'rollback' | null;
  /** Ciência dos alertas de perigo da versão nova. */
  ack: boolean;
  /** A skill foi mexida aqui (a verificação ou o servidor disseram): a troca apaga as mudanças. */
  modified: boolean;
  notice: string | null;
  error: GithubErrorKind | null;
  onCheck: () => void;
  onAck: (ack: boolean) => void;
  onAsk: (what: 'apply' | 'rollback' | null) => void;
  onApply: () => void;
  onRollback: () => void;
}

/** A frase de um erro nesta seção: "prévia velha" aqui é a versão nova que mudou depois da verificação. */
const originError = (e: GithubErrorKind) => (e.kind === 'changed' ? t('gh.updateStale') : errorText(e));

/** A seção do painel, sem rede nem estado (testável por renderização). */
export function OriginView({ name, status, check, phase, confirm, ack, modified, notice, error, onCheck, onAck, onAsk, onApply, onRollback }: ViewProps) {
  const busy = phase !== 'idle';
  const link = safeRepoUrl(status.origin.url);
  const label = repoLabel(status.origin.url);
  const update = check && !check.upToDate ? check : null;
  const danger = update ? hasDanger(update.alerts) : false;
  // A verificação de agora vale mais que o selo da checagem diária: em dia, o "há versão nova" some.
  const shown: GithubSkillStatus = check?.upToDate ? { ...status, update: null } : status;
  return (
    <section className="section gh-origin">
      <h3>
        {t('gh.originTitle')} <GithubBadges status={shown} />
      </h3>
      <dl className="gh-facts">
        <div>
          <dt>{t('gh.originFrom')}</dt>
          <dd>
            {link ? (
              <a href={link} target="_blank" rel="noopener noreferrer" className="mono link">
                {label ?? link}
              </a>
            ) : (
              <span className="mono">{status.origin.url}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t('gh.originSha')}</dt>
          <dd>
            <Sha sha={status.origin.sha} />
          </dd>
        </div>
        <div>
          <dt>{t('gh.originRef')}</dt>
          <dd className="mono">{status.origin.ref}</dd>
        </div>
        <div>
          <dt>{t('gh.originAt')}</dt>
          <dd>{new Date(status.origin.installedAt).toLocaleDateString(locale(), { dateStyle: 'medium' })}</dd>
        </div>
      </dl>
      {hasNewVersion(shown) && !check && <p className="gh-note">{t('gh.originNew')}</p>}
      {modified && (
        <p className="gh-warn" role="note">
          {t('gh.modifiedWarn')}
        </p>
      )}

      <div className="skill-actions">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onCheck}>
          {phase === 'checking' ? t('gh.checking') : t('gh.check')}
        </button>
      </div>

      {check?.upToDate && <p className="ok small">{check.sha ? t('gh.upToDateRepo') : t('gh.upToDate')}</p>}

      {update && (
        <div className="gh-update">
          <h4>{t('gh.updateTitle', { from: shortSha(update.fromSha), to: shortSha(update.toSha) })}</h4>
          <p className="muted small">{t('gh.updateSource', { repo: repoLabel(update.source.url) ?? `${update.source.owner}/${update.source.repo}`, ref: update.ref })}</p>
          <p className="small">{t('gh.diffCounts', diffCounts(update.diff))}</p>
          {update.frontmatter.length > 0 && (
            <div>
              <h5>{t('gh.fmTitle')}</h5>
              <ul className="plain gh-fm">
                {update.frontmatter.map((f) => (
                  <li key={f.key} className="mono">
                    {t('gh.fmRow', { key: f.key, before: frontmatterText(f.before), after: frontmatterText(f.after) })}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <AlertList alerts={update.alerts} />
          <DiffList diff={update.diff} />
          {danger && (
            <label className="check gh-ack">
              <input type="checkbox" checked={ack} onChange={(e) => onAck(e.target.checked)} /> {t('gh.ack')}
            </label>
          )}
          {confirm === 'apply' ? (
            <div className={`skill-confirm gh-confirm ${modified ? 'is-local' : ''}`} role="group" aria-label={t('gh.apply')}>
              <p>{modified ? t('gh.applyAskLocal', { name, to: shortSha(update.toSha) }) : t('gh.applyAsk', { name, to: shortSha(update.toSha), from: shortSha(update.fromSha) })}</p>
              <div className="skill-actions">
                <button type="button" className={`btn-secondary ${modified ? 'is-danger' : ''}`} disabled={busy || (danger && !ack)} onClick={onApply}>
                  {phase === 'applying' ? t('gh.applying') : modified ? t('gh.applyYesLocal') : t('gh.applyYes')}
                </button>
                <button type="button" className="btn-secondary" autoFocus disabled={busy} onClick={() => onAsk(null)}>
                  {t('gh.applyNo')}
                </button>
              </div>
            </div>
          ) : (
            <div className="skill-actions">
              <button type="button" className="btn-primary" disabled={busy || (danger && !ack)} onClick={() => onAsk('apply')}>
                {t('gh.apply')}
              </button>
            </div>
          )}
        </div>
      )}

      {notice && (
        <p className="ok small" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {originError(error)}
        </p>
      )}

      <div className="gh-rollback">
        <h4>{t('gh.rollbackTitle')}</h4>
        <p className="muted small">{t('gh.rollbackHelp')}</p>
        {confirm === 'rollback' ? (
          <div className="skill-confirm" role="group" aria-label={t('gh.rollback')}>
            <p>{t('gh.rollbackAsk', { name })}</p>
            <div className="skill-actions">
              <button type="button" className="btn-secondary" disabled={busy} onClick={onRollback}>
                {phase === 'rolling' ? t('gh.rollingBack') : t('gh.rollbackYes')}
              </button>
              <button type="button" className="btn-secondary" autoFocus disabled={busy} onClick={() => onAsk(null)}>
                {t('gh.applyNo')}
              </button>
            </div>
          </div>
        ) : (
          <div className="skill-actions">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => onAsk('rollback')}>
              {t('gh.rollback')}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

interface Props {
  target: GithubTarget;
  name: string;
  /** Aplicou ou voltou: o conteúdo da skill mudou (quem chamou relê o que mostra dela). */
  onChanged: () => void;
}

/** Lê a origem da skill; sem origem no GitHub (ou sem como ler), a seção nem aparece. */
export function GithubOrigin({ target, name, onChanged }: Props) {
  const key = `${target.scope}:${target.projectId ?? ''}:${name}`;
  const [status, setStatus] = useState<GithubSkillStatus | null>(null);
  const [check, setCheck] = useState<GithubCheck | null>(null);
  const [phase, setPhase] = useState<OriginPhase>('idle');
  const [confirm, setConfirm] = useState<'apply' | 'rollback' | null>(null);
  const [ack, setAck] = useState(false);
  const [forced, setForced] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<GithubErrorKind | null>(null);

  const load = () =>
    api.githubStatus(target).then(
      (list) => setStatus(list.find((s) => s.name === name) ?? null),
      () => setStatus(null),
    );

  // Cada skill começa do zero: sem resto da anterior (verificação, confirmação, aviso).
  useEffect(() => {
    setStatus(null);
    setCheck(null);
    setPhase('idle');
    setConfirm(null);
    setAck(false);
    setForced(false);
    setNotice(null);
    setError(null);
    let alive = true;
    api.githubStatus(target).then(
      (list) => alive && setStatus(list.find((s) => s.name === name) ?? null),
      () => alive && setStatus(null),
    );
    return () => {
      alive = false;
    };
  }, [key]);

  if (!status) return null;

  const modified = forced || status.modified || (check !== null && !check.upToDate && check.localModified);

  const run = async (next: OriginPhase, action: () => Promise<void>) => {
    setPhase(next);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      const err = githubError(e);
      if (err?.kind === 'modified' && next === 'applying') {
        // A skill foi mexida depois da verificação: a confirmação passa a ser a de sobrescrever.
        setForced(true);
        setPhase('idle');
        return;
      }
      setError(err);
    }
    setPhase('idle');
  };

  const afterChange = async () => {
    setCheck(null);
    setConfirm(null);
    setAck(false);
    setForced(false);
    await load();
    onChanged();
  };

  return (
    <OriginView
      name={name}
      status={status}
      check={check}
      phase={phase}
      confirm={confirm}
      ack={ack}
      modified={modified}
      notice={notice}
      error={error}
      onCheck={() =>
        void run('checking', async () => {
          setConfirm(null);
          setAck(false);
          setCheck(await api.githubCheck(target, name));
        })
      }
      onAck={setAck}
      onAsk={(what) => {
        setConfirm(what);
        setError(null);
      }}
      onApply={() => {
        if (!check || check.upToDate) return;
        void run('applying', async () => {
          const done = await api.githubUpdate(target, { name, sha: check.toSha, digest: check.digest, ...(modified && { overwriteLocal: true }) });
          await afterChange();
          setNotice(t('gh.applied', { sha: shortSha(done.sha) }));
        });
      }}
      onRollback={() =>
        void run('rolling', async () => {
          const done = await api.githubRollback(target, name);
          await afterChange();
          setNotice(t('gh.rolledBack', { sha: shortSha(done.sha) }));
        })
      }
    />
  );
}
