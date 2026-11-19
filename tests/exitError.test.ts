import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatItem } from '../shared/model';
import { ChatManager } from '../server/chat/manager';
import { ChatProcess } from '../server/chat/process';
import { CodexProcess } from '../server/chat/codexProcess';

// Saída do processo: fechamento nosso (ociosidade, ficha nova, reinício, Parar) não é erro da conversa; saída inesperada é, com a mensagem real.

const tick = () => new Promise((r) => setTimeout(r, 15));

/** Processo falso do claude: `emit` simula o stdout, `stderr` o stderr; `proc.emit('exit', n)` é a saída. */
function fakeClaude() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 4242 });
  const spawnImpl = () => proc as never;
  return { proc, spawnImpl, emit: (ev: object) => void stdout.write(JSON.stringify(ev) + '\n'), stderr: (t: string) => void stderr.write(t) };
}

function claude() {
  const f = fakeClaude();
  const exits: Array<[number | null, string | null]> = [];
  const chat = new ChatProcess({ sessionId: 's1', cwd: 'C:\\proj', args: [], spawnImpl: f.spawnImpl, onExit: (pid, error) => exits.push([pid, error]) });
  chat.start();
  return { f, chat, exits };
}

describe('ChatProcess: saída do claude', () => {
  it('stop() é intencional: o processo sair com código 1 (o taskkill do Windows) não vira erro', async () => {
    const { f, chat, exits } = claude();
    chat.stop();
    f.proc.emit('exit', 1);
    await tick();
    expect(exits).toEqual([[4242, null]]);
    expect(chat.snapshot().state).toMatchObject({ running: false, error: null });
  });

  it('stop() com turno em andamento (reinício): também sem erro', async () => {
    const { f, chat, exits } = claude();
    chat.send('rode');
    f.emit({ type: 'result', is_error: true, result: 'API Error: 529 sobrecarregado' }); // erro de antes do fechamento
    await tick();
    chat.stop();
    f.proc.emit('exit', 1);
    await tick();
    expect(exits).toEqual([[4242, null]]);
    expect(chat.error).toBeNull();
  });

  it('saída inesperada com código 1 continua sendo erro', async () => {
    const { f, chat, exits } = claude();
    f.proc.emit('exit', 1);
    await tick();
    expect(exits).toEqual([[4242, 'o claude saiu com código 1']]);
    expect(chat.error).toBe('o claude saiu com código 1');
  });

  it('saída com código 0 não é erro', async () => {
    const { f, chat, exits } = claude();
    f.proc.emit('exit', 0);
    await tick();
    expect(exits).toEqual([[4242, null]]);
    expect(chat.error).toBeNull();
  });

  it('o stderr, quando há, é a mensagem', async () => {
    const { f, chat } = claude();
    f.emit({ type: 'result', is_error: true, result: 'erro do stream' });
    f.stderr('falha no stderr\n');
    await tick();
    f.proc.emit('exit', 1);
    await tick();
    expect(chat.error).toBe('falha no stderr');
  });

  it('sem stderr, a mensagem é o último erro do stream (result com is_error)', async () => {
    const { f, chat, exits } = claude();
    chat.send('rode');
    f.emit({ type: 'result', is_error: true, result: 'API Error: 529 sobrecarregado' });
    await tick();
    f.proc.emit('exit', 1);
    await tick();
    expect(chat.error).toBe('API Error: 529 sobrecarregado');
    expect(exits).toEqual([[4242, 'API Error: 529 sobrecarregado']]);
  });

  it('sem stderr, a mensagem de erro sintética do assistente também vale', async () => {
    const { f, chat } = claude();
    f.emit({ type: 'assistant', isApiErrorMessage: true, message: { id: 'm1', model: '<synthetic>', content: [{ type: 'text', text: 'Credit balance is too low' }] } });
    await tick();
    f.proc.emit('exit', 1);
    await tick();
    expect(chat.error).toBe('Credit balance is too low');
  });

  it('erro de um turno que já passou não vale: turno seguinte sem erro e nova mensagem voltam ao texto do código', async () => {
    const { f, chat } = claude();
    chat.send('um');
    f.emit({ type: 'result', is_error: true, result: 'erro antigo' });
    await tick();
    chat.send('dois');
    f.emit({ type: 'result', is_error: false });
    await tick();
    f.proc.emit('exit', 1);
    await tick();
    expect(chat.error).toBe('o claude saiu com código 1');
  });

  it('turno que você interrompeu (Parar) não deixa erro para a saída seguinte', async () => {
    const { f, chat } = claude();
    chat.send('um');
    chat.interrupt();
    f.emit({ type: 'result', is_error: true, subtype: 'error_during_execution', result: 'interrompido' });
    await tick();
    f.proc.emit('exit', 1);
    await tick();
    expect(chat.error).toBe('o claude saiu com código 1');
  });
});

describe('ChatManager: fechamento intencional não entra na caixa', () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-exit-'));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function manager() {
    const procs: Array<ReturnType<typeof fakeClaude>> = [];
    const m = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage.json'),
      listLive: async () => [],
      resolve: async (_p, sid) => ({ sessionId: sid ?? 'sx', cwd: '.', args: [] }),
      spawnImpl: () => {
        const f = fakeClaude();
        procs.push(f);
        return f.proc as never;
      },
    });
    return { m, procs };
  }

  it('stop da conversa com saída em código 1: a caixa fica vazia; a mesma saída sem stop aparece como erro', async () => {
    const { m, procs } = manager();
    await m.send('p', 'sx', 'ana', 'oi');
    m.stop('sx'); // ociosidade, ficha nova e reinício passam por chat.stop()
    procs[0]!.proc.emit('exit', 1);
    await tick();
    expect(m.attention()).toEqual([]);

    await m.send('p', 'sx', 'ana', 'de novo');
    expect(procs).toHaveLength(2);
    procs[1]!.proc.emit('exit', 1);
    await tick();
    expect(m.attention()).toEqual([{ sessionId: 'sx', pending: [], error: 'o claude saiu com código 1' }]);
  });
});

/** Cada `spawn` do Codex devolve um processo falso novo (uma execução): `close` é o fim. */
function fakeCodex() {
  const runs: Array<{ emit: (ev: object) => void; stderr: (t: string) => void; close: (code?: number | null) => void; child: EventEmitter }> = [];
  const spawnImpl = () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr, pid: 5000 + runs.length });
    runs.push({ emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n'), stderr: (t) => void stderr.write(t), close: (code = 0) => void child.emit('close', code), child });
    return child as never;
  };
  return { runs, spawnImpl, last: () => runs[runs.length - 1]! };
}

describe('CodexProcess: saída do codex', () => {
  const profile = { cwd: '/proj', sessionId: 'sess-1', permissionMode: 'default', secrets: { projectPath: '/proj', home: '/nao-existe', mycoHome: '/nao-existe/.myco' } };
  const errorsOf = (chat: CodexProcess) => chat.snapshot().items.filter((i): i is Extract<ChatItem, { kind: 'notice' }> => i.kind === 'notice' && i.tone === 'error');

  it('stop() com execução em andamento: o codex sai com código 1 (taskkill) e não há erro nem aviso', async () => {
    const f = fakeCodex();
    const exits: Array<[number | null, string | null]> = [];
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl, onExit: (p, e) => exits.push([p, e]), kill: (child) => void child.emit('close', 1) });
    chat.start();
    chat.send('oi');
    await tick();
    f.last().emit({ type: 'error', message: 'erro de antes do fechamento' });
    await chat.stopAndWait();
    expect(chat.snapshot().state).toMatchObject({ running: false, error: null });
    expect(exits).toEqual([[null, null]]);
    expect(errorsOf(chat)).toEqual([]);
  });

  it('saída inesperada com código 1 continua sendo erro: o último `error` do stream, senão o stderr, senão o código', async () => {
    const f = fakeCodex();
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl });
    chat.start();
    chat.send('um');
    await tick();
    f.last().emit({ type: 'error', message: 'falha do stream' });
    f.last().stderr('ruído\n');
    await tick();
    f.last().close(1);
    await tick();
    chat.send('dois');
    await tick();
    f.last().stderr('falha no stderr\n');
    await tick();
    f.last().close(1);
    await tick();
    chat.send('três');
    await tick();
    f.last().close(1);
    await tick();
    expect(errorsOf(chat).map((n) => n.text)).toEqual(['falha do stream', 'falha no stderr', 'o codex saiu com código 1']);
  });
});
