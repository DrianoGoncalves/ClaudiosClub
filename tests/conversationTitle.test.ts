import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationTitle, manualTitle, reviewTitle, titleToSave } from '../client/src/detail/conversationTitle';
import { t } from '../client/src/i18n';
import tasks from '../client/src/i18n/tasks';

describe('título da conversa: manual > gerado por IA > assunto > title', () => {
  it('o manual vence o gerado, o assunto e o title', () => {
    expect(conversationTitle({ id: 'a', aiTitle: 'Gerado', topic: 'Assunto', title: 'Nome' }, { a: 'Meu título' })).toBe('Meu título');
  });

  it('sem manual o gerado vence o assunto e o title', () => {
    expect(conversationTitle({ id: 'a', aiTitle: 'Gerado', topic: 'Assunto', title: 'Nome do funcionário' }, {})).toBe('Gerado');
    expect(conversationTitle({ id: 'a', aiTitle: 'Gerado', topic: null })).toBe('Gerado');
  });

  it('sem gerado (ausente, null, vazio ou só espaços) cai no assunto, e só sem assunto usa o title', () => {
    expect(conversationTitle({ id: 'a', topic: 'Assunto', title: 'Nome' })).toBe('Assunto');
    expect(conversationTitle({ id: 'a', aiTitle: null, topic: 'Assunto', title: 'Nome' }, {})).toBe('Assunto');
    expect(conversationTitle({ id: 'a', aiTitle: '   ', topic: 'Assunto' })).toBe('Assunto');
    expect(conversationTitle({ id: 'a', aiTitle: '', topic: null, title: 'Nome' })).toBe('Nome');
    // Lista da ficha (Claude/Codex): o title é o nome do funcionário e não é passado.
    expect(conversationTitle({ id: 'a', aiTitle: null, topic: null })).toBeNull();
  });

  it('o gerado chegando depois troca o assunto sem perder o manual', () => {
    const before = { id: 'a', aiTitle: null, topic: 'Quero que você olhe o erro de login que aparece quando…' };
    const after = { ...before, aiTitle: 'Erro de login' };
    expect(conversationTitle(before, {})).toBe(before.topic);
    expect(conversationTitle(after, {})).toBe('Erro de login');
    expect(conversationTitle(after, { a: 'Login' })).toBe('Login');
  });

  it('manual de outra conversa, vazio ou só espaços não conta', () => {
    expect(conversationTitle({ id: 'a', topic: 'Assunto' }, { b: 'Outro' })).toBe('Assunto');
    expect(conversationTitle({ id: 'a', topic: 'Assunto' }, { a: '   ' })).toBe('Assunto');
    expect(conversationTitle({ id: 'a', aiTitle: 'Gerado', topic: 'Assunto' }, { a: '   ' })).toBe('Gerado');
    expect(manualTitle('a', { a: '' })).toBeNull();
    expect(manualTitle('a')).toBeNull();
  });

  it('id herdado do Object (toString) não vira título', () => {
    expect(manualTitle('toString', {})).toBeNull();
    expect(conversationTitle({ id: 'constructor', topic: 'Assunto' }, {})).toBe('Assunto');
    expect(conversationTitle({ id: 'constructor', aiTitle: 'Gerado', topic: 'Assunto' }, {})).toBe('Gerado');
  });
});

describe('conversa de revisão: "<coluna Revisão> - <tarefa>"', () => {
  const review = { id: 'a', reviewTask: 'Exportar CSV', aiTitle: 'Gerado', topic: 'Exportar CSV', title: 'Nome' };

  it('o rótulo é o da coluna Revisão do kanban (mesma chave), sem texto novo', () => {
    expect(t('tasks.statusReview')).toBe('Revisão');
    expect(reviewTitle('Exportar CSV')).toBe('Revisão - Exportar CSV');
    expect(conversationTitle(review, {})).toBe('Revisão - Exportar CSV');
  });

  it('precedência: manual > revisão > gerado por IA > assunto > title', () => {
    expect(conversationTitle(review, { a: 'Meu título' })).toBe('Meu título');
    expect(conversationTitle(review, { a: '   ' })).toBe('Revisão - Exportar CSV');
    expect(conversationTitle({ ...review, reviewTask: null }, {})).toBe('Gerado');
    expect(conversationTitle({ ...review, reviewTask: undefined, aiTitle: null }, {})).toBe('Exportar CSV');
    expect(conversationTitle({ ...review, reviewTask: '', aiTitle: null, topic: null }, {})).toBe('Nome');
  });

  it('sem título da tarefa (vazio ou só espaços) não há título de revisão', () => {
    expect(reviewTitle(null)).toBeNull();
    expect(reviewTitle(undefined)).toBeNull();
    expect(reviewTitle('   ')).toBeNull();
    expect(conversationTitle({ id: 'a', reviewTask: '  ', topic: 'Assunto' })).toBe('Assunto');
  });

  it('a tarefa é texto puro: não vira HTML nem perde o que tem dentro', () => {
    expect(reviewTitle('<b>x</b> & "y"')).toBe('Revisão - <b>x</b> & "y"');
  });

  it('o rótulo vem da coluna nos 3 idiomas (a chave tem pt, en e es)', () => {
    expect(tasks['pt-BR']['tasks.statusReview']).toBe('Revisão');
    expect(tasks.en['tasks.statusReview']).toBe('Review');
    expect(tasks.es['tasks.statusReview']).toBe('Revisión');
  });

  describe('com a página em outro idioma', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.resetModules();
    });
    const inLocale = async (locale: string) => {
      vi.resetModules();
      vi.stubGlobal('window', { localStorage: { getItem: () => locale } });
      return import('../client/src/detail/conversationTitle');
    };

    it.each([
      ['en', 'Review - Exportar CSV'],
      ['es', 'Revisión - Exportar CSV'],
      ['pt-BR', 'Revisão - Exportar CSV'],
    ])('%s', async (locale, expected) => {
      const mod = await inLocale(locale);
      expect(mod.conversationTitle(review, {})).toBe(expected);
      expect(mod.conversationTitle(review, { a: 'Meu título' })).toBe('Meu título');
    });
  });
});

describe('o que salvar no Renomear', () => {
  it('texto novo grava; igual ao que já aparece não chama o servidor', () => {
    expect(titleToSave('  Relatório  ', 'Assunto antigo', false)).toBe('Relatório');
    expect(titleToSave('Assunto antigo', 'Assunto antigo', false)).toBeUndefined();
    expect(titleToSave(' Assunto antigo ', 'Assunto antigo', true)).toBeUndefined();
  });

  it('abrir o campo sobre o título gerado e salvar sem mexer não o grava como manual', () => {
    const shown = conversationTitle({ id: 'a', aiTitle: 'Erro de login', topic: 'Assunto' }, {});
    expect(titleToSave(shown ?? '', shown, false)).toBeUndefined();
  });

  it('vazio apaga o manual (volta ao automático, agora o gerado); sem manual não há o que apagar', () => {
    expect(titleToSave('', 'Meu título', true)).toBeNull();
    expect(titleToSave('   ', 'Meu título', true)).toBeNull();
    expect(titleToSave('', 'Assunto', false)).toBeUndefined();
    expect(titleToSave('', 'Gerado', false)).toBeUndefined();
    // Depois de apagar o manual, a lista volta ao gerado.
    expect(conversationTitle({ id: 'a', aiTitle: 'Gerado', topic: 'Assunto' }, {})).toBe('Gerado');
  });

  it('conversa sem título mostrado: qualquer texto grava', () => {
    expect(titleToSave('Novo', null, false)).toBe('Novo');
    expect(titleToSave('', null, false)).toBeUndefined();
  });
});
