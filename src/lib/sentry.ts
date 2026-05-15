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

// Sentry's documented max tag-value length is 200 chars; values above
// the limit are silently dropped or truncated by the ingest endpoint.
// We clamp here so a freakishly long hotel name (or a stray paragraph
// in a `route` field) doesn't quietly disappear from the dashboard.
const TAG_VALUE_MAX = 200;

/**
 * SENTRY_TITLE_MAX: conservative cap below Sentry's stated 200-char
 * title truncation. Round 18 callers (doctor-check + walkthrough-health-
 * alert) embed dynamic content (failing check names, walkthrough task
 * names) in their captureMessage titles, which can blow past Sentry's
 * limit for long tasks/checks. We truncate at the application layer with
 * "+N more" overflow so titles stay scannable and Sentry's grouping/
 * fingerprinting stays stable. Lower than 200 because mid-word cuts
 * make titles cryptic.
 */
export const SENTRY_TITLE_MAX = 180;

/** Embed a list of dynamic items into a "<prefix><items joined>" title
 *  with a hard cap. Items that don't fit get summarized as "+N more".
 *  Returns just the joined-and-truncated tail string — caller prepends
 *  the prefix. Pure for testability.
 *
 *  Example:
 *    truncateListForSentryTitle('doctor: 5 failing — ', ['a','b','c','d','e'], 30)
 *      → 'a, b, c, +2 more'
 */
export function truncateListForSentryTitle(
  prefix: string,
  items: ReadonlyArray<string>,
  max: number = SENTRY_TITLE_MAX,
): string {
  if (items.length === 0) return '';
  const joined = items.join(', ');
  if (prefix.length + joined.length <= max) return joined;
  const budget = Math.max(0, max - prefix.length);
  const shown: string[] = [];
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    const sep = shown.length === 0 ? 0 : 2; // ", "
    const tail = `, +${items.length - i} more`;
    if (used + sep + items[i].length + tail.length > budget) break;
    shown.push(items[i]);
    used += sep + items[i].length;
  }
  const hidden = items.length - shown.length;
  return shown.join(', ') + (hidden > 0 ? `, +${hidden} more` : '');
}

/**
 * Normalize a value before setting it as a Sentry tag:
 *   - Strip newlines/tabs (Sentry doesn't render them and some
 *     transports reject the value).
 *   - Collapse runs of whitespace.
 *   - Trim.
 *   - Clamp to TAG_VALUE_MAX codepoints; on truncation, append "…"
 *     so the cut is visible in the dashboard.
 *
 * Codepoint-aware truncation matters: a hotel name like "🏨 Resort"
 * uses a surrogate pair for the emoji (2 UTF-16 units, 1 codepoint).
 * Naive `.slice(0, 199)` could land between the two halves of a
 * surrogate pair and produce an invalid UTF-16 string. Array.from
 * splits on codepoint boundaries — safe regardless of input shape.
 *
 * Returns null when the cleaned value is empty (caller should skip
 * setting the tag — Sentry rejects empty values).
 */
function cleanTagValue(raw: string): string | null {
  // Replace any whitespace span (newlines, tabs, multiple spaces) with
  // a single space, then trim.
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  // Cheap path: ASCII inputs (the overwhelming majority — UUIDs, hotel
  // names, route paths) have length === codepoint-count, no surrogate
  // pairs possible. Skip Array.from entirely when well under the cap.
  if (collapsed.length <= TAG_VALUE_MAX) return collapsed;
  const codepoints = Array.from(collapsed);
  if (codepoints.length <= TAG_VALUE_MAX) return collapsed;
  return codepoints.slice(0, TAG_VALUE_MAX - 1).join('') + '…';
}

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
  const pid =
    typeof pidCandidate === 'string' && pidCandidate.length > 0
      ? cleanTagValue(pidCandidate)
      : null;
  if (pid) {
    scope.setTag('property.id', pid);
  }

  const nameCandidate = extra.property_name ?? extra.propertyName;
  const name =
    typeof nameCandidate === 'string' && nameCandidate.length > 0
      ? cleanTagValue(nameCandidate)
      : null;
  if (name) {
    scope.setTag('property.name', name);
  }

  // `route` is the next-most-useful filter — "all errors from
  // /api/sms-reply" is a routine support move. Cheap to lift.
  const routeCandidate = typeof extra.route === 'string' ? extra.route : null;
  const route = routeCandidate ? cleanTagValue(routeCandidate) : null;
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
