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
    <link rel="icon" href="/icon-32.png" sizes="32x32" type="image/png" />
    <style>
      /* O DS do app (client/src/styles.css), como em scripts/start.html. Com o servidor parado, logo e
         fonte só aparecem se o navegador guardou; senão, some o logo e vale a manuscrita do sistema. */
      :root {
        --board: #fbfaf6; --board-dot: #dcd8cd; --card: #fffdf8; --ink: #1f2328; --ink-blue: #1f4fbf;
        --muted: #6b7076; --line: #e4e1da;
        --hand: 'Caveat', 'Segoe Print', 'Comic Sans MS', cursive;
      }
      @media (prefers-color-scheme: dark) {
        :root { --board: #1f2a25; --board-dot: #34433b; --card: #27322c; --ink: #eef0ea; --ink-blue: #9cc0ff; --muted: #a3aca7; --line: #3a4540; }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
        color: var(--ink); font: 15px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif;
        background: var(--board) radial-gradient(var(--board-dot) 1.2px, transparent 1.4px) 0 0 / 28px 28px;
      }
      main {
        width: min(440px, 100%); display: grid; gap: 10px; padding: 22px 24px;
        background: var(--card); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.12);
      }
      header { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
      header img { width: 56px; height: 56px; flex: none; }
      h1 { margin: 0; font-family: var(--hand); font-weight: 700; font-size: 38px; line-height: 1; }
      p { margin: 0; }
      .muted { color: var(--muted); font-size: 13px; }
      button {
        justify-self: start; font: inherit; font-size: 14px; font-weight: 600; padding: 8px 16px; cursor: pointer;
        color: var(--card); background: var(--ink-blue); border: 1px solid var(--ink-blue); border-radius: 6px;
      }
      button:hover:not(:disabled) { filter: brightness(1.08); }
      button:focus-visible { outline: 2px solid var(--ink-blue); outline-offset: 2px; }
      button:disabled { opacity: 0.6; cursor: default; }
      code { font: 12.5px ui-monospace, Consolas, monospace; background: color-mix(in srgb, var(--ink) 8%, transparent); padding: 0 3px; border-radius: 3px; }
      [hidden] { display: none !important; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <img src="/icon-192.png" alt="" onerror="this.remove()" />
        <h1>Claudio’s Club</h1>
      </header>
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
