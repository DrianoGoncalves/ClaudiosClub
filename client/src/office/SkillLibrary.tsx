import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LibrarySkill } from '../../../shared/model';
import { api, type GithubSkillStatus, type GithubTarget } from '../api';
import { t } from '../i18n';
import { askConfirm } from '../lib/dialogStore';
import { GithubInstall } from '../skills/GithubInstall';
import { GithubBadges, GithubOrigin } from '../skills/GithubOrigin';

// Biblioteca de skills da conta: ficam fora do ~/.claude, então nenhuma sessão vê sozinha; só quem
// tem a skill marcada na ficha (como `myco:<nome>`). Aqui se cria e se edita o SKILL.md; scripts e
// outros arquivos da pasta ficam como estão.

/** No painel da conta: a lista, com criar, editar e tirar (vai para a lixeira). */
const LIBRARY: GithubTarget = { scope: 'library', projectId: null };

export function SkillLibrary() {
  const [list, setList] = useState<LibrarySkill[] | null>(null);
  const [editing, setEditing] = useState<string | null | 'new'>(null);
  const [installing, setInstalling] = useState(false);
  // Quais skills da biblioteca vieram de um link do GitHub (selo, "há versão nova", "modificada aqui").
  const [origins, setOrigins] = useState<Map<string, GithubSkillStatus>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const reload = () => {
    void api.githubStatus(LIBRARY).then(
      (l) => setOrigins(new Map(l.map((s) => [s.name, s]))),
      () => {},
    );
    return api.skillLibrary().then(setList, (e: Error) => setError(e.message));
  };
  useEffect(() => void reload(), []);

  return (
    <section className="section">
      <h3>{t('office.libTitle')}</h3>
      <p className="muted small">{t('office.libIntro')}</p>
      {list?.length === 0 && <p className="muted small">{t('office.libEmpty')}</p>}
      <ul className="plain skill-lib">
        {list?.map((s) => (
          <li key={s.name}>
            <button type="button" className="link" onClick={() => setEditing(s.name)}>
              myco:{s.name}
            </button>
            {origins.has(s.name) && <GithubBadges status={origins.get(s.name)!} />}
            <span className="muted small"> {s.description}</span>
          </li>
        ))}
      </ul>
      <p className="actions">
        <button type="button" className="btn-secondary" onClick={() => setEditing('new')}>
          {t('office.libNew')}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setInstalling(true)}>
          {t('gh.install')}
        </button>
      </p>
      {error && <p className="error small">{error}</p>}
      {installing && <GithubInstall target={LIBRARY} onClose={() => setInstalling(false)} onInstalled={() => void reload()} />}
      {editing && (
        <SkillForm
          name={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
          onChanged={() => void reload()}
        />
      )}
    </section>
  );
}

/** Criar ou editar o SKILL.md de uma skill da biblioteca. */
function SkillForm({ name, onClose, onSaved, onChanged }: { name: string | null; onClose: () => void; onSaved: () => void; onChanged: () => void }) {
  const [loaded, setLoaded] = useState(!name);
  const [draft, setDraft] = useState({ name: name ?? '', description: '', body: '' });
  const [files, setFiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Atualizar ou voltar pelo GitHub troca o SKILL.md no disco: o formulário relê, para não salvar por cima com o texto velho.
  const [rev, setRev] = useState(0);

  useEffect(() => {
    if (!name) return;
    api.librarySkill(name).then(
      (s) => {
        setDraft({ name: s.name, description: s.description, body: s.body });
        setFiles(s.files);
        setLoaded(true);
      },
      (e: Error) => setError(e.message),
    );
  }, [name, rev]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.saveLibrarySkill({ ...(name && { originalName: name }), ...draft });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  // No body: o vidro do painel lateral (backdrop-filter) prenderia o modal dentro dele.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal hire" onSubmit={submit}>
        <button type="button" className="drawer-close" onClick={onClose} aria-label={t('office.cancel')}>
          ×
        </button>
        <p className="kicker">{t('office.libKicker')}</p>
        <h2>{name ? `myco:${name}` : t('office.libNewTitle')}</h2>
        <p className="muted small">{t('office.libFormIntro')}</p>
        {!loaded && !error && <p className="muted">…</p>}
        {loaded && (
          <>
            <label>
              {t('office.libName')}
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value.toLowerCase() })}
                maxLength={64}
                required
                pattern="[a-z0-9][a-z0-9-]*"
                placeholder="revisar-acessibilidade"
              />
            </label>
            <label>
              {t('office.libDescription')}
              <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={3} maxLength={1024} required placeholder={t('office.libDescriptionPlaceholder')} />
            </label>
            <label>
              {t('office.libBody')}
              <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={14} className="mono" />
            </label>
            {files.length > 0 && <p className="muted small">{t('office.libFiles', { files: files.join(', ') })}</p>}
            {name && (
              <GithubOrigin
                target={LIBRARY}
                name={name}
                onChanged={() => {
                  setRev((r) => r + 1);
                  onChanged();
                }}
              />
            )}
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="submit" className="btn-primary" disabled={busy || !loaded}>
            {busy ? t('office.connSaving') : t('office.libSave')}
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t('office.cancel')}
          </button>
          {name && (
            <button
              type="button"
              className="link small"
              onClick={async () => {
                if (!(await askConfirm(t('office.libRemoveConfirm', { name })))) return;
                await api.removeLibrarySkill(name).catch((e: Error) => setError(e.message));
                onSaved();
              }}
            >
              {t('office.libRemove')}
            </button>
          )}
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** No painel de uma skill da conta (que todas as sessões veem): copiar para a biblioteca. */
export function CopyToLibrary({ name }: { name: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="section">
      <h3>{t('office.libTitle')}</h3>
      <p className="muted small">{t('office.libCopyIntro')}</p>
      {state === 'done' ? (
        <p className="small ok">{t('office.libCopied', { name })}</p>
      ) : (
        <button
          type="button"
          className="btn-secondary"
          disabled={state === 'busy'}
          onClick={async () => {
            setState('busy');
            setError(null);
            try {
              await api.importSkill(name);
              setState('done');
            } catch (e) {
              setError((e as Error).message);
              setState('idle');
            }
          }}
        >
          {t('office.libCopy')}
        </button>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
