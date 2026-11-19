import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, isPairingError, NEEDS_PAIRING_EVENT } from '../client/src/api';

// GET de navegador não pareado (t-2d101e): o servidor responde 401 `needs-pairing` (server/gate.ts) e a tela sobe o aviso de parear no lugar do erro.

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('GET recusado por falta de pareamento', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('get: 401 needs-pairing sobe o aviso de parear e o erro sai sem texto, como o do POST', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('fetch', answer(401, { error: 'este navegador não está pareado', code: 'needs-pairing' }));
    vi.stubGlobal('window', { dispatchEvent });
    const err = await api.board().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(isPairingError(err)).toBe(true);
    expect((err as ApiError).message).toBe('');
    expect((err as ApiError).status).toBe(401);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect((dispatchEvent.mock.calls[0]![0] as Event).type).toBe(NEEDS_PAIRING_EVENT);
  });

  it('getExplained (a leitura com motivo, como os agendamentos): o mesmo aviso e o erro sem texto', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('fetch', answer(401, { error: 'este navegador não está pareado', code: 'needs-pairing' }));
    vi.stubGlobal('window', { dispatchEvent });
    const err = await api.schedules('p1').then(() => null, (e: unknown) => e);
    expect(isPairingError(err)).toBe(true);
    expect((err as ApiError).message).toBe('');
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('outro 401 e outros erros seguem como estavam: sem aviso de parear', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('fetch', answer(401, { error: 'token inválido' }));
    await expect(api.board()).rejects.toThrow('/api/board: 401');
    vi.stubGlobal('fetch', answer(500, { error: 'erro interno' }));
    await expect(api.board()).rejects.toThrow('/api/board: 500');
    vi.stubGlobal('fetch', answer(401, { error: 'token inválido' }));
    const err = await api.schedules('p1').then(() => null, (e: unknown) => e);
    expect((err as ApiError).message).toBe('token inválido');
    expect(isPairingError(err)).toBe(false);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
