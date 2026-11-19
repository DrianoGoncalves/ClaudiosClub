import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot, Engine, EngineOverride, HeldMessage, StaffProfile, Task, UsageStopHit } from '../shared/model';
import { RESUME_TEXT } from '../server/chat/items';
import { ChatClosingError } from '../server/chat/manager';
import { ResumeFile, resumeAfterRestart } from '../server/chat/resume';
import type { LimitHit } from '../server/chat/usageLimit';
import { buildHandoff } from '../server/fallbackHandoff';
import { TaskService } from '../server/tasks';
import { parsePrimaryNote } from '../client/src/tasks/primaryReturn';

// Volta ao motor principal: a tarefa que trocou de motor por limite (`Task.fallback`) retoma, com o principal liberado, numa conversa NOVA nele,
// com o handoff da antiga. Cobre os pontos de retomada (ajuste guardado, fila, resposta de dúvida, reprovação do revisor, órfã, resume do reinício),
// os dois sentidos, o principal ainda no limite, o boot e a ausência de laço de trocas.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-primaryreturn-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const NOW = Date.now();
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const hit = (minutes: number): LimitHit => ({ resetsAt: NOW + minutes * MIN, window: 'five_hour' });
const otherOf = (e: Engine): Engine => (e === 'claude' ? 'codex' : 'claude');
const LABEL: Record<Engine, string> = { claude: 'Claude', codex: 'Codex' };

interface Opts {
  /** O motor da ficha (o principal). O secundário é o outro. */
  engine?: Engine;
  autonomy?: StaffProfile['autonomy'];
  /** Limite agora de cada motor (padrão: sem limite). Mutável: o teste muda no meio. */
  limits?: Partial<Record<Engine, LimitHit | null | 'unknown'>>;
  /** Linha de parada da empresa por motor (padrão: nenhuma). */
  stop?: Partial<Record<Engine, UsageStopHit>>;
  /** A conversa de trabalho está num turno agora. */
  working?: boolean;
  /** A última resposta de cada conversa (o que o revisor disse): sessão → texto. */
  said?: Record<string, string>;
  /** Erro do envio de conversa nova (recebe o override, se houver). */
  sendError?: (override: EngineOverride | undefined) => Error | undefined;
}

const request = { kind: 'user', id: 'u1', text: 'faz o botão de exportar', at: iso(NOW) };

/** Projeto com tarefas gravadas e os fakes do TaskService. As tarefas nascem no secundário, trocadas há 30 min (`fallback` + `sessions`). */
async function club(name: string, tasks: Array<Partial<Task> & { id: string }>, opts: Opts = {}) {
  const primary = opts.engine ?? 'claude';
  const secondary = otherOf(primary);
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const at = iso(NOW - 30 * MIN);
  const full = tasks.map((t) => ({
    title: t.id,
    description: 'exportar em CSV',
    status: 'waiting',
    staffId: 'ana-1',
    sessionId: 'sess-sec',
    plan: null,
    branch: null,
    pr: null,
    createdAt: at,
    updatedAt: at,
    history: [],
    fallback: { engine: secondary, model: 'modelo-sec', from: primary, at: NOW - 30 * MIN, fromSession: 'sess-velha', reason: 'limit-mid' },
    sessions: [{ id: 'sess-sec', role: 'work', staffId: 'ana-1', engine: secondary, at }],
    ...t,
  }));
  const file = path.join(dir, '.myco', 'tasks.json');
  await fs.writeFile(file, JSON.stringify(full));
  const ana = { id: 'ana-1', name: 'Ana', autonomy: opts.autonomy ?? 'acceptEdits', worktree: false, engine: primary, model: 'modelo-pri', fallback: { engine: secondary, model: 'modelo-sec' } } as unknown as StaffProfile;
  const rui = { id: 'rui-1', name: 'Rui', autonomy: 'acceptEdits', worktree: false } as unknown as StaffProfile;
  const limits = opts.limits ?? {};
  const sent: unknown[][] = []; // conversa nova (deps.send)
  const sentTo: unknown[][] = []; // conversa que já existe (deps.sendTo)
  const overrides: Array<[string, unknown]> = [];
  const cleared: string[] = [];
  const stopped: string[] = [];
  const cancelled: string[] = [];
  let n = 0;
  const svc = new TaskService({
    projectPath: async (id) => (id === 'p' ? dir : null),
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => (id === 'ana-1' ? ana : id === 'rui-1' ? rui : null),
    lastText: (sid) => opts.said?.[sid] ?? null,
    apiUrl: 'http://127.0.0.1:4848',
    send: async (...args: unknown[]) => {
      sent.push(args);
      const err = opts.sendError?.(args[4] as EngineOverride | undefined);
      if (err) throw err;
      return `sess-novo-${++n}`;
    },
    sendTo: async (...args: unknown[]) => {
      sentTo.push(args);
      return String(args[1]);
    },
    branchFor: async () => 'main',
    setOverride: (sid, override) => overrides.push([sid, override]),
    clearOverride: (sid) => cleared.push(sid),
    stopSession: (sid) => stopped.push(sid),
    cancelContinue: async (sid) => {
      cancelled.push(sid);
      return null;
    },
    settleLimit: async () => {},
    assertRunnable: async () => {},
    readLimit: async (engine) => limits[engine] ?? null,
    stopHit: async (_p, _s, engine) => opts.stop?.[engine] ?? null,
    isSessionWorking: () => opts.working ?? false,
    isWorking: () => false,
    snapshot: async (_p, sid) => ({ sessionId: sid, history: [request, { kind: 'user', id: 'u2', text: 'use CSV, não XLSX', at: iso(NOW) }, { kind: 'assistant', id: 'a1', text: 'parei no exportador', at: iso(NOW) }], live: null }) as unknown as ChatSnapshot,
  });
  const list = async () => (await svc.list('p'))!;
  const task = async (id = tasks[0]!.id) => (await list()).find((t) => t.id === id)!;
  const hold = async (id: string, text: string, extra: Partial<HeldMessage> = {}) => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Task[];
    const held: HeldMessage = { id: `h-${Math.random().toString(16).slice(2, 8)}`, at: iso(NOW), text, reason: 'espera', ...extra };
    await fs.writeFile(file, JSON.stringify(all.map((t) => (t.id === id ? { ...t, held: [...(t.held ?? []), held] } : t))));
  };
  return { svc, sent, sentTo, overrides, cleared, stopped, cancelled, list, task, hold, limits, primary, secondary };
}

const NOTE = (e: Engine) => `motor principal liberado: voltou ao ${LABEL[e]} em conversa nova, com o resumo da anterior`;
/** As notas de volta que o servidor gravou, lidas como a tela as lê: se ele mudar o texto, a tela perde o selo, e o `toEqual` daqui quebra. */
const primaryNotes = (t: Task) => t.history.map((h) => parsePrimaryNote(h.note)).filter((n) => n !== null);
const held = (text: string): HeldMessage => ({ id: 'h1', at: iso(NOW), text, reason: 'espera' });

describe('volta ao motor principal: ajuste guardado (fila do funcionário)', () => {
  for (const engine of ['claude', 'codex'] as const) {
    it(`${LABEL[engine]} é o principal e o secundário é o ${LABEL[otherOf(engine)]}: com o principal liberado, o ajuste vai numa conversa nova nele`, async () => {
      const c = await club(`ajuste-${engine}`, [{ id: 't', held: [held('mude o nome do arquivo')] }], { engine });
      await c.svc.kickStaff('p', 'ana-1');
      // A conversa nova no principal: sem override (é o motor da ficha), com o handoff e o ajuste no fim.
      expect(c.sent).toHaveLength(1);
      const args = c.sent[0]!;
      expect(args).toHaveLength(4);
      expect(args[3]).toBe(false);
      const text = String(args[2]);
      expect(text).toContain('Você é o substituto desta tarefa');
      expect(text).toContain(`O trabalho volta para o motor ${LABEL[engine]}, em conversa nova (modelo modelo-pri)`);
      expect(text).toContain(`rodava no motor ${LABEL[otherOf(engine)]} (o secundário da ficha)`);
      expect(text).toContain('exportar em CSV');
      expect(text).toContain('use CSV, não XLSX');
      expect(text).toContain('parei no exportador');
      expect(text).toContain('Estado do código (git)');
      expect(text.endsWith('## Retomada: o que chegou agora\n\nmude o nome do arquivo')).toBe(true);
      // O ajuste NÃO foi também para a conversa antiga.
      expect(c.sentTo).toHaveLength(0);
      // A tarefa: conversa nova, sem troca, a conversa em `sessions` com o motor certo e a nota no histórico.
      const t = await c.task();
      expect(t.sessionId).toBe('sess-novo-1');
      expect(t.fallback).toBeUndefined();
      expect(t.fallbackBlocked).toBeUndefined();
      expect(t.sessions).toContainEqual(expect.objectContaining({ id: 'sess-novo-1', role: 'work', staffId: 'ana-1', engine }));
      expect(t.sessions).toContainEqual(expect.objectContaining({ id: 'sess-sec', engine: otherOf(engine) }));
      expect(t.history.map((h) => h.note)).toContain(NOTE(engine));
      expect(primaryNotes(t)).toEqual([{ kind: 'back', engine }]);
      expect(t.held).toEqual([]);
      expect(t.status).toBe('doing');
      // A antiga: sem "continue", sem override, parada.
      expect(c.cancelled).toEqual(['sess-sec']);
      expect(c.cleared).toEqual(['sess-sec']);
      expect(c.stopped).toEqual(['sess-sec']);
    });
  }

  it('principal ainda no limite: o ajuste vai para a conversa do secundário, e nada muda na tarefa', async () => {
    const c = await club('ajuste-limite', [{ id: 't', held: [held('mude o nome do arquivo')] }], { limits: { claude: hit(120) } });
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.sent).toHaveLength(0);
    expect(c.sentTo).toHaveLength(1);
    expect(c.sentTo[0]![1]).toBe('sess-sec');
    const t = await c.task();
    expect(t.sessionId).toBe('sess-sec');
    expect(t.fallback).toMatchObject({ engine: 'codex', fromSession: 'sess-velha' });
    expect(t.history.map((h) => h.note).join('|')).not.toContain('motor principal liberado');
  });

  it('a linha de parada da empresa conta como limite do principal (mesma régua da troca)', async () => {
    const stop: UsageStopHit = { kind: 'five_hour', percentUsed: 96, limit: 95, resetsAt: iso(NOW + 120 * MIN) };
    const c = await club('ajuste-parada', [{ id: 't', held: [held('x')] }], { stop: { claude: stop } });
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.sent).toHaveLength(0);
    expect(c.sentTo).toHaveLength(1);
  });

  it('sem leitura do limite do principal: não se sabe, fica no secundário (a ida também não troca às cegas)', async () => {
    const c = await club('ajuste-unknown', [{ id: 't', held: [held('x')] }], { limits: { claude: 'unknown' } });
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.sent).toHaveLength(0);
    expect(c.sentTo).toHaveLength(1);
  });

  it('a conversa está num turno: nunca se troca no meio dele', async () => {
    const c = await club('ajuste-turno', [{ id: 't', status: 'doing', held: [held('x')] }], { working: true });
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.sent).toHaveLength(0);
    expect(c.sentTo).toHaveLength(1);
    expect((await c.task()).sessionId).toBe('sess-sec');
  });

  it('a troca para o secundário ainda em curso (a conversa é a antiga): não volta', async () => {
    const c = await club('ajuste-em-curso', [{ id: 't', held: [held('x')], fallback: { engine: 'codex', model: 'm', from: 'claude', at: NOW, fromSession: 'sess-sec', reason: 'limit-mid' } }]);
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.sent).toHaveLength(0);
  });

  it('ajuste com print ou com carimbo de outro funcionário não vai pela conversa nova (abre só com texto): espera a próxima retomada', async () => {
    const c = await club('ajuste-print', [{ id: 't', held: [{ ...held('olhe isto'), images: ['data:image/png;base64,AAAA'] }] }]);
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.sent).toHaveLength(0);
    expect(c.sentTo).toHaveLength(1);
    const d = await club('ajuste-origem', [{ id: 't', held: [{ ...held('do gestor'), origin: 'Gil (Gerente)' }] }]);
    await d.svc.kickStaff('p', 'ana-1');
    expect(d.sent).toHaveLength(0);
    expect(d.sentTo).toHaveLength(1);
  });

  it('ficha de plano fora de "planejando" (o plano já foi aprovado): fica, porque a conversa nova abriria em modo plano', async () => {
    const c = await club('ajuste-plano', [{ id: 't', held: [held('x')] }], { autonomy: 'plan' });
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.sent).toHaveLength(0);
    expect(c.sentTo).toHaveLength(1);
  });

  it('tarefa sem troca: nada muda (nenhuma leitura de limite, o ajuste vai à conversa de sempre)', async () => {
    let reads = 0;
    const c = await club('ajuste-sem-troca', [{ id: 't', fallback: undefined, sessions: undefined, held: [held('x')] }]);
    const svc = new TaskService({
      projectPath: async () => path.join(root, 'ajuste-sem-troca'),
      projectIds: async () => ['p'],
      readProfile: async () => ({ id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as unknown as StaffProfile),
      send: async () => 'x',
      sendTo: async (...args: unknown[]) => String(c.sentTo.push(args)),
      branchFor: async () => 'main',
      readLimit: async () => {
        reads++;
        return null;
      },
    });
    await svc.kickStaff('p', 'ana-1');
    expect(reads).toBe(0);
    expect(c.sentTo).toHaveLength(1);
  });

  it('a conversa nova não abre (erro do motor): o ajuste segue na antiga e o histórico diz por quê, uma vez só', async () => {
    const c = await club('ajuste-falha', [{ id: 't', held: [held('a')] }], { sendError: () => new Error('motor indisponível') });
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.sent).toHaveLength(1);
    expect(c.sentTo).toHaveLength(1);
    expect(c.sentTo[0]![1]).toBe('sess-sec');
    const t = await c.task();
    expect(t.sessionId).toBe('sess-sec');
    expect(t.fallback).toBeDefined();
    expect(t.history.map((h) => h.note).some((n) => n?.includes('a conversa nova no Claude não abriu (motor indisponível); segue na conversa do secundário'))).toBe(true);
    expect(primaryNotes(t)).toEqual([{ kind: 'failed', engine: 'claude', reason: 'motor indisponível' }]);
    expect(c.cleared).toEqual([]);
    expect(c.stopped).toEqual([]);
  });

  it('servidor reiniciando (ChatClosingError): segue para a antiga sem nota de falha do principal', async () => {
    const c = await club('ajuste-fechando', [{ id: 't', held: [held('a')] }], { sendError: () => new ChatClosingError() });
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.sentTo).toHaveLength(1);
    expect((await c.task()).history.map((h) => h.note).join('|')).not.toContain('não abriu');
  });
});

describe('volta ao motor principal: retomada da fila, resposta de dúvida e órfã', () => {
  it('"a fazer" com conversa no secundário: a vez dele retoma numa conversa nova no principal, mesmo com a linha de parada do secundário passada', async () => {
    const stop: UsageStopHit = { kind: 'five_hour', percentUsed: 96, limit: 95, resetsAt: iso(NOW + 120 * MIN) };
    const c = await club('fila', [{ id: 't', status: 'todo', queuedAt: iso(NOW - MIN) }], { stop: { codex: stop } });
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.sent).toHaveLength(1);
    expect(String(c.sent[0]![2])).toContain('A tarefa voltou para "A fazer" e chegou a sua vez');
    expect(c.sentTo).toHaveLength(0);
    const t = await c.task();
    expect(t).toMatchObject({ status: 'doing', sessionId: 'sess-novo-1', queuedAt: null });
    expect(t.fallback).toBeUndefined();
    expect(t.history.map((h) => h.note)).toContain(NOTE('claude'));
    expect(t.history.at(-1)!.note).toMatch(/retomada na fila, em conversa nova no motor principal/);
    expect(primaryNotes(t)).toEqual([{ kind: 'back', engine: 'claude' }, { kind: 'queue', who: 'Ana', acked: false }]);
  });

  it('"a fazer" que você levou para a fila pela tela (`cutAck`): a nota leva o aviso da ciência, e a tela lê o nome sem ele', async () => {
    const c = await club('fila-ack', [{ id: 't', status: 'todo', queuedAt: iso(NOW - MIN), cutAck: true }]);
    await c.svc.kickStaff('p', 'ana-1');
    const t = await c.task();
    expect(t.history.at(-1)!.note).toMatch(/com Ana; você tinha confirmado a retomada, sem a checagem de ação cortada$/);
    expect(primaryNotes(t)).toEqual([{ kind: 'back', engine: 'claude' }, { kind: 'queue', who: 'Ana', acked: true }]);
  });

  it('"a fazer": principal no limite, fica na conversa do secundário (retomada de sempre)', async () => {
    const c = await club('fila-limite', [{ id: 't', status: 'todo', queuedAt: iso(NOW - MIN) }], { limits: { claude: hit(120) } });
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.sent).toHaveLength(0);
    expect(c.sentTo).toHaveLength(1);
    expect(c.sentTo[0]![1]).toBe('sess-sec');
    expect(await c.task()).toMatchObject({ status: 'doing', sessionId: 'sess-sec' });
  });

  it('"a fazer": a conversa nova não abriu: retoma a antiga, com a trava de consumo do secundário', async () => {
    const stop: UsageStopHit = { kind: 'five_hour', percentUsed: 96, limit: 95, resetsAt: iso(NOW + 120 * MIN) };
    const c = await club('fila-falha', [{ id: 't', status: 'todo', queuedAt: iso(NOW - MIN) }], { sendError: () => new Error('motor indisponível'), stop: { codex: stop } });
    await c.svc.kickStaff('p', 'ana-1');
    // A antiga está barrada pela linha de parada do Codex: espera na fila (não manda).
    expect(c.sentTo).toHaveLength(0);
    expect((await c.task()).status).toBe('todo');
    const livre = await club('fila-falha-livre', [{ id: 't', status: 'todo', queuedAt: iso(NOW - MIN) }], { sendError: () => new Error('motor indisponível') });
    await livre.svc.kickStaff('p', 'ana-1');
    expect(livre.sentTo).toHaveLength(1);
    expect((await livre.task()).sessionId).toBe('sess-sec');
  });

  it('resposta de dúvida (texto): a conversa nova no principal leva a resposta', async () => {
    const question = { id: 'q-1', source: 'text', text: 'posso apagar a coluna?', status: 'open', askedAt: iso(NOW - MIN) };
    const c = await club('duvida', [{ id: 't', status: 'doing', question: question as Task['question'] }]);
    await c.svc.answerQuestion('p', 't', null, { questionId: 'q-1', text: 'pode, sim' }, true);
    expect(c.sent).toHaveLength(1);
    expect(String(c.sent[0]![2]).endsWith('Resposta do usuário à sua dúvida: pode, sim')).toBe(true);
    expect(c.sentTo).toHaveLength(0);
    const t = await c.task();
    expect(t.sessionId).toBe('sess-novo-1');
    expect(t.fallback).toBeUndefined();
    expect(t.question?.status).toBe('answered');
  });

  it('resposta de dúvida com o principal no limite: vai para a conversa do secundário', async () => {
    const question = { id: 'q-1', source: 'text', text: 'posso apagar a coluna?', status: 'open', askedAt: iso(NOW - MIN) };
    const c = await club('duvida-limite', [{ id: 't', status: 'doing', question: question as Task['question'] }], { limits: { claude: hit(120) } });
    await c.svc.answerQuestion('p', 't', null, { questionId: 'q-1', text: 'pode, sim' }, true);
    expect(c.sent).toHaveLength(0);
    expect(c.sentTo[0]![1]).toBe('sess-sec');
  });

  it('órfã (a conversa parou no meio do turno): a retomada vai numa conversa nova no principal', async () => {
    const c = await club('orfa', [{ id: 't', status: 'doing', updatedAt: iso(NOW - 10 * MIN) }]);
    await c.svc.tick(new Date(NOW));
    expect(c.sent).toHaveLength(1);
    expect(String(c.sent[0]![2]).endsWith(RESUME_TEXT)).toBe(true);
    expect(c.sentTo).toHaveLength(0);
    const t = await c.task();
    expect(t.sessionId).toBe('sess-novo-1');
    expect(t.fallback).toBeUndefined();
    expect(t.history.map((h) => h.note)).toEqual(expect.arrayContaining([NOTE('claude'), 'conversa parou sem terminar: retomada']));
    expect(primaryNotes(t)).toEqual([{ kind: 'back', engine: 'claude' }]);
  });
});

describe('volta ao motor principal: reprovação do revisor', () => {
  // A tarefa entregue no secundário, em revisão com o Rui (revisor marcado): o veredito dele decide (`onReviewTurn` → `reject` → `backToPrimary`).
  const REJECTED = 'REPROVADO\n🔴 a.ts:1 quebrou';
  const reviewing = () => ({
    id: 't',
    status: 'review' as const,
    reviewerId: 'rui-1',
    review: { staffId: 'rui-1', sessionId: 'rev-sess', at: iso(NOW - MIN) },
    sessions: [
      { id: 'sess-sec', role: 'work' as const, staffId: 'ana-1', engine: 'codex' as const, at: iso(NOW - 30 * MIN) },
      { id: 'rev-sess', role: 'review' as const, staffId: 'rui-1', engine: 'claude' as const, at: iso(NOW - MIN) },
    ],
  });

  it('principal liberado: os ajustes vão numa conversa nova nele, com o handoff, e a tela lê a nota da volta', async () => {
    const c = await club('reprovada', [reviewing()], { said: { 'rev-sess': REJECTED } });
    await c.svc.onTurnDone('rev-sess');
    // A conversa nova no principal: do funcionário (não do revisor), sem override, com o handoff e a reprovação do revisor no fim.
    expect(c.sent).toHaveLength(1);
    const args = c.sent[0]!;
    expect(args).toHaveLength(4);
    expect(args[1]).toBe('ana-1');
    expect(args[3]).toBe(false);
    const text = String(args[2]);
    expect(text).toContain('Você é o substituto desta tarefa');
    expect(text).toContain('O trabalho volta para o motor Claude, em conversa nova (modelo modelo-pri)');
    expect(text).toContain('use CSV, não XLSX');
    expect(text).toContain('## Retomada: o que chegou agora');
    expect(text.indexOf('## Retomada')).toBeLessThan(text.indexOf('Rui reprovou a entrega'));
    expect(text).toContain('🔴 a.ts:1 quebrou');
    // A mensagem da reprovação vai inteira (texto cru, sem bloco): a resposta pedida e a DÚVIDA ao revisor fecham o handoff.
    expect(text).toContain('um resumo curto do que mudou (e a lição registrada, se houver).');
    expect(text.endsWith('Ela vai a Rui, que reprovou, e não a quem pediu a tarefa.')).toBe(true);
    // O ajuste NÃO foi também para a conversa antiga, que parou.
    expect(c.sentTo).toHaveLength(0);
    expect(c.cancelled).toEqual(['sess-sec']);
    expect(c.cleared).toEqual(['sess-sec']);
    expect(c.stopped).toEqual(['sess-sec']);
    // A tarefa: de volta a "fazendo" na conversa nova, sem troca, com a reprovação contada e a conversa nova em `sessions` no motor certo.
    const t = await c.task();
    expect(t).toMatchObject({ status: 'doing', sessionId: 'sess-novo-1', reworkRounds: 1, review: { sessionId: 'rev-sess', verdict: 'rejected' } });
    expect(t.fallback).toBeUndefined();
    expect(t.fallbackBlocked).toBeUndefined();
    expect(t.sessions).toContainEqual(expect.objectContaining({ id: 'sess-novo-1', role: 'work', staffId: 'ana-1', engine: 'claude' }));
    const notes = t.history.map((h) => h.note);
    expect(notes).toContain('reprovada por Rui');
    expect(notes.indexOf('reprovada por Rui')).toBeLessThan(notes.indexOf(NOTE('claude')));
    expect(primaryNotes(t)).toEqual([{ kind: 'back', engine: 'claude' }]);
  });

  it('principal ainda no limite: a tarefa fica no secundário e o ajuste vai para a conversa de sempre, sem nota de volta', async () => {
    const c = await club('reprovada-limite', [reviewing()], { said: { 'rev-sess': REJECTED }, limits: { claude: hit(120) } });
    await c.svc.onTurnDone('rev-sess');
    expect(c.sent).toHaveLength(0);
    expect(c.sentTo).toHaveLength(1);
    expect(c.sentTo[0]![1]).toBe('sess-sec');
    expect(String(c.sentTo[0]![3])).toContain('Rui reprovou a entrega');
    expect(String(c.sentTo[0]![3])).toContain('🔴 a.ts:1 quebrou');
    const t = await c.task();
    expect(t).toMatchObject({ status: 'doing', sessionId: 'sess-sec', reworkRounds: 1, review: { verdict: 'rejected' } });
    expect(t.fallback).toMatchObject({ engine: 'codex', fromSession: 'sess-velha' });
    expect(t.history.map((h) => h.note)).toContain('reprovada por Rui');
    expect(primaryNotes(t)).toEqual([]);
    expect(c.cleared).toEqual([]);
    expect(c.stopped).toEqual([]);
  });
});

describe('volta ao motor principal: boot', () => {
  it('com o principal liberado: o boot só registra a antiga (que só abre no motor dela); o resume do reinício a devolve, e o boot seguinte não prende nada', async () => {
    const c = await club('boot', [{ id: 't', status: 'doing' }]);
    expect(await c.svc.restoreFallbacks()).toBe(1);
    expect(c.overrides.map(([sid]) => sid)).toEqual(['sess-sec']);
    // O resume do reinício (a conversa estava em turno): conversa nova no principal, com o aviso do reinício no fim.
    expect(await c.svc.resumeOnPrimary('p', 'sess-sec', 'o servidor reiniciou: continue')).toBe(true);
    expect(c.sent).toHaveLength(1);
    expect(String(c.sent[0]![2]).endsWith('o servidor reiniciou: continue')).toBe(true);
    expect(c.cleared).toEqual(['sess-sec']);
    const t = await c.task();
    expect(t.sessionId).toBe('sess-novo-1');
    expect(t.fallback).toBeUndefined();
    // Outro boot: a tarefa já não tem troca, então não há o que registrar (nada de voltar a prender no secundário).
    expect(await c.svc.restoreFallbacks()).toBe(0);
    expect(c.overrides).toHaveLength(1);
  });

  it('com o principal no limite: o resume do reinício não devolve, e a conversa fica no secundário', async () => {
    const c = await club('boot-limite', [{ id: 't', status: 'doing' }], { limits: { claude: hit(120) } });
    await c.svc.restoreFallbacks();
    expect(await c.svc.resumeOnPrimary('p', 'sess-sec', 'continue')).toBe(false);
    expect(c.sent).toHaveLength(0);
    expect((await c.task()).fallback).toBeDefined();
  });

  it('conversa que não é a de trabalho de uma tarefa trocada: o resume não devolve nada', async () => {
    const c = await club('boot-outra', [{ id: 't', status: 'doing', fallback: undefined }]);
    expect(await c.svc.resumeOnPrimary('p', 'sess-sec', 'continue')).toBe(false);
    expect(await c.svc.resumeOnPrimary('p', 'nao-existe', 'continue')).toBe(false);
    expect(c.sent).toHaveLength(0);
  });

  it('resumeAfterRestart: a devolvida não é retomada (nem confere o limite da antiga); falha ou "não" retomam como sempre', async () => {
    const file = path.join(root, 'resume.json');
    const entry = (sessionId: string) => ({ projectId: 'p', sessionId, staffId: 'ana-1', engine: 'codex' as const, cwd: '.', hadPending: false });
    await new ResumeFile(file).save([entry('devolvida'), entry('ficou'), entry('quebrou')], NOW);
    const sent: string[] = [];
    const stops: string[] = [];
    await resumeAfterRestart({
      file,
      now: () => NOW,
      log: () => {},
      stopHit: async (_p, _s, _e) => {
        stops.push('x');
        return null;
      },
      send: async (e) => void sent.push(e.sessionId),
      redirect: async (e) => {
        if (e.sessionId === 'quebrou') throw new Error('sem leitura');
        return e.sessionId === 'devolvida';
      },
    });
    expect(sent).toEqual(['ficou', 'quebrou']);
    expect(stops).toHaveLength(2);
  });
});

describe('volta ao motor principal: sem laço de trocas', () => {
  it('uma volta por retomada; se o principal bate o limite de novo, a troca para o secundário segue a regra de sempre, e a retomada seguinte (ainda no limite) fica lá', async () => {
    const limits: Opts['limits'] = {};
    const c = await club('laco', [{ id: 't', held: [held('primeiro ajuste')] }], { limits });
    // 1) retomada com o principal livre: UMA conversa nova, sem override.
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toHaveLength(4);
    expect(await c.task()).toMatchObject({ status: 'doing', sessionId: 'sess-novo-1' });
    // 2) o principal estoura o limite no meio do turno: a regra de sempre troca para o secundário (conversa nova, com override).
    limits.claude = hit(120);
    await c.svc.onLimit({ sessionId: 'sess-novo-1', engine: 'claude', hit: hit(120) });
    expect(c.sent).toHaveLength(2);
    expect(c.sent[1]![4]).toMatchObject({ engine: 'codex' });
    const trocada = await c.task();
    expect(trocada.sessionId).toBe('sess-novo-2');
    expect(trocada.fallback).toMatchObject({ engine: 'codex', fromSession: 'sess-novo-1', reason: 'limit-mid' });
    // 3) nova retomada com o principal ainda no limite: fica no secundário, sem nenhuma conversa nova.
    await c.hold('t', 'segundo ajuste');
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.sent).toHaveLength(2);
    expect(c.sentTo).toHaveLength(1);
    expect(c.sentTo[0]![1]).toBe('sess-novo-2');
    expect((await c.task()).fallback).toBeDefined();
    // 4) o limite baixa: a retomada seguinte volta ao principal (de novo, uma só vez por retomada).
    limits.claude = null;
    await c.hold('t', 'terceiro ajuste');
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.sent).toHaveLength(3);
    expect(c.sent[2]).toHaveLength(4);
    expect(await c.task()).toMatchObject({ sessionId: 'sess-novo-3' });
    expect((await c.task()).fallback).toBeUndefined();
  });

  it('a mesma retomada não repete a volta: com a tarefa já no principal (sem troca), nada mais acontece', async () => {
    const c = await club('laco-sem-troca', [{ id: 't', held: [held('a')] }]);
    await c.svc.kickStaff('p', 'ana-1');
    await c.hold('t', 'b');
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.sent).toHaveLength(1);
    expect(c.sentTo).toHaveLength(1);
    expect(c.sentTo[0]![1]).toBe('sess-novo-1');
  });
});

describe('buildHandoff no sentido secundário → principal', () => {
  const input = {
    task: { id: 't-1', title: 'Exportar', description: 'em CSV' },
    from: { engine: 'codex' as const, reason: 'back' as const, resetsAt: null },
    to: { engine: 'claude' as const, model: 'sonnet' },
    userMessages: [],
    lastAssistantText: null,
    git: null,
    memoryPath: '.myco/staff/ana.memory.md',
  };

  it('diz que o principal foi liberado (não que a conversa parou no limite) e leva a mensagem inteira no fim, sem cortar', () => {
    const message = 'x'.repeat(20_000);
    const text = buildHandoff({ ...input, message }, NOW);
    expect(text).toContain('O trabalho volta para o motor Claude, em conversa nova (modelo sonnet)');
    expect(text).toContain('rodava no motor Codex (o secundário da ficha)');
    expect(text).not.toContain('bateu no limite de uso (');
    expect(text.endsWith(`## Retomada: o que chegou agora\n\n${message}`)).toBe(true);
    expect(text.indexOf('## O que fazer')).toBeLessThan(text.indexOf('## Retomada'));
  });

  it('sem mensagem, a seção não existe; o sentido da ida continua como era', () => {
    expect(buildHandoff(input, NOW)).not.toContain('## Retomada');
    const ida = buildHandoff({ ...input, from: { engine: 'claude', reason: 'limit', resetsAt: NOW + 120 * MIN }, to: { engine: 'codex', model: 'gpt-5' } }, NOW);
    expect(ida).toContain('A conversa anterior parou porque o motor Claude bateu no limite de uso');
    expect(ida).toContain('O trabalho segue aqui, em conversa nova, no motor Codex (modelo gpt-5)');
  });
});
