/* Кэш оболочки. Имя версии — единственное, что нужно менять при выпуске:
   старые версии стираются при активации, чужие хранилища не трогаются. */
const CACHE = "ayumi-v5";
const SHELL = ["./", "./index.html", "./app.js", "./manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      /* Чистим ТОЛЬКО прошлые версии оболочки. Всё остальное — картинки,
         вложения, звук — данные человека, и обновление их не касается. */
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("ayumi-v") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // чужие адреса не трогаем вовсе: видео, шрифты, чужое апи должны идти напрямую
  if (url.origin !== location.origin) return;
  if (e.request.method !== "GET") return;
  // версия и данные всегда из сети: по ним проверяется обновление
  if (url.pathname.endsWith("version.json")) return;

  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => hit))
  );
});
