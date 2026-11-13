import { describe, expect, it } from 'vitest';
import staff from '../client/src/i18n/staff';
import { blockedText, inboxText, inboxWho } from '../client/src/inbox/inboxText';
import type { Tr } from '../client/src/inbox/secretText';
import type { InboxItem } from '../shared/model';

type Locale = 'pt-BR' | 'en' | 'es';

/** Mesma troca de `{nome}` do `t()`, sobre o dicionário de cada idioma (o `t()` usa o idioma da página). */
const tr = (locale: Locale): Tr => (key, vars) => {
  const text = (staff[locale] as Record<string, string>)[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (vars && name in vars ? String(vars[name]) : m));
};

const blocked = (reason: string): Pick<InboxItem, 'summary' | 'blocked'> => ({
  summary: `“Tela” espera “API”: ${reason}`,
  blocked: { taskId: 't2', taskTitle: 'Tela', blockerId: 't1', blockerTitle: 'API', blockerStatus: 'waiting', reason },
});

describe('item "bloqueada" da caixa', () => {
  it('a frase sai da estrutura, no idioma da página', () => {
    expect(blockedText(blocked('limite de revisões automáticas atingido'), tr('pt-BR'))).toBe('“Tela” espera “API”: limite de revisões automáticas atingido');
    expect(blockedText(blocked('limite de revisões automáticas atingido'), tr('en'))).toBe('“Tela” is waiting for “API”: automatic review limit reached');
    expect(blockedText(blocked('sem responsável'), tr('es'))).toBe('“Tela” espera “API”: sin responsable');
  });

  it('Aguardar, com e sem motivo, e motivo novo do servidor aparece como veio', () => {
    expect(blockedText(blocked('em Aguardar'), tr('en'))).toBe('“Tela” is waiting for “API”: on hold');
    expect(blockedText(blocked('em Aguardar: esperando o cliente'), tr('en'))).toBe('“Tela” is waiting for “API”: on hold: esperando o cliente');
    expect(blockedText(blocked('motivo que o servidor inventou'), tr('en'))).toBe('“Tela” is waiting for “API”: motivo que o servidor inventou');
  });

  it('sem o campo blocked (servidor antigo), vale o summary em pt-BR', () => {
    expect(blockedText({ summary: 'resumo do servidor' }, tr('en'))).toBe('resumo do servidor');
    expect(inboxText({ summary: 'resumo do servidor' }, tr('en'))).toBe('resumo do servidor');
  });

  it('segredo continua saindo da frase do segredo', () => {
    expect(inboxText({ summary: 'x', secret: { kind: 'private-key', source: 'owner' } }, tr('pt-BR'))).toContain('Chave privada');
  });

  it('tarefa sem responsável não tem nome de funcionário: quem aparece é o projeto', () => {
    expect(inboxWho({ name: '', projectName: 'MyCo' })).toBe('MyCo');
    expect(inboxWho({ name: 'Ana', projectName: 'MyCo' })).toBe('Ana');
  });

  it('as chaves existem nos três idiomas', () => {
    for (const locale of ['pt-BR', 'en', 'es'] as const) {
      const dict = staff[locale] as Record<string, string>;
      for (const key of ['inbox.kindBlocked', 'inbox.titleBlocked', 'inbox.blocked.sentence', 'inbox.blocked.onHold', 'inbox.blocked.onHoldWhy', 'inbox.blocked.reviewLimit', 'inbox.blocked.noOwner'])
        expect(dict[key], `${locale} ${key}`).toBeTruthy();
    }
  });
});
