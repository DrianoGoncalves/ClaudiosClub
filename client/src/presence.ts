// Sinal de presença da aba (server/tabPresence.ts): com "parar ao fechar a aba" ligado, o servidor só para quando NENHUMA aba dá sinal por uma carência inteira.
// Dá sinal sempre (o servidor o ignora com a opção desligada), assim ligar a opção com a aba já aberta vale na hora.

/** O servidor confere a cada 5 s e vale um sinal por 90 s: de 15 em 15 s sobra folga mesmo com o timer de aba escondida estrangulado pelo Chrome. */
const BEAT_MS = 15_000;

function tabId(): string {
  const raw = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64).padEnd(8, '0');
}

/** `keepalive` deixa o aviso de saída (`pagehide`) terminar depois que a página some. Falha de rede ou recusa não importam: o próximo sinal refaz. */
function beat(tab: string, leaving = false): void {
  void fetch('/api/presence', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-myco': '1' },
    body: JSON.stringify(leaving ? { tab, leaving: true } : { tab }),
    keepalive: true,
  }).catch(() => {});
}

/** Começa a dar sinal desta aba; devolve quem para. Um id por carga da página: F5 e duplicar a aba nunca dividem o mesmo. */
export function startPresence(): () => void {
  const tab = tabId();
  beat(tab);
  const timer = window.setInterval(() => beat(tab), BEAT_MS);
  const onHide = () => beat(tab, true);
  // Voltou do cache de páginas (botão Voltar): o timer pode ter ficado parado.
  const onShow = (e: PageTransitionEvent) => {
    if (e.persisted) beat(tab);
  };
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('pageshow', onShow);
  };
}
