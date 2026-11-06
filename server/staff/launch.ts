import path from 'node:path';
import type { ServerInfo, StaffProfile } from '../../shared/model';
import { defaultLocations } from '../adapters/claude/paths';
import { ROOT } from '../root';
import { renderFicha, systemPrompt, type FichaContext, type TeamMember } from './ficha';
import { FTP_MCP_NAME } from '../../shared/model';
import { DEFAULT_SECRETS_DIR } from '../secretVault';
import { ftpMcpServerConfig } from './ftpMcp';
import { buildMcpConfig } from './mcp';
import { ensurePlaybookAgents } from './playbookAgents';
import { buildSkillPlugin } from '../skillLibrary';
import { hasGuide } from '../projectGuide';
import { ensureMemory, fichaFile, memoryFile, staffDir, writeAtomic } from './store';
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
  /** Skills da ficha que estão na biblioteca do Claudio’s Club (vão no plugin da sessão). */
  librarySkills?: string[];
  /** Pasta da biblioteca (os testes trocam). */
  skillLibraryDir?: string;
  /** Quem reporta a este funcionário (a seção "Sua equipe" da ficha). */
  team?: TeamMember[];
  /** Cargos prontos para contratar por roleId (só quem pode contratar; ver FichaContext.roles). */
  roles?: { id: string; label: string }[];
  /** Agents da conta (padrão ~/.claude/agents); os testes trocam. */
  userAgentsDir?: string;
}

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
}

/**
 * Ficha atualizada, prompt de sistema (identidade + ficha, em arquivo), config de MCP da ficha,
 * hooks do Claudio’s Club e os agents do roteiro, para a conversa no Claudio’s Club. Rodando fora
 * da pasta do projeto (worktree), a pasta das fichas entra em `--add-dir`.
 */
export async function prepareRun(profile: StaffProfile, ctx: LaunchContext, sessionId: string, cwd: string): Promise<PreparedRun> {
  const away = path.resolve(cwd) !== path.resolve(ctx.projectPath);
  const fichaCtx = await writeFicha(profile, ctx, away);
  const dir = path.join(ctx.runDir, sessionId);
  const systemPromptFile = path.join(dir, 'system.md');
  // Memória pessoal: só no system.md desta execução (fora do .md da ficha, que vai para o git do projeto).
  const personal = profile.personId ? await readPersonMemory(profile.personId) : null;
  await writeAtomic(systemPromptFile, systemPrompt(profile, fichaCtx, renderFicha(profile, fichaCtx), personal?.text ?? null));
  // FTP: as conexões da ficha que existem e têm senha (ctx.servers já vem filtrado assim).
  const ftpServers = ftpServersOf(profile, ctx.servers);
  let mcpConfigPath: string | null = null;
  if (profile.mcps !== null || ftpServers.length) {
    mcpConfigPath = path.join(dir, 'mcp.json');
    const config = profile.mcps !== null ? await buildMcpConfig(ctx.projectPath, profile.mcps, ctx.claudeConfigFile) : { mcpServers: {} };
    if (ftpServers.length) {
      // Só nomes e caminhos: o MCP tira a senha do cofre sozinho.
      config.mcpServers[FTP_MCP_NAME] = ftpMcpServerConfig({ projectPath: ctx.projectPath, root: cwd, staffId: profile.id, connections: ftpServers, vaultDir: DEFAULT_SECRETS_DIR });
    }
    await writeAtomic(mcpConfigPath, JSON.stringify(config, null, 2));
  }
  const settingsFile = path.join(dir, 'settings.json');
  await writeAtomic(settingsFile, JSON.stringify(staffSettings(), null, 2));
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
  // As skills da biblioteca que a ficha tem: um plugin só desta sessão (as outras não veem).
  const plugin = ctx.librarySkills?.length ? await buildSkillPlugin(ctx.librarySkills, path.join(dir, 'myco-plugin'), ctx.skillLibraryDir) : null;
  return {
    systemPromptFile,
    mcpConfigPath,
    // Sem lista de MCPs na ficha (todos), o de FTP só se soma aos do projeto e do usuário.
    strictMcp: profile.mcps !== null,
    addDirs: away ? [staffDir(ctx.projectPath)] : [],
    settingsFile,
    agentsFile,
    keyFiles: ctx.serverKeys ?? [],
    ftpServers,
    pluginDir: plugin?.dir ?? null,
  };
}

/** As conexões FTP da ficha que estão no projeto (com senha). */
export function ftpServersOf(profile: Pick<StaffProfile, 'servers'>, servers: ServerInfo[] | undefined): string[] {
  const ftp = new Set((servers ?? []).filter((s) => s.source === 'ftp').map((s) => s.name));
  return profile.servers.filter((n) => ftp.has(n));
}

const DELIVERY_HOOK = path.join(ROOT, 'scripts', 'hooks', 'delivery-check.mjs');

/**
 * Hooks do Claudio’s Club em todo funcionário (`--settings`, somados aos do usuário e do projeto): os agents
 * do roteiro rodam em primeiro plano e cada entrega do executor chega com o lembrete de conferir
 * (scripts/hooks/delivery-check.mjs). O node é chamado direto, sem shell: no Windows sem Git Bash
 * o Claude Code rodaria o comando no PowerShell.
 */
export function staffSettings() {
  const hook = (stage: 'pre' | 'post') => [
    { matcher: 'Agent|Task', hooks: [{ type: 'command', command: process.execPath, args: [DELIVERY_HOOK, stage], timeout: 10 }] },
  ];
  return { hooks: { PreToolUse: hook('pre'), PostToolUse: hook('post') } };
}

/**
 * (Re)gera a ficha em Markdown e cria a memória, se faltar. Roda na contratação e a cada sessão.
 * `absolute`: caminhos completos na identidade (a sessão roda noutra pasta, a worktree).
 */
export async function writeFicha(
  profile: StaffProfile,
  ctx: Pick<LaunchContext, 'company' | 'workspace' | 'projectName' | 'projectPath' | 'managerNames' | 'mycoUrl' | 'worktree' | 'servers' | 'team' | 'roles' | 'librarySkills'>,
  absolute = false,
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
    librarySkills: ctx.librarySkills,
    // Lido a cada sessão (writeFicha roda em prepareRun): criar ou apagar o SPEC.md vale na próxima conversa.
    guide: await hasGuide(ctx.projectPath),
  };
  await writeAtomic(fichaFile(ctx.projectPath, profile.id), renderFicha(profile, fichaCtx));
  await ensureMemory(ctx.projectPath, profile);
  return fichaCtx;
}

