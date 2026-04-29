/**
 * Sentry surface for app code.
 *
 * Re-exports the two functions we actually call from log.ts and route
 * handlers. The whole point of going through this thin file is so we
 * have ONE place to swap in a different APM later (Datadog, OpenTelemetry,
 * etc.) without touching ~30 call sites.
 *
 * If SENTRY_DSN is unset in the env, Sentry.init (in sentry.{server,edge,
 * client}.config.ts) initializes the SDK to a no-op client. captureException
 * still goes through the API but never reaches the network. That means
 * code paths in log.ts and elsewhere don't need a DSN check.
 */

import * as Sentry from '@sentry/nextjs';

/**
 * Report an error to Sentry. Safe to call from anywhere — Sentry's API
 * never throws on errors of its own (it logs them and continues), so we
 * don't bother wrapping in try/catch here.
 *
 * `extra` lets the caller attach context (requestId, route, pid). It
 * shows up in the Sentry issue under "Additional Data".
 */
export function captureException(err: unknown, extra?: Record<string, unknown>): void {
  if (extra) {
    Sentry.withScope((scope) => {
      scope.setExtras(extra);
      Sentry.captureException(err);
    });
  } else {
    Sentry.captureException(err);
  }
}

/**
 * Report a non-error event (info-level worth flagging). Use sparingly —
 * captureMessage clutters the issue list quickly. Real errors should go
 * through captureException.
 */
export function captureMessage(message: string, extra?: Record<string, unknown>): void {
  if (extra) {
    Sentry.withScope((scope) => {
      scope.setExtras(extra);
      Sentry.captureMessage(message);
    });
  } else {
    Sentry.captureMessage(message);
  }
}
