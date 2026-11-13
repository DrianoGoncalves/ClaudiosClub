import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollVisible, pollVisibleLoop } from '../client/src/usePoll';

// Sem jsdom: um `document` mínimo, com `hidden` e o evento `visibilitychange`.
let hidden = false;
let listeners: Array<() => void> = [];
const setHidden = (value: boolean) => {
  hidden = value;
  for (const l of [...listeners]) l();
};

beforeEach(() => {
  hidden = false;
  listeners = [];
  vi.useFakeTimers();
  vi.stubGlobal('document', {
    get hidden() {
      return hidden;
    },
    addEventListener: (_: string, l: () => void) => listeners.push(l),
    removeEventListener: (_: string, l: () => void) => (listeners = listeners.filter((x) => x !== l)),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pollVisible', () => {
  it('chama no intervalo com a aba visível', () => {
    const fn = vi.fn();
    const stop = pollVisible(fn, 1000);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(listeners).toHaveLength(0);
  });

  it('para escondida e chama na hora ao voltar', () => {
    const fn = vi.fn();
    pollVisible(fn, 1000);
    setHidden(true);
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
    setHidden(false);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('com hiddenMs desacelera em vez de parar', () => {
    const fn = vi.fn();
    pollVisible(fn, 1000, 5000);
    setHidden(true);
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(2);
    setHidden(false);
    expect(fn).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('montada escondida, só começa ao ficar visível', () => {
    const fn = vi.fn();
    hidden = true;
    pollVisible(fn, 1000);
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
    setHidden(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('pollVisibleLoop', () => {
  it('roda na hora, segue o ritmo devolvido e para com null', async () => {
    const step = vi.fn().mockResolvedValueOnce(1000).mockResolvedValueOnce(2000).mockResolvedValue(null);
    pollVisibleLoop(step);
    await vi.advanceTimersByTimeAsync(0);
    expect(step).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(step).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(step).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(step).toHaveBeenCalledTimes(3);
  });

  it('escondida não consulta; ao voltar consulta na hora', async () => {
    const step = vi.fn().mockResolvedValue(1000);
    pollVisibleLoop(step);
    await vi.advanceTimersByTimeAsync(0);
    hidden = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(step).toHaveBeenCalledTimes(1);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(step).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(step).toHaveBeenCalledTimes(3);
  });

  it('desligar cancela o próximo passo', async () => {
    const step = vi.fn().mockResolvedValue(1000);
    const stop = pollVisibleLoop(step);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(step).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(0);
  });
});
