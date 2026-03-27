// Kill-switch service worker — v2
// Clears the stale hotelops-v1 cache that was blocking JS bundle updates,
// then unregisters itself so future requests go directly to Vercel's CDN.
// The firebase-messaging-sw.js handles FCM push notifications separately.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Delete every cache bucket (removes stale hotelops-v1 JS chunks).
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));

      // Unregister so this SW no longer intercepts requests.
      await self.registration.unregister();

      // Reload all open tabs so they pick up fresh bundles immediately.
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of clients) {
        client.navigate(client.url);
      }
    })()
  );
});
