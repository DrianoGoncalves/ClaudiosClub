import type {
  AccountUsage,
  AppConfig,
  AuthStatus,
  Autonomy,
  Board,
  BoardBackground,
  BrowserStatus,
  ChatAttachment,
  ChatSnapshot,
  CostReport,
  Effort,
  GitState,
  InboxItem,
  LaunchResult,
  LiveSession,
  McpServerInfo,
  OrchestrationReport,
  Project,
  ProjectColor,
  ProjectDetail,
  Routine,
  RoutineRun,
  RunMark,
  SendPriority,
  UiLevel,
  ServerInfo,
  TurnNotice,
  StaffInput,
  StaffProfile,
  Task,
  TaskCode,
  TaskSummary,
  UsageStop,
  UsageStopHit,
  UserScope,
} from '../../shared/model';
import type { RoleEntry, RoleTemplate } from '../../shared/roles';

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

/** Ações levam o cabeçalho `x-myco`, que o servidor exige em todo POST. */
async function post<T>(url: string, body: unknown = {}): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-myco': '1' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string; hit?: UsageStopHit };
  if (!res.ok) throw new ApiError(data.error ?? `${url}: ${res.status}`, data.code ?? null, data.hit ?? null);
  return data;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly hit: UsageStopHit | null,
  ) {
    super(message);
  }
}

/**
 * Trava de consumo: tenta sem `force`; se o servidor recusar por passar da linha de parada,
 * pergunta e, confirmado, repete com `force`. Recusado, devolve null.
 */
export async function withUsageConfirm<T>(run: (force: boolean) => Promise<T>): Promise<T | null> {
  try {
    return await run(false);
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'usage-stop' || !err.hit) throw err;
    const h = err.hit;
    const reset = h.resetsAt ? ` A janela renova ${new Date(h.resetsAt).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.` : '';
    let why: string;
    if (h.kind === 'project_week') {
      why = `${h.projectName ?? 'Este projeto'} já usou cerca de ${Math.round(h.percentUsed)}% da cota de 7 dias da conta, acima do orçamento dele (${h.limit}%).`;
    } else {
      const origin = h.fromProfile ? 'da ficha deste funcionário' : 'da empresa';
      why = `O consumo ${h.kind === 'five_hour' ? '5h' : '7d'} da conta está em ${Math.round(h.percentUsed)}%, acima da linha de parada ${origin} (${h.limit}%).`;
    }
    const ok = window.confirm(`${why}${reset}\n\nSeguir mesmo assim?`);
    return ok ? run(true) : null;
  }
}

export interface AgentSource {
  name: string;
  description: string | null;
  model: string | null;
  tools: string[] | null;
  prompt: string;
  filePath: string;
  linked: boolean;
}

export const api = {
  agentSource: (scope: 'project' | 'user', projectId: string | null, name: string) =>
    get<AgentSource>(
      `/api/agents/source?scope=${scope}&name=${encodeURIComponent(name)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  saveAgent: (body: {
    scope: 'project' | 'user';
    projectId: string | null;
    originalName?: string;
    name: string;
    description: string;
    model: string | null;
    tools: string[] | null;
    prompt: string;
  }) => post<AgentSource>('/api/agents/save', body),
  board: () => get<Board>('/api/board'),
  projects: () => get<Project[]>('/api/projects'),
  project: (id: string) => get<ProjectDetail>(`/api/projects/${id}`),
  user: () => get<UserScope>('/api/user'),
  live: () => get<LiveSession[]>('/api/live'),
  git: () => get<Record<string, GitState>>('/api/git'),
  roles: () => get<RoleEntry[]>('/api/roles'),
  saveRole: (role: Omit<RoleTemplate, 'id'> & { id?: string }) => post<RoleEntry[]>('/api/roles', role),
  deleteRole: (id: string) => post<RoleEntry[]>(`/api/roles/${id}/delete`),
  setDefaultRole: (id: string | null) => post<RoleEntry[]>('/api/roles/default', { id }),
  restoreRoles: () => post<RoleEntry[]>('/api/roles/restore'),
  serverInfo: () =>
    get<{ daemon: boolean; pid: number; port: number; startedAt: string; working: { busy: number; background: number } }>('/api/server'),
  serverAction: (action: 'stop' | 'restart') => post<{ ok: boolean; daemon: boolean }>(`/api/server/${action}`),
  usage: () => get<AccountUsage>('/api/usage'),
  browser: (fresh = false) => get<BrowserStatus>(fresh ? '/api/browser?fresh=1' : '/api/browser'),
  auth: (fresh = false) => get<AuthStatus>(fresh ? '/api/auth?fresh=1' : '/api/auth'),
  login: () => post<{ ok: boolean; command: string; error: string | null }>('/api/auth/login'),
  config: () => get<AppConfig>('/api/config'),
  saveConfig: (patch: {
    companyName?: string;
    uiLevel?: UiLevel;
    usageStop?: UsageStop;
    sendWhileBusy?: SendPriority;
    /** Só os projetos enviados mudam; null volta à cor padrão. */
    projectColors?: Record<string, ProjectColor | null>;
    /** Só o tema enviado muda; null volta ao fundo padrão. */
    boardBackground?: Partial<BoardBackground>;
    /** Só os projetos enviados mudam; null tira o orçamento. */
    projectBudgets?: Record<string, number | null>;
  }) => post<AppConfig>('/api/config', patch),
  archive: (kind: 'project' | 'session', id: string, archived: boolean) =>
    post<AppConfig>('/api/archive', { kind, id, archived }),
  costs: () => get<CostReport>('/api/costs'),
  orchestration: (sessionId: string) => get<OrchestrationReport>(`/api/sessions/${sessionId}/orchestration`),
  markRun: (sessionId: string, runId: string, mark: RunMark | null) =>
    post<Record<string, RunMark>>(`/api/sessions/${sessionId}/marks`, { runId, mark }),
  mcp: (projectId: string) => get<McpServerInfo[]>(`/api/projects/${projectId}/mcp`),
  servers: (projectId: string) => get<ServerInfo[]>(`/api/projects/${projectId}/servers`),
  hire: (projectId: string, input: StaffInput) =>
    post<{ profile: StaffProfile; launch: LaunchResult | null }>(`/api/projects/${projectId}/staff`, input),
  chat: (projectId: string, sessionId: string) => get<ChatSnapshot>(`/api/projects/${projectId}/chat/${sessionId}`),
  /** Modelo, esforço e autonomia desta conversa, na hora (abre a conversa se preciso). */
  chatSettings: (
    projectId: string,
    body: { sessionId: string | null; staffId: string | null; model?: string; effort?: Effort; autonomy?: Autonomy },
  ) => post<{ sessionId: string }>(`/api/projects/${projectId}/chat/settings`, body),
  /** "@" no chat: arquivos do projeto que batem com `q`. */
  files: (projectId: string, q: string) => get<string[]>(`/api/projects/${projectId}/files?q=${encodeURIComponent(q)}`),
  chatSend: (
    projectId: string,
    body: {
      sessionId: string | null;
      staffId: string | null;
      text: string;
      force?: boolean;
      priority?: SendPriority;
      images?: string[];
      files?: ChatAttachment[];
    },
  ) =>
    /** `held`: guardada até ele terminar outra tarefa (o motivo). */
    post<{ sessionId: string; held?: string }>(`/api/projects/${projectId}/chat/send`, body),
  chatCompact: (projectId: string, sessionId: string, staffId: string | null, force = false) =>
    post<{ ok: boolean }>(`/api/projects/${projectId}/chat/${sessionId}/compact`, { staffId, force }),
  chatAdopt: (sessionId: string) => post<{ ok: boolean }>(`/api/chat/${sessionId}/adopt`),
  chatPermission: (
    sessionId: string,
    requestId: string,
    allow: boolean,
    opts: { message?: string; executeAs?: Autonomy; remember?: 'session' | 'project' } = {},
  ) =>
    post<{ ok: boolean }>(`/api/chat/${sessionId}/permission`, { requestId, allow, ...opts }),
  inbox: () => get<InboxItem[]>('/api/inbox'),
  turns: (since: string) => get<TurnNotice[]>(`/api/turns?since=${encodeURIComponent(since)}`),
  dismissSecret: (id: string) => post<{ ok: boolean }>('/api/secrets/dismiss', { id }),
  dismissRoutineAlert: (id: string) => post<{ ok: boolean }>('/api/routines/alerts/dismiss', { id }),
  routineState: () => get<Record<string, RoutineRun>>('/api/routines/state'),
  taskSummary: () => get<Record<string, TaskSummary>>('/api/tasks/summary'),
  taskCode: (projectId: string, taskId: string) => get<TaskCode>(`/api/projects/${projectId}/tasks/${taskId}/code`),
  taskTest: (projectId: string, taskId: string) => post<Task | null>(`/api/projects/${projectId}/tasks/${taskId}/test`),
  taskMerge: (projectId: string, taskId: string, skipTests = false) => post<Task | null>(`/api/projects/${projectId}/tasks/${taskId}/merge`, { skipTests }),
  taskReview: (projectId: string, taskId: string, staffId: string, force = false) =>
    post<Task | null>(`/api/projects/${projectId}/tasks/${taskId}/review`, { staffId, force }),
  taskDeploy: (projectId: string, taskId: string, staffId: string, force = false) =>
    post<Task | null>(`/api/projects/${projectId}/tasks/${taskId}/deploy`, { staffId, force }),
  tasks: (projectId: string) => get<Task[] | null>(`/api/projects/${projectId}/tasks`),
  createTask: (projectId: string, input: { title: string; description: string; staffId: string | null }) =>
    post<Task | null>(`/api/projects/${projectId}/tasks`, input),
  updateTask: (
    projectId: string,
    taskId: string,
    patch: Partial<Pick<Task, 'title' | 'description' | 'staffId' | 'status' | 'pr' | 'branch'>> & { queued?: false },
  ) =>
    post<Task | null>(`/api/projects/${projectId}/tasks/${taskId}`, patch),
  /** Efetivar um temporário (contratado por outro funcionário). */
  keepStaff: (projectId: string, staffId: string) => post<StaffProfile>(`/api/projects/${projectId}/staff/${staffId}/keep`),
  startTask: (projectId: string, taskId: string, force = false) => post<Task | null>(`/api/projects/${projectId}/tasks/${taskId}/start`, { force }),
  deleteTask: (projectId: string, taskId: string) => post<{ ok: boolean }>(`/api/projects/${projectId}/tasks/${taskId}/delete`),
  saveRoutines: (projectId: string, staffId: string, routines: Routine[]) =>
    post<StaffProfile>(`/api/projects/${projectId}/staff/${staffId}/routines`, { routines }),
  runRoutine: (projectId: string, staffId: string, routineId: string) =>
    post<{ ok: boolean; text: string } | null>(`/api/projects/${projectId}/staff/${staffId}/routines/${routineId}/run`),
  chatInterrupt: (sessionId: string) => post<{ ok: boolean }>(`/api/chat/${sessionId}/interrupt`),
  updateStaff: (projectId: string, staffId: string, input: StaffInput) =>
    post<StaffProfile>(`/api/projects/${projectId}/staff/${staffId}`, input),
  staffVersions: (projectId: string, staffId: string) =>
    get<Array<{ version: string; name: string; role: string; updatedAt: string }>>(`/api/projects/${projectId}/staff/${staffId}/versions`),
  restoreStaff: (projectId: string, staffId: string, version: string) =>
    post<StaffProfile>(`/api/projects/${projectId}/staff/${staffId}/restore`, { version }),
  addManager: (projectId: string, staffId: string, managerId: string) =>
    post<StaffProfile>(`/api/projects/${projectId}/staff/${staffId}/managers`, { managerId }),
  removeManager: (projectId: string, staffId: string, managerId: string) =>
    post<StaffProfile>(`/api/projects/${projectId}/staff/${staffId}/managers/remove`, { managerId }),
  saveProjectImage: (projectId: string, dataUrl: string | null) =>
    post<{ image: string | null }>(`/api/projects/${projectId}/image`, { dataUrl }),
  accountRules: () => get<{ path: string; text: string | null }>('/api/account/rules'),
  saveAccountRules: (text: string) => post<{ path: string; text: string | null }>('/api/account/rules', { text }),
  launch: (projectId: string, staffId: string, resume: boolean, force = false) =>
    post<LaunchResult>(`/api/projects/${projectId}/staff/${staffId}/launch`, { resume, force }),
};
