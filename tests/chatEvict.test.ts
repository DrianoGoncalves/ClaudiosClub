import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatItem } from '../shared/model';
import { CodexProcess } from '../server/chat/codexProcess';
import { ChatManager } from '../server/chat/manager';
import { ChatProcess, MAX_LIVE_ITEMS } from '../server/chat/process';

// Conversa de horas: o processo guarda só os itens mais recentes (e o log do stream acompanha); o que saiu volta do transcript
// no snapshot, a partir do ponto em que o stream começa (`cut`).

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-evict-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
afterEach(() => vi.useRealTimers());

function fakeClaude() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: 7, kill: () => proc.emit('exit', 0) });
  const spawnImpl = () => proc as never;
  return { spawnImpl };
}

const text = (id: string, body = id) => ({ type: 'assistant', message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: body }] } });
const toolUse = (id: string) => ({ type: 'assistant', message: { id: `m-${id}`, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 1' } }] } });
const toolResult = (id: string, out = 'ok') => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: out }] } });
const ids = (chat: ChatProcess) => chat.snapshot().items.map((i) => i.id);

describe('conversa ao vivo: limite de itens na memória', () => {
  it('o limite padrão é o mesmo da tela (400)', () => {
    expect(MAX_LIVE_ITEMS).toBe(400);
  });

  it('guarda só os últimos N, na ordem, e o log do stream deixa de repetir os que saíram', () => {
    const chat = new ChatProcess({ sessionId: 's', cwd: '.', args: [], maxItems: 5 });
    for (let i = 1; i <= 12; i++) chat.handle(text(`m${i}`));
    expect(ids(chat)).toEqual(['a:m8', 'a:m9', 'a:m10', 'a:m11', 'a:m12']);

    const replay: ChatEvent[] = [];
    chat.subscribe((e) => replay.push(e));
    const seen = replay.filter((e): e is Extract<ChatEvent, { type: 'item' }> => e.type === 'item').map((e) => e.item.id);
    expect(seen).toEqual(['a:m8', 'a:m9', 'a:m10', 'a:m11', 'a:m12']);
  });

  it('não tira pedido de permissão sem resposta, nem ferramenta rodando, nem a resposta que está chegando', () => {
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: 's', cwd: '.', args: [], maxItems: 3, spawnImpl: f.spawnImpl });
    chat.start();
    chat.handle({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }); // turno aberto: ferramenta sem resultado está rodando
    chat.handle({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm x' } } });
    chat.handle(toolUse('t1'));
    for (let i = 1; i <= 8; i++) chat.handle(text(`m${i}`));
    // A resposta no meio das deltas também fica.
    chat.handle({ type: 'stream_event', api_message_id: 'vivo', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } } });
    for (let i = 9; i <= 14; i++) chat.handle(text(`m${i}`));
    chat.handle({ type: 'stream_event', api_message_id: 'vivo', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'b' } } });

    const kept = ids(chat);
    expect(kept).toContain('p:r1');
    expect(kept).toContain('t:t1');
    expect(kept).toContain('a:vivo');
    expect(chat.snapshot().items.find((i) => i.id === 'a:vivo')).toMatchObject({ text: 'ab' });
    expect(chat.pendingPermissions().map((p) => p.id)).toEqual(['p:r1']);
    expect(kept.filter((id) => id.startsWith('a:m'))).toEqual(['a:m12', 'a:m13', 'a:m14'].slice(-1));

    // O resultado da ferramenta que rodava ainda acha o item; responder o pedido também.
    chat.handle(toolResult('t1', 'feito'));
    expect(chat.snapshot().items.find((i) => i.id === 't:t1')).toMatchObject({ result: 'feito' });
    expect(chat.answer('r1', false)).toBe(true);
    expect(chat.snapshot().items.find((i) => i.id === 'p:r1')).toMatchObject({ status: 'denied' });
    // Resolvidos, entram na fila de saída como os outros.
    chat.handle({ type: 'result', subtype: 'success', is_error: false });
    chat.handle(text('m15'));
    expect(ids(chat)).not.toContain('p:r1');
    expect(ids(chat)).not.toContain('t:t1');
    expect(ids(chat).length).toBeLessThanOrEqual(3);
  });

  it('resultado de ferramenta que já saiu não quebra nem cria item sem nome', () => {
    const chat = new ChatProcess({ sessionId: 's', cwd: '.', args: [], maxItems: 3 });
    chat.handle(toolUse('velha')); // sem turno aberto: é órfã e pode sair
    for (let i = 1; i <= 5; i++) chat.handle(text(`m${i}`));
    expect(ids(chat)).not.toContain('t:velha');
    const events: ChatEvent[] = [];
    chat.subscribe((e) => events.push(e), chat.currentSeq);
    expect(() => chat.handle(toolResult('velha', 'tarde'))).not.toThrow();
    expect(() => chat.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'velha', is_error: true, content: 'Permission to use Bash has been denied.' }] } })).not.toThrow();
    expect(ids(chat)).not.toContain('t:velha');
    expect(events.filter((e) => e.type === 'item' && e.item.kind === 'tool')).toEqual([]);
  });

  it('item atualizado depois que saiu (aviso trocado) volta como item novo, sem quebrar', () => {
    const chat = new ChatProcess({ sessionId: 's', cwd: '.', args: [], maxItems: 3 });
    chat.setNotice('n:limit:1', 'volta às 10h', 'info', 'cancel-auto-continue');
    for (let i = 1; i <= 5; i++) chat.handle(text(`m${i}`));
    expect(ids(chat)).not.toContain('n:limit:1');
    chat.setNotice('n:limit:1', 'já continuou', 'info');
    expect(chat.snapshot().items.at(-1)).toMatchObject({ id: 'n:limit:1', text: 'já continuou' });
  });

  it('`cut`: nada cortado = null; cortado = o primeiro item que ficou (before) e o mais antigo que saiu (oldest)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const at = (n: number) => new Date(Date.UTC(2026, 10, 14, 10, 0, n)).toISOString();
    vi.setSystemTime(new Date(at(0)));
    const chat = new ChatProcess({ sessionId: 's', cwd: '.', args: [], maxItems: 3 });
    expect(chat.cut).toBeNull();
    for (let i = 1; i <= 3; i++) {
      vi.setSystemTime(new Date(at(i)));
      chat.addNotice(`n${i}`);
    }
    expect(chat.cut).toBeNull();
    for (let i = 4; i <= 7; i++) {
      vi.setSystemTime(new Date(at(i)));
      chat.addNotice(`n${i}`);
    }
    // Ficaram n5, n6, n7: o stream começa em n5; n1 foi o primeiro a sair.
    expect(chat.snapshot().items.map((i) => i.at)).toEqual([at(5), at(6), at(7)]);
    expect(chat.cut).toEqual({ before: at(5), oldest: at(1) });
  });

  it('`cut`: log do stream que passou do limite também move o ponto (os itens sem evento no log vêm do transcript)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const at = (n: number) => new Date(Date.UTC(2026, 10, 14, 10, 0, n)).toISOString();
    vi.setSystemTime(new Date(at(1)));
    const chat = new ChatProcess({ sessionId: 's', cwd: '.', args: [], maxItems: 50 });
    chat.handle(text('A'));
    vi.setSystemTime(new Date(at(2)));
    // B chega em deltas (milhares de eventos) e fecha: o log de 5000 eventos perde o evento de A e o começo de B.
    for (let i = 0; i < 5_100; i++) chat.handle({ type: 'stream_event', api_message_id: 'B', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } });
    chat.handle(text('B', 'texto final de B'));
    vi.setSystemTime(new Date(at(3)));
    chat.handle(text('C'));
    expect(ids(chat)).toEqual(['a:A', 'a:B', 'a:C']); // na memória está tudo (limite 50)
    expect(chat.cut).toEqual({ before: at(2), oldest: at(1) }); // mas o stream só repete B e C
  });

  it('Codex: ferramenta rodando fica; a que saiu e termina depois volta inteira (o evento traz tudo)', () => {
    const profile = { cwd: '/proj', sessionId: 'sess-1', permissionMode: 'default', secrets: { projectPath: '/proj', home: '/nao-existe', mycoHome: '/nao-existe/.myco' } };
    const chat = new CodexProcess({ ...profile, maxItems: 3 });
    chat.start();
    const cmd = (id: string, status: string, out = '') => ({ id, type: 'command_execution', command: 'sleep 1', aggregated_output: out, status });
    const say = (id: string) => chat.handle({ type: 'item.completed', item: { id, type: 'agent_message', text: `fala ${id}` } });

    chat.handle({ type: 'turn.started' }); // turno aberto
    chat.handle({ type: 'item.started', item: cmd('run', 'in_progress') });
    for (let i = 0; i < 6; i++) say(`a${i}`);
    expect(chat.snapshot().items.some((i) => i.kind === 'tool' && i.result === null)).toBe(true);
    chat.handle({ type: 'item.completed', item: cmd('run', 'completed', 'pronto') });
    expect(chat.snapshot().items.filter((i) => i.kind === 'tool')).toHaveLength(1);
    expect(chat.snapshot().items.find((i) => i.kind === 'tool')).toMatchObject({ result: 'pronto' });

    // Sem turno aberto, uma ferramenta sem resultado é órfã e sai; o fim dela chega depois e não quebra.
    chat.handle({ type: 'item.started', item: cmd('orfa', 'in_progress') });
    chat.handle({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    expect(chat.snapshot().state.busy).toBe(false);
    for (let i = 6; i < 12; i++) say(`a${i}`);
    expect(chat.snapshot().items.some((i) => i.kind === 'tool' && i.summary.includes('sleep') && i.result === null)).toBe(false);
    expect(() => chat.handle({ type: 'item.completed', item: cmd('orfa', 'completed', 'tarde') })).not.toThrow();
    expect(chat.snapshot().items.at(-1)).toMatchObject({ kind: 'tool', result: 'tarde' });
    expect(chat.snapshot().items).toHaveLength(3);
  });
});

describe('ChatManager.snapshot: o histórico vai até onde o stream começa', () => {
  const BASE = Date.UTC(2026, 10, 14, 10, 0, 0);
  const at = (n: number, plus = 0) => new Date(BASE + n * 1000 + plus).toISOString();
  const userLine = (text: string, timestamp: string) => JSON.stringify({ type: 'user', uuid: `u-${text}`, timestamp, message: { content: text } });

  async function setup(name: string, sent: number, older: number, maxItems: number) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(BASE - 3_600_000));
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: name, cwd: '.', args: [], maxItems, spawnImpl: f.spawnImpl });
    chat.start();
    const lines: string[] = [];
    // O que veio antes de o processo abrir (já no transcript).
    for (let i = 0; i < older; i++) lines.push(userLine(`antes${i}`, new Date(BASE - 7_200_000 + i * 1000).toISOString()));
    for (let i = 1; i <= sent; i++) {
      vi.setSystemTime(new Date(BASE + i * 1000));
      chat.send(`m${i}`);
      // O Claude grava a mensagem logo depois de recebê-la.
      lines.push(userLine(`m${i}`, at(i, 5)));
    }
    await fs.mkdir(path.join(root, 'p'), { recursive: true });
    await fs.writeFile(path.join(root, 'p', `${name}.jsonl`), lines.join('\n') + '\n');
    const m = new ChatManager({ transcriptsDir: root, usageFile: path.join(root, `${name}-usage.json`), listLive: async () => [], resolve: async () => null });
    (m as unknown as { chats: Map<string, ChatProcess> }).chats.set(name, chat);
    return { m, chat };
  }
  const texts = (items: ChatItem[]) => items.map((i) => (i.kind === 'user' ? i.text : i.kind));

  it('sem corte: o histórico vai até a abertura do processo (como sempre)', async () => {
    const { m, chat } = await setup('sem-corte', 4, 3, 50);
    expect(chat.cut).toBeNull();
    const snap = await m.snapshot('p', 'sem-corte');
    expect(texts(snap.history)).toEqual(['antes0', 'antes1', 'antes2']);
    expect(snap.live!.items).toHaveLength(4);
  });

  it('com itens fora da memória: o que saiu volta do transcript, sem repetir o que o stream traz', async () => {
    const { m, chat } = await setup('cortada', 12, 3, 5);
    expect(chat.cut).toEqual({ before: at(8), oldest: at(1) });
    const snap = await m.snapshot('p', 'cortada');
    expect(texts(snap.history)).toEqual(['antes0', 'antes1', 'antes2', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    expect(snap.live!.items.map((i) => (i.kind === 'user' ? i.text : ''))).toEqual(['m8', 'm9', 'm10', 'm11', 'm12']);
    // O histórico alcança o mais antigo que saiu (e há pouco no arquivo): sem aviso.
    expect(snap.history.some((i) => i.kind === 'notice')).toBe(false);
  });

  it('o transcript não alcança o que saiu: um aviso no topo diz que o resto está no arquivo (uma vez só)', async () => {
    const { m } = await setup('curta', 260, 0, 5);
    const snap = await m.snapshot('p', 'curta');
    const [first, second] = snap.history;
    expect(first).toMatchObject({ kind: 'notice', id: 'n:older-in-file', note: 'older-in-file', tone: 'info' });
    expect(second).toMatchObject({ kind: 'user', text: 'm56' }); // os 200 últimos antes de m256 (o primeiro que ficou)
    expect(snap.history.filter((i) => i.kind === 'notice')).toHaveLength(1);
    expect(snap.history).toHaveLength(201);
  });

  it('histórico cheio mas que vai além do mais antigo que saiu: sem aviso', async () => {
    const { m } = await setup('longa', 12, 300, 5);
    const snap = await m.snapshot('p', 'longa');
    expect(snap.history).toHaveLength(200);
    expect(snap.history.some((i) => i.kind === 'notice')).toBe(false);
  });
});
