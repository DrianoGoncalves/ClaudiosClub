import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import { AutoContinue, type Pending } from '../server/chat/autoContinue';
import { RESUME_TEXT } from '../server/chat/items';
import { resumeAfterRestart, type ResumeEntry } from '../server/chat/resume';
import { ProjectPauses } from '../server/projectPause';
import { RoutineScheduler } from '../server/routines';
import { TaskForbiddenError, TaskService } from '../server/tasks';
import type { Engine, StaffProfile } from '../shared/model';

// Pausar o projeto (t-8224a4): pausado, nada começa sozinho (fila, início que não é do dono, revisão automática, retomada das órfãs, reprovação, troca de motor, rotinas,
// despertador/"continue"/retomada de turno e retomada do reinício); o que já roda termina o turno; as ações do dono seguem; o estado sobrevive ao reinício.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-pause-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const MIN = 60_000;
const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString();
const quiet = () => {};

describe('ProjectPauses: o estado em disco', () => {
  const file = (name: string) => path.join(root, `${name}.json`);

  it('sobrevive ao reinício (outra instância sobre o mesmo arquivo) e guarda quando pausou', async () => {
    const f = file('persist');
    const a = new ProjectPauses(f, quiet);
    expect(await a.isPaused('p')).toBe(false);
    const first = await a.pause('p', new Date('2026-11-18T10:00:00.000Z'));
    expect(first).toEqual({ at: '2026-11-18T10:00:00.000Z' });

    const b = new ProjectPauses(f, quiet); // "reiniciou"
    expect(await b.isPaused('p')).toBe(true);
    expect(await b.isPaused('outro')).toBe(false);
    expect(await b.get('p')).toEqual({ at: '2026-11-18T10:00:00.000Z' });
    expect(await b.all()).toEqual({ p: { at: '2026-11-18T10:00:00.000Z' } });
  });

  it('pausar de novo não muda o horário; retomar tira, de novo não faz nada', async () => {
    const f = file('idempotent');
    const a = new ProjectPauses(f, quiet);
    await a.pause('p', new Date('2026-11-18T10:00:00.000Z'));
    expect(await a.pause('p', new Date('2026-11-18T11:00:00.000Z'))).toEqual({ at: '2026-11-18T10:00:00.000Z' });
    expect(await a.resume('p')).toBe(true);
    expect(await a.resume('p')).toBe(false);
    expect(await new ProjectPauses(f, quiet).isPaused('p')).toBe(false);
  });

  it('arquivo estragado: guarda como .bad, avisa e segue sem projeto pausado; entrada torta não leva as outras', async () => {
    const bad = file('estragado');
    await fs.writeFile(bad, '{ não é json');
    const logs: string[] = [];
    const a = new ProjectPauses(bad, (l) => logs.push(l));
    expect(await a.isPaused('p')).toBe(false);
    expect(logs.join('\n')).toMatch(/estragado/);
    await expect(fs.access(`${bad}.bad`)).resolves.toBeUndefined();

    const mixed = file('misturado');
    await fs.writeFile(mixed, JSON.stringify({ version: 1, projects: { ok: { at: '2026-11-18T10:00:00.000Z' }, torta: { at: 'ontem' }, outra: 7 } }));
    const b = new ProjectPauses(mixed, quiet);
    expect(await b.all()).toEqual({ ok: { at: '2026-11-18T10:00:00.000Z' } });
  });

  it('pausa que não gravou não vale: o erro sobe e o projeto segue rodando', async () => {
    const blocker = file('arquivo-no-caminho');
    await fs.writeFile(blocker, 'x');
    const a = new ProjectPauses(path.join(blocker, 'paused.json'), quiet); // uma "pasta" que é arquivo: a gravação falha
    await expect(a.pause('p')).rejects.toThrow();
    expect(await a.isPaused('p')).toBe(false);
  });
});

// ---- o serviço de tarefas ---------------------------------------------------------------------------------------------------------------------------------

const RULES = {
  'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false },
  'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'manual', worktree: false },
  'gio-1': { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false },
} as const;

interface Opts {
  engine?: Engine;
  projects?: string[];
  fallback?: StaffProfile['fallback'];
}

/** Um quadro por teste: projetos em pastas próprias, a pausa num arquivo próprio e fakes que anotam o que o serviço abriu e mandou. */
async function club(name: string, opts: Opts = {}) {
  const projects = opts.projects ?? ['p'];
  const dirs: Record<string, string> = {};
  for (const p of projects) {
    dirs[p] = path.join(root, `${name}-${p}`);
    await fs.mkdir(dirs[p]!, { recursive: true });
  }
  const pauses = new ProjectPauses(path.join(root, `${name}-pausas.json`), quiet);
  const people = (id: string): StaffProfile | null => {
    const r = RULES[id as keyof typeof RULES];
    return r ? ({ ...r, ...(id === 'ana-1' && { engine: opts.engine ?? 'claude', ...(opts.fallback && { fallback: opts.fallback }) }) } as unknown as StaffProfile) : null;
  };
  const h = {
    /** Conversas abertas (`send`) e mensagens em conversas que já existiam (`sendTo`). */
    opened: [] as Array<{ project: string; staffId: string; text: string; session: string; override?: unknown; reviewOnly?: boolean }>,
    sentTo: [] as Array<{ project: string; session: string; staffId: string; text: string }>,
    busy: {} as Record<string, boolean>,
    lastText: null as string | null,
    stopped: [] as string[],
    n: 0,
  };
  const svc = new TaskService({
    projectPath: async (id) => dirs[id] ?? null,
    projectIds: async () => projects,
    readProfile: async (_p, id) => people(id),
    send: async (project, staffId, text, _force, override, reviewOnly) => {
      const session = `${staffId}-${++h.n}`;
      h.opened.push({ project, staffId, text, session, override, reviewOnly });
      if (!reviewOnly) h.busy[`${project}:${staffId}`] = true;
      return session;
    },
    sendTo: async (project, session, staffId, text) => {
      h.sentTo.push({ project, session, staffId, text });
      return session;
    },
    branchFor: async () => null,
    isWorking: (project, staffId) => !!h.busy[`${project}:${staffId}`],
    notify: async () => {},
    lastText: () => h.lastText,
    hasAsk: () => false,
    answerAsk: () => false,
    awaitingLimit: async () => false,
    readLimit: async () => null,
    settleLimit: async () => {},
    assertRunnable: async () => {},
    cancelContinue: async () => null,
    stopSession: (sid) => void h.stopped.push(sid),
    snapshot: async (_p, sid) => ({ sessionId: sid, history: [], live: null }) as never,
    apiUrl: 'http://127.0.0.1:4848',
    sandboxApiUrl: 'http://127.0.0.2:4848',
    pauses,
  });
  const list = async (p = 'p') => (await svc.list(p))!;
  const get = async (id: string, p = 'p') => (await list(p)).find((t) => t.id === id)!;
  /** Muda o arquivo das tarefas por fora (o estado em que um reinício, ou o tempo, deixou o cartão). */
  const edit = async (id: string, fn: (t: Record<string, any>) => void, p = 'p') => {
    const file = path.join(dirs[p]!, '.myco', 'tasks.json');
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    fn(all.find((t) => t.id === id)!);
    await fs.writeFile(file, JSON.stringify(all));
  };
  const add = async (title: string, extra: Record<string, unknown> = {}, p = 'p') => (await svc.create(p, { title, staffId: 'ana-1', ...extra }))!;
  /** O turno da conversa de trabalho acabou (o fim de turno de cada motor). */
  const turnEnds = async (session: string, p = 'p') => {
    h.busy[`${p}:ana-1`] = false;
    if (opts.engine === 'codex') await svc.onIdle(session, p, 'ana-1', 'turn', 'codex');
    else await svc.onIdle(session, p, 'ana-1');
  };
  const reviews = () => h.opened.filter((o) => o.staffId === 'rev-1');
  const works = () => h.opened.filter((o) => o.staffId === 'ana-1');
  return { svc, pauses, h, dirs, list, get, edit, add, turnEnds, reviews, works };
}
type Club = Awaited<ReturnType<typeof club>>;

/** Espera `fn` ficar verdadeira (o que roda em segundo plano, como o tick que a retomada dispara). */
async function until(fn: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('não chegou a tempo');
}

describe('rotas: só o dono, pelo navegador', () => {
  it('funcionário e token de conversa levam 403 ao pausar e ao retomar, e nada muda', async () => {
    const c = await club('perm');
    await expect(c.svc.setPaused('p', true, false)).rejects.toBeInstanceOf(TaskForbiddenError);
    expect(await c.pauses.isPaused('p')).toBe(false);
    await c.svc.setPaused('p', true, true);
    await expect(c.svc.setPaused('p', false, false)).rejects.toBeInstanceOf(TaskForbiddenError);
    expect(await c.pauses.isPaused('p')).toBe(true);
  });

  it('o navegador pausa e retoma (idempotente); projeto que não existe é 404 (null)', async () => {
    const c = await club('nav');
    expect(await c.svc.pauseOf('p')).toEqual({ paused: null });
    const first = await c.svc.setPaused('p', true, true);
    expect(first).toEqual({ paused: { at: expect.any(String) } });
    expect(await c.svc.setPaused('p', true, true)).toEqual(first);
    expect(await c.svc.pauseOf('p')).toEqual(first);
    expect(await c.svc.setPaused('p', false, true)).toEqual({ paused: null });
    expect(await c.svc.setPaused('p', false, true)).toEqual({ paused: null });
    expect(await c.svc.setPaused('nao-existe', true, true)).toBeNull();
    expect(await c.svc.pauseOf('nao-existe')).toBeNull();
  });

  it('as rotas só existem para a tela: fora da lista dos funcionários e da sandbox do Codex, e o "Começar" do dono leva byOwner', async () => {
    for (const p of ['/api/projects/p/pause', '/api/projects/p/resume']) {
      expect(staffMayPost(p)).toBe(false);
      expect(sandboxVerdict('POST', p, 'p')).toMatchObject({ status: 403 });
    }
    const index = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    expect(index).toMatch(/\['POST', new RegExp\(`\^\/api\/projects\/\$\{ID\}\/pause\$`\), \(\{ params: \[id\], fromBrowser \}\) => tasks\.setPaused\(id!, true, fromBrowser\)\]/);
    expect(index).toMatch(/\['POST', new RegExp\(`\^\/api\/projects\/\$\{ID\}\/resume\$`\), \(\{ params: \[id\], fromBrowser \}\) => tasks\.setPaused\(id!, false, fromBrowser\)\]/);
    expect(index).toMatch(/\['GET', new RegExp\(`\^\/api\/projects\/\$\{ID\}\/pause\$`\)/);
    expect(index).toMatch(/deadlineMs: START_DEADLINE_MS, byOwner: true/); // o "Começar" da tela
    expect(index).toMatch(/startTask: \(projectId, taskId\) => tasks\.start\(projectId, taskId, false, \{ byOwner: true \}\)/); // o da extensão
    // Cada ponto de partida automática pergunta à MESMA pausa: o "continue", o despertador, a retomada de turno, as rotinas e a retomada do reinício.
    expect(index.match(/paused: projectPaused/g)).toHaveLength(5);
    expect(index).toMatch(/pauses: projectPauses,/);
  });
});

describe.each<Engine>(['claude', 'codex'])('com o projeto pausado (funcionário no %s)', (engine) => {
  it('fila: nada começa sozinho; ao retomar, a primeira da ordem atual começa e a seguinte espera a vez', async () => {
    const c = await club(`fila-${engine}`, { engine });
    const a = await c.add('A');
    const b = await c.add('B');
    await c.svc.setPaused('p', true, true);
    // Entram na fila (a API segue aceitando cartões), e esperam.
    await c.svc.start('p', a.id);
    await c.svc.start('p', b.id);
    expect((await c.get(a.id)).history.at(-1)?.note).toMatch(/projeto está pausado/);
    await c.svc.tick();
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.h.opened).toEqual([]);
    expect(await c.get(a.id)).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String) });

    // Retomar: o tick do projeto roda sozinho, e a primeira da fila começa.
    await c.svc.setPaused('p', false, true);
    await until(async () => (await c.get(a.id)).status === 'doing'); // a conversa abre e só depois a tarefa é gravada
    expect(c.works()).toHaveLength(1);
    expect(c.works()[0]!.text).toContain('[Tarefa "A"]');
    expect(await c.get(a.id)).toMatchObject({ status: 'doing', queuedAt: null });
    expect(await c.get(b.id)).toMatchObject({ status: 'todo', sessionId: null });
    // A entrega da A libera a Ana, e a B vem depois: a ordem da fila não mudou.
    await c.turnEnds((await c.get(a.id)).sessionId!);
    expect(c.works().map((o) => /\[Tarefa "(.+?)"\]/.exec(o.text)![1])).toEqual(['A', 'B']);
  });

  it('a conversa em andamento termina o turno (a tarefa vai para revisão) e não recebe a próxima enquanto pausado; retomado, a próxima vem', async () => {
    const c = await club(`turno-${engine}`, { engine });
    const a = await c.add('A');
    const b = await c.add('B');
    await c.svc.start('p', a.id); // Ana livre: A começa
    await c.svc.start('p', b.id); // ocupada: B na fila
    const session = (await c.get(a.id)).sessionId!;
    expect(c.works()).toHaveLength(1);

    await c.svc.setPaused('p', true, true);
    await c.turnEnds(session);
    expect(await c.get(a.id)).toMatchObject({ status: 'review', sessionId: session });
    expect(c.works()).toHaveLength(1); // a B não começou
    await c.svc.tick();
    expect(c.works()).toHaveLength(1);
    expect(await c.get(b.id)).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String) });

    await c.pauses.resume('p');
    await c.svc.tick();
    expect(c.works()).toHaveLength(2);
    expect(c.works()[1]!.text).toContain('[Tarefa "B"]');
  });

  it('revisão automática: a entrega fica em revisão sem pedir a revisão; ao retomar, o tick pede, uma vez', async () => {
    const c = await club(`revisao-${engine}`, { engine });
    const t = await c.add('Tela', { reviewerId: 'rev-1' });
    await c.svc.start('p', t.id);
    await c.svc.setPaused('p', true, true);
    await c.turnEnds((await c.get(t.id)).sessionId!);
    expect(await c.get(t.id)).toMatchObject({ status: 'review' });
    expect((await c.get(t.id)).delivery).toBeDefined();
    await c.svc.tick();
    await c.svc.tick(new Date(Date.now() + 5 * MIN));
    expect(c.reviews()).toHaveLength(0);
    expect((await c.get(t.id)).review).toBeUndefined();

    await c.pauses.resume('p');
    await c.svc.tick();
    expect(c.reviews()).toHaveLength(1);
    expect(await c.get(t.id)).toMatchObject({ reviewRounds: 1, review: { staffId: 'rev-1' } });
    await c.svc.tick(new Date(Date.now() + 20 * MIN));
    expect(c.reviews()).toHaveLength(1);
  });

  it('retomada da órfã: a conversa que morreu no meio do turno só é retomada depois de retomar o projeto', async () => {
    const c = await club(`orfa-${engine}`, { engine });
    const t = await c.add('Tela');
    await c.svc.start('p', t.id);
    const session = (await c.get(t.id)).sessionId!;
    c.h.busy['p:ana-1'] = false; // o processo morreu
    await c.edit(t.id, (x) => (x.updatedAt = ago(10)));
    await c.svc.setPaused('p', true, true);
    await c.svc.tick();
    expect(c.h.sentTo).toEqual([]);
    expect(await c.get(t.id)).toMatchObject({ status: 'doing' });
    expect((await c.get(t.id)).resumedAt).toBeUndefined();

    await c.pauses.resume('p');
    await c.svc.tick();
    expect(c.h.sentTo).toEqual([{ project: 'p', session, staffId: 'ana-1', text: RESUME_TEXT }]);
  });

  it('reprovação do revisor: o ajuste fica guardado como automático, a tarefa segue em revisão e o ajuste vai ao retomar', async () => {
    const c = await club(`reprova-${engine}`, { engine });
    const t = await c.add('Tela', { reviewerId: 'rev-1' });
    await c.svc.start('p', t.id);
    await c.turnEnds((await c.get(t.id)).sessionId!);
    expect(c.reviews()).toHaveLength(1);
    const reviewSession = c.reviews()[0]!.session;

    await c.svc.setPaused('p', true, true);
    c.h.lastText = 'REPROVADO\n🔴 faltou validar a entrada';
    await c.svc.onTurnDone(reviewSession);
    const held = await c.get(t.id);
    expect(held.status).toBe('review');
    expect(c.h.sentTo).toEqual([]);
    expect(held.held).toHaveLength(1);
    expect(held.held![0]).toMatchObject({ auto: true, reason: 'espera o projeto ser retomado' });
    await c.svc.tick();
    expect(c.h.sentTo).toEqual([]);

    await c.pauses.resume('p');
    await c.svc.tick();
    expect(c.h.sentTo).toHaveLength(1);
    expect(c.h.sentTo[0]!.text).toContain('faltou validar a entrada');
    expect((await c.get(t.id)).held ?? []).toEqual([]);
  });
});

describe('o que não é automático segue valendo com o projeto pausado', () => {
  it('"Começar" do dono abre a conversa; o de um gestor pela API, o cartão arrastado para "a fazer" e a criação com início só entram na fila', async () => {
    const c = await club('manual');
    await c.svc.setPaused('p', true, true);

    const manual = await c.add('Manual');
    const started = (await c.svc.start('p', manual.id, false, { byOwner: true }))!;
    expect(started).toMatchObject({ status: 'doing', sessionId: expect.any(String) });
    expect(c.works()).toHaveLength(1);
    c.h.busy['p:ana-1'] = false;
    await c.turnEnds(started.sessionId!);

    // Gestor pela API (createAndStart sem byOwner): grava e fica na fila.
    const viaApi = (await c.svc.createAndStart('p', { title: 'Pela API', staffId: 'ana-1' }, 'gio-1', undefined, { start: true }))!;
    expect(viaApi).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String) });
    // O dono arrasta um cartão de Aguardar para A fazer: o cartão anda, mas só entra na fila.
    const parked = await c.add('Arrastada', { start: false });
    expect(parked.status).toBe('waiting');
    const moved = (await c.svc.update('p', parked.id, { status: 'todo' }, true))!;
    expect(moved.status).toBe('todo');
    expect(moved.sessionId).toBeNull();
    await c.svc.tick();
    expect(c.works()).toHaveLength(1); // só a do "Começar" do dono
  });

  it('ajuste guardado: o seu segue, o que veio de funcionário (automático) espera', async () => {
    const c = await club('ajuste');
    const t = await c.add('Tela');
    await c.svc.start('p', t.id);
    const session = (await c.get(t.id)).sessionId!;
    c.h.busy['p:ana-1'] = false;
    const at = new Date().toISOString();
    await c.edit(t.id, (x) => (x.held = [{ id: 'auto1', at, text: 'ajuste do gestor', reason: 'x', auto: true }]));
    await c.svc.setPaused('p', true, true);
    await c.svc.tick();
    expect(c.h.sentTo).toEqual([]);

    // A mensagem que você escreveu (sem a marca) vai, mesmo pausado, e a do gestor continua esperando.
    await c.edit(t.id, (x) => x.held.push({ id: 'own1', at: new Date().toISOString(), text: 'ajuste do dono', reason: 'x' }));
    await c.svc.tick();
    expect(c.h.sentTo).toEqual([{ project: 'p', session, staffId: 'ana-1', text: 'ajuste do dono' }]);
    expect((await c.get(t.id)).held!.map((m) => m.id)).toEqual(['auto1']);

    await c.pauses.resume('p');
    c.h.busy['p:ana-1'] = false;
    await c.svc.tick();
    expect(c.h.sentTo.map((s) => s.text)).toEqual(['ajuste do dono', 'ajuste do gestor']);
  });

  it('mensagem automática a uma conversa de tarefa fica guardada; a do dono (navegador) nunca espera pela pausa', async () => {
    const c = await club('hold');
    const t = await c.add('Tela');
    await c.svc.start('p', t.id);
    const session = (await c.get(t.id)).sessionId!;
    c.h.busy['p:ana-1'] = false;
    await c.svc.setPaused('p', true, true);
    expect(await c.svc.hold(session, { text: 'de outro funcionário', origin: 'x', auto: true })).toBe('espera o projeto ser retomado');
    expect(await c.svc.hold(session, { text: 'do dono', byOwner: true })).toBeNull();
    expect((await c.get(t.id)).held).toHaveLength(1);
    // Sem a pausa, a mesma mensagem automática vai direto (ele está livre).
    await c.pauses.resume('p');
    expect(await c.svc.hold(session, { text: 'de outro funcionário', origin: 'x', auto: true })).toBeNull();
  });

  it('a fila do mesmo funcionário em outro projeto segue: só o projeto pausado espera', async () => {
    const c = await club('dois', { projects: ['p1', 'p2'] });
    const a = await c.add('Do p1', {}, 'p1');
    const b = await c.add('Do p2', {}, 'p2');
    await c.svc.setPaused('p1', true, true);
    await c.svc.start('p1', a.id);
    await c.svc.start('p2', b.id); // p2 roda: começa na hora
    expect(c.h.opened.map((o) => o.project)).toEqual(['p2']);
    await c.turnEnds((await c.get(b.id, 'p2')).sessionId!, 'p2');
    await c.svc.tick();
    expect(c.h.opened.map((o) => o.project)).toEqual(['p2']);
    expect(await c.get(a.id, 'p1')).toMatchObject({ status: 'todo', sessionId: null });
    await c.pauses.resume('p1');
    await c.svc.tick();
    expect(c.h.opened.map((o) => o.project)).toEqual(['p2', 'p1']);
  });

  it('o pedido de revisão do dono, pelo quadro, abre mesmo pausado', async () => {
    const c = await club('revisao-manual');
    const t = await c.add('Tela');
    await c.svc.start('p', t.id);
    await c.turnEnds((await c.get(t.id)).sessionId!);
    await c.svc.setPaused('p', true, true);
    await c.svc.requestReview('p', t.id, 'rev-1');
    expect(c.reviews()).toHaveLength(1);
  });
});

describe('troca de motor (reabertura por fallback)', () => {
  const trocas: Array<[string, Engine, NonNullable<StaffProfile['fallback']>]> = [
    ['Claude → Codex', 'claude', { engine: 'codex', model: 'gpt-5' }],
    ['Codex → Claude', 'codex', { engine: 'claude', model: 'sonnet' }],
  ];
  it.each(trocas)('limite no meio do turno (%s): pausado, não abre a conversa no secundário nem para a antiga; sem pausa, abre', async (_label, engine, fallback) => {
    const limit = { resetsAt: Date.now() + 120 * MIN, window: 'five_hour' as const };
    const free = await club(`troca-livre-${engine}`, { engine, fallback });
    const t1 = await free.add('Tela');
    await free.svc.start('p', t1.id);
    await free.svc.onLimit({ sessionId: (await free.get(t1.id)).sessionId!, engine, hit: limit });
    expect(free.h.opened).toHaveLength(2); // o controle: sem pausa a troca acontece
    expect(free.h.opened[1]!.override).toMatchObject({ engine: fallback.engine });

    const c = await club(`troca-pausada-${engine}`, { engine, fallback });
    const t2 = await c.add('Tela');
    await c.svc.start('p', t2.id);
    const session = (await c.get(t2.id)).sessionId!;
    await c.svc.setPaused('p', true, true);
    await c.svc.onLimit({ sessionId: session, engine, hit: limit });
    expect(c.h.opened).toHaveLength(1);
    expect(c.h.stopped).toEqual([]);
    const after = await c.get(t2.id);
    expect(after.sessionId).toBe(session);
    expect(after.fallback).toBeUndefined();
    expect(after.history.at(-1)?.note).toMatch(/o projeto está pausado, não troca de motor/);
  });
});

describe('listagem e resumo informam a pausa', () => {
  it('cartão aberto leva projectPaused; o encerrado não; o resumo leva paused também com o quadro vazio', async () => {
    const c = await club('lista');
    const open = await c.add('Aberta');
    const done = await c.add('Pronta', { start: false });
    await c.svc.update('p', done.id, { status: 'done' }, true);
    expect((await c.get(open.id)).projectPaused).toBeUndefined();
    expect(await c.svc.summary()).toEqual({ p: expect.not.objectContaining({ paused: expect.anything() }) });

    const { paused } = (await c.svc.setPaused('p', true, true))!;
    expect((await c.get(open.id)).projectPaused).toEqual(paused);
    expect((await c.get(done.id)).projectPaused).toBeUndefined();
    expect((await c.svc.summary()).p).toMatchObject({ open: 1, paused });

    // Quadro sem nada aberto: o projeto pausado continua no resumo (a tela mostra a pausa).
    await c.svc.update('p', open.id, { status: 'done' }, true);
    expect((await c.svc.summary()).p).toMatchObject({ open: 0, paused });
    await c.svc.setPaused('p', false, true);
    expect((await c.svc.summary()).p).toBeUndefined();
  });

  it('a pausa sobrevive ao reinício do servidor: um serviço novo, sobre o mesmo arquivo, segue sem começar nada', async () => {
    const c = await club('reinicio');
    const t = await c.add('A');
    await c.svc.setPaused('p', true, true);
    await c.svc.start('p', t.id);
    const reborn = new TaskService({
      projectPath: async () => c.dirs.p!,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana-1' ? ({ ...RULES['ana-1'] } as unknown as StaffProfile) : null),
      send: async () => {
        throw new Error('não podia abrir conversa');
      },
      branchFor: async () => null,
      pauses: new ProjectPauses(path.join(root, 'reinicio-pausas.json'), quiet),
    });
    await reborn.tick();
    expect((await reborn.list('p'))![0]).toMatchObject({ status: 'todo', sessionId: null, projectPaused: expect.any(Object) });
  });
});

// ---- rotinas ----------------------------------------------------------------------------------------------------------------------------------------------

describe('rotinas (cron)', () => {
  const t = (day: number, h = 0, mi = 0, s = 0) => new Date(2026, 10, day, h, mi, s);
  const routine = { id: 'r1', name: 'Revisar', schedule: '0 9 * * *', message: 'Revise.', mode: 'continue' as const, enabled: true, catchUpHours: 6 };
  const profile = (projectId: string) => ({ id: 'ana-1', projectId, name: 'Ana', sessions: [], routines: [routine] }) as unknown as StaffProfile;
  let n = 0;

  function scheduler(paused: Set<string>, projects = ['proj']) {
    const calls: string[] = [];
    const s = new RoutineScheduler({
      file: path.join(root, `rotinas-${++n}.json`),
      listStaff: async () => projects.map(profile),
      run: async (p, _r, minute) => {
        calls.push(`${p.projectId}@${minute}`);
        return { ok: true, text: 'mandada' };
      },
      paused: async (id) => paused.has(id),
      log: quiet,
    });
    return { s, calls };
  }

  it('pausado: a ocorrência não roda, vira "pulada" no histórico, sem alerta e sem voltar depois (nem com execução atrasada); retomado, vale a próxima', async () => {
    const paused = new Set(['proj']);
    const { s, calls } = scheduler(paused);
    await s.tick(t(18, 8));
    await s.tick(t(18, 9, 0, 5));
    expect(calls).toEqual([]);
    const snap = await s.snapshot('proj:ana-1:r1');
    expect(snap?.history[0]).toMatchObject({ state: 'discarded', text: expect.stringMatching(/projeto está pausado/) });
    expect(s.alerts()).toEqual([]);

    paused.clear();
    await s.tick(t(18, 9, 30)); // retomou: a de 9h não volta, mesmo dentro das 6 h de atraso
    expect(calls).toEqual([]);
    await s.tick(t(19, 9, 0, 5));
    expect(calls).toEqual(['proj@2026-11-19T09:00']);
  });

  it('só o projeto pausado é pulado, e o "Rodar agora" é manual: roda mesmo pausado', async () => {
    const { s, calls } = scheduler(new Set(['proj']), ['proj', 'outro']);
    await s.tick(t(18, 8));
    await s.tick(t(18, 9, 0, 5));
    expect(calls).toEqual(['outro@2026-11-18T09:00']);
    expect(await s.runNow(profile('proj'), 'r1')).toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('sem conseguir ler a pausa, a ocorrência não roda nem é tratada: o próximo ciclo tenta', async () => {
    let fails = true;
    const calls: string[] = [];
    const s = new RoutineScheduler({
      file: path.join(root, `rotinas-${++n}.json`),
      listStaff: async () => [profile('proj')],
      run: async (p, _r, minute) => {
        calls.push(`${p.projectId}@${minute}`);
        return { ok: true, text: 'mandada' };
      },
      paused: async () => {
        if (fails) throw new Error('disco');
        return false;
      },
      log: quiet,
    });
    await s.tick(t(18, 8));
    await s.tick(t(18, 9, 0, 5));
    expect(calls).toEqual([]);
    fails = false;
    await s.tick(t(18, 9, 0, 30));
    expect(calls).toEqual(['proj@2026-11-18T09:00']);
  });
});

// ---- despertador, "continue" e retomada de turno (o mesmo agendador, três instâncias) -------------------------------------------------------------------

describe('AutoContinue: despertador, "continue" do limite e retomada de turno', () => {
  const T0 = Date.parse('2026-11-18T12:00:00.000Z');
  let n = 0;
  const pending = (over: Partial<Pending> = {}): Pending => ({ projectId: 'proj', sessionId: 's1', staffId: 'ana', resetsAt: T0, at: T0, ...over });

  function make(paused: Set<string>) {
    const clock = { t: T0 + MIN };
    const sent: string[] = [];
    const events: string[] = [];
    const file = path.join(root, `pendentes-${++n}.json`);
    const ac = new AutoContinue({
      file,
      enabled: async () => true,
      stopHit: async () => null,
      knownResets: async () => [],
      send: async (p) => void sent.push(p.sessionId),
      paused: async (id) => paused.has(id),
      now: () => clock.t,
      spacingMs: 0,
      log: quiet,
    });
    ac.subscribe((e) => events.push(e.type));
    return { ac, clock, sent, events, file };
  }

  it.each<[string, Partial<Pending>]>([
    ['despertador (com texto)', { text: 'acorde e confira o deploy' }],
    ['"continue" do limite de uso', {}],
    ['retomada de turno que falhou', { retry: { turnId: 'u1', attempt: 1, max: 3, kind: 'transient', error: 'API sobrecarregada' } }],
  ])('%s: pausado, a pendência não sai nem é solta; a de outro projeto sai; retomado, sai', async (_label, extra) => {
    const paused = new Set(['proj']);
    const { ac, sent, events, file } = make(paused);
    await ac.schedule(pending(extra));
    await ac.schedule(pending({ projectId: 'outro', sessionId: 's2', ...extra }));
    await ac.tick();
    expect(sent).toEqual(['s2']);
    expect((await ac.list()).map((p) => p.sessionId)).toEqual(['s1']);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).pending).toHaveLength(1);
    expect(events).toEqual(['sent']); // nada de "dropped" nem "deferred" para a pausada
    await ac.tick();
    await ac.tick();
    expect(sent).toEqual(['s2']);

    paused.clear();
    await ac.tick();
    expect(sent).toEqual(['s2', 's1']);
    expect(await ac.list()).toEqual([]);
  });

  it('a pendência pausada sobrevive ao reinício, no disco', async () => {
    const paused = new Set(['proj']);
    const a = make(paused);
    await a.ac.schedule(pending());
    await a.ac.tick();
    const sent: string[] = [];
    const again = new AutoContinue({ file: a.file, enabled: async () => true, stopHit: async () => null, knownResets: async () => [], send: async (p) => void sent.push(p.sessionId), paused: async (id) => paused.has(id), now: () => T0 + MIN, spacingMs: 0, log: quiet });
    await again.tick();
    expect(sent).toEqual([]);
    paused.clear();
    await again.tick();
    expect(sent).toEqual(['s1']);
  });
});

// ---- retomada após reinício -------------------------------------------------------------------------------------------------------------------------------

describe('retomada após reinício', () => {
  const NOW = Date.parse('2026-11-18T12:00:00.000Z');
  let n = 0;
  const entry = (over: Partial<ResumeEntry> = {}): ResumeEntry => ({ projectId: 'proj', sessionId: 's1', staffId: 'ana', engine: 'claude', cwd: '.', hadPending: false, ...over });
  const resume = async (entries: ResumeEntry[], paused: Set<string>) => {
    const file = path.join(root, `resume-${++n}.json`);
    await fs.writeFile(file, JSON.stringify({ savedAt: new Date(NOW).toISOString(), sessions: entries }));
    const sent: string[] = [];
    const redirected: string[] = [];
    const logs: string[] = [];
    await resumeAfterRestart({
      file,
      now: () => NOW,
      stopHit: async () => null,
      send: async (e) => void sent.push(e.sessionId),
      redirect: async (e) => {
        redirected.push(e.sessionId);
        return false;
      },
      paused: async (id) => paused.has(id),
      log: (l) => logs.push(l),
    });
    return { sent, redirected, logs };
  };

  it.each<Engine>(['claude', 'codex'])('conversa (%s) do projeto pausado não é retomada nem devolvida ao motor principal; a de outro projeto é', async (engine) => {
    const r = await resume([entry({ engine }), entry({ projectId: 'outro', sessionId: 's2', engine })], new Set(['proj']));
    expect(r.sent).toEqual(['s2']);
    expect(r.redirected).toEqual(['s2']);
    expect(r.logs.join('\n')).toMatch(/s1: não retomada: o projeto está pausado/);
  });

  it('sem pausa, todas voltam (o controle)', async () => {
    const r = await resume([entry(), entry({ sessionId: 's2' })], new Set());
    expect(r.sent).toEqual(['s1', 's2']);
  });

  it('sem conseguir ler a pausa, não retoma', async () => {
    const file = path.join(root, `resume-${++n}.json`);
    await fs.writeFile(file, JSON.stringify({ savedAt: new Date(NOW).toISOString(), sessions: [entry()] }));
    const sent: string[] = [];
    await resumeAfterRestart({
      file,
      now: () => NOW,
      stopHit: async () => null,
      send: async (e) => void sent.push(e.sessionId),
      paused: async () => {
        throw new Error('disco');
      },
      log: quiet,
    });
    expect(sent).toEqual([]);
  });
});
