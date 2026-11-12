import { describe, expect, it } from 'vitest';
import { conversationTitle, manualTitle, titleToSave } from '../client/src/detail/conversationTitle';

describe('título da conversa: manual > assunto > title', () => {
  it('o manual vence o assunto e o title', () => {
    expect(conversationTitle({ id: 'a', topic: 'Assunto', title: 'Nome' }, { a: 'Meu título' })).toBe('Meu título');
  });

  it('sem manual cai no assunto, e só sem assunto usa o title', () => {
    expect(conversationTitle({ id: 'a', topic: 'Assunto', title: 'Nome do funcionário' }, {})).toBe('Assunto');
    expect(conversationTitle({ id: 'a', topic: null, title: 'Nome' })).toBe('Nome');
    // Lista da ficha (Claude/Codex): o title é o nome do funcionário e não é passado.
    expect(conversationTitle({ id: 'a', topic: null })).toBeNull();
  });

  it('manual de outra conversa, vazio ou só espaços não conta', () => {
    expect(conversationTitle({ id: 'a', topic: 'Assunto' }, { b: 'Outro' })).toBe('Assunto');
    expect(conversationTitle({ id: 'a', topic: 'Assunto' }, { a: '   ' })).toBe('Assunto');
    expect(manualTitle('a', { a: '' })).toBeNull();
    expect(manualTitle('a')).toBeNull();
  });

  it('id herdado do Object (toString) não vira título', () => {
    expect(manualTitle('toString', {})).toBeNull();
    expect(conversationTitle({ id: 'constructor', topic: 'Assunto' }, {})).toBe('Assunto');
  });
});

describe('o que salvar no Renomear', () => {
  it('texto novo grava; igual ao que já aparece não chama o servidor', () => {
    expect(titleToSave('  Relatório  ', 'Assunto antigo', false)).toBe('Relatório');
    expect(titleToSave('Assunto antigo', 'Assunto antigo', false)).toBeUndefined();
    expect(titleToSave(' Assunto antigo ', 'Assunto antigo', true)).toBeUndefined();
  });

  it('vazio apaga o manual (volta ao automático); sem manual não há o que apagar', () => {
    expect(titleToSave('', 'Meu título', true)).toBeNull();
    expect(titleToSave('   ', 'Meu título', true)).toBeNull();
    expect(titleToSave('', 'Assunto', false)).toBeUndefined();
  });

  it('conversa sem título mostrado: qualquer texto grava', () => {
    expect(titleToSave('Novo', null, false)).toBe('Novo');
    expect(titleToSave('', null, false)).toBeUndefined();
  });
});
