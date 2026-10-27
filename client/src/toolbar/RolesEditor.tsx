import { useEffect, useState } from 'react';
import type { Autonomy, Effort } from '../../../shared/model';
import type { RoleEntry } from '../../../shared/roles';
import { api } from '../api';
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

  if (!roles) return <span className="muted small">{error ?? 'Carregando…'}</span>;
  const hiddenBuiltins = 7 - roles.filter((r) => r.builtin).length;

  return (
    <div className="roles">
      <ul className="roles-list">
        {roles.map((r) => (
          <li key={r.id}>
            <div className="roles-main">
              <b>{r.label}</b>
              <span className="muted small">
                {r.role} · {modelLabel(r.model)}
                {r.effort ? ` · esforço ${r.effort}` : ''}
                {r.builtin ? (r.edited ? ' · pronto (editado)' : ' · pronto') : ' · seu'}
              </span>
            </div>
            <span className="roles-actions">
              <label className="check small" title="Já vem preenchido ao contratar">
                <input type="radio" name="default-role" checked={r.isDefault} disabled={busy} onChange={() => void run(() => api.setDefaultRole(r.id))} /> padrão
              </label>
              <button type="button" className="link small" disabled={busy} onClick={() => setEditing(toDraft(r))}>
                editar
              </button>
              <button
                type="button"
                className="link small"
                disabled={busy}
                onClick={() => {
                  const what = r.builtin ? (r.edited ? `Voltar "${r.label}" ao original?` : `Tirar "${r.label}" da lista? (dá para trazer de volta)`) : `Apagar o cargo "${r.label}"?`;
                  if (window.confirm(what)) void run(() => api.deleteRole(r.id));
                }}
              >
                {r.builtin ? (r.edited ? 'voltar ao original' : 'tirar') : 'apagar'}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <p className="roles-footer">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditing({ ...blank })}>
          Novo cargo
        </button>
        {roles.some((r) => r.isDefault) && (
          <button type="button" className="link small" disabled={busy} onClick={() => void run(() => api.setDefaultRole(null))}>
            contratar sem cargo padrão
          </button>
        )}
        {hiddenBuiltins > 0 && (
          <button type="button" className="link small" disabled={busy} onClick={() => void run(() => api.restoreRoles())}>
            trazer de volta os prontos tirados ({hiddenBuiltins})
          </button>
        )}
      </p>

      {editing && (
        <form
          className="role-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid2">
            <label>
              Nome do cargo (botão)
              <input value={editing.label} maxLength={60} required onChange={(e) => setEditing({ ...editing, label: e.target.value })} />
            </label>
            <label>
              Cargo na ficha
              <input value={editing.role} maxLength={60} required onChange={(e) => setEditing({ ...editing, role: e.target.value })} />
            </label>
            <label>
              Modelo
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
              Esforço
              <select value={editing.effort} onChange={(e) => setEditing({ ...editing, effort: e.target.value as '' | Effort })}>
                {EFFORT_OPTIONS.map((x) => (
                  <option key={x} value={x}>
                    {x || 'padrão'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Autonomia
            <select value={editing.autonomy} onChange={(e) => setEditing({ ...editing, autonomy: e.target.value as Autonomy })}>
              {AUTONOMY_OPTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Missão
            <textarea rows={3} value={editing.mission} maxLength={4000} required onChange={(e) => setEditing({ ...editing, mission: e.target.value })} />
          </label>
          <label>
            Regras (uma por linha)
            <textarea rows={4} value={editing.rules} onChange={(e) => setEditing({ ...editing, rules: e.target.value })} />
          </label>
          <label>
            Pronto quando
            <input value={editing.doneWhen} maxLength={2000} onChange={(e) => setEditing({ ...editing, doneWhen: e.target.value })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={editing.canHire} onChange={(e) => setEditing({ ...editing, canHire: e.target.checked })} /> Pode
            contratar subfuncionários <span className="muted small">(entram como temporários)</span>
          </label>
          <p className="muted small">Vale para os próximos contratados com este cargo. Quem já foi contratado continua com a própria ficha.</p>
          <p className="roles-footer">
            <button type="submit" className="btn-primary" disabled={busy}>
              Salvar cargo
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditing(null)}>
              Cancelar
            </button>
          </p>
        </form>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
