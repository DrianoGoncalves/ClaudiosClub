import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import type { Caller } from '../server/callers';
import { versionPauseEndId, versionPauseItems } from '../server/inboxItems';
import { ENDED_KEEP_MS, ProjectPauses, VERSION_PAUSE_MAX_MINUTES, type ProjectPauseEnd } from '../server/projectPause';
import { RoutineScheduler } from '../server/routines';
import { TaskConflictError, TaskError, TaskForbiddenError, TaskService } from '../server/tasks';
import type { Engine, StaffProfile } from '../shared/model';
import { removeTemp } from './support/tmp';

// Pausa de versão (t-4bd86a): o mesmo mecanismo da pausa de projeto, com prazo. Nada novo começa (fila, início de tarefa, rotinas, despertador, troca de motor, órfãs); o que já está em voo
// termina (turno, revisão da entrega e o ajuste de um card em fazendo, planejando ou revisão, como a reprovação). Sai sozinha no prazo ou quando quem ligou encerra. Quem liga pela API é o
// funcionário com `canRelease` ("Pode versionar e fazer deploy"); o dono liga pela tela. A pausa comum não muda (tests/projectPause.test.ts).

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-vpause-'));
});
afterAll(() => removeTemp(root));

const MIN = 60_000;
const quiet = () => {};
const T0 = new Date('2026-11-21T10:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * MIN);
const GIO = { staffId: 'gio-1', name: 'Giovana' };
const DEB = { staffId: 'deb-1', name: 'Débora' };

describe('ProjectPauses: pausa de versão em disco', () => {
  const file = (name: string) => path.join(root, `${name}.json`);
  const ends = () => {
    const seen: Array<{ projectId: string; end: ProjectPauseEnd }> = [];
    return { seen, onEnd: (projectId: string, end: ProjectPauseEnd) => void seen.push({ projectId, end }) };
  };

  it('liga com prazo e quem ligou, vale para isPaused, sobrevive ao reinício; a pausa comum segue só { at }', async () => {
    const f = file('liga');
    const a = new ProjectPauses(f, quiet);
    const got = await a.pauseVersion('p', { minutes: 30, by: GIO }, T0);
    expect(got).toEqual({ ok: true, created: true, pause: { at: T0.toISOString(), mode: 'version', until: at(30).toISOString(), by: GIO } });
    expect(await a.isPaused('p', at(29))).toBe(true);
    // Outra instância sobre o mesmo arquivo (o reinício): o mesmo estado.
    const b = new ProjectPauses(f, quiet);
    expect(await b.get('p', at(1))).toEqual({ at: T0.toISOString(), mode: 'version', until: at(30).toISOString(), by: GIO });
    expect(await b.all(at(1))).toEqual({ p: await b.get('p', at(1)) });
    // O dono pela tela: sem `by`. A comum em outro projeto: exatamente { at } (o contrato que a tela já lê).
    await b.pauseVersion('q', { minutes: 5 }, T0);
    expect((await b.get('q', at(1)))!.by).toBeUndefined();
    await b.pause('r', T0);
    expect(await b.get('r', at(1))).toEqual({ at: T0.toISOString() });
  });

  it('vence no prazo: deixa de valer no instante, avisa uma vez (mesmo com perguntas ao mesmo tempo) e grava a saída com a hora do prazo', async () => {
    const f = file('vence');
    const { seen, onEnd } = ends();
    const a = new ProjectPauses(f, quiet, onEnd);
    await a.pauseVersion('p', { minutes: 30, by: GIO }, T0);
    expect(await a.isPaused('p', at(29.9))).toBe(true);
    const answers = await Promise.all([a.isPaused('p', at(30)), a.isPaused('p', at(31)), a.get('p', at(31))]);
    expect(answers).toEqual([false, false, null]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ projectId: 'p', end: { reason: 'expired', at: at(30).toISOString(), pause: { mode: 'version', by: GIO } } });
    expect(await a.all(at(31))).toEqual({});
    // Gravado (a gravação segue na fila, sem ninguém esperar por ela): outra instância já não vê a pausa e ainda guarda o aviso de saída para a caixa.
    await until(async () => Object.keys(JSON.parse(await fs.readFile(f, 'utf8')).projects).length === 0);
    const b = new ProjectPauses(f, quiet);
    expect(await b.isPaused('p', at(31))).toBe(false);
    expect((await b.notices(at(31))).ended).toEqual([{ projectId: 'p', end: expect.objectContaining({ reason: 'expired', at: at(30).toISOString() }) }]);
  });

  it('venceu com o servidor fora: a primeira pergunta depois do reinício a tira e guarda o aviso', async () => {
    const f = file('fora');
    await new ProjectPauses(f, quiet).pauseVersion('p', { minutes: 10, by: GIO }, T0);
    const { seen, onEnd } = ends();
    const reborn = new ProjectPauses(f, quiet, onEnd);
    expect(await reborn.isPaused('p', at(120))).toBe(false);
    expect(seen).toHaveLength(1);
    expect((await reborn.notices(at(120))).ended[0]!.end).toMatchObject({ reason: 'expired', at: at(10).toISOString() });
  });

  it('conflitos: pausa comum não é trocada pela de versão; de outro autor, não; o mesmo autor de novo não muda o prazo; a comum por cima converte', async () => {
    const { seen, onEnd } = ends();
    const a = new ProjectPauses(file('conflito'), quiet, onEnd);
    await a.pause('c', T0);
    expect(await a.pauseVersion('c', { minutes: 30, by: GIO }, at(1))).toMatchObject({ ok: false, reason: 'standard', pause: { at: T0.toISOString() } });
    expect(await a.get('c', at(2))).toEqual({ at: T0.toISOString() }); // a comum segue como estava

    await a.pauseVersion('v', { minutes: 30, by: GIO }, T0);
    expect(await a.pauseVersion('v', { minutes: 30, by: DEB }, at(1))).toMatchObject({ ok: false, reason: 'other', pause: { by: GIO } });
    expect(await a.pauseVersion('v', { minutes: 60 }, at(1))).toMatchObject({ ok: false, reason: 'other' }); // o dono também não pisa na de um funcionário sem encerrar
    const again = await a.pauseVersion('v', { minutes: 90, by: GIO }, at(5));
    expect(again).toMatchObject({ ok: true, created: false, pause: { until: at(30).toISOString() } });

    // A comum por cima da de versão: converte (sem prazo, o mesmo horário de parada) e guarda a saída como `standard`.
    expect(await a.pause('v', at(10))).toEqual({ at: T0.toISOString() });
    expect(await a.get('v', at(500))).toEqual({ at: T0.toISOString() }); // sem prazo: não sai sozinha
    expect(seen).toEqual([{ projectId: 'v', end: expect.objectContaining({ reason: 'standard', pause: expect.objectContaining({ mode: 'version' }) }) }]);
  });

  it(`prazo fora de 1 a ${VERSION_PAUSE_MAX_MINUTES} minutos (ou não inteiro) é recusado e nada é gravado`, async () => {
    const a = new ProjectPauses(file('prazo'), quiet);
    for (const minutes of [0, -5, VERSION_PAUSE_MAX_MINUTES + 1, 1.5, Number.NaN, Infinity]) {
      await expect(a.pauseVersion('p', { minutes }, T0)).rejects.toBeInstanceOf(RangeError);
    }
    expect(await a.isPaused('p', T0)).toBe(false);
    expect(await a.pauseVersion('p', { minutes: VERSION_PAUSE_MAX_MINUTES }, T0)).toMatchObject({ ok: true, pause: { until: at(VERSION_PAUSE_MAX_MINUTES).toISOString() } });
  });

  it('entrada de versão sem prazo no arquivo é ignorada (nunca vira pausa para sempre) e não leva as outras', async () => {
    const f = file('sem-prazo');
    const logs: string[] = [];
    await fs.writeFile(f, JSON.stringify({ version: 1, projects: { semPrazo: { at: T0.toISOString(), mode: 'version' }, ok: { at: T0.toISOString(), mode: 'version', until: at(30).toISOString() }, comum: { at: T0.toISOString(), until: at(1).toISOString(), by: GIO } } }));
    const a = new ProjectPauses(f, (l) => logs.push(l));
    expect(await a.isPaused('semPrazo', at(1))).toBe(false);
    expect(logs.join('\n')).toMatch(/semPrazo.*inválida/);
    expect(await a.get('ok', at(1))).toMatchObject({ mode: 'version', until: at(30).toISOString() });
    // `until` e `by` soltos numa pausa comum não a transformam em pausa com prazo: ela segue { at } e não vence.
    expect(await a.get('comum', at(60))).toEqual({ at: T0.toISOString() });
  });

  it('encerrar guarda quem encerrou e o motivo, avisa; `only` recusando não muda nada; em pausa comum não há aviso', async () => {
    const { seen, onEnd } = ends();
    const a = new ProjectPauses(file('encerra'), quiet, onEnd);
    await a.pauseVersion('p', { minutes: 30, by: GIO }, T0);
    expect(await a.resume('p', { reason: 'ended', by: GIO, now: at(5), only: () => false })).toBe(false);
    expect(await a.isPaused('p', at(6))).toBe(true);
    expect(seen).toEqual([]);
    expect(await a.resume('p', { reason: 'ended', by: GIO, now: at(7) })).toBe(true);
    expect(await a.isPaused('p', at(8))).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.end).toMatchObject({ reason: 'ended', at: at(7).toISOString(), endedBy: GIO, pause: { mode: 'version' } });
    expect(await a.resume('p', { now: at(9) })).toBe(false);

    await a.pause('c', T0);
    expect(await a.resume('c', { now: at(1) })).toBe(true);
    expect(seen).toHaveLength(1); // a pausa comum não gera saída
    expect((await a.notices(at(2))).ended.map((e) => e.projectId)).toEqual(['p']);
  });

  it('a caixa: a pausa ligada e a saída; a saída some em 24 h e ao dispensar (só pelo `at` certo)', async () => {
    const f = file('caixa');
    const a = new ProjectPauses(f, quiet);
    await a.pauseVersion('p', { minutes: 30, by: GIO }, T0);
    await a.pause('c', T0);
    expect(await a.notices(at(1))).toEqual({ active: [{ projectId: 'p', pause: expect.objectContaining({ mode: 'version' }) }], ended: [] });
    await a.resume('p', { reason: 'resumed', now: at(2) });
    const first = (await a.notices(at(3))).ended[0]!;
    expect((await a.notices(at(3))).active).toEqual([]);
    // O mesmo aviso depois de um reinício (vai junto no arquivo).
    expect((await new ProjectPauses(f, quiet).notices(at(3))).ended).toHaveLength(1);
    expect(await a.dismissEnd('p', Date.parse(first.end.at) + 1)).toBe(false); // outra saída, não esta
    expect((await a.notices(at(3))).ended).toHaveLength(1);
    expect(await a.dismissEnd('p', Date.parse(first.end.at))).toBe(true);
    expect((await a.notices(at(3))).ended).toEqual([]);
    expect((await new ProjectPauses(f, quiet).notices(at(3))).ended).toEqual([]);

    await a.pauseVersion('p', { minutes: 5, by: GIO }, at(10));
    await a.resume('p', { now: at(11) });
    expect((await a.notices(at(12))).ended).toHaveLength(1);
    expect((await a.notices(new Date(at(11).getTime() + ENDED_KEEP_MS + 1))).ended).toEqual([]);
  });

  it('pausa que não gravou não vale: o erro sobe, o projeto segue rodando e nada fica na memória', async () => {
    const blocker = file('arquivo-no-caminho');
    await fs.writeFile(blocker, 'x');
    const a = new ProjectPauses(path.join(blocker, 'paused.json'), quiet);
    await expect(a.pauseVersion('p', { minutes: 30, by: GIO }, T0)).rejects.toThrow();
    expect(await a.isPaused('p', at(1))).toBe(false);
  });
});

// ---- o serviço de tarefas ---------------------------------------------------------------------------------------------------------------------------------

const RULES: Record<string, Partial<StaffProfile>> = {
  'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false },
  'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'manual', worktree: false },
  'gio-1': { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false, canRelease: true },
  'deb-1': { id: 'deb-1', name: 'Débora', role: 'DevOps', autonomy: 'acceptEdits', worktree: false, canRelease: true },
  'off-1': { id: 'off-1', name: 'Otto', role: 'Orquestrador', autonomy: 'acceptEdits', worktree: false, canRelease: false },
};

/** Um quadro por teste: pasta própria, a pausa num arquivo próprio (a saída por prazo liga a rodada do projeto, como no index.ts) e fakes que anotam o que o serviço abriu e mandou. */
async function club(name: string, opts: { engine?: Engine; projects?: string[] } = {}) {
  const projects = opts.projects ?? ['p'];
  const dirs: Record<string, string> = {};
  for (const p of projects) {
    dirs[p] = path.join(root, `${name}-${p}`);
    await fs.mkdir(dirs[p]!, { recursive: true });
  }
  let svc: TaskService;
  const pauses = new ProjectPauses(path.join(root, `${name}-pausas.json`), quiet, (projectId, end) => {
    if (end.reason === 'expired') svc.resumeAfterExpiry(projectId);
  });
  const people = (id: string): StaffProfile | null => {
    const r = RULES[id];
    return r ? ({ ...r, ...(id === 'ana-1' && { engine: opts.engine ?? 'claude' }) } as unknown as StaffProfile) : null;
  };
  const h = {
    opened: [] as Array<{ project: string; staffId: string; text: string; session: string; reviewOnly?: boolean }>,
    sentTo: [] as Array<{ project: string; session: string; staffId: string; text: string }>,
    busy: {} as Record<string, boolean>,
    lastText: null as string | null,
    n: 0,
  };
  svc = new TaskService({
    projectPath: async (id) => dirs[id] ?? null,
    projectIds: async () => projects,
    readProfile: async (p, id) => (dirs[p] ? people(id) : null), // projeto que não existe não tem ficha
    send: async (project, staffId, text, _force, _override, reviewOnly) => {
      const session = `${staffId}-${++h.n}`;
      h.opened.push({ project, staffId, text, session, reviewOnly });
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
    stopSession: () => {},
    snapshot: async (_p, sid) => ({ sessionId: sid, history: [], live: null }) as never,
    apiUrl: 'http://127.0.0.1:4848',
    sandboxApiUrl: 'http://127.0.0.2:4848',
    pauses,
  });
  const list = async (p = 'p') => (await svc.list(p))!;
  const get = async (id: string, p = 'p') => (await list(p)).find((t) => t.id === id)!;
  const edit = async (id: string, fn: (t: Record<string, any>) => void, p = 'p') => {
    const file = path.join(dirs[p]!, '.myco', 'tasks.json');
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    fn(all.find((t) => t.id === id)!);
    await fs.writeFile(file, JSON.stringify(all));
  };
  const add = async (title: string, extra: Record<string, unknown> = {}, p = 'p') => (await svc.create(p, { title, staffId: 'ana-1', ...extra }))!;
  const turnEnds = async (session: string, p = 'p') => {
    h.busy[`${p}:ana-1`] = false;
    if (opts.engine === 'codex') await svc.onIdle(session, p, 'ana-1', 'turn', 'codex');
    else await svc.onIdle(session, p, 'ana-1');
  };
  const reviews = () => h.opened.filter((o) => o.staffId === 'rev-1');
  const works = () => h.opened.filter((o) => o.staffId === 'ana-1');
  /** O dono liga a pausa de versão pela tela (prazo padrão). */
  const owner = (minutes?: number) => svc.setVersionPause('p', minutes === undefined ? {} : { minutes }, true, null);
  return { svc, pauses, h, dirs, list, get, edit, add, turnEnds, reviews, works, owner };
}

/** Quem chama pela API com o token da conversa (ver callers.ts). */
const as = (staffId: string | null, projectId = 'p'): Caller => ({ staffId, projectId, sessionId: `s-${staffId}`, engine: 'claude', sandbox: false });

async function until(fn: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('não chegou a tempo');
}

describe('quem liga e encerra: o dono e o funcionário com a permissão', () => {
  it('sem a permissão, sem token, sem ficha ou com token de outro projeto: 403, e nada muda', async () => {
    const c = await club('perm', { projects: ['p', 'outro'] });
    for (const caller of [as('ana-1'), as('off-1'), null, as(null), as('gio-1', 'outro'), as('fantasma-1')]) {
      await expect(c.svc.setVersionPause('p', { minutes: 10 }, false, caller)).rejects.toBeInstanceOf(TaskForbiddenError);
    }
    expect(await c.pauses.isPaused('p')).toBe(false);
    // O requestedBy do corpo não vale: quem chama é o do token.
    await expect(c.svc.setVersionPause('p', { minutes: 10, requestedBy: 'gio-1', staffId: 'gio-1' }, false, as('ana-1'))).rejects.toBeInstanceOf(TaskForbiddenError);
    expect(await c.pauses.isPaused('p')).toBe(false);
  });

  it('com a permissão liga (registra quem, quando e até quando); o dono, pela tela, também, e sem prazo vale 30 min', async () => {
    const c = await club('liga');
    const before = Date.now();
    const got = (await c.svc.setVersionPause('p', { minutes: 45 }, false, as('gio-1')))!.paused;
    expect(got).toMatchObject({ mode: 'version', by: GIO });
    expect(Date.parse(got.at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(got.until!) - Date.parse(got.at)).toBe(45 * MIN);
    expect(await c.svc.pauseOf('p')).toEqual({ paused: got });

    const d = await club('liga-dono');
    const own = (await d.owner())!.paused;
    expect(own.mode).toBe('version');
    expect(own.by).toBeUndefined();
    expect(Date.parse(own.until!) - Date.parse(own.at)).toBe(30 * MIN);
    expect((await d.svc.setVersionPause('p', { minutes: 90 }, true, null))!.paused).toEqual(own); // já ligada pelo dono: ligar de novo não muda o prazo
  });

  it('o prazo do funcionário é obrigatório e fica em 1 a 120: o resto é 400 (TaskError), sem ajuste calado', async () => {
    const c = await club('prazo');
    for (const body of [{}, null, 'x', { minutes: 0 }, { minutes: -1 }, { minutes: 121 }, { minutes: 1.5 }, { minutes: '30' }, { minutes: null }, { minutes: Number.NaN }]) {
      const err = await c.svc.setVersionPause('p', body, false, as('gio-1')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TaskError);
      expect(err).not.toBeInstanceOf(TaskForbiddenError);
      expect(err).not.toBeInstanceOf(TaskConflictError);
    }
    // O dono também não passa do teto.
    await expect(c.svc.setVersionPause('p', { minutes: 121 }, true, null)).rejects.toBeInstanceOf(TaskError);
    expect(await c.pauses.isPaused('p')).toBe(false);
    expect((await c.svc.setVersionPause('p', { minutes: 120 }, false, as('gio-1')))!.paused.until).toBeDefined();
  });

  it('projeto que não existe: 404 (null) para o dono; o funcionário de outro projeto leva 403 antes', async () => {
    const c = await club('sem-projeto');
    expect(await c.svc.setVersionPause('nao-existe', { minutes: 5 }, true, null)).toBeNull();
    expect(await c.svc.endVersionPause('nao-existe', true, null)).toBeNull();
    await expect(c.svc.setVersionPause('nao-existe', { minutes: 5 }, false, as('gio-1', 'nao-existe'))).rejects.toBeInstanceOf(TaskForbiddenError);
  });

  it('conflitos: sobre a pausa comum é 409 (ela segue); a de outra pessoa é 409; quem já ligou chamando de novo não muda o prazo', async () => {
    const c = await club('conflito');
    await c.svc.setPaused('p', true, true);
    const err = await c.svc.setVersionPause('p', { minutes: 10 }, false, as('gio-1')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskConflictError);
    expect(await c.svc.pauseOf('p')).toEqual({ paused: { at: expect.any(String) } });
    await c.svc.setPaused('p', false, true);

    const first = (await c.svc.setVersionPause('p', { minutes: 20 }, false, as('gio-1')))!.paused;
    const other = await c.svc.setVersionPause('p', { minutes: 20 }, false, as('deb-1')).catch((e: unknown) => e);
    expect(other).toBeInstanceOf(TaskConflictError);
    expect((other as Error).message).toContain('Giovana');
    expect((await c.svc.setVersionPause('p', { minutes: 100 }, false, as('gio-1')))!.paused).toEqual(first);
  });

  it('encerrar: quem ligou (com a permissão) e o dono; outro funcionário, mesmo com a permissão, leva 403; sem pausa é um nada; em pausa comum é 409', async () => {
    const c = await club('encerra');
    expect(await c.svc.endVersionPause('p', false, as('gio-1'))).toEqual({ paused: null }); // nada ligado
    await c.svc.setVersionPause('p', { minutes: 30 }, false, as('gio-1'));
    for (const caller of [as('deb-1'), as('ana-1'), null, as(null)]) await expect(c.svc.endVersionPause('p', false, caller)).rejects.toBeInstanceOf(TaskForbiddenError);
    expect(await c.pauses.isPaused('p')).toBe(true);
    expect(await c.svc.endVersionPause('p', false, as('gio-1'))).toEqual({ paused: null });
    expect(await c.pauses.isPaused('p')).toBe(false);
    expect((await c.pauses.notices()).ended[0]!.end).toMatchObject({ reason: 'ended', endedBy: GIO });

    // O dono encerra a de um funcionário (e a saída diz que foi ele).
    await c.svc.setVersionPause('p', { minutes: 30 }, false, as('deb-1'));
    expect(await c.svc.endVersionPause('p', true, null)).toEqual({ paused: null });
    expect(await c.pauses.isPaused('p')).toBe(false);
    expect((await c.pauses.notices()).ended[0]!.end).toMatchObject({ reason: 'resumed' });

    // Pausa comum: nem o funcionário nem a rota de versão a retomam (409), e ela segue.
    await c.svc.setPaused('p', true, true);
    await expect(c.svc.endVersionPause('p', false, as('gio-1'))).rejects.toBeInstanceOf(TaskConflictError);
    await expect(c.svc.endVersionPause('p', true, null)).rejects.toBeInstanceOf(TaskConflictError);
    expect(await c.pauses.isPaused('p')).toBe(true);
  });

  it('a pausa comum continua só da tela: funcionário (token) leva 403 ao pausar e ao retomar, mesmo com a permissão', async () => {
    const c = await club('comum');
    await expect(c.svc.setPaused('p', true, false)).rejects.toBeInstanceOf(TaskForbiddenError);
    await c.svc.setVersionPause('p', { minutes: 30 }, false, as('gio-1'));
    await expect(c.svc.setPaused('p', false, false)).rejects.toBeInstanceOf(TaskForbiddenError);
    expect(await c.pauses.isPaused('p')).toBe(true);
  });

  it('o dono pausar "comum" sobre a pausa de versão a converte (sem prazo, mesmo horário) e a tela lê o novo estado', async () => {
    const c = await club('converte');
    const v = (await c.svc.setVersionPause('p', { minutes: 30 }, false, as('gio-1')))!.paused;
    const standard = (await c.svc.setPaused('p', true, true))!.paused!;
    expect(standard).toEqual({ at: v.at });
    expect(await c.svc.pauseOf('p')).toEqual({ paused: { at: v.at } });
    expect((await c.pauses.notices()).ended[0]!.end.reason).toBe('standard');
  });
});

describe.each<Engine>(['claude', 'codex'])('com a pausa de versão ligada (funcionário no %s)', (engine) => {
  it('nada novo começa: a fila espera, o "Começar" que não é do dono entra na fila com a nota, o do dono abre; ao sair, a fila anda', async () => {
    const c = await club(`fila-${engine}`, { engine });
    const a = await c.add('A');
    const b = await c.add('B');
    await c.owner();
    await c.svc.start('p', a.id);
    await c.svc.start('p', b.id);
    expect((await c.get(a.id)).history.at(-1)?.note).toMatch(/em pausa de versão/);
    await c.svc.tick();
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.h.opened).toEqual([]);
    expect(await c.get(a.id)).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String) });
    // O "Começar" do dono é ação manual: abre mesmo assim.
    const manual = await c.add('Manual');
    const started = (await c.svc.start('p', manual.id, false, { byOwner: true }))!;
    expect(started).toMatchObject({ status: 'doing', sessionId: expect.any(String) });
    await c.turnEnds(started.sessionId!); // o turno dele acaba com a pausa ligada: a Ana fica livre e a A continua esperando
    await c.svc.tick();
    expect(c.works()).toHaveLength(1);

    await c.svc.endVersionPause('p', true, null);
    await until(async () => c.works().some((o) => o.text.includes('[Tarefa "A"]')));
  });

  it('o turno em andamento termina (vai para revisão) e a próxima da fila não começa; a revisão da entrega abre e grava o veredito', async () => {
    const c = await club(`turno-${engine}`, { engine });
    const a = await c.add('Tela', { reviewerId: 'rev-1' });
    const b = await c.add('Outra');
    await c.svc.start('p', a.id);
    await c.svc.start('p', b.id); // Ana ocupada: a Outra na fila
    const session = (await c.get(a.id)).sessionId!;
    await c.owner();
    await c.turnEnds(session);
    expect(await c.get(a.id)).toMatchObject({ status: 'review', sessionId: session });
    expect(c.reviews()).toHaveLength(1);
    expect(c.reviews()[0]).toMatchObject({ reviewOnly: true });
    await c.svc.tick();
    expect(c.works()).toHaveLength(1); // a Outra não começou
    c.h.lastText = 'APROVADO\n🟢 nada a apontar';
    await c.svc.onTurnDone(c.reviews()[0]!.session);
    expect(await c.get(a.id)).toMatchObject({ status: 'done', review: { verdict: 'approved' } });
    await c.svc.tick();
    expect(c.works()).toHaveLength(1);
    expect(await c.get(b.id)).toMatchObject({ status: 'todo', sessionId: null });
  });

  it('o ajuste da reprovação de um card em revisão SEGUE: o card volta a fazendo e o ajuste vai à conversa (na pausa comum ele espera)', async () => {
    const c = await club(`reprova-${engine}`, { engine });
    const t = await c.add('Tela', { reviewerId: 'rev-1' });
    await c.svc.start('p', t.id);
    await c.turnEnds((await c.get(t.id)).sessionId!);
    const reviewSession = c.reviews()[0]!.session;
    const work = (await c.get(t.id)).sessionId!;
    await c.owner();
    c.h.lastText = 'REPROVADO\n🔴 faltou validar a entrada';
    await c.svc.onTurnDone(reviewSession);
    const after = await c.get(t.id);
    expect(after.status).toBe('doing');
    expect(after.held ?? []).toEqual([]);
    expect(c.h.sentTo).toHaveLength(1);
    expect(c.h.sentTo[0]).toMatchObject({ session: work, staffId: 'ana-1' });
    expect(c.h.sentTo[0]!.text).toContain('faltou validar a entrada');

    // O controle: com a pausa comum, a mesma reprovação fica guardada e a tarefa segue em revisão.
    const d = await club(`reprova-comum-${engine}`, { engine });
    const u = await d.add('Tela', { reviewerId: 'rev-1' });
    await d.svc.start('p', u.id);
    await d.turnEnds((await d.get(u.id)).sessionId!);
    await d.svc.setPaused('p', true, true);
    d.h.lastText = 'REPROVADO\n🔴 faltou validar a entrada';
    await d.svc.onTurnDone(d.reviews()[0]!.session);
    expect(await d.get(u.id)).toMatchObject({ status: 'review', held: [expect.objectContaining({ auto: true, reason: 'espera o projeto ser retomado' })] });
    expect(d.h.sentTo).toEqual([]);
  });

  it('mensagem automática: segue para o card em voo (fazendo, planejando, revisão) e espera para o que abriria trabalho novo (a fazer, pronto, sem conversa)', async () => {
    const c = await club(`hold-${engine}`, { engine });
    const t = await c.add('Tela');
    await c.svc.start('p', t.id);
    const session = (await c.get(t.id)).sessionId!;
    c.h.busy['p:ana-1'] = false;
    await c.owner();
    for (const status of ['doing', 'planning', 'review']) {
      await c.edit(t.id, (x) => (x.status = status));
      expect(await c.svc.hold(session, { text: 'de outro funcionário', auto: true })).toBeNull();
    }
    for (const status of ['todo', 'waiting']) {
      await c.edit(t.id, (x) => (x.status = status));
      expect(await c.svc.hold(session, { text: `para ${status}`, auto: true })).toBe('espera o projeto ser retomado');
    }
    expect((await c.get(t.id)).held).toHaveLength(2);
    // A do dono nunca espera pela pausa, em nenhum estado do card.
    expect(await c.svc.hold(session, { text: 'do dono', byOwner: true })).toBeNull();
  });

  it('o ajuste guardado: o automático do card em voo vai; o do card parado em "a fazer" espera; o seu sempre vai', async () => {
    const c = await club(`ajuste-${engine}`, { engine });
    const t = await c.add('Tela');
    await c.svc.start('p', t.id);
    const session = (await c.get(t.id)).sessionId!;
    c.h.busy['p:ana-1'] = false;
    const stamp = new Date().toISOString();
    await c.edit(t.id, (x) => (x.held = [{ id: 'auto1', at: stamp, text: 'ajuste do gestor', reason: 'x', auto: true }]));
    await c.owner();
    await c.svc.tick();
    expect(c.h.sentTo).toEqual([{ project: 'p', session, staffId: 'ana-1', text: 'ajuste do gestor' }]);
    expect((await c.get(t.id)).held ?? []).toEqual([]);

    // O mesmo ajuste num card que voltou para "a fazer": é trabalho novo, espera.
    c.h.busy['p:ana-1'] = false;
    await c.edit(t.id, (x) => {
      x.status = 'todo';
      x.held = [{ id: 'auto2', at: stamp, text: 'ajuste de card parado', reason: 'x', auto: true }];
    });
    await c.svc.tick();
    expect(c.h.sentTo).toHaveLength(1);
    expect((await c.get(t.id)).held!.map((m) => m.id)).toEqual(['auto2']);
    // O controle (pausa comum): nem o do card em voo vai.
    const d = await club(`ajuste-comum-${engine}`, { engine });
    const u = await d.add('Tela');
    await d.svc.start('p', u.id);
    d.h.busy['p:ana-1'] = false;
    await d.edit(u.id, (x) => (x.held = [{ id: 'auto1', at: stamp, text: 'ajuste do gestor', reason: 'x', auto: true }]));
    await d.svc.setPaused('p', true, true);
    await d.svc.tick();
    expect(d.h.sentTo).toEqual([]);
  });

  it('sai sozinha no prazo: a fila volta a andar sem ninguém retomar, e a saída fica para a caixa', async () => {
    const c = await club(`prazo-${engine}`, { engine });
    const a = await c.add('A');
    // Ligada com prazo de 1 h, "há 1 h menos 250 ms": vence em 250 ms.
    await c.pauses.pauseVersion('p', { minutes: 60, by: GIO }, new Date(Date.now() - (60 * MIN - 250)));
    expect(await c.pauses.isPaused('p')).toBe(true);
    await c.svc.start('p', a.id); // entra na fila: pausado
    await c.svc.tick();
    expect(c.works()).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 300));
    // A primeira pergunta depois do prazo (aqui o tick; no servidor, o de 60 s ou qualquer gate) tira a pausa e liga a rodada do projeto.
    await c.svc.tick();
    await until(() => c.works().length === 1);
    expect(await c.pauses.isPaused('p')).toBe(false);
    expect((await c.pauses.notices()).ended[0]!.end).toMatchObject({ reason: 'expired', pause: { by: GIO } });
  });
});

describe('o estado que a tela lê', () => {
  it('GET da pausa, listagem, resumo e fila trazem modo, desde, até e quem ligou', async () => {
    const c = await club('estado');
    const open = await c.add('Aberta');
    const { paused } = (await c.svc.setVersionPause('p', { minutes: 30 }, false, as('gio-1')))!;
    expect(paused).toEqual({ at: expect.any(String), mode: 'version', until: expect.any(String), by: GIO });
    expect(await c.svc.pauseOf('p')).toEqual({ paused });
    expect((await c.get(open.id)).projectPaused).toEqual(paused);
    expect((await c.svc.summary()).p).toMatchObject({ open: 1, paused });
    const queues = (await c.svc.queueStates('p'))!;
    expect(queues.find((q) => q.staffId === 'ana-1')).toMatchObject({ state: 'paused', since: paused.at, detail: expect.stringMatching(/^pausa de versão até \d{2}:\d{2}$/) });
    await c.svc.endVersionPause('p', false, as('gio-1'));
    expect((await c.get(open.id)).projectPaused).toBeUndefined();
    expect((await c.svc.summary()).p!.paused).toBeUndefined();
  });

  it('a pausa comum não ganha campo nenhum e a fila dela não leva detalhe', async () => {
    const c = await club('estado-comum');
    const open = await c.add('Aberta');
    const { paused } = (await c.svc.setPaused('p', true, true))!;
    expect(Object.keys(paused!)).toEqual(['at']);
    expect((await c.get(open.id)).projectPaused).toEqual({ at: paused!.at });
    expect((await c.svc.queueStates('p'))!.find((q) => q.staffId === 'ana-1')).not.toHaveProperty('detail');
  });
});

describe('o resto do servidor segue barrado (um só lugar responde "pausado?")', () => {
  it('rotinas: a ocorrência é pulada com a pausa de versão ligada (e roda de novo quando ela sai)', async () => {
    const pauses = new ProjectPauses(path.join(root, 'rotinas-pausas.json'), quiet);
    const routine = { id: 'r1', name: 'Revisar', schedule: '0 9 * * *', message: 'Revise.', mode: 'continue' as const, enabled: true, catchUpHours: 6 };
    const calls: string[] = [];
    const s = new RoutineScheduler({
      file: path.join(root, 'rotinas-vp.json'),
      listStaff: async () => [{ id: 'ana-1', projectId: 'proj', name: 'Ana', sessions: [], routines: [routine] } as unknown as StaffProfile],
      run: async (p, _r, minute) => {
        calls.push(`${p.projectId}@${minute}`);
        return { ok: true, text: 'mandada' };
      },
      paused: (id) => pauses.isPaused(id),
      log: quiet,
    });
    await pauses.pauseVersion('proj', { minutes: 120, by: GIO });
    await s.tick(new Date(2026, 10, 21, 8));
    await s.tick(new Date(2026, 10, 21, 9, 0, 5));
    expect(calls).toEqual([]);
    expect((await s.snapshot('proj:ana-1:r1'))?.history[0]).toMatchObject({ state: 'discarded', text: expect.stringMatching(/projeto está pausado/) });
    await pauses.resume('proj');
    await s.tick(new Date(2026, 10, 21, 9, 30));
    expect(calls).toEqual([]); // a de 9h não volta
    await s.tick(new Date(2026, 10, 22, 9, 0, 5));
    expect(calls).toEqual(['proj@2026-11-22T09:00']);
  });

  it('as rotas: dono e funcionário (e a sandbox do Codex) alcançam as duas; a pausa comum segue só da tela; o index liga o serviço, a caixa e a dispensa', async () => {
    for (const p of ['/api/projects/p/version-pause', '/api/projects/p/version-pause/end']) {
      expect(staffMayPost(p)).toBe(true);
      expect(sandboxVerdict('POST', p, 'p')).toBeNull();
      expect(sandboxVerdict('POST', p, 'outro')).toMatchObject({ status: 403 }); // só o projeto da própria conversa
    }
    for (const p of ['/api/projects/p/pause', '/api/projects/p/resume', '/api/projects/p/version-pause/x', '/api/projects/p/version-pauses']) expect(staffMayPost(p)).toBe(false);
    const index = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    expect(index).toMatch(/\['POST', new RegExp\(`\^\/api\/projects\/\$\{ID\}\/version-pause\$`\), \(\{ params: \[id\], body, fromBrowser, caller \}\) => tasks\.setVersionPause\(id!, body, fromBrowser, caller\)\]/);
    expect(index).toMatch(/\['POST', new RegExp\(`\^\/api\/projects\/\$\{ID\}\/version-pause\/end\$`\), \(\{ params: \[id\], fromBrowser, caller \}\) => tasks\.endVersionPause\(id!, fromBrowser, caller\)\]/);
    expect(index).toMatch(/end\.reason === 'expired'\) tasks\.resumeAfterExpiry\(projectId\)/); // a saída por prazo liga a rodada do projeto
    expect(index).toMatch(/versionPauseItems\(await projectPauses\.notices\(\)/);
    expect(index).toMatch(/b\.id\.startsWith\('vpause:'\)\) return \{ ok: await dismissVersionPause\(b\.id\) \}/);
    // A pausa comum e a pergunta de todo ponto de partida seguem como eram.
    expect(index.match(/paused: projectPaused/g)).toHaveLength(5);
  });

  it('o aviso da caixa: ligada (quem e até quando) e a saída de cada motivo, kind routine (informativo), com id que a dispensa entende', () => {
    const name = (id: string) => (id === 'p' ? 'Projeto P' : id);
    const on = { at: T0.toISOString(), mode: 'version' as const, until: at(30).toISOString(), by: GIO };
    const items = versionPauseItems({ active: [{ projectId: 'p', pause: on }, { projectId: 'q', pause: { ...on, by: undefined } }], ended: [] }, name);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 'routine:vpause:p:on', kind: 'routine', projectId: 'p', projectName: 'Projeto P', staffId: null, sessionId: '', at: on.at });
    expect(items[0]!.summary).toMatch(/ligada por Giovana às \d{2}:\d{2}.*sai sozinha às \d{2}:\d{2} ou quando Giovana encerrar/);
    expect(items[1]!.summary).toMatch(/ligada por você.*ou quando você retomar o projeto/);

    const out = (reason: ProjectPauseEnd['reason'], endedBy?: typeof GIO) => versionPauseItems({ active: [], ended: [{ projectId: 'p', end: { at: at(30).toISOString(), reason, pause: on, ...(endedBy && { endedBy }) } }] }, name)[0]!;
    expect(out('expired').summary).toMatch(/saiu às \d{2}:\d{2}: o prazo acabou/);
    expect(out('ended', DEB).summary).toMatch(/encerrada por Débora/);
    expect(out('resumed').summary).toMatch(/você retomou o projeto/);
    expect(out('standard').summary).toMatch(/virou pausa comum.*sem prazo/);
    expect(out('expired')).toMatchObject({ kind: 'routine', id: `routine:vpause:p:end:${at(30).getTime()}` });
    expect(out('expired')).not.toHaveProperty('resolvedAt');
    // O id que a tela manda à rota (sem o prefixo `routine:`) volta ao projeto e ao instante da saída.
    expect(versionPauseEndId(`vpause:p:end:${at(30).getTime()}`)).toEqual({ projectId: 'p', atMs: at(30).getTime() });
    expect(versionPauseEndId('vpause:p:on')).toBeNull();
    expect(versionPauseEndId('vpause:p:end:abc')).toBeNull();
  });
});

describe('o serviço sem a pausa configurada', () => {
  it('liga e encerra respondem TaskError (400), depois do 403: o servidor sem `pauses` não finge', async () => {
    const dir = path.join(root, 'sem-pauses');
    await fs.mkdir(dir, { recursive: true });
    const svc = new TaskService({ projectPath: async () => dir, projectIds: async () => ['p'], readProfile: async (_p, id) => ({ ...RULES[id] }) as unknown as StaffProfile, send: async () => 'x', branchFor: async () => null });
    await expect(svc.setVersionPause('p', { minutes: 5 }, true, null)).rejects.toBeInstanceOf(TaskError);
    await expect(svc.setVersionPause('p', { minutes: 5 }, false, as('ana-1'))).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(svc.endVersionPause('p', true, null)).rejects.toBeInstanceOf(TaskError);
  });
});
