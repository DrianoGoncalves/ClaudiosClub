import { useEffect, useState } from 'react';
import type { StaffProfile } from '../../../shared/model';
import { api, isPairingError, type ProjectGuide as Guide } from '../api';
import { t, locale } from '../i18n';
import { FileIcon } from '../icons';
import { defaultGuideStaff, type GuideAction } from './guideActions';

type Busy = GuideAction | 'create' | null;

/**
 * Guia do projeto (SPEC.md): a equipe lê em caso de dúvida. Cria a partir do modelo ou abre no editor de Arquivos.
 * Um funcionário (`staff`) também pode testá-lo, conferi-lo com o código ou, sem guia, escrever um rascunho.
 */
export function ProjectGuide({
  projectId,
  staff = [],
  onOpen,
  onOpenConversation,
}: {
  projectId: string;
  /** Funcionários do projeto: quem faz o teste, a verificação e o rascunho. */
  staff?: StaffProfile[];
  onOpen?: (path: string) => void;
  /** A conversa que o pedido abriu (o painel do funcionário mostra). */
  onOpenConversation?: (staffId: string, sessionId: string) => void;
}) {
  const [guide, setGuide] = useState<Guide | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  // Aviso que não é erro: o pedido não abriu conversa (nada mudou desde a última conferência). Texto do servidor.
  const [note, setNote] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  // Quem a pessoa escolheu, se ainda está na equipe; senão o do topo do organograma.
  const who = staff.some((s) => s.id === picked) ? picked : defaultGuideStaff(staff);

  useEffect(() => {
    setGuide(null);
    setError(null);
    setNote(null);
    setPicked(null);
    api.projectGuide(projectId).then(setGuide, (e: Error) => setError(e.message));
  }, [projectId]);

  // Relê o guia: a recusa por já existir (409/400) ou por não existir muda quais botões aparecem.
  const reread = () =>
    api.projectGuide(projectId).then(
      (g) => {
        setGuide(g);
        if (g.exists) setError(null);
      },
      () => {},
    );

  const create = async () => {
    setBusy('create');
    setError(null);
    try {
      setGuide(await api.createProjectGuide(projectId));
    } catch (e) {
      if (isPairingError(e)) return;
      setError((e as Error).message);
      // Recusa por já existir (409): relê, e aparece o "Abrir".
      void reread();
    } finally {
      setBusy(null);
    }
  };

  const run = async (action: GuideAction) => {
    if (!who) return;
    setBusy(action);
    setError(null);
    setNote(null);
    try {
      const r = await api.runProjectGuide(projectId, action, who);
      if ('skipped' in r) {
        // Sem conversa nova nem erro: só diz por quê. Relê para o contador de arquivos mudados acompanhar.
        setNote(r.reason);
      } else {
        onOpenConversation?.(r.staffId, r.sessionId);
      }
      // O servidor grava o HEAD como nova base ao abrir a conversa: o "N arquivos mudaram" recomeça.
      void reread();
    } catch (e) {
      if (isPairingError(e)) return;
      setError((e as Error).message);
      void reread();
    } finally {
      setBusy(null);
    }
  };

  /** Botão de pedido ao funcionário: sem ninguém na equipe fica `aria-disabled` com o motivo (o `disabled` esconderia o title). */
  const runButton = (action: GuideAction, label: string, hint: string, className: string) => (
    <button
      className={className}
      onClick={() => void run(action)}
      disabled={busy !== null}
      aria-disabled={!who || undefined}
      title={who ? hint : t('detail.guideNoStaff')}
    >
      {busy === action ? t('detail.guideRunning') : label}
    </button>
  );

  const whoPicker =
    staff.length > 0 ? (
      <label className="guide-who small">
        <span className="muted">{t('detail.guideWho')}</span>
        <select className="setting-select" value={who ?? ''} onChange={(e) => setPicked(e.target.value)} disabled={busy !== null}>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.role}
            </option>
          ))}
        </select>
      </label>
    ) : (
      <p className="muted small">{t('detail.guideNoStaff')}</p>
    );

  // "N arquivos mudaram desde 09/11/2026": só com base de conferência (o servidor omite os dois campos sem ela).
  const checkedAt = guide?.lastCheck ? Date.parse(guide.lastCheck.at) : NaN;
  const since =
    guide?.changedSince !== undefined && !Number.isNaN(checkedAt)
      ? t(guide.changedSince === 1 ? 'detail.guideChangedOne' : 'detail.guideChangedOther', {
          n: guide.changedSince,
          date: new Date(checkedAt).toLocaleDateString(locale()),
        })
      : null;

  return (
    <section className="section">
      <h3>{t('detail.guideHeading')}</h3>
      {!guide ? (
        !error && <p className="muted small">{t('detail.loading')}</p>
      ) : guide.exists ? (
        <>
          <p className="muted small">{t('detail.guideExists', { path: guide.path })}</p>
          {guide.isGit && !guide.ignored && (
            <p className="guide-alert small" role="note">
              {t('detail.guideGitAlert', { path: guide.path })}
            </p>
          )}
          {whoPicker}
          <p className="actions guide-actions">
            {onOpen && (
              <button className="btn-secondary btn-with-icon" onClick={() => onOpen(guide.path)}>
                <FileIcon />
                {t('detail.guideOpen')}
              </button>
            )}
            {runButton('test', t('detail.guideTest'), t('detail.guideTestHint'), 'btn-secondary')}
            {runButton('drift', t('detail.guideDrift'), t('detail.guideDriftHint'), 'btn-secondary')}
          </p>
          {note ? (
            <p className="guide-since small" role="status">
              {note}
            </p>
          ) : (
            since && <p className="guide-since muted small">{since}</p>
          )}
          <ul className="guide-hints muted small">
            <li>{t('detail.guideTestHint')}</li>
            <li>{t('detail.guideDriftHint')}</li>
          </ul>
        </>
      ) : (
        <>
          <p className="muted small">{t('detail.guideNone')}</p>
          {whoPicker}
          <p className="actions guide-actions">
            <button className="btn-primary" onClick={() => void create()} disabled={busy !== null}>
              {busy === 'create' ? t('detail.guideCreating') : t('detail.guideCreate')}
            </button>
            {runButton('draft', t('detail.guideDraft'), t('detail.guideDraftHint'), 'btn-secondary')}
          </p>
          <ul className="guide-hints muted small">
            <li>{t('detail.guideDraftHint')}</li>
          </ul>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
