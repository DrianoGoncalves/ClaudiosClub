import { describe, expect, it } from 'vitest';
import { finalQuestion } from '../server/chat/question';

describe('pergunta no fim da resposta', () => {
  it('acha nas últimas linhas, mesmo com uma nota depois', () => {
    expect(finalQuestion('Feito.\n\nQuer que eu faça o commit?')).toBe('Quer que eu faça o commit?');
    expect(finalQuestion('Pronto.\n\n**Sigo com a opção 2?**\n\nCerteza: 8/10')).toBe('Sigo com a opção 2?');
    expect(finalQuestion('- Posso apagar os 3 arquivos?')).toBe('Posso apagar os 3 arquivos?');
  });

  it('não acha onde não é pergunta para você', () => {
    expect(finalQuestion('Commit feito. Agora os órfãos no servidor.')).toBeNull();
    // Pergunta lá em cima, e a resposta segue: não espera nada.
    expect(finalQuestion('Por que falhava?\nPorque o caminho estava errado.\nCorrigi.\nTestes passando.')).toBeNull();
    expect(finalQuestion('Veja:\n```ts\nconst x = a ? b : c?\n```\nFeito.')).toBeNull();
    expect(finalQuestion('| item | ok? |')).toBeNull();
    expect(finalQuestion(null)).toBeNull();
  });

  it('corta pergunta longa', () => {
    const long = `${'a'.repeat(300)}?`;
    expect(finalQuestion(long)!.length).toBe(160);
  });
});
