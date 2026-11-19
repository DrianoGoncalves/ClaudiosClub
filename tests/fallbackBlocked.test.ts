import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CapabilityError } from '../server/engineCapability';
import { stuckInboxItem } from '../server/inboxItems';
import type { LimitHit } from '../server/chat/usageLimit';
import { ownAlerts, stuckState, TaskService } from '../server/tasks';
import type { StaffProfile, Task } from '../shared/model';

// A troca para o secundário que não serve agora (`fallbackBlocked`): a tarefa espera o limite do motor da ficha baixar, em vez de cair
// no secundário. Começo (`startPlan`), meio do turno (`onLimit`), a parada que ela mostra (`stuckState`, `ownAlerts`) e o id do aviso.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-fallbackblocked-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const NOW = Date.now();
const MIN = 60_000;
const hit = (minutes: number): LimitHit => ({ resetsAt: NOW + minutes * MIN, window: 'five_hour' });
const withFallback: Pick<StaffProfile, 'fallback'> = { fallback: { engine: 'codex', model: 'gpt-5' } };
const SANDBOX = 'outra conversa do Codex está rodando agora; no Windows duas ao mesmo tempo derrubam a sandbox uma da outra';

interface Opts {
  /** Limite de cada motor agora (ms de reset, ou null = sem limite). Mutável: o teste baixa o limite no meio. */
  limits: Partial<Record<'claude' | 'codex', LimitHit | null>>;
  /** O que a pré-checagem da troca lança (mutável). Sem ele, a troca abre. */
  assertError?: Error;
  /** Há "continue" pendente, e o limite do motor chega no meio do turno. */
  sessionId?: string;
}

/** Projeto com a tarefa já gravada e os fakes do TaskService. `exceptions` guarda o 4º argumento de cada pré-checagem. */
async function project(dirName: string, tasks: Array<Partial<Task> & { id: string }>, opts: Opts) {
  const dir = path.join(root, dirName);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const now = new Date().toISOString();
  const full = tasks.map((t) => ({ title: t.id, description: '', status: 'todo', staffId: 'ana-1', sessionId: null, plan: null, branch: null, pr: null, createdAt: now, updatedAt: now, history: [], ...t }));
  await fs.writeFile(path.join(dir, '.myco', 'tasks.json'), JSON.stringify(full));
  const ana = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false, ...withFallback } as StaffProfile;
  const sent: unknown[][] = [];
  const exceptions: Array<string | undefined> = [];
  const svc = new TaskService({
    projectPath: async (id) => (id === 'p' ? dir : null),
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
    apiUrl: 'http://127.0.0.1:4848',
    send: async (...args: unknown[]) => {
      sent.push(args);
      return 'sess-novo';
    },
    branchFor: async () => 'main',
    readLimit: async (engine) => opts.limits[engine] ?? null,
    settleLimit: async () => {},
    awaitingLimit: async () => false,
    assertRunnable: async (_p, _s, override, exceptSession) => {
      exceptions.push(exceptSession);
      if (opts.assertError) throw opts.assertError;
    },
    cancelContinue: async () => null,
    stopSession: () => {},
    setOverride: () => {},
    clearOverride: () => {},
  });
  return { svc, dir, sent, exceptions };
}

const note = (t: Task) => t.history.map((h) => h.note ?? '');

describe('pré-checagem que falha no começo: a tarefa espera, não cai no secundário', () => {
  it('sandbox do Codex: fica na fila com a nota e com fallbackBlocked (reason sandbox, until = resetsAt)', async () => {
    const opts: Opts = { limits: { claude: hit(120) }, assertError: new CapabilityError('sandbox', SANDBOX) };
    const { svc, sent } = await project('bloq-sandbox', [{ id: 'ini' }], opts);
    const t = (await svc.start('p', 'ini'))!;
    expect(sent).toHaveLength(0);
    expect(t).toMatchObject({ status: 'todo', sessionId: null });
    expect(t.fallback).toBeUndefined();
    expect(t.queuedAt).toBeTruthy();
    expect(t.history.at(-1)!.note).toMatch(/não começou: Claude está no limite até .*a troca para Codex não abre \(outra conversa do Codex/);
    expect(t.fallbackBlocked).toMatchObject({ reason: 'sandbox', detail: SANDBOX, engine: 'codex', from: 'claude', until: new Date(NOW + 120 * MIN).toISOString() });
  });

  it('erro genérico na pré-checagem: reason other', async () => {
    const { svc } = await project('bloq-outro', [{ id: 'ini' }], { limits: { claude: hit(120) }, assertError: new Error('o Codex está desligado') });
    const t = (await svc.start('p', 'ini'))!;
    expect(t.fallbackBlocked).toMatchObject({ reason: 'other', detail: 'o Codex está desligado', engine: 'codex', from: 'claude' });
  });

  it('o tick seguinte com a mesma falha: since preservado e sem nota repetida', async () => {
    const { svc } = await project('bloq-tick', [{ id: 'ini' }], { limits: { claude: hit(120) }, assertError: new CapabilityError('sandbox', SANDBOX) });
    const primeiro = (await svc.start('p', 'ini'))!;
    await svc.tick();
    const [depois1] = (await svc.list('p'))!;
    await svc.tick();
    const [depois] = (await svc.list('p'))!;
    expect(depois!.fallbackBlocked!.since).toBe(primeiro.fallbackBlocked!.since);
    // Os ticks seguintes não acrescentam nota (a do tick já está no histórico).
    expect(note(depois!)).toEqual(note(depois1!));
  });

  it('o limite baixou: começa no motor da ficha, sem troca, e fallbackBlocked some', async () => {
    const opts: Opts = { limits: { claude: hit(120) }, assertError: new CapabilityError('sandbox', SANDBOX) };
    const { svc, sent, dir } = await project('bloq-baixou', [{ id: 'ini' }], opts);
    await svc.start('p', 'ini');
    expect((await svc.list('p'))![0]!.fallbackBlocked).toBeDefined();
    // O limite baixa: a tarefa segue a fila no motor da ficha (Claude), sem o override do secundário.
    opts.limits = { claude: null };
    opts.assertError = undefined;
    await svc.tick();
    const [t] = (await svc.list('p'))!;
    expect(t).toMatchObject({ status: 'doing', sessionId: 'sess-novo' });
    expect(t!.fallbackBlocked).toBeUndefined();
    expect(sent.at(-1)![4]).toBeUndefined();
  });
});

describe('limite no meio do turno com a troca que não serve (onLimit)', () => {
  it('CapabilityError de agents: nota "segue como antes", fallbackBlocked (reason agents), e a pré-checagem recebe a própria conversa como exceção', async () => {
    const { svc, sent, exceptions } = await project(
      'bloq-meio',
      [{ id: 'meio', status: 'doing', sessionId: 'sess-velha' }],
      { limits: { claude: hit(120) }, assertError: new CapabilityError('agents', 'o Codex não tem os agents da ficha: gil') },
    );
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    expect(sent).toHaveLength(0);
    expect(exceptions).toEqual(['sess-velha']);
    const [t] = (await svc.list('p'))!;
    expect(t).toMatchObject({ status: 'doing', sessionId: 'sess-velha', fallbackBlocked: { reason: 'agents', engine: 'codex', from: 'claude' } });
    expect(t!.history.at(-1)!.note).toMatch(/segue como antes/);
  });
});

// Tarefas montadas direto, para a regra única de "parado" (ver `stuckState`).
describe('a parada que a espera mostra (stuckState, ownAlerts, caixa)', () => {
  const at = '2026-11-17T10:00:00.000Z';
  const now = Date.parse(at);
  const mk = (over: Partial<Task> = {}): Task => ({
    id: 't-1', title: 'Tarefa', description: '', status: 'todo', staffId: 'ana-1', sessionId: null, plan: null, branch: null, pr: null, createdAt: at, updatedAt: at, history: [], ...over,
  });
  const espera = (until: string | null): NonNullable<Task['fallbackBlocked']> => ({
    reason: 'sandbox', detail: SANDBOX, engine: 'codex', from: 'claude', since: at, until,
  });
  const later = new Date(now + 60 * MIN).toISOString();

  it('com o limite vigente: selfHeals, sem ação sua, com o motivo', () => {
    const t = mk({ fallbackBlocked: espera(later) });
    expect(stuckState(t, now)).toEqual({
      reason: `espera o limite do Claude baixar: a troca para o Codex não serve agora (sandbox indisponível: ${SANDBOX})`,
      selfHeals: true,
      humanAction: null,
      since: at,
    });
    expect(ownAlerts([t], now)).toEqual([expect.objectContaining({ task: t, state: expect.objectContaining({ humanAction: null, selfHeals: true }) })]);
  });

  it('depois de until, não aparece; sem until (null), aparece até a partida limpar', () => {
    const passou = mk({ fallbackBlocked: espera(new Date(now - MIN).toISOString()) });
    expect(stuckState(passou, now)).toBeNull();
    expect(ownAlerts([passou], now)).toEqual([]);
    expect(stuckState(mk({ fallbackBlocked: espera(null) }), now)).toMatchObject({ selfHeals: true, humanAction: null });
  });

  it('a dúvida escalada continua vencendo a espera', () => {
    const t = mk({
      status: 'doing',
      sessionId: 's',
      fallbackBlocked: espera(later),
      question: { id: 'q', source: 'text', text: 'DÚVIDA: a?', status: 'escalated', askedAt: at, escalatedAt: at },
    });
    expect(stuckState(t, now)).toMatchObject({ humanAction: 'answer', selfHeals: false });
    expect(ownAlerts([t], now)).toEqual([expect.objectContaining({ state: expect.objectContaining({ humanAction: 'answer' }) })]);
  });

  it('o aviso da caixa com humanAction null tem o id stuck:<tarefa>:fallback', () => {
    const t = mk({ fallbackBlocked: espera(later) });
    const [alert] = ownAlerts([t], now);
    const item = stuckInboxItem(alert!, { projectId: 'p', projectName: 'P', sessionId: '', staffId: 'ana-1', name: 'Ana' });
    expect(item).toMatchObject({ id: 'stuck:t-1:fallback', kind: 'stuck', stuck: { humanAction: null, selfHeals: true } });
  });
});
