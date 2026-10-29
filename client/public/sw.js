// Com o Claudio’s Club parado, nada responde na porta e o navegador mostraria "conexão recusada". Este
// service worker fica no navegador desde a última visita: se abrir uma página falhar por rede, responde
// com a tela de parado abaixo, que tem o botão Rodar. Fora isso, vai sempre à rede e não guarda nada
// (a tela mora aqui dentro: não depende do Cache Storage, que pode falhar).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(
      () => new Response(stoppedPage(), { headers:{ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }),
    ),
  );
});

// "Rodar" abre o link myco://start (registrado no Windows por `npm run launcher`) e recarrega assim
// que o Claudio’s Club responder; se ele subir por outro caminho (terminal, outra aba), entra sozinho.
// Textos da tela de parado. O service worker não lê o localStorage do Claudio’s Club: vale o idioma do navegador.
const STOPPED_TEXT = {
  'pt-BR': {
    title: 'Claudio’s Club parado',
    status: 'O Claudio’s Club está parado.',
    run: 'Rodar o Claudio’s Club',
    hint: 'Sobe em segundo plano, sem janela. Na primeira vez, o navegador pergunta se pode abrir o Claudio’s Club: confirme.',
    help: 'Nada aconteceu? Rode <code>npm run launcher</code> uma vez na pasta do Claudio’s Club (registra este botão) ou suba com <code>npm run daily:start</code>.',
    starting: 'Subindo o Claudio’s Club…',
    timeout: 'Não subiu em 3 minutos. Veja o log com npm run daily:status.',
  },
  en: {
    title: 'Claudio’s Club stopped',
    status: 'Claudio’s Club is stopped.',
    run: 'Run Claudio’s Club',
    hint: 'It starts in the background, with no window. The first time, the browser asks whether it can open Claudio’s Club: confirm.',
    help: 'Nothing happened? Run <code>npm run launcher</code> once in the Claudio’s Club folder (this registers the button) or start it with <code>npm run daily:start</code>.',
    starting: 'Starting Claudio’s Club…',
    timeout: 'It did not start within 3 minutes. Check the log with npm run daily:status.',
  },
  es: {
    title: 'Claudio’s Club detenido',
    status: 'Claudio’s Club está detenido.',
    run: 'Ejecutar Claudio’s Club',
    hint: 'Se inicia en segundo plano, sin ventana. La primera vez, el navegador pregunta si puede abrir Claudio’s Club: confirma.',
    help: '¿No pasó nada? Ejecuta <code>npm run launcher</code> una vez en la carpeta de Claudio’s Club (registra este botón) o inicia con <code>npm run daily:start</code>.',
    starting: 'Iniciando Claudio’s Club…',
    timeout: 'No se inició en 3 minutos. Revisa el log con npm run daily:status.',
  },
};

/** Idioma do navegador (pt, es ou en). */
function stoppedLocale() {
  const nav = String((self.navigator && self.navigator.language) || '').toLowerCase();
  if (nav.startsWith('pt')) return 'pt-BR';
  if (nav.startsWith('es')) return 'es';
  return 'en';
}

function stoppedPage() {
  const lang = stoppedLocale();
  const m = STOPPED_TEXT[lang];
  return `<!doctype html>
<html lang="${lang}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${m.title}</title>
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <style>
      :root { --bg: #f6f3ea; --card: #fffdf8; --ink: #1f2328; --muted: #6b6f76; --line: #ddd6c8; --blue: #2457c5; }
      @media (prefers-color-scheme: dark) {
        :root { --bg: #1a2026; --card: #222a31; --ink: #e8e6df; --muted: #9aa3ab; --line: #36414b; --blue: #9cc0ff; }
      }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, sans-serif; }
      main { width: min(440px, 100%); background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 24px 26px; display: grid; gap: 12px; }
      h1 { margin: 0; font-size: 30px; line-height: 1; }
      p { margin: 0; }
      .muted { color: var(--muted); font-size: 13px; }
      button { justify-self: start; font: inherit; font-weight: 600; padding: 9px 18px; border-radius: 9px; border: 0; background: var(--blue); color: #fff; cursor: pointer; }
      button:disabled { opacity: 0.6; cursor: default; }
      code { font-size: 12.5px; }
      [hidden] { display: none !important; }
    </style>
  </head>
  <body>
    <main>
      <h1>Claudio’s Club</h1>
      <p id="status">${m.status}</p>
      <button id="run" type="button">${m.run}</button>
      <p class="muted">${m.hint}</p>
      <p class="muted" id="help" hidden>
        ${m.help}
      </p>
    </main>
    <script>
      const T = ${JSON.stringify({ starting: m.starting, timeout: m.timeout })};
      const el = (id) => document.getElementById(id);
      const isUp = () => fetch('/api/health', { cache: 'no-store' }).then((r) => r.ok, () => false);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));

      el('run').addEventListener('click', async () => {
        el('run').disabled = true;
        el('status').textContent = T.starting;
        location.href = 'myco://start';
        for (let i = 1; i <= 90; i++) {
          await wait(2000);
          if (await isUp()) return location.reload();
          if (i === 8) el('help').hidden = false;
        }
        el('status').textContent = T.timeout;
        el('run').disabled = false;
      });

      (async () => {
        while (!(await isUp())) await wait(5000);
        location.reload();
      })();
    </script>
  </body>
</html>`;
}
