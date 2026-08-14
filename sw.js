/* Сеть в приоритете, кэш — только как запасной вариант.
   Из-за этого приложение всегда свежее, когда связь есть, и всё равно
   открывается офлайн. Обратный порядок (кэш вперёд) как раз и приводит
   к тому, что на телефоне неделями живёт старая копия. */
const CACHE = 'ayumi-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return;   // гист и прочее — мимо

  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-store' });
      if (res && res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch (err) {
      return (await caches.match(req)) || Response.error();
    }
  })());
});
