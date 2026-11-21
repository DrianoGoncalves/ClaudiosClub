import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskService } from '../server/tasks';
import type { Engine, StaffProfile, Task } from '../shared/model';
import { removeTemp } from './support/tmp';

// Subtarefa e fim de turno (t-828dc7): a tarefa pedida pela API com o token da conversa de trabalho de um card Ã© subtarefa dele (`parentTaskId`, sozinho). O fim de
// turno do card com subtarefa aberta nÃ£o Ã© entrega: fica em "fazendo", aguardando, sem ocupar o funcionÃ¡rio (a fila anda). Fechadas todas (pronta, cancelada ou
// apagada), o fim de turno seguinte entrega como sempre. Claude e Codex pela mesma regra (a conversa de trabalho e o token sÃ£o o mesmo para os dois).

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-subtasks-'));
});
afterAll(() => removeTemp(root));

const DAY = 24 * 60 * 60_000;
const profile = (id: string, name: string, extra: Partial<StaffProfile> = {}) => ({ id, name, role: 'Back-end', autonomy: 'acceptEdits', worktree: false, ...extra }) as StaffProfile;

/** Giovana (a orquestradora, dona do card) e Ana (a que recebe as subtarefas). Cada `club` precisa da sua pasta (senÃ£o herda o tasks.json do teste anterior). */
async function club(dirName: string, opts: { engine?: Engine } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  const people: Record<string, StaffProfile> = {
    'gio-1': profile('gio-1', 'Giovana', { role: 'Orquestradora', engine: opts.engine ?? 'claude' }),
    'ana-1': profile('ana-1', 'Ana', { engine: opts.engine ?? 'claude' }),
  };
  const h = {
    delivered: [] as Array<{ sessionId: string; text: string }>,
    notified: [] as Array<{ staffId: string; text: string; sessionId: string | null | undefined }>,
    working: new Set<string>(),
    texts: {} as Record<string, string>,
    /** A conversa "que estÃ¡ no turno agora" de quem pede (o que `requesterSession` devolve): nunca vale como o token. */
    turn: null as string | null,
    n: 0,
  };
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId) => `${staffId}-${++h.n}`,
    branchFor: async () => null,
    isWorking: (_p, _s, except) => {
      const skip = typeof except === 'string' ? [except] : [...(except ?? [])];
      return [...h.working].some((s) => !skip.includes(s));
    },
    sendTo: async (_p, sessionId, _s, text) => {
      h.delivered.push({ sessionId, text });
      return sessionId;
    },
    notify: async (_p, staffId, text, sessionId) => {
      h.notified.push({ staffId, text, sessionId });
    },
    requesterSession: () => h.turn,
    lastText: (s) => h.texts[s] ?? null,
  });
  const list = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await list()).find((t) => t.id === id)!;
  const settle = () => svc.kickStaff('p', 'gio-1');
  return { h, svc, list, get, settle, dir };
}
type Club = Awaited<ReturnType<typeof club>>;

/** O card da Giovana (pedido por Ana, que o revisa pelo aviso), comeÃ§ado: a conversa de trabalho dele trabalha. */
async function orquestrar(b: Club, title = 'Orquestrar') {
  const card = (await b.svc.create('p', { title, description: 'Divida e delegue', staffId: 'gio-1', reviewerId: null }, 'ana-1', 'ana-s'))!;
  await b.svc.start('p', card.id);
  const work = (await b.get(card.id)).sessionId!;
  b.h.working.add(work);
  return { card: card.id, work };
}

/** A Giovana delega Ã  Ana, pelo token da conversa `session` (a de trabalho do card, por padrÃ£o). */
async function delegar(b: Club, session: string, title = 'Parte A') {
  return (await b.svc.create('p', { title, description: 'FaÃ§a a sua parte', staffId: 'ana-1', reviewerId: null }, 'gio-1', session))!;
}

/** O turno da conversa acaba, com a Ãºltima mensagem `text`. */
async function endTurn(b: Club, work: string, text = 'Delegado, aguardando as subtarefas.') {
  b.h.working.delete(work);
  b.h.texts[work] = text;
  await b.svc.onTurnDone(work);
  await b.settle();
}

describe.each<Engine>(['claude', 'codex'])('(1) o vÃ­nculo na criaÃ§Ã£o: %s', (engine) => {
  it('criada pelo token da conversa de trabalho do card, ganha parentTaskId; o card lista as subtarefas', async () => {
    const b = await club(`vinculo-${engine}`, { engine });
    const { card, work } = await orquestrar(b);
    const sub = await delegar(b, work);
    expect(sub.parentTaskId).toBe(card);
    expect((await b.get(sub.id)).parentTaskId).toBe(card);
    // O contrato da tela: id, tÃ­tulo, coluna e responsÃ¡vel de cada subtarefa (as encerradas tambÃ©m), sem a marca de espera enquanto o turno nÃ£o acabou.
    expect((await b.get(card)).subtasks).toEqual([{ id: sub.id, title: 'Parte A', status: 'todo', staffId: 'ana-1' }]);
    expect((await b.get(card)).awaitingSubtasks).toBeUndefined();
  });

  it('criada de outra conversa (a que nÃ£o Ã© a de trabalho do card, ou a que estÃ¡ no turno), nÃ£o Ã© subtarefa', async () => {
    const b = await club(`vinculo-outra-${engine}`, { engine });
    const { card, work } = await orquestrar(b);
    // Outra conversa da prÃ³pria Giovana (o gestor tem vÃ¡rias delegaÃ§Ãµes abertas sem relaÃ§Ã£o com o card).
    const outra = await delegar(b, 'gio-outra-conversa', 'Sem relaÃ§Ã£o');
    expect(outra.parentTaskId).toBeUndefined();
    // Sem token (compatibilidade): a conversa "que estÃ¡ no turno" nÃ£o vale como a do token, mesmo sendo a de trabalho do card.
    b.h.turn = work;
    const semToken = (await b.svc.create('p', { title: 'Sem token', description: 'x', staffId: 'ana-1', reviewerId: null }, 'gio-1'))!;
    expect(semToken.parentTaskId).toBeUndefined();
    expect((await b.get(card)).subtasks).toBeUndefined();
  });

  it('a conversa de trabalho de um card de OUTRO funcionÃ¡rio nÃ£o vincula (o card tem de ser de quem pede)', async () => {
    const b = await club(`vinculo-alheio-${engine}`, { engine });
    const mine = await orquestrar(b);
    // O card da Ana, com a conversa dela: a Giovana nÃ£o pode pendurar tarefa nele sÃ³ por conhecer o id da sessÃ£o.
    const hers = (await b.svc.create('p', { title: 'Da Ana', description: 'x', staffId: 'ana-1', reviewerId: null }))!;
    await b.svc.start('p', hers.id);
    const anaWork = (await b.get(hers.id)).sessionId!;
    const sub = await delegar(b, anaWork);
    expect(sub.parentTaskId).toBeUndefined();
    expect((await b.get(hers.id)).subtasks).toBeUndefined();
    expect((await b.get(mine.card)).subtasks).toBeUndefined();
  });

  it('card automÃ¡tico (conversa direta) e card encerrado nÃ£o tÃªm subtarefa', async () => {
    const b = await club(`vinculo-auto-${engine}`, { engine });
    // A Giovana edita arquivo numa conversa sem tarefa: nasce o card automÃ¡tico, que Ã© sÃ³ o registro dela.
    await b.svc.onCodeEdit({ sessionId: 'gio-direta', projectId: 'p', staffId: 'gio-1', engine, cwd: b.dir, files: [path.join(b.dir, 'a.ts')], request: null });
    const auto = (await b.list()).find((t) => t.autoCreated && t.sessionId === 'gio-direta');
    expect(auto).toBeDefined();
    expect((await delegar(b, 'gio-direta')).parentTaskId).toBeUndefined();
    // O card que jÃ¡ fechou (cancelado) nÃ£o ganha subtarefa nova da conversa que foi dele.
    const { card, work } = await orquestrar(b);
    await b.svc.cancel('p', card, { by: 'user' });
    expect((await delegar(b, work)).parentTaskId).toBeUndefined();
  });

  it('o corpo nÃ£o escolhe o vÃ­nculo (parentTaskId do pedido Ã© descartado)', async () => {
    const b = await club(`vinculo-corpo-${engine}`, { engine });
    const { card } = await orquestrar(b);
    const sub = (await b.svc.create('p', { title: 'Forjada', description: 'x', staffId: 'ana-1', reviewerId: null, parentTaskId: card }, 'gio-1', 'gio-outra'))!;
    expect(sub.parentTaskId).toBeUndefined();
    expect((await b.get(sub.id)).parentTaskId).toBeUndefined();
  });
});

describe.each<Engine>(['claude', 'codex'])('(2) fim de turno com subtarefa aberta: %s', (engine) => {
  it('nÃ£o vai para revisÃ£o, fica em fazendo aguardando, e a prÃ³xima da fila dele comeÃ§a', async () => {
    const b = await club(`espera-${engine}`, { engine });
    const { card, work } = await orquestrar(b);
    const sub = await delegar(b, work);
    const outro = (await b.svc.create('p', { title: 'Outro card', description: 'x', staffId: 'gio-1', reviewerId: null }))!;
    await b.svc.start('p', outro.id);
    // Com o turno rodando o card ocupa a Giovana: o outro espera na fila.
    expect(await b.get(outro.id)).toMatchObject({ status: 'todo', sessionId: null });
    expect((await b.get(outro.id)).queuedAt).toBeTruthy();

    await endTurn(b, work);

    const waiting = await b.get(card);
    expect(waiting.status).toBe('doing');
    expect(waiting.delivery).toBeUndefined();
    expect(waiting.checkpoint).toBeUndefined();
    expect(waiting.history.at(-1)).toMatchObject({ status: 'doing', by: 'auto', note: `aguardando subtarefas (${sub.id})` });
    expect(waiting.awaitingSubtasks?.since).toEqual(expect.any(String));
    expect(waiting.subtasks).toEqual([{ id: sub.id, title: 'Parte A', status: 'todo', staffId: 'ana-1' }]);
    // NinguÃ©m Ã© avisado de entrega (o revisor nÃ£o vÃª uma "entrega" sem diff).
    expect(b.h.notified).toEqual([]);
    // NÃ£o ocupa: a prÃ³xima da fila dele comeÃ§ou, com conversa prÃ³pria.
    expect(await b.get(outro.id)).toMatchObject({ status: 'doing', sessionId: expect.stringMatching(/^gio-1-/) });
    expect((await b.get(outro.id)).queuedAt).toBeFalsy();
  });

  it('o outro fim de turno (mesma conversa, subtarefa ainda aberta) nÃ£o repete a nota nem sai da espera', async () => {
    const b = await club(`espera-repete-${engine}`, { engine });
    const { card, work } = await orquestrar(b);
    await delegar(b, work);
    await endTurn(b, work);
    const notes = (await b.get(card)).history.filter((h) => /aguardando subtarefas/.test(h.note ?? '')).length;
    // Um desfecho de outra subtarefa acorda a conversa; ela responde "ainda aguardo" e o turno acaba de novo.
    b.h.working.add(work);
    await endTurn(b, work, 'Ainda aguardo as outras.');
    const again = await b.get(card);
    expect(again.status).toBe('doing');
    expect(again.history.filter((h) => /aguardando subtarefas/.test(h.note ?? '')).length).toBe(notes);
    expect(again.awaitingSubtasks).toBeDefined();
  });

  it('o tick nÃ£o toma o card aguardando por conversa Ã³rfÃ£ (nÃ£o manda "continue")', async () => {
    const b = await club(`espera-tick-${engine}`, { engine });
    const { card, work } = await orquestrar(b);
    await delegar(b, work);
    await endTurn(b, work);
    await b.svc.tick(new Date(Date.now() + DAY));
    expect(b.h.delivered).toEqual([]);
    expect((await b.get(card)).status).toBe('doing');
    expect((await b.get(card)).history.some((h) => /parou sem terminar/.test(h.note ?? ''))).toBe(false);
  });

  it('mensagem sua na conversa o tira da espera: ele volta a ocupar o funcionÃ¡rio', async () => {
    const b = await club(`espera-msg-${engine}`, { engine });
    const { card, work } = await orquestrar(b);
    await delegar(b, work);
    await endTurn(b, work);
    expect((await b.get(card)).awaitingSubtasks).toBeDefined();
    await b.svc.onSent(work);
    expect((await b.get(card)).awaitingSubtasks).toBeUndefined();
    // Voltou a ocupar: a que entrar na fila agora espera.
    b.h.working.add(work);
    const outro = (await b.svc.create('p', { title: 'Depois', description: 'x', staffId: 'gio-1', reviewerId: null }))!;
    await b.svc.start('p', outro.id);
    expect(await b.get(outro.id)).toMatchObject({ status: 'todo', sessionId: null });
  });

  it('subtarefa de outra conversa (sem vÃ­nculo) aberta nÃ£o segura o card: ele vai para revisÃ£o', async () => {
    const b = await club(`espera-alheia-${engine}`, { engine });
    const { card, work } = await orquestrar(b);
    const alheia = await delegar(b, 'gio-outra-conversa', 'Sem relaÃ§Ã£o');
    expect(alheia.parentTaskId).toBeUndefined();
    await endTurn(b, work, 'Feito.');
    expect((await b.get(card)).status).toBe('review');
    expect((await b.get(card)).awaitingSubtasks).toBeUndefined();
  });
});

describe.each<Engine>(['claude', 'codex'])('(3) e (4) subtarefa fechada: %s', (engine) => {
  it('cancelada conta como fechada: com todas fechadas o fim de turno vai para revisÃ£o, como hoje', async () => {
    const b = await club(`fechada-${engine}`, { engine });
    const { card, work } = await orquestrar(b);
    const a = await delegar(b, work, 'Parte A');
    const c = await delegar(b, work, 'Parte C');
    await b.svc.cancel('p', a.id, { by: 'user' });
    await b.svc.update('p', c.id, { status: 'done' });
    await endTurn(b, work, 'Tudo pronto, segue o resumo.');
    const done = await b.get(card);
    expect(done.status).toBe('review');
    expect(done.awaitingSubtasks).toBeUndefined();
    expect(done.delivery?.summary).toBe('Tudo pronto, segue o resumo.');
    expect(done.history.at(-1)).toMatchObject({ status: 'review', by: 'auto', note: 'turno terminou' });
    // A entrega avisa quem pediu o card, como sempre (os avisos a `gio-1` são os desfechos das subtarefas, que chegam à conversa dela pelo fluxo de sempre).
    expect(b.h.notified.filter((n) => n.staffId === 'ana-1')).toEqual([expect.objectContaining({ sessionId: 'ana-s' })]);
    expect(b.h.notified.filter((n) => n.staffId === 'gio-1').length).toBeGreaterThan(0);
    // As subtarefas seguem listadas (com a coluna de cada uma) para a tela.
    expect((await b.get(card)).subtasks?.map((s) => [s.id, s.status])).toEqual([
      [a.id, 'cancelled'],
      [c.id, 'done'],
    ]);
  });

  it('espera, as subtarefas fecham, e a prÃ³xima entrega (sem subtarefa aberta) vai para revisÃ£o', async () => {
    const b = await club(`fechou-depois-${engine}`, { engine });
    const { card, work } = await orquestrar(b);
    const a = await delegar(b, work, 'Parte A');
    const c = await delegar(b, work, 'Parte C');
    await endTurn(b, work);
    expect((await b.get(card)).awaitingSubtasks).toBeDefined();
    // Uma fecha: ainda hÃ¡ outra aberta, a espera segue (e ele nÃ£o ocupa).
    await b.svc.cancel('p', a.id, { by: 'user' });
    expect((await b.get(card)).awaitingSubtasks).toBeDefined();
    // A Ãºltima fecha: a marca sai da listagem (nada mais a esperar). O desfecho chega Ã  conversa dele pelo fluxo de sempre.
    await b.svc.update('p', c.id, { status: 'done' });
    expect((await b.get(card)).awaitingSubtasks).toBeUndefined();
    expect((await b.get(card)).status).toBe('doing');
    // A conversa trabalha com o desfecho e entrega: revisÃ£o.
    b.h.working.add(work);
    await endTurn(b, work, 'Integrei as partes.');
    const delivered = await b.get(card);
    expect(delivered.status).toBe('review');
    expect(delivered.delivery?.summary).toBe('Integrei as partes.');
    expect(b.h.notified.filter((n) => n.staffId === 'ana-1')).toHaveLength(1);
  });

  it('subtarefa apagada tambÃ©m conta como fechada', async () => {
    const b = await club(`apagada-${engine}`, { engine });
    const { card, work } = await orquestrar(b);
    const a = await delegar(b, work);
    expect(await b.svc.remove('p', a.id)).toBe(true);
    await endTurn(b, work, 'Feito.');
    expect((await b.get(card)).status).toBe('review');
  });

  it('sem nenhuma subtarefa o fim de turno entrega como sempre', async () => {
    const b = await club(`sem-sub-${engine}`, { engine });
    const { card, work } = await orquestrar(b);
    await endTurn(b, work, 'Feito.');
    const done = await b.get(card);
    expect(done.status).toBe('review');
    expect(done.subtasks).toBeUndefined();
  });
});
