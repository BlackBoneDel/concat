/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* SPDX-FileCopyrightText: 2026 Jareer and Concat contributors */

/*
 * Fase 6: Concat's service worker. Network-first for everything on our own
 * origin (a fresh deploy always wins when online), falling back to the
 * cache offline; navigations fall back to the cached shell, then to
 * offline.html. The build replaces the two placeholders below with the
 * build id and the list of hashed assets to precache. Never touches other
 * origins (the app makes no external requests anyway), never caches
 * partial (206) or opaque responses, and skips waiting only when the page
 * asks (the "update available" toast).
 */

const BUILD_ID = '__CONCAT_BUILD_ID__';
const PRECACHE_ASSETS = /*__CONCAT_PRECACHE__*/ [];
const SHELL = ['./', './index.html', './offline.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];
/*
 * Fase 7+: explicit cache-schema version. Bumping it invalidates every
 * cache of previous deploys on activate (the cleanup below deletes all
 * `concat-*` caches that are not the two current ones), which is how the
 * stale GitHub Pages shells of earlier fases get evicted. Keep in sync
 * with SW_CACHE_VERSION in src/pwa/sw-register.ts.
 */
const CACHE_VERSION = 'v7';
const CACHE = `concat-${CACHE_VERSION}-${BUILD_ID}`;
const RUNTIME = `concat-runtime-${CACHE_VERSION}-${BUILD_ID}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      const urls = [...new Set([...SHELL, ...PRECACHE_ASSETS])];
      // One failing asset must not abort the whole install.
      await Promise.all(urls.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined)));
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([CACHE, RUNTIME]);
      for (const key of await caches.keys()) {
        if (key.startsWith('concat-') && !keep.has(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') void self.skipWaiting();
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok && response.status === 200 && response.type === 'basic') {
      const copy = response.clone();
      void caches.open(RUNTIME).then((cache) => cache.put(request, copy)).catch(() => undefined);
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      return (await caches.match('./index.html')) || (await caches.match('./')) || (await caches.match('./offline.html')) || Response.error();
    }
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});
