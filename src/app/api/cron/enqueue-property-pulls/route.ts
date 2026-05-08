/**
 * GET /api/cron/enqueue-property-pulls
 *
 * Cron tick for the steady-state pull queue. A GitHub Actions workflow
 * (`.github/workflows/pull-jobs-cron.yml`) hits this every 15 minutes.
 *
 * What it does:
 *   1. Lists every property with pms_connected=true and a non-null pms_type.
 *   2. Calls staxis_enqueue_property_pull(property, pms_type) for each. The
 *      function is idempotent — if a pull_job is already queued or running
 *      for that property, no new row is inserted.
 *   3. Returns a structured summary of the tick (enqueued, skipped, errors).
 *
 * Why a separate cron from process-sms-jobs:
 *   Different cadence. SMS drains every minute (latency-sensitive). Pulls
 *   run every 15 min (rate-limited by PMS server tolerance + Playwright cost).
 *
 * Why GitHub Actions, not Vercel cron:
 *   Vercel's free-tier cron limits are tight; GitHub Actions are free at our
 *   scale and we already use them for sms-jobs / scraper-health / etc.
 *
 * Auth: CRON_SECRET bearer token, same model as every other cron endpoint.
 *
 * Note: this route only ENQUEUES. Actual pulls run on the Fly.io CUA worker
 * fleet via staxis_claim_next_pull_job() — see cua-service/src/index.ts.
 */

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import { ok, err, ApiErrorCode } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PropertyRow {
  id: string;
  pms_type: string | null;
  pms_connected: boolean | null;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const startedAt = Date.now();

  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  try {
    // 1. Find every connected property. Service-role bypasses RLS.
    const { data: rows, error: listErr } = await supabaseAdmin
      .from('properties')
      .select('id, pms_type, pms_connected')
      .eq('pms_connected', true)
      .not('pms_type', 'is', null);

    if (listErr) {
      log.error('[cron/enqueue-property-pulls] property list failed', {
        requestId, msg: listErr.message,
      });
      return err('property list failed', {
        requestId, status: 500, code: ApiErrorCode.InternalError,
        details: { detail: listErr.message },
      });
    }

    const properties = (rows ?? []) as PropertyRow[];

    let enqueued = 0;
    let skipped = 0;
    const errors: Array<{ propertyId: string; msg: string }> = [];

    // 2. Enqueue per-property in parallel. The RPC is idempotent, so
    // even if two cron ticks race we won't double-insert. We DON'T
    // batch into a single RPC call — keeping the per-property error
    // boundary means one bad property doesn't poison the whole tick.
    const results = await Promise.allSettled(
      properties.map(async (p) => {
        if (!p.pms_type) return { skipped: true as const, propertyId: p.id };
        const { data: existingOrNew, error: rpcErr } =
          await supabaseAdmin.rpc('staxis_enqueue_property_pull', {
            p_property_id:   p.id,
            p_pms_type:      p.pms_type,
          });
        if (rpcErr) {
          throw new Error(`${p.id}: ${rpcErr.message}`);
        }
        // The RPC returns the existing job id if one was already queued
        // (=> skipped) or a new id (=> enqueued). We don't know which
        // happened from the return value alone, so we issue a follow-up
        // query — but only if performance becomes a concern. For now,
        // count both cases as "enqueued" since the goal is "every
        // property has a pending pull job after this tick".
        return { skipped: false as const, propertyId: p.id, jobId: existingOrNew as string };
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value.skipped) skipped++;
        else enqueued++;
      } else {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        const propertyId = reason.split(':')[0];
        errors.push({ propertyId: propertyId ?? 'unknown', msg: reason });
      }
    }

    const durationMs = Date.now() - startedAt;

    log.info('[cron/enqueue-property-pulls] tick', {
      requestId,
      totalProperties: properties.length,
      enqueued,
      skipped,
      errorCount: errors.length,
      durationMs,
    });

    return ok({
      totalProperties: properties.length,
      enqueued,
      skipped,
      errors,
      durationMs,
    }, { requestId });
  } catch (caughtErr) {
    const msg = caughtErr instanceof Error ? caughtErr.message : String(caughtErr);
    log.error('[cron/enqueue-property-pulls] failed', { requestId, msg });
    return err('enqueue-property-pulls failed', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
      details: { detail: msg },
    });
  }
}
