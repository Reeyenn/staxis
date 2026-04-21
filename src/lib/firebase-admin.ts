import admin from 'firebase-admin';

// ─── Why this file is hardened ─────────────────────────────────────────────
// The previous version silently console.warn'd when env vars were missing
// and then admin.firestore() would throw an obscure "default Firebase app
// does not exist" from some unrelated API route. We also learned on
// 2026-04-21 that if the Vercel env var holds a stale/revoked service
// account key, the Admin SDK's initializeApp() succeeds (it's lazy), and
// only the *first Firestore call* blows up with "16 UNAUTHENTICATED" —
// which looks like any other 500 to GitHub Actions and to the SMS alerter.
//
// Now: missing env vars throw loudly at module load with the exact var
// names, and a `verifyFirebaseAuth()` helper lets routes do a cheap preflight
// that surfaces auth failures with a specific, actionable error.
// ───────────────────────────────────────────────────────────────────────────

// Prevent duplicate initialization across Next.js hot reload and serverless
// warm containers.
if (!admin.apps.length) {
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey  = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const projectId   = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

  const missing: string[] = [];
  if (!clientEmail) missing.push('FIREBASE_ADMIN_CLIENT_EMAIL');
  if (!privateKey)  missing.push('FIREBASE_ADMIN_PRIVATE_KEY');
  if (!projectId)   missing.push('NEXT_PUBLIC_FIREBASE_PROJECT_ID');
  if (missing.length) {
    throw new Error(
      `Firebase Admin SDK missing required Vercel env vars: ${missing.join(', ')}. ` +
      `Fix: Vercel Project Settings → Environment Variables, then redeploy.`
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert({ clientEmail, privateKey, projectId }),
  });
}

// Preflight: does a cheap authenticated Firestore read to verify the service
// account key is still valid. Call from any route that absolutely needs
// admin access (e.g. /api/cron/scraper-health) before doing real work.
//
// Memoized per warm container so only the first request per cold-start pays
// the ~50–200ms round-trip. A failure clears the cache so the next request
// retries (lets a fresh redeploy's env vars take effect without waiting for
// container cycling).
let authPreflight: Promise<void> | null = null;
export async function verifyFirebaseAuth(): Promise<void> {
  if (!authPreflight) {
    authPreflight = (async () => {
      try {
        await admin.firestore().collection('scraperStatus').doc('heartbeat').get();
      } catch (err) {
        authPreflight = null; // allow retry on next request
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Firebase Admin auth failed on Vercel: ${msg}. ` +
          `FIREBASE_ADMIN_PRIVATE_KEY is likely stale or revoked. ` +
          `Fix: Firebase Console → Project Settings → Service Accounts → ` +
          `Generate new private key, then update BOTH ` +
          `Vercel (FIREBASE_ADMIN_PRIVATE_KEY) AND Railway (FIREBASE_PRIVATE_KEY).`
        );
      }
    })();
  }
  return authPreflight;
}

export default admin;
