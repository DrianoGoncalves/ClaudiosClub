import { describe, expect, it } from 'vitest';
import { STAFF_SEND_MAX, STAFF_SEND_WINDOW_MS, StaffSendLimitError, StaffSendRate, sendTargetKey } from '../server/chat/sendRate';

// Freio contra laço entre funcionários: 20 mensagens por conversa de destino em 30 min; a 21ª recusa (429 na rota).
// Relógio injetado: `now` avança à mão.

const T0 = Date.parse('2026-11-12T10:00:00');
const MIN = 60_000;
const KEY = 'p1:s-destino';

function rateAt() {
  let now = T0;
  const rate = new StaffSendRate(() => now);
  return {
    rate,
    at: (t: number) => (now = t),
    /** Conta `n` mensagens seguidas, no relógio atual. */
    fill: (n: number, key = KEY) => {
      for (let i = 0; i < n; i++) rate.count(key);
    },
  };
}

/** Quanto a mensagem recusada precisa esperar (ou null se não foi recusada). */
function refusal(fn: () => void): number | null {
  try {
    fn();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(StaffSendLimitError);
    return (err as StaffSendLimitError).retryAfter;
  }
}

describe('constantes', () => {
  it('20 mensagens em 30 min', () => {
    expect(STAFF_SEND_MAX).toBe(20);
    expect(STAFF_SEND_WINDOW_MS).toBe(30 * MIN);
  });
});

describe('StaffSendRate', () => {
  it('deixa passar 20 mensagens e recusa a 21ª', () => {
    const { rate, fill } = rateAt();
    fill(20);
    expect(refusal(() => rate.count(KEY))).not.toBeNull();
  });

  it('a recusa não entra na conta: depois de sair uma da janela, cabe outra', () => {
    const { rate, at, fill } = rateAt();
    fill(20);
    expect(refusal(() => rate.count(KEY))).not.toBeNull();
    expect(refusal(() => rate.count(KEY))).not.toBeNull();
    at(T0 + STAFF_SEND_WINDOW_MS);
    expect(refusal(() => rate.count(KEY))).toBeNull();
    // Só entrou uma: a 20ª de novo está na janela, a 21ª recusa.
    fill(19);
    expect(refusal(() => rate.count(KEY))).not.toBeNull();
  });

  it('Retry-After: segundos até a mais antiga sair da janela', () => {
    const { rate, at, fill } = rateAt();
    fill(20);
    at(T0 + 10 * MIN);
    expect(refusal(() => rate.count(KEY))).toBe(20 * 60);
  });

  it('Retry-After arredonda para cima (não avisa antes da hora)', () => {
    const { rate, at, fill } = rateAt();
    fill(20);
    at(T0 + 1_500); // faltam 1798,5 s
    expect(refusal(() => rate.count(KEY))).toBe(1799);
    at(T0 + 1_500 + 1799 * 1000);
    expect(refusal(() => rate.count(KEY))).toBeNull();
  });

  it('Retry-After usa a mensagem mais antiga, não a última', () => {
    const { rate, at } = rateAt();
    rate.count(KEY); // T0
    at(T0 + 5 * MIN);
    for (let i = 0; i < 19; i++) rate.count(KEY); // 19 em T0+5 min
    at(T0 + 6 * MIN);
    // A janela tem 20; a mais antiga (T0) sai em 24 min.
    expect(refusal(() => rate.count(KEY))).toBe(24 * 60);
  });

  it('a janela anda com o relógio: a mensagem sai exatamente aos 30 min', () => {
    const { rate, at, fill } = rateAt();
    fill(20);
    at(T0 + STAFF_SEND_WINDOW_MS - 1);
    expect(refusal(() => rate.count(KEY))).not.toBeNull();
    at(T0 + STAFF_SEND_WINDOW_MS);
    expect(refusal(() => rate.count(KEY))).toBeNull();
  });

  it('janela anda de verdade: mensagens espaçadas, só as da última meia hora contam', () => {
    const { rate, at } = rateAt();
    // 20 mensagens a cada minuto, por 20 min: ainda dentro de 30 min, então a 21ª recusa.
    for (let i = 0; i < 20; i++) {
      at(T0 + i * MIN);
      rate.count(KEY);
    }
    at(T0 + 20 * MIN);
    expect(refusal(() => rate.count(KEY))).not.toBeNull();
    // Em T0+30 min sai só a de T0 (as de T0+1 a T0+19 ainda contam): cabe uma, a seguinte recusa.
    at(T0 + 30 * MIN);
    expect(refusal(() => rate.count(KEY))).toBeNull();
    expect(refusal(() => rate.count(KEY))).not.toBeNull();
  });

  it('o dono zera a janela da conversa dele', () => {
    const { rate, fill } = rateAt();
    fill(20);
    expect(refusal(() => rate.count(KEY))).not.toBeNull();
    rate.reset(KEY);
    fill(20);
    expect(refusal(() => rate.count(KEY))).not.toBeNull();
  });

  it('o dono de uma conversa não zera as outras', () => {
    const { rate, fill } = rateAt();
    fill(20, 'p1:a');
    fill(20, 'p1:b');
    rate.reset('p1:a');
    expect(refusal(() => rate.count('p1:a'))).toBeNull();
    expect(refusal(() => rate.count('p1:b'))).not.toBeNull();
  });

  it('destinos independentes: uma conversa cheia não trava a outra', () => {
    const { rate, fill } = rateAt();
    fill(20, 'p1:a');
    expect(refusal(() => rate.count('p1:a'))).not.toBeNull();
    fill(20, 'p1:b');
    expect(refusal(() => rate.count('p1:b'))).not.toBeNull();
  });

  it('sem conversa (nova da ficha): o freio vale pela ficha, não escapa abrindo conversa nova', () => {
    const { rate, fill } = rateAt();
    fill(20, sendTargetKey('p1', null, 'ficha-x'));
    expect(refusal(() => rate.count(sendTargetKey('p1', null, 'ficha-x')))).not.toBeNull();
    // Outra ficha tem a própria janela.
    expect(refusal(() => rate.count(sendTargetKey('p1', null, 'ficha-y')))).toBeNull();
  });
});

describe('sendTargetKey', () => {
  it('conversa existente: chave pelo projeto e pela sessão', () => {
    expect(sendTargetKey('p1', 's-1', 'ficha-x')).toBe('p1:s-1');
    expect(sendTargetKey('p1', 's-1', null)).toBe('p1:s-1');
    expect(sendTargetKey('p2', 's-1', 'ficha-x')).not.toBe(sendTargetKey('p1', 's-1', 'ficha-x'));
  });
});
