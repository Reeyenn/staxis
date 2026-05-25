/* Housekeeper page service worker — piece C of the housekeeper mobile
 * rebuild (2026-05-25).
 *
 * Caches the housekeeper page shell + the assets it needs so a brief
 * connectivity drop doesn't leave the housekeeper looking at an empty
 * browser. Action queueing + replay is handled by the page itself via
 * IndexedDB (see src/lib/offline-sync/) — NOT by Background Sync, which
 * iOS Safari doesn't ship and which would silently no-op on most
 * housekeeper devices.
 *
 * Cache strategy:
 *   - Navigation requests for /housekeeper/* fall back to the cached
 *     shell when the network fails.
 *   - Static assets (/_next/static/...) are cache-first with a 7-day TTL.
 *   - Everything else passes through.
 *
 * Replaces the legacy `public/sw.js` kill-switch only for housekeeper-
 * scoped paths; other surfaces continue to use the kill-switch.
 */

const CACHE_NAME = 'staxis-hk-shell-v1';
const STATIC_CACHE = 'staxis-hk-static-v1';
const SHELL_URLS = ['/housekeeper'];
const STATIC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

self.addEventListener('install', (event) => {
  // Pre-cache the page shell so the first offline navigation works.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        await cache.addAll(SHELL_URLS);
      } catch {
        // Best-effort — if a URL 404s during install we still want the SW
        // to activate so action queueing still works.
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n !== CACHE_NAME && n !== STATIC_CACHE)
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests.
  if (url.origin !== self.location.origin) return;

  // Static Next assets — cache-first.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(staticCacheFirst(event.request));
    return;
  }

  // Navigation requests for /housekeeper/* — network-first with shell
  // fallback so an offline navigation still renders the empty shell
  // (which then mounts and pulls from IndexedDB).
  if (event.request.mode === 'navigate' && url.pathname.startsWith('/housekeeper')) {
    event.respondWith(navigationWithFallback(event.request));
    return;
  }

  // Everything else — pass through (don't intercept API mutations; the
  // page handles those via the IndexedDB queue).
});

async function navigationWithFallback(request) {
  try {
    const networkResp = await fetch(request);
    if (networkResp && networkResp.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResp.clone()).catch(() => {});
      return networkResp;
    }
    return networkResp;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    const shell = await cache.match('/housekeeper');
    if (shell) return shell;
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function staticCacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    // Check freshness via the Date header — if stale, refresh in the
    // background but still return the cached copy now.
    const dateStr = cached.headers.get('date');
    const dateMs = dateStr ? Date.parse(dateStr) : NaN;
    if (Number.isFinite(dateMs) && Date.now() - dateMs > STATIC_MAX_AGE_MS) {
      refreshStaticAsset(request, cache).catch(() => {});
    }
    return cached;
  }
  try {
    const resp = await fetch(request);
    if (resp && resp.ok) {
      cache.put(request, resp.clone()).catch(() => {});
    }
    return resp;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function refreshStaticAsset(request, cache) {
  try {
    const resp = await fetch(request);
    if (resp && resp.ok) await cache.put(request, resp);
  } catch {
    // best-effort
  }
}
