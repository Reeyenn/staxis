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
import { scrubSentryEvent } from '@/lib/sentry-scrub';

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

  // 2026-05-12 (Codex audit): sendDefaultPii=false sanitises the SDK's
  // automatic IP / cookie / header capture, but does NOT scrub PII out
  // of custom error messages, tags, breadcrumbs, or contexts. Hotel-ops
  // errors routinely embed staff phone numbers, names, PMS payloads,
  // and shift IDs. The shared scrubber below redacts those before
  // ingestion so the Sentry project is GDPR/CCPA-safer by default.
  beforeSend: scrubSentryEvent,
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

// Local import-free scrubber for the breadcrumb hook (avoids circular).
function scrubString(s: string): string {
  return s
    // E.164 / 10-digit US phones
    .replace(/\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, '<phone>')
    // emails
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '<email>')
    // Authorization headers
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1<redacted>');
}
