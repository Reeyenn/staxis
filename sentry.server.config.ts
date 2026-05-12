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
