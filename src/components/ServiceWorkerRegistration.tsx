'use client';

import { useEffect } from 'react';

/** Registers the app-shell service worker once on mount. No-op in dev mode. */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker
        .register('/sw.js')
        .catch((err) => console.warn('[SW] Registration failed:', err));
    }
  }, []);

  return null;
}
