import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Autonomy,
  Board,
  Effort,
  GitState,
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
import { t, locale } from '../i18n';
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
  /** Funcionário criado fora do Claudio’s Club: ganha ficha (nome, retrato, regras) sem perder a sessão. */
  | { kind: 'adopt'; session: Session };

interface Props {
  board: Board;
  projectId: string;
  mode: StaffFormMode;
  /** Nível simples: só cargo, nome, retrato e primeira tarefa; o resto vem do cargo. */
  simple?: boolean;
  onClose: () => void;
  onHired: (profile: StaffProfile, launch: LaunchResult | null) => void;
  onSaved: (profile: StaffProfile) => void;
}

/** Quem edita código (a autonomia deixa): no simples, ganha worktree se já há outro assim no projeto. */
const editsCode = (a: Autonomy) => a === 'acceptEdits' || a === 'auto' || a === 'bypassPermissions';

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

/** A ficha é longa: dividida em abas, cada uma com uma pergunta só. */
type Tab = 'who' | 'work' | 'tools' | 'run' | 'history';
const TABS: Array<{ id: Tab; label: string; intro: string }> = [
  { id: 'who', label: t('staff.tabWho'), intro: t('staff.tabWhoIntro') },
  { id: 'work', label: t('staff.tabWork'), intro: t('staff.tabWorkIntro') },
  { id: 'tools', label: t('staff.tools'), intro: t('staff.tabToolsIntro') },
  { id: 'run', label: t('staff.tabRun'), intro: t('staff.tabRunIntro') },
  { id: 'history', label: t('staff.tabHistory'), intro: t('staff.tabHistoryIntro') },
];

export function StaffForm({ board, projectId, mode, simple = false, onClose, onHired, onSaved }: Props) {
  const editing = mode.kind === 'edit' ? mode.profile : null;
  const adopting = mode.kind === 'adopt' ? mode.session : null;
  // No simples, a ficha inteira fica a um clique ("Mostrar todos os campos").
  const [full, setFull] = useState(!simple || !!adopting);
  const [git, setGit] = useState<Record<string, GitState> | null>(null);
  useEffect(() => {
    if (!full && !editing) api.git().then(setGit, () => setGit({}));
  }, [full, editing]);
  const project = board.projects.find((p) => p.id === projectId);
  const inventory = board.inventories[projectId] ?? { agents: [], skills: [] };
  const agentNames = useMemo(
    () => [...new Set([...inventory.agents, ...board.user.agents].map((a) => a.name))].sort(),
    [inventory, board.user],
  );
  // As da biblioteca do Claudio’s Club só carregam para quem tem na ficha (as do projeto e da conta, todos veem).
  const [library, setLibrary] = useState<string[]>([]);
  useEffect(() => {
    api.skillLibrary().then((l) => setLibrary(l.map((s) => s.name)), () => {});
  }, []);
  const skillNames = useMemo(
    () => [...new Set([...inventory.skills, ...board.user.skills.filter((s) => s.scope !== 'synced')].map((s) => s.name).concat(library))].sort(),
    [inventory, board.user, library],
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
    // No simples sempre há um cargo escolhido: o padrão, o orquestrador ou o primeiro.
    const d = roles.find((r) => r.isDefault) ?? (full ? undefined : (roles.find((r) => r.id === 'orquestrador') ?? roles[0]));
    if (d) applyTemplate(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles]);

  /** Preenche com o cargo: o modelo (e o esforço) vêm dele; troca só deste funcionário na ficha. */
  const applyTemplate = (tpl: RoleEntry) => {
    setRoleId(tpl.id);
    setRole(tpl.role);
    setMission(tpl.mission);
    setAutonomy(tpl.autonomy);
    setRules(tpl.rules.join('\n'));
    setDoneWhen(tpl.doneWhen);
    setModel(tpl.model);
    setEffort(tpl.effort ?? '');
    setPlaybook(tpl.playbook ?? '');
    setCanHire(!!tpl.canHire);
    if (tpl.worktree !== undefined) setWorktree(tpl.worktree);
    if (tpl.skills) setSkills([...new Set([...skills, ...tpl.skills.filter((s) => skillNames.includes(s))])]);
    setShowServers(!!tpl.servers || servers.length > 0);
    if (tpl.pickExecutors) {
      // Agents com modelo menor que o do orquestrador são os executores naturais.
      const executors = [...inventory.agents, ...board.user.agents]
        .filter((a) => a.model && /haiku|sonnet/i.test(a.model))
        .map((a) => a.name);
      setAgents([...new Set(executors)]);
      setTip(
        executors.length
          ? null
          : t('staff.tipNoExecutors', { preset: t('staff.presetExecutor'), newAgent: t('staff.newAgent') }),
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
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setError(t('staff.errPortraitType'));
    if (file.size > MAX_INPUT_BYTES) return setError(t('staff.errPortraitSize'));
    // Reduzido aqui: o quadro mostra com 40 px e o arquivo fica na pasta do projeto.
    shrinkImage(file, PORTRAIT_MAX).then(setPortrait, () => setError(t('staff.errPortraitRead')));
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
        ? t('staff.tipPlaybookMissing', {
            playbook: option.label,
            agents: missing.map((a) => `“${a}”`).join(', '),
            newAgent: t('staff.newAgent'),
          })
        : null,
    );
  };

  // Contratando no simples: o recomendado para sair funcionando, sem perguntar.
  const simpleHire = !full && !editing && !adopting;
  const template = roles?.find((r) => r.id === roleId) ?? null;
  const autoWorktree =
    template?.worktree ??
    (editsCode(autonomy) && !!git?.[projectId] && colleagues.some((c) => editsCode(c.autonomy) && !c.temporary));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Validação própria: o navegador não consegue focar um campo obrigatório numa aba escondida.
    const missing: Tab | null = !name.trim() || !role.trim() ? 'who' : !mission.trim() && full ? 'work' : null;
    if (missing) {
      setTab(missing);
      return setError(missing === 'who' ? (full ? t('staff.errNameRole') : t('staff.errChooseRoleName')) : t('staff.errMission'));
    }
    setBusy(true);
    setError(null);
    const input: StaffInput = {
      name,
      role,
      mission: mission.trim() || `Ajudar no projeto ${project?.name ?? ''} como ${role}.`,
      firstTask,
      reportsTo: managers,
      autonomy,
      agents,
      skills,
      // Todos marcados = não restringir (a sessão também recebe os conectores da conta). No simples,
      // nenhum: a sessão abre mais leve e rápida; quem precisa liga no avançado.
      mcps: simpleHire ? [] : allMcps ? null : [...mcpOn],
      knowledge: lines(knowledge),
      rules: lines(rules),
      doneWhen,
      model: model || null,
      effort: effort || null,
      canHire,
      playbook: playbook || null,
      worktree: simpleHire ? autoWorktree : worktree,
      servers,
      browser,
      ...(portrait !== undefined ? { portraitDataUrl: portrait } : {}),
      // A conversa é sempre pelo painel do Claudio’s Club. No simples, espera você escrever; no avançado,
      // `launch` já manda a saudação e ele começa pela primeira tarefa.
      ...(editing ? {} : adopting ? { adoptSessionId: adopting.id, launch: false } : { launch: simpleHire ? false : launch }),
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
        <button type="button" className="drawer-close" onClick={onClose} aria-label={t('staff.close')}>
          ×
        </button>
        <p className="kicker">
          {editing || adopting ? t('staff.kickerEdit') : t('staff.kickerHire')} · {project?.name}
        </p>
        <h2>{editing ? editing.name : adopting ? t('staff.titleAdopt') : t('staff.titleNew')}</h2>
        {adopting && (
          <p className="muted small">
            {t('staff.adoptNote')}
          </p>
        )}

        {!full ? (
          <div className="form-panel simple-hire">
            {!editing && (
              <fieldset>
                <legend>{t('staff.roleLegend')}</legend>
                {!roles && <p className="muted small">{t('staff.rolesLoading')}</p>}
                <div className="templates">
                  {roles?.map((tpl) => (
                    <button
                      type="button"
                      key={tpl.id}
                      className={`btn-secondary ${roleId === tpl.id ? 'is-on' : ''}`}
                      aria-pressed={roleId === tpl.id}
                      title={tpl.mission}
                      onClick={() => applyTemplate(tpl)}
                    >
                      {tpl.label}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}
            <div className="grid2">
              <label>
                {t('staff.nameReq')}
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoFocus />
              </label>
              <label>
                {t('staff.portrait')}
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => pickPortrait(e.target.files?.[0])} />
                {currentPortrait && (
                  <span className="portrait-row">
                    <img className="portrait-preview" src={currentPortrait} alt={t('staff.portrait')} />
                  </span>
                )}
              </label>
            </div>
            {editing && (
              <label>
                {t('staff.whatHeDoes')}
                <textarea value={mission} onChange={(e) => setMission(e.target.value)} rows={3} maxLength={4000} />
              </label>
            )}
            <label>
              {t('staff.firstTask')} <span className="muted small">{editing ? t('staff.firstTaskOptionalNext') : t('staff.firstTaskOptional')}</span>
              <textarea
                value={firstTask}
                onChange={(e) => setFirstTask(e.target.value)}
                rows={3}
                maxLength={4000}
                placeholder={t('staff.firstTaskPlaceholderSimple')}
              />
            </label>
            {!editing && template && (
              <p className="muted small simple-summary">
                {t('staff.fromRole', {
                  details: [
                    modelLabel(template.model),
                    template.effort ? t('staff.summaryEffort', { effort: template.effort }) : null,
                    AUTONOMY_OPTIONS.find((o) => o.value === template.autonomy)?.label.toLowerCase(),
                    template.playbook ? PLAYBOOK_OPTIONS.find((o) => o.value === template.playbook)?.label.toLowerCase() : null,
                    autoWorktree ? t('staff.summaryOwnWorktree') : t('staff.summaryDirect'),
                    template.canHire ? t('staff.summaryCanHire') : null,
                    t('staff.summaryNoMcp'),
                    t('staff.summaryChat'),
                  ]
                    .filter(Boolean)
                    .join(', '),
                })}
              </p>
            )}
            <p className="small">
              <button type="button" className="link" onClick={() => setFull(true)}>
                {t('staff.showAll')}
              </button>
            </p>
          </div>
        ) : (
          <>
        <div className="tabs" role="tablist">
          {TABS.filter((tb) => tb.id !== 'history' || editing).map((tb) => (
            <button
              key={tb.id}
              type="button"
              role="tab"
              aria-selected={tab === tb.id}
              className={`tab ${tab === tb.id ? 'is-active' : ''}`}
              onClick={() => setTab(tb.id)}
            >
              {tb.label}
              {tb.id === 'history' && versions ? ` (${versions.length})` : ''}
            </button>
          ))}
        </div>
        <p className="muted small tab-intro">{TABS.find((tb) => tb.id === tab)?.intro}</p>

        {/* ---- Quem é ---- */}
        <div className="form-panel" role="tabpanel" hidden={tab !== 'who'}>
        {!editing && roles && roles.length > 0 && (
          <div className="templates">
            <span className="muted small" title={t('staff.cargosTitle')}>
              {t('staff.cargosLabel')}
            </span>
            {roles.map((tpl) => (
              <button
                type="button"
                key={tpl.id}
                className={`btn-secondary ${roleId === tpl.id ? 'is-on' : ''}`}
                aria-pressed={roleId === tpl.id}
                title={`${tpl.role} · ${modelLabel(tpl.model)}${tpl.isDefault ? ` · ${t('staff.defaultTag')}` : ''}`}
                onClick={() => applyTemplate(tpl)}
              >
                {tpl.label}
              </button>
            ))}
          </div>
        )}

        <div className="grid2">
          <label>
            {t('staff.nameReq')}
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoFocus={!editing} />
          </label>
          <label>
            {t('staff.roleReq')}
            <input value={role} onChange={(e) => setRole(e.target.value)} maxLength={60} required />
          </label>
        </div>

        <div className="grid2">
          <label>
            {t('staff.portrait')}
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => pickPortrait(e.target.files?.[0])} />
            {currentPortrait && (
              <span className="portrait-row">
                <img className="portrait-preview" src={currentPortrait} alt={t('staff.portrait')} />
                <button type="button" className="btn-secondary" onClick={() => setPortrait(null)}>
                  {t('staff.removePortrait')}
                </button>
              </span>
            )}
          </label>
          <fieldset>
            <legend>{t('staff.reportsTo')}</legend>
            <p className="muted small">{t('staff.reportsToHint')}</p>
            <div className="checks">
              {colleagues.length === 0 && <span className="muted small">{t('staff.noColleagues')}</span>}
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
          <input type="checkbox" checked={canHire} onChange={(e) => setCanHire(e.target.checked)} /> {t('staff.canHire')}
          <span className="muted small"> {t('staff.canHireHint')}</span>
        </label>
        </div>

        {/* ---- Trabalho ---- */}
        <div className="form-panel" role="tabpanel" hidden={tab !== 'work'}>
        <label>
          {t('staff.missionReq')}
          <textarea value={mission} onChange={(e) => setMission(e.target.value)} rows={3} maxLength={4000} required />
        </label>
        <label>
          {t('staff.firstTask')}
          <textarea value={firstTask} onChange={(e) => setFirstTask(e.target.value)} rows={2} maxLength={4000} placeholder={t('staff.firstTaskPlaceholder')} />
        </label>
        <label>
          {t('staff.doneWhen')}
          <input value={doneWhen} onChange={(e) => setDoneWhen(e.target.value)} maxLength={2000} placeholder={t('staff.doneWhenPlaceholder')} />
        </label>
        <div className="grid2">
          <label>
            {t('staff.rules')}
            <textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={4} placeholder={t('staff.rulesPlaceholder')} />
          </label>
          <label>
            {t('staff.knowledge')}
            <textarea value={knowledge} onChange={(e) => setKnowledge(e.target.value)} rows={4} placeholder={t('staff.knowledgePlaceholder')} />
          </label>
        </div>
        </div>

        {/* ---- Ferramentas ---- */}
        <div className="form-panel" role="tabpanel" hidden={tab !== 'tools'}>
        {agentNames.length === 0 && skillNames.length === 0 && (
          <p className="muted small">{t('staff.noAgentsSkills')}</p>
        )}
        {(agentNames.length > 0 || skillNames.length > 0) && (
          <fieldset>
            <legend>{t('staff.suggested')}</legend>
            <p className="muted small">{t('staff.suggestedHint')}</p>
            <div className="checks">
              {agentNames.map((a) => (
                <label key={`a:${a}`} className="check">
                  <input type="checkbox" checked={agents.includes(a)} onChange={() => toggle(agents, setAgents, a)} /> {a}
                  <span className="muted small"> {t('staff.agentTag')} · {modelOf.get(a) ?? t('staff.callerModel')}</span>
                </label>
              ))}
              {skillNames.map((s) => (
                <label key={`s:${s}`} className="check">
                  <input type="checkbox" checked={skills.includes(s)} onChange={() => toggle(skills, setSkills, s)} /> {s}
                  <span className="muted small"> {library.includes(s) ? t('office.libTag') : t('staff.skillTag')}</span>
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
          {mcps === null && <p className="muted small">{t('staff.loading')}</p>}
          {mcps?.length === 0 && <p className="muted small">{t('staff.mcpNone')}</p>}
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
                    <span className="muted small">
                      {' '}
                      {m.source === 'user' ? t('staff.sourceUser') : m.source === 'local' ? t('staff.sourceLocal') : t('staff.sourceProject')}
                    </span>
                  </label>
                ))}
              </div>
              <p className="muted small">{allMcps ? t('staff.mcpAllOn') : t('staff.mcpSomeOff')}</p>
            </>
          )}
        </fieldset>

        {showServers ? (
          <fieldset>
            <legend>{t('staff.sshLegend')}</legend>
            <p className="muted small">
              {t('office.hireServersNote')}{' '}
              {(() => {
                // Só no "só planeja", "manual" e "edita sozinho" um comando no servidor espera você.
                const label = AUTONOMY_OPTIONS.find((o) => o.value === autonomy)?.label ?? autonomy;
                return autonomy === 'auto' || autonomy === 'bypassPermissions' ? (
                  <b>{t('office.hireNoApproval', { autonomy: label, manual: t('staff.autonomyManualLabel') })}</b>
                ) : (
                  t('office.hireApproval', { autonomy: label })
                );
              })()}
            </p>
            {serverList === null && <p className="muted small">{t('staff.loading')}</p>}
            {serverList?.length === 0 && <p className="muted small">{t('office.hireServersEmpty')}</p>}
            <div className="checks">
              {serverList?.map((s) => (
                <label key={s.name} className="check">
                  <input type="checkbox" checked={servers.includes(s.name)} onChange={() => toggle(servers, setServers, s.name)} /> {s.name}
                  <span className="muted small">
                    {' '}
                    {s.host}
                    {s.remoteRoot ? ` · ${s.remoteRoot}` : ''}
                  </span>
                </label>
              ))}
              {servers
                .filter((n) => serverList && !serverList.some((s) => s.name === n))
                .map((n) => (
                  <label key={n} className="check">
                    <input type="checkbox" checked onChange={() => toggle(servers, setServers, n)} /> {n}
                    <span className="muted small"> {t('office.hireServerGone')}</span>
                  </label>
                ))}
            </div>
          </fieldset>
        ) : (
          <p className="muted small">
            <button type="button" className="link" onClick={() => setShowServers(true)}>
              {t('staff.addSsh')}
            </button>
          </p>
        )}

        <label className="check">
          <input type="checkbox" checked={browser} onChange={(e) => setBrowser(e.target.checked)} /> {t('staff.browserLabel')}
          <span className="muted small">
            {' '}
            {t('staff.browserHintA')}<code>claude --chrome</code>{t('staff.browserHintB')}
          </span>
        </label>
        {browser && <BrowserCheck />}
        </div>

        {/* ---- Como trabalha ---- */}
        <div className="form-panel" role="tabpanel" hidden={tab !== 'run'}>
        {editing && <p className="muted small">{t('staff.editNote')}</p>}
        <fieldset>
          <legend>{t('staff.autonomy')}</legend>
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
            {t('staff.modelLabel')}
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODEL_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('staff.effortLabel')}
            <select value={effort} onChange={(e) => setEffort(e.target.value as '' | Effort)}>
              {EFFORT_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v || t('staff.effortDefault')}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset>
          <legend>{t('staff.orchestration')}</legend>
          <label>
            {t('staff.playbookLabel')}
            <select value={playbook} onChange={(e) => pickPlaybook(e.target.value as '' | Playbook)}>
              <option value="">{t('staff.playbookNone')}</option>
              {PLAYBOOK_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {playbook && <p className="muted small">{PLAYBOOK_OPTIONS.find((o) => o.value === playbook)?.help}</p>}
          <label className="check">
            <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} /> {t('staff.worktreeLabel')}
            <span className="muted small">
              {' '}
              {t('staff.worktreeHintA')}<code>myco/…</code>{t('staff.worktreeHintB')}
            </span>
          </label>
        </fieldset>
        </div>

        {/* ---- Histórico ---- */}
        {editing && (
          <div className="form-panel" role="tabpanel" hidden={tab !== 'history'}>
            {versions === null && <p className="muted small">{t('staff.loading')}</p>}
            {versions?.length === 0 && <p className="muted small">{t('staff.historyEmpty')}</p>}
            <ul className="rows">
              {versions?.map((v) => (
                <li key={v.version} className="row row-inline">
                  <span className="row-title">
                    {v.name} <span className="muted small">{v.role}</span>
                  </span>
                  <span className="row-meta">
                    <span className="muted">{new Date(v.updatedAt).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' })}</span>
                    <button type="button" className="btn-secondary" disabled={busy} onClick={() => void restore(v.version)}>
                      {t('staff.restore')}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
          </>
        )}

        {/* Rodapé fixo: salvar está sempre à vista, em qualquer aba. */}
        <div className="modal-footer">
        {full && !editing && !adopting && (
          <label className="check">
            <input type="checkbox" checked={launch} onChange={(e) => setLaunch(e.target.checked)} /> {t('staff.startChat')}
            <span className="muted small"> {t('staff.startChatHint')}</span>
          </label>
        )}

        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? t('staff.saving') : editing || adopting ? t('staff.saveProfile') : t('staff.hire')}
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t('staff.cancel')}
          </button>
          <span className="muted small modal-footer-note">
            {t('staff.profileIn')} <code>{project ? `${project.name}/.myco/staff/` : '.myco/staff/'}</code>
          </span>
        </div>
        </div>
      </form>
    </div>
  );
}
