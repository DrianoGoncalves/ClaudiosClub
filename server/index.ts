import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { clientChanged, DAILY, TSX, VITE } from '../scripts/lib';
import { openTerminal } from './terminal';
import { CodexAdapter, CodexError } from './adapters/codex';
import { CodexEnv, withAppAddress, type CodexEnvStatus } from './codexEnv';
import { CodexModels } from './codexModels';
import { ClaudeAdapter } from './adapters/claude';
import { defaultLocations } from './adapters/claude/paths';
import type { ToolAdapter } from './adapters/types';
import { getAuthStatus, openLoginTerminal } from './auth';
import { serveStartFiles } from './startPage';
import {
  addExtraProject,
  ArchiveRequest,
  ConfigPatch,
  MYCO_HOME,
  readConfig,
  readExtraProjects,
  removeWorkspace,
  saveWorkspace,
  setArchived,
  setProjectWorkspace,
  updateConfig,
  WorkspaceError,
} from './config';
import { openProject, parseNewProject, ProjectError, usualParent } from './newProject';
import { createDemo, DEMO_DIR } from './demo';
import { z } from 'zod';
import { AgentError, AgentInput, readAgentSource, saveAgent } from './adapters/claude/agentWrite';
import { ChatError, ChatManager, findTranscript } from './chat/manager';
import { AnnotationsField, AnswersField } from './chat/questions';
import { touchedFiles } from './chatChanges';
import { uncommittedByConversation } from './uncommitted';
import { searchConversations } from './chatSearch';
import { searchFiles } from './fileSearch';
import { CodeError, detectTest, locateCode, mergeCode, readCode, runTests } from './taskCode';
import { ChatRegistry } from './chat/registry';
import { AutoContinue } from './chat/autoContinue';
import { WakeBody, WakeStreakError, watchWakeups } from './chat/wake';
import { StaffBusyError, StaffError, StaffOpenTasksError, StaffService } from './staff/service';
import { sweepFreelas } from './freelaSweep';
import { CLUB_MCP_FILE, McpError, mcpJsonWarnings } from './staff/mcp';
import { createMcpLibrary } from './staff/mcpLibrary';
import { permissionInboxItem, questionInboxItem } from './inboxItems';
import { InboxState } from './inboxState';
import { readServerLog } from './staff/serverLog';
import { copyToLibrary, listLibrary, readLibrarySkill, removeLibrarySkill, saveLibrarySkill, SkillError } from './skillLibrary';
import { FileError, projectImageUrl, readAccountRules, readProjectImage, saveAccountRules, saveProjectImage } from './files';
import { createGuide, GuideExistsError, guideStatus } from './projectGuide';
import { checkProjectHealth } from './health/scan';
import { GuideActionError, runGuideAction } from './guideActions';
import { deleteAttachment, listAttachments, MAX_ATTACHMENT_BYTES, readAttachment, saveAttachment } from './projectAttachments';
import {
  createProjectEntry,
  deleteProjectEntry,
  listProjectTree,
  parseCreateBody,
  parseDeleteBody,
  parseWriteBody,
  ProjectFileError,
  readProjectFile,
  readProjectImageFile,
  writeProjectFile,
} from './projectFiles';
import { actingStaff, requesterSessionOf, SANDBOX_HOST, SessionTokens, type Caller } from './callers';
import { staffOrigin, type OriginDeps } from './chat/origin';
import { gate } from './gate';
import { CodexUsageReader, codexLimitHit, readInstalled } from './codexUsage';
import { CodexSetup, CodexSetupError } from './codexSetup';
import { readUsage } from './usage';
import { claudeLimitHit, UsageStopError } from './usageStop';
import { quotaBoost } from './quotaBoost';
import { browserStatus } from './browser';
import { gitState } from './git';
import { buildOrchestration, buildSavings, MarkBody, readAllMarks, readMarks, saveMark, savingsSince, withRunInfo } from './orchestration';
import { buildCostReview, COST_REVIEW_MAX_DAYS, parseCostReviewDays } from './costReview';
import { CostReviewApplyError, runCostReviewApply } from './costReviewApply';
import type { Board, CostReport, InboxItem, InboxKind, LiveSession, Project, TurnNotice } from '../shared/model';
import { TurnWatcher } from './turns';
import { RoutineScheduler, type RoutineOutcome } from './routines';
import type { AppServerInfo, EngineOverride, Routine, StaffProfile, SystemStats } from '../shared/model';
import { systemStats } from './systemStats';
import { pathKey, worktreeParent } from './adapters/claude/paths';
import { codexSession } from './adapters/codex/rollout';
import { boardFilter } from './board';
import { mycoWorktreeParents, sessionPlaces } from './sessionPlaces';
import { importableList, importProjects } from './importProjects';
import { AUTONOMY, listProjectStaff, readProfile } from './staff/store';
import { readPersonMemory, savePersonMemory } from './staff/personalMemory';
import { TaskError, TaskService } from './tasks';
import { listRoles, removeRole, restoreBuiltins, RoleError, saveRole, setDefaultRole } from './roles';
import { ROOT } from './root';
import { cleanRunDir } from './runCleanup';
import { SelfUpdater, UpdateError } from './selfUpdate';
import { pendingRestartCheck } from './pendingRestart';
import { Pairing } from './pairing';

const PORT = Number(process.env.MYCO_PORT ?? 4848);
/** Rodando pelo vigia (scripts/daemon.ts): ele religa o servidor quando este sai. */
const UNDER_DAEMON = process.env.MYCO_DAEMON === '1';
const STARTED_AT = new Date().toISOString();
/** Código no disco mais novo que o no ar (marco: o pacote carregado agora, ou a subida pelo tsx). */
const pendingRestart = pendingRestartCheck({ entry: import.meta.filename, startedAt: Date.parse(STARTED_AT) });
/** Novidades do próprio Claudio’s Club no remoto (GitHub). */
const updater = new SelfUpdater();

/** Tempo máximo do build do cliente antes de um reinício. Estourou, o servidor sai mesmo assim. */
const BUILD_TIMEOUT_MS = 120_000;

/**
 * Gera o cliente (vite build, sem checagem de tipos) com este servidor ainda no ar. Assíncrono: o event loop
 * segue atendendo enquanto o build roda. Devolve se deu certo.
 */
function buildClient(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VITE, 'build'], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, BUILD_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** Reinício com o vigia: se o cliente mudou, gera o build antes de sair (o vigia então não precisa fazê-lo). */
async function buildBeforeRestart(): Promise<void> {
  try {
    if (!clientChanged()) return;
    console.log('[servidor] o cliente mudou: gerando antes de reiniciar');
    if (!(await buildClient())) console.error('[servidor] o build do cliente falhou ou passou de 2 min: reinicio com a versão anterior');
  } catch (err) {
    console.error('[servidor] não consegui gerar o cliente antes de reiniciar:', err);
  }
}

let leaving = false;

/**
 * Fecha as conversas (sem deixar processos órfãos) e sai. `stop`: o vigia não religa. Sem `stop`, grava o pedido de
 * reinício: só com ele o vigia refaz o pacote e sobe o código novo (saída sem pedido é queda: sobe a mesma versão).
 */
async function shutdown(stop: boolean, userAgent = '') {
  // Parar grava o arquivo mesmo durante um reinício em curso: o vigia, ao ver o arquivo, não religa.
  if (stop && UNDER_DAEMON) await fs.writeFile(path.join(MYCO_HOME, 'run', 'daemon.stop'), '').catch(() => {});
  if (leaving) return;
  leaving = true;
  console.log(`[servidor] ${stop ? 'parando' : 'reiniciando'} a pedido do config${userAgent ? ` (${userAgent})` : ''}`);
  if (!stop && UNDER_DAEMON) {
    await fs.writeFile(path.join(MYCO_HOME, 'run', 'daemon.restart'), '').catch(() => {});
    await buildBeforeRestart();
  }
  await Promise.race([chats.stopAll(), new Promise((r) => setTimeout(r, 5000))]);
  process.exit(0);
}
// Parado por sinal (npm run daily:stop, o vigia religando, tsx watch): as conversas são líderes do próprio
// grupo de processos e não morreriam junto; ficariam órfãs, presas no meio do turno.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.once(signal, () => {
    console.log(`[servidor] ${signal}: fechando as conversas`);
    void Promise.race([chats.stopAll(), new Promise((r) => setTimeout(r, 5000))]).then(() => process.exit(0));
  });
}
// Só local: o Claudio’s Club lê transcripts e configurações do usuário.
const HOST = '127.0.0.1';
/**
 * Também escuta em 127.0.0.2 (mesma porta): é o único endereço que a sandbox do Codex alcança (a lista de domínios do perfil dela, ver
 * server/chat/codexArgs.ts). Quem chega por ele é "da sandbox do Codex": nunca é tela, precisa do token da conversa e só usa as rotas liberadas
 * (server/apiPolicy.ts, server/callers.ts). Todo 127/8 é loopback no Linux e no Windows; no macOS o endereço pode faltar.
 */
const SANDBOX_URL = `http://${SANDBOX_HOST}:${PORT}`;
/** O servidor ficou de pé em 127.0.0.2? `up` falso: o Codex roda sem rede (a conversa avisa). */
const sandboxListener: { up: boolean; error: string | null } = { up: false, error: null };
/** Token de cada conversa (Claude e Codex): `MYCO_TOKEN` no ambiente; quem chama a API é o dono dele. */
const sessionTokens = new SessionTokens();
const CLIENT_DIR = path.join(ROOT, 'dist', 'client');
// `claudio.localhost`: endereço fixo do Claudio’s Club. Todo `*.localhost` aponta para a própria máquina nos
// navegadores (RFC 6761), sem mexer no arquivo hosts; continua protegido contra DNS rebinding.
// `myco.localhost`: o endereço de antes da troca de nome, para favoritos e atalhos antigos.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', 'claudio.localhost', 'myco.localhost']);
// Retratos chegam como data URL no JSON da contratação.
const MAX_BODY = 4 * 1024 * 1024;
/** Pareamento do navegador: a chave (~/.myco/secrets/pairing.key) é criada aqui, na subida, se ainda não existe. */
const pairing = new Pairing();

// No quadro: o demo, as pastas de `extraProjects` (novas ou importadas) e os projetos com equipe. O resto
// do que o Claude Code conhece só entra se o usuário importar (`/api/import-projects`).
const pinnedProjects = async () => [DEMO_DIR, ...(await readExtraProjects())];
const adapter: ToolAdapter = new ClaudeAdapter({
  extraPaths: pinnedProjects,
  onBoard: boardFilter({ pinned: pinnedProjects }),
  projectNames: async () => (await readConfig()).projectNames,
});
/** ~/.claude/projects: onde ficam os transcripts das conversas. */
const defaultTranscripts = path.join(defaultLocations().home, 'projects');

/** Onde está o código de um funcionário (a worktree dele ou o próprio projeto). */
async function chatPlace(projectId: string, staffId: string | null) {
  const dir = await projectPathOf(projectId);
  if (!dir) throw new BadRequest('projeto não encontrado');
  const profile = staffId ? await readProfile(dir, staffId) : null;
  const place = await locateCode(dir, staffId, !!profile?.worktree);
  if (!place) throw new BadRequest('o projeto não é um repositório git');
  return { dir, place, profile };
}
const staff: StaffService = new StaffService(adapter, {
  runDir: path.join(MYCO_HOME, 'run'),
  claudeConfigFile: defaultLocations().configFile,
  mycoUrl: `http://127.0.0.1:${PORT}`,
  codexUrl: SANDBOX_URL,
  onChange: (prev, next) =>
    void projectPathOf(next.projectId).then((dir) =>
      chats.profileChanged(prev, next, dir ? path.join(dir, '.myco', 'staff', `${next.id}.md`) : null),
    ),
  // Subfuncionário contratado pela API: abre numa conversa do Claudio’s Club, não num terminal.
  // O gestor que contratou pela API passa a primeira tarefa: é delegação (bolinhas na linha).
  openChat: (projectId, staffId, text): Promise<string> => chats.send(projectId, null, staffId, text, undefined, [], [], true),
  isWorking: (projectId, staffId) => chats.staffWorking(projectId, staffId),
  // Tarefas abertas da ficha impedem apagar (ver deleteStaff). `tasks` é declarado logo abaixo: só é lido na chamada.
  tasksOf: async (projectId) => (await tasks.list(projectId)) ?? [],
  // Apagar com tarefas abertas e `force`: as tarefas ficam sem responsável (ver TaskService.releaseStaff).
  releaseTasks: (projectId, staffId) => tasks.releaseStaff(projectId, staffId),
  weekCost: async (projectId) => {
    const c = await getCosts();
    return { project: c.projects[projectId]?.last7d ?? 0, total: c.total.last7d };
  },
  // Salvar ficha do Codex com modelo fora do catálogo da conta é recusado. `codexModels` é declarado mais abaixo: só é lido na chamada.
  codexCatalog: () => codexModels.list(),
  // Versão mínima e `network_proxy` do codex instalado: a conversa de quem roda no Codex só abre com um Codex que serve.
  codexEnv: () => codexRunEnv(),
});
/** Perguntas em aberto e avisos marcados como "não é segredo", guardados entre reinícios. */
const inboxState = new InboxState(path.join(MYCO_HOME, 'inbox.json'));
/** Folga de cota agora, só com "otimizar assinatura" ligado no config. */
const currentBoost = async () => ((await readConfig()).optimizeQuota ? quotaBoost(await readUsage()) : null);

/**
 * O limite de uso da assinatura acabou no meio de uma conversa: o "continue" sai sozinho quando ele volta
 * (opção `autoContinue`). Respeita a linha de parada do usuário e o orçamento do projeto, como o chat.
 * O `engine` é o da conversa: a trava confere o consumo desse motor (Codex e Claude não se barram um ao outro).
 */
const usageStopHit = async (projectId: string, staffId: string | null, engine: 'claude' | 'codex') => {
  try {
    await staff.checkUsage(projectId, { staffId, engine });
    return null;
  } catch (err) {
    if (err instanceof UsageStopError) return err.hit;
    throw err;
  }
};
const autoContinue = new AutoContinue({
  file: path.join(MYCO_HOME, 'auto-continue.json'),
  enabled: async () => (await readConfig()).autoContinue,
  stopHit: usageStopHit,
  knownResets: async () => (await readUsage()).limits,
  send: (p) => chats.continueChat(p.projectId, p.sessionId, p.staffId),
});
/**
 * Despertador: o funcionário pede para ser chamado de novo na conversa dele daqui a N segundos (ver chat/wake.ts). É o
 * mesmo agendador, com arquivo próprio (as duas pendências da mesma conversa não se apagam) e sempre ligado.
 * A linha de parada do usuário barra do mesmo jeito; o temporizador confere de perto, porque o prazo mínimo é de 10 s.
 */
const wakeups = new AutoContinue({
  file: path.join(MYCO_HOME, 'wakeups.json'),
  enabled: async () => true,
  stopHit: usageStopHit,
  knownResets: async () => (await readUsage()).limits,
  send: (p) => chats.wakeChat(p),
  tickMs: 2_000,
  spacingMs: 2_000,
  log: (line) => console.log(`[despertador] ${line}`),
});

const chats: ChatManager = new ChatManager({
  // Plano B de quem roda no Codex: a conta recusou o modelo da ficha, o turno é refeito com o mais parecido do catálogo.
  codexModels: async () => (await codexModels.list()).models,
  // Antes de cada execução do Codex: o recurso `network_proxy` presente e o 127.0.0.2 de pé (senão roda sem rede e avisa) e a versão mínima.
  codexEnv: () => codexRunEnv(),
  tokens: sessionTokens,
  autoContinue,
  wakeups,
  inbox: inboxState,
  contextSwitch: async () => (await readConfig()).contextSwitch,
  quotaBoost: currentBoost,
  // A conversa de uma tarefa fica onde está: o quadro (revisão, ajustes, mescla) segue por ela.
  keepSession: (sessionId) => tasks.isTaskSession(sessionId),
  transcriptsDir: defaultTranscripts,
  runDir: path.join(MYCO_HOME, 'run'),
  usageFile: path.join(MYCO_HOME, 'usage.json'),
  // Limite do Codex estourado: a hora de voltar vem da leitura fresca dos limites do Codex (só com `codexReview` ligado).
  codexLimits: async () => codexUsage.read((await readConfig()).codexReview, { fresh: true, waitMs: 8_000 }),
  listLive: () => adapter.listLiveSessions(),
  resolve: (projectId, sessionId, staffId, forkFrom, engineOverride) => staff.chatSpawn(projectId, sessionId, staffId, forkFrom, engineOverride),
  rememberChoice: (projectId, staffId, sessionId, choice) => staff.rememberChoice(projectId, staffId, sessionId, choice),
  registry: new ChatRegistry(path.join(MYCO_HOME, 'run', 'chats.json')),
  copiesFile: path.join(MYCO_HOME, 'run', 'copies.json'),
  onPlanApproved: (sid, plan) => void tasks.onPlanApproved(sid, plan).catch(() => {}),
  onPlanRejected: (sid) => void tasks.onPlanRejected(sid).catch(() => {}),
  onSent: (sid) => void tasks.onSent(sid).catch(() => {}),
  // Ficou livre: os ajustes guardados e a próxima tarefa da fila dele.
  onIdle: (sid, pid, staffId, reason) => {
    // Turno de conversa do Claudio’s Club: o aviso "terminou" vem daqui, na hora exata (o vigia lê as sessões
    // de tempos em tempos e perde turno curto).
    if (reason === 'turn') turns.noteDone(sid);
    void tasks.onIdle(sid, pid, staffId).catch(() => {});
  },
});
// Quem acabou de terminar o turno (trabalhando → parado), para o aviso "terminou" no navegador.
const turns = new TurnWatcher(
  () => adapter.listLiveSessions(),
  (sid) => chats.lastAssistantText(sid),
  (sid) => void tasks.onTurnDone(sid).catch(() => {}),
);
turns.start();

// Tarefas por projeto (`.myco/tasks.json`): começam numa conversa nova e andam sozinhas com ela.
const projectPathOf = async (projectId: string) => {
  const p = (await adapter.listProjects()).find((x) => x.id === projectId);
  return p?.exists ? p.path : null;
};
/** Codex CLI só como segunda opinião na revisão de tarefas (o motor dos funcionários é o Claude). */
const codex = new CodexAdapter();
const codexUsage = new CodexUsageReader({ check: (fresh) => codex.check(fresh) });
/** Instalar e entrar no Codex pelo Claudio’s Club (ver codexSetup.ts). Depois de instalar, o status do Codex é relido já. */
const codexSetup = new CodexSetup({
  installed: async () => !(await readInstalled()).missing,
  afterInstall: async () => {
    codexUsage.forget();
    await codex.check(true);
  },
});
/** Só com o Codex ligado nas configurações (`codexReview`): desligado, o catálogo vem vazio com o motivo e nada abre o `codex`. */
const codexModels = new CodexModels((fresh) => codex.check(fresh), undefined, undefined, async () => (await readConfig()).codexReview);
const codexEnv = new CodexEnv();
/**
 * O que o Codex confere antes de cada execução (ver codexEnv.ts) mais o endereço dele: sem o 127.0.0.2 de pé (o macOS sem o alias, por exemplo) a
 * sandbox não teria por onde chegar à API, então roda sem rede e a conversa avisa.
 */
async function codexRunEnv(): Promise<CodexEnvStatus> {
  return withAppAddress(await codexEnv.status(), sandboxListener, `${SANDBOX_HOST}:${PORT}`);
}

/** Abre uma conversa nova com o funcionário e manda o texto. Sem `force`, confere o consumo antes. Usado pelas tarefas e pelas ações do guia. */
const sendNewConversation = async (projectId: string, staffId: string, text: string, force: boolean, override?: EngineOverride) => {
  // A trava confere o motor que a conversa vai usar: o do override (Claude→Codex não cai na trava do Claude; Codex→Claude
  // respeita a do Claude). Sem override, é a do motor da ficha, como sempre.
  if (!force) await staff.checkUsage(projectId, { staffId, ...(override && { engine: override.engine }) });
  return chats.send(projectId, null, staffId, text, undefined, [], [], false, undefined, override);
};

const tasks = new TaskService({
  projectPath: projectPathOf,
  projectIds: async () => (await adapter.listProjects()).filter((p) => p.exists && !p.worktreeOf).map((p) => p.id),
  readProfile: async (projectId, staffId) => {
    const dir = await projectPathOf(projectId);
    return dir ? readProfile(dir, staffId) : null;
  },
  send: sendNewConversation,
  apiUrl: `http://127.0.0.1:${PORT}`,
  branchFor: async (dir, profile) => (profile.worktree ? `myco/${profile.id}` : ((await gitState(dir))?.branch ?? null)),
  isWorking: (projectId, staffId, except) => chats.staffWorking(projectId, staffId, except),
  // O gestor que pediu recebe a entrega na conversa em que pediu (ou, sem ela, na mais recente dele),
  // depois que o turno dele acabar.
  notify: async (projectId, staffId, text, sessionId) => {
    const dir = await projectPathOf(projectId);
    const manager = dir ? await readProfile(dir, staffId) : null;
    if (!manager) return;
    const target = sessionId && manager.sessions.some((s) => s.id === sessionId) ? sessionId : (manager.sessions.at(-1)?.id ?? null);
    await chats.sendToRequester(projectId, target, staffId, text);
  },
  requesterSession: (projectId, staffId) => chats.workingSession(projectId, staffId),
  lastText: (sessionId) => chats.lastAssistantText(sessionId),
  // O consumo já foi conferido quando você mandou (a mensagem só esperou a vez).
  // Com carimbo (mensagem guardada de outro funcionário), vai como delegada: a marca vai junto, como no envio direto.
  sendTo: (projectId, sessionId, staffId, text, images, origin) => chats.send(projectId, sessionId, staffId, text, 'next', images, [], !!origin, origin),
  secondOpinion: (input) => codex.review(input),
  // Turno que parou no limite de uso, com o "continue" agendado, não é entrega.
  // Também com despertador marcado: o funcionário ainda está acompanhando algo, não entregou.
  awaitingLimit: async (sessionId) => (await chats.awaitingLimit(sessionId)) || !!(await wakeups.get(sessionId)),
  setOverride: (sessionId, override) => chats.setOverride(sessionId, override),
  // O limite de cada motor agora (ver taskFallback.ts). Sem leitura, 'unknown': não troca às cegas.
  readLimit: async (engine) => {
    if (engine === 'codex') {
      const usage = await codexUsage.read((await readConfig()).codexReview, { fresh: true, waitMs: 8_000 }).catch(() => null);
      return usage ? codexLimitHit(usage) : 'unknown';
    }
    const usage = await readUsage().catch(() => null);
    return usage && usage.limits.length ? claudeLimitHit(usage) : 'unknown';
  },
  settleLimit: (sessionId) => chats.settledLimit(sessionId),
  // A linha de parada 5h/7d da empresa conta para a troca de motor (o orçamento do projeto não: espera, como antes).
  stopHit: usageStopHit,
  // Tira o "continue" e o despertador da conversa antiga: ela não volta sozinha no motor principal. Devolve a hora do despertador.
  cancelContinue: async (sessionId) => {
    const wake = await wakeups.get(sessionId);
    await autoContinue.cancel(sessionId, 'fallback');
    await wakeups.cancel(sessionId, 'fallback');
    return wake ? wake.at : null;
  },
  // Pré-checagem da troca: a conversa no motor do override abriria? (as barreiras do envio, sem gravar nada).
  assertRunnable: (projectId, staffId, override) => staff.assertOverrideRunnable(projectId, staffId, override),
  clearOverride: (sessionId) => chats.clearOverride(sessionId),
  stopSession: (sessionId) => chats.stop(sessionId),
  snapshot: (projectId, sessionId) => chats.snapshot(projectId, sessionId),
});
// Limite no meio do turno: a tarefa pode trocar de motor (ver TaskService.onLimit). Depois de agendado o "continue".
chats.onUsageLimit((ev) => {
  void tasks.onLimit(ev).catch((err) => console.error('[tarefas] limite no meio do turno:', err));
});
/** O carimbo das mensagens entre funcionários (ver server/chat/origin.ts). */
const originDeps: OriginDeps = {
  projectPath: projectPathOf,
  readProfile,
  taskOfWork: (projectId, sessionId) => tasks.taskOfWork(projectId, sessionId),
  mycoUrl: `http://127.0.0.1:${PORT}`,
  codexUrl: SANDBOX_URL,
};

// "Continue" que não vai sair (cancelado na conversa, opção desligada, falhou): o turno que parou no limite
// vale como fim, e a tarefa daquela conversa é entregue como antes, sem prender a fila do funcionário.
autoContinue.subscribe((e) => {
  if (e.type === 'dropped' || e.type === 'failed' || (e.type === 'cancelled' && e.by === 'user')) {
    void tasks.onTurnDone(e.pending.sessionId).catch(() => {});
  }
});
// Despertador cancelado pelo usuário, solto ou que falhou: a tarefa daquela conversa é entregue como antes, mas só com
// a conversa parada (trabalhando, o fim do turno entrega); cancelado pelo próprio funcionário não entrega nada.
watchWakeups(
  wakeups,
  (sessionId) => chats.isWorking(sessionId),
  (sessionId) => void tasks.onTurnDone(sessionId).catch(() => {}),
);

// Rotinas: no horário, a mensagem vai ao funcionário pelo mesmo caminho do chat do painel.
const routines = new RoutineScheduler({
  file: path.join(MYCO_HOME, 'routines.json'),
  listStaff: async () => {
    const [projects, config] = await Promise.all([adapter.listProjects(), readConfig()]);
    const archived = new Set([...config.archived.projects, ...config.archived.sessions]);
    const all = await staff.listAll(projects.filter((p) => p.exists && !archived.has(p.id)));
    return all.filter((s) => !archived.has(`staff:${s.id}`));
  },
  run: runRoutine,
});

/**
 * Uma rotina disparando. As mesmas travas do chat valem, mas não há a quem perguntar: passou da
 * trava de consumo ou do orçamento, a rotina é pulada (e o aviso vai para a caixa). Também não
 * começa com o funcionário trabalhando ou com a sessão aberta em outro lugar.
 */
async function runRoutine(profile: StaffProfile, r: Routine): Promise<RoutineOutcome> {
  try {
    await staff.checkUsage(profile.projectId, { engine: profile.engine ?? 'claude' });
  } catch (err) {
    if (err instanceof UsageStopError) return { ok: false, text: `pulada: ${err.message}` };
    throw err;
  }
  const last = r.mode === 'continue' ? (profile.sessions.at(-1)?.id ?? null) : null;
  if (last && chats.isBusy(last)) return { ok: false, text: 'pulada: ele estava trabalhando' };
  try {
    const sid = await chats.send(profile.projectId, last, profile.id, `[Rotina "${r.name}"] ${r.message}`);
    return { ok: true, text: last === sid ? 'mandada na última conversa' : 'mandada numa conversa nova' };
  } catch (err) {
    if (err instanceof ChatError) return { ok: false, text: `pulada: ${err.message}` };
    throw err;
  }
}

/** Imagem colada no chat (já reduzida no navegador): data URL PNG, JPEG, WebP ou GIF. */
const ChatImage = z
  .string()
  .max(1_200_000, 'imagem grande demais')
  .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/, 'imagem inválida: use PNG, JPEG, WebP ou GIF');
const SendBody = z
  .object({
    sessionId: z.string().uuid().nullable(),
    staffId: z.string().max(40).nullable(),
    text: z.string().trim().max(50_000).default(''),
    /** Prints e imagens coladas (até 4). */
    images: z.array(ChatImage).max(4, 'no máximo 4 imagens por mensagem').default([]),
    /** Confirmado no Claudio’s Club: segue mesmo acima da linha de parada do consumo. */
    force: z.boolean().default(false),
    /** Com o funcionário trabalhando; sem ela, vale a da configuração. */
    priority: z.enum(['now', 'next', 'later']).optional(),
    /** Arquivos anexados (texto ou PDF), além das imagens. */
    files: z
      .array(z.object({ name: z.string().trim().min(1).max(200), mediaType: z.string().max(100), data: z.string().max(3_000_000) }))
      .max(5, 'no máximo 5 arquivos por mensagem')
      .default([]),
  })
  .refine((b) => b.text.length > 0 || b.images.length > 0 || b.files.length > 0, 'mensagem vazia');
const PermissionBody = z.object({
  requestId: z.string().min(1).max(100),
  allow: z.boolean(),
  /** Ao negar: o que o funcionário lê (ex.: "quero mudanças no plano"). */
  message: z.string().trim().min(1).max(500).optional(),
  /** Ao aprovar um plano: autonomia com que ele executa (só pelo Claudio’s Club). */
  executeAs: z.enum(AUTONOMY).optional(),
  /** Ao negar um plano: recusa de vez (não executa; a tarefa sai da fila e vai para Aguardar). Só pelo Claudio’s Club. */
  reject: z.boolean().optional(),
  /** Ao aprovar: liberar de vez, nesta conversa ou no projeto (só pelo Claudio’s Club). */
  remember: z.enum(['session', 'project']).optional(),
  /** Ao aprovar uma pergunta com opções: texto da pergunta → a opção, várias opções ou o que foi escrito. */
  answers: AnswersField,
  /** O `preview` (ou nota) da opção marcada, por pergunta. */
  annotations: AnnotationsField,
});
const ChatSettingsBody = z
  .object({
    staffId: z.string().max(40).nullable(),
    model: z.string().regex(/^[\w.[\]-]{1,60}$/, 'modelo inválido').optional(),
    // `ultra` só vale para conversa do Codex (o manager recusa nas do Claude).
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
    autonomy: z.enum(AUTONOMY).optional(),
  })
  .refine((b) => b.model || b.effort || b.autonomy, 'nada para mudar');
const StaffRef = z.object({ staffId: z.string().max(40).nullable().default(null), force: z.boolean().default(false) });

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequest(r.error.issues[0]?.message ?? 'pedido inválido');
  return r.data;
}

interface Request {
  params: string[];
  url: URL;
  body: unknown;
  /**
   * Veio da página do Claudio’s Club num navegador pareado (Origin local e o cookie do pareamento), e não de uma
   * ferramenta de linha de comando. Origin sem cookie num POST nem chega aqui (403 needs-pairing, ver pairing.ts).
   */
  fromBrowser: boolean;
  /** Só o cookie do pareamento é válido (o GET do navegador não manda Origin). Informação para a tela; NUNCA autoriza nada. */
  paired: boolean;
  /** Só para o log (quem pediu o reinício: navegador ou curl); cortado e sem caracteres de controle. */
  userAgent: string;
  /**
   * Quem chama, pelo token da conversa (`x-myco-token`, ver callers.ts): vale no lugar do que o pedido declara. Pela sandbox do Codex (127.0.0.2) é
   * sempre alguém; em 127.0.0.1 o token é opcional. Nunca existe para a tela (`fromBrowser`).
   */
  caller: Caller | null;
}

type Handler = (r: Request) => Promise<unknown>;

/** Resposta binária (retratos), em vez de JSON. */
class Raw {
  constructor(
    readonly bytes: Buffer,
    readonly type: string,
    /** Cabeçalhos a mais (ex.: content-disposition dos anexos). */
    readonly headers: Record<string, string> = {},
  ) {}
}

class BadRequest extends Error {}
/** O pedido é de quem não pode (403). */
class Forbidden extends Error {}

/** Quem pede pela API: o dono do token da conversa, ou (sem token) o `requestedBy` declarado; conversa sem ficha não é ninguém. */
function actorOf(caller: Caller | null, declared: string | undefined): string | undefined {
  const who = actingStaff(caller, declared);
  if (who.error) throw new BadRequest(who.error);
  return who.staffId;
}

/** A sandbox do Codex só fala com a própria conversa e com as de quem reporta a ela. */
async function checkReach(caller: Caller | null, projectId: string, target: { sessionId: string | null; staffId: string | null }): Promise<void> {
  if (caller?.sandbox && !(await staff.mayReach(projectId, caller, target))) {
    throw new Forbidden('a sandbox do Codex só fala com a própria conversa e com as de quem reporta a você');
  }
}

const ID = '([A-Za-z0-9-]+)';
/** Nome de conexão SSH ou FTP (o mesmo formato de server/staff/servers.ts). */
const CONN = '([A-Za-z0-9][\\w.-]{0,39})';

/** Envio de anexo: o corpo são os bytes do arquivo (não JSON), o nome vai em `?name=`. */
const ATTACHMENT_UPLOAD = new RegExp(`^/api/projects/${ID}/attachments$`);

/** Biblioteca de MCPs (cadastro e edição nos quatro escopos). A pasta do projeto vem do adapter, nunca do cliente. */
const mcpLibrary = createMcpLibrary({
  claudeConfigFile: defaultLocations().configFile,
  clubFile: CLUB_MCP_FILE,
  backupDir: path.join(MYCO_HOME, 'backups'),
  resolveProject: projectPathOf,
});

const routes: Array<['GET' | 'POST' | 'PUT', RegExp, Handler]> = [
  ['GET', /^\/api\/health$/, async () => ({ ok: true, adapter: adapter.id })],
  // CPU e RAM da máquina, para o monitor do canto (só números; ver systemStats.ts).
  ['GET', /^\/api\/system$/, async (): Promise<SystemStats> => systemStats()],
  // ---- o próprio servidor: parar e (com o vigia) reiniciar pelo config ----
  // `pendingRestart`: há código no disco que só entra reiniciando (o vigia não reinicia por mudança de código).
  [
    'GET',
    /^\/api\/server$/,
    async ({ paired }): Promise<AppServerInfo> => ({
      daemon: UNDER_DAEMON,
      paired,
      pid: process.pid,
      port: PORT,
      startedAt: STARTED_AT,
      working: chats.working(),
      ...pendingRestart(),
    }),
  ],
  [
    'POST',
    /^\/api\/server\/(stop|restart)$/,
    async ({ params: [action], fromBrowser, userAgent }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      if (action === 'restart' && !UNDER_DAEMON) throw new BadRequest('reiniciar precisa do Claudio’s Club em segundo plano (npm run daily:start)');
      // Responde primeiro; fecha as conversas e sai logo depois. Parando com o vigia, o arquivo de
      // parada impede que ele religue; reiniciando, ele sobe o servidor de novo em poucos segundos.
      setTimeout(() => void shutdown(action === 'stop', userAgent), 300);
      return { ok: true, daemon: UNDER_DAEMON };
    },
  ],
  // ---- atualizar o Claudio’s Club pelo GitHub: novidades no remoto e, com o vigia, atualizar e reiniciar ----
  ['GET', /^\/api\/update$/, async ({ url }) => ({ ...(await updater.check(url.searchParams.has('fresh'))), daemon: UNDER_DAEMON })],
  [
    'POST',
    /^\/api\/update$/,
    async ({ fromBrowser, userAgent }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const result = await updater.apply();
      console.log(`[servidor] atualizado pelo config: ${result.from} → ${result.to}${result.installed ? ' (com npm install)' : ''}`);
      // Com o vigia, reinicia já na versão nova (ele refaz o build do cliente); sem ele, quem reinicia é você.
      if (UNDER_DAEMON) setTimeout(() => void shutdown(false, userAgent), 300);
      return { ...result, restarting: UNDER_DAEMON };
    },
  ],
  ['GET', /^\/api\/projects$/, () => adapter.listProjects()],
  // Fichas de todos os projetos, para copiar uma para outro (só os campos da lista; ver StaffService.directory).
  ['GET', /^\/api\/staff-directory$/, () => staff.directory()],
  // "Novo projeto": a pasta sugerida (onde está a maioria) e criar ou abrir, já na empresa da aba.
  // Conta também os projetos do Claude Code que ficaram fora do quadro: quem só tem o demo ainda recebe a pasta onde trabalha.
  ['GET', /^\/api\/new-project$/, async () => ({ parent: usualParent([...(await adapter.listProjects()), ...(await offBoardFolders())]) })],
  [
    'POST',
    /^\/api\/new-project$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const input = parseNewProject(body);
      // O workspace antes da pasta: um id errado não deixa pasta criada para trás.
      if (input.workspaceId && !(await readConfig()).workspaces.some((w) => w.id === input.workspaceId)) throw new BadRequest('workspace não encontrado');
      const opened = await openProject(input);
      await addExtraProject(opened.path);
      adapter.forgetProjects();
      const project = (await adapter.listProjects()).find((p) => pathKey(p.path) === pathKey(opened.path));
      if (!project) throw new BadRequest('a pasta não entrou na lista de projetos');
      if (input.workspaceId) await setProjectWorkspace(project.id, input.workspaceId);
      // Estava arquivado: abrir de novo traz de volta ao quadro.
      if ((await readConfig()).archived.projects.includes(project.id)) await setArchived({ kind: 'project', id: project.id, archived: false });
      return { created: opened.created, projectId: project.id };
    },
  ],
  // "Importar do Claude Code": os projetos que o Claude Code conhece e ainda estão fora do quadro, e pô-los nele.
  ['GET', /^\/api\/import-projects$/, () => importableList(adapter)],
  [
    'POST',
    /^\/api\/import-projects$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      return importProjects(adapter, body);
    },
  ],
  ['GET', new RegExp(`^/api/projects/${ID}$`), ({ params: [id] }) => adapter.getProject(id!)],
  ['GET', new RegExp(`^/api/projects/${ID}/mcp$`), ({ params: [id] }) => staff.listMcp(id!)],
  // Biblioteca de MCPs: a lista não traz valor (só nome e se está preenchido); cadastrar, editar, apagar e testar só pelo navegador.
  ['GET', /^\/api\/mcp-servers$/, ({ url }) => mcpLibrary.list(url.searchParams.get('projectId'))],
  ['POST', /^\/api\/mcp-servers\/save$/, ({ body, fromBrowser }) => mcpLibrary.save(body, fromBrowser)],
  ['POST', /^\/api\/mcp-servers\/delete$/, ({ body, fromBrowser }) => mcpLibrary.remove(body, fromBrowser)],
  ['POST', /^\/api\/mcp-servers\/test$/, ({ body, fromBrowser }) => mcpLibrary.test(body, fromBrowser)],
  ['GET', new RegExp(`^/api/projects/${ID}/servers$`), ({ params: [id] }) => staff.listServers(id!)],
  // Conexões SSH do projeto, só pela página do Claudio’s Club: até a lista é POST, para exigir o cabeçalho
  // x-myco e a origem local (um funcionário teria de forjar os dois num comando que você aprova).
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/connections/list$`),
    ({ params: [id], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      return staff.listConnections(id!);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/connections$`),
    ({ params: [id], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      return staff.saveConnection(id!, body);
    },
  ],
  // FTP/FTPS: a senha vai para o cofre do sistema (~/.myco/secrets) e nunca volta em resposta nenhuma.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/connections/ftp$`),
    ({ params: [id], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      return staff.saveFtpConnection(id!, body);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/connections/${CONN}/(delete|test)$`),
    async ({ params: [id, name, action], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      if (action === 'test') return staff.testConnection(id!, name!);
      const ok = await staff.removeConnection(id!, name!);
      return ok === null ? null : { ok };
    },
  ],
  // Pela API, o gestor é quem chama (o token da conversa), não o `reportsTo` do pedido.
  ['POST', new RegExp(`^/api/projects/${ID}/staff$`), ({ params: [id], body, fromBrowser, caller }) => staff.hire(id!, body, fromBrowser, caller)],
  // Copiar uma ficha de outro projeto (só pelo Claudio’s Club). Antes da rota de edição: "copy" casaria como id.
  ['POST', new RegExp(`^/api/projects/${ID}/staff/copy$`), ({ params: [id], body, fromBrowser }) => staff.copyFrom(id!, body, fromBrowser)],
  // Fichas da mesma pessoa (cópias): ligar, desligar e apagar de vez. Só pelo Claudio’s Club (o serviço confere).
  ['POST', /^\/api\/staff-link$/, ({ body, fromBrowser }) => staff.link(body, fromBrowser)],
  ['POST', /^\/api\/staff-unlink$/, ({ body, fromBrowser }) => staff.unlink(body, fromBrowser)],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/delete$`),
    ({ params: [id, staffId], body, fromBrowser }) => staff.deleteStaff(id!, staffId!, fromBrowser, body),
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}$`),
    ({ params: [id, staffId], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('a ficha só é editada pelo Claudio’s Club');
      return staff.update(id!, staffId!, body);
    },
  ],
  ['GET', new RegExp(`^/api/projects/${ID}/staff/${ID}/versions$`), ({ params: [id, staffId] }) => staff.versions(id!, staffId!)],
  // Registro de acesso aos servidores: os comandos ssh/scp/vps das conversas do funcionário.
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/server-log$`),
    async ({ params: [id, staffId] }) => {
      const dir = await projectPathOf(id!);
      const profile = dir ? await readProfile(dir, staffId!) : null;
      if (!profile) return null;
      const files = await Promise.all(profile.sessions.map((s) => findTranscript(defaultTranscripts, id!, s.id)));
      return readServerLog(files, profile.servers);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/restore$`),
    ({ params: [id, staffId], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('a ficha só é editada pelo Claudio’s Club');
      return staff.restore(id!, staffId!, parse(z.object({ version: z.string().max(40) }), body).version);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/managers$`),
    ({ params: [id, staffId], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('vínculos só pelo Claudio’s Club');
      return staff.addManager(id!, staffId!, parse(z.object({ managerId: z.string().max(40) }), body).managerId);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/managers/remove$`),
    ({ params: [id, staffId], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('vínculos só pelo Claudio’s Club');
      return staff.removeManager(id!, staffId!, parse(z.object({ managerId: z.string().max(40) }), body).managerId);
    },
  ],
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/portrait$`),
    async ({ params: [id, staffId] }) => {
      const img = await staff.portrait(id!, staffId!);
      return img ? new Raw(img.bytes, img.type) : null;
    },
  ],
  // Memória pessoal (uma por pessoa, lida pelas fichas dela em todos os projetos). Lê qualquer um; grava só pelo navegador.
  ['GET', new RegExp(`^/api/people/${ID}/memory$`), async ({ params: [pid] }) => readPersonMemory(pid!)],
  [
    'PUT',
    new RegExp(`^/api/people/${ID}/memory$`),
    async ({ params: [pid], body, fromBrowser }) => {
      const saved = await savePersonMemory(pid!, body, fromBrowser);
      // As conversas abertas dessa pessoa reabrem com a memória nova na próxima mensagem.
      chats.personChanged(await staff.sessionsOfPerson(pid!));
      return saved;
    },
  ],
  // Garante o personId da ficha (gera se faltar) para a tela poder editar a memória. Grava o JSON: só pelo navegador.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/person$`),
    ({ params: [id, staffId], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      return staff.personOf(id!, staffId!);
    },
  ],
  // ---- conversa ----
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/chat/${ID}$`),
    async ({ params: [pid, sid] }) => ({ ...(await chats.snapshot(pid!, sid!)), held: await tasks.heldItems(sid!) }),
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/chat/send$`),
    async ({ params: [pid], body, fromBrowser, caller }) => {
      const b = parse(SendBody, body);
      await checkReach(caller, pid!, { sessionId: b.sessionId, staffId: b.staffId });
      if (!(fromBrowser && b.force)) await staff.checkUsage(pid!, { staffId: b.staffId });
      // De outro funcionário, quem manda é o dono do token (nunca o corpo): o carimbo vai junto, também se a mensagem ficar guardada.
      const origin = fromBrowser ? undefined : await staffOrigin(originDeps, pid!, caller, b.staffId);
      // Ajuste numa tarefa anterior com ele ocupado em outra: espera a vez (ver tasks.ts).
      if (b.sessionId && b.staffId) {
        const held = await tasks.hold(b.sessionId, { text: b.text, images: b.images, origin });
        if (held) return { sessionId: b.sessionId, held };
      }
      const priority = b.priority ?? (await readConfig()).sendWhileBusy;
      // Fora do navegador, quem manda é outro funcionário (o gestor, pela API): delegação. Pelo Claudio’s Club,
      // a mensagem pode seguir numa conversa nova se o assunto da atual fechou (ver contextPolicy.ts).
      const sessionId = fromBrowser
        ? await chats.sendFromUser(pid!, b.sessionId, b.staffId, b.text, priority, b.images, b.files)
        : await chats.send(pid!, b.sessionId, b.staffId, b.text, priority, b.images, b.files, true, origin);
      return { sessionId };
    },
  ],
  // Aviso de limite de uso na conversa: desfaz o "continue" agendado para quando ele voltar.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/chat/${ID}/auto-continue/cancel$`),
    async ({ params: [pid, sid], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      // Pendência de outro projeto: 404, e ela fica como está.
      const done = await chats.cancelAutoContinue(pid!, sid!);
      return done === null ? null : { ok: done };
    },
  ],
  // Despertador: o funcionário (x-myco, sem origem de navegador) pede para ser chamado de novo nesta conversa, e cancela.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/chat/${ID}/wake$`),
    async ({ params: [pid, sid], body, caller }) => {
      const b = parse(WakeBody, body);
      await checkReach(caller, pid!, { sessionId: sid!, staffId: null });
      const done = await chats.scheduleWake(pid!, sid!, b).catch((err) => {
        throw err instanceof WakeStreakError ? new BadRequest(err.message) : err;
      });
      // Conversa que não é deste projeto (ou não está aberta aqui): 404.
      return done && { ok: true, at: new Date(done.at).toISOString(), seconds: b.seconds };
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/chat/${ID}/wake/cancel$`),
    async ({ params: [pid, sid], caller }) => {
      await checkReach(caller, pid!, { sessionId: sid!, staffId: null });
      const done = await chats.cancelWake(pid!, sid!, 'staff');
      return done === null ? null : { ok: done };
    },
  ],
  // O botão Cancelar do aviso do despertador: só pelo Claudio’s Club, conferindo o projeto.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/chat/${ID}/wake/user-cancel$`),
    async ({ params: [pid, sid], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const done = await chats.cancelWake(pid!, sid!, 'user');
      return done === null ? null : { ok: done };
    },
  ],
  // Agendamentos pendentes do projeto (despertadores e "continue" do limite), para a tela central. Só pelo Claudio’s Club.
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/schedules$`),
    async ({ params: [pid], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      return { items: await chats.listSchedules(pid!) };
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/chat/settings$`),
    async ({ params: [pid], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const b = parse(ChatSettingsBody.and(z.object({ sessionId: z.string().uuid().nullable() })), body);
      return { sessionId: await chats.settings(pid!, b.sessionId, b.staffId, b) };
    },
  ],
  // "O que mudou" na conversa: a worktree dele, ou só os arquivos que ele editou nesta conversa.
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/chat/${ID}/changes$`),
    async ({ params: [pid, sid], url }) => {
      const { dir, place } = await chatPlace(pid!, url.searchParams.get('staffId'));
      if (place.where === 'worktree') return { ...(await readCode(dir, place)), scope: 'worktree', touched: [] };
      const touched = await touchedFiles(await findTranscript(defaultTranscripts, pid!, sid!), place.path);
      return { ...(await readCode(dir, place, null, touched)), scope: 'conversation', touched };
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/chat/${ID}/test$`),
    async ({ params: [pid], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const { dir, place } = await chatPlace(pid!, parse(StaffRef, body).staffId);
      const command = await detectTest(dir);
      if (!command) throw new BadRequest('não achei testes neste projeto (npm test, composer test ou phpunit)');
      return runTests(place.path, command);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/chat/${ID}/merge$`),
    async ({ params: [pid], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const b = parse(StaffRef.extend({ skipTests: z.boolean().default(false) }), body);
      const { dir, place, profile } = await chatPlace(pid!, b.staffId);
      return mergeCode(dir, place, `Trabalho de ${profile?.name ?? 'funcionário'}`, { skipTests: b.skipTests });
    },
  ],
  // "Voltar até aqui": desfaz as edições de arquivo feitas desde aquela mensagem sua.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/chat/${ID}/rewind$`),
    async ({ params: [pid, sid], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const b = parse(StaffRef.extend({ uuid: z.string().uuid(), dryRun: z.boolean().default(true) }), body);
      return chats.rewind(pid!, sid!, b.staffId, b.uuid, b.dryRun);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/chat/${ID}/fork$`),
    async ({ params: [pid, sid], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      return { sessionId: await chats.fork(pid!, sid!, parse(StaffRef, body).staffId) };
    },
  ],
  // "Trazer" uma conversa aberta em outro lugar: a cópia daqui, criada uma vez só.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/chat/${ID}/bring$`),
    async ({ params: [pid, sid], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      return { sessionId: await chats.bring(pid!, sid!, parse(StaffRef, body).staffId) };
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/chat/${ID}/rename$`),
    async ({ params: [pid, sid], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const { title } = parse(z.object({ title: z.string().trim().min(1, 'dê um nome').max(120) }), body);
      await chats.rename(pid!, sid!, title);
      return { ok: true };
    },
  ],
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/chat/${ID}/mcp$`),
    async ({ params: [pid, sid], url }) => chats.mcp(pid!, sid!, url.searchParams.get('staffId')),
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/chat/${ID}/mcp$`),
    async ({ params: [pid, sid], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const b = parse(StaffRef.extend({ name: z.string().min(1).max(100), enabled: z.boolean() }), body);
      await chats.mcpToggle(pid!, sid!, b.staffId, b.name, b.enabled);
      return { ok: true };
    },
  ],
  [
    'POST',
    new RegExp(`^/api/chat/${ID}/stop-task$`),
    async ({ params: [sid], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      await chats.stopTask(sid!, parse(z.object({ taskId: z.string().min(1).max(100) }), body).taskId);
      return { ok: true };
    },
  ],
  // Busca nas conversas dos funcionários (Ctrl+K).
  [
    'GET',
    /^\/api\/search$/,
    async ({ url }) => {
      const q = url.searchParams.get('q') ?? '';
      if (q.trim().length < 3) return [];
      const projects = (await adapter.listProjects()).filter((p) => p.exists);
      const targets = await Promise.all(
        (await staff.listAll(projects)).flatMap((s) =>
          s.sessions.map(async (x) => ({ projectId: s.projectId, staffId: s.id, staffName: s.name, sessionId: x.id, file: await findTranscript(defaultTranscripts, s.projectId, x.id) })),
        ),
      );
      return searchConversations(targets, q);
    },
  ],
  // "@" no chat: arquivos do projeto que batem com o que foi digitado.
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/files$`),
    async ({ params: [pid], url }) => {
      const dir = await projectPathOf(pid!);
      if (!dir) return [];
      return searchFiles(dir, url.searchParams.get('q') ?? '');
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/chat/${ID}/compact$`),
    async ({ params: [pid, sid], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const b = parse(StaffRef, body);
      if (!b.force) await staff.checkUsage(pid!, { staffId: b.staffId });
      await chats.compact(pid!, sid!, b.staffId);
      return { ok: true };
    },
  ],
  [
    'POST',
    new RegExp(`^/api/chat/${ID}/permission$`),
    async ({ params: [sid], body, fromBrowser }) => {
      // Um funcionário não aprova pedido de permissão (nem o dele, nem o de outro).
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const b = parse(PermissionBody, body);
      return {
        ok: chats.answer(sid!, b.requestId, b.allow, {
          message: b.message,
          executeAs: b.executeAs,
          reject: b.reject,
          remember: b.remember,
          answers: b.answers,
          annotations: b.annotations,
        }),
      };
    },
  ],
  // ---- caixa "precisa de mim" ----
  ['GET', /^\/api\/inbox$/, () => getInbox()],
  ['GET', /^\/api\/turns$/, ({ url }) => getTurns(url.searchParams.get('since'))],
  // ---- cargos (modelos de ficha) ----
  ['GET', /^\/api\/roles$/, () => listRoles()],
  [
    'POST',
    /^\/api\/roles(?:\/(default|restore))?$/,
    ({ params: [action], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('cargos só pelo Claudio’s Club');
      if (action === 'restore') return restoreBuiltins();
      if (action === 'default') return setDefaultRole(parse(z.object({ id: z.string().max(40).nullable() }), body).id);
      return saveRole(body);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/roles/${ID}/delete$`),
    ({ params: [id], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('cargos só pelo Claudio’s Club');
      return removeRole(id!);
    },
  ],
  // ---- tarefas por projeto ----
  ['GET', /^\/api\/tasks\/summary$/, () => tasks.summary()],
  ['GET', new RegExp(`^/api/projects/${ID}/tasks$`), ({ params: [id] }) => tasks.list(id!)],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks$`),
    async ({ params: [id], body, fromBrowser, caller }) => {
      if (fromBrowser) return tasks.create(id!, body);
      // Pela API, só um gestor passando tarefa para quem reporta a ele. Já entra na fila dela; `start: false` = rascunho. Com o token da conversa,
      // quem pede é quem chama: o `requestedBy` do pedido é descartado (sem o token, segue valendo o que ele declara, por compatibilidade).
      const b = parse(z.object({ staffId: z.string().max(40), requestedBy: z.string().max(40).optional(), start: z.boolean().default(true) }).passthrough(), body);
      const requestedBy = actorOf(caller, b.requestedBy);
      if (!requestedBy) throw new BadRequest('pela API, diga quem pede (requestedBy: o seu id)');
      if (!(await staff.isManagerOf(id!, requestedBy, b.staffId))) throw new BadRequest('pela API, só para quem reporta a você (requestedBy)');
      // A entrega volta para a conversa dele que pediu (a do token), e não para a que está no turno agora.
      const task = await tasks.create(id!, body, requestedBy, requesterSessionOf(caller, requestedBy));
      return task && b.start ? ((await tasks.start(id!, task.id)) ?? task) : task;
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}$`),
    ({ params: [id, taskId], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('tarefas só pelo Claudio’s Club');
      return tasks.update(id!, taskId!, body);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/start$`),
    ({ params: [id, taskId], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('tarefas só pelo Claudio’s Club');
      return tasks.start(id!, taskId!, (body as { force?: unknown } | null)?.force === true);
    },
  ],
  ['GET', new RegExp(`^/api/projects/${ID}/tasks/${ID}/code$`), ({ params: [id, taskId] }) => tasks.code(id!, taskId!)],
  // Desligada nas configurações: nem procura o `codex` (nenhum processo é aberto).
  [
    'GET',
    /^\/api\/codex$/,
    async ({ url }) =>
      (await readConfig()).codexReview
        ? { enabled: true, ...(await codex.check(url.searchParams.has('fresh'))) }
        : { enabled: false, available: false, reason: null },
  ],
  // Modelos e esforços do Codex para a ficha escolher (`codex debug models`, só os da lista). Sem o CLI ou sem login: lista vazia com o motivo.
  // Só com o Codex ligado nas configurações (`codexReview`, o "usar o Codex"): desligado, lista vazia com o motivo (ver CodexModels).
  ['GET', /^\/api\/codex\/models$/, ({ url }) => codexModels.list(url.searchParams.has('fresh'))],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/(test|merge|review|deploy|second-opinion)$`),
    ({ params: [id, taskId, action], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('tarefas só pelo Claudio’s Club');
      const b = parse(z.object({ staffId: z.string().max(40).optional(), force: z.boolean().default(false), skipTests: z.boolean().default(false) }), body ?? {});
      if (action === 'test') return tasks.test(id!, taskId!);
      // O diff vai para a OpenAI: só com a opção ligada nas configurações e quando você pede, pelo botão.
      if (action === 'second-opinion') {
        return readConfig().then((c) => {
          if (!c.codexReview) throw new BadRequest('a segunda opinião do Codex está desligada nas configurações');
          return tasks.secondOpinion(id!, taskId!);
        });
      }
      if (action === 'merge') return tasks.merge(id!, taskId!, b.skipTests);
      if (!b.staffId) throw new BadRequest(action === 'review' ? 'escolha quem revisa' : 'escolha quem faz o deploy');
      return action === 'review' ? tasks.requestReview(id!, taskId!, b.staffId, b.force, { assign: true }) : tasks.requestDeploy(id!, taskId!, b.staffId, b.force);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/delete$`),
    async ({ params: [id, taskId], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('tarefas só pelo Claudio’s Club');
      return { ok: await tasks.remove(id!, taskId!) };
    },
  ],
  // ---- rotinas agendadas ----
  ['GET', /^\/api\/routines\/state$/, () => routines.state()],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/routines$`),
    ({ params: [id, staffId], body, fromBrowser }) => {
      // Um funcionário não agenda trabalho para si mesmo (nem para outro) pela API.
      if (!fromBrowser) throw new BadRequest('rotinas só pelo Claudio’s Club');
      return staff.setRoutines(id!, staffId!, (body as { routines?: unknown } | null)?.routines);
    },
  ],
  // Temporários: quem contratou (pela API, com requestedBy) ou você encerra; só você efetiva.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/done$`),
    ({ params: [id, staffId], body, fromBrowser, caller }) => {
      const b = parse(z.object({ note: z.unknown().optional(), requestedBy: z.string().max(40).optional() }), body ?? {});
      // Com o token da conversa, quem encerra é quem chama (só encerra quem contratou, ver StaffService.end).
      const requestedBy = fromBrowser ? undefined : actorOf(caller, b.requestedBy);
      if (!fromBrowser && !requestedBy) throw new BadRequest('pela API, diga quem encerra (requestedBy: o seu id)');
      const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : fromBrowser ? 'você encerrou' : 'o gestor encerrou';
      return staff.end(id!, staffId!, note, requestedBy);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/keep$`),
    ({ params: [id, staffId], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só você efetiva, pelo Claudio’s Club');
      return staff.keep(id!, staffId!);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/routines/${ID}/run$`),
    async ({ params: [id, staffId, routineId], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('rotinas só pelo Claudio’s Club');
      const profile = (await staff.listAll((await adapter.listProjects()).filter((p) => p.id === id))).find((s) => s.id === staffId);
      return profile ? await routines.runNow(profile, routineId!) : null;
    },
  ],
  [
    'POST',
    /^\/api\/routines\/alerts\/dismiss$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const b = parse(z.object({ id: z.string().min(1).max(300) }), body);
      return { ok: routines.dismissAlert(b.id) };
    },
  ],
  [
    'POST',
    /^\/api\/secrets\/dismiss$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const b = parse(z.object({ id: z.string().min(1).max(300), notSecret: z.boolean().default(false) }), body);
      // Chave no .mcp.json: "já troquei" não guarda nada (o aviso some quando o arquivo muda).
      if (b.id.startsWith('mcp:')) {
        if (b.notSecret) inboxState.mute(b.id);
        return { ok: true };
      }
      return { ok: chats.dismissSecret(b.id, b.notSecret) };
    },
  ],
  [
    'POST',
    /^\/api\/questions\/dismiss$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const b = parse(z.object({ sessionId: z.string().min(1).max(100) }), body);
      return { ok: chats.dismissQuestion(b.sessionId) };
    },
  ],
  [
    'POST',
    /^\/api\/waiting\/dismiss$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const b = parse(z.object({ sessionId: z.string().min(1).max(100) }), body);
      // Só sessão viva e esperando: o statusUpdatedAt guardado é o de agora, lido aqui (não o que o cliente diz).
      const l = (await adapter.listLiveSessions()).find((s) => s.sessionId === b.sessionId && s.alive && s.status === 'waiting');
      if (l) inboxState.dismissWaiting(l.sessionId, l.statusUpdatedAt);
      return { ok: !!l };
    },
  ],
  [
    'POST',
    new RegExp(`^/api/chat/${ID}/(interrupt|stop)$`),
    async ({ params: [sid, action], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      if (action === 'interrupt') chats.interrupt(sid!);
      else chats.stop(sid!);
      return { ok: true };
    },
  ],
  [
    'POST',
    new RegExp(`^/api/chat/${ID}/adopt$`),
    async ({ params: [sid], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      await chats.adopt(sid!);
      return { ok: true };
    },
  ],
  // "Assumir aqui": sessão aberta no app do Claude ou num terminal. O pid sai do servidor, nunca do cliente.
  [
    'POST',
    new RegExp(`^/api/chat/${ID}/takeover$`),
    async ({ params: [sid], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const b = parse(z.object({ projectId: z.string().min(1).max(200) }), body);
      if (!(await projectById(b.projectId))) return null;
      await chats.takeOver(sid!);
      return { ok: true };
    },
  ],
  // ---- imagem do projeto e regras da conta ----
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/image$`),
    async ({ params: [id] }) => {
      const p = await projectById(id!);
      const img = p ? await readProjectImage(p.path) : null;
      return img ? new Raw(img.bytes, img.type) : null;
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/image$`),
    async ({ params: [id], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const p = await projectById(id!);
      if (!p) return null;
      const { dataUrl } = parse(z.object({ dataUrl: z.string().max(3_000_000).nullable() }), body);
      await saveProjectImage(p.path, dataUrl);
      return { image: await projectImageUrl(p.id, p.path) };
    },
  ],
  // ---- guia do projeto (SPEC.md na raiz): ver o estado; criar o modelo só pelo Claudio’s Club (fora da lista de funcionários em apiPolicy.ts) ----
  ['GET', new RegExp(`^/api/projects/${ID}/guide$`), async ({ params: [id] }) => {
    const dir = await projectPathOf(id!);
    return dir ? guideStatus(dir) : null;
  }],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/guide$`),
    async ({ params: [id], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('o guia só é criado pelo Claudio’s Club');
      const dir = await projectPathOf(id!);
      if (!dir) return null;
      await createGuide(dir);
      return guideStatus(dir);
    },
  ],
  // Ações do guia (teste de compreensão, divergência, rascunho): abrem uma conversa nova do funcionário, com o texto da ação.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/guide/run$`),
    async ({ params: [id], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('as ações do guia só pelo Claudio’s Club');
      const dir = await projectPathOf(id!);
      if (!dir) return null;
      return runGuideAction(
        { readProfile: (staffId) => readProfile(dir, staffId), send: (staffId, text, force) => sendNewConversation(id!, staffId, text, force) },
        dir,
        body,
      ).catch((err) => {
        throw err instanceof GuideActionError ? new BadRequest(err.message) : err;
      });
    },
  ],
  // ---- health check do projeto: varredura de regras fixas (sem IA), só leitura ----
  ['GET', new RegExp(`^/api/projects/${ID}/health-check$`), async ({ params: [id] }) => {
    const dir = await projectPathOf(id!);
    return dir ? checkProjectHealth(dir) : null;
  }],
  // ---- arquivos do projeto (aba de arquivos): listar e ler; gravar só pelo Claudio’s Club ----
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/files/tree$`),
    async ({ params: [id], url }) => {
      const dir = await projectPathOf(id!);
      return dir ? listProjectTree(dir, url.searchParams.get('path') ?? '') : null;
    },
  ],
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/files/read$`),
    async ({ params: [id], url }) => {
      const dir = await projectPathOf(id!);
      return dir ? readProjectFile(dir, url.searchParams.get('path') ?? '') : null;
    },
  ],
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/files/image$`),
    async ({ params: [id], url }) => {
      const dir = await projectPathOf(id!);
      const img = dir ? await readProjectImageFile(dir, url.searchParams.get('path') ?? '') : null;
      return img ? new Raw(img.bytes, img.type) : null;
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/files/write$`),
    async ({ params: [id], body, fromBrowser }) => {
      if (!fromBrowser) throw new ProjectFileError(403, 'arquivos só são gravados pelo Claudio’s Club');
      const input = parseWriteBody(body);
      const dir = await projectPathOf(id!);
      return dir ? writeProjectFile(dir, input) : null;
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/files/create$`),
    async ({ params: [id], body, fromBrowser }) => {
      if (!fromBrowser) throw new ProjectFileError(403, 'arquivos só são criados pelo Claudio’s Club');
      const input = parseCreateBody(body);
      const dir = await projectPathOf(id!);
      return dir ? createProjectEntry(dir, input) : null;
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/files/delete$`),
    async ({ params: [id], body, fromBrowser }) => {
      if (!fromBrowser) throw new ProjectFileError(403, 'arquivos só são apagados pelo Claudio’s Club');
      const input = parseDeleteBody(body);
      const dir = await projectPathOf(id!);
      return dir ? deleteProjectEntry(dir, input.path) : null;
    },
  ],
  // ---- anexos do projeto (<projeto>/.myco/attachments): listar e baixar; enviar e apagar só pelo Claudio’s Club ----
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/attachments$`),
    async ({ params: [id] }) => {
      const dir = await projectPathOf(id!);
      return dir ? listAttachments(dir) : null;
    },
  ],
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/attachments/file$`),
    async ({ params: [id], url }) => {
      const dir = await projectPathOf(id!);
      const file = dir ? await readAttachment(dir, url.searchParams.get('name')) : null;
      return file ? new Raw(file.bytes, file.type, file.headers) : null;
    },
  ],
  [
    'POST',
    ATTACHMENT_UPLOAD,
    async ({ params: [id], url, body, fromBrowser }) => {
      if (!fromBrowser) throw new ProjectFileError(403, 'anexos só são enviados pelo Claudio’s Club');
      const dir = await projectPathOf(id!);
      return dir ? saveAttachment(dir, url.searchParams.get('name'), body, fromBrowser) : null;
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/attachments/delete$`),
    async ({ params: [id], body, fromBrowser }) => {
      if (!fromBrowser) throw new ProjectFileError(403, 'anexos só são apagados pelo Claudio’s Club');
      const dir = await projectPathOf(id!);
      const name = body && typeof body === 'object' ? (body as Record<string, unknown>).name : undefined;
      return dir ? deleteAttachment(dir, name, fromBrowser) : null;
    },
  ],
  ['GET', /^\/api\/account\/rules$/, () => readAccountRules()],
  [
    'POST',
    /^\/api\/account\/rules$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('as regras da conta só são editadas pelo Claudio’s Club');
      return saveAccountRules(parse(z.object({ text: z.string() }), body).text);
    },
  ],
  // ---- agents (subagents): criar e editar ----
  [
    'GET',
    /^\/api\/agents\/source$/,
    async ({ url }) => {
      const dir = await agentsDir(url.searchParams.get('scope'), url.searchParams.get('projectId'));
      const name = url.searchParams.get('name') ?? '';
      return dir ? readAgentSource(dir, name) : null;
    },
  ],
  [
    'POST',
    /^\/api\/agents\/save$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('agents só são editados pelo Claudio’s Club');
      const b = parse(z.object({ scope: z.enum(['project', 'user']), projectId: z.string().max(200).nullable().default(null) }), body);
      const dir = await agentsDir(b.scope, b.projectId);
      if (!dir) return null;
      return saveAgent(dir, parse(AgentInput, body), path.join(MYCO_HOME, 'backups', 'agents'));
    },
  ],
  ['GET', /^\/api\/user$/, () => adapter.getUserScope()],
  ['GET', /^\/api\/board$/, () => getBoard()],
  ['GET', /^\/api\/live$/, () => liveForBoard()],
  // Estado do código de cada projeto (git status, com cache curto); worktrees ficam de fora.
  [
    'GET',
    /^\/api\/git$/,
    async () => {
      const projects = (await adapter.listProjects()).filter((p) => p.exists && !p.worktreeOf);
      const states = await Promise.all(projects.map(async (p) => [p.id, await gitState(p.path)] as const));
      return Object.fromEntries(states.filter(([, s]) => s !== null));
    },
  ],
  // Arquivos sem commit do projeto, por conversa que os editou (só leitura; ver server/uncommitted.ts).
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/git/uncommitted$`),
    async ({ params: [pid] }) => {
      const dir = await projectPathOf(pid!);
      if (!dir) throw new BadRequest('projeto não encontrado');
      const [sessions, staff] = await Promise.all([adapter.getProjectSessions(pid!), listProjectStaff(dir, pid!)]);
      return uncommittedByConversation({
        projectPath: dir,
        sessions: sessions ?? [],
        staff,
        transcriptOf: (sid) => findTranscript(defaultTranscripts, pid!, sid),
      });
    },
  ],
  ['GET', /^\/api\/auth$/, ({ url }) => getAuthStatus({ fresh: url.searchParams.has('fresh') })],
  [
    'POST',
    /^\/api\/auth\/login$/,
    async ({ fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      return openLoginTerminal();
    },
  ],
  // Codex: instalar (npm, uma vez; quem já tem não roda) e entrar (abre o terminal do login). Só pelo navegador.
  ['POST', /^\/api\/codex\/install$/, ({ fromBrowser }) => codexSetup.install(fromBrowser)],
  ['POST', /^\/api\/codex\/login$/, async ({ fromBrowser }) => codexSetup.login(fromBrowser)],
  [
    'GET',
    /^\/api\/usage$/,
    async ({ url }) => {
      const [usage, config] = await Promise.all([readUsage(), readConfig()]);
      // Codex só com a opção ligada; o campo `codex` não existe quando desligada. Nunca lança nem trava os dados do Claude.
      // `?fresh=1` relê o login do Codex na hora (a tela pede isso enquanto espera o login).
      const codexField = await codexUsage.read(config.codexReview, { fresh: url.searchParams.has('fresh') });
      return { ...usage, boost: config.optimizeQuota ? quotaBoost(usage) : null, ...(codexField ? { codex: codexField } : {}) };
    },
  ],
  ['GET', /^\/api\/browser$/, ({ url }) => browserStatus(url.searchParams.has('fresh'))],
  ['GET', /^\/api\/costs$/, () => getCosts()],
  // Projeto demo (equipe e tarefas de exemplo em ~/.myco/demo). Criar de novo não sobrescreve:
  // só traz de volta ao quadro, se estava arquivado.
  [
    'POST',
    /^\/api\/demo$/,
    async ({ fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const demo = await createDemo();
      if ((await readConfig()).archived.projects.includes(demo.projectId)) {
        await setArchived({ kind: 'project', id: demo.projectId, archived: false });
      }
      adapter.forgetProjects();
      return { created: demo.created, projectId: demo.projectId };
    },
  ],
  // ---- "valeu a pena?" de uma sessão ----
  [
    'GET',
    new RegExp(`^/api/sessions/${ID}/orchestration$`),
    async ({ params: [sid] }) => {
      const { files, scanning } = await adapter.getSessionCostFiles(sid!);
      return buildOrchestration(sid!, await withRunInfo(files), await readMarks(sid!), scanning);
    },
  ],
  // Economia por sessão, para o ranking: `days` (1 a 3650) limita aos últimos dias; sem ele, desde sempre.
  [
    'GET',
    /^\/api\/savings$/,
    async ({ url }) => {
      const raw = url.searchParams.get('days');
      const days = raw === null ? null : /^\d{1,4}$/.test(raw) ? Number(raw) : 0;
      if (days !== null && (days < 1 || days > 3650)) throw new BadRequest('days deve ser um inteiro de 1 a 3650');
      const since = savingsSince(days);
      const { files, scanning } = await adapter.getSavingsFiles(since);
      return buildSavings(files, await readAllMarks(), since, scanning);
    },
  ],
  // Revisão de custo de um funcionário (botão "Analisar" do ranking): regras fixas, sem IA. `days` como em /api/savings.
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/cost-review$`),
    async ({ params: [id, staffId], url }) => {
      const days = parseCostReviewDays(url.searchParams.get('days'));
      if (days === null) throw new BadRequest(`days deve ser um inteiro de 1 a ${COST_REVIEW_MAX_DAYS}`);
      const dir = await projectPathOf(id!);
      if (!dir) return null;
      return buildCostReview({ projectPath: dir, projectId: id!, staffId: staffId!, days, transcriptsDir: defaultTranscripts, now: Date.now() });
    },
  ],
  // Aplicar as sugestões da revisão (botão "Aplicar"): só pelo Claudio’s Club (a guarda fica em costReviewApply.ts). Ficha pelo mesmo caminho da tela.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/cost-review/apply$`),
    async ({ params: [id, staffId], body, fromBrowser }) => {
      const dir = await projectPathOf(id!);
      if (!dir) return null;
      return runCostReviewApply({
        fromBrowser,
        body,
        projectPath: dir,
        projectId: id!,
        staffId: staffId!,
        transcriptsDir: defaultTranscripts,
        now: Date.now(),
        updateFicha: (fields) => staff.update(id!, staffId!, fields),
        createTask: async ({ staffId: sid, title, description }) => {
          const task = await tasks.create(id!, { title, description, staffId: sid });
          return task ? ((await tasks.start(id!, task.id)) ?? task) : null;
        },
      });
    },
  ],
  [
    'POST',
    new RegExp(`^/api/sessions/${ID}/marks$`),
    async ({ params: [sid], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const b = parse(MarkBody, body);
      return saveMark(sid!, b.runId, b.mark);
    },
  ],
  [
    'POST',
    /^\/api\/archive$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const req = ArchiveRequest.safeParse(body);
      if (!req.success) throw new BadRequest('pedido de arquivamento inválido');
      const config = await setArchived(req.data);
      // Temporário de volta ao quadro: os dias parado recomeçam a contar.
      if (!req.data.archived && req.data.id.startsWith('staff:')) await staff.restored(req.data.id.slice('staff:'.length));
      return config;
    },
  ],
  ['GET', /^\/api\/config$/, () => readConfig()],
  // Biblioteca de skills da conta (~/.myco/skills): só quem tem a skill na ficha carrega.
  ['GET', /^\/api\/skills\/library$/, () => listLibrary()],
  [
    'GET',
    /^\/api\/skills\/library\/([a-z0-9][a-z0-9-]{0,63})$/,
    async ({ params: [name] }) => {
      const s = await readLibrarySkill(name!);
      return s && { name: s.name, description: s.description, body: s.body, files: s.files, updatedAt: s.updatedAt };
    },
  ],
  [
    'POST',
    /^\/api\/skills\/library$/,
    ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      return saveLibrarySkill(body);
    },
  ],
  [
    'POST',
    /^\/api\/skills\/library\/import$/,
    ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const b = parse(z.object({ name: z.string().max(64) }), body);
      return copyToLibrary(b.name, path.join(defaultLocations().home, 'skills'));
    },
  ],
  [
    'POST',
    /^\/api\/skills\/library\/([a-z0-9][a-z0-9-]{0,63})\/delete$/,
    async ({ params: [name], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      return { ok: await removeLibrarySkill(name!) };
    },
  ],
  // Workspaces (abas do quadro): criar ou editar, remover, e o workspace de cada projeto.
  [
    'POST',
    /^\/api\/workspaces$/,
    ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      return saveWorkspace(body);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/workspaces/${ID}/delete$`),
    ({ params: [id], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      return removeWorkspace(id!);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/workspace$`),
    async ({ params: [id], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      if (!(await adapter.listProjects()).some((p) => p.id === id)) return null;
      const b = parse(z.object({ workspaceId: z.string().max(40).nullable() }), body);
      return setProjectWorkspace(id!, b.workspaceId);
    },
  ],
  [
    'POST',
    /^\/api\/config$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const patch = ConfigPatch.safeParse(body);
      if (!patch.success) throw new BadRequest(patch.error.issues[0]?.message ?? 'configuração inválida');
      return updateConfig(patch.data);
    },
  ],
];

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

async function onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  // Porta de entrada (server/gate.ts): Host, método, navegador pareado (ver pairing.ts), quem chama (socket e token da conversa) e as listas de rotas.
  // Aqui também ficam GET /api/pair (o link com o código), POST /api/pair/request|claim|approve (o botão "Parear este navegador" + `npm run pair
  // CÓDIGO`) e POST /api/pair/rotate (desparear todos).
  const admitted = gate(req, res, { pairing, tokens: sessionTokens, localHostnames: LOCAL_HOSTNAMES, isLocalOrigin, openApproval });
  if (!admitted) return;
  const { url, sandbox, fromBrowser, caller } = admitted;

  const stream = STREAM_ROUTE.exec(url.pathname);
  if (stream && req.method === 'GET') return serveChatStream(stream[1]!, Number(url.searchParams.get('after') ?? 0), req, res);
  if (url.pathname.startsWith('/api/')) {
    for (const [method, pattern, handler] of routes) {
      const m = pattern.exec(url.pathname);
      if (!m || method !== req.method) continue;
      try {
        // O envio de anexo manda os bytes do arquivo (até 10 MB) em vez de JSON.
        const body = method !== 'GET' ? (ATTACHMENT_UPLOAD.test(url.pathname) ? await readRaw(req, MAX_ATTACHMENT_BYTES) : await readJson(req)) : undefined;
        const userAgent = (req.headers['user-agent'] ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 80);
        const out = await handler({ params: m.slice(1), url, body, fromBrowser, paired: !sandbox && pairing.isPaired(req.headers.cookie), userAgent, caller });
        if (out === null) return send(res, 404, { error: 'não encontrado' });
        if (out instanceof Raw) {
          // no-cache + ETag: o navegador confere a cada vez, mas só baixa de novo se a imagem mudou.
          const etag = `"${createHash('sha1').update(out.bytes).digest('base64url')}"`;
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { etag, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
            return res.end();
          }
          res.writeHead(200, { 'content-type': out.type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', ...out.headers, etag });
          return res.end(out.bytes);
        }
        return send(res, 200, out);
      } catch (err) {
        if (err instanceof ProjectFileError) return send(res, err.status, { error: err.message, ...err.extra });
        if (err instanceof UsageStopError) return send(res, 409, { error: err.message, code: err.code, hit: err.hit });
        // Mescla recusada (sem testes, teste vermelho, conflito): 409 com o motivo; `no-tests` dá para confirmar.
        if (err instanceof CodeError) return send(res, 409, { error: err.message, code: err.code });
        // Ficha em uso (conversa trabalhando): 409, antes do StaffError genérico (400).
        if (err instanceof StaffOpenTasksError) return send(res, 409, { error: err.message, code: err.code, openTasks: err.openTasks });
        if (err instanceof StaffBusyError) return send(res, 409, { error: err.message });
        // Já há SPEC.md no projeto: a criação não sobrescreve (409 com `exists`).
        if (err instanceof GuideExistsError) return send(res, 409, { error: 'exists' });
        if (err instanceof Forbidden) return send(res, 403, { error: err.message });
        if (
          err instanceof BadRequest ||
          err instanceof CostReviewApplyError ||
          err instanceof StaffError ||
          err instanceof ChatError ||
          err instanceof TaskError ||
          err instanceof CodexError ||
          err instanceof RoleError ||
          err instanceof FileError ||
          err instanceof AgentError ||
          err instanceof WorkspaceError ||
          err instanceof SkillError ||
          err instanceof McpError ||
          err instanceof ProjectError ||
          err instanceof UpdateError ||
          err instanceof CodexSetupError ||
          (err as NodeJS.ErrnoException | null)?.code === 'EEXIST'
        ) {
          const message = (err as NodeJS.ErrnoException).code === 'EEXIST' ? 'já existe um arquivo com esse nome' : (err as Error).message;
          return send(res, err instanceof ChatError ? 409 : 400, { error: message });
        }
        console.error(err);
        return send(res, 500, { error: 'erro interno' });
      }
    }
    return send(res, 404, { error: 'rota desconhecida' });
  }
  if (req.method !== 'GET') return send(res, 405, { error: 'método não permitido' });
  if (await serveStartFiles(url.pathname, res)) return;
  return serveStatic(url.pathname, res);
}

const server = http.createServer(onRequest);
/** O mesmo servidor no 127.0.0.2: quem chega por ele é a sandbox do Codex (ver `onRequest`). */
const sandboxServer = http.createServer(onRequest);

const STREAM_ROUTE = new RegExp(`^/api/chat/${ID}/stream$`);

/** SSE da conversa: repete o que veio depois de `after` e segue ao vivo enquanto o processo existir. */
function serveChatStream(sessionId: string, after: number, req: http.IncomingMessage, res: http.ServerResponse) {
  if (!chats.has(sessionId)) return send(res, 404, { error: 'conversa não está aberta' });
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(': ok\n\n');
  const write = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const unsubscribe = chats.subscribe(sessionId, Number.isFinite(after) ? after : 0, write);
  // O ping mantém a conexão viva atrás de proxies (o do Vite, em desenvolvimento).
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe?.();
  });
}

/** Corpo binário até `limit` bytes; passou disso, 413 sem ler o resto. */
async function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const tooBig = () => new ProjectFileError(413, 'arquivo grande demais (máx. 10 MB)');
  if (Number(req.headers['content-length'] ?? 0) > limit) throw tooBig();
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw tooBig();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BadRequest('corpo grande demais');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest('JSON inválido');
  }
}

/** "Parear este navegador": terminal com `npm run pair CÓDIGO` pronto, que só pergunta e aprova (scripts/daily.ts). */
function openApproval(code: string): boolean {
  return openTerminal([process.execPath, TSX, DAILY, 'pair', code, '--port', String(PORT)], {
    title: 'Claudio’s Club - parear navegador',
    cwd: ROOT,
  }).ok;
}

function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // ferramentas locais (curl, um funcionário) não mandam Origin
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** Sessões vivas, marcadas com quem pediu o trabalho atual (as bolinhas na linha só na delegação). */
async function liveForBoard(): Promise<LiveSession[]> {
  return (await adapter.listLiveSessions()).map((s) => (chats.isDelegated(s.sessionId) ? { ...s, delegated: true } : s));
}

async function getBoard(): Promise<Board> {
  const [projects, user, live] = await Promise.all([
    adapter.listProjects(),
    adapter.getUserScope(),
    liveForBoard(),
  ]);
  const inventories: Board['inventories'] = {};
  const sessions: Board['sessions'] = {};
  const images: Board['images'] = {};
  const [staffList] = await Promise.all([
    staff.listAll(projects),
    ...projects.map(async (p) => {
      const [inv, list, image] = await Promise.all([
        adapter.getProjectInventory(p.id),
        adapter.getProjectSessions(p.id),
        p.exists ? projectImageUrl(p.id, p.path) : null,
      ]);
      if (inv) inventories[p.id] = inv;
      if (list) sessions[p.id] = list;
      if (image) images[p.id] = image;
    }),
  ]);
  // Conversa do Codex não tem transcript em ~/.claude/projects: cada id da ficha que ainda não está na lista vira uma sessão,
  // com o assunto e a hora do rollout (ver adapters/codex/rollout.ts). Entra antes do fold de worktree, que a trata igual.
  const listed = new Set(Object.values(sessions).flat().map((s) => s.id));
  const projectIds = new Set(projects.map((p) => p.id));
  const added: Record<string, number> = {};
  for (const f of staffList) {
    if (f.engine !== 'codex' || !projectIds.has(f.projectId)) continue;
    for (const entry of f.sessions) {
      if (listed.has(entry.id)) continue;
      listed.add(entry.id);
      if (!sessions[f.projectId]) sessions[f.projectId] = [];
      sessions[f.projectId]!.push(await codexSession(path.join(MYCO_HOME, 'run'), f.name, entry));
      added[f.projectId] = (added[f.projectId] ?? 0) + 1;
    }
  }
  for (const pid of Object.keys(added)) sessions[pid]!.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // Sessões de funcionário numa worktree própria contam como do projeto (onde está a ficha).
  const folded = projects.map((p) => ({ ...p, sessionCount: p.sessionCount + (added[p.id] ?? 0) }));
  for (const [child, parent] of mycoWorktreeParents(projects)) {
    const moved = sessions[child] ?? [];
    if (!moved.length) continue;
    sessions[parent] = [...(sessions[parent] ?? []), ...moved].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    sessions[child] = [];
    const pp = folded.find((p) => p.id === parent);
    const cp = folded.find((p) => p.id === child);
    if (pp && cp) {
      pp.sessionCount += cp.sessionCount;
      cp.sessionCount = 0;
    }
  }
  return { projects: folded, inventories, sessions, staff: staffList, images, user, live };
}

const INBOX_ORDER: Record<InboxKind, number> = { plan: 0, permission: 1, secret: 2, waiting: 3, error: 4, routine: 5, orphan: 6 };

/**
 * Tudo que espera você, de todas as salas: planos prontos e permissões pendentes das conversas
 * no Claudio’s Club, sessões esperando resposta em outro lugar (app, terminal), conversas que pararam com
 * erro e processos órfãos de um reinício. Arquivados ficam de fora.
 */
async function getInbox(): Promise<InboxItem[]> {
  const [projects, live] = await Promise.all([adapter.listProjects(), adapter.listLiveSessions()]);
  const { where, hidden } = await sessionPlacesNow(projects);

  const out: InboxItem[] = [];
  const liveById = new Map(live.map((l) => [l.sessionId, l]));
  for (const { sessionId, pending, error } of chats.attention()) {
    const w = where(sessionId, liveById.get(sessionId));
    if (hidden(w)) continue;
    for (const p of pending) out.push(permissionInboxItem(p, w));
    if (error) out.push({ id: `error:${sessionId}`, kind: 'error', ...w, summary: error, at: null });
  }
  // Terminou o turno perguntando algo no texto (sem pedido de permissão): espera até você responder.
  for (const q of chats.pendingQuestions()) {
    const w = where(q.sessionId, liveById.get(q.sessionId));
    if (!hidden(w)) out.push(questionInboxItem(q, w));
  }
  const orphans = await chats.orphans(live);
  const orphanIds = new Set(orphans.map((o) => o.sessionId));
  for (const o of orphans) {
    const w = where(o.sessionId, liveById.get(o.sessionId));
    if (!hidden(w)) out.push({ id: `orphan:${o.sessionId}`, kind: 'orphan', ...w, summary: 'processo de antes do reinício do Claudio’s Club: clique em Trazer', at: null });
  }
  const own = chats.ownPids();
  for (const l of live) {
    if (!l.alive || l.status !== 'waiting' || own.has(l.pid) || orphanIds.has(l.sessionId)) continue;
    // Dispensada por você: volta só quando o status mudar (outro statusUpdatedAt).
    if (inboxState.isWaitingDismissed(l.sessionId, l.statusUpdatedAt)) continue;
    const w = where(l.sessionId, l);
    if (hidden(w)) continue;
    const place = l.entrypoint === 'claude-desktop' ? 'no app do Claude' : l.entrypoint === 'sdk-cli' ? 'em outro programa' : 'num terminal';
    out.push({ id: `waiting:${l.sessionId}`, kind: 'waiting', ...w, summary: `esperando sua resposta ${place}`, at: l.statusUpdatedAt });
  }
  // Rotinas que não rodaram (trava de consumo, funcionário ocupado, sessão aberta em outro lugar).
  for (const a of routines.alerts()) {
    if (hidden({ projectId: a.projectId, staffId: a.staffId, sessionId: '' })) continue;
    out.push({
      id: `routine:${a.id}`,
      kind: 'routine',
      projectId: a.projectId,
      projectName: (await adapter.listProjects()).find((p) => p.id === a.projectId)?.name ?? '',
      sessionId: '',
      staffId: a.staffId,
      name: a.staffName,
      summary: `rotina "${a.routineName}" não rodou: ${a.text.replace(/^pulada: /, '')}`,
      at: a.at,
    });
  }
  // Segredos que apareceram nas conversas do Claudio’s Club (senha num comando, token colado…).
  for (const s of chats.secretHits()) {
    const w = where(s.sessionId, liveById.get(s.sessionId));
    if (!hidden(w)) out.push({ id: `secret:${s.id}`, kind: 'secret', ...w, summary: `${s.label} apareceu no chat: troque e não cole segredos na conversa`, at: s.at });
  }
  // Chave escrita no .mcp.json de um projeto: o arquivo vai para o git junto com o código.
  for (const p of projects.filter((x) => x.exists && !x.worktreeOf)) {
    if (hidden({ projectId: p.id, staffId: null, sessionId: '' })) continue;
    for (const s of await mcpJsonWarnings(p.path)) {
      if (inboxState.isMuted(`mcp:${p.id}:${s.server}`)) continue;
      out.push({
        id: `secret:mcp:${p.id}:${s.server}`,
        kind: 'secret',
        projectId: p.id,
        projectName: p.name,
        sessionId: '',
        staffId: null,
        name: `MCP ${s.server}`,
        summary: `${s.label} escrita no .mcp.json, que vai para o git: troque a chave e ponha \${VARIAVEL} no lugar dela`,
        at: null,
      });
    }
  }
  return out.sort((a, b) => INBOX_ORDER[a.kind] - INBOX_ORDER[b.kind] || (b.at ?? '').localeCompare(a.at ?? ''));
}

/** Turnos que terminaram desde `since`, com quem e onde (para o aviso "terminou"). */
async function getTurns(since: string | null): Promise<TurnNotice[]> {
  const done = turns.since(since);
  if (!done.length) return [];
  const [projects, live] = await Promise.all([adapter.listProjects(), adapter.listLiveSessions()]);
  const { where, hidden } = await sessionPlacesNow(projects);
  const liveById = new Map(live.map((l) => [l.sessionId, l]));
  return done.flatMap((d) => {
    const w = where(d.sessionId, liveById.get(d.sessionId));
    return hidden(w) ? [] : [{ id: d.id, ...w, text: d.text, at: d.at }];
  });
}

/** Dono e nome de cada sessão, e se ela fica de fora (arquivada, ou de projeto que não está no quadro). */
async function sessionPlacesNow(projects: Project[]) {
  const [config, staffList, off] = await Promise.all([readConfig(), staff.listAll(projects), adapter.offBoardRefs()]);
  return sessionPlaces(projects, staffList, new Set([...config.archived.sessions, ...config.archived.projects]), new Set(off.map((r) => r.id)));
}

/** As pastas do Claude Code fora do quadro, no formato que a "pasta sugerida" lê (existe? é worktree?). */
async function offBoardFolders() {
  const refs = await adapter.offBoardRefs();
  return Promise.all(refs.map(async (r) => ({ path: r.path, exists: await fs.stat(r.path).then(() => true, () => false), worktreeOf: worktreeParent(r.path) })));
}

/** Custos: a mesma dobra do quadro (worktree do Claudio’s Club soma no projeto principal). */
async function getCosts(): Promise<CostReport> {
  const [report, projects] = await Promise.all([adapter.getCosts(), adapter.listProjects()]);
  const out: CostReport = { ...report, projects: { ...report.projects } };
  for (const [child, parent] of mycoWorktreeParents(projects)) {
    const c = out.projects[child];
    if (!c) continue;
    const p = out.projects[parent] ?? { usd: 0, today: 0, last7d: 0, month: 0, sessions: {} };
    out.projects[parent] = {
      usd: p.usd + c.usd,
      today: p.today + c.today,
      last7d: p.last7d + c.last7d,
      month: p.month + c.month,
      sessions: { ...p.sessions, ...c.sessions },
    };
    delete out.projects[child];
  }
  return out;
}

/** Pasta de agents do projeto ou do usuário. */
async function agentsDir(scope: string | null, projectId: string | null): Promise<string | null> {
  if (scope === 'user') return path.join(defaultLocations().home, 'agents');
  if (scope !== 'project' || !projectId) return null;
  const p = await projectById(projectId);
  return p ? path.join(p.path, '.claude', 'agents') : null;
}

async function projectById(id: string) {
  const p = (await adapter.listProjects()).find((x) => x.id === id);
  return p?.exists ? p : null;
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveStatic(pathname: string, res: http.ServerResponse) {
  const requested = path.resolve(CLIENT_DIR, '.' + decodeURIComponent(pathname));
  const inside = requested === CLIENT_DIR || requested.startsWith(CLIENT_DIR + path.sep);
  // Só rota do app (sem extensão) cai no index.html. Arquivo que falta (ex.: /assets/x.js de um build quebrado) é 404:
  // devolver HTML no lugar do JS deixava a tela em branco, sem erro nenhum.
  if (inside && !(await isFile(requested)) && path.extname(pathname) !== '') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Arquivo não encontrado.');
    return;
  }
  const file = inside && (await isFile(requested)) ? requested : path.join(CLIENT_DIR, 'index.html');
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Cliente não compilado. Use `npm run dev` ou `npm run build`.');
  }
}

async function isFile(p: string): Promise<boolean> {
  return fs.stat(p).then((s) => s.isFile()).catch(() => false);
}

server.listen(PORT, HOST, () => {
  console.log(`Claudio’s Club em http://claudio.localhost:${PORT} (adaptador: ${adapter.id})`);
  // Só depois de ficar com a porta: o segundo endereço é o da sandbox do Codex. Se não abrir (no macOS o 127.0.0.2 pode faltar), quem roda no
  // Codex fica sem rede e a conversa avisa (ver `codexRunEnv`); o resto do app segue igual.
  sandboxServer.once('error', (err: NodeJS.ErrnoException) => {
    sandboxListener.up = false;
    sandboxListener.error = err.code ?? err.message;
    console.warn(`[servidor] não consegui escutar em ${SANDBOX_HOST}:${PORT} (${sandboxListener.error}): o Codex dos funcionários roda sem rede`);
  });
  sandboxServer.listen(PORT, SANDBOX_HOST, () => {
    sandboxListener.up = true;
    console.log(`[servidor] sandbox do Codex em ${SANDBOX_URL}`);
  });
  // Só quem conseguiu a porta limpa: um segundo servidor que falhou não mexe nos processos do outro.
  chats.cleanOrphans().catch((err) => console.error('[chat] limpeza de órfãos falhou:', err));
  // Só o servidor que ficou com a porta agenda: um segundo que falhou não dispara rotinas em dobro.
  routines.start();
  // Tarefas que trocaram de motor voltam ao secundário ANTES do "continue", do despertador e da fila: o override vive só na
  // memória, e sem ele a conversa cairia no motor da ficha. Se falhar, o erro vai para o log e o resto sobe igual.
  void tasks
    .restoreFallbacks()
    .catch((err) => console.error('[tarefas] motor secundário não reaberto:', err))
    .then(() => {
      // Só ele manda o "continue" das conversas que bateram no limite de uso (e o despertador).
      autoContinue.start();
      wakeups.start();
      // Fila de tarefas: quem ficou com tarefa ou ajuste esperando (ex.: o Claudio’s Club reiniciou no meio).
      const queueTick = () => void tasks.tick().catch(() => {});
      setTimeout(queueTick, 15_000).unref();
      setInterval(queueTick, 60_000).unref();
    });
  // Temporários parados há dias saem do quadro (arquivados, nada apagado).
  const sweep = () =>
    void staff
      .sweepTemporaries()
      .then((ended) => ended.forEach((s) => console.log(`[staff] ${s.name}: temporário arquivado (${s.ended?.reason})`)))
      .catch(() => {});
  setTimeout(sweep, 30_000).unref();
  setInterval(sweep, 60 * 60_000).unref();
  // Freelas (conversas sem ficha) parados há dias saem do quadro (arquivados, desarquivar vale): na subida e a cada 1 h.
  const sweepFree = () =>
    void sweepFreelas({ adapter, staff })
      .then((ids) => ids.length && console.log(`[freela] ${ids.length} conversa(s) sem ficha arquivada(s) por inatividade`))
      .catch(() => {});
  setTimeout(sweepFree, 45_000).unref();
  setInterval(sweepFree, 60 * 60_000).unref();
  // Configs de sessão antigas em ~/.myco/run (podem ter tokens de MCP): na subida e a cada 12 h.
  const cleanRun = () =>
    cleanRunDir(path.join(MYCO_HOME, 'run'))
      .then((n) => n && console.log(`[run] ${n} pasta(s) de sessão antiga(s) apagada(s) de ~/.myco/run`))
      .catch(() => {});
  void cleanRun();
  setInterval(cleanRun, 12 * 60 * 60_000).unref();
  // Novidades do Claudio’s Club no GitHub: na subida e a cada 6 h.
  updater.start();
});
