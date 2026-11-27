import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diagnoseExit, journalOomEvidence, memorySample, readSession, saveLastExit, writeSession } from '../server/exitReason';
import { currentScope, inClubScope, scopeCommand, splitScopeMarker } from '../server/scopeCommand';
import { DAEMON_BUNDLE, FTP_MCP_BUNDLE, GIT_MCP_BUNDLE, GPT_MCP_BUNDLE, GPT_MCP_CORE_BUNDLE, MEMORIA_MCP_BUNDLE, NAVEGADOR_MCP_BUNDLE, SERVER_BUNDLE, SSH_MCP_BUNDLE, bundle, bundleStale } from './bundle';
import {
  LAST_EXIT_FILE,
  LOG_FILE,
  PID_FILE,
  RESTART_FILE,
  ROOT,
  RUN_DIR,
  SESSION_FILE,
  STOP_FILE,
  VITE,
  appendLog,
  clientChanged,
  clientMissing,
  portFrom,
  runningDaemon,
  systemdScopeUsable,
  writeLogSnapshot,
} from './lib';
import { startSteps, supervise, takeFlag } from './supervisor';

// Vigia do Claudio’s Club: sobe o servidor sem janela, guarda a saída em ~/.myco/logs/server.log e religa sozinho se
// ele cair (a mesma versão: código novo só entra pelo botão Reiniciar/Atualizar; ver scripts/supervisor.ts).
// Para parar: npm run daily:stop. Quem chama (daily start, ou o login automático) já o põe em segundo plano.

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

/**
 * Como subir o servidor numa subida completa: o pacote, refeito se o código mudou; sem ele (erro no build), pelo
 * tsx como antes. Numa queda o vigia reaproveita estes mesmos argumentos, sem chamar isto.
 */
async function serverArgs(): Promise<string[]> {
  if (bundleStale(SERVER_BUNDLE)) {
    await bundle('server/index.ts', SERVER_BUNDLE).catch((err: unknown) =>
      log(`o pacote do servidor falhou; sobe pelo tsx: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  // O MCP de FTP dos funcionários: sem pacote em dia, o servidor sobe o .ts pelo tsx.
  if (bundleStale(FTP_MCP_BUNDLE)) {
    await bundle('server/ftp-mcp.ts', FTP_MCP_BUNDLE).catch((err: unknown) =>
      log(`o pacote do MCP de FTP falhou; ele roda pelo tsx: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  // O MCP do GPT (`perguntar_gpt`): o mesmo.
  if (bundleStale(GPT_MCP_BUNDLE)) {
    await bundle('server/gpt-mcp.ts', GPT_MCP_BUNDLE).catch((err: unknown) =>
      log(`o pacote do MCP do GPT falhou; ele roda pelo tsx: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  if (bundleStale(GPT_MCP_CORE_BUNDLE)) {
    await bundle('server/staff/gptMcp.ts', GPT_MCP_CORE_BUNDLE).catch((err: unknown) =>
      log(`o pacote do MCP do GPT (inteiro) falhou; ele roda pelo tsx: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  // O MCP de SSH (`ssh_*`, o Claude e o Codex): o mesmo.
  if (bundleStale(SSH_MCP_BUNDLE)) {
    await bundle('server/ssh-mcp.ts', SSH_MCP_BUNDLE).catch((err: unknown) =>
      log(`o pacote do MCP de SSH falhou; ele roda pelo tsx: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  // O MCP da memória da própria ficha (`myco-memoria`, conversas em plan): o mesmo.
  if (bundleStale(MEMORIA_MCP_BUNDLE)) {
    await bundle('server/memoria-mcp.ts', MEMORIA_MCP_BUNDLE).catch((err: unknown) =>
      log(`o pacote do MCP da memória falhou; ele roda pelo tsx: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  // O MCP de git (`myco-git`, o Claude e o Codex): o mesmo, mas só pelo pacote (sem ele o MCP não entra; nunca pelo tsx).
  if (bundleStale(GIT_MCP_BUNDLE)) {
    await bundle('server/git-mcp.ts', GIT_MCP_BUNDLE, { inline: true }).catch((err: unknown) =>
      log(`o pacote do MCP de git falhou; ele não entra nas conversas: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  // O proxy do navegador limpo (`myco-navegador`): o mesmo.
  if (bundleStale(NAVEGADOR_MCP_BUNDLE)) {
    await bundle('server/navegador-mcp.ts', NAVEGADOR_MCP_BUNDLE).catch((err: unknown) =>
      log(`o pacote do proxy do navegador falhou; ele roda pelo tsx: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  return bundleStale(SERVER_BUNDLE) ? ['--import', 'tsx', 'server/index.ts'] : [SERVER_BUNDLE];
}

/** Gera o cliente (só o build, sem checagem de tipos: um erro de tipo em edição não deixa o Claudio’s Club sem tela). */
function buildClient(): void {
  const build = spawnSync(process.execPath, [VITE, 'build'], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (build.status !== 0) log('o build do cliente falhou (veja acima); o servidor sobe com a última versão do cliente');
}

/**
 * O pool de I/O do Node tem 4 threads: o stat dos transcripts (centenas de uma vez) enfileirava atrás dele a leitura e a gravação do quadro.
 * Com 16, o arquivo pequeno não espera a rajada. Quem já definiu o valor no ambiente manda. Os processos que o servidor abre herdam (inofensivo).
 * `MYCO_CONV_SCOPE`: o vigia está no próprio escopo do systemd, então o servidor pode pôr cada conversa no seu (server/scopeCommand.ts).
 */
function serverEnv(env: NodeJS.ProcessEnv, scopes = scopesOn): NodeJS.ProcessEnv {
  return { ...env, UV_THREADPOOL_SIZE: env.UV_THREADPOOL_SIZE || '16', MYCO_CONV_SCOPE: env.MYCO_CONV_SCOPE ?? (scopes ? '1' : '0') };
}

/**
 * Escopos do systemd (Linux): ligados quando o vigia está no escopo dele (o `daily start` já o lança nele; `enterOwnScope` cobre os outros jeitos de
 * subir) e ninguém desligou com `MYCO_SCOPES=0`. Falha ao abrir o escopo do servidor desliga só o do servidor (`serverScopeBroken`).
 */
let scopesOn = false;
let serverScopeBroken = false;

/**
 * O vigia que subiu fora de um escopo (login automático, `npm run daemon`) se põe num: `systemd-run --user --scope` dá exec e o processo continua o
 * mesmo (mesmo PID, mesma saída). Sem isso, o oomd mataria o vigia junto com a conversa mais pesada (e com o servidor) por ser o mesmo cgroup do app que o lançou.
 * Falhou (sem systemd do usuário, sem execve): segue como antes.
 */
function enterOwnScope(): void {
  if (process.platform !== 'linux' || !process.execve || process.env.MYCO_SCOPES === '0' || process.env.MYCO_SCOPED === '1' || inClubScope()) return;
  try {
    if (!systemdScopeUsable()) return;
    const bin = (process.env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, 'systemd-run')).find((f) => fs.existsSync(f)) ?? '/usr/bin/systemd-run';
    const c = scopeCommand(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { unit: `app-claudios-${Date.now()}`, description: "Claudio's Club", oom: 'omit', keepOnOom: true });
    process.execve(bin, [bin, ...c.args], { ...process.env, MYCO_SCOPED: '1' });
  } catch (err) {
    log(`o vigia segue sem escopo próprio: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Sobe o servidor uma vez e devolve o código. `scoped`: no escopo dele (`avoid`); `noScope` = o systemd-run falhou antes de rodar o servidor (não entrou, nada rodou). */
function runServerOnce(args: string[], scoped: boolean): Promise<{ code: number | null; noScope: boolean }> {
  return new Promise((resolve) => {
    const plain = { cmd: process.execPath, args };
    const c = scoped
      ? scopeCommand(process.execPath, args, { unit: `app-claudios-server-${Date.now()}`, description: "Claudio's Club (servidor)", quiet: false, oom: 'avoid', keepOnOom: true }, { platform: 'linux' })
      : plain;
    let verified = !scoped;
    const spawned = spawn(c.cmd, c.args, {
      cwd: ROOT,
      env: serverEnv(process.env),
      // Com escopo, o stderr passa por aqui: a linha "Running as unit" do systemd-run é o sinal de que o servidor vai rodar (ver splitScopeMarker). Sai do log.
      stdio: scoped ? ['ignore', 'inherit', 'pipe'] : 'inherit',
      windowsHide: true,
    });
    child = spawned;
    spawned.stderr?.on('data', (chunk: Buffer) => {
      const r = splitScopeMarker(chunk.toString('utf8'));
      if (r.marker) verified = true;
      if (r.text) process.stderr.write(r.text);
    });
    spawned.on('exit', (code) => {
      child = null;
      resolve({ code, noScope: !verified });
    });
    spawned.on('error', () => {
      child = null;
      resolve({ code: null, noScope: !verified });
    });
  });
}

/** Roda o servidor até ele sair; devolve o código de saída. Se o escopo não abriu, sobe de novo na hora sem ele (o servidor nunca deixa de subir por causa do escopo). */
async function runServer(args: string[]): Promise<number | null> {
  if (scopesOn && !serverScopeBroken) {
    const r = await runServerOnce(args, true);
    if (!r.noScope) return r.code;
    serverScopeBroken = true;
    log('o systemd-run não abriu o escopo do servidor; subindo sem ele (volta a tentar na próxima vez que o vigia subir)');
  }
  return (await runServerOnce(args, false)).code;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  // Antes de qualquer registro: se se pôr no escopo, o processo é trocado aqui mesmo e esta função recomeça (já dentro dele).
  enterOwnScope();
  scopesOn = process.platform === 'linux' && process.env.MYCO_SCOPES !== '0' && inClubScope();
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

  // Pedido de reinício que sobrou de outro vigia: esta subida já é completa.
  fs.rmSync(RESTART_FILE, { force: true });

  // A saída do vigia anterior foi limpa? O marcador dele ainda diz "no ar" se alguém o matou por baixo (o oomd, em 27/11/2026): o motivo vai para o log e para a
  // página de início (server/exitReason.ts). Lido antes de o marcador deste vigia o substituir; o diagnóstico (journal, até 5 s) não segura a subida.
  const previous = readSession(SESSION_FILE);
  const startedAt = new Date().toISOString();
  const unit = currentScope();
  let beatFailed = false;
  const beat = (clean = false) => {
    try {
      writeSession(SESSION_FILE, { pid: process.pid, startedAt, lastBeat: new Date().toISOString(), unit, clean, ...memorySample() });
    } catch (err) {
      if (!beatFailed) log(`não consegui gravar o sinal de vida do vigia (${err instanceof Error ? err.message : String(err)}); a próxima saída não limpa não terá hora`);
      beatFailed = true;
    }
  };
  beat();
  setInterval(beat, 30_000).unref();
  const diagnosis = diagnoseExit(previous, { now: Date.now(), uptimeSec: os.uptime(), selfPid: process.pid, oomEvidence: journalOomEvidence })
    .then((report) => {
      saveLastExit(LAST_EXIT_FILE, report);
      if (report) log(report.message);
    })
    .catch((err: unknown) => log(`não consegui avaliar a saída anterior: ${err instanceof Error ? err.message : String(err)}`));
  // O relatório sai antes de o servidor responder: a página de início mostra o motivo quando o Club volta (em vez de entrar direto no app). Em até 3 s;
  // o journal lento não segura a subida além disso (o relatório sai quando chegar).
  await Promise.race([diagnosis, sleep(3_000)]);

  log(`iniciando em ${ROOT} (porta ${port})${scopesOn ? ` no escopo ${unit}` : ''}`);
  // Código novo só entra pela subida completa (esta, e o botão Reiniciar/Atualizar). Queda sobe a mesma versão.
  await supervise({
    shouldStop: () => stopping || fs.existsSync(STOP_FILE),
    takeRestartRequest: () => takeFlag(RESTART_FILE),
    ...startSteps({ clientChanged: () => clientChanged(), clientMissing: () => clientMissing(), buildClient, serverArgs }),
    run: (args) => {
      log(`subindo o servidor: http://claudio.localhost:${port}`);
      return runServer(args);
    },
    log,
    sleep,
  });

  // Parada de verdade (Parar, daily stop, sinal de término): o marcador diz "limpo", a próxima subida não estranha e o aviso "Por que parou" some (foi o usuário
  // quem parou). Apagado ANTES da linha no log: é ela que regrava o scripts/log.js da página de início.
  beat(true);
  saveLastExit(LAST_EXIT_FILE, null);
  log('parado');
  fs.rmSync(STOP_FILE, { force: true });
  fs.rmSync(RESTART_FILE, { force: true });
  fs.rmSync(PID_FILE, { force: true });
}

main().catch((err: unknown) => {
  log(`erro no vigia: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
