import { useSyncExternalStore } from 'react';

// Tema da tela: claro, escuro ou o do sistema. A escolha vale só neste navegador (localStorage) e vira
// `data-theme` no <html> (sempre "light" ou "dark"): é nele que o styles.css e o fundo do quadro se apoiam.

export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

const KEY = 'myco.theme';
const QUERY = '(prefers-color-scheme: dark)';
const PREFS: readonly ThemePref[] = ['system', 'light', 'dark'];

function read(): ThemePref {
  try {
    const saved = localStorage.getItem(KEY);
    return PREFS.includes(saved as ThemePref) ? (saved as ThemePref) : 'system';
  } catch {
    return 'system'; // localStorage bloqueado: segue o sistema
  }
}

const media = window.matchMedia(QUERY);
let pref = read();
const listeners = new Set<() => void>();

const resolve = (): Theme => (pref === 'system' ? (media.matches ? 'dark' : 'light') : pref);

function apply() {
  document.documentElement.dataset.theme = resolve();
  listeners.forEach((l) => l());
}

media.addEventListener('change', apply);

/** Aplica o tema salvo; chamar antes de renderizar para a página não piscar no tema errado. */
export function initTheme() {
  apply();
}

export function setThemePref(next: ThemePref) {
  pref = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* sem localStorage: vale até recarregar */
  }
  apply();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  return [useSyncExternalStore(subscribe, () => pref), setThemePref];
}

/** O tema em uso agora (escolhido ou, em "sistema", o do sistema); acompanha a troca sem recarregar. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, resolve);
}
