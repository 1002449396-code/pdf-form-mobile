// Service worker: makes the app work with no connection, and receives files
// shared to it from other apps.
//
// assets.js is GENERATED (node tools/build-assets.mjs) and lists every file
// the app needs plus a VERSION hashed from their contents, so any change to
// any file installs a fresh cache and the old one is dropped.

importScripts("assets.js");

const CACHE = "app-" + self.VERSION;
const SHARED = "shared-file";   // the one file handed over from the share sheet

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(self.ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE && key !== SHARED) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  if (e.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== "GET") return;

  // Cache first: the app is the same files until the next version, and a
  // network round-trip would make it useless offline. ignoreSearch so that
  // ./?shared is answered by the cached ./
  e.respondWith((async () => {
    const hit = await caches.match(e.request, { ignoreSearch: true, cacheName: CACHE });
    return hit || fetch(e.request);
  })());
});

// The share sheet POSTs the file here. It is parked in a cache (it never
// leaves the phone) and the app is reloaded, which picks it up.
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const file = form.getAll("file").find((f) => f && f.size);
    if (file) {
      const cache = await caches.open(SHARED);
      await cache.put("shared", new Response(file, {
        headers: { "Content-Type": "application/pdf",
                   "X-File-Name": encodeURIComponent(file.name || "") },
      }));
    }
  } catch (err) {
    console.error(err);
  }
  return Response.redirect("./?shared=1", 303);
}
