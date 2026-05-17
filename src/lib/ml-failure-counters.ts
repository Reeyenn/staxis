/**
 * Smoke-detector counters for silent ML feature failures.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────
 * /api/housekeeper/room-action has two best-effort blocks that the housekeeper
 * tap is never allowed to fail on:
 *
 *   1. Occupancy capture on Start — reads scraper_status.dashboard.in_house
 *      and stamps it on rooms.last_started_occupancy. If the scraper is
 *      down, the dashboard row is stale, or the field is missing, we log
 *      a warning and continue. The Done tap still works; it just lands
 *      with `occupancy_at_start = null` on the cleaning_events row, which
 *      removes one of the supply model's most valuable features.
 *
 *   2. Feature derivation on Done — calls deriveCleaningEventFeatures(),
 *      which itself returns nulls on internal failure but is wrapped in
 *      an outer try/catch as a "should never happen" net. If the helper
 *      ever throws (e.g. an upstream schema change leaves the helper
 *      reading a column that doesn't exist), the cleaning_events row
 *      lands with all 10 ML features null and the Done tap appears to
 *      have worked.
 *
 * Both paths "succeed" from the housekeeper's perspective. The only signal
 * is a Vercel log line that nobody reads. If either path silently fails for
 * weeks, the supply model retrains on increasingly-degraded data and Reeyen
 * has no idea anything's wrong.
 *
 * ─── What this module does ───────────────────────────────────────────────
 * Increments a JSON counter in scraper_status keyed by `ml_failures:<kind>`
 * every time one of those catch blocks fires. Stores up to 100 most-recent
 * failure records (timestamp + property + truncated error) plus a lifetime
 * total. The /api/admin/doctor endpoint reads these rows and goes RED if
 * any failures landed in the last 24h — so the daily-drift-check cron
 * surfaces them within hours of the first occurrence.
 *
 * ─── Failure mode ────────────────────────────────────────────────────────
 * If THIS module fails (Supabase write errors, etc.) it MUST NOT break the
 * parent room-action request. Every operation is wrapped in try/catch and
 * returns silently. We'd rather lose a counter increment than break Maria's
 * housekeeper page.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

export type MLFailureKind = 'occupancy_capture' | 'feature_derivation';

const KEY_PREFIX = 'ml_failures:';
const RECENT_CAP = 100;

interface MLFailureRecord {
  /** ISO timestamp of when the failure happened. */
  at: string;
  /** Property id where it happened. Truncate-safe; doctor surfaces only first 8. */
  pid: string;
  /** Stringified error message, capped at 200 chars. */
  err: string;
}

/** Shape stored in scraper_status.data for `ml_failures:<kind>` rows. */
export interface MLFailureRow {
  /** Most-recent failures, newest first. Capped at RECENT_CAP. */
  recent: MLFailureRecord[];
  /** Lifetime counter; never reset. */
  total: number;
}

/**
 * Bump the counter for a given failure kind. Best-effort — never throws,
 * never blocks the parent request.
 *
 * Race tolerance: read-modify-write under concurrent failures can lose an
 * increment, but the only thing the doctor cares about is `count > 0 in
 * last 24h`. A lost increment doesn't change that signal.
 */
export async function incrementMLFailureCounter(
  pid: string,
  kind: MLFailureKind,
  rawErr: unknown,
): Promise<void> {
  const key = `${KEY_PREFIX}${kind}`;
  const errString = rawErr instanceof Error ? rawErr.message : String(rawErr);

  try {
    const { data: row, error: readErr } = await supabaseAdmin
      .from('scraper_status')
      .select('data')
      .eq('key', key)
      .maybeSingle();

    if (readErr) {
      // Don't blow up the parent — counter writes are best-effort.
      log.warn('ml-failure-counter: read failed (non-fatal)', {
        kind, err: readErr,
      });
      return;
    }

    const current = (row?.data ?? { recent: [], total: 0 }) as Partial<MLFailureRow>;

    const newRecord: MLFailureRecord = {
      at: new Date().toISOString(),
      pid,
      err: errString.slice(0, 200),
    };

    const updated: MLFailureRow = {
      recent: [newRecord, ...(current.recent ?? [])].slice(0, RECENT_CAP),
      total: (current.total ?? 0) + 1,
    };

    const { error: writeErr } = await supabaseAdmin
      .from('scraper_status')
      .upsert(
        { key, data: updated, updated_at: new Date().toISOString() },
        { onConflict: 'key' },
      );

    if (writeErr) {
      log.warn('ml-failure-counter: write failed (non-fatal)', {
        kind, err: writeErr,
      });
    }
  } catch (e) {
    // Belt-and-suspenders — counter logic must NEVER crash the parent request.
    log.warn('ml-failure-counter: unexpected exception (non-fatal)', {
      kind, err: e,
    });
  }
}
