import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCodexArgs, CODEX_HEAVY_LEASE_S, type CodexHeavyGuard } from '../server/chat/codexArgs';
import { resolveCodexCommand } from '../server/codexEnv';
import { killTree } from '../server/chat/registry';

// Teste de integração com o Codex de verdade, PULADO por padrão: só roda com MYCO_CODEX_E2E=1 e o `codex` instalado.
//   MYCO_CODEX_E2E=1 npx vitest run tests/codexHooksE2e.test.ts      (PowerShell: $env:MYCO_CODEX_E2E=1; npx vitest run ...)
// Refaz a matriz da auditoria t-3bea79 (Codex 0.169.0) sobre a regra de server/chat/codexArgs.ts (`codexHeavyArgs`): a flag
// --dangerously-bypass-hook-trust do hook da fila libera o $CODEX_HOME/hooks.json da conta, e por isso ela não sai quando ele existe.
// Rode a cada versão nova do Codex: se um caso quebrar, o Codex mudou o que a regra assume (revise o comentário de `CodexHeavyGuard`).
//
// Sem custo nem rede: CODEX_HOME é uma pasta temporária (sem auth.json; nada do ~/.codex real é lido ou copiado) e o endereço da API aponta para
// uma porta fechada desta máquina. Os hooks são de SessionStart, que dispara no começo do turno, antes de qualquer chamada ao modelo; PreToolUse
// precisaria de uma resposta do modelo (provado ao vivo na t-aafb19 e na t-3bea79). O hook do Club é o que o `buildCodexArgs` monta de verdade
// (a flag e o comando), só com o evento trocado de PreToolUse para SessionStart e o `heavy-guard.mjs` trocado por um marcador.
//
// Partida fria: a 1ª execução do codex (e do hook, que abre o shell e o node) pode levar dezenas de segundos numa máquina carregada, e uma folga fixa depois de `turn.started`
// já fez o 1º caso falhar (hook marcado depois da folga). Por isso o `beforeAll` esquenta o codex com uma execução descartável do hook do Club e mede o atraso dele; os casos que
// esperam um marcador fazem polling com prazo (só terminam antes quando ele aparece) e os que provam que um hook NÃO roda esperam uma folga calibrada nesse atraso (3x, no mínimo 3 s).

const RUN = process.env.MYCO_CODEX_E2E === '1';
/** Prazo para o codex abrir o turno e para o marcador de um hook aparecer depois disso: partida fria e máquina carregada. */
const START_DEADLINE_MS = 150_000;
const MARK_DEADLINE_MS = 60_000;
/** Cada caso: o prazo da partida, o do marcador e a folga, com sobra. */
const CASE_TIMEOUT_MS = 300_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const installed = RUN && (() => {
  const { command, prefix } = resolveCodexCommand();
  const r = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  return r.status === 0;
})();
if (RUN && !installed) console.warn('[codexHooksE2e] MYCO_CODEX_E2E=1, mas o `codex` não roda aqui: testes pulados');

const FLAG = '--dangerously-bypass-hook-trust';

describe.skipIf(!installed)('Codex real: a matriz de hooks da auditoria t-3bea79', () => {
  let root: string;
  let mark: string;
  let logFile: string;
  let deadPort: number;
  let cases = 0;
  /** Quanto esperar para provar que um hook não roda: calibrado no aquecimento (ver o `beforeAll`). */
  let graceMs = 3000;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codex-e2e-'));
    mark = path.join(root, 'mark.mjs').replace(/\\/g, '/');
    logFile = path.join(root, 'marks.log').replace(/\\/g, '/');
    // O marcador: anota o que recebeu por argumento (o hook do Club recebe pasta da trava, estágio, pid e prazo). MYCO_CODEX_E2E_HOOK_DELAY_MS atrasa a anotação, para simular o hook
    // lento da partida fria (o 1º caso falhava quando ele chegava depois da folga fixa de 3 s): com 8000, o teste tem que passar do mesmo jeito.
    const delay = Math.max(0, Number(process.env.MYCO_CODEX_E2E_HOOK_DELAY_MS) || 0);
    await fs.writeFile(
      mark,
      `import { appendFileSync } from 'node:fs';\n${delay ? `await new Promise((r) => setTimeout(r, ${delay}));\n` : ''}appendFileSync(${JSON.stringify(logFile)}, process.argv.slice(2).join(' ') + '\\n');\n`,
    );
    deadPort = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address() as net.AddressInfo;
        s.close(() => resolve(port));
      });
    });
    // Aquecimento: uma execução descartável com o hook do Club (o `--version` do começo do arquivo não basta: não carrega o resto do codex nem abre o shell do hook). Quem paga a partida
    // fria é ela, e o atraso do hook que ela mede calibra a folga dos casos negativos. Sem o marcador no prazo, o codex não consegue rodar o hook nesta máquina: falha aqui, com o diagnóstico.
    const { home, repo } = await scene();
    const warm = await run(clubArgs(repo, home), home, repo, { until: clubRan, settleMs: 0 });
    if (!clubRan(warm)) throw new Error(`aquecimento: o hook do Club não rodou em ${MARK_DEADLINE_MS / 1000} s depois de o turno começar\nmarcas: ${JSON.stringify(warm.marks)}\nstdout: ${warm.stdout.slice(-800)}`);
    graceMs = Math.min(30_000, Math.max(3000, warm.hookMs * 3));
  }, 2 * START_DEADLINE_MS + MARK_DEADLINE_MS);
  // Cada CODEX_HOME vazio vira ~1.000 arquivos depois de uma execução (7 mil e 65 MB no total): apagar isso no Windows leva minutos e já estourou o prazo do hook, marcando a suíte como falha
  // com os 6 casos passando. A limpeza vai para um processo desacoplado (só apaga esta pasta temporária, com repetição para o que o codex ainda segura) e não segura nem derruba o teste.
  afterAll(() => {
    if (!root) return;
    const rm = 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })';
    spawn(process.execPath, ['-e', rm, root], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  });

  const node = () => process.execPath.replace(/\\/g, '/');
  /** O comando de hook que o Codex roda pelo shell dele: o PowerShell no Windows (precisa do `&`), o sh nos outros. */
  const command = (label: string) => `${process.platform === 'win32' ? '& ' : ''}"${node()}" "${mark}" ${label}`;
  const guard = (): CodexHeavyGuard => ({ hook: mark, lockDir: path.join(root, 'trava'), ownerPid: 4242 });

  /** Uma execução isolada: CODEX_HOME e projeto próprios, vazios. */
  async function scene() {
    const dir = path.join(root, `caso-${cases++}`);
    const home = path.join(dir, 'codex-home');
    const repo = path.join(dir, 'repo');
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(repo, { recursive: true });
    return { dir, home, repo };
  }

  /** O que o Club monta para uma conversa (a decisão da flag olha `decideHome`), com o evento do hook trocado para SessionStart e sem o sandbox elevado do Windows. */
  function clubArgs(repo: string, decideHome: string): string[] {
    const args = buildCodexArgs({
      cwd: repo,
      sandbox: 'read-only',
      network: 'off',
      secrets: { projectPath: repo, home: path.join(root, 'sem-home'), mycoHome: path.join(root, 'sem-home', '.myco') },
      heavyGuard: guard(),
      env: { CODEX_HOME: decideHome },
    });
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (args[i - 1] === '-c' && a.startsWith('windows.sandbox=')) {
        out.pop(); // o `-c` que veio antes
        continue;
      }
      if (args[i - 1] === '-c' && a.startsWith('hooks.PostToolUse=')) {
        out.pop();
        continue;
      }
      out.push(a.startsWith('hooks.PreToolUse=') ? a.replace('hooks.PreToolUse=', 'hooks.SessionStart=').replace('matcher="Bash",', '') : a);
    }
    return out;
  }

  interface Result {
    marks: string[];
    stdout: string;
    /** Milissegundos entre o `turn.started` e o `until` ser atendido (ou o prazo, ou o fim do processo); 0 sem `until`. */
    hookMs: number;
  }

  const readMarks = async () => (await fs.readFile(logFile, 'utf8').catch(() => '')).split('\n').filter(Boolean);

  /**
   * Roda o `codex exec` até o turno começar (o prazo é START_DEADLINE_MS) e anota o que os hooks marcaram, depois encerra. Com `until`, espera por polling (até MARK_DEADLINE_MS) as
   * marcas que o caso exige; depois espera `settleMs` (a folga calibrada, `graceMs`) para pegar marca que não devia existir. Sem `until`, só a folga: é a prova de que nada roda.
   */
  async function run(args: string[], home: string, repo: string, o: { until?: (r: Result) => boolean; settleMs?: number } = {}): Promise<Result> {
    await fs.rm(logFile, { force: true });
    const { command: bin, prefix } = resolveCodexCommand();
    const withApi = [...args.slice(0, -1), '-c', `openai_base_url="http://127.0.0.1:${deadPort}/v1"`, args.at(-1)!];
    const { MYCO_TOKEN: _token, ...env } = process.env;
    const child = spawn(bin, [...prefix, ...withApi], { cwd: repo, env: { ...env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const r: Result = { marks: [], stdout: '', hookMs: 0 };
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (r.stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.stdin.on('error', () => {});
    child.stdin.end('oi');
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`o codex não começou o turno em ${START_DEADLINE_MS / 1000} s\nstdout: ${r.stdout.slice(-800)}\nstderr: ${stderr.slice(-800)}`)), START_DEADLINE_MS);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        child.stdout.on('data', () => r.stdout.includes('"type":"turn.started"') && done());
        child.on('close', done);
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      const t0 = Date.now();
      r.marks = await readMarks();
      while (o.until && !o.until(r) && Date.now() - t0 < MARK_DEADLINE_MS && child.exitCode === null) {
        await sleep(100);
        r.marks = await readMarks();
      }
      r.hookMs = o.until ? Date.now() - t0 : 0;
      await sleep(o.settleMs ?? graceMs);
      r.marks = await readMarks();
      return r;
    } finally {
      if (child.pid) await killTree(child.pid);
    }
  }

  /** O hook do Club rodou: o `heavy-guard.mjs` (aqui o marcador) recebe a pasta da trava, o estágio, o pid do servidor e o prazo. */
  const clubRan = (r: Result) => r.marks.some((m) => m.endsWith(` pre 4242 ${CODEX_HEAVY_LEASE_S}`));
  const hooksJson = (label: string) => JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: command(label), timeout: 30 }] }] } });
  const trusted = (r: Result) => r.stdout.includes(`${FLAG}\` is enabled`);

  it('o hook inline do Club roda com a flag (sem hooks.json na conta), pelo comando que o Club monta', async () => {
    const { home, repo } = await scene();
    const args = clubArgs(repo, home);
    expect(args).toContain(FLAG);
    const r = await run(args, home, repo, { until: clubRan });
    expect(clubRan(r)).toBe(true);
    expect(trusted(r)).toBe(true);
  }, CASE_TIMEOUT_MS);

  it('sem a flag o hook inline não roda (é por isso que o Club a usa; se rodar, a flag pode sair de vez)', async () => {
    const { home, repo } = await scene();
    const r = await run(clubArgs(repo, home).filter((a) => a !== FLAG), home, repo);
    expect(r.marks).toEqual([]);
    expect(trusted(r)).toBe(false);
  }, CASE_TIMEOUT_MS);

  /** Os hooks do projeto: `.codex/hooks.json` e o `[[hooks.SessionStart]]` do `.codex/config.toml`. */
  async function repoHooks(repo: string) {
    await fs.mkdir(path.join(repo, '.codex'));
    await fs.writeFile(path.join(repo, '.codex', 'hooks.json'), hooksJson('repo-json'));
    await fs.writeFile(
      path.join(repo, '.codex', 'config.toml'),
      `[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command('repo-toml'))}\ntimeout = 30\n`,
    );
  }

  it('controle: os hooks do projeto rodam quando o config.toml do usuário confia no projeto (o formato dos arquivos é válido; o que os barra é o --ignore-user-config)', async () => {
    const { home, repo } = await scene();
    await repoHooks(repo);
    await fs.writeFile(path.join(home, 'config.toml'), `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`);
    // Com a flag, mas sem `--ignore-user-config`: o config.toml (onde mora a confiança do projeto) é lido.
    const r = await run(clubArgs(repo, home).filter((a) => a !== '--ignore-user-config'), home, repo, { until: (x) => x.marks.includes('repo-json') && x.marks.includes('repo-toml') });
    expect(r.marks).toEqual(expect.arrayContaining(['repo-json', 'repo-toml']));
  }, CASE_TIMEOUT_MS);

  it('o hook do projeto (<projeto>/.codex/hooks.json e config.toml) não roda, nem com a flag (--ignore-user-config)', async () => {
    const { home, repo } = await scene();
    await repoHooks(repo);
    const r = await run(clubArgs(repo, home), home, repo, { until: clubRan }); // depois do marcador do Club, a folga calibrada: se um hook do projeto rodasse, já teria marcado
    expect(clubRan(r)).toBe(true); // a flag valeu para o hook do Club...
    expect(r.marks.filter((m) => m.startsWith('repo-'))).toEqual([]); // ...e não liberou os do projeto
  }, CASE_TIMEOUT_MS);

  it('o $CODEX_HOME/hooks.json RODA com a flag: é o risco que a regra evita (se este teste quebrar, o Codex mudou: revise codexArgs.ts)', async () => {
    const { home, repo } = await scene();
    await fs.writeFile(path.join(home, 'hooks.json'), hooksJson('account-json'));
    // Como era antes da correção: a flag decidida sem olhar o hooks.json da conta.
    const r = await run(clubArgs(repo, path.join(home, 'outra-pasta')), home, repo, { until: (x) => x.marks.includes('account-json') && clubRan(x) });
    expect(r.marks).toContain('account-json');
    expect(clubRan(r)).toBe(true);
  }, CASE_TIMEOUT_MS);

  it('com hooks.json na conta o Club monta a execução sem a flag e sem o hook: nada roda (nem o hooks.json)', async () => {
    const { home, repo } = await scene();
    await fs.writeFile(path.join(home, 'hooks.json'), hooksJson('account-json'));
    const args = clubArgs(repo, home);
    expect(args).not.toContain(FLAG);
    expect(args.some((a) => a.startsWith('hooks.'))).toBe(false);
    const r = await run(args, home, repo);
    expect(r.marks).toEqual([]);
    expect(trusted(r)).toBe(false);
  }, CASE_TIMEOUT_MS);
});
