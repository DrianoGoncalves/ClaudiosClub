import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../shared/model';
import { centerScrollTop, endScrollTop, findQuoteIndex, findQuoteItem, foldText, plainText, quoteNeedle } from '../client/src/chat/chatFocus';

describe('achar a pergunta dentro da conversa', () => {
  it('compara sem Markdown, sem caixa e com espaços normalizados', () => {
    expect(plainText('**Sigo** com a  `opção 2`?\n[veja](https://x.y)')).toBe('sigo com a opção 2? veja');
  });

  it('o começo da pergunta vale ~40 caracteres, sem o marcador de lista', () => {
    expect(quoteNeedle('3. O ajuste do item 5…')).toBe('o ajuste do item 5…');
    expect(quoteNeedle('- Posso apagar os 3 arquivos?')).toBe('posso apagar os 3 arquivos?');
    expect(quoteNeedle('x'.repeat(100))).toHaveLength(40);
    expect(quoteNeedle('3.5 é a versão?')).toBe('3.5 é a versão?');
    expect(quoteNeedle('  ')).toBe('');
  });

  it('acha o trecho (parágrafo, item) da pergunta, o mais específico', () => {
    const parts = [
      'Decisões aplicadas. 1. Feito o item 3 2. Feito o item 4 3. O ajuste do item 5 fica para depois? Certeza: 8/10', // item de lista pai
      'Feito o item 3',
      'O ajuste do item 5 fica para depois?',
      'Certeza: 8/10',
    ];
    expect(findQuoteIndex(parts, '3. O ajuste do item 5 fica para depois?')).toBe(2);
    expect(findQuoteIndex(parts, '**Certeza: 8/10**')).toBe(3);
  });

  it('num empate (item e o parágrafo dentro dele) fica o mais interno', () => {
    expect(findQuoteIndex(['Quer que eu faça o commit?', 'Quer que eu faça o commit?'], 'Quer que eu faça o commit?')).toBe(1);
  });

  it('pergunta cortada ou com link no texto ainda acha', () => {
    const long = `Quer que eu (1) faça o commit em main e (2) apague os órfãos e depois rode todos os testes de novo${'?'}`;
    expect(findQuoteIndex(['outra coisa', long], `${long.slice(0, 80)}…`)).toBe(1);
    expect(findQuoteIndex(['Veja o plano e me diga se segue?'], 'Veja o [plano](https://x.y) e me diga se segue?')).toBe(0);
  });

  it('entidades HTML, escapes com barra, autolink e imagem valem como na tela', () => {
    expect(plainText('R&amp;D &lt;b&gt; &quot;x&quot; &#39;y&#39; &#x41; &foo;')).toBe('r&d <b> "x" \'y\' a &foo;');
    expect(plainText('2 \\* 3 \\_ x')).toBe('2 * 3 _ x');
    expect(plainText('veja <https://x.y/a?b=1> e ![diagrama](https://x.y/i.png)')).toBe('veja https://x.y/a?b=1 e diagrama');
  });

  it('a comparação só olha letras e números, sem caixa nem acento', () => {
    expect(foldText('Você quer, então, R&D? (sim)…')).toBe('vocequerentaordsim');
  });

  it('acha com entidade, negrito, link, autolink, escape e item de lista', () => {
    // O texto dos trechos é o que a tela mostra (textContent já renderizado).
    expect(findQuoteIndex(['Feito.', 'Posso trocar R&D por P&D?'], 'Posso trocar R&amp;D por P&amp;D?')).toBe(1);
    expect(findQuoteIndex(['Posso trocar <b> por <i>?'], 'Posso trocar &lt;b&gt; por &lt;i&gt;?')).toBe(0);
    expect(findQuoteIndex(['Posso seguir com a opção B?'], 'Posso seguir com a **opção B**?')).toBe(0);
    expect(findQuoteIndex(['Abro https://x.y/a agora?'], 'Abro <https://x.y/a> agora?')).toBe(0);
    expect(findQuoteIndex(['Uso 2 * 3 aqui?'], 'Uso 2 \\* 3 aqui?')).toBe(0);
    expect(findQuoteIndex(['Resumo', 'Ajusto o item 5 agora?'], '3. Ajusto o **item 5** agora?')).toBe(1);
    expect(findQuoteIndex(['Veja o diagrama e me diga'], 'Veja o ![diagrama](https://x.y/i.png) e me diga')).toBe(0);
  });

  it('pontuação, símbolos e acento não impedem de achar', () => {
    expect(findQuoteIndex(['Você quer, então, seguir?'], 'Voce quer entao seguir')).toBe(0);
    expect(findQuoteIndex(['Tudo certo — sigo para o commit?'], 'Tudo certo… sigo para o commit?')).toBe(0);
    expect(findQuoteIndex(['Texto sem relação'], '…?!')).toBe(-1);
  });

  it('não acha o que não está lá', () => {
    expect(findQuoteIndex(['Feito.', 'Testes passando.'], 'Faço o commit?')).toBe(-1);
    expect(findQuoteIndex(['Feito.'], '')).toBe(-1);
  });

  it('sem o id do balão: o mais recente, entre as últimas respostas, que traz a pergunta', () => {
    const answer = (id: string, text: string): ChatItem => ({ kind: 'assistant', id, text, at: null });
    const items: ChatItem[] = [
      answer('a:velha', 'Faço o commit?'),
      { kind: 'user', id: 'u:1', text: 'sim', at: null },
      answer('a:m1', 'Feito.\n\nFaço o commit?'),
      answer('a:m2', 'Outra coisa'),
    ];
    expect(findQuoteItem(items, 'Faço o commit?')).toBe('a:m1');
    expect(findQuoteItem(items, 'Apago os órfãos?')).toBeNull();
    // Entidade e negrito no texto da resposta e na pergunta.
    const withMarks = [answer('a:r', 'Feito.\n\nPosso trocar **R&D** por P&amp;D?')];
    expect(findQuoteItem(withMarks, 'Posso trocar R&amp;D por P&D?')).toBe('a:r');
    // Só as últimas respostas entram.
    const many = [answer('a:longe', 'Faço o commit?'), ...Array.from({ length: 6 }, (_, i) => answer(`a:${i}`, 'nada'))];
    expect(findQuoteItem(many, 'Faço o commit?')).toBeNull();
  });
});

describe('rolagem até o trecho', () => {
  it('pelo fim: o fim do trecho fica na parte de baixo da área visível', () => {
    expect(endScrollTop(400, 1000, 3000)).toBe(3612);
    expect(endScrollTop(400, 0, 100)).toBe(0);
  });

  it('põe o trecho no centro da área visível', () => {
    expect(centerScrollTop(400, 1000, 100)).toBe(850);
  });

  it('trecho mais alto que a área visível: pelo começo; no topo da lista, não passa de 0', () => {
    expect(centerScrollTop(400, 1000, 600)).toBe(988);
    expect(centerScrollTop(400, 50, 100)).toBe(0);
  });
});
