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

// O que veio do app do Claude para a conversa do MyCo: ajustes na hora, "permitir sempre", anexos,
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
