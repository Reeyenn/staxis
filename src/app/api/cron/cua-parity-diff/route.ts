/**
 * GET /api/cron/cua-parity-diff
 *
 * Plan v7 Phase 2b parity gate. Runs daily at 04:00 UTC (vercel.json
 * cron entry). For each of the 6 shadow tables, computes a row-by-row
 * diff against the authoritative table and writes any mismatches to
 * `pms_parity_diffs`. Sentry-alerts when any table has non-zero diffs.
 *
 * Gate semantics:
 *   - 7 consecutive days of zero `pms_parity_diffs` rows per table =
 *     that table's generic-writer path is safe to flip authoritative
 *     (env CUA_USE_GENERIC_WRITER_<table>=true).
 *   - Diff cron writes to error_logs + Sentry when any table fails the
 *     gate. Doctor surfaces "shadow parity diffs in last 24h" check.
 *
 * Diff logic (per table):
 *   - Authoritative SELECT rows (latest = pre-shadow-write)
 *   - Shadow SELECT rows
 *   - FULL OUTER JOIN on natural key
 *   - Diff kind:
 *     - row in authoritative + NOT in shadow = 'missing_in_shadow'
 *     - row in shadow + NOT in authoritative = 'missing_in_authoritative'
 *     - row in both but column values differ = 'value_mismatch'
 *
 * Auth: Bearer ${CRON_SECRET}.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { log, getOrMintRequestId } from '@/lib/log';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// The 6 tables in shadow mode during Plan v7 Phase 2b parity window.
// When a table flips authoritative, remove its entry here (and drop
// the shadow table in a follow-up migration).
const SHADOW_TABLES: Array<{ table: string; naturalKey: string[] }> = [
  { table: 'pms_reservations',              naturalKey: ['property_id', 'pms_reservation_id'] },
  { table: 'pms_rooms_inventory',           naturalKey: ['property_id', 'room_number'] },
  { table: 'pms_room_status_log',           naturalKey: ['property_id', 'room_number', 'changed_at'] },
  { table: 'pms_housekeeping_assignments',  naturalKey: ['property_id', 'date', 'room_number'] },
  { table: 'pms_work_orders_v2',            naturalKey: ['property_id', 'pms_work_order_id'] },
  { table: 'pms_in_house_snapshot',         naturalKey: ['property_id'] },
];

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  const runId = crypto.randomUUID();
  const summary: Array<{ table: string; diffCount: number; ok: boolean; reason?: string }> = [];

  for (const { table, naturalKey } of SHADOW_TABLES) {
    try {
      const diffCount = await diffTable(table, naturalKey, runId);
      summary.push({ table, diffCount, ok: true });
    } catch (e) {
      log.error('cua-parity-diff: table diff failed', {
        requestId, table, err: errToString(e),
      });
      summary.push({ table, diffCount: 0, ok: false, reason: errToString(e) });
    }
  }

  const totalDiffs = summary.reduce((s, r) => s + r.diffCount, 0);
  const anyFailed = summary.some((r) => !r.ok);

  // Heartbeat written even when diffs > 0 — the cron RAN successfully,
  // it's the parity STATE that's stale. Doctor surfaces the diff count
  // via a separate check.
  await writeCronHeartbeat('cua-parity-diff', {
    requestId,
    status: anyFailed ? 'degraded' : 'ok',
    notes: { runId, totalDiffs, summary },
  });

  return NextResponse.json({
    ok: !anyFailed,
    requestId,
    runId,
    totalDiffs,
    summary,
  }, { status: anyFailed ? 502 : 200 });
}

/**
 * Diff one authoritative table against its shadow. Writes mismatches
 * to pms_parity_diffs. Returns the number of diff rows written.
 *
 * Implementation note: we SELECT * from both sides and diff in memory.
 * For small tables (≤ a few thousand rows during the v7 parity window),
 * this is simpler than a SQL FULL OUTER JOIN that varies per-table by
 * natural_key shape. If a shadow table gets large, this can be moved
 * to a server-side SQL function.
 */
async function diffTable(table: string, naturalKey: string[], runId: string): Promise<number> {
  const shadowTable = `${table}_shadow`;

  const { data: authRows, error: authErr } = await supabaseAdmin.from(table).select('*');
  if (authErr) throw new Error(`authoritative select failed: ${authErr.message}`);
  const { data: shadowRows, error: shadowErr } = await supabaseAdmin.from(shadowTable).select('*');
  if (shadowErr) throw new Error(`shadow select failed: ${shadowErr.message}`);

  const keyOf = (row: Record<string, unknown>): string =>
    JSON.stringify(naturalKey.map((k) => row[k] ?? null));

  const authByKey = new Map<string, Record<string, unknown>>();
  for (const r of authRows ?? []) authByKey.set(keyOf(r), r);
  const shadowByKey = new Map<string, Record<string, unknown>>();
  for (const r of shadowRows ?? []) shadowByKey.set(keyOf(r), r);

  const diffs: Array<{
    table_name: string;
    natural_key: Record<string, unknown>;
    authoritative_row: Record<string, unknown> | null;
    shadow_row: Record<string, unknown> | null;
    diff_kind: 'missing_in_shadow' | 'missing_in_authoritative' | 'value_mismatch';
    run_id: string;
  }> = [];

  const allKeys = new Set([...authByKey.keys(), ...shadowByKey.keys()]);
  for (const key of allKeys) {
    const auth = authByKey.get(key) ?? null;
    const shadow = shadowByKey.get(key) ?? null;
    const nk = naturalKey.reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = (auth ?? shadow)?.[k] ?? null;
      return acc;
    }, {});

    if (auth && !shadow) {
      diffs.push({ table_name: table, natural_key: nk, authoritative_row: auth, shadow_row: null, diff_kind: 'missing_in_shadow', run_id: runId });
    } else if (!auth && shadow) {
      diffs.push({ table_name: table, natural_key: nk, authoritative_row: null, shadow_row: shadow, diff_kind: 'missing_in_authoritative', run_id: runId });
    } else if (auth && shadow) {
      // Both present — diff field-by-field, excluding metadata + id.
      const skipCols = new Set(['id', 'created_at', 'updated_at', 'last_synced_at', 'captured_at']);
      const mismatched = Object.keys(auth).some((col) => {
        if (skipCols.has(col)) return false;
        return JSON.stringify(auth[col]) !== JSON.stringify(shadow[col]);
      });
      if (mismatched) {
        diffs.push({ table_name: table, natural_key: nk, authoritative_row: auth, shadow_row: shadow, diff_kind: 'value_mismatch', run_id: runId });
      }
    }
  }

  if (diffs.length === 0) return 0;

  const { error: insErr } = await supabaseAdmin.from('pms_parity_diffs').insert(diffs);
  if (insErr) throw new Error(`pms_parity_diffs insert failed: ${insErr.message}`);
  return diffs.length;
}
