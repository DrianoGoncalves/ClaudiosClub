import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SHOWCASE_BYTES, SHOWCASE_CHECK_PATH, validCheck } from '../server/projectGuide';
import {
  extractShowcase,
  readResult,
  retryDelay,
  ShowcaseBusyError,
  ShowcaseRefusedError,
  ShowcaseRunner,
  showcaseArgs,
  showcaseRefusal,
  type ClaudeOutput,
  type ClaudeRun,
  type ShowcaseJob,
  type ShowcaseRunnerDeps,
  type SpawnClaude,
} from '../server/showcaseRunner';
import { UsageStopError } from '../server/usageStop';

const HTML = '<!doctype html><html lang="pt-BR"><head><style>body{}</style></head><body><h1>Projeto</h1></body></html>';

/** Saída do `claude -p --output-format json` com o texto `result`. */
const ok = (result: string, extra: Record<string, unknown> = {}): ClaudeOutput => ({ code: 0, stderr: '', stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, ...extra }) });
/** Saída de erro do `claude` (JSON com `is_error`). */
const errorJson = (subtype: string, result = '', extra: Record<string, unknown> = {}): ClaudeOutput => ({ code: 1, stderr: '', stdout: JSON.stringify({ type: 'result', subtype, is_error: true, result, ...extra }) });
/** Chave com cara de real (passa em `findSecret`), montada em tempo de execução para não aparecer literal no repositório. */
const FAKE_KEY = ['sk', 'ant', 'api03', 'K9fH2mQp7RxT4vLz8NcB1wY6sD3gJ5'].join('-');
/** Saída sem resultado nenhum (o processo caiu). */
const empty: ClaudeOutput = { code: 1, stderr: 'caiu', stdout: '' };

/** Um processo que já terminou com `out`. */
const finished = (out: ClaudeOutput): ClaudeRun => ({ done: Promise.resolve(out), kill: () => {} });

/** Um processo controlado pelo teste: termina quando `finish` é chamado, ou quando é morto (saída sem resultado). */
function controlled() {
  let finish!: (o: ClaudeOutput) => void;
  const done = new Promise<ClaudeOutput>((resolve) => (finish = resolve));
  let kills = 0;
  const run: ClaudeRun = {
    done,
    kill: () => {
      kills++;
      finish({ code: null, stdout: '', stderr: '' });
    },
  };
  return { run, finish, kills: () => kills };
}

function makeRunner(responses: ClaudeRun[], over: Partial<ShowcaseRunnerDeps> = {}) {
  const spawns: Array<{ args: string[]; cwd: string; stdin: string }> = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const releases = { count: 0 };
  const spawnClaude: SpawnClaude = (args, cwd, stdin) => {
    spawns.push({ args, cwd, stdin });
    const next = responses.shift();
    if (!next) throw new Error('spawn inesperado');
    return next;
  };
  const runner = new ShowcaseRunner({
    spawnClaude,
    checkUsage: async () => {},
    reserve: async () => ({
      ok: true,
      release: () => {
        releases.count++;
      },
    }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    log: (line) => logs.push(line),
    timeoutMs: 60_000,
    // Ledger do Sistema numa pasta temporária: sem isso, o teste gravaria no ~/.myco de quem roda.
    systemCostsFile: path.join(os.tmpdir(), 'myco-vitrine-teste', 'system-costs.jsonl'),
    ...over,
  });
  return { runner, spawns, sleeps, logs, releases };
}

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=teste', '-c', 'user.email=teste@teste', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
  }).trim();

const exists = (p: string) => fs.stat(p).then(
  () => true,
  () => false,
);

describe('gerador da vitrine: argumentos do claude', () => {
  it('só leitura: sem a flag que libera tudo, sem max-turns (não existe), com o deny de segredos e de escrita', () => {
    const a = showcaseArgs();
    expect(a).not.toContain('--allow-dangerously-skip-permissions');
    expect(a).not.toContain('--permission-prompt-tool');
    expect(a).not.toContain('--max-turns');
    expect(a[a.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
    expect(a[a.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(a[a.indexOf('--output-format') + 1]).toBe('json');
    expect(a[a.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
    expect(a).toContain('--strict-mcp-config');
    expect(a[a.indexOf('--setting-sources') + 1]).toBe('user');
    expect(a).toContain('--no-session-persistence');
    const denied = a[a.indexOf('--disallowedTools') + 1]!.split(',');
    for (const rule of ['Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Read(~/.ssh/**)', 'Bash', 'PowerShell', 'Write', 'Edit', 'Agent', 'mcp__*']) {
      expect(denied).toContain(rule);
    }
  });
});

describe('gerador da vitrine: resposta e conferência', () => {
  it('extrai do doctype ao último </html>, sem o texto em volta nem a cerca de código', () => {
    expect(extractShowcase('texto antes <!DOCTYPE HTML><html><body>a</body></html> texto depois')).toBe('<!DOCTYPE HTML><html><body>a</body></html>');
    expect(extractShowcase('<html><p>x</p></html>')).toBe('<html><p>x</p></html>');
    expect(extractShowcase('<!doctype html><html></html>')).toBe('<!doctype html><html></html>');
    // Caractere que muda de tamanho ao minúsculo não pode deslocar o corte.
    expect(extractShowcase('İİİ <!doctype html><html></html>')).toBe('<!doctype html><html></html>');
    expect(extractShowcase('<!doctype html><html><body>sem fim')).toBeNull();
    expect(extractShowcase('só texto')).toBeNull();
  });

  it('recusa script, iframe, objeto, evento, link, base e meta http-equiv; não recusa texto parecido', () => {
    expect(showcaseRefusal(HTML)).toBeNull();
    expect(showcaseRefusal('<p>button = 1, Monday = 2</p>')).toBeNull();
    expect(showcaseRefusal('<script>x</script>')).toMatch(/script/);
    expect(showcaseRefusal('<iframe src="x"></iframe>')).toMatch(/iframe/);
    expect(showcaseRefusal('<object data="x"></object>')).toMatch(/object/);
    expect(showcaseRefusal('<embed src="x">')).toMatch(/embed/);
    expect(showcaseRefusal('<button onclick="x()">a</button>')).toMatch(/evento/);
    expect(showcaseRefusal('<link rel="stylesheet" href="https://x.test/a.css">')).toMatch(/link/);
    expect(showcaseRefusal('<base href="https://x.test/">')).toMatch(/base/);
    expect(showcaseRefusal('<meta http-equiv="refresh" content="0">')).toMatch(/link|base|http-equiv/);
  });

  it('lê a resposta do claude: erro de sobrecarga é transitório; limite da conta, não', () => {
    expect(readResult(empty)).toMatchObject({ ok: false, transient: true });
    expect(readResult({ code: 0, stderr: '', stdout: 'não é json' })).toMatchObject({ ok: false, transient: true });
    expect(readResult(errorJson('error_during_execution', 'API Error: 529 {"type":"overloaded_error"}'))).toMatchObject({ ok: false, transient: true });
    expect(readResult(errorJson('error_during_execution', 'API Error: 429 rate limit'))).toMatchObject({ ok: false, transient: true });
    expect(readResult(errorJson('error_during_execution', "You've hit your limit · resets 5pm"))).toMatchObject({ ok: false, transient: false });
    expect(readResult(errorJson('error_max_turns'))).toMatchObject({ ok: false, transient: false });
    expect(readResult(ok(HTML))).toEqual({ ok: true, result: HTML });
  });

  it('espera de nova tentativa: 5 s na primeira, 10 s na segunda, com jitter de até a base', () => {
    expect(retryDelay(1, () => 0)).toBe(5_000);
    expect(retryDelay(1, () => 0.999)).toBe(9_995);
    expect(retryDelay(2, () => 0)).toBe(10_000);
  });
});

describe('gerador da vitrine: gravação', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-vitrine-gerador-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const job = (head: string | null = null): ShowcaseJob => ({ projectId: 'p1', dir, prompt: 'PROMPT_NAO_LOGAR', head });

  it('sucesso: grava VITRINE.html (o HTML sem o texto em volta) e a base com o HEAD de antes; o prompt vai pelo stdin', async () => {
    gitIn(dir, 'init', '-q');
    await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = 1;\n', 'utf8');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-q', '-m', 'base');
    const head = gitIn(dir, 'rev-parse', 'HEAD');
    const { runner, spawns, logs } = makeRunner([finished(ok(`Segue a página:\n\`\`\`html\n${HTML}\n\`\`\`\n`))]);
    await runner.start(job(head));
    await runner.settled('p1');
    expect(runner.status('p1')).toMatchObject({ state: 'done' });
    expect(await fs.readFile(path.join(dir, 'VITRINE.html'), 'utf8')).toBe(HTML + '\n');
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.cwd).toBe(dir);
    expect(spawns[0]!.stdin).toBe('PROMPT_NAO_LOGAR');
    expect(spawns[0]!.args).not.toContain('PROMPT_NAO_LOGAR');
    expect((await validCheck(dir, SHOWCASE_CHECK_PATH))?.sha).toBe(head);
    // O log é curto: sem o HTML e sem o prompt.
    expect(logs.some((l) => l.startsWith('[vitrine] projeto p1: página gravada'))).toBe(true);
    expect(logs.join('\n')).not.toContain('<html');
    expect(logs.join('\n')).not.toContain('PROMPT_NAO_LOGAR');
  }, 30_000);

  it.each([
    ['script', '<script>alert(1)</script>'],
    ['iframe', '<iframe src="https://x.test"></iframe>'],
    ['atributo on*', '<button onclick="x()">oi</button>'],
    ['link', '<link rel="stylesheet" href="https://x.test/a.css">'],
    ['base', '<base href="https://x.test/">'],
    ['meta http-equiv', '<meta http-equiv="refresh" content="0">'],
  ])('recusa %s: failed, nada gravado (nem a base)', async (_, bad) => {
    const { runner } = makeRunner([finished(ok(`<!doctype html><html><body>${bad}</body></html>`))]);
    await runner.start(job('a'.repeat(40)));
    await runner.settled('p1');
    expect(runner.status('p1').state).toBe('failed');
    expect(await exists(path.join(dir, 'VITRINE.html'))).toBe(false);
    expect(await exists(path.join(dir, '.myco', 'showcase.json'))).toBe(false);
  });

  it('HTML com cara de segredo: failed com o tipo do achado, nada gravado, e o valor fora da mensagem e do log', async () => {
    const { runner, logs } = makeRunner([finished(ok(`<!doctype html><html><body><code>${FAKE_KEY}</code></body></html>`))]);
    await runner.start(job());
    await runner.settled('p1');
    const st = runner.status('p1');
    expect(st).toMatchObject({ state: 'failed', error: 'a vitrine saiu com algo que parece segredo (chave de API da Anthropic): nada foi gravado; gere de novo' });
    expect(st.error).not.toContain(FAKE_KEY);
    expect(logs.join('\n')).not.toContain(FAKE_KEY);
    expect(await exists(path.join(dir, 'VITRINE.html'))).toBe(false);
  });

  it('custo: total_cost_usd vira costUsd (done) e aparece no log; sem o campo, nada de costUsd', async () => {
    const com = makeRunner([finished(ok(HTML, { total_cost_usd: 0.0421 }))]);
    await com.runner.start(job());
    await com.runner.settled('p1');
    expect(com.runner.status('p1')).toMatchObject({ state: 'done', costUsd: 0.0421 });
    expect(com.logs.some((l) => l.startsWith('[vitrine] projeto p1: página gravada') && l.includes('custo US$ 0,0421'))).toBe(true);

    const sem = makeRunner([finished(ok(HTML))]);
    await sem.runner.start(job());
    await sem.runner.settled('p1');
    expect(sem.runner.status('p1').state).toBe('done');
    expect(sem.runner.status('p1')).not.toHaveProperty('costUsd');
    expect(sem.logs.join('\n')).not.toContain('custo');
  });

  it('custo em falha: informado pelo claude, vai para failed', async () => {
    const { runner } = makeRunner([finished(errorJson('error_max_turns', '', { total_cost_usd: 0.5 }))]);
    await runner.start(job());
    await runner.settled('p1');
    expect(runner.status('p1')).toMatchObject({ state: 'failed', costUsd: 0.5 });
  });

  it('resposta sem </html>: failed, com o motivo; nada gravado', async () => {
    const { runner } = makeRunner([finished(ok('<!doctype html><html><body>cortada'))]);
    await runner.start(job());
    await runner.settled('p1');
    expect(runner.status('p1')).toMatchObject({ state: 'failed', error: expect.stringMatching(/não traz o HTML/) });
    expect(await exists(path.join(dir, 'VITRINE.html'))).toBe(false);
  });

  it('página maior que o limite: failed, nada gravado', async () => {
    const big = `<!doctype html><html>${'a'.repeat(MAX_SHOWCASE_BYTES)}</html>`;
    const { runner } = makeRunner([finished(ok(big))]);
    await runner.start(job());
    await runner.settled('p1');
    expect(runner.status('p1')).toMatchObject({ state: 'failed', error: expect.stringMatching(/5 MB/) });
    expect(await exists(path.join(dir, 'VITRINE.html'))).toBe(false);
  });

  it('destino é link simbólico: failed, e o alvo fica como estava (pula sem permissão de link simbólico)', async (ctx) => {
    const alvo = path.join(dir, 'alvo.txt');
    await fs.writeFile(alvo, 'original', 'utf8');
    try {
      await fs.symlink(alvo, path.join(dir, 'VITRINE.html'));
    } catch {
      ctx.skip();
    }
    const { runner } = makeRunner([finished(ok(HTML))]);
    await runner.start(job());
    await runner.settled('p1');
    expect(runner.status('p1')).toMatchObject({ state: 'failed', error: expect.stringMatching(/não é arquivo comum/) });
    expect(await fs.readFile(alvo, 'utf8')).toBe('original');
  });
});

describe('gerador da vitrine: uma por projeto, reserva e tentativas', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-vitrine-fila-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const job = (): ShowcaseJob => ({ projectId: 'p1', dir, prompt: 'P', head: null });

  it('segunda geração do mesmo projeto, enquanto a primeira roda: 409', async () => {
    const c = controlled();
    const { runner, spawns } = makeRunner([c.run]);
    await runner.start(job());
    await expect(runner.start(job())).rejects.toBeInstanceOf(ShowcaseBusyError);
    expect(spawns).toHaveLength(1);
    c.finish(ok(HTML));
    await runner.settled('p1');
    expect(runner.status('p1').state).toBe('done');
  });

  it('uso no limite: 429, a geração não começa e o estado volta a idle', async () => {
    const { runner, spawns } = makeRunner([], {
      checkUsage: async () => {
        throw new UsageStopError({ kind: 'five_hour', percentUsed: 90, limit: 85, resetsAt: null });
      },
    });
    const err = await runner.start(job()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShowcaseRefusedError);
    expect((err as ShowcaseRefusedError).status).toBe(429);
    expect(spawns).toHaveLength(0);
    expect(runner.status('p1').state).toBe('idle');
  });

  it('recursos ocupados: 503 com o motivo, a geração não começa e o estado volta a idle', async () => {
    const { runner, spawns } = makeRunner([], { reserve: async () => ({ ok: false, reason: 'RAM disponível 0,4 GB (reserva 1 GB)' }) });
    const err = await runner.start(job()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShowcaseRefusedError);
    expect((err as ShowcaseRefusedError).status).toBe(503);
    expect((err as Error).message).toMatch(/RAM disponível/);
    expect(spawns).toHaveLength(0);
    expect(runner.status('p1').state).toBe('idle');
  });

  it('reserva liberada no fim, em sucesso e em erro (inclusive quando o claude não abre)', async () => {
    const sucesso = makeRunner([finished(ok(HTML))]);
    await sucesso.runner.start(job());
    await sucesso.runner.settled('p1');
    expect(sucesso.releases.count).toBe(1);

    const erro = makeRunner([finished(ok('sem html'))]);
    await erro.runner.start(job());
    await erro.runner.settled('p1');
    expect(erro.runner.status('p1').state).toBe('failed');
    expect(erro.releases.count).toBe(1);

    const semClaude = makeRunner([]);
    await semClaude.runner.start(job());
    await semClaude.runner.settled('p1');
    expect(semClaude.runner.status('p1').state).toBe('failed');
    expect(semClaude.releases.count).toBe(1);
  });

  it('falha transitória (saída sem resultado): uma nova tentativa, com espera de 5 a 10 s', async () => {
    const { runner, spawns, sleeps } = makeRunner([finished(empty), finished(ok(HTML))]);
    await runner.start(job());
    await runner.settled('p1');
    expect(spawns).toHaveLength(2);
    expect(sleeps).toEqual([5_000]);
    expect(runner.status('p1').state).toBe('done');
  });

  it('overloaded no JSON é transitório: repete', async () => {
    const { runner, spawns } = makeRunner([finished(errorJson('error_during_execution', 'API Error: 529 overloaded_error')), finished(ok(HTML))]);
    await runner.start(job());
    await runner.settled('p1');
    expect(spawns).toHaveLength(2);
    expect(runner.status('p1').state).toBe('done');
  });

  it('erro que não é transitório não repete', async () => {
    const { runner, spawns } = makeRunner([finished(errorJson('error_max_turns'))]);
    await runner.start(job());
    await runner.settled('p1');
    expect(spawns).toHaveLength(1);
    expect(runner.status('p1').error).toMatch(/error_max_turns/);
  });

  it('validação do HTML não repete', async () => {
    const { runner, spawns } = makeRunner([finished(ok('<!doctype html><html><script></script></html>'))]);
    await runner.start(job());
    await runner.settled('p1');
    expect(spawns).toHaveLength(1);
    expect(runner.status('p1').state).toBe('failed');
  });

  it('custo com nova tentativa: soma o das duas tentativas', async () => {
    const { runner } = makeRunner([finished(errorJson('error_during_execution', 'API Error: 529 overloaded_error', { total_cost_usd: 0.25 })), finished(ok(HTML, { total_cost_usd: 0.5 }))]);
    await runner.start(job());
    await runner.settled('p1');
    expect(runner.status('p1')).toMatchObject({ state: 'done', costUsd: 0.75 });
  });

  it('duas falhas transitórias seguidas: falha depois da segunda tentativa', async () => {
    const { runner, spawns, sleeps } = makeRunner([finished(empty), finished(empty)]);
    await runner.start(job());
    await runner.settled('p1');
    expect(spawns).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(runner.status('p1').state).toBe('failed');
  });

  it('passou do tempo máximo: mata o processo e falha com "tempo esgotado"', async () => {
    const c = controlled();
    const { runner } = makeRunner([c.run], { timeoutMs: 20 });
    await runner.start(job());
    await runner.settled('p1');
    expect(c.kills()).toBe(1);
    expect(runner.status('p1')).toMatchObject({ state: 'failed', error: expect.stringMatching(/tempo esgotado/) });
  });

  it('desligando o servidor: mata a geração, não repete e recusa as novas com 503', async () => {
    const c = controlled();
    const { runner, spawns } = makeRunner([c.run]);
    await runner.start(job());
    await runner.stopAll();
    expect(c.kills()).toBe(1);
    expect(spawns).toHaveLength(1);
    expect(runner.status('p1')).toMatchObject({ state: 'failed', error: expect.stringMatching(/parado/) });
    const err = await runner.start(job()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShowcaseRefusedError);
    expect((err as ShowcaseRefusedError).status).toBe(503);
  });
});
