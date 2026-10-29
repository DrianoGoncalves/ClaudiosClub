import { describe, expect, it } from 'vitest';
import { systemMessageText } from '../client/src/chat/systemMessage';

describe('systemMessageText (mensagem automática da plataforma no chat)', () => {
  it('reconhece o prefixo [MyCo] e tira ele do texto', () => {
    expect(systemMessageText('[MyCo] Belchior entregou a tarefa')).toBe('Belchior entregou a tarefa');
    expect(systemMessageText('[MyCo] Contexto desta conversa: 80%')).toBe('Contexto desta conversa: 80%');
  });

  it('reconhece o nome novo, com aspa reta ou curva', () => {
    expect(systemMessageText("[Claudio's Club] oi")).toBe('oi');
    expect(systemMessageText('[Claudio’s Club] oi')).toBe('oi');
  });

  it('mantém as quebras de linha depois do prefixo', () => {
    expect(systemMessageText('[MyCo]\nlinha 1\nlinha 2')).toBe('\nlinha 1\nlinha 2');
  });

  it('mensagem normal do usuário não é automática', () => {
    expect(systemMessageText('oi, tudo bem?')).toBeNull();
    expect(systemMessageText('veja o [MyCo] no meio')).toBeNull();
    expect(systemMessageText('[myco] minúsculo')).toBeNull();
    expect(systemMessageText('[MyCompany] outro')).toBeNull();
    expect(systemMessageText('')).toBeNull();
  });
});
