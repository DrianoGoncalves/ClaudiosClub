import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_MIN_VERSION } from '../server/codexEnv';
import { ConfigPatch, readConfig, updateConfig } from '../server/config';
import {
  buildAskArgs,
  buildAskPrompt,
  createGptMcp,
  gptMcpCommand,
  gptMcpServerConfig,
  runGptMcpStdio,
  spawnCodex,
  sweepStaleTemps,
  TOOLS,
  windowsArg,
  type GptRun,
  type GptRunner,
} from '../server/staff/gptMcp';

// O MCP do GPT (`perguntar_gpt`): a montagem do `codex exec` (só leitura, sem shell, segredos negados), o plano B de modelo, o filtro de
// segredos e o protocolo. O Codex de verdade é trocado por um runner falso; o spawn é testado com um `codex` de mentira no PATH.

let root: string;
let proj: string; // pasta da sessão
let main: string; // pasta do projeto (numa worktree é outra)
let mycoHome: string;
let home: string;
let configFile: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-gpt-'));
  proj = path.join(root, 'wt');
  main = path.join(root, 'main');
  mycoHome = path.join(root, 'myco');
  home = path.join(root, 'home');
  configFile = path.join(mycoHome, 'config.json');
  for (const d of [proj, main, path.join(mycoHome, 'secrets'), path.join(home, '.ssh'), path.join(proj, '.vps'), path.join(main, '.vps')]) await fs.mkdir(d, { recursive: true });
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await fs.rm(configFile, { force: true });
  await updateConfig({ codexReview: true }, configFile);
});

const MODELS = JSON.stringify({
  models: [
    { slug: 'gpt-6-sol', display_name: 'GPT-6 Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }], default_reasoning_level: 'high' },
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }], default_reasoning_level: 'high' },
    { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }], default_reasoning_level: 'high' },
  ],
});
const GONE = `warning: Model metadata for gpt-6.1-sol not found\nERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}`;

interface Call {
  args: string[];
  input: string;
  cwd: string;
}
const FEATURES = 'network_proxy                       experimental       true\napps                                stable             true\n';
/** Runner falso: cada `exec` é respondido por `exec(args, n)`; `debug models` devolve o catálogo; `--version` e `features list`, o ambiente do Codex. */
function fake(
  exec: (args: string[], n: number) => Partial<GptRun> & { answer?: string },
  catalog: GptRun = { code: 0, stdout: MODELS, stderr: '' },
  version: GptRun = { code: 0, stdout: 'codex-cli 0.167.0\n', stderr: '' },
) {
  const calls: Call[] = [];
  let n = 0;
  const run: GptRunner = async (args, input, o) => {
    calls.push({ args, input, cwd: o.cwd });
    if (args[0] === 'debug') return catalog;
    if (args[0] === '--version') return version;
    if (args[0] === 'features') return { code: 0, stdout: FEATURES, stderr: '' };
    const r = exec(args, n++);
    if (r.answer !== undefined) await fs.writeFile(args[args.indexOf('-o') + 1]!, r.answer);
    return { code: 0, stdout: '', stderr: '', ...r };
  };
  return { run, calls, execs: () => calls.filter((c) => c.args[0] === 'exec') };
}
const server = (run: GptRunner, over = {}) => createGptMcp({ root: proj, projectPath: main, home, mycoHome, run, tmpRoot: root, ...over });
const ask = async (s: ReturnType<typeof createGptMcp>, args: Record<string, unknown> = { pergunta: 'JSON ou SQLite?' }) => {
  const r = await s.callTool('perguntar_gpt', args);
  return { text: r.content[0]!.text, isError: !!r.isError };
};

describe('perguntar_gpt: argumentos do codex exec', () => {
  let opts: Parameters<typeof buildAskArgs>[0];
  let args: string[];
  beforeAll(() => {
    opts = { cwd: proj, projectPath: main, home, mycoHome, out: '/tmp/x/resposta.md', effort: 'high', model: null };
    args = buildAskArgs(opts);
  });
  const has = (...seq: string[]) => args.join('\u0000').includes(seq.join('\u0000'));

  it('só leitura e sem rede, pelo codexSafetyArgs; nunca -s, --dangerously nem rede liberada', () => {
    expect(args[0]).toBe('exec');
    expect(args).toEqual(expect.arrayContaining(['--ignore-user-config', '--ephemeral', '--skip-git-repo-check']));
    expect(has('-c', 'features.apps=false')).toBe(true);
    expect(has('-c', 'approval_policy="never"')).toBe(true);
    expect(has('-c', 'default_permissions="mycodeny"')).toBe(true);
    expect(has('-c', 'permissions.mycodeny.extends=":read-only"')).toBe(true);
    expect(has('-c', 'permissions.mycodeny.network={enabled=false}')).toBe(true);
    expect(args).not.toContain('network_proxy');
    expect(args.some((a) => /^(-s|--sandbox|--full-auto|--dangerously\S*|--add-dir)$/.test(a) || /workspace|danger-full-access|:workspace/.test(a))).toBe(false);
  });

  it('nega os segredos: ~/.ssh, o cofre do Claudio’s Club e o .vps da sessão e o do projeto (worktree)', () => {
    const fs = args.find((a) => a.startsWith('permissions.mycodeny.filesystem='))!;
    for (const denied of ['~/.ssh', path.join(mycoHome, 'secrets'), path.join(proj, '.vps'), path.join(main, '.vps')]) expect(fs).toContain(`${JSON.stringify(denied)}="deny"`);
  });

  it('pasta da sessão em -C, resposta em -o, prompt pelo stdin (-), esforço high por padrão; o modelo só vai com -m quando há', () => {
    expect(has('-C', proj, '-o', opts.out, '-')).toBe(true);
    expect(args.at(-1)).toBe('-');
    expect(has('-c', 'model_reasoning_effort="high"')).toBe(true);
    expect(args).not.toContain('-m');
    const withModel = buildAskArgs({ ...opts, model: 'gpt-6-sol', effort: 'max' });
    expect(withModel.join(' ')).toContain('-m gpt-6-sol');
    expect(withModel).toContain('model_reasoning_effort="max"');
  });

  it('o texto da pergunta nunca entra nos argumentos', () => {
    const q = '$(rm -rf ~) ; `x` "aspas" \'simples\' PROMPT_GPT';
    expect(buildAskArgs(opts).join(' ')).not.toContain('rm -rf');
    expect(buildAskPrompt({ pergunta: q, contexto: 'ctx' })).toContain(q);
  });
});

describe('perguntar_gpt: a ferramenta', () => {
  it('manda o prompt pelo stdin, roda na pasta da sessão e devolve "Resposta do GPT (modelo)"; limpa o temporário', async () => {
    const f = fake(() => ({ answer: '1) JSON\n2) simples\n3) risco: gravação interrompida', stderr: 'OpenAI Codex v0.156.1\nmodel: gpt-6-astra\n' }));
    const r = await ask(server(f.run), { pergunta: 'JSON ou SQLite?', contexto: 'um usuário, 50 chaves' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Resposta do GPT \(gpt-6-astra\):\n\n1\) JSON/);
    const [call] = f.execs();
    expect(call!.cwd).toBe(proj);
    expect(call!.input).toContain('JSON ou SQLite?');
    expect(call!.input).toContain('um usuário, 50 chaves');
    expect(call!.args.join(' ')).not.toContain('JSON ou SQLite?');
    const out = call!.args[call!.args.indexOf('-o') + 1]!;
    await expect(fs.stat(path.dirname(out))).rejects.toThrow();
    expect((await fs.readdir(root)).filter((n) => n.startsWith('myco-gpt-'))).toEqual([]);
  });

  it('vazio = padrão do Codex (sem -m); o modelo da config vai com -m e vale já, sem reiniciar', async () => {
    const f = fake(() => ({ answer: 'ok' }));
    const s = server(f.run);
    expect((await ask(s)).text).toContain('Resposta do GPT (padrão do Codex)');
    expect(f.execs()[0]!.args).not.toContain('-m');
    await updateConfig({ codexModel: 'gpt-6-sol' }, configFile);
    expect((await ask(s)).text).toContain('Resposta do GPT (gpt-6-sol)');
    expect(f.execs()[1]!.args.join(' ')).toContain('-m gpt-6-sol');
  });

  it('esforço: padrão high, o pedido vale, e um inválido é recusado antes de abrir o Codex', async () => {
    const f = fake(() => ({ answer: 'ok' }));
    const s = server(f.run);
    await ask(s);
    await ask(s, { pergunta: 'x', esforco: 'xhigh' });
    await ask(s, { pergunta: 'x', esforco: '' });
    expect(f.execs().map((c) => c.args.find((a) => a.startsWith('model_reasoning_effort=')))).toEqual(['model_reasoning_effort="high"', 'model_reasoning_effort="xhigh"', 'model_reasoning_effort="high"']);
    const bad = await ask(s, { pergunta: 'x', esforco: 'turbo' });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.text).toContain('argumentos inválidos');
    expect(f.execs()).toHaveLength(3);
    expect((await ask(s, {})).text).toContain('informe a pergunta');
  });

  it('plano B: a conta recusa o modelo da config, usa o mais parecido do catálogo e avisa', async () => {
    await updateConfig({ codexModel: 'gpt-6.1-sol' }, configFile);
    const f = fake((_a, n) => (n === 0 ? { code: 1, stderr: GONE } : { answer: 'segunda opinião' }));
    const r = await ask(server(f.run));
    expect(r.isError).toBe(false);
    expect(f.execs().map((c) => c.args[c.args.indexOf('-m') + 1])).toEqual(['gpt-6.1-sol', 'gpt-6-sol']);
    expect(r.text).toContain('Resposta do GPT (gpt-6-sol):');
    expect(r.text).toContain('o modelo gpt-6.1-sol não está disponível na sua conta do Codex; usei gpt-6-sol nesta pergunta');
  });

  it('plano B sem parecido (ou sem catálogo): roda sem -m, no padrão do Codex, e avisa', async () => {
    await updateConfig({ codexModel: 'gpt-9-zeta' }, configFile);
    const f = fake((_a, n) => (n === 0 ? { code: 1, stderr: GONE } : { answer: 'ok', stderr: 'model: gpt-6-astra\n' }), { code: 1, stdout: '', stderr: 'sem rede' });
    const r = await ask(server(f.run));
    expect(f.execs()[1]!.args).not.toContain('-m');
    expect(r.text).toContain('Resposta do GPT (gpt-6-astra):');
    expect(r.text).toContain('usei o padrão do Codex nesta pergunta');
  });

  it('o plano B é uma vez só: se a segunda também falha, devolve o erro', async () => {
    await updateConfig({ codexModel: 'gpt-6.1-sol' }, configFile);
    const f = fake(() => ({ code: 1, stderr: GONE }));
    const r = await ask(server(f.run));
    expect(r.isError).toBe(true);
    expect(f.execs()).toHaveLength(2);
    expect(r.text).toContain('o Codex falhou');
  });

  it('outra falha não aciona o plano B; mostra a última linha do erro', async () => {
    await updateConfig({ codexModel: 'gpt-6-sol' }, configFile);
    const f = fake(() => ({ code: 1, stderr: 'linha 1\nERROR: rate limit reached' }));
    const r = await ask(server(f.run));
    expect(f.execs()).toHaveLength(1);
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain('rate limit reached');
  });

  it('Codex desligado nas configurações: nem abre o processo (a flag é relida a cada chamada)', async () => {
    const f = fake(() => ({ answer: 'ok' }));
    const s = server(f.run);
    await updateConfig({ codexReview: false }, configFile);
    const r = await ask(s);
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain('desligado nas configurações');
    expect(f.calls).toHaveLength(0);
  });

  it('segredo na pergunta não vai ao GPT; segredo na resposta não volta para a sessão', async () => {
    const f = fake(() => ({ answer: 'use DB_PASSWORD=Sup3rSecreta123 no .env' }));
    const s = server(f.run);
    const sent = await ask(s, { pergunta: 'minha chave é sk-ant-api03-Zx9Qw7Lm2Kp4Rt8Vb1Nc5Hd3Jf6', contexto: '' });
    expect(sent).toMatchObject({ isError: true });
    expect(sent.text).toContain('não mandei ao GPT');
    expect(f.calls).toHaveLength(0);
    const back = await ask(s);
    expect(back.isError).toBe(true);
    expect(back.text).toContain('foi retida');
    expect(back.text).not.toContain('Sup3rSecreta123');
    expect((await fs.readdir(root)).filter((n) => n.startsWith('myco-gpt-'))).toEqual([]);
  });

  it('sem o codex instalado, sem resposta no prazo e resposta enorme', async () => {
    const enoent = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
    expect((await ask(server(fake(() => ({ code: null, spawnError: enoent })).run))).text).toContain('não está instalado');
    // Sem o codex já na conferência da versão: nenhum `exec` é aberto.
    const gone = fake(() => ({ answer: 'ok' }), undefined, { code: null, stdout: '', stderr: '', spawnError: enoent });
    expect(await ask(server(gone.run))).toMatchObject({ isError: true, text: expect.stringContaining('não está instalado') });
    expect(gone.execs()).toHaveLength(0);
    const late = await ask(server(fake(() => ({ code: null, timedOut: true })).run, { timeoutMs: 60_000 }));
    expect(late).toMatchObject({ isError: true });
    expect(late.text).toContain('não respondeu em 1 minutos');
    const big = await ask(server(fake(() => ({ answer: 'a'.repeat(30_000) })).run));
    expect(big.text.length).toBeLessThan(21_000);
    expect(big.text).toContain('resposta cortada');
  });
});

describe('perguntar_gpt: Codex velho e bloqueio de segredos', () => {
  it('Codex abaixo do mínimo do motor: recusa com a mesma mensagem (mínimo e como atualizar) e não abre o exec', async () => {
    const f = fake(() => ({ answer: 'ok' }), undefined, { code: 0, stdout: 'codex-cli 0.120.0\n', stderr: '' });
    const r = await ask(server(f.run));
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`O Codex 0.120.0 é antigo demais para rodar funcionários no Claudio’s Club (o mínimo é ${CODEX_MIN_VERSION}). Atualize com: `);
    expect(f.execs()).toHaveLength(0);
    expect((await fs.readdir(root)).filter((n) => n.startsWith('myco-gpt-'))).toEqual([]);
  });

  it('versão que não dá para ler, ou o comando falhando: recusa; só a conferência que deu certo fica guardada', async () => {
    for (const version of [{ code: 0, stdout: 'bom dia', stderr: '' }, { code: 3, stdout: '', stderr: 'boom' }, { code: null, stdout: '', stderr: '', timedOut: true }]) {
      const f = fake(() => ({ answer: 'ok' }), undefined, version);
      const r = await ask(server(f.run));
      expect(r.isError).toBe(true);
      expect(f.execs()).toHaveLength(0);
    }
    // Duas perguntas, uma conferência: o `--version` roda uma vez.
    const ok = fake(() => ({ answer: 'ok' }));
    const s = server(ok.run);
    expect((await ask(s)).isError).toBe(false);
    expect((await ask(s)).isError).toBe(false);
    expect(ok.calls.filter((c) => c.args[0] === '--version')).toHaveLength(1);
    expect(ok.execs()).toHaveLength(2);
  });

  it('o network_proxy não importa: Codex sem o recurso responde normalmente (a pergunta roda sem rede)', async () => {
    const f = fake(() => ({ answer: 'ok' }));
    const run: GptRunner = async (args, input, o) => (args[0] === 'features' ? { code: 1, stdout: '', stderr: 'sem features' } : f.run(args, input, o));
    expect((await ask(server(run))).isError).toBe(false);
  });

  it('mais de um arquivo para negar: erro claro da ferramenta (CodexBlockedError), nada roda e o temporário some', async () => {
    const w = await fs.mkdtemp(path.join(root, 'dois-arquivos-'));
    const a = path.join(w, 'a');
    const b = path.join(w, 'b');
    await fs.mkdir(a);
    await fs.mkdir(b);
    await fs.writeFile(path.join(a, '.vps'), 'x'); // .vps que é arquivo, na pasta da sessão e no projeto
    await fs.writeFile(path.join(b, '.vps'), 'y');
    const f = fake(() => ({ answer: 'ok' }));
    const r = await ask(server(f.run, { root: a, projectPath: b }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain('mais de um arquivo para proteger');
    expect(r.text).not.toContain('falha inesperada');
    expect(f.execs()).toHaveLength(0);
    expect((await fs.readdir(root)).filter((n) => n.startsWith('myco-gpt-'))).toEqual([]);
  });

  it('caminho secreto que não dá para conferir (link em laço no ~/.ssh): erro claro da ferramenta, nada roda', async () => {
    const w = await fs.mkdtemp(path.join(root, 'laco-'));
    await fs.symlink(path.join(w, '.ssh-b'), path.join(w, '.ssh'));
    await fs.symlink(path.join(w, '.ssh'), path.join(w, '.ssh-b'));
    const f = fake(() => ({ answer: 'ok' }));
    const r = await ask(server(f.run, { home: w }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Não consegui conferir');
    expect(r.text).toContain('ELOOP');
    expect(r.text).not.toContain('falha inesperada');
    expect(f.execs()).toHaveLength(0);
    expect((await fs.readdir(root)).filter((n) => n.startsWith('myco-gpt-'))).toEqual([]);
  });

  it('MYCO_HOME vale para o MCP: o servidor da sessão leva --myco-home com ele', async () => {
    const old = process.env.MYCO_HOME;
    process.env.MYCO_HOME = path.join(root, 'outro-myco');
    try {
      vi.resetModules();
      const fresh = await import('../server/staff/gptMcp');
      const c = fresh.gptMcpServerConfig({ projectPath: main, root: proj, home });
      expect(c.args.slice(c.args.indexOf('--myco-home'))).toEqual(['--myco-home', path.join(root, 'outro-myco')]);
    } finally {
      if (old === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = old;
      vi.resetModules();
    }
  });
});

describe('perguntar_gpt: protocolo MCP', () => {
  it('initialize, tools/list e tools/call; ferramenta ou método desconhecido; notificação sem resposta', async () => {
    const f = fake(() => ({ answer: 'opinião' }));
    const s = server(f.run);
    const init = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'myco-gpt' } });
    expect(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const list = (await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as { result: { tools: typeof TOOLS } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['perguntar_gpt']);
    expect(list.result.tools[0]!.inputSchema).toMatchObject({ required: ['pergunta'], properties: { pergunta: {}, contexto: {}, esforco: {} } });
    const call = (await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'perguntar_gpt', arguments: { pergunta: 'q' } } })) as { result: { content: Array<{ text: string }> } };
    expect(call.result.content[0]!.text).toContain('Resposta do GPT');
    expect(await s.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'outra' } })).toMatchObject({ error: { code: -32602 } });
    expect(await s.handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' })).toMatchObject({ error: { code: -32601 } });
    expect(await s.handle({ jsonrpc: '2.0', id: 6, method: 'ping' })).toMatchObject({ result: {} });
  });

  it('pelo stdio: uma mensagem JSON por linha', async () => {
    await updateConfig({ codexReview: false }, configFile); // sem Codex: a chamada volta o erro, sem abrir nada
    const lines: string[] = [];
    const out = new Writable({ write: (c, _e, cb) => (lines.push(...c.toString().split('\n').filter(Boolean)), cb()) });
    const input = Readable.from([
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
      'isto não é json\n',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
    ]);
    await runGptMcpStdio(['--project', main, '--root', proj, '--home', home, '--myco-home', mycoHome], input, out);
    const msgs = lines.map((l) => JSON.parse(l) as { id: number | null; result?: unknown; error?: { code: number } });
    expect(msgs.find((m) => m.id === 1)?.result).toBeTruthy();
    expect(msgs.find((m) => m.id === null)?.error?.code).toBe(-32700);
    expect(msgs.find((m) => m.id === 2)?.result).toMatchObject({ tools: [{ name: 'perguntar_gpt' }] });
    await expect(runGptMcpStdio(['--project', 'relativo'], Readable.from([]), out)).rejects.toThrow(/uso:/);
  });

  it('como a sessão sobe o servidor: só caminhos, nenhum segredo', () => {
    const c = gptMcpServerConfig({ projectPath: main, root: proj, home, mycoHome });
    expect(c.type).toBe('stdio');
    expect(c.args).toEqual(expect.arrayContaining(['--project', main, '--root', proj, '--home', home, '--myco-home', mycoHome]));
    expect(c.args.some((a) => /gpt-mcp\.(ts|mjs)$/.test(a))).toBe(true);
  });
});

describe('spawnCodex', () => {
  it('windowsArg: aspas e espaços entre aspas, aspas internas escapadas', () => {
    expect(windowsArg('exec')).toBe('exec');
    expect(windowsArg('a b')).toBe('"a b"');
    expect(windowsArg('permissions.x.filesystem={":project_roots"={".vps"="deny"}}')).toBe('"permissions.x.filesystem={\\":project_roots\\"={\\".vps\\"=\\"deny\\"}}"');
  });

  // Um `codex` de mentira no PATH (script de shell): só no Unix.
  const unix = process.platform !== 'win32';
  let bin: string;
  const fakeCodex = async (script: string) => {
    bin = await fs.mkdtemp(path.join(root, 'bin-'));
    await fs.writeFile(path.join(bin, 'codex'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  };
  const withEnv = async <T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>) => {
    const old = { PATH: process.env.PATH, MYCO_X: process.env.MYCO_X, CLAUDE_X: process.env.CLAUDE_X, ANTHROPIC_X: process.env.ANTHROPIC_X, KEEP_X: process.env.KEEP_X };
    Object.assign(process.env, env, { MYCO_X: '1', CLAUDE_X: '1', ANTHROPIC_X: '1', KEEP_X: 'sim' });
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };

  it.runIf(unix)('abre sem shell: argumentos intactos (nada é executado), prompt pelo stdin, pasta certa e ambiente sem MYCO_/CLAUDE_/ANTHROPIC_', async () => {
    const env = await fakeCodex('printf "%s\\n" "$@" > "$OUTDIR/args.txt"; cat > "$OUTDIR/stdin.txt"; echo "$PWD" > "$OUTDIR/pwd.txt"; env > "$OUTDIR/env.txt"; echo ok');
    const outdir = await fs.mkdtemp(path.join(root, 'out-'));
    const marker = path.join(outdir, 'executou');
    const nasty = ['$(touch ' + marker + ')', '; touch ' + marker, '`touch ' + marker + '`', 'com "aspas" e \'simples\'', 'a b'];
    const r = await withEnv({ ...env, OUTDIR: outdir }, () => spawnCodex(nasty, 'prompt $(touch ' + marker + ')\nsegunda linha', { cwd: proj, timeoutMs: 20_000 }));
    expect(r).toMatchObject({ code: 0, stdout: 'ok\n' });
    expect((await fs.readFile(path.join(outdir, 'args.txt'), 'utf8')).trimEnd().split('\n')).toEqual(nasty);
    expect(await fs.readFile(path.join(outdir, 'stdin.txt'), 'utf8')).toBe('prompt $(touch ' + marker + ')\nsegunda linha');
    expect((await fs.readFile(path.join(outdir, 'pwd.txt'), 'utf8')).trim()).toBe(await fs.realpath(proj));
    const seen = await fs.readFile(path.join(outdir, 'env.txt'), 'utf8');
    expect(seen).toContain('KEEP_X=sim');
    expect(seen).not.toMatch(/^(MYCO_X|CLAUDE_X|ANTHROPIC_X)=/m);
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it.runIf(unix)('passado o prazo, o processo e o que ele abriu morrem (nada fica rodando)', async () => {
    const env = await fakeCodex('sleep 60 & echo $! > "$OUTDIR/neto.pid"; echo $$ > "$OUTDIR/pai.pid"; wait');
    const outdir = await fs.mkdtemp(path.join(root, 'out-'));
    const t0 = Date.now();
    const r = await withEnv({ ...env, OUTDIR: outdir }, () => spawnCodex([], '', { cwd: proj, timeoutMs: 700 }));
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await new Promise((res) => setTimeout(res, 500));
    for (const f of ['pai.pid', 'neto.pid']) expect(alive(Number((await fs.readFile(path.join(outdir, f), 'utf8')).trim()))).toBe(false);
  });

  it('codex fora do PATH: spawnError ENOENT', async () => {
    const old = process.env.PATH;
    process.env.PATH = path.join(root, 'vazio');
    try {
      const r = await spawnCodex(['--version'], '', { cwd: proj, timeoutMs: 5_000 });
      if (process.platform === 'win32') expect(r.code).not.toBe(0);
      else expect(r.spawnError?.code).toBe('ENOENT');
    } finally {
      process.env.PATH = old;
    }
  });
});

// ---- encerramento: o codex em andamento não pode sobrar (nem o temporário) ----

describe('encerramento do MCP e cancelamento', () => {
  const unix = process.platform !== 'win32';
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  /** Vivo de verdade: `kill -0` responde também para zumbi, então no Linux olha o estado em /proc. */
  const alive = async (pid: number) => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
    return stat === null ? true : !/^\d+ \(.*\) Z /.test(stat);
  };
  const until = async (cond: () => Promise<boolean> | boolean, ms = 20_000) => {
    const t0 = Date.now();
    while (!(await cond())) {
      if (Date.now() - t0 > ms) throw new Error('prazo esgotado esperando a condição');
      await sleep(50);
    }
  };
  const pidOf = async (f: string) => Number((await fs.readFile(f, 'utf8')).trim());
  const tempsIn = async (dir: string) => (await fs.readdir(dir)).filter((n) => n.startsWith('myco-gpt-'));

  /** Um runner que fica parado até o `signal` abortar, como o spawnCodex de verdade (e só devolve depois, como ele). */
  function hang() {
    let started!: () => void;
    const begun = new Promise<void>((res) => (started = res));
    let seen: AbortSignal | undefined;
    const f = fake(() => ({}));
    const run: GptRunner = async (args, input, o) => {
      if (args[0] !== 'exec') return f.run(args, input, o);
      seen = o.signal;
      started();
      await new Promise<void>((res) => (o.signal?.aborted ? res() : o.signal?.addEventListener('abort', () => res(), { once: true })));
      await sleep(30); // o "processo" demora um pouco para fechar
      return { code: null, stdout: '', stderr: '', aborted: true };
    };
    return { run, begun, signal: () => seen };
  }
  const callMsg = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'perguntar_gpt', arguments: { pergunta: 'q' } } });

  it('notifications/cancelled: aborta só aquela pergunta, não responde a ela e apaga o temporário', async () => {
    const tmp = await fs.mkdtemp(path.join(root, 'tmp-'));
    const h = hang();
    const s = server(h.run, { tmpRoot: tmp });
    const call = s.handle(callMsg(7));
    await h.begun;
    expect(await tempsIn(tmp)).toHaveLength(1);
    expect(await s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } })).toBeNull(); // outra: nada acontece
    expect(h.signal()?.aborted).toBe(false);
    expect(await s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7, reason: 'user' } })).toBeNull();
    expect(await call).toBeNull();
    expect(h.signal()?.aborted).toBe(true);
    expect(await tempsIn(tmp)).toEqual([]);
  });

  it('shutdown: aborta tudo o que está em andamento, espera e não deixa temporário; chamada nova depois não abre nada', async () => {
    const tmp = await fs.mkdtemp(path.join(root, 'tmp-'));
    const h = hang();
    const f = fake(() => ({ answer: 'x' }));
    const s = server(h.run, { tmpRoot: tmp });
    const a = s.handle(callMsg(1));
    const b = s.handle(callMsg(2));
    await h.begun;
    await s.shutdown();
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect(await tempsIn(tmp)).toEqual([]);
    const late = server(f.run, { tmpRoot: tmp });
    await late.shutdown();
    expect(await late.handle(callMsg(3))).toBeNull();
    expect(f.execs()).toHaveLength(0);
  });

  it('cancelada na conferência da versão ou antes do plano B: nada de codex exec novo', async () => {
    const tmp = await fs.mkdtemp(path.join(root, 'tmp-'));
    const f = fake(() => ({ code: 1, stderr: GONE }));
    let s!: ReturnType<typeof createGptMcp>;
    // O catálogo é pedido depois do primeiro exec falhar: a pergunta é cancelada bem aí.
    const run: GptRunner = async (args, input, o) => {
      if (args[0] === 'debug') void s.shutdown(); // sem esperar: o shutdown espera esta própria chamada
      return f.run(args, input, o);
    };
    await updateConfig({ codexModel: 'gpt-6.1-sol' }, configFile);
    s = server(run, { tmpRoot: tmp });
    expect(await s.handle(callMsg(1))).toBeNull();
    expect(f.execs()).toHaveLength(1);
    expect(await tempsIn(tmp)).toEqual([]);
    await updateConfig({ codexModel: '' }, configFile);
  });

  it('sweepStaleTemps: só myco-gpt-* de pasta com mais de 1 h', async () => {
    const tmp = await fs.mkdtemp(path.join(root, 'tmp-'));
    const mk = async (name: string, ageMin: number) => {
      const d = path.join(tmp, name);
      await fs.mkdir(d);
      await fs.writeFile(path.join(d, 'resposta.md'), 'x');
      const t = new Date(Date.now() - ageMin * 60_000);
      await fs.utimes(d, t, t);
      return d;
    };
    const velha = await mk('myco-gpt-AbC123', 90);
    const nova = await mk('myco-gpt-xYz789', 5);
    const outra = await mk('outra-coisa-velha', 500);
    const comprida = await mk('myco-gpt-abc123-nao-e-do-mkdtemp', 500);
    expect(await sweepStaleTemps(tmp)).toBe(1);
    await expect(fs.stat(velha)).rejects.toThrow();
    for (const d of [nova, outra, comprida]) await fs.stat(d);
    expect(await sweepStaleTemps(path.join(tmp, 'nao-existe'))).toBe(0);
  });

  it.runIf(unix)('spawnCodex com signal: mata o processo e o neto, devolve aborted só depois de fechar; sinal já abortado não abre nada', async () => {
    const bin = await fs.mkdtemp(path.join(root, 'bin-'));
    const outdir = await fs.mkdtemp(path.join(root, 'out-'));
    await fs.writeFile(path.join(bin, 'codex'), '#!/bin/sh\nsleep 60 & echo $! > "$OUTDIR/neto.pid"; echo $$ > "$OUTDIR/pai.pid"; wait\n', { mode: 0o755 });
    const old = { PATH: process.env.PATH, OUTDIR: process.env.OUTDIR };
    Object.assign(process.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, OUTDIR: outdir });
    try {
      const ac = new AbortController();
      const p = spawnCodex([], '', { cwd: proj, timeoutMs: 60_000, signal: ac.signal });
      await until(async () => (await fs.readdir(outdir)).length === 2 && (await fs.readFile(path.join(outdir, 'pai.pid'), 'utf8')).trim() !== '');
      const [pai, neto] = [await pidOf(path.join(outdir, 'pai.pid')), await pidOf(path.join(outdir, 'neto.pid'))];
      ac.abort();
      expect(await p).toMatchObject({ aborted: true }); // code: null (morto por sinal)
      expect(await alive(pai)).toBe(false);
      await until(async () => !(await alive(neto)), 2_000);
      const again = await spawnCodex([], '', { cwd: proj, timeoutMs: 60_000, signal: ac.signal });
      expect(again).toMatchObject({ aborted: true, code: null });
      expect(again.spawnError).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it.runIf(unix)('spawnCodex: quem ignora o SIGTERM leva SIGKILL depois da carência (grupo inteiro)', async () => {
    const bin = await fs.mkdtemp(path.join(root, 'bin-'));
    const outdir = await fs.mkdtemp(path.join(root, 'out-'));
    await fs.writeFile(path.join(bin, 'codex'), '#!/bin/sh\ntrap "" TERM\nsleep 60 & echo $! > "$OUTDIR/neto.pid"; echo $$ > "$OUTDIR/pai.pid"; while :; do sleep 0.2; done\n', { mode: 0o755 });
    const old = { PATH: process.env.PATH, OUTDIR: process.env.OUTDIR };
    Object.assign(process.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, OUTDIR: outdir });
    try {
      const ac = new AbortController();
      const p = spawnCodex([], '', { cwd: proj, timeoutMs: 60_000, signal: ac.signal, graceMs: 500 });
      await until(async () => (await fs.readdir(outdir)).length === 2 && (await fs.readFile(path.join(outdir, 'pai.pid'), 'utf8')).trim() !== '');
      const [pai, neto] = [await pidOf(path.join(outdir, 'pai.pid')), await pidOf(path.join(outdir, 'neto.pid'))];
      const t0 = Date.now();
      ac.abort();
      expect(await p).toMatchObject({ aborted: true });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(450); // esperou a carência antes do SIGKILL
      expect(await alive(pai)).toBe(false);
      expect(await alive(neto)).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  // O MCP de verdade (o mesmo .ts que o app sobe, pelo tsx) com um `codex` de mentira que dorme: matar o MCP leva o codex junto.
  describe.runIf(unix)('MCP real por stdio', () => {
    type Stop = { how: 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'stdin'; ignoreTerm?: boolean };
    const cases: Stop[] = [{ how: 'SIGTERM' }, { how: 'SIGINT' }, { how: 'SIGHUP' }, { how: 'stdin' }, { how: 'SIGTERM', ignoreTerm: true }];
    it.each(cases)('$how (codex ignorando SIGTERM: $ignoreTerm): o codex e o neto morrem e /tmp/myco-gpt-* some', async ({ how, ignoreTerm }) => {
      const bin = await fs.mkdtemp(path.join(root, 'bin-'));
      const outdir = await fs.mkdtemp(path.join(root, 'out-'));
      const tmp = await fs.mkdtemp(path.join(root, 'tmp-'));
      const script = [
        '#!/bin/sh',
        'case "$1" in',
        '  --version) echo "codex-cli 0.167.0"; exit 0;;',
        '  features) echo "network_proxy experimental true"; exit 0;;',
        'esac',
        '[ -n "$IGNORE_TERM" ] && trap "" TERM',
        'sleep 60 & echo $! > "$OUTDIR/neto.pid"; echo $$ > "$OUTDIR/pai.pid"',
        'while :; do wait; done',
      ].join('\n');
      await fs.writeFile(path.join(bin, 'codex'), script + '\n', { mode: 0o755 });
      const { command, args } = gptMcpCommand(false);
      const mcp = spawn(command, [...args, '--project', main, '--root', proj, '--home', home, '--myco-home', mycoHome], {
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, OUTDIR: outdir, TMPDIR: tmp, ...(ignoreTerm && { IGNORE_TERM: '1' }) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      mcp.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      const exited = new Promise<number | null>((res) => mcp.on('exit', (code) => res(code)));
      try {
        mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
        mcp.stdin.write(JSON.stringify(callMsg(2)) + '\n');
        await until(async () => (await fs.readdir(outdir)).length === 2 && (await fs.readFile(path.join(outdir, 'pai.pid'), 'utf8')).trim() !== '', 40_000);
        const [pai, neto] = [await pidOf(path.join(outdir, 'pai.pid')), await pidOf(path.join(outdir, 'neto.pid'))];
        expect(await alive(pai)).toBe(true);
        expect(await tempsIn(tmp)).toHaveLength(1); // a pasta da resposta existe enquanto a pergunta roda
        const t0 = Date.now();
        if (how === 'stdin') mcp.stdin.end();
        else mcp.kill(how);
        expect(await exited).toBe(0);
        expect(Date.now() - t0).toBeLessThan(ignoreTerm ? 9_000 : 5_000);
        if (ignoreTerm) expect(Date.now() - t0).toBeGreaterThanOrEqual(2_800); // esperou os 3 s antes do SIGKILL
        expect(await alive(pai)).toBe(false);
        expect(await alive(neto)).toBe(false);
        expect(await tempsIn(tmp)).toEqual([]);
        expect(stdout).not.toContain('"id":2'); // a pergunta abortada não é respondida
      } finally {
        mcp.kill('SIGKILL');
        for (const f of ['pai.pid', 'neto.pid']) {
          const pid = await pidOf(path.join(outdir, f)).catch(() => 0);
          if (pid) try { process.kill(-pid, 'SIGKILL'); } catch { /* já saiu */ }
        }
      }
    }, 60_000);
  });
});

describe('config codexModel', () => {
  it('padrão vazio; grava e lê; o pedido tira os espaços; vazio volta ao padrão', async () => {
    const file = path.join(root, 'cfg-model.json');
    expect((await readConfig(file)).codexModel).toBe('');
    expect((await updateConfig({ codexModel: ' gpt-6-sol ' }, file)).codexModel).toBe('gpt-6-sol');
    expect((await readConfig(file)).codexModel).toBe('gpt-6-sol');
    expect((await updateConfig({ codexModel: '' }, file)).codexModel).toBe('');
    // Sem o campo no pedido, o que está gravado fica.
    await updateConfig({ codexModel: 'gpt-6-luna' }, file);
    expect((await updateConfig({ codexReview: true }, file)).codexModel).toBe('gpt-6-luna');
  });

  it('valor torto: o pedido é recusado; no arquivo, vira o padrão', async () => {
    expect(ConfigPatch.safeParse({ codexModel: 'gpt 6; rm -rf' }).success).toBe(false);
    expect(ConfigPatch.safeParse({ codexModel: '-m' }).success).toBe(false);
    expect(ConfigPatch.safeParse({ codexModel: 'x'.repeat(101) }).success).toBe(false);
    expect(ConfigPatch.safeParse({ codexModel: 'gpt-6-sol' }).success).toBe(true);
    const file = path.join(root, 'cfg-bad.json');
    await fs.writeFile(file, JSON.stringify({ codexModel: 'gpt 6; rm -rf', codexReview: true }));
    expect(await readConfig(file)).toMatchObject({ codexModel: '', codexReview: true });
  });
});
