import { readFileSync, writeFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StaffProfile, Task } from '../shared/model';
import { resolveCaller, SessionTokens, type Engine } from '../server/callers';
import { renderFicha, type FichaContext } from '../server/staff/ficha';
import { TaskConflictError, TaskError, TaskForbiddenError, TaskService } from '../server/tasks';

// Funcionário edita pela API a tarefa que ainda não começou (Aguardar e A fazer): quem pediu ou o gestor de quem faz, com o token da conversa.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-edit-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const person = (id: string, name: string, reportsTo: string[] = []) => ({ id, name, autonomy: 'acceptEdits', worktree: false, servers: [], reportsTo }) as unknown as StaffProfile;

/** Gio é o gestor; Ana e Bia reportam a ele; Dev é de fora (não reporta a ninguém) e Rui é revisor. */
function board(dirName: string) {
  const dir = path.join(root, dirName);
  const file = path.join(dir, '.myco', 'tasks.json');
  const people: Record<string, StaffProfile> = {
    'gio-1': person('gio-1', 'Gio'),
    'ana-1': person('ana-1', 'Ana', ['gio-1']),
    'bia-1': person('bia-1', 'Bia', ['gio-1']),
    'dev-1': person('dev-1', 'Dev'),
    'rev-1': person('rev-1', 'Rui'),
  };
  const sent: Array<{ staffId: string; text: string; session: string }> = [];
  const working = new Map<string, string>();
  const hooks: { beforeSend?: (staffId: string, text: string) => Promise<void>; onProfile?: (id: string) => void | Promise<void> } = {};
  let n = 0;
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => {
      await hooks.onProfile?.(id);
      return people[id] ?? null;
    },
    send: async (_p, staffId, text) => {
      await hooks.beforeSend?.(staffId, text);
      const session = `s-${++n}`;
      sent.push({ staffId, text, session });
      working.set(session, staffId);
      return session;
    },
    sendTo: async (_p, sessionId, staffId) => {
      working.set(sessionId, staffId);
      return sessionId;
    },
    branchFor: async () => null,
    isWorking: (_p, staffId, except) => [...working].some(([s, who]) => who === staffId && s !== except),
    lastText: () => null,
    notify: async () => {},
    apiUrl: 'http://127.0.0.1:4848',
    sandboxApiUrl: 'http://127.0.0.2:4848',
  });
  const finish = async (session: string) => {
    const who = working.get(session) ?? 'ana-1';
    working.delete(session);
    await svc.onIdle(session, 'p', who);
    await svc.onTurnDone(session);
  };
  /** Cria sem começar (Aguardar), pedida por Gio; `by: null` = pela tela (sem gestor, sem revisor automático). */
  const make = async (title: string, o: { staff?: string; by?: string | null; reviewerId?: string | null; blockedBy?: string[]; description?: string; acceptance?: string } = {}) =>
    (await svc.create(
      'p',
      {
        title,
        staffId: o.staff ?? 'ana-1',
        start: false,
        description: o.description ?? `desc de ${title}`,
        acceptance: o.acceptance ?? `critério de ${title}`,
        ...(o.reviewerId !== undefined && { reviewerId: o.reviewerId }),
        ...(o.blockedBy && { blockedBy: o.blockedBy }),
      },
      o.by === undefined ? 'gio-1' : o.by,
    ))!;
  const list = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await list()).find((t) => t.id === id)!;
  const settle = () => new Promise((r) => setTimeout(r, 25));
  const raw = () => readFileSync(file, 'utf8');
  /** Muda o arquivo à mão: o que outro caminho (a tela, sem a vez do funcionário) faria no meio. */
  const edit = (fn: (tasks: Array<Record<string, any>>) => void) => {
    const all = JSON.parse(raw()) as Array<Record<string, any>>;
    fn(all);
    writeFileSync(file, JSON.stringify(all, null, 2));
  };
  const tokens = new SessionTokens();
  /** Quem chama, pelo token da conversa dele (a conversa e o projeto são os do pedido). */
  const callerOf = (staffId: string | null, o: { project?: string; engine?: Engine; sandbox?: boolean } = {}) => {
    const token = tokens.issue({ staffId, projectId: o.project ?? 'p', sessionId: `c-${staffId}-${o.project ?? 'p'}-${o.engine ?? 'claude'}`, engine: o.engine ?? 'claude' });
    const r = resolveCaller(!!o.sandbox, token, tokens);
    return r.ok ? r.caller : null;
  };
  /** O erro que a edição devolve (ou o resultado, se deu certo). */
  const tryEdit = (id: string, caller: ReturnType<typeof callerOf>, body: unknown) => svc.editFrom('p', id, caller, body).then((t) => t, (e: unknown) => e);
  return { svc, dir, file, sent, working, hooks, finish, make, list, get, settle, raw, edit, as: callerOf, tryEdit };
}

describe('editar tarefa pela API: quem pode', () => {
  it('quem pediu edita em Aguardar e em A fazer: troca os campos, não muda a coluna nem a fila, e deixa nota no histórico', async () => {
    const b = board('quem-pediu');
    const t = await b.make('Exportar CSV');
    expect(t.status).toBe('waiting');
    const out = (await b.svc.editFrom('p', t.id, b.as('gio-1'), { title: 'Exportar CSV e XLSX', description: 'agora com XLSX', acceptance: 'abre no Excel', goal: 'o financeiro pediu' })) as Task;
    expect(out).toMatchObject({ status: 'waiting', title: 'Exportar CSV e XLSX', description: 'agora com XLSX', acceptance: 'abre no Excel', goal: 'o financeiro pediu', staffId: 'ana-1', requestedBy: 'gio-1' });
    expect(out.queuedAt ?? null).toBeNull();
    expect(out.history.at(-1)).toMatchObject({ status: 'waiting', by: 'auto', note: 'editada por Gio: title, description, acceptance, goal' });
    expect(await b.get(t.id)).toMatchObject({ title: 'Exportar CSV e XLSX', status: 'waiting' });
    expect(b.sent).toHaveLength(0); // editar não começa nada

    // Em A fazer, na fila (Ana ocupada): segue na mesma posição da fila.
    const ocupada = await b.make('Outra', { by: null });
    await b.svc.start('p', ocupada.id);
    await b.svc.start('p', t.id);
    const queued = await b.get(t.id);
    expect(queued).toMatchObject({ status: 'todo' });
    expect(queued.queuedAt).toBeTruthy();
    const again = (await b.svc.editFrom('p', t.id, b.as('gio-1'), { acceptance: null, goal: null })) as Task;
    expect(again).toMatchObject({ status: 'todo', acceptance: null, goal: null, queuedAt: queued.queuedAt, description: 'agora com XLSX' });
    expect(again.history.at(-1)).toMatchObject({ status: 'todo', note: 'editada por Gio: acceptance, goal' });
  });

  it('o gestor de quem faz edita mesmo sem ter pedido (tarefa criada pela tela); o `requestedBy` do corpo não conta', async () => {
    const b = board('gestor');
    const t = await b.make('Da tela', { by: null });
    expect(t.requestedBy).toBeUndefined();
    const out = (await b.svc.editFrom('p', t.id, b.as('gio-1'), { description: 'ajustada', requestedBy: 'dev-1' })) as Task;
    expect(out.description).toBe('ajustada');
    // O dono do token é quem edita: declarar outro `requestedBy` não dá permissão.
    const falso = await b.tryEdit(t.id, b.as('dev-1'), { description: 'forjada', requestedBy: 'gio-1' });
    expect(falso).toBeInstanceOf(TaskForbiddenError);
    expect((await b.get(t.id)).description).toBe('ajustada');
  });

  it('403 sem gravar: quem faz a tarefa (nem o critério de pronto), um par, um de fora, o revisor, sem token, sem ficha e token de outro projeto', async () => {
    const b = board('recusas');
    const t = await b.make('Exportar CSV');
    const before = b.raw();
    const cases: Array<[string, ReturnType<typeof b.as>]> = [
      ['o responsável', b.as('ana-1')],
      ['um par', b.as('bia-1')],
      ['um de fora', b.as('dev-1')],
      ['o revisor', b.as('rev-1')],
      ['sem token', null],
      ['conversa sem ficha', b.as(null)],
      ['token de outro projeto', b.as('gio-1', { project: 'q' })],
    ];
    for (const [quem, caller] of cases) {
      const err = await b.tryEdit(t.id, caller, { acceptance: 'qualquer coisa serve' });
      expect(err, quem).toBeInstanceOf(TaskForbiddenError);
    }
    expect(b.raw()).toBe(before);
    // A sandbox do Codex vale como qualquer outro: o dono do token.
    expect(await b.tryEdit(t.id, b.as('dev-1', { engine: 'codex', sandbox: true }), { title: 'x' })).toBeInstanceOf(TaskForbiddenError);
    const ok = (await b.svc.editFrom('p', t.id, b.as('gio-1', { engine: 'codex', sandbox: true }), { title: 'Do Codex' })) as Task;
    expect(ok.title).toBe('Do Codex');
  });

  it('tarefa que não existe: null (404)', async () => {
    const b = board('inexistente');
    await b.make('Qualquer');
    expect(await b.svc.editFrom('p', 't-nao-existe', b.as('gio-1'), { title: 'x' })).toBeNull();
  });
});

describe('editar tarefa pela API: só Aguardar e A fazer', () => {
  it('Planejando, Fazendo, Revisão, Finalizado e Cancelada: 409 claro, sem gravar', async () => {
    const b = board('colunas');
    const nomes: Record<string, string> = { planning: 'Planejando', doing: 'Fazendo', review: 'Revisão', done: 'Finalizado', cancelled: 'Cancelada' };
    for (const [status, nome] of Object.entries(nomes)) {
      const t = await b.make(`Em ${status}`);
      b.edit((all) => (all.find((x) => x.id === t.id)!.status = status));
      const before = b.raw();
      const err = await b.tryEdit(t.id, b.as('gio-1'), { description: 'tarde demais' });
      expect(err, status).toBeInstanceOf(TaskConflictError);
      expect((err as Error).message).toContain(nome);
      expect((err as Error).message).toContain('Aguardar e A fazer');
      expect(b.raw(), status).toBe(before);
    }
  });

  it('a tarefa de verdade em "fazendo" (conversa aberta) é recusada', async () => {
    const b = board('fazendo');
    const t = await b.make('Em curso');
    await b.svc.start('p', t.id);
    expect((await b.get(t.id)).status).toBe('doing');
    expect(await b.tryEdit(t.id, b.as('gio-1'), { description: 'complemento' })).toBeInstanceOf(TaskConflictError);
    expect((await b.get(t.id)).description).toBe('desc de Em curso');
  });

  it('parada no teto de turno (Aguardar, mas já com conversa): 409, o complemento vai pela conversa', async () => {
    const b = board('parada');
    const t = await b.make('Parou no teto');
    b.edit((all) => (all.find((x) => x.id === t.id)!.sessionId = 's-antiga'));
    const err = await b.tryEdit(t.id, b.as('gio-1'), { description: 'complemento' });
    expect(err).toBeInstanceOf(TaskConflictError);
    expect((err as Error).message).toContain('já começou');
  });

  it('corrida: a partida já abrindo a conversa termina antes; a edição espera a vez, é recusada e a partida levou o texto original', async () => {
    const b = board('corrida');
    const t = await b.make('Relatório', { description: 'texto original' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    b.hooks.beforeSend = async () => {
      entered();
      await gate;
    };
    const starting = b.svc.start('p', t.id);
    await reached; // a conversa está abrindo: a tarefa ainda está em "a fazer"/Aguardar no arquivo
    expect((await b.get(t.id)).status).toBe('waiting');
    let done = false;
    const editing = b.tryEdit(t.id, b.as('gio-1'), { description: 'texto novo' });
    void editing.then(() => (done = true));
    await b.settle();
    expect(done).toBe(false); // espera a vez do funcionário
    release();
    expect((await starting)?.status).toBe('doing');
    const err = await editing;
    expect(err).toBeInstanceOf(TaskConflictError);
    expect((err as Error).message).toContain('Fazendo');
    expect((await b.get(t.id)).description).toBe('texto original');
    expect(b.sent[0]!.text).toContain('texto original');
    expect(b.sent[0]!.text).not.toContain('texto novo');
  });

  it('a edição gravada antes da partida vale: a conversa abre com o texto novo', async () => {
    const b = board('antes');
    const t = await b.make('Relatório', { description: 'texto original' });
    await b.svc.editFrom('p', t.id, b.as('gio-1'), { description: 'texto novo', acceptance: 'critério novo' });
    await b.svc.start('p', t.id);
    expect(b.sent[0]!.text).toContain('texto novo');
    expect(b.sent[0]!.text).toContain('Critério de aceite: critério novo');
  });

  it('a coluna muda por fora (sem a vez do funcionário) entre a leitura e a gravação: a gravação vê e recusa, sem sobrescrever', async () => {
    const b = board('por-fora');
    const t = await b.make('Relatório', { description: 'texto original' });
    b.hooks.onProfile = (id) => {
      if (id !== 'ana-1') return;
      b.hooks.onProfile = undefined;
      b.edit((all) => (all.find((x) => x.id === t.id)!.status = 'doing'));
    };
    const err = await b.tryEdit(t.id, b.as('gio-1'), { description: 'texto novo' });
    expect(err).toBeInstanceOf(TaskConflictError);
    expect(await b.get(t.id)).toMatchObject({ status: 'doing', description: 'texto original' });
  });

  it('o responsável muda por fora entre a leitura e a gravação: recusa (a permissão era para o responsável de antes)', async () => {
    const b = board('dono-por-fora');
    const t = await b.make('Relatório', { by: null });
    b.hooks.onProfile = (id) => {
      if (id !== 'ana-1') return;
      b.hooks.onProfile = undefined;
      b.edit((all) => (all.find((x) => x.id === t.id)!.staffId = 'dev-1'));
    };
    expect(await b.tryEdit(t.id, b.as('gio-1'), { description: 'texto novo' })).toBeInstanceOf(TaskConflictError);
    expect((await b.get(t.id)).description).toBe('desc de Relatório');
  });
});

describe('editar tarefa pela API: trocar o responsável', () => {
  it('em A fazer na fila: sai da fila de Ana e vai para o fim da fila de Bia; a vez de cada uma segue a fila', async () => {
    const b = board('troca-fila');
    const a = await b.make('A da Ana', { by: null });
    const c = await b.make('C da Bia', { by: null, staff: 'bia-1' });
    await b.svc.start('p', a.id); // s-1, Ana ocupada
    await b.svc.start('p', c.id); // s-2, Bia ocupada
    const tb = await b.make('B trocada');
    await b.svc.start('p', tb.id); // na fila da Ana
    await b.settle();
    const td = await b.make('D da Bia', { staff: 'bia-1' });
    await b.svc.start('p', td.id); // na fila da Bia, depois de B ter entrado na da Ana
    await b.settle();
    const antes = await b.get(tb.id);
    expect(antes).toMatchObject({ status: 'todo', staffId: 'ana-1' });
    expect((await b.get(td.id)).queuedAt! > antes.queuedAt!).toBe(true);

    const out = (await b.svc.editFrom('p', tb.id, b.as('gio-1'), { staffId: 'bia-1' })) as Task;
    expect(out).toMatchObject({ status: 'todo', staffId: 'bia-1', queuedForce: false });
    expect(out.queuedAt! > (await b.get(td.id)).queuedAt!).toBe(true); // no fim da fila nova, não na posição antiga
    expect(out.history.at(-1)).toMatchObject({ status: 'todo', note: 'editada por Gio: staffId (agora com Bia)' });

    // Ana termina: B já não é dela, nada começa. Bia termina: D (antes na fila) começa; B espera.
    await b.finish('s-1');
    await b.settle();
    expect(b.sent.filter((s) => s.staffId === 'ana-1')).toHaveLength(1);
    await b.finish('s-2');
    await vi.waitFor(() => expect(b.sent.filter((s) => s.staffId === 'bia-1')).toHaveLength(2));
    expect(b.sent.at(-1)!.text).toContain('D da Bia');
    expect(await b.get(tb.id)).toMatchObject({ status: 'todo', staffId: 'bia-1' });
  });

  it('o novo responsável está livre: a tarefa que estava na fila da Ana começa com a Bia', async () => {
    const b = board('troca-livre');
    const a = await b.make('A da Ana', { by: null });
    await b.svc.start('p', a.id); // Ana ocupada
    const t = await b.make('Na fila');
    await b.svc.start('p', t.id);
    expect((await b.get(t.id)).queuedAt).toBeTruthy();
    await b.svc.editFrom('p', t.id, b.as('gio-1'), { staffId: 'bia-1' });
    await vi.waitFor(async () => expect(await b.get(t.id)).toMatchObject({ status: 'doing', staffId: 'bia-1' }));
    expect(b.sent.at(-1)).toMatchObject({ staffId: 'bia-1' });
    expect(b.sent.at(-1)!.text).toContain('Na fila');
  });

  it('em Aguardar: troca o responsável sem entrar na fila nem começar', async () => {
    const b = board('troca-aguardar');
    const t = await b.make('Parada');
    const out = (await b.svc.editFrom('p', t.id, b.as('gio-1'), { staffId: 'bia-1' })) as Task;
    expect(out).toMatchObject({ status: 'waiting', staffId: 'bia-1' });
    expect(out.queuedAt ?? null).toBeNull();
    await b.settle();
    expect(b.sent).toHaveLength(0);
  });

  it('só para quem reporta a quem edita (403); inexistente ou texto ruim (400); o revisor da tarefa não vira responsável (400); nada gravado', async () => {
    const b = board('troca-recusas');
    const t = await b.make('Com revisor', { reviewerId: 'bia-1' });
    const before = b.raw();
    expect(await b.tryEdit(t.id, b.as('gio-1'), { staffId: 'dev-1' })).toBeInstanceOf(TaskForbiddenError); // Dev não reporta a Gio
    expect(await b.tryEdit(t.id, b.as('gio-1'), { staffId: 'rev-1' })).toBeInstanceOf(TaskForbiddenError);
    expect(await b.tryEdit(t.id, b.as('gio-1'), { staffId: 'fantasma-1' })).toBeInstanceOf(TaskError);
    expect(await b.tryEdit(t.id, b.as('gio-1'), { staffId: null })).toBeInstanceOf(TaskError);
    expect(await b.tryEdit(t.id, b.as('gio-1'), { staffId: '../x' })).toBeInstanceOf(TaskError);
    const revisor = await b.tryEdit(t.id, b.as('gio-1'), { staffId: 'bia-1' });
    expect(revisor).toBeInstanceOf(TaskError);
    expect((revisor as Error).message).toContain('revisor');
    expect(b.raw()).toBe(before);
    // Mandar o responsável que já é o dela não é troca: edita o resto e deixa a fila.
    const mesmo = (await b.svc.editFrom('p', t.id, b.as('gio-1'), { staffId: 'ana-1', title: 'Mesmo dono' })) as Task;
    expect(mesmo).toMatchObject({ staffId: 'ana-1', title: 'Mesmo dono' });
  });

  it('start que já tinha lido o responsável antigo não abre a conversa com ele: a tarefa é do novo', async () => {
    const b = board('start-velho');
    const t = await b.make('Relatório');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    b.hooks.onProfile = async (id) => {
      if (id !== 'ana-1') return;
      b.hooks.onProfile = undefined;
      entered();
      await gate;
    };
    const starting = b.svc.start('p', t.id); // leu a Ana como responsável e espera, ainda antes da vez dela
    await reached;
    await b.svc.editFrom('p', t.id, b.as('gio-1'), { staffId: 'bia-1' });
    release();
    expect(await starting).toMatchObject({ staffId: 'bia-1', status: 'waiting' });
    expect(b.sent).toHaveLength(0);
  });
});

describe('editar tarefa pela API: dependências', () => {
  it('troca o blockedBy; id que não existe, a própria tarefa, ciclo e repetido são recusados sem gravar', async () => {
    const b = board('deps');
    const x = await b.make('X');
    const y = await b.make('Y', { blockedBy: [x.id] });
    const z = await b.make('Z');
    const ok = (await b.svc.editFrom('p', z.id, b.as('gio-1'), { blockedBy: [x.id, y.id] })) as Task;
    expect(ok.blockedBy).toEqual([x.id, y.id]);
    expect(ok.history.at(-1)!.note).toBe('editada por Gio: blockedBy');

    const before = b.raw();
    const nao = await b.tryEdit(z.id, b.as('gio-1'), { blockedBy: ['t-inexistente'] });
    expect(nao).toBeInstanceOf(TaskError);
    expect((nao as Error).message).toContain('não encontrada');
    expect(await b.tryEdit(z.id, b.as('gio-1'), { blockedBy: [z.id] })).toBeInstanceOf(TaskError);
    const ciclo = await b.tryEdit(x.id, b.as('gio-1'), { blockedBy: [y.id] }); // Y já espera X
    expect(ciclo).toBeInstanceOf(TaskError);
    expect((ciclo as Error).message).toContain('ciclo');
    const longo = await b.tryEdit(x.id, b.as('gio-1'), { blockedBy: [z.id] }); // Z espera Y, que espera X
    expect((longo as Error).message).toContain('ciclo');
    expect(await b.tryEdit(x.id, b.as('gio-1'), { blockedBy: ['t-1', 't-1'] })).toBeInstanceOf(TaskError);
    expect(await b.tryEdit(x.id, b.as('gio-1'), { blockedBy: 'x' })).toBeInstanceOf(TaskError);
    expect(b.raw()).toBe(before);
  });

  it('tirar a dependência de quem está na fila bloqueada: o dono livre pega a vez', async () => {
    const b = board('deps-solta');
    const x = await b.make('X', { staff: 'bia-1', by: null });
    const t = await b.make('Espera X', { blockedBy: [x.id] });
    await b.svc.start('p', t.id); // bloqueada: entra na fila sem começar
    await b.settle();
    expect(await b.get(t.id)).toMatchObject({ status: 'todo' });
    expect(b.sent).toHaveLength(0);
    await b.svc.editFrom('p', t.id, b.as('gio-1'), { blockedBy: [] });
    await vi.waitFor(async () => expect(await b.get(t.id)).toMatchObject({ status: 'doing', staffId: 'ana-1' }));
  });
});

describe('editar tarefa pela API: o corpo', () => {
  it('campo fora da lista (status, revisor, PR, fila…) é recusado com o nome do campo, e corpo vazio ou título vazio também', async () => {
    const b = board('corpo');
    const t = await b.make('Exportar');
    const before = b.raw();
    for (const campo of ['status', 'reviewerId', 'pr', 'branch', 'waitReason', 'queued', 'start', 'sessionId', 'id']) {
      const err = await b.tryEdit(t.id, b.as('gio-1'), { title: 'x', [campo]: 'y' });
      expect(err, campo).toBeInstanceOf(TaskError);
      expect((err as Error).message, campo).toContain(campo);
    }
    expect(await b.tryEdit(t.id, b.as('gio-1'), {})).toBeInstanceOf(TaskError);
    expect(await b.tryEdit(t.id, b.as('gio-1'), { requestedBy: 'gio-1' })).toBeInstanceOf(TaskError); // só o `requestedBy`: nada para editar
    expect(await b.tryEdit(t.id, b.as('gio-1'), null)).toBeInstanceOf(TaskError);
    expect(await b.tryEdit(t.id, b.as('gio-1'), { title: '   ' })).toBeInstanceOf(TaskError);
    expect(await b.tryEdit(t.id, b.as('gio-1'), { acceptance: 'a'.repeat(2001) })).toBeInstanceOf(TaskError);
    expect(await b.tryEdit(t.id, b.as('gio-1'), { description: 123 })).toBeInstanceOf(TaskError);
    expect(b.raw()).toBe(before);
  });
});

describe('a rota e a ficha', () => {
  it('a rota: a tela edita como sempre; o funcionário só pelo `editFrom` com o token (quem chama), nunca pelo corpo', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    const route = /\/tasks\/\$\{ID\}\$`\),([\s\S]*?)\n  \],/.exec(src)![1]!;
    expect(route).toContain('({ params: [id, taskId], body, fromBrowser, caller })');
    expect(route).toContain('if (fromBrowser) return tasks.update(id!, taskId!, body);');
    expect(route).toContain('return tasks.editFrom(id!, taskId!, caller, body);');
    expect(src).toMatch(/err instanceof TaskConflictError\) return send\(res, 409/);
    expect(src).toMatch(/err instanceof TaskForbiddenError\) return send\(res, 403/);
  });

  const profile = (over: Partial<StaffProfile> = {}) =>
    ({
      id: 'gio-1',
      projectId: 'proj-x',
      name: 'Gio',
      role: 'Orquestrador',
      portrait: null,
      reportsTo: [],
      mission: 'Passar o trabalho',
      firstTask: 'Leia o quadro',
      autonomy: 'acceptEdits',
      agents: [],
      skills: [],
      mcps: null,
      knowledge: [],
      rules: [],
      doneWhen: 'Quadro em dia',
      model: 'opus',
      effort: 'high',
      canHire: false,
      playbook: null,
      worktree: false,
      servers: [],
      browser: false,
      sessions: [],
      createdAt: '2026-10-26T00:00:00.000Z',
      updatedAt: '2026-10-26T00:00:00.000Z',
      ...over,
    }) as StaffProfile;
  const team = [{ id: 'ana-1', name: 'Ana', role: 'Back-end', mission: 'Servidor.' }];
  const ctx = (mycoUrl: string): FichaContext => ({
    company: 'Acme',
    projectName: 'painel',
    projectPath: 'C:\\www\\painel',
    managerNames: [],
    fichaPath: '.myco\\staff\\gio-1.md',
    memoryPath: '.myco\\staff\\gio-1.memory.md',
    mycoUrl,
    team,
  });

  it('a ficha do gestor ensina a editar (rota, cabeçalhos, campos, só em Aguardar e A fazer) no Claude e no Codex', () => {
    for (const [motor, url] of [
      ['claude', 'http://127.0.0.1:4848'],
      ['codex', 'http://127.0.0.2:4848'],
    ] as const) {
      const md = renderFicha(profile({ engine: motor }), ctx(url));
      expect(md, motor).toContain(`POST ${url}/api/projects/proj-x/tasks/<id da tarefa>`);
      expect(md, motor).toContain('`x-myco: 1` e `x-myco-token: $MYCO_TOKEN`');
      expect(md, motor).toContain('title, description, acceptance, goal, blockedBy ou staffId');
      expect(md, motor).toContain('Só vale em Aguardar e A fazer');
      expect(md, motor).toContain('a resposta é 409');
      expect(md, motor).toContain('(senão 403)');
      expect(md, motor).toContain('edite a tarefa em vez de criar outra com blockedBy');
    }
    // Sem equipe, sem a seção (e sem a linha).
    expect(renderFicha(profile(), { ...ctx('http://127.0.0.1:4848'), team: [] })).not.toContain('edite a tarefa em vez de criar outra');
  });
});
