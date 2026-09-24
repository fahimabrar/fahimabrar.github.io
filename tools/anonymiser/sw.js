// sw.js
// Service worker: makes the app work offline after the first visit.
//   - App shell (index.html, app.js, engine/) is precached and refreshed
//     network-first so updates arrive on the next load.
//   - Everything under vendor/ (libraries, fonts, OCR data, the NER model
//     parts) is versioned and immutable, so it is served cache-first and
//     stored the first time it is used.
// Nothing outside this site's origin is ever requested.

const SHELL_CACHE   = "pdfanon-shell-v2";
const RUNTIME_CACHE = "pdfanon-runtime-v2";

const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./engine/recognisers.js",
  "./engine/ner.js",
  "./engine/pdftools.js",
  "./vendor/fonts/fonts.css",
];

// ── Network activity reporting ───────────────────────────────────────────────
// Every request the page or its workers make passes through here, so this
// is the one place that can truthfully tell the page what touched the network.
let seq = 0;
async function broadcast(msg) {
  try {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clients) c.postMessage(msg);
  } catch (e) {}
}
const netStart = url => { const id = ++seq; broadcast({ type: "net", phase: "start", id, url }); return id; };
const netEnd   = (id, url, source, status) => broadcast({ type: "net", phase: "end", id, url, source, status });
const netCache = url => broadcast({ type: "net", phase: "done", url, source: "cache" });

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const id = netStart("precache: app files");
    try {
      const c = await caches.open(SHELL_CACHE);
      await c.addAll(SHELL_FILES);
      netEnd(id, "precache: app files", "network", 200);
    } catch (e) {
      netEnd(id, "precache: app files", "error", 0);
      throw e;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // The app never requests anything off-site. If something does, report it
  // loudly to the page (it shows as an external request in the indicator).
  if (url.origin !== self.location.origin) {
    broadcast({ type: "net", phase: "external", url: req.url });
    return;
  }

  // Vendored components: cache first, store on first use.
  if (url.pathname.includes("/vendor/")) {
    event.respondWith((async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) { netCache(req.url); return hit; }
      const id = netStart(req.url);
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then(c => c.put(req, copy));
        }
        netEnd(id, req.url, "network", res.status);
        return res;
      } catch (e) {
        netEnd(id, req.url, "error", 0);
        throw e;
      }
    })());
    return;
  }

  // App shell: network first, fall back to cache when offline.
  event.respondWith((async () => {
    const id = netStart(req.url);
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then(c => c.put(req, copy));
      }
      netEnd(id, req.url, "network", res.status);
      return res;
    } catch (e) {
      const hit = await caches.match(req, { ignoreSearch: true });
      netEnd(id, req.url, hit ? "cache" : "error", hit ? 200 : 0);
      if (hit) return hit;
      throw e;
    }
  })());
});
