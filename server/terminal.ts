import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Abre uma janela de terminal rodando um comando, no Windows e no Linux. Usado pelo login (server/auth.ts) e pelo
// botão "Preparar e iniciar" da página de início (scripts/daily.ts setup). A janela fecha quando o comando sai.

/** Terminais do Linux, em ordem de preferência: o binário e como ele recebe o comando. */
const LINUX_TERMINALS: Array<{ bin: string; args: (cmd: string[]) => string[] }> = [
  // O padrão do XDG: abre o terminal que o usuário escolheu (Omarchy, Fedora e outros).
  { bin: 'xdg-terminal-exec', args: (cmd) => cmd },
  { bin: 'x-terminal-emulator', args: (cmd) => ['-e', ...cmd] },
  { bin: 'gnome-terminal', args: (cmd) => ['--', ...cmd] },
  { bin: 'konsole', args: (cmd) => ['-e', ...cmd] },
  { bin: 'xfce4-terminal', args: (cmd) => ['-x', ...cmd] },
  { bin: 'ghostty', args: (cmd) => ['-e', ...cmd] },
  { bin: 'kitty', args: (cmd) => cmd },
  { bin: 'alacritty', args: (cmd) => ['-e', ...cmd] },
  { bin: 'foot', args: (cmd) => cmd },
  { bin: 'wezterm', args: (cmd) => ['start', '--', ...cmd] },
  { bin: 'xterm', args: (cmd) => ['-e', ...cmd] },
];

/** O executável está no PATH? */
function inPath(bin: string): boolean {
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => {
    if (!dir) return false;
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export interface TerminalResult {
  ok: boolean;
  error: string | null;
}

/**
 * Abre um terminal novo rodando `cmd` (programa e argumentos). No Windows, `start` abre o programa num console
 * próprio, que some quando ele termina; no Linux, o primeiro terminal instalado da lista acima.
 */
export function openTerminal(cmd: string[], opts: { title?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {}): TerminalResult {
  const env = opts.env ?? process.env;
  try {
    if (process.platform === 'win32') {
      const line = cmd.map((a) => `"${a.replace(/"/g, '')}"`).join(' ');
      // /s: o cmd tira só as aspas de fora; o primeiro argumento entre aspas do `start` é o título da janela.
      const child = spawn('cmd.exe', ['/d', '/s', '/c', `"start "${opts.title ?? 'Claudio’s Club'}" ${line}"`], {
        env,
        cwd: opts.cwd,
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
      });
      child.on('error', () => {});
      child.unref();
      return { ok: true, error: null };
    }
    if (process.platform === 'linux') {
      const found = LINUX_TERMINALS.find((t) => inPath(t.bin));
      if (!found) return { ok: false, error: 'nenhum terminal encontrado' };
      const child = spawn(found.bin, found.args(cmd), { env, cwd: opts.cwd, detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return { ok: true, error: null };
    }
    return { ok: false, error: 'abrir terminal automaticamente só no Windows e no Linux por enquanto' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
