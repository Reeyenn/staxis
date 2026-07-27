/**
 * GET /api/cron/pms-observations-purge
 *
 * Retention sweep for the five append-only PMS observation tables. Daily.
 *
 * ─── Why this exists ──────────────────────────────────────────────────────
 * Migration 0343 made the observation tables append-only, enforced by a
 * BEFORE UPDATE OR DELETE trigger, and shipped exactly one sanctioned escape
 * hatch: `staxis_pms_purge_observations(table, before_date)`, which sets a
 * transaction-local flag the trigger honours. That function has existed since
 * 0343 with ZERO callers. 0343 says why, verbatim: "At one hotel and 42 MB that
 * is years away; the sanctioned purge function exists so the decision can be
 * made later without reopening the append-only guarantee."
 *
 * The decision is still not urgent — but the wiring should not be invented in a
 * hurry on the day report ingestion restarts and these tables start taking real
 * volume. So this cron exists now, deliberately with a window so generous it is
 * a guaranteed no-op today. It is scheduled (unlike the findings janitor)
 * because it is safe to run against empty and near-empty tables: verified
 * 2026-07-27 against production, where the function returns 0 and deletes
 * nothing.
 *
 * Production state when this was written:
 *   pms_room_status_log        41 rows (2026-07-03 → 2026-07-06)
 *   pms_activity_log            0
 *   pms_occupancy_observation   0
 *   pms_booking_pace            0
 *   pms_entity_change_log       0
 *
 * ─── The one knob ─────────────────────────────────────────────────────────
 * RETENTION_DAYS. It matches CORPUS_RETENTION_DAYS in ml-retention-purge (5
 * years) because these tables are the same kind of thing: longitudinal history
 * whose value is that it is long. Tighten it when real volume arrives and the
 * founder has an actual opinion — do not tighten it to reclaim space nobody
 * needs.
 *
 * ─── Deliberately NOT clever ──────────────────────────────────────────────
 * No batching loop here, unlike ml-retention-purge. The purge is a single
 * server-side statement per table behind a SECURITY DEFINER function whose
 * table allowlist is enforced in SQL, and a 5-year window means the first real
 * run will still be small. If these tables ever get big enough for the delete
 * to be a lock problem, the batching belongs INSIDE the SQL function, where the
 * append-only flag is scoped — not out here.
 *
 * Auth: CRON_SECRET bearer.
 * Schedule: daily 05:40 UTC (after the AI-books rollup at 05:20).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * 5 years. Matches CORPUS_RETENTION_DAYS in ml-retention-purge on purpose —
 * see the header. This is the single knob.
 */
export const RETENTION_DAYS = 1825;

/**
 * The five tables the SQL function accepts. Kept here as an explicit list
 * rather than derived, so adding a table is a visible decision in a diff; the
 * function rejects anything not on its own allowlist regardless, so a drift
 * between these two lists fails loudly instead of silently purging something
 * unintended.
 */
export const OBSERVATION_TABLES = [
  'pms_room_status_log',
  'pms_activity_log',
  'pms_occupancy_observation',
  'pms_booking_pace',
  'pms_entity_change_log',
] as const;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  const before = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10); // the function takes a date, not a timestamp

  const purged: Record<string, number> = {};
  const errors: Record<string, string> = {};

  for (const table of OBSERVATION_TABLES) {
    const { data, error } = await supabaseAdmin.rpc('staxis_pms_purge_observations', {
      p_table: table,
      p_before: before,
    });
    if (error) {
      // One table failing must not stop the others — the next tick retries.
      log.error('[cron/pms-observations-purge] purge failed', {
        requestId, table, error: error.message,
      });
      errors[table] = error.message;
      continue;
    }
    purged[table] = Number(data ?? 0);
  }

  const degraded = Object.keys(errors).length > 0;

  await writeCronHeartbeat('pms-observations-purge', {
    requestId,
    status: degraded ? 'degraded' : 'ok',
    notes: { purged, errors, before, retentionDays: RETENTION_DAYS },
  });

  return ok({ purged, errors, before, retentionDays: RETENTION_DAYS }, { requestId });
}
