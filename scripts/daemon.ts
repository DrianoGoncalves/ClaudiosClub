import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BUILT, LOG_FILE, PID_FILE, ROOT, RUN_DIR, STOP_FILE, portFrom, runningDaemon } from './lib';

// Vigia do Claudio’s Club: sobe o servidor sem janela, guarda a saída em ~/.myco/logs/server.log e religa sozinho se
// ele cair. Para parar: npm run daily:stop. Quem chama (daily start, ou o login automático) já o põe em segundo plano.

const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const LOG_MAX = 5 * 1024 * 1024;
const port = portFrom(process.argv.slice(2));

let child: ChildProcess | null = null;
let stopping = false;

function log(line: string): void {
  // Hora local, no formato AAAA-MM-DD HH:MM:SS.
  const stamp = new Date().toLocaleString('sv-SE');
  fs.appendFileSync(LOG_FILE, `[${stamp}] [vigia] ${line}\n`);
}

/** Arquivos de uma pasta, em todos os níveis. */
function filesUnder(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[]).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile());
}

/** O cliente mudou desde o último build? (código, dependências ou config do Vite) */
function clientChanged(): boolean {
  if (!fs.existsSync(BUILT)) return true;
  const since = fs.statSync(BUILT).mtimeMs;
  const sources = [
    ...filesUnder(path.join(ROOT, 'client')),
    ...filesUnder(path.join(ROOT, 'shared')),
    path.join(ROOT, 'vite.config.ts'),
    path.join(ROOT, 'package-lock.json'),
  ];
  return sources.some((f) => (fs.statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0) > since);
}

/** Roda o servidor até ele sair; devolve o código de saída. */
function runServer(): Promise<number | null> {
  return new Promise((resolve) => {
    child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
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
