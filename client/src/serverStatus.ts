// Servidor fora do ar: "reiniciando" só vale pelo tempo de um reinício de verdade. Passado o limite, ninguém vai religá-lo
// sozinho (foi o caso do sistema matar o Claudio’s Club por falta de memória): a tela troca o "reiniciando" por um aviso
// fixo (ServerStoppedBanner) que manda ir à página de início, onde está o botão Iniciar.
import { useSyncExternalStore } from 'react';

/**
 * Quanto esperar antes de dizer que o Claudio’s Club parou. Um reinício normal (sai o processo, o launcher sobe outro, o
 * servidor lê o quadro) volta em segundos; 60 s dá folga para uma máquina lenta ou um disco frio sem deixar o usuário
 * esperando um minuto e meio à toa com o app desligado.
 */
export const RESTART_LIMIT_MS = 60_000;
/** De quanto em quanto tempo perguntar se o servidor voltou (só enquanto ele está fora). */
export const PROBE_MS = 3_000;

export type ServerPhase = 'up' | 'restarting' | 'stopped';

/** A decisão: `downSince` é quando a primeira falha de rede aconteceu (null = no ar). */
export function serverPhase(downSince: number | null, now: number, limit = RESTART_LIMIT_MS): ServerPhase {
  if (downSince === null) return 'up';
  return now - downSince >= limit ? 'stopped' : 'restarting';
}

let downSince: number | null = null;
let phase: ServerPhase = 'up';
let probe: ReturnType<typeof setInterval> | undefined;
let stopTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function set(next: ServerPhase) {
  if (next === phase) return;
  phase = next;
  listeners.forEach((l) => l());
}

function refresh() {
  set(serverPhase(downSince, Date.now()));
}

/** O servidor voltou: o aviso some e a sonda para. */
export function noteOnline() {
  downSince = null;
  clearInterval(probe);
  clearTimeout(stopTimer);
  probe = undefined;
  stopTimer = undefined;
  refresh();
}

/** Uma chamada falhou por rede. A primeira marca o início da queda; as seguintes não o adiam. */
export function noteOffline(now = Date.now()) {
  if (downSince !== null) return;
  downSince = now;
  stopTimer = setTimeout(refresh, RESTART_LIMIT_MS);
  probe = setInterval(() => {
    fetch('/api/health', { cache: 'no-store' }).then((r) => r.ok && noteOnline(), () => {});
  }, PROBE_MS);
  refresh();
}

/** A chave da mensagem de erro de uma ação que falhou por rede: "reiniciando" só até o limite; depois, "parou" e o que fazer. */
export function offlineMessageKey(): 'app.serverOffline' | 'app.serverStoppedAction' {
  return serverPhase(downSince, Date.now()) === 'stopped' ? 'app.serverStoppedAction' : 'app.serverOffline';
}

export function useServerPhase(): ServerPhase {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => phase,
    () => 'up',
  );
}

/** Estado para os testes. */
export function resetServerStatus() {
  noteOnline();
}
