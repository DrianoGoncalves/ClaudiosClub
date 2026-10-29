import { useEffect, useRef, useState } from 'react';
import type { Autonomy, Effort } from '../../../shared/model';
import type { RoleEntry } from '../../../shared/roles';
import { api } from '../api';
import { effortLabel } from '../format';
import { t } from '../i18n';
import { modelLabel } from '../staff/HireForm';
import { AUTONOMY_OPTIONS, EFFORT_OPTIONS, MODEL_OPTIONS } from '../staff/templates';

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
  /** Campos dos prontos que o editor não mostra (roteiro, worktree, skills…): voltam como estavam. */
  rest: Partial<RoleEntry>;
}

const blank: Draft = { label: '', role: '', mission: '', autonomy: 'acceptEdits', rules: '', doneWhen: '', model: 'sonnet', effort: 'medium', canHire: false, rest: {} };

function toDraft(r: RoleEntry): Draft {
  const { id, label, role, mission, autonomy, rules, doneWhen, model, effort, canHire, builtin: _b, edited: _e, isDefault: _d, ...rest } = r;
  return { id, label, role, mission, autonomy, rules: rules.join('\n'), doneWhen, model, effort: effort ?? '', canHire: !!canHire, rest };
}

export function RolesEditor() {
  const [roles, setRoles] = useState<RoleEntry[] | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
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
      }),
    );
    if (ok) setEditing(null);
  };

  // A edição abre no próprio item (ou no fim, para um cargo novo): traz o item para a vista ao abrir.
  const openKey = editing ? (editing.id ?? '') : null;
  const openItem = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (openKey !== null) openItem.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [openKey]);

  if (!roles) return <span className="muted small">{error ?? t('toolbar.loading')}</span>;
  const hiddenBuiltins = 7 - roles.filter((r) => r.builtin).length;

  const form = editing && (
    <form
      className="role-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
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
      <label className="check">
        <input type="checkbox" checked={editing.canHire} onChange={(e) => setEditing({ ...editing, canHire: e.target.checked })} /> {t('toolbar.canHire')}{' '}
        <span className="muted small">{t('toolbar.canHireNote')}</span>
      </label>
      <p className="muted small">{t('toolbar.formNote')}</p>
      <p className="roles-footer">
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('toolbar.saveRole')}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditing(null)}>
          {t('toolbar.cancel')}
        </button>
      </p>
    </form>
  );

  return (
    <div className="roles">
      <ul className="roles-list">
        {roles.map((r) => {
          const open = editing?.id === r.id;
          return (
          <li key={r.id} ref={open ? openItem : undefined} className={open ? 'is-open' : undefined}>
            <div className="roles-row">
            <div className="roles-main">
              <b>{r.label}</b>
              <span className="muted small">
                {r.role} · {modelLabel(r.model)}
                {r.effort ? ` · ${t('toolbar.effortWith', { effort: effortLabel(r.effort) })}` : ''}
                {r.builtin ? ` · ${r.edited ? t('toolbar.builtInEdited') : t('toolbar.builtIn')}` : ` · ${t('toolbar.yours')}`}
              </span>
            </div>
            <span className="roles-actions">
              <label className="check small" title={t('toolbar.defaultTitle')}>
                <input type="radio" name="default-role" checked={r.isDefault} disabled={busy} onChange={() => void run(() => api.setDefaultRole(r.id))} /> {t('toolbar.defaultLabel')}
              </label>
              <button type="button" className="link small" disabled={busy} aria-expanded={open} onClick={() => setEditing(open ? null : toDraft(r))}>
                {t('toolbar.edit')}
              </button>
              <button
                type="button"
                className="link small"
                disabled={busy}
                onClick={() => {
                  const what = r.builtin
                    ? r.edited
                      ? t('toolbar.restoreConfirm', { label: r.label })
                      : t('toolbar.removeConfirm', { label: r.label })
                    : t('toolbar.deleteConfirm', { label: r.label });
                  if (window.confirm(what)) void run(() => api.deleteRole(r.id));
                }}
              >
                {r.builtin ? (r.edited ? t('toolbar.restoreOriginal') : t('toolbar.remove')) : t('toolbar.delete')}
              </button>
            </span>
            </div>
            {open && form}
          </li>
          );
        })}
        {editing && !editing.id && (
          <li ref={openItem} className="is-open">
            {form}
          </li>
        )}
      </ul>
      <p className="roles-footer">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditing({ ...blank })}>
          {t('toolbar.newRole')}
        </button>
        {roles.some((r) => r.isDefault) && (
          <button type="button" className="link small" disabled={busy} onClick={() => void run(() => api.setDefaultRole(null))}>
            {t('toolbar.noDefault')}
          </button>
        )}
        {hiddenBuiltins > 0 && (
          <button type="button" className="link small" disabled={busy} onClick={() => void run(() => api.restoreRoles())}>
            {t('toolbar.restoreBuiltins', { n: hiddenBuiltins })}
          </button>
        )}
      </p>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
