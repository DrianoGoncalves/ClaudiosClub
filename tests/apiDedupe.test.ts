import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../client/src/api';

// GETs iguais em voo ao mesmo tempo dividem uma ida ao servidor (client/src/api.ts, `sharedFetch`); cada um recebe o próprio objeto.

const list = [{ id: 't-1', title: 'a' }];

/** fetch que só responde quando `release()` é chamado: os pedidos ficam em voo juntos. */
function heldFetch() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fn = vi.fn(async () => {
    await gate;
    return new Response(JSON.stringify(list), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { fn, release };
}

describe('GET em voo dividido (sharedFetch)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('três pedidos da mesma URL juntos: uma ida só; leitura comum: cada um com a própria cópia', async () => {
    const f = heldFetch();
    vi.stubGlobal('fetch', f.fn);
    const pending = [api.live(), api.live(), api.live()];
    f.release();
    const [a, b, c] = await Promise.all(pending);
    expect(f.fn).toHaveBeenCalledTimes(1);
    expect(a).toEqual(list);
    expect(b).toEqual(list);
    expect(a).not.toBe(b); // objetos diferentes: mexer num não muda o outro
    expect(b).not.toBe(c);
  });

  it('URLs diferentes não se juntam; depois da resposta, o próximo pedido vai ao servidor', async () => {
    const f = heldFetch();
    vi.stubGlobal('fetch', f.fn);
    const pending = [api.tasks('p1'), api.tasks('p2')];
    f.release();
    await Promise.all(pending);
    expect(f.fn).toHaveBeenCalledTimes(2);
    await api.tasks('p1');
    expect(f.fn).toHaveBeenCalledTimes(3);
  });

  it('a releitura depois de uma escrita não pega carona num GET que saiu antes dela (o cartão arrastado não "volta")', async () => {
    const f = heldFetch();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => (init?.method === 'POST' ? new Response('{}', { status: 200 }) : f.fn()));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { dispatchEvent: () => true }); // o POST avisa o pareamento por evento
    const before = api.tasks('p-escrita'); // o polling, em voo
    await api.updateTask('p-escrita', 't-1', { status: 'done' }); // a escrita termina com o GET ainda em voo
    const after = api.tasks('p-escrita'); // a releitura de depois da escrita
    f.release();
    await Promise.all([before, after]);
    const gets = fetchMock.mock.calls.filter(([, init]) => !init || !init.method || init.method === 'GET');
    expect(gets).toHaveLength(2); // ida própria, não a resposta de antes
  });

  it('leitura estável (o polling do quadro): resposta igual devolve o mesmo objeto; resposta nova, objeto novo', async () => {
    let body = JSON.stringify(list);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const first = await api.tasks('p-estavel');
    const again = await api.tasks('p-estavel');
    expect(again).toBe(first); // mesmo texto: a mesma referência, e o setState do React não redesenha
    body = JSON.stringify([{ id: 't-1', title: 'mudou' }]);
    const changed = await api.tasks('p-estavel');
    expect(changed).not.toBe(first);
    expect(changed).toEqual([{ id: 't-1', title: 'mudou' }]);
    expect(await api.tasks('p-outro')).not.toBe(changed); // outra URL, outra entrada
  });

  it('falha de rede não fica guardada: a tentativa seguinte faz um fetch novo', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls === 1) throw new TypeError('rede');
        return new Response(JSON.stringify(list), { status: 200 });
      }),
    );
    expect(await api.tasks('p1')).toEqual(list); // a 1ª tentativa falha, o get tenta de novo
    expect(calls).toBe(2);
  });
});
