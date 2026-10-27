import { useEffect, useState } from 'react';
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

// Executores respondem curto para o planejador (cada linha da resposta volta para o contexto
// do modelo grande) e não delegam: dividir o trabalho é do orquestrador.
const EXECUTOR_RULES = [
  'Você é um executor. Faça exatamente a tarefa recebida, sem ampliar o escopo.',
  '- Leia só o necessário para a tarefa.',
  '- Se algo estiver ambíguo ou fora do combinado, pare e diga o que falta em vez de adivinhar.',
  '- Não chame outros agents nem divida a tarefa: se ela for grande demais, devolva dizendo isso.',
  '- Responda curto: o que mudou, com arquivo:linha, e o que você verificou (comando e resultado). Não cole arquivos inteiros nem diffs longos.',
  '- Se não conseguiu, diga o motivo e onde parou, em uma ou duas linhas.',
].join('\n');

const PRESETS = [
  {
    label: 'Executor (Haiku)',
    name: 'executor',
    description: 'Executa tarefas mecânicas e bem especificadas que o planejador delegar: editar arquivos indicados, aplicar mudanças repetitivas, rodar comandos de verificação.',
    model: 'haiku',
    tools: 'Read, Grep, Glob, Edit, Write, Bash, PowerShell',
    prompt: EXECUTOR_RULES,
  },
  {
    label: 'Pesquisador (Haiku, só leitura)',
    name: 'pesquisador',
    description: 'Procura no código e resume o que encontrou: onde algo está definido, quem usa uma função, como uma parte funciona. Não altera nada.',
    model: 'haiku',
    tools: 'Read, Grep, Glob',
    prompt:
      'Você é um pesquisador de código. Encontre o que foi pedido e responda com caminhos de arquivo:linha e um resumo curto.\n- Não altere arquivos.\n- Não cole arquivos inteiros: no máximo trechos de poucas linhas quando forem essenciais.\n- Não chame outros agents; se a busca for grande demais, diga o que falta cobrir.\n- Diga claramente o que não encontrou.',
  },
  {
    label: 'Revisor (Sonnet)',
    name: 'revisor',
    description: 'Revisa uma mudança feita por um executor antes de ela ser aceita: procura bugs, regressões e desvios do pedido.',
    model: 'sonnet',
    tools: 'Read, Grep, Glob',
    prompt:
      'Você é um revisor. Compare a mudança com o que foi pedido.\n- Aponte cada problema com arquivo:linha e um cenário concreto de falha.\n- Separe bug de estilo.\n- Não corrija nem chame outros agents: devolva os achados para quem pediu.\n- Termine com um veredito: aprovado ou reprovado.\n- Se estiver tudo certo, diga isso em uma linha.',
  },
];

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
