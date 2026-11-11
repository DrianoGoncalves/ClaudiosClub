import type { Engine } from '../../../shared/model';

// Avisos da trava de consumo no chat, sem tela: a ponte entre quem manda (api.ts, useChat) e os modais do design system
// (usageWarning.tsx, montados uma vez no App). Lógica pura, testada em tests/usageWarning.test.ts.

/** O envio que passou para o motor secundário (a resposta do chat/send traz `fallback`). */
export interface FallbackNotice {
  projectId: string;
  name: string;
  engine: Engine;
  model: string;
}

export const FALLBACK_NOTICE_EVENT = 'myco:fallback-notice';
const hideKey = (projectId: string) => `myco.hideFallbackNotice.${projectId}`;
// Se o sessionStorage estiver bloqueado, "não avisar" vale enquanto a página estiver aberta.
const hiddenInMemory = new Set<string>();

/** "Não avisar nesta sessão": guardado por projeto no sessionStorage (some ao fechar a aba). */
export function fallbackNoticeHidden(projectId: string): boolean {
  if (hiddenInMemory.has(projectId)) return true;
  try {
    return sessionStorage.getItem(hideKey(projectId)) === '1';
  } catch {
    return false;
  }
}

export function hideFallbackNotice(projectId: string): void {
  hiddenInMemory.add(projectId);
  try {
    sessionStorage.setItem(hideKey(projectId), '1');
  } catch {
    /* segue oculto na memória */
  }
}

/** Abre o aviso da troca, a não ser que o dono já tenha dispensado neste projeto. Devolve se abriu. */
export function announceFallback(notice: FallbackNotice): boolean {
  if (fallbackNoticeHidden(notice.projectId)) return false;
  window.dispatchEvent(new CustomEvent(FALLBACK_NOTICE_EVENT, { detail: notice }));
  return true;
}

/** A resposta do chat/send: se trouxe `fallback`, a mensagem foi para o secundário e o aviso abre. Sem o campo, nada. */
export function announceSent(projectId: string, name: string, sent: { fallback?: { engine: Engine; model: string } }): boolean {
  return sent.fallback ? announceFallback({ projectId, name, engine: sent.fallback.engine, model: sent.fallback.model }) : false;
}

/** Uma pergunta da trava (409 `usage-stop`): o texto do motivo e a resposta do dono. */
export interface UsageStopAsk {
  text: string;
  answer: (go: boolean) => void;
}

let asker: ((ask: UsageStopAsk) => void) | null = null;

/** O modal do App se registra aqui; devolve o cancelamento do registro. */
export function onUsageStopAsk(fn: (ask: UsageStopAsk) => void): () => void {
  asker = fn;
  return () => {
    if (asker === fn) asker = null;
  };
}

/** Pergunta no modal do design system se segue mesmo assim. Sem modal montado, não segue (nunca passa da trava sem o ok). */
export function askUsageStop(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!asker) return resolve(false);
    asker({ text, answer: resolve });
  });
}
