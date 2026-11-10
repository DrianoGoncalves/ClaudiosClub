import { useEffect, useState } from 'react';
import { api } from '../api';

// Instalação do Codex pela tela: a opção nas Configurações (ao ligar) e o botão do header dividem a mesma. Uma por vez: pedido
// enquanto instala espera a mesma. Fica só na memória da tela (um recarregar no meio perde o "instalando", não a instalação).

interface Setup {
  installing: boolean;
  /** Erro curto da última tentativa; null sem erro. */
  error: string | null;
}

let state: Setup = { installing: false, error: null };
let running: Promise<string | null> | null = null;
const listeners = new Set<() => void>();

function set(next: Setup) {
  state = next;
  listeners.forEach((l) => l());
}

/** Instala o Codex pelo servidor (se já estiver instalado, o servidor não roda o npm). Devolve o erro curto, ou null. */
export function installCodex(): Promise<string | null> {
  if (running) return running;
  set({ installing: true, error: null });
  running = api
    .installCodex()
    .then(
      (r) => (r.ok ? null : (r.error ?? 'não deu para instalar o Codex')),
      (e: Error) => e.message,
    )
    .then((error) => {
      running = null;
      set({ installing: false, error });
      return error;
    });
  return running;
}

/** A instalação do Codex em andamento na tela, e o erro da última tentativa. */
export function useCodexSetup(): Setup {
  const [s, setS] = useState(state);
  useEffect(() => {
    const sync = () => setS(state);
    listeners.add(sync);
    sync();
    return () => {
      listeners.delete(sync);
    };
  }, []);
  return s;
}
