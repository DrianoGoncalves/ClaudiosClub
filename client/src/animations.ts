import type { UiLevel } from '../../shared/model';

export const ANIMATIONS_KEY = 'myco.animations';

/** Escolha salva ('1' liga, '0' desliga); null = nunca escolheu (ou sem armazenamento). */
export function readAnimationsChoice(): boolean | null {
  try {
    const saved = localStorage.getItem(ANIMATIONS_KEY);
    return saved === '1' ? true : saved === '0' ? false : null;
  } catch {
    return null;
  }
}

/**
 * Sem escolha salva, o Simples começa ligado; o Avançado (e o instante antes de o nível chegar do servidor) segue o
 * "reduzir animações" do sistema. Escolha salva sempre vale.
 */
export function animationsOn(choice: boolean | null, level: UiLevel | null, reduceMotion: boolean): boolean {
  if (choice !== null) return choice;
  return level === 'simple' ? true : !reduceMotion;
}

export function systemReducesMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
