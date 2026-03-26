// Firebase Messaging Service Worker
// Handles background push notifications AND offline app-shell caching

importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyCaZOj0pSfzzslK1CBv9DNBL0O2V7LWnVs',
  authDomain: 'hotelops-ai.firebaseapp.com',
  projectId: 'hotelops-ai',
  storageBucket: 'hotelops-ai.firebasestorage.app',
  messagingSenderId: '307553713414',
  appId: '1:307553713414:web:c2de3afcc4b4a9a11bb287',
});

const messaging = firebase.messaging();

// Handle background messages (app is closed or in background tab)
messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification ?? {};
  if (!title) return;

  self.registration.showNotification(title, {
    body: body ?? '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'room-assignment',        // replaces previous notification instead of stacking
    renotify: true,
    data: payload.data ?? {},
  });
});

// ─── App Shell Offline Caching ──────────────────────────────────────────────

const CACHE_NAME = 'hotelops-shell-v1';

// Pages to pre-cache so the app shell loads offline
const SHELL_URLS = ['/', '/dashboard', '/manifest.json'];

self.addEventListener('install', (event) => {
  // Pre-cache the app shell; skip waiting so the new SW activates immediately
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Remove any old cache versions
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only cache same-origin GET requests for navigation (HTML pages)
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    !event.request.url.startsWith(self.location.origin) ||
    url.pathname.startsWith('/api/')
  ) {
    return; // Let non-cacheable requests pass through unmodified
  }

  // Network-first strategy: try network, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses for navigation requests
        if (response.ok && event.request.mode === 'navigate') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() =>
        // Offline: serve from cache, or the root shell as last resort
        caches.match(event.request).then(
          (cached) => cached ?? caches.match('/')
        )
      )
  );
});
