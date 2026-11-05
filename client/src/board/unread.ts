import { useLayoutEffect, useSyncExternalStore } from 'react';
import type { LiveSession } from '../../../shared/model';

// Bolinha de ocioso como "não lido": aparece quando o funcionário termina e você ainda não viu aquela
// conversa; some quando você a abre e só volta no próximo término (outro `statusUpdatedAt`). Fica no
// navegador: por conversa, o `statusUpdatedAt` da parada que você já viu ('' = sem data).

export type SeenIdle = Record<string, string>;

const KEY = 'myco.seenIdle';
/** Conversas guardadas; as vistas há mais tempo saem primeiro. */
const MAX = 300;
const listeners = new Set<() => void>();

function read(): SeenIdle | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as SeenIdle) : null;
  } catch {
    return null;
  }
}

/** null = nada guardado neste navegador (ou ilegível): ver `seedSeenIdle`. */
let stored = read();
let seen: SeenIdle = stored ?? {};

/** Parada (ociosa) e você ainda não viu a conversa desde que ela parou. */
export const idleUnseen = (seen: SeenIdle, live: LiveSession) =>
  live.alive && live.status === 'idle' && seen[live.sessionId] !== (live.statusUpdatedAt ?? '');

/** A bolinha de status aparece: ocioso só enquanto não visto; os outros estados, sempre. */
export const showsStatus = (seen: SeenIdle, live: LiveSession) => live.status !== 'idle' || idleUnseen(seen, live);

/** Marca a parada como vista; a última marcada vai para o fim da fila (a primeira a sair é a mais antiga). */
export function withSeen(seen: SeenIdle, sessionId: string, at: string, max = MAX): SeenIdle {
  const rest = Object.entries(seen).filter(([id]) => id !== sessionId);
  return Object.fromEntries([...rest, [sessionId, at]].slice(-max));
}

function save(next: SeenIdle) {
  seen = next;
  stored = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // sem armazenamento: vale só nesta aba
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

// Vista em outra aba do Claudio’s Club: a bolinha some aqui também.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    stored = read();
    seen = stored ?? {};
    listeners.forEach((l) => l());
  });
}

/**
 * Primeira vez neste navegador: o que já está parado conta como visto, para não acender a bolinha de
 * todo mundo de uma vez; daí em diante, só os términos novos.
 */
export function seedSeenIdle(live: LiveSession[]) {
  if (stored) return;
  save(live.reduce((acc, l) => (l.alive && l.status === 'idle' ? withSeen(acc, l.sessionId, l.statusUpdatedAt ?? '') : acc), seen));
}

/** O que você já viu (o componente redesenha quando muda). */
export function useSeenIdle(): SeenIdle {
  return useSyncExternalStore(subscribe, () => seen);
}

/**
 * A conversa na tela, parada, conta como vista: na hora, se a aba está à vista, ou quando você volta
 * para a aba. Antes da pintura, para o quadro não piscar a bolinha de quem você está olhando.
 */
export function useSeeIdle(live: LiveSession | null | undefined) {
  const id = live?.alive && live.status === 'idle' ? live.sessionId : null;
  const at = live?.statusUpdatedAt ?? '';
  useLayoutEffect(() => {
    if (!id) return;
    const look = () => {
      if (document.visibilityState === 'visible' && seen[id] !== at) save(withSeen(seen, id, at));
    };
    look();
    document.addEventListener('visibilitychange', look);
    return () => document.removeEventListener('visibilitychange', look);
  }, [id, at]);
}
