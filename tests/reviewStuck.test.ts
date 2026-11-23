import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { REVIEW_WAIT_MS } from '../server/retryPolicy';
import { TaskService, ownAlerts, stuckState } from '../server/tasks';
import type { StaffProfile, Task } from '../shared/model';
import { removeTemp } from './support/tmp';

// Card em revisão sem revisão aberta (t-2a8ee8): `stuckState` o marca como parada ('review', "Delegar revisão") passado o prazo, e o fim "conversa parou sem terminar" não o deixa em revisão
// sem ninguém olhar: com o que revisar abre a revisão automática; sem nada alterado vai para Aguardar, com o motivo, e quem pediu é avisado. Repositório git de verdade no segundo bloco.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-reviewstuck-'));
});
afterAll(() => removeTemp(root));

const MIN = 60_000;
const T0 = Date.parse('2026-11-18T12:31:00.000Z');
const at = (min: number) => new Date(T0 + min * MIN).toISOString();

/** Um card em "revisão" desde T0 (entrou por "turno terminou"), com revisor marcado e sem nenhuma revisão pedida. */
function card(patch: Partial<Task> = {}): Task {
  return {
    id: 't-aaaaaa',
    title: 'Tela',
    description: '',
    status: 'review',
    staffId: 'ana-1',
    reviewerId: 'rui-1',
    requestedBy: 'gio-1',
    sessionId: 'ana-1-1',
    sessions: [],
    plan: null,
    branch: null,
    pr: null,
    createdAt: at(-120),
    updatedAt: at(0),
    history: [
      { at: at(-120), status: 'todo', by: 'you' },
      { at: at(-100), status: 'doing', by: 'auto' },
      { at: at(0), status: 'review', by: 'auto', note: 'turno terminou' },
    ],
    delivery: { at: at(0), summary: 'feito' },
    ...patch,
  } as Task;
}
const review = (extra: Partial<NonNullable<Task['review']>> = {}) => ({ staffId: 'rui-1', sessionId: 'rui-1-1', at: at(1), ...extra }) as NonNullable<Task['review']>;
const now = (min: number) => T0 + min * MIN;

describe('revisão que nunca começou: parada no stuckState', () => {
  it('dentro do prazo não é parada; passado o prazo, é do dono, com o atalho "Delegar revisão" (humanAction review)', () => {
    const t = card();
    expect(stuckState(t, now(29))).toBeNull();
    expect(stuckState(t, now(REVIEW_WAIT_MS / MIN) - 1)).toBeNull();
    expect(stuckState(t, now(30))).toMatchObject({ humanAction: 'review', selfHeals: false, since: at(0), reason: expect.stringContaining('sem revisão aberta') });
    expect(stuckState(t, now(31))).toMatchObject({ humanAction: 'review', since: at(0) });
    // A caixa do dono lê pelo ownAlerts (kind 'stuck', com o atalho que já existe).
    expect(ownAlerts([t], now(29))).toEqual([]);
    expect(ownAlerts([t], now(31)).map((a) => [a.task.id, a.state.humanAction])).toEqual([['t-aaaaaa', 'review']]);
  });

  it('o prazo conta da ÚLTIMA entrada em revisão (as notas seguintes e uma rodada anterior não o movem)', () => {
    const t = card({
      history: [
        { at: at(-300), status: 'review', by: 'auto', note: 'turno terminou' },
        { at: at(-290), status: 'doing', by: 'auto', note: 'reprovada por Rui' },
        { at: at(0), status: 'review', by: 'auto', note: 'turno terminou' },
        { at: at(20), status: 'review', by: 'auto', note: 'uma nota qualquer' },
      ],
      updatedAt: at(20),
    });
    expect(stuckState(t, now(29))).toBeNull();
    expect(stuckState(t, now(31))).toMatchObject({ humanAction: 'review', since: at(0) });
  });

  it('com revisão em curso desta entrega, nada: nem muito depois', () => {
    expect(stuckState(card({ review: review() }), now(600))).toBeNull();
  });

  it('revisão que já respondeu (veredito) e espera o dono não é parada duplicada: aprovada ou reprovada', () => {
    expect(stuckState(card({ review: review({ doneAt: at(10), verdict: 'approved' }) }), now(600))).toBeNull();
    expect(stuckState(card({ review: review({ doneAt: at(10), verdict: 'rejected' }) }), now(600))).toBeNull();
  });

  it('com reviewRetry a regra é a da revisão que não começou (a nova não se soma a ela)', () => {
    const retry = { attempts: 1, nextAt: at(40), firstAt: at(5), deliveryAt: at(0) };
    expect(stuckState(card({ reviewRetry: retry }), now(31))).toBeNull(); // ainda tentando
    expect(stuckState(card({ reviewRetry: retry }), now(36))).toMatchObject({ reason: expect.stringContaining('não começou'), humanAction: 'review', since: at(5) });
  });

  it('sem revisor marcado o card fica com o dono por desenho: não é parada', () => {
    expect(stuckState(card({ reviewerId: null }), now(600))).toBeNull();
  });

  it('só em revisão: fazendo, Aguardar e pronta ficam como estão', () => {
    expect(stuckState(card({ status: 'doing' }), now(600))).toBeNull();
    expect(stuckState(card({ status: 'done' }), now(600))).toBeNull();
    expect(stuckState(card({ status: 'waiting', waitReason: 'x' }), now(600))).toMatchObject({ humanAction: 'decide' });
  });

  it('a revisão de entrega anterior (superseded, ou pedida antes da entrega de agora) não vale: a entrega nova está sem revisão', () => {
    expect(stuckState(card({ review: review({ superseded: true, doneAt: at(-50), verdict: 'rejected' }) }), now(31))).toMatchObject({ humanAction: 'review' });
    expect(stuckState(card({ review: review({ at: at(-60) }) }), now(31))).toMatchObject({ humanAction: 'review' });
  });

  it('o limite de revisões automáticas segue valendo à frente (decide, não review)', () => {
    const t = card({ reviewRounds: 3, review: review({ at: at(-60), doneAt: at(-50), verdict: 'rejected', superseded: true }) });
    expect(stuckState(t, now(31))).toMatchObject({ reason: 'limite de revisões automáticas atingido', humanAction: 'decide' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const PAST = '2020-01-01T00:00:00';
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: PAST, GIT_COMMITTER_DATE: PAST } }).toString();
const profile = (id: string, name: string, extra: Partial<StaffProfile> = {}) => ({ id, name, role: 'Back-end', autonomy: 'acceptEdits', worktree: false, reportsTo: [], ...extra }) as StaffProfile;

/** Gio pede a Ana (revisor: Rui). O commit-base é de 2020: o "código mexido depois do começo" só vale para o que o teste fizer. `repo: false` deixa a pasta fora do git. */
async function club(dirName: string, opts: { repo?: boolean } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  if (opts.repo !== false) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.autocrlf', 'false');
    await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = 1;\n');
    git(dir, 'add', 'a.ts');
    git(dir, 'commit', '-q', '-m', 'base');
  }
  const people: Record<string, StaffProfile> = {
    'gio-1': profile('gio-1', 'Gio', { role: 'Orquestrador' }),
    'ana-1': profile('ana-1', 'Ana', { reportsTo: ['gio-1'] }),
    'rui-1': profile('rui-1', 'Rui', { role: 'Revisor' }),
  };
  const h = { sent: [] as Array<{ staffId: string; text: string; session: string }>, notified: [] as Array<{ staffId: string; text: string; sessionId: string | null | undefined }>, hidden: new Set<string>(), n: 0 };
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => (h.hidden.has(id) ? null : (people[id] ?? null)),
    send: async (_p, staffId, text) => {
      const session = `${staffId}-${++h.n}`;
      h.sent.push({ staffId, text, session });
      return session;
    },
    branchFor: async () => null,
    isWorking: () => false,
    sendTo: async (_p, sessionId) => sessionId,
    notify: async (_p, staffId, text, sessionId) => {
      h.notified.push({ staffId, text, sessionId });
    },
    apiUrl: 'http://127.0.0.1:4848',
    sandboxApiUrl: 'http://127.0.0.2:4848',
    lastText: () => null,
    log: () => {},
  });
  const get = async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)!;
  /** O card de Ana, pedido por Gio, com Rui de revisor, já começado e com a conversa de trabalho parada (ninguém trabalha). */
  const begin = async () => {
    const t = (await svc.create('p', { title: 'Exportar CSV', description: 'Faça a exportação', staffId: 'ana-1', reviewerId: 'rui-1' }, 'gio-1', 'gio-s'))!;
    await svc.start('p', t.id);
    return { id: t.id, work: (await get(t.id)).sessionId! };
  };
  const edit = (work: string) => svc.onCodeEdit({ sessionId: work, projectId: 'p', staffId: 'ana-1', engine: 'claude', cwd: dir, files: [path.join(dir, 'a.ts')], request: null });
  const later = (min: number) => new Date(Date.now() + min * MIN);
  const toReviewer = () => h.sent.filter((s) => s.staffId === 'rui-1');
  return { dir, h, svc, get, begin, edit, later, toReviewer };
}

describe('"conversa parou sem terminar": não deixa o card em revisão sem revisão', () => {
  it('com mudança: vai para revisão E a revisão automática abre (como numa entrega), e não fica parada', async () => {
    const b = await club('orfa-com-mudanca');
    const { id, work } = await b.begin();
    await b.edit(work);
    expect((await b.get(id)).changedFiles).toEqual(['a.ts']);
    await b.svc.tick(b.later(3)); // retoma
    await b.svc.tick(b.later(6)); // parou de novo
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.history.at(-1)?.note).toBe('conversa parou sem terminar');
    expect(t.review).toMatchObject({ staffId: 'rui-1' });
    expect(t.reviewRounds).toBe(1);
    expect(b.toReviewer()).toHaveLength(1);
    expect(b.toReviewer()[0]!.text).toContain('Exportar CSV');
    expect(stuckState(t, Date.now() + 600 * MIN)).toBeNull();
    // O aviso a quem pediu segue (a entrega pode estar incompleta).
    expect(b.h.notified.some((n) => n.staffId === 'gio-1' && n.text.includes('parou duas vezes sem terminar'))).toBe(true);
    // Nem o tick seguinte pede outra revisão.
    await b.svc.tick(b.later(20));
    expect(b.toReviewer()).toHaveLength(1);
  });

  it('sem nada alterado (provado no git): vai para Aguardar com o motivo, não abre revisão e avisa quem pediu na conversa em que pediu', async () => {
    const b = await club('orfa-sem-mudanca');
    const { id } = await b.begin();
    await b.svc.tick(b.later(3));
    await b.svc.tick(b.later(6));
    const t = await b.get(id);
    expect(t.status).toBe('waiting');
    expect(t.waitReason).toBe('a conversa parou sem terminar e nada foi alterado: não há o que revisar');
    expect(t.history.map((h) => h.status)).not.toContain('review');
    expect(t.review).toBeUndefined();
    expect(b.toReviewer()).toHaveLength(0);
    expect(stuckState(t)).toMatchObject({ humanAction: 'decide', reason: expect.stringContaining('não há o que revisar') });
    const told = b.h.notified.filter((n) => n.staffId === 'gio-1');
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ sessionId: 'gio-s', text: expect.stringContaining('não há o que revisar') });
    expect(told[0]!.text).toContain(id);
    await b.svc.tick(b.later(30)); // Aguardar não vira revisão sozinho nem avisa de novo
    expect((await b.get(id)).status).toBe('waiting');
    expect(b.h.notified.filter((n) => n.staffId === 'gio-1')).toHaveLength(1);
  });

  it('sem como provar que nada mudou (fora do git): o conservador é revisar', async () => {
    const b = await club('orfa-sem-git', { repo: false });
    const { id } = await b.begin();
    await b.svc.tick(b.later(3));
    await b.svc.tick(b.later(6));
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.review).toMatchObject({ staffId: 'rui-1' });
    expect(b.toReviewer()).toHaveLength(1);
  });

  it('código mexido sem passar pelas ferramentas de edição (shell) também conta como o que revisar', async () => {
    const b = await club('orfa-shell');
    const { id } = await b.begin();
    await new Promise((r) => setTimeout(r, 1100)); // o arquivo precisa ser mais novo que o começo da tarefa (mtime e commit contam em segundos)
    await fs.writeFile(path.join(b.dir, 'novo.ts'), 'export const n = 1;\n');
    await b.svc.tick(b.later(3));
    await b.svc.tick(b.later(6));
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.review).toMatchObject({ staffId: 'rui-1' });
  });

  it('a revisão automática sai da vez do funcionário: a falha dela não derruba a órfã e vira o retry de sempre', async () => {
    const b = await club('orfa-falha');
    const { id, work } = await b.begin();
    await b.edit(work);
    // Quem revisa some da equipe: o pedido não passa (erro de ficha), e o card fica com o motivo na caixa.
    b.h.hidden.add('rui-1');
    await b.svc.tick(b.later(3));
    await b.svc.tick(b.later(6));
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.reviewRetry).toMatchObject({ expired: true });
    expect(stuckState(t)).toMatchObject({ humanAction: 'review', reason: expect.stringContaining('não começou') });
  });
});
