import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LaunchResult, ServerInfo, StaffProfile } from '../../shared/model';
import { defaultLocations } from '../adapters/claude/paths';
import { cleanEnv } from '../auth';
import { buildClaudeArgs, renderFicha, sanitizeArg, systemPrompt, toCmdLine, type FichaContext, type TeamMember } from './ficha';
import { buildMcpConfig } from './mcp';
import { ensurePlaybookAgents } from './playbookAgents';
import { ensureMemory, fichaFile, memoryFile, saveProfile, staffDir, writeAtomic } from './store';
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
  /** Arquivos das chaves desses servidores (a sessão não pode ler). */
  serverKeys?: string[];
  /** Quem reporta a este funcionário (a seção "Sua equipe" da ficha). */
  team?: TeamMember[];
  /** Agents da conta (padrão ~/.claude/agents); os testes trocam. */
  userAgentsDir?: string;
  /** Troca o `spawn` real nos testes. */
  open?: (scriptPath: string, title: string) => void;
}

/** A primeira mensagem de uma sessão nova (no terminal ou numa conversa do MyCo). */
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

/** Gera a ficha, a config de MCP e o script, e abre o funcionário num terminal novo. */
export async function launchStaff(
  profile: StaffProfile,
  ctx: LaunchContext,
  opts: { resume: boolean },
): Promise<{ result: LaunchResult; profile: StaffProfile }> {
  const last = profile.sessions.at(-1);
  const resume = opts.resume && !!last;
  const sessionId = resume ? last!.id : randomUUID();
  const cwd = sessionCwd(profile, ctx, resume ? sessionId : null);

  const run = await prepareRun(profile, ctx, sessionId, cwd);
  const runDir = path.join(ctx.runDir, sessionId);

  const args = buildClaudeArgs(profile, { ...run, sessionId, resume, firstPrompt: greeting(profile) });
  const command = toCmdLine('claude', args);
  // Nome primeiro: a aba do terminal é estreita.
  const title = sanitizeArg(`${profile.name} (${profile.role}) - ${ctx.company}`);

  if (process.platform !== 'win32' && !ctx.open) {
    return {
      result: { ok: false, sessionId: null, command: `cd "${cwd}" && ${command}`, error: 'abrir terminal automaticamente só no Windows por enquanto' },
      profile,
    };
  }

  const script = path.join(runDir, 'start.cmd');
  await writeAtomic(script, cmdScript(title, cwd, command));
  try {
    (ctx.open ?? openWindow)(script, title);
  } catch (err) {
    return { result: { ok: false, sessionId: null, command, error: err instanceof Error ? err.message : String(err) }, profile };
  }

  const next: StaffProfile = resume
    ? { ...profile, updatedAt: new Date().toISOString() }
    : { ...profile, sessions: [...profile.sessions, { id: sessionId, startedAt: new Date().toISOString(), cwd }], updatedAt: new Date().toISOString() };
  await saveProfile(ctx.projectPath, next);
  return { result: { ok: true, sessionId, command, error: null }, profile: next };
}

export interface PreparedRun {
  systemPromptFile: string;
  mcpConfigPath: string | null;
  addDirs: string[];
  settingsFile: string;
  agentsFile: string | null;
  keyFiles: string[];
}

/**
 * Ficha atualizada, prompt de sistema (identidade + ficha, em arquivo), config de MCP da ficha,
 * hooks do MyCo e os agents do roteiro, para o terminal ou para a conversa no MyCo. Rodando fora
 * da pasta do projeto (worktree), a pasta das fichas entra em `--add-dir`.
 */
export async function prepareRun(profile: StaffProfile, ctx: LaunchContext, sessionId: string, cwd: string): Promise<PreparedRun> {
  const away = path.resolve(cwd) !== path.resolve(ctx.projectPath);
  const fichaCtx = await writeFicha(profile, ctx, away);
  const dir = path.join(ctx.runDir, sessionId);
  const systemPromptFile = path.join(dir, 'system.md');
  await writeAtomic(systemPromptFile, systemPrompt(profile, fichaCtx, renderFicha(profile, fichaCtx)));
  let mcpConfigPath: string | null = null;
  if (profile.mcps !== null) {
    mcpConfigPath = path.join(dir, 'mcp.json');
    await writeAtomic(mcpConfigPath, JSON.stringify(await buildMcpConfig(ctx.projectPath, profile.mcps, ctx.claudeConfigFile), null, 2));
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
  return { systemPromptFile, mcpConfigPath, addDirs: away ? [staffDir(ctx.projectPath)] : [], settingsFile, agentsFile, keyFiles: ctx.serverKeys ?? [] };
}

const DELIVERY_HOOK = fileURLToPath(new URL('../../scripts/hooks/delivery-check.mjs', import.meta.url));

/**
 * Hooks do MyCo em todo funcionário (`--settings`, somados aos do usuário e do projeto): os agents
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
  ctx: Pick<LaunchContext, 'company' | 'workspace' | 'projectName' | 'projectPath' | 'managerNames' | 'mycoUrl' | 'worktree' | 'servers' | 'team'>,
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
  };
  await writeAtomic(fichaFile(ctx.projectPath, profile.id), renderFicha(profile, fichaCtx));
  await ensureMemory(ctx.projectPath, profile);
  return fichaCtx;
}

/**
 * UTF-8 (chcp 65001) para nomes e caminhos com acento; CRLF, como o cmd espera.
 * O título da aba fica com o nome do funcionário: o Claude não troca o título do terminal.
 * Saiu bem (/exit), a janela fecha sozinha; com erro, fica aberta para dar para ler.
 */
export function cmdScript(title: string, cwd: string, command: string): string {
  return [
    '@echo off',
    'chcp 65001 >nul',
    `title ${title}`,
    'set CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1',
    `cd /d "${cwd}"`,
    command,
    'if errorlevel 1 (',
    '  echo.',
    '  echo A sessao terminou com erro. Aperte uma tecla para fechar.',
    '  pause >nul',
    ')',
    'exit',
    '',
  ].join('\r\n');
}

function openWindow(script: string, title: string) {
  // `start` abre uma janela nova; o primeiro argumento entre aspas é o título. Com /s, o cmd tira
  // só as aspas externas e o resto chega intacto.
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `"start "${title}" "${script}""`], {
    env: cleanEnv(),
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
  });
  child.unref();
}
