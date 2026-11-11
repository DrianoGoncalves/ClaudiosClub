import { describe, expect, it } from 'vitest';
import type { ChatItem, EngineOverride, StaffProfile, UsageStopHit } from '../shared/model';
import type { LimitHit } from '../server/chat/usageLimit';
import { buildChatHandoff, oldConversationExtract } from '../server/fallbackHandoff';
import { DirectFallback, ownerMaySwitch, restoreDirectFallbacks, type DirectFallbackDeps } from '../server/directFallback';
import { UsageStopError } from '../server/usageStop';

// Conversa direta no limite de uso: a trava 5h/7d (ou o orçamento) barra o envio do dono; se a ficha tem secundário, a mensagem
// segue numa conversa nova no secundário, com o handoff. Testes com dependências falsas (sem processo, sem git, sem config).

const HOUR = 3_600_000;
/** Reset daqui a `h` horas, relativo ao relógio real (a decisão usa Date.now()). */
const resetIn = (ms: number) => new Date(Date.now() + ms).toISOString();

const fiveHour = (resetsAt = resetIn(2 * HOUR)): UsageStopHit => ({ kind: 'five_hour', percentUsed: 96, limit: 95, resetsAt });
const barredFive = (resetsAt?: string) => new UsageStopError(fiveHour(resetsAt));
const barredBudget = () => new UsageStopError({ kind: 'project_week', percentUsed: 80, limit: 70, resetsAt: resetIn(2 * HOUR), projectName: 'Demo' } as UsageStopHit);

function profile(over: Partial<StaffProfile> = {}): StaffProfile {
  return { id: 'ana', projectId: 'p1', name: 'Ana', engine: 'claude', fallback: { engine: 'codex', model: 'gpt-5.5' }, sessions: [], ...over } as StaffProfile;
}

const userItem = (text: string) => ({ kind: 'user', id: `u:${text}`, text, at: null }) as unknown as ChatItem;
const assistantItem = (text: string) => ({ kind: 'assistant', id: `a:${text}`, text, at: null }) as unknown as ChatItem;

interface Sent {
  sessionId: string | null;
  text: string;
  override?: EngineOverride;
}

/** Dependências falsas: o perfil, os limites de cada motor, a conversa antiga e o envio (que vira `sends`). */
function harness(opts: {
  profile?: StaffProfile | null;
  provider?: LimitHit | null | 'unknown';
  other?: LimitHit | null | 'unknown';
  otherStop?: UsageStopHit | null;
  runnable?: Error;
  sendError?: Error;
  history?: ChatItem[];
} = {}) {
  const sends: Sent[] = [];
  const logs: string[] = [];
  const cancels: string[] = [];
  const deps: DirectFallbackDeps = {
    cancelContinue: async (sessionId) => {
      cancels.push(sessionId);
    },
    readProfile: async () => (opts.profile === undefined ? profile() : opts.profile),
    readLimit: async (engine) => (engine === 'claude' ? (opts.provider ?? null) : (opts.other ?? null)),
    stopHit: async (_p, _s, engine) => (engine === 'codex' ? (opts.otherStop ?? null) : null),
    assertRunnable: async () => {
      if (opts.runnable) throw opts.runnable;
    },
    snapshot: async () => ({ history: opts.history ?? [], live: null }),
    git: async () => ({ status: '?? novo.ts', diffStat: ' a.ts | 2 +-' }),
    send: async (_projectId, sessionId, _staffId, text, _priority, _images, _files, override) => {
      sends.push({ sessionId, text, override });
      if (opts.sendError) throw opts.sendError;
      return sessionId ?? `nova-${sends.length}`;
    },
    log: (line) => logs.push(line),
  };
  return { dx: new DirectFallback(deps), sends, logs, cancels };
}

const switchInput = (over: Partial<{ sessionId: string | null; text: string; barred: UsageStopError }> = {}) => ({
  projectId: 'p1',
  staffId: 'ana',
  sessionId: 'velha',
  text: 'agora faz o relatório',
  images: [],
  files: [],
  barred: barredFive(),
  ...over,
});

describe('conversa direta no limite: troca para o secundário da ficha', () => {
  it('trava de 5h com secundário Codex: a mensagem vai para uma conversa nova no Codex, com o handoff; a antiga não é tocada', async () => {
    const { dx, sends } = harness({ history: [userItem('pedido antigo'), assistantItem('parei na migração')] });
    const r = await dx.switchOnLimit(switchInput());
    expect(r.sessionId).toBe('nova-1');
    expect(r.fallback).toEqual({ movedFrom: 'velha', engine: 'codex', model: 'gpt-5.5' });
    // Só uma chamada, e é a conversa nova (null): nada foi enviado à antiga.
    expect(sends).toHaveLength(1);
    expect(sends[0]!.sessionId).toBeNull();
    expect(sends[0]!.override).toEqual({ engine: 'codex', model: 'gpt-5.5' });
    const t = sends[0]!.text;
    expect(t).toContain('substituto desta conversa');
    expect(t).toContain('passou da linha de parada');
    expect(t).toContain('pedido antigo');
    expect(t).toContain('parei na migração');
    expect(t).toContain('?? novo.ts');
    expect(t).toContain('.myco/staff/ana.memory.md');
    expect(t.endsWith('## Pedido atual do dono\n\nagora faz o relatório')).toBe(true);
  });

  it('troca feita: o continue da conversa antiga é cancelado (motivo fallback), e a antiga não recebe mensagem', async () => {
    const { dx, sends, cancels } = harness();
    await dx.switchOnLimit(switchInput());
    expect(cancels).toEqual(['velha']);
    expect(sends.every((s) => s.sessionId === null)).toBe(true);
  });

  it('a mensagem nova do dono vai inteira, mesmo grande (o teto é do aviso, não dela)', async () => {
    const { dx, sends } = harness();
    const big = 'y'.repeat(20_000);
    await dx.switchOnLimit(switchInput({ text: big }));
    expect(sends[0]!.text.endsWith(`## Pedido atual do dono\n\n${big}`)).toBe(true);
  });

  it('conversa nova (sem conversa antiga): a 1ª mensagem não traz mensagens de conversa que não existe', async () => {
    const { dx, sends } = harness();
    const r = await dx.switchOnLimit(switchInput({ sessionId: null }));
    expect(r.fallback.movedFrom).toBeNull();
    expect(sends[0]!.text).not.toContain('Mensagens do dono nesta conversa');
    expect(sends[0]!.text).not.toContain('Onde a conversa anterior parou');
  });

  it('orçamento do projeto barra: nada é enviado e o erro é o mesmo', async () => {
    const { dx, sends } = harness();
    const barred = barredBudget();
    await expect(dx.switchOnLimit(switchInput({ barred }))).rejects.toBe(barred);
    expect(sends).toHaveLength(0);
  });

  it('sem secundário na ficha: barra como antes', async () => {
    const { dx, sends } = harness({ profile: profile({ fallback: undefined }) });
    const barred = barredFive();
    await expect(dx.switchOnLimit(switchInput({ barred }))).rejects.toBe(barred);
    expect(sends).toHaveLength(0);
  });

  it('o secundário também está no limite: barra, sem enviar', async () => {
    const { dx, sends } = harness({ other: { resetsAt: Date.now() + HOUR, window: 'five_hour' } });
    const barred = barredFive();
    await expect(dx.switchOnLimit(switchInput({ barred }))).rejects.toBe(barred);
    expect(sends).toHaveLength(0);
  });

  it('o reset do limite volta em menos de 15 min: espera (barra)', async () => {
    const { dx, sends } = harness();
    const barred = barredFive(resetIn(5 * 60_000));
    await expect(dx.switchOnLimit(switchInput({ barred }))).rejects.toBe(barred);
    expect(sends).toHaveLength(0);
  });

  it('a conversa nova não abre (pré-checagem): barra com o erro de antes, sem enviar', async () => {
    const { dx, sends } = harness({ runnable: new Error('codex não está instalado') });
    const barred = barredFive();
    await expect(dx.switchOnLimit(switchInput({ barred }))).rejects.toBe(barred);
    expect(sends).toHaveLength(0);
  });

  it('a falha da conversa nova devolve o erro de limite de antes (a antiga não recebe nada)', async () => {
    const { dx, sends, logs } = harness({ sendError: new Error('sem processo') });
    const barred = barredFive();
    await expect(dx.switchOnLimit(switchInput({ barred }))).rejects.toBe(barred);
    expect(sends).toHaveLength(1);
    expect(sends.every((s) => s.sessionId === null)).toBe(true);
    expect(logs.some((l) => l.includes('sem processo'))).toBe(true);
  });

  it('o 2º envio seguido, ainda na conversa antiga, vai para a nova: não troca de novo', async () => {
    const { dx, sends } = harness();
    await dx.switchOnLimit(switchInput({ text: 'um' }));
    const r2 = await dx.switchOnLimit(switchInput({ text: 'dois' }));
    expect(r2.sessionId).toBe('nova-1');
    expect(sends).toHaveLength(2);
    expect(sends[1]).toMatchObject({ sessionId: 'nova-1', text: 'dois' });
  });

  it('dois envios ao mesmo tempo: uma conversa nova só (a fila por funcionário)', async () => {
    const { dx, sends } = harness();
    const [a, b] = await Promise.all([dx.switchOnLimit(switchInput({ text: 'um' })), dx.switchOnLimit(switchInput({ text: 'dois' }))]);
    expect(a.sessionId).toBe('nova-1');
    expect(b.sessionId).toBe('nova-1');
    expect(sends.filter((s) => s.sessionId === null)).toHaveLength(1);
  });
});

describe('quem pode trocar (ownerMaySwitch)', () => {
  const base = { fromBrowser: true, force: false, staffId: 'ana', onFallback: false, taskConversation: false };

  it('o dono, pela tela, numa conversa direta sem força: pode', () => {
    expect(ownerMaySwitch(base)).toBe(true);
  });

  it('mensagem de funcionário pela API (sem a tela) não troca', () => {
    expect(ownerMaySwitch({ ...base, fromBrowser: false })).toBe(false);
  });

  it('com `force` o dono já escolheu passar da trava: não troca', () => {
    expect(ownerMaySwitch({ ...base, force: true })).toBe(false);
  });

  it('conversa que já roda no secundário segue nele: não troca de novo', () => {
    expect(ownerMaySwitch({ ...base, onFallback: true })).toBe(false);
  });

  it('conversa de tarefa fica com a tarefa: não entra no envio direto', () => {
    expect(ownerMaySwitch({ ...base, taskConversation: true })).toBe(false);
  });

  it('sem funcionário (conversa avulsa) não há ficha para trocar', () => {
    expect(ownerMaySwitch({ ...base, staffId: null })).toBe(false);
  });
});

describe('boot: conversas diretas trocadas voltam ao secundário', () => {
  it('re-registra só as que batem com a ficha atual, com o modelo da ficha (não o gravado), e pula as de tarefa', async () => {
    const prof = profile({
      fallback: { engine: 'codex', model: 'gpt-5.5' },
      sessions: [
        { id: 'a', startedAt: '', fallback: { engine: 'codex', model: 'modelo-gravado-antigo' } },
        { id: 'b', startedAt: '', fallback: { engine: 'claude', model: 'opus' } },
        { id: 'tarefa', startedAt: '', fallback: { engine: 'codex', model: 'gpt-5.5' } },
        { id: 'c', startedAt: '' },
      ],
    });
    const set: Array<[string, EngineOverride]> = [];
    const n = await restoreDirectFallbacks({
      listStaff: async () => [prof],
      isTaskConversation: async (sid) => sid === 'tarefa',
      setOverride: (sid, o) => set.push([sid, o]),
    });
    expect(n).toBe(1);
    expect(set).toEqual([['a', { engine: 'codex', model: 'gpt-5.5' }]]);
  });

  it('ficha sem secundário: nada é re-registrado', async () => {
    const prof = profile({ fallback: undefined, sessions: [{ id: 'a', startedAt: '', fallback: { engine: 'codex', model: 'x' } }] });
    const set: string[] = [];
    const n = await restoreDirectFallbacks({ listStaff: async () => [prof], isTaskConversation: async () => false, setOverride: (sid) => set.push(sid) });
    expect(n).toBe(0);
    expect(set).toEqual([]);
  });
});

describe('handoff da conversa direta e leitura da conversa antiga', () => {
  it('sem conversa antiga, sem git: avisa que o git não deu, e traz o motivo e a memória', () => {
    const t = buildChatHandoff({
      reason: 'o motor Claude está no limite até 15:00',
      to: { engine: 'codex', model: 'gpt-5.5' },
      git: null,
      memoryPath: '.myco/staff/ana.memory.md',
      message: 'oi',
    });
    expect(t).toContain('o motor Claude está no limite até 15:00');
    expect(t).toContain('Não deu para ler o git');
    expect(t).not.toContain('Mensagens do dono nesta conversa');
    expect(t).toContain('`.myco/staff/ana.memory.md`');
  });

  it('na tarefa, a 1ª mensagem da conversa é o pedido e sai; na direta (skipRequest: false), fica', () => {
    const snap = { history: [userItem('pedido'), userItem('correção')], live: null };
    expect(oldConversationExtract(snap).userMessages).toEqual(['correção']);
    expect(oldConversationExtract(snap, { skipRequest: false }).userMessages).toEqual(['pedido', 'correção']);
  });
});
