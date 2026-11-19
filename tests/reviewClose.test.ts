import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatManager } from '../server/chat/manager';
import { TaskService } from '../server/tasks';
import type { StaffProfile } from '../shared/model';

// A conversa de revisão é de um tiro só (t-dd474c): com o veredito gravado, o processo dela fecha pelo caminho seguro da t-073009 (sem virar erro
// "saiu com código 1") em vez de ficar vivo até o reap. Parada: fecha na hora; trabalhando: ao fim do turno. Nunca com re-pedido marcado nem a conversa
// de trabalho, a em que o gestor pediu, a do deploy ou a de uma dúvida aberta. Claude e Codex.

let root: string;
let n = 0;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-review-close-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const MIN = 60_000;
const later = (min: number) => new Date(Date.now() + min * MIN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REASKED = /exatamente assim, e depois os achados/;

// ---- o serviço de tarefas com dependências falsas ----

async function board(dirName: string, engine: 'claude' | 'codex') {
  const dir = path.join(root, dirName);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const file = path.join(dir, '.myco', 'tasks.json');
  const people: Record<string, StaffProfile> = {
    'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'acceptEdits', worktree: false, engine } as StaffProfile,
    'ger-1': { id: 'ger-1', name: 'Gil', role: 'Gestor', autonomy: 'acceptEdits', worktree: false, engine } as StaffProfile,
  };
  const h = {
    sent: [] as Array<{ staffId: string; session: string; reviewOnly: boolean | undefined }>,
    sentTo: [] as Array<{ session: string; text: string }>,
    said: new Map<string, string>(),
    /** Cada pedido de fechar (a conversa). */
    closeCalls: [] as string[],
    /** Conversas que "trabalham": o fechamento recusa (false), como o `closeIdle` do gerente. */
    busy: new Set<string>(),
    /** Funcionários ocupados em outra coisa (o ajuste da reprovação fica guardado). */
    busyStaff: new Set<string>(),
    closeError: null as Error | null,
    k: 0,
  };
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId, _text, _force, _override, reviewOnly) => {
      const session = `${staffId}-${++h.k}`;
      h.sent.push({ staffId, session, reviewOnly });
      return session;
    },
    sendTo: async (_p, session, _staff, text) => {
      h.sentTo.push({ session, text });
      return session;
    },
    branchFor: async () => null,
    isWorking: (_p, staffId) => h.busyStaff.has(staffId),
    isSessionWorking: () => false,
    lastText: (session) => h.said.get(session) ?? null,
    notify: async () => {},
    hasAsk: () => false,
    answerAsk: () => false,
    awaitingLimit: async () => false,
    apiUrl: 'http://127.0.0.1:4848',
    closeIfIdle: async (session) => {
      h.closeCalls.push(session);
      if (h.closeError) throw h.closeError;
      return !h.busy.has(session);
    },
  });
  const get = async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)!;
  const edit = async (id: string, fn: (t: Record<string, any>) => void) => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    fn(all.find((t) => t.id === id)!);
    await fs.writeFile(file, JSON.stringify(all));
  };
  return { h, svc, get, edit, engine };
}
type Board = Awaited<ReturnType<typeof board>>;

/** A Ana entrega (com o Rui de revisor) e o pedido de revisão sai: conversa nova do Rui. */
async function delivered(b: Board, reviewerId = 'rev-1') {
  const t = (await b.svc.create('p', { title: 'Tela', description: 'Mostrar o card', acceptance: 'Sem erro no console', staffId: 'ana-1', reviewerId }))!;
  return { id: t.id, ...(await deliver(b, t.id)) };
}
async function deliver(b: Board, id: string) {
  await b.svc.start('p', id);
  const work = (await b.get(id)).sessionId!;
  await b.svc.onTurnDone(work);
  return { work, review: (await b.get(id)).review!.sessionId };
}

describe.each(['claude', 'codex'] as const)('conversa de revisão, revisor no %s', (engine) => {
  it('aprovada: o veredito gravado fecha só a conversa de revisão, e a conversa de trabalho não', async () => {
    const b = await board(`aprovada-${engine}`, engine);
    const { id, work, review } = await delivered(b);
    expect(b.h.closeCalls).toEqual([]); // revisão pedida e ainda sem resposta: nada fecha
    b.h.said.set(review, 'APROVADO\n🟢 a.ts:2 nome');
    await b.svc.onTurnDone(review);
    expect(await b.get(id)).toMatchObject({ status: 'done', review: { verdict: 'approved' } });
    expect(b.h.closeCalls).toEqual([review]);
    expect(b.h.closeCalls).not.toContain(work);
  });

  it('reprovada: o ajuste vai para a conversa de trabalho (que segue aberta) e a de revisão fecha', async () => {
    const b = await board(`reprovada-${engine}`, engine);
    const { id, work, review } = await delivered(b);
    b.h.said.set(review, 'REPROVADO\n🔴 a.ts:1 quebrou');
    await b.svc.onTurnDone(review);
    expect(await b.get(id)).toMatchObject({ status: 'doing', review: { verdict: 'rejected' } });
    expect(b.h.sentTo.filter((m) => m.session === work && /reprovou/.test(m.text))).toHaveLength(1);
    expect(b.h.closeCalls).toEqual([review]);
  });

  it('reprovada com a Ana ocupada: o ajuste fica guardado para a conversa de trabalho (não é da de revisão), e a de revisão fecha', async () => {
    const b = await board(`guardado-${engine}`, engine);
    const { id, review } = await delivered(b);
    b.h.busyStaff.add('ana-1');
    b.h.said.set(review, 'REPROVADO\n🔴 a.ts:1 quebrou');
    await b.svc.onTurnDone(review);
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.held).toHaveLength(1);
    expect(b.h.closeCalls).toEqual([review]);
  });

  it('o veredito só anotado (pedido do quadro sem revisor marcado na tarefa) também fecha: ela já respondeu', async () => {
    const b = await board(`anotado-${engine}`, engine);
    const t = (await b.svc.create('p', { title: 'Tela', description: 'Mostrar o card', staffId: 'ana-1', reviewerId: null }))!;
    await b.svc.start('p', t.id);
    await b.svc.onTurnDone((await b.get(t.id)).sessionId!);
    await b.svc.requestReview('p', t.id, 'rev-1');
    const review = (await b.get(t.id)).review!.sessionId;
    b.h.said.set(review, 'APROVADO');
    await b.svc.onTurnDone(review);
    expect(await b.get(t.id)).toMatchObject({ status: 'review', review: { verdict: 'approved' } }); // não move: o revisor não é o da tarefa
    expect(b.h.closeCalls).toEqual([review]);
  });

  it('ainda trabalhando: não fecha agora, e fecha ao fim do turno (uma vez só)', async () => {
    const b = await board(`trabalhando-${engine}`, engine);
    const { id, review } = await delivered(b);
    b.h.busy.add(review);
    b.h.said.set(review, 'APROVADO\n🟢 a.ts:2 nome');
    await b.svc.onTurnDone(review);
    expect(await b.get(id)).toMatchObject({ status: 'done', review: { verdict: 'approved' } }); // a decisão não espera o fechamento
    expect(b.h.closeCalls).toEqual([review]); // tentou: trabalhando
    // Enquanto ela trabalha, o aviso de "ficou livre" de outra conversa não fecha nada.
    await b.svc.onIdle('rev-1-outra', 'p', 'rev-1');
    expect(b.h.closeCalls).toEqual([review]);
    // O turno terminou: fecha.
    b.h.busy.delete(review);
    await b.svc.onIdle(review, 'p', 'rev-1');
    expect(b.h.closeCalls).toEqual([review, review]);
    // E não tenta de novo nos próximos avisos (a saída do processo também chega aqui).
    await b.svc.onIdle(review, 'p', 'rev-1');
    expect(b.h.closeCalls).toEqual([review, review]);
  });

  it('trabalhando ao fim do turno, mas com o re-pedido marcado ou uma dúvida aberta que chegou nesse meio-tempo: não fecha', async () => {
    const b = await board(`meio-${engine}`, engine);
    const other = (await b.svc.create('p', { title: 'Outra', description: 'Algo', staffId: 'ana-1', reviewerId: null }))!;
    const { review } = await delivered(b);
    b.h.busy.add(review);
    b.h.said.set(review, 'APROVADO');
    await b.svc.onTurnDone(review);
    expect(b.h.closeCalls).toEqual([review]);
    await b.edit(other.id, (t) => (t.question = { id: 'q1', status: 'open', text: 'posso apagar?', askedAt: new Date().toISOString(), managerSession: review }));
    b.h.busy.delete(review);
    await b.svc.onIdle(review, 'p', 'rev-1');
    expect(b.h.closeCalls).toEqual([review]); // conferiu de novo e desistiu
  });

  it('sem veredito não fecha, e o re-pedido ainda chega à conversa dela; com o veredito do re-pedido, fecha', async () => {
    const b = await board(`reask-${engine}`, engine);
    const { id, review } = await delivered(b);
    b.h.said.set(review, 'Vou olhar com calma.');
    await b.svc.onTurnDone(review);
    expect((await b.get(id)).review).toMatchObject({ verdict: null, reaskAt: expect.any(String) });
    expect(b.h.closeCalls).toEqual([]);
    await b.svc.tick(later(11));
    expect(b.h.sentTo.filter((m) => m.session === review && REASKED.test(m.text))).toHaveLength(1);
    expect(b.h.closeCalls).toEqual([]);
    b.h.said.set(review, 'APROVADO\n🟢 a.ts:2 nome');
    await b.svc.onTurnDone(review);
    expect(await b.get(id)).toMatchObject({ status: 'done', review: { verdict: 'approved', reasked: true } });
    expect(b.h.closeCalls).toEqual([review]);
  });

  it('re-pedido marcado e ainda não enviado (`reaskAt`): não fecha, mesmo com o veredito de agora', async () => {
    const b = await board(`reask-marcado-${engine}`, engine);
    const { id, review } = await delivered(b);
    b.h.said.set(review, 'Vou olhar com calma.');
    await b.svc.onTurnDone(review);
    b.h.said.set(review, 'APROVADO');
    await b.svc.onTurnDone(review); // alguém falou com ela antes da cobrança
    const t = await b.get(id);
    expect(t).toMatchObject({ status: 'done', review: { verdict: 'approved' } });
    expect(t.review!.reaskAt).toEqual(expect.any(String));
    expect(t.review!.reasked).toBeUndefined();
    expect(b.h.closeCalls).toEqual([]);
  });

  it('dúvida aberta (de outra tarefa) que chegou por essa conversa: não fecha; resolvida, o próximo fim de turno com veredito fecha', async () => {
    const b = await board(`duvida-${engine}`, engine);
    // A outra tarefa vem antes no quadro: a conversa segue sendo "de revisão" para o serviço (a mais nova do índice vence).
    const other = (await b.svc.create('p', { title: 'Outra', description: 'Algo', staffId: 'ana-1', reviewerId: null }))!;
    const { review } = await delivered(b);
    await b.edit(other.id, (t) => (t.question = { id: 'q1', status: 'open', text: 'posso apagar?', askedAt: new Date().toISOString(), managerSession: review }));
    b.h.said.set(review, 'APROVADO');
    await b.svc.onTurnDone(review);
    expect(b.h.closeCalls).toEqual([]);
    await b.edit(other.id, (t) => (t.question.status = 'answered'));
    await b.svc.onTurnDone(review);
    expect(b.h.closeCalls).toEqual([review]);
  });

  it('gestor que revisa em conversa própria: só a de revisão fecha, nunca a em que ele pediu nem a de trabalho', async () => {
    const b = await board(`gestor-${engine}`, engine);
    const t = (await b.svc.create('p', { title: 'Tela', description: 'Mostrar o card', staffId: 'ana-1', reviewerId: 'ger-1' }))!;
    await b.edit(t.id, (x) => Object.assign(x, { requestedBy: 'ger-1', requestedSession: 'ger-pediu' }));
    const { work, review } = await deliver(b, t.id);
    expect(new Set([work, review, 'ger-pediu']).size).toBe(3);
    b.h.said.set(review, 'APROVADO\n🟢 a.ts:2 nome');
    await b.svc.onTurnDone(review);
    expect(await b.get(t.id)).toMatchObject({ status: 'done', review: { verdict: 'approved' } });
    expect(b.h.closeCalls).toEqual([review]);
  });

  it.each([
    ['a conversa em que o gestor pediu', (review: string, t: Record<string, any>) => (t.requestedSession = review)],
    ['uma conversa de trabalho (também a de antes da troca de motor)', (review: string, t: Record<string, any>) => (t.sessions = [{ id: review, role: 'work', staffId: 'rev-1', engine: 'claude', at: new Date().toISOString() }])],
    ['a conversa de trabalho da tarefa', (review: string, t: Record<string, any>) => (t.sessionId = review)],
    ['a conversa do deploy', (review: string, t: Record<string, any>) => (t.deploy = { staffId: 'rev-1', sessionId: review, at: new Date().toISOString() })],
  ])('nunca fecha %s, mesmo com o veredito dado', async (_name, mark) => {
    const b = await board(`nunca-${engine}-${++n}`, engine);
    const { id, review } = await delivered(b);
    await b.edit(id, (t) => void mark(review, t));
    b.h.said.set(review, 'APROVADO');
    await b.svc.onTurnDone(review);
    expect(b.h.closeCalls).toEqual([]);
  });

  it('o fechamento que falha não vira erro: o veredito decide igual e o reap fecha depois', async () => {
    const b = await board(`falha-${engine}`, engine);
    const { id, review } = await delivered(b);
    b.h.closeError = new Error('a conversa não fechou a tempo; tente de novo');
    b.h.said.set(review, 'APROVADO');
    await expect(b.svc.onTurnDone(review)).resolves.toBeUndefined();
    expect(await b.get(id)).toMatchObject({ status: 'done', review: { verdict: 'approved' } });
    expect(b.h.closeCalls).toEqual([review]);
    // Não fica marcada para tentar a cada fim de turno.
    await b.svc.onIdle(review, 'p', 'rev-1');
    expect(b.h.closeCalls).toEqual([review]);
  });

  it('a conversa de uma rodada anterior (a tarefa foi entregue de novo) não decide nem fecha por um turno velho', async () => {
    const b = await board(`velha-${engine}`, engine);
    const { id, work, review: first } = await delivered(b);
    b.h.said.set(first, 'REPROVADO\n🔴 a.ts:1 quebrou');
    await b.svc.onTurnDone(first);
    expect(b.h.closeCalls).toEqual([first]);
    await b.svc.onTurnDone(work); // nova entrega: outra conversa de revisão
    const second = (await b.get(id)).review!.sessionId;
    expect(second).not.toBe(first);
    await b.svc.onTurnDone(first); // um turno velho da primeira (reaberta por alguém)
    expect(b.h.closeCalls).toEqual([first]); // a da rodada nova segue aberta, esperando o veredito dela
    b.h.said.set(second, 'APROVADO');
    await b.svc.onTurnDone(second);
    expect(b.h.closeCalls).toEqual([first, second]);
  });
});

it('sem o gancho de fechar (o que os outros testes montam), nada muda', async () => {
  const b = await board('sem-gancho', 'claude');
  const { id, review } = await delivered(b);
  b.h.said.set(review, 'APROVADO');
  await b.svc.onTurnDone(review);
  expect((await b.get(id)).status).toBe('done');
});

// ---- com o gerente de conversas de verdade (processos falsos): fecha o processo, sem erro, e a conversa reabre ----

function fakeClaude(pid: number) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid });
  // Sai quando o stdin fecha (como o de verdade), com código 1 (o `taskkill` do Windows): fechar por nós não pode virar "saiu com código 1".
  stdin.on('data', () => {});
  stdin.on('end', () => setImmediate(() => proc.emit('exit', 1)));
  const emit = (ev: object) => stdout.write(JSON.stringify(ev) + '\n');
  return { proc, emit };
}

function fakeCodex() {
  const runs: Array<{ emit: (ev: object) => void; close: (code?: number | null) => void }> = [];
  const spawnImpl = () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    stdin.on('data', () => {});
    // Sem pid: o gerente não tenta encerrar um processo de verdade; quem fecha a execução é o teste.
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough() });
    runs.push({ emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n'), close: (code = 0) => void child.emit('close', code) });
    return child as never;
  };
  return { runs, spawnImpl };
}

/** O gerente de conversas ligado ao serviço de tarefas como o servidor liga (`onIdle`, `isWorking`, `closeIfIdle` pelo `closeIdle`). */
async function wired(dirName: string, engine: 'claude' | 'codex') {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  const chatDir = path.join(dir, 'chats');
  const procs: Array<ReturnType<typeof fakeClaude>> = [];
  const codex = fakeCodex();
  const m: ChatManager = new ChatManager({
    transcriptsDir: chatDir,
    usageFile: path.join(chatDir, 'usage.json'),
    listLive: async () => [],
    resolve: async (_p, sid) =>
      engine === 'codex'
        ? {
            sessionId: sid ?? 'cx-new',
            cwd: dir,
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
              secrets: { projectPath: dir, home: path.join(dir, 'sem-home'), mycoHome: path.join(dir, 'sem-myco') },
              threadId: null,
              threadFile: path.join(dir, `thread-${sid}.json`),
              mycoUrl: 'http://127.0.0.2:4848',
            },
          }
        : { sessionId: sid ?? 'new', cwd: '.', args: [] },
    spawnImpl:
      engine === 'codex'
        ? codex.spawnImpl
        : () => {
            const f = fakeClaude(4242 + procs.length);
            procs.push(f);
            return f.proc as never;
          },
    onIdle: (sid, pid, staffId) => void svc.onIdle(sid, pid, staffId).catch(() => {}),
    log: () => {},
  });
  let k = 0;
  const people: Record<string, StaffProfile> = {
    'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false, engine } as StaffProfile,
    'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'acceptEdits', worktree: false, engine } as StaffProfile,
  };
  const svc: TaskService = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (p, staffId, text) => {
      const sid = `${engine === 'codex' ? 'cx' : 'w'}-${++k}`;
      await m.send(p, sid, staffId, text);
      return sid;
    },
    sendTo: async (p, sid, staffId, text) => {
      await m.send(p, sid, staffId, text);
      return sid;
    },
    branchFor: async () => null,
    isWorking: (p, staffId, except) => m.staffWorking(p, staffId, except),
    isSessionWorking: (sid) => m.isWorking(sid),
    lastText: (sid) => m.lastAssistantText(sid),
    closing: () => m.isClosing(),
    closeIfIdle: async (sid) => (await m.closeIdle((c) => c.sessionId === sid)).working === 0,
  });
  const get = async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)!;
  /** A execução `i` (o processo do Claude, ou a `i`-ésima execução do Codex) responde `text` e termina o turno. */
  const answer = async (i: number, text: string) => {
    if (engine === 'claude') {
      procs[i]!.emit({ type: 'assistant', message: { id: `m-${i}-${Date.now()}`, model: 'claude', content: [{ type: 'text', text }] } });
      procs[i]!.emit({ type: 'result', is_error: false, result: text });
    } else {
      const run = codex.runs[i]!;
      run.emit({ type: 'turn.started' });
      run.emit({ type: 'item.completed', item: { id: `item_${i}`, type: 'agent_message', text } });
      run.emit({ type: 'turn.completed' });
      run.close(0);
    }
    await sleep(30);
  };
  const opened = () => (engine === 'claude' ? procs.length : codex.runs.length);
  /** Tarefa da Ana com o Rui de revisor: começa, entrega e a conversa de revisão abre. */
  const review = async () => {
    const t = (await svc.create('p', { title: 'Relatório', description: 'Exportar CSV', staffId: 'ana-1', reviewerId: 'rev-1' }))!;
    await svc.start('p', t.id);
    const work = (await get(t.id)).sessionId!;
    await vi.waitFor(() => expect(opened()).toBeGreaterThan(0));
    await answer(0, 'feito');
    await vi.waitFor(async () => expect((await get(t.id)).review?.sessionId).toBeTruthy(), { timeout: 3_000 });
    await vi.waitFor(() => expect(opened()).toBe(2));
    return { id: t.id, work, review: (await get(t.id)).review!.sessionId };
  };
  return { m, svc, get, answer, opened, review };
}

describe.each(['claude', 'codex'] as const)('com o gerente de conversas, no %s', (engine) => {
  it('o veredito gravado fecha o processo da conversa de revisão sem virar erro; a de trabalho segue aberta e a de revisão reabre', async () => {
    const w = await wired(`real-${engine}`, engine);
    const { id, work, review } = await w.review();
    expect(w.m.runningSessionIds().sort()).toEqual([work, review].sort());
    await w.answer(1, 'APROVADO\n🟢 a.ts:2 nome');
    // O vigia das sessões avisa o fim do turno (na produção, o TurnWatcher): é ele que lê o veredito.
    await w.svc.onTurnDone(review);
    expect(await w.get(id)).toMatchObject({ status: 'done', review: { verdict: 'approved' } });
    expect(w.m.runningSessionIds()).toEqual([work]);
    expect(w.m.attention()).toEqual([]); // sem "saiu com código 1"
    // Quem mandar mensagem depois a reabre (a sessão continua no disco).
    await w.m.send('p', review, 'rev-1', 'e o outro arquivo?');
    await vi.waitFor(() => expect(w.opened()).toBe(3));
    expect(w.m.runningSessionIds().sort()).toEqual([work, review].sort());
  });

  it('ainda trabalhando quando o veredito é lido: fecha quando o turno termina, sem erro', async () => {
    const w = await wired(`trabalhando-${engine}`, engine);
    const { id, work, review } = await w.review();
    await w.answer(1, 'APROVADO\n🟢 a.ts:2 nome');
    // Antes de o vigia ler o veredito, alguém manda outra mensagem para a conversa de revisão: ela volta a trabalhar.
    await w.m.send('p', review, 'rev-1', 'e o outro arquivo?');
    await vi.waitFor(() => expect(w.m.isWorking(review)).toBe(true));
    await vi.waitFor(() => expect(engine === 'claude' || w.opened() === 3).toBe(true));
    await w.svc.onTurnDone(review);
    expect(await w.get(id)).toMatchObject({ status: 'done', review: { verdict: 'approved' } }); // decidiu, mas não cortou o turno dela
    expect(w.m.runningSessionIds().sort()).toEqual([work, review].sort());
    // O turno termina: o aviso de "ficou livre" fecha a conversa.
    await w.answer(engine === 'claude' ? 1 : 2, 'o outro arquivo está certo');
    await vi.waitFor(() => expect(w.m.runningSessionIds()).toEqual([work]), { timeout: 3_000 });
    expect(w.m.attention()).toEqual([]);
  });
});
