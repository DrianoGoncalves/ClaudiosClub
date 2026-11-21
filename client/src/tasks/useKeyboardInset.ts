import { useEffect, useState } from 'react';

// Teclado virtual aberto no celular: nos navegadores que só cobrem a página (iOS Safari, Chrome Android com `resizes-visual`) a altura do layout não muda e
// o rodapé fixo do painel ficaria atrás do teclado. A altura visível (`visualViewport`) diz quanto está coberto; o painel sobe esse tanto.
// Onde o teclado encolhe o layout (`resizes-content`), `innerHeight` já é a altura visível e a conta dá 0.

/** Pixels do fundo da janela cobertos pelo teclado. 0 com zoom (pinça) ou diferença pequena (barra de endereço). */
export function keyboardInset(innerHeight: number, vv: { height: number; offsetTop: number; scale: number }): number {
  if (vv.scale > 1.01) return 0;
  const covered = Math.round(innerHeight - vv.height - vv.offsetTop);
  return covered > 80 ? covered : 0;
}

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setInset(keyboardInset(window.innerHeight, vv));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}
