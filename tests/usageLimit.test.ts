import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ChatProcess } from '../server/chat/process';
import {
  clockText,
  limitFromRateLimitEvent,
  limitFromText,
  limitNotice,
  mergeHits,
  resumePlan,
  RETRY_MS,
  SLACK_MS,
  type LimitHit,
} from '../server/chat/usageLimit';

// Reconhecer o limite de uso estourado no stream do claude e saber quando ele volta.

const rejected = (over: Record<string, unknown> = {}) => ({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', resetsAt: 1_793_032_200, rateLimitType: 'five_hour', ...over },
});

describe('limitFromRateLimitEvent', () => {
  it('rejected: a hora (época em segundos) e a janela que estourou', () => {
    expect(limitFromRateLimitEvent(rejected())).toEqual({ resetsAt: 1_793_032_200_000, window: 'five_hour' });
    expect(limitFromRateLimitEvent(rejected({ rateLimitType: 'seven_day' }))).toMatchObject({ window: 'seven_day' });
    expect(limitFromRateLimitEvent(rejected({ rateLimitType: 'seven_day_opus' }))).toMatchObject({ window: 'seven_day' });
    expect(limitFromRateLimitEvent(rejected({ rateLimitType: 'overage' }))).toMatchObject({ window: null });
  });

  it('aceita a hora em milissegundos e sem hora', () => {
    expect(limitFromRateLimitEvent(rejected({ resetsAt: 1_793_032_200_000 }))?.resetsAt).toBe(1_793_032_200_000);
    expect(limitFromRateLimitEvent(rejected({ resetsAt: undefined }))).toEqual({ resetsAt: null, window: 'five_hour' });
    expect(limitFromRateLimitEvent(rejected({ resetsAt: 'amanhã' }))?.resetsAt).toBeNull();
  });

  it('allowed e allowed_warning não são limite estourado; outros eventos também não', () => {
    expect(limitFromRateLimitEvent(rejected({ status: 'allowed' }))).toBeNull();
    expect(limitFromRateLimitEvent(rejected({ status: 'allowed_warning' }))).toBeNull();
    expect(limitFromRateLimitEvent({ type: 'result', rate_limit_info: { status: 'rejected' } })).toBeNull();
    expect(limitFromRateLimitEvent({ type: 'rate_limit_event' })).toBeNull();
    expect(limitFromRateLimitEvent(null)).toBeNull();
  });
});

describe('limitFromText', () => {
  it('"Claude AI usage limit reached|<época>": a hora vem depois da barra', () => {
    expect(limitFromText('Claude AI usage limit reached|1793032200')).toEqual({ resetsAt: 1_793_032_200_000, window: null });
    expect(limitFromText('Claude AI usage limit reached | 1793032200000')?.resetsAt).toBe(1_793_032_200_000);
  });

  it('"5-hour limit reached ∙ resets 3pm": a janela, sem hora (o "3pm" não tem data nem fuso)', () => {
    expect(limitFromText('5-hour limit reached ∙ resets 3pm')).toEqual({ resetsAt: null, window: 'five_hour' });
  });

  it('"You\'ve hit your limit · resets 3pm (America/Sao_Paulo)"', () => {
    expect(limitFromText("You've hit your limit · resets 3pm (America/Sao_Paulo)")).toEqual({ resetsAt: null, window: null });
    expect(limitFromText('You’ve hit your limit')).toEqual({ resetsAt: null, window: null });
  });

  it('"Session limit reached" é a janela de 5h; "Weekly limit reached", a de 7 dias', () => {
    expect(limitFromText('Session limit reached')).toEqual({ resetsAt: null, window: 'five_hour' });
    expect(limitFromText('Weekly limit reached')).toEqual({ resetsAt: null, window: 'seven_day' });
    expect(limitFromText('Weekly limit reached ∙ resets Nov 8, 3pm')?.window).toBe('seven_day');
  });

  it('maiúsculas e minúsculas não importam', () => {
    expect(limitFromText('USAGE LIMIT REACHED')).not.toBeNull();
    expect(limitFromText('you have hit your limit')).not.toBeNull();
    expect(limitFromText('YOU HIT YOUR LIMIT')).not.toBeNull();
    expect(limitFromText('  weekly LIMIT reached  ')).not.toBeNull();
  });

  it('não confunde com outras coisas', () => {
    // Janela de contexto da conversa, não a assinatura.
    expect(limitFromText('Context limit reached ∙ /compact or /clear to continue')).toBeNull();
    expect(limitFromText('Login expired · Please run /login')).toBeNull();
    expect(limitFromText('')).toBeNull();
    expect(limitFromText(42)).toBeNull();
    expect(limitFromText(undefined)).toBeNull();
    // Conversa que só fala do assunto.
    expect(limitFromText(`Vou tratar o caso em que o usage limit reached aparece. ${'texto '.repeat(100)}`)).toBeNull();
  });

  it('mergeHits fica com a hora e a janela que um deles souber', () => {
    expect(mergeHits(null, { resetsAt: 5, window: null })).toEqual({ resetsAt: 5, window: null });
    expect(mergeHits({ resetsAt: 5, window: null }, { resetsAt: null, window: 'seven_day' })).toEqual({ resetsAt: 5, window: 'seven_day' });
    expect(mergeHits({ resetsAt: 5, window: 'five_hour' }, { resetsAt: 9, window: 'seven_day' })).toEqual({ resetsAt: 5, window: 'five_hour' });
  });
});

describe('resumePlan: a hora de voltar', () => {
  const now = Date.parse('2026-11-02T12:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();

  it('a hora que o claude disse, mais 1 minuto de folga', () => {
    const plan = resumePlan({ resetsAt: now + 3_600_000, window: 'five_hour' }, [], now);
    expect(plan).toEqual({ resetsAt: now + 3_600_000, at: now + 3_600_000 + SLACK_MS, source: 'reported' });
  });

  it('sem hora: o reset mais próximo no futuro das janelas conhecidas', () => {
    const known = [
      { kind: 'five_hour', resetsAt: iso(now + 7_200_000) },
      { kind: 'seven_day', resetsAt: iso(now + 86_400_000) },
    ];
    expect(resumePlan({ resetsAt: null, window: null }, known, now)).toEqual({ resetsAt: now + 7_200_000, at: now + 7_200_000 + SLACK_MS, source: 'window' });
  });

  it('janela já virada (reset no passado) e sem data não contam', () => {
    const known = [
      { kind: 'five_hour', resetsAt: iso(now - 1_000) },
      { kind: 'seven_day', resetsAt: iso(now + 86_400_000) },
      { kind: 'other', resetsAt: null },
    ];
    expect(resumePlan({ resetsAt: null, window: null }, known, now).resetsAt).toBe(now + 86_400_000);
  });

  it('sabendo qual janela estourou, vale o reset dela, não o da outra que volta antes', () => {
    const known = [
      { kind: 'five_hour', resetsAt: iso(now + 3_600_000) },
      { kind: 'seven_day', resetsAt: iso(now + 86_400_000) },
    ];
    expect(resumePlan({ resetsAt: null, window: 'seven_day' }, known, now).resetsAt).toBe(now + 86_400_000);
    // A janela dita não está entre as conhecidas: cai no mais próximo.
    expect(resumePlan({ resetsAt: null, window: 'seven_day' }, [known[0]!], now).resetsAt).toBe(now + 3_600_000);
  });

  it('hora que já passou não serve (mandaria na hora e bateria de novo): usa as janelas', () => {
    const plan = resumePlan({ resetsAt: now - 5_000, window: null }, [{ kind: 'five_hour', resetsAt: iso(now + 600_000) }], now);
    expect(plan).toMatchObject({ resetsAt: now + 600_000, source: 'window' });
  });

  it('sem nada conhecido: tenta de novo em 30 minutos', () => {
    expect(resumePlan({ resetsAt: null, window: null }, [], now)).toEqual({ resetsAt: now + RETRY_MS, at: now + RETRY_MS, source: 'fallback' });
    expect(RETRY_MS).toBe(30 * 60_000);
  });

  it('o "continue" nunca sai antes de 1 minuto, mesmo com hora no passado', () => {
    for (const hit of [{ resetsAt: now - 1, window: null }, { resetsAt: null, window: null }, { resetsAt: now + 1, window: null }]) {
      expect(resumePlan(hit, [], now).at - now).toBeGreaterThanOrEqual(SLACK_MS);
    }
  });
});

describe('textos do aviso', () => {
  it('hoje: só a hora; outro dia: com o dia (hora desta máquina)', () => {
    const now = new Date(2026, 10, 2, 12, 0).getTime();
    expect(clockText(new Date(2026, 10, 2, 15, 0).getTime(), now)).toBe('às 15:00');
    expect(clockText(new Date(2026, 10, 2, 9, 5).getTime(), now)).toBe('às 09:05');
    expect(clockText(new Date(2026, 10, 8, 15, 0).getTime(), now)).toBe('dia 08/11 às 15:00');
    expect(limitNotice.waiting(new Date(2026, 10, 2, 15, 0).getTime(), now)).toBe('Limite de uso atingido. Continua sozinha às 15:00.');
    expect(limitNotice.back(new Date(2026, 10, 2, 15, 0).getTime(), now)).toBe('Limite de uso atingido. Volta às 15:00.');
    expect(limitNotice.continued(new Date(2026, 10, 2, 15, 1).getTime())).toBe('Continuou sozinha às 15:01.');
  });
});

describe('ChatProcess: avisa quando o turno parou no limite de uso', () => {
  function proc() {
    const hits: LimitHit[] = [];
    const chat = new ChatProcess({ sessionId: 's1', cwd: '.', args: [], onUsageLimit: (h) => hits.push(h) });
    return { chat, hits };
  }
  const synthetic = (text: string, over: Record<string, unknown> = {}) => ({
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'rate_limit',
    message: { id: 'e1', model: '<synthetic>', content: [{ type: 'text', text }] },
    ...over,
  });

  it('evento rejected + turno com erro: uma vez, com a hora do evento', () => {
    const { chat, hits } = proc();
    chat.handle(rejected());
    chat.handle({ type: 'result', is_error: true, result: 'Something failed' });
    expect(hits).toEqual([{ resetsAt: 1_793_032_200_000, window: 'five_hour' }]);
  });

  it('evento, texto do assistente e texto do result no mesmo turno: uma vez só, com a hora que tiver', () => {
    const { chat, hits } = proc();
    chat.handle(synthetic('Session limit reached'));
    chat.handle(rejected({ rateLimitType: 'five_hour' }));
    chat.handle(synthetic("You've hit your limit · resets 3pm"));
    chat.handle({ type: 'result', is_error: true, result: "You've hit your limit · resets 3pm" });
    expect(hits).toEqual([{ resetsAt: 1_793_032_200_000, window: 'five_hour' }]);
  });

  it('só o texto no result (turno com erro)', () => {
    const { chat, hits } = proc();
    chat.handle({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|1793032200' });
    expect(hits).toEqual([{ resetsAt: 1_793_032_200_000, window: null }]);
  });

  it('só o texto da mensagem do assistente (sem hora)', () => {
    const { chat, hits } = proc();
    chat.handle(synthetic('Weekly limit reached'));
    chat.handle({ type: 'result', is_error: true, result: 'x' });
    expect(hits).toEqual([{ resetsAt: null, window: 'seven_day' }]);
  });

  it('o evento rejected sozinho, com o turno terminando bem, não é limite estourado', () => {
    const { chat, hits } = proc();
    chat.handle(rejected());
    chat.handle({ type: 'result', is_error: false });
    expect(hits).toEqual([]);
    // E não vaza para o turno seguinte.
    chat.handle({ type: 'result', is_error: true, result: 'outro erro' });
    expect(hits).toEqual([]);
  });

  it('allowed e allowed_warning não disparam, mesmo com o turno em erro', () => {
    const { chat, hits } = proc();
    chat.handle(rejected({ status: 'allowed_warning' }));
    chat.handle({ type: 'result', is_error: true, result: 'falhou' });
    expect(hits).toEqual([]);
  });

  it('o assistente falando do assunto (resposta normal) não dispara', () => {
    const { chat, hits } = proc();
    chat.handle({ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Weekly limit reached' }] } });
    chat.handle({ type: 'result', is_error: false, result: 'Weekly limit reached' });
    expect(hits).toEqual([]);
  });

  it('erro de contexto cheio não é o limite da assinatura', () => {
    const { chat, hits } = proc();
    chat.handle(synthetic('Context limit reached ∙ /compact or /clear to continue'));
    chat.handle({ type: 'result', is_error: true, result: 'Context limit reached ∙ /compact or /clear to continue' });
    expect(hits).toEqual([]);
  });

  it('evento de subagent fica de fora', () => {
    const { chat, hits } = proc();
    chat.handle({ ...rejected(), parent_tool_use_id: 'tu1' });
    chat.handle({ type: 'result', is_error: true, result: 'x' });
    expect(hits).toEqual([]);
  });

  it('cada turno conta por si', () => {
    const { chat, hits } = proc();
    chat.handle(rejected());
    chat.handle({ type: 'result', is_error: true, result: 'x' });
    chat.handle(rejected({ resetsAt: 1_793_050_000 }));
    chat.handle({ type: 'result', is_error: true, result: 'x' });
    expect(hits.map((h) => h.resetsAt)).toEqual([1_793_032_200_000, 1_793_050_000_000]);
  });
});

describe('ChatProcess: turno interrompido por você não agenda "continue"', () => {
  /** Um processo de verdade (com o claude de mentira), para poder mandar e interromper. */
  function started() {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: 4242, kill: () => child.emit('exit', 0) });
    const hits: LimitHit[] = [];
    let normal = 0;
    const chat = new ChatProcess({
      sessionId: 's1',
      cwd: '.',
      args: [],
      spawnImpl: (() => child) as never,
      onUsageLimit: (h) => hits.push(h),
      onTurnWithoutLimit: () => void normal++,
    });
    chat.start();
    return { chat, hits, normal: () => normal };
  }
  const interruptedByLimitText = { type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your limit · resets 3pm" };

  it('rejected e depois o turno parado por interromper: não agenda, e conta como turno sem limite', () => {
    const { chat, hits, normal } = started();
    chat.send('faz algo longo');
    chat.handle(rejected());
    chat.interrupt();
    chat.handle({ type: 'result', subtype: 'error_during_execution', is_error: true });
    expect(hits).toEqual([]);
    expect(normal()).toBe(1);
  });

  it('o texto do limite no result de um turno que você interrompeu também não agenda', () => {
    const { chat, hits } = started();
    chat.send('faz algo longo');
    chat.interrupt();
    chat.handle(interruptedByLimitText);
    expect(hits).toEqual([]);
  });

  it('mensagem "now" por cima do turno também interrompe: não agenda', () => {
    const { chat, hits } = started();
    chat.send('faz algo longo');
    chat.handle(rejected());
    chat.send('para e responde isto', 'now');
    chat.handle({ type: 'result', subtype: 'error_during_execution', is_error: true });
    expect(hits).toEqual([]);
  });

  it('a interrupção vale só para aquele turno: o seguinte, que estoura de verdade, agenda', () => {
    const { chat, hits, normal } = started();
    chat.send('faz algo longo');
    chat.interrupt();
    chat.handle(interruptedByLimitText);
    chat.send('outra');
    chat.handle(rejected());
    chat.handle({ type: 'result', is_error: true, result: "You've hit your limit · resets 3pm" });
    expect(hits).toHaveLength(1);
    expect(normal()).toBe(1);
  });

  it('turno normal e turno com outro erro avisam onTurnWithoutLimit; o que estourou, não', () => {
    const { chat, hits, normal } = started();
    chat.send('a');
    chat.handle({ type: 'result', is_error: false });
    chat.send('b');
    chat.handle({ type: 'result', is_error: true, result: 'falhou por outro motivo' });
    expect(normal()).toBe(2);
    chat.send('c');
    chat.handle(rejected());
    chat.handle({ type: 'result', is_error: true, result: 'x' });
    expect(hits).toHaveLength(1);
    expect(normal()).toBe(2);
  });
});
