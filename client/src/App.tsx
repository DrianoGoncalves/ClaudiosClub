import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Agent,
  AppConfig,
  Board,
  BoardBackground,
  CostReport,
  GitState,
  InboxItem,
  ProjectColor,
  SendPriority,
  Session,
  Skill,
  StaffProfile,
  TaskSummary,
  UiLevel,
  UsageStop,
} from '../../shared/model';
import { api, withUsageConfirm } from './api';
import { BoardView } from './board/Board';
import { useBoardBackground } from './board/colors';
import { archiveKey, employeeNodeId, projectNodeId, RANKING_ID, staffNodeId, SYNCED_NODE_ID, USER_NODE_ID } from './board/layout';
import { QuickJump } from './toolbar/QuickJump';
import {
  AgentPanel,
  EmployeePanel,
  ProjectPanel,
  RankingPanel,
  SkillPanel,
  SyncedPanel,
  UserPanel,
  type RankingEntry,
} from './detail/Detail';
import { employeeName } from './format';
import { t } from './i18n';
import { useInbox } from './inbox/useInbox';
import { AgentForm, type AgentFormTarget } from './staff/AgentForm';
import { NewProjectForm } from './office/NewProjectForm';
import { readTab, writeTab } from './office/workspaces';
import { ProjectOffice } from './office/ProjectOffice';
import { StaffForm, type StaffFormMode } from './staff/HireForm';
import { TasksBoard } from './tasks/TasksBoard';

const WORKTREES_KEY = 'myco.showWorktrees';
const ARCHIVED_KEY = 'myco.showArchived';
const ANIMATIONS_KEY = 'myco.animations';

/** Escolha salva; sem escolha, segue o "reduzir animações" do sistema. */
function readAnimations(): boolean {
  try {
    const saved = localStorage.getItem(ANIMATIONS_KEY);
    if (saved !== null) return saved === '1';
  } catch {
    // sem armazenamento: segue o sistema
  }
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type Selection =
  | { kind: 'ranking' }
  | { kind: 'user' }
  | { kind: 'synced'; skills: Skill[] }
  | { kind: 'project'; id: string }
  | { kind: 'employee'; session: Session | null; staff: StaffProfile | null; projectId: string }
  | { kind: 'agent'; agent: Agent; projectId: string | null }
  | { kind: 'skill'; skill: Skill };

export function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [costs, setCosts] = useState<CostReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showWorktrees, setShowWorktrees] = useState(() => readFlag(WORKTREES_KEY));
  const [showArchived, setShowArchived] = useState(() => readFlag(ARCHIVED_KEY));
  const [animations, setAnimations] = useState(readAnimations);
  const [form, setForm] = useState<{ projectId: string; mode: StaffFormMode } | null>(null);
  const [agentForm, setAgentForm] = useState<AgentFormTarget | null>(null);
  /** "+ projeto" das abas: a empresa da aba de onde veio. */
  const [newProject, setNewProject] = useState<{ workspaceId: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Quadro de tarefas aberto (id do projeto). */
  const [tasksFor, setTasksFor] = useState<string | null>(null);
  /** Tarefa escolhida no Ctrl+K: o quadro de tarefas abre com ela selecionada. */
  const [jumpTask, setJumpTask] = useState<string | null>(null);
  /** Conversa achada na busca do Ctrl+K: o painel do funcionário abre nela. */
  const [jumpConversation, setJumpConversation] = useState<string | null>(null);
  /** Tarefas em aberto por projeto, para o cabeçalho das salas. */
  const [taskSummary, setTaskSummary] = useState<Record<string, TaskSummary>>({});
  const readTaskSummary = useCallback(() => {
    api.taskSummary().then((next) => setTaskSummary((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next)), () => {});
  }, []);
  useEffect(() => {
    readTaskSummary();
    const t = setInterval(readTaskSummary, 15_000);
    return () => clearInterval(t);
  }, [readTaskSummary]);

  const load = useCallback(() => {
    setRefreshing(true);
    api
      .board()
      .then(
        (b) => {
          setBoard(b);
          setError(null);
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => {
    load();
    api.config().then(setConfig, () => {});
  }, [load]);

  // Uma conversa nova grava o transcript logo depois da primeira resposta.
  const reloadSoon = useCallback(() => {
    setTimeout(load, 2000);
  }, [load]);

  // Clicar num item da caixa (ou na notificação) abre o painel de quem espera.
  const openInbox = useCallback((item: InboxItem) => {
    // Sem funcionário nem conversa (aviso do projeto, como chave no .mcp.json): a sala do projeto.
    setSelectedId(item.staffId ? staffNodeId(item.projectId, item.staffId) : item.sessionId ? employeeNodeId(item.sessionId) : projectNodeId(item.projectId));
  }, []);
  const inbox = useInbox(openInbox);

  // O título da aba traz quantas coisas esperam você: dá para ver sem trazer o Claudio’s Club para a frente.
  useEffect(() => {
    const name = config?.companyName ?? 'Claudio’s Club';
    document.title = inbox.items.length ? `(${inbox.items.length}) ${name}` : name;
  }, [config?.companyName, inbox.items.length]);

  // Estado ao vivo por polling (SSE na Fase 3). Só troca o board se algo mudou, para não redesenhar à toa.
  useEffect(() => {
    const t = setInterval(() => {
      api.live().then(
        (live) =>
          setBoard((b) => (b && JSON.stringify(b.live) !== JSON.stringify(live) ? { ...b, live } : b)),
        () => {},
      );
    }, 3000);
    return () => clearInterval(t);
  }, []);

  // Estado do código (branch, sem commit, remoto) no cabeçalho de cada sala; muda devagar.
  const [git, setGit] = useState<Record<string, GitState>>({});
  useEffect(() => {
    const read = () =>
      api.git().then((next) => setGit((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next)), () => {});
    void read();
    const t = setInterval(read, 30_000);
    return () => clearInterval(t);
  }, []);

  // Custos: a 1ª leitura dos transcripts demora; enquanto isso, consulta mais vezes.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const next = await api.costs().catch(() => null);
      if (next) setCosts((prev) => (prev && sameCosts(prev, next) ? prev : next));
      timer = setTimeout(tick, next?.scanning ? 3000 : 30_000);
    };
    void tick();
    return () => clearTimeout(timer);
  }, []);

  const toggle = (key: string, set: (v: boolean) => void) => (value: boolean) => {
    set(value);
    writeFlag(key, value);
  };

  const rename = async (companyName: string) => setConfig(await api.saveConfig({ companyName }));
  const saveUsageStop = async (usageStop: UsageStop) => setConfig(await api.saveConfig({ usageStop }));
  const saveSendWhileBusy = async (sendWhileBusy: SendPriority) => setConfig(await api.saveConfig({ sendWhileBusy }));
  const saveUiLevel = async (uiLevel: UiLevel) => setConfig(await api.saveConfig({ uiLevel }));
  const simple = config?.uiLevel === 'simple';
  const saveProjectColor = async (projectId: string, color: ProjectColor | null) =>
    setConfig(await api.saveConfig({ projectColors: { [projectId]: color } }));
  const saveBoardBackground = async (boardBackground: Partial<BoardBackground>) => setConfig(await api.saveConfig({ boardBackground }));
  const saveProjectBudget = async (projectId: string, budget: number | null) =>
    setConfig(await api.saveConfig({ projectBudgets: { [projectId]: budget } }));
  // Aba de workspace (filtra o quadro) e o fundo dela: cada workspace pode ter o seu, para dar para
  // saber de relance em qual se está; sem escolha, vale o fundo geral.
  const [workspaceTab, setWorkspaceTabState] = useState(readTab);
  const setWorkspaceTab = (tab: string) => {
    setWorkspaceTabState(tab);
    writeTab(tab);
  };
  const tabBackground = config?.workspaces.find((w) => w.id === workspaceTab)?.background;
  useBoardBackground({
    light: tabBackground?.light ?? config?.boardBackground.light ?? null,
    dark: tabBackground?.dark ?? config?.boardBackground.dark ?? null,
  });

  /** Projeto novo (ou o demo): recarrega o quadro e o config (o workspace dele) e abre a sala. */
  const projectCreated = (projectId: string) => {
    load();
    void api.config().then(setConfig, () => {});
    setSelectedId(projectNodeId(projectId));
  };

  const archive = async (kind: 'project' | 'session', id: string, archived: boolean) => {
    setConfig(await api.archive(kind, id, archived));
    if (archived && !showArchived) setSelectedId(null);
  };

  const selection = useMemo(() => (board ? resolveSelection(board, selectedId) : null), [board, selectedId]);
  const isArchived = (kind: 'project' | 'session', id: string) =>
    (kind === 'project' ? config?.archived.projects : config?.archived.sessions)?.includes(id) ?? false;

  return (
    <div className={`app ${animations ? 'anim-on' : 'anim-off'}`}>
      {!board && <div className="center">{error ? <p className="error">{error}</p> : <p className="muted">{t('app.loadingBoard')}</p>}</div>}
      {board && (
        <ReactFlowProvider>
          <BoardView
            board={board}
            config={config}
            costs={costs}
            git={git}
            tasks={taskSummary}
            onOpenTasks={setTasksFor}
            showWorktrees={showWorktrees}
            onToggleWorktrees={toggle(WORKTREES_KEY, setShowWorktrees)}
            showArchived={showArchived}
            onToggleArchived={toggle(ARCHIVED_KEY, setShowArchived)}
            animations={animations}
            onToggleAnimations={toggle(ANIMATIONS_KEY, setAnimations)}
            selectedId={selectedId}
            onSelect={setSelectedId}
            inbox={inbox}
            onOpenInbox={openInbox}
            onRefresh={load}
            refreshing={refreshing}
            onRename={rename}
            onUsageStop={saveUsageStop}
            onSendWhileBusy={saveSendWhileBusy}
            onUiLevel={saveUiLevel}
            onProjectColor={saveProjectColor}
            onBoardBackground={saveBoardBackground}
            onProjectBudget={saveProjectBudget}
            onConfig={setConfig}
            tab={workspaceTab}
            onTab={setWorkspaceTab}
            onNewProject={(workspaceId) => setNewProject({ workspaceId })}
            onProjectCreated={projectCreated}
            images={board.images}
            onHireFrom={(projectId, managerId) =>
              setForm({ projectId, mode: { kind: 'hire', reportsTo: managerId ? [managerId] : [] } })
            }
            onLink={(projectId, staffId, managerId) => {
              const who = board.staff.find((s) => s.projectId === projectId && s.id === staffId);
              const boss = board.staff.find((s) => s.projectId === projectId && s.id === managerId);
              api.addManager(projectId, staffId, managerId).then(
                () => {
                  setNotice(
                    t('app.linkDone', {
                      boss: boss?.name ?? t('app.fallbackManager'),
                      who: who?.name ?? t('app.fallbackEmployee'),
                    }),
                  );
                  load();
                },
                (e: Error) => setNotice(t('app.linkFailed', { error: e.message })),
              );
            }}
            onUnlink={({ projectId, staffId, managerId }) => {
              const who = board.staff.find((s) => s.projectId === projectId && s.id === staffId);
              const boss = board.staff.find((s) => s.projectId === projectId && s.id === managerId);
              api.removeManager(projectId, staffId, managerId).then(
                () => {
                  setNotice(
                    t('app.unlinkDone', {
                      boss: boss?.name ?? t('app.fallbackManager'),
                      who: who?.name ?? t('app.fallbackEmployee'),
                    }),
                  );
                  load();
                },
                (e: Error) => setNotice(t('app.unlinkFailed', { error: e.message })),
              );
            }}
          />
        </ReactFlowProvider>
      )}
      {board && selection && (
        <aside className={`drawer ${selection.kind === 'employee' ? 'drawer-wide drawer-chat' : ''}`}>
          <button className="drawer-close" onClick={() => setSelectedId(null)} aria-label={t('app.close')}>
            ×
          </button>
          {selection.kind === 'ranking' && (
            <RankingPanel
              employees={rankEmployees(board, costs, config)}
              agents={Object.entries(costs?.agents ?? {})
                .map(([type, c]) => ({ type, usd: c.usd, runs: c.runs }))
                .sort((a, b) => b.usd - a.usd)}
              scanning={costs?.scanning ?? true}
              onSelect={setSelectedId}
            />
          )}
          {selection.kind === 'user' && (
            <UserPanel
              scope={board.user}
              onNewAgent={() => setAgentForm({ scope: 'user', projectId: null })}
              onEditAgent={(name) => setAgentForm({ scope: 'user', projectId: null, name })}
            />
          )}
          {selection.kind === 'synced' && <SyncedPanel skills={selection.skills} />}
          {selection.kind === 'project' && (
            <ProjectPanel
              onTasks={() => setTasksFor(selection.id)}
              tasks={taskSummary[selection.id] ?? null}
              office={<ProjectOffice projectId={selection.id} config={config} onConfig={setConfig} />}
              onNewAgent={() => setAgentForm({ scope: 'project', projectId: selection.id })}
              onEditAgent={(name) => setAgentForm({ scope: 'project', projectId: selection.id, name })}
              id={selection.id}
              live={board.live}
              cost={costs?.projects[selection.id] ?? null}
              archived={isArchived('project', selection.id)}
              onArchive={(v) => archive('project', selection.id, v)}
              onHire={() => setForm({ projectId: selection.id, mode: { kind: 'hire', reportsTo: [] } })}
              image={board.images[selection.id] ?? null}
              color={config?.projectColors[selection.id] ?? null}
              onColor={(color) => saveProjectColor(selection.id, color)}
              totalUsd={costs?.total.usd ?? 0}
              onImage={async (dataUrl) => {
                await api.saveProjectImage(selection.id, dataUrl);
                load();
              }}
            />
          )}
          {selection.kind === 'employee' && (
            <EmployeePanel
              key={`${selectedId}:${jumpConversation ?? ''}`}
              initialConversation={jumpConversation}
              session={
                selection.session && {
                  ...selection.session,
                  live: board.live.find((l) => l.sessionId === selection.session!.id) ?? selection.session.live,
                }
              }
              staff={selection.staff}
              managers={board.staff.filter((s) => s.projectId === selection.projectId && selection.staff?.reportsTo.includes(s.id))}
              project={board.projects.find((p) => p.id === selection.projectId) ?? null}
              costUsd={employeeCost(costs, selection)}
              totalUsd={costs?.total.usd ?? 0}
              archived={isArchived('session', archiveKey(selection))}
              onArchive={(v) => archive('session', archiveKey(selection), v)}
              onLaunch={async (resume) => {
                const r = await withUsageConfirm((force) => api.launch(selection.projectId, selection.staff!.id, resume, force));
                if (!r) return { ok: false, sessionId: null, command: '', error: t('app.notOpenedUsage') };
                // A sessão nova entra no quadro assim que o Claude Code gravar o transcript.
                setTimeout(load, 4000);
                return r;
              }}
              onHireSub={() => setForm({ projectId: selection.projectId, mode: { kind: 'hire', reportsTo: selection.staff ? [selection.staff.id] : [] } })}
              onEdit={() => {
                if (selection.staff) setForm({ projectId: selection.projectId, mode: { kind: 'edit', profile: selection.staff } });
                else if (selection.session) setForm({ projectId: selection.projectId, mode: { kind: 'adopt', session: selection.session } });
              }}
              onSessionStarted={reloadSoon}
              simple={simple}
              onShowAdvanced={() => void saveUiLevel('advanced')}
              conversations={selection.staff ? staffConversations(board, selection.staff) : []}
              onChanged={() => {
                load();
                // Efetivar desarquiva no servidor: os arquivados do config mudam também.
                void api.config().then(setConfig, () => {});
              }}
            />
          )}
          {selection.kind === 'agent' && (
            <AgentPanel
              onEdit={() =>
                setAgentForm({
                  scope: selection.agent.scope === 'user' ? 'user' : 'project',
                  projectId: selection.projectId,
                  name: selection.agent.name,
                })
              }
              agent={selection.agent}
              cost={costs?.agents[selection.agent.name] ?? null}
              agentsUsd={Object.values(costs?.agents ?? {}).reduce((s, a) => s + a.usd, 0)}
            />
          )}
          {selection.kind === 'skill' && <SkillPanel skill={selection.skill} />}
        </aside>
      )}
      {newProject && (
        <NewProjectForm
          workspaces={config?.workspaces ?? []}
          workspaceId={newProject.workspaceId}
          onClose={() => setNewProject(null)}
          onCreated={(projectId) => {
            setNewProject(null);
            projectCreated(projectId);
          }}
        />
      )}
      {agentForm && (
        <AgentForm
          target={agentForm}
          onClose={() => setAgentForm(null)}
          onSaved={(a) => {
            setAgentForm(null);
            const how = [a.model && t('app.modelValue', { value: a.model }), a.effort && t('app.effortValue', { value: a.effort })]
              .filter(Boolean)
              .join(', ');
            setNotice(t('app.agentSaved', { name: a.name, how: how ? ` (${how})` : '' }));
            load();
          }}
        />
      )}
      {board && (
        <QuickJump
          board={board}
          taskProjects={Object.keys(taskSummary)}
          onJump={(t) => {
            if (t.kind === 'task') {
              setJumpTask(t.taskId);
              setTasksFor(t.projectId);
              return;
            }
            setTasksFor(null);
            setJumpConversation(t.kind === 'staff' ? (t.sessionId ?? null) : null);
            setSelectedId(t.kind === 'staff' ? staffNodeId(t.projectId, t.staffId) : projectNodeId(t.projectId));
          }}
        />
      )}
      {board && tasksFor && (
        <TasksBoard
          key={`${tasksFor}:${jumpTask ?? ''}`}
          initialTaskId={jumpTask}
          projectId={tasksFor}
          projectName={board.projects.find((p) => p.id === tasksFor)?.name ?? tasksFor}
          staff={board.staff.filter((s) => s.projectId === tasksFor)}
          costs={costs}
          lastDeploy={taskSummary[tasksFor]?.lastDeploy ?? null}
          onClose={() => {
            setTasksFor(null);
            setJumpTask(null);
          }}
          onOpenStaff={(staffId) => {
            setTasksFor(null);
            setSelectedId(staffNodeId(tasksFor, staffId));
            reloadSoon();
          }}
          onChanged={() => {
            readTaskSummary();
            reloadSoon();
          }}
        />
      )}
      {board && form && (
        <StaffForm
          key={form.mode.kind === 'edit' ? form.mode.profile.updatedAt : 'novo'}
          board={board}
          projectId={form.projectId}
          mode={form.mode}
          simple={simple}
          onClose={() => setForm(null)}
          onHired={(profile, launch) => {
            setForm(null);
            setNotice(
              launch === null
                ? t('app.hiredChat', { name: profile.name })
                : launch.ok
                  ? t('app.hiredLaunched', { name: profile.name })
                  : t('app.hiredNotLaunched', { name: profile.name, error: String(launch.error), command: launch.command }),
            );
            setSelectedId(staffNodeId(profile.projectId, profile.id));
            load();
            setTimeout(load, 5000);
          }}
          onSaved={(profile) => {
            setForm(null);
            setNotice(t('app.profileSaved', { name: profile.name }));
            // Quem ganhou ficha agora muda de nó (sessão solta → funcionário com ficha).
            setSelectedId(staffNodeId(profile.projectId, profile.id));
            load();
          }}
        />
      )}
      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button className="drawer-close" onClick={() => setNotice(null)} aria-label={t('app.closeNotice')}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}

/** Funcionários (com ficha ou não) do mais ao menos gastão, sem os arquivados. */
function rankEmployees(board: Board, costs: CostReport | null, config: AppConfig | null): RankingEntry[] {
  if (!costs) return [];
  const archivedProjects = new Set(config?.archived.projects ?? []);
  const archivedSessions = new Set(config?.archived.sessions ?? []);
  const out: RankingEntry[] = [];
  for (const p of board.projects) {
    if (archivedProjects.has(p.id)) continue;
    const bySession = costs.projects[p.id]?.sessions ?? {};
    const owned = new Set<string>();
    for (const st of board.staff.filter((s) => s.projectId === p.id)) {
      st.sessions.forEach((s) => owned.add(s.id));
      if (archivedSessions.has(`staff:${st.id}`)) continue;
      const usd = st.sessions.reduce((sum, s) => sum + (bySession[s.id] ?? 0), 0);
      if (usd > 0) out.push({ nodeId: staffNodeId(p.id, st.id), name: st.name, detail: `${st.role} · ${p.name}`, usd });
    }
    for (const s of board.sessions[p.id] ?? []) {
      const usd = bySession[s.id];
      if (owned.has(s.id) || archivedSessions.has(s.id) || !usd) continue;
      out.push({ nodeId: employeeNodeId(s.id), name: employeeName(s), detail: p.name, usd });
    }
  }
  return out.sort((a, b) => b.usd - a.usd);
}

/**
 * Conversas de um funcionário, da mais recente à mais antiga. As da worktree dele ficam noutra
 * pasta do Claude Code; as que ainda não gravaram nada entram pela data de início.
 */
function staffConversations(board: Board, staff: StaffProfile) {
  const known = new Map(Object.values(board.sessions).flat().map((s) => [s.id, s]));
  return staff.sessions
    .map((x) => {
      const s = known.get(x.id);
      return { id: x.id, title: s?.title ?? null, updatedAt: s?.updatedAt ?? x.startedAt };
    })
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

function employeeCost(costs: CostReport | null, sel: { session: Session | null; staff: StaffProfile | null; projectId: string }) {
  const bySession = costs?.projects[sel.projectId]?.sessions;
  if (!bySession) return null;
  const ids = sel.staff ? sel.staff.sessions.map((s) => s.id) : sel.session ? [sel.session.id] : [];
  const found = ids.map((id) => bySession[id]).filter((v): v is number => v !== undefined);
  return found.length ? found.reduce((a, b) => a + b, 0) : null;
}

function resolveSelection(board: Board, id: string | null): Selection | null {
  if (!id) return null;
  if (id === RANKING_ID) return { kind: 'ranking' };
  if (id === USER_NODE_ID) return { kind: 'user' };
  if (id === SYNCED_NODE_ID) return { kind: 'synced', skills: board.user.skills.filter((s) => s.scope === 'synced') };
  if (id.startsWith('p:')) return { kind: 'project', id: id.slice(2) };
  if (id.startsWith('e:')) {
    const sessionId = id.slice(2);
    for (const [projectId, list] of Object.entries(board.sessions)) {
      const session = list.find((s) => s.id === sessionId);
      if (session) return { kind: 'employee', session, staff: null, projectId };
    }
    return null;
  }
  if (id.startsWith('h:')) {
    const [, projectId, staffId] = id.split(':');
    const staff = board.staff.find((s) => s.projectId === projectId && s.id === staffId);
    if (!staff || !projectId) return null;
    const mine = new Set(staff.sessions.map((s) => s.id));
    const session = (board.sessions[projectId] ?? []).find((s) => mine.has(s.id)) ?? null;
    return { kind: 'employee', session, staff, projectId };
  }

  const inventories = [board.user, ...Object.values(board.inventories)];
  if (id.startsWith('a:')) {
    const agentId = id.slice(2);
    const userAgent = board.user.agents.find((a) => a.id === agentId);
    if (userAgent) return { kind: 'agent', agent: userAgent, projectId: null };
    for (const [projectId, inv] of Object.entries(board.inventories)) {
      const agent = inv.agents.find((a) => a.id === agentId);
      if (agent) return { kind: 'agent', agent, projectId };
    }
    return null;
  }
  if (id.startsWith('s:')) {
    const skill = inventories.flatMap((i) => i.skills).find((s) => s.id === id.slice(2));
    return skill ? { kind: 'skill', skill } : null;
  }
  return null;
}

/** Compara sem `generatedAt`, que muda a cada consulta. */
function sameCosts(a: CostReport, b: CostReport): boolean {
  return JSON.stringify({ ...a, generatedAt: '' }) === JSON.stringify({ ...b, generatedAt: '' });
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // sem armazenamento: vale só nesta aba
  }
}
