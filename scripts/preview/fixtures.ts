// Dados fictícios da prévia de interface (npm run preview:ui). Nada aqui lê disco, ~/.claude, ~/.myco nem o servidor do Club:
// são objetos em memória. Os cargos vêm de shared/roles.ts (os prontos, puros).
import type { Agent, AppConfig, Board, LiveSession, Project, ProjectInventory, Session, Skill, StaffProfile, Task } from '../../shared/model';
import { BUILTIN_ROLES } from '../../shared/roles';
import type { RoleEntry } from '../../shared/roles';

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const link = { kind: 'file', target: null } as const;

const project = (id: string, name: string, sessions: number): Project => ({
  id,
  path: `/exemplo/${name}`,
  name,
  exists: true,
  worktreeOf: null,
  hasClaudeMd: true,
  agentCount: 4,
  skillCount: 1,
  sessionCount: sessions,
  lastActivityAt: ago(5),
});

export const projects: Project[] = [project('-exemplo-loja-demo', 'loja-demo', 3), project('-exemplo-site-demo', 'site-demo', 2)];

const agent = (name: string, description: string, model: string): Agent => ({
  id: name, name, description, tools: null, model, effort: null, scope: 'project', filePath: `/exemplo/.claude/agents/${name}.md`, link, duplicate: false, error: null,
});
const skill: Skill = { id: 'revisao', name: 'revisao', label: 'Revisão', description: 'Checklist de revisão de código (fictícia).', scope: 'project', readOnly: false, dirPath: '/exemplo/.claude/skills/revisao', link, error: null };
const inventory: ProjectInventory = {
  agents: [agent('pesquisador', 'Procura no código e resume.', 'haiku'), agent('executor', 'Executa tarefas bem especificadas.', 'sonnet'), agent('revisor', 'Revisa mudanças.', 'opus')],
  skills: [skill],
};

const live = (id: string, name: string, status: string): LiveSession => ({
  sessionId: id, pid: 1000, cwd: '/exemplo', name, status, alive: true, entrypoint: 'sdk-cli', kind: null, startedAt: ago(30), statusUpdatedAt: ago(1),
});
const session = (id: string, topic: string, liveS: LiveSession | null): Session => ({
  id, title: topic, topic, entrypoint: 'sdk-cli', gitBranch: 'main', version: null, startedAt: ago(120), updatedAt: ago(3), sizeBytes: 20_000, subagentCount: 0, live: liveS,
});

const staffOf = (projectId: string, id: string, name: string, role: string, reportsTo: string[], sessionId: string): StaffProfile =>
  ({
    id, projectId, name, role, portrait: null, reportsTo,
    mission: `Missão fictícia de ${name}.`, firstTask: '', autonomy: 'auto', agents: ['executor'], skills: [], mcps: null,
    knowledge: [], rules: ['Regra de exemplo.'], doneWhen: 'Pronto quando os testes passam.', model: null, effort: null,
    canHire: false, playbook: null, worktree: false, servers: [], browser: false,
    sessions: [{ id: sessionId, startedAt: ago(120) }], createdAt: ago(9000), updatedAt: ago(60),
  }) as unknown as StaffProfile;

const P1 = projects[0]!.id;
const P2 = projects[1]!.id;
export const staff: StaffProfile[] = [
  staffOf(P1, 'denise-0001', 'Denise', 'Orquestrador(a)', [], 's-denise'),
  staffOf(P1, 'ana-0002', 'Ana', 'Desenvolvedor(a) front-end', ['denise-0001'], 's-ana'),
  staffOf(P1, 'bruno-0003', 'Bruno', 'Desenvolvedor(a)', ['denise-0001'], 's-bruno'),
  staffOf(P2, 'caio-0004', 'Caio', 'Web designer', [], 's-caio'),
];

const liveAna = live('s-ana', 'Ana', 'busy');
export const lives: LiveSession[] = [liveAna];
const sessions: Record<string, Session[]> = {
  [P1]: [session('s-denise', 'Planejar a vitrine', null), session('s-ana', 'Tela de checkout', liveAna), session('s-bruno', 'API de pedidos', null)],
  [P2]: [session('s-caio', 'Página inicial', null)],
};

export const board: Board = {
  projects,
  inventories: { [P1]: inventory, [P2]: inventory },
  sessions,
  staff,
  images: {},
  user: { agents: [], skills: [] },
  live: lives,
};

const task = (id: string, projectId: string, title: string, status: Task['status'], staffId: string | null): Task =>
  ({
    id, title, description: `Descrição fictícia: ${title}.`, goal: 'Meta de exemplo.', acceptance: 'Critério de exemplo.', status, staffId,
    sessionId: null, plan: null, branch: null, pr: null, createdAt: ago(600), updatedAt: ago(20), history: [{ at: ago(600), status, by: 'you' }],
    model: null, effort: null, projectId,
  }) as unknown as Task;

export const tasks: Record<string, Task[]> = {
  [P1]: [
    task('t-demo01', P1, 'Tela de checkout no celular', 'doing', 'ana-0002'),
    task('t-demo02', P1, 'API de pedidos', 'todo', 'bruno-0003'),
    task('t-demo03', P1, 'Revisar carrinho', 'review', 'ana-0002'),
    task('t-demo04', P1, 'Planejar a vitrine', 'planning', 'denise-0001'),
    task('t-demo05', P1, 'Ajustar rodapé', 'done', 'ana-0002'),
  ],
  [P2]: [task('t-demo06', P2, 'Página inicial', 'doing', 'caio-0004'), task('t-demo07', P2, 'Fotos do portfólio', 'todo', null)],
};

export const roles: RoleEntry[] = BUILTIN_ROLES.map((r) => ({ ...r, builtin: true, edited: false, isDefault: r.id === 'desenvolvedor' }));

export const config = {
  companyName: 'Clube de Exemplo',
  uiLevel: 'advanced',
  archived: { projects: [], sessions: [], conversations: {} },
  usageStop: { enabled: false, percent: 90 },
  sendWhileBusy: 'queue',
  projectColors: { [P1]: 'blue', [P2]: 'green' },
  projectNames: {},
  boardBackground: { light: null, dark: null },
  projectBudgets: {},
  contextSwitch: 'suggest',
  optimizeQuota: false,
  autoContinue: true,
  autoRetry: true,
  showUserScope: false,
  codexReview: false,
  codexModel: '',
  internetAccess: true,
  codexBrowser: false,
  clubGuard: true,
  freelaArchiveDays: 3,
  freelaAutoArchived: {},
  archiveAfterDays: 7,
  deleteAfterDays: 30,
  retentionDeleteEnabledAt: null,
  workspaces: [],
  projectWorkspaces: {},
  resourceGate: false,
  minFreeRamGb: 0,
  cpuGate: false,
  maxActiveChats: 0,
  maxTurnTools: 0,
  maxTurnMinutes: 0,
  aiTitles: false,
} as unknown as AppConfig;

export const taskSummary = { open: 4, review: 1, progress: { points: 3, max: 7 } };
export const server = { daemon: false, paired: true, pid: 0, port: 0, startedAt: ago(60), working: { busy: 0, background: 0 }, pendingRestart: false };
export const system = { cpu: 12, memTotal: 16e9, memFree: 8e9 };
export const usage = { tapInstalled: true, limits: [{ kind: 'five_hour', percentUsed: 35, resetsAt: ago(-120) }, { kind: 'seven_day', percentUsed: 52, resetsAt: ago(-4000) }], updatedAt: ago(1) };
export const auth = { cliFound: true, loggedIn: true, authMethod: 'claude.ai', subscription: true, error: null, checkedAt: ago(1) };

const cost = { usd: 1.2, today: 0.3, last7d: 1.2, month: 1.2 };
export const costs = {
  generatedAt: ago(1), pricingAsOf: '2026-01-01', scanning: false, total: cost,
  projects: { [P1]: { ...cost, sessions: { 's-ana': 0.8 } }, [P2]: { ...cost, sessions: {} } },
  agents: {}, models: {}, unpricedModels: [],
} as unknown as import('../../shared/model').CostReport;
