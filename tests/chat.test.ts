import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatEvent, StaffProfile, UsageLimit } from '../shared/model';
import { readHistory } from '../server/chat/history';
import { ChatManager } from '../server/chat/manager';
import { ChatRegistry } from '../server/chat/registry';
import { ChatProcess, STREAM_FLAGS } from '../server/chat/process';
import { accountRulesFile, readAccountRules, saveAccountRules, saveProjectImage, readProjectImage } from '../server/files';

/** Processo falso: o que o Claudio’s Club escreve no stdin fica em `written`; `emit` simula o stdout do claude. */
function fakeClaude() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 4242, kill: () => proc.emit('exit', 0) });
  const written: unknown[] = [];
  stdin.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => written.push(JSON.parse(l))));
  let spawned: { cmd: string; args: string[]; cwd: string } | null = null;
  const spawnImpl = (cmd: string, args: string[], opts: { cwd: string }) => {
    spawned = { cmd, args, cwd: opts.cwd };
    return proc as never;
  };
  const emit = (ev: object) => stdout.write(JSON.stringify(ev) + '\n');
  return { proc, written, spawnImpl, emit, spawned: () => spawned };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('ChatProcess', () => {
  it('abre o claude em stream-json, manda mensagens e monta a conversa a partir dos eventos', async () => {
    const f = fakeClaude();
    const usage: UsageLimit[][] = [];
    const chat = new ChatProcess({ sessionId: 's1', cwd: 'C:\\proj', args: ['--resume', 's1'], spawnImpl: f.spawnImpl, onUsage: (l) => usage.push(l) });
    const events: ChatEvent[] = [];
    chat.start();
    chat.subscribe((e) => events.push(e));
    expect(f.spawned()).toMatchObject({ cmd: 'claude', cwd: 'C:\\proj', args: [...STREAM_FLAGS, '--resume', 's1'] });
    // Sem a opção, trocar para "sem travas" com o processo aberto é recusado e ele segue pedindo.
    expect(STREAM_FLAGS).toContain('--allow-dangerously-skip-permissions');

    chat.send('Olá');
    await tick();
    // Com o id da mensagem (vira o do transcript: é por ele que "voltar até aqui" acha o ponto).
    expect(f.written[0]).toEqual({ type: 'user', uuid: expect.any(String), message: { role: 'user', content: [{ type: 'text', text: 'Olá' }] } });
    expect(chat.snapshot().state.busy).toBe(true);

    f.emit({ type: 'system', subtype: 'init', model: 'claude-haiku-5-5' });
    f.emit({ type: 'stream_event', api_message_id: 'm1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Oi, ' } } });
    f.emit({ type: 'stream_event', api_message_id: 'm1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'tudo bem?' } } });
    // Evento de subagent: fica fora da conversa principal.
    f.emit({ type: 'assistant', parent_tool_use_id: 'x', message: { id: 'sub', content: [{ type: 'text', text: 'interno' }] } });
    f.emit({
      type: 'assistant',
      message: {
        id: 'm1',
        model: 'claude-haiku-5-5',
        content: [{ type: 'text', text: 'Oi, tudo bem?' }],
        usage: { input_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 10_000 },
      },
    });
    f.emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'src/a.ts' } }] } });
    f.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'conteúdo', is_error: false }] } });
    f.emit({
      type: 'rate_limit_event',
      rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.314, resetsAt: 1793032200 }, seven_day: { utilization: 0.22, resetsAt: 1793307600 } } },
    });
    f.emit({ type: 'result', is_error: false, modelUsage: { 'claude-haiku-5-5': { contextWindow: 200_000 } } });
    await tick();

    const { items, state } = chat.snapshot();
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool']);
    expect(items[1]).toMatchObject({ kind: 'assistant', text: 'Oi, tudo bem?' });
    expect(items[2]).toMatchObject({ kind: 'tool', name: 'Read', summary: 'src/a.ts', result: 'conteúdo' });
    expect(state).toMatchObject({ busy: false, model: 'claude-haiku-5-5', context: { used: 100_010, window: 200_000, percent: 50 } });
    expect(usage[0]).toEqual([
      { kind: 'five_hour', percentUsed: 31.4, resetsAt: new Date(1793032200 * 1000).toISOString() },
      { kind: 'seven_day', percentUsed: 22, resetsAt: new Date(1793307600 * 1000).toISOString() },
    ]);
    expect(events.some((e) => e.type === 'delta' && e.text === 'tudo bem?')).toBe(true);
  });

  it('pedido de permissão vira cartão; aprovar devolve a entrada; negar responde deny', async () => {
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: 's2', cwd: '.', args: [], spawnImpl: f.spawnImpl });
    chat.start();
    f.emit({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'x.txt', content: 'oi' } } });
    f.emit({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /' } } });
    await tick();
    expect(chat.busy).toBe(true);
    expect(chat.snapshot().items.find((i) => i.id === 'p:r1')).toMatchObject({ kind: 'permission', tool: 'Write', summary: 'x.txt', status: 'pending' });

    expect(chat.answer('r1', true)).toBe(true);
    expect(chat.answer('r2', false)).toBe(true);
    expect(chat.answer('r2', false)).toBe(false); // já respondido
    await tick();
    expect(f.written).toEqual([
      { type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { file_path: 'x.txt', content: 'oi' } } } },
      { type: 'control_response', response: { subtype: 'success', request_id: 'r2', response: { behavior: 'deny', message: 'O usuário negou pelo Claudio’s Club.' } } },
    ]);
    expect(chat.snapshot().items.find((i) => i.id === 'p:r2')).toMatchObject({ status: 'denied' });
  });

  it('compactar manda /compact; quem conecta depois recebe a conversa desde o início', async () => {
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: 's3', cwd: '.', args: [], spawnImpl: f.spawnImpl });
    chat.start();
    chat.compact();
    f.emit({ type: 'system', subtype: 'compact_boundary' });
    f.emit({ type: 'result', is_error: false });
    await tick();
    expect(f.written[0]).toMatchObject({ message: { content: [{ text: '/compact' }] } });
    const late: ChatEvent[] = [];
    chat.subscribe((e) => late.push(e), 0);
    expect(late.some((e) => e.type === 'item' && e.item.kind === 'notice' && e.item.text === 'Conversa compactada')).toBe(true);
    expect(chat.snapshot().state).toMatchObject({ compacting: false, busy: false });
  });

  it('mensagem com o turno em andamento leva a prioridade; a da fila reabre o turno no init seguinte', async () => {
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: 's4', cwd: '.', args: [], spawnImpl: f.spawnImpl });
    chat.start();
    chat.send('primeira', 'later'); // parado: turno novo, sem prioridade
    f.emit({ type: 'system', subtype: 'init', permissionMode: 'acceptEdits' });
    chat.send('segunda', 'later');
    await tick();
    expect(f.written[0]).not.toHaveProperty('priority');
    expect(f.written[1]).toMatchObject({ type: 'user', priority: 'later' });
    expect(chat.snapshot().items.filter((i) => i.kind === 'user').map((i) => (i.kind === 'user' ? i.queued : null))).toEqual([undefined, 'later']);
    expect(chat.snapshot().state.permissionMode).toBe('acceptEdits');

    f.emit({ type: 'result', is_error: false });
    await tick();
    expect(chat.snapshot().state.busy).toBe(false);
    f.emit({ type: 'system', subtype: 'init', permissionMode: 'acceptEdits' }); // turno da mensagem da fila
    await tick();
    expect(chat.snapshot().state.busy).toBe(true);
  });

  it('imagens coladas vão como blocos base64 antes do texto; a mensagem guarda só a contagem', async () => {
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: 's-img', cwd: '.', args: [], spawnImpl: f.spawnImpl });
    chat.start();
    chat.send('olha esse erro', 'next', ['data:image/png;base64,iVBORw0KGgo=', 'data:image/webp;base64,UklGRg==']);
    await tick();
    expect(f.written[0]).toEqual({
      type: 'user',
      uuid: expect.any(String),
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklGRg==' } },
          { type: 'text', text: 'olha esse erro' },
        ],
      },
    });
    expect(chat.snapshot().items[0]).toMatchObject({ kind: 'user', text: 'olha esse erro', images: 2 });
  });

  it('segredo no chat ou no comando vira aviso (só o tipo, nunca o valor)', async () => {
    const f = fakeClaude();
    const seen: string[] = [];
    const chat = new ChatProcess({ sessionId: 's-sec', cwd: '.', args: [], spawnImpl: f.spawnImpl, onSecret: (l) => seen.push(l) });
    chat.start();
    chat.send('oi');
    f.emit({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'tu', name: 'Bash', input: { command: 'mysql -uroot -pS3nh4Forte app' } }] } });
    await tick();
    expect(seen).toEqual(['uma senha']);
  });

  it('`now` interrompe: o turno parado vira aviso discreto, não erro', async () => {
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: 's5', cwd: '.', args: [], spawnImpl: f.spawnImpl });
    chat.start();
    chat.send('faz algo longo');
    chat.send('para e responde isto', 'now');
    f.emit({ type: 'result', subtype: 'error_during_execution', is_error: true });
    await tick();
    const notices = chat.snapshot().items.filter((i) => i.kind === 'notice');
    expect(notices).toEqual([expect.objectContaining({ text: 'Turno interrompido', tone: 'info' })]);
  });

  it('troca o modo de permissão do processo aberto e avisa o resultado', async () => {
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: 's6', cwd: '.', args: [], spawnImpl: f.spawnImpl });
    chat.start();
    chat.setPermissionMode('auto', 'Autonomia agora: automático');
    chat.setPermissionMode('auto', 'de novo');
    await tick();
    const [a, b] = f.written as Array<{ request_id: string; request: unknown }>;
    expect(a).toMatchObject({ type: 'control_request', request: { subtype: 'set_permission_mode', mode: 'auto' } });
    f.emit({ type: 'control_response', response: { subtype: 'success', request_id: a!.request_id, response: { mode: 'auto' } } });
    f.emit({ type: 'control_response', response: { subtype: 'error', request_id: b!.request_id, error: 'auto_mode_unavailable' } });
    f.emit({ type: 'control_response', response: { subtype: 'success', request_id: 'de-outro' } }); // não é nosso
    await tick();
    const notices = chat.snapshot().items.filter((i) => i.kind === 'notice').map((i) => (i.kind === 'notice' ? [i.tone, i.text] : null));
    expect(notices).toEqual([
      ['info', 'Autonomia agora: automático'],
      ['warn', expect.stringContaining('auto_mode_unavailable')],
    ]);
    expect(chat.stale).toBe(true); // não deu: reabre com a ficha nova
  });

  it('fim do modo plano vira cartão com o plano; pendentes ficam listados; negar leva a mensagem', async () => {
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: 's8', cwd: '.', args: [], spawnImpl: f.spawnImpl });
    chat.start();
    f.emit({
      type: 'control_request',
      request_id: 'r9',
      request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Plano\n\n1. Criar x.txt', planFilePath: 'C:\\p.md' }, requires_user_interaction: true },
    });
    f.emit({ type: 'control_request', request_id: 'r10', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'x.txt', content: '' } } });
    await tick();
    expect(chat.pendingPermissions().map((p) => [p.id, p.summary, p.plan])).toEqual([
      ['p:r9', 'plano pronto para aprovar', '# Plano\n\n1. Criar x.txt'],
      ['p:r10', 'x.txt', undefined],
    ]);
    expect(chat.answer('r9', false, 'Quero mudanças.')).toBe(true);
    await tick();
    expect(f.written.at(-1)).toMatchObject({ response: { request_id: 'r9', response: { behavior: 'deny', message: 'Quero mudanças.' } } });
    expect(chat.pendingPermissions().map((p) => p.id)).toEqual(['p:r10']);
  });

  it('"sem travas" não entra com o processo aberto: avisa que reabre na próxima mensagem', async () => {
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: 's7', cwd: '.', args: [], spawnImpl: f.spawnImpl });
    chat.start();
    chat.setPermissionMode('bypassPermissions', 'Autonomia agora: sem travas');
    await tick();
    const req = f.written[0] as { request_id: string };
    f.emit({
      type: 'control_response',
      response: { subtype: 'error', request_id: req.request_id, error: 'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions', error_code: 'bypass_not_launched' },
    });
    await tick();
    expect(chat.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', tone: 'info', text: 'Autonomia agora: sem travas: a conversa reabre nesse modo na próxima mensagem.' });
    expect(chat.stale).toBe(true);
  });
});

describe('ChatManager: processo órfão de um servidor que reiniciou', () => {
  const DEAD_SERVER = 99_001;
  const ORPHAN = 99_002;
  function setup(status: string) {
    const registry = new ChatRegistry(path.join(root, `chats-${status}.json`));
    const alive = new Set([ORPHAN]);
    const killed: number[] = [];
    const lines: string[] = [];
    const m = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage.json'),
      listLive: async () =>
        [{ sessionId: 'orf', pid: ORPHAN, alive: alive.has(ORPHAN), entrypoint: 'sdk-cli', status }] as never,
      resolve: async () => null,
      registry,
      isAlive: (pid) => alive.has(pid),
      kill: async (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
      log: (l) => lines.push(l),
    });
    return { m, registry, killed, lines };
  }

  it('mandar mensagem para o órfão encerra o processo e segue aqui', async () => {
    const { m, registry, killed, lines } = setup('busy');
    await registry.add({ sessionId: 'orf', pid: ORPHAN, server: DEAD_SERVER, startedAt: '' });
    // `resolve` do teste não abre processo: o erro vem depois de o órfão sair do caminho.
    await expect(m.send('p', 'orf', null, 'oi')).rejects.toThrow(/não encontrado/);
    expect(killed).toEqual([ORPHAN]);
    expect(await registry.read()).toEqual({});
    expect(lines.some((l) => l.includes('retomada aqui'))).toBe(true);
  });

  it('reconhece o órfão e o "Trazer" encerra o processo', async () => {
    const { m, registry, killed, lines } = setup('busy');
    await registry.add({ sessionId: 'orf', pid: ORPHAN, server: DEAD_SERVER, startedAt: '' });
    const snap = await m.snapshot('p', 'orf');
    expect(snap.elsewhere).toMatchObject({ pid: ORPHAN, orphan: true });
    await m.adopt('orf');
    expect(killed).toEqual([ORPHAN]);
    expect(await registry.read()).toEqual({});
    expect((await m.snapshot('p', 'orf')).elsewhere).toBeNull();
    expect(lines.some((l) => l.includes('encerrando processo órfão'))).toBe(true);
  });

  it('a caixa lista o órfão (registro de servidor morto + processo vivo)', async () => {
    const { m, registry } = setup('waiting');
    await registry.add({ sessionId: 'orf', pid: ORPHAN, server: DEAD_SERVER, startedAt: '' });
    const live = [{ sessionId: 'orf', pid: ORPHAN, alive: true, entrypoint: 'sdk-cli', status: 'waiting' }] as never;
    expect(await m.orphans(live)).toEqual([{ sessionId: 'orf', pid: ORPHAN, status: 'waiting' }]);
    await registry.add({ sessionId: 'orf', pid: ORPHAN, server: process.pid, startedAt: '' }); // deste servidor: não é órfão
    expect(await m.orphans(live)).toEqual([]);
  });

  it('aberta de verdade em outro lugar (sem registro do Claudio’s Club): não encerra nada', async () => {
    const { m, killed } = setup('idle');
    expect((await m.snapshot('p', 'orf')).elsewhere).toMatchObject({ orphan: false });
    await expect(m.adopt('orf')).rejects.toThrow(/feche lá/);
    expect(killed).toEqual([]);
  });

  it('na subida: encerra órfão parado, deixa o que está trabalhando', async () => {
    const parado = setup('waiting');
    await parado.registry.add({ sessionId: 'orf', pid: ORPHAN, server: DEAD_SERVER, startedAt: '' });
    await parado.m.cleanOrphans();
    expect(parado.killed).toEqual([ORPHAN]);

    const ocupado = setup('busy');
    await ocupado.registry.add({ sessionId: 'orf', pid: ORPHAN, server: DEAD_SERVER, startedAt: '' });
    await ocupado.m.cleanOrphans();
    expect(ocupado.killed).toEqual([]);
  });
});

describe('ChatManager: assumir sessão aberta em outro lugar', () => {
  const OTHER = 99_101;
  function setup(status: string | null, present = true) {
    const alive = new Set(present ? [OTHER] : []);
    const killed: number[] = [];
    const m = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage.json'),
      listLive: async () =>
        (present ? [{ sessionId: 'ter', pid: OTHER, alive: alive.has(OTHER), entrypoint: 'claude-desktop', status }] : []) as never,
      resolve: async () => null,
      isAlive: (pid) => alive.has(pid),
      kill: async (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
      log: () => {},
    });
    return { m, killed };
  }

  it('recusa sessão trabalhando (encerrar no meio do turno perderia o que ela faz)', async () => {
    const { m, killed } = setup('busy');
    await expect(m.takeOver('ter')).rejects.toThrow(/trabalhando/);
    expect(killed).toEqual([]);
  });

  it('sessão parada em outro lugar: encerra só o processo dela, e a conversa fica livre aqui', async () => {
    const { m, killed } = setup('waiting');
    expect((await m.snapshot('p', 'ter')).elsewhere).toMatchObject({ pid: OTHER, orphan: false });
    await m.takeOver('ter');
    expect(killed).toEqual([OTHER]);
    expect((await m.snapshot('p', 'ter')).elsewhere).toBeNull();
  });

  it('sem sessão aberta: não mexe em nada', async () => {
    const { m, killed } = setup('waiting', false);
    await m.takeOver('ter');
    expect(killed).toEqual([]);
  });
});

describe('ChatManager: ficha editada com a conversa aberta', () => {
  function manager() {
    const procs: Array<ReturnType<typeof fakeClaude>> = [];
    const spawnImpl = (cmd: string, args: string[], opts: { cwd: string }) => {
      const f = fakeClaude();
      f.proc.stdin.on('finish', () => f.proc.emit('exit', 0)); // fecha ao terminar a entrada
      procs.push(f);
      return f.spawnImpl(cmd, args, opts);
    };
    let args = ['--permission-mode', 'acceptEdits'];
    const m = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage.json'),
      listLive: async () => [],
      resolve: async (_p, sid) => ({ sessionId: sid ?? 'sx', cwd: '.', args }),
      spawnImpl,
    });
    return { m, procs, setArgs: (a: string[]) => (args = a) };
  }
  const profile = (over: Partial<StaffProfile> = {}) =>
    ({ id: 'ana', autonomy: 'acceptEdits', model: 'sonnet', sessions: [{ id: 'sx', startedAt: '' }], updatedAt: '1', ...over }) as StaffProfile;

  it('marca a conversa como delegada só quando quem mandou foi outro funcionário', async () => {
    const { m } = manager();
    await m.send('p', 'sx', 'ana', 'faça X', undefined, [], [], true);
    expect(m.isDelegated('sx')).toBe(true);
    // Você falou com ele no chat: deixa de ser delegação.
    await m.send('p', 'sx', 'ana', 'e também Y');
    expect(m.isDelegated('sx')).toBe(false);
  });

  it('turno que termina com pergunta no texto espera você, até você responder; delegada não', async () => {
    const { m, procs } = manager();
    await m.send('p', 'sx', 'ana', 'arrume e me diga');
    const f = procs[0]!;
    const ask = 'Decisões aplicadas.\n\nQuer que eu **(1)** faça o commit em `main` e **(2)** apague os órfãos?\n\nCerteza: 8/10';
    f.emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: ask }] } });
    f.emit({ type: 'result', is_error: false });
    await tick();
    expect(m.pendingQuestions()).toEqual([{ sessionId: 'sx', text: 'Quer que eu (1) faça o commit em main e (2) apague os órfãos?', at: expect.any(String) }]);
    await m.send('p', 'sx', 'ana', 'faça como sugerir');
    expect(m.pendingQuestions()).toEqual([]);

    // "Ok, vi": sai da caixa sem responder.
    f.emit({ type: 'assistant', message: { id: 'm1b', content: [{ type: 'text', text: 'Sigo com a opção 2?' }] } });
    f.emit({ type: 'result', is_error: false });
    await tick();
    expect(m.dismissQuestion('sx')).toBe(true);
    expect(m.pendingQuestions()).toEqual([]);

    // Pedido de outro funcionário: a pergunta é para ele, que recebe a entrega.
    await m.send('p', 'sx', 'ana', 'tarefa', undefined, [], [], true);
    f.emit({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Pode ser assim?' }] } });
    f.emit({ type: 'result', is_error: false });
    await tick();
    expect(m.pendingQuestions()).toEqual([]);
  });

  it('"já troquei" tira o aviso de segredo; "não é segredo" tira e não avisa mais desse tipo', async () => {
    const { m, procs } = manager();
    await m.send('p', 'sx', 'ana', 'rode');
    const f = procs[0]!;
    const leak = (id: string) => f.emit({ type: 'assistant', message: { id, content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Bash', input: { command: 'mysql -uroot -pS3nh4Forte app' } }] } });
    leak('a');
    await tick();
    const [hit] = m.secretHits();
    expect(hit).toMatchObject({ sessionId: 'sx', label: 'uma senha' });
    expect(m.dismissSecret(hit!.id)).toBe(true);
    leak('b');
    await tick();
    expect(m.secretHits()).toHaveLength(1); // trocou e colou de novo: volta
    expect(m.dismissSecret(hit!.id, true)).toBe(true);
    leak('c');
    await tick();
    expect(m.secretHits()).toEqual([]);
  });

  it('só a autonomia mudou: troca o modo sem reabrir', async () => {
    const { m, procs } = manager();
    await m.send('p', 'sx', 'ana', 'oi');
    procs[0]!.emit({ type: 'system', subtype: 'init', permissionMode: 'acceptEdits' });
    procs[0]!.emit({ type: 'result', is_error: false });
    await tick();
    m.profileChanged(profile(), profile({ autonomy: 'manual', updatedAt: '2' }));
    await tick();
    expect(procs[0]!.written.at(-1)).toMatchObject({ request: { subtype: 'set_permission_mode', mode: 'default' } });
    await m.send('p', 'sx', 'ana', 'e agora?');
    expect(procs).toHaveLength(1);
  });

  it('"aprovar e executar": aprova o plano e troca a autonomia; a caixa lista pendentes e erros', async () => {
    const { m, procs } = manager();
    await m.send('p', 'sx', 'ana', 'planeje');
    const f = procs[0]!;
    f.emit({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Plano' } } });
    await tick();
    expect(m.attention()).toEqual([{ sessionId: 'sx', pending: [expect.objectContaining({ id: 'p:r1', plan: '# Plano' })], error: null }]);

    expect(m.answer('sx', 'r1', true, { executeAs: 'acceptEdits' })).toBe(true);
    await tick();
    expect(f.written.slice(-2)).toEqual([
      expect.objectContaining({ response: expect.objectContaining({ request_id: 'r1', response: { behavior: 'allow', updatedInput: { plan: '# Plano' } } }) }),
      expect.objectContaining({ type: 'control_request', request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } }),
    ]);
    expect(m.attention()).toEqual([]);

    f.proc.emit('exit', 1); // o claude caiu: a conversa parada com erro entra na caixa
    await tick();
    expect(m.attention()).toEqual([{ sessionId: 'sx', pending: [], error: 'o claude saiu com código 1' }]);
  });

  it('ficha mudou: a próxima mensagem de cada conversa dela leva o aviso para reler, uma vez só', async () => {
    const { m, procs } = manager();
    await m.send('p', 'sx', 'ana', 'oi');
    procs[0]!.emit({ type: 'result', is_error: false });
    await tick();
    m.profileChanged(profile(), profile({ mission: 'nova missão', updatedAt: '2' } as Partial<StaffProfile>), 'C:\\p\\.myco\\staff\\ana.md');
    await m.send('p', 'sx', 'ana', 'continua');
    await tick();
    const blocks = (procs.at(-1)!.written.at(-1) as { message: { content: Array<{ text: string }> } }).message.content;
    expect(blocks.map((b) => b.text)).toEqual([expect.stringMatching(/^\[MyCo\] Sua ficha foi atualizada.*C:\\p\\\.myco\\staff\\ana\.md/), 'continua']);
    procs.at(-1)!.emit({ type: 'result', is_error: false });
    await tick();
    await m.send('p', 'sx', 'ana', 'e agora');
    await tick();
    const again = (procs.at(-1)!.written.at(-1) as { message: { content: Array<{ text: string }> } }).message.content;
    expect(again.map((b) => b.text)).toEqual(['e agora']);
    // Só a autonomia mudou: troca ao vivo, sem aviso de ficha.
    m.profileChanged(profile(), profile({ autonomy: 'manual', updatedAt: '3' }));
    await m.send('p', 'sx', 'ana', 'ok');
    await tick();
    expect((procs.at(-1)!.written.at(-1) as { message: { content: unknown[] } }).message.content).toHaveLength(1);
  });

  it('aba ouvindo a sessão continua recebendo quando o processo fecha e reabre', async () => {
    const { m, procs } = manager();
    await m.send('p', 'sx', 'ana', 'um');
    const heard: string[] = [];
    m.subscribe('sx', 0, (e) => {
      if (e.type === 'item' && e.item.kind === 'user') heard.push(e.item.text);
    });
    m.stop('sx'); // fecha por inatividade, ficha mudou, claude saiu…
    await tick();
    expect(m.has('sx')).toBe(true);
    await m.send('p', 'sx', 'ana', 'dois');
    await tick();
    expect(procs).toHaveLength(2);
    expect(heard).toEqual(['um', 'dois']);
  });

  it('modelo mudou: reabre o processo na próxima mensagem, com o funcionário parado', async () => {
    const { m, procs, setArgs } = manager();
    await m.send('p', 'sx', 'ana', 'oi');
    procs[0]!.emit({ type: 'result', is_error: false });
    await tick();
    m.profileChanged(profile(), profile({ model: 'opus', updatedAt: '2' }));
    setArgs(['--model', 'opus']);
    await m.send('p', 'sx', 'ana', 'continua');
    expect(procs).toHaveLength(2);
    expect(procs[1]!.spawned()?.args).toContain('opus');
    // Com o aviso de ficha atualizada antes (a ficha mudou), e a sua mensagem por último.
    expect(procs[1]!.written[0]).toMatchObject({ message: { content: [{ text: expect.stringMatching(/^\[MyCo\] Sua ficha/) }, { text: 'continua' }] } });
  });

  it('ficha mudou com agents em segundo plano: não reabre (eles morreriam) até terminarem', async () => {
    const { m, procs } = manager();
    await m.send('p', 'sx', 'ana', 'delegue');
    const f = procs[0]!;
    f.emit({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'a1', task_type: 'local_agent', subagent_type: 'executor', description: 'Servidor: cor da sala' }],
    });
    f.emit({ type: 'result', is_error: false }); // o turno acabou, o executor continua
    await tick();
    expect(m.working()).toEqual({ busy: 0, background: 1 });
    m.profileChanged(profile(), profile({ model: 'opus', updatedAt: '2' }));
    await m.send('p', 'sx', 'ana', 'como vai?');
    expect(procs).toHaveLength(1);
    f.emit({ type: 'result', is_error: false });
    f.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    await tick();
    await m.send('p', 'sx', 'ana', 'e agora?');
    expect(procs).toHaveLength(2);
  });
});

describe('ChatProcess: segundo plano', () => {
  it('lista o que roda em segundo plano e limpa quando o processo sai', async () => {
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: 's', cwd: '.', args: [], spawnImpl: f.spawnImpl });
    chat.start();
    f.emit({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        { task_id: 'a1', task_type: 'local_agent', subagent_type: 'executor', description: 'Cliente' },
        { task_id: 'b2', task_type: 'local_bash', description: 'npm test' },
      ],
    });
    await tick();
    expect(chat.working).toBe(true);
    expect(chat.background).toEqual([
      { id: 'a1', kind: 'agent', label: 'executor: Cliente' },
      { id: 'b2', kind: 'shell', label: 'npm test' },
    ]);
    f.proc.emit('exit', 0);
    expect(chat.working).toBe(false);
    expect(chat.snapshot().state.background).toEqual([]);
  });
});

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-chat-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('readHistory', () => {
  it('lê do transcript as mensagens, ferramentas e o contexto, sem o texto injetado pelo sistema', async () => {
    const file = path.join(root, 's.jsonl');
    const lines = [
      { type: 'user', timestamp: '2026-10-26T10:00:00Z', message: { content: 'Arrume o bug' } },
      { type: 'user', timestamp: '2026-10-26T10:00:01Z', message: { content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] } },
      { type: 'assistant', timestamp: '2026-10-26T10:00:02Z', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Vou olhar.' }], usage: { input_tokens: 5, cache_read_input_tokens: 99_995 } } },
      { type: 'assistant', timestamp: '2026-10-26T10:00:02Z', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'user', timestamp: '2026-10-26T10:00:03Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }] } },
      { type: 'assistant', isSidechain: true, timestamp: '2026-10-26T10:00:04Z', message: { id: 'sx', content: [{ type: 'text', text: 'subagent' }] } },
      { type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-26T10:00:05Z' },
      { type: 'user', timestamp: '2026-10-26T11:00:00Z', message: { content: 'depois do processo' } },
    ];
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const { items, context } = await readHistory(file, { before: '2026-10-26T10:30:00Z' });
    expect(items.map((i) => [i.kind, 'text' in i ? i.text : 'name' in i ? i.name : ''])).toEqual([
      ['user', 'Arrume o bug'],
      ['assistant', 'Vou olhar.'],
      ['tool', 'Bash'],
      ['notice', 'Conversa compactada'],
    ]);
    expect(items[2]).toMatchObject({ summary: 'npm test', result: 'ok' });
    expect(context).toEqual({ used: 100_000, window: 1_000_000, percent: 10 });
  });
});

describe('arquivos editados pelo Claudio’s Club', () => {
  it('regras da conta: cria, e na edição guarda a anterior em backup', async () => {
    const file = path.join(root, 'claude', 'CLAUDE.md');
    const backups = path.join(root, 'backups');
    expect(await readAccountRules(file)).toEqual({ path: file, text: null });
    await saveAccountRules('# Regras\n- a', file, backups);
    const r = await saveAccountRules('# Regras\n- b', file, backups);
    expect(r.text).toBe('# Regras\n- b\n');
    const saved = await fs.readdir(backups);
    expect(saved).toHaveLength(1);
    expect(await fs.readFile(path.join(backups, saved[0]!), 'utf8')).toBe('# Regras\n- a\n');
    expect(accountRulesFile()).toMatch(/[\\/]\.claude[\\/]CLAUDE\.md$/);
  });

  it('imagem do projeto: grava, troca de formato e remove', async () => {
    const proj = path.join(root, 'proj');
    const png = 'data:image/png;base64,' + Buffer.from('png').toString('base64');
    const webp = 'data:image/webp;base64,' + Buffer.from('webp').toString('base64');
    await saveProjectImage(proj, png);
    expect((await readProjectImage(proj))?.type).toBe('image/png');
    await saveProjectImage(proj, webp);
    expect((await readProjectImage(proj))?.type).toBe('image/webp');
    // A troca apaga a anterior; o .gitignore deixa a imagem fora do git.
    expect(await fs.readdir(path.join(proj, '.myco'))).toEqual(['.gitignore', 'project.webp']);
    await saveProjectImage(proj, null);
    expect(await readProjectImage(proj)).toBeNull();
    await expect(saveProjectImage(proj, 'data:text/html;base64,AAAA')).rejects.toThrow('imagem inválida');
  });
});

describe('ChatManager: folga de cota', () => {
  it('liga Opus no máximo enquanto dura, avisa o funcionário uma vez e volta ao da ficha; a sua escolha vale', async () => {
    const f = fakeClaude();
    let boost: { until: string; projected: number } | null = { until: '2026-10-31T17:00:00.000Z', projected: 45 };
    const m = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage-boost.json'),
      listLive: async () => [],
      resolve: async () => ({ sessionId: 's-b', cwd: root, args: ['--session-id', 's-b', '--model', 'sonnet', '--effort', 'medium'] }),
      spawnImpl: f.spawnImpl,
      quotaBoost: async () => boost,
    });
    type Msg = { type: string; request?: Record<string, unknown>; message?: { content: Array<{ text?: string }> } };
    const sent = () => f.written.splice(0) as Msg[];
    const controls = (w: Msg[]) => w.filter((x) => x.type === 'control_request').map((x) => x.request);
    const notice = (w: Msg[]) => w.find((x) => x.type === 'user')?.message?.content.find((b) => b.text?.startsWith('[MyCo] Folga'))?.text;

    const sid = await m.send('p', null, 'bia', 'oi');
    await tick();
    let w = sent();
    expect(controls(w)).toEqual([{ subtype: 'set_model', model: 'opus' }, { subtype: 'apply_flag_settings', settings: { effortLevel: 'max' } }]);
    expect(notice(w)).toMatch(/effort: "xhigh" para o revisor e o pesquisador e effort: "medium" para o executor/);

    // Ainda na folga: nada muda, nada repete.
    await m.send('p', sid, 'bia', 'e agora?');
    await tick();
    w = sent();
    expect(controls(w)).toEqual([]);
    expect(notice(w)).toBeUndefined();

    // Acabou: volta ao modelo e ao esforço com que a conversa abriu.
    boost = null;
    await m.send('p', sid, 'bia', 'continua');
    await tick();
    w = sent();
    expect(controls(w)).toEqual([{ subtype: 'set_model', model: 'sonnet' }, { subtype: 'apply_flag_settings', settings: { effortLevel: 'medium' } }]);
    expect(notice(w)).toMatch(/acabou/);

    // Você trocou o modelo à mão: a folga não mexe mais nesta conversa.
    await m.settings('p', sid, 'bia', { model: 'haiku' });
    boost = { until: '2026-10-31T17:00:00.000Z', projected: 40 };
    await m.send('p', sid, 'bia', 'mais uma');
    await tick();
    w = sent();
    expect(controls(w)).toEqual([{ subtype: 'set_model', model: 'haiku' }]);
    expect(notice(w)).toBeUndefined();
  });
});

describe('ChatManager: conversa sem ficha', () => {
  it('modelo, esforço e autonomia mudam na hora, sem funcionário (a conversa só precisa existir)', async () => {
    const f = fakeClaude();
    let asked: { sessionId: string | null; staffId: string | null } | null = null;
    const m = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage-loose.json'),
      listLive: async () => [],
      // Como o chatSpawn sem ficha: retoma a sessão que já existe, pedindo antes de agir.
      resolve: async (_p, sessionId, staffId) => {
        asked = { sessionId, staffId };
        return sessionId && !staffId ? { sessionId, cwd: root, args: ['--resume', sessionId, '--permission-mode', 'manual'] } : null;
      },
      spawnImpl: f.spawnImpl,
    });
    type Msg = { type: string; request?: Record<string, unknown> };
    const sid = await m.settings('p', 'solta-1', null, { model: 'haiku', effort: 'low', autonomy: 'auto' });
    await tick();
    expect(sid).toBe('solta-1');
    expect(asked).toEqual({ sessionId: 'solta-1', staffId: null });
    const controls = (f.written as Msg[]).filter((x) => x.type === 'control_request').map((x) => x.request?.subtype);
    expect(controls).toEqual(expect.arrayContaining(['set_model', 'apply_flag_settings', 'set_permission_mode']));
  });
});

describe('ChatManager: trazer uma conversa aberta em outro lugar', () => {
  it('cria a cópia uma vez só, grava o vínculo e a original aponta para ela', async () => {
    const f = fakeClaude();
    const copiesFile = path.join(root, 'copies-bring.json');
    let n = 0;
    const opts = {
      transcriptsDir: root,
      usageFile: path.join(root, 'usage-bring.json'),
      copiesFile,
      listLive: async () => [],
      resolve: async (_p: string, sessionId: string | null, _s: string | null, forkFrom?: string) => {
        if (forkFrom) {
          const id = `00000000-0000-4000-8000-00000000000${++n}`;
          return { sessionId: id, cwd: root, args: ['--resume', forkFrom, '--fork-session', '--session-id', id] };
        }
        return sessionId ? { sessionId, cwd: root, args: ['--resume', sessionId] } : null;
      },
      spawnImpl: f.spawnImpl,
    };
    const m = new ChatManager(opts);
    const copy = await m.bring('p', 'original-app', null);
    expect(await m.bring('p', 'original-app', null)).toBe(copy);
    expect(n).toBe(1);
    expect((await m.snapshot('p', 'original-app')).copy).toBe(copy);
    expect((await m.snapshot('p', copy)).copy).toBeNull();
    // Depois de reiniciar o servidor, o vínculo continua (arquivo).
    expect(await new ChatManager(opts).copyOf('original-app')).toBe(copy);
    expect(JSON.parse(await fs.readFile(copiesFile, 'utf8'))).toEqual({ 'original-app': copy });
  });
});
