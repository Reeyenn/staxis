/**
 * Sentry Edge-runtime configuration.
 *
 * Loaded by src/instrumentation.ts only when NEXT_RUNTIME === 'edge'.
 * The Edge SDK has a smaller surface than the Node SDK (no native
 * modules, fewer integrations) but the init contract is the same.
 *
 * If SENTRY_DSN is empty, init runs and the SDK becomes a no-op —
 * downstream call sites don't need a DSN check.
 *
 * Security review 2026-05-16: added `scrubSentryEvent` `beforeSend`
 * for parity with the client + server configs. Today there are zero
 * edge-runtime routes in src/app/api, so this is a latent defense:
 * the moment a future route opts into `runtime = 'edge'` and throws
 * an error containing PII (phone/email/JWT/Bearer/Twilio SID),
 * the edge SDK would have shipped it un-scrubbed. With the hook,
 * scrubbing happens regardless of runtime.
 */

import * as Sentry from '@sentry/nextjs';
import { scrubSentryEvent } from '@/lib/sentry-scrub';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  debug: false,
  beforeSend: scrubSentryEvent,
});
