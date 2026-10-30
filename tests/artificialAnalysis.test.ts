import { describe, expect, it, vi } from 'vitest';
import { ArtificialAnalysis, pickTop } from '../server/adapters/artificialAnalysis';

const model = (id: string, index: number | null, price: number | null) => ({
  id,
  name: `Modelo ${id}`,
  slug: id,
  model_creator: { name: 'Anthropic', slug: 'anthropic' },
  evaluations: { artificial_analysis_coding_index: index },
  pricing: { price_1m_blended_3_to_1: price },
});
const ok = (data: unknown[]) => new Response(JSON.stringify({ status: 200, data }), { status: 200 });
/** Modelo com os dois índices (código e inteligência), ambos opcionais. */
const both = (id: string, coding: number | null, intelligence: number | null, price = 1) => ({
  ...model(id, coding, price),
  evaluations: { artificial_analysis_coding_index: coding, artificial_analysis_intelligence_index: intelligence },
});

function setup(responses: Array<Response | Error>, key: string | null = 'chave-de-teste-123') {
  let now = 1_000_000;
  const fetch = vi.fn(async () => {
    const r = responses.shift() ?? new Error('acabaram as respostas');
    if (r instanceof Error) throw r;
    return r;
  });
  const aa = new ArtificialAnalysis({
    fetch: fetch as unknown as typeof globalThis.fetch,
    readKey: async () => key,
    now: () => now,
    sleep: async () => {},
  });
  return { aa, fetch, advance: (ms: number) => (now += ms) };
}

describe('pickTop', () => {
  it('fica com os de maior índice que têm índice e preço, e ignora itens fora do formato', () => {
    const top = pickTop([model('a', 40, 1), model('b', null, 2), model('c', 60, null), model('d', 55, 3), { id: 1 }], 2).models;
    expect(top.map((m) => m.id)).toEqual(['d', 'a']);
    const variant = { id: 'd', effort: null, codingIndex: 55, priceBlended: 3 };
    expect(top[0]).toEqual({ ...variant, name: 'Modelo d', creator: 'Anthropic', variants: [variant] });
  });

  it('só Claude e OpenAI', () => {
    const from = (id: string, slug: string) => ({ ...model(id, 60, 1), model_creator: { name: slug, slug } });
    expect(pickTop([from('a', 'anthropic'), from('o', 'openai'), from('g', 'google'), { ...model('x', 90, 1), model_creator: null }]).models.map((m) => m.id)).toEqual([
      'a',
      'o',
    ]);
  });

  it('junta os esforços de um modelo e mostra o padrão do AA (slug sem sufixo), com todos do menor ao maior', () => {
    const v = (slug: string, name: string, index: number) => ({ ...model(slug, index, 1), name, slug });
    const top = pickTop([
      v('x-high', 'Modelo X (High)', 70),
      v('x', 'Modelo X (Max, Default Fallback)', 75),
      v('x-low', 'Modelo X (Low)', 60),
      // Outra versão, não outro esforço: fica separada e com o nome inteiro.
      v('y', 'Modelo Y (0902)', 72),
      v('y-0803', 'Modelo Y', 65),
    ]).models;
    expect(top.map((m) => [m.id, m.name, m.effort, m.codingIndex])).toEqual([
      ['x', 'Modelo X', 'max', 75],
      ['y', 'Modelo Y (0902)', null, 72],
      ['y-0803', 'Modelo Y', null, 65],
    ]);
    expect(top[0]!.variants.map((x) => x.effort)).toEqual(['low', 'high', 'max']);
  });

  it('sem a variante principal na resposta, vale o esforço de maior índice', () => {
    const v = (slug: string, index: number) => ({ ...model(slug, index, 1), name: 'Modelo Z', slug });
    const [z] = pickTop([v('z-low', 50), v('z-high', 58), v('z-medium', 55)]).models;
    expect([z!.id, z!.effort, z!.variants.length]).toEqual(['z-high', 'high', 3]);
  });

  it('sem nenhum índice de código, usa o de inteligência para a lista inteira', () => {
    const r = pickTop([both('a', null, 50), both('b', null, 70), both('c', null, null)]);
    expect(r.metric).toBe('intelligence');
    expect(r.models.map((m) => [m.id, m.codingIndex])).toEqual([
      ['b', 70],
      ['a', 50],
    ]);
  });

  it('com algum índice de código, a lista é de código e deixa de fora quem só tem o de inteligência', () => {
    const r = pickTop([both('a', 40, 90), both('b', null, 99), both('c', 60, 10)]);
    expect(r.metric).toBe('coding');
    expect(r.models.map((m) => [m.id, m.codingIndex])).toEqual([
      ['c', 60],
      ['a', 40],
    ]);
  });

  it('sem nenhum índice, a lista vem vazia e a métrica é null', () => {
    expect(pickTop([both('a', null, null), model('b', null, 1)])).toEqual({ metric: null, models: [] });
  });
});

describe('ArtificialAnalysis', () => {
  it('sem chave no .env não chama a API', async () => {
    const { aa, fetch } = setup([], null);
    expect(await aa.get(true)).toEqual({ configured: false, metric: null, models: [], fetchedAt: null, error: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('manda a chave só no cabeçalho e guarda a resposta', async () => {
    const { aa, fetch, advance } = setup([ok([model('a', 50, 1)])]);
    const first = await aa.get(true);
    expect(first.models).toHaveLength(1);
    expect(first.error).toBeNull();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('chave');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('chave-de-teste-123');
    // Atualizar de novo antes de 1 min, ou abrir sem atualizar dentro das 6 h, não busca.
    advance(30_000);
    await aa.get(true);
    advance(60 * 60_000);
    await aa.get(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('repete falha passageira e entrega quando a API volta', async () => {
    const { aa, fetch } = setup([new Error('ECONNRESET'), new Response('', { status: 503 }), ok([model('a', 50, 1)])]);
    const r = await aa.get(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(r.models).toHaveLength(1);
    expect(r.error).toBeNull();
  });

  it('chave recusada não é repetida e a mensagem não mostra a chave', async () => {
    const { aa, fetch } = setup([new Response('', { status: 401 })]);
    const r = await aa.get(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r.error).toMatch(/chave recusada/);
    expect(r.error).not.toContain('chave-de-teste-123');
  });

  it('falhando, mantém os dados anteriores; 3 buscas seguidas falhando abrem o disjuntor por 5 min', async () => {
    const fail = () => new Response('', { status: 500 });
    const { aa, fetch, advance } = setup([ok([model('a', 50, 1)]), ...Array.from({ length: 9 }, fail), ok([model('b', 70, 2)])]);
    await aa.get(true);
    for (let i = 0; i < 3; i++) {
      advance(61_000);
      const r = await aa.get(true);
      expect(r.models.map((m) => m.id)).toEqual(['a']);
      expect(r.error).toMatch(/500/);
    }
    expect(fetch).toHaveBeenCalledTimes(1 + 9);
    advance(61_000);
    expect((await aa.get(true)).error).toMatch(/nova tentativa/);
    expect(fetch).toHaveBeenCalledTimes(10);
    advance(5 * 60_000);
    expect((await aa.get(true)).models.map((m) => m.id)).toEqual(['b']);
  });

  it('o ranking leva a métrica usada', async () => {
    const { aa } = setup([ok([both('a', null, 50)])]);
    expect(await aa.get(true)).toMatchObject({ metric: 'intelligence', models: [{ id: 'a', codingIndex: 50 }] });
  });
});
