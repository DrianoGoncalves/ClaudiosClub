import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatManager } from '../server/chat/manager';
import { BACKGROUND_WAIT_MS } from '../server/retryPolicy';
import { TaskService } from '../server/tasks';
import type { BackgroundTask, StaffProfile, Task } from '../shared/model';
import { removeTemp } from './support/tmp';

// Turno que termina com trabalho em segundo plano (t-aff796, caso t-33b84c): o resumo "rodando em segundo plano; retomo quando terminar" virou entrega e abriu a revisão em
// cima de trabalho pela metade. Agora o card segue em "fazendo" (sem delivery, sem revisão, sem aviso) até o turno que vem depois do término; o que nunca termina tem prazo.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-bghold-'));
});
afterAll(() => removeTemp(root));

const WAIT_MIN = BACKGROUND_WAIT_MS / 60_000;
const STALE = 'Lote A de mutações rodando em segundo plano; retomo quando terminar.';
const REAL = 'Lote A terminou: 41 de 42 mutantes mortos; segue o resumo.';
const profile = (id: string, name: string) => ({ id, name, role: 'Back-end', autonomy: 'acceptEdits', worktree: false, engine: 'claude' }) as StaffProfile;
const shell = (id = 'b1', label = 'npm run mutation'): BackgroundTask => ({ id, kind: 'shell', label });

/** Ana trabalha, Giovana pediu a tarefa. Cada `club` precisa da sua pasta (senão herda o tasks.json do teste anterior). */
async function club(dirName: string, opts: { liveWork?: boolean } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  const people: Record<string, StaffProfile> = { 'ana-1': profile('ana-1', 'Ana'), 'gio-1': profile('gio-1', 'Giovana') };
  const h = {
    sent: [] as Array<{ sessionId: string; text: string }>,
    notified: [] as Array<{ staffId: string; text: string }>,
    working: new Set<string>(),
    live: {} as Record<string, { busy: boolean; background: BackgroundTask[] }>,
    texts: {} as Record<string, string>,
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
      h.sent.push({ sessionId, text });
      return sessionId;
    },
    notify: async (_p, staffId, text) => {
      h.notified.push({ staffId, text });
    },
    lastText: (s) => h.texts[s] ?? null,
    ...(opts.liveWork !== false && { liveWork: (s: string) => h.live[s] ?? null }),
  });
  const all = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await all()).find((t) => t.id === id)!;
  return { h, svc, get, all, dir };
}
type Club = Awaited<ReturnType<typeof club>>;

/** O que o processo diz agora: o turno rodando e/ou o que há em segundo plano. A conversa "trabalha" com qualquer um dos dois, como no ChatProcess. */
function live(b: Club, work: string, state: { busy?: boolean; background?: BackgroundTask[] }) {
  const busy = state.busy ?? false;
  const background = state.background ?? [];
  b.h.live[work] = { busy, background };
  if (busy || background.length) b.h.working.add(work);
  else b.h.working.delete(work);
}

/** A tarefa da Ana, pedida pela Giovana, começada: a conversa de trabalho está no turno. */
async function comecar(b: Club, title = 'Mutações') {
  const task = (await b.svc.create('p', { title, description: 'Rode as mutações', staffId: 'ana-1', reviewerId: null }, 'gio-1', 'gio-s'))!;
  await b.svc.start('p', task.id);
  const work = (await b.get(task.id)).sessionId!;
  live(b, work, { busy: true });
  return { id: task.id, work };
}

/** O turno acaba com `text` e o segundo plano `background`. `via`: o vigia de sessões (onTurnDone) ou o aviso de ocioso do processo (onIdle). */
async function fimDeTurno(b: Club, work: string, text: string, background: BackgroundTask[] = [], via: 'vigia' | 'processo' = 'vigia') {
  b.h.texts[work] = text;
  live(b, work, { background });
  if (via === 'vigia') await b.svc.onTurnDone(work);
  // O processo só avisa o fim do turno com a conversa parada (sem segundo plano): ver `ChatProcess.idleCheck`.
  else await b.svc.onIdle(work, 'p', 'ana-1', 'turn', 'claude');
}

/** Muda a espera do card no disco (o prazo conta pelo relógio de verdade: aqui o card envelhece em vez de o relógio andar). */
async function edit(b: Club, id: string, change: (w: NonNullable<Task['backgroundWait']>) => Task['backgroundWait']) {
  const file = path.join(b.dir, '.myco', 'tasks.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Task[];
  for (const t of raw) if (t.id === id) t.backgroundWait = change(t.backgroundWait!);
  await fs.writeFile(file, JSON.stringify(raw, null, 2));
}
const expire = (b: Club, id: string) => edit(b, id, (w) => ({ ...w, since: new Date(Date.now() - BACKGROUND_WAIT_MS - 60_000).toISOString() }));

const holdNotes = (t: Task) => t.history.filter((h) => /trabalho em segundo plano/.test(h.note ?? '')).length;
const expiryNote = (t: Task) => t.history.find((h) => /não terminou em/.test(h.note ?? ''))?.note;

describe('(1) fim de turno com segundo plano pendente: não é entrega', () => {
  it('fica em fazendo, sem delivery, sem revisão e sem aviso a quem pediu, e anota a espera', async () => {
    const b = await club('pendente');
    const { id, work } = await comecar(b);
    await fimDeTurno(b, work, STALE, [shell()]);

    const t = await b.get(id);
    expect(t.status).toBe('doing');
    expect(t.delivery).toBeUndefined();
    expect(t.review).toBeUndefined();
    expect(t.reviewRounds).toBeUndefined();
    expect(t.tests).toBeUndefined();
    expect(t.history.map((h) => h.status)).not.toContain('review');
    expect(b.h.notified).toEqual([]);
    expect(t.backgroundWait).toMatchObject({ since: expect.any(String), ids: ['b1'], label: 'shell: npm run mutation' });
    expect(t.backgroundWait?.expiredAt).toBeUndefined();
    expect(holdNotes(t)).toBe(1);
    expect(t.history.at(-1)?.note).toContain(`prazo de ${WAIT_MIN} min`);
  });

  it('o mesmo fim de turno avisado de novo (vigia e processo) não repete a nota nem entrega', async () => {
    const b = await club('pendente-repete');
    const { id, work } = await comecar(b);
    await fimDeTurno(b, work, STALE, [shell()]);
    await fimDeTurno(b, work, STALE, [shell()]);
    // Aviso de ocioso do processo com algo em segundo plano nem chega a existir (idleCheck); se vier, também não entrega.
    b.h.texts[work] = STALE;
    await b.svc.onIdle(work, 'p', 'ana-1', 'turn', 'claude');
    const t = await b.get(id);
    expect(t.status).toBe('doing');
    expect(holdNotes(t)).toBe(1);
    expect(b.h.notified).toEqual([]);
  });

  it('segue ocupando o funcionário: a próxima da fila dele não começa, e o tick não manda "continue"', async () => {
    const b = await club('pendente-ocupa');
    const { id, work } = await comecar(b);
    const outro = (await b.svc.create('p', { title: 'Outra', description: 'x', staffId: 'ana-1', reviewerId: null }))!;
    await b.svc.start('p', outro.id);
    expect(await b.get(outro.id)).toMatchObject({ status: 'todo', sessionId: null });
    await fimDeTurno(b, work, STALE, [shell()]);
    await b.svc.kickStaff('p', 'ana-1');
    expect(await b.get(outro.id)).toMatchObject({ status: 'todo', sessionId: null });
    // A conversa "trabalha" (segundo plano): não é órfã, mesmo com o card parado dentro do prazo.
    await b.svc.tick(new Date(Date.now() + (BACKGROUND_WAIT_MS - 60_000)));
    expect(b.h.sent).toEqual([]);
    expect((await b.get(id)).status).toBe('doing');
  });

  it('agent em segundo plano conta como o comando (qualquer item da lista segura)', async () => {
    const b = await club('pendente-agent');
    const { id, work } = await comecar(b);
    await fimDeTurno(b, work, STALE, [{ id: 'a1', kind: 'agent', label: 'executor: lote B' }, shell()]);
    const t = await b.get(id);
    expect(t.status).toBe('doing');
    expect(t.backgroundWait).toMatchObject({ ids: ['a1', 'b1'], label: 'agent: executor: lote B e mais 1' });
  });

  it('com a dúvida aberta a espera é da dúvida: o segundo plano não a atrasa', async () => {
    const b = await club('pendente-duvida');
    const { id, work } = await comecar(b);
    await fimDeTurno(b, work, 'DÚVIDA: escopo do lote A?\nO resto roda em segundo plano.', [shell()]);
    const t = await b.get(id);
    expect(t.status).toBe('doing');
    // Sem conversa de gestor no teste a dúvida vai direto a você ('escalated'); com gestor, ficaria 'open'. Nos dois casos é a dúvida que segura.
    expect(['open', 'escalated']).toContain(t.question?.status);
    expect(t.delivery).toBeUndefined();
    expect(t.backgroundWait).toBeUndefined();
  });
});

describe('(2) o término e o turno seguinte', () => {
  it('o aviso de ocioso do término não entrega; o fim do turno que vem depois entrega o resumo de verdade', async () => {
    const b = await club('termino');
    const { id, work } = await comecar(b);
    await fimDeTurno(b, work, STALE, [shell()]);

    // O comando termina: o processo avisa "parou" (reason 'background') antes de o Claude Code acordar a conversa com o turno novo.
    live(b, work, {});
    await b.svc.onIdle(work, 'p', 'ana-1', 'background', 'claude');
    let t = await b.get(id);
    expect(t.status).toBe('doing');
    expect(t.delivery).toBeUndefined();
    expect(b.h.notified).toEqual([]);

    // O turno novo roda (a notificação do término) e termina: entrega normal, com o resumo desse turno.
    live(b, work, { busy: true });
    await b.svc.kickStaff('p', 'ana-1');
    await fimDeTurno(b, work, REAL, [], 'processo');
    t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.delivery?.summary).toBe(REAL);
    expect(t.backgroundWait).toBeUndefined();
    expect(t.history.at(-1)).toMatchObject({ status: 'review', by: 'auto', note: 'turno terminou' });
    // Quem pediu recebe a entrega real, e só ela.
    expect(b.h.notified.filter((n) => n.staffId === 'gio-1')).toHaveLength(1);
    expect(b.h.notified[0]!.text).toContain(REAL);
    expect(b.h.notified[0]!.text).not.toContain(STALE);
  });

  it('o mesmo, pelo vigia de sessões em vez do aviso do processo', async () => {
    const b = await club('termino-vigia');
    const { id, work } = await comecar(b);
    await fimDeTurno(b, work, STALE, [shell()]);
    live(b, work, {});
    await b.svc.onIdle(work, 'p', 'ana-1', 'background', 'claude');
    live(b, work, { busy: true });
    await fimDeTurno(b, work, REAL);
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.delivery?.summary).toBe(REAL);
  });

  it('um dos comandos termina e outro segue: continua esperando, sem nota nova', async () => {
    const b = await club('termino-parcial');
    const { id, work } = await comecar(b);
    await fimDeTurno(b, work, STALE, [shell('b1'), shell('b2', 'npm run lint')]);
    // O turno que o primeiro término acorda acaba com o b2 ainda rodando.
    await fimDeTurno(b, work, 'Lote A ok; o lint segue em segundo plano.', [shell('b2', 'npm run lint')]);
    const t = await b.get(id);
    expect(t.status).toBe('doing');
    expect(holdNotes(t)).toBe(1);
    expect(t.backgroundWait?.since).toBeDefined();
    // Acabou tudo: o turno seguinte entrega.
    await fimDeTurno(b, work, REAL);
    expect((await b.get(id)).status).toBe('review');
  });

  it('o aviso de ocioso do término sem marca (o vigia ainda não lera o fim do turno) também não entrega; a órfã retoma a conversa se ela não acordar', async () => {
    const b = await club('termino-sem-marca');
    const { id, work } = await comecar(b);
    b.h.texts[work] = STALE;
    live(b, work, {});
    await b.svc.onIdle(work, 'p', 'ana-1', 'background', 'claude');
    expect((await b.get(id)).status).toBe('doing');
    expect((await b.get(id)).delivery).toBeUndefined();
    // A conversa nunca acordou: depois de ORPHAN_MS o tick a retoma (como a conversa que morreu no meio do turno).
    await b.svc.tick(new Date(Date.now() + 3 * 60_000));
    expect(b.h.sent).toHaveLength(1);
    expect((await b.get(id)).status).toBe('doing');
  });

  it('sai da espera quando o card sai de fazendo (cancelado)', async () => {
    const b = await club('termino-cancela');
    const { id, work } = await comecar(b);
    await fimDeTurno(b, work, STALE, [shell()]);
    await b.svc.cancel('p', id, { by: 'user' });
    const t = await b.get(id);
    expect(t.status).toBe('cancelled');
    expect(t.backgroundWait).toBeUndefined();
  });
});

describe('(3) o prazo para o que nunca termina', () => {
  it('antes do prazo o tick não toca; vencido, entrega como está e deixa a nota', async () => {
    const b = await club('prazo');
    const { id, work } = await comecar(b);
    await fimDeTurno(b, work, STALE, [shell()]);

    await b.svc.tick();
    expect((await b.get(id)).status).toBe('doing');
    expect(b.h.notified).toEqual([]);

    await expire(b, id);
    await b.svc.tick();
    const t = await b.get(id);
    expect(t.status).toBe('review');
    // Entregue como estava, o fluxo de hoje: o resumo é o daquele turno.
    expect(t.delivery?.summary).toBe(STALE);
    expect(expiryNote(t)).toBe(`o segundo plano (shell: npm run mutation) não terminou em ${WAIT_MIN} min: a entrega segue como está`);
    expect(t.history.at(-1)).toMatchObject({ status: 'review', note: 'turno terminou' });
    expect(t.backgroundWait).toBeUndefined();
    expect(b.h.notified.filter((n) => n.staffId === 'gio-1')).toHaveLength(1);
  });

  it('o prazo vale pelo relógio passado ao tick (o mesmo dos outros passos)', async () => {
    const b = await club('prazo-relogio');
    const { id, work } = await comecar(b);
    await fimDeTurno(b, work, STALE, [shell()]);
    await b.svc.tick(new Date(Date.now() + BACKGROUND_WAIT_MS - 120_000));
    expect((await b.get(id)).status).toBe('doing');
    await b.svc.tick(new Date(Date.now() + BACKGROUND_WAIT_MS + 120_000));
    expect((await b.get(id)).status).toBe('review');
  });

  it('com o turno rodando o tick espera; o fim dele, com o mesmo comando pendente e o prazo vencido, entrega', async () => {
    const b = await club('prazo-turno');
    const { id, work } = await comecar(b);
    await fimDeTurno(b, work, STALE, [shell()]);
    await expire(b, id);
    live(b, work, { busy: true, background: [shell()] });
    await b.svc.tick();
    expect((await b.get(id)).status).toBe('doing');
    expect((await b.get(id)).backgroundWait?.expiredAt).toBeUndefined();

    await fimDeTurno(b, work, 'Ainda aguardando o lote A.', [shell()]);
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.delivery?.summary).toBe('Ainda aguardando o lote A.');
    expect(expiryNote(t)).toContain('não terminou em');
  });

  it('conversa fechada com o prazo vencido (o processo saiu e levou o comando): o tick entrega, como a conversa sem segundo plano', async () => {
    const b = await club('prazo-fechada');
    const { id, work } = await comecar(b);
    await fimDeTurno(b, work, STALE, [shell()]);
    await expire(b, id);
    delete b.h.live[work];
    b.h.working.delete(work);
    await b.svc.tick();
    expect((await b.get(id)).status).toBe('review');
  });

  it('vencido o prazo, o mesmo comando não segura de novo; comando novo recomeça a espera', async () => {
    const b = await club('prazo-pegajoso');
    const { id, work } = await comecar(b);
    await fimDeTurno(b, work, STALE, [shell()]);
    // A espera já venceu e o card ficou em fazendo por outro motivo (o marcador de vencida fica).
    await edit(b, id, (w) => ({ ...w, since: new Date(Date.now() - BACKGROUND_WAIT_MS - 60_000).toISOString(), expiredAt: new Date().toISOString() }));
    live(b, work, { busy: true });

    // Comando novo (id fora do que já esperava): é trabalho novo, a espera recomeça.
    await fimDeTurno(b, work, 'Subi outro lote.', [shell('b9', 'npm run lint')]);
    let t = await b.get(id);
    expect(t.status).toBe('doing');
    expect(t.backgroundWait).toMatchObject({ ids: ['b9'], label: 'shell: npm run lint' });
    expect(t.backgroundWait?.expiredAt).toBeUndefined();
    expect(holdNotes(t)).toBe(2);

    // O mesmo comando de antes, já vencido: não segura.
    await edit(b, id, (w) => ({ ...w, ids: ['b1'], label: 'shell: npm run mutation', expiredAt: new Date().toISOString() }));
    live(b, work, { busy: true });
    await fimDeTurno(b, work, STALE, [shell('b1')]);
    t = await b.get(id);
    expect(t.status).toBe('review');
    expect(holdNotes(t)).toBe(2);
  });
});

describe('(4) o que não muda', () => {
  it('fim de turno sem segundo plano entrega como antes (nota, resumo, aviso)', async () => {
    const b = await club('sem-bg');
    const { id, work } = await comecar(b);
    await fimDeTurno(b, work, REAL);
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.delivery?.summary).toBe(REAL);
    expect(t.backgroundWait).toBeUndefined();
    expect(t.history.at(-1)).toMatchObject({ status: 'review', by: 'auto', note: 'turno terminou' });
    expect(holdNotes(t)).toBe(0);
    expect(b.h.notified.filter((n) => n.staffId === 'gio-1')).toHaveLength(1);
  });

  it('sem a leitura do processo (`liveWork` ausente) tudo segue como antes', async () => {
    const b = await club('sem-dep', { liveWork: false });
    const { id, work } = await comecar(b);
    b.h.texts[work] = REAL;
    b.h.working.delete(work);
    await b.svc.onTurnDone(work);
    expect((await b.get(id)).status).toBe('review');
  });

  it('o processo saiu (aviso de saída, conversa fechada) entrega como antes', async () => {
    const b = await club('saiu');
    const { id, work } = await comecar(b);
    b.h.texts[work] = REAL;
    b.h.working.delete(work);
    delete b.h.live[work];
    await b.svc.onIdle(work, 'p', 'ana-1', 'exit', 'claude');
    expect((await b.get(id)).status).toBe('review');
  });

  it('card automático (conversa direta sua) não espera o segundo plano', async () => {
    const b = await club('auto');
    await b.svc.onCodeEdit({ sessionId: 'ana-direta', projectId: 'p', staffId: 'ana-1', engine: 'claude', cwd: b.dir, files: [path.join(b.dir, 'a.ts')], request: null });
    const auto = (await b.all()).find((t) => t.autoCreated && t.sessionId === 'ana-direta');
    expect(auto).toBeDefined();
    b.h.texts['ana-direta'] = 'Servidor de pé em segundo plano.';
    live(b, 'ana-direta', { background: [shell('srv', 'npm run dev')] });
    await b.svc.onTurnDone('ana-direta');
    const t = await b.get(auto!.id);
    expect(t.status).toBe('review');
    expect(t.backgroundWait).toBeUndefined();
  });
});

// ---- a leitura que alimenta a regra: ChatManager.liveWork (processo falso, sem Claude nem Codex de verdade) ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Work = { busy: boolean; background: BackgroundTask[] } | null;

describe('(5) Claude: o que o processo diz ao fim do turno', () => {
  it('o turno acaba com o comando na lista e SEM aviso de ocioso; o término avisa "background" com a lista vazia', async () => {
    const dir = path.join(root, 'm-claude');
    const idle: Array<{ reason: string; work: Work }> = [];
    let emit: (ev: object) => void = () => {};
    const m: ChatManager = new ChatManager({
      transcriptsDir: dir,
      usageFile: path.join(dir, 'usage.json'),
      listLive: async () => [],
      resolve: async (_p, sid) => ({ sessionId: sid ?? 'sx', cwd: '.', args: [] }),
      spawnImpl: () => {
        const stdout = new PassThrough();
        emit = (ev) => void stdout.write(JSON.stringify(ev) + '\n');
        return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: 4242 }) as never;
      },
      onIdle: (sid, _p, _s, reason) => idle.push({ reason, work: m.liveWork(sid) }),
      log: () => {},
    });
    expect(m.liveWork('s1')).toBeNull();
    await m.send('p', 's1', 'ana', 'rode as mutações');
    emit({ type: 'system', subtype: 'init', model: 'm', permissionMode: 'default' });
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'npm run mutation' }] });
    emit({ type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: STALE }] } });
    emit({ type: 'result', is_error: false, result: STALE });
    await sleep(40);
    // O turno acabou, mas a conversa "trabalha": sem aviso de ocioso. É por isso que quem decide a entrega (o vigia de sessões, ou o prazo) lê `liveWork`.
    expect(idle).toEqual([]);
    expect(m.liveWork('s1')).toEqual({ busy: false, background: [{ id: 'b1', kind: 'shell', label: 'npm run mutation' }] });

    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    await sleep(40);
    expect(idle).toEqual([{ reason: 'background', work: { busy: false, background: [] } }]);
  });
});

describe('(6) Codex: não há segundo plano ao fim do turno', () => {
  it('o subagent ainda ativo sai da lista antes do aviso de ocioso: liveWork vem vazio e a entrega não espera nada', async () => {
    const home = path.join(root, 'codex-home');
    const day = path.join(home, 'sessions', '2026', '11', '19');
    await fs.mkdir(day, { recursive: true });
    const rollout = path.join(day, 'rollout-2026-11-19T10-00-00-thread-bg01-aaaa.jsonl');
    await fs.writeFile(rollout, '{"type":"session_meta","payload":{}}\n');
    const started = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'pai', item: { type: 'SubAgentActivity', kind: 'started', id: 'call_1', agent_thread_id: 'filho-1', agent_path: '/root/lote_a' } } });

    const before = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const dir = path.join(root, 'm-codex');
      const idle: Array<{ reason: string; work: Work }> = [];
      const runs: Array<{ emit: (ev: object) => void; close: (code?: number | null) => void }> = [];
      const m: ChatManager = new ChatManager({
        transcriptsDir: dir,
        usageFile: path.join(dir, 'usage.json'),
        listLive: async () => [],
        resolve: async (_p, sid) => ({
          sessionId: sid ?? 'cx',
          cwd: root,
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
            secrets: { projectPath: root, home: path.join(root, 'sem-home'), mycoHome: path.join(root, 'sem-myco') },
            threadId: 'thread-bg01-aaaa',
            threadFile: path.join(dir, 'codex-thread.json'),
            mycoUrl: 'http://127.0.0.2:4848',
          },
        }),
        spawnImpl: () => {
          const stdout = new PassThrough();
          const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: 5000 + runs.length });
          runs.push({ emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n'), close: (code = 0) => void child.emit('close', code) });
          return child as never;
        },
        onIdle: (sid, _p, _s, reason) => idle.push({ reason, work: m.liveWork(sid) }),
        log: () => {},
      });
      await m.send('p', 'cx', 'cris', 'faça a tarefa');
      await sleep(300); // a primeira volta do vigia do rollout (começa do fim do arquivo)
      runs.at(-1)!.emit({ type: 'turn.started' });
      await fs.appendFile(rollout, started + '\n');
      // O vigia o vê (a cada 1,5 s): o agent aparece em segundo plano durante o turno, como no Claude.
      await vi.waitFor(() => expect(m.liveWork('cx')?.background).toEqual([{ id: 'filho-1', kind: 'agent', label: 'agent: lote_a' }]), { timeout: 8000, interval: 50 });
      expect(m.liveWork('cx')?.busy).toBe(true);

      runs.at(-1)!.emit({ type: 'turn.completed', usage: {} });
      await sleep(60);
      // O fim do turno zera a lista (`endTurn` para o vigia) ANTES do aviso de ocioso: o Codex nunca entrega com segundo plano pendente.
      expect(idle).toEqual([{ reason: 'turn', work: { busy: false, background: [] } }]);
      runs.at(-1)!.close(0);
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = before;
    }
  });
});