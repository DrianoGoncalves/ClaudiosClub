import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { BUILTIN_ROLES } from '../shared/roles';
import { sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import type { Caller } from '../server/callers';
import { renderFicha, type FichaContext } from '../server/staff/ficha';
import { TaskConflictError, TaskError, TaskForbiddenError, TaskOrderBody, TaskService, readTasks } from '../server/tasks';

// Ordem da fila do funcionário (t-d257fb): o usuário reordena qualquer card; o gestor, só os que pediu e só entre eles; o responsável só sugere (vira
// aviso a quem pediu, sem mudar nada). A fila anda pela posição gravada (`queueRank`) e continua pulando card bloqueado.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-queueorder-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const person = (id: string, name: string, reportsTo: string[] = []) => ({ id, name, role: 'Dev', autonomy: 'acceptEdits', worktree: false, servers: [], reportsTo }) as unknown as StaffProfile;
const people: Record<string, StaffProfile> = {
  'gio-1': person('gio-1', 'Gio'),
  'hal-1': person('hal-1', 'Hal'),
  'ana-1': person('ana-1', 'Ana', ['gio-1', 'hal-1']),
  'bia-1': person('bia-1', 'Bia', ['gio-1']),
  'dev-1': person('dev-1', 'Dev'),
};
const as = (staffId: string | null, o: Partial<Caller> = {}): Caller => ({ staffId, projectId: 'p', sessionId: `c-${staffId}`, engine: 'claude', sandbox: false, ...o });

/** Ana (ocupada até o teste liberar) com a fila dos cards que o teste pede; Gio e Hal pedem. Cada `club` precisa de pasta própria. */
async function club(dirName: string) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, '.myco', 'tasks.json');
  const state = {
    busy: true,
    sends: [] as string[],
    notices: [] as Array<{ to: string; text: string; session: string | null }>,
    notifyFails: false,
    onProfile: undefined as undefined | ((id: string) => Promise<void>),
  };
  let n = 0;
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => {
      await state.onProfile?.(id);
      return people[id] ?? null;
    },
    send: async (_p, _s, text) => {
      state.sends.push(/\[Tarefa "(.+?)"\]/.exec(text)![1]!);
      return `s-${++n}`;
    },
    branchFor: async () => null,
    isWorking: () => state.busy,
    notify: async (_p, staffId, text, session) => {
      if (state.notifyFails) throw new Error('a conversa dele não abriu');
      state.notices.push({ to: staffId, text, session: session ?? null });
    },
  });
  const ids: Record<string, string> = {};
  /** Cria o card (pedido por `by`; null = pelo usuário) e o põe na fila de quem faz. */
  const add = async (title: string, by: string | null = 'gio-1', staff = 'ana-1', session?: string, extra: Record<string, unknown> = {}) => {
    // Sem revisor automático: a entrega pelo arquivo (`deliver`) não abre conversa de revisão no meio do teste.
    const t = (await svc.create('p', { title, staffId: staff, reviewerId: null, ...extra }, by, session))!;
    await svc.start('p', t.id);
    ids[title] = t.id;
    return t.id;
  };
  const get = async (title: string) => (await svc.list('p'))!.find((t) => t.id === ids[title])!;
  /** Os títulos da fila do funcionário, na ordem em que andam (a posição que a listagem devolve). */
  const order = async (staff = 'ana-1') =>
    (await svc.list('p'))!
      .filter((t) => t.staffId === staff && t.queuePos)
      .sort((a, b) => a.queuePos! - b.queuePos!)
      .map((t) => t.title);
  const edit = async (fn: (all: Array<Record<string, any>>) => void) => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    fn(all);
    await fs.writeFile(file, JSON.stringify(all));
  };
  /** A entrega de quem está fazendo: sai de "fazendo" (não ocupa mais a Ana). */
  const deliver = (title: string) => edit((all) => all.forEach((t) => t.title === title && (t.status = 'review')));
  /** Libera a Ana e deixa a fila andar `count` vezes: devolve os títulos na ordem em que começaram. */
  const run = async (count: number, staff = 'ana-1') => {
    state.busy = false;
    for (let i = 0; i < count; i++) {
      await svc.tick();
      const doing = (await svc.list('p'))!.find((t) => t.staffId === staff && t.status === 'doing');
      if (doing) await deliver(doing.title);
    }
    return state.sends;
  };
  const reorder = (title: string, caller: Caller | null, fromBrowser: boolean, body: unknown) => svc.reorder('p', ids[title]!, caller, fromBrowser, body);
  /** O erro que o pedido devolve (ou o resultado, se deu certo). */
  const tryOrder = (title: string, caller: Caller | null, fromBrowser: boolean, body: unknown) => reorder(title, caller, fromBrowser, body).then((r) => r, (e: unknown) => e);
  return { svc, dir, file, state, ids, add, get, order, edit, deliver, run, reorder, tryOrder };
}

describe('ordem da fila: o usuário reordena qualquer card', () => {
  it('sem reordenar, a fila anda pela ordem de entrada e a listagem diz a posição de cada card', async () => {
    const b = await club('base');
    await b.add('A');
    await b.add('B', 'hal-1');
    await b.add('C', null);
    expect(await b.order()).toEqual(['A', 'B', 'C']);
    expect((await b.get('C')).queuePos).toBe(3);
    expect((await b.get('C')).queueRank).toBeUndefined();
  });

  it('"to: top" leva o card de qualquer solicitante ao topo, grava a posição de toda a fila e o takeNext segue a ordem nova', async () => {
    const b = await club('top');
    await b.add('A');
    await b.add('B', 'hal-1');
    await b.add('C', null);
    const out = await b.reorder('C', null, true, { to: 'top' });
    expect(out).toMatchObject({ ok: true, moved: { from: 3, to: 1, of: 3 }, task: { title: 'C', queuePos: 1, queueRank: 1 } });
    expect(await b.order()).toEqual(['C', 'A', 'B']);
    expect([(await b.get('A')).queueRank, (await b.get('B')).queueRank]).toEqual([2, 3]);
    expect(await b.run(3)).toEqual(['C', 'A', 'B']);
  });

  it('"to: n" põe o card na posição pedida; fora da fila é 400, na mesma posição é 409', async () => {
    const b = await club('pos');
    for (const t of ['A', 'B', 'C', 'D']) await b.add(t);
    await b.reorder('A', null, true, { to: 3 });
    expect(await b.order()).toEqual(['B', 'C', 'A', 'D']);
    expect(await b.tryOrder('A', null, true, { to: 5 })).toBeInstanceOf(TaskError);
    expect(await b.tryOrder('A', null, true, { to: 3 })).toBeInstanceOf(TaskConflictError);
    expect(await b.order()).toEqual(['B', 'C', 'A', 'D']);
  });

  it('"step" sobe ou desce um lugar na fila toda; no limite é 409', async () => {
    const b = await club('step');
    for (const t of ['A', 'B', 'C']) await b.add(t);
    await b.reorder('C', null, true, { step: 'up' });
    expect(await b.order()).toEqual(['A', 'C', 'B']);
    await b.reorder('A', null, true, { step: 'down' });
    expect(await b.order()).toEqual(['C', 'A', 'B']);
    expect(await b.tryOrder('C', null, true, { step: 'up' })).toBeInstanceOf(TaskConflictError);
    expect(await b.tryOrder('B', null, true, { step: 'down' })).toBeInstanceOf(TaskConflictError);
  });

  it('cada movimento deixa no histórico do card quem moveu e de onde para onde (e só o movido ganha a nota)', async () => {
    const b = await club('hist');
    for (const t of ['A', 'B', 'C']) await b.add(t);
    const before = (await b.get('A')).history.length;
    await b.reorder('C', null, true, { to: 'top' });
    const note = (await b.get('C')).history.at(-1)!;
    expect(note).toMatchObject({ by: 'you', note: 'fila de Ana reordenada por você: posição 3 → 1 de 3' });
    expect((await b.get('A')).history).toHaveLength(before);
    await b.reorder('B', as('gio-1'), false, { step: 'up' });
    expect((await b.get('B')).history.at(-1)).toMatchObject({ by: 'auto', note: 'fila de Ana reordenada por Gio: posição 3 → 2 de 3' });
  });

  it('a fila de um funcionário não mexe na de outro, e o card que não está na fila é 409', async () => {
    const b = await club('outra');
    await b.add('A');
    await b.add('X', 'gio-1', 'bia-1');
    await b.add('B');
    await b.reorder('B', null, true, { to: 'top' });
    expect(await b.order('bia-1')).toEqual(['X']);
    expect((await b.get('X')).queueRank).toBeUndefined();
    await b.edit((all) => all.forEach((t) => t.title === 'A' && Object.assign(t, { status: 'waiting', queuedAt: null })));
    expect(await b.tryOrder('A', null, true, { to: 'top' })).toBeInstanceOf(TaskConflictError);
  });

  it('tarefa que não existe: null (404 na rota)', async () => {
    const b = await club('nao-existe');
    await b.add('A');
    expect(await b.svc.reorder('p', 't-zzzzzz', null, true, { to: 'top' })).toBeNull();
  });

  it('o corpo é conferido: um só entre to, step e suggest; campo desconhecido, posição inválida e reason sem suggest são 400', async () => {
    const b = await club('corpo');
    await b.add('A');
    await b.add('B');
    for (const body of [{}, { to: 'top', step: 'up' }, { to: 0 }, { to: 1.5 }, { to: 'meio' }, { step: 'left' }, { to: 'top', reason: 'x' }, { suggest: 'up' }, { to: 'top', rank: 1 }, { queueRank: 1 }]) {
      expect(await b.tryOrder('B', null, true, body), JSON.stringify(body)).toBeInstanceOf(TaskError);
    }
    expect(TaskOrderBody.safeParse({ suggest: 'top', reason: '  uma\n\nlinha  só ' })).toMatchObject({ success: true, data: { reason: 'uma linha só' } });
    expect(await b.order()).toEqual(['A', 'B']);
  });
});

describe('ordem da fila: o gestor só mexe no que pediu', () => {
  it('sobe e desce trocando de lugar só com o card dele mais próximo: a posição dos cards de outros não muda', async () => {
    const b = await club('gestor-troca');
    await b.add('G1', 'gio-1');
    await b.add('H1', 'hal-1');
    await b.add('G2', 'gio-1');
    await b.add('U1', null);
    await b.add('G3', 'gio-1');
    expect(await b.order()).toEqual(['G1', 'H1', 'G2', 'U1', 'G3']);
    // G3 sobe: troca com G2 (o card dele mais próximo; U1, de outro solicitante, está no meio e não se mexe).
    const up = await b.reorder('G3', as('gio-1'), false, { step: 'up' });
    expect(up).toMatchObject({ moved: { from: 5, to: 3, of: 5 } });
    expect(await b.order()).toEqual(['G1', 'H1', 'G3', 'U1', 'G2']);
    await b.reorder('G1', as('gio-1'), false, { step: 'down' });
    expect(await b.order()).toEqual(['G3', 'H1', 'G1', 'U1', 'G2']);
    // Os de outros solicitantes seguem nos mesmos lugares de antes (2 e 4).
    expect([(await b.get('H1')).queuePos, (await b.get('U1')).queuePos]).toEqual([2, 4]);
  });

  it('no limite dos cards dele é 409 (não há outro dele para trocar)', async () => {
    const b = await club('gestor-limite');
    await b.add('G1', 'gio-1');
    await b.add('H1', 'hal-1');
    await b.add('G2', 'gio-1');
    expect(await b.tryOrder('G1', as('gio-1'), false, { step: 'up' })).toBeInstanceOf(TaskConflictError);
    expect(await b.tryOrder('G2', as('gio-1'), false, { step: 'down' })).toBeInstanceOf(TaskConflictError);
    // O único card dele na fila também não tem com quem trocar.
    expect(await b.tryOrder('H1', as('hal-1'), false, { step: 'up' })).toBeInstanceOf(TaskConflictError);
    expect(await b.order()).toEqual(['G1', 'H1', 'G2']);
  });

  it('403 no card que outro pediu e no pedido pelo usuário (e a ordem não muda)', async () => {
    const b = await club('gestor-403');
    await b.add('G1', 'gio-1');
    await b.add('H1', 'hal-1');
    await b.add('U1', null);
    expect(await b.tryOrder('H1', as('gio-1'), false, { step: 'up' })).toBeInstanceOf(TaskForbiddenError);
    expect(await b.tryOrder('U1', as('gio-1'), false, { step: 'up' })).toBeInstanceOf(TaskForbiddenError);
    expect(await b.tryOrder('G1', as('hal-1'), false, { step: 'down' })).toBeInstanceOf(TaskForbiddenError);
    expect(await b.order()).toEqual(['G1', 'H1', 'U1']);
    expect((await b.get('G1')).queueRank).toBeUndefined();
  });

  it('403 ao pedir posição ou topo no card dele: furar a fila de outro é só do usuário', async () => {
    const b = await club('gestor-fura');
    await b.add('H1', 'hal-1');
    await b.add('G1', 'gio-1');
    expect(await b.tryOrder('G1', as('gio-1'), false, { to: 'top' })).toBeInstanceOf(TaskForbiddenError);
    expect(await b.tryOrder('G1', as('gio-1'), false, { to: 1 })).toBeInstanceOf(TaskForbiddenError);
    expect(await b.order()).toEqual(['H1', 'G1']);
  });

  it('sem token de funcionário (ou de outro projeto, ou sem ficha) é 403, antes de ler a tarefa', async () => {
    const b = await club('gestor-token');
    await b.add('G1', 'gio-1');
    await b.add('G2', 'gio-1');
    for (const caller of [null, as(null), as('gio-1', { projectId: 'outro' })]) {
      expect(await b.tryOrder('G2', caller, false, { step: 'up' })).toBeInstanceOf(TaskForbiddenError);
      expect(await b.tryOrder('t-zzzzzz', caller, false, { step: 'up' })).toBeInstanceOf(TaskForbiddenError);
    }
    expect(await b.order()).toEqual(['G1', 'G2']);
  });

  it('quem pediu não sugere: é 400 (ele reordena)', async () => {
    const b = await club('gestor-sugere');
    await b.add('G1', 'gio-1');
    const err = await b.tryOrder('G1', as('gio-1'), false, { suggest: 'top', reason: 'urgente' });
    expect(err).toBeInstanceOf(TaskError);
    expect(err).not.toBeInstanceOf(TaskForbiddenError);
    expect(b.state.notices).toHaveLength(0);
  });

  it('a troca confere o que está gravado na hora: card que já começou no meio do pedido é 409 e nada muda', async () => {
    const b = await club('gestor-corrida');
    await b.add('G1', 'gio-1');
    await b.add('G2', 'gio-1');
    // Entre a leitura e a gravação o card G2 começou (virou "fazendo" por outro caminho).
    b.state.onProfile = async (id) => {
      if (id !== 'gio-1') return;
      b.state.onProfile = undefined;
      await b.edit((all) => all.forEach((t) => t.title === 'G2' && Object.assign(t, { status: 'doing', queuedAt: null, sessionId: 's-x' })));
    };
    expect(await b.tryOrder('G2', as('gio-1'), false, { step: 'up' })).toBeInstanceOf(TaskConflictError);
    expect((await readTasks(b.dir)).find((t) => t.title === 'G1')!.queueRank).toBeUndefined();
  });
});

describe('ordem da fila: quem faz a tarefa só sugere', () => {
  it('403 ao reordenar (qualquer movimento, em qualquer card dele) e a ordem não muda', async () => {
    const b = await club('resp-403');
    await b.add('G1', 'gio-1');
    await b.add('G2', 'gio-1');
    await b.add('U1', null);
    for (const [title, body] of [
      ['G2', { step: 'up' }],
      ['G2', { to: 'top' }],
      ['U1', { to: 1 }],
      ['G1', { step: 'down' }],
    ] as const) {
      expect(await b.tryOrder(title, as('ana-1'), false, body), `${title} ${JSON.stringify(body)}`).toBeInstanceOf(TaskForbiddenError);
    }
    expect(await b.order()).toEqual(['G1', 'G2', 'U1']);
    expect((await b.get('G2')).queueRank).toBeUndefined();
  });

  it('a sugestão vira aviso para quem pediu, na conversa em que pediu, e não muda a ordem nem a posição', async () => {
    const b = await club('resp-sugere');
    await b.add('G1', 'gio-1');
    await b.add('G2', 'gio-1', 'ana-1', 'sess-gio');
    await b.add('H1', 'hal-1');
    const out = await b.reorder('G2', as('ana-1'), false, { suggest: 'top', reason: 'a G1 depende\ndela' });
    expect(out).toEqual({ ok: true, suggested: true, notified: 'gio-1' });
    expect(b.state.notices).toHaveLength(1);
    expect(b.state.notices[0]).toMatchObject({ to: 'gio-1', session: 'sess-gio' });
    expect(b.state.notices[0]!.text).toContain('Ana sugere mudar a ordem da fila dele: passar para o topo a tarefa “G2”');
    expect(b.state.notices[0]!.text).toContain('a 2ª de 3');
    expect(b.state.notices[0]!.text).toContain('Motivo: “a G1 depende dela”');
    expect(b.state.notices[0]!.text).toContain('a ordem não mudou');
    expect(await b.order()).toEqual(['G1', 'G2', 'H1']);
    expect([(await b.get('G2')).queueRank, (await b.get('G2')).status]).toEqual([undefined, 'todo']);
    expect((await b.get('G2')).history.at(-1)!.note).toBe('Ana sugeriu passar para o topo na fila: a G1 depende dela');
  });

  it('só uma sugestão por tarefa no intervalo (409), e o aviso que não chegou é erro e não gasta o intervalo', async () => {
    const b = await club('resp-limite');
    await b.add('G1', 'gio-1');
    await b.add('G2', 'gio-1');
    b.state.notifyFails = true;
    const failed = await b.tryOrder('G2', as('ana-1'), false, { suggest: 'up', reason: 'urgente' });
    expect(failed).toBeInstanceOf(TaskError);
    expect(String((failed as Error).message)).toContain('o aviso não chegou a Gio');
    expect((await b.get('G2')).history.at(-1)!.note ?? '').not.toContain('sugeriu');
    b.state.notifyFails = false;
    expect(await b.reorder('G2', as('ana-1'), false, { suggest: 'up', reason: 'urgente' })).toMatchObject({ suggested: true });
    expect(await b.tryOrder('G2', as('ana-1'), false, { suggest: 'up', reason: 'urgente de novo' })).toBeInstanceOf(TaskConflictError);
    expect(b.state.notices).toHaveLength(1);
    // Outra tarefa dele tem o seu intervalo.
    expect(await b.reorder('G1', as('ana-1'), false, { suggest: 'down', reason: 'pode esperar' })).toMatchObject({ suggested: true });
  });

  it('tarefa pedida pelo usuário (sem gestor): 409, diz a ele na conversa; fora da fila também é 409; sem motivo é 400', async () => {
    const b = await club('resp-sem-gestor');
    await b.add('U1', null);
    await b.add('G1', 'gio-1');
    const noManager = await b.tryOrder('U1', as('ana-1'), false, { suggest: 'top', reason: 'urgente' });
    expect(noManager).toBeInstanceOf(TaskConflictError);
    expect(String((noManager as Error).message)).toContain('na conversa');
    await b.edit((all) => all.forEach((t) => t.title === 'G1' && Object.assign(t, { status: 'waiting', queuedAt: null })));
    expect(await b.tryOrder('G1', as('ana-1'), false, { suggest: 'top', reason: 'urgente' })).toBeInstanceOf(TaskConflictError);
    expect(await b.tryOrder('U1', as('ana-1'), false, { suggest: 'top' })).toBeInstanceOf(TaskError);
    expect(b.state.notices).toHaveLength(0);
  });

  it('quem não é o responsável nem quem pediu (nem o usuário) recebe 403, reordenando ou sugerindo', async () => {
    const b = await club('terceiro');
    await b.add('G1', 'gio-1');
    await b.add('G2', 'gio-1');
    for (const body of [{ step: 'up' }, { to: 'top' }, { suggest: 'up', reason: 'urgente' }]) {
      expect(await b.tryOrder('G2', as('bia-1'), false, body), JSON.stringify(body)).toBeInstanceOf(TaskForbiddenError);
      expect(await b.tryOrder('G2', as('dev-1'), false, body), JSON.stringify(body)).toBeInstanceOf(TaskForbiddenError);
    }
    expect(b.state.notices).toHaveLength(0);
    expect(await b.order()).toEqual(['G1', 'G2']);
  });

  it('o usuário não manda sugestão (é do responsável): 400', async () => {
    const b = await club('usuario-sugere');
    await b.add('G1', 'gio-1');
    expect(await b.tryOrder('G1', null, true, { suggest: 'top', reason: 'urgente' })).toBeInstanceOf(TaskError);
  });
});

describe('ordem da fila: o que o takeNext faz com a posição', () => {
  it('card bloqueado no topo é pulado, e começa quando a dependência fica pronta', async () => {
    const b = await club('bloqueada');
    // A dependência fica em Aguardar (nunca começa sozinha); B entra na fila e passa a depender dela por fora.
    const base = (await b.svc.create('p', { title: 'Base', staffId: 'bia-1', start: false, reviewerId: null }, 'gio-1'))!.id;
    await b.add('A');
    await b.add('B');
    await b.add('C');
    await b.edit((all) => all.forEach((t) => t.title === 'B' && (t.blockedBy = [base])));
    await b.reorder('B', null, true, { to: 'top' });
    expect(await b.order()).toEqual(['B', 'A', 'C']);
    expect(await b.run(2)).toEqual(['A', 'C']); // B no topo, mas bloqueada: pulada, sem perder o lugar
    expect((await b.get('B')).queueRank).toBe(1);
    await b.edit((all) => all.forEach((t) => t.title === 'Base' && (t.status = 'done')));
    expect(await b.run(1)).toEqual(['A', 'C', 'B']);
  });

  it('card novo entra no fim, atrás dos que já têm posição, mesmo que a fila antiga tenha sido reordenada', async () => {
    const b = await club('novo-no-fim');
    for (const t of ['A', 'B', 'C']) await b.add(t);
    await b.reorder('C', null, true, { to: 'top' });
    await b.add('D', 'hal-1');
    await b.add('E', null);
    expect(await b.order()).toEqual(['C', 'A', 'B', 'D', 'E']);
    expect([(await b.get('D')).queueRank, (await b.get('E')).queueRank]).toEqual([undefined, undefined]);
    // Reordenar de novo dá posição a todos, e a ordem dos que já estavam se mantém.
    await b.reorder('E', null, true, { to: 2 });
    expect(await b.order()).toEqual(['C', 'E', 'A', 'B', 'D']);
    expect(await b.run(5)).toEqual(['C', 'E', 'A', 'B', 'D']);
  });

  it('quem sai da fila perde a posição, e quando volta vai para o fim (não para o lugar antigo)', async () => {
    const b = await club('volta');
    for (const t of ['A', 'B', 'C']) await b.add(t);
    await b.reorder('C', null, true, { to: 'top' });
    expect((await b.get('C')).queueRank).toBe(1);
    await b.svc.update('p', b.ids['C']!, { queued: false }); // o usuário a tira da fila
    expect((await b.get('C')).queueRank).toBeUndefined();
    expect(await b.order()).toEqual(['A', 'B']);
    await b.svc.start('p', b.ids['C']!);
    expect(await b.order()).toEqual(['A', 'B', 'C']);
    expect((await b.get('C')).queueRank).toBeUndefined();
  });

  it('a posição dos que ficam sobrevive à saída de um: começar o primeiro não bagunça o resto', async () => {
    const b = await club('sai-um');
    for (const t of ['A', 'B', 'C', 'D']) await b.add(t);
    await b.reorder('D', null, true, { to: 'top' });
    await b.reorder('B', null, true, { to: 2 });
    expect(await b.order()).toEqual(['D', 'B', 'A', 'C']);
    expect(await b.run(1)).toEqual(['D']);
    expect(await b.order()).toEqual(['B', 'A', 'C']);
    expect(await b.run(3)).toEqual(['D', 'B', 'A', 'C']);
  });
});

describe('ordem da fila: a edição de tarefa não abre caminho para mudá-la (t-d6b6ce)', () => {
  it('o funcionário não consegue gravar a posição nem a hora de entrada pela edição (400 com o nome do campo)', async () => {
    const b = await club('edicao');
    await b.add('G1', 'gio-1');
    await b.add('G2', 'gio-1');
    for (const body of [{ queueRank: 1 }, { queuedAt: '2000-01-01T00:00:00.000Z' }, { title: 'G2', queueRank: 1 }]) {
      const err = await b.svc.editFrom('p', b.ids['G2']!, as('gio-1'), body).then(() => null, (e: unknown) => e);
      expect(err, JSON.stringify(body)).toBeInstanceOf(TaskError);
      expect(String((err as Error).message)).toMatch(/queueRank|queuedAt/);
    }
    expect(await b.order()).toEqual(['G1', 'G2']);
    expect((await b.get('G2')).queueRank).toBeUndefined();
  });

  it('a edição pela tela também ignora o campo (o esquema não o aceita)', async () => {
    const b = await club('edicao-tela');
    await b.add('G1', 'gio-1');
    await b.add('G2', 'gio-1');
    await b.svc.update('p', b.ids['G2']!, { title: 'G2 novo', queueRank: 1 } as never);
    const raw = (await readTasks(b.dir)).find((t) => t.id === b.ids['G2'])!;
    expect(raw.title).toBe('G2 novo');
    expect(raw.queueRank).toBeUndefined();
  });

  it('passar o card a outro responsável (editFrom) leva ao fim da fila nova e solta a posição da antiga', async () => {
    const b = await club('edicao-troca');
    await b.add('G1', 'gio-1');
    await b.add('G2', 'gio-1');
    await b.add('X', 'gio-1', 'bia-1');
    await b.reorder('G2', null, true, { to: 'top' });
    await b.svc.editFrom('p', b.ids['G2']!, as('gio-1'), { staffId: 'bia-1' });
    expect(await b.order('bia-1')).toEqual(['X', 'G2']);
    expect(await b.order('ana-1')).toEqual(['G1']);
    expect((await b.get('G2')).queueRank).toBeUndefined();
  });
});

describe('ordem da fila: rota, política e ficha', () => {
  it('a rota é liberada aos funcionários (e à sandbox do Codex, só no próprio projeto); o resto da família continua da tela', () => {
    expect(staffMayPost('/api/projects/p1/tasks/t-1a2b3c/order')).toBe(true);
    for (const p of ['/api/projects/p1/tasks/t-1a2b3c/order/extra', '/api/projects/p1/tasks/t-1a2b3c/rank', '/api/projects/p1/order']) expect(staffMayPost(p), p).toBe(false);
    expect(sandboxVerdict('POST', '/api/projects/p1/tasks/t-1/order', 'p1')).toBeNull();
    expect(sandboxVerdict('POST', '/api/projects/p2/tasks/t-1/order', 'p1')).toMatchObject({ status: 403 });
    expect(sandboxVerdict('GET', '/api/projects/p1/tasks/t-1/order', 'p1')).toMatchObject({ status: 403 });
  });

  it('a rota está ligada ao serviço com o `fromBrowser` e o `caller` da chamada (a permissão não é da tela)', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    expect(src).toMatch(/tasks\/\$\{ID\}\/order\$`\),\s*\(\{ params: \[id, taskId\], body, fromBrowser, caller \}\) => tasks\.reorder\(id!, taskId!, caller, fromBrowser, body\)/);
  });

  const profile = (over: Partial<StaffProfile> = {}) =>
    ({
      id: 'gio-1',
      projectId: 'proj-x',
      name: 'Gio',
      role: 'Orquestrador(a)',
      engine: 'claude',
      mission: 'Passar o trabalho',
      autonomy: 'acceptEdits',
      agents: [],
      skills: [],
      knowledge: [],
      rules: [],
      worktree: false,
      servers: [],
      sessions: [],
      reportsTo: [],
      ...over,
    }) as unknown as StaffProfile;
  const ctx = (mycoUrl: string, over: Partial<FichaContext> = {}): FichaContext => ({
    company: 'Acme',
    projectName: 'painel',
    projectPath: 'C:\\www\\painel',
    managerNames: [],
    fichaPath: '.myco\\staff\\gio-1.md',
    memoryPath: '.myco\\staff\\gio-1.memory.md',
    mycoUrl,
    team: [{ id: 'ana-1', name: 'Ana', role: 'Back-end', mission: 'Servidor.' }],
    ...over,
  });

  it('a ficha do gestor explica a ordem (só as que pediu, step, 403 no resto, quem faz só sugere) no Claude e no Codex', () => {
    for (const [engine, url] of [
      ['claude', 'http://127.0.0.1:4848'],
      ['codex', 'http://127.0.0.2:4848'],
    ] as const) {
      const md = renderFicha(profile({ engine }), ctx(url));
      expect(md, engine).toContain(`POST ${url}/api/projects/proj-x/tasks/<id da tarefa>/order`);
      expect(md, engine).toContain('{"step": "up"} ou {"step": "down"}');
      expect(md, engine).toContain('que VOCÊ pediu');
      expect(md, engine).toContain('nenhuma tarefa de outro solicitante muda de posição');
      expect(md, engine).toContain('é 403: isso é só do usuário');
      expect(md, engine).toContain('Quem faz a tarefa não muda a ordem: ele só te manda uma sugestão');
    }
    expect(renderFicha(profile(), ctx('http://127.0.0.1:4848', { team: [] }))).not.toContain('/order');
  });

  it('a ficha do gestor diz que a fila é da pessoa: entre pessoas só blockedBy ordena e os mesmos arquivos vão para a mesma pessoa (Claude e Codex)', () => {
    const orquestrador = BUILTIN_ROLES.find((r) => r.id === 'orquestrador')!;
    for (const engine of ['claude', 'codex'] as const) {
      const md = renderFicha(profile({ engine, rules: orquestrador.rules }), ctx('http://127.0.0.1:4848'));
      // Texto da API (a linha de `blockedBy` ao passar a tarefa) e a regra do cargo, ambos na ficha gerada.
      expect(md, engine).toContain('a fila é da pessoa, então entre pessoas diferentes só o blockedBy garante a ordem');
      expect(md, engine).toContain('dependência real entre pessoas leva blockedBy');
      expect(md, engine).toContain('tarefas que vão mexer nos mesmos arquivos vão para a mesma pessoa, cuja fila as serializa sem blockedBy');
      expect(md, engine).toContain('A fila é da pessoa: as tarefas de uma pessoa andam uma por vez');
      expect(md, engine).toContain('as de pessoas diferentes rodam juntas, e só blockedBy ordena entre elas');
      expect(md, engine).toContain('Tarefas nos mesmos arquivos vão para a mesma pessoa, cuja fila as serializa');
      // O texto antigo prometia ordem que a fila não dá entre pessoas e negava o "mesmo arquivo".
      expect(md, engine).not.toContain('a fila já anda em ordem');
      expect(md, engine).not.toContain('a fila espera sozinha');
      expect(md, engine).not.toContain('mexer no mesmo arquivo ou assunto não basta');
      expect(md, engine).not.toContain('mesmo arquivo ou assunto não basta');
    }
  });

  it('a ficha de quem recebe tarefa diz que a ordem não é dele e como sugerir (mesma linha nos dois motores); sem gestor, sem a seção', () => {
    for (const [engine, url] of [
      ['claude', 'http://127.0.0.1:4848'],
      ['codex', 'http://127.0.0.2:4848'],
    ] as const) {
      const md = renderFicha(profile({ engine, name: 'Ana', id: 'ana-1' }), ctx(url, { managerNames: ['Gio'], team: [] }));
      expect(md, engine).toContain('## Ordem da fila');
      expect(md, engine).toContain('A ordem das tarefas na sua fila não é sua');
      expect(md, engine).toContain('dá 403');
      expect(md, engine).toContain(`POST ${url}/api/projects/proj-x/tasks/<id da tarefa>/order`);
      expect(md, engine).toContain('{"suggest": "up" | "down" | "top", "reason": "<o motivo, em uma frase>"}');
      expect(md, engine).toContain('não muda nada até ele decidir');
    }
    expect(renderFicha(profile(), ctx('http://127.0.0.1:4848', { team: [] }))).not.toContain('## Ordem da fila');
  });
});
