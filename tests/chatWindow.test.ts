import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../shared/model';
import { applyLive, mergeItems, renderWindow, WINDOW_STEP } from '../client/src/chat/chatWindow';

const msg = (n: number): ChatItem => ({ kind: 'assistant', id: `a:${n}`, text: `resposta ${n}`, at: null });
const run = (n: number, result: string | null = null): ChatItem => ({ kind: 'tool', id: `t:${n}`, name: 'Bash', summary: 'ls', input: '', result, isError: false, at: null });
const ask = (n: number, status: 'pending' | 'allowed' = 'pending'): ChatItem => ({ kind: 'permission', id: `p:${n}`, tool: 'Bash', summary: 'rm', description: null, input: '', status, at: null });
const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => msg(from + i));
const idsOf = (items: ChatItem[]) => items.map((i) => i.id);

describe('conversa ao vivo na tela: o stream se aplica ao que veio no snapshot', () => {
  it('o passo da janela é 200', () => {
    expect(WINDOW_STEP).toBe(200);
  });

  it('item novo entra no fim; o mesmo id troca o item (o texto recomeça)', () => {
    const a = msg(1);
    const out = applyLive([a], { type: 'item', seq: 5, item: msg(2) });
    expect(idsOf(out)).toEqual(['a:1', 'a:2']);
    const swapped = applyLive(out, { type: 'item', seq: 6, item: { kind: 'assistant', id: 'a:1', text: 'de novo', at: null } });
    expect(swapped.map((i) => (i.kind === 'assistant' ? i.text : ''))).toEqual(['de novo', 'resposta 2']);
  });

  it('delta soma ao texto da resposta; para id que não existe ou não é resposta, nada muda', () => {
    const items = [msg(1), run(1)];
    const out = applyLive(items, { type: 'delta', seq: 3, id: 'a:1', text: '!' });
    expect(out[0]).toMatchObject({ text: 'resposta 1!' });
    expect(applyLive(items, { type: 'delta', seq: 4, id: 'a:9', text: 'x' })).toEqual(items);
    expect(applyLive(items, { type: 'delta', seq: 5, id: 't:1', text: 'x' })).toEqual(items);
  });

  it('evento de estado não mexe nos itens', () => {
    const items = [msg(1)];
    expect(applyLive(items, { type: 'state', seq: 2, state: {} as never })).toBe(items);
  });

  it('a tela não corta o que chega (o histórico não alcançaria o que saísse do meio)', () => {
    let items: ChatItem[] = [];
    for (let i = 0; i < 1_000; i++) items = applyLive(items, { type: 'item', seq: i + 1, item: msg(i) });
    expect(items).toHaveLength(1_000);
    expect(items[0]!.id).toBe('a:0');
  });
});

describe('histórico + ao vivo + guardadas', () => {
  it('junta na ordem e, se o mesmo id está nos dois (a emenda), fica o ao vivo', () => {
    const history = [msg(1), run(2), msg(3)];
    const live = [run(2, 'pronto'), msg(4)];
    const held: ChatItem = { kind: 'user', id: 'h:1', text: 'oi', at: null, held: 'ocupado' };
    const out = mergeItems(history, live, [held]);
    expect(idsOf(out)).toEqual(['a:1', 'a:3', 't:2', 'a:4', 'h:1']);
    expect(out[2]).toMatchObject({ result: 'pronto' });
  });

  it('sem nada ao vivo: histórico e guardadas', () => {
    expect(idsOf(mergeItems([msg(1)], [], [msg(2)]))).toEqual(['a:1', 'a:2']);
  });
});

describe('janela da lista: só o fim é pintado', () => {
  it('lista curta: pinta tudo, sem botão', () => {
    const items = many(50);
    expect(renderWindow(items, WINDOW_STEP)).toEqual({ items, hidden: 0, shown: 50 });
  });

  it('lista comprida: pinta os últimos 200 e diz quantos ficaram de fora', () => {
    const items = many(530);
    const w = renderWindow(items, WINDOW_STEP);
    expect(w.items).toHaveLength(200);
    expect(w.items[0]!.id).toBe('a:330');
    expect(w.items.at(-1)!.id).toBe('a:529');
    expect(w.hidden).toBe(330);
    expect(w.shown).toBe(200);
  });

  it('cada clique em "mostrar anteriores" traz mais 200 (o último traz só o que resta)', () => {
    const items = many(530);
    const second = renderWindow(items, 200 + WINDOW_STEP);
    expect(second.items).toHaveLength(400);
    expect(second.hidden).toBe(130);
    const third = renderWindow(items, 200 + 2 * WINDOW_STEP);
    expect(third.items).toBe(items);
    expect(third.hidden).toBe(0);
  });

  it('o balão em foco fora da janela abre a janela até ele (e devolve o tamanho para guardar)', () => {
    const items = many(530);
    const w = renderWindow(items, WINDOW_STEP, ['a:100']);
    expect(w.items[0]!.id).toBe('a:100');
    expect(w.items).toHaveLength(430);
    expect(w.shown).toBe(430);
    expect(w.hidden).toBe(100);
    // Guardado o tamanho, a janela não encolhe quando o foco acaba.
    expect(renderWindow(items, w.shown).items[0]!.id).toBe('a:100');
  });

  it('foco dentro da janela, sem id ou com id que não está na lista: a janela não muda', () => {
    const items = many(530);
    for (const anchors of [['a:500'], [null, undefined], ['a:nao-existe']]) {
      const w = renderWindow(items, WINDOW_STEP, anchors);
      expect(w.items).toHaveLength(200);
      expect(w.shown).toBe(200);
    }
  });

  it('com vários focos vale o mais antigo', () => {
    const w = renderWindow(many(530), WINDOW_STEP, ['a:400', 'a:250', null]);
    expect(w.items[0]!.id).toBe('a:250');
  });

  it('pedido sem resposta antigo é pintado mesmo fora da janela, no lugar dele, e não conta como escondido', () => {
    const items = [msg(0), ask(1), msg(2), ask(3, 'allowed'), ...many(300, 10)];
    const w = renderWindow(items, WINDOW_STEP);
    expect(idsOf(w.items).slice(0, 2)).toEqual(['p:1', 'a:110']);
    expect(w.items).toHaveLength(201);
    expect(w.items.some((i) => i.id === 'p:3')).toBe(false); // respondido: some com os outros
    expect(w.hidden).toBe(items.length - 200 - 1);
  });
});
