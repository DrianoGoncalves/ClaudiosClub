import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import fs from 'node:fs';
import path from 'node:path';
import { DAEMON, LOG_FILE, PID_FILE, ROOT, RUN_DIR, STOP_FILE, isAlive, modInstalled, openUrl, portFrom, runningDaemon, stopProcess } from './lib';

// Claudio’s Club no dia a dia. Uso (npm run daily:…, ou direto com tsx):
//   run     em primeiro plano: build, abre o navegador e segue no terminal até Ctrl+C (npm run daily)
//   start   em segundo plano, sem janela, religando se cair (npm run daily:start)
//   stop    para o vigia e tudo o que ele abriu (npm run daily:stop)
//   status  vigia, servidor e fim do log (npm run daily:status)
// Porta: --port N, ou MYCO_PORT, ou 4848.

const [action = 'status', ...rest] = process.argv.slice(2);
const port = portFrom(rest);
const url = `http://claudio.localhost:${port}`;

function run(): void {
  const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (build.status !== 0) {
    console.error('\nO build falhou; veja o erro acima.');
    process.exit(1);
  }
  openUrl(url);
  const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, MYCO_PORT: String(port) },
    stdio: 'inherit',
  });
  server.on('exit', (code) => process.exit(code ?? 0));
}

/** Sem o myco-tap não há barras de cota: pergunta uma vez, no terminal, antes de subir. */
async function offerModInstall(): Promise<void> {
  if (modInstalled() || !process.stdin.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('O myco-tap (barras de cota 5h/7d) não está instalado. Instalar agora? Mexe em ~/.claude/settings.json, com backup [s/N] ');
  rl.close();
  if (/^s/i.test(answer.trim())) spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts', 'install-mod.ts')], { cwd: ROOT, stdio: 'inherit' });
}

async function start(): Promise<void> {
  const running = runningDaemon();
  if (running) {
    console.log(`O Claudio’s Club já está rodando em segundo plano: ${url}`);
    return;
  }
  await offerModInstall();
  // Atualiza o checklist (scripts/status.js) que a página de início mostra; nunca impede a subida.
  spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts', 'doctor.ts')], { cwd: ROOT, stdio: 'ignore', timeout: 60_000 });
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  // O vigia recebe o log como saída e segue sozinho: não fica preso a este terminal.
  const log = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', DAEMON, '--port', String(port)], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: { ...process.env, MYCO_PORT: String(port) },
  });
  child.unref();
  fs.closeSync(log);
  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid }));
  console.log(`Subindo em segundo plano (o build leva alguns segundos): ${url}`);
  console.log(`Log: ${LOG_FILE}`);
}

function stop(): void {
  const pid = runningDaemon();
  if (!pid) {
    console.log('O Claudio’s Club não está rodando em segundo plano.');
    fs.rmSync(PID_FILE, { force: true });
    return;
  }
  fs.writeFileSync(STOP_FILE, '');
  stopProcess(pid);
  // Espera o vigia sair de fato (até 5 s) antes de apagar os arquivos de controle.
  for (let i = 0; i < 50 && isAlive(pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  fs.rmSync(PID_FILE, { force: true });
  fs.rmSync(STOP_FILE, { force: true });
  console.log('Claudio’s Club parado.');
}

async function status(): Promise<void> {
  const pid = runningDaemon();
  let up = false;
  try {
    up = (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    up = false;
  }
  if (pid) {
    const since = fs.statSync(PID_FILE).mtime;
    console.log(`Vigia rodando (pid ${pid}) desde ${since.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}.`);
  } else {
    console.log('Vigia parado.');
  }
  console.log(up ? `Servidor respondendo: ${url}` : `Servidor não responde na porta ${port}.`);
  if (fs.existsSync(LOG_FILE)) {
    console.log(`--- últimas linhas de ${LOG_FILE}`);
    console.log(fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-8).join('\n'));
  }
}

switch (action) {
  case 'run':
    run();
    break;
  case 'start':
    await start();
    break;
  case 'stop':
    stop();
    break;
  case 'status':
    await status();
    break;
  default:
    console.error(`Ação desconhecida: ${action}. Use run, start, stop ou status.`);
    process.exit(1);
}
