/**
 * Sentry Node-runtime configuration.
 *
 * Loaded by src/instrumentation.ts only when NEXT_RUNTIME === 'nodejs'.
 * If SENTRY_DSN is empty, Sentry.init still runs but the SDK becomes a
 * no-op — calls to captureException, captureMessage, etc. are silently
 * dropped. That keeps log.ts and downstream code call-site-clean whether
 * Sentry is configured or not.
 *
 * IMPORTANT: this file is intentionally at the repo root (NOT in src/) so
 * the Next.js + Sentry build wiring can find it via the convention path.
 */

import * as Sentry from '@sentry/nextjs';
import { getBaseSentryOptions } from '@/lib/sentry-base';

// Safety defaults (sendDefaultPii=false, beforeSend scrubber, ignoreErrors
// list for "failed to pipe response" upstream-fetch noise) live in
// getBaseSentryOptions so the three runtime configs (client / server / edge)
// can't drift. See src/lib/sentry-base.ts and src/lib/sentry-scrub.ts for
// the rationale on each default.

Sentry.init({
  ...getBaseSentryOptions(),
  dsn: process.env.SENTRY_DSN,

  // Bind the environment so issues are filterable in the dashboard.
  // VERCEL_ENV is "production" / "preview" / "development" on Vercel;
  // local dev falls back to NODE_ENV.
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',

  // Performance tracing — keep modest until we know real volume.
  // 0.1 = 10% of requests get a trace. We can crank it up if we want
  // more data, or turn it off entirely with 0 if Sentry's bill scares us.
  tracesSampleRate: 0.1,
});
