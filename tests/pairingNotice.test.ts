import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alertError, api, ApiError, attachmentsApi, FileApiError, filesApi, isPairingError, NEEDS_PAIRING_EVENT, PAIRED_EVENT } from '../client/src/api';

// O aviso de navegador não pareado: cada POST recusado com `needs-pairing` liga o aviso do App, um POST que passa o
// tira, e o erro da recusa vem sem texto (o aviso é o único lugar que explica).

const REFUSED = { error: 'este navegador não está pareado: clique em "Parear este navegador"', code: 'needs-pairing' };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let events: string[];
let alert: ReturnType<typeof vi.fn>;
let next: Response;

beforeEach(() => {
  events = [];
  alert = vi.fn();
  const win = Object.assign(new EventTarget(), { alert });
  for (const name of [NEEDS_PAIRING_EVENT, PAIRED_EVENT]) win.addEventListener(name, () => events.push(name));
  vi.stubGlobal('window', win);
  vi.stubGlobal('fetch', vi.fn(async () => next));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('aviso de navegador não pareado', () => {
  it('POST recusado: liga o aviso e o erro vem sem texto, com o código', async () => {
    next = reply(403, REFUSED);
    const err = await api.chatRename('p', 's', 'novo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ message: '', code: 'needs-pairing' });
    expect(isPairingError(err)).toBe(true);
    expect(events).toEqual([NEEDS_PAIRING_EVENT]);
  });

  it('POST que passa tira o aviso; GET não conta', async () => {
    next = reply(200, { ok: true });
    await api.chatRename('p', 's', 'novo');
    expect(events).toEqual([PAIRED_EVENT]);
    next = reply(200, []);
    await api.roles();
    expect(events).toEqual([PAIRED_EVENT]);
  });

  it('outro erro mantém o texto do servidor e não mexe no aviso', async () => {
    next = reply(400, { error: 'nome inválido', code: 'bad-name' });
    const err = await api.chatRename('p', 's', '').catch((e: unknown) => e);
    expect(err).toMatchObject({ message: 'nome inválido', code: 'bad-name' });
    expect(isPairingError(err)).toBe(false);
    expect(events).toEqual([]);
  });

  it('pedir e buscar o pareamento passam sem o cookie: só tiram o aviso quando vem `paired`', async () => {
    next = reply(200, { paired: false, id: 'x', code: 'K7QX-4M2P', terminal: true });
    await api.pairRequest();
    next = reply(200, { paired: false });
    await api.pairClaim('x');
    expect(events).toEqual([]);
    next = reply(200, { paired: true });
    await api.pairClaim('x');
    expect(events).toEqual([PAIRED_EVENT]);
  });

  it('arquivos e anexos: o mesmo aviso, e o erro guarda o status e o código', async () => {
    next = reply(403, REFUSED);
    const write = await filesApi.write('p', 'a.txt', 'oi', 1).catch((e: unknown) => e);
    expect(write).toBeInstanceOf(FileApiError);
    expect(write).toMatchObject({ message: '', status: 403, code: 'needs-pairing' });
    next = reply(403, REFUSED);
    const upload = await attachmentsApi.upload('p', new Blob(['x']), 'a.png').catch((e: unknown) => e);
    expect(upload).toMatchObject({ message: '', status: 403, code: 'needs-pairing' });
    expect(events).toEqual([NEEDS_PAIRING_EVENT, NEEDS_PAIRING_EVENT]);

    // A árvore é GET: passar não prova o pareamento. Gravar, sim.
    next = reply(200, { entries: [] });
    await filesApi.tree('p', '');
    next = reply(200, { mtimeMs: 2 });
    await filesApi.write('p', 'a.txt', 'oi', 1);
    expect(events.at(-1)).toBe(PAIRED_EVENT);
    expect(events).toHaveLength(3);
  });

  it('alertError não abre alerta na recusa por pareamento', () => {
    alertError(new ApiError('', 'needs-pairing', null));
    expect(alert).not.toHaveBeenCalled();
    alertError(new ApiError('falhou', null, null));
    expect(alert).toHaveBeenCalledWith('falhou');
  });
});
