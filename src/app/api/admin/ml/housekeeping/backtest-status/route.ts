/**
 * GET /api/admin/ml/housekeeping/backtest-status?propertyId=<uuid>&layer=demand|supply
 *
 * Returns the most recent walk-forward backtest artifact written by
 * `ml-service/scripts/backtest_housekeeping.py`. The artifact lives in
 * Supabase Storage (`ml-models` bucket, key
 * `backtest_results/{propertyId}/{layer}/{YYYY-MM-DD}.json`).
 *
 * Returns `data: null` when no backtest has been run yet — the cockpit
 * hides the backtest tile rather than rendering a fake "N/A" placeholder.
 *
 * Phase 2.2 (2026-05-22). Companion to:
 *   - ml-service/scripts/backtest_housekeeping.py (writer)
 *   - src/app/admin/ml/_components/housekeeping/HousekeepingSystemHealth.tsx (consumer)
 *
 * Auth: requireAdmin. Reads via supabaseAdmin (service role) so the
 * RLS shape on the `ml-models` bucket is irrelevant — same pattern as
 * the rest of /api/admin/ml/housekeeping/*.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import {
  parseArtifact,
  type BacktestStatusResponse,
} from '@/lib/housekeeping/backtest-artifact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const BUCKET = 'ml-models';

/**
 * Find the newest artifact key under
 * `backtest_results/{propertyId}/{layer}/` by listing and sorting.
 * Returns null if the folder is empty.
 */
async function findLatestArtifactKey(
  propertyId: string,
  layer: 'demand' | 'supply',
): Promise<string | null> {
  const prefix = `backtest_results/${propertyId}/${layer}`;
  // supabase-js storage.list takes the directory; entries come back
  // with `name` set to the file name (no prefix).
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .list(prefix, { limit: 100, sortBy: { column: 'name', order: 'desc' } });
  if (error) {
    log.warn('hk backtest-status: list failed (treat as empty)', {
      prefix, error: error.message ?? String(error),
    });
    return null;
  }
  if (!data || data.length === 0) return null;
  // Newest-first by name (YYYY-MM-DD.json sorts lexicographically =
  // chronologically). Defensive: skip entries that aren't .json.
  const newest = data.find((entry) => entry.name?.endsWith('.json'));
  if (!newest?.name) return null;
  return `${prefix}/${newest.name}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const idV = validateUuid(url.searchParams.get('propertyId'), 'propertyId');
  if (idV.error) {
    return NextResponse.json(
      { ok: false, error: idV.error, requestId },
      { status: 400 },
    );
  }
  const layerRaw = url.searchParams.get('layer');
  if (layerRaw !== 'demand' && layerRaw !== 'supply') {
    return NextResponse.json(
      { ok: false, error: 'layer must be demand or supply', requestId },
      { status: 400 },
    );
  }
  const layer: 'demand' | 'supply' = layerRaw;
  const pid = idV.value!;

  try {
    const key = await findLatestArtifactKey(pid, layer);
    if (!key) {
      return NextResponse.json({ ok: true, requestId, data: null } satisfies BacktestStatusResponse);
    }
    const { data: blob, error } = await supabaseAdmin.storage.from(BUCKET).download(key);
    if (error || !blob) {
      log.warn('hk backtest-status: download failed (treat as missing)', {
        key, error: error?.message ?? String(error),
      });
      return NextResponse.json({ ok: true, requestId, data: null } satisfies BacktestStatusResponse);
    }
    const text = await blob.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      log.warn('hk backtest-status: invalid JSON in artifact', { key });
      return NextResponse.json({ ok: true, requestId, data: null } satisfies BacktestStatusResponse);
    }
    const data = parseArtifact(parsed);
    return NextResponse.json({ ok: true, requestId, data } satisfies BacktestStatusResponse);
  } catch (e) {
    log.error('hk backtest-status: failed', { requestId, err: e as Error });
    return NextResponse.json(
      { ok: false, error: 'internal_error', requestId },
      { status: 500 },
    );
  }
}
