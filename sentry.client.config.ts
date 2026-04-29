/**
 * Sentry browser-runtime configuration.
 *
 * Auto-loaded by Next.js when @sentry/nextjs is installed. Captures
 * unhandled errors and rejections from the React app running in
 * Mario / staff browsers.
 *
 * If SENTRY_DSN is empty, init runs and the SDK becomes a no-op.
 */

import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN,

  environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV || 'development',

  // Conservative sampling — staff phones aren't a great place to ship
  // megabytes of perf data over LTE.
  tracesSampleRate: 0.05,

  // Session replay is GREAT for debugging UI bugs but expensive on the
  // free plan. Off by default; we can flip to 0.1 if we want.
  replaysSessionSampleRate: 0,
  // Always replay sessions where an error occurred — best signal-per-byte.
  replaysOnErrorSampleRate: 1.0,

  sendDefaultPii: false,
  debug: false,
});
