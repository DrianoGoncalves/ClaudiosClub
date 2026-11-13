// Polling que poupa o servidor: com a aba escondida não consulta (ou consulta bem mais devagar);
// ao voltar, consulta na hora e retoma o ritmo normal. Devolve a função que desliga tudo.

/**
 * Chama `fn` a cada `ms` com a aba visível. Escondida: para (`hiddenMs` ausente) ou desacelera para `hiddenMs`.
 * Ao ficar visível de novo chama `fn` na hora. A 1ª chamada, ao montar, continua com quem usa.
 */
export function pollVisible(fn: () => void, ms: number, hiddenMs: number | null = null): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const start = () => {
    stop();
    const every = document.hidden ? hiddenMs : ms;
    if (every !== null) timer = setInterval(fn, every);
  };
  const onChange = () => {
    if (!document.hidden) fn();
    start();
  };
  start();
  document.addEventListener('visibilitychange', onChange);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onChange);
  };
}

/**
 * Igual, para quem muda o ritmo a cada resposta: `step` roda na hora e devolve em quantos ms rodar de novo
 * (null = não rodar mais). Com a aba escondida o próximo passo espera ela voltar e roda na hora.
 */
export function pollVisibleLoop(step: () => Promise<number | null>): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  let running = false;
  const run = async () => {
    clearTimeout(timer);
    if (!alive || running) return;
    running = true;
    let next: number | null = null;
    try {
      next = await step();
    } finally {
      running = false;
    }
    if (!alive || next === null) return;
    timer = setTimeout(() => {
      // Escondida: não consulta; o `visibilitychange` retoma.
      if (!document.hidden) void run();
    }, next);
  };
  const onChange = () => {
    if (!document.hidden) void run();
  };
  void run();
  document.addEventListener('visibilitychange', onChange);
  return () => {
    alive = false;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onChange);
  };
}
