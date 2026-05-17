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
import { scrubString } from '@/lib/sentry-scrub';
import { getBaseSentryOptions } from '@/lib/sentry-base';

// Safety defaults (sendDefaultPii=false, beforeSend scrubber, ignoreErrors
// list) live in getBaseSentryOptions so the three runtime configs can't
// drift. See src/lib/sentry-base.ts and src/lib/sentry-scrub.ts.

Sentry.init({
  ...getBaseSentryOptions(),

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

  // 2026-05-12 (Codex audit follow-up): use the SHARED scrubString from
  // sentry-scrub.ts so breadcrumbs and events scrub against the same set
  // of patterns. Previously the breadcrumb hook used a 3-pattern inline
  // scrubber while events used the 7-pattern shared one, which let JWTs
  // and Twilio SIDs slip past the breadcrumb path.
  beforeBreadcrumb: (crumb) => {
    if (!crumb) return crumb;
    if (crumb.message) {
      crumb.message = scrubString(crumb.message);
    }
    if (crumb.data && typeof crumb.data === 'object') {
      for (const k of Object.keys(crumb.data)) {
        const v = (crumb.data as Record<string, unknown>)[k];
        if (typeof v === 'string') (crumb.data as Record<string, unknown>)[k] = scrubString(v);
      }
    }
    return crumb;
  },
});
