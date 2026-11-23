import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { clientChanged, DAILY, TSX, VITE } from '../scripts/lib';
import { openTerminal } from './terminal';
import { bodyText } from './bodyText';
import { CodexAdapter, CodexError, defaultRunner } from './adapters/codex';
import { CodexEnv, withAppAddress, type CodexEnvStatus } from './codexEnv';
import { CodexCapability } from './engineCapability';
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
  setConversationTitle,
  setProjectWorkspace,
  updateConfig,
  WorkspaceError,
  RetentionError,
  ConversationTitleError,
  ConversationTitleRequest,
  ConversationTitlesFullError,
} from './config';
import { PickerBusyError, pickFolder } from './folderPicker';
import { openProject, parseNewProject, ProjectError, usualParent } from './newProject';
import { legacyDemoPaths } from './legacyDemo';
import { z } from 'zod';
import { AgentError, AgentInput, readAgentSource, saveAgent } from './adapters/claude/agentWrite';
import { deleteSkill, hookFilesOf, readSkillSource, SkillDeleteInput, SkillRefInput, saveSkill, SkillSaveInput, type SkillScope } from './adapters/claude/skillWrite';
import { createSkill } from './skillCreate';
import { projectClaudeDir } from './adapters/claude/projects';
import { ChatClosingError, ChatError, ChatManager, CloseRefusedError, findTranscript } from './chat/manager';
import { ResumeFile, bootResume, resumeText } from './chat/resume';
import { AnnotationsField, AnswersField } from './chat/questions';
import { touchedFiles } from './chatChanges';
import { uncommittedByConversation } from './uncommitted';
import { searchConversations } from './chatSearch';
import { searchFiles } from './fileSearch';
import { CodeError, detectTest, locateCode, mergeCode, readCode, runTests } from './taskCode';
import { ChatRegistry } from './chat/registry';
import { AutoContinue } from './chat/autoContinue';
import { WakeBody, WakeStreakError, watchWakeups } from './chat/wake';
import { StaffSendLimitError, StaffSendRate, sendTargetKey } from './chat/sendRate';
import { StaffBusyError, StaffError, StaffOpenTasksError, StaffService, StaffTeamExistsError } from './staff/service';
import { sweepFreelas } from './freelaSweep';
import { CLUB_MCP_FILE, knownMcpNames, McpError, mcpJsonWarnings } from './staff/mcp';
import { createMcpLibrary } from './staff/mcpLibrary';
import { migrateMcpsAtBoot as runMcpMigration } from './staff/mcpMigration';
import { MCP_TOOLS_FILE } from './staff/mcpTools';
import { CodexPasswordPolicy } from './codexPasswordPolicy';
import { withInboxWait } from './inboxWait';
import { commitInboxAlerts, commitWaitingCount, resolveBy, withCommitLeft } from './commitLeft';
import { blockedInboxItem, codexSandboxInboxItem, commitInboxItem, deniedInboxItem, followUpInboxItem, heavyGuardOffInboxItem, notStartedInboxItem, permissionInboxItem, questionInboxItem, secretInboxItem, stuckInboxItem, taskQuestionInboxItem, versionPauseEndId, versionPauseItems, withoutSecretHint } from './inboxItems';
import { InboxResolver, resolvedLast, settleWithin } from './inboxResolved';
import { capText } from './chat/turnCap';
import { TurnRetryLedger } from './chat/turnRetry';
import { InboxState } from './inboxState';
import { readServerLog } from './staff/serverLog';
import { LIBRARY_DIR, readLibrarySkill, SkillError } from './skillLibrary';
import { convertStaffSkills, migrateLibraryToGlobal } from './skillMigration';
import { migrateProjectAgents } from './staff/presetMigration';
import { skillSourcesOf } from './skillAccess';
import { applyUpdate, checkUpdate, GitHubInstallBatchInput, GitHubInstallInput, GitHubPreviewInput, GitHubSkillInput, GitHubStatusQuery, GitHubUpdateInput, githubSkillsIn, installBatch, installSkill, previewSkill, rollback, SkillConflictError, UpdateChecker, type InstallTarget } from './skillInstall';
import { GitHubError, GitHubRateLimited } from './adapters/github/client';
import { FileError, projectImageUrl, readAccountRules, readProjectImage, saveAccountRules, saveProjectImage } from './files';
import { createGuide, GuideExistsError, guideStatus, readShowcase } from './projectGuide';
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
} from './projectFiles';
import { openEditorRoute } from './openInEditor';
import { openProjectTerminalRoute } from './openProjectTerminal';
import { actingStaff, requesterSessionOf, SANDBOX_HOST, SessionTokens, type Caller } from './callers';
import { isUnverifiedOrigin, staffOrigin, type OriginDeps } from './chat/origin';
import { RequesterAskLimiter } from './chat/requesterAsk';
import { gate, refusalLine } from './gate';
import { sessionAllowed, sessionInProject, type SessionScopeDeps } from './sessionScope';
import { EXTENSION_DIR, EXTENSION_ID } from './extension/identity';
import { ExtensionTokens } from './extension/tokens';
import { handleExtension, type ExtensionDeps } from './extension/routes';
import { buildExtensionZip, ExtensionPackError } from './extension/zip';
import { CodexUsageReader, codexLimitHit, readInstalled } from './codexUsage';
import { CodexSetup, CodexSetupError } from './codexSetup';
import { readUsage } from './usage';
import { claudeLimitHit, UsageStopError } from './usageStop';
import { UsageWarnings } from './usageWarn';
import { quotaBoost } from './quotaBoost';
import { browserStatus } from './browser';
import { gitState } from './git';
import { buildOrchestration, buildSavings, MarkBody, readAllMarks, readMarks, saveMark, savingsSince, withRunInfo } from './orchestration';
import { buildCostReview, COST_REVIEW_MAX_DAYS, parseCostReviewDays } from './costReview';
import { CostReviewApplyError, runCostReviewApply } from './costReviewApply';
import type { Board, CommitWaitingSummary, CostReport, InboxItem, InboxKind, LiveSession, Project, TurnNotice } from '../shared/model';
import { TurnWatcher } from './turns';
import { ProjectPauses } from './projectPause';
import { FlowPolicies } from './flowPolicy';
import { deliverToAsker } from './consult/deliver';
import { ConsultLinks } from './consult/links';
import { ConsultError, ConsultService } from './consult/service';
import { ConsultStore } from './consult/store';
import { RoutineScheduler, routineKey, type RoutineOutcome } from './routines';
import { buildSchedules, routineSchedule, ScheduleWindowError, scheduleWindow } from './scheduleView';
import type { AppServerInfo, EngineOverride, Routine, SchedulesResponse, StaffProfile, SystemStats } from '../shared/model';
import { systemStats } from './systemStats';
import { PresenceBody, TabPresence } from './tabPresence';
import { ResourceGate } from './resourceGate';
import { ShowcaseBusyError, ShowcaseRefusedError, ShowcaseRunner, spawnClaudeProcess } from './showcaseRunner';
import { pathKey, worktreeParent } from './adapters/claude/paths';
import { codexSession, rolloutStat, rolloutUpdatedAt } from './adapters/codex/rollout';
import { readSessionRegistry, REGISTRY_FILE } from './sessionsRegistry';
import { TitleService } from './titles/generator';
import { codexUsageOf } from './adapters/codex/usage';
import type { TranscriptCost } from './adapters/claude/costs';
import { claudeFilesBy, taskCostOf, taskCostRanking, type CostSources } from './taskCost';
import { TtlCache } from './ttlCache';
import { StageTimer } from './stageTimer';
import { boardFilter } from './board';
import { mycoWorktreeParents, sessionPlaces } from './sessionPlaces';
import { importableList, importProjects } from './importProjects';
import { AUTONOMY, dropStaffSessions, hasStaffFiles, listProjectStaff, listProjectStaffStrict, readProfile, saveProfile } from './staff/store';
import { StateBusyError } from './atomicWrite';
import { lastRetentionRun, nextRetentionDelay, retentionPreview, runRetentionSweep, setRetentionDeletion, type RetentionDeps } from './retentionSweep';
import { readPersonMemory, savePersonMemory } from './staff/personalMemory';
import { writeOwnerFile } from './ownerEdits';
import { START_DEADLINE_MS, TaskBusyError, TaskConflictError, TaskError, TaskForbiddenError, TaskService, cancelRequest, commitAlerts, deleteRequest, followUpAlerts, notStartedTasks, ownAlerts, readTasks, reasonRequest, stuckDependencies } from './tasks';
import { retainedSessionIds } from './retention';
import { listRoles, removeRole, restoreBuiltins, RoleError, saveRole, setDefaultRole } from './roles';
import { ROOT } from './root';
import { cleanRunDir } from './runCleanup';
import { SelfUpdater, UpdateError } from './selfUpdate';
import { pendingRestartCheck } from './pendingRestart';
import { CLUB_PORT } from './clubAddress';
import { Pairing } from './pairing';
import type { LimitHit } from './chat/usageLimit';
import { collectGit } from './fallbackHandoff';
import { DirectFallback, ownerMaySwitch, restoreDirectFallbacks } from './directFallback';

const PORT = CLUB_PORT;
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
/** Pedido de retomada das conversas em turno: gravado ao reiniciar, apagado por Parar e pelo boot (ver server/chat/resume.ts). */
const resumeFile = new ResumeFile(path.join(MYCO_HOME, 'run', 'resume.json'));

/**
 * Fecha as conversas (sem deixar processos órfãos) e sai. `stop`: o vigia não religa. Sem `stop`, grava o pedido de
 * reinício: só com ele o vigia refaz o pacote e sobe o código novo (saída sem pedido é queda: sobe a mesma versão).
 * Reiniciando, quem estava em turno fica no pedido de retomada e o boot reabre a conversa.
 */
async function shutdown(stop: boolean, userAgent = '') {
  // Parar grava o arquivo mesmo durante um reinício em curso: o vigia, ao ver o arquivo, não religa.
  if (stop && UNDER_DAEMON) await fs.writeFile(path.join(MYCO_HOME, 'run', 'daemon.stop'), '').catch(() => {});
  // Parar nunca agenda retomada, nem a de um reinício em curso (o pedido dele não é gravado depois disto).
  if (stop) await resumeFile.stop().catch(() => {});
  if (leaving) return;
  leaving = true;
  console.log(`[servidor] ${stop ? 'parando' : 'reiniciando'} a pedido do config${userAgent ? ` (${userAgent})` : ''}`);
  // Nada novo entra daqui em diante: o build abaixo leva até 2 min com o servidor no ar.
  if (!stop) {
    chats.closing();
    // As pendências do "continue", do despertador e da retomada por falha passageira ficam no disco e disparam no boot (o `start` delas).
    autoContinue.stop();
    wakeups.stop();
    turnRetries.stop();
  }
  if (!stop && UNDER_DAEMON) {
    await fs.writeFile(path.join(MYCO_HOME, 'run', 'daemon.restart'), '').catch(() => {});
    await buildBeforeRestart();
  }
  // Depois do build: quem está em turno agora é o que volta sozinho (o turno que acabou no build não precisa).
  if (!stop) {
    try {
      const sessions = await chats.busySessions();
      if (await resumeFile.save(sessions, Date.now())) console.log(`[servidor] ${sessions.length} conversa(s) em turno: voltam sozinhas quando o servidor subir`);
    } catch (err) {
      console.error('[servidor] não consegui gravar as conversas em turno:', err);
    }
  }
  await Promise.race([Promise.all([chats.stopAll(), showcases.stopAll(), titles.stopAll()]), new Promise((r) => setTimeout(r, 5000))]);
  process.exit(0);
}
// Parado por sinal (npm run daily:stop, o vigia religando, tsx watch): as conversas são líderes do próprio
// grupo de processos e não morreriam junto; ficariam órfãs, presas no meio do turno.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.once(signal, () => {
    console.log(`[servidor] ${signal}: fechando as conversas`);
    void Promise.race([Promise.all([chats.stopAll(), showcases.stopAll(), titles.stopAll()]), new Promise((r) => setTimeout(r, 5000))]).then(() => process.exit(0));
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
const requesterAskLimiter = new RequesterAskLimiter();
/** Mensagens de funcionários por conversa de destino (em memória): o freio contra laço, ver sendRate.ts. */
const staffSendRate = new StaffSendRate();
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
/** Pareamentos da extensão do Chrome (token Bearer; só o hash vai ao disco). */
const extensionTokens = new ExtensionTokens();
/** Abas do Claudio’s Club abertas (sinal da tela): com `stopOnTabClose`, a última a fechar para o servidor pelo mesmo caminho do botão Parar. */
const tabs = new TabPresence({
  enabled: async () => (await readConfig()).stopOnTabClose,
  stop: () => {
    console.log('[servidor] nenhuma aba do Claudio’s Club aberta: parando (opção "parar ao fechar a aba")');
    void shutdown(true, 'nenhuma aba aberta');
  },
});

// No quadro: o demo que já existe na máquina (o projeto demo saiu do produto, mas a pasta é do usuário: ver legacyDemo.ts), as pastas de
// `extraProjects` (novas ou importadas) e os projetos com equipe. O resto do que o Claude Code conhece só entra se o usuário importar
// (`/api/import-projects`).
const pinnedProjects = async () => [...(await legacyDemoPaths()), ...(await readExtraProjects())];
/** Ids das conversas do Claude que o Club lançou (o registro; sem registro legível, nenhuma). */
const clubClaudeIds = async (): Promise<Set<string>> => {
  const reg = await readSessionRegistry().catch((): Map<string, { engine: string }> => new Map());
  return new Set([...reg].filter(([, e]) => e.engine === 'claude').map(([id]) => id));
};
const adapter: ToolAdapter = new ClaudeAdapter({
  // O resumo dos projetos lê todo transcript (segundos com centenas de conversas) e quase toda rota passa por ele (`projectPathOf`): guardado por 5 s.
  // Novo projeto e importação chamam `forgetProjects`; o apelido nem entra no que fica guardado.
  projectsTtlMs: 5_000,
  extraPaths: pinnedProjects,
  onBoard: boardFilter({ pinned: pinnedProjects }),
  projectNames: async () => (await readConfig()).projectNames,
  // Retenção: conversa sem atividade há mais dias que isso sai da lista (sem ler o arquivo); `?old=1` traz de volta.
  archiveAfterDays: async () => (await readConfig()).archiveAfterDays,
  keepSessions: retainedOf,
  // Conversas do Club: o assunto vem do rastreador (ver titles/tracker.ts), que acha a virada no meio do transcript.
  clubSessions: clubClaudeIds,
});
/** `?old=1` na rota: lista também as conversas antigas (arquivadas pela retenção). */
const includeOld = (url: URL) => url.searchParams.get('old') === '1';
/**
 * /api/board lê head/tail de todo transcript: guardado por 5 s (por `old`). Esquecido quando o Club muda algo (qualquer escrita na API,
 * conversa que recebe mensagem ou termina o turno/sai); conversa aberta fora do Club aparece em até 5 s. Sem checar mtime de pasta
 * (no Windows ela não muda quando o transcript ganha linha). `live` é relido a cada chamada (barato) para o "trabalhando" não atrasar.
 */
const boardCache = new TtlCache<Board>(5_000);
/** Conversas que a retenção nunca arquiva no projeto (ver server/retention.ts). Lê ficha e tarefas do disco, sem efeito colateral. */
async function retainedOf(projectId: string, projectPath: string): Promise<Set<string>> {
  return retainedSessionIds(await listProjectStaff(projectPath, projectId), await readTasks(projectPath));
}
/** A exclusão da retenção (ver retentionSweep.ts): as mesmas fontes que o quadro usa. Só lê o que as closures pedem, na hora. */
/** Horário da última varredura da retenção (sobrevive a reinícios). */
const retentionLastRun = path.join(MYCO_HOME, 'retention-last-run.json');
const retentionDeps: RetentionDeps = {
  claudeHome: defaultLocations().home,
  runDir: path.join(MYCO_HOME, 'run'),
  lastRunFile: retentionLastRun,
  projects: () => adapter.listProjects(),
  // Fichas lidas por inteiro: uma que não carrega tira o projeto da varredura (ver retentionSweep.ts).
  staffOf: (project) => listProjectStaffStrict(project.path, project.id),
  liveSessions: () => adapter.listLiveSessions(),
  // Protegidas: abertas (em turno, na fila ou ociosas), e com despertador ou auto-continue pendente. Ler a pendência não quarentena:
  // arquivo estragado LANÇA e a varredura aborta.
  busy: async () =>
    new Set([...chats.runningSessionIds(), ...(await autoContinue.sessionIdsStrict()), ...(await wakeups.sessionIdsStrict()), ...(await turnRetries.sessionIdsStrict())]),
  codex: { deleteThread: (threadId) => codex.deleteThread(threadId) },
  dropStaffSession: (projectPath, staffId, sessionId) => dropStaffSessions(projectPath, staffId, [sessionId]),
  forgetTitles: (ids) => titles.forget(ids),
  log: (line) => console.log(line),
};
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
// Sandbox e agents do Codex antes de uma troca de motor (ver engineCapability.ts). O runner é o do CodexEnv; `chats` é lido só na chamada.
const codexCapability = new CodexCapability(defaultRunner(), { liveCodex: () => chats.codexRunning() });
// Política de senha do Windows que quebra o sandbox do Codex (só avisa a caixa; nunca altera a política, ver codexPasswordPolicy.ts). Fora do Windows não faz nada.
const codexPolicy = new CodexPasswordPolicy();
/** Vínculos de consulta entre projetos (só a tela grava) e o registro das consultas, que sobrevive a reinício (ver server/consult/). */
const consultLinks = new ConsultLinks(path.join(MYCO_HOME, 'consult', 'links.json'));
const consultStore = new ConsultStore(path.join(MYCO_HOME, 'consult', 'records.json'));
const staff: StaffService = new StaffService(adapter, {
  runDir: path.join(MYCO_HOME, 'run'),
  // A seção Consulta da ficha: só os projetos que o dono liberou a este funcionário (sem vínculo, a ficha fica como antes).
  consultTargets: async (projectId, staffId) => {
    const ids = await consultLinks.targetsOf(projectId, staffId);
    if (!ids.length) return [];
    const known = await adapter.listProjects();
    return ids.flatMap((id) => {
      const p = known.find((x) => x.id === id && x.exists);
      return p ? [{ projectId: p.id, projectName: p.name }] : [];
    });
  },
  codexCapability,
  // Ficha do Codex contratada ou salva: a checagem prévia da política de senha (com cache; sem esperar).
  onCodexProfile: () => void codexPolicy.check(),
  // Conversas lançadas pelo Club (fora de run/, que a limpeza apaga): base da exclusão futura (ver sessionsRegistry.ts).
  sessionsFile: REGISTRY_FILE,
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
/**
 * Projetos pausados (ver server/projectPause.ts): uma só fonte, perguntada por todo ponto de partida automática (a fila em TaskService, as rotinas, o "continue", o
 * despertador, a retomada de turno e a do reinício). Pausado, nada de execução começa sozinho (a revisão da entrega já feita roda); o que já roda termina o turno, e as suas ações manuais seguem.
 */
// A pausa de versão que venceu volta tudo ao normal sozinha: a rodada do projeto roda na hora (encerrar e retomar já fazem isso pela rota; converter em comum segue pausado).
const projectPauses = new ProjectPauses(path.join(MYCO_HOME, 'paused-projects.json'), undefined, (projectId, end) => {
  if (end.reason === 'expired') tasks.resumeAfterExpiry(projectId);
});
const projectPaused = (projectId: string) => projectPauses.isPaused(projectId);
/** Dispensa o aviso de saída da pausa de versão (id `vpause:<projeto>:end:<ms>`). O aviso "ligada" não se dispensa (sai com a pausa): false. */
async function dismissVersionPause(id: string): Promise<boolean> {
  const end = versionPauseEndId(id);
  return end ? projectPauses.dismissEnd(end.projectId, end.atMs) : false;
}
/**
 * A política de fluxo de cada projeto (ver server/flowPolicy.ts): quem leva a tarefa a "pronto" (a IA, pelo revisor, ou só o dono), quem aprova o plano e o commit automático. Em `~/.myco`, fora do
 * projeto (o agente não grava ali); só a rota `flow-policy`, pela tela, a muda.
 */
const flowPolicies = new FlowPolicies(path.join(MYCO_HOME, 'flow-policies.json'));
const autoContinue = new AutoContinue({
  file: path.join(MYCO_HOME, 'auto-continue.json'),
  enabled: async () => (await readConfig()).autoContinue,
  stopHit: usageStopHit,
  knownResets: async () => (await readUsage()).limits,
  send: (p) => chats.continueChat(p.projectId, p.sessionId, p.staffId),
  paused: projectPaused,
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
  paused: projectPaused,
  tickMs: 2_000,
  spacingMs: 2_000,
  log: (line) => console.log(`[despertador] ${line}`),
});
/**
 * Retomada do turno que falhou por causa passageira (API sobrecarregada, 5xx, limite de taxa, falha de conexão) ou cujo processo morreu no meio
 * (ver chat/turnRetry.ts). Terceira instância do agendador, com arquivo próprio e a opção `autoRetry`: só espera o horário e manda o texto; quem
 * decide retomar (ação externa cortada, despertador, parada) é o ChatManager. O orçamento de tentativas por turno também fica em disco.
 */
const turnRetries = new AutoContinue({
  file: path.join(MYCO_HOME, 'turn-retries.json'),
  enabled: async () => (await readConfig()).autoRetry,
  stopHit: usageStopHit,
  knownResets: async () => (await readUsage()).limits,
  send: (p) => chats.retryChat(p),
  paused: projectPaused,
  log: (line) => console.log(`[retomada] ${line}`),
});
const turnLedger = new TurnRetryLedger(path.join(MYCO_HOME, 'turn-retry.json'));

const chats: ChatManager = new ChatManager({
  // O aviso de segredo achar o arquivo que um comando leu (vários no mesmo comando): precisa da raiz do projeto para nada fora dela ser aberto.
  projectDirOf: (projectId) => projectPathOf(projectId),
  // Plano B de quem roda no Codex: a conta recusou o modelo da ficha, o turno é refeito com o mais parecido do catálogo.
  codexModels: async () => (await codexModels.list()).models,
  // Antes de cada execução do Codex: o recurso `network_proxy` presente e o 127.0.0.2 de pé (senão roda sem rede e avisa) e a versão mínima.
  codexEnv: () => codexRunEnv(),
  // A sandbox do Codex quebrou numa conversa: as próximas conferências de troca esperam (ver CodexCapability.reportFailure).
  onCodexSandboxFailure: (text) => codexCapability.reportFailure(text),
  // Conversa do Codex abrindo: checagem prévia da política de senha; o erro do usuário do sandbox na saída de uma ferramenta leva o mesmo aviso à caixa.
  onCodexOpen: () => void codexPolicy.check(),
  onCodexPasswordPolicyFailure: () => void codexPolicy.noteFailure(),
  tokens: sessionTokens,
  autoContinue,
  wakeups,
  retries: turnRetries,
  retryLedger: turnLedger,
  inbox: inboxState,
  contextSwitch: async () => (await readConfig()).contextSwitch,
  // Teto por turno (ferramentas e minutos): lido a cada turno, mudança vale sem reiniciar (0 = desligado).
  turnCaps: async () => {
    const c = await readConfig();
    return { maxTools: c.maxTurnTools, maxMinutes: c.maxTurnMinutes };
  },
  quotaBoost: currentBoost,
  // A conversa de uma tarefa fica onde está: o quadro (revisão, ajustes, mescla) segue por ela.
  keepSession: (sessionId) => tasks.isTaskSession(sessionId),
  denialTask: (sessionId) => tasks.denialTask(sessionId),
  heavyGuardOff: (sessionId) => tasks.noteHeavyGuardOff(sessionId),
  transcriptsDir: defaultTranscripts,
  // O histórico do Codex não diz o projeto: o snapshot só o lê da conversa que o servidor prova ser do projeto (ver sessionScope).
  sessionInProject: (projectId, sessionId) => sessionInProject(sessionScope, projectId, sessionId),
  runDir: path.join(MYCO_HOME, 'run'),
  usageFile: path.join(MYCO_HOME, 'usage.json'),
  // Limite do Codex estourado: a hora de voltar vem da leitura fresca dos limites do Codex (só com `codexReview` ligado).
  codexLimits: async () => codexUsage.read((await readConfig()).codexReview, { fresh: true, waitMs: 8_000 }),
  listLive: () => adapter.listLiveSessions(),
  resolve: (projectId, sessionId, staffId, forkFrom, engineOverride, reviewOnly, consult) => staff.chatSpawn(projectId, sessionId, staffId, forkFrom, engineOverride, reviewOnly, consult),
  // A conversa de consulta de outro projeto terminou o turno: o serviço lê a resposta e a entrega (`consults` é declarado mais abaixo: só é lido na chamada).
  onConsultIdle: (consultId, sessionId, reason) => void consults.onIdle(consultId, sessionId, reason).catch((err) => console.warn('[consulta] fim de turno:', err)),
  rememberChoice: (projectId, staffId, sessionId, choice) => staff.rememberChoice(projectId, staffId, sessionId, choice),
  markModelObsolete: (projectId, staffId, model, engine) => staff.markModelObsolete(projectId, staffId, model, engine),
  registry: new ChatRegistry(path.join(MYCO_HOME, 'run', 'chats.json')),
  copiesFile: path.join(MYCO_HOME, 'run', 'copies.json'),
  onPlanApproved: (sid, plan) => void tasks.onPlanApproved(sid, plan).catch((err) => console.error('[tarefas] plano aprovado:', sid, err)),
  onPlanRejected: (sid) => void tasks.onPlanRejected(sid).catch(() => {}),
  onAsk: (sid, rid, qs) => void tasks.onAsk(sid, rid, qs).catch(() => {}),
  onAskAnswered: (sid, rid, by, summary) => void tasks.onAskAnswered(sid, rid, by, summary).catch(() => {}),
  onSent: (sid) => {
    boardCache.invalidate();
    void tasks.onSent(sid).catch(() => {});
  },
  // Toda alteração de código de uma conversa sem tarefa vira um card (ver TaskService.onCodeEdit). Registro, não trava: a escrita já foi.
  onEdit: (edit) => void tasks.onCodeEdit(edit).catch((err) => console.error('[tarefas] card automático:', err)),
  // Você fechou a conversa de uma tarefa no meio do turno: a tarefa vai para Aguardar antes de o processo sair (senão a saída a entregaria para revisão).
  beforeClose: async (sid) => {
    await tasks.parkClosed(sid);
    boardCache.invalidate();
  },
  // Ficou livre: os ajustes guardados e a próxima tarefa da fila dele.
  onIdle: (sid, pid, staffId, reason, engine) => {
    boardCache.invalidate();
    // Turno de conversa do Claudio’s Club: o aviso "terminou" vem daqui, na hora exata (o vigia lê as sessões
    // de tempos em tempos e perde turno curto).
    if (reason === 'turn') turns.noteDone(sid);
    void tasks.onIdle(sid, pid, staffId, reason, engine).catch(() => {});
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
/** Fontes do custo por tarefa (ver server/taskCost.ts): transcripts do Claude, o registro do Club (threadId) e o uso do Codex. */
async function taskCostSources(files: TranscriptCost[]): Promise<CostSources> {
  const registry = await readSessionRegistry().catch((): Map<string, { threadId?: string }> => new Map());
  return { claudeFiles: claudeFilesBy(files), registry, codexUsage: (threadId) => codexUsageOf(threadId) };
}
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

/** O limite de um motor agora (o do provedor, 100%); 'unknown' se não deu para ler. A troca de tarefa e a conversa direta leem igual. */
const readLimitOf = async (engine: 'claude' | 'codex'): Promise<LimitHit | null | 'unknown'> => {
  if (engine === 'codex') {
    const usage = await codexUsage.read((await readConfig()).codexReview, { fresh: true, waitMs: 8_000 }).catch(() => null);
    return usage ? codexLimitHit(usage) : 'unknown';
  }
  const usage = await readUsage().catch(() => null);
  return usage && usage.limits.length ? claudeLimitHit(usage) : 'unknown';
};

/** Abre uma conversa nova com o funcionário e manda o texto. Sem `force`, confere o consumo antes. Usado pelas tarefas e pelas ações do guia. */
const sendNewConversation = async (projectId: string, staffId: string, text: string, force: boolean, override?: EngineOverride, reviewOnly = false) => {
  // Lenta (2 s ou mais), escreve no log quanto levou a trava de consumo e quanto levou abrir a conversa (ver stageTimer.ts).
  const timer = new StageTimer(`abrir conversa de ${staffId}`);
  try {
    // A trava confere o motor que a conversa vai usar: o do override (Claude→Codex não cai na trava do Claude; Codex→Claude
    // respeita a do Claude). Sem override, é a do motor da ficha, como sempre.
    timer.stage('consumo');
    if (!force) await staff.checkUsage(projectId, { staffId, ...(override && { engine: override.engine }) });
    timer.stage('abrir');
    return await chats.send(projectId, null, staffId, text, undefined, [], [], false, undefined, override, reviewOnly);
  } finally {
    timer.finish();
  }
};

// Gate de recursos da fila (RAM, CPU e teto de conversas; ver resourceGate.ts). A config é lida a cada partida.
const resourceGate = new ResourceGate({ config: () => readConfig(), activeTurns: () => chats.activeTurns() });
// Vitrine: o gerador oculto (ver showcaseRunner.ts). Motor Claude: a trava de consumo é a do Claude (`engine: 'claude'`).
const showcases = new ShowcaseRunner({
  spawnClaude: spawnClaudeProcess,
  checkUsage: (projectId) => staff.checkUsage(projectId, { engine: 'claude' }),
  reserve: () => resourceGate.reserve(),
  log: (line) => console.log(line),
});
// Títulos das conversas do Club com assunto livre (ver titles/generator.ts). Mesma trava de consumo da vitrine (motor Claude).
const titles = new TitleService({
  spawnClaude: spawnClaudeProcess,
  checkUsage: (projectId) => staff.checkUsage(projectId, { engine: 'claude' }),
  claudeProjectsDir: defaultTranscripts,
  rolloutOf: async (sessionId) => (await rolloutStat(path.join(MYCO_HOME, 'run'), sessionId))?.file ?? null,
  clubClaude: clubClaudeIds,
  enabled: async () => (await readConfig()).aiTitles,
  log: (line) => console.log(line),
});
const tasks = new TaskService({
  projectPath: projectPathOf,
  // Versão das skills que a ficha marca no registro de execuções (ver tasks.ts, skillsOf).
  skillSources: (projectId) => skillSourcesOf(adapter, projectId),
  projectIds: async () => (await adapter.listProjects()).filter((p) => p.exists && !p.worktreeOf).map((p) => p.id),
  readProfile: async (projectId, staffId) => {
    const dir = await projectPathOf(projectId);
    return dir ? readProfile(dir, staffId) : null;
  },
  send: sendNewConversation,
  apiUrl: `http://127.0.0.1:${PORT}`,
  sandboxApiUrl: SANDBOX_URL,
  // A pergunta por opções ainda aberta na conversa de trabalho, e a resposta do gestor (vai à conversa do funcionário).
  hasAsk: (sid, rid) => chats.hasPending(sid, rid),
  answerAsk: (sid, rid, answers, by) => chats.answer(sid, rid, true, { answers, by: by ?? 'manager' }),
  dismissQuestion: (sid) => void chats.dismissQuestion(sid),
  branchFor: async (dir, profile) => (profile.worktree ? `myco/${profile.id}` : ((await gitState(dir))?.branch ?? null)),
  isWorking: (projectId, staffId, except) => chats.staffWorking(projectId, staffId, except),
  isTurning: (projectId, staffId, except) => chats.staffTurning(projectId, staffId, except),
  isSessionWorking: (sessionId) => chats.isWorking(sessionId),
  // Só a partida automática da fila passa pelo gate (o start à mão não): sem RAM, CPU ou vaga, a tarefa espera na fila.
  resourceGate: () => resourceGate.reserve(),
  // Reiniciando: fim de turno não conclui tarefa (ver tasks.ts `closing`).
  closing: () => chats.isClosing(),
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
  // O título que você deu à conversa: o card automático (ver TaskService.onCodeEdit) nasce com ele.
  conversationTitle: async (sessionId) => (await readConfig()).conversationTitles?.[sessionId] ?? null,
  // O consumo já foi conferido quando você mandou (a mensagem só esperou a vez).
  // Com carimbo (mensagem guardada de outro funcionário), vai como delegada: a marca vai junto, como no envio direto.
  sendTo: (projectId, sessionId, staffId, text, images, origin) => chats.send(projectId, sessionId, staffId, text, 'next', images, [], !!origin, origin),
  // Aviso da plataforma (pedido de cancelamento ao responsável): não conta como resposta sua nem tira o "continue" agendado.
  sendNotice: (projectId, sessionId, staffId, text) => chats.sendNotice(projectId, sessionId, staffId, text),
  secondOpinion: (input) => codex.review(input),
  // Turno que parou no limite de uso, com o "continue" agendado, não é entrega.
  // Também com despertador marcado: o funcionário ainda está acompanhando algo, não entregou.
  awaitingLimit: async (sessionId) => (await chats.awaitingLimit(sessionId)) || !!(await wakeups.get(sessionId)),
  // Turno que terminou com agent ou comando em segundo plano ainda rodando não é entrega: o card segue em "fazendo" até o turno que vem depois do término (ver TaskService.holdBackground).
  liveWork: (sessionId) => chats.liveWork(sessionId),
  // Turno que falhou por causa passageira: a decisão de retomar sai antes do fim do turno ser lido; a retomada marcada aparece em `Task.retry`.
  settleRetry: (sessionId) => chats.settledRetry(sessionId),
  retryOf: (sessionId) => chats.retryOf(sessionId),
  // Permissão esperando a sua resposta (o cartão `permission` pendente da conversa de trabalho): vai em `Task.permissionWait`; só leitura.
  permissionOf: (sessionId) => chats.permissionWaitOf(sessionId),
  // Turno que parou no teto de ferramentas ou de minutos: vai para Aguardar, não para revisão (o motivo fica guardado antes da interrupção).
  turnCap: (sessionId) => chats.turnCapOf(sessionId),
  // Turno que terminou em erro do motor (login recusado, erro que não passa sozinho): vai para Aguardar, não para revisão (ver ChatManager.turnEnded).
  engineStop: (sessionId) => chats.engineStopOf(sessionId),
  holdEngine: (sessionId) => chats.holdEngineStop(sessionId),
  restartCut: (projectId, sessionId) => chats.restartCut(projectId, sessionId),
  setOverride: (sessionId, override) => chats.setOverride(sessionId, override),
  // O limite de cada motor agora (ver taskFallback.ts). Sem leitura, 'unknown': não troca às cegas.
  readLimit: readLimitOf,
  settleLimit: (sessionId) => chats.settledLimit(sessionId),
  // A linha de parada 5h/7d da empresa conta para a troca de motor (o orçamento do projeto não: espera, como antes).
  stopHit: usageStopHit,
  // Tira o "continue" e o despertador da conversa antiga: ela não volta sozinha no motor principal. Devolve a hora do despertador.
  cancelContinue: async (sessionId) => {
    const wake = await wakeups.get(sessionId);
    await autoContinue.cancel(sessionId, 'fallback');
    await wakeups.cancel(sessionId, 'fallback');
    await turnRetries.cancel(sessionId, 'fallback');
    return wake ? wake.at : null;
  },
  // Pré-checagem da troca: a conversa no motor do override abriria? (as barreiras do envio, sem gravar nada).
  assertRunnable: (projectId, staffId, override, exceptSession) => staff.assertOverrideRunnable(projectId, staffId, override, exceptSession),
  clearOverride: (sessionId) => chats.clearOverride(sessionId),
  stopSession: (sessionId) => chats.stop(sessionId),
  // A revisão que deu o veredito fecha o processo (liberar memória): só parada, pelo fechamento seguro (`close`); trabalhando, o serviço tenta ao fim do turno.
  closeIfIdle: async (sessionId) => {
    const { working } = await chats.closeIdle((c) => c.sessionId === sessionId);
    boardCache.invalidate();
    return working === 0;
  },
  // Tarefa cancelada: o turno em andamento para como no botão Parar do chat (a conversa continua aberta, com o histórico).
  interruptSession: (sessionId) => chats.interrupt(sessionId),
  // E o plano (ou a permissão) que ficou pendente na conversa é negado: interromper não tira o cartão, e aprovar depois executaria.
  dismissPending: (sessionId, message) => void chats.dismissPending(sessionId, message),
  snapshot: (projectId, sessionId) => chats.snapshot(projectId, sessionId),
  // Projeto pausado: a fila, o ajuste da reprovação, a retomada das órfãs e a troca de motor esperam; a revisão da entrega já feita roda (ver TaskService.paused).
  pauses: projectPauses,
  flow: flowPolicies,
});
// Conversa direta no limite de uso (o dono pela tela): a mensagem segue no secundário da ficha, numa conversa nova (ver directFallback.ts).
const directFallback = new DirectFallback({
  readProfile: async (projectId, staffId) => {
    const dir = await projectPathOf(projectId);
    return dir ? readProfile(dir, staffId) : null;
  },
  readLimit: readLimitOf,
  stopHit: usageStopHit,
  assertRunnable: (projectId, staffId, override, exceptSession) => staff.assertOverrideRunnable(projectId, staffId, override, exceptSession),
  snapshot: (projectId, sessionId) => chats.snapshot(projectId, sessionId),
  git: async (projectId, staffId) => {
    const dir = await projectPathOf(projectId);
    const profile = dir ? await readProfile(dir, staffId) : null;
    if (!dir || !profile) return null;
    const place = await locateCode(dir, profile.id, !!profile.worktree).catch(() => null);
    return collectGit(place?.path ?? dir).catch(() => null);
  },
  // Como na tarefa (cancelContinue): o "continue" da antiga sai com o motivo 'fallback'.
  cancelContinue: async (sessionId) => {
    await autoContinue.cancel(sessionId, 'fallback');
    await turnRetries.cancel(sessionId, 'fallback');
  },
  send: (projectId, sessionId, staffId, text, priority, images, files, override) =>
    chats.send(projectId, sessionId, staffId, text, priority, images, files, false, undefined, override),
  log: (line) => console.log(`[chat] ${line}`),
});
/**
 * A consulta de funcionário a funcionário entre projetos (ver server/consult/service.ts): o vínculo é do dono (só a tela grava), a conversa de consulta abre no projeto de destino só para ler
 * (sem token, sem aprovação, sem MCP; ver StaffService.consultSpawn) e a resposta final volta à conversa de quem perguntou, como informação de outro projeto.
 */
const consults = new ConsultService({
  links: consultLinks,
  store: consultStore,
  project: async (projectId) => {
    const p = (await adapter.listProjects()).find((x) => x.id === projectId && x.exists && !x.worktreeOf);
    return p ? { id: p.id, name: p.name } : null;
  },
  staff: async (projectId, staffId) => {
    const dir = await projectPathOf(projectId);
    const p = dir ? await readProfile(dir, staffId) : null;
    return p ? { id: p.id, name: p.name, role: p.role, ended: !!p.ended } : null;
  },
  listStaff: async (projectId) => {
    const dir = await projectPathOf(projectId);
    return dir ? (await listProjectStaff(dir, projectId)).filter((s) => !s.ended && !s.temporary).map((s) => ({ id: s.id, name: s.name, role: s.role })) : [];
  },
  paused: (projectId) => projectPauses.isPaused(projectId),
  // A trava de uso do projeto de destino (a conversa de consulta gasta o orçamento dele).
  checkUsage: (projectId, staffId) => staff.checkUsage(projectId, { staffId }),
  openConsult: (projectId, staffId, text, stamp) => chats.send(projectId, null, staffId, text, undefined, [], [], false, undefined, undefined, false, stamp),
  isConsultSession: (sessionId) => chats.isConsultSession(sessionId),
  lastText: (sessionId) => chats.lastAssistantText(sessionId),
  turn: (sessionId) => chats.consultTurn(sessionId),
  closeSession: async (sessionId) => void (await chats.closeIdle((c) => c.sessionId === sessionId)),
  stopSession: (sessionId) => chats.stop(sessionId),
  // A resposta (ou o aviso) na conversa de quem perguntou: a trava de uso dele confere; em outra tarefa, espera a vez (guardada, como a resposta a uma dúvida); conversa fechada, reabre.
  // `sendNotice` é mensagem da plataforma: não "responde" a tarefa em revisão nem tira o "continue" agendado.
  deliver: deliverToAsker({
    checkUsage: (projectId, staffId) => staff.checkUsage(projectId, { staffId }),
    hold: (sessionId, msg) => tasks.hold(sessionId, msg),
    sendNotice: (projectId, sessionId, staffId, text) => chats.sendNotice(projectId, sessionId, staffId, text),
  }),
  isClosing: () => chats.isClosing(),
});
// O relógio da consulta: vence o prazo e entrega o que ficou esperando (resposta ou aviso). Também no boot: o registro sobrevive ao reinício.
const consultTick = () => {
  if (!chats.isClosing()) void consults.tick().catch((err) => console.warn('[consulta] relógio:', err));
};
consultTick();
setInterval(consultTick, 15_000).unref();
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

/** De quem é cada conversa, para o que um funcionário (com token) lê ou escreve pelo id dela (ver server/sessionScope.ts). */
const sessionScope: SessionScopeDeps = {
  live: (sessionId) => chats.liveProject(sessionId),
  transcriptIn: (projectId, sessionId) => chats.hasOwnTranscript(projectId, sessionId),
  taskProject: (sessionId) => tasks.projectOfSession(sessionId),
  staffOwns: (projectId, sessionId) => staff.ownsSession(projectId, sessionId),
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
// Retomada de turno que falhou que não vai sair (cancelada por Parar, opção desligada, envio que falhou): a tarefa é entregue como antes (o
// turno que falhou vale como fim), só com a conversa parada. As outras saídas (mensagem sua, teto, reinício) têm quem trate o fim do turno.
watchWakeups(
  turnRetries,
  (sessionId) => chats.isWorking(sessionId),
  (sessionId) => void tasks.onTurnDone(sessionId).catch(() => {}),
);

// Rotinas: no horário, a mensagem vai ao funcionário pelo mesmo caminho do chat do painel.
const routines = new RoutineScheduler({
  file: path.join(MYCO_HOME, 'routines.json'),
  listStaff: () => scheduledStaff(),
  run: runRoutine,
  paused: projectPaused,
});

/** As fichas cujas rotinas o agendador vê (as arquivadas ficam de fora): as de todos os projetos, ou só as de `projectId`. */
async function scheduledStaff(projectId?: string): Promise<StaffProfile[]> {
  const [projects, config] = await Promise.all([adapter.listProjects(), readConfig()]);
  const archived = new Set([...config.archived.projects, ...config.archived.sessions]);
  const all = await staff.listAll(projects.filter((p) => p.exists && !archived.has(p.id) && (!projectId || p.id === projectId)));
  return all.filter((s) => !archived.has(`staff:${s.id}`));
}

/** Depois de gravar rotinas na ficha: o agendador arma as novas e esquece as apagadas já, sem esperar o tick. Falha dele não desfaz a gravação. */
async function routinesSaved(profile: StaffProfile): Promise<void> {
  await routines.sync(profile).catch((err) => console.warn(`[rotina] não consegui armar as rotinas de ${profile.name}: ${err instanceof Error ? err.message : String(err)}`));
}

/** Uma rotina como a tela central a vê, já com o estado do agendador. */
async function routineView(profile: StaffProfile, routineId: string) {
  const r = profile.routines?.find((x) => x.id === routineId);
  return r ? routineSchedule(profile, r, await routines.snapshot(routineKey(profile.projectId, profile.id, r.id)), new Date()) : null;
}

/**
 * Uma rotina disparando (`minute`: o minuto PREVISTO dela, que também é a chave da tarefa de rotina, mesmo numa execução atrasada).
 * As mesmas travas do chat valem, mas não há a quem perguntar: passou da
 * trava de consumo ou do orçamento, a rotina é pulada (e o aviso vai para a caixa). Também não
 * começa com o funcionário trabalhando ou com a sessão aberta em outro lugar.
 * Modo `task`: sem checagem aqui; a tarefa é criada antes, e o `start` põe na fila se o consumo barrar.
 */
async function runRoutine(profile: StaffProfile, r: Routine, minute: string): Promise<RoutineOutcome> {
  if (r.mode === 'task') return runRoutineAsTask(profile, r, minute);
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

/**
 * Rotina de tarefa: cria no quadro já na fila dele (idempotente por minuto e por tarefa aberta) e manda o funcionário andar a fila.
 * A partida é do `takeNext`, com o gatilho 'routine'; se o servidor cair antes do kick, o tick do boot pega a tarefa.
 */
async function runRoutineAsTask(profile: StaffProfile, r: Routine, minute: string): Promise<RoutineOutcome> {
  const made = await tasks.createFromRoutine(profile.projectId, profile.id, r, minute);
  if (made.kind === 'open') return { ok: false, text: `pulada: a anterior ainda está aberta (${made.task.id})` };
  if (made.kind === 'repeated') return { ok: true, text: `já criada neste minuto (${made.task.id})` };
  await tasks.kickStaff(profile.projectId, profile.id);
  return { ok: true, text: `tarefa ${made.task.id} criada na fila de ${profile.name}` };
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
// Resposta do gestor à dúvida da tarefa (ver TaskService.answerQuestion): `answers` por pergunta; `text` na dúvida escrita; `escalate` passa a você.
const TaskAnswerBody = z.object({
  questionId: z.string().min(1).max(100),
  answers: z.record(z.string().max(500), z.union([z.string().max(500), z.array(z.string().max(500)).max(20)])).optional(),
  text: z.string().max(2_000).optional(),
  escalate: z.boolean().optional(),
});

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequest(r.error.issues[0]?.message ?? 'pedido inválido');
  return r.data;
}

/** `confirm`: você sabe que a conversa está trabalhando e quer fechá-la mesmo assim (ver `ChatManager.close`). */
const CloseBody = z.object({ confirm: z.boolean().optional() }).strict();
const ArchiveBody = ArchiveRequest.extend({ confirm: z.boolean().optional() });

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

/** Resposta 202 (aceito): a consulta nova foi aberta e a resposta vem depois, na conversa de quem perguntou. */
class Accepted {
  constructor(readonly body: unknown) {}
}

class BadRequest extends Error {}
/** O pedido é de quem não pode (403). */
class Forbidden extends Error {}
class RateLimited extends Error {}

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

/**
 * A conversa do URL é do projeto do URL? Confere antes de ler ou escrever qualquer coisa pelo id dela (histórico, mensagem guardada, envio): o token
 * só alcança o projeto dele, mas o id da conversa vem do pedido. Funcionário (com token): a prova completa, também para conversa fechada (ver
 * server/sessionScope.ts). Sem token (a tela, que sempre manda o projeto certo): só a conversa aberta de outro projeto é recusada.
 */
async function assertSessionOf(caller: Caller | null, method: string, url: URL, projectId: string, sessionId: string): Promise<void> {
  if (await sessionAllowed(sessionScope, !!caller, projectId, sessionId)) return;
  console.log(refusalLine({ status: 403, reason: 'conversa-de-outro-projeto', method, pathname: url.pathname, projectId, caller }));
  throw new Forbidden(
    'essa conversa não é deste projeto (ou não existe nele): o token da sua conversa só alcança as conversas do projeto dela. Se precisa de algo de outro projeto, peça ao usuário',
  );
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
  // ---- consulta entre projetos (server/consult/) ----
  // Vínculo, revogação e leitura: só a tela (as rotas `/api/consult/*` não estão em apiPolicy.ts `STAFF_POSTS`: o gate já recusa o POST de funcionário e a sandbox). O serviço confere `fromBrowser` de novo.
  [
    'GET',
    /^\/api\/consult\/links$/,
    async ({ paired }) => {
      if (!paired) throw new BadRequest('só pelo Claudio’s Club');
      return { links: await consults.listLinks() };
    },
  ],
  ['POST', /^\/api\/consult\/links$/, async ({ body, fromBrowser }) => ({ link: await consults.setLink(fromBrowser, body) })],
  ['POST', /^\/api\/consult\/links\/revoke$/, async ({ body, fromBrowser }) => consults.revokeLink(fromBrowser, body)],
  [
    'GET',
    /^\/api\/consult\/records$/,
    async ({ url, paired }) => {
      if (!paired) throw new BadRequest('só pelo Claudio’s Club');
      return { consults: await consults.listRecords(url.searchParams.get('project') ?? undefined) };
    },
  ],
  // Do funcionário (token do projeto de origem; a origem e o remetente vêm do token, nunca do corpo): o diretório (só id, nome e cargo) e a consulta.
  ['GET', new RegExp(`^/api/projects/${ID}/consult/directory$`), async ({ params: [pid], caller }) => ({ projects: await consults.directory(caller, pid!) })],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/consult$`),
    async ({ params: [pid], body, caller }) => {
      const out = await consults.start(caller, pid!, body);
      return out.replay ? out : new Accepted(out);
    },
  ],
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
  // Conta também os projetos do Claude Code que ficaram fora do quadro: quem só tem o demo antigo ainda recebe a pasta onde trabalha.
  ['GET', /^\/api\/new-project$/, async () => ({ parent: usualParent([...(await adapter.listProjects()), ...(await offBoardFolders())]) })],
  [
    'POST',
    /^\/api\/new-project$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const input = parseNewProject(body);
      // O workspace antes da pasta: um id errado não deixa pasta criada para trás.
      if (input.workspaceId && !(await readConfig()).workspaces.some((w) => w.id === input.workspaceId)) throw new BadRequest('workspace não encontrado');
      // Modelo de equipe (`templateId`, já conferido contra a lista): pasta existente que já tem equipe recusa (409) antes de abrir qualquer coisa.
      if (input.templateId && input.mode === 'existing' && (await hasStaffFiles(path.resolve(input.path)))) throw new StaffTeamExistsError();
      const opened = await openProject(input);
      await addExtraProject(opened.path);
      adapter.forgetProjects();
      const project = (await adapter.listProjects()).find((p) => pathKey(p.path) === pathKey(opened.path));
      if (!project) throw new BadRequest('a pasta não entrou na lista de projetos');
      if (input.workspaceId) await setProjectWorkspace(project.id, input.workspaceId);
      // Estava arquivado: abrir de novo traz de volta ao quadro.
      if ((await readConfig()).archived.projects.includes(project.id)) await setArchived({ kind: 'project', id: project.id, archived: false });
      // Só as fichas e a hierarquia, na mesma chamada (ver `applyTeamTemplate`). Se falhar aqui, o projeto já está aberto, sem equipe: a tela pode aplicar o modelo de novo.
      const team = input.templateId ? await staff.applyTeamTemplate(project.id, { templateId: input.templateId }, true) : null;
      return { created: opened.created, projectId: project.id, ...(team && { team }) };
    },
  ],
  // "Novo projeto → pasta que já existe": abre a janela nativa de escolher pasta nesta máquina (o navegador não entrega o caminho absoluto) e devolve
  // `{ path }`, `{ cancelled: true }` (fechou a janela ou passou o prazo) ou `{ unsupported: true }` (sem ferramenta: a tela usa o campo de texto). Um por vez: 409.
  // Sem corpo: nada do pedido entra no comando (server/folderPicker.ts). Fora da lista dos funcionários (apiPolicy.ts), então só a tela chega aqui.
  [
    'POST',
    /^\/api\/new-project\/pick-folder$/,
    async ({ fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      return pickFolder({ log: (line) => console.warn(`[pasta] ${line}`) });
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
  [
    'GET',
    new RegExp(`^/api/projects/${ID}$`),
    async ({ params: [id], url }) => {
      const detail = await adapter.getProject(id!, { includeOld: includeOld(url) });
      return detail && { ...detail, sessions: await titles.annotate(id!, 'claude', detail.sessions) };
    },
  ],
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
  // Equipe em arquivo (server/staff/teamExport.ts): exportar lê, sem segredo; importar só pela tela, tudo ou nada. Antes da rota de edição: "import" casaria como id.
  ['GET', new RegExp(`^/api/projects/${ID}/staff/export$`), ({ params: [id], url }) => staff.exportTeam(id!, url.searchParams.get('ids'))],
  ['POST', new RegExp(`^/api/projects/${ID}/staff/import$`), ({ params: [id], body, fromBrowser }) => staff.importTeam(id!, body, fromBrowser)],
  // Modelo de equipe (shared/teamTemplates.ts): `{ templateId }` cria só as fichas e a hierarquia (nenhuma tarefa, nada começa). Só pela tela; 400 modelo
  // desconhecido, 404 projeto fora do quadro, 409 (`code: 'team-exists'`) se o projeto já tem funcionário. Antes da rota de edição: "template" casaria como id.
  ['POST', new RegExp(`^/api/projects/${ID}/staff/template$`), ({ params: [id], body, fromBrowser }) => staff.applyTeamTemplate(id!, body, fromBrowser)],
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
    async ({ params: [pid, sid], url, caller }) => {
      await assertSessionOf(caller, 'GET', url, pid!, sid!);
      return { ...(await chats.snapshot(pid!, sid!)), held: await tasks.heldItems(sid!) };
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/chat/send$`),
    async ({ params: [pid], url, body, fromBrowser, caller }) => {
      const b = parse(SendBody, body);
      // Primeiro a prova de que a conversa (e o funcionário) são deste projeto, antes de qualquer contagem, guarda ou envio: o token só chega ao
      // projeto dele (gate), mas o id da conversa vem do corpo (ver assertSessionOf).
      if (b.sessionId) await assertSessionOf(caller, 'POST', url, pid!, b.sessionId);
      if (!fromBrowser && b.staffId) {
        const dir = await projectPathOf(pid!);
        if (!dir || !(await readProfile(dir, b.staffId))) throw new BadRequest('esse funcionário não é deste projeto');
      }
      const target = { sessionId: b.sessionId, staffId: b.staffId };
      const requesterAsk = await tasks.mayAskRequester(pid!, caller, target);
      // Um limite por par: quem pergunta (sessão do remetente) e a conversa que responde.
      const askKey = requesterAsk && caller ? `${pid!}:${caller.sessionId}:${b.sessionId}` : '';
      if (requesterAsk) {
        const limit = requesterAskLimiter.check(askKey, b.text, b.images.length > 0 || b.files.length > 0);
        if (limit === 'too-large') throw new BadRequest('a dúvida para quem pediu a tarefa deve ter no máximo 4 KB');
        if (limit === 'attachments') throw new BadRequest('a dúvida para quem pediu a tarefa aceita só texto');
        if (limit === 'rate-limited') throw new RateLimited('aguarde um minuto antes de perguntar de novo a quem pediu a tarefa');
      } else {
        await checkReach(caller, pid!, target);
      }
      // Freio contra laço entre funcionários (ver sendRate.ts): o dono zera a janela da conversa; funcionário com token conta (429 na 21ª).
      const rateKey = sendTargetKey(pid!, b.sessionId, b.staffId);
      if (fromBrowser) staffSendRate.reset(rateKey);
      else if (caller) staffSendRate.count(rateKey);
      // Trava de consumo. Conversa que já roda no secundário confere o motor dela, não o da ficha.
      const onFallback = b.sessionId ? chats.overrideOf(b.sessionId) : undefined;
      let barred: UsageStopError | null = null;
      if (!(fromBrowser && b.force)) {
        try {
          await staff.checkUsage(pid!, { staffId: b.staffId, ...(onFallback && { engine: onFallback.engine }) });
        } catch (err) {
          if (!(err instanceof UsageStopError)) throw err;
          barred = err;
        }
      }
      // Barrada pela janela 5h/7d, com o dono pela tela numa conversa direta: segue no secundário da ficha, numa conversa nova
      // (ver server/directFallback.ts). Orçamento, sem secundário ou troca que não abre: o erro de antes.
      if (barred) {
        const taskConversation = !!b.sessionId && (await tasks.isTaskConversation(b.sessionId));
        if (!ownerMaySwitch({ fromBrowser, force: b.force, staffId: b.staffId, onFallback: !!onFallback, taskConversation })) throw barred;
        const priority = b.priority ?? (await readConfig()).sendWhileBusy;
        return directFallback.switchOnLimit({ projectId: pid!, sessionId: b.sessionId, staffId: b.staffId!, text: b.text, priority, images: b.images, files: b.files, barred });
      }
      // De outro funcionário, quem manda é o dono do token (nunca o corpo): o carimbo vai junto, também se a mensagem ficar guardada.
      const origin = fromBrowser ? undefined : await staffOrigin(originDeps, pid!, caller, b.staffId);
      // Dúvida ao gestor sem ficha de quem manda: não segue, porque o carimbo não teria quem mandou.
      if (requesterAsk && origin && isUnverifiedOrigin(origin)) throw new Forbidden('a dúvida ao gestor exige a ficha de quem pergunta');
      // Usage/profile reads above await; recheck immediately before sending so a task closed meanwhile loses this route.
      if (requesterAsk && !(await tasks.mayAskRequester(pid!, caller, target))) {
        throw new Forbidden('a tarefa que autorizava a dúvida já não está ativa');
      }
      // Reserva o slot só agora, sem await até o envio. Se o envio falhar, devolve o slot.
      const releaseAsk = requesterAsk ? requesterAskLimiter.reserve(askKey) : null;
      if (requesterAsk && !releaseAsk) throw new RateLimited('aguarde um minuto antes de perguntar de novo a quem pediu a tarefa');
      // Ajuste numa tarefa anterior com ele ocupado em outra: espera a vez (ver tasks.ts).
      if (!requesterAsk && b.sessionId && b.staffId) {
        // Você (navegador) respondendo a uma pergunta dele: guardada, ela sai da caixa na hora (a de outro funcionário não responde por você).
        // Fora do navegador a mensagem é de outro funcionário (`auto`): com o projeto pausado ela espera ser retomado; a sua, do navegador, nunca espera por isso.
        const held = await tasks.hold(b.sessionId, { text: b.text, images: b.images, origin, ...(fromBrowser ? { byOwner: true as const } : { auto: true as const }) });
        if (held) return { sessionId: b.sessionId, held };
      }
      const priority = requesterAsk ? 'next' : b.priority ?? (await readConfig()).sendWhileBusy;
      try {
        // Fora do navegador, quem manda é outro funcionário (o gestor, pela API): delegação. Pelo Claudio’s Club,
        // a mensagem pode seguir numa conversa nova se o assunto da atual fechou (ver contextPolicy.ts).
        const sessionId = fromBrowser
          ? await chats.sendFromUser(pid!, b.sessionId, b.staffId, b.text, priority, b.images, b.files)
          : await chats.send(pid!, b.sessionId, b.staffId, b.text, priority, b.images, b.files, true, origin);
        return { sessionId };
      } catch (err) {
        releaseAsk?.();
        throw err;
      }
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
  // Agendamentos do projeto, para a tela central: despertadores e "continue" do limite (`items`), as rotinas das fichas (`routines`, com
  // próxima ocorrência, estado e histórico) e as ocorrências de `?from=&to=` para o calendário. Só pelo Claudio’s Club (ver SchedulesResponse).
  // O GET da própria página não leva `Origin` (o navegador só manda em POST e em pedido de outra origem): `fromBrowser` nunca vale aqui,
  // e era o que fazia o botão Agendamentos dar erro. A prova de ser a tela é o cookie do pareamento (`paired`, como em /api/inbox).
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/schedules$`),
    async ({ params: [pid], url, paired }) => {
      if (!paired) throw new BadRequest('só pelo Claudio’s Club');
      const now = new Date();
      let window: ReturnType<typeof scheduleWindow>;
      try {
        window = scheduleWindow(url.searchParams.get('from'), url.searchParams.get('to'), now);
      } catch (err) {
        throw err instanceof ScheduleWindowError ? new BadRequest(err.message) : err;
      }
      const [items, staffList] = await Promise.all([chats.listSchedules(pid!), scheduledStaff(pid!)]);
      const built = await buildSchedules(staffList, (key) => routines.snapshot(key), window, now);
      const out: SchedulesResponse = {
        items,
        routines: built.routines,
        occurrences: built.occurrences,
        window: { from: window.from.toISOString(), to: window.to.toISOString(), truncated: built.truncated },
        stateWarning: routines.warning(),
      };
      return out;
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
    async ({ params: [pid, sid], url, caller }) => {
      await assertSessionOf(caller, 'GET', url, pid!, sid!);
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
      // A pasta de trabalho inteira, sem tarefa e pelo clique do dono: o único caminho que mescla o branch todo (`wholeBranch`); a mescla de uma tarefa vai até o commit da entrega.
      return mergeCode(dir, place, `Trabalho de ${profile?.name ?? 'funcionário'}`, { skipTests: b.skipTests, wholeBranch: true });
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
    async ({ params: [pid, sid], url, caller }) => {
      await assertSessionOf(caller, 'GET', url, pid!, sid!);
      return chats.mcp(pid!, sid!, url.searchParams.get('staffId'));
    },
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
      return searchConversations(targets, q, (await readConfig()).conversationTitles);
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
  // O palpite e a dica mascarada do segredo só vão para a tela (navegador pareado): agente e curl recebem o aviso sem eles.
  ['GET', /^\/api\/inbox$/, async ({ paired }) => (paired ? await getInbox() : withoutSecretHint(await getInbox()))],
  // Quantos avisos de commit parcial esperam outro card terminar (`autoCommit.state` 'waiting'): só ciência, fora da lista da caixa e do sino. Só leitura, com o mesmo acesso da caixa.
  ['GET', /^\/api\/inbox\/commit-waiting$/, () => getCommitWaiting()],
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
  // Com `inboxWait`: o card parado esperando um item da caixa (derivado, ver server/inboxWait.ts).
  // E `commitLeft`: o estado do aviso de commit parcial do card (waiting, ready ou failed; derivado, ver server/commitLeft.ts).
  ['GET', new RegExp(`^/api/projects/${ID}/tasks$`), async ({ params: [id] }) => tasks.commitLeftOf(id!, withInboxWait(await tasks.list(id!), id!, chats.attention()))],
  // Refazer o commit das sobras de uma tarefa pronta (ver `TaskService.redoLeftovers`): o GET mostra os arquivos, o diff e o `digest`; o POST `{ digest }` faz o commit complementar. Só pela tela
  // (o serviço responde 403 a quem não é a tela; o gate já barra o POST de funcionário e as rotas nem estão na lista de apiPolicy.ts). 404 se o projeto ou a tarefa não existem; 409 com o motivo se não dá.
  ['GET', new RegExp(`^/api/projects/${ID}/tasks/${ID}/commit-leftovers$`), ({ params: [id, taskId], fromBrowser }) => tasks.previewLeftovers(id!, taskId!, fromBrowser)],
  ['POST', new RegExp(`^/api/projects/${ID}/tasks/${ID}/commit-leftovers$`), ({ params: [id, taskId], body, fromBrowser }) => tasks.redoLeftovers(id!, taskId!, body, fromBrowser)],
  // Revisão automática do quadro: `{ autoReview, reviewerId }` (ver server/boardConfig.ts). Ler é livre; gravar só pela tela, como as outras
  // configurações de projeto (o funcionário nem tem este POST na lista de apiPolicy.ts).
  ['GET', new RegExp(`^/api/projects/${ID}/board-review$`), ({ params: [id] }) => tasks.boardConfig(id!)],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/board-review$`),
    ({ params: [id], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('a revisão do quadro só é configurada pelo Claudio’s Club');
      return tasks.setBoardConfig(id!, body);
    },
  ],
  // Commit automático do projeto: `{ autoCommit }` (ver server/boardConfig.ts e TaskService.autoCommit). Como a revisão do quadro: ler é livre, gravar só pela tela (o serviço responde 403
  // a quem não é a tela; o gate já barra o POST de quem não é o navegador antes de chegar aqui) e o funcionário nem tem este POST na lista de apiPolicy.ts.
  ['GET', new RegExp(`^/api/projects/${ID}/board-commit$`), ({ params: [id] }) => tasks.boardCommit(id!)],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/board-commit$`),
    ({ params: [id], body, fromBrowser }) => tasks.setBoardCommit(id!, body, fromBrowser),
  ],
  // A política de fluxo do projeto (ver server/flowPolicy.ts e FLOW_PRESETS em shared/model.ts): `{ mode, plan, completion, commit, source, completionChosen }`. Ler é livre; gravar só pela tela
  // (preset `{ mode }` ou portões `{ plan, completion, commit }`, que gravam 'custom'): o serviço responde 403 a quem não é a tela e o funcionário nem tem este POST na lista de apiPolicy.ts.
  ['GET', new RegExp(`^/api/projects/${ID}/flow-policy$`), ({ params: [id] }) => tasks.flowPolicy(id!)],
  ['POST', new RegExp(`^/api/projects/${ID}/flow-policy$`), ({ params: [id], body, fromBrowser }) => tasks.setFlowPolicy(id!, body, fromBrowser)],
  // Um escritor por vez no checkout principal: `{ singleWriter }` (ver server/boardConfig.ts e TaskService.writeSlot). Como o commit automático: ler é livre, gravar só pela tela (o serviço
  // responde 403 a quem não é a tela) e o funcionário nem tem este POST na lista de apiPolicy.ts.
  ['GET', new RegExp(`^/api/projects/${ID}/board-writer$`), ({ params: [id] }) => tasks.boardWriter(id!)],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/board-writer$`),
    ({ params: [id], body, fromBrowser }) => tasks.setBoardWriter(id!, body, fromBrowser),
  ],
  // Pausar o projeto (ver server/projectPause.ts): pausado, nada de execução começa sozinho (fila, ajuste da reprovação, rotinas, despertador, "continue", retomada, troca de motor; a revisão da entrega já feita roda); o que já roda termina
  // o turno, e as suas ações manuais seguem. Ler é livre (`{ paused: { at } | null }`). Pausar e retomar só pelo navegador pareado: o serviço responde 403 a quem não é a tela (o gate já
  // barra o POST do funcionário antes, como nas outras rotas só da tela), e as rotas nem estão na lista de apiPolicy.ts. Idempotentes: pausar de novo mantém o horário, retomar o que roda é um nada.
  ['GET', new RegExp(`^/api/projects/${ID}/pause$`), ({ params: [id] }) => tasks.pauseOf(id!)],
  // O estado da fila de cada funcionário (ver `TaskService.queueStates`): livre, ocupado com o card X, esperando recurso, no limite de consumo, projeto pausado, entrega em processamento ou a suíte
  // esperando a vez. Só leitura (lista de `StaffQueue`); 404 se o projeto não existe.
  ['GET', new RegExp(`^/api/projects/${ID}/queues$`), ({ params: [id] }) => tasks.queueStates(id!)],
  ['POST', new RegExp(`^/api/projects/${ID}/pause$`), ({ params: [id], fromBrowser }) => tasks.setPaused(id!, true, fromBrowser)],
  ['POST', new RegExp(`^/api/projects/${ID}/resume$`), ({ params: [id], fromBrowser }) => tasks.setPaused(id!, false, fromBrowser)],
  // Pausa de versão (ver `ProjectPause.mode` e `TaskService.setVersionPause`): a pausa com prazo para montar uma versão do working tree sem trabalho novo mexendo nos arquivos; o que já está em voo termina e ela sai
  // sozinha. Liga: a tela (prazo padrão 30 min) ou o funcionário com a permissão "Pode versionar e fazer deploy" (`canRelease`), pelo token da conversa e com `{ minutes }` obrigatório (1 a 120). Encerra: a tela
  // (qualquer uma) ou quem a ligou. O 403 é do serviço, e as duas rotas estão em `STAFF_POSTS` (apiPolicy.ts). O estado sai no `GET .../pause` (`mode`, `at`, `until`, `by`).
  ['POST', new RegExp(`^/api/projects/${ID}/version-pause$`), ({ params: [id], body, fromBrowser, caller }) => tasks.setVersionPause(id!, body, fromBrowser, caller)],
  ['POST', new RegExp(`^/api/projects/${ID}/version-pause/end$`), ({ params: [id], fromBrowser, caller }) => tasks.endVersionPause(id!, fromBrowser, caller)],
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
      // Lento (2 s ou mais), escreve no log o tempo de cada etapa do pedido (o começo da tarefa escreve o dele, ver TaskService.start).
      const timer = new StageTimer(`POST tarefa de ${requestedBy}`);
      try {
        timer.stage('gestor');
        if (!(await staff.isManagerOf(id!, requestedBy, b.staffId))) throw new BadRequest('pela API, só para quem reporta a você (requestedBy)');
        // A entrega volta para a conversa dele que pediu (a do token), e não para a que está no turno agora. Grava e começa; a tarefa gravada é sempre
        // devolvida, mesmo se o começo falhar (`startError`), e o retry com a mesma `idempotencyKey` devolve a mesma tarefa (ver TaskService.createAndStart).
        // Com prazo: o funcionário ocupado (a vez dele demora) não prende o pedido, a resposta vem com a tarefa na fila.
        return await tasks.createAndStart(id!, body, requestedBy, requesterSessionOf(caller, requestedBy), { start: b.start, deadlineMs: START_DEADLINE_MS, stage: (s) => timer.stage(s) });
      } finally {
        timer.finish();
      }
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}$`),
    ({ params: [id, taskId], body, fromBrowser, caller }) => {
      // A tela edita como sempre (o `true` é o dono: levar para "A fazer" um card com conversa é a ciência do corte, ver `Task.cutAck`). O funcionário, só com o token da conversa
      // e só tarefa em Aguardar ou A fazer (ver TaskService.editFrom), que não muda de coluna.
      if (fromBrowser) return tasks.update(id!, taskId!, body, true);
      return tasks.editFrom(id!, taskId!, caller, body);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/start$`),
    ({ params: [id, taskId], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('tarefas só pelo Claudio’s Club');
      // O "Começar" é seu: com o projeto pausado ele começa mesmo assim (`byOwner`); só a partida automática espera.
      return tasks.start(id!, taskId!, (body as { force?: unknown } | null)?.force === true, { deadlineMs: START_DEADLINE_MS, byOwner: true });
    },
  ],
  // Cancelar a tarefa (fecha sem entrega e não libera quem depende dela). Da tela, ou do funcionário só com o token da conversa ATUAL
  // da tarefa (cancelando a própria; ver TaskService.cancelFrom). O gestor não cancela a tarefa de quem reporta a ele por aqui.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/cancel$`),
    ({ params: [id, taskId], body, fromBrowser, caller }) => {
      // Corpo: { reason?, dependents?: { [taskId]: 'release' | 'cancel' | 'wait' } }. `dependents` só vale da tela; com o token do funcionário é ignorado.
      const b = cancelRequest(body, fromBrowser);
      // `deadline`: a vez do funcionário presa não deixa a tela sem resposta (503, nada gravado; ver `TaskService.lockedWithDeadline`).
      if (fromBrowser) return tasks.cancel(id!, taskId!, { by: 'user', reason: b.reason, dependents: b.dependents, deadline: true });
      return tasks.cancelFrom(id!, taskId!, caller, b.reason);
    },
  ],
  // Pedido de cancelamento de tarefa que JÁ COMEÇOU: quem a pediu (só com o token da conversa dele) manda o pedido com o motivo (`{ reason }`, obrigatório), que chega
  // na conversa do responsável; ele aceita cancelando (a rota acima) ou recusa dizendo por quê (a de baixo). Quem pediu cancela direto, pela rota acima, a que nunca
  // começou. Só funcionários pela API (a tela cancela direto, com a rota acima); a permissão é do serviço (403 sem token ou sem ser quem pediu).
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/cancel-request$`),
    ({ params: [id, taskId], body, fromBrowser, caller }) => {
      if (fromBrowser) throw new BadRequest('a tela cancela a tarefa direto (cancel); o pedido de cancelamento é do funcionário que pediu a tarefa');
      return tasks.requestCancel(id!, taskId!, caller, reasonRequest(body, 'do pedido de cancelamento'));
    },
  ],
  // O responsável RECUSA o pedido de cancelamento, com o porquê (`{ reason }`, obrigatório): só com o token da conversa atual da tarefa; quem pediu é avisado.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/cancel-request/refuse$`),
    ({ params: [id, taskId], body, fromBrowser, caller }) => {
      if (fromBrowser) throw new BadRequest('a recusa é de quem faz a tarefa, pela conversa dela');
      return tasks.refuseCancel(id!, taskId!, caller, reasonRequest(body, 'da recusa'));
    },
  ],
  // Follow-up de revisão: quem revisou a tarefa (ou é o responsável por ela) registra, com o token da conversa dele, o ajuste de acompanhamento que achou depois de aprovar
  // (`{ text, idempotencyKey? }`). Grava na tarefa e só então avisa quem pediu (ou a caixa do usuário); não cria card. O autor é o dono do token (403 sem token, ou para quem nem
  // revisou nem faz a tarefa; a tela não registra). A permissão é do serviço.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/followup$`),
    ({ params: [id, taskId], body, caller }) => tasks.createFollowUp(id!, taskId!, caller, body),
  ],
  // Decidir o follow-up: virou card (`{ resolution: 'card', cardId? }`) ou descartado (`{ resolution: 'discarded', reason? }`). Decide o usuário (pela tela, `fromBrowser`) ou o
  // gestor que pediu a tarefa (token da conversa dele; se ele também é o autor, decide o próprio follow-up); qualquer outro, inclusive o autor que não pediu, leva 403. Decidido uma vez, 409.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/followup/${ID}/resolve$`),
    ({ params: [id, taskId, followUpId], body, caller, fromBrowser }) => tasks.resolveFollowUp(id!, taskId!, followUpId!, caller, fromBrowser, body),
  ],
  // Criar o card do follow-up em um passo (`{ title?, description?, staffId?, start? }`, tudo opcional: o que não vem sai do follow-up): cria a tarefa e marca o follow-up como
  // resolvido (`resolution: 'card'`, `cardId`) numa gravação só, idempotente (repetir devolve o mesmo card). Quem decide o follow-up: o usuário (pela tela, `fromBrowser`) ou o gestor
  // que pediu a tarefa de origem (token); o resto leva 403. A permissão é do serviço.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/followup/${ID}/card$`),
    ({ params: [id, taskId, followUpId], body, caller, fromBrowser }) => tasks.createFollowUpCard(id!, taskId!, followUpId!, caller, fromBrowser, body),
  ],
  // Reabrir a cancelada: volta para "a fazer", sem começar sozinha. Só pela tela.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/reopen$`),
    ({ params: [id, taskId], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('tarefas só pelo Claudio’s Club');
      return tasks.reopen(id!, taskId!);
    },
  ],
  // O dono decide o que fazer com quem espera uma tarefa cancelada (item 'blocked' da caixa): liberar, cancelar junto ou seguir esperando.
  // `:id` é a tarefa que ESPERA; `blockerId`, a cancelada. Só pela tela.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/blocker$`),
    ({ params: [id, taskId], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('tarefas só pelo Claudio’s Club');
      const b = parse(z.object({ blockerId: z.string().max(40), action: z.enum(['release', 'cancel', 'wait']) }), body);
      return tasks.resolveCancelledBlocker(id!, taskId!, b.blockerId, b.action, undefined, { deadline: true });
    },
  ],
  ['GET', new RegExp(`^/api/projects/${ID}/tasks/${ID}/code$`), ({ params: [id, taskId] }) => tasks.code(id!, taskId!)],
  // Execuções da tarefa (começos e fins, do registro task-runs.jsonl). Lê quem lê o código; a sandbox do Codex não (ver apiPolicy.ts).
  ['GET', new RegExp(`^/api/projects/${ID}/tasks/${ID}/runs$`), ({ params: [id, taskId] }) => tasks.runs(id!, taskId!)],
  // Custo da tarefa: as conversas dela (trabalho, revisão, dúvida). US$ só do Claude; tokens dos dois motores. Sem dado = null, nunca zero.
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/cost$`),
    async ({ params: [id, taskId] }) => {
      const dir = await projectPathOf(id!);
      const task = dir ? (await readTasks(dir)).find((t) => t.id === taskId) : undefined;
      if (!task) return null;
      // Sem filtro de quadro: a sessão da tarefa pode estar numa worktree fora do quadro (o custo dela ainda conta).
      const { files, scanning } = await adapter.getAllSessionCostFiles();
      return taskCostOf(task, await taskCostSources(files), scanning);
    },
  ],
  // Dúvida da tarefa respondida pelo gestor que pediu (pela API, com o token da conversa dele) ou por você (pela tela, navegador pareado: a
  // resposta vale como sua e `escalate` é recusado). Quem responde como você é só `fromBrowser`, nunca o corpo do pedido. Sem token de gestor e
  // fora do navegador (ex.: o Codex pela sandbox, sem token), o serviço recusa (403).
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/answer$`),
    async ({ params: [id, taskId], body, caller, fromBrowser }) => {
      const b = parse(TaskAnswerBody, body);
      const who = caller?.staffId ? { staffId: caller.staffId, sessionId: caller.sessionId } : null;
      return { ok: true, task: await tasks.answerQuestion(id!, taskId!, who, b, fromBrowser) };
    },
  ],
  // O ajuste guardado que não chegou (item 'stuck' com `resend`): zera as falhas e tenta já. Sem corpo: só `fromBrowser` (navegador pareado)
  // autoriza, e o serviço recusa com 403 quem não é (404 sem a tarefa, 409 encerrada ou sem ajuste guardado).
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/resend-held$`),
    ({ params: [id, taskId], fromBrowser }) => tasks.resendHeld(id!, taskId!, fromBrowser),
  ],
  // "Excluir" o ajuste guardado `hid` (o id do item `h:<hid>` de `held` na conversa). Sem corpo: só `fromBrowser` autoriza (403 no serviço; fora do navegador o gate
  // já responde 400 a todo POST fora de `staffMayPost`, convenção global). 404 sem a tarefa; 409 se já foi enviado, ou se é a resposta a uma dúvida. Devolve a tarefa.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/held/${ID}/discard$`),
    ({ params: [id, taskId, heldId], fromBrowser }) => tasks.discardHeld(id!, taskId!, heldId!, fromBrowser),
  ],
  // Ordem da fila do responsável pela tarefa (`:id` é o card). Corpo (um só): `{ to: 'top' | n }` ou `{ step: 'up' | 'down' }` (reordenar) ou
  // `{ suggest: 'up' | 'down' | 'top', reason }` (sugestão do responsável, vira aviso a quem pediu e não muda nada). Quem pode, no serviço (403 sem
  // permissão, 409 fora da fila ou sem mudança, 404 sem a tarefa): o usuário (`fromBrowser`) em qualquer card; o gestor que pediu, só `step` nos que pediu
  // (com o token da conversa dele); o responsável, só `suggest`. A permissão não depende da tela.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/order$`),
    ({ params: [id, taskId], body, fromBrowser, caller }) => tasks.reorder(id!, taskId!, caller, fromBrowser, body),
  ],
  // Card sem código (`Task.noCode`): quem pediu manda revisar mesmo assim (o usuário pelo Claudio’s Club, o gestor com o token da conversa dele).
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/review-anyway$`),
    ({ params: [id, taskId], fromBrowser, caller }) => tasks.reviewAnyway(id!, taskId!, caller, fromBrowser),
  ],
  // Plano primeiro (`Task.planWait`): quem pediu o card aprova ou recusa o plano que o responsável entregou (o usuário pelo Claudio’s Club, o gestor com o token da conversa dele).
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/plan$`),
    ({ params: [id, taskId], body, fromBrowser, caller }) => tasks.decidePlan(id!, taskId!, caller, fromBrowser, body),
  ],
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
      // O `true` é o dono pela tela (`fromBrowser` conferido acima): com a conclusão reservada a ele na política de fluxo, só a mescla dele leva a "pronto".
      if (action === 'merge') return tasks.merge(id!, taskId!, b.skipTests, true);
      if (!b.staffId) throw new BadRequest(action === 'review' ? 'escolha quem revisa' : 'escolha quem faz o deploy');
      return action === 'review' ? tasks.requestReview(id!, taskId!, b.staffId, b.force, { assign: true }) : tasks.requestDeploy(id!, taskId!, b.staffId, b.force);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/delete$`),
    async ({ params: [id, taskId], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('tarefas só pelo Claudio’s Club');
      // Corpo (opcional): { dependents?: { [taskId]: 'release' | 'cancel' | 'wait' } }. Sem ele, ou incompleto, quem depende barra (409).
      return { ok: await tasks.remove(id!, taskId!, deleteRequest(body)) };
    },
  ],
  // ---- rotinas agendadas ----
  ['GET', /^\/api\/routines\/state$/, () => routines.state()],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/routines$`),
    async ({ params: [id, staffId], body, fromBrowser }) => {
      // Um funcionário não agenda trabalho para si mesmo (nem para outro) pela API.
      if (!fromBrowser) throw new BadRequest('rotinas só pelo Claudio’s Club');
      const profile = await staff.setRoutines(id!, staffId!, (body as { routines?: unknown } | null)?.routines);
      if (profile) await routinesSaved(profile);
      return profile;
    },
  ],
  // A tela central de agendamentos: cria/edita, liga/desliga e apaga UMA rotina de um funcionário escolhido (mesmo caminho de gravação da lista
  // acima). Todas só pelo Claudio’s Club; devolvem a rotina como `RoutineSchedule` (apagar: `{ ok: true }`). Ficha ou rotina que não existe: 404.
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/routines/save$`),
    async ({ params: [id, staffId], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('rotinas só pelo Claudio’s Club');
      const b = parse(z.object({ routine: z.unknown() }), body);
      const saved = await staff.saveRoutine(id!, staffId!, b.routine);
      if (!saved) return null;
      await routinesSaved(saved.profile);
      return { routine: await routineView(saved.profile, saved.routineId) };
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/routines/${ID}/enabled$`),
    async ({ params: [id, staffId, routineId], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('rotinas só pelo Claudio’s Club');
      const b = parse(z.object({ enabled: z.boolean() }), body);
      const profile = await staff.setRoutineEnabled(id!, staffId!, routineId!, b.enabled);
      if (!profile) return null;
      await routinesSaved(profile);
      return { routine: await routineView(profile, routineId!) };
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/routines/${ID}/delete$`),
    async ({ params: [id, staffId, routineId], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('rotinas só pelo Claudio’s Club');
      const profile = await staff.deleteRoutine(id!, staffId!, routineId!);
      if (!profile) return null;
      await routinesSaved(profile);
      return { ok: true };
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
      // O aviso da pausa de versão (ligada ou que saiu) é da caixa, como o da rotina: o kind é `routine` para a tela mostrar como informação e tirar por aqui (ver `versionPauseItems`).
      if (b.id.startsWith('vpause:')) return { ok: await dismissVersionPause(b.id) };
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
    /^\/api\/errors\/dismiss$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      // `error:<sessão>` (parou com erro), `cap:<sessão>` (parou no teto), `commit:<projeto>:<tarefa>` (o commit automático falhou ou foi parcial) ou `guardoff:<sessão>` (a fila de
      // validação pesada ficou desligada por hooks.json na conta do Codex) ou `codexsandbox:password-policy` (a política de senha do Windows quebra o sandbox do Codex): o id do item da caixa.
      const b = parse(z.object({ id: z.string().regex(/^(error|cap|commit|guardoff|codexsandbox):.+/).max(300) }), body);
      return { ok: b.id.startsWith('commit:') ? await tasks.ackCommit(b.id) : b.id.startsWith('guardoff:') ? chats.dismissGuardOff(b.id) : b.id.startsWith('codexsandbox:') ? codexPolicy.dismiss(b.id) : chats.dismissError(b.id) };
    },
  ],
  [
    'POST',
    /^\/api\/denied\/dismiss$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      // `denied:<sessão>:<turno>`: o id do item da caixa (ver deniedInboxItem).
      const b = parse(z.object({ id: z.string().regex(/^denied:.+/).max(300) }), body);
      return { ok: chats.dismissDenied(b.id) };
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
  // A vitrine não abre conversa: o gerador oculto roda em segundo plano (`started`; o estado sai em /showcase/status).
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/guide/run$`),
    async ({ params: [id], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('as ações do guia só pelo Claudio’s Club');
      const dir = await projectPathOf(id!);
      if (!dir) return null;
      return runGuideAction(
        {
          readProfile: (staffId) => readProfile(dir, staffId),
          send: (staffId, text, force) => sendNewConversation(id!, staffId, text, force),
          showcase: (showcaseDir, prompt, head) => showcases.start({ projectId: id!, dir: showcaseDir, prompt, head }),
        },
        dir,
        body,
      ).catch((err) => {
        throw err instanceof GuideActionError ? new BadRequest(err.message) : err;
      });
    },
  ],
  // Estado da geração da vitrine (idle, running, done, failed). Só leitura, pelo Claudio’s Club.
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/showcase/status$`),
    async ({ params: [id] }) => {
      const dir = await projectPathOf(id!);
      return dir ? showcases.status(id!) : null;
    },
  ],
  // Vitrine (VITRINE.html, ação `showcase`): a página abre numa aba nova (GET sem Origin, sem cabeçalho). Só leitura, em sandbox e sem script
  // (a CSP bloqueia tudo que não é o próprio HTML e o CSS embutido). Fora das listas da sandbox do Codex e dos funcionários (apiPolicy.ts).
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/showcase$`),
    async ({ params: [id] }) => {
      const dir = await projectPathOf(id!);
      const bytes = dir ? await readShowcase(dir) : null;
      return bytes
        ? new Raw(bytes, 'text/html; charset=utf-8', {
            'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            'referrer-policy': 'no-referrer',
            'x-frame-options': 'DENY',
            'content-disposition': 'inline',
          })
        : null;
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
    // Abrir um arquivo do projeto no editor de texto do computador (o "Corrigir" do alerta de segredo e o arquivo de segredo da aba Arquivos): só a tela (navegador
    // pareado), uma vez por clique do dono. Não devolve conteúdo: o texto de um segredo nunca passa pelo navegador. O GET `read` segue recusando segredo.
    'POST',
    new RegExp(`^/api/projects/${ID}/files/open-editor$`),
    async ({ params: [id], body, fromBrowser }) => openEditorRoute({ fromBrowser, body, projectDir: await projectPathOf(id!) }, { log: (line) => console.log(line) }),
  ],
  [
    // Abrir um terminal do computador na pasta do projeto (botão do painel): só a tela (navegador pareado); a pasta vem do cadastro, o corpo não leva nada.
    'POST',
    new RegExp(`^/api/projects/${ID}/open-terminal$`),
    async ({ params: [id], fromBrowser }) => openProjectTerminalRoute({ fromBrowser, projectDir: await projectPathOf(id!) }, { log: (line) => console.log(line) }),
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
      // `writeOwnerFile` grava e registra que a última mão no arquivo foi a sua (o commit automático deixa de fora o que você mexeu depois da tarefa, ver server/ownerEdits.ts).
      return dir ? writeOwnerFile(dir, input) : null;
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
  // ---- skills da conta e do projeto (SKILL.md): ver, editar e excluir para a lixeira (ver skillWrite.ts) ----
  [
    'GET',
    /^\/api\/skills\/source$/,
    async ({ url }) => {
      const t = await skillScopeOf(url.searchParams.get('scope'), url.searchParams.get('projectId'));
      return readSkillSource({ ...t, name: url.searchParams.get('name') ?? '' });
    },
  ],
  [
    'POST',
    /^\/api\/skills\/save$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('skills só são editadas pelo Claudio’s Club');
      const b = parse(SkillSaveInput, body);
      const t = await skillScopeOf(b.scope, b.projectId);
      return saveSkill({ ...t, name: b.name, content: b.content, backupDir: path.join(MYCO_HOME, 'backups', 'skills') });
    },
  ],
  [
    'POST',
    /^\/api\/skills\/create$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('skills só são criadas pelo Claudio’s Club');
      return createSkill(body, { resolveTarget: (scope, projectId) => skillScopeOf(scope, projectId), globalRoot: path.join(defaultLocations().home, 'skills') });
    },
  ],
  [
    'POST',
    /^\/api\/skills\/delete$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('skills só são apagadas pelo Claudio’s Club');
      const b = parse(SkillDeleteInput, body);
      const t = await skillScopeOf(b.scope, b.projectId);
      const hookFiles = hookFilesOf(defaultLocations().home, t.projectPaths);
      return deleteSkill({
        ...t,
        name: b.name,
        backupDir: path.join(MYCO_HOME, 'backups', 'skills'),
        settingsBackupDir: path.join(MYCO_HOME, 'backups', 'settings'),
        hookFiles,
        removeHooks: b.removeHooks,
      });
    },
  ],
  ['GET', /^\/api\/user$/, () => adapter.getUserScope()],
  // Quadro (e a lista de conversas de cada funcionário, que lê daqui). `?old=1` inclui as antigas (retenção).
  [
    'GET',
    /^\/api\/board$/,
    async ({ url }) => {
      const old = includeOld(url);
      const board = await boardCache.get(old ? 'old' : 'recent', () => getBoard({ includeOld: old }));
      return { ...board, live: await liveForBoard() };
    },
  ],
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
      // Conversa antiga também conta para o "sem commit" (o arquivamento só esconde da lista).
      const [sessions, staff] = await Promise.all([adapter.getProjectSessions(pid!, { includeOld: true }), listProjectStaff(dir, pid!)]);
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
  // Custo por tarefa concluída no período (`days`, como em /api/savings), do quadro: por tarefa, por funcionário e por gestor.
  [
    'GET',
    /^\/api\/task-costs$/,
    async ({ url }) => {
      const raw = url.searchParams.get('days');
      const days = raw === null ? null : /^\d{1,4}$/.test(raw) ? Number(raw) : 0;
      if (days !== null && (days < 1 || days > 3650)) throw new BadRequest('days deve ser um inteiro de 1 a 3650');
      const since = savingsSince(days);
      const projects = (await adapter.listProjects()).filter((p) => p.exists && !p.worktreeOf);
      const [{ files, scanning }, lists] = await Promise.all([
        adapter.getAllSessionCostFiles(),
        Promise.all(projects.map(async (p) => ({ projectId: p.id, tasks: await readTasks(p.path) }))),
      ]);
      return taskCostRanking(lists, since, await taskCostSources(files), scanning);
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
      const parsed = ArchiveBody.safeParse(body);
      if (!parsed.success) throw new BadRequest('pedido de arquivamento inválido');
      const { confirm, ...req } = parsed.data;
      // Arquivar também fecha o processo (libera memória). Uma conversa que trabalha sem confirmação, ou com efeito incerto, recusa (409) e NADA é arquivado.
      const closing = req.archived ? await chats.closeForArchive(req, confirm) : null;
      const config = await setArchived(req);
      boardCache.invalidate();
      // Temporário de volta ao quadro: os dias parado recomeçam a contar.
      if (!req.archived && req.id.startsWith('staff:')) await staff.restored(req.id.slice('staff:'.length));
      return closing ? { ...config, closing } : config;
    },
  ],
  // Fechar a conversa (libera o processo e os MCPs dela; a sessão continua no disco). Parada fecha; trabalhando pede `confirm`; efeito incerto recusa.
  [
    'POST',
    new RegExp(`^/api/chat/${ID}/close$`),
    async ({ params: [sid], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const b = parse(CloseBody, body ?? {});
      const result = await chats.close(sid!, { confirm: b.confirm });
      boardCache.invalidate();
      return { ok: true, ...result };
    },
  ],
  // Título manual da conversa (null ou vazio apaga: volta ao último assunto). Só pelo Claudio’s Club.
  [
    'POST',
    /^\/api\/conversation-title$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const req = ConversationTitleRequest.safeParse(body);
      if (!req.success) throw new BadRequest('pedido de título inválido');
      return setConversationTitle(req.data.id, req.data.title);
    },
  ],
  ['GET', /^\/api\/config$/, () => readConfig()],
  // Sinal de presença da aba (a tela manda a cada ~15 s e, ao sair, com `leaving`; ver tabPresence.ts). Só o navegador pareado: a extensão, o funcionário
  // e a sandbox do Codex não são aba (gate.ts: POST fora de `staffMayPost` é 400 sem a tela, e a extensão só alcança a lista dela).
  [
    'POST',
    /^\/api\/presence$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const b = parse(PresenceBody, body);
      tabs.signal(b.tab, b.leaving);
      return { ok: true };
    },
  ],
  // ---- a extensão do Chrome (Configurações): o código de pareamento, os pareados e o .zip para instalar (server/extension/) ----
  // Todas são POST (um GET de navegação não manda Origin, então não seria da tela) e só valem pelo navegador pareado.
  [
    'GET',
    /^\/api\/extension$/,
    async () => ({
      id: EXTENSION_ID,
      available: await fs.access(path.join(EXTENSION_DIR, 'manifest.json')).then(
        () => true,
        () => false,
      ),
      pairings: extensionTokens.list(),
    }),
  ],
  [
    'POST',
    /^\/api\/extension\/pair$/,
    async ({ fromBrowser, body }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const req = z.object({ label: z.string().max(40).optional() }).strict().safeParse(body ?? {});
      if (!req.success) throw new BadRequest(req.error.issues[0]?.message ?? 'pedido inválido');
      return extensionTokens.startPairing(req.data.label);
    },
  ],
  [
    'POST',
    /^\/api\/extension\/pairings\/([A-Za-z0-9-]+)\/revoke$/,
    async ({ params: [id], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      return extensionTokens.revoke(id ?? '') ? { ok: true } : null;
    },
  ],
  [
    'POST',
    /^\/api\/extension\/download$/,
    async ({ fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');
      const bytes = await buildExtensionZip(EXTENSION_DIR, PORT);
      return new Raw(bytes, 'application/zip', { 'content-disposition': 'attachment; filename="claudios-club-extensao.zip"' });
    },
  ],
  // A biblioteca do Club virou Global (~/.claude/skills, ver skillMigration.ts): a lista fica vazia e as escritas recusam.
  // A leitura de uma pasta que sobrou (conflito da migração) segue igual.
  ['GET', /^\/api\/skills\/library$/, async () => []],
  [
    'GET',
    /^\/api\/skills\/library\/([a-z0-9][a-z0-9-]{0,63})$/,
    async ({ params: [name] }) => {
      const s = await readLibrarySkill(name!);
      return s && { name: s.name, description: s.description, body: s.body, files: s.files, updatedAt: s.updatedAt };
    },
  ],
  ['POST', /^\/api\/skills\/library$/, () => refuseLibrary()],
  ['POST', /^\/api\/skills\/library\/import$/, () => refuseLibrary()],
  ['POST', /^\/api\/skills\/library\/([a-z0-9][a-z0-9-]{0,63})\/delete$/, () => refuseLibrary()],
  // Skills de repositório público do GitHub (ver skillInstall.ts): prévia, instalação, selo, atualizar e voltar. Nada aqui executa código.
  [
    'POST',
    /^\/api\/skills\/github\/preview$/,
    ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('skills só são instaladas pelo Claudio’s Club');
      return previewSkill(parse(GitHubPreviewInput, body));
    },
  ],
  [
    'POST',
    /^\/api\/skills\/github\/install$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('skills só são instaladas pelo Claudio’s Club');
      const b = parse(GitHubInstallInput, body);
      const target = await githubTargetOf(b.scope, b.projectId);
      return installSkill({ target, url: b.url, path: b.path, ref: b.ref, sha: b.sha, digest: b.digest, name: b.name });
    },
  ],
  // Várias skills do mesmo repositório de uma vez: 200 com um resultado por item (falha de um não derruba os outros).
  [
    'POST',
    /^\/api\/skills\/github\/install-batch$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('skills só são instaladas pelo Claudio’s Club');
      const b = parse(GitHubInstallBatchInput, body);
      const target = await githubTargetOf(b.scope, b.projectId);
      return { results: await installBatch({ target, url: b.url, items: b.items }) };
    },
  ],
  [
    'GET',
    /^\/api\/skills\/github\/status$/,
    async ({ url }) => {
      const q = parse(GitHubStatusQuery, { scope: url.searchParams.get('scope'), projectId: url.searchParams.get('projectId') });
      const target = await githubTargetOf(q.scope, q.projectId);
      const skills = await githubSkillsIn(target);
      return Promise.all(skills.map(async (s) => ({ ...s, update: await githubChecker.statusOf(target.scope, target.owner, s.name) })));
    },
  ],
  [
    'POST',
    /^\/api\/skills\/github\/check$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('skills só são atualizadas pelo Claudio’s Club');
      const b = parse(GitHubSkillInput, body);
      return checkUpdate({ target: await githubTargetOf(b.scope, b.projectId), name: b.name });
    },
  ],
  [
    'POST',
    /^\/api\/skills\/github\/update$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('skills só são atualizadas pelo Claudio’s Club');
      const b = parse(GitHubUpdateInput, body);
      return applyUpdate({ target: await githubTargetOf(b.scope, b.projectId), name: b.name, sha: b.sha, digest: b.digest, overwriteLocal: b.overwriteLocal });
    },
  ],
  [
    'POST',
    /^\/api\/skills\/github\/rollback$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('skills só são voltadas pelo Claudio’s Club');
      const b = parse(GitHubSkillInput, body);
      return rollback({ target: await githubTargetOf(b.scope, b.projectId), name: b.name });
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
  // Retenção (etapa 2): a prévia só lê; ligar a exclusão exige o navegador (ver retentionSweep.ts); desligar é sempre permitido.
  ['GET', /^\/api\/retention\/preview$/, () => retentionPreview(retentionDeps)],
  ['POST', /^\/api\/retention\/enable$/, ({ fromBrowser }) => setRetentionDeletion(true, { fromBrowser })],
  ['POST', /^\/api\/retention\/disable$/, () => setRetentionDeletion(false, { fromBrowser: false })],
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

/**
 * O que a extensão do Chrome vê: as mesmas leituras e escritas da tela, só com a projeção dela (ver server/extension/routes.ts). Nada de
 * conversa, arquivo ou configuração.
 */
const extDeps: ExtensionDeps = {
  tokens: extensionTokens,
  inbox: () => getInbox(),
  projects: async () => {
    const list = (await adapter.listProjects()).filter((p) => p.exists && !p.worktreeOf);
    const profiles = await staff.listAll(list);
    return list.map((p) => ({
      id: p.id,
      name: p.name,
      staff: profiles.filter((s) => s.projectId === p.id).map((s) => ({ id: s.id, name: s.name, role: s.role })),
    }));
  },
  createTask: (projectId, body) => tasks.create(projectId, body),
  // O "Começar" da extensão é seu, como o da tela: vale com o projeto pausado.
  startTask: (projectId, taskId) => tasks.start(projectId, taskId, false, { byOwner: true }),
  parkTask: (projectId, taskId, reason) => tasks.update(projectId, taskId, { waitReason: reason }),
};

async function onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  // Porta de entrada (server/gate.ts): Host, método, navegador pareado (ver pairing.ts), quem chama (socket e token da conversa) e as listas de rotas.
  // Aqui também ficam GET /api/pair (o link com o código), POST /api/pair/request|claim|approve (o botão "Parear este navegador" + `npm run pair
  // CÓDIGO`) e POST /api/pair/rotate (desparear todos).
  const admitted = gate(req, res, { pairing, tokens: sessionTokens, extensionTokens, localHostnames: LOCAL_HOSTNAMES, isLocalOrigin, openApproval });
  if (!admitted) return;
  // A extensão do Chrome tem as próprias rotas (antes do stream e da tabela da tela). O boardCache sai no fim de toda escrita, como abaixo.
  if (admitted.extension) {
    try {
      return await handleExtension(req, res, admitted, extDeps);
    } finally {
      if (req.method !== 'GET') boardCache.invalidate();
    }
  }
  const { url, sandbox, fromBrowser, caller } = admitted;

  const stream = STREAM_ROUTE.exec(url.pathname);
  if (stream && req.method === 'GET') return serveChatStream(stream[1]!, Number(url.searchParams.get('after') ?? 0), req, res);
  if (url.pathname.startsWith('/api/')) {
    for (const [method, pattern, handler] of routes) {
      const m = pattern.exec(url.pathname);
      if (!m || method !== req.method) continue;
      try {
        // Qualquer escrita (ficha, tarefa, projeto, conversa aberta/encerrada pelo Club) invalida o /api/board, no início e no fim.
        if (method !== 'GET') boardCache.invalidate();
        // O envio de anexo manda os bytes do arquivo (até 10 MB) em vez de JSON.
        const body = method !== 'GET' ? (ATTACHMENT_UPLOAD.test(url.pathname) ? await readRaw(req, MAX_ATTACHMENT_BYTES) : await readJson(req)) : undefined;
        const userAgent = (req.headers['user-agent'] ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 80);
        const out = await handler({ params: m.slice(1), url, body, fromBrowser, paired: !sandbox && pairing.isPaired(req.headers.cookie), userAgent, caller });
        if (method !== 'GET') boardCache.invalidate();
        if (out === null) return send(res, 404, { error: 'não encontrado' });
        if (out instanceof Accepted) return send(res, 202, out.body);
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
        if (method !== 'GET') boardCache.invalidate(); // falha no meio de uma escrita também pode ter mudado algo
        if (err instanceof ProjectFileError) return send(res, err.status, { error: err.message, ...err.extra });
        // Zip da extensão: pasta ausente (404) ou manifest recusado / pacote grande (409).
        if (err instanceof ExtensionPackError) return send(res, err.status, { error: err.message });
        if (err instanceof UsageStopError) return send(res, 409, { error: err.message, code: err.code, hit: err.hit });
        // Consulta entre projetos: o status vem do próprio erro (400, 403, 404, 409, 429 ou 503), sem token nem conteúdo na mensagem.
        if (err instanceof ConsultError) return send(res, err.status, { error: err.message, ...err.extra });
        // Vitrine: já sendo gerada (409); recusada antes de começar, pelo uso (429) ou pelos recursos (503).
        if (err instanceof ShowcaseBusyError) return send(res, 409, { error: err.message });
        // Já há uma janela de escolher pasta aberta: 409 com `code: 'busy'`.
        if (err instanceof PickerBusyError) return send(res, 409, { error: err.message, code: err.code });
        if (err instanceof ShowcaseRefusedError) return send(res, err.status, { error: err.message });
        // Mescla recusada (sem testes, teste vermelho, conflito): 409 com o motivo; `no-tests` dá para confirmar.
        if (err instanceof CodeError) return send(res, 409, { error: err.message, code: err.code });
        // Ficha em uso (conversa trabalhando): 409, antes do StaffError genérico (400).
        if (err instanceof StaffOpenTasksError) return send(res, 409, { error: err.message, code: err.code, openTasks: err.openTasks });
        if (err instanceof StaffTeamExistsError) return send(res, 409, { error: err.message, code: err.code });
        if (err instanceof StaffBusyError) return send(res, 409, { error: err.message });
        // Dúvida já respondida, ou pergunta que não está mais aberta na conversa: 409; quem não é o gestor: 403 (antes do TaskError, 400).
        if (err instanceof TaskConflictError) return send(res, 409, { error: err.message });
        if (err instanceof TaskForbiddenError) return send(res, 403, { error: err.message });
        // A vez do funcionário não chegou no prazo da resposta (edição, cancelamento, resposta à dúvida, ajuste guardado, revisão): 503, nada gravado (tentar de novo em instantes é seguro).
        if (err instanceof TaskBusyError) return send(res, 503, { error: err.message }, { 'retry-after': '5' });
        // Arquivo de estado (tasks.json, config.json…) seguiu preso por outro processo depois de todas as tentativas do rename: 503, nada gravado (tentar de novo é seguro).
        if (err instanceof StateBusyError) {
          console.error('[estado] arquivo ocupado:', err.file, (err.cause as Error | undefined)?.message);
          return send(res, 503, { error: err.message }, { 'retry-after': String(err.retryAfter) });
        }
        // Já há SPEC.md no projeto: a criação não sobrescreve (409 com `exists`).
        if (err instanceof GuideExistsError) return send(res, 409, { error: 'exists' });
        // Teto de títulos manuais: só criar outro recusa (409); editar ou apagar um que existe segue.
        if (err instanceof ConversationTitlesFullError) return send(res, 409, { error: err.message });
        if (err instanceof Forbidden) return send(res, 403, { error: err.message });
        if (err instanceof RateLimited) return send(res, 429, { error: err.message });
        // GitHub: limite de consultas (429, com quando volta); prévia que mudou ou skill mexida sem confirmação (409 com code).
        if (err instanceof GitHubRateLimited) {
          const wait = Math.max(1, Math.ceil((Date.parse(err.resetAt) - Date.now()) / 1000));
          return send(res, 429, { error: err.message, resetAt: err.resetAt }, { 'retry-after': String(wait) });
        }
        if (err instanceof SkillConflictError) return send(res, 409, { error: err.message, code: err.code });
        if (err instanceof StaffSendLimitError) return send(res, 429, { error: err.message }, { 'retry-after': String(err.retryAfter) });
        // Reiniciando: a entrega é recusada e a conversa não abre (tentar de novo em instantes).
        if (err instanceof ChatClosingError) return send(res, 503, { error: err.message });
        // Fechar (ou arquivar) uma conversa que trabalha: 409 com `code` (`working`: falta `confirm`; `uncertain`: efeito fora do projeto, com a `action`). Nada foi fechado.
        if (err instanceof CloseRefusedError) return send(res, 409, { error: err.message, code: err.code, ...(err.action && { action: err.action }) });
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
          err instanceof RetentionError ||
          err instanceof ConversationTitleError ||
          err instanceof SkillError ||
          err instanceof GitHubError ||
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
  const text = bodyText(Buffer.concat(chunks));
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

/**
 * Sessões vivas, marcadas com quem pediu o trabalho atual (as bolinhas na linha só na delegação). As do Codex entram
 * junto (ver ChatManager.codexLive), senão a animação de "trabalhando" não aparece nelas.
 */
async function liveForBoard(): Promise<LiveSession[]> {
  const claude = await adapter.listLiveSessions();
  return [...claude, ...chats.codexLive(claude)].map((s) => (chats.isDelegated(s.sessionId) ? { ...s, delegated: true } : s));
}

async function getBoard(opts: { includeOld?: boolean } = {}): Promise<Board> {
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
        adapter.getProjectSessions(p.id, { includeOld: opts.includeOld === true }),
        p.exists ? projectImageUrl(p.id, p.path) : null,
      ]);
      if (inv) inventories[p.id] = inv;
      if (list) sessions[p.id] = await titles.annotate(p.id, 'claude', list);
      if (image) images[p.id] = image;
    }),
  ]);
  // Conversa do Codex não tem transcript em ~/.claude/projects: cada id da ficha que ainda não está na lista vira uma sessão,
  // com o assunto e a hora do rollout (ver adapters/codex/rollout.ts). Entra antes do fold de worktree, que a trata igual.
  const listed = new Set(Object.values(sessions).flat().map((s) => s.id));
  const projectIds = new Set(projects.map((p) => p.id));
  // Retenção: a conversa do Codex sem atividade há mais dias que `archiveAfterDays` sai da lista só com `stat` do rollout (sem
  // rollout, fica como antes). Conta no `sessionCount` mesmo assim, como o transcript do Claude.
  const archiveDays = opts.includeOld ? 0 : (await readConfig()).archiveAfterDays;
  const cutoff = archiveDays > 0 ? Date.now() - archiveDays * 86_400_000 : null;
  const liveIds = new Set(live.filter((l) => l.alive).map((l) => l.sessionId));
  // Os mesmos protegidos do adapter (última de cada ficha, tarefas não concluídas): nunca saem pela retenção.
  const retained = cutoff === null ? new Map<string, Set<string>>() : new Map(await Promise.all(projects.map(async (p) => [p.id, await retainedOf(p.id, p.path)] as const)));
  const runDir = path.join(MYCO_HOME, 'run');
  const added: Record<string, number> = {};
  const shown = new Set<string>();
  for (const f of staffList) {
    if (f.engine !== 'codex' || !projectIds.has(f.projectId)) continue;
    for (const entry of f.sessions) {
      if (listed.has(entry.id)) continue;
      listed.add(entry.id);
      added[f.projectId] = (added[f.projectId] ?? 0) + 1;
      if (cutoff !== null && !liveIds.has(entry.id) && !retained.get(f.projectId)?.has(entry.id)) {
        // Só `stat` do rollout (o threadId vem de run/ ou, se a limpeza já levou, do registro de conversas).
        const at = await rolloutUpdatedAt(runDir, entry.id);
        if (at && at.getTime() < cutoff) continue;
      }
      if (!sessions[f.projectId]) sessions[f.projectId] = [];
      const [withTitle] = await titles.annotate(f.projectId, 'codex', [await codexSession(runDir, f.name, entry)]);
      sessions[f.projectId]!.push(withTitle!);
      shown.add(f.projectId);
    }
  }
  for (const pid of shown) sessions[pid]!.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

const INBOX_ORDER: Record<InboxKind, number> = { plan: 0, permission: 1, secret: 2, waiting: 3, question: 4, denied: 5, stuck: 6, followUp: 7, blocked: 8, notStarted: 9, error: 10, routine: 11, usage: 12, orphan: 13 };
/** Avisos de consumo (conta e orçamento de projeto) que a caixa mostra; guardados entre leituras da caixa. */
const usageWarnings = new UsageWarnings();
/** Quais avisos de erro da caixa já passaram (`InboxItem.resolvedAt`, ver inboxResolved.ts) e há quanto tempo; só na memória. */
const resolver = new InboxResolver();

/**
 * Quantos avisos de commit parcial esperam outro card terminar, por projeto (`GET /api/inbox/commit-waiting`): só ciência, a caixa não os lista. Os mesmos projetos da caixa (do quadro, não
 * arquivados); o aviso que o dono já ignorou não conta. Erro ao ler um projeto: ele fica de fora da contagem, os outros seguem.
 */
async function getCommitWaiting(): Promise<CommitWaitingSummary> {
  const projects = await adapter.listProjects();
  const { hidden } = await sessionPlacesNow(projects);
  const rows: CommitWaitingSummary['projects'] = [];
  for (const p of projects.filter((x) => x.exists && !x.worktreeOf)) {
    if (hidden({ projectId: p.id, staffId: null, sessionId: '' })) continue;
    try {
      const count = commitWaitingCount(await withCommitLeft(await readTasks(p.path), p.id, p.path));
      if (count) rows.push({ projectId: p.id, projectName: p.name, count });
    } catch {
      // projeto ilegível: não entra na contagem
    }
  }
  return { total: rows.reduce((n, r) => n + r.count, 0), projects: rows };
}

/**
 * Tudo que espera você, de todas as salas: planos prontos e permissões pendentes das conversas
 * no Claudio’s Club, sessões esperando resposta em outro lugar (app, terminal), conversas que pararam com
 * erro e processos órfãos de um reinício. Arquivados ficam de fora. Aviso de erro cujo problema já passou
 * segue na lista com `resolvedAt` (depois dos pendentes, não conta como pendência) até ser ignorado ou vencer o prazo.
 */
async function getInbox(): Promise<InboxItem[]> {
  const readAt = resolver.begin();
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
  // Tarefa que espera outra empacada (ver stuckDependencies em server/tasks.ts) e cartão esquecido em "a fazer" (ver notStartedTasks): calculados
  // na leitura, nada gravado; somem ao destravar, começar, cancelar, editar ou apagar. Só projetos do quadro e não arquivados (como os outros avisos).
  const boardProjects = projects.filter((x) => x.exists && !x.worktreeOf);
  // Com a permissão que a conversa espera de você (`withPermission`): a tarefa parada nela segura os dependentes na caixa, como as outras paradas.
  // Com o estado do aviso de commit parcial (`commitLeft`, ver server/commitLeft.ts).
  const boards = await Promise.all(boardProjects.map(async (p) => ({ p, tasks: await withCommitLeft((await readTasks(p.path)).map((t) => tasks.withPermission(t)), p.id, p.path) })));
  // Turno que parou no teto (ferramentas ou minutos): some quando você manda mensagem nova na conversa; com a tarefa da conversa já encerrada, segue na lista como resolvido.
  for (const c of chats.turnCaps()) {
    const w = where(c.sessionId, liveById.get(c.sessionId));
    if (hidden(w)) continue;
    const owner = boards.find((b) => b.p.id === w.projectId)?.tasks.find((t) => t.sessionId === c.sessionId);
    const item = resolver.cap({ id: `cap:${c.sessionId}`, kind: 'error', ...w, summary: capText(c), at: c.at }, owner);
    if (item) out.push(item);
  }
  // Também as tarefas que só você destrava (ver ownAlerts): dúvida escalada ('question') e revisão ou ajuste parados ('stuck').
  // E os follow-ups de revisão que esperam você (ver followUpAlerts): tarefa que você pediu, ou o gestor não pôde receber ('followUp').
  // E o commit automático de tarefa pronta que falhou ou foi parcial (ver commitAlerts): kind 'error', some ao ignorar.
  const stuck = boards.map(({ p, tasks: all }) => ({ p, rows: stuckDependencies(all), forgotten: notStartedTasks(all), own: ownAlerts(all), followUps: followUpAlerts(all), commits: commitInboxAlerts(commitAlerts(all)) }));
  if (stuck.some((s) => s.rows.length || s.forgotten.length || s.own.length || s.followUps.length || s.commits.length)) {
    const staffNames = new Map((await staff.listAll(boardProjects)).map((s) => [`${s.projectId}:${s.id}`, s.name]));
    const nameOf = (projectId: string, staffId: string | null) => (staffId ? (staffNames.get(`${projectId}:${staffId}`) ?? '') : '');
    for (const { p, rows, forgotten, own, followUps, commits } of stuck) {
      if (hidden({ projectId: p.id, staffId: null, sessionId: '' })) continue;
      for (const a of own) {
        const w = { projectId: p.id, projectName: p.name, sessionId: '', staffId: a.task.staffId, name: nameOf(p.id, a.task.staffId) };
        out.push(a.state.humanAction === 'answer' ? taskQuestionInboxItem(a, w) : stuckInboxItem(a, w));
      }
      for (const a of followUps) out.push(followUpInboxItem(a, { projectId: p.id, projectName: p.name, sessionId: '', name: nameOf(p.id, a.task.staffId) }, nameOf(p.id, a.followUp.by), nameOf(p.id, a.followUp.staffId ?? null)));
      // Commit automático: as sobras (ou, no aviso de erro, os arquivos da tarefa) já sem mudança no git = resolvido (consulta ao git em paralelo, com cache e prazo, ver InboxResolver.commit).
      // Os que esperam outro card (`waiting`) não são item: ficam só no estado da tarefa e na contagem (`/api/inbox/commit-waiting`).
      const commitItems = await Promise.all(commits.map((a) => resolver.commit(commitInboxItem(a, { projectId: p.id, projectName: p.name, sessionId: '', name: nameOf(p.id, a.task.staffId) }), p.path, resolveBy(a.task))));
      for (const item of commitItems) if (item) out.push(item);
      for (const s of rows) out.push(blockedInboxItem(s, { projectId: p.id, projectName: p.name, sessionId: '', staffId: s.task.staffId, name: nameOf(p.id, s.task.staffId) }));
      for (const n of forgotten) out.push(notStartedInboxItem(n, { projectId: p.id, projectName: p.name, sessionId: '', name: nameOf(p.id, n.task.staffId) }));
    }
  }
  const orphans = await chats.orphans(live);
  const orphanIds = new Set(orphans.map((o) => o.sessionId));
  for (const o of orphans) {
    const w = where(o.sessionId, liveById.get(o.sessionId));
    if (!hidden(w)) out.push({ id: `orphan:${o.sessionId}`, kind: 'orphan', ...w, summary: 'processo de antes do reinício do Claudio’s Club: clique em Trazer', at: null });
  }
  const own = chats.ownPids();
  for (const l of live) {
    if (!l.alive || l.status !== 'waiting' || own.has(l.pid) || orphanIds.has(l.sessionId) || chats.isReusedPid(l)) continue;
    // Dispensada por você: volta só quando o status mudar (outro statusUpdatedAt).
    if (inboxState.isWaitingDismissed(l.sessionId, l.statusUpdatedAt)) continue;
    const w = where(l.sessionId, l);
    if (hidden(w)) continue;
    const place = l.entrypoint === 'claude-desktop' ? 'no app do Claude' : l.entrypoint === 'sdk-cli' ? 'em outro programa' : 'num terminal';
    out.push({ id: `waiting:${l.sessionId}`, kind: 'waiting', ...w, summary: `esperando sua resposta ${place}`, at: l.statusUpdatedAt });
  }
  // Pausa de versão ligada, e a que saiu (prazo, encerrada, retomada) enquanto o dono não dispensa o aviso: itens informativos (ver `versionPauseItems`).
  for (const item of versionPauseItems(await projectPauses.notices().catch(() => ({ active: [], ended: [] })), (id) => projects.find((p) => p.id === id)?.name ?? id)) {
    if (!hidden({ projectId: item.projectId, staffId: null, sessionId: '' })) out.push(item);
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
      summary: a.uncertain ? `rotina "${a.routineName}": ${a.text}` : `rotina "${a.routineName}" não rodou: ${a.text.replace(/^pulada: /, '')}`,
      at: a.at,
    });
  }
  // Consumo da conta Claude 10 pontos antes da linha de parada, e orçamento de projeto a 80% (estimativa). Sem leitura recente, não avisa.
  const cfg = await readConfig();
  const budgeted = Object.keys(cfg.projectBudgets);
  const costs = budgeted.length ? await getCosts() : null;
  const week = Object.fromEntries(
    budgeted.map((id) => [id, { project: costs?.projects[id]?.last7d ?? 0, total: costs?.total.last7d ?? 0 }]),
  );
  const warned = usageWarnings.update({
    usage: await readUsage(),
    usageStop: cfg.usageStop,
    projectBudgets: cfg.projectBudgets,
    week,
    projectName: (id) => projects.find((p) => p.id === id)?.name ?? id,
    now: Date.now(),
  });
  for (const u of warned.active) {
    if (u.projectId === null) {
      // Conta inteira: sem projeto nem funcionário.
      out.push({ id: u.id, kind: 'usage', projectId: '', projectName: '', sessionId: '', staffId: null, name: 'Conta Claude', summary: u.summary, at: null });
      continue;
    }
    if (hidden({ projectId: u.projectId, staffId: null, sessionId: '' })) continue;
    const projectName = projects.find((p) => p.id === u.projectId)?.name ?? u.projectId;
    out.push({ id: u.id, kind: 'usage', projectId: u.projectId, projectName, sessionId: '', staffId: null, name: projectName, summary: u.summary, at: null });
  }
  // Ferramenta barrada por uma regra de permissão numa conversa de tarefa (um item por conversa e por turno, ver ChatManager.noteDenied).
  for (const d of chats.deniedHits()) {
    const w = where(d.sessionId, liveById.get(d.sessionId));
    if (!hidden(w)) out.push(deniedInboxItem(d, w));
  }
  // Conversa de tarefa do Codex sem a fila de validação pesada por causa do hooks.json da conta (kind 'error', ver ChatManager.noteGuardOff): o aviso do chat ninguém lê numa conversa autônoma.
  for (const g of chats.guardOffHits()) {
    const w = where(g.sessionId, liveById.get(g.sessionId));
    if (hidden(w)) continue;
    // O hooks.json que sumiu deixa o aviso como resolvido (a conversa só o larga na próxima mensagem).
    const item = await resolver.guardOff(heavyGuardOffInboxItem(g, w));
    if (item) out.push(item);
  }
  // O sandbox do Codex no Windows não abre por causa da política de senha (kind 'error', um por máquina, ver CodexPasswordPolicy): sem projeto, como o aviso de consumo da conta.
  // Aviso de pé: relê a política (com o cache dela) para quem a corrigiu sem abrir conversa do Codex; passou = resolvido.
  if (codexPolicy.current() && !codexPolicy.current()!.resolvedAt) await settleWithin(codexPolicy.check(), 3_000, undefined);
  const sandbox = codexPolicy.current();
  const sandboxItem = sandbox ? resolver.codexSandbox(codexSandboxInboxItem(sandbox)) : null;
  if (sandboxItem) out.push(sandboxItem);
  // Segredos que apareceram nas conversas do Claudio’s Club (senha num comando, token colado…).
  for (const s of chats.secretHits()) {
    const w = where(s.sessionId, liveById.get(s.sessionId));
    if (!hidden(w)) out.push(secretInboxItem(s, w, projects.find((p) => p.id === w.projectId)?.path ?? null));
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
  resolver.sweep(readAt);
  return out.sort((a, b) => resolvedLast(a, b) || INBOX_ORDER[a.kind] - INBOX_ORDER[b.kind] || (b.at ?? '').localeCompare(a.at ?? ''));
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

/**
 * Pasta `skills` do escopo, montada pelo servidor (o navegador só manda o id). `projectPaths`: os projetos cujos settings
 * contam para o hook que aponta para a skill (conta: todos os existentes; projeto: o dele).
 */
async function skillScopeOf(scope: string | null, projectId: string | null): Promise<SkillScope & { projectPaths: string[] }> {
  if (scope === 'user') {
    const projectPaths = (await adapter.listProjects()).filter((p) => p.exists).map((p) => p.path);
    return { scope: 'user', owner: 'user', root: path.join(defaultLocations().home, 'skills'), projectPaths };
  }
  if (scope !== 'project' || !projectId) throw new BadRequest('escopo inválido');
  const p = await projectById(projectId);
  if (!p) throw new BadRequest('projeto não encontrado');
  const claudeDir = projectClaudeDir(defaultLocations(), p.path);
  if (!claudeDir) throw new BadRequest('este projeto é a sua pasta do Claude: as skills dele são as da conta');
  return { scope: 'project', owner: p.id, root: path.join(claudeDir, 'skills'), projectPaths: [p.path] };
}

/** A biblioteca não é mais escopo: o zod ainda aceita o nome, mas a instalação recusa (ver refuseLibrary). */
function refuseLibrary(): never {
  throw new BadRequest('a biblioteca virou Global: use as skills da conta');
}

/** A pasta de skills do GitHub de um escopo: a conta ou um projeto (o servidor monta; o navegador manda só o id). */
async function githubTargetOf(scope: 'library' | 'user' | 'project', projectId: string | null | undefined): Promise<InstallTarget> {
  if (scope === 'library') refuseLibrary();
  const t = await skillScopeOf(scope, projectId ?? null);
  return { scope: t.scope, owner: t.owner, root: t.root };
}

/** Onde procurar as skills do GitHub para o selo de atualização: a conta e cada projeto existente. */
async function githubScopes(): Promise<InstallTarget[]> {
  const out: InstallTarget[] = [{ scope: 'user', owner: 'user', root: path.join(defaultLocations().home, 'skills') }];
  for (const p of (await adapter.listProjects()).filter((x) => x.exists)) {
    const dir = projectClaudeDir(defaultLocations(), p.path);
    if (dir) out.push({ scope: 'project', owner: p.id, root: path.join(dir, 'skills') });
  }
  return out;
}
const githubChecker = new UpdateChecker({ targets: githubScopes });

async function projectById(id: string) {
  const p = (await adapter.listProjects()).find((x) => x.id === id);
  return p?.exists ? p : null;
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
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

/**
 * Migração das skills (ver skillMigration.ts): a biblioteca do Club vai para a Global (uma vez) e os nomes antigos das fichas viram refs.
 * O log diz o que mudou e o que ficou (conflitos e fichas de projeto que não deu para ler).
 */
async function migrateSkillsAtBoot(): Promise<void> {
  const lib = await migrateLibraryToGlobal({
    libraryDir: LIBRARY_DIR,
    globalDir: path.join(defaultLocations().home, 'skills'),
    recordFile: path.join(MYCO_HOME, 'skills-migracao.json'),
  });
  if (lib) {
    console.log(`[skills] biblioteca → Global: ${lib.moved.length} movida(s)${lib.moved.length ? ` (${lib.moved.join(', ')})` : ''}`);
    if (lib.conflicts.length) console.log(`[skills] biblioteca: ${lib.conflicts.length} não movida(s), nada foi sobrescrito: ${lib.conflicts.join('; ')}`);
  }
  const projects = (await adapter.listProjects()).filter((p) => p.exists);
  const conv = await convertStaffSkills({
    projects,
    known: async (p) => {
      const [inventory, scope] = await Promise.all([adapter.getProjectInventory(p.id), adapter.getUserScope()]);
      return { globalNames: scope.skills.map((s) => s.name), projectNames: (inventory?.skills ?? []).map((s) => s.name) };
    },
    list: listProjectStaff,
    save: saveProfile,
  });
  if (conv.changed.length) console.log(`[skills] fichas com skill por nome antigo convertidas: ${conv.changed.length}`);
  if (conv.skipped.length) console.warn(`[skills] projetos não lidos na conversão das fichas: ${conv.skipped.join(', ')}`);
}

/**
 * Migração dos MCPs (ver staff/mcpMigration.ts): o registro do Club vai para a Global (`mcpServers` do ~/.claude.json, uma vez, com backup), as
 * ferramentas testadas ganham a chave nova e as fichas com nome antigo viram refs `global:`/`project:`. O log diz o que mudou, o caminho do
 * backup e o que ficou (conflitos de nome e valores que faltam no cofre).
 */
async function migrateMcpsAtBoot(): Promise<void> {
  const projects = (await adapter.listProjects()).filter((p) => p.exists);
  const r = await runMcpMigration({
    clubFile: CLUB_MCP_FILE,
    claudeConfigFile: defaultLocations().configFile,
    backupDir: path.join(MYCO_HOME, 'backups'),
    recordFile: path.join(MYCO_HOME, 'mcps-migracao.json'),
    toolsFile: MCP_TOOLS_FILE,
    projects,
    known: (p) => knownMcpNames(p.path, defaultLocations().configFile),
    list: listProjectStaff,
    save: saveProfile,
  });
  if (r.clubError) console.warn(`[mcp] migração do registro não concluída (tenta de novo no próximo boot): ${r.clubError}`);
  if (r.club) {
    console.log(`[mcp] registro do Club → Global: ${r.club.moved.length} MCP(s)${r.club.moved.length ? ` (${r.club.moved.join(', ')})` : ''}; backup do ~/.claude.json: ${r.club.backup ?? 'não precisou (o arquivo não existia ou nada foi gravado)'}`);
    if (r.club.conflicts.length) console.log(`[mcp] ${r.club.conflicts.length} não movido(s), nada foi sobrescrito: ${r.club.conflicts.join('; ')}`);
    if (r.club.semValor.length) console.warn(`[mcp] sem valor no cofre (cadastre de novo na Global): ${r.club.semValor.join(', ')}`);
  }
  if (r.repaired.length) console.log(`[mcp] entradas do Club com o lançador refeito: ${r.repaired.join(', ')}`);
  if (r.toolsKeys) console.log(`[mcp] ferramentas testadas com a chave nova: ${r.toolsKeys}`);
  if (r.fichas.changed.length) console.log(`[mcp] fichas com MCP por nome antigo convertidas: ${r.fichas.changed.length}`);
  if (r.fichas.skipped.length) console.warn(`[mcp] projetos não lidos na conversão das fichas: ${r.fichas.skipped.join(', ')}`);
}

/**
 * Migração dos agents prontos (ver staff/presetMigration.ts): o executor do projeto que ainda é o Haiku antigo passa para o Sonnet; o que
 * alguém editou fica e vai no log, com o que difere.
 */
async function migrateAgentPresetsAtBoot(): Promise<void> {
  const projects = (await adapter.listProjects()).filter((p) => p.exists);
  const done = await migrateProjectAgents({
    projects,
    recordFile: path.join(MYCO_HOME, 'agents-migracao.json'),
    backupDir: path.join(MYCO_HOME, 'agent-backups'),
  });
  for (const [id, r] of Object.entries(done)) {
    if (r.updated.length) console.log(`[agents] ${id}: atualizado para o pronto novo: ${r.updated.join(', ')} (o arquivo anterior ficou em ${path.join(MYCO_HOME, 'agent-backups', id)})`);
    if (r.kept.length) console.log(`[agents] ${id}: não atualizado, nada foi sobrescrito: ${r.kept.join('; ')}`);
  }
}

server.listen(PORT, HOST, () => {
  console.log(`Claudio’s Club em http://claudio.localhost:${PORT} (adaptador: ${adapter.id})`);
  // Só quem ficou com a porta confere as abas (um segundo servidor que falhou não pode parar o do outro).
  tabs.start();
  // Migração das skills (uma vez): depois da porta, sem segurar a subida.
  void migrateSkillsAtBoot().catch((err: unknown) => console.warn('[skills] migração não concluída:', err));
  void migrateMcpsAtBoot().catch((err: unknown) => console.warn('[mcp] migração não concluída:', err));
  void migrateAgentPresetsAtBoot().catch((err: unknown) => console.warn('[agents] migração dos prontos não concluída:', err));
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
    // As conversas diretas trocadas voltam ao secundário da ficha atual (ver directFallback.ts), antes do continue.
    .then(() =>
      restoreDirectFallbacks({
        listStaff: async () => staff.listAll(await adapter.listProjects()),
        isTaskConversation: (sid) => tasks.isTaskConversation(sid),
        setOverride: (sid, override) => chats.setOverride(sid, override),
      }),
    )
    .catch((err) => console.error('[chat] conversa no motor secundário não reaberta:', err))
    .then(() => {
      // Só ele manda o "continue" das conversas que bateram no limite de uso (e o despertador).
      // Quem estava em turno volta antes de tudo (ver server/chat/resume.ts). Só depois ligam o "continue", o despertador
      // e a fila: eles mandam mensagem, e não podem mandar de novo numa conversa que a retomada ainda está abrindo.
      // Tarefa que estava no motor secundário, com o principal liberado: o resume dela vai numa conversa nova no principal (ver TaskService.resumeOnPrimary).
      void bootResume({ file: resumeFile.file, stopHit: usageStopHit, paused: projectPaused, send: (entry) => chats.resumeChat(entry), hold: (entry) => void chats.holdCut(entry.sessionId, entry.cut), redirect: (entry) => tasks.resumeOnPrimary(entry.projectId, entry.sessionId, resumeText(entry.hadPending)) }, () => {
        autoContinue.start();
        wakeups.start();
        turnRetries.start();
        // Fila de tarefas: quem ficou com tarefa ou ajuste esperando. Reiniciando, a fila espera o boot (ver tasks.ts).
        // A coleta de CPU do gate começa aqui (a média vale depois de ~2 min).
      resourceGate.start();
      const queueTick = () => {
          if (!chats.isClosing()) void tasks.tick().catch(() => {});
        };
        setTimeout(queueTick, 15_000).unref();
        setInterval(queueTick, 60_000).unref();
      }).catch((err) => console.error('[retomar] falhou:', err));
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
  // Selo de atualização das skills do GitHub: no máximo uma varredura por dia (ver UpdateChecker). Não baixa nem aplica nada.
  const checkGithub = () => void githubChecker.runIfDue().catch(() => {});
  setTimeout(checkGithub, 2 * 60_000).unref();
  setInterval(checkGithub, 6 * 60 * 60_000).unref();
  // Configs de sessão antigas em ~/.myco/run (podem ter tokens de MCP): na subida e a cada 12 h.
  const cleanRun = () =>
    cleanRunDir(path.join(MYCO_HOME, 'run'))
      .then((n) => n && console.log(`[run] ${n} pasta(s) de sessão antiga(s) apagada(s) de ~/.myco/run`))
      .catch(() => {});
  void cleanRun();
  setInterval(cleanRun, 12 * 60 * 60_000).unref();
  // Retenção: apaga conversas do Club paradas além de deleteAfterDays, só com a exclusão confirmada no navegador. A primeira
  // varredura só ~5 min depois da subida (o resume das conversas abertas acaba antes), depois a cada 12 h.
  const RETENTION_EVERY_MS = 12 * 60 * 60_000;
  const retentionRound = () => {
    void runRetentionSweep(retentionDeps)
      .catch((err) => console.error('[retencao] falhou:', err instanceof Error ? err.message : err))
      .finally(() => setTimeout(retentionRound, RETENTION_EVERY_MS).unref());
  };
  // No boot: o que falta das 12 h desde a última varredura guardada (com piso de 5 min). Reiniciar muitas vezes não zera a conta.
  void lastRetentionRun(retentionLastRun).then((last) =>
    setTimeout(retentionRound, nextRetentionDelay(last, Date.now(), RETENTION_EVERY_MS, 5 * 60_000)).unref(),
  );
  // Novidades do Claudio’s Club no GitHub: na subida e a cada 6 h.
  updater.start();
});
