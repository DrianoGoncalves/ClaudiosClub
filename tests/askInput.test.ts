import { describe, expect, it } from 'vitest';
import { readAsk } from '../client/src/chat/askInput';
import { inputText } from '../server/chat/items';

const input = {
  questions: [
    {
      question: 'Qual banco?',
      header: 'Banco',
      multiSelect: false,
      options: [{ label: 'Postgres', description: 'Relacional' }, { label: 'SQLite' }],
    },
    { question: 'Quantos?', kind: 'number', min: 1, max: 5, unit: 'itens', multiSelect: false, options: [] },
  ],
};

describe('readAsk', () => {
  it('lê os campos da pergunta em vez do JSON', () => {
    const asked = readAsk(JSON.stringify(input));
    expect(asked).toHaveLength(2);
    expect(asked![0]).toEqual({
      question: 'Qual banco?',
      header: 'Banco',
      multiSelect: false,
      options: [{ label: 'Postgres', description: 'Relacional' }, { label: 'SQLite' }],
    });
    expect(asked![1]).toMatchObject({ kind: 'number', min: 1, max: 5, unit: 'itens', options: [] });
  });

  it('ignora o que não é pergunta e devolve null sem nenhuma legível', () => {
    expect(readAsk('{"questions":[{"options":[]},null]}')).toBeNull();
    expect(readAsk('{"outra":1}')).toBeNull();
    expect(readAsk('texto cortado {"questions":[')).toBeNull();
    expect(readAsk('null')).toBeNull();
  });
});

describe('inputText da pergunta com opções', () => {
  const big = { questions: [{ question: 'Q', options: Array.from({ length: 12 }, (_, i) => ({ label: `Opção ${i}`, description: 'x'.repeat(300) })) }] };

  it('não corta o JSON no meio, para a tela conseguir lê-lo', () => {
    expect(readAsk(inputText(big, 'AskUserQuestion'))).not.toBeNull();
    expect(readAsk(inputText(big, 'Outra'))).toBeNull(); // as demais ferramentas seguem com o limite curto
  });
});
