import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ESCALATE_AFTER_MS } from '../server/retryPolicy';
import { releasesStaff, TaskService } from '../server/tasks';
import type { Engine, StaffProfile, Task } from '../shared/model';

// Fila anda com dúvida escalada (t-a914ce): a tarefa com dúvida escalada ao dono e sem nenhuma edição não ocupa o funcionário, e a próxima da
// fila começa; com edição, ou com a dúvida ainda com o gestor, segue ocupando. A resposta que chega com ele em outra tarefa fica guardada
// (ajuste) e vai antes da fila. A worktree é do funcionário: não muda nada. Claude e Codex pela mesma regra (é regra de fila).

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-doubtq-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const MIN = 60_000;
const profile = (id: string, name: string, extra: Partial<StaffProfile> = {}) => ({ id, name, role: 'Back-end', autonomy: 'acceptEdits', worktree: false, ...extra }) as StaffProfile;

/** Ana (a que tem a fila) e Giovana (a gestora que pede). Sem `manager`, a dúvida vai direto para o dono (sem endereço da API o gestor não responde). */
async function club(dirName: string, opts: { engine?: Engine; worktree?: boolean; manager?: boolean } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, '.myco', 'tasks.json');
  const people: Record<string, StaffProfile> = {
    'gio-1': profile('gio-1', 'Giovana', { role: 'Orquestradora' }),
    'ana-1': profile('ana-1', 'Ana', { engine: opts.engine ?? 'claude', worktree: !!opts.worktree }),
  };
  const h = {
    sent: [] as Array<{ staffId: string; text: string; session: string }>,
    delivered: [] as Array<{ sessionId: string; text: string }>,
    answeredAsks: [] as Array<{ sessionId: string; requestId: string; by: string | undefined }>,
    asks: new Set<string>(),
    /** Conversas trabalhando agora (o turno, ou a pergunta pendente: para o chat ela também está "ocupada"). */
    working: new Set<string>(),
    texts: {} as Record<string, string>,
    n: 0,
  };
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId, text) => {
      const session = `${staffId}-${++h.n}`;
      h.sent.push({ staffId, text, session });
      return session;
    },
    branchFor: async () => null,
    isWorking: (_p, _s, except) => {
      const skip = typeof except === 'string' ? [except] : [...(except ?? [])];
      return [...h.working].some((s) => !skip.includes(s));
    },
    sendTo: async (_p, sessionId, _s, text) => {
      h.delivered.push({ sessionId, text });
      return sessionId;
    },
    notify: async () => {},
    lastText: (s) => h.texts[s] ?? null,
    hasAsk: (_s, id) => h.asks.has(id),
    answerAsk: (sessionId, requestId, _answers, by) => {
      if (!h.asks.has(requestId)) return false;
      h.asks.delete(requestId);
      h.answeredAsks.push({ sessionId, requestId, by });
      return true;
    },
    ...(opts.manager && { apiUrl: 'http://127.0.0.1:4848', sandboxApiUrl: 'http://127.0.0.2:4848' }),
  });
  const list = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await list()).find((t) => t.id === id)!;
  /** Muda o arquivo das tarefas por fora (um fixture que o serviço não produz sozinho). */
  const edit = async (fn: (all: Array<Record<string, any>>) => void) => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    fn(all);
    await fs.writeFile(file, JSON.stringify(all));
  };
  /** Espera o `kick` que a dúvida escalada disparou (e o que ele começou). */
  const settle = () => svc.kickStaff('p', 'ana-1');
  /** A Ana edita um arquivo do projeto na conversa da tarefa. */
  const editFile = (sessionId: string, rel: string) =>
    svc.onCodeEdit({ sessionId, projectId: 'p', staffId: 'ana-1', engine: opts.engine ?? 'claude', cwd: dir, files: [path.join(dir, rel)], request: null });
  return { h, svc, list, get, edit, settle, editFile, dir };
}
type Club = Awaited<ReturnType<typeof club>>;

/** A tarefa da Ana pedida pela Giovana, começada (a conversa dela trabalha), e as da fila dela atrás, nesta ordem. */
async function fila(b: Club, titles = ['Próxima']) {
  const p = (await b.svc.create('p', { title: 'Relatório', description: 'Exportar CSV', staffId: 'ana-1', reviewerId: null }, 'gio-1', 'gio-s'))!;
  await b.svc.start('p', p.id);
  const work = (await b.get(p.id)).sessionId!;
  b.h.working.add(work);
  const next: string[] = [];
  for (const title of titles) {
    const t = (await b.svc.create('p', { title, staffId: 'ana-1', reviewerId: null }))!;
    await b.svc.start('p', t.id);
    next.push(t.id);
  }
  return { p: p.id, work, next };
}

/** A Ana termina o turno com `DÚVIDA:` (a conversa para). Sem gestor com API, a dúvida já nasce escalada. */
async function textDoubt(b: Club, work: string) {
  b.h.working.delete(work);
  b.h.texts[work] = 'DÚVIDA: posso apagar a tabela antiga?';
  await b.svc.onTurnDone(work);
  await b.settle();
}

/** A Ana pergunta por opções: a pergunta fica pendente na conversa (ela segue "ocupada" para o chat). */
async function askDoubt(b: Club, work: string) {
  b.h.asks.add('req-1');
  b.h.working.add(work);
  await b.svc.onAsk(work, 'req-1', [{ question: 'Qual banco?', options: ['Postgres', 'MySQL'] }]);
  await b.settle();
}

/** A tarefa que a Ana começou (a da fila) como está agora, com o que a fila deixou nela. */
const started = (t: Task) => ({ status: t.status, queued: !!t.queuedAt, session: t.sessionId });

describe('a regra: dúvida escalada sem edição não ocupa', () => {
  const base = { question: { id: 'q', source: 'text', status: 'escalated', askedAt: 'a' } } as Partial<Task> as Task;
  it('só a escalada, sem changedFiles e sem checkpoint, solta', () => {
    expect(releasesStaff(base)).toBe(true);
    expect(releasesStaff({ ...base, changedFiles: [] })).toBe(true);
    expect(releasesStaff({ ...base, changedFiles: ['a.ts'] })).toBe(false);
    expect(releasesStaff({ ...base, checkpoint: { sha: 'abc', at: 'x' } })).toBe(false);
    expect(releasesStaff({ ...base, question: { ...base.question!, status: 'open' } })).toBe(false);
    expect(releasesStaff({ ...base, question: { ...base.question!, status: 'answered' } })).toBe(false);
    expect(releasesStaff({} as Task)).toBe(false);
  });
});

describe.each<Engine>(['claude', 'codex'])('(1) escalada sem edição libera a fila: %s', (engine) => {
  it('dúvida escrita: a próxima da fila começa e a tarefa pausada diz para onde ele foi', async () => {
    const b = await club(`um-texto-${engine}`, { engine });
    const { p, work, next } = await fila(b, ['Próxima', 'Depois']);
    // Antes da dúvida: ela ocupa, a fila espera.
    expect(started(await b.get(next[0]!))).toMatchObject({ status: 'todo', queued: true });
    await textDoubt(b, work);
    expect((await b.get(p)).question?.status).toBe('escalated');
    expect(started(await b.get(next[0]!))).toMatchObject({ status: 'doing', queued: false, session: expect.stringMatching(/^ana-1-/) });
    // Uma por vez: a seguinte espera a primeira, como sempre.
    expect(started(await b.get(next[1]!))).toMatchObject({ status: 'todo', queued: true });
    const paused = await b.get(p);
    expect(paused.status).toBe('doing');
    expect(paused.pause).toEqual({ state: 'released', reason: 'dúvida escalada sem edição: pausada esperando você', since: paused.question!.escalatedAt, movedTo: { id: next[0], title: 'Próxima' } });
  });

  it('pergunta por opções: a pergunta pendente deixa a conversa "ocupada" para o chat, mas não segura a fila', async () => {
    const b = await club(`um-ask-${engine}`, { engine });
    const { p, work, next } = await fila(b);
    await askDoubt(b, work);
    expect((await b.get(p)).question).toMatchObject({ status: 'escalated', source: 'ask' });
    expect(b.h.working.has(work)).toBe(true);
    expect(started(await b.get(next[0]!))).toMatchObject({ status: 'doing', queued: false });
    expect((await b.get(p)).pause).toMatchObject({ state: 'released', movedTo: { id: next[0] } });
  });

  it('a dúvida que passa do prazo com o gestor (tick) libera do mesmo jeito', async () => {
    const b = await club(`um-tick-${engine}`, { engine, manager: true });
    const { p, work, next } = await fila(b);
    b.h.working.delete(work);
    b.h.texts[work] = 'DÚVIDA: posso apagar a tabela antiga?';
    await b.svc.onTurnDone(work);
    expect((await b.get(p)).question?.status).toBe('open');
    // Ainda com o gestor: segura (ver o caso 3). Passado o prazo, vai para o dono e a fila anda.
    await b.svc.tick(new Date(Date.now() + ESCALATE_AFTER_MS - MIN));
    expect(started(await b.get(next[0]!))).toMatchObject({ status: 'todo', queued: true });
    await b.svc.tick(new Date(Date.now() + ESCALATE_AFTER_MS + MIN));
    await b.settle();
    expect((await b.get(p)).question?.status).toBe('escalated');
    expect(started(await b.get(next[0]!))).toMatchObject({ status: 'doing', queued: false });
  });

  it('sem ninguém na fila, a tarefa fica pausada com `movedTo` nulo (ele está livre)', async () => {
    const b = await club(`um-vazia-${engine}`, { engine });
    const { p, work } = await fila(b, []);
    await textDoubt(b, work);
    expect((await b.get(p)).pause).toMatchObject({ state: 'released', movedTo: null });
  });

  it('a mensagem para a conversa em que ele está agora não espera a tarefa pausada', async () => {
    const b = await club(`um-hold-${engine}`, { engine });
    const { work, next } = await fila(b);
    await askDoubt(b, work); // a pausada segue com a pergunta pendente: nem ela nem a tarefa pausada seguram a atual
    const nova = (await b.get(next[0]!)).sessionId!;
    b.h.working.add(nova);
    expect(await b.svc.hold(nova, { text: 'use o banco novo' })).toBeNull();
  });
});

describe.each<Engine>(['claude', 'codex'])('(2) escalada com edição segura: %s', (engine) => {
  it('editou arquivo do projeto: a dúvida escalada segue ocupando, e o motivo está legível', async () => {
    const b = await club(`dois-edicao-${engine}`, { engine });
    const { p, work, next } = await fila(b);
    await b.editFile(work, path.join('src', 'export.ts'));
    expect((await b.get(p)).changedFiles).toEqual(['src/export.ts']);
    await textDoubt(b, work);
    const t = await b.get(p);
    expect(t.question?.status).toBe('escalated');
    expect(started(await b.get(next[0]!))).toMatchObject({ status: 'todo', queued: true });
    expect(b.h.sent.filter((s) => s.staffId === 'ana-1')).toHaveLength(1);
    expect(t.pause).toEqual({ state: 'holding', reason: 'dúvida com edição em andamento', since: t.question!.escalatedAt, movedTo: null });
  });

  it('já entregou antes (checkpoint) e voltou: conta como edição', async () => {
    const b = await club(`dois-checkpoint-${engine}`, { engine });
    const { p, work, next } = await fila(b);
    await b.edit((all) => {
      all.find((t) => t.id === p)!.checkpoint = { sha: 'abc123', at: new Date().toISOString() };
    });
    await textDoubt(b, work);
    expect(started(await b.get(next[0]!))).toMatchObject({ status: 'todo', queued: true });
    expect((await b.get(p)).pause).toMatchObject({ state: 'holding' });
  });

  it('pergunta por opções com edição: também segura', async () => {
    const b = await club(`dois-ask-${engine}`, { engine });
    const { p, work, next } = await fila(b);
    await b.editFile(work, 'a.ts');
    await askDoubt(b, work);
    expect(started(await b.get(next[0]!))).toMatchObject({ status: 'todo', queued: true });
    expect((await b.get(p)).pause).toMatchObject({ state: 'holding' });
  });

  it('só `.myco/` e arquivo fora do projeto não contam como edição (a tarefa segue solta)', async () => {
    const b = await club(`dois-fora-${engine}`, { engine });
    const { p, work, next } = await fila(b);
    await b.editFile(work, path.join('.myco', 'staff', 'ana-1.memory.md'));
    await b.svc.onCodeEdit({ sessionId: work, projectId: 'p', staffId: 'ana-1', engine, cwd: b.dir, files: [path.join(os.tmpdir(), 'fora.ts')], request: null });
    expect((await b.get(p)).changedFiles).toBeUndefined();
    await textDoubt(b, work);
    expect(started(await b.get(next[0]!))).toMatchObject({ status: 'doing' });
  });
});

describe('(3) dúvida com o gestor segura', () => {
  it('open: a fila espera, e a tarefa não ganha `pause`', async () => {
    const b = await club('tres-gestor', { manager: true });
    const { p, work, next } = await fila(b);
    b.h.working.delete(work);
    b.h.texts[work] = 'DÚVIDA: posso apagar a tabela antiga?';
    await b.svc.onTurnDone(work);
    await b.settle();
    const t = await b.get(p);
    expect(t.question).toMatchObject({ status: 'open', managerSession: expect.stringMatching(/^gio-1-/) });
    expect(t.pause).toBeUndefined();
    expect(started(await b.get(next[0]!))).toMatchObject({ status: 'todo', queued: true });
    // E o tick de antes do prazo não muda nada.
    await b.svc.tick(new Date(Date.now() + MIN));
    expect(started(await b.get(next[0]!))).toMatchObject({ status: 'todo', queued: true });
  });

  it('o gestor responde: a resposta vai à conversa dela, e só então, com ela entregue, a fila anda', async () => {
    const b = await club('tres-resposta', { manager: true });
    const { p, work, next } = await fila(b);
    b.h.working.delete(work);
    b.h.texts[work] = 'DÚVIDA: posso apagar a tabela antiga?';
    await b.svc.onTurnDone(work);
    const q = (await b.get(p)).question!;
    await b.svc.answerQuestion('p', p, { staffId: 'gio-1', sessionId: q.managerSession! }, { questionId: q.id, text: 'Sim.' });
    expect(b.h.delivered).toEqual([{ sessionId: work, text: 'Resposta de Giovana à sua dúvida: Sim.' }]);
    expect(started(await b.get(next[0]!))).toMatchObject({ status: 'todo', queued: true });
  });
});

describe('(4) a resposta que chega com ele em outra tarefa vira ajuste guardado', () => {
  /** A dúvida escalada, a próxima da fila começou (e trabalha) e há mais uma esperando atrás dela. */
  async function seguiu(b: Club, kind: 'text' | 'ask') {
    const f = await fila(b, ['Próxima', 'Depois']);
    if (kind === 'text') await textDoubt(b, f.work);
    else await askDoubt(b, f.work);
    const nova = (await b.get(f.next[0]!)).sessionId!;
    b.h.working.add(nova);
    return { ...f, nova };
  }

  it('dúvida escrita: fica guardada na pausada, vai antes da fila quando ele ficar livre, e a seguinte espera', async () => {
    const b = await club('quatro-texto');
    const { p, work, next, nova } = await seguiu(b, 'text');
    const out = await b.svc.answerQuestion('p', p, null, { questionId: (await b.get(p)).question!.id, text: 'Pode apagar.' }, true);
    // Ele está na "Próxima": nada foi mandado, a resposta espera.
    expect(out?.question).toMatchObject({ status: 'answered', answeredBy: 'user' });
    expect(b.h.delivered).toEqual([]);
    expect((await b.get(p)).held).toEqual([expect.objectContaining({ text: 'Resposta do usuário à sua dúvida: Pode apagar.', reason: 'espera Ana terminar “Próxima”' })]);
    expect((await b.get(p)).pause).toBeUndefined(); // respondida: já não é "pausada esperando você"
    // Ele termina a "Próxima": o ajuste vai para a conversa pausada ANTES da "Depois".
    b.h.working.delete(nova);
    await b.svc.onTurnDone(nova);
    await b.settle();
    expect(b.h.delivered).toEqual([{ sessionId: work, text: 'Resposta do usuário à sua dúvida: Pode apagar.' }]);
    expect((await b.get(p)).held).toEqual([]);
    expect(started(await b.get(next[1]!))).toMatchObject({ status: 'todo', queued: true });
    // A conversa pausada trabalha de novo; quando ela entrega, a "Depois" começa.
    b.h.texts[work] = 'Apaguei a tabela antiga.';
    await b.svc.onTurnDone(work);
    await b.settle();
    expect((await b.get(p)).status).toBe('review');
    expect(started(await b.get(next[1]!))).toMatchObject({ status: 'doing', queued: false });
  });

  it('pergunta por opções: a resposta espera, e chega à pergunta pendente (sem texto repetido) antes da fila', async () => {
    const b = await club('quatro-ask');
    const { p, work, next, nova } = await seguiu(b, 'ask');
    const out = await b.svc.answerQuestion('p', p, null, { questionId: 'req-1', answers: { 'Qual banco?': 'Postgres' } }, true);
    expect(out?.question).toMatchObject({ status: 'answered', answeredBy: 'user', answer: 'Qual banco?: Postgres' });
    expect(b.h.answeredAsks).toEqual([]);
    expect((await b.get(p)).held).toEqual([
      expect.objectContaining({ reason: 'espera Ana terminar “Próxima”', ask: { requestId: 'req-1', answers: { 'Qual banco?': 'Postgres' }, by: 'user' } }),
    ]);
    b.h.working.delete(nova);
    await b.svc.onTurnDone(nova);
    await b.settle();
    expect(b.h.answeredAsks).toEqual([{ sessionId: work, requestId: 'req-1', by: 'user' }]);
    expect(b.h.delivered).toEqual([]);
    expect((await b.get(p)).held).toEqual([]);
    expect(started(await b.get(next[1]!))).toMatchObject({ status: 'todo', queued: true });
  });

  it('pergunta por opções que já não está pendente na hora de ir (a conversa reabriu): o texto vai como mensagem', async () => {
    const b = await club('quatro-ask-sumiu');
    const { p, work, nova } = await seguiu(b, 'ask');
    await b.svc.answerQuestion('p', p, null, { questionId: 'req-1', answers: { 'Qual banco?': 'Postgres' } }, true);
    b.h.asks.clear();
    b.h.working.delete(nova);
    await b.svc.onTurnDone(nova);
    await b.settle();
    expect(b.h.answeredAsks).toEqual([]);
    expect(b.h.delivered).toEqual([{ sessionId: work, text: 'Resposta do usuário à sua dúvida: Qual banco?: Postgres' }]);
    expect((await b.get(p)).held).toEqual([]);
  });

  it('ele livre (nada na fila): a resposta vai direto, sem guardar', async () => {
    const text = await club('quatro-livre-texto');
    const a = await fila(text, []);
    await textDoubt(text, a.work);
    await text.svc.answerQuestion('p', a.p, null, { questionId: (await text.get(a.p)).question!.id, text: 'Pode apagar.' }, true);
    expect(text.h.delivered).toEqual([{ sessionId: a.work, text: 'Resposta do usuário à sua dúvida: Pode apagar.' }]);
    expect((await text.get(a.p)).held ?? []).toEqual([]);

    const ask = await club('quatro-livre-ask');
    const c = await fila(ask, []);
    await askDoubt(ask, c.work);
    await ask.svc.answerQuestion('p', c.p, null, { questionId: 'req-1', answers: { 'Qual banco?': 'MySQL' } }, true);
    expect(ask.h.answeredAsks).toEqual([{ sessionId: c.work, requestId: 'req-1', by: 'user' }]);
    expect((await ask.get(c.p)).held ?? []).toEqual([]);
  });

  it('ajuste que falha ao ir não segura a fila: conta a falha e a próxima começa', async () => {
    const b = await club('quatro-falha');
    const { p, work, next, nova } = await seguiu(b, 'text');
    await b.svc.answerQuestion('p', p, null, { questionId: (await b.get(p)).question!.id, text: 'Pode apagar.' }, true);
    // A conversa pausada não abre (limite de consumo, por exemplo): o envio dela falha.
    const real = (b.svc as unknown as { deps: { sendTo: (...a: unknown[]) => Promise<string> } }).deps;
    const ok = real.sendTo;
    real.sendTo = async (_p, sid) => {
      if (sid === work) throw new Error('limite de consumo');
      return ok(_p, sid);
    };
    b.h.working.delete(nova);
    await b.svc.onTurnDone(nova);
    await b.settle();
    expect((await b.get(p)).held).toEqual([expect.objectContaining({ attempts: 1, nextAt: expect.any(String) })]);
    expect(started(await b.get(next[1]!))).toMatchObject({ status: 'doing', queued: false });
  });
});

describe('(5) worktree não muda nada', () => {
  it('com worktree: sem edição solta, com edição segura (a worktree é do funcionário, não da tarefa)', async () => {
    const livre = await club('cinco-livre', { worktree: true });
    const a = await fila(livre);
    await textDoubt(livre, a.work);
    expect(started(await livre.get(a.next[0]!))).toMatchObject({ status: 'doing', queued: false });
    expect((await livre.get(a.p)).pause).toMatchObject({ state: 'released' });

    const preso = await club('cinco-preso', { worktree: true });
    const c = await fila(preso);
    await preso.editFile(c.work, 'a.ts');
    await textDoubt(preso, c.work);
    expect(started(await preso.get(c.next[0]!))).toMatchObject({ status: 'todo', queued: true });
    expect((await preso.get(c.p)).pause).toMatchObject({ state: 'holding' });
  });
});
