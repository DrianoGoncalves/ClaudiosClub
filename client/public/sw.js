// Com o Claudio’s Club parado, nada responde na porta e o navegador mostraria "conexão recusada". Este
// service worker fica no navegador desde a última visita: se abrir uma página falhar por rede, responde com a
// página de início (scripts/start.html, servida em /start.html num arquivo só), com o checklist e o botão
// Iniciar. Ela e o checklist (/status.js) são guardados a cada visita com o servidor no ar; o resto vai sempre
// à rede e não é guardado.

const CACHE = 'claudio-parado-v1';
const PAGE = '/start.html';
const STATUS = '/status.js';

// Sem cópia guardada (Cache Storage indisponível ou primeira visita interrompida): o mínimo para saber o que fazer.
const FALLBACK = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Claudio’s Club</title></head>
<body style="font: 15px/1.45 system-ui, sans-serif; padding: 24px">
<p>O Claudio’s Club está parado. Para subir, rode <code>npm run daily:start</code> na pasta do projeto.</p>
<script>setInterval(() => fetch('/api/health').then((r) => r.ok && location.reload(), () => {}), 5000);</script>
</body></html>`;

/** Guarda a página de início e o checklist atuais; cada um falha sozinho (sem doctor, não há /status.js). */
function store() {
  return caches
    .open(CACHE)
    .then((cache) => Promise.all([cache.add(PAGE).catch(() => {}), cache.add(STATUS).catch(() => {})]))
    .catch(() => {});
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(store());
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(
        (res) => {
          event.waitUntil(store());
          return res;
        },
        () =>
          caches
            .match(PAGE)
            .catch(() => null)
            .then((page) => page || new Response(FALLBACK, { headers: { 'content-type': 'text/html; charset=utf-8' } })),
      ),
    );
    return;
  }

  // O checklist pede status.js?t=…: com o servidor parado, vale a última cópia guardada.
  if (url.pathname === STATUS) {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches
          .match(STATUS, { ignoreSearch: true })
          .catch(() => null)
          .then((st) => st || new Response('', { status: 404 })),
      ),
    );
  }
});
