// HotelOps AI — Service Worker
// Caches the app shell so the UI loads offline; actual room data is handled
// by Firestore's built-in IndexedDB persistence layer.

const CACHE_NAME = 'hotelops-v1';

// ─── Install ──────────────────────────────────────────────────────────────────
// Pre-cache the root so navigation works immediately on first offline visit.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.add('/'))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()) // don't block install if root fetch fails
  );
});

// ─── Activate ─────────────────────────────────────────────────────────────────
// Remove old caches and immediately control all open tabs.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests.
  if (request.method !== 'GET') return;

  // Skip requests to external origins (Firebase APIs, Google Fonts CDN, etc.).
  // Firestore handles its own offline caching via IndexedDB — don't intercept it.
  if (url.hostname !== self.location.hostname) return;

  // ── Strategy 1: Cache-first for immutable Next.js static chunks ──────────
  // _next/static/ files have content hashes in their names — once cached,
  // they never change, so serve directly from cache if available.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            caches.open(CACHE_NAME).then((cache) =>
              cache.put(request, response.clone())
            );
          }
          return response;
        });
      })
    );
    return;
  }

  // ── Strategy 2: Network-first for HTML navigation requests ───────────────
  // Try the network; fall back to the cached version or the root shell.
  // This keeps pages fresh while still working offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            caches.open(CACHE_NAME).then((cache) =>
              cache.put(request, response.clone())
            );
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          // Fall back to the root shell for any unrecognised route.
          const root = await caches.match('/');
          return root || new Response('Offline', { status: 503 });
        })
    );
    return;
  }

  // ── Strategy 3: Stale-while-revalidate for everything else ───────────────
  // Return cache immediately (fast) while refreshing in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request).then((response) => {
        if (response.ok) {
          caches.open(CACHE_NAME).then((cache) =>
            cache.put(request, response.clone())
          );
        }
        return response;
      });
      return cached || networkFetch;
    })
  );
});
