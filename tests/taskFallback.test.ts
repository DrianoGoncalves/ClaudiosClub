import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatItem, ChatSnapshot, EngineOverride, StaffProfile, Task, TaskFallback, UsageStopHit } from '../shared/model';
import { CONTINUE_TEXT } from '../server/chat/autoContinue';
import { RESUME_TEXT } from '../server/chat/items';
import { PLAN_REJECTED_MESSAGE } from '../server/chat/manager';
import type { LimitHit } from '../server/chat/usageLimit';
import { oldConversationExtract } from '../server/fallbackHandoff';
import { limitOfStop, limitReading, shouldFallback } from '../server/taskFallback';
import { TaskService } from '../server/tasks';
import { UsageStopError } from '../server/usageStop';

// Troca de motor por tarefa: a decisão pura (`shouldFallback`), o início no secundário (limite da ficha), o meio do turno
// (`onLimit`: pré-checagem, para a antiga, cancela o "continue", abre a nova com o handoff), a fase e o modo, o que o boot
// e o estado da tarefa fazem com o override, e o que o handoff leva (e o que não leva).

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-taskfallback-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// O código lê o relógio de verdade (Date.now): os resets dos testes são relativos a ele.
const NOW = Date.now();
const MIN = 60_000;
const hit = (minutes: number | null): LimitHit => ({ resetsAt: minutes === null ? null : NOW + minutes * MIN, window: 'five_hour' });
const withFallback: Pick<StaffProfile, 'fallback'> = { fallback: { engine: 'codex', model: 'gpt-5' } };
const troca: TaskFallback = { engine: 'codex', model: 'gpt-5', from: 'claude', at: NOW, fromSession: 'sess-velha', reason: 'limit-mid' };

const decide = (over: Partial<Parameters<typeof shouldFallback>[0]> = {}) =>
  shouldFallback({ task: {}, profile: withFallback, engine: 'claude', hit: hit(120), otherEngineHit: null, now: NOW, ...over });

describe('shouldFallback (decisão pura)', () => {
  it('ficha com motor secundário, limite longo e secundário livre: troca', () => {
    expect(decide()).toMatchObject({ ok: true });
  });

  it('ficha sem fallback: espera (como hoje), com o motivo', () => {
    const d = decide({ profile: {} });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/não tem motor secundário/);
  });

  it('secundário do mesmo motor da ficha: espera', () => {
    expect(decide({ profile: { fallback: { engine: 'claude', model: 'outro' } } }).ok).toBe(false);
  });

  it('tarefa que já trocou: não troca de novo (anti ping-pong)', () => {
    const d = decide({ task: { fallback: troca } });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/não troca de novo/);
  });

  it('reset em 15 min ou menos: espera; mais de 15 min: troca', () => {
    expect(decide({ hit: hit(10) }).ok).toBe(false);
    expect(decide({ hit: hit(15) }).ok).toBe(false);
    expect(decide({ hit: hit(16) }).ok).toBe(true);
  });

  it('reset desconhecido (null): troca', () => {
    expect(decide({ hit: hit(null) }).ok).toBe(true);
  });

  it('secundário também no limite: espera', () => {
    const d = decide({ otherEngineHit: hit(120) });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/também está no limite/);
  });

  it('leitura do secundário indisponível: não sabe, então não troca', () => {
    const d = decide({ otherEngineHit: 'unknown' });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/leitura indisponível/);
  });
});

/** Trava da empresa (5h/7d) que passou da linha, com o reset em `minutes` (null = desconhecido). */
const trava = (kind: 'five_hour' | 'seven_day', minutes: number | null, percent = 96): UsageStopHit => ({
  kind,
  percentUsed: percent,
  limit: 95,
  resetsAt: minutes === null ? null : new Date(NOW + minutes * MIN).toISOString(),
});
const orcamento: UsageStopHit = { kind: 'project_week', percentUsed: 40, limit: 30, resetsAt: null, projectName: 'Projeto X' };

describe('linha de parada como limite do motor (taskFallback)', () => {
  it('o orçamento do projeto não é limite do motor', () => {
    expect(limitOfStop(orcamento)).toBeNull();
  });

  it('a janela 5h/7d vira limite, com o reset em ms; reset ilegível ou ausente: longe (null)', () => {
    expect(limitOfStop(trava('five_hour', 120))).toEqual({ resetsAt: NOW + 120 * MIN, window: 'five_hour' });
    expect(limitOfStop(trava('seven_day', null))).toEqual({ resetsAt: null, window: 'seven_day' });
    expect(limitOfStop({ ...trava('five_hour', 120), resetsAt: 'nada' })).toEqual({ resetsAt: null, window: 'five_hour' });
  });

  it('limitReading: o do provedor vem antes; sem leitura de um dos dois, unknown; sem limite nenhum, null', () => {
    const provedor = hit(120);
    const empresa = limitOfStop(trava('five_hour', 60))!;
    expect(limitReading(provedor, empresa)).toBe(provedor);
    expect(limitReading(null, empresa)).toBe(empresa);
    expect(limitReading('unknown', empresa)).toBe(empresa);
    expect(limitReading('unknown', null)).toBe('unknown');
    expect(limitReading(null, 'unknown')).toBe('unknown');
    expect(limitReading(null, null)).toBeNull();
  });
});

interface ProjectOpts {
  /** Limite agora de cada motor (padrão: sem limite). */
  limits?: Partial<Record<'claude' | 'codex', LimitHit | null | 'unknown'>>;
  /** Erro do envio da conversa nova (recebe o override, se houver). */
  sendError?: (override: EngineOverride | undefined) => Error | undefined;
  /** A foto da conversa antiga falha: o handoff sai sem ela. */
  snapshotFails?: boolean;
  /** Modo de execução (permissionMode do Claude Code) da conversa antiga na foto. Sem ele, a foto não tem live. */
  mode?: string | null;
  /** Hora do despertador que o cancelamento devolve (null/ausente = não havia). */
  wakeAt?: number | null;
  /** A pré-checagem da troca falha com isto. */
  assertError?: Error;
  /** Há "continue" pendente para a conversa (o workDone espera). Padrão: não. */
  awaitingLimit?: boolean;
  /** A tarefa foi pedida por um gestor (Gil), na conversa `sess-gestor`. */
  manager?: boolean;
  /** Trava de consumo de cada motor (linha 5h/7d ou orçamento; 'unknown' = sem leitura). Sem `force`, o envio barra o Claude. */
  stop?: Partial<Record<'claude' | 'codex', UsageStopHit | 'unknown'>>;
}

/** Projeto com tarefas já gravadas em `.myco/tasks.json` e os fakes do TaskService. `log` guarda a ordem do que o serviço fez. */
async function project(dirName: string, tasks: Array<Partial<Task> & { id: string }>, profile: Partial<StaffProfile>, opts: ProjectOpts = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const now = new Date().toISOString();
  const pedida = opts.manager ? { requestedBy: 'gestor-1', requestedSession: 'sess-gestor' } : {};
  const full = tasks.map((t) => ({ title: t.id, description: '', status: 'todo', staffId: 'ana-1', sessionId: null, plan: null, branch: null, pr: null, createdAt: now, updatedAt: now, history: [], ...pedida, ...t }));
  await fs.writeFile(path.join(dir, '.myco', 'tasks.json'), JSON.stringify(full));
  const ana = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false, ...profile } as StaffProfile;
  const gil = { id: 'gestor-1', name: 'Gil', role: 'Gerente', autonomy: 'manual', worktree: false } as unknown as StaffProfile;
  const reads: Record<string, number> = {};
  const sent: unknown[][] = [];
  const overrides: Array<[string, unknown]> = [];
  const cleared: string[] = [];
  const asserted: EngineOverride[] = [];
  const log: string[] = [];
  const state = { persistedAtStop: null as boolean | null };
  const file = path.join(dir, '.myco', 'tasks.json');
  const svc = new TaskService({
    projectPath: async (id) => (id === 'p' ? dir : null),
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => (id === 'ana-1' ? ana : id === 'gestor-1' ? gil : null),
    apiUrl: 'http://127.0.0.1:4848',
    send: async (...args: unknown[]) => {
      sent.push(args);
      log.push('send');
      // Como a trava real (sendNewConversation): sem `force`, o motor da conversa confere a trava dele (o Codex não passa por ela).
      const override = args[4] as EngineOverride | undefined;
      const engineOfSend = override?.engine ?? (ana.engine === 'codex' ? 'codex' : 'claude');
      const barrada = opts.stop?.[engineOfSend];
      if (!args[3] && engineOfSend === 'claude' && barrada && barrada !== 'unknown') throw new UsageStopError(barrada);
      const err = opts.sendError?.(override);
      if (err) throw err;
      return 'sess-novo';
    },
    branchFor: async () => 'main',
    setOverride: (sessionId, override) => overrides.push([sessionId, override]),
    clearOverride: (sessionId) => cleared.push(sessionId),
    readLimit: async (engine) => {
      reads[engine] = (reads[engine] ?? 0) + 1;
      return opts.limits?.[engine] ?? null;
    },
    settleLimit: async () => {
      log.push('settle');
    },
    awaitingLimit: async () => opts.awaitingLimit ?? false,
    assertRunnable: async (_p, _s, override) => {
      asserted.push(override);
      if (opts.assertError) throw opts.assertError;
      const barrada = opts.stop?.[override.engine];
      if (override.engine === 'claude' && barrada && barrada !== 'unknown') throw new UsageStopError(barrada);
    },
    stopHit: async (_p, _s, engine) => {
      const s = opts.stop?.[engine] ?? null;
      if (s === 'unknown') throw new Error('sem leitura do consumo');
      return s;
    },
    cancelContinue: async (sid) => {
      log.push(`cancel:${sid}`);
      return opts.wakeAt ?? null;
    },
    stopSession: (sid) => {
      log.push(`stop:${sid}`);
      // A troca tem de estar gravada antes de matar a antiga (ver TaskService.onLimit).
      state.persistedAtStop = readFileSync(file, 'utf8').includes('"reason": "limit-mid"');
    },
    snapshot: async (_p, sid) => {
      if (opts.snapshotFails) throw new Error('sem foto');
      const live = opts.mode === undefined ? null : { items: [], state: { permissionMode: opts.mode } };
      return {
        sessionId: sid,
        history: [
          { kind: 'user', id: 'u1', text: 'faz o botão de exportar', at: now },
          { kind: 'user', id: 'u2', text: 'use CSV, não XLSX', at: now },
        ],
        live,
      } as unknown as ChatSnapshot;
    },
  });
  return { svc, dir, sent, overrides, cleared, asserted, log, state, file, reads };
}

describe('motor secundário na tarefa (TaskService)', () => {
  it('a próxima tarefa da mesma pessoa abre sem override: o envio é o de sempre, e a ficha sem fallback também', async () => {
    const { svc, sent } = await project('proxima', [{ id: 'antiga', status: 'done', sessionId: 'sess-antiga', fallback: troca }, { id: 'nova' }], withFallback);
    const started = (await svc.start('p', 'nova'))!;
    expect(started).toMatchObject({ status: 'doing', sessionId: 'sess-novo' });
    expect(started.fallback).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(4); // (projeto, funcionário, texto, force): nenhum override no envio

    const semFallback = await project('sem-fallback', [{ id: 'so' }], {});
    expect((await semFallback.svc.start('p', 'so'))!.fallback).toBeUndefined();
    expect(semFallback.sent[0]).toHaveLength(4);
  });

  it('o motor secundário fica gravado na tarefa e sobrevive a outras mudanças (e ao reinício: está no arquivo)', async () => {
    const { svc, dir } = await project('persiste', [{ id: 'x', status: 'doing', sessionId: 'sess-novo', fallback: troca }], withFallback);
    await svc.update('p', 'x', { title: 'Outro título' });
    const [t] = (await svc.list('p'))!;
    expect(t!.fallback).toEqual(troca);
    expect(await fs.readFile(path.join(dir, '.myco', 'tasks.json'), 'utf8')).toContain('"reason": "limit-mid"');
  });

  it('no boot, a conversa da tarefa que trocou volta no secundário da ficha (com o esforço dela); a das outras não', async () => {
    const { svc, overrides } = await project(
      'boot',
      [
        { id: 'trocou', status: 'doing', sessionId: 'sess-novo', fallback: troca },
        { id: 'normal', status: 'doing', sessionId: 'sess-normal' },
        { id: 'sem-conversa', status: 'todo' },
      ],
      { fallback: { engine: 'codex', model: 'gpt-5', effort: 'high' } },
    );
    expect(await svc.restoreFallbacks()).toBe(1);
    // Fazendo, ficha "aceitar edições": a conversa executa em "aceitar edições" (o que o plano aprovado já usa).
    expect(overrides).toEqual([['sess-novo', { engine: 'codex', model: 'gpt-5', effort: 'high', autonomy: 'acceptEdits' }]]);
  });

  it('no boot, o modelo vem da ficha ATUAL, não do arquivo da tarefa (que pode ter sido forjado ou ficado para trás)', async () => {
    const { svc, overrides } = await project('boot-ficha', [{ id: 't', status: 'doing', sessionId: 'sess-novo', fallback: { ...troca, model: 'forjado' } }], withFallback);
    expect(await svc.restoreFallbacks()).toBe(1);
    expect(overrides).toEqual([['sess-novo', { engine: 'codex', model: 'gpt-5', autonomy: 'acceptEdits' }]]);
  });

  it('no boot, o motor da tarefa tem de bater com o secundário da ficha; senão, ignora e a tarefa diz que a ficha mudou', async () => {
    const { svc, overrides } = await project('boot-motor', [{ id: 't', status: 'doing', sessionId: 'sess-novo', fallback: { ...troca, engine: 'claude' } }], withFallback);
    expect(await svc.restoreFallbacks()).toBe(0);
    expect(overrides).toEqual([]);
    const [t] = (await svc.list('p'))!;
    expect(t!.history.at(-1)!.note).toBe('o motor secundário da ficha mudou; a conversa volta ao principal');
    // Uma vez só: o próximo boot não repete a nota.
    await svc.restoreFallbacks();
    expect((await svc.list('p'))![0]!.history.filter((h) => h.note?.includes('secundário da ficha mudou'))).toHaveLength(1);
  });

  it('no boot, a autonomia vem da FASE e nunca passa da ficha: planejando é plano; fazendo, o modo do plano aprovado (limitado pela ficha)', async () => {
    const casos: Array<[Task['status'], Partial<StaffProfile>, string]> = [
      ['planning', { autonomy: 'auto' }, 'plan'],
      ['planning', { autonomy: 'manual' }, 'manual'], // a ficha manual não sobe para plano
      ['doing', { autonomy: 'plan' }, 'acceptEdits'], // ficha de plano executa em "aceitar edições" (ChatView)
      ['doing', { autonomy: 'auto' }, 'auto'],
      ['doing', { autonomy: 'manual' }, 'manual'],
      ['waiting', { autonomy: 'bypassPermissions' }, 'bypassPermissions'],
    ];
    for (const [status, ficha, esperado] of casos) {
      const { svc, overrides } = await project(`boot-auto-${status}-${ficha.autonomy}`, [{ id: 't', status, sessionId: 'sess-novo', fallback: troca }], { ...withFallback, ...ficha });
      await svc.restoreFallbacks();
      expect(overrides[0]?.[1]).toMatchObject({ autonomy: esperado });
    }
  });

  it('no boot, Claude como secundário de ficha Codex roda em "aceitar edições" (com o teto da ficha: auto fica acceptEdits; manual fica manual)', async () => {
    const codexAuto = { engine: 'codex', autonomy: 'auto', fallback: { engine: 'claude', model: 'sonnet' } } as Partial<StaffProfile>;
    const { svc, overrides } = await project('boot-claude-do-codex', [{ id: 't', status: 'doing', sessionId: 'sess-novo', fallback: { ...troca, engine: 'claude', model: 'sonnet', from: 'codex' } }], codexAuto);
    await svc.restoreFallbacks();
    expect(overrides[0]?.[1]).toMatchObject({ engine: 'claude', autonomy: 'acceptEdits' });
    const manual = await project('boot-claude-do-codex-manual', [{ id: 't', status: 'doing', sessionId: 'sess-novo', fallback: { ...troca, engine: 'claude', model: 'sonnet', from: 'codex' } }], { ...codexAuto, autonomy: 'manual' });
    await manual.svc.restoreFallbacks();
    expect(manual.overrides[0]?.[1]).toMatchObject({ autonomy: 'manual' });
  });

  it('a tarefa "a fazer" ou "aguardar" com troca registrada também volta no secundário (e a pronta não)', async () => {
    const { svc, overrides } = await project(
      'boot-todo-wait',
      [
        { id: 'fila', status: 'todo', sessionId: 'sess-fila', fallback: troca },
        { id: 'espera', status: 'waiting', sessionId: 'sess-espera', fallback: troca },
        { id: 'pronta', status: 'done', sessionId: 'sess-pronta', fallback: troca },
      ],
      withFallback,
    );
    expect(await svc.restoreFallbacks()).toBe(2);
    expect(overrides.map(([sid]) => sid).sort()).toEqual(['sess-espera', 'sess-fila']);
  });

  it('no boot, só volta a conversa de tarefa que anda ou espera revisão: pronta fica como está', async () => {
    const { svc, overrides } = await project(
      'boot-status',
      [
        { id: 'pronta', status: 'done', sessionId: 'sess-a', fallback: troca },
        { id: 'revisao', status: 'review', sessionId: 'sess-b', fallback: troca },
      ],
      withFallback,
    );
    expect(await svc.restoreFallbacks()).toBe(1);
    expect(overrides.map(([sid]) => sid)).toEqual(['sess-b']);
  });

  it('no boot, troca interrompida pelo reinício (a conversa é a antiga): a troca sai da tarefa, e a antiga não volta no secundário', async () => {
    const { svc, overrides, file } = await project('boot-antiga', [{ id: 'meio', status: 'doing', sessionId: 'sess-velha', fallback: troca }], withFallback);
    expect(await svc.restoreFallbacks()).toBe(0);
    expect(overrides).toEqual([]);
    const [t] = (await svc.list('p'))!;
    expect(t!.fallback).toBeUndefined();
    expect(t!.history.at(-1)!.note).toMatch(/troca interrompida pelo reinício/);
    expect(await fs.readFile(file, 'utf8')).not.toContain('"reason": "limit-mid"');
  });

  it('sem setOverride (servidor sem o gancho), o boot não registra nada', async () => {
    const { dir } = await project('boot-sem-gancho', [{ id: 'trocou', status: 'doing', sessionId: 'sess-novo', fallback: troca }], withFallback);
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async () => null,
      send: async () => 'x',
      branchFor: async () => null,
    });
    expect(await svc.restoreFallbacks()).toBe(0);
  });

  it('pronta: a conversa sai do motor secundário no manager; reaberta, volta com o secundário da ficha atual', async () => {
    const { svc, cleared, overrides } = await project('sync', [{ id: 'x', status: 'doing', sessionId: 'sess-novo', fallback: troca }], withFallback);
    await svc.update('p', 'x', { status: 'done' });
    expect(cleared).toEqual(['sess-novo']);
    await svc.update('p', 'x', { status: 'doing' });
    expect(overrides).toEqual([['sess-novo', { engine: 'codex', model: 'gpt-5', autonomy: 'acceptEdits' }]]);
  });

  it('a conversa de troca fica no secundário também em "aguardar": sai de aguardar, volta com o secundário (e a fase da volta)', async () => {
    const { svc, cleared, overrides } = await project('sync-espera', [{ id: 'x', status: 'doing', sessionId: 'sess-novo', fallback: troca }], withFallback);
    await svc.update('p', 'x', { status: 'waiting' });
    expect(cleared).toEqual([]); // aguardar não tira o secundário
    expect(overrides).toEqual([]); // nem re-registra: ainda não saiu de aguardar
    await svc.update('p', 'x', { status: 'todo' });
    // Saiu de aguardar: registra o secundário de novo (com a ficha atual e a autonomia da fase).
    expect(overrides).toEqual([['sess-novo', { engine: 'codex', model: 'gpt-5', autonomy: 'acceptEdits' }]]);
  });

  it('liberar o funcionário zera o secundário junto com a conversa: a tarefa volta para o começo, sem troca', async () => {
    const { svc } = await project('libera', [{ id: 'x', status: 'doing', sessionId: 'sess-novo', fallback: troca }], withFallback);
    expect(await svc.releaseStaff('p', 'ana-1')).toBe(1);
    const [t] = (await svc.list('p'))!;
    expect(t).toMatchObject({ status: 'todo', sessionId: null, staffId: null });
    expect(t!.fallback).toBeUndefined();
  });
});

describe('início da tarefa com o motor da ficha no limite', () => {
  it('limite do Claude e fallback Codex: abre no secundário, com a linha no texto, e grava a troca na tarefa', async () => {
    const { svc, sent } = await project('inicio-troca', [{ id: 'ini' }], withFallback, { limits: { claude: hit(120) } });
    const t = (await svc.start('p', 'ini'))!;
    expect(sent).toHaveLength(1);
    expect(sent[0]![4]).toEqual({ engine: 'codex', model: 'gpt-5' });
    expect(String(sent[0]![2])).toContain('Você está no motor secundário (Codex) porque Claude está no limite até');
    expect(t).toMatchObject({ status: 'doing', sessionId: 'sess-novo', fallback: { engine: 'codex', model: 'gpt-5', from: 'claude', fromSession: null, reason: 'limit-start' } });
  });

  it('ficha SEM fallback no limite: começa como sempre (o envio de hoje, com o force), sem fila e sem pré-checagem', async () => {
    const { svc, sent } = await project('inicio-sem', [{ id: 'sem' }], {}, { limits: { claude: hit(120) } });
    const t = (await svc.start('p', 'sem', true))!;
    expect(t).toMatchObject({ status: 'doing', sessionId: 'sess-novo', queuedAt: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]![3]).toBe(true); // o force segue como veio
    expect(sent[0]).toHaveLength(4);
  });

  it('reset em 15 min ou menos, com fallback: espera na fila, não troca', async () => {
    const { svc, sent } = await project('inicio-curto', [{ id: 'curto' }], withFallback, { limits: { claude: hit(10) } });
    const t = (await svc.start('p', 'curto'))!;
    expect(sent).toHaveLength(0);
    expect(t.queuedAt).toBeTruthy();
    expect(t.fallback).toBeUndefined();
  });

  it('linha de parada da empresa: não troca de motor; a tarefa vai para a fila com o aviso, e tenta uma vez só', async () => {
    const empresa = new UsageStopError({ kind: 'five_hour', percentUsed: 90, limit: 80, resetsAt: null });
    const { svc, sent } = await project('inicio-empresa', [{ id: 'emp' }], withFallback, {
      limits: { claude: hit(120) },
      sendError: () => empresa,
    });
    const t = (await svc.start('p', 'emp'))!;
    expect(sent).toHaveLength(1); // a tentativa no secundário; a empresa barrou, e não há troca nem nova tentativa
    expect(t).toMatchObject({ status: 'todo' });
    expect(t.queuedAt).toBeTruthy();
    expect(t.fallback).toBeUndefined();
  });

  it('falha ao abrir no secundário no início: continua na FILA (como sem fallback), não grava a troca, registra o motivo, e a fila tenta de novo', async () => {
    const { svc, sent } = await project('inicio-falha', [{ id: 'falha' }], withFallback, {
      limits: { claude: hit(120) },
      sendError: (o) => (o ? new Error('o Codex não abriu') : undefined),
    });
    const t = (await svc.start('p', 'falha'))!; // não lança: a tarefa fica na fila
    expect(t).toMatchObject({ status: 'todo', sessionId: null });
    expect(t.queuedAt).toBeTruthy();
    expect(t.fallback).toBeUndefined();
    expect(t.history.at(-1)!.note).toMatch(/não abriu no motor secundário: o Codex não abriu/);
    expect(sent).toHaveLength(1);
    await svc.tick(); // a fila tenta de novo (com o limite de hoje), e segue sem a troca gravada
    const [depois] = (await svc.list('p'))!;
    expect(sent).toHaveLength(2);
    expect(depois).toMatchObject({ status: 'todo' });
    expect(depois!.queuedAt).toBeTruthy();
    expect(depois!.fallback).toBeUndefined();
  });

  it('o limite baixou: começa como sempre, sem troca', async () => {
    const { svc, sent } = await project('inicio-livre', [{ id: 'livre' }], withFallback, { limits: { claude: null } });
    const t = (await svc.start('p', 'livre'))!;
    expect(t).toMatchObject({ status: 'doing', sessionId: 'sess-novo' });
    expect(t.fallback).toBeUndefined();
    expect(sent[0]![4]).toBeUndefined();
  });
});

describe('trava da empresa (5h/7d) dispara a troca como o limite do provedor (início)', () => {
  it('trava 5h com fallback: abre no Codex (a trava do Claude não barra o Codex), com "passou da linha de parada" no texto, e grava a troca', async () => {
    const { svc, sent, asserted } = await project('stop-troca', [{ id: 'st' }], withFallback, { stop: { claude: trava('five_hour', 120) } });
    const t = (await svc.start('p', 'st'))!;
    expect(asserted).toEqual([{ engine: 'codex', model: 'gpt-5' }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]![4]).toEqual({ engine: 'codex', model: 'gpt-5' });
    expect(String(sent[0]![2])).toContain('porque Claude passou da linha de parada (volta às ');
    expect(t).toMatchObject({ status: 'doing', sessionId: 'sess-novo', fallback: { engine: 'codex', from: 'claude', fromSession: null, reason: 'limit-start' } });
  });

  it('trava 7d com reset desconhecido: longe, então troca', async () => {
    const { svc, sent } = await project('stop-sem-reset', [{ id: 'sr' }], withFallback, { stop: { claude: trava('seven_day', null) } });
    await svc.start('p', 'sr');
    expect(sent[0]![4]).toEqual({ engine: 'codex', model: 'gpt-5' });
  });

  it('trava 5h com reset em 15 min ou menos: espera na fila, não troca', async () => {
    const { svc, sent } = await project('stop-curto', [{ id: 'curto' }], withFallback, { stop: { claude: trava('five_hour', 10) } });
    const t = (await svc.start('p', 'curto'))!;
    expect(sent).toHaveLength(0);
    expect(t.queuedAt).toBeTruthy();
    expect(t.fallback).toBeUndefined();
  });

  it('orçamento do projeto não troca: o envio no motor da ficha é barrado, e a tarefa fica na fila sem troca', async () => {
    const { svc, sent, asserted } = await project('stop-orcamento', [{ id: 'orc' }], withFallback, { stop: { claude: orcamento } });
    const t = (await svc.start('p', 'orc'))!;
    expect(asserted).toHaveLength(0);
    expect(sent).toHaveLength(1); // tentou no motor da ficha; o orçamento barrou
    expect(sent[0]![4]).toBeUndefined();
    expect(t).toMatchObject({ status: 'todo', sessionId: null });
    expect(t.queuedAt).toBeTruthy();
    expect(t.fallback).toBeUndefined();
  });

  it('trava 5h sem fallback na ficha: fica na fila como antes, sem troca', async () => {
    const { svc, sent } = await project('stop-sem', [{ id: 'sem' }], {}, { stop: { claude: trava('five_hour', 120) } });
    const t = (await svc.start('p', 'sem'))!;
    expect(sent).toHaveLength(1); // o envio no Claude foi barrado pela trava, como hoje
    expect(sent[0]![4]).toBeUndefined();
    expect(t).toMatchObject({ status: 'todo' });
    expect(t.queuedAt).toBeTruthy();
    expect(t.fallback).toBeUndefined();
  });

  it('Codex como principal: a trava 5h do Claude (secundário) barra a troca, e a tarefa espera', async () => {
    const { svc, sent } = await project('stop-codex-claude', [{ id: 'cc' }], { engine: 'codex', model: 'gpt-6-sol', fallback: { engine: 'claude', model: 'sonnet' } }, {
      limits: { codex: hit(120) },
      stop: { claude: trava('five_hour', 120) },
    });
    const t = (await svc.start('p', 'cc'))!;
    expect(sent).toHaveLength(0);
    expect(t.queuedAt).toBeTruthy();
    expect(t.history.at(-1)!.note).toMatch(/claude também está no limite/);
  });

  it('no meio do turno, o Codex (secundário) também respeita a trava do Claude: segue como antes, sem trocar', async () => {
    const { svc, log, sent } = await project('meio-trava-claude', [{ id: 'meio', status: 'doing', sessionId: 'sess-velha' }], { engine: 'codex', model: 'gpt-6-sol', fallback: { engine: 'claude', model: 'sonnet' } }, {
      limits: { codex: hit(120) },
      stop: { claude: trava('five_hour', 120) },
    });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'codex', hit: hit(120) });
    expect(log).toEqual(['settle']);
    expect(sent).toHaveLength(0);
  });
});

describe('limite no meio do turno (onLimit)', () => {
  const doing = (fallback?: TaskFallback, status: Task['status'] = 'doing') => [
    { id: 'meio', title: 'Botão de exportar', status, sessionId: 'sess-velha', ...(fallback && { fallback }) },
  ];

  it('para a antiga, cancela o "continue" dela, grava a troca antes de matar, e abre a nova no secundário com o handoff', async () => {
    const { svc, sent, log, state, asserted, file } = await project('meio-troca', doing(), withFallback, { limits: { claude: hit(120) } });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    expect(log).toEqual(['settle', 'cancel:sess-velha', 'stop:sess-velha', 'send']);
    expect(state.persistedAtStop).toBe(true);
    // A pré-checagem viu o override que a conversa nova abriria. Sem leitura do modo da antiga: o mínimo (manual).
    expect(asserted).toEqual([{ engine: 'codex', model: 'gpt-5', autonomy: 'manual' }]);
    expect(sent[0]![4]).toEqual({ engine: 'codex', model: 'gpt-5', autonomy: 'manual' });
    const handoff = String(sent[0]![2]);
    expect(handoff).toContain('Botão de exportar');
    expect(handoff).toContain('use CSV, não XLSX');
    expect(handoff).toContain('Quando terminar, responda com um resumo curto do que foi feito e do que falta.');
    expect(handoff).toContain('.myco/staff/ana-1.memory.md'); // com `/`, também no Windows
    expect(handoff).not.toContain('\\');
    const [t] = (await svc.list('p'))!;
    expect(t).toMatchObject({ status: 'doing', sessionId: 'sess-novo', fallback: { engine: 'codex', from: 'claude', fromSession: 'sess-velha', reason: 'limit-mid' } });
    expect(await fs.readFile(file, 'utf8')).toContain('"fromSession": "sess-velha"');
  });

  it('o idle e o fim do turno atrasados da conversa antiga são ignorados: a tarefa segue na nova', async () => {
    const { svc, sent } = await project('meio-atrasado', doing(), withFallback, { limits: { claude: hit(120) } });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    await svc.onTurnDone('sess-velha');
    await svc.onIdle('sess-velha', 'p', 'ana-1');
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    const [t] = (await svc.list('p'))!;
    expect(t).toMatchObject({ status: 'doing', sessionId: 'sess-novo' });
    expect(sent).toHaveLength(1);
  });

  it('workDone antigo ANTES do limite, sem "continue" pendente: a tarefa entrega (revisão) e o limite não troca nada', async () => {
    const { svc, log, sent } = await project('ordem-antes', doing(), withFallback, { limits: { claude: hit(120) }, awaitingLimit: false });
    await svc.onTurnDone('sess-velha');
    expect((await svc.list('p'))![0]!.status).toBe('review');
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    expect(log).toEqual(['settle']); // revisão não é de quem troca de motor
    expect(sent).toHaveLength(0);
    expect((await svc.list('p'))![0]).toMatchObject({ status: 'review', sessionId: 'sess-velha' });
  });

  it('workDone antigo DEPOIS do limite, sem "continue" pendente: a troca já aconteceu, e o fim da antiga não entrega nem fecha a nova', async () => {
    const { svc, sent } = await project('ordem-depois', doing(), withFallback, { limits: { claude: hit(120) }, awaitingLimit: false });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    await svc.onTurnDone('sess-velha');
    await svc.onIdle('sess-velha', 'p', 'ana-1');
    expect((await svc.list('p'))![0]).toMatchObject({ status: 'doing', sessionId: 'sess-novo' });
    expect(sent).toHaveLength(1);
  });

  it('a tarefa que já trocou não troca de novo: a antiga nem é tocada', async () => {
    const { svc, log } = await project('meio-segunda', doing(troca), withFallback, { limits: { claude: hit(120) } });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    expect(log).toEqual(['settle']);
    const [t] = (await svc.list('p'))!;
    expect(t!.history.at(-1)!.note).toMatch(/não troca de novo/);
  });

  it('reset em 15 min ou menos: segue como antes (o "continue" agendado), sem trocar', async () => {
    const { svc, log } = await project('meio-curto', doing(), withFallback, { limits: { claude: hit(120) } });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(10) });
    expect(log).toEqual(['settle']);
  });

  it('o secundário também no limite: não troca', async () => {
    const { svc, log } = await project('meio-secundario', doing(), withFallback, { limits: { claude: hit(120), codex: hit(120) } });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    expect(log).toEqual(['settle']);
  });

  it('leitura do secundário indisponível: não sabe, então não troca', async () => {
    const { svc, log } = await project('meio-leitura', doing(), withFallback, { limits: { claude: hit(120), codex: 'unknown' } });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    expect(log).toEqual(['settle']);
  });

  it('ficha sem fallback: o limite no meio não mexe em nada (como hoje; só espera o agendamento)', async () => {
    const { svc, log } = await project('meio-sem-fallback', doing(), {}, { limits: { claude: hit(120) } });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    expect(log).toEqual(['settle']);
    const [t] = (await svc.list('p'))!;
    expect(t).toMatchObject({ status: 'doing', sessionId: 'sess-velha' });
  });

  it('pré-checagem que não passa (ex.: o Codex desligado): não troca, não para a antiga, e o limite segue como antes', async () => {
    const { svc, log } = await project('meio-precheck', doing(), withFallback, {
      limits: { claude: hit(120) },
      assertError: new Error('O Codex está desligado nas configurações'),
    });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    expect(log).toEqual(['settle']);
    const [t] = (await svc.list('p'))!;
    expect(t).toMatchObject({ status: 'doing', sessionId: 'sess-velha' });
    expect(t!.fallback).toBeUndefined();
    expect(t!.history.at(-1)!.note).toMatch(/troca para Codex não feita: O Codex está desligado/);
  });

  it('fase: "fazendo" segue fazendo e a nova abre no modo em que a antiga estava (não no plano da ficha)', async () => {
    const { svc, sent, asserted } = await project('modo-doing', doing(), { ...withFallback, autonomy: 'plan' }, { limits: { claude: hit(120) }, mode: 'acceptEdits' });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    expect(sent[0]![4]).toEqual({ engine: 'codex', model: 'gpt-5', autonomy: 'acceptEdits' });
    expect(asserted[0]).toEqual({ engine: 'codex', model: 'gpt-5', autonomy: 'acceptEdits' });
    expect((await svc.list('p'))![0]).toMatchObject({ status: 'doing', sessionId: 'sess-novo' });
  });

  it('fase: "planejando" segue planejando e a nova abre em plano', async () => {
    const { svc, sent } = await project('modo-planning', doing(undefined, 'planning'), { ...withFallback, autonomy: 'acceptEdits' }, { limits: { claude: hit(120) }, mode: 'acceptEdits' });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    expect(sent[0]![4]).toEqual({ engine: 'codex', model: 'gpt-5', autonomy: 'plan' });
    expect((await svc.list('p'))![0]).toMatchObject({ status: 'planning', sessionId: 'sess-novo' });
  });

  it('fase "fazendo" sem leitura do modo: abre em manual (o mínimo), e não em "aceitar edições" por chute', async () => {
    const { svc, sent } = await project('modo-sem-leitura', doing(), { ...withFallback, autonomy: 'plan' }, { limits: { claude: hit(120) } });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    expect(sent[0]![4]).toEqual({ engine: 'codex', model: 'gpt-5', autonomy: 'manual' });
  });

  it('teto de autonomia: o modo da antiga nunca passa do da ficha (bypass numa ficha de "aceitar edições" abre em "aceitar edições")', async () => {
    const { svc, sent } = await project('teto-bypass', doing(), withFallback, { limits: { claude: hit(120) }, mode: 'bypassPermissions' });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    expect(sent[0]![4]).toMatchObject({ autonomy: 'acceptEdits' });
  });

  it('teto de autonomia: ficha manual com a antiga em "automático" abre em manual', async () => {
    const { svc, sent } = await project('teto-manual', doing(), { ...withFallback, autonomy: 'manual' }, { limits: { claude: hit(120) }, mode: 'auto' });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    expect(sent[0]![4]).toMatchObject({ autonomy: 'manual' });
  });

  it('falha ao abrir a nova: a troca fica gravada, a tarefa vai para Aguardar com o motivo, e não tenta de novo', async () => {
    const { svc, sent } = await project('meio-falha', doing(), withFallback, {
      limits: { claude: hit(120) },
      sendError: () => new Error('boom'),
    });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    const [t] = (await svc.list('p'))!;
    expect(t).toMatchObject({ status: 'waiting', fallback: { reason: 'limit-mid', fromSession: 'sess-velha' } });
    expect(t!.waitReason).toMatch(/não abriu no motor secundário: boom/);
    await svc.tick();
    expect(sent).toHaveLength(1);
  });

  it('o handoff não quebra sem leitura da conversa antiga: a nova abre mesmo assim', async () => {
    const { svc, sent } = await project('meio-sem-snapshot', doing(), withFallback, { limits: { claude: hit(120) }, snapshotFails: true });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    expect(sent).toHaveLength(1);
    expect(String(sent[0]![2])).toContain('Botão de exportar');
    expect(String(sent[0]![2])).not.toContain('use CSV, não XLSX');
  });

  it('o despertador da antiga, cancelado, entra no handoff com a hora (reagende se ainda fizer sentido)', async () => {
    const wake = Date.parse('2026-11-10T15:30:00');
    const { svc, sent } = await project('meio-despertador', doing(), withFallback, { limits: { claude: hit(120) }, wakeAt: wake });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    expect(String(sent[0]![2])).toMatch(/havia um despertador agendado para \d{2}:\d{2}: reagende se ainda fizer sentido/);
  });
});

describe('dúvida ao gestor pelo motor EFETIVO da conversa', () => {
  it('no Claude, a dúvida vai pela API local', async () => {
    const { svc, sent } = await project('duv-claude', [{ id: 'c' }], {}, { manager: true });
    await svc.start('p', 'c');
    expect(String(sent[0]![2])).toContain('Pedida por Gil');
    expect(String(sent[0]![2])).toContain('http://127.0.0.1:4848/api/projects/p');
  });

  it('no Codex como principal, não há linha de dúvida (a sandbox não fala com subordinados: mayReach)', async () => {
    const { svc, sent } = await project('duv-codex', [{ id: 'c' }], { engine: 'codex', model: 'gpt-6-sol' }, { manager: true });
    await svc.start('p', 'c');
    expect(String(sent[0]![2])).toContain('Pedida por Gil');
    expect(String(sent[0]![2])).not.toContain('/api/projects/');
  });

  it('no Codex como secundário (troca no meio), o handoff não leva linha de dúvida', async () => {
    const { svc, sent } = await project('duv-meio', [{ id: 'meio', status: 'doing', sessionId: 'sess-velha' }], withFallback, { limits: { claude: hit(120) }, manager: true });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    expect(String(sent[0]![2])).toContain('Pedida por Gil');
    expect(String(sent[0]![2])).not.toContain('/api/projects/');
  });

  it('a troca no meio de Codex para Claude (ficha Codex) leva a linha da API local: o motor efetivo é o Claude', async () => {
    const { svc, sent } = await project('duv-volta', [{ id: 'meio', status: 'doing', sessionId: 'sess-velha' }], { engine: 'codex', model: 'gpt-6-sol', fallback: { engine: 'claude', model: 'sonnet' } }, { limits: { codex: hit(120) }, manager: true });
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'codex', hit: hit(120) });
    expect(String(sent[0]![2])).toContain('http://127.0.0.1:4848/api/projects/p');
  });
});

describe('início: pré-checagem da troca e leitura do Codex em cache', () => {
  it('a pré-checagem da troca falha no início: fica na fila, sem enviar e sem sessão, com o motivo', async () => {
    const { svc, sent, asserted } = await project('pre-inicio', [{ id: 'p1' }], withFallback, {
      limits: { claude: hit(120) },
      assertError: new Error('o Codex está desligado'),
    });
    const t = (await svc.start('p', 'p1'))!;
    expect(asserted).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(t).toMatchObject({ status: 'todo', sessionId: null });
    expect(t.queuedAt).toBeTruthy();
    expect(t.fallback).toBeUndefined();
    expect(t.history.at(-1)!.note).toMatch(/a troca para Codex não abre \(o Codex está desligado\)/);
  });

  it('a fila de início lê o Codex uma vez, e não a cada tick (cache de 5 min); a do Claude segue a cada tick', async () => {
    const { svc, reads } = await project('cache-fila', [{ id: 'f1' }], withFallback, { limits: { claude: hit(10) } });
    await svc.start('p', 'f1'); // na fila (reset curto): lê o Codex e guarda
    expect(reads.codex).toBe(1);
    await svc.tick();
    await svc.tick();
    await svc.tick();
    expect(reads.codex).toBe(1);
    expect(reads.claude).toBeGreaterThan(1);
  });

  it('o meio do turno lê o Codex de novo, mesmo com a leitura da fila em cache', async () => {
    const { svc, reads, file } = await project('fresco-meio', [{ id: 'f1' }], withFallback, { limits: { claude: hit(10) } });
    await svc.start('p', 'f1');
    expect(reads.codex).toBe(1);
    // Um trabalho em andamento aparece (a conversa dele): o estouro no meio do turno lê o Codex fresco.
    const atual = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    const agora = new Date().toISOString();
    atual.push({ id: 'm', title: 'Meio', description: '', status: 'doing', staffId: 'ana-1', sessionId: 'sess-velha', plan: null, branch: null, pr: null, createdAt: agora, updatedAt: agora, history: [] });
    await fs.writeFile(file, JSON.stringify(atual));
    await svc.onLimit({ sessionId: 'sess-velha', engine: 'claude', hit: hit(120) });
    expect(reads.codex).toBe(2);
  });
});

describe('o que o handoff leva da conversa antiga', () => {
  const item = (kind: 'user' | 'assistant', text: string, id: string): ChatItem => ({ kind, id, text, at: new Date().toISOString() }) as ChatItem;

  it('o que a própria plataforma injeta (continue, retomada, recusa de plano, avisos) não vira correção do dono', () => {
    const history = [
      item('user', 'faz o botão de exportar', 'a'), // o pedido: sai
      item('user', CONTINUE_TEXT, 'b'),
      item('user', RESUME_TEXT, 'c'),
      item('user', PLAN_REJECTED_MESSAGE, 'd'),
      item('user', 'use CSV, não XLSX', 'e'),
    ];
    expect(oldConversationExtract({ history, live: null }).userMessages).toEqual(['use CSV, não XLSX']);
  });
});
