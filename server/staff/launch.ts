import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ServerInfo, StaffProfile } from '../../shared/model';
import { personalityName, personalityReminder } from '../../shared/personality';
import { defaultLocations } from '../adapters/claude/paths';
import { clubBlockedOrigins } from '../clubAddress';
import { MYCO_HOME } from '../config';
import { heavyLockDir } from '../heavyQueue';
import { lazyNavegadorCommand } from '../navegadorMcp';
import { ROOT } from '../root';
import { memoryMeasure, memoryOver } from '../../scripts/hooks/memory-cap.mjs';
import { consultDenyRules, consultSystemPrompt, isClaudeRoot, renderFicha, systemPrompt, type CleanBrowserInfo, type CodexChromeInfo, type FichaContext, type GitInfo, type MemoriaInfo, type SshInfo, type TarefaInfo, type TeamMember } from './ficha';
import { FTP_MCP_NAME, GIT_MCP_NAME, GIT_READ_TOOLS, GPT_MCP_NAME, MEMORIA_MCP_NAME, TAREFA_MCP_NAME } from '../../shared/model';
import { GIT_MCP_BUNDLE, gitBundleExists, gitGrant, gitMcpServer, writeGitPolicy } from './gitMcp';
import { DEFAULT_SECRETS_DIR } from '../secretVault';
import { ftpMcpServerConfig } from './ftpMcp';
import { memoriaMcpServer } from './memoriaMcp';
import { tarefaMcpServer } from './tarefaMcp';
import { SSH_MCP_BUNDLE, SSH_MCP_NAME, SSH_READ_TOOLS, WRITE_AUTONOMY, sshMcpServerConfig } from './sshMcp';
import { CLEAN_BROWSER_MCP_NAME, CODEX_CHROME_MCP_NAME, CODEX_SSH_MCP_NAME, type CodexAgentRole, type CodexExtraMcp, type CodexHeavyGuard, type CodexMcpServer } from '../chat/codexArgs';
import { codexMcpAccess } from './mcpAccess';
import { gptMcpServerConfig } from './gptMcp';
import { buildMcpConfig, codexMcpServers, mcpWriteFileFor, type CodexMcpMotivo } from './mcp';
import { MCP_LAUNCH_BUNDLE, mcpLaunchBundle } from './mcpLaunch';
import { ensurePlaybookAgents } from './playbookAgents';
import { writeCodexAgents } from './codexAgents';
import { PLAYBOOK_AGENTS } from '../../shared/agentPresets';
import { buildSkillPlugin } from '../skillLibrary';
import { listSkillDirs, skillPlanOf, type SkillSource } from '../skillAccess';
import { hasGuide } from '../projectGuide';
import { readConsultGuide } from './consultGuide';
import { ensureMemory, fichaFile, historyDir, memoryFile, profileFile, staffDir, writeAtomic } from './store';
import { readPersonMemory } from './personalMemory';
import type { Worktree } from './worktree';

export interface LaunchContext {
  company: string;
  /** Workspace do projeto (aba do quadro), se tiver. */
  workspace?: string | null;
  projectName: string;
  projectPath: string;
  managerNames: string[];
  mycoUrl: string;
  /** Onde ficam os arquivos de lançamento (fora do projeto: a config de MCP pode ter segredos). */
  runDir: string;
  claudeConfigFile: string;
  /** Worktree própria (ficha com `worktree`); sessões novas rodam nela. */
  worktree?: Worktree | null;
  /** Servidores da ficha, resolvidos (só nomes e destinos). */
  servers?: ServerInfo[];
  /** Arquivos das chaves das conexões SSH do projeto (a sessão não pode ler). */
  serverKeys?: string[];
  /** Skills Globais que existem agora (`~/.claude/skills`, com as da conta e as sincronizadas). Ausente = nenhuma (ver skillAccess.ts). */
  globalSkills?: SkillSource[];
  /** Skills do projeto que existem agora (`<projeto>/.claude/skills`). Numa worktree, prepareRun soma a pasta dela. */
  projectSkills?: SkillSource[];
  /** Quem reporta a este funcionário (a seção "Sua equipe" da ficha). */
  team?: TeamMember[];
  /** Cargos prontos para contratar por roleId (só quem pode contratar; ver FichaContext.roles). */
  roles?: { id: string; label: string }[];
  /** Projetos que o dono liberou a este funcionário consultar (ver FichaContext.consult): ausente ou vazio = a ficha não tem a seção Consulta. */
  consult?: FichaContext['consult'];
  /**
   * Lançador dos MCPs da biblioteca e da ficha no Codex (os testes trocam; ausente = `mcpLaunchBundle()`, o pacote do build). null = sem lançador:
   * os MCPs que precisam dele ficam de fora e a ficha diz que estão indisponíveis.
   */
  mcpLauncher?: { command: string; args: string[] } | null;
  /** Agents da conta (padrão ~/.claude/agents); os testes trocam. */
  userAgentsDir?: string;
  /** Codex ligado nas configurações (`codexReview`): o funcionário do Claude ganha o MCP `perguntar_gpt` e o roteiro manda usá-lo. */
  codex?: boolean;
  /** "Permitir acesso à internet" (`internetAccess`): sem ela, o Claude perde WebSearch e WebFetch; o Codex ganha a frase da ficha. */
  internetAccess?: boolean;
  /** Claude contratado por um gestor no Codex e travado em `manual`: a ficha conta por que ele pede aprovação de tudo. */
  lockedByCodexManager?: boolean;
  /** Pacote do MCP de SSH para o Codex (os testes trocam; padrão dist/ssh-mcp.mjs). Sem ele, o MCP não entra e a ficha diz "indisponível". */
  sshMcpBundle?: string;
  /** Pacote do MCP de git (os testes trocam; padrão dist/git-mcp.mjs). Sem ele, o MCP não entra e a ficha diz "indisponível". Ver `gitLaunchOf`. */
  gitMcpBundle?: string;
  /** "Permitir que o GPT use meu Chrome" (`codexBrowser`), lida ao abrir a conversa. Sem ela, o Chrome não entra no Codex. */
  codexBrowser?: boolean;
  /** "Bloquear a tela do Claudio’s Club no navegador dos funcionários" (`clubGuard`). Só `false` desliga: ausente, bloqueia. */
  clubGuard?: boolean;
  /** CLI do Playwright MCP (os testes trocam; padrão CHROME_MCP_CLI). Sem ele, o Chrome não entra e a ficha diz "indisponível". */
  chromeMcpCli?: string;
  /** "Navegador" pedido na ficha, para o navegador limpo (ver cleanBrowserOf). Ausente = `profile.browser`. Não depende da extensão do Chrome. */
  cleanBrowser?: boolean;
  /** Canal do navegador limpo (os testes trocam). Ausente = detecta (ver cleanBrowserChannel); `null` = nenhum Chrome nem Edge. */
  cleanBrowserChannel?: 'chrome' | 'msedge' | null;
}

/** Onde o proxy do navegador limpo guarda o `initialize` e o `tools/list` do Playwright (ver navegadorMcp.ts): na pasta do Club, nunca no projeto. */
export const NAVEGADOR_CACHE_DIR = path.join(MYCO_HOME, 'cache', 'navegador-mcp');

/** CLI do Playwright MCP instalado com o Claudio’s Club (dependência fixa). Roda com o node do Club, nunca com npx. */
export const CHROME_MCP_CLI = path.join(ROOT, 'node_modules', '@playwright', 'mcp', 'cli.js');

/** A primeira mensagem de uma sessão nova numa conversa do Claudio’s Club. */
export function greeting(profile: Pick<StaffProfile, 'name' | 'firstTask'>): string {
  return profile.firstTask
    ? `Olá, ${profile.name}. Leia sua memória e comece pela primeira tarefa da ficha.`
    : `Olá, ${profile.name}. Leia sua memória e diga em poucas linhas como pretende começar.`;
}

/** Pasta de uma sessão: a gravada (retomar exige a mesma), ou a worktree, ou o projeto. */
export function sessionCwd(profile: StaffProfile, ctx: Pick<LaunchContext, 'projectPath' | 'worktree'>, sessionId: string | null): string {
  const known = sessionId ? profile.sessions.find((s) => s.id === sessionId)?.cwd : undefined;
  if (known) return known;
  if (sessionId && profile.sessions.some((s) => s.id === sessionId)) return ctx.projectPath; // anterior à worktree
  return ctx.worktree?.path ?? ctx.projectPath;
}

export interface PreparedRun {
  systemPromptFile: string;
  mcpConfigPath: string | null;
  strictMcp: boolean;
  addDirs: string[];
  settingsFile: string;
  agentsFile: string | null;
  keyFiles: string[];
  ftpServers: string[];
  pluginDir: string | null;
  /** "Permitir acesso à internet" (ver ClaudeArgsOptions.internetAccess): o que o buildClaudeArgs nega. */
  internetAccess?: boolean;
  /** Manual (docs/uso) editável: o projeto é o próprio Claudio’s Club e a sessão não roda numa worktree (ver ClaudeArgsOptions.manualEditable). */
  manualEditable: boolean;
  /** O navegador limpo (MCP `myco-navegador`) entrou nesta conversa: o buildClaudeArgs nega o que ele não usa (ver ClaudeArgsOptions.cleanBrowser). */
  cleanBrowser: boolean;
  /** O MCP de SSH (`myco-ssh`) entrou nesta conversa (ver sshLaunchOf): o buildClaudeArgs põe as de leitura em --allowedTools. */
  sshMcp: boolean;
  /** O MCP da memória (`myco-memoria`) entrou nesta conversa em `plan` (ver memoriaLaunchOf): o buildClaudeArgs o põe em --allowedTools. */
  memoriaMcp: boolean;
  /** O MCP de git (`myco-git`) entrou nesta conversa (ver gitLaunchOf): o buildClaudeArgs põe as de leitura em --allowedTools e, na revisão, nega as de escrita. */
  gitMcp: boolean;
  /** O MCP de tarefa (`myco-tarefa`) entrou nesta conversa (ver tarefaLaunchOf): o buildClaudeArgs o põe em --allowedTools. Nunca na conversa de revisão. */
  tarefaMcp: boolean;
}

/**
 * Ficha atualizada, prompt de sistema (identidade + ficha, em arquivo), config de MCP da ficha,
 * hooks do Claudio’s Club e os agents do roteiro, para a conversa no Claudio’s Club. Rodando fora
 * da pasta do projeto (worktree), a pasta das fichas entra em `--add-dir`.
 */
export async function prepareRun(profile: StaffProfile, ctx: LaunchContext, sessionId: string, cwd: string, readOnly = false): Promise<PreparedRun> {
  const away = path.resolve(cwd) !== path.resolve(ctx.projectPath);
  const dir = path.join(ctx.runDir, sessionId);
  // MCP de SSH: o mesmo do Codex (ver sshLaunchOf). O terminal não tem ssh (o hook remote-guard barra), então o acesso é só por ele.
  const ssh = sshLaunchOf(profile, ctx, cwd);
  // Em plan e na conversa de revisão, o MCP que grava só a memória da própria ficha (ver memoriaLaunchOf): a edição de arquivos está bloqueada.
  const memoria = memoriaLaunchOf(profile, ctx, readOnly);
  // MCP de git (commit, push e PR): o mesmo nos dois motores (ver gitLaunchOf).
  const git = await gitLaunchOf(profile, ctx, cwd, dir, readOnly);
  // MCP de tarefa (cancelar, pedir cancelamento, recusar): só aqui, no Claude, e nunca na revisão (ver tarefaLaunchOf).
  const tarefa = tarefaLaunchOf(profile, ctx, readOnly);
  // Navegador limpo: pela ficha (`browser` efetivo não entra aqui), então vale sem a extensão do Chrome. O SSH não entra aqui: no Claude o terminal
  // tem rede, então tirar o navegador por causa do SSH não fecharia canal nenhum (no Codex, a sandbox fecha a rede e o caso é outro; ver cleanBrowserOf).
  const cleanDir = path.join(dir, 'navegador');
  const clean = cleanBrowserOf(ctx.cleanBrowser ?? profile.browser, ctx, false, cleanDir);
  const fichaCtx = await writeFicha(profile, await withCwdSkills(ctx, cwd, away), away, { ssh: ssh.info, cleanBrowser: clean.info, memoria: memoria.info, git: git.info, tarefa: tarefa.info });
  const systemPromptFile = path.join(dir, 'system.md');
  // Memória pessoal: só no system.md desta execução (fora do .md da ficha, que vai para o git do projeto).
  const personal = profile.personId ? await readPersonMemory(profile.personId) : null;
  await writeAtomic(systemPromptFile, systemPrompt(profile, fichaCtx, renderFicha(profile, fichaCtx), personal?.text ?? null));
  // FTP: as conexões da ficha que existem e têm senha (ctx.servers já vem filtrado assim).
  const ftpServers = ftpServersOf(profile, ctx.servers);
  let mcpConfigPath: string | null = null;
  // O `perguntar_gpt` entra só com o Codex ligado nas configurações e só aqui, no motor Claude (no Codex, os MCPs da ficha entram por prepareCodexRun).
  const gpt = ctx.codex === true && profile.engine !== 'codex';
  if (profile.mcps !== null || ftpServers.length || gpt || clean.mcp || ssh.server || memoria.server || git.server || tarefa.server) {
    mcpConfigPath = path.join(dir, 'mcp.json');
    // Só com lista na ficha (refs `global:`/`project:`): com `mcps` null a conversa não leva `--strict-mcp-config` e o Claude Code carrega sozinho os do
    // ~/.claude.json, então copiá-los aqui subiria o mesmo servidor duas vezes. Os do Club entram sem valor: o comando é o lançador, que tira o segredo
    // do cofre ao subir (mcpLaunch.ts).
    const config = profile.mcps !== null ? await buildMcpConfig(ctx.projectPath, profile.mcps, ctx.claudeConfigFile) : { mcpServers: {} };
    if (ftpServers.length) {
      // Só nomes e caminhos: o MCP tira a senha do cofre sozinho.
      config.mcpServers[FTP_MCP_NAME] = ftpMcpServerConfig({ projectPath: ctx.projectPath, root: cwd, staffId: profile.id, connections: ftpServers, vaultDir: DEFAULT_SECRETS_DIR });
    }
    if (gpt) config.mcpServers[GPT_MCP_NAME] = gptMcpServerConfig({ projectPath: ctx.projectPath, root: cwd });
    if (clean.mcp) {
      // A pasta de capturas existe antes do processo. Sem `cwd`: o mcp.json do Claude não o usa.
      await mkdir(cleanDir, { recursive: true });
      config.mcpServers[CLEAN_BROWSER_MCP_NAME] = { type: 'stdio', command: clean.mcp.command, args: clean.mcp.args };
    }
    // O myco-ssh: só nomes e a escrita do lançamento (nenhuma chave; ver sshMcpServerConfig).
    if (ssh.server) config.mcpServers[SSH_MCP_NAME] = { type: 'stdio', command: ssh.server.command, args: ssh.server.args };
    // O myco-memoria: só o projeto e a ficha dona (nada de segredo; ver memoriaMcpServer).
    if (memoria.server) config.mcpServers[MEMORIA_MCP_NAME] = { type: 'stdio', command: memoria.server.command, args: memoria.server.args };
    // O myco-git: a cópia do pacote na pasta da conversa, a pasta de trabalho e a pasta da conversa (nada de segredo; ver gitMcpServer).
    if (git.server) config.mcpServers[GIT_MCP_NAME] = { type: 'stdio', command: git.server.command, args: git.server.args };
    // O myco-tarefa: só o endereço do Club e o projeto; o token vem do ambiente da conversa (MYCO_TOKEN), nunca deste arquivo (ver tarefaMcpServer).
    if (tarefa.server) config.mcpServers[TAREFA_MCP_NAME] = { type: 'stdio', command: tarefa.server.command, args: tarefa.server.args };
    await writeAtomic(mcpConfigPath, JSON.stringify(config, null, 2));
  }
  // Lembrete do estilo a cada mensagem (hook UserPromptSubmit): só com estilo no motor Claude; sem ele, nem arquivo nem hook.
  const styleFile = path.join(dir, 'style.txt');
  const reminder = (profile.engine ?? 'claude') === 'claude' ? personalityReminder(profile.personality) : '';
  if (reminder) await writeAtomic(styleFile, reminder);
  else await rm(styleFile, { force: true });
  const settingsFile = path.join(dir, 'settings.json');
  // Hooks do Claudio’s Club na pasta da conversa (cópia): o agente não edita o hook que guarda a regra (Edit e Write negados em run/**).
  const hooksDir = path.join(dir, 'hooks');
  await mkdir(hooksDir, { recursive: true });
  for (const file of GUARD_HOOK_FILES) await copyFile(path.join(HOOKS_DIR, file), path.join(hooksDir, file));
  // Política de escrita dos MCPs da ficha: o hook mcp-write-guard lê este arquivo. Sem política, nem arquivo nem hook.
  const mcpWriteFilePath = path.join(dir, 'mcp-write.json');
  const mcpWrite = await mcpWriteFileFor(ctx.projectPath, profile, ctx.claudeConfigFile);
  const hasPolicy = Object.keys(mcpWrite).length > 0;
  if (hasPolicy) await writeAtomic(mcpWriteFilePath, JSON.stringify(mcpWrite, null, 2));
  else await rm(mcpWriteFilePath, { force: true });
  const settings = staffSettings(profile, reminder ? styleFile : undefined, {
    clubGuard: ctx.clubGuard,
    hooksDir,
    mcpWriteFile: hasPolicy ? mcpWriteFilePath : null,
    skillOverrides: skillOverridesOf(fichaCtx.skillPlan?.off ?? []),
    projectPath: ctx.projectPath,
  });
  await writeAtomic(settingsFile, JSON.stringify(settings, null, 2));
  const agents = await ensurePlaybookAgents(profile, {
    projectPath: ctx.projectPath,
    cwd,
    userAgentsDir: ctx.userAgentsDir ?? path.join(defaultLocations().home, 'agents'),
    backupDir: path.join(ctx.runDir, 'agent-backups'),
  });
  if (agents.created.length) {
    console.log(`[staff] ${profile.name}: criado ${agents.created.join(', ')} em ${path.join(ctx.projectPath, '.claude', 'agents')} (roteiro da ficha)`);
  }
  let agentsFile: string | null = null;
  if (Object.keys(agents.inline).length) {
    agentsFile = path.join(dir, 'agents.json');
    await writeAtomic(agentsFile, JSON.stringify(agents.inline, null, 2));
  }
  // As skills do projeto que a Global de mesmo nome esconderia (ver skillAccess.planSkills): um plugin só desta sessão. Sempre roda,
  // para apagar o plugin de um lançamento anterior mesmo quando a ficha não marca nada.
  const plugin = await buildSkillPlugin(fichaCtx.skillPlan?.plugin ?? [], path.join(dir, 'myco-plugin'));
  return {
    systemPromptFile,
    mcpConfigPath,
    // Sem lista de MCPs na ficha (todos), o de FTP e o do GPT só se somam aos do projeto e do usuário.
    strictMcp: profile.mcps !== null,
    addDirs: away ? [staffDir(ctx.projectPath)] : [],
    settingsFile,
    agentsFile,
    keyFiles: ctx.serverKeys ?? [],
    ftpServers,
    pluginDir: plugin?.dir ?? null,
    internetAccess: ctx.internetAccess,
    // Só o projeto ROOT sem worktree: a worktree (away) tem o próprio docs/uso, que não é o do ROOT, e continua negada.
    manualEditable: !away && isClaudeRoot(ctx.projectPath),
    cleanBrowser: clean.mcp !== null,
    sshMcp: ssh.server !== null,
    memoriaMcp: memoria.server !== null,
    gitMcp: git.server !== null,
    tarefaMcp: tarefa.server !== null,
  };
}

/**
 * O que a conversa de CONSULTA (server/consult/) precisa nos dois motores: a ficha compacta, sem `writeFicha` (que reescreve o `.md` real e cria a memória) e sem memória, e no Claude o
 * mcp.json vazio e as regras de negação. Nada de worktree, MCP, agents, plugin nem hook. `otherProjects`: as pastas dos OUTROS projetos (negadas nos dois motores).
 */
export async function prepareConsultRun(
  profile: StaffProfile,
  ctx: Pick<LaunchContext, 'company' | 'projectName' | 'projectPath' | 'runDir' | 'serverKeys' | 'servers'>,
  sessionId: string,
  o: { otherProjects: string[]; engine: 'claude' | 'codex' },
): Promise<{ instructions: string; systemPromptFile: string; mcpConfigPath: string; deny: string[] }> {
  const dir = path.join(ctx.runDir, sessionId);
  const fichaCtx: FichaContext = { company: ctx.company, projectName: ctx.projectName, projectPath: ctx.projectPath, managerNames: [], fichaPath: '', memoryPath: '', mycoUrl: '' };
  // O CLAUDE.md do projeto entra no prompt só no Claude (que abre com `--setting-sources user`, sem o CLAUDE.md do projeto); o Codex lê o AGENTS.md dele sozinho.
  const instructions = consultSystemPrompt(profile, fichaCtx, o.engine === 'claude' ? await readConsultGuide(ctx.projectPath) : null);
  const systemPromptFile = path.join(dir, 'system.md');
  const mcpConfigPath = path.join(dir, 'mcp.json');
  if (o.engine === 'claude') {
    await mkdir(dir, { recursive: true });
    await writeAtomic(systemPromptFile, instructions);
    // Sem MCP nenhum: o arquivo existe e é vazio (nunca JSON na linha de comando).
    await writeAtomic(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
  }
  return { instructions, systemPromptFile, mcpConfigPath, deny: consultDenyRules(profile, { otherProjects: o.otherProjects, keyFiles: ctx.serverKeys, ftpServers: ftpServersOf(profile, ctx.servers) }) };
}

export interface PreparedCodexRun {
  /** Identidade e ficha, para o `developer_instructions` do Codex (ver ficha.ts: sem o que o Codex não tem). */
  instructions: string;
  /** Pastas fora da pasta de trabalho onde a sandbox de escrita pode gravar (a pasta das fichas e da memória, numa worktree). */
  writableRoots: string[];
  /** A ficha do próprio funcionário (JSON, Markdown e histórico): só leitura na sandbox, para ele não mudar o motor e a autonomia (ver seal.ts). */
  readOnlyPaths: string[];
  /** Onde fica o thread_id da conversa (retomar depois), ao lado dos arquivos de lançamento dela. */
  threadFile: string;
  /** MCP de SSH (só conexões SSH da ficha; null = sem). Nunca no projeto do próprio Claudio’s Club (ver `sshLaunchOf`). */
  sshMcp: CodexMcpServer | null;
  /** MCP da memória da própria ficha (null = sem). Só em `plan`, onde a sandbox é de só leitura (ver `memoriaLaunchOf`). */
  memoriaMcp: CodexMcpServer | null;
  /** MCP de git (commit, push e PR fora da sandbox; null = sem). Ver `gitLaunchOf`. */
  gitMcp: CodexMcpServer | null;
  /** MCP do Chrome do usuário (null = sem). Só com a opção ligada, Navegador na ficha e sem o MCP de SSH na conversa (ver `codexChromeOf`). */
  chromeMcp: CodexMcpServer | null;
  /** MCP do navegador limpo (null = sem). Pedido na ficha (Navegador), com ou sem a extensão do Chrome; ver `cleanBrowserOf`. */
  cleanMcp: CodexMcpServer | null;
  /** MCPs da biblioteca do Club e da ficha (projeto, usuário, local), com o acesso da ficha (ver `codexMcpServers`). Sem valor de env ou cabeçalho. */
  extraMcps: CodexExtraMcp[];
  /** O arquivo de lançamento desta execução (`codex-mcp.json`, com os valores da ficha expandidos), ou null se não gravou. O CodexProcess o apaga ao fechar a conversa. */
  mcpSnapshotFile: string | null;
  /** Agents da ficha e do roteiro como subagents do Codex (TOML já gravado na pasta da conversa; ver `writeCodexAgents`). */
  agents: CodexAgentRole[];
  /** A fila de validação pesada no terminal: o hook (cópia na pasta da conversa) e a trava; null se a cópia falhou (ver `codexHeavyArgs`). */
  heavyGuard: CodexHeavyGuard | null;
}

/**
 * O Chrome do usuário no Codex: o MCP só entra com a opção "Permitir que o GPT use meu Chrome" ligada, Navegador na ficha, sem o MCP de SSH
 * na mesma conversa (não juntar servidor e logins) e com o pacote instalado. `info` é o que a ficha diz (undefined: a ficha não tem Navegador).
 */
export function codexChromeOf(
  profile: Pick<StaffProfile, 'browser' | 'mcpAccess'>,
  ctx: Pick<LaunchContext, 'codexBrowser' | 'chromeMcpCli' | 'clubGuard'>,
  sshAttached: boolean,
  chromeDir: string,
): { mcp: CodexMcpServer | null; info?: CodexChromeInfo } {
  if (!profile.browser) return { mcp: null };
  const cli = ctx.chromeMcpCli ?? CHROME_MCP_CLI;
  // A chave do Claude in Chrome vale aqui também: é o mesmo Chrome do usuário (ver mcpAccess.ts). Sem lista de leitura para o Chrome,
  // `readonly` e `ask` desligam o Chrome no Codex (não há como perguntar, nem como filtrar).
  const access = codexMcpAccess(profile.mcpAccess, CODEX_CHROME_MCP_NAME, ['claude-in-chrome'], null);
  const motivos: CodexChromeInfo['motivos'] = [];
  if (ctx.codexBrowser !== true) motivos.push('config');
  if (sshAttached) motivos.push('ssh');
  if (!access.attached) motivos.push('politica');
  if (!existsSync(cli)) motivos.push('indisponivel');
  if (motivos.length) return { mcp: null, info: { mcp: false, motivos } };
  // A pasta é da conversa (`<mycoHome>/run/<sessionId>/chrome`), fora de qualquer projeto e do repo do Club: o MCP não lê nem grava fora dela.
  return {
    // --blocked-origins: o Chrome é o do dono, pareado; a tela do Club fica fora do alcance do agente (ver server/clubAddress.ts).
    // Sem ele só com o bloqueio desligado nas Configurações (`clubGuard: false`).
    mcp: {
      command: process.execPath,
      args: [cli, '--extension', '--output-dir', chromeDir, ...(ctx.clubGuard === false ? [] : ['--blocked-origins', clubBlockedOrigins()])],
      cwd: chromeDir,
      ...(access.enabledTools ? { enabledTools: access.enabledTools } : {}),
    },
    info: { mcp: true, motivos: [] },
  };
}

/**
 * O navegador limpo usa o Chrome já instalado e, se não houver, o Edge: nada se baixa. Procura nos lugares onde o Playwright procura.
 * `null` = nenhum dos dois.
 */
export function cleanBrowserChannel(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): 'chrome' | 'msedge' | null {
  let chrome: string[] = [];
  let edge: string[] = [];
  if (platform === 'win32') {
    const bases = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)'] ?? env['ProgramFiles(x86)']].filter((b): b is string => !!b);
    chrome = bases.map((b) => path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    edge = bases.map((b) => path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else if (platform === 'darwin') {
    chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
    edge = ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  } else if (platform === 'linux') {
    chrome = ['/opt/google/chrome/chrome'];
    edge = ['/opt/microsoft/msedge/msedge'];
  }
  if (chrome.some((p) => existsSync(p))) return 'chrome';
  if (edge.some((p) => existsSync(p))) return 'msedge';
  return null;
}

/**
 * O navegador limpo (MCP `myco-navegador`): um Chrome à parte, sem janela, sem login nem cookies do dono. Entra quando a ficha pede Navegador
 * (`wanted`, sem depender da extensão do Chrome) e nenhum motivo barra: a internet desligada (o navegador é acesso à internet), um servidor SSH
 * na conversa (no Codex, por ser canal para o conteúdo do servidor sair), o pacote ausente ou nenhum Chrome/Edge. `info` é o que a ficha diz
 * (undefined: a ficha não pede navegador).
 */
export function cleanBrowserOf(
  wanted: boolean,
  ctx: Pick<LaunchContext, 'internetAccess' | 'chromeMcpCli' | 'clubGuard' | 'cleanBrowserChannel'>,
  sshAttached: boolean,
  dir: string,
): { mcp: CodexMcpServer | null; info?: CleanBrowserInfo } {
  if (!wanted) return { mcp: null };
  const cli = ctx.chromeMcpCli ?? CHROME_MCP_CLI;
  const channel = ctx.cleanBrowserChannel === undefined ? cleanBrowserChannel() : ctx.cleanBrowserChannel;
  const motivos: CleanBrowserInfo['motivos'] = [];
  if (ctx.internetAccess === false) motivos.push('internet');
  if (sshAttached) motivos.push('ssh');
  if (!existsSync(cli)) motivos.push('indisponivel');
  if (!channel) motivos.push('sem-chrome');
  if (!channel || motivos.length) return { mcp: null, info: { mcp: false, motivos } };
  return {
    // --isolated: perfil em memória, apagado ao fechar (nada no disco, nenhum cookie nem login do dono). --headless: sem janela, não rouba o foco
    // do dono e deixa vários funcionários rodarem juntos; a captura de tela e o snapshot saem iguais. --browser: o Chrome ou o Edge já instalados,
    // sem baixar um do Playwright. --no-webmcp: o que a página registra seria ferramenta de terceiros (injeção). --blocked-origins: a tela do Club
    // (ver clubBlockedOrigins). Não é barreira (diz o README do Playwright); no Claude a barreira é o hook club-guard, que também pega
    // `mcp__.*__browser_.*`. Sem trava por isClaudeRoot: o que vale para um motor no projeto do Club vale para o outro.
    // Esses argumentos são os do Playwright de verdade; quem sobe na conversa é o proxy preguiçoso (navegadorMcp.ts), que responde `initialize` e
    // `tools/list` do cache e só abre o Playwright (~117 MB) no primeiro uso do navegador, repassando tudo a ele sem mudar nada.
    mcp: {
      ...lazyNavegadorCommand(
        {
          command: process.execPath,
          args: [cli, '--isolated', '--headless', '--browser', channel, '--no-webmcp', '--output-dir', dir, ...(ctx.clubGuard === false ? [] : ['--blocked-origins', clubBlockedOrigins()])],
        },
        NAVEGADOR_CACHE_DIR,
      ),
      cwd: dir,
    },
    info: { mcp: true, motivos: [] },
  };
}

/** As conexões SSH da ficha que existem no projeto (FTP fica de fora: no Codex não há). */
export function sshServersOf(profile: Pick<StaffProfile, 'servers'>, servers: ServerInfo[] | undefined): string[] {
  const ssh = new Set((servers ?? []).filter((s) => s.source === 'vps').map((s) => s.name));
  return profile.servers.filter((n) => ssh.has(n));
}

/**
 * O MCP da memória da própria ficha (`myco-memoria`), igual nos dois motores: só com autonomia `plan` (nas outras a edição de arquivos funciona,
 * e o comportamento delas não muda) e com o acesso a ele ligado na ficha (`mcpAccess`: `off`, e também `readonly` e `ask`, que não têm lista de
 * leitura para esta ferramenta, deixam o MCP de fora). Sem pacote do build ele roda pelo tsx, como o de FTP. `info` é o que a ficha diz
 * (undefined: não é plan). O MCP só leva o projeto e a ficha dona; o que ele grava está limitado em memoriaMcp.ts.
 */
export function memoriaLaunchOf(
  profile: Pick<StaffProfile, 'id' | 'autonomy' | 'mcpAccess'>,
  ctx: Pick<LaunchContext, 'projectPath'>,
  readOnly = false,
): { info?: MemoriaInfo; server: { command: string; args: string[] } | null } {
  // A conversa de revisão (`readOnly`) também não edita arquivo: a memória dela segue o mesmo caminho do plan, mesmo com a ficha em outra autonomia.
  if (profile.autonomy !== 'plan' && !readOnly) return { server: null };
  const review = readOnly && profile.autonomy !== 'plan';
  if (!codexMcpAccess(profile.mcpAccess, MEMORIA_MCP_NAME, [], null).attached) return { info: { mcp: false, ...(review && { review }) }, server: null };
  return { info: { mcp: true, ...(review && { review }) }, server: memoriaMcpServer({ projectPath: ctx.projectPath, staffId: profile.id }) };
}

/**
 * O MCP de tarefa (`myco-tarefa`): cancelar, pedir cancelamento, recusar pedido de cancelamento e decidir o limite de revisões (`tarefa_decidir_limite`) pelas mesmas rotas HTTP do curl, com o `MYCO_TOKEN` da conversa. Só no
 * Claude (o Codex segue pelo curl, onde não há classificador: ver server/staff/tarefaText.ts), nunca na conversa de revisão (o revisor não cancela) e com o acesso
 * `myco-tarefa` ligado na ficha (`off`, e também `readonly` e `ask`, que não têm lista de leitura para ele, deixam o MCP de fora). Sem endereço do Club, não entra.
 * `info` é o que a ficha diz (undefined: Codex). O MCP não abre permissão nenhuma: o servidor confere token, quem pediu, responsável atual, pedido e coluna.
 */
export function tarefaLaunchOf(
  profile: Pick<StaffProfile, 'projectId' | 'engine' | 'mcpAccess'>,
  ctx: Pick<LaunchContext, 'mycoUrl'>,
  readOnly = false,
): { info?: TarefaInfo; server: { command: string; args: string[] } | null } {
  if ((profile.engine ?? 'claude') !== 'claude') return { server: null };
  if (readOnly || !ctx.mycoUrl || !codexMcpAccess(profile.mcpAccess, TAREFA_MCP_NAME, [], null).attached) return { info: { mcp: false }, server: null };
  return { info: { mcp: true }, server: tarefaMcpServer({ api: ctx.mycoUrl, projectId: profile.projectId }) };
}

/** A pasta (ou alguma acima dela) tem `.git`? Vale o arquivo da worktree também. */
function inGitRepo(dir: string): boolean {
  for (let d = path.resolve(dir); ; ) {
    if (existsSync(path.join(d, '.git'))) return true;
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}

/** O MCP de git (`myco-git`) de uma conversa, igual nos dois motores (ver `gitLaunchOf`). */
export interface GitLaunch {
  /** O que a ficha diz (undefined: a pasta não é um repositório git). */
  info?: GitInfo;
  /** Comando e argumentos do MCP (null = não entra). O Claude põe em mcp.json; o Codex acrescenta `cwd` e `enabled_tools`. */
  server: { command: string; args: string[] } | null;
  /** Ferramentas que o Codex vê (`enabled_tools`): só as de leitura com `readonly`, `ask` ou na revisão. Ausente = todas (a política confere a cada chamada). */
  enabledTools?: string[];
}

/**
 * O MCP de git (`myco-git`), igual nos dois motores: commit, push e PR fora da sandbox do Codex (onde o `.git` é só leitura e não há rede nem as credenciais
 * do dono). Entra em pasta de repositório git, com o pacote do build e com o acesso `myco-git` ligado na ficha (`off` fica fora; `readonly` e `ask` no Codex
 * só veem a leitura). O pacote é COPIADO para `<sessão>/git-mcp.mjs` (a sandbox nega `run/`): o código que usa as credenciais do dono nunca é o que o
 * agente edita, nem no projeto do próprio Club. A política da conversa (`git-policy.json`, a mesma pasta) é gravada aqui e o MCP a relê a cada chamada.
 */
export async function gitLaunchOf(
  profile: Pick<StaffProfile, 'autonomy' | 'mcpAccess' | 'engine'>,
  ctx: Pick<LaunchContext, 'projectPath' | 'gitMcpBundle'>,
  cwd: string,
  sessionDir: string,
  readOnly = false,
): Promise<GitLaunch> {
  if (!inGitRepo(cwd)) return { server: null };
  const access = codexMcpAccess(profile.mcpAccess, GIT_MCP_NAME, [], GIT_READ_TOOLS);
  if (!access.attached) return { info: { mcp: false, motivos: ['politica'] }, server: null };
  const bundle = ctx.gitMcpBundle ?? GIT_MCP_BUNDLE;
  const copy = path.join(sessionDir, 'git-mcp.mjs');
  const copied = gitBundleExists(bundle) && (await mkdir(sessionDir, { recursive: true }).then(() => copyFile(bundle, copy)).then(() => true, () => false));
  if (!copied) return { info: { mcp: false, motivos: ['indisponivel'] }, server: null };
  const level = profile.mcpAccess?.[GIT_MCP_NAME];
  const policy = { engine: profile.engine === 'codex' ? ('codex' as const) : ('claude' as const), access: level === 'ask' || level === 'readonly' ? level : ('free' as const), autonomy: profile.autonomy, review: readOnly };
  await writeGitPolicy(sessionDir, policy);
  const grant = gitGrant(policy);
  return {
    info: { mcp: true, motivos: [], level: grant.level, ...(grant.level !== 'all' ? { why: grant.why } : {}) },
    server: gitMcpServer({ bundle: copy, projectPath: ctx.projectPath, root: cwd, runDir: sessionDir }),
    ...(access.enabledTools || readOnly ? { enabledTools: [...GIT_READ_TOOLS] } : {}),
  };
}

/** O MCP de SSH (`myco-ssh`) de uma conversa, igual nos dois motores (ver `sshLaunchOf`). */
export interface SshLaunch {
  /** O que a ficha diz (undefined: a ficha não tem conexão SSH). */
  info?: SshInfo;
  /** Comando e argumentos do MCP (null = não entra). O Claude põe em mcp.json; o Codex acrescenta `cwd` e `enabled_tools`. */
  server: { command: string; args: string[] } | null;
  /** Ferramentas que o Codex vê (`enabled_tools`): as de leitura, com `readonly` ou `ask`. Ausente = todas (sem regra). */
  enabledTools?: string[];
  /** `ask` no Codex (que não pergunta): o SSH fica só de leitura, e a ficha avisa. */
  askAsReadonly: boolean;
}

/**
 * O MCP de SSH da conversa, com a mesma regra nos dois motores: só com conexão SSH na ficha, fora do projeto do próprio Claudio’s Club
 * (o MCP roda fora da sandbox, e no projeto do Club o funcionário poderia editar o código dele), com o pacote do build e com o acesso
 * `myco-ssh` ligado na ficha. A escrita (`ssh_executar` e `ssh_enviar`) só nas conexões de `sshWrite`, e só com autonomia que altera algo.
 */
export function sshLaunchOf(
  profile: Pick<StaffProfile, 'id' | 'servers' | 'sshWrite' | 'autonomy' | 'mcpAccess'>,
  ctx: Pick<LaunchContext, 'projectPath' | 'servers' | 'sshMcpBundle'>,
  cwd: string,
): SshLaunch {
  const names = sshServersOf(profile, ctx.servers);
  const root = names.length > 0 && isClaudeRoot(ctx.projectPath);
  const bundle = ctx.sshMcpBundle ?? SSH_MCP_BUNDLE;
  // Escrita do lançamento: a sshWrite da ficha (de conexões do projeto), só com autonomia que altera algo. Vai no `--write`.
  const write = WRITE_AUTONOMY.includes(profile.autonomy) ? (profile.sshWrite ?? []).filter((n) => names.includes(n)) : [];
  // Acesso ao MCP: `off` fica fora da conversa; `readonly` e `ask` entram só com as ferramentas de leitura (o Codex não pergunta; o Claude filtra pelo hook).
  const access = codexMcpAccess(profile.mcpAccess, CODEX_SSH_MCP_NAME, [], SSH_READ_TOOLS);
  // Sem o pacote do build, o MCP não sobe (nunca pelo tsx): a ficha diz que o servidor está indisponível.
  const bundleOk = existsSync(bundle);
  const attached = names.length > 0 && !root && bundleOk && access.attached;
  const info: SshInfo | undefined = names.length
    ? {
        mcp: attached,
        names,
        writable: attached ? write : [],
        root,
        indisponivel: names.length > 0 && !root && !bundleOk,
        politica: names.length > 0 && !root && bundleOk && !access.attached,
      }
    : undefined;
  let server: SshLaunch['server'] = null;
  if (attached) {
    const cfg = sshMcpServerConfig({ projectPath: ctx.projectPath, root: cwd, staffId: profile.id, connections: names, write, autonomy: profile.autonomy, bundle });
    server = { command: cfg.command, args: cfg.args };
  }
  return { info, server, enabledTools: access.enabledTools, askAsReadonly: names.length > 0 && !root && access.askAsReadonly };
}

/**
 * O que o Codex precisa para a conversa: a ficha atualizada (e a memória criada) e o texto de instruções. Os MCPs são o de SSH, o do Chrome,
 * o do navegador limpo e os da biblioteca e da ficha (projeto, usuário e local, pelo lançador; ver `codexMcpServers`). Os agents da ficha e do
 * roteiro viram subagents do Codex (um TOML por agent, ver codexAgents.ts). Sem hooks nem plugin de skills: não existem no Codex. As skills marcadas que existem entram na ficha como lista (nome, descrição e o caminho do
 * SKILL.md, sem copiar nada; ver ficha.ts). O texto vai em `developer_instructions` na linha de comando; passando de ~24 KB (ou
 * no Windows) o CodexProcess o manda no começo do prompt da primeira mensagem (o Codex não tem arquivo para isso sem trocar as instruções base).
 */
export async function prepareCodexRun(profile: StaffProfile, ctx: LaunchContext, sessionId: string, cwd: string, readOnly = false): Promise<PreparedCodexRun> {
  const away = path.resolve(cwd) !== path.resolve(ctx.projectPath);
  // MCP de SSH: o mesmo do Claude (ver sshLaunchOf). Aqui roda fora da sandbox, com o cwd na pasta do Club e as ferramentas de leitura
  // (`enabled_tools`) quando `readonly` ou `ask`, porque o Codex não pergunta.
  const ssh = sshLaunchOf(profile, ctx, cwd);
  let sshMcp: CodexMcpServer | null = null;
  if (ssh.server) sshMcp = { ...ssh.server, cwd: ROOT, ...(ssh.enabledTools ? { enabledTools: ssh.enabledTools } : {}) };
  // Memória da própria ficha: em plan (e na revisão) a sandbox é de só leitura e não aceita exceção por caminho, então o MCP (fora dela) é a porta de escrita.
  const memoria = memoriaLaunchOf(profile, ctx, readOnly);
  const memoriaMcp: CodexMcpServer | null = memoria.server ? { ...memoria.server, cwd: ROOT } : null;
  // Git: na sandbox o `.git` é só leitura e não há rede, então commit, push e PR vão por este MCP, fora dela (ver gitLaunchOf). A cópia do pacote e a política ficam em run/<sessão>.
  const git = await gitLaunchOf(profile, ctx, cwd, path.join(ctx.runDir, sessionId), readOnly);
  const gitMcp: CodexMcpServer | null = git.server ? { ...git.server, cwd: ROOT, ...(git.enabledTools ? { enabledTools: git.enabledTools } : {}) } : null;
  // Chrome do usuário: depois do SSH, porque o MCP de SSH na conversa desliga o Chrome (não juntar servidor e logins).
  const chromeDir = path.join(ctx.runDir, sessionId, 'chrome');
  const chrome = codexChromeOf(profile, ctx, sshMcp !== null, chromeDir);
  // A pasta do MCP existe antes do processo (o cwd dele): só quando o MCP entra.
  if (chrome.mcp) await mkdir(chromeDir, { recursive: true });
  // Navegador limpo: depois do Chrome, com a mesma regra de SSH. Não depende da extensão do Chrome (a ficha que pede Navegador).
  const cleanDir = path.join(ctx.runDir, sessionId, 'navegador');
  const clean = cleanBrowserOf(ctx.cleanBrowser ?? profile.browser, ctx, sshMcp !== null, cleanDir);
  if (clean.mcp) await mkdir(cleanDir, { recursive: true });
  // MCPs da biblioteca e da ficha (projeto, usuário, local), pelo lançador: o arquivo de lançamento fica na pasta da conversa (a sandbox nega).
  // Sem lançador (o build não existe), os que precisam dele ficam de fora e a ficha diz. Os de HTTP sem cabeçalho não precisam.
  const launcher = ctx.mcpLauncher !== undefined ? ctx.mcpLauncher : mcpLaunchBundle();
  const extra = await codexMcpServers(ctx.projectPath, profile.mcps, ctx.claudeConfigFile, {
    access: profile.mcpAccess,
    snapshotFile: path.join(ctx.runDir, sessionId, 'codex-mcp.json'),
    launcher,
  });
  // O que o Codex deixou só leitura por causa de "pede antes" (a ficha diz): o SSH e os MCPs da ficha. O Chrome não entra aqui: sem lista de leitura, ask o desliga.
  const asked = [...(ssh.askAsReadonly ? [CODEX_SSH_MCP_NAME] : []), ...extra.asked];
  // Agents da ficha e do roteiro como subagents do Codex. Cria os presets que faltam (igual ao Claude, ver prepareRun) e grava um TOML por agent
  // na pasta da conversa em run/: a sandbox a nega (o agente não lê nem troca o TOML), uma por conversa (fichas concorrentes não se
  // sobrescrevem) e fora do git.
  const userAgentsDir = ctx.userAgentsDir ?? path.join(defaultLocations().home, 'agents');
  const agentNames = [...new Set([...(profile.playbook ? PLAYBOOK_AGENTS[profile.playbook] : []), ...profile.agents])];
  const created = await ensurePlaybookAgents(profile, {
    projectPath: ctx.projectPath,
    cwd,
    userAgentsDir,
    backupDir: path.join(ctx.runDir, 'agent-backups'),
  });
  if (created.created.length) {
    console.log(`[staff] ${profile.name}: criado ${created.created.join(', ')} em ${path.join(ctx.projectPath, '.claude', 'agents')} (roteiro da ficha)`);
  }
  const { roles: agentRoles, missing: agentsMissing } = await writeCodexAgents(agentNames, {
    cwd,
    projectPath: ctx.projectPath,
    userAgentsDir,
    outDir: path.join(ctx.runDir, sessionId, 'codex-agents'),
  });
  const fichaCtx = await writeFicha(profile, await withCwdSkills(ctx, cwd, away), away, {
    codexAgents: { available: agentRoles.map((r) => r.name), missing: agentsMissing },
    ssh: ssh.info,
    memoria: memoria.info,
    git: git.info,
    codexChrome: chrome.info,
    codexMcpAsked: asked,
    codexMcpOut: extra.out,
    cleanBrowser: clean.info,
  });
  // A config dos MCPs do projeto e deste projeto (.mcp.json) e o próprio lançador ficam só leitura: o agente não troca o comando de um MCP
  // no meio do caminho (o Codex lê a ficha a cada mensagem), e o lançador, que roda fora da sandbox, não é reescrito por ele (quando o projeto é o do Club).
  const mcpJson = [...new Set([path.join(cwd, '.mcp.json'), path.join(ctx.projectPath, '.mcp.json')])];
  const bundleInCwd = isInside(cwd, MCP_LAUNCH_BUNDLE) ? [MCP_LAUNCH_BUNDLE] : [];
  // Fila de validação pesada e bloqueio do git destrutivo (hooks do terminal). Os hooks rodam FORA da sandbox: a cópia fica na pasta da conversa (a sandbox a nega), não no
  // projeto, que o agente pode editar. Se não deu para copiar, a conversa roda sem a fila, sem o bloqueio e sem a flag de confiança (nunca flag sem o hook).
  const hooksDir = path.join(ctx.runDir, sessionId, 'hooks');
  const heavyGuard = await mkdir(hooksDir, { recursive: true })
    .then(() => Promise.all([...HEAVY_HOOK_FILES, ...GIT_HOOK_FILES].map((f) => copyFile(path.join(HOOKS_DIR, f), path.join(hooksDir, f)))))
    .then((): CodexHeavyGuard => ({
      hook: path.join(hooksDir, 'heavy-guard.mjs'),
      lockDir: heavyLockDir(),
      ownerPid: process.pid,
      git: { hook: path.join(hooksDir, 'git-guard.mjs'), projectPath: ctx.projectPath },
    }))
    .catch((err) => {
      console.warn(`[staff] ${profile.name}: sem a fila de validação pesada e sem o bloqueio de git destrutivo no Codex (${err instanceof Error ? err.message : String(err)})`);
      return null;
    });
  return {
    instructions: systemPrompt(profile, fichaCtx, renderFicha(profile, fichaCtx)),
    writableRoots: away ? [staffDir(ctx.projectPath)] : [],
    readOnlyPaths: [
      profileFile(ctx.projectPath, profile.id),
      fichaFile(ctx.projectPath, profile.id),
      historyDir(ctx.projectPath, profile.id),
      ...mcpJson,
      ...bundleInCwd,
    ],
    threadFile: path.join(ctx.runDir, sessionId, 'codex-thread.json'),
    sshMcp,
    memoriaMcp,
    gitMcp,
    chromeMcp: chrome.mcp,
    cleanMcp: clean.mcp,
    extraMcps: extra.servers,
    mcpSnapshotFile: extra.snapshotFile,
    agents: agentRoles,
    heavyGuard,
  };
}

/** `file` está dentro de `dir` (sem sair por `..` nem por outro drive). */
function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** As conexões FTP da ficha que estão no projeto (com senha). */
export function ftpServersOf(profile: Pick<StaffProfile, 'servers'>, servers: ServerInfo[] | undefined): string[] {
  const ftp = new Set((servers ?? []).filter((s) => s.source === 'ftp').map((s) => s.name));
  return profile.servers.filter((n) => ftp.has(n));
}

const HOOKS_DIR = path.join(ROOT, 'scripts', 'hooks');
const DELIVERY_HOOK = path.join(HOOKS_DIR, 'delivery-check.mjs');
const STYLE_HOOK = path.join(HOOKS_DIR, 'style-reminder.mjs');
/** Os hooks de guarda que a conversa leva na própria pasta (cópia, ver prepareRun): o agente não edita o que os aplica. */
const GUARD_HOOK_FILES = ['club-guard.mjs', 'mcp-write-guard.mjs', 'remote-guard.mjs', 'memory-guard.mjs', 'memory-cap.mjs', 'heavy-guard.mjs', 'heavy-lock.mjs', 'git-guard.mjs', 'git-guard-lib.mjs'] as const;
/** O hook da fila de validação pesada e a lib dele (o heavy-guard importa o heavy-lock da mesma pasta). Vão para a pasta do Claude e a do Codex. */
const HEAVY_HOOK_FILES = ['heavy-guard.mjs', 'heavy-lock.mjs'] as const;
/** O hook do git destrutivo e a regra dele (o git-guard importa o git-guard-lib da mesma pasta). Também vão para os dois motores. */
const GIT_HOOK_FILES = ['git-guard.mjs', 'git-guard-lib.mjs'] as const;
/** Ferramentas de navegador: o Claude in Chrome e os MCPs no padrão `browser_*` (Playwright e afins da biblioteca). */
export const BROWSER_TOOLS_MATCHER = 'mcp__claude-in-chrome__.*|mcp__.*__browser_.*';
/** Toda ferramenta de MCP: o hook de escrita decide pela política da ficha (sem política, não responde). */
export const MCP_TOOLS_MATCHER = 'mcp__.*';
/** Terminal (Bash e PowerShell): o hook de acesso remoto barra ssh, scp e afins, com ou sem servidor na ficha. */
export const REMOTE_GUARD_MATCHER = 'Bash|PowerShell';
/** Escrita de arquivo: o hook do teto da memória (scripts/hooks/memory-guard.mjs) confere o que vai para `.myco/staff/<id>.memory*`. */
export const MEMORY_GUARD_MATCHER = 'Write|Edit|MultiEdit';
/** Terminal também para a fila de validação pesada (suíte completa, tsc do projeto): uma por vez na máquina (scripts/hooks/heavy-guard.mjs). */
export const HEAVY_GUARD_MATCHER = 'Bash|PowerShell';
/** Terminal para o git que descarta mudança não commitada no checkout principal do projeto (scripts/hooks/git-guard.mjs). */
export const GIT_GUARD_MATCHER = 'Bash|PowerShell';
/** O hook da fila espera a vez aqui dentro, então o prazo dele passa dos 10 s dos outros: abaixo dele, a espera máxima do próprio hook (13 min). */
const HEAVY_GUARD_TIMEOUT_S = 15 * 60;

/**
 * Hooks do Claudio’s Club em todo funcionário (`--settings`, somados aos do usuário e do projeto): os agents
 * do roteiro rodam em primeiro plano e cada entrega do executor chega com o lembrete de conferir
 * (scripts/hooks/delivery-check.mjs). O node é chamado direto, sem shell: no Windows sem Git Bash
 * o Claude Code rodaria o comando no PowerShell.
 * Com estilo de comunicação (motor Claude), `outputStyle: 'default'`: o output style global do usuário (ex.: "Concise") brigaria com o estilo.
 * E, com o `styleFile` (style.txt da conversa), um hook UserPromptSubmit põe o lembrete do estilo em cada mensagem (scripts/hooks/style-reminder.mjs).
 * `hooksDir`: a pasta com a cópia dos hooks de guarda da conversa (prepareRun); sem ela, a do programa (só os testes usam). `mcpWriteFile`:
 * a política de escrita dos MCPs (mcp-write.json); sem ela, não há hook de MCP. `heavyLockDir`: a pasta da trava da fila de validação
 * pesada (uma por máquina; o padrão é a do servidor, ver heavyQueue.ts). `projectPath`: o checkout principal do projeto, onde o git-guard barra o
 * git que descarta trabalho não commitado; sem ele, não há esse hook (só os testes chamam sem; o lançamento sempre passa).
 */
export function staffSettings(
  p?: Pick<StaffProfile, 'personality' | 'engine'>,
  styleFile?: string,
  o: { clubGuard?: boolean; hooksDir?: string; mcpWriteFile?: string | null; skillOverrides?: Record<string, 'off'>; heavyLockDir?: string; projectPath?: string } = {},
) {
  const guards = o.hooksDir ?? HOOKS_DIR;
  const lockDir = o.heavyLockDir ?? heavyLockDir();
  // Fila de validação pesada: pega a vez antes (pre) e solta depois (post). PostToolUse só dispara com o comando que deu certo; teste vermelho
  // é falha da ferramenta e dispara só o PostToolUseFailure, então o mesmo hook vai nos dois.
  const heavy = (stage: 'pre' | 'post') => ({
    matcher: HEAVY_GUARD_MATCHER,
    hooks: [{ type: 'command', command: process.execPath, args: [path.join(guards, 'heavy-guard.mjs'), lockDir, stage], timeout: stage === 'pre' ? HEAVY_GUARD_TIMEOUT_S : 10 }],
  });
  const hook = (stage: 'pre' | 'post') => [
    { matcher: 'Agent|Task', hooks: [{ type: 'command', command: process.execPath, args: [DELIVERY_HOOK, stage], timeout: 10 }] },
    // O navegador do funcionário não abre a tela do Club (ver scripts/hooks/club-guard.mjs e server/clubAddress.ts).
    // `onFailure: 'block'` (Claude Code 2.1.295+): comando que não inicia, saída de erro, timeout ou saída inválida bloqueiam a
    // chamada em vez de deixá-la passar. Sem helper de versão do Claude no Club, vai sempre (ver doc de hooks).
    ...(stage === 'pre' && o.clubGuard !== false ? [{ matcher: BROWSER_TOOLS_MATCHER, hooks: [{ type: 'command', command: process.execPath, args: [path.join(guards, 'club-guard.mjs'), 'pre'], timeout: 10, onFailure: 'block' }] }] : []),
    // Escrita por MCP: o acesso da ficha (ver mcpAccess.ts). Sem regra de MCP, a conversa não tem o hook.
    ...(stage === 'pre' && o.mcpWriteFile ? [{ matcher: MCP_TOOLS_MATCHER, hooks: [{ type: 'command', command: process.execPath, args: [path.join(guards, 'mcp-write-guard.mjs'), o.mcpWriteFile], timeout: 10, onFailure: 'block' }] }] : []),
    // Acesso remoto no terminal: sempre, com ou sem servidor na ficha (ver scripts/hooks/remote-guard.mjs).
    ...(stage === 'pre' ? [{ matcher: REMOTE_GUARD_MATCHER, hooks: [{ type: 'command', command: process.execPath, args: [path.join(guards, 'remote-guard.mjs')], timeout: 10, onFailure: 'block' }] }] : []),
    // Git que descarta mudança não commitada no checkout principal: sempre, com `onFailure: 'block'` (hook que falha não deixa o reset passar; ver o topo do script).
    ...(stage === 'pre' && o.projectPath ? [{ matcher: GIT_GUARD_MATCHER, hooks: [{ type: 'command', command: process.execPath, args: [path.join(guards, 'git-guard.mjs'), o.projectPath], timeout: 10, onFailure: 'block' }] }] : []),
    // Teto da memória no Write/Edit (fora do plan, onde o MCP myco-memoria tem o dele): sempre, sem `onFailure`, porque um erro do hook não deve travar a edição (ver o topo do script).
    ...(stage === 'pre' ? [{ matcher: MEMORY_GUARD_MATCHER, hooks: [{ type: 'command', command: process.execPath, args: [path.join(guards, 'memory-guard.mjs')], timeout: 10 }] }] : []),
    heavy(stage),
  ];
  const styled = !!p && personalityName(p.personality) !== '' && (p.engine ?? 'claude') === 'claude';
  const style = styled && styleFile ? { UserPromptSubmit: [{ hooks: [{ type: 'command', command: process.execPath, args: [STYLE_HOOK, styleFile], timeout: 10 }] }] } : {};
  // Sem `permissions.ask` aqui: as ferramentas MCP de "pede antes" são do hook de escrita (mcp-write.json), que decide por ferramenta.
  return {
    hooks: { PreToolUse: hook('pre'), PostToolUse: hook('post'), PostToolUseFailure: [heavy('post')], ...style },
    ...(styled ? { outputStyle: 'default' } : {}),
    // Skills da Global (e as de projeto que ela esconde) que a ficha não marca: `off` some com o nome da pasta nesta conversa.
    // O `myco:<nome>` do plugin da sessão não é afetado (ver skillAccess.planSkills). Sem nenhuma, a chave não vai.
    ...(o.skillOverrides && Object.keys(o.skillOverrides).length ? { skillOverrides: o.skillOverrides } : {}),
  };
}

/** `skillOverrides` do settings: cada nome que não deve chegar nativo vira `off`. */
export function skillOverridesOf(off: string[]): Record<string, 'off'> {
  return Object.fromEntries(off.map((n) => [n, 'off' as const]));
}

/**
 * O contexto com as skills que a conversa vê: numa worktree (`away`), as do projeto da worktree entram junto com as do projeto
 * (a Claude Code carrega as duas pastas). Fora dela, o contexto fica como está.
 */
export async function withCwdSkills(ctx: LaunchContext, cwd: string, away: boolean): Promise<LaunchContext> {
  if (!away) return ctx;
  const here = await listSkillDirs(path.join(cwd, '.claude', 'skills'));
  return { ...ctx, projectSkills: [...(ctx.projectSkills ?? []), ...here] };
}

/** O que cada lançamento sabe e a ficha diz além do contexto (ver writeFicha). Ausente = nada a dizer sobre ele. */
export interface FichaRunInfo {
  /** O MCP de SSH da conversa (nos dois motores; ver sshLaunchOf). */
  ssh?: SshInfo;
  /** O MCP da memória da própria ficha, em `plan` (nos dois motores; ver memoriaLaunchOf). */
  memoria?: MemoriaInfo;
  /** O MCP de git da conversa (nos dois motores; ver gitLaunchOf). Ausente = a pasta não é um repositório git. */
  git?: GitInfo;
  /** O MCP de tarefa da conversa (só no Claude; ver tarefaLaunchOf). Ausente = sem MCP (Codex): a ficha manda o curl. */
  tarefa?: TarefaInfo;
  codexChrome?: CodexChromeInfo;
  codexMcpAsked?: string[];
  /** Codex: os MCPs da ficha que ficaram fora da conversa, com o motivo (ver `codexMcpServers`). */
  codexMcpOut?: Array<{ name: string; motivo: CodexMcpMotivo }>;
  cleanBrowser?: CleanBrowserInfo;
  /** Codex: os agents que viraram subagents e os que a ficha pede mas não existem (ver `writeCodexAgents`). */
  codexAgents?: { available: string[]; missing: string[] };
}

/**
 * (Re)gera a ficha em Markdown e cria a memória, se faltar. Roda na contratação e a cada sessão.
 * `absolute`: caminhos completos na identidade (a sessão roda noutra pasta, a worktree).
 */
export async function writeFicha(
  profile: StaffProfile,
  ctx: Pick<LaunchContext, 'company' | 'workspace' | 'projectName' | 'projectPath' | 'managerNames' | 'mycoUrl' | 'worktree' | 'servers' | 'team' | 'roles' | 'globalSkills' | 'projectSkills' | 'codex' | 'internetAccess' | 'clubGuard' | 'lockedByCodexManager' | 'consult'>,
  absolute = false,
  run: FichaRunInfo = {},
): Promise<FichaContext> {
  const rel = (file: string) => (absolute ? file : path.relative(ctx.projectPath, file));
  const fichaCtx: FichaContext = {
    company: ctx.company,
    workspace: ctx.workspace ?? null,
    projectName: ctx.projectName,
    projectPath: ctx.projectPath,
    managerNames: ctx.managerNames,
    fichaPath: rel(fichaFile(ctx.projectPath, profile.id)),
    memoryPath: rel(memoryFile(ctx.projectPath, profile.id)),
    mycoUrl: ctx.mycoUrl,
    worktree: profile.worktree ? (ctx.worktree ?? null) : null,
    servers: ctx.servers,
    team: ctx.team,
    roles: ctx.roles,
    ...(ctx.consult?.targets.length && { consult: ctx.consult }),
    // Lido a cada sessão (writeFicha roda em prepareRun): o plano (marcadas, o que some, o plugin e o que falta) sai da ficha e do disco agora.
    skillPlan: await skillPlanOf(profile.skills, { globalSkills: ctx.globalSkills ?? [], projectSkills: ctx.projectSkills ?? [] }),
    // Lido a cada sessão (writeFicha roda em prepareRun): criar ou apagar o SPEC.md vale na próxima conversa.
    guide: await hasGuide(ctx.projectPath),
    codex: ctx.codex,
    internetAccess: ctx.internetAccess,
    clubGuard: ctx.clubGuard,
    lockedByCodexManager: ctx.lockedByCodexManager,
    ssh: run.ssh,
    memoria: run.memoria,
    git: run.git,
    tarefa: run.tarefa,
    codexChrome: run.codexChrome,
    codexMcpAsked: run.codexMcpAsked,
    codexMcpOut: run.codexMcpOut,
    cleanBrowser: run.cleanBrowser,
    codexAgents: run.codexAgents,
    // Mesma regra de prepareRun (manualEditable): só o projeto do Claudio’s Club, fora de worktree.
    manualEditable: !absolute && isClaudeRoot(ctx.projectPath),
    // Numa worktree do projeto do Claudio’s Club, a documentação se edita na cópia (o ROOT segue negado: ver secretDenyRules).
    manualInCopy: absolute && isClaudeRoot(ctx.projectPath),
  };
  await writeAtomic(fichaFile(ctx.projectPath, profile.id), renderFicha(profile, fichaCtx));
  await ensureMemory(ctx.projectPath, profile);
  // Só no prompt da conversa (systemPrompt), não no .md da ficha: o tamanho da memória muda sozinho e não deve sujar o git.
  const size = memoryMeasure(await readFile(memoryFile(ctx.projectPath, profile.id), 'utf8').catch(() => ''));
  return memoryOver('index', size) ? { ...fichaCtx, memoryOver: size } : fichaCtx;
}

