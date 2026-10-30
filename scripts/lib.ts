import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Base dos scripts do dia a dia (daily, daemon, doctor, launcher, autostart). Roda igual no Windows, no macOS e
// no Linux: só Node. O que é do sistema (atalho, registro, login automático) fica nos blocos por plataforma.

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DEFAULT_PORT = 4848;
export const MYCO_HOME = process.env.MYCO_HOME ?? path.join(os.homedir(), '.myco');
export const LOG_FILE = path.join(MYCO_HOME, 'logs', 'server.log');
export const RUN_DIR = path.join(MYCO_HOME, 'run');
export const PID_FILE = path.join(RUN_DIR, 'daemon.pid');
export const STOP_FILE = path.join(RUN_DIR, 'daemon.stop');
export const BUILT = path.join(ROOT, 'dist', 'client', 'index.html');
export const DAEMON = path.join(ROOT, 'scripts', 'daemon.ts');
export const DAILY = path.join(ROOT, 'scripts', 'daily.ts');
export const START_PAGE = path.join(ROOT, 'scripts', 'start.html');

/** Porta: --port, depois MYCO_PORT, depois 4848. */
export function portFrom(args: string[]): number {
  const i = args.indexOf('--port');
  const fromArgs = i >= 0 ? Number(args[i + 1]) : 0;
  return fromArgs > 0 ? fromArgs : Number(process.env.MYCO_PORT) || DEFAULT_PORT;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Linha de comando do processo; vazia se não der para ler. */
export function commandLine(pid: number): string {
  try {
    if (process.platform === 'win32') {
      return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      });
    }
    return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
  } catch {
    return '';
  }
}

/** PID do vigia, se ele está vivo. O sistema reaproveita PIDs: confere que o processo ainda é o daemon. */
export function runningDaemon(): number | null {
  let pid: unknown;
  try {
    pid = (JSON.parse(fs.readFileSync(PID_FILE, 'utf8')) as { pid?: unknown }).pid;
  } catch {
    return null;
  }
  if (typeof pid !== 'number' || !isAlive(pid)) return null;
  return commandLine(pid).includes('daemon.ts') ? pid : null;
}

/** Encerra o vigia e tudo o que ele abriu (servidor, build). No Unix, o vigia é líder do próprio grupo. */
export function stopProcess(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // já saiu
    }
  }
}

/** Abre o endereço no navegador padrão. */
export function openUrl(url: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

/** Pasta de aplicativos do usuário no Linux (menu e links), segundo o XDG. */
export function linuxAppsDir(): string {
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'applications');
}

/** Roda um script do PowerShell no Windows. Os valores vão em variáveis de ambiente: sem escapar aspas. */
function powershellRun(script: string, env: Record<string, string>): void {
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: 'ignore',
  });
}

export interface WindowsShortcut {
  link: string;
  target: string;
  args?: string;
  cwd?: string;
  description: string;
  /** Minimizado ao abrir (o console do Node fica na barra de tarefas). */
  minimized?: boolean;
}

export function createWindowsShortcut(s: WindowsShortcut): void {
  powershellRun(
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:CC_LINK);' +
      ' $s.TargetPath = $env:CC_TARGET; $s.Arguments = $env:CC_ARGS; $s.WorkingDirectory = $env:CC_CWD;' +
      " $s.Description = $env:CC_DESC; if ($env:CC_MIN -eq '1') { $s.WindowStyle = 7 }; $s.Save()",
    {
      CC_LINK: s.link,
      CC_TARGET: s.target,
      CC_ARGS: s.args ?? '',
      CC_CWD: s.cwd ?? '',
      CC_DESC: s.description,
      CC_MIN: s.minimized ? '1' : '0',
    },
  );
}
