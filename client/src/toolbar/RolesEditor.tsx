import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Autonomy, Effort, Playbook } from '../../../shared/model';
import { BUILTIN_ROLES, NICHES, type Niche, type RoleEntry } from '../../../shared/roles';
import { api } from '../api';
import { effortLabel } from '../format';
import { t } from '../i18n';
import { AUTONOMY_OPTIONS, EFFORT_OPTIONS, MODEL_OPTIONS, modelLabel, PLAYBOOK_OPTIONS } from '../staff/templates';
import { PlaybookRoster } from '../staff/PlaybookRoster';
import { rosterRows } from '../staff/agentRoles';
import { askConfirm, DIALOG_ATTR } from '../lib/dialogStore';

// Cargos da empresa (config → Cargos): os prontos e os seus. Cada cargo traz o modelo com que o
// funcionário começa; trocar o modelo de um funcionário só é na ficha dele. O cargo padrão já vem
// preenchido ao contratar.

interface Draft {
  id?: string;
  label: string;
  role: string;
  mission: string;
  autonomy: Autonomy;
  rules: string;
  doneWhen: string;
  model: string;
  effort: '' | Effort;
  canHire: boolean;
  niches: Niche[];
  /** O roteiro com que o funcionário contratado começa ('' = nenhum): o cargo que implementa já vem com o Planeja grande, executa pequeno. */
  playbook: '' | Playbook;
  /** Campos dos prontos que o editor não mostra (worktree, skills…): voltam como estavam. */
  rest: Partial<RoleEntry>;
}

export const blank: Draft = { label: '', role: '', mission: '', autonomy: 'acceptEdits', rules: '', doneWhen: '', model: 'sonnet', effort: 'medium', canHire: false, niches: [], playbook: '', rest: {} };

function toDraft(r: RoleEntry): Draft {
  const { id, label, role, mission, autonomy, rules, doneWhen, model, effort, canHire, playbook, niches, builtin: _b, edited: _e, isDefault: _d, ...rest } = r;
  return { id, label, role, mission, autonomy, rules: rules.join('\n'), doneWhen, model, effort: effort ?? '', canHire: !!canHire, niches: niches ?? [], playbook: playbook ?? '', rest };
}

type Filter = 'all' | 'mine' | Niche;

/** A 1ª frase da missão: é o que o cargo mostra no card. */
export const firstSentence = (s: string) => s.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? s;

export function RolesEditor() {
  const [roles, setRoles] = useState<RoleEntry[] | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.roles().then(setRoles, (e: Error) => setError(e.message));
  }, []);

  const run = async (fn: () => Promise<RoleEntry[]>) => {
    setBusy(true);
    setError(null);
    try {
      setRoles(await fn());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editing) return;
    const ok = await run(() =>
      api.saveRole({
        ...editing.rest,
        ...(editing.id && { id: editing.id }),
        label: editing.label.trim(),
        role: editing.role.trim(),
        mission: editing.mission.trim(),
        autonomy: editing.autonomy,
        rules: editing.rules.split('\n').map((l) => l.trim()).filter(Boolean),
        doneWhen: editing.doneWhen.trim(),
        model: editing.model,
        effort: editing.effort || null,
        canHire: editing.canHire,
        niches: editing.niches,
        playbook: editing.playbook || null,
      }),
    );
    if (ok) setEditing(null);
  };

  // Esc: fecha o editor e, sem ele, a tela. Na captura, para não fechar a Config por trás; um diálogo de
  // confirmação aberto (ele cuida do próprio Esc) fica de fora.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector(`[${DIALOG_ATTR}]:not(.roles-screen)`)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (editing) setEditing(null);
      else setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, editing]);

  if (!roles) return <span className="muted small">{error ?? t('toolbar.loading')}</span>;
  const hiddenBuiltins = BUILTIN_ROLES.length - roles.filter((r) => r.builtin).length;
  const current = roles.find((r) => r.isDefault);

  const form = editing && <RoleForm editing={editing} setEditing={setEditing} busy={busy} onSave={() => void save()} onCancel={() => setEditing(null)} />;

  return (
    <div className="roles">
      <p className="roles-current">
        <span className="muted small">{t('roles.defaultRole')}</span> <b>{current ? current.label : t('toolbar.noDefaultShort')}</b>
      </p>
      <p className="roles-footer">
        <button type="button" className="btn-secondary" aria-haspopup="dialog" onClick={() => setOpen(true)}>
          {t('roles.view', { n: roles.length })}
        </button>
      </p>
      {error && !open && <p className="error small">{error}</p>}
      {open && (
        <RolesScreen
          roles={roles}
          onClose={() => setOpen(false)}
          manage={{
            busy,
            error,
            current: !!current,
            hiddenBuiltins,
            onNew: () => setEditing({ ...blank }),
            onEdit: (r) => setEditing(toDraft(r)),
            onDefault: (id) => void run(() => api.setDefaultRole(id)),
            onDelete: (r) => void run(() => api.deleteRole(r.id)),
            onRestore: () => void run(() => api.restoreRoles()),
          }}
        >
          {editing && (
            <div className="roles-edit-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && setEditing(null)}>
              <div className="roles-edit">{form}</div>
            </div>
          )}
        </RolesScreen>
      )}
    </div>
  );
}

interface ManageProps {
  busy: boolean;
  error: string | null;
  current: boolean;
  hiddenBuiltins: number;
  onNew: () => void;
  onEdit: (r: RoleEntry) => void;
  onDefault: (id: string | null) => void;
  onDelete: (r: RoleEntry) => void;
  onRestore: () => void;
}

/**
 * A tela cheia "Ver cargos": os cards com filtro de nicho. Com `manage` é a da Config (editar, apagar, padrão,
 * novo cargo); com `onPick` é a de escolher ao contratar: tocar no card escolhe, sem nenhuma ação de edição,
 * e Esc/Voltar fecha sem trocar.
 */
export function RolesScreen({ roles, onClose, manage, onPick, selectedId, children }: { roles: RoleEntry[]; onClose: () => void; manage?: ManageProps; onPick?: (r: RoleEntry) => void; selectedId?: string | null; children?: ReactNode }) {
  const [filter, setFilter] = useState<Filter>('all');
  const visible = roles.filter((r) => (filter === 'all' ? true : filter === 'mine' ? !r.builtin : (r.niches ?? []).includes(filter)));
  const busy = manage?.busy ?? false;

  // Esc no modo de escolher: fecha só a tela (na captura, para não fechar o formulário por trás).
  useEffect(() => {
    if (!onPick) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector(`[${DIALOG_ATTR}]:not(.roles-screen)`)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onPick, onClose]);

  return createPortal(
    <div className="roles-screen" role="dialog" aria-modal="true" aria-label={t(onPick ? 'roles.pickTitle' : 'toolbar.rolesTitle')} {...{ [DIALOG_ATTR]: '' }}>
      <header className="roles-screen-head">
        <button type="button" className="link" onClick={onClose}>
          ← {t('roles.back')}
        </button>
        <h2>{t(onPick ? 'roles.pickTitle' : 'toolbar.rolesTitle')}</h2>
        {manage && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={manage.onNew}>
            {t('toolbar.newRole')}
          </button>
        )}
      </header>
      <div className="roles-filters" role="group" aria-label={t('roles.filters')}>
        {(['all', ...NICHES, 'mine'] as Filter[]).map((f) => (
          <button key={f} type="button" className={`chip roles-filter${filter === f ? ' is-on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === 'all' ? t('roles.filterAll') : f === 'mine' ? t('roles.filterMine') : t(`roles.niche.${f}`)}
          </button>
        ))}
      </div>
      <div className="roles-screen-body">
        {visible.length === 0 ? (
          <p className="muted">{t('roles.empty')}</p>
        ) : (
          <ul className="roles-cards">
            {visible.map((r) => (
              <li key={r.id} className={`roles-card${selectedId === r.id ? ' is-on' : ''}`}>
                <button type="button" className="roles-card-open" aria-pressed={onPick ? selectedId === r.id : undefined} onClick={() => (onPick ? onPick(r) : manage?.onEdit(r))}>
                  <b>{r.label}</b>
                  <span className="muted small">{firstSentence(r.mission)}</span>
                  <span className="muted small">
                    {modelLabel(r.model)}
                    {r.effort ? ` · ${t('toolbar.effortWith', { effort: effortLabel(r.effort) })}` : ''}
                    {r.builtin ? ` · ${r.edited ? t('toolbar.builtInEdited') : t('toolbar.builtIn')}` : ` · ${t('toolbar.yours')}`}
                    {r.isDefault ? ` · ${t('toolbar.defaultLabel')}` : ''}
                  </span>
                </button>
                {manage && (
                  <span className="roles-actions">
                    <label className="check small" title={t('toolbar.defaultTitle')}>
                      <input type="radio" name="default-role" checked={r.isDefault} disabled={busy} onChange={() => manage.onDefault(r.id)} /> {t('toolbar.defaultLabel')}
                    </label>
                    <button
                      type="button"
                      className="link small"
                      disabled={busy}
                      onClick={async () => {
                        const what = r.builtin
                          ? r.edited
                            ? t('toolbar.restoreConfirm', { label: r.label })
                            : t('toolbar.removeConfirm', { label: r.label })
                          : t('toolbar.deleteConfirm', { label: r.label });
                        if (await askConfirm(what)) manage.onDelete(r);
                      }}
                    >
                      {r.builtin ? (r.edited ? t('toolbar.restoreOriginal') : t('toolbar.remove')) : t('toolbar.delete')}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {manage && (
          <p className="roles-footer">
            {manage.current && (
              <button type="button" className="link small" disabled={busy} onClick={() => manage.onDefault(null)}>
                {t('toolbar.noDefault')}
              </button>
            )}
            {manage.hiddenBuiltins > 0 && (
              <button type="button" className="link small" disabled={busy} onClick={manage.onRestore}>
                {t('toolbar.restoreBuiltins', { n: manage.hiddenBuiltins })}
              </button>
            )}
          </p>
        )}
        {manage?.error && <p className="error small">{manage.error}</p>}
      </div>
      {children}
    </div>,
    document.body,
  );
}

/** O formulário de um cargo (exportado para o teste renderizar sem a lista). */
export function RoleForm({ editing, setEditing, busy, onSave, onCancel }: { editing: Draft; setEditing: (d: Draft) => void; busy: boolean; onSave: () => void; onCancel: () => void }) {
  return (
    <form
      className="role-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="grid2">
        <label>
          {t('toolbar.fieldLabel')}
          <input value={editing.label} maxLength={60} required autoFocus onChange={(e) => setEditing({ ...editing, label: e.target.value })} />
        </label>
        <label>
          {t('toolbar.fieldRole')}
          <input value={editing.role} maxLength={60} required onChange={(e) => setEditing({ ...editing, role: e.target.value })} />
        </label>
        <label>
          {t('toolbar.fieldModel')}
          <select value={editing.model} onChange={(e) => setEditing({ ...editing, model: e.target.value })}>
            {MODEL_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
            {!MODEL_OPTIONS.some((m) => m.value === editing.model) && <option value={editing.model}>{editing.model}</option>}
          </select>
        </label>
        <label>
          {t('toolbar.effort')}
          <select value={editing.effort} onChange={(e) => setEditing({ ...editing, effort: e.target.value as '' | Effort })}>
            {EFFORT_OPTIONS.map((x) => (
              <option key={x} value={x}>
                {x ? effortLabel(x) : t('toolbar.defaultLabel')}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        {t('toolbar.fieldAutonomy')}
        <select value={editing.autonomy} onChange={(e) => setEditing({ ...editing, autonomy: e.target.value as Autonomy })}>
          {AUTONOMY_OPTIONS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('staff.playbookLabel')}
        <select value={editing.playbook} onChange={(e) => setEditing({ ...editing, playbook: e.target.value as '' | Playbook })}>
          <option value="">{t('staff.playbookNone')}</option>
          {PLAYBOOK_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {editing.playbook && <p className="muted small">{PLAYBOOK_OPTIONS.find((o) => o.value === editing.playbook)?.help}</p>}
      {editing.playbook && <PlaybookRoster rows={rosterRows(editing.playbook, new Map(), false)} forRole />}
      <label>
        {t('toolbar.fieldMission')}
        <textarea rows={3} value={editing.mission} maxLength={4000} required onChange={(e) => setEditing({ ...editing, mission: e.target.value })} />
      </label>
      <label>
        {t('toolbar.fieldRules')}
        <textarea rows={4} value={editing.rules} onChange={(e) => setEditing({ ...editing, rules: e.target.value })} />
      </label>
      <label>
        {t('toolbar.fieldDoneWhen')}
        <input value={editing.doneWhen} maxLength={2000} onChange={(e) => setEditing({ ...editing, doneWhen: e.target.value })} />
      </label>
      <fieldset className="role-niches">
        <legend>{t('roles.fieldNiches')}</legend>
        {NICHES.map((n) => (
          <label key={n} className="check">
            <input
              type="checkbox"
              checked={editing.niches.includes(n)}
              onChange={(e) => setEditing({ ...editing, niches: e.target.checked ? [...editing.niches, n] : editing.niches.filter((x) => x !== n) })}
            />{' '}
            {t(`roles.niche.${n}`)}
          </label>
        ))}
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={editing.canHire} onChange={(e) => setEditing({ ...editing, canHire: e.target.checked })} /> {t('toolbar.canHire')}{' '}
        <span className="muted small">{t('toolbar.canHireNote')}</span>
      </label>
      <p className="muted small">{t('toolbar.formNote')}</p>
      <p className="roles-footer">
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('toolbar.saveRole')}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
          {t('toolbar.cancel')}
        </button>
      </p>
    </form>
  );
}
