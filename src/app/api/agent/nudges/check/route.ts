// ─── POST /api/agent/nudges/check ──────────────────────────────────────────
// Cron entry point. Runs every 5 min via Vercel Cron, iterates all properties
// and runs nudge checks. Protected by CRON_SECRET.

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { runNudgeChecksForProperty } from '@/lib/agent/nudges';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const authErr = requireCronSecret(req);
  if (authErr) return authErr;

  // Pull only the properties with agent activity in the last 7 days.
  // Iterating ALL properties is wasted work — a property with zero
  // recent agent messages can't produce nudges anyone would receive.
  // Migration 0132 added staxis_active_property_ids_for_nudges. If the
  // RPC isn't available (older deploy without the migration applied),
  // fall back to listing every property so the cron stays functional.
  let propertyIds: string[];
  const { data: activeRows, error: rpcErr } = await supabaseAdmin
    .rpc('staxis_active_property_ids_for_nudges', { p_window_days: 7 });
  if (rpcErr) {
    log.warn('[agent/nudges/check] active-property RPC unavailable; falling back to full list', { requestId, err: rpcErr.message });
    const { data: properties, error: pErr } = await supabaseAdmin
      .from('properties')
      .select('id');
    if (pErr || !properties) {
      log.error('[agent/nudges/check] failed to list properties', { requestId, err: pErr });
      return err('failed to list properties', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
    propertyIds = properties.map(p => p.id as string);
  } else {
    propertyIds = (activeRows ?? []).map((r: { property_id: string }) => r.property_id);
  }

  const results = await Promise.allSettled(
    propertyIds.map(id => runNudgeChecksForProperty(id)),
  );

  const totals = {
    propertiesChecked: propertyIds.length,
    nudgesInserted: 0,
    skipped: 0,
    errors: [] as string[],
  };
  for (const r of results) {
    if (r.status === 'fulfilled') {
      totals.nudgesInserted += r.value.nudgesInserted;
      totals.skipped += r.value.skipped;
      totals.errors.push(...r.value.errors);
    } else {
      totals.errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
  }

  if (totals.errors.length > 0) {
    // Codex adversarial review 2026-05-13: this loop accumulated per-
    // property errors into totals.errors but returned ok(...) regardless,
    // so Vercel saw a successful invocation even when every property's
    // nudge run rejected. Surface to Sentry; keep the 200 (Vercel cron
    // retries on non-2xx and we don't want duplicate nudge inserts).
    log.error('[agent/nudges/check] per-property runs failed', {
      requestId,
      errorCount: totals.errors.length,
      errors: totals.errors.slice(0, 5),
    });
  }

  await writeCronHeartbeat('agent-nudges-check', {
    requestId,
    notes: { propertiesChecked: totals.propertiesChecked, errorCount: totals.errors.length },
    status: totals.errors.length > 0 ? 'degraded' : 'ok',
  });

  return ok(totals, { requestId });
}

// Vercel Cron sends GET. Accept both so manual curl POST works too.
export async function GET(req: NextRequest): Promise<Response> {
  return POST(req);
}
