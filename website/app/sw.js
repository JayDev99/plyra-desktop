// Keeps the app itself on the phone so it opens offline. Your books and progress live in IndexedDB (sync.js);
// calls to Plyra's service are never cached here.
const VERSION = "plyra-app-3";
const SHELL = [
  "./", "index.html", "app.css", "app.js", "board.js", "sync.js", "games.js", "review.js", "engine.js", "puzzles.js", "vendor/chess.js",
  "engine/stockfish-19-lite-single.js", "engine/stockfish-19-lite-single.wasm", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-180.png",
  ...["K", "Q", "R", "B", "N", "P"].flatMap(p => [`pieces/w${p}.svg`, `pieces/b${p}.svg`]),
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin === self.location.origin) {
    // the app: network first (so a new version shows at once), the cached copy when offline
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
  } else if (url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com")) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r;
    })));
  }
});
