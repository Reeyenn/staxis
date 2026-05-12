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
import { scrubSentryEvent } from '@/lib/sentry-scrub';

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Bind the environment so issues are filterable in the dashboard.
  // VERCEL_ENV is "production" / "preview" / "development" on Vercel;
  // local dev falls back to NODE_ENV.
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',

  // Performance tracing — keep modest until we know real volume.
  // 0.1 = 10% of requests get a trace. We can crank it up if we want
  // more data, or turn it off entirely with 0 if Sentry's bill scares us.
  tracesSampleRate: 0.1,

  // Don't send PII (request bodies, cookies, headers) by default. Routes
  // that legitimately want this can opt in per-event via withScope.
  sendDefaultPii: false,

  // 2026-05-12: drop transient upstream-fetch noise from the Sentry inbox.
  // Routes like /api/admin/build-status fan-out to many external APIs
  // (GitHub, Vercel, Fly) in parallel. When any of those connections is
  // closed mid-response, undici raises SocketError: other side closed
  // → TypeError: fetch failed → Next.js wraps it as "failed to pipe
  // response". The caller already catches these (Promise.all(.catch())
  // pattern) so the user sees no degradation — they're pure noise. Sentry's
  // auto-instrumentation still captures them before our catch runs, which
  // is what we're filtering here. If we ever stop catching upstream fetch
  // errors at the route level, REMOVE these so we don't silently mask
  // real outages.
  ignoreErrors: [
    'failed to pipe response',
    /other side closed/,
  ],

  // 2026-05-12 (Codex audit): scrub custom error text / tags / contexts /
  // breadcrumbs for PII (phones, emails, JWT/Bearer tokens, etc.) before
  // ingestion. sendDefaultPii=false only handles the SDK's automatic
  // capture; staff names and PMS payloads in custom errors slipped
  // through. See src/lib/sentry-scrub.ts.
  beforeSend: scrubSentryEvent,

  // Reduce log noise during deploys — Vercel rebuilds churn through
  // serverless containers and we don't need an init line per cold start.
  debug: false,
});
