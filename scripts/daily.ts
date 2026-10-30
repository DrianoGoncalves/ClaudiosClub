import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { getAuthStatus } from '../server/auth';
import { openTerminal } from '../server/terminal';
import {
  DAEMON,
  DAILY,
  LOG_FILE,
  PID_FILE,
  ROOT,
  RUN_DIR,
  STOP_FILE,
  TSX,
  appendLog,
  isAlive,
  modInstalled,
  openUrl,
  portFrom,
  runningDaemon,
  stopProcess,
  writeLogSnapshot,
} from './lib';

// Claudio’s Club no dia a dia. Uso (npm run …, ou direto com tsx):
//   setup   prepara tudo (dependências, Claude Code, login, botões, cota) e sobe; feito para um terminal (npm run setup)
//   run     em primeiro plano: build, abre o navegador e segue no terminal até Ctrl+C (npm run daily)
//   start   em segundo plano, sem janela, religando se cair (npm run daily:start)
//   stop    para o vigia e tudo o que ele abriu (npm run daily:stop)
//   status  vigia, servidor e fim do log (npm run daily:status)
//   link    o botão Iniciar da página de início, pelo link myco:// (registrado por npm run launcher): sobe sem janela
//           ou, se faltar algo, abre um terminal com o setup
// Porta: --port N, ou MYCO_PORT, ou 4848.

const [action = 'status', ...rest] = process.argv.slice(2);
const port = portFrom(rest);
const url = `http://claudio.localhost:${port}`;
const win = process.platform === 'win32';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isUp = () => fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
/** O programa existe e responde a --version? (no Windows, o `claude` e o `npm` são .cmd: precisam do shell) */
const has = (cmd: string) => spawnSync(cmd, ['--version'], { shell: win, stdio: 'ignore', windowsHide: true }).status === 0;
const npm = (args: string[]) => spawnSync('npm', args, { cwd: ROOT, stdio: 'inherit', shell: win }).status === 0;

/** Login no Claude Code feito (ou chave de API definida)? */
const loggedIn = async () => (await getAuthStatus({ fresh: true })).loggedIn || !!process.env.ANTHROPIC_API_KEY;

/** Pergunta sim/não no terminal. Sem terminal (atalho, link), não instala nada por conta própria. */
async function ask(question: string, yesByDefault: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} ${yesByDefault ? '[S/n]' : '[s/N]'} `)).trim();
  rl.close();
  return answer ? /^s/i.test(answer) : yesByDefault;
}

function run(): void {
  if (!npm(['run', 'build'])) {
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

/** Sem o myco-tap não há barras de cota: pergunta, no terminal, antes de subir. */
async function offerModInstall(): Promise<void> {
  if (modInstalled()) return;
  if (await ask('O myco-tap (barras de cota 5h/7d) não está instalado. Instalar agora? Mexe em ~/.claude/settings.json, com backup', false)) {
    spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts', 'install-mod.ts')], { cwd: ROOT, stdio: 'inherit' });
  }
}

async function start(opts: { offerMod: boolean }): Promise<void> {
  const running = runningDaemon();
  if (running) {
    console.log(`O Claudio’s Club já está rodando em segundo plano: ${url}`);
    return;
  }
  if (opts.offerMod) await offerModInstall();
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
  appendLog('daily', 'parado a pedido (npm run daily:stop)');
  console.log('Claudio’s Club parado.');
}

async function status(): Promise<void> {
  const pid = runningDaemon();
  const up = await isUp();
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

/** node_modules ausente ou mais velho que o package-lock.json (alguém atualizou as dependências). */
function depsStale(): boolean {
  const installed = fs.statSync(path.join(ROOT, 'node_modules', '.package-lock.json'), { throwIfNoEntry: false });
  const lock = fs.statSync(path.join(ROOT, 'package-lock.json'), { throwIfNoEntry: false });
  return !installed || (!!lock && lock.mtimeMs > installed.mtimeMs);
}

/** Falhou: mostra o motivo e o fim do log, e deixa a janela aberta até o usuário ler. */
async function setupFailed(reason: string): Promise<never> {
  console.error(`\n✗ ${reason}`);
  appendLog('setup', `parou: ${reason}`);
  await writeLogSnapshot();
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question('\nAperte Enter para fechar. ');
    rl.close();
  }
  process.exit(1);
}

/** O que impede a subida e só o setup resolve (instalar, fazer login); vazio quando dá para subir direto. */
async function missingForStart(): Promise<string[]> {
  const missing: string[] = [];
  if (Number(process.versions.node.split('.')[0]) < 22) missing.push('Node 22+');
  if (!has('git')) missing.push('Git');
  if (depsStale()) missing.push('dependências');
  if (!has('claude')) missing.push('Claude Code');
  else if (!(await loggedIn())) missing.push('login');
  return missing;
}

/**
 * Tudo o que falta para rodar, em ordem, num terminal: quando o botão Iniciar da página de início encontra algo
 * faltando, abre esta janela, e ela fecha sozinha quando o Claudio’s Club está no ar (a página entra nele). Sem o
 * botão registrado ainda, rode `npm run setup` uma vez.
 */
async function setup(fromLink: boolean): Promise<void> {
  console.log('Claudio’s Club: preparando tudo para rodar.');
  appendLog('setup', 'começou');
  const step = (label: string) => console.log(`\n== ${label}`);

  step('Node e Git');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) await setupFailed(`precisa do Node 22 ou mais novo (este é ${process.version}): instale em nodejs.org`);
  if (!has('git')) await setupFailed('Git não encontrado: instale o Git e rode de novo');
  console.log(`ok (Node ${process.version})`);

  step('Dependências');
  if (depsStale()) {
    if (!npm(['install', '--no-audit', '--no-fund'])) await setupFailed('npm install falhou (veja acima)');
  } else console.log('ok');

  step('Claude Code');
  if (!has('claude')) {
    if (await ask('O Claude Code não está instalado. Instalar agora (npm install -g @anthropic-ai/claude-code)?', true)) {
      npm(['install', '-g', '@anthropic-ai/claude-code']);
    }
    if (!has('claude')) await setupFailed('Claude Code não encontrado: npm install -g @anthropic-ai/claude-code');
  }
  console.log('ok');

  step('Login no Claude Code');
  if (!(await loggedIn())) {
    if (process.stdin.isTTY) {
      console.log('Entre com a sua conta do Claude no navegador que vai abrir.');
      spawnSync('claude', ['auth', 'login', '--claudeai'], { stdio: 'inherit', shell: win });
    }
    if (!(await loggedIn())) await setupFailed('sem login no Claude Code: rode claude auth login --claudeai');
  }
  console.log('ok');

  step('Botões da página de início');
  spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts', 'launcher.ts')], { cwd: ROOT, stdio: 'inherit' });

  step('Barras de cota (myco-tap)');
  await offerModInstall();
  console.log(modInstalled() ? 'ok' : 'sem as barras de cota por enquanto (npm run mod:install instala)');

  step('Subindo');
  await start({ offerMod: false });
  for (let i = 0; i < 90 && !(await isUp()); i++) {
    process.stdout.write('.');
    await sleep(2000);
  }
  if (!(await isUp())) await setupFailed(`não subiu em 3 minutos: veja o log na página de início ou em ${LOG_FILE}`);
  appendLog('setup', `pronto: ${url}`);
  await writeLogSnapshot();
  console.log(`\n\n✓ Pronto: ${url}`);
  // Pela página de início, ela mesma entra no app e esta janela fecha; pelo terminal, abrimos o navegador.
  if (!fromLink) return openUrl(url);
  console.log('Esta janela fecha em 5 s.');
  await sleep(5000);
}

/**
 * O botão Iniciar da página de início (myco://start). Com tudo pronto, sobe em segundo plano, sem janela; faltando
 * algo que só o setup resolve, abre um terminal com ele, que sobe no fim e fecha. myco://setup abre o terminal
 * sempre. O link não recebe nada de fora: só o nome da ação, de uma lista fixa; o resto é ignorado.
 */
async function link(raw: string | undefined): Promise<void> {
  const what = (raw ?? '').replace(/^myco:\/*/i, '').split(/[/?#]/)[0]?.toLowerCase() || 'start';
  appendLog('link', `pedido: myco://${what}`);
  if (runningDaemon()) return start({ offerMod: false });
  const missing = what === 'setup' ? ['pedido direto'] : await missingForStart();
  if (missing.length) {
    appendLog('link', `falta: ${missing.join(', ')}; abrindo o terminal para preparar`);
    const r = openTerminal([process.execPath, TSX, DAILY, 'setup', '--from-link'], { title: 'Claudio’s Club - preparar', cwd: ROOT });
    if (r.ok) return;
    // Sem terminal para mostrar: sobe assim mesmo e registra o motivo.
    appendLog('link', `não abri o terminal (${r.error}); subindo sem ele`);
  }
  await start({ offerMod: false });
}

switch (action) {
  case 'setup':
    await setup(rest.includes('--from-link'));
    break;
  case 'run':
    run();
    break;
  case 'start':
    await start({ offerMod: true });
    break;
  case 'stop':
    stop();
    break;
  case 'status':
    await status();
    break;
  case 'link':
    await link(rest[0]);
    break;
  default:
    console.error(`Ação desconhecida: ${action}. Use setup, run, start, stop, status ou link.`);
    process.exit(1);
}
await writeLogSnapshot();
