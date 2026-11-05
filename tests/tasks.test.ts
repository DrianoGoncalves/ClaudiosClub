import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { ChatManager } from '../server/chat/manager';
import { parseVerdict, TaskService } from '../server/tasks';
import { cleanRunDir } from '../server/runCleanup';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-tasks-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function service(dirName: string, autonomy: StaffProfile['autonomy'] = 'acceptEdits') {
  const dir = path.join(root, dirName);
  const sent: Array<{ staffId: string; text: string }> = [];
  const ana = { id: 'ana-1', name: 'Ana', autonomy, worktree: true } as StaffProfile;
  const svc = new TaskService({
    projectPath: async (id) => (id === 'p' ? dir : null),
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
    send: async (_p, staffId, text) => {
      sent.push({ staffId, text });
      return 'sess-1';
    },
    branchFor: async (_d, p) => (p.worktree ? `myco/${p.id}` : 'main'),
  });
  return { svc, sent, dir };
}

describe('limpeza de ~/.myco/run', () => {
  it('apaga só pastas de sessão antigas; arquivos e pastas com outro nome ficam', async () => {
    const run = path.join(root, 'run');
    const oldId = '11111111-2222-3333-4444-555555555555';
    const newId = '66666666-7777-8888-9999-000000000000';
    for (const d of [oldId, newId, 'outra-coisa']) {
      await fs.mkdir(path.join(run, d), { recursive: true });
      await fs.writeFile(path.join(run, d, 'mcp.json'), '{}');
    }
    await fs.writeFile(path.join(run, 'chats.json'), '{}');
    const old = new Date(Date.now() - 5 * 24 * 60 * 60_000);
    await fs.utimes(path.join(run, oldId), old, old);
    await fs.utimes(path.join(run, 'outra-coisa'), old, old);
    expect(await cleanRunDir(run)).toBe(1);
    expect((await fs.readdir(run)).sort()).toEqual([newId, 'chats.json', 'outra-coisa'].sort());
  });
});

describe('tarefas por projeto', () => {
  it('cria, começa numa conversa nova e anda sozinha: fazendo → revisão → fazendo', async () => {
    const { svc, sent, dir } = service('a');
    const t = (await svc.create('p', { title: 'Botão de exportar', description: 'CSV na tela de relatórios', staffId: 'ana-1' }))!;
    expect(t).toMatchObject({ status: 'todo', staffId: 'ana-1', sessionId: null });

    const started = (await svc.start('p', t.id))!;
    expect(started).toMatchObject({ status: 'doing', sessionId: 'sess-1', branch: 'myco/ana-1' });
    expect(sent[0]!.text).toContain('[Tarefa "Botão de exportar"]');
    expect(sent[0]!.text).toContain('CSV na tela de relatórios');
    await expect(svc.start('p', t.id)).rejects.toThrow(/já começou/);

    await svc.onTurnDone('sess-1');
    expect((await svc.list('p'))![0]!.status).toBe('review');
    await svc.onSent('sess-1');
    expect((await svc.list('p'))![0]!.status).toBe('doing');
    await svc.onTurnDone('outra-sessao'); // de outra conversa: nada muda
    expect((await svc.list('p'))![0]!.status).toBe('doing');

    // Fica no disco do projeto, com o histórico das colunas.
    const saved = JSON.parse(await fs.readFile(path.join(dir, '.myco', 'tasks.json'), 'utf8'));
    expect(saved[0].history.map((h: { status: string }) => h.status)).toEqual(['todo', 'doing', 'review', 'doing']);
  });

  it('com a ficha em "só planeja": planejando, e o plano aprovado leva para fazendo', async () => {
    const { svc } = service('b', 'plan');
    const t = (await svc.create('p', { title: 'Refatorar o login', staffId: 'ana-1' }))!;
    expect((await svc.start('p', t.id))!.status).toBe('planning');
    await svc.onTurnDone('sess-1'); // terminou o turno com o plano pendente: continua planejando
    expect((await svc.list('p'))![0]!.status).toBe('planning');
    await svc.onPlanApproved('sess-1', '1. Extrair o serviço\n2. Testes');
    expect((await svc.list('p'))![0]).toMatchObject({ status: 'doing', plan: '1. Extrair o serviço\n2. Testes' });
  });

  it('pede revisão a outro funcionário e deploy ao de infra; a resposta de cada um fica no histórico', async () => {
    const dir = path.join(root, 'd');
    const sent: Array<{ staffId: string; text: string }> = [];
    const people: Record<string, StaffProfile> = {
      'ana-1': { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false, servers: [] } as unknown as StaffProfile,
      'rev-1': { id: 'rev-1', name: 'Rui', autonomy: 'manual', worktree: false, servers: [] } as unknown as StaffProfile,
      'ops-1': { id: 'ops-1', name: 'Ícaro', autonomy: 'manual', worktree: false, servers: ['VPS'] } as unknown as StaffProfile,
    };
    let n = 0;
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId, text) => {
        sent.push({ staffId, text });
        return `s-${++n}`;
      },
      branchFor: async () => null,
    });
    const t = (await svc.create('p', { title: 'Exportar CSV', description: 'Na tela de relatórios', staffId: 'ana-1' }))!;
    await svc.start('p', t.id); // s-1
    await expect(svc.requestReview('p', t.id, 'ana-1')).rejects.toThrow(/outro funcionário/);
    const reviewed = (await svc.requestReview('p', t.id, 'rev-1'))!; // s-2
    expect(reviewed).toMatchObject({ status: 'review', review: { staffId: 'rev-1', sessionId: 's-2' } });
    expect(sent[1]!.text).toMatch(/\[Revisão da tarefa "Exportar CSV"\][\s\S]*APROVADO/);
    await svc.onTurnDone('s-2'); // o revisor respondeu: não muda de coluna, anota
    const afterReview = (await svc.list('p'))![0]!;
    expect(afterReview.status).toBe('review');
    expect(afterReview.review?.doneAt).toBeTruthy();
    expect(afterReview.history.at(-1)?.note).toBe('revisão respondida');

    await expect(svc.requestDeploy('p', t.id, 'rev-1')).rejects.toThrow(/não tem acesso a servidores/);
    await svc.update('p', t.id, { status: 'done' });
    const deploying = (await svc.requestDeploy('p', t.id, 'ops-1'))!; // s-3
    expect(deploying).toMatchObject({ status: 'done', deploy: { staffId: 'ops-1', sessionId: 's-3' } });
    expect(sent[2]!.text).toMatch(/\[Deploy da tarefa "Exportar CSV"\][\s\S]*backup[\s\S]*runbook/);
    await svc.onTurnDone('s-3');
    await svc.update('p', t.id, { status: 'live' });
    expect((await svc.summary()).p).toMatchObject({ open: 0, lastDeploy: { title: 'Exportar CSV', by: 'ops-1' } });
  });

  it('valida, edita, move à mão e apaga; o índice sessão → tarefa sobrevive a um reinício', async () => {
    const { svc } = service('c');
    await expect(svc.create('p', { title: ' ' })).rejects.toThrow(/título/);
    await expect(svc.create('p', { title: 'x', staffId: 'ninguem' })).rejects.toThrow(/não encontrado/);
    const t = (await svc.create('p', { title: 'Sem dono' }))!;
    await expect(svc.start('p', t.id)).rejects.toThrow(/escolha quem/);
    await expect(svc.update('p', t.id, { pr: 'nao-e-link' })).rejects.toThrow(/link/);
    expect(await svc.update('p', t.id, { status: 'done', pr: 'https://github.com/x/y/pull/1' })).toMatchObject({ status: 'done', pr: 'https://github.com/x/y/pull/1' });
    expect(await svc.summary()).toEqual({});

    const u = (await svc.create('p', { title: 'Outra', staffId: 'ana-1' }))!;
    await svc.start('p', u.id);
    const { svc: fresh } = service('c'); // "reiniciou": índice vazio, achado pelo disco
    await fresh.onTurnDone('sess-1');
    expect((await fresh.list('p'))!.find((x) => x.id === u.id)!.status).toBe('review');
    expect(await fresh.summary()).toEqual({ p: { open: 1, review: 1, lastDeploy: null } });

    expect(await svc.remove('p', t.id)).toBe(true);
    expect(await svc.remove('p', t.id)).toBe(false);
    expect(await svc.list('outro')).toBeNull();
  });
});

describe('tarefa pedida por um gestor', () => {
  it('a pessoa sabe quem pediu; na entrega, o gestor recebe o resumo para conferir', async () => {
    const dir = path.join(root, 'gestor');
    const sent: Array<{ staffId: string; text: string }> = [];
    const notified: Array<{ staffId: string; text: string }> = [];
    const people: Record<string, StaffProfile> = {
      'gio-1': { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'lu-1': { id: 'lu-1', name: 'Luana', role: 'Design system', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    };
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId, text) => (sent.push({ staffId, text }), 's-lu'),
      branchFor: async () => null,
      notify: async (_p, staffId, text) => void notified.push({ staffId, text }),
      lastText: () => 'Troquei os tokens de cor do botão.',
    });
    const t = (await svc.create('p', { title: 'Botão no DS', description: 'Usar os tokens novos', staffId: 'lu-1' }, 'gio-1'))!;
    expect(t).toMatchObject({ requestedBy: 'gio-1', history: [{ by: 'auto', note: 'pedida por Giovana' }] });
    await svc.start('p', t.id);
    expect(sent[0]).toMatchObject({ staffId: 'lu-1', text: expect.stringContaining('Pedida por Giovana (Orquestradora)') });

    await svc.onTurnDone('s-lu'); // Luana entregou
    expect(notified).toEqual([{ staffId: 'gio-1', text: expect.stringMatching(/Luana entregou a tarefa “Botão no DS”[\s\S]*Troquei os tokens de cor do botão/) }]);
    await svc.onIdle('s-lu', 'p', 'lu-1'); // o segundo aviso do mesmo fim não repete
    expect(notified).toHaveLength(1);
  });

  it('a entrega volta para a conversa em que o gestor pediu, já com os testes rodados pelo Claudio’s Club', async () => {
    const dir = path.join(root, 'gestor-testes');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const notified: Array<{ text: string; sessionId: string | null | undefined }> = [];
    const ran: string[] = [];
    const people: Record<string, StaffProfile> = {
      'gio-1': { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'lu-1': { id: 'lu-1', name: 'Luana', role: 'Front-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    };
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async () => 's-lu2',
      branchFor: async () => null,
      notify: async (_p, _s, text, sessionId) => void notified.push({ text, sessionId }),
      lastText: () => 'Pronto.',
      // Giovana está no turno em que chamou a API: é para essa conversa que a entrega volta.
      requesterSession: (staffId) => (staffId === 'gio-1' ? 's-gio-pediu' : null),
      runTests: async (cwd, command) => (ran.push(`${cwd}|${command}`), { command, ok: false, output: 'FAIL botao.test.ts', ms: 4200, at: '2026-10-28T12:00:00Z' }),
    });
    const t = (await svc.create('p', { title: 'Botão', description: '', staffId: 'lu-1' }, 'gio-1'))!;
    expect(t.requestedSession).toBe('s-gio-pediu');
    await svc.start('p', t.id);
    await svc.onTurnDone('s-lu2');
    expect(ran).toEqual([`${dir}|npm test`]);
    expect(notified).toEqual([{ sessionId: 's-gio-pediu', text: expect.stringContaining('FALHARAM. Fim da saída:\nFAIL botao.test.ts') }]);
    expect((await svc.list('p'))![0]!.tests).toMatchObject({ ok: false, command: 'npm test' });
  });
});

describe('fila por funcionário', () => {
  function queued(dirName: string) {
    const dir = path.join(root, dirName);
    const sent: Array<{ text: string; session: string }> = [];
    const delivered: Array<{ sessionId: string; text: string; images: string[] }> = [];
    /** Conversas trabalhando agora (o que o ChatManager sabe). */
    const working = new Set<string>();
    let n = 0;
    const ana = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
      send: async (_p, _staffId, text) => {
        const session = `s-${++n}`;
        sent.push({ text, session });
        working.add(session);
        return session;
      },
      branchFor: async () => null,
      isWorking: (_staffId, except) => [...working].some((s) => s !== except),
      sendTo: async (_p, sessionId, _staffId, text, images) => {
        delivered.push({ sessionId, text, images });
        working.add(sessionId);
        return sessionId;
      },
    });
    // O turno acabou: o processo da conversa avisa (onIdle) e o vigia de sessões também (onTurnDone);
    // turno curto o vigia perde, então o processo vem primeiro e o segundo aviso não muda nada.
    const finish = async (session: string) => {
      working.delete(session);
      await svc.onIdle(session, 'p', 'ana-1');
      await svc.onTurnDone(session);
    };
    const make = async (title: string) => (await svc.create('p', { title, staffId: 'ana-1' }))!;
    return { svc, sent, delivered, working, finish, make };
  }

  it('uma por vez: as outras entram na fila e a próxima começa quando a atual vai para revisão', async () => {
    const { svc, sent, finish, make } = queued('q1');
    const [a, b, c] = [await make('A'), await make('B'), await make('C')];
    expect((await svc.start('p', a.id))!.status).toBe('doing');
    const qb = (await svc.start('p', b.id))!;
    expect(qb).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String) });
    expect(qb.history.at(-1)?.note).toBe('na fila de Ana, depois de “A”');
    await svc.start('p', c.id);
    expect(sent).toHaveLength(1);

    await finish('s-1');
    const list = (await svc.list('p'))!;
    expect(list.map((t) => [t.title, t.status])).toEqual([
      ['A', 'review'],
      ['B', 'doing'],
      ['C', 'todo'],
    ]);
    expect(sent[1]!.text).toContain('[Tarefa "B"]');
    expect(list[1]!.queuedAt).toBeNull();

    // Tirou da fila: quando B entregar, C não começa.
    await svc.update('p', c.id, { queued: false });
    await finish('s-2');
    expect(sent).toHaveLength(2);
  });

  it('turno curto que o vigia de sessões não viu: o aviso do processo basta', async () => {
    const { svc, sent, working, make } = queued('q3');
    const [a, b] = [await make('A'), await make('B')];
    await svc.start('p', a.id); // s-1
    await svc.start('p', b.id); // fila
    working.delete('s-1');
    await svc.onIdle('s-1', 'p', 'ana-1'); // só o processo avisou
    expect((await svc.list('p'))!.map((t) => t.status)).toEqual(['review', 'doing']);
    expect(sent.at(-1)!.text).toContain('[Tarefa "B"]');
  });

  it('ajuste numa tarefa anterior espera a vez e vai antes da próxima da fila', async () => {
    const { svc, sent, delivered, finish, make } = queued('q2');
    const [a, b, c] = [await make('A'), await make('B'), await make('C')];
    await svc.start('p', a.id); // s-1
    await finish('s-1'); // A em revisão
    await svc.start('p', b.id); // livre: começa já (s-2)
    await svc.start('p', c.id); // fila, depois de B

    expect(await svc.hold('s-1', { text: 'faltou o cabeçalho' })).toBe('espera Ana terminar “B”');
    expect(await svc.heldItems('s-1')).toEqual([expect.objectContaining({ kind: 'user', text: 'faltou o cabeçalho', held: 'espera Ana terminar “B”' })]);
    expect(await svc.hold('s-2', { text: 'na B mesmo' })).toBeNull(); // a conversa em que ela está: vai já

    await finish('s-2');
    expect(delivered).toEqual([{ sessionId: 's-1', text: 'faltou o cabeçalho', images: [] }]);
    expect(sent).toHaveLength(2); // C ainda espera: ela está no ajuste da A
    expect(await svc.heldItems('s-1')).toEqual([]);

    await svc.onSent('s-1'); // o que o ChatManager faz ao mandar: A volta para "fazendo"
    await finish('s-1');
    expect(sent.at(-1)!.text).toContain('[Tarefa "C"]');
    expect((await svc.list('p'))!.find((t) => t.id === a.id)!.history.map((h) => h.note)).toContain('ajuste guardado enviado');
  });
});

describe('conversa da tarefa que morreu no meio do turno', () => {
  /** Ana com A fazendo (s-1) e B na fila. `working`: o que o ChatManager sabe; tirar dali sem onIdle = o processo morreu. */
  async function orphaned(dirName: string, awaitingLimit?: () => Promise<boolean>) {
    const dir = path.join(root, dirName);
    const sent: string[] = [];
    const delivered: Array<{ sessionId: string; text: string }> = [];
    const working = new Set<string>();
    let n = 0;
    const ana = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
      send: async (_p, _s, text) => {
        const session = `s-${++n}`;
        sent.push(text);
        working.add(session);
        return session;
      },
      branchFor: async () => null,
      isWorking: (_s, except) => [...working].some((s) => s !== except),
      sendTo: async (_p, sessionId, _s, text) => {
        delivered.push({ sessionId, text });
        working.add(sessionId);
        return sessionId;
      },
      ...(awaitingLimit && { awaitingLimit }),
    });
    const a = (await svc.create('p', { title: 'A', staffId: 'ana-1' }))!;
    const b = (await svc.create('p', { title: 'B', staffId: 'ana-1' }))!;
    await svc.start('p', a.id); // s-1
    await svc.start('p', b.id); // fila
    const later = (min: number) => new Date(Date.now() + min * 60_000);
    const task = async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)!;
    return { svc, sent, delivered, working, a, b, later, task };
  }

  it('parada sem onIdle: retoma a conversa uma vez, e segue em fazendo', async () => {
    const { svc, delivered, working, a, later, task } = await orphaned('orfa-1');
    working.delete('s-1'); // o servidor caiu no meio do turno
    await svc.tick(later(3));
    expect(delivered).toEqual([{ sessionId: 's-1', text: expect.stringContaining('Continue de onde parou') }]);
    const t = await task(a.id);
    expect(t).toMatchObject({ status: 'doing', resumedAt: expect.any(String) });
    expect(t.history.at(-1)?.note).toBe('conversa parou sem terminar: retomada');
    await svc.tick(later(3)); // trabalhando de novo: nada
    expect(delivered).toHaveLength(1);
    // O turno retomado termina: entrega normal (a sessão é conhecida).
    working.delete('s-1');
    await svc.onIdle('s-1', 'p', 'ana-1');
    expect((await task(a.id)).status).toBe('review');
  });

  it('retomada de conversa que morreu com comando em segundo plano: o aviso do claude não entrega a tarefa', async () => {
    // ChatManager de verdade, com um claude falso que emite o que o 2.1.310 emite ao retomar (capturado sem
    // chamada à API): o aviso de que o comando parou vira um "turno" só de histórico (init e result com
    // num_turns 0) antes do turno da nossa mensagem.
    const dir = path.join(root, 'orfa-aviso');
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: 4242, kill: () => {} });
    const emit = (ev: object) => stdout.write(JSON.stringify(ev) + '\n');
    const idle: Array<Promise<void>> = [];
    const settle = async () => {
      await new Promise((r) => setTimeout(r, 20));
      await Promise.all(idle);
    };
    const ana = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
    let svc: TaskService | null = null;
    const chats = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage-aviso.json'),
      listLive: async () => [],
      resolve: async (_p, sid) => ({ sessionId: sid!, cwd: '.', args: ['--resume', sid!] }),
      spawnImpl: () => proc as never,
      onIdle: (sid, pid, staffId) => void idle.push(svc!.onIdle(sid, pid, staffId)),
    });
    svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
      send: async () => 's-1', // a conversa da tarefa começou antes do reinício
      branchFor: async () => null,
      isWorking: (s, except) => chats.staffWorking(s, except),
      sendTo: (p, sid, s, text, images) => chats.send(p, sid, s, text, 'next', images),
    });
    const a = (await svc.create('p', { title: 'A', staffId: 'ana-1' }))!;
    await svc.start('p', a.id);
    const status = async () => (await svc!.list('p'))!.find((t) => t.id === a.id)!.status;

    await svc.tick(new Date(Date.now() + 3 * 60_000)); // o servidor subiu e a conversa não está aberta: retoma
    emit({ type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'toolu_1', status: 'stopped', summary: "Background shell command didn't finish before the previous session ended" });
    emit({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' });
    emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '', origin: { kind: 'task-notification' } });
    emit({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' });
    emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Retomando: o Vite parou com o reinício.' }] } });
    await settle();
    expect(await status()).toBe('doing');
    expect(chats.isWorking('s-1')).toBe(true);
    expect(idle).toHaveLength(0);

    // O turno da retomada termina de verdade: aí sim é entrega.
    emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, result: 'Pronto.' });
    await settle();
    expect(await status()).toBe('review');
  });

  it('retomada e morreu de novo: vai para revisão e a próxima da fila começa', async () => {
    const { svc, sent, delivered, working, a, b, later, task } = await orphaned('orfa-2');
    working.delete('s-1');
    await svc.tick(later(3)); // retoma
    working.delete('s-1'); // morreu de novo
    await svc.tick(later(4)); // ainda dentro da janela desde a retomada
    expect((await task(a.id)).status).toBe('doing');
    await svc.tick(later(6));
    expect(delivered).toHaveLength(1); // não retoma de novo
    const t = await task(a.id);
    expect(t.status).toBe('review');
    expect(t.history.at(-1)?.note).toBe('conversa parou sem terminar');
    expect((await task(b.id)).status).toBe('doing');
    expect(sent.at(-1)).toContain('[Tarefa "B"]');
  });

  it('morreu de novo, pedida por um gestor: ele é avisado da interrupção, sem testes nem revisão automática', async () => {
    const dir = path.join(root, 'orfa-gestor');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const sent: Array<{ staffId: string; text: string }> = [];
    const notified: Array<{ staffId: string; text: string }> = [];
    const ran: string[] = [];
    const working = new Set<string>();
    let n = 0;
    const people: Record<string, StaffProfile> = {
      'gio-1': { id: 'gio-1', name: 'Giovana', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'ana-1': { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'rev-1': { id: 'rev-1', name: 'Rui', autonomy: 'manual', worktree: false } as StaffProfile,
    };
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId, text) => {
        const session = `s-${++n}`;
        sent.push({ staffId, text });
        working.add(session);
        return session;
      },
      branchFor: async () => null,
      isWorking: (_s, except) => [...working].some((s) => s !== except),
      sendTo: async (_p, sessionId) => (working.add(sessionId), sessionId),
      notify: async (_p, staffId, text) => void notified.push({ staffId, text }),
      lastText: () => 'Fiz metade do formulário.',
      runTests: async (_cwd, command) => (ran.push(command), { command, ok: true, output: '', ms: 1, at: '2026-11-04T12:00:00Z' }),
    });
    const a = (await svc.create('p', { title: 'Formulário', staffId: 'ana-1', reviewerId: 'rev-1' }, 'gio-1'))!;
    await svc.start('p', a.id); // s-1
    const later = (min: number) => new Date(Date.now() + min * 60_000);
    working.delete('s-1');
    await svc.tick(later(3)); // retoma
    working.delete('s-1'); // morreu de novo
    await svc.tick(later(6));

    expect((await svc.list('p'))![0]!.status).toBe('review');
    expect(notified).toEqual([{ staffId: 'gio-1', text: expect.stringContaining(`parou duas vezes sem terminar`) }]);
    expect(notified[0]!.text).toContain(`(id ${a.id})`);
    expect(notified[0]!.text).toContain('Fiz metade do formulário.');
    expect(ran).toEqual([]); // sem testes
    expect(sent.map((s) => s.staffId)).toEqual(['ana-1']); // o revisor não foi chamado
  });

  it('conversa trabalhando não é tocada', async () => {
    const { svc, delivered, a, later, task } = await orphaned('orfa-3');
    await svc.tick(later(30));
    expect(delivered).toEqual([]);
    expect(await task(a.id)).toMatchObject({ status: 'doing' });
    expect((await task(a.id)).resumedAt).toBeUndefined();
  });

  it('parada no limite de uso (ou com despertador), ou erro ao perguntar: não é tocada', async () => {
    for (const [dirName, ask] of [
      ['orfa-4', async () => true],
      ['orfa-4b', async () => Promise.reject(new Error('sem resposta'))],
    ] as const) {
      const { svc, delivered, working, a, later, task } = await orphaned(dirName, ask);
      working.delete('s-1');
      await svc.tick(later(30));
      expect(delivered).toEqual([]);
      expect((await task(a.id)).status).toBe('doing');
    }
  });

  it('recém-começada (dentro da janela) não é tocada; depois dela, sim', async () => {
    const { svc, delivered, working, later } = await orphaned('orfa-5');
    working.delete('s-1');
    await svc.tick(); // agora
    await svc.tick(later(1));
    expect(delivered).toEqual([]);
    await svc.tick(later(3));
    expect(delivered).toHaveLength(1);
  });
});

describe('limite de uso no meio da tarefa', () => {
  /** Giovana pede, Luana faz. `limit.waiting` diz se a conversa da Luana parou no limite com o "continue" agendado. */
  function limited(dirName: string, opts: { awaitingLimit?: (sessionId: string) => Promise<boolean> } = {}) {
    const dir = path.join(root, dirName);
    const notified: string[] = [];
    const reviewed: string[] = [];
    const sent: string[] = [];
    const limit = { waiting: true, asked: [] as string[] };
    let n = 0;
    const people: Record<string, StaffProfile> = {
      'gio-1': { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'lu-1': { id: 'lu-1', name: 'Luana', role: 'Front-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'rev-1': { id: 'rev-1', name: 'Rui', autonomy: 'manual', worktree: false } as StaffProfile,
    };
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId, text) => {
        const session = `s-${++n}`;
        (staffId === 'rev-1' ? reviewed : sent).push(text);
        return session;
      },
      branchFor: async () => null,
      notify: async (_p, _s, text) => void notified.push(text),
      lastText: () => 'Fiz até aqui.',
      awaitingLimit:
        opts.awaitingLimit ??
        (async (sid) => {
          limit.asked.push(sid);
          return limit.waiting;
        }),
    });
    const make = async (title: string, reviewerId: string | null = null) => (await svc.create('p', { title, staffId: 'lu-1', reviewerId }, 'gio-1'))!;
    const status = async () => (await svc.list('p'))!.map((t) => [t.title, t.status]);
    return { svc, notified, reviewed, sent, limit, make, status };
  }

  it('turno parado pelo limite com "continue" agendado: não entrega, não avisa o gestor e a fila não anda', async () => {
    const { svc, notified, sent, limit, make, status } = limited('limite-1');
    const [a, b] = [await make('A'), await make('B')];
    await svc.start('p', a.id); // s-1
    await svc.start('p', b.id); // fila da Luana
    expect(sent).toHaveLength(1);

    // As duas origens do fim de turno: o processo da conversa (onIdle) e o vigia de sessões (onTurnDone).
    await svc.onIdle('s-1', 'p', 'lu-1');
    await svc.onTurnDone('s-1');
    expect(limit.asked).toEqual(['s-1', 's-1']);
    expect(await status()).toEqual([['A', 'doing'], ['B', 'todo']]);
    expect(notified).toEqual([]);
    expect(sent).toHaveLength(1);
    const list = (await svc.list('p'))!;
    expect(list[0]!.history.map((h) => h.note)).not.toContain('turno terminou');
    expect(list[1]!.queuedAt).toEqual(expect.any(String)); // B segue na fila

    // O "continue" rodou e o turno terminou de verdade: a entrega segue normal.
    limit.waiting = false;
    await svc.onIdle('s-1', 'p', 'lu-1');
    expect(await status()).toEqual([['A', 'review'], ['B', 'doing']]);
    expect(notified).toEqual([expect.stringContaining('Luana entregou a tarefa “A”')]);
    expect(sent).toHaveLength(2);
  });

  it('só o vigia de sessões vendo o fim (com atraso): a pendência também segura a entrega', async () => {
    const { svc, notified, make, status } = limited('limite-2');
    const t = await make('A');
    await svc.start('p', t.id);
    await svc.onTurnDone('s-1');
    expect(await status()).toEqual([['A', 'doing']]);
    expect(notified).toEqual([]);
  });

  it('sem pendência (opção desligada ou cancelada): entrega como antes', async () => {
    const { svc, notified, limit, make, status } = limited('limite-3');
    limit.waiting = false;
    const t = await make('A');
    await svc.start('p', t.id);
    await svc.onIdle('s-1', 'p', 'lu-1');
    expect(await status()).toEqual([['A', 'review']]);
    expect(notified).toHaveLength(1);
  });

  it('sem a dependência, ou com erro ao perguntar: entrega como antes', async () => {
    const plain = service('limite-4');
    const t = (await plain.svc.create('p', { title: 'A', staffId: 'ana-1' }))!;
    await plain.svc.start('p', t.id);
    await plain.svc.onTurnDone('sess-1');
    expect((await plain.svc.list('p'))![0]!.status).toBe('review');

    const broken = limited('limite-5', {
      awaitingLimit: async () => {
        throw new Error('sem resposta');
      },
    });
    const b = await broken.make('B');
    await broken.svc.start('p', b.id);
    await broken.svc.onIdle('s-1', 'p', 'lu-1');
    expect(await broken.status()).toEqual([['B', 'review']]);
    expect(broken.notified).toHaveLength(1);
  });

  it('a pendência vale só para a conversa de trabalho: a revisão automática segue o seu caminho', async () => {
    const { svc, reviewed, limit, make, status } = limited('limite-6');
    const t = await make('A', 'rev-1');
    await svc.start('p', t.id); // s-1
    await svc.onTurnDone('s-1'); // parou no limite: não entrega, o revisor não é chamado
    expect(reviewed).toEqual([]);
    limit.waiting = false;
    await svc.onTurnDone('s-1');
    expect(await status()).toEqual([['A', 'review']]);
    expect(reviewed).toHaveLength(1);
  });
});

describe('revisão automática', () => {
  /** Ana faz a tarefa, Rui revisa. `texts` diz o que cada conversa respondeu por último. */
  function reviewFlow(dirName: string, extra: Partial<StaffProfile> = {}) {
    const dir = path.join(root, dirName);
    const sent: Array<{ staffId: string; text: string; session: string }> = [];
    const delivered: Array<{ sessionId: string; text: string }> = [];
    const texts = new Map<string, string>();
    let n = 0;
    const people: Record<string, StaffProfile> = {
      'ana-1': { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false, servers: [], ...extra } as unknown as StaffProfile,
      'rev-1': { id: 'rev-1', name: 'Rui', autonomy: 'manual', worktree: false, servers: [] } as unknown as StaffProfile,
    };
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId, text) => {
        const session = `s-${++n}`;
        sent.push({ staffId, text, session });
        return session;
      },
      branchFor: async () => null,
      lastText: (sessionId) => texts.get(sessionId) ?? null,
      sendTo: async (_p, sessionId, _staffId, text) => {
        delivered.push({ sessionId, text });
        return sessionId;
      },
    });
    const make = async (title: string, reviewerId: string | null = 'rev-1') => (await svc.create('p', { title, staffId: 'ana-1', reviewerId }))!;
    const current = async () => (await svc.list('p'))![0]!;
    return { svc, dir, sent, delivered, texts, make, current };
  }

  it('aprovada pelo revisor vai para pronto sozinha; ao entregar, ele é chamado com o veredito na primeira linha', async () => {
    const { svc, sent, texts, make, current } = reviewFlow('auto-ok');
    const t = await make('Tabela paginada');
    expect(t).toMatchObject({ reviewerId: 'rev-1' });
    await svc.start('p', t.id); // s-1
    await svc.onTurnDone('s-1'); // entregou: o Rui revisa sozinho (s-2)
    expect(await current()).toMatchObject({ status: 'review', reviewRounds: 1, review: { staffId: 'rev-1', sessionId: 's-2' } });
    expect(sent.at(-1)).toMatchObject({ staffId: 'rev-1', session: 's-2' });
    expect(sent.at(-1)!.text).toContain('APROVADO ou REPROVADO na primeira linha');

    texts.set('s-2', '**APROVADO**\n\nPaginação e testes conferidos.');
    await svc.onTurnDone('s-2');
    const done = await current();
    expect(done).toMatchObject({ status: 'done', review: { verdict: 'approved' } });
    expect(done.history.at(-1)).toMatchObject({ status: 'done', by: 'auto', note: 'aprovada por Rui' });
  });

  it('aprovada, mas o código ainda está numa worktree por mesclar: fica em revisão, com a nota', async () => {
    const { svc, dir, texts, make, current } = reviewFlow('auto-wt', { worktree: true });
    // A worktree dela: a pasta com o arquivo `.git` (é assim que o Claudio’s Club acha a worktree).
    const wt = path.join(dir, '.claude', 'worktrees', 'myco-ana-1');
    await fs.mkdir(wt, { recursive: true });
    await fs.writeFile(path.join(wt, '.git'), 'gitdir: nao-existe\n');
    const t = await make('Filtro de datas');
    await svc.start('p', t.id); // s-1
    await svc.onTurnDone('s-1'); // s-2
    texts.set('s-2', 'APROVADO\n\nok');
    await svc.onTurnDone('s-2');
    expect(await current()).toMatchObject({ status: 'review', review: { verdict: 'approved' } });
    expect((await current()).history.at(-1)?.note).toBe('aprovada por Rui; falta mesclar');
  });

  it('reprovada: a tarefa volta para fazendo, a resposta do revisor vai para a conversa de trabalho, e a próxima rodada é pedida quando ela terminar', async () => {
    const { svc, texts, delivered, make, current } = reviewFlow('auto-no');
    const t = await make('Botão de exportar');
    await svc.start('p', t.id); // s-1
    await svc.onTurnDone('s-1'); // s-2: revisão automática
    texts.set('s-2', 'REPROVADO\n\nbotao.tsx:12 falta o aria-label');
    await svc.onTurnDone('s-2');
    const back = await current();
    expect(back).toMatchObject({ status: 'doing', review: { verdict: 'rejected' } });
    expect(back.history.map((h) => h.note)).toContain('reprovada por Rui');
    expect(delivered).toEqual([{ sessionId: 's-1', text: expect.stringContaining('botao.tsx:12 falta o aria-label') }]);

    await svc.onTurnDone('s-1'); // ajustou e terminou: volta para revisão, e o Rui revisa de novo (s-3)
    expect(await current()).toMatchObject({ status: 'review', reviewRounds: 2, review: { sessionId: 's-3' } });
  });

  it('reprovada com ela ocupada com outra tarefa: o ajuste espera na conversa dela, e a tarefa segue em revisão', async () => {
    const { svc, texts, delivered, make } = reviewFlow('auto-busy');
    const a = await make('A');
    const b = await make('B', null);
    await svc.start('p', a.id); // s-1
    await svc.onTurnDone('s-1'); // A em revisão; o Rui revisa (s-2)
    await svc.start('p', b.id); // a Ana está livre (A em revisão não ocupa): B começa (s-3)
    texts.set('s-2', 'REPROVADO\n\nfalta o teste da paginação');
    await svc.onTurnDone('s-2');
    const held = (await svc.list('p'))!.find((x) => x.id === a.id)!;
    expect(held).toMatchObject({ status: 'review', held: [expect.objectContaining({ text: expect.stringContaining('falta o teste da paginação') })] });
    expect(held.held![0]!.reason).toBe('espera Ana terminar “B”');
    expect(delivered).toEqual([]);

    await svc.onTurnDone('s-3'); // B termina: a fila da Ana anda, e o ajuste da A vai primeiro
    await svc.tick();
    expect(delivered).toEqual([{ sessionId: 's-1', text: expect.stringContaining('falta o teste da paginação') }]);
  });

  it('no máximo 3 rodadas automáticas: depois, a tarefa fica com você e a entrega não pede mais revisão', async () => {
    const { svc, sent, texts, delivered, make, current } = reviewFlow('auto-limit');
    const t = await make('Relatório');
    await svc.start('p', t.id); // s-1
    await svc.onTurnDone('s-1'); // rodada 1 (s-2)
    for (const round of [1, 2, 3]) {
      texts.set(`s-${round + 1}`, `REPROVADO\n\najuste ${round}`);
      await svc.onTurnDone(`s-${round + 1}`); // reprovou: volta para fazendo
      await svc.onTurnDone('s-1'); // ajustou e terminou: vai para revisão
    }
    const end = await current();
    expect(sent.filter((m) => m.staffId === 'rev-1')).toHaveLength(3);
    expect(delivered).toHaveLength(3);
    expect(end).toMatchObject({ status: 'review', reviewRounds: 3 });
    expect(end.history.at(-1)?.note).toBe('limite de 3 revisões automáticas; fica com você');
  });

  it('revisor: outro funcionário do projeto, que não é quem faz a tarefa, nem na troca', async () => {
    const { svc, make } = reviewFlow('auto-val');
    await expect(svc.create('p', { title: 'x', staffId: 'ana-1', reviewerId: 'ana-1' })).rejects.toThrow(/outro funcionário/);
    await expect(svc.create('p', { title: 'x', staffId: 'ana-1', reviewerId: 'ninguem' })).rejects.toThrow(/revisor não encontrado/);
    const t = await make('y');
    await expect(svc.update('p', t.id, { staffId: 'rev-1' })).rejects.toThrow(/outro funcionário/);
    await expect(svc.update('p', t.id, { reviewerId: 'ana-1' })).rejects.toThrow(/outro funcionário/);
    expect(await svc.update('p', t.id, { reviewerId: null })).toMatchObject({ reviewerId: null });
  });

  it('sem revisor marcado, nada muda: entregue fica em revisão; um veredito de revisão pedida à mão só é anotado', async () => {
    const { svc, sent, texts, make, current } = reviewFlow('auto-none');
    const t = await make('Sem revisor', null);
    await svc.start('p', t.id); // s-1
    await svc.onTurnDone('s-1');
    expect(sent).toHaveLength(1);
    expect(await current()).toMatchObject({ status: 'review' });
    expect((await current()).reviewRounds).toBeUndefined();

    await svc.requestReview('p', t.id, 'rev-1'); // s-2, pedida à mão
    texts.set('s-2', 'APROVADO');
    await svc.onTurnDone('s-2');
    expect(await current()).toMatchObject({ status: 'review', review: { verdict: 'approved' } });
  });

  it('o veredito é a primeira linha, sem markdown e em maiúsculas; o resto não decide', () => {
    expect(parseVerdict('**APROVADO**\n\nok')).toBe('approved');
    expect(parseVerdict('\n  # REPROVADO\n- x')).toBe('rejected');
    expect(parseVerdict('APROVADO.')).toBe('approved');
    expect(parseVerdict('APROVADO com ressalvas')).toBeNull();
    expect(parseVerdict('APROVADO, mas o teste X falha')).toBeNull();
    expect(parseVerdict('Aprovado')).toBeNull();
    expect(parseVerdict('Acho que está APROVADO')).toBeNull();
    expect(parseVerdict('APROVADOS os dois')).toBeNull();
    expect(parseVerdict('')).toBeNull();
    expect(parseVerdict(null)).toBeNull();
  });
});
