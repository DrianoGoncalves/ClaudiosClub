import { useEffect, useRef, useState, type ReactNode } from 'react';

// Canto superior direito: o monitor e o player do Spotify lado a lado. Fica embaixo do painel lateral quando ele abre.

/** Distância das bordas (a mesma do CSS) e folga até a barra do topo. */
const EDGE = 12;
const GAP = 8;
/** A barra do topo muda de largura (abas, quebra de linha) sem avisar: confere de tempos em tempos, como o monitor fazia. */
const RECHECK_MS = 2000;

export function CornerDock({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(EDGE);
  useEffect(() => {
    const dock = box.current;
    if (!dock) return;
    // Janela estreita: a barra do topo chega no canto e a camada cobriria os botões dela (o ⚙). Aí desce para baixo dela.
    const place = () => {
      if (document.visibilityState !== 'visible') return;
      const bar = document.querySelector('.toolbar')?.getBoundingClientRect();
      setTop(bar && bar.right > window.innerWidth - EDGE - dock.offsetWidth - GAP ? Math.round(bar.bottom + GAP) : EDGE);
    };
    // O dock muda de largura quando o monitor ou o player liga/desliga.
    const size = new ResizeObserver(place);
    size.observe(dock);
    const timer = setInterval(place, RECHECK_MS);
    place();
    window.addEventListener('resize', place);
    document.addEventListener('visibilitychange', place);
    return () => {
      size.disconnect();
      clearInterval(timer);
      window.removeEventListener('resize', place);
      document.removeEventListener('visibilitychange', place);
    };
  }, []);
  return (
    <div ref={box} className="corner-dock" style={{ top }}>
      {children}
    </div>
  );
}
