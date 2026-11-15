import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../shared/model';
import { liveOnlyNotices } from '../client/src/chat/chatWindow';
import { afterSnapshot, planReconnect, reconnectDelay, RECONNECT_MAX_MS, STABLE_OPEN_MS, streamNeed } from '../client/src/chat/reconnect';

const notice = (id: string, text: string, extra: Partial<Extract<ChatItem, { kind: 'notice' }>> = {}): ChatItem => ({ kind: 'notice', id, text, tone: 'warn', at: null, ...extra });
const said = (id: string): ChatItem => ({ kind: 'assistant', id, text: id, at: null });

describe('espera entre tentativas de reconectar', () => {
  it('dobra a cada falha e para em 30 s', () => {
    expect([0, 1, 2, 3, 4, 5].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(reconnectDelay(6)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelay(1000)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelay(-3)).toBe(1000);
  });

  it('falhas seguidas sobem a espera; a primeira queda é discreta, da segunda em diante avisa', () => {
    let failures = 0;
    const seen: Array<[number, boolean]> = [];
    for (let i = 0; i < 8; i++) {
      const plan = planReconnect(failures, true);
      if (plan.kind !== 'retry') throw new Error('com rede, tenta de novo');
      seen.push([plan.delay, plan.lost]);
      failures = plan.failures;
    }
    expect(seen.map(([d]) => d)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(seen.map(([, lost]) => lost)).toEqual([false, true, true, true, true, true, true, true]);
  });

  it('stream que ficou aberto o bastante zera a conta; o que abriu e caiu logo, não', () => {
    expect(planReconnect(5, true, STABLE_OPEN_MS)).toMatchObject({ kind: 'retry', delay: 1000, failures: 1, lost: false });
    expect(planReconnect(5, true, STABLE_OPEN_MS - 1)).toMatchObject({ kind: 'retry', delay: 30000, failures: 6 });
    // Nunca abriu (ou foi o snapshot que falhou): segue a conta.
    expect(planReconnect(2, true, null)).toMatchObject({ kind: 'retry', delay: 4000, failures: 3 });
  });

  it('sem rede não agenda nem gasta tentativa: espera o evento online', () => {
    expect(planReconnect(3, false)).toEqual({ kind: 'wait-online', failures: 3, lost: true });
    // Um stream que durou antes da rede cair recomeça a conta do 1 s quando ela voltar.
    expect(planReconnect(3, false, STABLE_OPEN_MS)).toEqual({ kind: 'wait-online', failures: 0, lost: true });
  });
});

describe('abrir o stream passa pelo snapshot', () => {
  it('sem stream, fechado, ou de outra sessão: precisa do snapshot; aberto ou conectando na mesma sessão: segue', () => {
    expect(streamNeed(null, null, 's1')).toBe('snapshot');
    expect(streamNeed(2, 's1', 's1')).toBe('snapshot');
    expect(streamNeed(1, 's0', 's1')).toBe('snapshot');
    expect(streamNeed(1, 's1', 's1')).toBe('keep');
    expect(streamNeed(0, 's1', 's1')).toBe('keep');
  });

  it('o stream abre depois do seq do snapshot (inclusive 0), nunca do zero sem ele', () => {
    const state = { running: true } as never;
    expect(afterSnapshot({ live: { items: [], seq: 412, state } })).toBe(412);
    expect(afterSnapshot({ live: { items: [], seq: 0, state } })).toBe(0);
    // Sem processo: não há stream a abrir (o transcript tem tudo).
    expect(afterSnapshot({ live: null })).toBeNull();
  });
});

describe('processo que se foi: o que sobra ao vivo', () => {
  it('ficam os avisos que só existem ao vivo; sai o que o histórico já traz', () => {
    const live = [said('a:1'), notice('n:1', 'A conversa terminou com erro', { tone: 'error' }), notice('n:2', 'Conversa compactada', { tone: 'info' }), notice('n:3', 'Bash: permissão negada')];
    const history = [said('a:1'), notice('n:2024', 'Conversa compactada', { tone: 'info' })];
    expect(liveOnlyNotices(live, history).map((i) => i.id)).toEqual(['n:1', 'n:3']);
  });

  it('avisos com botão ou do despertador voltam do que está guardado: não ficam', () => {
    const live = [notice('n:l', 'Limite de uso', { action: 'cancel-auto-continue' }), notice('n:w', 'Despertador', { wake: 'waiting', wakeAt: 1 })];
    expect(liveOnlyNotices(live, [])).toEqual([]);
  });
});
