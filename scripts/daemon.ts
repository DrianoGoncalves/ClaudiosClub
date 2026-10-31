import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DAEMON_BUNDLE, SERVER_BUNDLE, bundle, bundleStale } from './bundle';
import { LOG_FILE, PID_FILE, ROOT, RUN_DIR, STOP_FILE, VITE, appendLog, clientChanged, portFrom, runningDaemon, writeLogSnapshot } from './lib';

// Vigia do Claudio’s Club: sobe o servidor sem janela, guarda a saída em ~/.myco/logs/server.log e religa sozinho se
// ele cair. Para parar: npm run daily:stop. Quem chama (daily start, ou o login automático) já o põe em segundo plano.

const LOG_MAX = 5 * 1024 * 1024;
const port = portFrom(process.argv.slice(2));

let child: ChildProcess | null = null;
let stopping = false;

/** Registra no log e atualiza a cópia que a página de início lê (scripts/log.js). */
function log(line: string): void {
  appendLog('vigia', line);
  void writeLogSnapshot();
}

// Rodando do .ts (tsx), o vigia se troca pelo pacote dist/daemon.mjs no mesmo processo (mesmo PID) e fica no ar
// sem o tsx. Sem process.execve (Windows) ou sem conseguir gerar o pacote, segue pelo tsx mesmo. No Windows a função
// existe mas lança "unavailable": por isso a checagem é pela plataforma, e não pela função.
if (import.meta.filename.endsWith('.ts') && process.platform !== 'win32' && process.execve) {
  try {
    if (bundleStale(DAEMON_BUNDLE)) await bundle('scripts/daemon.ts', DAEMON_BUNDLE);
    process.execve(process.execPath, [process.execPath, DAEMON_BUNDLE, ...process.argv.slice(2)]);
  } catch (err) {
    log(`o vigia segue pelo tsx (sem o pacote: ${err instanceof Error ? err.message : String(err)})`);
  }
}

/** Como subir o servidor: o pacote, refeito se o código mudou; sem ele (erro no build), pelo tsx como antes. */
async function serverArgs(): Promise<string[]> {
  if (bundleStale(SERVER_BUNDLE)) {
    await bundle('server/index.ts', SERVER_BUNDLE).catch((err: unknown) =>
      log(`o pacote do servidor falhou; sobe pelo tsx: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  return bundleStale(SERVER_BUNDLE) ? ['--import', 'tsx', 'server/index.ts'] : [SERVER_BUNDLE];
}

/** Roda o servidor até ele sair; devolve o código de saída. */
async function runServer(): Promise<number | null> {
  const args = await serverArgs();
  return new Promise((resolve) => {
    child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('exit', (code) => {
      child = null;
      resolve(code);
    });
    child.on('error', () => resolve(null));
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  // O servidor sabe que tem vigia: o config mostra "Reiniciar" (sair e voltar) além de "Parar".
  process.env.MYCO_PORT = String(port);
  process.env.MYCO_DAEMON = '1';
  // Variáveis do Claude Code de quem chamou não vazam para o servidor (nem para as sessões dele).
  for (const key of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC)/.test(key)) delete process.env[key];

  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.mkdirSync(RUN_DIR, { recursive: true });

  // Um vigia por vez: se o registrado ainda está vivo, este sai quieto.
  const other = runningDaemon();
  if (other && other !== process.pid) process.exit(0);
  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid }));
  fs.rmSync(STOP_FILE, { force: true });

  // Log de até ~5 MB: o anterior vira server.log.1.
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);

  const shutdown = () => {
    stopping = true;
    child?.kill('SIGTERM');
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  log(`iniciando em ${ROOT} (porta ${port})`);
  let delay = 5;
  while (!stopping && !fs.existsSync(STOP_FILE)) {
    // O cliente é gerado no (re)início quando mudou. Só o build (sem checagem de tipos): um erro de tipo em
    // edição não deixa o Claudio’s Club sem tela.
    if (clientChanged()) {
      const build = spawnSync(process.execPath, [VITE, 'build'], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
      if (build.status !== 0) log('o build do cliente falhou (veja acima); o servidor sobe com a última versão do cliente');
    }
    const started = Date.now();
    log(`subindo o servidor: http://claudio.localhost:${port}`);
    const code = await runServer();
    if (stopping || fs.existsSync(STOP_FILE)) break;
    // Caiu logo de novo (porta ocupada, erro na subida): espera cada vez mais, até 1 min.
    delay = Date.now() - started < 30_000 ? Math.min(delay * 2, 60) : 5;
    log(`o servidor saiu (código ${code}); religando em ${delay} s`);
    await sleep(delay * 1000);
  }

  log('parado');
  fs.rmSync(STOP_FILE, { force: true });
  fs.rmSync(PID_FILE, { force: true });
}

main().catch((err: unknown) => {
  log(`erro no vigia: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
