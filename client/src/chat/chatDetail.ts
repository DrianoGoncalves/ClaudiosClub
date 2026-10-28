import { useSyncExternalStore } from 'react';

// "Chat detalhado" (config → Conversa): mostra as leituras, buscas e comandos dos funcionários em
// todas as conversas. Fica no navegador; as conversas abertas mudam na hora.

const KEY = 'myco.chat.showTools';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let value = read();

function set(v: boolean) {
  value = v;
  try {
    localStorage.setItem(KEY, v ? '1' : '0');
  } catch {
    // sem armazenamento: vale só nesta aba
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useChatDetail(): [boolean, (v: boolean) => void] {
  return [useSyncExternalStore(subscribe, () => value), set];
}
