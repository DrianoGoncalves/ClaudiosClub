import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatItem } from '../shared/model';
import { ChatProcess, rememberRules } from '../server/chat/process';
import { searchFiles } from '../server/fileSearch';
import { TurnWatcher } from '../server/turns';
import { applySuggestion, commandSuggestions, todosFrom, triggerOf } from '../client/src/chat/ChatExtras';

// O que veio do app do Claude para a conversa do Claudio’s Club: ajustes na hora, "permitir sempre", anexos,
// comandos "/", arquivos com "@", lista de tarefas e o aviso "terminou" de turno curto.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-parity-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function fakeClaude() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: 1, kill: () => proc.emit('exit', 0) });
  const written: Array<Record<string, unknown>> = [];
  stdin.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => written.push(JSON.parse(l))));
  let env: NodeJS.ProcessEnv = {};
  const spawnImpl = (_cmd: string, _args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
    env = opts.env;
    return proc as never;
  };
  const emit = (ev: object) => stdout.write(JSON.stringify(ev) + '\n');
  return { written, spawnImpl, emit, env: () => env };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('conversa: ajustes, permitir sempre, anexos e comandos', () => {
  it('troca modelo e esforço na hora, com aviso; liga a lista de tarefas; guarda os comandos', async () => {
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: 's', cwd: '.', args: [], spawnImpl: f.spawnImpl });
    chat.start();
    expect(f.env().CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1');

    chat.setModel('sonnet', 'Modelo desta conversa: sonnet');
    chat.setEffort('high', 'Esforço desta conversa: high');
    await tick();
    const [m, e] = f.written as Array<{ request_id: string; request: unknown }>;
    expect(m!.request).toEqual({ subtype: 'set_model', model: 'sonnet' });
    expect(e!.request).toEqual({ subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } });
    f.emit({ type: 'control_response', response: { subtype: 'success', request_id: m!.request_id, response: { model: 'claude-sonnet-5-5' } } });
    f.emit({ type: 'control_response', response: { subtype: 'success', request_id: e!.request_id } });
    f.emit({ type: 'system', subtype: 'commands_changed', commands: [{ name: 'review', description: 'Revisa o PR' }, { name: 'clear' }] });
    await tick();
    const snap = chat.snapshot();
    expect(snap.state.effort).toBe('high');
    expect(snap.state.commands).toEqual([
      { name: 'review', description: 'Revisa o PR' },
      { name: 'clear', description: '' },
    ]);
    expect(snap.items.filter((i) => i.kind === 'notice').map((i) => (i as { text: string }).text)).toEqual([
      'Modelo desta conversa: sonnet',
      'Esforço desta conversa: high',
    ]);
  });

  it('"permitir sempre" usa as sugestões do Claude Code; no projeto, só regras de ferramenta', async () => {
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: 's', cwd: '.', args: [], spawnImpl: f.spawnImpl });
    chat.start();
    const ask = (id: string, tool: string, permission_suggestions: unknown[]) =>
      f.emit({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, input: { x: 1 }, permission_suggestions } });
    ask('r1', 'Write', [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
    ask('r2', 'Bash', [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }]);
    await tick();
    chat.answer('r1', true, undefined, 'session');
    chat.answer('r2', true, undefined, 'project');
    await tick();
    const resp = f.written.map((w) => (w.response as { response: { updatedPermissions?: unknown } }).response.updatedPermissions);
    expect(resp[0]).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
    expect(resp[1]).toEqual([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }]);
    expect(chat.snapshot().items.find((i) => i.id === 'p:r1')).toMatchObject({ status: 'allowed', remembered: 'session' });
    // Sem sugestão de regra, o projeto libera a ferramenta.
    expect(rememberRules('Write', [{ type: 'setMode', mode: 'acceptEdits' }], 'project')).toEqual([
      { type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'localSettings' },
    ]);
  });

  it('anexos viram blocos de documento (texto como texto, PDF em base64)', async () => {
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: 's', cwd: '.', args: [], spawnImpl: f.spawnImpl });
    chat.start();
    chat.send('leia', 'next', [], undefined, [
      { name: 'nota.txt', mediaType: 'text/plain', data: 'carambola' },
      { name: 'a.pdf', mediaType: 'application/pdf', data: 'JVBERi0=' },
    ]);
    await tick();
    expect((f.written[0] as { message: { content: unknown[] } }).message.content).toEqual([
      { type: 'document', title: 'nota.txt', source: { type: 'text', media_type: 'text/plain', data: 'carambola' } },
      { type: 'document', title: 'a.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
      { type: 'text', text: 'leia' },
    ]);
    expect(chat.snapshot().items[0]).toMatchObject({ kind: 'user', files: ['nota.txt', 'a.pdf'] });
  });

  it('menu de "/" e "@": o que dispara, o que sugere e o que entra na caixa', () => {
    expect(triggerOf('/rev')).toEqual({ kind: 'command', query: 'rev' });
    expect(triggerOf('/review agora')).toBeNull();
    expect(triggerOf('olha o @src/ap')).toEqual({ kind: 'file', query: 'src/ap' });
    expect(triggerOf('email@x')).toBeNull();
    const cmds = [
      { name: 'clear', description: 'Limpa a conversa' },
      { name: 'review', description: 'Revisa o PR' },
      { name: 'code-review', description: 'Revisão de código' },
    ];
    expect(commandSuggestions(cmds, 'rev').map((s) => s.value)).toEqual(['review', 'code-review']);
    expect(applySuggestion('/rev', { kind: 'command', query: 'rev' }, 'review')).toBe('/review ');
    expect(applySuggestion('veja @src/ap', { kind: 'file', query: 'src/ap' }, 'src/app.ts')).toBe('veja @src/app.ts ');
  });

  it('"@": arquivos do projeto pelo git, sem .env nem dependências', async () => {
    const dir = path.join(root, 'proj');
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
    for (const f of ['src/app.ts', 'src/apply.ts', 'README.md', '.env', 'node_modules/x/app.js']) await fs.writeFile(path.join(dir, f), '');
    execFileSync('git', ['-C', dir, 'init', '-q']);
    await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules/\n');
    expect(await searchFiles(dir, 'app')).toEqual(['src/app.ts', 'src/apply.ts']);
    expect(await searchFiles(dir, 'env')).toEqual([]);
  });
});

describe('voltar no tempo, duplicar, renomear, MCPs, parar, buscar e o que mudou', () => {
  it('"voltar até aqui" e os pedidos com resposta; MCPs só com nome e estado (sem a configuração)', async () => {
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: 's', cwd: '.', args: [], spawnImpl: f.spawnImpl });
    chat.start();
    expect(f.env().CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe('1');
    chat.send('mude o arquivo');
    await tick();
    const uuid = (f.written[0] as { uuid: string }).uuid;
    expect(chat.snapshot().items[0]).toMatchObject({ kind: 'user', uuid });

    const answer = (i: number, response: object, subtype = 'success') => {
      const id = (f.written[i] as { request_id: string }).request_id;
      f.emit({ type: 'control_response', response: { subtype, request_id: id, response } });
    };
    const preview = chat.rewind(uuid, true);
    await tick();
    expect(f.written[1]).toMatchObject({ request: { subtype: 'rewind_files', user_message_id: uuid, dry_run: true } });
    answer(1, { canRewind: true, filesChanged: ['a.txt'], insertions: 1, deletions: 1 });
    expect(await preview).toMatchObject({ canRewind: true, filesChanged: ['a.txt'] });

    const mcp = chat.mcpStatus();
    await tick();
    answer(2, { mcpServers: [{ name: 'n8n', status: 'connected', config: { headers: { Authorization: 'Bearer SEGREDO' } } }] });
    expect(await mcp).toEqual([{ name: 'n8n', status: 'connected' }]);

    const stop = chat.stopTask('t1');
    await tick();
    expect(f.written[3]).toMatchObject({ request: { subtype: 'stop_task', task_id: 't1' } });
    answer(3, {}, 'error');
    await expect(stop).rejects.toThrow(/recusou/);
  });

  it('renomear com a conversa fechada grava a mesma linha do /rename; duplicar usa --fork-session', async () => {
    const { ChatManager } = await import('../server/chat/manager');
    const { buildClaudeArgs } = await import('../server/staff/ficha');
    const dir = path.join(root, 'tr', 'proj');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 's1.jsonl'), '{"type":"user","message":{"content":"oi"}}\n');
    const m = new ChatManager({ transcriptsDir: path.join(root, 'tr'), usageFile: path.join(root, 'u.json'), listLive: async () => [], resolve: async () => null });
    await m.rename('proj', 's1', 'Ajustar o login');
    expect((await fs.readFile(path.join(dir, 's1.jsonl'), 'utf8')).trim().split('\n').at(-1)).toBe('{"type":"custom-title","customTitle":"Ajustar o login","sessionId":"s1"}');
    const p = { name: 'Ana', role: 'Dev', autonomy: 'acceptEdits', model: null, effort: null, browser: false, mcps: null, servers: [] } as never;
    const args = buildClaudeArgs(p, { sessionId: 'novo', resume: false, systemPromptFile: 's.md', mcpConfigPath: null, firstPrompt: null, forkFrom: 'velho' });
    expect(args.slice(0, 5)).toEqual(['--resume', 'velho', '--fork-session', '--session-id', 'novo']);
  });

  it('"o que mudou" sem worktree: só os arquivos que ele editou nesta conversa', async () => {
    const { touchedFiles } = await import('../server/chatChanges');
    const { locateCode, readCode } = await import('../server/taskCode');
    const dir = path.join(root, 'repo');
    await fs.mkdir(dir, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a]);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    await fs.writeFile(path.join(dir, 'a.txt'), '1\n');
    await fs.writeFile(path.join(dir, 'b.txt'), '1\n');
    git('add', '.');
    git('commit', '-qm', 'início');
    await fs.writeFile(path.join(dir, 'a.txt'), '2\n'); // ele editou
    await fs.writeFile(path.join(dir, 'b.txt'), '2\n'); // outra pessoa editou
    const tr = path.join(root, 'conversa.jsonl');
    await fs.writeFile(
      tr,
      [
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(dir, 'a.txt') } }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(dir, 'b.txt') } }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'C:/fora/x.txt' } }] } },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
    );
    const touched = await touchedFiles(tr, dir);
    expect(touched).toEqual(['a.txt']);
    const code = await readCode(dir, (await locateCode(dir, null, false))!, null, touched);
    expect(code.files.map((f) => f.path)).toEqual(['a.txt']);
    expect(code.diff).toContain('a.txt');
    expect(code.diff).not.toContain('b.txt');
  });

  it('busca nas conversas: seu texto e o deles, com o trecho e o nome da conversa', async () => {
    const { searchConversations } = await import('../server/chatSearch');
    const file = path.join(root, 'busca.jsonl');
    await fs.writeFile(
      file,
      [
        { type: 'user', timestamp: '2026-10-27T10:00:00Z', message: { content: 'Precisamos trocar o gateway de pagamento' } },
        { type: 'assistant', timestamp: '2026-10-27T10:01:00Z', message: { content: [{ type: 'text', text: 'Troquei o Gateway para o novo.' }] } },
        { type: 'custom-title', customTitle: 'Pagamentos' },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
    );
    const hits = await searchConversations([{ projectId: 'p', staffId: 'ana', staffName: 'Ana', sessionId: 's', file }], 'gateway');
    expect(hits.map((h) => [h.title, h.snippet])).toEqual([
      ['Pagamentos', 'Troquei o Gateway para o novo.'],
      ['Pagamentos', 'Precisamos trocar o gateway de pagamento'],
    ]);
    expect(await searchConversations([], 'ga')).toEqual([]);
  });
});

describe('lista de tarefas do funcionário', () => {
  it('monta a partir de TaskCreate e TaskUpdate', () => {
    const tool = (id: string, name: string, input: object, result: string | null): ChatItem => ({
      kind: 'tool',
      id,
      name,
      summary: '',
      input: JSON.stringify(input, null, 2),
      result,
      isError: false,
      at: null,
    });
    const items = [
      tool('1', 'TaskCreate', { subject: 'Ler o código' }, 'Task #1 created successfully: Ler o código'),
      tool('2', 'TaskCreate', { subject: 'Escrever o teste' }, 'Task #2 created successfully: Escrever o teste'),
      tool('3', 'TaskUpdate', { taskId: '1', status: 'completed' }, 'Updated task #1 status'),
      tool('4', 'TaskUpdate', { taskId: '2', status: 'in_progress' }, 'Updated task #2 status'),
      tool('5', 'TaskCreate', { subject: 'Rodando' }, null), // ainda sem resposta: não entra
    ];
    expect(todosFrom(items)).toEqual([
      { id: '1', subject: 'Ler o código', status: 'completed' },
      { id: '2', subject: 'Escrever o teste', status: 'in_progress' },
    ]);
  });
});

describe('aviso "terminou" de turno curto', () => {
  it('o processo avisa; a leitura das sessões do mesmo turno não repete', async () => {
    let status = 'busy';
    const w = new TurnWatcher(async () => [{ sessionId: 's', pid: 1, status, alive: true } as never], () => 'feito');
    await w.tick(new Date('2026-10-27T10:00:00Z'));
    w.noteDone('s', new Date('2026-10-27T10:00:02Z')); // o processo viu o fim primeiro
    status = 'idle';
    await w.tick(new Date('2026-10-27T10:00:04Z')); // a leitura vê o mesmo fim
    expect(w.since('2026-10-27T09:00:00Z').map((d) => d.at)).toEqual(['2026-10-27T10:00:02.000Z']);
    // Turno curto que a leitura nunca viu trabalhando: só o aviso do processo.
    w.noteDone('s', new Date('2026-10-27T10:05:00Z'));
    expect(w.since('2026-10-27T10:01:00Z')).toHaveLength(1);
  });
});
