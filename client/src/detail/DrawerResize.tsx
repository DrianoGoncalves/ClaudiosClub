import { useCallback, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { t } from '../i18n';

const WIDTH_KEY = 'myco.drawer.width';
const MIN = 360;
const DEFAULT = 560;
/** Margem do painel (12px de cada lado) que sempre sobra na janela. */
const GAP = 24;

const clamp = (w: number) => Math.round(Math.max(MIN, Math.min(w, window.innerWidth - GAP)));

function readWidth(): number {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (saved >= MIN) return saved;
  } catch {
    // sem armazenamento: largura padrão
  }
  return DEFAULT;
}

function saveWidth(w: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(w));
  } catch {
    // sem armazenamento: vale só nesta aba
  }
}

/** Largura do painel do funcionário, salva no navegador. O CSS ainda limita à janela. */
export function useDrawerWidth() {
  const [width, setWidth] = useState(readWidth);
  const set = useCallback((w: number) => {
    const next = clamp(w);
    setWidth(next);
    saveWidth(next);
  }, []);
  return [width, set] as const;
}

/** Alça na borda esquerda do painel: arrastar (ou setas do teclado) muda a largura. */
export function DrawerResize({ width, onResize }: { width: number; onResize: (w: number) => void }) {
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    // O painel encosta na direita: a largura é a distância do ponteiro até a borda direita dele.
    const right = handle.parentElement!.getBoundingClientRect().right;
    const move = (ev: globalThis.PointerEvent) => onResize(right - ev.clientX);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('is-resizing');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    document.body.classList.add('is-resizing');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 80 : 20;
    if (e.key === 'ArrowLeft') onResize(width + step);
    else if (e.key === 'ArrowRight') onResize(width - step);
    else if (e.key === 'Home') onResize(DEFAULT);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className="drawer-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('app.resizeDrawer')}
      title={t('app.resizeDrawer')}
      aria-valuenow={width}
      aria-valuemin={MIN}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(DEFAULT)}
    />
  );
}
