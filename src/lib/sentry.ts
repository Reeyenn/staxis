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
 *
 * ─── Per-property tagging (Tier 3 scaling) ────────────────────────────
 * For fleet-of-N-hotels operations, "show me all errors from property X"
 * is a routine debugging move. Sentry exposes two attribute kinds:
 *   - extras: free-form bag, only visible by drilling into a single event
 *   - tags:   first-class indexed dimension, supports filters/dashboards/
 *             alerts (e.g. "alert if property Y > 10 errors/hour")
 *
 * Most code already passes the property identifier in log fields as
 * `pid`, `property_id`, or `propertyId` (we've never been consistent on
 * the spelling). Doing the tag-lift HERE — automatically promoting those
 * fields from extras to tags — means every existing log.error() call
 * gets per-property dashboards for free without per-route changes.
 *
 * Same trick for `route` (so "all errors from /api/sms-reply" is one
 * filter click) and `property_name` / `propertyName` (so dashboards read
 * "Comfort Suites Beaumont" instead of a uuid).
 *
 * Routes that want to scope an entire handler can call
 * `setPropertyContextOnScope` inside a Sentry.withScope block — the tag
 * sticks for every event inside that scope.
 */

import * as Sentry from '@sentry/nextjs';

type Scope = ReturnType<typeof Sentry.getCurrentScope>;

/**
 * Lift property identifiers from a free-form extras bag onto an active
 * Sentry scope as TAGS. Exported because some callers (e.g. cron
 * handlers that explicitly open a withScope per property) want to set
 * the tag without going through captureException's extras path.
 *
 * Looks up the property id under any of the spellings we use across the
 * codebase. Returns the canonical pid (or null) so callers can chain
 * follow-up enrichment off it.
 */
export function setPropertyContextOnScope(
  scope: Scope,
  extra: Record<string, unknown>,
): string | null {
  // Try every spelling we've shipped: pid (short alias, used by user-facing
  // routes), property_id (snake_case, used by cron routes), propertyId
  // (camelCase, used in lib code). Whichever appears first wins; in
  // practice only one of them is set per call.
  const pidCandidate =
    extra.pid ?? extra.property_id ?? extra.propertyId;
  const pid = typeof pidCandidate === 'string' && pidCandidate.length > 0 ? pidCandidate : null;
  if (pid) {
    scope.setTag('property.id', pid);
  }

  const nameCandidate = extra.property_name ?? extra.propertyName;
  const name = typeof nameCandidate === 'string' && nameCandidate.length > 0 ? nameCandidate : null;
  if (name) {
    scope.setTag('property.name', name);
  }

  // `route` is the next-most-useful filter — "all errors from
  // /api/sms-reply" is a routine support move. Cheap to lift.
  const route = typeof extra.route === 'string' ? extra.route : null;
  if (route) {
    scope.setTag('route', route);
  }

  // setContext is the structured version that shows up on the event
  // detail page as a labeled card. Tag = filterable; context = readable.
  // Both are useful, and Sentry's UI displays them in different places.
  if (pid || name) {
    scope.setContext('property', {
      id: pid ?? undefined,
      name: name ?? undefined,
    });
  }

  return pid;
}

/**
 * Report an error to Sentry. Safe to call from anywhere — Sentry's API
 * never throws on errors of its own (it logs them and continues), so we
 * don't bother wrapping in try/catch here.
 *
 * `extra` lets the caller attach context (requestId, route, pid). It
 * shows up in the Sentry issue under "Additional Data", and any
 * recognised property identifier is automatically promoted to a tag so
 * fleet-wide dashboards work.
 */
export function captureException(err: unknown, extra?: Record<string, unknown>): void {
  if (extra) {
    Sentry.withScope((scope) => {
      scope.setExtras(extra);
      setPropertyContextOnScope(scope, extra);
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
      setPropertyContextOnScope(scope, extra);
      Sentry.captureMessage(message);
    });
  } else {
    Sentry.captureMessage(message);
  }
}
