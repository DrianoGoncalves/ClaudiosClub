import { useState } from 'react';
import { BUILTIN_ROLES } from '../../../shared/roles';
import { TEAM_TEMPLATES, type TeamTemplate } from '../../../shared/teamTemplates';
import { api, ApiError } from '../api';
import { t, type MsgKey } from '../i18n';

// Modelos de equipe (shared/teamTemplates.ts): uma equipe pronta, só as fichas. Aparece no Novo projeto (opcional) e num
// projeto sem nenhum funcionário. Antes de aplicar, mostra quem entra (nome + cargo) e que nada começa sozinho.

const roleName = (roleId: string) => BUILTIN_ROLES.find((r) => r.id === roleId)?.role ?? roleId;

/** Nome e descrição no idioma da tela; a lista do servidor (pt) é o texto de reserva. */
const TEXT: Record<string, { label: MsgKey; desc: MsgKey }> = {
  'site-landing-page': { label: 'tpl.site.label', desc: 'tpl.site.desc' },
  'manutencao-saas': { label: 'tpl.saas.label', desc: 'tpl.saas.desc' },
};
const labelOf = (tpl: TeamTemplate) => (TEXT[tpl.id] ? t(TEXT[tpl.id]!.label) : tpl.label);
const descOf = (tpl: TeamTemplate) => (TEXT[tpl.id] ? t(TEXT[tpl.id]!.desc) : tpl.description);

/** Quem entra no modelo, um por linha: nome + cargo, e o aviso de que nada começa sozinho. */
function TemplatePreview({ template }: { template: TeamTemplate }) {
  return (
    <div className="tpl-preview">
      <p className="muted small">{descOf(template)}</p>
      <p className="small">
        <b>{t('tpl.whoJoins', { n: template.members.length })}</b>
      </p>
      <ul className="tpl-members">
        {template.members.map((m) => (
          <li key={m.key}>
            <b>{m.name}</b> <span className="muted small">{roleName(m.roleId)}</span>
          </li>
        ))}
      </ul>
      <p className="muted small" role="note">
        {t('tpl.nothingStarts')}
      </p>
    </div>
  );
}

/** Escolha do modelo; `value` null = sem equipe (só no Novo projeto, onde é o padrão). */
export function TeamTemplatePicker({ value, onChange, allowNone }: { value: string | null; onChange: (id: string | null) => void; allowNone: boolean }) {
  const chosen = TEAM_TEMPLATES.find((x) => x.id === value) ?? null;
  const options: Array<{ id: string | null; label: string }> = [
    ...(allowNone ? [{ id: null, label: t('tpl.none') }] : []),
    ...TEAM_TEMPLATES.map((x) => ({ id: x.id, label: labelOf(x) })),
  ];
  return (
    <div className="tpl">
      <div className="templates" role="radiogroup" aria-label={t('tpl.title')}>
        {options.map((o) => (
          <button
            key={o.id ?? 'none'}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            className={value === o.id ? 'btn-secondary is-on' : 'btn-secondary'}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {chosen && <TemplatePreview template={chosen} />}
    </div>
  );
}

/** A frase pelo status: o texto do servidor vem em pt e não se traduz. */
const errorText = (err: unknown) => {
  const status = err instanceof ApiError ? err.status : null;
  if (status === 409) return t('tpl.errExists');
  if (status === 404) return t('tpl.errGone');
  return t('tpl.errOther');
};

/** Projeto sem funcionário: chamada para aplicar um modelo. Quem usa só a mostra com a equipe vazia. */
export function TeamTemplateApply({ projectId, onApplied }: { projectId: string; onApplied: (notice?: string) => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await api.applyTeamTemplate(projectId, picked);
      onApplied();
    } catch (err) {
      const text = errorText(err);
      // 409: já tem equipe (outra aba aplicou). A releitura desmonta esta chamada, então o pai guarda e mostra o aviso.
      if (err instanceof ApiError && err.status === 409) onApplied(text);
      else setError(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tpl tpl-empty">
      <h4>{t('tpl.emptyTitle')}</h4>
      <p className="muted small">{t('tpl.emptyHint')}</p>
      <TeamTemplatePicker value={picked} onChange={setPicked} allowNone={false} />
      <p className="actions">
        <button type="button" className="btn-secondary" disabled={!picked || busy} onClick={() => void apply()}>
          {busy ? t('tpl.applying') : t('tpl.apply')}
        </button>
      </p>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
