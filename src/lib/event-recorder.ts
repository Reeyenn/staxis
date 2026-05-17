/**
 * Observability event recorders — `recordErrorLog`, `recordWebhookLog`,
 * `recordAppEvent`.
 *
 * ─── Why this file exists ────────────────────────────────────────────────────
 *
 * The audit at `.claude/reports/external-api-audit.md` found ~5 sites that
 * insert into `error_logs` / `webhook_log` / `app_events` and silently
 * swallow Supabase errors with `try {} catch {}` or `.catch(() => {})`.
 *
 * The principle: observability writes are the rows we read DURING an
 * incident. If they're missing because the same Supabase outage that
 * caused the incident also broke the write, we're flying blind.
 *
 * The fix: every observability write goes through one of these helpers.
 * On Supabase error:
 *   1. Always log a structured `console.error('event_insert_failed', ...)`
 *      line. Vercel's log drain picks this up regardless of Supabase
 *      health, so we keep the breadcrumb.
 *   2. If failures pile up (≥3 in a 60s window for the same table),
 *      escalate to Sentry via `captureException`. Rate-limited so a
 *      Supabase outage doesn't flood Sentry with 1000 events.
 *
 * The helpers NEVER throw. They return `Promise<void>` so callers can
 * `await` for ordering but cannot use try/catch — that's by design,
 * because the original silent-catch sites only existed because callers
 * needed a never-throws guarantee.
 *
 * ─── Existing precedent ─────────────────────────────────────────────────────
 *
 * `src/lib/audit.ts:writeAudit` is the prior art — wraps `admin_audit_log`
 * inserts with try/catch + console.warn. Same shape, slightly older.
 * Keep using it for `admin_audit_log` writes; this module covers the
 * other three observability tables.
 *
 * See also: CLAUDE.md → "External Services Policy".
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { captureException } from '@/lib/sentry';

// ─── Table row shapes ────────────────────────────────────────────────────────

export interface ErrorLogRow {
  /** Route or subsystem that hit the error, e.g. '/api/send-shift-confirmations'. */
  source: string;
  /** Human-readable error message. */
  message: string;
  /** JS stack trace if available. */
  stack?: string | null;
}

export interface WebhookLogRow {
  /** Identifies the inbound provider, e.g. 'twilio-sms-reply', 'github', 'stripe'. */
  source: string;
  /** Redacted payload. Callers must scrub PII before passing in. */
  payload: Record<string, unknown>;
}

export interface AppEventRow {
  property_id: string | null;
  user_id: string | null;
  user_role: string | null;
  event_type: string;
  metadata: Record<string, unknown>;
}

// ─── Failure escalation rate limit ───────────────────────────────────────────
//
// In-memory counter keyed by table. Counts inserts that hit a Supabase
// error within the trailing 60s. After the 3rd failure in the window we
// also fire captureException — that surfaces "our observability table is
// broken" to the on-call without flooding Sentry on a sustained outage.

const FAILURE_WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 3;

interface FailureWindow {
  count: number;
  windowStartedAt: number;
  /** True once we've already escalated this window — gates the captureException. */
  escalated: boolean;
}

const failureWindows: Map<string, FailureWindow> = new Map();

/**
 * Track an insert failure for a table. Returns true if THIS failure
 * should be escalated to Sentry (the first escalation in the current
 * window). Subsequent failures in the same window return false until
 * the window rolls over.
 *
 * Exported for direct unit testing — monkey-patching ESM module exports
 * (e.g. captureException) is not portable, so the rate-limit decision
 * is tested via this pure-ish function.
 */
export function trackFailureAndShouldEscalate(table: string): boolean {
  const now = Date.now();
  const existing = failureWindows.get(table);
  if (!existing || now - existing.windowStartedAt >= FAILURE_WINDOW_MS) {
    // Fresh window. Don't escalate on the first failure — could be a
    // transient blip; we'll escalate on the 3rd if it sustains.
    failureWindows.set(table, { count: 1, windowStartedAt: now, escalated: false });
    return false;
  }
  existing.count += 1;
  if (existing.count >= FAILURE_THRESHOLD && !existing.escalated) {
    existing.escalated = true;
    return true;
  }
  return false;
}

/** Test helper — resets the in-memory failure counters. Not for production. */
export function __resetEventRecorderFailureWindowsForTests(): void {
  failureWindows.clear();
}

// ─── Structured-log helper ───────────────────────────────────────────────────

function logInsertFailure(
  table: string,
  row: Record<string, unknown>,
  error: unknown,
): void {
  // Structured single-line log so Vercel log-drain can parse it.
  // Trim row to avoid blasting whole payloads — keep top-level keys only.
  const rowSummary: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const val = row[key];
    if (typeof val === 'string') {
      rowSummary[key] = val.length > 200 ? val.slice(0, 200) + '…' : val;
    } else if (val === null || typeof val === 'boolean' || typeof val === 'number') {
      rowSummary[key] = val;
    } else {
      rowSummary[key] = `<${typeof val}>`;
    }
  }
  console.error('event_insert_failed', {
    table,
    rowSummary,
    error: error instanceof Error ? error.message : String(error),
  });

  if (trackFailureAndShouldEscalate(table)) {
    // Wrap in try/catch — captureException is normally safe but we MUST
    // not throw out of an observability helper.
    try {
      captureException(error instanceof Error ? error : new Error(String(error)), {
        subsystem: 'event-recorder',
        table,
        failure_mode: 'sustained_insert_failures',
      });
    } catch {
      // swallow — Sentry is best-effort
    }
  }
}

// ─── recordErrorLog ──────────────────────────────────────────────────────────

export async function recordErrorLog(row: ErrorLogRow): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('error_logs').insert({
      source: row.source,
      message: row.message,
      stack: row.stack ?? null,
    });
    if (error) {
      logInsertFailure('error_logs', row as unknown as Record<string, unknown>, error);
    }
  } catch (e) {
    logInsertFailure('error_logs', row as unknown as Record<string, unknown>, e);
  }
}

// ─── recordWebhookLog ────────────────────────────────────────────────────────

export async function recordWebhookLog(row: WebhookLogRow): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('webhook_log').insert({
      source: row.source,
      payload: row.payload,
    });
    if (error) {
      logInsertFailure(
        'webhook_log',
        { source: row.source, payload_keys: Object.keys(row.payload).join(',') },
        error,
      );
    }
  } catch (e) {
    logInsertFailure(
      'webhook_log',
      { source: row.source, payload_keys: Object.keys(row.payload).join(',') },
      e,
    );
  }
}

// ─── recordAppEvent ──────────────────────────────────────────────────────────

/**
 * Record a single `app_events` row. For bulk inserts (multiple events in
 * one call) pass an array.
 */
export async function recordAppEvent(rowOrRows: AppEventRow | AppEventRow[]): Promise<void> {
  const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
  if (rows.length === 0) return;
  try {
    const { error } = await supabaseAdmin.from('app_events').insert(rows);
    if (error) {
      logInsertFailure(
        'app_events',
        {
          event_type: rows[0].event_type,
          count: rows.length,
          property_id: rows[0].property_id,
        },
        error,
      );
    }
  } catch (e) {
    logInsertFailure(
      'app_events',
      {
        event_type: rows[0].event_type,
        count: rows.length,
        property_id: rows[0].property_id,
      },
      e,
    );
  }
}
