/* NUASA Library service worker. Bump VERSION to force clients to refresh cached files. */
const VERSION = "v13";
const SHELL = "nuasa-shell-" + VERSION;
const ASSETS = "nuasa-assets-" + VERSION;
const FILES = "nuasa-files"; // files students saved for offline. Never deleted by updates.
const PRECACHE = ["/", "/offline.html", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"];
// Public, read-only library data that may be shown offline (never user, profile, pending-review or CBT question data: CBT is a paid feature, so it always goes to the network).
const DATA = /^\/rest\/v1\/(courses|notebooks|prep_classes|opportunities|resources)(\?|$)/;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("nuasa-") && ![SHELL, ASSETS, FILES].includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Library data: use the network, but fall back to the last copy when offline or when the connection is very slow.
async function dataFirst(req) {
  const cache = await caches.open(ASSETS);
  const net = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; });
  net.catch(() => {});
  try {
    return await Promise.race([net, new Promise((_, no) => setTimeout(no, 6000))]);
  } catch (e) {
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
    try { return await net; } catch (_) { return Response.error(); }
  }
}

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;

  // Pages: network first so students always get the latest site, cached copy when offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put("/", copy));
        return res;
      }).catch(() => caches.match("/").then(r => r || caches.match("/offline.html")))
    );
    return;
  }

  // Course, file and class lists (approved items only).
  if (url.hostname.endsWith(".supabase.co") && DATA.test(url.pathname) && (!url.pathname.includes("/resources") || url.search.includes("status=eq.approved"))) {
    e.respondWith(dataFirst(req));
    return;
  }

  // Fonts, app scripts from the CDN, and same-origin static files: serve the saved copy fast, refresh in the background.
  const isCdn = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net"].includes(url.hostname);
  const isStatic = url.origin === location.origin && /\.(png|jpe?g|svg|webp|ico|css|js|woff2?|webmanifest)$/i.test(url.pathname);
  if (isCdn || isStatic) {
    e.respondWith(
      caches.open(ASSETS).then(cache =>
        cache.match(req).then(hit => {
          const net = fetch(req).then(res => { if (res.ok || res.type === "opaque") cache.put(req, res.clone()); return res; }).catch(() => hit);
          return hit || net;
        })
      )
    );
  }
  // Everything else (sign-in, uploads, payments, embeds, file downloads) always goes straight to the network.
});
