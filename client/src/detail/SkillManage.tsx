import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Skill } from '../../../shared/model';
import { api, type SkillDeleted, type SkillHook, type SkillSource } from '../api';
import { useEscape } from '../chat/usageWarning';
import { t } from '../i18n';
import { hooksChanged, needsHooksConfirm, skillLock, skillRef } from './skillAccess';

// Editar o SKILL.md e excluir (para a lixeira do servidor) uma skill da conta ou do projeto, no painel dela.
// Hook apontando para a skill: o servidor não apaga e devolve a lista; o alerta pergunta "Deseja continuar?" e, com o Sim,
// o servidor tira os hooks (com backup dos settings) e depois manda a skill para a lixeira.
// As outras recusas do servidor (link, sincronizada, settings inválido) aparecem com a mensagem dele, sem esconder.

interface ViewProps {
  name: string;
  source: SkillSource | null;
  loadError: string | null;
  /** Salvou há pouco (a confirmação some ao abrir outra skill). */
  saved: boolean;
  confirming: boolean;
  busy: boolean;
  error: string | null;
  onEdit: () => void;
  onAskDelete: (ask: boolean) => void;
  onDelete: () => void;
}

/** A seção do painel, sem estado nem rede (testável por renderização). */
export function SkillManageView({ name, source, loadError, saved, confirming, busy, error, onEdit, onAskDelete, onDelete }: ViewProps) {
  const lock = source ? skillLock(source) : null;
  return (
    <section className="section skill-manage">
      <h3>{t('detail.skillManageTitle')}</h3>
      {!source && !loadError && <p className="muted small">{t('detail.loading')}</p>}
      {loadError && <p className="error">{loadError}</p>}
      {lock && <p className="muted small skill-lock">{lock.kind === 'link' ? t('detail.skillLinked', { target: lock.target }) : t('detail.skillLocked')}</p>}
      {source?.editable && (
        <>
          <p className="muted small">{t('detail.skillManageIntro')}</p>
          {confirming ? (
            <div className="skill-confirm" role="group" aria-label={t('detail.skillDeleteTitle')}>
              <p>{t('detail.skillDeleteAsk', { name })}</p>
              <div className="skill-actions">
                <button type="button" className="btn-secondary is-danger" disabled={busy} onClick={onDelete}>
                  {busy ? t('detail.skillDeleting') : t('detail.skillDeleteYes')}
                </button>
                <button type="button" className="btn-secondary" autoFocus disabled={busy} onClick={() => onAskDelete(false)}>
                  {t('detail.skillDeleteNo')}
                </button>
              </div>
            </div>
          ) : (
            <div className="skill-actions">
              <button type="button" className="btn-secondary" onClick={onEdit}>
                {t('detail.edit')}
              </button>
              <button type="button" className="btn-secondary is-danger" onClick={() => onAskDelete(true)}>
                {t('detail.skillDelete')}
              </button>
            </div>
          )}
        </>
      )}
      {saved && <p className="ok small">{t('detail.skillSaved')}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

interface WarningProps {
  name: string;
  hooks: SkillHook[];
  busy: boolean;
  /** A mensagem do servidor quando os hooks mudaram desde o aviso anterior (a lista já é a nova). */
  error: string | null;
  onYes: () => void;
  onCancel: () => void;
}

/** O alerta dos hooks vinculados: a lista, o que acontece e "Deseja continuar?". Cancelar é o padrão (foco, Esc, clique fora). */
export function SkillHooksWarning({ name, hooks, busy, error, onYes, onCancel }: WarningProps) {
  useEscape(!busy, onCancel);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="modal usage-warning skill-hooks-warning" role="alertdialog" aria-modal="true" aria-labelledby="skill-hooks-title" aria-describedby="skill-hooks-text">
        <h2 id="skill-hooks-title">{t('detail.skillHooksTitle')}</h2>
        <p id="skill-hooks-text">{t('detail.skillHooksText', { name })}</p>
        <ul className="skill-hooks">
          {hooks.map((h) => (
            <li key={`${h.file}\n${h.event}`}>
              <strong>{h.event}</strong>
              <span className="mono muted">{h.file}</span>
            </li>
          ))}
        </ul>
        <p className="muted small">{t('detail.skillHooksBackup')}</p>
        {error && <p className="error">{error}</p>}
        <p>
          <strong>{t('detail.skillHooksAsk')}</strong>
        </p>
        <div className="usage-warning-actions">
          <button type="button" className="btn-secondary" autoFocus disabled={busy} onClick={onCancel}>
            {t('detail.cancel')}
          </button>
          <button type="button" className="btn-secondary is-danger" disabled={busy} onClick={onYes}>
            {busy ? t('detail.skillHooksRemoving') : t('detail.skillHooksYes')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface Props {
  skill: Skill;
  /** O projeto da skill (null = skill da conta). */
  projectId: string | null;
  /** Salvou ou excluiu: o quadro relê a lista. */
  onChanged: () => void;
  /** Excluiu: a pasta da lixeira onde a skill ficou e, se saíram hooks, quais e onde estão os backups dos settings. */
  onDeleted: (done: SkillDeleted) => void;
}

export function SkillManage({ skill, projectId, onChanged, onDeleted }: Props) {
  const ref = skillRef(skill, projectId);
  const key = ref ? `${ref.scope}:${ref.projectId ?? ''}:${ref.name}` : '';
  const [source, setSource] = useState<SkillSource | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hooks que apontam para a skill (alerta aberto) e o aviso de que a lista mudou desde a anterior.
  const [hooks, setHooks] = useState<SkillHook[] | null>(null);
  const [hooksError, setHooksError] = useState<string | null>(null);

  // Cada skill começa do zero: sem resto da anterior (editor aberto, confirmação, alerta, erro) e com a leitura dela.
  useEffect(() => {
    setSource(null);
    setLoadError(null);
    setEditing(false);
    setSaved(false);
    setConfirming(false);
    setBusy(false);
    setError(null);
    setHooks(null);
    setHooksError(null);
    if (!ref) return;
    let alive = true;
    api.skillSource(ref).then(
      (s) => alive && setSource(s),
      (e: Error) => alive && setLoadError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [key]);

  // Sincronizada vem de fora do Club: só leitura, e o painel diz o porquê em vez de sumir com as ações.
  if (!ref) {
    return skill.readOnly || skill.scope === 'synced' ? (
      <section className="section skill-manage">
        <p className="muted small skill-lock">{t('detail.skillSyncedWhy')}</p>
      </section>
    ) : null;
  }

  /** Sem `confirmed`: o servidor só apaga se não houver hook; com hook devolve a lista e nada é apagado. */
  const remove = async (confirmed?: SkillHook[]) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.deleteSkill(ref, confirmed);
      if (needsHooksConfirm(res)) {
        setHooks(res.hooks);
        setConfirming(false);
        setBusy(false);
        return;
      }
      onDeleted(res);
    } catch (e) {
      const message = (e as Error).message;
      if (confirmed && hooksChanged(message)) {
        // A lista confirmada ficou velha: mostra a mensagem e volta ao aviso com a lista nova (nada foi apagado).
        setHooksError(message);
        await remove();
        return;
      }
      setError(message);
      setConfirming(false);
      setHooks(null);
      setBusy(false);
    }
  };

  const save = async (content: string) => {
    const next = await api.saveSkill(ref, content);
    setSource(next);
    setSaved(true);
    setError(null);
    setEditing(false);
    onChanged();
  };

  return (
    <>
      <SkillManageView
        name={skill.name}
        source={source}
        loadError={loadError}
        saved={saved}
        confirming={confirming}
        busy={busy}
        error={error}
        onEdit={() => {
          setSaved(false);
          setError(null);
          setEditing(true);
        }}
        onAskDelete={(ask) => {
          setConfirming(ask);
          setSaved(false);
          setError(null);
        }}
        onDelete={() => {
          setHooksError(null);
          void remove();
        }}
      />
      {/* No body: o vidro do painel lateral (backdrop-filter) prenderia o alerta dentro dele. */}
      {hooks &&
        createPortal(
          <SkillHooksWarning
            name={skill.name}
            hooks={hooks}
            busy={busy}
            error={hooksError}
            onYes={() => void remove(hooks)}
            onCancel={() => {
              setHooks(null);
              setHooksError(null);
            }}
          />,
          document.body,
        )}
      {editing && source && (
        <SkillEditor
          name={skill.name}
          scopeLabel={ref.scope === 'project' ? t('detail.scopeProject') : t('detail.scopeUser')}
          initial={source.content}
          onClose={() => setEditing(false)}
          onSave={save}
        />
      )}
    </>
  );
}

interface EditorProps {
  name: string;
  scopeLabel: string;
  initial: string;
  onClose: () => void;
  /** Recusa (erro) fica no editor, com a mensagem do servidor; o texto digitado não se perde. */
  onSave: (content: string) => Promise<void>;
}

function SkillEditor({ name, scopeLabel, initial, onClose, onSave }: EditorProps) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = text !== initial;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave(text);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  // No body: o vidro do painel lateral (backdrop-filter) prenderia o modal dentro dele. Clique fora só fecha sem texto mexido.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !dirty && onClose()}>
      <form className="modal hire skill-editor" onSubmit={submit}>
        <button type="button" className="drawer-close" onClick={onClose} aria-label={t('app.close')}>
          ×
        </button>
        <p className="kicker">{t('detail.kickerSkill', { scope: scopeLabel })}</p>
        <h2>{t('detail.skillEditTitle', { name })}</h2>
        <p className="muted small">{t('detail.skillEditHelp')}</p>
        <label>
          {t('detail.skillContent')}
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={18} className="mono" spellCheck={false} required />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="submit" className="btn-primary" disabled={busy || !dirty || !text.trim()}>
            {busy ? t('detail.saving') : t('detail.skillSave')}
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t('detail.cancel')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
