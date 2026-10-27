import { useEffect, useState } from 'react';
import { AGENT_PRESETS } from '../../../shared/agentPresets';
import { api, type AgentSource } from '../api';

// Criar ou editar um agent (subagent) do Claude Code. O modelo do agent é o que permite o padrão
// orquestrador → executores: o funcionário roda num modelo grande e delega a execução a agents
// em modelos menores.

export interface AgentFormTarget {
  scope: 'project' | 'user';
  projectId: string | null;
  /** Nome atual, para editar; ausente = criar. */
  name?: string;
}

const MODELS = [
  { value: 'inherit', label: 'O mesmo de quem chama' },
  { value: 'haiku', label: 'Haiku — rápido e barato (executor)' },
  { value: 'sonnet', label: 'Sonnet — equilíbrio' },
  { value: 'opus', label: 'Opus — planejamento e revisão' },
  { value: 'fable', label: 'Fable — o mais capaz' },
];

const TOOL_SETS = [
  { label: 'Só leitura', tools: 'Read, Grep, Glob' },
  { label: 'Leitura e edição', tools: 'Read, Grep, Glob, Edit, Write' },
  { label: 'Leitura, edição e comandos', tools: 'Read, Grep, Glob, Edit, Write, Bash, PowerShell' },
  { label: 'Todas', tools: '' },
];

// Os prontos (executor, pesquisador, revisor) são os mesmos que o MyCo cria sozinho quando um
// roteiro precisa deles e o projeto não tem.
const PRESETS = AGENT_PRESETS;

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
    setTools(p.tools);
    setPrompt(p.prompt);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const list = tools.split(',').map((t) => t.trim()).filter(Boolean);
    try {
      onSaved(
        await api.saveAgent({
          scope: target.scope,
          projectId: target.projectId,
          originalName: target.name,
          name,
          description,
          model: model === 'inherit' ? null : model,
          tools: list.length ? list : null,
          prompt,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const where = target.scope === 'user' ? '~/.claude/agents (todos os projetos)' : '.claude/agents do projeto';

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal hire" onSubmit={submit}>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Fechar">
          ×
        </button>
        <p className="kicker">{editing ? 'editar agent' : 'novo agent'} · {where}</p>
        <h2>{editing ? target.name : 'Novo agent'}</h2>
        <p className="muted small">
          Agents são os subagents que um funcionário chama pela ferramenta Agent. Com um modelo menor que o do funcionário, ele
          planeja num modelo grande e delega a execução aqui.
        </p>
        {linked && <p className="badge warn">Vinculado a outro projeto: salvar muda o arquivo original.</p>}

        {!editing && (
          <div className="templates">
            <span className="muted small">Prontos:</span>
            {PRESETS.map((p, i) => (
              <button type="button" key={p.label} className="btn-secondary" onClick={() => applyPreset(i)}>
                {p.label}
              </button>
            ))}
          </div>
        )}

        {!loaded && !error && <p className="muted">Carregando…</p>}
        {loaded && (
          <>
            <div className="grid2">
              <label>
                Nome*
                <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} maxLength={50} required placeholder="executor" />
              </label>
              <label>
                Modelo
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                  {!MODELS.some((m) => m.value === model) && <option value={model}>{model}</option>}
                </select>
              </label>
            </div>
            <label>
              Quando usar*
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                maxLength={1000}
                required
                placeholder="O Claude decide delegar a este agent lendo esta descrição"
              />
            </label>
            <fieldset>
              <legend>Ferramentas</legend>
              <div className="templates">
                {TOOL_SETS.map((t) => (
                  <button type="button" key={t.label} className="btn-secondary" onClick={() => setTools(t.tools)}>
                    {t.label}
                  </button>
                ))}
              </div>
              <input value={tools} onChange={(e) => setTools(e.target.value)} placeholder="Vazio = todas as de quem chama" />
              {(!tools.trim() || /(^|[\s,])Agent([\s,]|$)/.test(tools)) && (
                <p className="muted small">
                  Com “Todas” (ou Agent na lista), este agent pode chamar outros agents. Para um executor, prefira uma lista sem
                  Agent: quem divide o trabalho é o orquestrador.
                </p>
              )}
            </fieldset>
            <label>
              Instruções*
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={8} required className="mono" />
            </label>
          </>
        )}

        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="submit" className="btn-primary" disabled={busy || !loaded}>
            {busy ? 'Salvando…' : 'Salvar agent'}
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancelar
          </button>
        </div>
        <p className="muted small">Vale para as sessões abertas a partir de agora. Na edição, a versão anterior vai para ~/.myco/backups/agents.</p>
      </form>
    </div>
  );
}
