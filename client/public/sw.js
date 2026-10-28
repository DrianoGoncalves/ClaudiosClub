// Com o MyCo parado, nada responde na porta e o navegador mostraria "conexão recusada". Este
// service worker fica no navegador desde a última visita: se abrir uma página falhar por rede, responde
// com a tela de parado abaixo, que tem o botão Rodar. Fora isso, vai sempre à rede e não guarda nada
// (a tela mora aqui dentro: não depende do Cache Storage, que pode falhar).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(
      () => new Response(STOPPED_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }),
    ),
  );
});

// "Rodar" abre o link myco://start (registrado no Windows por `npm run launcher`) e recarrega assim
// que o MyCo responder; se ele subir por outro caminho (terminal, outra aba), entra sozinho.
const STOPPED_PAGE = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MyCo parado</title>
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
      <h1>MyCo</h1>
      <p id="status">O MyCo está parado.</p>
      <button id="run" type="button">Rodar o MyCo</button>
      <p class="muted">Sobe em segundo plano, sem janela. Na primeira vez, o navegador pergunta se pode abrir o MyCo: confirme.</p>
      <p class="muted" id="help" hidden>
        Nada aconteceu? Rode <code>npm run launcher</code> uma vez na pasta do MyCo (registra este botão) ou suba com
        <code>npm run daily:start</code>.
      </p>
    </main>
    <script>
      const el = (id) => document.getElementById(id);
      const isUp = () => fetch('/api/health', { cache: 'no-store' }).then((r) => r.ok, () => false);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));

      el('run').addEventListener('click', async () => {
        el('run').disabled = true;
        el('status').textContent = 'Subindo o MyCo…';
        location.href = 'myco://start';
        for (let i = 1; i <= 90; i++) {
          await wait(2000);
          if (await isUp()) return location.reload();
          if (i === 8) el('help').hidden = false;
        }
        el('status').textContent = 'Não subiu em 3 minutos. Veja o log com npm run daily:status.';
        el('run').disabled = false;
      });

      (async () => {
        while (!(await isUp())) await wait(5000);
        location.reload();
      })();
    </script>
  </body>
</html>`;
