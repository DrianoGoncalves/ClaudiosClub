import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Autonomy,
  Board,
  Effort,
  LaunchResult,
  McpServerInfo,
  Playbook,
  ServerInfo,
  Session,
  StaffInput,
  StaffProfile,
} from '../../../shared/model';
import { api, withUsageConfirm } from '../api';
import { employeeName } from '../format';
import { MAX_INPUT_BYTES, PORTRAIT_MAX, shrinkImage } from '../lib/shrinkImage';
import { BrowserCheck } from './BrowserCheck';
import type { RoleEntry } from '../../../shared/roles';
import { AUTONOMY_OPTIONS, EFFORT_OPTIONS, MODEL_OPTIONS, PLAYBOOK_OPTIONS } from './templates';

/** "opus" → "Opus (mais recente)"; '' → "Padrão do Claude Code"; outro id fica como está. */
export const modelLabel = (m: string) => MODEL_OPTIONS.find((o) => o.value === m)?.label ?? m;

// Questionário do funcionário: contratar (vira a ficha em <projeto>/.myco/staff/) ou editar
// (a versão anterior vai para o histórico, de onde dá para restaurar).

export type StaffFormMode =
  | { kind: 'hire'; reportsTo: string[] }
  | { kind: 'edit'; profile: StaffProfile }
  /** Funcionário criado fora do MyCo: ganha ficha (nome, retrato, regras) sem perder a sessão. */
  | { kind: 'adopt'; session: Session };

interface Props {
  board: Board;
  projectId: string;
  mode: StaffFormMode;
  onClose: () => void;
  onHired: (profile: StaffProfile, launch: LaunchResult | null) => void;
  onSaved: (profile: StaffProfile) => void;
}

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

/** A ficha é longa: dividida em abas, cada uma com uma pergunta só. */
type Tab = 'who' | 'work' | 'tools' | 'run' | 'history';
const TABS: Array<{ id: Tab; label: string; intro: string }> = [
  { id: 'who', label: 'Quem é', intro: 'Identidade e a quem este funcionário responde.' },
  { id: 'work', label: 'Trabalho', intro: 'O que ele faz, o que precisa saber e quando terminou.' },
  { id: 'tools', label: 'Ferramentas', intro: 'O que ele pode usar: agents, skills, MCPs, servidores e navegador.' },
  { id: 'run', label: 'Como trabalha', intro: 'Quanto decide sozinho, com que modelo e até onde pode gastar.' },
  { id: 'history', label: 'Histórico', intro: 'Cada edição guarda a versão anterior; restaure se precisar.' },
];

export function StaffForm({ board, projectId, mode, onClose, onHired, onSaved }: Props) {
  const editing = mode.kind === 'edit' ? mode.profile : null;
  const adopting = mode.kind === 'adopt' ? mode.session : null;
  const project = board.projects.find((p) => p.id === projectId);
  const inventory = board.inventories[projectId] ?? { agents: [], skills: [] };
  const agentNames = useMemo(
    () => [...new Set([...inventory.agents, ...board.user.agents].map((a) => a.name))].sort(),
    [inventory, board.user],
  );
  const skillNames = useMemo(
    () => [...new Set([...inventory.skills, ...board.user.skills.filter((s) => s.scope !== 'synced')].map((s) => s.name))].sort(),
    [inventory, board.user],
  );
  const colleagues = board.staff.filter((s) => s.projectId === projectId && s.id !== editing?.id);

  const [name, setName] = useState(editing?.name ?? (adopting ? employeeName(adopting).slice(0, 60) : ''));
  const [role, setRole] = useState(editing?.role ?? '');
  const [mission, setMission] = useState(
    editing?.mission ?? (adopting ? `Dar continuidade ao trabalho desta sessão${adopting.title ? `: ${adopting.title}` : ''}.` : ''),
  );
  const [firstTask, setFirstTask] = useState(editing?.firstTask ?? '');
  const [managers, setManagers] = useState<string[]>(editing?.reportsTo ?? (mode.kind === 'hire' ? mode.reportsTo : []));
  const [autonomy, setAutonomy] = useState<Autonomy>(editing?.autonomy ?? 'manual');
  const [agents, setAgents] = useState<string[]>(editing?.agents ?? []);
  const [skills, setSkills] = useState<string[]>(editing?.skills ?? []);
  const [mcps, setMcps] = useState<McpServerInfo[] | null>(null);
  const [mcpOn, setMcpOn] = useState<Set<string>>(new Set());
  const [knowledge, setKnowledge] = useState((editing?.knowledge ?? []).join('\n'));
  const [rules, setRules] = useState((editing?.rules ?? []).join('\n'));
  const [doneWhen, setDoneWhen] = useState(editing?.doneWhen ?? '');
  const [model, setModel] = useState(editing?.model ?? '');
  const [effort, setEffort] = useState<'' | Effort>(editing?.effort ?? '');
  const [canHire, setCanHire] = useState(editing?.canHire ?? false);
  const [playbook, setPlaybook] = useState<'' | Playbook>(editing?.playbook ?? '');
  const [worktree, setWorktree] = useState(editing?.worktree ?? false);
  // Linha de parada própria: vazio = a da empresa.
  const [stop5h, setStop5h] = useState(editing?.usageStop?.fiveHour?.toString() ?? '');
  const [stop7d, setStop7d] = useState(editing?.usageStop?.sevenDay?.toString() ?? '');
  const [servers, setServers] = useState<string[]>(editing?.servers ?? []);
  const [browser, setBrowser] = useState(editing?.browser ?? false);
  const [serverList, setServerList] = useState<ServerInfo[] | null>(null);
  // O campo só aparece para quem é de infra (cargo pronto) ou já tem servidores.
  const [showServers, setShowServers] = useState((editing?.servers.length ?? 0) > 0);
  // undefined = manter o retrato atual; null = remover; string = trocar.
  const [portrait, setPortrait] = useState<string | null | undefined>(undefined);
  const [launch, setLaunch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<Array<{ version: string; name: string; role: string; updatedAt: string }> | null>(null);
  const [tab, setTab] = useState<Tab>('who');

  useEffect(() => {
    api.mcp(projectId).then(
      (list) => {
        setMcps(list);
        // Ficha sem restrição (null) = todos marcados.
        setMcpOn(new Set(editing?.mcps ?? list.map((m) => m.name)));
      },
      () => setMcps([]),
    );
    if (editing) api.staffVersions(projectId, editing.id).then(setVersions, () => setVersions([]));
    api.servers(projectId).then(setServerList, () => setServerList([]));
  }, [projectId, editing]);

  // Cargos da empresa (config → Cargos). Contratando, o cargo padrão já vem preenchido.
  const [roles, setRoles] = useState<RoleEntry[] | null>(null);
  const [roleId, setRoleId] = useState<string | null>(null);
  useEffect(() => {
    api.roles().then(setRoles, () => setRoles([]));
  }, []);
  const defaultApplied = useRef(false);
  useEffect(() => {
    if (!roles || editing || adopting || defaultApplied.current) return;
    defaultApplied.current = true;
    const d = roles.find((r) => r.isDefault);
    if (d) applyTemplate(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles]);

  /** Preenche com o cargo: o modelo (e o esforço) vêm dele; troca só deste funcionário na ficha. */
  const applyTemplate = (t: RoleEntry) => {
    setRoleId(t.id);
    setRole(t.role);
    setMission(t.mission);
    setAutonomy(t.autonomy);
    setRules(t.rules.join('\n'));
    setDoneWhen(t.doneWhen);
    setModel(t.model);
    setEffort(t.effort ?? '');
    setPlaybook(t.playbook ?? '');
    if (t.worktree !== undefined) setWorktree(t.worktree);
    if (t.skills) setSkills([...new Set([...skills, ...t.skills.filter((s) => skillNames.includes(s))])]);
    setShowServers(!!t.servers || servers.length > 0);
    if (t.pickExecutors) {
      // Agents com modelo menor que o do orquestrador são os executores naturais.
      const executors = [...inventory.agents, ...board.user.agents]
        .filter((a) => a.model && /haiku|sonnet/i.test(a.model))
        .map((a) => a.name);
      setAgents([...new Set(executors)]);
      setTip(
        executors.length
          ? null
          : 'Ainda não há agents em modelos menores para executar. Crie um (ex.: “Executor (Haiku)”) em “Novo agent”, no painel do projeto, e edite esta ficha depois.',
      );
    }
  };
  const [tip, setTip] = useState<string | null>(null);
  const modelOf = useMemo(
    () => new Map([...inventory.agents, ...board.user.agents].map((a) => [a.name, a.model])),
    [inventory, board.user],
  );

  const pickPortrait = (file: File | undefined) => {
    setError(null);
    if (!file) return setPortrait(undefined);
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setError('Retrato: use PNG, JPEG ou WebP.');
    if (file.size > MAX_INPUT_BYTES) return setError('Retrato: máximo de 20 MB.');
    // Reduzido aqui: o quadro mostra com 40 px e o arquivo fica na pasta do projeto.
    shrinkImage(file, PORTRAIT_MAX).then(setPortrait, () => setError('Retrato: não foi possível ler a imagem.'));
  };

  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const allMcps = mcps !== null && mcps.every((m) => mcpOn.has(m.name));

  /** Escolher um roteiro marca os agents que ele usa, se o projeto tiver. */
  const pickPlaybook = (value: '' | Playbook) => {
    setPlaybook(value);
    const option = PLAYBOOK_OPTIONS.find((o) => o.value === value);
    if (!option) return setTip(null);
    const found = option.agents.filter((a) => agentNames.includes(a));
    const missing = option.agents.filter((a) => !agentNames.includes(a));
    setAgents([...new Set([...agents, ...found])]);
    setTip(
      missing.length
        ? `O roteiro “${option.label}” usa ${missing.map((a) => `“${a}”`).join(', ')}, que ainda não existe neste projeto. Crie em “Novo agent”, no painel do projeto (há modelos prontos).`
        : null,
    );
  };

  const stopValue = (s: string) => {
    const n = Number(s);
    return s.trim() && Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : null;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Validação própria: o navegador não consegue focar um campo obrigatório numa aba escondida.
    const missing: Tab | null = !name.trim() || !role.trim() ? 'who' : !mission.trim() ? 'work' : null;
    if (missing) {
      setTab(missing);
      return setError(missing === 'who' ? 'Preencha nome e cargo.' : 'Preencha a missão.');
    }
    setBusy(true);
    setError(null);
    const usageStop = { fiveHour: stopValue(stop5h), sevenDay: stopValue(stop7d) };
    const input: StaffInput = {
      name,
      role,
      mission,
      firstTask,
      reportsTo: managers,
      autonomy,
      agents,
      skills,
      // Todos marcados = não restringir (a sessão também recebe os conectores da conta).
      mcps: allMcps ? null : [...mcpOn],
      knowledge: lines(knowledge),
      rules: lines(rules),
      doneWhen,
      model: model || null,
      effort: effort || null,
      canHire,
      usageStop: usageStop.fiveHour === null && usageStop.sevenDay === null ? null : usageStop,
      playbook: playbook || null,
      worktree,
      servers,
      browser,
      ...(portrait !== undefined ? { portraitDataUrl: portrait } : {}),
      ...(editing ? {} : adopting ? { adoptSessionId: adopting.id, launch: false } : { launch }),
    };
    try {
      if (editing) onSaved(await api.updateStaff(projectId, editing.id, input));
      else if (adopting) onSaved((await api.hire(projectId, input)).profile);
      else {
        // Abrir a sessão ao contratar passa pela trava de consumo.
        const r = await withUsageConfirm((force) => api.hire(projectId, { ...input, force }));
        if (!r) return setBusy(false);
        onHired(r.profile, r.launch);
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const restore = async (version: string) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.restoreStaff(projectId, editing!.id, version));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const currentPortrait = editing?.portrait && portrait === undefined ? `/api/projects/${projectId}/staff/${editing.id}/portrait` : portrait;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal hire" onSubmit={submit} noValidate>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Fechar">
          ×
        </button>
        <p className="kicker">
          {editing ? 'editar funcionário' : adopting ? 'editar funcionário' : 'contratar funcionário'} · {project?.name}
        </p>
        <h2>{editing ? editing.name : adopting ? 'Criar a ficha' : 'Nova ficha'}</h2>
        {adopting && (
          <p className="muted small">
            Este funcionário foi aberto fora do MyCo. Ao salvar, ele ganha nome, retrato e ficha, e a sessão continua a mesma,
            com o histórico.
          </p>
        )}

        <div className="tabs" role="tablist">
          {TABS.filter((t) => t.id !== 'history' || editing).map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`tab ${tab === t.id ? 'is-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === 'history' && versions ? ` (${versions.length})` : ''}
            </button>
          ))}
        </div>
        <p className="muted small tab-intro">{TABS.find((t) => t.id === tab)?.intro}</p>

        {/* ---- Quem é ---- */}
        <div className="form-panel" role="tabpanel" hidden={tab !== 'who'}>
        {!editing && roles && roles.length > 0 && (
          <div className="templates">
            <span className="muted small" title="Edite ou crie cargos em config → Cargos">
              Cargos:
            </span>
            {roles.map((t) => (
              <button
                type="button"
                key={t.id}
                className={`btn-secondary ${roleId === t.id ? 'is-on' : ''}`}
                aria-pressed={roleId === t.id}
                title={`${t.role} · ${modelLabel(t.model)}${t.isDefault ? ' · padrão' : ''}`}
                onClick={() => applyTemplate(t)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        <div className="grid2">
          <label>
            Nome*
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoFocus={!editing} />
          </label>
          <label>
            Cargo*
            <input value={role} onChange={(e) => setRole(e.target.value)} maxLength={60} required />
          </label>
        </div>

        <div className="grid2">
          <label>
            Retrato
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => pickPortrait(e.target.files?.[0])} />
            {currentPortrait && (
              <span className="portrait-row">
                <img className="portrait-preview" src={currentPortrait} alt="Retrato" />
                <button type="button" className="btn-secondary" onClick={() => setPortrait(null)}>
                  Remover retrato
                </button>
              </span>
            )}
          </label>
          <fieldset>
            <legend>Reporta a</legend>
            <p className="muted small">Quem pode chamar este funcionário. Nenhum marcado = só você.</p>
            <div className="checks">
              {colleagues.length === 0 && <span className="muted small">Nenhum outro funcionário com ficha neste projeto.</span>}
              {colleagues.map((m) => (
                <label key={m.id} className="check">
                  <input type="checkbox" checked={managers.includes(m.id)} onChange={() => toggle(managers, setManagers, m.id)} /> {m.name}
                  <span className="muted small"> {m.role}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <label className="check">
          <input type="checkbox" checked={canHire} onChange={(e) => setCanHire(e.target.checked)} /> Pode contratar subfuncionários
          <span className="muted small"> (abre novas sessões pelo MyCo, com no máximo a autonomia dele)</span>
        </label>
        </div>

        {/* ---- Trabalho ---- */}
        <div className="form-panel" role="tabpanel" hidden={tab !== 'work'}>
        <label>
          Missão*
          <textarea value={mission} onChange={(e) => setMission(e.target.value)} rows={3} maxLength={4000} required />
        </label>
        <label>
          Primeira tarefa
          <textarea value={firstTask} onChange={(e) => setFirstTask(e.target.value)} rows={2} maxLength={4000} placeholder="O que fazer assim que a sessão abrir" />
        </label>
        <label>
          Definição de pronto
          <input value={doneWhen} onChange={(e) => setDoneWhen(e.target.value)} maxLength={2000} placeholder="Quando dá para dizer que terminou" />
        </label>
        <div className="grid2">
          <label>
            Regras (uma por linha)
            <textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={4} placeholder="Nunca dar push" />
          </label>
          <label>
            Conhecimento (um caminho por linha)
            <textarea value={knowledge} onChange={(e) => setKnowledge(e.target.value)} rows={4} placeholder={'docs/arquitetura.md\nsrc/components/'} />
          </label>
        </div>
        </div>

        {/* ---- Ferramentas ---- */}
        <div className="form-panel" role="tabpanel" hidden={tab !== 'tools'}>
        {agentNames.length === 0 && skillNames.length === 0 && (
          <p className="muted small">Este projeto ainda não tem agents nem skills.</p>
        )}
        {(agentNames.length > 0 || skillNames.length > 0) && (
          <fieldset>
            <legend>Agents e skills indicados</legend>
            <p className="muted small">Viram orientação na ficha; o Claude Code continua vendo os demais do projeto.</p>
            <div className="checks">
              {agentNames.map((a) => (
                <label key={`a:${a}`} className="check">
                  <input type="checkbox" checked={agents.includes(a)} onChange={() => toggle(agents, setAgents, a)} /> {a}
                  <span className="muted small"> agent · {modelOf.get(a) ?? 'modelo de quem chama'}</span>
                </label>
              ))}
              {skillNames.map((s) => (
                <label key={`s:${s}`} className="check">
                  <input type="checkbox" checked={skills.includes(s)} onChange={() => toggle(skills, setSkills, s)} /> {s}
                  <span className="muted small"> skill</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {tip && (
          <p className="badge warn" role="note">
            {tip}
          </p>
        )}

        <fieldset>
          <legend>MCPs</legend>
          {mcps === null && <p className="muted small">Carregando…</p>}
          {mcps?.length === 0 && <p className="muted small">Nenhum MCP configurado neste projeto (os conectores da conta continuam disponíveis).</p>}
          {mcps && mcps.length > 0 && (
            <>
              <div className="checks">
                {mcps.map((m) => (
                  <label key={m.name} className="check">
                    <input
                      type="checkbox"
                      checked={mcpOn.has(m.name)}
                      onChange={() => {
                        const next = new Set(mcpOn);
                        if (next.has(m.name)) next.delete(m.name);
                        else next.add(m.name);
                        setMcpOn(next);
                      }}
                    />{' '}
                    {m.name}
                    <span className="muted small"> {m.source === 'user' ? 'usuário' : m.source === 'local' ? 'local' : 'projeto'}</span>
                  </label>
                ))}
              </div>
              <p className="muted small">
                {allMcps
                  ? 'Todos ligados: a sessão usa a configuração normal, inclusive os conectores da conta.'
                  : 'Com algum desligado, a sessão usa só os marcados (os conectores da conta ficam de fora).'}
              </p>
            </>
          )}
        </fieldset>

        {showServers ? (
          <fieldset>
            <legend>Servidores (SSH)</legend>
            <p className="muted small">
              Só os apelidos chegam à IA: chaves e senhas ficam no ssh-agent e no <code>~/.ssh/config</code>. A ficha bloqueia a
              leitura de <code>~/.ssh</code>, <code>.env</code> e chaves, e cada comando no servidor passa pela sua aprovação
              (autonomia “Pede tudo”).
            </p>
            {serverList === null && <p className="muted small">Carregando…</p>}
            {serverList?.length === 0 && (
              <p className="muted small">
                Nenhum servidor encontrado. Adicione um <code>Host</code> no <code>~/.ssh/config</code> ou rode <code>/vps init</code> no
                projeto.
              </p>
            )}
            <div className="checks">
              {serverList?.map((s) => (
                <label key={s.name} className="check">
                  <input type="checkbox" checked={servers.includes(s.name)} onChange={() => toggle(servers, setServers, s.name)} /> {s.name}
                  <span className="muted small">
                    {' '}
                    {s.source === 'vps' ? `vps deste projeto${s.remoteRoot ? ` · ${s.remoteRoot}` : ''}` : '~/.ssh/config'}
                  </span>
                </label>
              ))}
              {servers
                .filter((n) => serverList && !serverList.some((s) => s.name === n))
                .map((n) => (
                  <label key={n} className="check">
                    <input type="checkbox" checked onChange={() => toggle(servers, setServers, n)} /> {n}
                    <span className="muted small"> não encontrado nesta máquina</span>
                  </label>
                ))}
            </div>
          </fieldset>
        ) : (
          <p className="muted small">
            <button type="button" className="link" onClick={() => setShowServers(true)}>
              + dar acesso a servidores (SSH)
            </button>
          </p>
        )}

        <label className="check">
          <input type="checkbox" checked={browser} onChange={(e) => setBrowser(e.target.checked)} /> Usar o navegador (Claude in Chrome)
          <span className="muted small">
            {' '}
            (age no seu Chrome real, com os seus logins; envios, compras e formulários pedem seu ok. Precisa da extensão instalada e de
            ter rodado <code>claude --chrome</code> uma vez)
          </span>
        </label>
        {browser && <BrowserCheck />}
        </div>

        {/* ---- Como trabalha ---- */}
        <div className="form-panel" role="tabpanel" hidden={tab !== 'run'}>
        {editing && <p className="muted small">Mudanças aqui (e nos MCPs) valem a partir da próxima sessão.</p>}
        <fieldset>
          <legend>Autonomia</legend>
          <div className="choices">
            {AUTONOMY_OPTIONS.map((o) => (
              <label key={o.value} className="choice" title={o.help}>
                <input type="radio" name="autonomy" checked={autonomy === o.value} onChange={() => setAutonomy(o.value)} />
                <span>
                  <b>{o.label}</b>
                  <span className="muted small">{o.help}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid2">
          <label>
            Modelo
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODEL_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Esforço
            <select value={effort} onChange={(e) => setEffort(e.target.value as '' | Effort)}>
              {EFFORT_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v || 'Padrão'}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset>
          <legend>Orquestração e limites</legend>
          <label>
            Roteiro
            <select value={playbook} onChange={(e) => pickPlaybook(e.target.value as '' | Playbook)}>
              <option value="">Nenhum (trabalha do jeito dele)</option>
              {PLAYBOOK_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {playbook && <p className="muted small">{PLAYBOOK_OPTIONS.find((o) => o.value === playbook)?.help}</p>}
          <label className="check">
            <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} /> Trabalhar numa worktree própria
            <span className="muted small">
              {' '}
              (cópia git separada, no branch <code>myco/…</code>: dois funcionários escrevendo ao mesmo tempo não se atropelam; o
              projeto precisa ser um repositório git)
            </span>
          </label>
          <div className="grid2">
            <label>
              Linha de parada 5h (%)
              <input type="number" min={1} max={100} value={stop5h} onChange={(e) => setStop5h(e.target.value)} placeholder="a da empresa" />
            </label>
            <label>
              Linha de parada 7d (%)
              <input type="number" min={1} max={100} value={stop7d} onChange={(e) => setStop7d(e.target.value)} placeholder="a da empresa" />
            </label>
          </div>
          <p className="muted small">
            Passando dela, o MyCo pergunta antes de mandar trabalho a este funcionário. Vazio = a linha da empresa (em config → Consumo).
          </p>
        </fieldset>
        </div>

        {/* ---- Histórico ---- */}
        {editing && (
          <div className="form-panel" role="tabpanel" hidden={tab !== 'history'}>
            {versions === null && <p className="muted small">Carregando…</p>}
            {versions?.length === 0 && <p className="muted small">Nenhuma edição ainda.</p>}
            <ul className="rows">
              {versions?.map((v) => (
                <li key={v.version} className="row row-inline">
                  <span className="row-title">
                    {v.name} <span className="muted small">{v.role}</span>
                  </span>
                  <span className="row-meta">
                    <span className="muted">{new Date(v.updatedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span>
                    <button type="button" className="btn-secondary" disabled={busy} onClick={() => void restore(v.version)}>
                      Restaurar
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Rodapé fixo: salvar está sempre à vista, em qualquer aba. */}
        <div className="modal-footer">
        {!editing && !adopting && (
          <label className="check">
            <input type="checkbox" checked={launch} onChange={(e) => setLaunch(e.target.checked)} /> Abrir a sessão no terminal ao contratar
            <span className="muted small"> (sem marcar, converse pelo painel do MyCo)</span>
          </label>
        )}

        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Salvando…' : editing || adopting ? 'Salvar ficha' : 'Contratar'}
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <span className="muted small modal-footer-note">
            Ficha em <code>{project ? `${project.name}/.myco/staff/` : '.myco/staff/'}</code>
          </span>
        </div>
        </div>
      </form>
    </div>
  );
}
