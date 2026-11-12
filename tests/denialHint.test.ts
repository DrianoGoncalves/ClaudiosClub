import { describe, expect, it } from 'vitest';
import type { ChatItem, DenialInfo } from '../shared/model';
import { actionableDenials, denialHintOf } from '../client/src/chat/denialHint';

const notice = (id: string, denial?: DenialInfo): ChatItem => ({ kind: 'notice', id, text: 'x', tone: 'warn', at: null, ...(denial && { denial }) });
const user = (id: string): ChatItem => ({ kind: 'user', id, text: 'oi', at: null });

describe('dica do aviso de negação', () => {
  it('lê a dica só de aviso com denial', () => {
    expect(denialHintOf(notice('a', { layer: 'classifier', hint: 'autonomy' }))).toBe('autonomy');
    expect(denialHintOf(notice('b', { layer: 'other', hint: null }))).toBeNull();
    expect(denialHintOf(notice('c'))).toBeNull();
    expect(denialHintOf(user('d'))).toBeNull();
  });

  it('só os avisos depois da última mensagem do usuário pedem ação', () => {
    const items = [
      notice('velho', { layer: 'club', hint: 'servers' }),
      user('u1'),
      notice('novo', { layer: 'classifierError', hint: 'retry' }),
      notice('sem-dica', { layer: 'other', hint: null }),
    ];
    expect([...actionableDenials(items)]).toEqual(['novo']);
  });

  it('mandar "tente de novo" (mensagem do usuário) tira o botão', () => {
    const items = [notice('a', { layer: 'classifierError', hint: 'retry' }), user('retry')];
    expect(actionableDenials(items).size).toBe(0);
  });
});
