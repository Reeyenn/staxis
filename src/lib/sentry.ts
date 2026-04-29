/**
 * Thin Sentry abstraction.
 *
 * The wiring is intentionally split into two layers so we can ship the
 * call sites *now* and turn Sentry on later without touching every route:
 *
 *   1. **Call sites** import { captureException } from '@/lib/sentry'
 *      and call it whenever they catch an error they want to track.
 *      They never import @sentry/nextjs directly.
 *
 *   2. **Initialization** happens in `src/instrumentation.ts` (Next.js
 *      convention — auto-loaded once per server / runtime). When
 *      SENTRY_DSN is set in the env, that file dynamically imports
 *      @sentry/nextjs, calls Sentry.init(...), and registers the
 *      captureException implementation here.
 *
 * Net effect when SENTRY_DSN is empty (the current default):
 *   - captureException(...) is a no-op (logs locally only).
 *   - No @sentry/nextjs dep is loaded at runtime.
 *   - Bundle size is unchanged.
 *
 * Net effect when SENTRY_DSN is set:
 *   - The first request after server startup calls Sentry.init.
 *   - All subsequent captureException calls flow to Sentry.
 *   - Errors include requestId / route / pid context (whatever the
 *     caller passed in `extra`).
 *
 * To fully turn it on:
 *   1. `npm install @sentry/nextjs`
 *   2. Sign up at sentry.io → create a Next.js project → grab the DSN
 *   3. Set SENTRY_DSN in Vercel env vars (Production + Preview)
 *   4. Optionally run `npx @sentry/wizard@latest -i nextjs` once for
 *      sourcemap upload + auth-token wiring (purely cosmetic — call
 *      sites already work without it).
 */

type CaptureFn = (err: unknown, extra?: Record<string, unknown>) => void;

// Default no-op. instrumentation.ts replaces this when SENTRY_DSN is set.
let _captureImpl: CaptureFn = () => {};

/**
 * Called once from instrumentation.ts after `import('@sentry/nextjs')`
 * resolves. Replaces the no-op with the real implementation.
 */
export function setCaptureImpl(fn: CaptureFn): void {
  _captureImpl = fn;
}

/**
 * Report an error to Sentry (if configured) without disturbing the
 * caller's control flow. Safe to call from anywhere — never throws.
 *
 * Usage:
 *   try { ... } catch (err) {
 *     captureException(err, { requestId, route: '/api/foo', pid });
 *     throw err; // or handle locally
 *   }
 */
export function captureException(err: unknown, extra?: Record<string, unknown>): void {
  try {
    _captureImpl(err, extra);
  } catch {
    // Swallow Sentry-side errors — we never want telemetry to break a
    // user request.
  }
}

/**
 * Convenience for "info-level" event capture (rare; mostly for tracking
 * unusual-but-not-error conditions worth investigating). Implementations
 * can choose to ignore these in production.
 */
export function captureMessage(message: string, extra?: Record<string, unknown>): void {
  try {
    _captureImpl(new Error(`[message] ${message}`), { ...extra, _level: 'info' });
  } catch {
    // see above
  }
}
