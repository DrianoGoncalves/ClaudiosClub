import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatManager } from '../server/chat/manager';
import { TaskService } from '../server/tasks';
import type { StaffProfile } from '../shared/model';

// O veredito de um revisor que roda no Codex é lido (t-e2a019, achado na t-6270da): o `TurnWatcher` só vê o status das sessões do Claude, então o fim
// de turno do Codex (`turn.completed` → `onIdle('turn')`) é o único aviso. No Claude o vigia já chama `onTurnDone`: o veredito entra uma vez só por turno.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-review-codex-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noted = (t: { history: Array<{ note?: string }> }, re: RegExp) => t.history.filter((h) => re.test(h.note ?? '')).length;

// ---- o serviço de tarefas com dependências falsas ----

async function board(dirName: string) {
  const dir = path.join(root, dirName);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const people: Record<string, StaffProfile> = {
    'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'acceptEdits', worktree: false, engine: 'codex' } as StaffProfile,
  };
  const h = {
    sentTo: [] as Array<{ session: string; text: string }>,
    said: new Map<string, string>(),
    /** Enquanto houver, a abertura da conversa de revisão espera (os testes da entrega). */
    gate: null as Promise<void> | null,
    k: 0,
  };
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId, _text, _force, _override, reviewOnly) => {
      if (reviewOnly && h.gate) await h.gate;
      return `${staffId}-${++h.k}`;
    },
    sendTo: async (_p, session, _staff, text) => {
      h.sentTo.push({ session, text });
      return session;
    },
    branchFor: async () => null,
    isWorking: () => false,
    isSessionWorking: () => false,
    lastText: (session) => h.said.get(session) ?? null,
    notify: async () => {},
    hasAsk: () => false,
    answerAsk: () => false,
    awaitingLimit: async () => false,
    apiUrl: 'http://127.0.0.1:4848',
  });
  const get = async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)!;
  return { h, svc, get };
}
type Board = Awaited<ReturnType<typeof board>>;

/** A Ana começa e entrega; o Rui (revisor do card) recebe o pedido da 1ª rodada. */
async function round1(b: Board) {
  const t = (await b.svc.create('p', { title: 'Tela', description: 'Mostrar o card', acceptance: 'Sem erro no console', staffId: 'ana-1', reviewerId: 'rev-1' }))!;
  await b.svc.start('p', t.id);
  const work = (await b.get(t.id)).sessionId!;
  await b.svc.onTurnDone(work);
  return { id: t.id, work, review: (await b.get(t.id)).review!.sessionId };
}

describe('revisor no Codex, aviso de ocioso do processo (sem o vigia)', () => {
  it('REPROVADO no fim do turno do Codex: a tarefa sai da revisão, o ajuste volta à conversa de trabalho, uma vez', async () => {
    const b = await board('reprovado');
    const { id, work, review } = await round1(b);
    b.h.said.set(review, 'REPROVADO\n🔴 a.ts:1 quebrou');
    await b.svc.onIdle(review, 'p', 'rev-1', 'turn', 'codex');
    expect(await b.get(id)).toMatchObject({ status: 'doing', review: { sessionId: review, verdict: 'rejected' } });
    expect(b.h.sentTo.filter((m) => m.session === work && /reprovou/.test(m.text))).toHaveLength(1);
    // O mesmo aviso de novo (reinício do fim de turno, por exemplo) não repete o ajuste nem o histórico.
    await b.svc.onIdle(review, 'p', 'rev-1', 'turn', 'codex');
    expect(b.h.sentTo.filter((m) => m.session === work && /reprovou/.test(m.text))).toHaveLength(1);
  });

  it('só o fim de turno do Codex lê: Claude (o vigia já avisa), segundo plano, saída e aviso sem motor não leem', async () => {
    const b = await board('so-codex-turn');
    const { id, review } = await round1(b);
    b.h.said.set(review, 'APROVADO\n🟢 a.ts:2 nome');
    await b.svc.onIdle(review, 'p', 'rev-1', 'turn', 'claude');
    await b.svc.onIdle(review, 'p', 'rev-1', 'background', 'codex');
    await b.svc.onIdle(review, 'p', 'rev-1', 'exit', 'codex');
    await b.svc.onIdle(review, 'p', 'rev-1');
    expect(await b.get(id)).toMatchObject({ status: 'review', review: { sessionId: review } });
    expect((await b.get(id)).review!.doneAt).toBeUndefined();
    await b.svc.onIdle(review, 'p', 'rev-1', 'turn', 'codex');
    expect(await b.get(id)).toMatchObject({ status: 'done', review: { verdict: 'approved' } });
  });

  it('respondeu sem veredito: marca a resposta e o re-pedido, como no Claude', async () => {
    const b = await board('sem-veredito');
    const { id, review } = await round1(b);
    b.h.said.set(review, 'Vou olhar com calma.');
    await b.svc.onIdle(review, 'p', 'rev-1', 'turn', 'codex');
    expect((await b.get(id)).review).toMatchObject({ doneAt: expect.any(String), verdict: null, reaskAt: expect.any(String) });
    expect((await b.get(id)).status).toBe('review');
  });

  it('conversa de revisão de uma rodada anterior não vale (liveReview): o turno dela no Codex não vira veredito', async () => {
    const b = await board('rodada-velha');
    const { id, work, review: first } = await round1(b);
    b.h.said.set(first, 'REPROVADO\n🔴 a.ts:1 quebrou');
    await b.svc.onIdle(first, 'p', 'rev-1', 'turn', 'codex');
    expect((await b.get(id)).status).toBe('doing');
    // A Ana entrega de novo e o pedido da rodada 2 demora a sair: a conversa velha ainda tem o REPROVADO antigo como última resposta.
    b.h.gate = new Promise<void>(() => {});
    void b.svc.onTurnDone(work);
    await vi.waitFor(async () => expect(await b.get(id)).toMatchObject({ status: 'review', review: { sessionId: first, superseded: true } }));
    await b.svc.onIdle(first, 'p', 'rev-1', 'turn', 'codex');
    expect((await b.get(id)).status).toBe('review'); // não reprovou de novo
    expect(noted(await b.get(id), /^revisão respondida$/)).toBe(1);
    expect(b.h.sentTo.filter((m) => m.session === work && /reprovou/.test(m.text))).toHaveLength(1);
  });
});

// ---- com o gerente de conversas de verdade (processos falsos): qual evento do Codex dispara, e o Claude uma vez só ----

function fakeClaude(pid: number) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid });
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

/** O gerente de conversas ligado ao serviço de tarefas como o `server/index.ts` liga o `onIdle` (com `reason` e `engine`). SEM o vigia de turnos: ele só existe no Claude. */
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
    onIdle: (sid, pid, staffId, reason, eng) => void svc.onIdle(sid, pid, staffId, reason, eng).catch(() => {}),
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
  /** A execução `i` (o processo do Claude, ou a `i`-ésima execução do Codex) escreve `text`, sem terminar o turno. */
  const say = async (i: number, text: string) => {
    if (engine === 'claude') procs[i]!.emit({ type: 'assistant', message: { id: `m-${i}-${Date.now()}`, model: 'claude', content: [{ type: 'text', text }] } });
    else {
      const run = codex.runs[i]!;
      run.emit({ type: 'turn.started' });
      run.emit({ type: 'item.completed', item: { id: `item_${i}`, type: 'agent_message', text } });
    }
    await sleep(30);
  };
  /** O turno da execução `i` termina: `result` no Claude; `turn.completed` (e o processo fecha) no Codex. */
  const finish = async (i: number, text: string) => {
    if (engine === 'claude') procs[i]!.emit({ type: 'result', is_error: false, result: text });
    else {
      codex.runs[i]!.emit({ type: 'turn.completed' });
      codex.runs[i]!.close(0);
    }
    await sleep(30);
  };
  const opened = () => (engine === 'claude' ? procs.length : codex.runs.length);
  /** Tarefa da Ana com o Rui de revisor: começa, entrega e a conversa de revisão abre (a execução 1). */
  const review = async () => {
    const t = (await svc.create('p', { title: 'Relatório', description: 'Exportar CSV', staffId: 'ana-1', reviewerId: 'rev-1' }))!;
    await svc.start('p', t.id);
    await vi.waitFor(() => expect(opened()).toBeGreaterThan(0));
    await say(0, 'feito');
    await finish(0, 'feito');
    await vi.waitFor(async () => expect((await get(t.id)).review?.sessionId).toBeTruthy(), { timeout: 3_000 });
    await vi.waitFor(() => expect(opened()).toBe(2));
    return { id: t.id, review: (await get(t.id)).review!.sessionId };
  };
  return { m, svc, get, say, finish, review };
}

describe('com o gerente de conversas, sem o vigia de turnos', () => {
  it('Codex: o veredito só é lido no turn.completed (o item com o texto sozinho não basta) e entra uma vez', async () => {
    const w = await wired('real-codex', 'codex');
    const { id, review } = await w.review();
    const read = vi.spyOn(w.svc as unknown as { onReviewTurn: (s: string) => Promise<void> }, 'onReviewTurn');
    await w.say(1, 'APROVADO\n🟢 a.ts:2 nome');
    // O texto do veredito já está na conversa (item.completed), mas o turno não acabou: nada foi lido.
    expect((await w.get(id)).status).toBe('review');
    expect(read.mock.calls.filter(([s]) => s === review)).toHaveLength(0);
    await w.finish(1, 'APROVADO');
    await vi.waitFor(async () => expect(await w.get(id)).toMatchObject({ status: 'done', review: { verdict: 'approved' } }), { timeout: 3_000 });
    expect(read.mock.calls.filter(([s]) => s === review)).toHaveLength(1);
    expect(noted(await w.get(id), /^revisão respondida$/)).toBe(1);
    expect(noted(await w.get(id), /^aprovada por/)).toBe(1);
  });

  it('Claude: o fim de turno do processo não lê (o vigia lê), e o veredito passa por onReviewTurn uma vez só', async () => {
    const w = await wired('real-claude', 'claude');
    const { id, review } = await w.review();
    const read = vi.spyOn(w.svc as unknown as { onReviewTurn: (s: string) => Promise<void> }, 'onReviewTurn');
    await w.say(1, 'APROVADO\n🟢 a.ts:2 nome');
    await w.finish(1, 'APROVADO');
    // O processo avisou o ocioso (`onIdle('turn', 'claude')`) e nada foi lido: quem chama é o TurnWatcher, pelo status da sessão.
    expect((await w.get(id)).status).toBe('review');
    expect(read.mock.calls.filter(([s]) => s === review)).toHaveLength(0);
    await w.svc.onTurnDone(review); // o TurnWatcher: busy → idle
    expect(await w.get(id)).toMatchObject({ status: 'done', review: { verdict: 'approved' } });
    // E um segundo aviso de ocioso do mesmo turno (o `onIdle('background')` de um agent que termina, por exemplo) segue sem ler.
    await w.svc.onIdle(review, 'p', 'rev-1', 'background', 'claude');
    expect(read.mock.calls.filter(([s]) => s === review)).toHaveLength(1);
    expect(noted(await w.get(id), /^revisão respondida$/)).toBe(1);
    expect(noted(await w.get(id), /^aprovada por/)).toBe(1);
  });
});

it('o index.ts repassa o motor do processo ao onIdle das tarefas (ligação sem harness HTTP: conferida pelo texto)', async () => {
  const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
  expect(src).toMatch(/onIdle: \(sid, pid, staffId, reason, engine\) => \{[\s\S]*?tasks\.onIdle\(sid, pid, staffId, reason, engine\)/);
});
