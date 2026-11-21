import { describe, expect, it } from 'vitest';
import { conversationOption } from '../client/src/detail/Detail';
import { t } from '../client/src/i18n';

const c = { title: 'Ajustar o header', updatedAt: null };

describe('seletor de conversas: ativa x inativa', () => {
  it('ativa (processo aberto) leva "· ativa" no texto e a classe is-active', () => {
    expect(conversationOption(c, true, false)).toEqual({ label: `Ajustar o header · ${t('detail.convActive')}`, className: 'is-active' });
  });

  it('inativa fica só com o título e a classe is-idle (o CSS põe em muted)', () => {
    expect(conversationOption(c, false, false)).toEqual({ label: 'Ajustar o header', className: 'is-idle' });
  });

  it('o "● " de parada e não vista vem antes, junto do "· ativa"', () => {
    expect(conversationOption(c, true, true).label).toBe(`● Ajustar o header · ${t('detail.convActive')}`);
  });

  it('pergunta/ação da caixa: "⚠ " e classe is-needs, no lugar do "● "', () => {
    const o = conversationOption(c, false, true, true);
    expect(o.label).toBe('⚠ Ajustar o header');
    expect(o.className).toBe('is-idle is-needs');
    expect(conversationOption(c, true, false, false).className).toBe('is-active');
  });

  it('sem título usa o nome de conversa sem título', () => {
    expect(conversationOption({ title: null, updatedAt: null }, false, false).label).toBe(t('detail.untitledConversation'));
  });
});
