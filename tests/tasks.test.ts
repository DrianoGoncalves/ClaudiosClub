import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { TaskService } from '../server/tasks';
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
