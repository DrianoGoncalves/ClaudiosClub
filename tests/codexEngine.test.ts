import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatEvent, ChatItem, StaffProfile } from '../shared/model';
import { contextWindowFor, costOf } from '../server/adapters/claude/pricing';
import { buildCodexArgs, codexDenyPaths, codexModelOrNull, codexProfileArgs, codexProfileError, codexSafetyArgs, sandboxFor, sandboxOfAutonomy, tomlString } from '../server/chat/codexArgs';
import { isModelUnavailable, itemFromCodex, parseCodexFailure, unwrapShell } from '../server/chat/codexEvents';
import { CodexProcess, readCodexThread } from '../server/chat/codexProcess';
import { ChatManager } from '../server/chat/manager';
import { ChatProcess } from '../server/chat/process';
import { renderFicha, type FichaContext } from '../server/staff/ficha';

// Motor Codex: montagem dos argumentos, conversão dos eventos do `codex exec --json` em itens, o processo (com `codex` falso) e a escolha
// entre Claude e Codex no manager. As fixtures de tests/fixtures/codex/ são saídas reais do Codex CLI 0.156.1 (falha-modelo,
// comando-ls, edita-e-falha), menos esquema-mcp-busca-plano, que foi montado à mão a partir do esquema do SDK do Codex (mcp_tool_call,
// web_search, todo_list e reasoning não foram observados).

const fixture = async (name: string) =>
  (await fs.readFile(path.join(process.cwd(), 'tests', 'fixtures', 'codex', `${name}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

const tick = () => new Promise((r) => setTimeout(r, 15));

/** Cada `spawn` devolve um processo falso novo (uma execução do Codex): `emit` simula o stdout, `close` o fim. */
function fakeCodex() {
  const runs: Array<{
    cmd: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    prompt: () => string;
    emit: (ev: object) => void;
    stderr: (text: string) => void;
    close: (code?: number | null) => void;
    child: EventEmitter;
  }> = [];
  const spawnImpl = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 4242 + runs.length });
    let prompt = '';
    stdin.on('data', (d: Buffer) => (prompt += d.toString()));
    runs.push({
      cmd,
      args,
      cwd: opts.cwd,
      env: opts.env,
      prompt: () => prompt,
      emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n'),
      stderr: (t) => void stderr.write(t),
      close: (code = 0) => void child.emit('close', code),
      child,
    });
    return child as never;
  };
  return { runs, spawnImpl, last: () => runs[runs.length - 1]! };
}

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codex-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const optionOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const configs = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []));
const configOf = (args: string[], key: string) => configs(args).find((c) => c.startsWith(`${key}=`))?.slice(key.length + 1);
/** Sandbox de onde o perfil parte (`:workspace` ou `:read-only`) e o mapa de arquivos dele. */
const baseOf = (args: string[]) => configOf(args, 'permissions.mycodeny.extends');
const filesOf = (args: string[]) => configOf(args, 'permissions.mycodeny.filesystem');
/** O perfil substitui o `-s`: nenhum dos dois jeitos antigos de escolher sandbox pode aparecer junto. */
const noLegacySandbox = (args: string[]) => {
  expect(args).not.toContain('-s');
  expect(args).not.toContain('--sandbox');
  expect(configs(args).some((c) => c.startsWith('sandbox_mode') || c.startsWith('sandbox_workspace_write'))).toBe(false);
};

describe('Codex: argumentos', () => {
  // Uma pasta pessoal que não existe: o resultado não depende de a máquina ter ~/.ssh.
  const base = { cwd: '/proj', sandbox: 'read-only' as const, secrets: { projectPath: '/proj', home: '/nao-existe' } };

  it('primeira mensagem: exec --json com pasta, perfil de permissões, modelo, esforço e o prompt pelo stdin', () => {
    const args = buildCodexArgs({ ...base, model: 'gpt-6-sol', effort: 'high', instructions: 'Você é a Bia.' });
    expect(args.slice(0, 5)).toEqual(['exec', '--json', '--skip-git-repo-check', '-C', '/proj']);
    expect(args).toContain('--ignore-user-config');
    expect(optionOf(args, '-C')).toBe('/proj');
    noLegacySandbox(args);
    expect(configOf(args, 'default_permissions')).toBe('"mycodeny"');
    expect(baseOf(args)).toBe('":read-only"');
    expect(optionOf(args, '-m')).toBe('gpt-6-sol');
    expect(configs(args)).toContain('model_reasoning_effort="high"');
    expect(configs(args)).toContain('developer_instructions="Você é a Bia."');
    expect(configs(args)).toContain('approval_policy="never"');
    // Sem os conectores da conta do ChatGPT (rodam fora da sandbox).
    expect(configs(args)).toContain('features.apps=false');
    expect(args.at(-1)).toBe('-'); // prompt pelo stdin
    expect(args).not.toContain('resume');
  });

  it('sem modelo nem esforço, não manda -m nem model_reasoning_effort (vale o padrão do Codex)', () => {
    const args = buildCodexArgs(base);
    expect(args).not.toContain('-m');
    expect(configs(args).some((c) => c.startsWith('model_reasoning_effort'))).toBe(false);
    expect(configs(args).some((c) => c.startsWith('developer_instructions'))).toBe(false);
  });

  it('as seguintes: exec resume <thread_id>, sem -C; o perfil de permissões é o mesmo da primeira execução', () => {
    const id = '01a1babd-2221-7471-bc6f-23be3a417793';
    const args = buildCodexArgs({ ...base, sandbox: 'workspace', model: 'gpt-6-luna', threadId: id });
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(args).not.toContain('-C');
    noLegacySandbox(args);
    expect(baseOf(args)).toBe('":workspace"');
    const first = buildCodexArgs({ ...base, sandbox: 'workspace', model: 'gpt-6-luna' });
    expect(configs(args)).toContain('features.apps=false'); // também no resume
    for (const key of ['default_permissions', 'permissions.mycodeny.extends', 'permissions.mycodeny.filesystem', 'permissions.mycodeny.network']) {
      expect(configOf(args, key)).toBe(configOf(first, key));
    }
    expect(args).toContain('network_proxy');
    expect(optionOf(args, '-m')).toBe('gpt-6-luna');
    // O id fica logo antes do prompt (`-`).
    expect(args.slice(-2)).toEqual([id, '-']);
  });

  it('autonomia → perfil: plan e manual partem de :read-only; acceptEdits, auto e sem travas, de :workspace; nunca danger-full-access', () => {
    expect(sandboxOfAutonomy('plan')).toBe('read-only');
    expect(sandboxOfAutonomy('manual')).toBe('read-only');
    expect(sandboxOfAutonomy('acceptEdits')).toBe('workspace');
    expect(sandboxOfAutonomy('auto')).toBe('workspace');
    expect(sandboxOfAutonomy('bypassPermissions')).toBe('workspace');
    // Os modos que o processo aberto reporta (`default` = manual) e um que não existe.
    expect(sandboxFor('default')).toBe('read-only');
    expect(sandboxFor(null)).toBe('read-only');
    expect(sandboxFor('algo-novo')).toBe('read-only');
    for (const mode of ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions', null, 'x']) {
      for (const threadId of [null, 'abcdef12-3456']) {
        const args = buildCodexArgs({ ...base, sandbox: sandboxFor(mode), threadId });
        expect(args.join(' ')).not.toMatch(/danger|bypass/i);
        noLegacySandbox(args);
        expect(baseOf(args)).toBe(sandboxFor(mode) === 'workspace' ? '":workspace"' : '":read-only"');
      }
    }
  });

  it('pastas extras de escrita entram no perfil como "write" só na sandbox de escrita; a de leitura não ganha nenhuma', () => {
    const write = buildCodexArgs({ ...base, sandbox: 'workspace', writableRoots: ['/proj/.myco/staff', 'C:\\x y'] });
    expect(filesOf(write)).toBe('{"/proj/.myco/staff"="write","C:\\\\x y"="write"}');
    const read = buildCodexArgs({ ...base, writableRoots: ['/proj/.myco/staff'] });
    expect(filesOf(read)).toBe('{}');
  });

  it('rede: só a própria máquina (127.0.0.1 e localhost) pelo proxy do Codex, igual em qualquer autonomia', () => {
    for (const sandbox of ['read-only', 'workspace'] as const) {
      const args = buildCodexArgs({ ...base, sandbox });
      // Sem o recurso network_proxy a lista de domínios não vale e `enabled=true` liberaria a rede inteira.
      expect(args.slice(args.indexOf('--enable'), args.indexOf('--enable') + 2)).toEqual(['--enable', 'network_proxy']);
      expect(configOf(args, 'permissions.mycodeny.network')).toBe('{enabled=true,domains={"127.0.0.1"="allow","localhost"="allow"}}');
      expect(args.join(' ')).not.toMatch(/network_access|"\*"/);
    }
  });

  it('o texto vai como string do TOML: aspas, barras, quebras de linha e acentos sobrevivem', () => {
    expect(tomlString('a "b" \\ c\nd\té ✓')).toBe('"a \\"b\\" \\\\ c\\nd\\té ✓"');
    expect(tomlString('x\u007fy')).toBe('"x\\u007fy"');
    expect(tomlString('metade \ud83d')).toBe('"metade \ufffd"');
    const args = buildCodexArgs({ ...base, instructions: 'linha 1\nlinha "2"' });
    expect(configs(args)).toContain('developer_instructions="linha 1\\nlinha \\"2\\""');
  });

  it('segredos: ~/.ssh, o cofre e o .vps (da pasta e do projeto) entram como "deny" com caminho exato, só pastas e só o que existe', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-deny-'));
    const home = path.join(dir, 'home');
    const proj = path.join(dir, 'proj');
    const wt = path.join(dir, 'wt');
    const mycoHome = path.join(home, '.myco');
    const vault = path.join(mycoHome, 'secrets');
    for (const d of [path.join(home, '.ssh'), vault, path.join(proj, '.vps'), wt]) await fs.mkdir(d, { recursive: true });
    const ctx = { cwd: wt, projectPath: proj, home, mycoHome };

    // Numa worktree o .vps do projeto é outro caminho que o da pasta da conversa; a worktree não tem `.vps` (não existe: nada a negar).
    const args = codexProfileArgs({ ...ctx, mode: 'workspace', network: 'loopback', writableRoots: [path.join(proj, '.myco', 'staff')] });
    expect(args).toEqual([
      '-c', 'default_permissions="mycodeny"',
      '-c', 'permissions.mycodeny.extends=":workspace"',
      '-c', `permissions.mycodeny.filesystem={"~/.ssh"="deny",${tomlString(vault)}="deny",${tomlString(path.join(proj, '.vps'))}="deny",${tomlString(path.join(proj, '.myco', 'staff'))}="write"}`,
      '-c', 'permissions.mycodeny.network={enabled=true,domains={"127.0.0.1"="allow","localhost"="allow"}}',
      '--enable', 'network_proxy',
    ]);
    // No modo de leitura é o mesmo bloqueio, partindo de :read-only e sem a escrita extra.
    const ro = codexProfileArgs({ ...ctx, mode: 'read-only', network: 'loopback', writableRoots: [path.join(proj, '.myco', 'staff')] });
    expect(ro[3]).toBe('permissions.mycodeny.extends=":read-only"');
    expect(ro[5]).not.toContain('"write"');
    expect(codexDenyPaths(ctx)).toEqual(['~/.ssh', vault, path.join(proj, '.vps')]);

    // Negar caminho que não existe faz o Codex criar um arquivo vazio no lugar (um `.vps` vazio atrapalharia a pasta `.vps`): fica de fora.
    const nada = { home: path.join(dir, 'sem-home'), mycoHome: path.join(dir, 'sem-myco') };
    expect(codexDenyPaths({ cwd: wt, projectPath: wt, ...nada })).toEqual([]);
    expect(filesOf(buildCodexArgs({ cwd: wt, sandbox: 'workspace', secrets: { projectPath: wt, ...nada } }))).toBe('{}');
    // Pasta da conversa = projeto: um .vps só.
    expect(codexDenyPaths({ cwd: proj, projectPath: proj, ...nada })).toEqual([path.join(proj, '.vps')]);
    // O buildCodexArgs leva o contexto até o bloqueio.
    expect(filesOf(buildCodexArgs({ cwd: wt, sandbox: 'workspace', secrets: { projectPath: proj, ...nada } }))).toBe(`{${tomlString(path.join(proj, '.vps'))}="deny"}`);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('segredos: se o .vps for um arquivo, só um arquivo regular é negado por execução (limite do bwrap); pastas não têm limite', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-deny1-'));
    const home = path.join(dir, 'home');
    const proj = path.join(dir, 'proj');
    const wt = path.join(dir, 'wt');
    await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
    await fs.mkdir(proj, { recursive: true });
    await fs.mkdir(wt, { recursive: true });
    await fs.writeFile(path.join(proj, '.vps'), 'x');
    await fs.writeFile(path.join(wt, '.vps'), 'x');
    // Os dois `.vps` são arquivos: entra o da pasta da conversa; o segundo quebraria a execução ("Bad file descriptor").
    expect(codexDenyPaths({ cwd: wt, projectPath: proj, home, mycoHome: path.join(dir, 'sem-myco') })).toEqual(['~/.ssh', path.join(wt, '.vps')]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('codexSafetyArgs: a segurança de toda execução do Codex, sem depender de ficha; as ferramentas de leitura usam a mesma', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-safe-'));
    const home = path.join(dir, 'home');
    const proj = path.join(dir, 'proj');
    await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
    await fs.mkdir(path.join(proj, '.vps'), { recursive: true });
    const base = { cwd: proj, projectPath: proj, home, mycoHome: path.join(home, '.myco') };

    // "Perguntar ao GPT": só leitura e sem rede.
    const ask = codexSafetyArgs({ ...base, mode: 'read-only', network: 'off' });
    expect(ask).toEqual([
      '--ignore-user-config',
      '-c', 'features.apps=false',
      '-c', 'approval_policy="never"',
      '-c', 'default_permissions="mycodeny"',
      '-c', 'permissions.mycodeny.extends=":read-only"',
      '-c', `permissions.mycodeny.filesystem={"~/.ssh"="deny",${tomlString(path.join(proj, '.vps'))}="deny"}`,
      '-c', 'permissions.mycodeny.network={enabled=false}',
    ]);
    expect(ask).not.toContain('--enable'); // sem rede, sem o proxy

    // Escrita na pasta e só a rede local.
    const work = codexSafetyArgs({ ...base, mode: 'workspace', network: 'loopback' });
    expect(work.slice(0, 6)).toEqual(ask.slice(0, 6));
    expect(configOf(work, 'permissions.mycodeny.extends')).toBe('":workspace"');
    expect(configOf(work, 'permissions.mycodeny.network')).toBe('{enabled=true,domains={"127.0.0.1"="allow","localhost"="allow"}}');
    expect(work.slice(-2)).toEqual(['--enable', 'network_proxy']);

    // Nunca o -s, nunca danger-full-access, nunca --dangerously-*, e é a mesma que o motor usa (buildCodexArgs só acrescenta o que é dele).
    for (const args of [ask, work]) {
      noLegacySandbox(args);
      expect(args.join(' ')).not.toMatch(/danger|bypass/i);
    }
    const motor = buildCodexArgs({ cwd: proj, sandbox: 'workspace', model: 'gpt-6-sol', secrets: { projectPath: proj, home } });
    expect(motor.join('\u0000')).toContain(work.join('\u0000'));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('servidores na ficha não combinam com o Codex (sem rede para eles, e o bwrap só nega um arquivo de chave); ultra só no Codex', () => {
    const erro = 'Quem tem servidores na ficha não pode rodar no Codex: tire os servidores ou use o Claude';
    expect(codexProfileError({ engine: 'codex', servers: ['vps1'] })).toBe(erro);
    expect(codexProfileError({ engine: 'codex', servers: [] })).toBeNull();
    // No Claude servidores seguem como sempre.
    expect(codexProfileError({ servers: ['vps1'] })).toBeNull();
    expect(codexProfileError({ engine: 'claude', servers: ['vps1'], effort: 'max' })).toBeNull();
    expect(codexProfileError({ engine: 'codex', servers: [], effort: 'ultra' })).toBeNull();
    expect(codexProfileError({ engine: 'claude', servers: [], effort: 'ultra' })).toBe('O esforço ultra só existe no Codex');
    expect(codexProfileError({ servers: [], effort: 'ultra' })).toBe('O esforço ultra só existe no Codex');
  });

  it('modelo do Claude numa ficha que trocou de motor não vai para o Codex', () => {
    expect(codexModelOrNull('opus')).toBeNull();
    expect(codexModelOrNull('claude-sonnet-5-5')).toBeNull();
    expect(codexModelOrNull('sonnet[1m]')).toBeNull();
    expect(codexModelOrNull('gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(codexModelOrNull(null)).toBeNull();
  });

  it('preço e janela de contexto: modelo gpt sem preço conhecido (nada inventado) e janela de 272k', () => {
    expect(costOf('gpt-6-sol', { input_tokens: 1000, output_tokens: 1000 })).toBeNull();
    expect(contextWindowFor('gpt-6-sol')).toBe(272_000);
    expect(contextWindowFor('claude-opus-5-5')).toBe(1_000_000);
  });
});

describe('Codex: eventos → itens', () => {
  it('unwrapShell tira o invólucro do bash e deixa o resto como veio', () => {
    expect(unwrapShell('/usr/bin/bash -lc ls')).toBe('ls');
    expect(unwrapShell("/usr/bin/bash -lc 'cat nao-existe.txt'")).toBe('cat nao-existe.txt');
    expect(unwrapShell("/bin/bash -lc 'echo '\\''oi'\\'''")).toBe("echo 'oi'");
    expect(unwrapShell('bash -lc "echo \\"oi\\""')).toBe('echo "oi"');
    expect(unwrapShell('git status')).toBe('git status');
    expect(unwrapShell('powershell.exe -Command "dir"')).toBe('powershell.exe -Command "dir"');
  });

  it('agent_message vira resposta; reasoning e tipos desconhecidos não aparecem', () => {
    const at = '2026-01-01T00:00:00.000Z';
    expect(itemFromCodex({ id: 'item_1', type: 'agent_message', text: 'Oi' }, 'k', at, 'completed')).toEqual({ kind: 'assistant', id: 'a:k:item_1', text: 'Oi', at });
    expect(itemFromCodex({ id: 'item_1', type: 'agent_message', text: '  ' }, 'k', at, 'completed')).toBeNull();
    expect(itemFromCodex({ id: 'item_0', type: 'reasoning', text: 'penso' }, 'k', at, 'completed')).toBeNull();
    expect(itemFromCodex({ id: 'item_0', type: 'coisa_nova' }, 'k', at, 'completed')).toBeNull();
    expect(itemFromCodex('lixo', 'k', at, 'completed')).toBeNull();
  });

  it('comando: cartão Bash, em andamento sem resultado e depois com a saída; saída com erro marca isError', async () => {
    const [, , start, done] = await fixture('comando-ls');
    const at = 'x';
    const running = itemFromCodex(start!.item, 'k', at, 'started')!;
    expect(running).toMatchObject({ kind: 'tool', id: 't:k:item_0', name: 'Bash', summary: 'ls', result: null, isError: false });
    expect(JSON.parse((running as Extract<ChatItem, { kind: 'tool' }>).input)).toEqual({ command: 'ls' });
    expect(itemFromCodex(done!.item, 'k', at, 'completed')).toMatchObject({ result: 'nota.txt', isError: false });
    const failed = itemFromCodex({ id: 'item_3', type: 'command_execution', command: "/usr/bin/bash -lc 'cat nao-existe.txt'", aggregated_output: '', exit_code: 1, status: 'failed' }, 'k', at, 'completed');
    expect(failed).toMatchObject({ summary: 'cat nao-existe.txt', result: '[código de saída 1]', isError: true });
    expect(itemFromCodex({ id: 'i', type: 'command_execution', command: 'rm x', aggregated_output: '', exit_code: null, status: 'declined' }, 'k', at, 'completed')).toMatchObject({
      isError: true,
      result: '[recusado pela sandbox]',
    });
  });

  it('edição vira Edit (resumo dos arquivos); MCP vira mcp__servidor__ferramenta; busca e lista de tarefas viram cartões', async () => {
    const at = 'x';
    const edit = itemFromCodex({ id: 'item_2', type: 'file_change', changes: [{ path: '/tmp/projeto/novo.txt', kind: 'add' }], status: 'completed' }, 'k', at, 'completed')!;
    expect(edit).toMatchObject({ kind: 'tool', name: 'Edit', summary: 'add novo.txt', result: '1 arquivo alterado', isError: false });
    const many = itemFromCodex({ id: 'i', type: 'file_change', changes: [{ path: '/p/a.ts', kind: 'update' }, { path: '/p/b.ts', kind: 'delete' }], status: 'completed' }, 'k', at, 'completed');
    expect(many).toMatchObject({ summary: '2 arquivos: a.ts, b.ts', result: '2 arquivos alterados' });
    const events = await fixture('esquema-mcp-busca-plano');
    const byId = (id: string, phase: 'completed' | 'started') => events.find((e) => e.type === `item.${phase}` && (e.item as { id: string }).id === id)!.item;
    expect(itemFromCodex(byId('item_3', 'completed'), 'k', at, 'completed')).toMatchObject({ name: 'mcp__docs__buscar', result: '3 resultados', isError: false });
    expect(itemFromCodex(byId('item_3', 'started'), 'k', at, 'started')).toMatchObject({ result: null });
    expect(itemFromCodex(byId('item_4', 'completed'), 'k', at, 'completed')).toMatchObject({ name: 'mcp__docs__abrir', result: 'não encontrado', isError: true });
    expect(itemFromCodex(byId('item_2', 'completed'), 'k', at, 'completed')).toMatchObject({ name: 'WebSearch', summary: 'codex exec json', result: '' });
    expect(itemFromCodex(byId('item_1', 'started'), 'k', at, 'started')).toMatchObject({ name: 'TodoWrite', summary: '0/2 concluídos', result: null });
  });

  it('item de erro é aviso (não encerra o turno)', async () => {
    const [, err] = await fixture('falha-modelo');
    expect(itemFromCodex(err!.item, 'k', 'x', 'completed')).toMatchObject({ kind: 'notice', tone: 'warn', text: expect.stringContaining('Model metadata for `gpt-6.1-sol` not found') });
  });

  it('turn.failed: a mensagem sai do JSON; limite de uso é reconhecido e avisa em português', () => {
    expect(parseCodexFailure('{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"modelo não suportado","code":"model_not_found"}}')).toEqual({
      text: 'modelo não suportado',
      limit: false,
    });
    expect(parseCodexFailure('queda de rede')).toEqual({ text: 'queda de rede', limit: false });
    expect(parseCodexFailure('').text).toBe('O turno terminou com erro.');
    const hit = parseCodexFailure('{"type":"error","status":429,"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_in_seconds":13200}}');
    expect(hit.limit).toBe(true);
    expect(hit.text).toMatch(/^Limite de uso do Codex atingido \(volta em 3 h 40 min\): The usage limit has been reached\./);
    expect(parseCodexFailure("You've hit your usage limit. Try again later.").limit).toBe(true);
    // Estouro da janela de contexto da conversa não é o limite de uso.
    expect(parseCodexFailure('context_length_exceeded: input too long').limit).toBe(false);
  });
});

describe('CodexProcess', () => {
  const profile = { cwd: '/proj', sessionId: 'sess-1', permissionMode: 'default', secrets: { projectPath: '/proj', home: '/nao-existe' } };

  it('cada mensagem é uma execução: exec na primeira e exec resume <thread_id> nas seguintes; os itens vêm dos eventos', async () => {
    const f = fakeCodex();
    const threadFile = path.join(root, 'sess-1', 'codex-thread.json');
    const idle: string[] = [];
    const chat = new CodexProcess({ ...profile, model: 'gpt-6-sol', effort: 'medium', instructions: 'Ficha da Bia', threadFile, spawnImpl: f.spawnImpl, onIdle: (r) => idle.push(r) });
    const events: ChatEvent[] = [];
    chat.start();
    chat.subscribe((e) => events.push(e));
    expect(chat.engine).toBe('codex');
    expect(chat.running).toBe(true);
    expect(f.runs).toHaveLength(0); // sem processo até a primeira mensagem
    expect(chat.snapshot().state).toMatchObject({ running: true, busy: false, model: 'gpt-6-sol', effort: 'medium', permissionMode: 'default' });

    chat.send('liste os arquivos', 'next', [], '[MyCo] aviso da ficha');
    expect(chat.snapshot().state.busy).toBe(true);
    const r1 = f.last();
    expect(r1.cmd).toBe('codex');
    expect(r1.cwd).toBe('/proj');
    expect(r1.args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(baseOf(r1.args)).toBe('":read-only"');
    noLegacySandbox(r1.args);
    expect(configs(r1.args)).toContain('developer_instructions="Ficha da Bia"');
    await tick();
    // O prompt vai pelo stdin: o aviso do Claudio’s Club e a sua mensagem.
    expect(r1.prompt()).toBe('[MyCo] aviso da ficha\n\nliste os arquivos');
    expect(chat.pid).toBe(4242);

    for (const ev of await fixture('comando-ls')) r1.emit(ev);
    await tick();
    expect(idle).toEqual(['turn']); // o fim do turno vem do turn.completed, antes de o processo sair
    r1.close(0);
    await tick();
    expect(chat.pid).toBeNull();

    const { items, state } = chat.snapshot();
    expect(items.map((i) => i.kind)).toEqual(['user', 'tool', 'assistant']);
    expect(items[0]).toMatchObject({ kind: 'user', text: 'liste os arquivos' });
    expect(items[1]).toMatchObject({ kind: 'tool', name: 'Bash', summary: 'ls', result: 'nota.txt', isError: false });
    expect(items[2]).toMatchObject({ kind: 'assistant', text: 'Existe apenas o arquivo `nota.txt`.' });
    expect(state.busy).toBe(false);
    // Contexto estimado: o usage soma as duas chamadas ao modelo do turno (27.999 de entrada): 27.999 / (1 ferramenta + 1) ≈ 14.000.
    expect(state.context).toEqual({ used: 14_000, window: 272_000, percent: 5 });
    expect(chat.threadId).toBe('01a1babd-2221-7471-bc6f-23be3a417793');
    expect(chat.lastAssistantText()).toBe('Existe apenas o arquivo `nota.txt`.');
    // O thread_id fica gravado para retomar depois que o processo fechar.
    expect(await readCodexThread(threadFile)).toBe('01a1babd-2221-7471-bc6f-23be3a417793');

    // Segunda mensagem: resume, sem -C nem -s, e os ids dos itens da execução nova (item_0 de novo) não se misturam com os da primeira.
    chat.send('e agora?');
    const r2 = f.last();
    expect(r2.args.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(r2.args.slice(-2)).toEqual(['01a1babd-2221-7471-bc6f-23be3a417793', '-']);
    expect(baseOf(r2.args)).toBe('":read-only"');
    noLegacySandbox(r2.args);
    r2.emit({ type: 'thread.started', thread_id: '01a1babd-2221-7471-bc6f-23be3a417793' });
    r2.emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Segunda resposta' } });
    r2.emit({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 5 } });
    await tick();
    r2.close(0);
    await tick();
    const ids = chat.snapshot().items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(chat.lastAssistantText()).toBe('Segunda resposta');
    expect(idle).toEqual(['turn', 'turn']);
    expect(events.some((e) => e.type === 'item')).toBe(true);
  });

  it('ambiente: MYCO_SESSION_ID vai; variáveis CLAUDE*/ANTHROPIC* não', async () => {
    const f = fakeCodex();
    const saved = { a: process.env.ANTHROPIC_API_KEY, c: process.env.CLAUDE_CODE_ENTRYPOINT };
    process.env.ANTHROPIC_API_KEY = 'nao-deve-ir';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'x';
    try {
      const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl });
      chat.start();
      chat.send('oi');
      expect(f.last().env.MYCO_SESSION_ID).toBe('sess-1');
      expect(f.last().env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(f.last().env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    } finally {
      if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.a;
      if (saved.c === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
      else process.env.CLAUDE_CODE_ENTRYPOINT = saved.c;
    }
  });

  it('reabrir com o thread_id gravado: a primeira mensagem já é um resume; id inválido não vira argumento', async () => {
    const f = fakeCodex();
    const chat = new CodexProcess({ ...profile, threadId: '01a1babd-2221-7471-bc6f-23be3a417793', spawnImpl: f.spawnImpl });
    chat.start();
    chat.send('oi de novo');
    expect(f.last().args.slice(0, 2)).toEqual(['exec', 'resume']);
    const bad = new CodexProcess({ ...profile, threadId: '--dangerously-bypass-approvals-and-sandbox', spawnImpl: f.spawnImpl });
    bad.start();
    bad.send('oi');
    expect(f.last().args).not.toContain('resume');
    expect(f.last().args.join(' ')).not.toMatch(/dangerously/);
  });

  it('falha de modelo (fixture real): aviso do item de erro + um erro da conversa só, e o turno termina', async () => {
    const f = fakeCodex();
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl });
    chat.start();
    chat.send('oi');
    for (const ev of await fixture('falha-modelo')) f.last().emit(ev);
    await tick();
    f.last().close(1); // o codex sai com 1 depois do turn.failed
    await tick();
    const notices = chat.snapshot().items.filter((i): i is Extract<ChatItem, { kind: 'notice' }> => i.kind === 'notice');
    expect(notices.map((n) => n.tone)).toEqual(['warn', 'error']);
    expect(notices[1]!.text).toBe("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.");
    expect(chat.snapshot().state.busy).toBe(false);
  });

  it('limite de uso do Codex: erro da conversa, e o Claudio’s Club não agenda "continue" sozinho', async () => {
    const f = fakeCodex();
    let limit = 0;
    const idle: string[] = [];
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl, onUsageLimit: () => limit++, onIdle: (r) => idle.push(r) });
    chat.start();
    chat.send('oi');
    const msg = '{"type":"error","status":429,"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":7200}}';
    f.last().emit({ type: 'turn.started' });
    f.last().emit({ type: 'error', message: msg });
    f.last().emit({ type: 'turn.failed', error: { message: msg } });
    await tick();
    f.last().close(1);
    await tick();
    const last = chat.snapshot().items.at(-1)!;
    expect(last).toMatchObject({ kind: 'notice', tone: 'error', text: expect.stringContaining('Limite de uso do Codex atingido (volta em 2 h)') });
    expect(limit).toBe(0);
    expect(idle).toEqual(['turn']);
  });

  it('o processo sai com erro sem nenhum evento: o stderr vira o erro da conversa; sem erro nem resposta, também avisa', async () => {
    const f = fakeCodex();
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl });
    chat.start();
    chat.send('oi');
    f.last().stderr('Error: thread/resume failed: no rollout found for thread id x');
    await tick();
    f.last().close(1);
    await tick();
    expect(chat.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', tone: 'error', text: 'Error: thread/resume failed: no rollout found for thread id x' });
    expect(chat.snapshot().state.busy).toBe(false);
    chat.send('outra');
    f.last().close(0);
    await tick();
    expect(chat.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', tone: 'error', text: 'O Codex terminou sem responder.' });
    expect(chat.running).toBe(true); // a conversa segue aberta: a próxima mensagem abre outra execução
  });

  it('interromper mata a execução: "Turno interrompido", sem erro, e a conversa fica livre', async () => {
    const f = fakeCodex();
    const killed: unknown[] = [];
    const idle: string[] = [];
    const chat = new CodexProcess({
      ...profile,
      spawnImpl: f.spawnImpl,
      onIdle: (r) => idle.push(r),
      kill: (child) => {
        killed.push(child);
        child.emit('close', null);
      },
    });
    chat.start();
    chat.send('uma tarefa longa');
    f.last().emit({ type: 'turn.started' });
    await tick();
    chat.interrupt();
    await tick();
    expect(killed).toHaveLength(1);
    const last = chat.snapshot().items.at(-1)!;
    expect(last).toMatchObject({ kind: 'notice', tone: 'info', text: 'Turno interrompido' });
    expect(chat.snapshot().state.busy).toBe(false);
    expect(idle).toEqual(['turn']);
    // Sem execução, interromper não faz nada.
    chat.interrupt();
    expect(killed).toHaveLength(1);
  });

  it('mensagem com o turno andando espera na fila; "now" interrompe e passa na frente', async () => {
    const f = fakeCodex();
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl, kill: (child) => void child.emit('close', null) });
    chat.start();
    chat.send('primeira');
    chat.send('segunda', 'later');
    expect(f.runs).toHaveLength(1);
    expect(chat.snapshot().items.find((i) => i.kind === 'user' && i.text === 'segunda')).toMatchObject({ queued: 'later' });
    f.runs[0]!.emit({ type: 'thread.started', thread_id: 'abcdef12-3456' });
    f.runs[0]!.emit({ type: 'turn.completed', usage: { input_tokens: 10 } });
    await tick();
    expect(chat.snapshot().state.busy).toBe(true); // a segunda ainda vai rodar: segue ocupado
    f.runs[0]!.close(0);
    await tick();
    expect(f.runs).toHaveLength(2);
    expect(f.runs[1]!.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(f.runs[1]!.prompt()).toBe('segunda');
    // Saiu da fila ao começar.
    expect(chat.snapshot().items.find((i) => i.kind === 'user' && i.text === 'segunda')).not.toHaveProperty('queued');

    chat.send('urgente', 'now');
    await tick();
    expect(f.runs).toHaveLength(3);
    expect(f.runs[2]!.prompt()).toBe('urgente');
    expect(chat.snapshot().items.some((i) => i.kind === 'notice' && i.text === 'Turno interrompido')).toBe(true);
  });

  it('autonomia, modelo e esforço trocados valem na execução seguinte; sem travas continua em workspace-write', async () => {
    const f = fakeCodex();
    const chat = new CodexProcess({ ...profile, model: 'gpt-6-sol', effort: 'low', spawnImpl: f.spawnImpl, writableRoots: ['/proj/.myco/staff'] });
    chat.start();
    chat.setPermissionMode('acceptEdits', 'Autonomia agora: edita sozinho');
    chat.setModel('gpt-6-luna', 'Modelo desta conversa: gpt-6-luna');
    chat.setEffort('xhigh', '');
    expect(chat.permissionMode).toBe('acceptEdits');
    expect(chat.model).toBe('gpt-6-luna');
    chat.send('edita');
    const a = f.last().args;
    expect(baseOf(a)).toBe('":workspace"');
    noLegacySandbox(a);
    expect(optionOf(a, '-m')).toBe('gpt-6-luna');
    expect(configs(a)).toContain('model_reasoning_effort="xhigh"');
    expect(filesOf(a)).toBe('{"/proj/.myco/staff"="write"}');
    expect(chat.snapshot().items.filter((i) => i.kind === 'notice').map((i) => (i as { text: string }).text)).toEqual([
      'Autonomia agora: edita sozinho.',
      'Modelo desta conversa: gpt-6-luna',
    ]);
    f.last().emit({ type: 'thread.started', thread_id: 'abcdef12-3456' });
    f.last().emit({ type: 'turn.completed', usage: {} });
    await tick();
    f.last().close(0);
    await tick();
    chat.setPermissionMode('bypassPermissions', 'Autonomia agora: sem travas');
    chat.send('mais uma');
    noLegacySandbox(f.last().args);
    expect(baseOf(f.last().args)).toBe('":workspace"'); // resume: o mesmo perfil
    expect(f.last().args.join(' ')).not.toMatch(/danger|bypass/i);
    expect((chat.snapshot().items.filter((i) => i.kind === 'notice').at(-1) as { text: string }).text).toMatch(/a escrita fica na pasta de trabalho e sem rede/);
  });

  it('segredos: comando, saída e resposta passam pelo filtro (só o tipo vai para o aviso)', async () => {
    const f = fakeCodex();
    const found: string[] = [];
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl, onSecret: (l) => found.push(l) });
    chat.start();
    chat.send('rode isso');
    const r = f.last();
    r.emit({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: "/usr/bin/bash -lc 'mysql -u root -pSenhaSecreta123 db'", aggregated_output: '', exit_code: null, status: 'in_progress' } });
    r.emit({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'cat .env', aggregated_output: 'DB_PASSWORD=outraSenha456\n', exit_code: 0, status: 'completed' } });
    r.emit({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: `a chave é ghp_${'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6'}` } });
    await tick();
    expect(found).toEqual(['uma senha', 'uma senha', 'um token do GitHub']);
    expect(JSON.stringify(found)).not.toMatch(/SenhaSecreta|outraSenha/);
  });

  it('ponto de corte na resposta: fica guardado e some do texto', async () => {
    const f = fakeCodex();
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl });
    chat.start();
    chat.send('feche o assunto');
    for (const ev of await fixture('esquema-mcp-busca-plano')) f.last().emit(ev);
    await tick();
    expect(chat.checkpoint).toBe(true);
    expect(chat.lastAssistantText()).toBe('Pronto.');
    const tools = chat.snapshot().items.filter((i) => i.kind === 'tool').map((i) => (i as { name: string }).name);
    expect(tools).toEqual(['TodoWrite', 'WebSearch', 'mcp__docs__buscar', 'mcp__docs__abrir']);
    // A lista de tarefas atualizada troca o cartão no mesmo id, em vez de somar outro.
    const todo = chat.snapshot().items.find((i) => i.kind === 'tool' && i.name === 'TodoWrite') as Extract<ChatItem, { kind: 'tool' }>;
    expect(todo).toMatchObject({ summary: '2/2 concluídos', result: '' });
    // 3 ferramentas na execução (busca e as duas chamadas ao MCP): 50.000 / (3 + 1) = 12.500 de contexto.
    expect(chat.snapshot().state.context?.used).toBe(12_500);
  });

  it('recursos do Claude Code que não existem aqui: não quebram a conversa', async () => {
    const f = fakeCodex();
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl });
    chat.start();
    chat.compact();
    expect(chat.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', tone: 'warn' });
    expect(chat.snapshot().state.busy).toBe(false);
    await expect(chat.rewind('uuid', true)).rejects.toThrow();
    await expect(chat.mcpStatus()).resolves.toEqual([]);
    await expect(chat.rename('x')).resolves.toBeUndefined();
  });

  it('fechar a conversa: sem execução, sai na hora; com execução, mata e espera', async () => {
    const f = fakeCodex();
    const exits: Array<[number | null, string | null]> = [];
    const idle: string[] = [];
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl, onExit: (p, e) => exits.push([p, e]), onIdle: (r) => idle.push(r), kill: (child) => void child.emit('close', null) });
    chat.start();
    chat.send('oi');
    await chat.stopAndWait();
    expect(chat.running).toBe(false);
    expect(exits).toEqual([[null, null]]);
    expect(idle).toContain('exit');
    expect(() => chat.send('depois de fechar')).toThrow('a conversa não está aberta');
  });
});

describe('CodexProcess: plano B quando a conta recusa o modelo', () => {
  const profile = { cwd: '/proj', sessionId: 'sess-1', permissionMode: 'default', secrets: { projectPath: '/proj', home: '/nao-existe' } };
  const catalog = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol'].map((slug) => ({ slug }));
  const AVISO = 'O modelo gpt-6.1-sol não está disponível na sua conta; usei gpt-6-sol nesta mensagem. Troque na ficha se quiser.';
  const noticesOf = (chat: CodexProcess) => chat.snapshot().items.filter((i): i is Extract<ChatItem, { kind: 'notice' }> => i.kind === 'notice');
  /** A falha real do dono (fixture): thread.started, aviso, turn.started, error e turn.failed com `model_not_found`. */
  const falha = async (run: { emit: (ev: object) => void; close: (code?: number | null) => void }) => {
    for (const ev of await fixture('falha-modelo')) run.emit(ev);
    await tick();
    run.close(1);
    await tick();
    await tick(); // o plano B espera o catálogo
  };
  const sucesso = async (run: { emit: (ev: object) => void; close: (code?: number | null) => void }, thread: string) => {
    run.emit({ type: 'thread.started', thread_id: thread });
    run.emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Oi!' } });
    run.emit({ type: 'turn.completed', usage: { input_tokens: 10 } });
    await tick();
    run.close(0);
    await tick();
  };

  it('isModelUnavailable reconhece o model_not_found da fixture e só ele', async () => {
    const failed = (await fixture('falha-modelo')).find((e) => e.type === 'turn.failed') as { error: { message: string } };
    expect(isModelUnavailable(failed.error.message)).toBe(true);
    expect(isModelUnavailable('{"error":{"type":"invalid_request_error","code":"model_not_found","message":"x"}}')).toBe(true);
    expect(isModelUnavailable('The model `gpt-9-sol` does not exist or you do not have access to it.')).toBe(true);
    expect(isModelUnavailable("The 'gpt-9' model is not supported when using Codex with a ChatGPT account.")).toBe(true);
    expect(isModelUnavailable('{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}')).toBe(false);
    expect(isModelUnavailable('context_length_exceeded: input too long')).toBe(false);
    expect(isModelUnavailable('queda de rede')).toBe(false);
    expect(isModelUnavailable('')).toBe(false);
  });

  it('primeira mensagem: refaz uma vez com o Sol mais novo do catálogo, avisa, descarta a thread vazia e não mexe no modelo da conversa', async () => {
    const f = fakeCodex();
    const threadFile = path.join(root, 'planb-1', 'codex-thread.json');
    const idle: string[] = [];
    const chat = new CodexProcess({ ...profile, sessionId: 'planb-1', model: 'gpt-6.1-sol', threadFile, models: async () => catalog, spawnImpl: f.spawnImpl, onIdle: (r) => idle.push(r) });
    chat.start();
    chat.send('oi');
    await falha(f.last());
    expect(f.runs).toHaveLength(2);
    const [r1, r2] = f.runs as [(typeof f.runs)[number], (typeof f.runs)[number]];
    expect(optionOf(r1.args, '-m')).toBe('gpt-6.1-sol');
    expect(optionOf(r2.args, '-m')).toBe('gpt-6-sol');
    expect(r2.args).not.toContain('resume'); // a thread que a execução falha abriu estava vazia
    expect(r2.prompt()).toBe('oi'); // o mesmo turno
    expect(noticesOf(chat).filter((n) => n.tone === 'error')).toEqual([]);
    expect(noticesOf(chat).some((n) => n.text === AVISO && n.tone === 'warn')).toBe(true);
    // O turno ainda não acabou: segue ocupado, ninguém foi avisado de que parou.
    expect(chat.snapshot().state.busy).toBe(true);
    expect(idle).toEqual([]);
    expect(await readCodexThread(threadFile)).toBeNull();

    await sucesso(r2, '01a1babe-0000-7000-8000-000000000002');
    expect(idle).toEqual(['turn']);
    expect(chat.lastAssistantText()).toBe('Oi!');
    expect(chat.snapshot().state.model).toBe('gpt-6.1-sol'); // a ficha não muda sozinha
    expect(await readCodexThread(threadFile)).toBe('01a1babe-0000-7000-8000-000000000002');

    // A mensagem seguinte volta a pedir o modelo da ficha (e retoma a thread nova).
    chat.send('de novo');
    expect(optionOf(f.last().args, '-m')).toBe('gpt-6.1-sol');
    expect(f.last().args.slice(-2)).toEqual(['01a1babe-0000-7000-8000-000000000002', '-']);
  });

  it('se foi o resume que falhou, o plano B vale do mesmo jeito, na mesma thread', async () => {
    const f = fakeCodex();
    const chat = new CodexProcess({ ...profile, model: 'gpt-6.1-sol', threadId: '01a1babc-b62c-79a1-baaf-622dd5b1dc25', models: async () => catalog, spawnImpl: f.spawnImpl });
    chat.start();
    chat.send('continua');
    expect(f.last().args.slice(0, 2)).toEqual(['exec', 'resume']);
    await falha(f.last());
    expect(f.runs).toHaveLength(2);
    expect(f.runs[1]!.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(f.runs[1]!.args.slice(-2)).toEqual(['01a1babc-b62c-79a1-baaf-622dd5b1dc25', '-']);
    expect(optionOf(f.runs[1]!.args, '-m')).toBe('gpt-6-sol');
    expect(chat.threadId).toBe('01a1babc-b62c-79a1-baaf-622dd5b1dc25');
    expect(noticesOf(chat).some((n) => n.text === AVISO)).toBe(true);
  });

  it('sem parecido no catálogo (ou sem catálogo), roda sem -m: o padrão do Codex', async () => {
    for (const models of [async () => [{ slug: 'gpt-6-luna' }], undefined]) {
      const f = fakeCodex();
      const chat = new CodexProcess({ ...profile, model: 'gpt-6.1-sol', models, spawnImpl: f.spawnImpl });
      chat.start();
      chat.send('oi');
      await falha(f.last());
      expect(f.runs).toHaveLength(2);
      expect(f.runs[1]!.args).not.toContain('-m');
      expect(noticesOf(chat).some((n) => n.text === 'O modelo gpt-6.1-sol não está disponível na sua conta; usei o padrão do Codex nesta mensagem. Troque na ficha se quiser.')).toBe(true);
    }
  });

  it('uma vez só: se o plano B também falha, vira o erro da conversa e o turno termina', async () => {
    const f = fakeCodex();
    const idle: string[] = [];
    const chat = new CodexProcess({ ...profile, model: 'gpt-6.1-sol', models: async () => catalog, spawnImpl: f.spawnImpl, onIdle: (r) => idle.push(r) });
    chat.start();
    chat.send('oi');
    await falha(f.runs[0] ?? f.last());
    await falha(f.runs[1]!);
    expect(f.runs).toHaveLength(2); // não tenta uma terceira
    const last = chat.snapshot().items.at(-1)!;
    expect(last).toMatchObject({ kind: 'notice', tone: 'error', text: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." });
    expect(chat.snapshot().state.busy).toBe(false);
    expect(idle).toEqual(['turn']);
  });

  it('outra falha (limite de uso) e conversa sem modelo na ficha não entram no plano B', async () => {
    const f = fakeCodex();
    const chat = new CodexProcess({ ...profile, model: 'gpt-6-sol', models: async () => catalog, spawnImpl: f.spawnImpl });
    chat.start();
    chat.send('oi');
    const msg = '{"type":"error","status":429,"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}';
    f.last().emit({ type: 'turn.failed', error: { message: msg } });
    await tick();
    f.last().close(1);
    await tick();
    await tick();
    expect(f.runs).toHaveLength(1);
    expect(chat.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', tone: 'error' });

    // Sem `-m` na linha de comando não há modelo da ficha para trocar: o erro aparece como está.
    const g = fakeCodex();
    const semModelo = new CodexProcess({ ...profile, models: async () => catalog, spawnImpl: g.spawnImpl });
    semModelo.start();
    semModelo.send('oi');
    await falha(g.last());
    expect(g.runs).toHaveLength(1);
    expect(semModelo.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', tone: 'error' });
  });

  it('mensagem que chega enquanto o plano B escolhe o modelo espera a vez (não abre outra execução no meio)', async () => {
    const f = fakeCodex();
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => (release = r));
    const chat = new CodexProcess({ ...profile, model: 'gpt-6.1-sol', models: async () => (await slow, catalog), spawnImpl: f.spawnImpl });
    chat.start();
    chat.send('primeira');
    for (const ev of await fixture('falha-modelo')) f.last().emit(ev);
    await tick();
    f.last().close(1);
    await tick();
    chat.send('segunda');
    expect(f.runs).toHaveLength(1); // o catálogo ainda não veio
    release();
    await tick();
    await tick();
    expect(f.runs).toHaveLength(2);
    expect(f.runs[1]!.prompt()).toBe('primeira'); // o turno refeito vem antes da fila
    await sucesso(f.runs[1]!, '01a1babe-0000-7000-8000-000000000003');
    expect(f.runs).toHaveLength(3);
    expect(f.runs[2]!.prompt()).toBe('segunda');
    expect(optionOf(f.runs[2]!.args, '-m')).toBe('gpt-6.1-sol');
  });
});

describe('ChatManager: Claude ou Codex', () => {
  it('o spawn com engine codex abre um CodexProcess (`codex exec`); sem engine segue no `claude`', async () => {
    const f = fakeCodex();
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnImpl = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
      calls.push({ cmd, args });
      return f.spawnImpl(cmd, args, opts);
    };
    const m = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage-codex.json'),
      listLive: async () => [],
      resolve: async (_p, sessionId, staffId) =>
        staffId === 'cris'
          ? {
              sessionId: sessionId ?? 'codex-1',
              cwd: root,
              args: [],
              engine: 'codex',
              codex: { autonomy: 'acceptEdits', model: 'gpt-6-sol', effort: 'high', instructions: 'Ficha', writableRoots: [], secrets: { projectPath: root, home: path.join(root, 'sem-home'), mycoHome: path.join(root, 'sem-myco') }, threadId: null, threadFile: path.join(root, 'codex-1', 'codex-thread.json') },
            }
          : { sessionId: sessionId ?? 'claude-1', cwd: root, args: ['--session-id', 'claude-1', '--model', 'sonnet'] },
      spawnImpl,
      // Folga de cota ligada: no Claude troca para o Opus; no Codex nunca.
      quotaBoost: async () => ({ until: '2026-12-31T17:00:00.000Z', projected: 45 }),
    });
    const cid = await m.send('p', null, 'cris', 'oi codex');
    await tick();
    expect(cid).toBe('codex-1');
    expect(calls[0]!.cmd).toBe('codex');
    expect(calls[0]!.args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(baseOf(calls[0]!.args)).toBe('":workspace"');
    noLegacySandbox(calls[0]!.args);
    expect(optionOf(calls[0]!.args, '-m')).toBe('gpt-6-sol');
    expect(f.last().prompt()).toBe('oi codex'); // sem aviso de folga de cota nem de ficha
    const snap = await m.snapshot('p', cid);
    expect(snap.live?.state).toMatchObject({ running: true, model: 'gpt-6-sol', effort: 'high', permissionMode: 'acceptEdits' });
    expect(m.has(cid)).toBe(true);
    // A autonomia da ficha muda: vale na próxima execução (a sandbox é por execução).
    m.profileChanged({ autonomy: 'acceptEdits' } as StaffProfile, { autonomy: 'manual', sessions: [{ id: cid }] } as StaffProfile);
    f.last().emit({ type: 'thread.started', thread_id: 'abcdef12-3456' });
    f.last().emit({ type: 'turn.completed', usage: {} });
    await tick();
    f.last().close(0);
    await tick();
    await m.send('p', cid, 'cris', 'de novo');
    expect(optionOf(f.last().args, '-m')).toBe('gpt-6-sol');
    expect(baseOf(f.last().args)).toBe('":read-only"');

    // Termina o turno aberto antes de fechar (fechar com uma execução em andamento encerraria um processo de verdade).
    const reopened = f.last();
    reopened.emit({ type: 'turn.completed', usage: {} });
    await tick();
    reopened.close(0);
    await tick();

    await m.send('p', null, 'bia', 'oi claude');
    await tick();
    expect(calls.at(-1)!.cmd).toBe('claude');
    expect(calls.at(-1)!.args).toContain('--input-format');
    // O `claude` falso sai quando o stdin fecha; o Codex ocioso fecha na hora.
    f.last().child.emit('exit', 0);
    await m.stopAll();
    expect(m.isBusy(cid)).toBe(false);
  });

  it('o esforço ultra do seletor do chat só vale numa conversa do Codex', async () => {
    const f = fakeCodex();
    const m = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage-ultra.json'),
      listLive: async () => [],
      resolve: async (_p, sessionId, staffId) =>
        staffId === 'cris'
          ? {
              sessionId: sessionId ?? 'codex-u',
              cwd: root,
              args: [],
              engine: 'codex',
              codex: { autonomy: 'manual', model: 'gpt-6-sol', effort: 'high', instructions: 'Ficha', writableRoots: [], secrets: { projectPath: root, home: path.join(root, 'sem-home'), mycoHome: path.join(root, 'sem-myco') }, threadId: null, threadFile: path.join(root, 'codex-u', 'codex-thread.json') },
            }
          : { sessionId: sessionId ?? 'claude-u', cwd: root, args: ['--session-id', 'claude-u', '--model', 'sonnet'] },
      spawnImpl: f.spawnImpl,
    });
    const cid = await m.settings('p', null, 'cris', { effort: 'ultra' });
    expect(m.has(cid)).toBe(true);
    expect((await m.snapshot('p', cid)).live?.state.effort).toBe('ultra');
    // Numa conversa do Claude o `ultra` é recusado, antes de qualquer troca.
    await expect(m.settings('p', null, 'bia', { effort: 'ultra' })).rejects.toThrow('O esforço ultra só existe no Codex');
    expect((await m.snapshot('p', 'claude-u')).live?.state.effort ?? null).toBeNull();
    await expect(m.settings('p', 'claude-u', 'bia', { effort: 'max' })).resolves.toBe('claude-u'); // os de sempre seguem
    f.last().child.emit('exit', 0); // o `claude` falso
    await m.stopAll();
  });

  it('ChatProcess (Claude) continua com engine claude', () => {
    expect(new ChatProcess({ sessionId: 's', cwd: root, args: [] }).engine).toBe('claude');
  });
});

describe('ficha de quem roda no Codex', () => {
  const ctx: FichaContext = {
    company: 'Acme',
    projectName: 'site',
    projectPath: '/proj',
    managerNames: ['Ana (diretora)'],
    fichaPath: '.myco/staff/cris.md',
    memoryPath: '.myco/staff/cris.memory.md',
    mycoUrl: 'http://localhost:3777',
    team: [{ id: 'dev-1', name: 'Davi', role: 'Dev', mission: 'Cuida do front. Segue o design.' }],
    servers: [{ name: 'vps1', source: 'vps', protocol: 'ssh', host: 'h', remoteRoot: '/srv', hasKey: true } as never],
  };
  const person: StaffProfile = {
    id: 'cris',
    projectId: 'p',
    name: 'Cris',
    role: 'Dev',
    portrait: null,
    reportsTo: [],
    mission: 'Cuidar do site.',
    firstTask: '',
    autonomy: 'manual',
    agents: ['revisor-extra'],
    skills: ['vps'],
    mcps: null,
    knowledge: [],
    rules: ['Nada de segredos.'],
    doneWhen: 'Testes passando.',
    model: 'gpt-6-sol',
    effort: 'high',
    canHire: true,
    playbook: 'plan-big-execute-small',
    worktree: false,
    servers: ['vps1'],
    browser: true,
    sessions: [],
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };

  it('no Codex a ficha não manda usar Agent, subagents, roteiro de delegação, skills, Chrome nem Monitor; o resto fica', () => {
    // O AGENTS.md (o arquivo de instruções do Codex) é permitido; "agent" sozinho, não.
    const text = renderFicha({ ...person, engine: 'codex' }, ctx).replaceAll('AGENTS.md', 'INSTRUCOES.md');
    for (const banned of [/\bAgent\b/, /agents?\b/i, /subagent/i, /pesquisador|executor|revisor/i, /Chrome/i, /Monitor/, /skills?\b/i, /Claude Code/, /--chrome|tabs_context|javascript_tool/, /ferramenta Agent/, /mcp__/]) {
      expect(text, String(banned)).not.toMatch(banned);
    }
    // O roteiro vira "faça você mesmo" e a equipe segue valendo.
    expect(text).toContain('## Roteiro: Planeja grande, executa pequeno');
    expect(text).toMatch(/faça você mesmo cada papel do roteiro/);
    expect(text).toContain('## Sua equipe');
    expect(text).toContain('O que não tem dono, faça você mesmo.');
    // Missão, regras, definição de pronto, memória, tarefas por curl e despertador ficam.
    expect(text).toContain('## Missão\nCuidar do site.');
    expect(text).toContain('Nada de segredos.');
    expect(text).toContain('## Definição de pronto\nTestes passando.');
    expect(text).toContain('## Memória');
    expect(text).toContain('[MyCo:ponto-de-corte]');
    expect(text).toContain('POST http://localhost:3777/api/projects/p/tasks');
    expect(text).toContain('## Despertador');
    expect(text).toContain('/chat/$MYCO_SESSION_ID/wake');
    expect(text).toContain('rode o comando e espere ele terminar');
    expect(text).toContain('## Subfuncionários');
    expect(text).toContain('faça você mesmo');
    // Autonomia no Codex: sem pedido de aprovação, a sandbox decide.
    expect(text).toContain('Sandbox somente leitura');
    expect(text).not.toContain('Pede aprovação');
    // Servidores: sem rede na sandbox, e nada de MCP de FTP nem ssh_config.
    expect(text).toContain('a sandbox não tem rede');
    expect(text).not.toMatch(/ssh -F|scp -F/);
  });

  it('sem subfuncionários: a ficha do Codex também não cita subagents', () => {
    const text = renderFicha({ ...person, engine: 'codex', canHire: false, playbook: null }, ctx).replaceAll('AGENTS.md', 'INSTRUCOES.md');
    expect(text).toContain('Você não pode contratar subfuncionários. Se precisar de mais gente, peça ao usuário.');
    expect(text).not.toMatch(/subagent|Agent/i);
  });

  it('quem roda no Claude (engine ausente ou claude) continua com a ficha de sempre', () => {
    for (const engine of [undefined, 'claude' as const]) {
      const text = renderFicha({ ...person, ...(engine && { engine }) }, ctx);
      expect(text).toContain('## Agents e skills indicados');
      expect(text).toContain('ferramenta Agent');
      expect(text).toContain('## Navegador');
      expect(text).toContain('Pede aprovação antes de cada edição ou comando.');
      expect(text).toContain('ferramenta Monitor');
      expect(text).toContain('use subagents (ferramenta Agent)');
    }
  });
});
