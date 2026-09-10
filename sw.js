// Service worker simples - cache básico só pra permitir instalar como app.
// Sempre busca a versão mais nova da rede quando há internet.
const CACHE = 'agenda-olhatta-v1';
const ARQUIVOS = ['./', './index.html', './app.js', './firebase-config.js', './manifest.json'];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ARQUIVOS)).catch(() => {}));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(chaves => Promise.all(chaves.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request).then(resp => {
      const copia = resp.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copia)).catch(() => {});
      return resp;
    }).catch(() => caches.match(event.request))
  );
});
