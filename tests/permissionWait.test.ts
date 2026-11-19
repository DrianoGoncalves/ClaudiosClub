import { EventEmitter } from 'node:events';
import { readFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StaffProfile, Task } from '../shared/model';
import { ChatManager, type ChatManagerOptions } from '../server/chat/manager';
import { PERMISSION_STUCK_MS } from '../server/retryPolicy';
import { ownAlerts, permissionStuck, stuckDependencies, stuckReason, stuckState, TaskService } from '../server/tasks';

// Tarefa com permissão pendente (t-fc9e1e): a conversa de trabalho espera o dono responder um pedido de permissão. O estado vai no GET (`permissionWait`,
// derivado do processo), passados 15 min a tarefa conta como parada (`stuckState`) e o gestor que pediu recebe UM aviso por pedido. Respondida, some.
// Nada aqui responde a permissão: só o dono, pela tela. Codex: o exec não pede permissão (a sandbox decide).

let root: string;
let n = 0;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-permwait-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const MIN = 60_000;
const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const person = (id: string, name: string, over: Partial<StaffProfile> = {}) =>
  ({ id, name, role: id.startsWith('gio') ? 'Orquestrador' : 'Back-end', autonomy: 'acceptEdits', worktree: false, servers: [], reportsTo: [], ...over }) as unknown as StaffProfile;

/** Gio é o gestor; Ana faz a tarefa. `perm.current`: a permissão que a conversa de Ana espera (o que `ChatManager.permissionWaitOf` devolveria). */
function board() {
  const dir = path.join(root, `b-${++n}`);
  const people: Record<string, StaffProfile> = { 'gio-1': person('gio-1', 'Gio'), 'ana-1': person('ana-1', 'Ana', { reportsTo: ['gio-1'] }) };
  const perm = { current: null as { tool: string; since: string } | null, asked: [] as string[] };
  const notified: Array<{ staffId: string; text: string; session: string | null }> = [];
  const sentTo: unknown[] = [];
  const notices: unknown[] = [];
  const hooks = { notifyFails: false, busy: false };
  let s = 0;
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async () => `s-${++s}`,
    // Quem responderia a permissão ou mexeria na conversa: nada disto pode rodar com a permissão pendente.
    sendTo: async (_p, session) => {
      sentTo.push(session);
      return session;
    },
    sendNotice: async (_p, session) => {
      notices.push(session);
      return session;
    },
    branchFor: async () => null,
    isWorking: () => hooks.busy, // com a conversa de Ana viva (depois de começar), o tick não a trata como órfã
    isSessionWorking: () => hooks.busy,
    permissionOf: (sessionId) => {
      perm.asked.push(sessionId);
      return perm.current;
    },
    notify: async (_p, staffId, text, session) => {
      if (hooks.notifyFails) throw new Error('conversa dele não abriu');
      notified.push({ staffId, text, session: session ?? null });
    },
    apiUrl: 'http://127.0.0.1:4848',
    log: () => {},
  });
  const list = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await list()).find((t) => t.id === id)!;
  /** Tarefa de Ana em "fazendo", pedida por Gio (conversa c-gio-1); `by: null` = pela tela. */
  const doing = async (title: string, by: string | null = 'gio-1') => {
    const t = (await svc.create('p', { title, staffId: 'ana-1', start: false, description: 'Faça.', acceptance: 'Feito.', reviewerId: null }, by, 'c-gio-1'))!;
    await svc.start('p', t.id);
    hooks.busy = true;
    return get(t.id);
  };
  return { svc, perm, notified, sentTo, notices, hooks, list, get, doing };
}

describe('o estado no GET (permissionWait)', () => {
  it('permissão pendente: ferramenta e desde quando; ainda dentro do prazo não é parada', async () => {
    const b = board();
    const t = await b.doing('A');
    expect(t.permissionWait).toBeUndefined();
    const since = ago(2);
    b.perm.current = { tool: 'Bash', since };
    const w = await b.get(t.id);
    expect(w).toMatchObject({ status: 'doing', permissionWait: { tool: 'Bash', since, stuck: false } });
    expect(b.perm.asked.at(-1)).toBe(w.sessionId); // lida da conversa de trabalho da tarefa
    expect(stuckState(w)).toBeNull();
    expect(stuckReason(w)).toBeNull();
    expect(ownAlerts([w])).toEqual([]);
  });

  it('não é gravado: o arquivo da tarefa não ganha o campo', async () => {
    const b = board();
    const t = await b.doing('A');
    b.perm.current = { tool: 'Bash', since: ago(40) };
    await b.get(t.id);
    const file = readFileSync(path.join(root, `b-${n}`, '.myco', 'tasks.json'), 'utf8');
    expect(file).not.toContain('permissionWait');
  });

  it('só tarefa em fazendo ou planejando, com conversa: revisão não lê a conversa', async () => {
    const b = board();
    const t = await b.doing('A');
    b.perm.current = { tool: 'Bash', since: ago(40) };
    expect(b.svc.withPermission({ ...t, status: 'review' }).permissionWait).toBeUndefined();
    expect(b.svc.withPermission({ ...t, status: 'planning' }).permissionWait).toMatchObject({ tool: 'Bash', stuck: true });
    expect(b.svc.withPermission({ ...t, sessionId: null }).permissionWait).toBeUndefined();
    expect(b.svc.withPermission({ ...t, autoCreated: true }).permissionWait).toBeUndefined(); // card automático: a conversa é sua, você está nela
  });

  it('respondida (permitir ou negar): o estado some e a parada também', async () => {
    const b = board();
    const t = await b.doing('A');
    b.perm.current = { tool: 'Bash', since: ago(20) };
    expect(stuckState(await b.get(t.id))).not.toBeNull();
    b.perm.current = null; // o cartão saiu de "pendente"
    const w = await b.get(t.id);
    expect(w.permissionWait).toBeUndefined();
    expect(stuckState(w)).toBeNull();
  });

  it('nome da ferramenta cortado e sem o comando: só o nome vai no GET', async () => {
    const b = board();
    const t = await b.doing('A');
    b.perm.current = { tool: 'x'.repeat(300), since: ago(1) };
    const w = await b.get(t.id);
    expect(w.permissionWait!.tool).toHaveLength(80);
    expect(Object.keys(w.permissionWait!).sort()).toEqual(['since', 'stuck', 'tool']);
  });
});

describe('depois de 15 min conta como parada (stuckState)', () => {
  it('o prazo é de 15 min, na régua da hora passada, com o motivo e sem ação sua', async () => {
    expect(PERMISSION_STUCK_MS).toBe(15 * MIN);
    const b = board();
    const t = await b.doing('A');
    const since = '2026-11-18T10:00:00.000Z';
    const at = Date.parse(since);
    b.perm.current = { tool: 'Bash', since };
    const w = await b.get(t.id);
    expect(w.permissionWait).toMatchObject({ stuck: true }); // a leitura de agora já passou de 15 min
    expect(permissionStuck(since, at + 15 * MIN - 1)).toBe(false);
    expect(permissionStuck(since, at + 15 * MIN)).toBe(true);
    expect(stuckState(w, at + 15 * MIN - 1)).toBeNull();
    expect(stuckState(w, at + 15 * MIN)).toEqual({ reason: 'esperando sua permissão: Bash há 15 min', selfHeals: false, humanAction: null, since });
    expect(stuckReason(w)).toMatch(/^esperando sua permissão: Bash há \d+ min$/);
    expect(stuckState(w, at + 47 * MIN)?.reason).toBe('esperando sua permissão: Bash há 47 min');
  });

  it('a espera de quem depende dela aparece na caixa; o item de parada/dúvida não (a permissão já tem o dela)', async () => {
    const b = board();
    const t = await b.doing('A');
    b.perm.current = { tool: 'Edit', since: ago(30) };
    const w = await b.get(t.id);
    const dep: Task = { ...w, id: 't-dep001', title: 'B', status: 'todo', sessionId: null, queuedAt: null, blockedBy: [w.id], permissionWait: undefined };
    const rows = stuckDependencies([w, dep]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task: { id: 't-dep001' }, blocker: { id: w.id }, selfHeals: false, humanAction: null, reason: expect.stringMatching(/^esperando sua permissão: Edit há 3\d min$/) });
    expect(ownAlerts([w])).toEqual([]);
  });

  it('a dúvida escalada vence a permissão (uma parada por vez)', async () => {
    const b = board();
    const t = await b.doing('A');
    b.perm.current = { tool: 'Bash', since: ago(30) };
    const w = await b.get(t.id);
    const asked = { ...w, question: { id: 'q1', status: 'escalated', askedAt: ago(50), escalatedAt: ago(20) } } as Task;
    expect(stuckState(asked)).toMatchObject({ humanAction: 'answer' });
  });
});

describe('o aviso ao gestor que pediu (uma vez por pedido)', () => {
  it('antes de 15 min não avisa; passados, avisa UMA vez, na conversa em que pediu, dizendo que só o dono responde', async () => {
    const b = board();
    const t = await b.doing('Exportar CSV');
    b.perm.current = { tool: 'Bash', since: ago(5) };
    await b.svc.tick();
    expect(b.notified).toEqual([]);

    await b.svc.tick(new Date(Date.now() + 11 * MIN)); // agora o pedido tem 16 min
    expect(b.notified).toHaveLength(1);
    expect(b.notified[0]).toMatchObject({ staffId: 'gio-1', session: 'c-gio-1' });
    const text = b.notified[0]!.text;
    expect(text).toContain('“Exportar CSV”');
    expect(text).toContain(`id ${t.id}`);
    expect(text).toContain('Ana');
    expect(text).toContain('(Bash)');
    expect(text).toMatch(/há 16 min/);
    expect(text).toMatch(/só ele responde, pela tela/);
    expect(text).toMatch(/Não permita nem negue por ele/);

    await b.svc.tick(new Date(Date.now() + 12 * MIN));
    await b.svc.tick(new Date(Date.now() + 60 * MIN));
    await b.svc.tick();
    expect(b.notified).toHaveLength(1); // o mesmo pedido não avisa de novo
  });

  it('respondida: nada mais sai; um pedido novo (outro, mais tarde) avisa de novo, também uma vez', async () => {
    const b = board();
    await b.doing('A');
    b.perm.current = { tool: 'Bash', since: ago(20) };
    await b.svc.tick();
    expect(b.notified).toHaveLength(1);

    b.perm.current = null; // o dono respondeu
    await b.svc.tick();
    await b.svc.tick(new Date(Date.now() + 30 * MIN));
    expect(b.notified).toHaveLength(1);

    b.perm.current = { tool: 'Write', since: ago(16) }; // outro pedido, já passado do prazo
    await b.svc.tick();
    await b.svc.tick();
    expect(b.notified).toHaveLength(2);
    expect(b.notified[1]!.text).toContain('(Write)');
  });

  it('aviso que não chegou tenta de novo na rodada seguinte, e depois que chega não repete', async () => {
    const b = board();
    await b.doing('A');
    b.perm.current = { tool: 'Bash', since: ago(20) };
    b.hooks.notifyFails = true;
    await b.svc.tick();
    expect(b.notified).toEqual([]);
    b.hooks.notifyFails = false;
    await b.svc.tick();
    await b.svc.tick();
    expect(b.notified).toHaveLength(1);
  });

  it('tarefa pedida pela tela (sem gestor) não avisa ninguém: a caixa já mostra o pedido ao dono', async () => {
    const b = board();
    await b.doing('A', null);
    b.perm.current = { tool: 'Bash', since: ago(40) };
    await b.svc.tick();
    expect(b.notified).toEqual([]);
  });

  it('nada responde a permissão nem mexe na conversa: o aviso é só informativo', async () => {
    const b = board();
    const t = await b.doing('A');
    b.perm.current = { tool: 'Bash', since: ago(40) };
    await b.svc.tick();
    await b.svc.tick(new Date(Date.now() + 40 * MIN));
    await sleep(25);
    expect(b.notified).toHaveLength(1);
    expect(b.sentTo).toEqual([]);
    expect(b.notices).toEqual([]);
    expect(b.perm.current).not.toBeNull(); // o pedido segue pendente: negar sozinho depois do prazo não existe
    expect(await b.get(t.id)).toMatchObject({ status: 'doing', permissionWait: { tool: 'Bash', stuck: true } }); // e a tarefa não saiu de fazendo
  });

  it('o código não tem como responder: o serviço não recebe nenhum "responder permissão" e o tick não cita a resposta', () => {
    const src = readFileSync(path.join(__dirname, '..', 'server', 'tasks.ts'), 'utf8');
    const step = /private async warnPermissions[\s\S]*?\n  \}\n/.exec(src)![0];
    expect(step).not.toMatch(/answer|dismissPending|allow|deny/i);
    const index = readFileSync(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    expect(index).toContain('permissionOf: (sessionId) => chats.permissionWaitOf(sessionId),');
    expect(index).toContain('.map((t) => tasks.withPermission(t))'); // a caixa lê a mesma regra (dependentes da tarefa parada)
  });
});

// ---- a leitura da conversa (ChatManager.permissionWaitOf) ----

function fakeClaude() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: 4242, kill: () => proc.emit('exit', 0) });
  stdin.on('data', () => {});
  const emit = (ev: object) => stdout.write(JSON.stringify(ev) + '\n');
  return { proc, emit };
}

const tick = () => sleep(15);

describe('ChatManager.permissionWaitOf (Claude)', () => {
  function manager(extra: Partial<ChatManagerOptions> = {}) {
    const procs: Array<ReturnType<typeof fakeClaude>> = [];
    const dir = path.join(root, `c-${++n}`);
    const m = new ChatManager({
      transcriptsDir: dir,
      usageFile: path.join(dir, 'usage.json'),
      listLive: async () => [],
      resolve: async (_p, sid) => ({ sessionId: sid ?? 'sx', cwd: '.', args: ['--permission-mode', 'acceptEdits'] }),
      spawnImpl: ((_cmd: string, _args: string[]) => {
        const f = fakeClaude();
        f.proc.stdin.on('finish', () => f.proc.emit('exit', 0));
        procs.push(f);
        return f.proc as never;
      }) as never,
      log: () => {},
      ...extra,
    });
    return { m, procs };
  }
  const request = (f: ReturnType<typeof fakeClaude>, id: string, tool: string, input: object = {}) =>
    f.emit({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, input } });

  it('devolve a ferramenta e a hora do pedido pendente; respondido (permitir ou negar), some', async () => {
    const { m, procs } = manager();
    await m.send('p', 'sx', 'ana', 'rode');
    expect(m.permissionWaitOf('sx')).toBeNull();
    const before = Date.now();
    request(procs[0]!, 'r1', 'Bash', { command: 'rm -rf /' });
    await tick();
    const w = m.permissionWaitOf('sx')!;
    expect(w.tool).toBe('Bash');
    expect(Date.parse(w.since)).toBeGreaterThanOrEqual(before - 5);
    expect(Object.keys(w).sort()).toEqual(['since', 'tool']); // nem o comando nem o resumo saem daqui

    expect(m.answer('sx', 'r1', true)).toBe(true); // o dono permite (a resposta da tela)
    await tick();
    expect(m.permissionWaitOf('sx')).toBeNull();

    request(procs[0]!, 'r2', 'Write', { file_path: 'x.txt', content: '' });
    await tick();
    expect(m.permissionWaitOf('sx')?.tool).toBe('Write');
    expect(m.answer('sx', 'r2', false)).toBe(true); // ou nega
    await tick();
    expect(m.permissionWaitOf('sx')).toBeNull();
  });

  it('com mais de uma pendente, vale a mais antiga; ao responder a primeira, vale a seguinte', async () => {
    const { m, procs } = manager();
    await m.send('p', 'sx', 'ana', 'rode');
    request(procs[0]!, 'r1', 'Bash');
    await sleep(5);
    request(procs[0]!, 'r2', 'Write');
    await tick();
    const first = m.permissionWaitOf('sx')!;
    expect(first.tool).toBe('Bash');
    m.answer('sx', 'r1', true);
    await tick();
    const second = m.permissionWaitOf('sx')!;
    expect(second.tool).toBe('Write');
    expect(second.since >= first.since).toBe(true);
  });

  it('pergunta com opções não conta (o gestor a responde); plano pronto conta', async () => {
    const { m, procs } = manager({ onAsk: () => {} });
    await m.send('p', 'sx', 'ana', 'pergunte');
    const banco = { question: 'Qual banco?', header: 'Banco', multiSelect: false, options: [{ label: 'SQLite' }, { label: 'Postgres' }] };
    request(procs[0]!, 'a1', 'AskUserQuestion', { questions: [banco] });
    await tick();
    expect(m.attention()[0]!.pending).toHaveLength(1); // a caixa mostra
    expect(m.permissionWaitOf('sx')).toBeNull(); // mas não é permissão do dono
    request(procs[0]!, 'r9', 'ExitPlanMode', { plan: '# Plano' });
    await tick();
    expect(m.permissionWaitOf('sx')?.tool).toBe('ExitPlanMode');
  });

  it('conversa fechada ou que não existe: nada', async () => {
    const { m, procs } = manager();
    await m.send('p', 'sx', 'ana', 'rode');
    request(procs[0]!, 'r1', 'Bash');
    await tick();
    expect(m.permissionWaitOf('sx')).not.toBeNull();
    expect(m.permissionWaitOf('nao-existe')).toBeNull();
    procs[0]!.proc.emit('exit', 1); // o processo caiu: o pedido caiu junto
    await tick();
    expect(m.permissionWaitOf('sx')).toBeNull();
  });
});

describe('Codex: não se aplica (o exec não pede permissão, a sandbox decide)', () => {
  function fakeCodex() {
    const runs: Array<{ emit: (ev: object) => void; close: (code?: number | null) => void }> = [];
    const spawnImpl = () => {
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), { stdin: Object.assign(new PassThrough(), {}), stdout, stderr: new PassThrough() });
      child.stdin.on('data', () => {});
      runs.push({ emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n'), close: (code = 0) => void child.emit('close', code) });
      return child as never;
    };
    return { runs, spawnImpl };
  }

  it('a execução com comando, edição e comando barrado pela sandbox nunca vira pedido pendente', async () => {
    const f = fakeCodex();
    const dir = path.join(root, `x-${++n}`);
    const m = new ChatManager({
      transcriptsDir: dir,
      usageFile: path.join(dir, 'usage.json'),
      listLive: async () => [],
      resolve: async (_p, sid) => ({
        sessionId: sid ?? 'codex-1',
        cwd: root,
        args: [],
        engine: 'codex',
        codex: {
          autonomy: 'acceptEdits',
          model: 'gpt-6-sol',
          effort: 'high',
          instructions: 'Ficha',
          writableRoots: [],
          readOnlyPaths: [],
          agents: [],
          secrets: { projectPath: root, home: path.join(root, 'sem-home'), mycoHome: path.join(root, 'sem-myco') },
          threadId: 'thread-0001-aaaa',
          threadFile: path.join(dir, 'codex-thread.json'),
          mycoUrl: 'http://127.0.0.2:4848',
        },
      }),
      spawnImpl: f.spawnImpl,
      log: () => {},
    });
    await m.send('p', 'cx', 'cris', 'faça a tarefa');
    await vi.waitFor(() => expect(f.runs.length).toBeGreaterThan(0));
    const run = f.runs.at(-1)!;
    run.emit({ type: 'turn.started' });
    run.emit({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: '', status: 'in_progress' } });
    run.emit({ type: 'item.completed', item: { id: 'c2', type: 'command_execution', command: 'rm -rf /', aggregated_output: '', status: 'declined' } });
    run.emit({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }], status: 'completed' } });
    run.emit({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } }); // nem o formato do Claude entra
    await tick();
    expect(m.isWorking('cx')).toBe(true);
    expect(m.permissionWaitOf('cx')).toBeNull();
    expect(m.attention()).toEqual([]);
    run.emit({ type: 'turn.completed' });
    run.close(0);
    await vi.waitFor(() => expect(m.isWorking('cx')).toBe(false));
  });
});
