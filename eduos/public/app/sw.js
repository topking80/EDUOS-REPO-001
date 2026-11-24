// EduOS Mobile service worker (32.4.0, reviewed 33.2.0). Caches ONLY the
// static app shell (HTML, CSS, JS, icons, manifest) so the app opens with a
// clear "you're offline" state. It never caches /api/ or /auth/ responses:
// names, rosters, grades, pick-up passes and messages are not stored by the
// service worker. The only other on-device data is the encrypted offline
// write queue in app.js (see docs/UPGRADING-32.7.0.md, "What a phone keeps").
const SHELL = "eduos-app-shell-37.7.4";
const ASSETS = ["/app/", "/app/index.html", "/app/app.css", "/app/app.js", "/app/icon.svg", "/app/manifest.webmanifest"];
self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("eduos-app-shell-") && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return; // network only, never cached
  if (!url.pathname.startsWith("/app")) return;
  // Network first so updates land immediately; the cached shell is the offline fallback.
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok && ASSETS.includes(url.pathname)) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(url.pathname, copy)); }
    return res;
  }).catch(() => caches.match(url.pathname).then(hit => hit || caches.match("/app/index.html"))));
});
