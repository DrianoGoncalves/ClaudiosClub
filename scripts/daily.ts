import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { getAuthStatus } from '../server/auth';
import { PAIR_APPROVE_PATH, PAIR_USER_CODE, pairCode, pairUrl, readOrCreatePairKey } from '../server/pairing';
import { openTerminal } from '../server/terminal';
import { DAEMON_BUNDLE, SERVER_BUNDLE, bundle } from './bundle';
import {
  DAEMON,
  DAILY,
  LOG_FILE,
  PID_FILE,
  ROOT,
  RUN_DIR,
  START_PAGE,
  STOP_FILE,
  TSX,
  appendLog,
  brokenDeps,
  isAlive,
  launcherInstalled,
  modInstalled,
  openUrl,
  portFrom,
  runningDaemon,
  stopProcess,
  writeLogSnapshot,
} from './lib';

// Claudio’s Club no dia a dia. Uso (npm run …, ou direto com tsx):
//   setup   prepara tudo (dependências, Claude Code, login, atalho opcional, cota) e sobe; feito para um terminal (npm run setup)
//   run     em primeiro plano: build, abre o navegador e segue no terminal até Ctrl+C (npm run daily)
//   start   em segundo plano, sem janela, religando se cair (npm run daily:start)
//   stop    para o vigia e tudo o que ele abriu (npm run daily:stop)
//   status  vigia, servidor e fim do log (npm run daily:status)
//   link    o botão Iniciar da página de início, pelo link myco:// (registrado por npm run launcher): sobe sem janela
//           ou, se faltar algo, abre um terminal com o setup
//   open    o atalho do menu: sobe se preciso e abre o navegador já pareado (código de uso único, ver server/pairing.ts)
//   pair    com o código que o "Parear este navegador" mostra (npm run pair K7QX-4M2P): aprova aquela aba, em qualquer
//           navegador. Sem código, abre o navegador padrão já pareado (no Vite: npm run pair:dev)
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

/** Espera o servidor responder, até `ms`. */
async function waitUp(ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(2000)) if (await isUp()) return true;
  return isUp();
}

/**
 * Abre o painel já pareando este navegador: o código (uso único, 2 min) vai só na URL entregue ao navegador, nunca
 * na saída nem no log. Quem roda isto só consegue abrir uma aba no seu navegador, não levar o código.
 */
function openPaired(): void {
  openUrl(pairUrl(url, pairCode(readOrCreatePairKey())));
  appendLog('open', 'navegador aberto com um código de pareamento');
}

/**
 * Aprova o pedido da aba que mostra `code`: a prova é um código de uso único feito com a chave (nunca impresso). Só
 * num terminal interativo, com confirmação: um funcionário roda comandos sem terminal e não aprova o próprio pedido.
 */
async function approvePairing(code: string): Promise<void> {
  // Aberto pelo botão, o terminal fecha ao sair: a mensagem fica uns segundos (o erro, até o Enter).
  const done = async (message: string, ok: boolean) => {
    (ok ? console.log : console.error)(message);
    if (ok) await sleep(2500);
    else if (process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await rl.question('\nAperte Enter para fechar. ');
      rl.close();
    }
    process.exit(ok ? 0 : 1);
  };
  console.log(`Pareamento do Claudio’s Club\n\n    Código: ${code.toUpperCase()}\n`);
  console.log('Só aprove se você acabou de clicar em "Parear este navegador" e a aba mostra este mesmo código.');
  // Padrão "não": um Enter distraído não aprova um pedido que não é seu.
  if (!(await ask('Aprovar?', false))) {
    return done(process.stdin.isTTY ? 'Não aprovei.' : 'Não aprovei: rode num terminal seu (interativo), não por script.', false);
  }
  const res = await fetch(`http://127.0.0.1:${port}${PAIR_APPROVE_PATH}`, {
    method: 'POST',
    headers: { 'x-myco': '1', 'x-pair-code': code, 'x-pair-proof': pairCode(readOrCreatePairKey()) },
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as { error?: string } | null;
  if (!res?.ok) return done(`Não aprovei: ${body?.error ?? 'o Claudio’s Club não respondeu'}`, false);
  appendLog('pair', 'pedido de pareamento aprovado pelo terminal');
  await done('Aprovado: a aba que mostrou o código fica pareada em alguns segundos.', true);
}

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
  const server = spawn(process.execPath, [SERVER_BUNDLE], {
    cwd: ROOT,
    env: { ...process.env, MYCO_PORT: String(port) },
    stdio: 'inherit',
  });
  server.on('exit', (code) => process.exit(code ?? 0));
  // O navegador abre depois que o servidor responde: o código de pareamento só vale por 2 min.
  void waitUp(60_000).then((up) => (up ? openPaired() : console.error(`\nO servidor não respondeu em 60 s: abra ${url} quando ele subir (npm run pair).`)));
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
  // Direto pelo pacote quando dá. Pelo .ts o vigia também se troca por ele, mas sobra um processo zumbi do tsx.
  const daemon = await bundle('scripts/daemon.ts', DAEMON_BUNDLE).then(
    () => [DAEMON_BUNDLE],
    () => ['--import', 'tsx', DAEMON],
  );
  const log = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [...daemon, '--port', String(port)], {
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
 * botão é opcional: `npm run setup` pergunta, ou `npm run launcher` registra.
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
  // `npm install` não refaz pacote que o npm acha instalado: com arquivos apagados, só `npm ci` repara.
  const broken = fs.existsSync(path.join(ROOT, 'node_modules', '.package-lock.json')) ? brokenDeps() : [];
  if (broken.length) {
    console.log(`node_modules quebrado (${broken.join(', ')}): reinstalando.`);
    if (!npm(['ci', '--no-audit', '--no-fund'])) await setupFailed('npm ci falhou (veja acima)');
  } else if (depsStale()) {
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

  // Opcional: o atalho e o link myco:// ficam no sistema (menu, registro). Quem já tem segue atualizado; quem não
  // tem só ganha se pedir. Sem eles: npm run daily:start e "Parear este navegador" no config.
  step('Atalho e botão Iniciar (opcional)');
  const wantsLauncher =
    launcherInstalled() ||
    (process.platform !== 'darwin' &&
      (await ask('Criar o atalho no menu e o link myco:// do botão Iniciar da página de início? Fica no sistema (npm run launcher:remove tira)', false)));
  if (wantsLauncher) spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts', 'launcher.ts')], { cwd: ROOT, stdio: 'inherit' });
  else console.log('sem atalho (npm run launcher cria depois)');

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
  if (!fromLink) return openPaired();
  console.log('Esta janela fecha em 5 s.');
  await sleep(5000);
}

/**
 * O botão Iniciar da página de início (myco://start). Com tudo pronto, sobe em segundo plano, sem janela; faltando
 * algo que só o setup resolve, abre um terminal com ele, que sobe no fim e fecha. myco://setup abre o terminal
 * sempre; myco://open faz o mesmo que o atalho (open). O link não recebe nada de fora: só o nome da ação, de uma
 * lista fixa; o resto é ignorado. Uma página qualquer que chame myco://open só abre uma aba pareada no seu navegador
 * (e o navegador pergunta antes): o código não volta para ela.
 */
async function link(raw: string | undefined): Promise<void> {
  const what = (raw ?? '').replace(/^myco:\/*/i, '').split(/[/?#]/)[0]?.toLowerCase() || 'start';
  appendLog('link', `pedido: myco://${what === 'setup' || what === 'open' ? what : 'start'}`);
  if (what === 'open') return openPanel();
  await bringUp(what === 'setup');
}

/** Sobe sem janela ou, faltando algo (ou com `setup`), abre o terminal do setup. Devolve como subiu. */
async function bringUp(setupAlways: boolean): Promise<'background' | 'terminal'> {
  if (runningDaemon()) {
    await start({ offerMod: false });
    return 'background';
  }
  const missing = setupAlways ? ['pedido direto'] : await missingForStart();
  if (missing.length) {
    appendLog('link', `falta: ${missing.join(', ')}; abrindo o terminal para preparar`);
    const r = openTerminal([process.execPath, TSX, DAILY, 'setup', '--from-link'], { title: 'Claudio’s Club - preparar', cwd: ROOT });
    if (r.ok) return 'terminal';
    // Sem terminal para mostrar: sobe assim mesmo e registra o motivo.
    appendLog('link', `não abri o terminal (${r.error}); subindo sem ele`);
  }
  await start({ offerMod: false });
  return 'background';
}

/**
 * O atalho do menu (e myco://open): com o servidor no ar, abre o navegador pareado; parado, sobe (ou abre o setup) e
 * abre quando ele responder. Não subiu a tempo: a página de início, com o checklist e o log.
 */
async function openPanel(): Promise<void> {
  if (!(await isUp())) {
    console.log('Subindo o Claudio’s Club; o navegador abre sozinho quando ele estiver no ar.');
    const how = await bringUp(false);
    if (!(await waitUp(how === 'terminal' ? 10 * 60_000 : 3 * 60_000))) {
      appendLog('open', 'não respondeu a tempo: abrindo a página de início');
      openUrl(START_PAGE);
      return;
    }
  }
  openPaired();
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
  case 'open':
    await openPanel();
    break;
  case 'pair': {
    if (!(await isUp())) {
      console.error(`Nada respondendo em ${url}: suba o Claudio’s Club antes (npm run daily:start ou npm run dev).`);
      process.exit(1);
    }
    const code = rest.find((a) => PAIR_USER_CODE.test(a));
    if (code) {
      await approvePairing(code);
      break;
    }
    openPaired();
    console.log('Abri o navegador padrão com um código de pareamento (uso único, vale 2 min).');
    console.log('Outro navegador? Nele, clique em "Parear este navegador" e rode o comando que aparece.');
    break;
  }
  default:
    console.error(`Ação desconhecida: ${action}. Use setup, run, start, stop, status, link, open ou pair.`);
    process.exit(1);
}
await writeLogSnapshot();
