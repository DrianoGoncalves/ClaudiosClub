import { execFile, spawn } from 'node:child_process';
import { z } from 'zod';
import type { AuthStatus } from '../shared/model';

// O Claudio’s Club nunca lê credenciais: pergunta ao próprio `claude` se está logado e, se não estiver,
// abre um terminal com `claude auth login` para o usuário entrar pela assinatura.

const StatusOutput = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
});

/**
 * Ambiente sem variáveis do Claude/Anthropic. Herdadas do app desktop, elas desviam o CLI para a
 * autenticação do app; e `ANTHROPIC_API_KEY` faria as sessões cobrarem pela API em vez da assinatura.
 */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/i.test(k)));
}

export function parseAuthStatus(stdout: string, checkedAt = new Date()): AuthStatus {
  const json = stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1);
  let parsed: z.SafeParseReturnType<unknown, z.infer<typeof StatusOutput>>;
  try {
    parsed = StatusOutput.safeParse(JSON.parse(json));
  } catch {
    parsed = StatusOutput.safeParse(null);
  }
  if (!parsed.success) {
    return { cliFound: true, loggedIn: false, authMethod: null, subscription: false, error: 'resposta inesperada do `claude auth status`', checkedAt: checkedAt.toISOString() };
  }
  const { loggedIn, authMethod = null } = parsed.data;
  return {
    cliFound: true,
    loggedIn,
    authMethod,
    subscription: loggedIn && !/console|api/i.test(authMethod ?? ''),
    error: null,
    checkedAt: checkedAt.toISOString(),
  };
}

let cache: { at: number; status: Promise<AuthStatus> } | null = null;

export function getAuthStatus(opts: { fresh?: boolean } = {}): Promise<AuthStatus> {
  if (!opts.fresh && cache && Date.now() - cache.at < 20_000) return cache.status;
  const status = new Promise<AuthStatus>((resolve) => {
    // Deslogado, o CLI sai com código 1 mas ainda imprime o JSON: o stdout decide, não o código.
    execFile('claude', ['auth', 'status', '--json'], { env: cleanEnv(), timeout: 15_000, windowsHide: true }, (err, stdout) => {
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        resolve({ cliFound: false, loggedIn: false, authMethod: null, subscription: false, error: '`claude` não encontrado no PATH', checkedAt: new Date().toISOString() });
        return;
      }
      resolve(parseAuthStatus(stdout));
    });
  });
  cache = { at: Date.now(), status };
  return status;
}

export const LOGIN_COMMAND = 'claude auth login --claudeai';

/** Abre uma janela de terminal com o login pela assinatura. O usuário conclui no navegador. */
export function openLoginTerminal(): { ok: boolean; command: string; error: string | null } {
  if (process.platform !== 'win32') {
    return { ok: false, command: LOGIN_COMMAND, error: 'abrir terminal automaticamente só no Windows por enquanto' };
  }
  try {
    // `start` abre uma janela nova; o primeiro argumento entre aspas é o título.
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"start "Claudio’s Club - login no Claude" cmd /k ${LOGIN_COMMAND}"`], {
      env: cleanEnv(),
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    });
    child.unref();
    cache = null;
    return { ok: true, command: LOGIN_COMMAND, error: null };
  } catch (err) {
    return { ok: false, command: LOGIN_COMMAND, error: err instanceof Error ? err.message : String(err) };
  }
}
