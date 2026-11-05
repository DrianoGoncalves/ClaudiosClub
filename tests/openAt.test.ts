import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../shared/model';
import { lastPromptId, promptScrollTop } from '../client/src/chat/openAt';

const user = (id: string, extra: Partial<Extract<ChatItem, { kind: 'user' }>> = {}): ChatItem => ({ kind: 'user', id, text: id, at: null, ...extra });
const reply = (id: string): ChatItem => ({ kind: 'assistant', id, text: 'ok', at: null });
const tool = (id: string): ChatItem => ({ kind: 'tool', id, name: 'Read', summary: '', input: '', result: '', isError: false, at: null });

describe('onde a conversa abre sem pendência', () => {
  it('na última mensagem enviada a ele, mesmo com ferramentas e respostas depois', () => {
    expect(lastPromptId([user('u1'), reply('a1'), user('u2'), tool('t1'), reply('a2'), tool('t2'), reply('a3')])).toBe('u2');
  });

  it('aviso da plataforma (entrega de tarefa) e mensagem na fila contam; a guardada ainda não foi', () => {
    expect(lastPromptId([user('u1'), reply('a1'), user('u2', { text: '[MyCo] Fulano entregou a tarefa' }), reply('a2')])).toBe('u2');
    expect(lastPromptId([user('u1'), reply('a1'), user('u2', { queued: 'next' })])).toBe('u2');
    expect(lastPromptId([user('u1'), reply('a1'), user('h:1', { held: 'outra tarefa' })])).toBe('u1');
  });

  it('sem mensagem enviada a ele: nenhuma (abre no fim)', () => {
    expect(lastPromptId([])).toBeNull();
    expect(lastPromptId([reply('a1'), tool('t1')])).toBeNull();
  });

  it('a mensagem fica no topo, com a margem', () => {
    expect(promptScrollTop(600, 1000, 60)).toBe(988);
    expect(promptScrollTop(600, 1000, 60, 8)).toBe(992);
    expect(promptScrollTop(600, 5, 60)).toBe(0);
  });

  it('mensagem longa: aparece só o fim dela, e a resposta começa até 40% da altura', () => {
    expect(promptScrollTop(600, 1000, 500)).toBe(1260);
    expect(1000 + 500 - promptScrollTop(600, 1000, 500)).toBe(240);
  });
});
