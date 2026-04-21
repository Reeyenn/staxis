import { initializeApp, getApps, getApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { getAuth } from 'firebase/auth';
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Prevent duplicate initialization in Next.js hot reload
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Initialize Firebase App Check with reCAPTCHA v3. Runs only in the browser.
// Enforcement is set to UNENFORCED in Firebase (monitoring mode) so missing
// or invalid tokens won't break the app — this is a gradual rollout.
// Falls back silently if init fails (e.g. env var missing, duplicate init).
if (typeof window !== 'undefined') {
  const recaptchaSiteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;
  if (recaptchaSiteKey) {
    try {
      initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(recaptchaSiteKey),
        isTokenAutoRefreshEnabled: true,
      });
    } catch (e) {
      console.warn('App Check: initialization failed', e);
    }
  }
}

export const auth = getAuth(app);

// Enable IndexedDB offline persistence in the browser so housekeepers can
// read and write room data without an internet connection. Writes are queued
// locally and automatically synced when the connection returns.
// On the server (SSR/API routes) we fall back to in-memory storage.
// Falls back gracefully if persistent cache fails (e.g. corrupted IndexedDB).
export const db = (() => {
  if (typeof window !== 'undefined') {
    try {
      return initializeFirestore(app, {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      });
    } catch (e) {
      // Firestore was already initialized (e.g. Next.js HMR), or persistent
      // cache setup failed (corrupted IndexedDB) - reuse default instance.
      console.warn('Firestore: falling back to default instance', e);
      return getFirestore(app);
    }
  }
  return getFirestore(app);
})();

export default app;
