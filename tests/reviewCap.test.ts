import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Caller } from '../server/callers';
import { CAP_REOPENS_MAX, ownAlerts, readTasks, stuckReason, TaskConflictError, TaskError, TaskForbiddenError, TaskService } from '../server/tasks';
import { AUTO_REVIEW_ROUNDS, type StaffProfile, type Task } from '../shared/model';
import { removeTemp } from './support/tmp';

// Limite de revisões automáticas sem o dono (t-e0fae2): ao reprovar `AUTO_REVIEW_ROUNDS` vezes, a decisão vai a quem pediu a tarefa (`requestedBy`), que aceita com trade-off, reabre com instrução
// nova (uma rodada a mais, contada) ou cancela. O dono decide só quando o pedido foi dele, não há quem pediu, ou o gestor não respondeu no prazo. Aqui, a parte sem git: o pedido, o aviso, o prazo,
// a autorização e os três caminhos sem worktree (a aceitação com worktree e mescla automática está em autoMerge.test.ts).

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-cap-'));
});
afterAll(() => removeTemp(root));

const person = (id: string, name: string, over: Partial<StaffProfile> = {}) => ({ id, name, role: 'Dev', autonomy: 'acceptEdits', worktree: false, servers: [], reportsTo: [], projectId: 'p', ...over }) as unknown as StaffProfile;
const caller = (staffId: string | null, over: Partial<Caller> = {}): Caller => ({ staffId, projectId: 'p', sessionId: `c-${staffId}`, engine: 'claude', sandbox: false, ...over });
const min = (n: number) => n * 60_000;
const R1 = 'R1 | a.ts:1 | quebrou o export | rode o teste do export';
const block = (...lines: string[]) => ['[BLOQUEADORES]', ...lines, '[/BLOQUEADORES]'].join('\n');

/** Gio é o gestor (pede os cards); Ana faz e reporta a ele; Rui revisa; Dev é de fora. `notifyFails`: o aviso ao gestor lança. */
async function board(dirName: string, o: { notifyFails?: boolean } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const people: Record<string, StaffProfile> = {
    'gio-1': person('gio-1', 'Gio', { role: 'Orquestrador' }),
    'ana-1': person('ana-1', 'Ana', { reportsTo: ['gio-1'] }),
    'rev-1': person('rev-1', 'Rui', { role: 'Revisor' }),
    'dev-1': person('dev-1', 'Dev'),
  };
  const h = {
    sent: [] as Array<{ staffId: string; session: string; text: string }>,
    to: [] as Array<{ staffId: string; session: string; text: string }>,
    notified: [] as Array<{ staffId: string; text: string; session: string | null }>,
    said: new Map<string, string>(),
    n: 0,
    notifyFails: !!o.notifyFails,
  };
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId, text) => {
      const session = `${staffId}-${++h.n}`;
      h.sent.push({ staffId, session, text });
      return session;
    },
    sendTo: async (_p, session, staffId, text) => {
      h.to.push({ staffId, session, text });
      return session;
    },
    branchFor: async () => null,
    isWorking: () => false,
    isSessionWorking: () => false,
    lastText: (session) => h.said.get(session) ?? null,
    notify: async (_p, staffId, text, session) => {
      if (h.notifyFails) throw new Error('conversa fechada');
      h.notified.push({ staffId, text, session: session ?? null });
    },
    hasAsk: () => false,
    answerAsk: () => false,
    awaitingLimit: async () => false,
    apiUrl: 'http://127.0.0.1:4848',
    sandboxApiUrl: 'http://127.0.0.2:4848',
  });
  const get = async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)!;
  const reviews = () => h.sent.filter((s) => s.staffId === 'rev-1');
  /** O Rui reprova a revisão `session` (com o bloco de 🔴) e a Ana ajusta e entrega de novo. */
  const rejectAndRedeliver = async (id: string, work: string) => {
    const review = (await get(id)).review!.sessionId;
    h.said.set(review, `REPROVADO\n🔴 a.ts:1 quebrou o export\n${block(R1)}`);
    await svc.onTurnDone(review);
    await svc.onTurnDone(work);
  };
  /** A Ana entrega e o Rui reprova `AUTO_REVIEW_ROUNDS` vezes; a entrega seguinte já não pede revisão (o limite). `by`: quem pede o card (Gio), ou ninguém (o dono). */
  const capped = async (title: string, by: 'gio-1' | null = 'gio-1', beforeCap?: () => void) => {
    const t = (await svc.create('p', { title, description: `desc de ${title}`, acceptance: `critério de ${title}`, staffId: 'ana-1', reviewerId: 'rev-1' }, by ?? undefined, by ? 'c-gio-1' : undefined))!;
    await svc.start('p', t.id);
    const work = (await get(t.id)).sessionId!;
    await svc.onTurnDone(work); // rodada 1
    beforeCap?.();
    for (let i = 0; i < AUTO_REVIEW_ROUNDS; i++) await rejectAndRedeliver(t.id, work);
    return { id: t.id, work };
  };
  /** O card como está gravado agora (sem o cache do serviço). */
  const disk = async (id: string) => (await readTasks(dir)).find((t) => t.id === id)!;
  return { dir, svc, h, get, disk, reviews, capped, rejectAndRedeliver, people };
}
type Board = Awaited<ReturnType<typeof board>>;

const asked = (b: Board) => b.h.notified.filter((n) => n.text.includes('revisões automáticas'));

describe('o limite vai a quem pediu a tarefa, e o dono só decide quando o pedido foi dele', () => {
  it('pedido por gestor: ele recebe o pedido de decisão (com os 🔴, o commit e os três caminhos) e NADA vai para a caixa do dono', async () => {
    const b = await board('gestor');
    const { id } = await b.capped('Relatório');
    const t = await b.get(id);
    expect(b.reviews()).toHaveLength(AUTO_REVIEW_ROUNDS);
    expect(t).toMatchObject({ status: 'review', reviewRounds: AUTO_REVIEW_ROUNDS, capWait: { to: 'manager', deliveryAt: t.delivery?.at ?? null, sha: null, items: [{ id: 'R1', where: 'a.ts:1', problem: 'quebrou o export' }] } });
    expect(t.capWait!.deliveredAt).toBeTruthy();
    expect(t.capWait!.notifyRetry).toBeUndefined();
    expect(t.history.map((x) => x.note)).toContain(`limite de ${AUTO_REVIEW_ROUNDS} revisões automáticas; o que sobrou vai a quem pediu decidir: aceitar com trade-off, reabrir com instrução nova ou cancelar`);

    // O aviso foi à conversa em que o Gio pediu, com os 🔴 como dado do funcionário e os três caminhos (ferramenta e curl).
    expect(asked(b)).toHaveLength(1);
    const msg = asked(b)[0]!;
    expect(msg).toMatchObject({ staffId: 'gio-1', session: 'c-gio-1' });
    expect(msg.text).toContain(`(id \`${id}\`) usou as ${AUTO_REVIEW_ROUNDS} revisões automáticas`);
    expect(msg.text).toContain('R1 · a.ts:1 — quebrou o export');
    expect(msg.text).toContain('mcp__myco-tarefa__tarefa_decidir_limite');
    for (const decision of ['accept', 'reopen', 'cancel']) expect(msg.text).toContain(`"decision": "${decision}"`);
    expect(msg.text).toContain(`http://127.0.0.1:4848/api/projects/p/tasks/${id}/review-limit`);
    expect(msg.text).toContain(`Sem decisão em 30 min, o pedido vai para a caixa do usuário.`);

    // Com o gestor decidindo, o dono não recebe item nenhum (só o aviso ao gestor), e o motivo diz quem decide.
    expect(ownAlerts(await readTasks(b.dir))).toEqual([]);
    expect(stuckReason(t)).toBe('limite de revisões automáticas atingido: espera quem pediu decidir (aceitar com trade-off, reabrir com instrução nova ou cancelar)');
  });

  it('pedido pelo dono (sem requestedBy): o dono decide, com item na caixa, e ninguém é avisado', async () => {
    const b = await board('dono');
    const { id } = await b.capped('Relatório', null);
    const t = await b.get(id);
    expect(t).toMatchObject({ status: 'review', capWait: { to: 'owner' } });
    expect(t.capWait!.deliveredAt).toBeUndefined();
    expect(t.capWait!.notifyRetry).toBeUndefined();
    expect(b.h.notified).toEqual([]); // card do dono: ninguém recebeu nada (nem as entregas)
    const alerts = ownAlerts(await readTasks(b.dir));
    expect(alerts.map((a) => [a.task.id, a.state.humanAction, a.state.reason])).toEqual([[id, 'decide', 'limite de revisões automáticas atingido: espera você decidir (aceitar com trade-off, reabrir com instrução nova ou cancelar)']]);
  });

  it('o gestor que pediu saiu do projeto: o pedido nasce com o dono', async () => {
    const b = await board('gestor-saiu');
    const { id } = await b.capped('Relatório', 'gio-1', () => delete b.people['gio-1']); // sai da equipe depois de pedir
    expect(await b.get(id)).toMatchObject({ capWait: { to: 'owner' } });
    expect(asked(b)).toEqual([]); // o aviso do limite não foi a ninguém (os das entregas, ao gestor, são outros)
  });

  it('o pedido é uma vez por entrega: o tick e uma segunda chamada não repetem o aviso nem a nota', async () => {
    const b = await board('uma-vez');
    const { id } = await b.capped('Relatório');
    const before = await b.get(id);
    await b.svc.tick();
    await b.svc.tick();
    await (b.svc as unknown as { autoReview(p: string, t: Task): Promise<void> }).autoReview('p', before);
    const after = await b.get(id);
    expect(after.capWait).toEqual(before.capWait);
    expect(after.history).toEqual(before.history);
    expect(asked(b)).toHaveLength(1);
  });
});

describe('o prazo: 30 min contados da entrega do aviso ao gestor, não do limite', () => {
  it('entregue, sem decisão: antes de 30 min nada muda; passados, o pedido vai ao dono (item na caixa) com a nota do motivo', async () => {
    const b = await board('prazo');
    const { id } = await b.capped('Relatório');
    const t = await b.get(id);
    const delivered = Date.parse(t.capWait!.deliveredAt!);
    await b.svc.tick(new Date(delivered + min(29)));
    expect((await b.get(id)).capWait).toMatchObject({ to: 'manager' });
    expect(ownAlerts(await readTasks(b.dir))).toEqual([]);

    await b.svc.tick(new Date(delivered + min(31)));
    const out = await b.get(id);
    expect(out.capWait).toMatchObject({ to: 'owner', escalatedAt: expect.any(String) });
    expect(out.history.at(-1)?.note).toBe('limite de revisões: a decisão de quem pediu foi para você (ninguém decidiu em 30 min)');
    expect(ownAlerts(await readTasks(b.dir)).map((a) => [a.task.id, a.state.humanAction])).toEqual([[id, 'decide']]);
  });

  it('conta da entrega do aviso: com o limite de 40 min atrás e o aviso entregue há 10, ainda é do gestor', async () => {
    const b = await board('prazo-entrega');
    const { id } = await b.capped('Relatório');
    const t = await b.get(id);
    const now = Date.parse(t.capWait!.deliveredAt!) + min(10);
    const file = path.join(b.dir, '.myco', 'tasks.json');
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    all[0]!.capWait.since = new Date(now - min(40)).toISOString();
    all[0]!.capWait.deliveredAt = new Date(now - min(10)).toISOString();
    await fs.writeFile(file, JSON.stringify(all));
    await b.svc.tick(new Date(now));
    expect((await b.disk(id)).capWait).toMatchObject({ to: 'manager' });
    await b.svc.tick(new Date(now + min(21)));
    expect((await b.disk(id)).capWait).toMatchObject({ to: 'owner' });
  });

  it('aviso que não chega: tenta de novo com backoff; com o retry esgotado (30 min desde a primeira falha) o pedido vai ao dono', async () => {
    const b = await board('aviso-falha', { notifyFails: true });
    const { id } = await b.capped('Relatório');
    const t = await b.get(id);
    expect(t.capWait).toMatchObject({ to: 'manager', notifyRetry: { attempts: 1 } });
    expect(t.capWait!.deliveredAt).toBeUndefined();
    expect(ownAlerts(await readTasks(b.dir))).toEqual([]);
    const first = Date.parse(t.capWait!.notifyRetry!.firstAt);
    // Dentro do prazo o tick só tenta de novo (e falha): segue com o gestor.
    await b.svc.tick(new Date(first + min(20)));
    expect((await b.get(id)).capWait).toMatchObject({ to: 'manager' });
    // Esgotado o retry, escala já no tick, sem esperar a próxima tentativa.
    await b.svc.tick(new Date(first + min(31)));
    const out = await b.get(id);
    expect(out.capWait).toMatchObject({ to: 'owner' });
    expect(out.history.at(-1)?.note).toContain('o aviso ao gestor não chegou');
    expect(ownAlerts(await readTasks(b.dir)).map((a) => a.task.id)).toEqual([id]);
  });

  it('depois de escalado, só o dono decide: o gestor leva 403 e o dono (pela tela) decide', async () => {
    const b = await board('escalado');
    const { id } = await b.capped('Relatório');
    await b.svc.tick(new Date(Date.parse((await b.get(id)).capWait!.deliveredAt!) + min(31)));
    await expect(b.svc.decideCap('p', id, caller('gio-1'), false, { decision: 'accept', justification: 'ok' })).rejects.toBeInstanceOf(TaskForbiddenError);
    expect((await b.get(id)).capWait).toMatchObject({ to: 'owner' });
    const out = await b.svc.decideCap('p', id, null, true, { decision: 'accept', justification: 'o dono aceita' });
    expect(out).toMatchObject({ status: 'done', capAccepted: { by: 'o usuário', justification: 'o dono aceita' } });
  });
});

describe('quem pode decidir', () => {
  it('só quem pediu (com o token) ou o usuário: o responsável, o revisor e os de fora levam 403 e nada muda; sem o limite, 409; id inexistente, null', async () => {
    const b = await board('autoriza');
    const { id } = await b.capped('Relatório');
    const before = await b.disk(id);
    const body = { decision: 'accept', justification: 'tento' };
    for (const who of [caller('ana-1', { sessionId: before.sessionId! }), caller('rev-1'), caller('dev-1'), caller(null), caller('gio-1', { projectId: 'outro' })]) {
      await expect(b.svc.decideCap('p', id, who, false, body), `${who.staffId}`).rejects.toBeInstanceOf(TaskForbiddenError);
    }
    await expect(b.svc.decideCap('p', id, null, false, body)).rejects.toBeInstanceOf(TaskForbiddenError); // sem token e sem ser a tela
    expect(await b.disk(id)).toEqual(before);
    expect(await b.svc.decideCap('p', 't-000000', caller('gio-1'), false, body)).toBeNull();

    const other = await board('autoriza-sem-limite');
    const t = (await other.svc.create('p', { title: 'Em andamento', staffId: 'ana-1', reviewerId: 'rev-1' }, 'gio-1', 'c-gio-1'))!;
    await expect(other.svc.decideCap('p', t.id, caller('gio-1'), false, body)).rejects.toBeInstanceOf(TaskConflictError);
  });

  it('corpo inválido: 400 antes de qualquer coisa (decisão desconhecida, texto vazio, campo do outro caminho, campo desconhecido)', async () => {
    const b = await board('corpo');
    const { id } = await b.capped('Relatório');
    const before = await b.disk(id);
    for (const body of [
      {},
      { decision: 'aprovar' },
      { decision: 'accept' },
      { decision: 'accept', justification: '   ' },
      { decision: 'accept', justification: 'ok', reason: 'x' },
      { decision: 'reopen', justification: 'ok' },
      { decision: 'cancel', instruction: 'x' },
      { decision: 'cancel', reason: 'x'.repeat(2001) },
      { decision: 'reopen', instruction: 'x', extra: 1 },
    ]) {
      await expect(b.svc.decideCap('p', id, caller('gio-1'), false, body), JSON.stringify(body)).rejects.toBeInstanceOf(TaskError);
    }
    expect(await b.disk(id)).toEqual(before);
  });

  it('decidido uma vez: a segunda decisão (outra chamada, ou a do dono) é 409 e não grava nada', async () => {
    const b = await board('duas-vezes');
    const { id } = await b.capped('Relatório');
    await b.svc.decideCap('p', id, caller('gio-1'), false, { decision: 'accept', justification: 'ok' });
    const done = await b.disk(id);
    expect(done.status).toBe('done');
    await expect(b.svc.decideCap('p', id, caller('gio-1'), false, { decision: 'cancel', reason: 'não' })).rejects.toBeInstanceOf(TaskConflictError);
    await expect(b.svc.decideCap('p', id, null, true, { decision: 'reopen', instruction: 'refaça' })).rejects.toBeInstanceOf(TaskConflictError);
    expect(await b.disk(id)).toEqual(done);
  });
});

describe('aceitar com trade-off (sem worktree: o mesmo caminho da aprovação, que vai a pronto)', () => {
  it('grava os 🔴 aceitos, a justificativa e o commit da entrega; a tarefa vai a pronto e o pedido some', async () => {
    const b = await board('aceita');
    const { id } = await b.capped('Relatório');
    const at = (await b.get(id)).delivery?.at ?? null;
    const out = await b.svc.decideCap('p', id, caller('gio-1'), false, { decision: 'accept', justification: 'o export legado nem usa esse caminho' });
    expect(out).toMatchObject({
      status: 'done',
      capAccepted: {
        by: 'Gio',
        justification: 'o export legado nem usa esse caminho',
        deliveryAt: at,
        sha: null,
        items: [{ id: 'R1', where: 'a.ts:1', problem: 'quebrou o export' }],
      },
    });
    expect(out!.capWait).toBeUndefined();
    expect(out!.history.at(-1)?.note).toBe('aceita com trade-off por Gio');
    expect(stuckReason(out!)).toBeNull();
  });

  it('o dono (pela tela) também aceita, e assina como "o usuário"', async () => {
    const b = await board('aceita-dono');
    const { id } = await b.capped('Relatório', null);
    const out = await b.svc.decideCap('p', id, null, true, { decision: 'accept', justification: 'vale' });
    expect(out).toMatchObject({ status: 'done', capAccepted: { by: 'o usuário', justification: 'vale' } });
  });

  it('com a conclusão reservada ao dono (política manual), aceitar NÃO leva a pronto: grava e espera a aprovação dele, como uma aprovação', async () => {
    const b = await board('aceita-politica-dono');
    const policy = {
      get: async () => ({ mode: 'manual', source: 'stored', completionChosen: true, plan: 'owner', completion: 'owner', commit: false }) as never,
    };
    (b.svc as unknown as { deps: { flow: unknown } }).deps.flow = policy;
    const { id } = await b.capped('Relatório');
    const out = await b.svc.decideCap('p', id, caller('gio-1'), false, { decision: 'accept', justification: 'ok' });
    expect(out).toMatchObject({ status: 'review', capAccepted: { by: 'Gio' }, ownerGate: { why: 'approved', by: 'Gio (trade-off)' } });
    expect(out!.capWait).toBeUndefined();
    expect(out!.history.at(-1)?.note).toBe('aceita com trade-off por Gio; falta sua aprovação');
    // Já aceita: não volta a ser "parada no limite" (a decisão foi tomada), e só o dono a leva a pronto.
    expect(stuckReason(out!)).toBe('aprovada por Gio (trade-off); falta sua aprovação');
  });
});

describe('reabrir com instrução nova: uma rodada a mais, contada', () => {
  it('volta ao responsável com a instrução e os 🔴; a próxima entrega tem UMA revisão e, reprovada, a decisão volta a quem pediu', async () => {
    const b = await board('reabre');
    const { id, work } = await b.capped('Relatório');
    const out = await b.svc.decideCap('p', id, caller('gio-1'), false, { decision: 'reopen', instruction: 'cubra o caso de arquivo vazio' });
    expect(out).toMatchObject({ status: 'doing', reviewRounds: AUTO_REVIEW_ROUNDS - 1, capReopens: 1 });
    expect(out!.capWait).toBeUndefined();
    expect(out!.history.at(-1)?.note).toContain(`reabriu com instrução nova (cubra o caso de arquivo vazio); uma rodada de revisão a mais (reabertura 1/${CAP_REOPENS_MAX})`);
    // A instrução vai à conversa de trabalho, com os 🔴 em aberto.
    const msg = b.h.to.filter((m) => m.session === work).at(-1)!;
    expect(msg.text).toContain('cubra o caso de arquivo vazio');
    expect(msg.text).toContain('R1 · a.ts:1 — quebrou o export');
    expect(msg.text).toContain(`reabertura 1 de no máximo ${CAP_REOPENS_MAX}`);

    // A entrega seguinte pede a revisão (a 4ª do Rui) e só ela: reprovada, é o limite de novo.
    const reviewsBefore = b.reviews().length;
    await b.svc.onTurnDone(work);
    expect(b.reviews()).toHaveLength(reviewsBefore + 1);
    expect(await b.get(id)).toMatchObject({ status: 'review', reviewRounds: AUTO_REVIEW_ROUNDS });
    await b.rejectAndRedeliver(id, work);
    expect(b.reviews()).toHaveLength(reviewsBefore + 1); // não pediu a 5ª
    const again = await b.get(id);
    expect(again).toMatchObject({ status: 'review', capReopens: 1, capWait: { to: 'manager' } });
    expect(asked(b)).toHaveLength(2); // um aviso por limite
  });

  it(`passadas ${CAP_REOPENS_MAX} reaberturas o limite nasce com o dono: a IA não reabre sem fim`, async () => {
    const b = await board('teto');
    const { id, work } = await b.capped('Relatório');
    for (let i = 1; i <= CAP_REOPENS_MAX; i++) {
      expect(await b.get(id), `limite ${i}`).toMatchObject({ capWait: { to: 'manager' } });
      await b.svc.decideCap('p', id, caller('gio-1'), false, { decision: 'reopen', instruction: `volta ${i}` });
      await b.svc.onTurnDone(work);
      await b.rejectAndRedeliver(id, work);
    }
    const t = await b.get(id);
    expect(t).toMatchObject({ status: 'review', capReopens: CAP_REOPENS_MAX, capWait: { to: 'owner' } });
    expect(ownAlerts(await readTasks(b.dir)).map((a) => a.task.id)).toEqual([id]);
    await expect(b.svc.decideCap('p', id, caller('gio-1'), false, { decision: 'reopen', instruction: 'mais uma' })).rejects.toBeInstanceOf(TaskForbiddenError);
  });
});

describe('cancelar no limite', () => {
  it('quem pediu cancela com o motivo: a tarefa fica cancelada e o motivo guarda de onde veio', async () => {
    const b = await board('cancela');
    const { id } = await b.capped('Relatório');
    const out = await b.svc.decideCap('p', id, caller('gio-1'), false, { decision: 'cancel', reason: 'o cliente desistiu' });
    expect(out).toMatchObject({ status: 'cancelled', cancelReason: 'limite de revisões: o cliente desistiu' });
  });
});

describe('o pedido de decisão acaba com o que muda o card', () => {
  it('o dono pede ajuste pelos botões de sempre (volta a Fazendo): o pedido some, e a entrega nova que bate o limite de novo ganha outro', async () => {
    const b = await board('muda-fazendo');
    const { id, work } = await b.capped('Relatório', null);
    const first = (await b.get(id)).capWait!;
    await b.svc.update('p', id, { status: 'doing' });
    expect((await b.get(id)).capWait).toBeUndefined();
    await b.svc.onTurnDone(work);
    const next = (await b.get(id)).capWait!;
    expect(next).toMatchObject({ to: 'owner' });
    expect(next.since).not.toBe(first.since);
  });

  it('delegar a revisão (zera as rodadas) desfaz o pedido: o revisor novo tem as rodadas dele', async () => {
    const b = await board('delega');
    const { id } = await b.capped('Relatório');
    expect((await b.get(id)).capWait).toBeTruthy();
    await b.svc.requestReview('p', id, 'rev-1', false, { assign: true });
    const t = await b.get(id);
    expect(t.capWait).toBeUndefined();
    expect(t).toMatchObject({ status: 'review', reviewRounds: 1 });
  });

  it('um pedido do limite que sobrou de uma entrega anterior não decide a entrega de agora (since diferente: 409)', async () => {
    const b = await board('velho');
    const { id } = await b.capped('Relatório');
    const file = path.join(b.dir, '.myco', 'tasks.json');
    const stale = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    const first = stale[0]!.capWait.since as string;
    // Outra espera no lugar (o que um limite novo gravaria): a decisão lida antes (`first`) já não vale.
    stale[0]!.capWait.since = new Date(Date.parse(first) + 1000).toISOString();
    await fs.writeFile(file, JSON.stringify(stale));
    const priv = b.svc as unknown as { settleCap(p: string, t: Task, input: unknown, who: string, by: string): Promise<Task | null> };
    const old = { ...(await b.get(id)), capWait: { ...(await b.get(id)).capWait!, since: first } } as Task;
    await expect(priv.settleCap('p', old, { decision: 'accept', justification: 'ok' }, 'Gio', 'gio-1')).rejects.toBeInstanceOf(TaskConflictError);
    await expect(priv.settleCap('p', old, { decision: 'cancel', reason: 'x' }, 'Gio', 'gio-1')).rejects.toBeInstanceOf(TaskConflictError);
    await expect(priv.settleCap('p', old, { decision: 'reopen', instruction: 'x' }, 'Gio', 'gio-1')).rejects.toBeInstanceOf(TaskConflictError);
    expect((await b.disk(id)).status).toBe('review');
  });
});
