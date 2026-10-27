import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { LaunchResult, ServerInfo, StaffProfile } from '../../shared/model';
import { cleanEnv } from '../auth';
import { buildClaudeArgs, identityPrompt, renderFicha, sanitizeArg, toCmdLine, type FichaContext } from './ficha';
import { buildMcpConfig } from './mcp';
import { ensureMemory, fichaFile, memoryFile, saveProfile, staffDir, writeAtomic } from './store';
import type { Worktree } from './worktree';

export interface LaunchContext {
  company: string;
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
  /** Troca o `spawn` real nos testes. */
  open?: (scriptPath: string, title: string) => void;
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

  const { identity, mcpConfigPath, addDirs } = await prepareRun(profile, ctx, sessionId, cwd);
  const runDir = path.join(ctx.runDir, sessionId);

  const args = buildClaudeArgs(profile, {
    sessionId,
    resume,
    identity,
    mcpConfigPath,
    addDirs,
    firstPrompt: profile.firstTask
      ? `Olá, ${profile.name}. Leia sua ficha e sua memória e comece pela primeira tarefa.`
      : `Olá, ${profile.name}. Leia sua ficha e sua memória e diga em poucas linhas como pretende começar.`,
  });
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

/**
 * Ficha atualizada, identidade curta e config de MCP da ficha, para o terminal ou para a conversa
 * no MyCo. Rodando fora da pasta do projeto (worktree), a pasta das fichas entra em `--add-dir`.
 */
export async function prepareRun(
  profile: StaffProfile,
  ctx: LaunchContext,
  sessionId: string,
  cwd: string,
): Promise<{ identity: string; mcpConfigPath: string | null; addDirs: string[] }> {
  const away = path.resolve(cwd) !== path.resolve(ctx.projectPath);
  const fichaCtx = await writeFicha(profile, ctx, away);
  let mcpConfigPath: string | null = null;
  if (profile.mcps !== null) {
    mcpConfigPath = path.join(ctx.runDir, sessionId, 'mcp.json');
    await writeAtomic(mcpConfigPath, JSON.stringify(await buildMcpConfig(ctx.projectPath, profile.mcps, ctx.claudeConfigFile), null, 2));
  }
  return { identity: identityPrompt(profile, fichaCtx), mcpConfigPath, addDirs: away ? [staffDir(ctx.projectPath)] : [] };
}

/**
 * (Re)gera a ficha em Markdown e cria a memória, se faltar. Roda na contratação e a cada sessão.
 * `absolute`: caminhos completos na identidade (a sessão roda noutra pasta, a worktree).
 */
export async function writeFicha(
  profile: StaffProfile,
  ctx: Pick<LaunchContext, 'company' | 'projectName' | 'projectPath' | 'managerNames' | 'mycoUrl' | 'worktree' | 'servers'>,
  absolute = false,
): Promise<FichaContext> {
  const rel = (file: string) => (absolute ? file : path.relative(ctx.projectPath, file));
  const fichaCtx: FichaContext = {
    company: ctx.company,
    projectName: ctx.projectName,
    projectPath: ctx.projectPath,
    managerNames: ctx.managerNames,
    fichaPath: rel(fichaFile(ctx.projectPath, profile.id)),
    memoryPath: rel(memoryFile(ctx.projectPath, profile.id)),
    mycoUrl: ctx.mycoUrl,
    worktree: profile.worktree ? (ctx.worktree ?? null) : null,
    servers: ctx.servers,
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
