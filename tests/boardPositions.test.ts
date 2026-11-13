import { describe, expect, it } from 'vitest';
import { layoutKey, positionsOf, withMoved, withReset, type PositionStore } from '../client/src/board/positions';

const ws = { workspaces: [{ id: 'part', name: 'Particular', background: null }] } as never;
const empty = (legacy: PositionStore['legacy'] = {}): PositionStore => ({ byTab: {}, legacy, order: {} });

describe('planta por aba', () => {
  it('arrastar numa aba não mexe nas outras', () => {
    const a = withMoved(empty(), 'all', { 'p:x': { x: 1, y: 2 } });
    const b = withMoved(a, 'part', { 'p:x': { x: 9, y: 9 } });
    expect(positionsOf(b, 'all')['p:x']).toEqual({ x: 1, y: 2 });
    expect(positionsOf(b, 'part')['p:x']).toEqual({ x: 9, y: 9 });
  });

  it('reorganizar zera só a aba e não devolve a planta antiga (v3)', () => {
    const start = withMoved(withMoved(empty({ 'p:x': { x: 5, y: 5 } }), 'all', { 'p:y': { x: 1, y: 1 } }), 'part', { 'p:y': { x: 2, y: 2 } });
    const after = withReset(start, 'all', []);
    expect(positionsOf(after, 'all')).toEqual({});
    expect(positionsOf(after, 'part')['p:y']).toEqual({ x: 2, y: 2 });
    expect(positionsOf(withReset(empty({ 'p:x': { x: 5, y: 5 } }), 'all', []), 'all')).toEqual({});
  });

  it('reorganizar guarda a ordem dos projetos só da aba', () => {
    const a = withReset(empty(), 'all', ['b', 'a']);
    const b = withReset(a, 'part', ['a']);
    expect(b.order).toEqual({ all: ['b', 'a'], part: ['a'] });
    expect(withReset(b, 'all', ['a', 'b']).order).toEqual({ all: ['a', 'b'], part: ['a'] });
  });

  it('aba ainda não mexida parte da planta v3; ao mexer, vira uma cópia própria', () => {
    const store = empty({ 'p:x': { x: 5, y: 5 }, 'p:y': { x: 6, y: 6 } });
    expect(positionsOf(store, 'part')['p:x']).toEqual({ x: 5, y: 5 });
    const moved = withMoved(store, 'part', { 'p:y': { x: 7, y: 7 } });
    expect(positionsOf(moved, 'part')).toEqual({ 'p:x': { x: 5, y: 5 }, 'p:y': { x: 7, y: 7 } });
    expect(positionsOf(moved, 'all')['p:y']).toEqual({ x: 6, y: 6 });
  });

  it('aba de workspace que não existe mais usa a planta de Todos', () => {
    expect(layoutKey('all', ws)).toBe('all');
    expect(layoutKey('none', ws)).toBe('none');
    expect(layoutKey('part', ws)).toBe('part');
    expect(layoutKey('sumiu', ws)).toBe('all');
  });
});
