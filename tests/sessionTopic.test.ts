import { describe, expect, it } from 'vitest';
import { sessionTopic } from '../server/adapters/claude/sessions';

const user = (content: unknown) => ({ type: 'user', message: { content } });

describe('assunto da conversa', () => {
  it('a tarefa do quadro dá o nome; senão, a 1ª linha da 1ª mensagem sua', () => {
    expect(sessionTopic([user('[Tarefa "Scrollbar do kanban"] deixe o scroll com a classe do DS')])).toBe('Scrollbar do kanban');
    expect(sessionTopic([user([{ type: 'text', text: 'Corrija o total do pedido\ncom teste' }])])).toBe('Corrija o total do pedido');
  });

  it('pula o que é injetado, os avisos do Claudio’s Club e a saudação de sessão nova', () => {
    const lines = [
      { type: 'summary' },
      user('<local-command-stdout>ok</local-command-stdout>'),
      user('Olá, Belchior. Leia sua memória e diga em poucas linhas como pretende começar.'),
      user([{ type: 'tool_result', content: 'x' }]),
      user([
        { type: 'text', text: '[MyCo] Contexto desta conversa: 160k' },
        { type: 'text', text: 'Deixe o botão azul' },
      ]),
    ];
    expect(sessionTopic(lines)).toBe('Deixe o botão azul');
    expect(sessionTopic([user('Olá, Ana. Leia sua memória e comece pela primeira tarefa da ficha.')])).toBeNull();
    // A saudação de versões antigas também.
    expect(sessionTopic([user('Olá, Luana. Leia sua ficha e sua memória e diga como pretende começar.')])).toBeNull();
  });

  it('corta texto longo numa linha só', () => {
    const topic = sessionTopic([user(`  ${'palavra '.repeat(30)}`)])!;
    expect(topic.length).toBe(80);
    expect(topic.endsWith('…')).toBe(true);
  });
});
