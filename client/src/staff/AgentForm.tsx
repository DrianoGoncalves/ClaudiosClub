import { useEffect, useState } from 'react';
import { AGENT_PRESETS } from '../../../shared/agentPresets';
import type { Effort } from '../../../shared/model';
import { api, type AgentSource } from '../api';
import { t } from '../i18n';

// Criar ou editar um agent (subagent) do Claude Code. O modelo do agent é o que permite o padrão
// orquestrador → executores: o funcionário roda num modelo grande e delega a execução a agents
// em modelos menores. O esforço diz quanto ele pensa antes de agir (menos tokens em low).

export interface AgentFormTarget {
  scope: 'project' | 'user';
  projectId: string | null;
  /** Nome atual, para editar; ausente = criar. */
  name?: string;
}

const MODELS = [
  { value: 'inherit', label: t('staff.modelSameCaller') },
  { value: 'haiku', label: t('staff.agentModelHaiku') },
  { value: 'sonnet', label: t('staff.agentModelSonnet') },
  { value: 'opus', label: t('staff.agentModelOpus') },
  { value: 'fable', label: t('staff.agentModelFable') },
];

const EFFORTS: Array<{ value: Effort | ''; label: string }> = [
  { value: '', label: t('staff.agentEffortDefault') },
  { value: 'low', label: t('staff.agentEffortLow') },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: t('staff.agentEffortHigh') },
  { value: 'xhigh', label: 'Xhigh' },
  { value: 'max', label: t('staff.agentEffortMax') },
];

const TOOL_SETS = [
  { label: t('staff.toolSetReadOnly'), tools: 'Read, Grep, Glob' },
  { label: t('staff.toolSetReadEdit'), tools: 'Read, Grep, Glob, Edit, Write' },
  { label: t('staff.toolSetReadEditRun'), tools: 'Read, Grep, Glob, Edit, Write, Bash, PowerShell' },
  { label: t('staff.toolSetAll'), tools: '' },
];

// Os prontos (executor, pesquisador, revisor) são os mesmos que o MyCo cria sozinho quando um
// roteiro precisa deles e o projeto não tem.
const PRESETS = AGENT_PRESETS;
// Rótulo traduzido de cada pronto (pelo nome); o do shared/agentPresets.ts serve de reserva.
const PRESET_LABEL: Record<string, string> = {
  executor: t('staff.presetExecutor'),
  pesquisador: t('staff.presetResearcher'),
  revisor: t('staff.presetReviewer'),
};

interface Props {
  target: AgentFormTarget;
  onClose: () => void;
  onSaved: (agent: AgentSource) => void;
}

export function AgentForm({ target, onClose, onSaved }: Props) {
  const editing = !!target.name;
  const [loaded, setLoaded] = useState(!editing);
  const [linked, setLinked] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [model, setModel] = useState('inherit');
  const [effort, setEffort] = useState<Effort | ''>('');
  const [tools, setTools] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target.name) return;
    api.agentSource(target.scope, target.projectId, target.name).then(
      (a) => {
        setName(a.name);
        setDescription(a.description ?? '');
        setModel(a.model ?? 'inherit');
        setEffort(EFFORTS.some((x) => x.value === a.effort) ? (a.effort as Effort) : '');
        setTools((a.tools ?? []).join(', '));
        setPrompt(a.prompt);
        setLinked(a.linked);
        setLoaded(true);
      },
      (e: Error) => setError(e.message),
    );
  }, [target]);

  const applyPreset = (i: number) => {
    const p = PRESETS[i];
    if (!p) return;
    if (!editing) setName(p.name);
    setDescription(p.description);
    setModel(p.model);
    setEffort(p.effort);
    setTools(p.tools);
    setPrompt(p.prompt);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const list = tools.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      onSaved(
        await api.saveAgent({
          scope: target.scope,
          projectId: target.projectId,
          originalName: target.name,
          name,
          description,
          model: model === 'inherit' ? null : model,
          effort: effort || null,
          tools: list.length ? list : null,
          prompt,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const where = target.scope === 'user' ? t('staff.agentWhereUser') : t('staff.agentWhereProject');

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal hire" onSubmit={submit}>
        <button type="button" className="drawer-close" onClick={onClose} aria-label={t('staff.close')}>
          ×
        </button>
        <p className="kicker">{editing ? t('staff.kickerEditAgent') : t('staff.kickerNewAgent')} · {where}</p>
        <h2>{editing ? target.name : t('staff.newAgent')}</h2>
        <p className="muted small">
          {t('staff.agentIntro')}
        </p>
        {linked && <p className="badge warn">{t('staff.linkedWarn')}</p>}

        {!editing && (
          <div className="templates">
            <span className="muted small">{t('staff.presetsLabel')}</span>
            {PRESETS.map((p, i) => (
              <button type="button" key={p.label} className="btn-secondary" onClick={() => applyPreset(i)}>
                {PRESET_LABEL[p.name] ?? p.label}
              </button>
            ))}
          </div>
        )}

        {!loaded && !error && <p className="muted">{t('staff.loading')}</p>}
        {loaded && (
          <>
            <div className="grid2">
              <label>
                {t('staff.nameReq')}
                <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} maxLength={50} required placeholder={t('staff.agentNamePlaceholder')} />
              </label>
              <label>
                {t('staff.modelLabel')}
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                  {!MODELS.some((m) => m.value === model) && <option value={model}>{model}</option>}
                </select>
              </label>
              <label>
                {t('staff.effortLabel')}
                <select value={effort} onChange={(e) => setEffort(e.target.value as Effort | '')}>
                  {EFFORTS.map((x) => (
                    <option key={x.value} value={x.value}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              {t('staff.whenToUse')}
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                maxLength={1000}
                required
                placeholder={t('staff.whenPlaceholder')}
              />
            </label>
            <fieldset>
              <legend>{t('staff.tools')}</legend>
              <div className="templates">
                {TOOL_SETS.map((set) => (
                  <button type="button" key={set.label} className="btn-secondary" onClick={() => setTools(set.tools)}>
                    {set.label}
                  </button>
                ))}
              </div>
              <input value={tools} onChange={(e) => setTools(e.target.value)} placeholder={t('staff.toolsPlaceholder')} />
              {(!tools.trim() || /(^|[\s,])Agent([\s,]|$)/.test(tools)) && (
                <p className="muted small">
                  {t('staff.toolsWarn')}
                </p>
              )}
            </fieldset>
            <label>
              {t('staff.instructions')}
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={8} required className="mono" />
            </label>
          </>
        )}

        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="submit" className="btn-primary" disabled={busy || !loaded}>
            {busy ? t('staff.saving') : t('staff.saveAgent')}
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t('staff.cancel')}
          </button>
        </div>
        <p className="muted small">{t('staff.agentNote')}</p>
      </form>
    </div>
  );
}
