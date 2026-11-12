import { describe, expect, it } from 'vitest';
import { isConversationArchived, splitArchived } from '../client/src/detail/conversationArchive';

const ARCHIVED_AT = '2026-11-10T12:00:00.000Z';
const before = '2026-11-10T11:59:59.000Z';
const after = '2026-11-10T12:00:01.000Z';

describe('arquivar conversa no seletor do chat', () => {
  it('conversa arquivada some da lista e vai para as arquivadas', () => {
    const list = [
      { id: 'a', updatedAt: before },
      { id: 'b', updatedAt: before },
    ];
    const r = splitArchived(list, { a: ARCHIVED_AT });
    expect(r.active.map((c) => c.id)).toEqual(['b']);
    expect(r.archived.map((c) => c.id)).toEqual(['a']);
  });

  it('sem entrada no mapa nada é arquivado, e a ordem da lista se mantém', () => {
    const list = [
      { id: 'a', updatedAt: after },
      { id: 'b', updatedAt: null },
      { id: 'c', updatedAt: before },
    ];
    const r = splitArchived(list, {});
    expect(r.active.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(r.archived).toEqual([]);
  });

  it('atividade depois do arquivamento traz a conversa de volta sozinha', () => {
    expect(isConversationArchived({ id: 'a', updatedAt: after }, { a: ARCHIVED_AT })).toBe(false);
    expect(isConversationArchived({ id: 'a', updatedAt: before }, { a: ARCHIVED_AT })).toBe(true);
    // Na mesma hora do arquivamento ainda não é atividade nova.
    expect(isConversationArchived({ id: 'a', updatedAt: ARCHIVED_AT }, { a: ARCHIVED_AT })).toBe(true);
  });

  it('a conversa do aviso (focus) aparece mesmo arquivada', () => {
    const c = { id: 'a', updatedAt: before };
    expect(isConversationArchived(c, { a: ARCHIVED_AT }, ['a'])).toBe(false);
    expect(splitArchived([c], { a: ARCHIVED_AT }, ['a']).active).toEqual([c]);
    // Outra conversa arquivada não é salva pelo aviso desta.
    expect(isConversationArchived({ id: 'b', updatedAt: before }, { b: ARCHIVED_AT }, ['a'])).toBe(true);
  });

  it('sem data de atividade ou com data ilegível segue arquivada (não há como provar atividade nova)', () => {
    expect(isConversationArchived({ id: 'a', updatedAt: null }, { a: ARCHIVED_AT })).toBe(true);
    expect(isConversationArchived({ id: 'a', updatedAt: after }, { a: 'ontem' })).toBe(true);
  });
});
