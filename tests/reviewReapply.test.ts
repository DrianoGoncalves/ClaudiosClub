import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TaskService } from '../server/tasks';
import { FLOW_PRESETS, type ChatSnapshot, type FlowPolicy, type StaffProfile } from '../shared/model';
import { removeTemp } from './support/tmp';

// Veredito gravado e não aplicado (t-4f9e84, caso real t-23e7cb): o Club cai (ou erra) entre `noteHandoff` e `approve`/`reject` de `onReviewTurn`, o card segue em "revisão" com
// `review.verdict` e nenhuma decisão, e nada mais olhava para ele. A varredura (`tick`, na subida e a cada minuto) aplica o mesmo efeito, uma vez, e só da revisão desta entrega.

let root: string;
let n = 0;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-review-reapply-'));
});
afterAll(() => removeTemp(root));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OWNER: FlowPolicy = { mode: 'manual', ...FLOW_PRESETS.manual, source: 'stored', completionChosen: true } as FlowPolicy;

async function board() {
  const dir = path.join(root, `p${++n}`);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const file = path.join(dir, '.myco', 'tasks.json');
  const people: Record<string, StaffProfile> = {
    'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    'ger-1': { id: 'ger-1', name: 'Gil', role: 'Gestor', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
  };
  const h = {
    sentTo: [] as Array<{ session: string; text: string }>,
    told: [] as string[],
    /** O que a conversa de revisão escreveu: vira o `lastText` do serviço que estava de pé e o histórico (transcript) que o serviço novo lê. */
    said: new Map<string, string>(),
    /** O decisão do veredito falha (o `readProfile` do revisor lança): o veredito já está gravado, a decisão não. */
    crash: false,
    busyStaff: new Set<string>(),
    flow: null as FlowPolicy | null,
    /** Sem transcript: o histórico da conversa de revisão não tem o texto dela. */
    noTranscript: false,
    slowProfile: 0,
    /** Enquanto houver, a leitura do perfil do revisor (a que o turno e a varredura fazem antes de decidir) espera: os dois chegam à decisão juntos. */
    gate: null as Promise<void> | null,
    /** Quem revisa o card: é o perfil que `crash`, `slowProfile` e `gate` seguram. */
    reviewer: 'rev-1',
    k: 0,
  };
  /** Um serviço de tarefas; `fresh`: o de depois de reiniciar (o que o turno tinha na memória se foi, só o transcript e o card ficam). */
  const service = (fresh: boolean) =>
    new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => {
        if (h.slowProfile && id === h.reviewer) await sleep(h.slowProfile);
        if (h.gate && id === h.reviewer) await h.gate;
        if (h.crash && id === h.reviewer) throw new Error('o Club caiu');
        return people[id] ?? null;
      },
      send: async (_p, staffId) => `${staffId}-${++h.k}`,
      sendTo: async (_p, session, _staff, text) => {
        h.sentTo.push({ session, text });
        return session;
      },
      branchFor: async () => null,
      isWorking: (_p, staffId) => h.busyStaff.has(staffId),
      isSessionWorking: () => false,
      lastText: (session) => (fresh ? null : (h.said.get(session) ?? null)),
      snapshot: async (_p, session) => ({ sessionId: session, history: !h.noTranscript && h.said.has(session) ? [{ kind: 'assistant', id: 'a1', text: h.said.get(session)!, at: null }] : [], live: null }) as unknown as ChatSnapshot,
      notify: async (_p, _s, text) => {
        h.told.push(text);
      },
      hasAsk: () => false,
      answerAsk: () => false,
      awaitingLimit: async () => false,
      apiUrl: 'http://127.0.0.1:4848',
      closeIfIdle: async () => true,
      flow: { get: async () => h.flow } as never,
    });
  const svc = service(false);
  const get = async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)!;
  const edit = async (id: string, fn: (t: Record<string, any>) => void) => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    fn(all.find((t) => t.id === id)!);
    await fs.writeFile(file, JSON.stringify(all));
  };
  /** Quantas notas do histórico começam com `prefix`. */
  const notes = async (id: string, prefix: string) => (await get(id)).history.filter((e) => e.note?.startsWith(prefix)).length;
  return { h, svc, service, get, edit, notes, tick: (s: TaskService = svc) => s.tick(new Date(), 'p') };
}
type Board = Awaited<ReturnType<typeof board>>;

/** A Ana entrega, a revisão abre e o Rui responde `text`, mas o Club cai antes de aplicar: o card fica em revisão com o veredito gravado e sem decisão. */
async function crashedAfter(b: Board, text: string, reviewerId: string | null = 'rev-1') {
  const t = (await b.svc.create('p', { title: 'Tela', description: 'Mostrar o card', acceptance: 'Sem erro no console', staffId: 'ana-1', reviewerId }))!;
  await b.svc.start('p', t.id);
  const work = (await b.get(t.id)).sessionId!;
  await b.svc.onTurnDone(work);
  const review = (await b.get(t.id)).review!.sessionId;
  b.h.said.set(review, text);
  b.h.crash = true;
  await b.svc.onTurnDone(review).catch(() => {});
  b.h.crash = false;
  return { id: t.id, work, review };
}

describe('veredito gravado e não aplicado', () => {
  it('o estado do caso real se reproduz: veredito e "revisão respondida" gravados, nenhuma decisão, card em revisão', async () => {
    const b = await board();
    const { id } = await crashedAfter(b, 'APROVADO\n🟢 a.ts:2 nome');
    const t = await b.get(id);
    expect(t).toMatchObject({ status: 'review', review: { verdict: 'approved' } });
    expect(t.review!.doneAt).toBeTruthy();
    expect(await b.notes(id, 'revisão respondida')).toBe(1);
    expect(await b.notes(id, 'aprovada por')).toBe(0);
    // O que o `chaseReviews` fazia com ele (nada: a revisão "já respondeu"): sem a varredura o card ficava assim para sempre.
    await b.tick(b.service(true));
    expect((await b.get(id)).status).toBe('done');
  });

  it('aprovado: ao subir (serviço novo, sem a memória do turno) a decisão sai e o card vai para pronto, uma vez só', async () => {
    const b = await board();
    const { id } = await crashedAfter(b, 'APROVADO\n🟢 a.ts:2 nome');
    const boot = b.service(true);
    await b.tick(boot);
    expect(await b.get(id)).toMatchObject({ status: 'done', review: { verdict: 'approved' } });
    expect(await b.notes(id, 'aprovada por Rui')).toBe(1);
    // A varredura seguinte (e o mesmo tick em dobro) não decide de novo.
    await b.tick(boot);
    await b.tick();
    expect(await b.notes(id, 'aprovada por')).toBe(1);
    expect((await b.get(id)).history.filter((e) => e.status === 'done')).toHaveLength(1);
  });

  it('reprovado: o ajuste vai à conversa de trabalho com o texto da revisão (lido do histórico), o card volta para fazendo e a rodada conta uma vez', async () => {
    const b = await board();
    const { id, work } = await crashedAfter(b, 'REPROVADO\n🔴 a.ts:1 quebrou o contrato');
    await b.tick(b.service(true));
    const t = await b.get(id);
    expect(t.status).toBe('doing');
    expect(t.rejections).toHaveLength(1);
    expect(t.reworkRounds).toBe(1);
    expect(await b.notes(id, 'reprovada por Rui')).toBe(1);
    const sent = b.h.sentTo.filter((m) => m.session === work && /reprovou/.test(m.text));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('a.ts:1 quebrou o contrato');
    // De novo: o card já não está em revisão (e, com ajuste guardado, a nota de decisão fica), e nada é mandado outra vez.
    await b.tick(b.service(true));
    await b.tick();
    expect(b.h.sentTo.filter((m) => /reprovou/.test(m.text))).toHaveLength(1);
    expect((await b.get(id)).rejections).toHaveLength(1);
  });

  it('o erro sem reinício (o processo seguiu de pé): a mesma varredura resolve, com o `lastText` vivo', async () => {
    const b = await board();
    const { id } = await crashedAfter(b, 'APROVADO');
    await b.tick();
    expect((await b.get(id)).status).toBe('done');
  });

  it('rodada antiga não aplica: a revisão `superseded` (a tarefa foi entregue de novo) e a pedida antes da entrega gravada ficam como estão', async () => {
    const old = await board();
    const a = await crashedAfter(old, 'APROVADO');
    await old.edit(a.id, (t) => {
      t.review.superseded = true;
    });
    await old.tick(old.service(true));
    expect(await old.get(a.id)).toMatchObject({ status: 'review' });
    expect(await old.notes(a.id, 'aprovada por')).toBe(0);

    const early = await board();
    const r = await crashedAfter(early, 'REPROVADO\n🔴 a.ts:1 quebrou');
    await early.edit(r.id, (t) => {
      t.delivery.at = new Date(Date.parse(t.review.at) + 60_000).toISOString(); // entrega depois do pedido: a revisão é de antes
    });
    await early.tick(early.service(true));
    expect(await early.get(r.id)).toMatchObject({ status: 'review' });
    expect(early.h.sentTo.filter((m) => /reprovou/.test(m.text))).toHaveLength(0);
    expect(await early.notes(r.id, 'reprovada por')).toBe(0);
  });

  it('a decisão de uma rodada anterior não conta como aplicada: a reprovação velha (mais velha que a resposta de agora) não segura o veredito novo', async () => {
    const b = await board();
    const { id } = await crashedAfter(b, 'APROVADO');
    await b.edit(id, (t) => {
      t.history.unshift({ at: new Date(Date.parse(t.review.doneAt) - 60_000).toISOString(), status: 'review', by: 'auto', note: 'reprovada por Rui' });
    });
    await b.tick(b.service(true));
    expect((await b.get(id)).status).toBe('done');
  });

  it('a decisão que deixa o card em revisão (aprovada, falta a sua aprovação) fica gravada: a varredura não repete a nota nem o aviso a quem pediu', async () => {
    const b = await board();
    b.h.flow = OWNER;
    const { id } = await crashedAfter(b, 'APROVADO');
    const boot = b.service(true);
    await b.tick(boot);
    expect(await b.get(id)).toMatchObject({ status: 'review', ownerGate: { by: 'Rui' } });
    expect(await b.notes(id, 'aprovada por Rui; falta sua aprovação')).toBe(1);
    await b.tick(boot);
    await b.tick(boot);
    expect(await b.notes(id, 'aprovada por')).toBe(1);
  });

  it('reprovada com a Ana ocupada (ajuste guardado, o card segue em revisão): reaplicar não guarda o ajuste nem conta a rodada de novo', async () => {
    const b = await board();
    const { id } = await crashedAfter(b, 'REPROVADO\n🔴 a.ts:1 quebrou');
    b.h.busyStaff.add('ana-1');
    const boot = b.service(true);
    await b.tick(boot);
    const first = await b.get(id);
    expect(first.status).toBe('review');
    expect(first.held).toHaveLength(1);
    expect(first.rejections).toHaveLength(1);
    await b.tick(boot);
    await b.tick(boot);
    const again = await b.get(id);
    expect(again.held).toHaveLength(1);
    expect(again.rejections).toHaveLength(1);
    expect(again.reworkRounds).toBe(1);
    expect(await b.notes(id, 'reprovada por')).toBe(1);
  });

  it('duas varreduras ao mesmo tempo (a decisão ainda lenta) aplicam uma vez só', async () => {
    const b = await board();
    const { id } = await crashedAfter(b, 'REPROVADO\n🔴 a.ts:1 quebrou');
    b.h.slowProfile = 40;
    const boot = b.service(true);
    await Promise.all([b.tick(boot), b.tick(boot)]);
    expect(b.h.sentTo.filter((m) => /reprovou/.test(m.text))).toHaveLength(1);
    expect((await b.get(id)).rejections).toHaveLength(1);
    expect(await b.notes(id, 'reprovada por')).toBe(1);
  });

  it('o turno ainda aplicando o veredito (gravado, decisão em curso) não leva uma segunda decisão da varredura', async () => {
    const b = await board();
    const t = (await b.svc.create('p', { title: 'Tela', description: 'Mostrar o card', staffId: 'ana-1', reviewerId: 'rev-1' }))!;
    await b.svc.start('p', t.id);
    await b.svc.onTurnDone((await b.get(t.id)).sessionId!);
    const review = (await b.get(t.id)).review!.sessionId;
    b.h.said.set(review, 'REPROVADO\n🔴 a.ts:1 quebrou');
    let open!: () => void;
    b.h.gate = new Promise<void>((resolve) => (open = resolve)); // o `readProfile` do turno segura a decisão depois de o veredito estar gravado
    const live = b.svc.onTurnDone(review);
    await vi.waitFor(async () => expect((await b.get(t.id)).review!.verdict).toBe('rejected')); // gravado, decisão ainda não
    const sweep = b.tick();
    await sleep(100);
    open();
    await Promise.all([live, sweep]);
    expect(b.h.sentTo.filter((m) => /reprovou/.test(m.text))).toHaveLength(1);
    expect((await b.get(t.id)).rejections).toHaveLength(1);
  });

  it('aprovado no caminho pronto, o turno e a varredura chegando juntos à decisão: o aviso a quem pediu e o despertar dos dependentes saem uma vez só', async () => {
    const b = await board();
    b.h.reviewer = 'ger-1';
    // O gestor que pediu revisa: o desfecho "foi para pronto" vai para a conversa dele (`selfReview`), e é esse aviso que não pode sair em dobro.
    const t = (await b.svc.create('p', { title: 'Tela', description: 'Mostrar o card', staffId: 'ana-1', reviewerId: 'ger-1' }))!;
    await b.edit(t.id, (x) => Object.assign(x, { requestedBy: 'ger-1', requestedSession: 'ger-pediu' }));
    await b.svc.start('p', t.id);
    await b.svc.onTurnDone((await b.get(t.id)).sessionId!);
    const review = (await b.get(t.id)).review!.sessionId;
    const wake = vi.spyOn(b.svc as never as { wakeDependents: () => Promise<void> }, 'wakeDependents');
    let open!: () => void;
    b.h.gate = new Promise<void>((resolve) => (open = resolve));
    b.h.said.set(review, 'APROVADO\n🟢 a.ts:2 nome');
    const live = b.svc.onTurnDone(review);
    await vi.waitFor(async () => expect((await b.get(t.id)).review!.verdict).toBe('approved')); // gravado, a decisão presa no perfil do revisor
    const sweep = b.tick(); // a varredura vê o veredito sem decisão e também chega à decisão
    await sleep(100);
    open();
    await Promise.all([live, sweep]);
    const after = await b.get(t.id);
    expect(after.status).toBe('done');
    expect(after.history.filter((e) => e.status === 'done')).toHaveLength(1);
    expect(b.h.told.filter((m) => /foi para pronto/.test(m))).toHaveLength(1);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('reprovado sem o texto da revisão legível: não manda ajuste vazio nem conta rodada; o card fica com você, com a nota, uma vez', async () => {
    const b = await board();
    const { id } = await crashedAfter(b, 'REPROVADO\n🔴 a.ts:1 quebrou');
    b.h.noTranscript = true;
    const boot = b.service(true);
    await b.tick(boot);
    await b.tick(boot);
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.rejections ?? []).toHaveLength(0);
    expect(b.h.sentTo).toHaveLength(0);
    expect(await b.notes(id, 'reprovada por Rui, mas o texto da revisão não pôde ser lido')).toBe(1);
  });

  it('o último texto da conversa não é o veredito gravado (outro turno por cima): não reprova com ele', async () => {
    const b = await board();
    const { id, review } = await crashedAfter(b, 'REPROVADO\n🔴 a.ts:1 quebrou');
    b.h.said.set(review, 'Obrigado pela resposta.');
    await b.tick(b.service(true));
    expect((await b.get(id)).status).toBe('review');
    expect(b.h.sentTo).toHaveLength(0);
  });

  it('veredito só anotado (revisor do quadro, sem revisor marcado na tarefa) não move o card, como sempre', async () => {
    const b = await board();
    const t = (await b.svc.create('p', { title: 'Tela', description: 'Mostrar o card', staffId: 'ana-1', reviewerId: null }))!;
    await b.svc.start('p', t.id);
    await b.svc.onTurnDone((await b.get(t.id)).sessionId!);
    await b.svc.requestReview('p', t.id, 'rev-1');
    const review = (await b.get(t.id)).review!.sessionId;
    b.h.said.set(review, 'APROVADO');
    await b.svc.onTurnDone(review);
    await b.tick(b.service(true));
    expect(await b.get(t.id)).toMatchObject({ status: 'review', review: { verdict: 'approved' } });
    expect(await b.notes(t.id, 'aprovada por')).toBe(0);
  });

  it('card que não está em revisão (cancelado) com veredito gravado não é tocado', async () => {
    const b = await board();
    const { id } = await crashedAfter(b, 'APROVADO');
    await b.edit(id, (t) => {
      t.status = 'cancelled';
    });
    await b.tick(b.service(true));
    expect((await b.get(id)).status).toBe('cancelled');
    expect(await b.notes(id, 'aprovada por')).toBe(0);
  });
});
