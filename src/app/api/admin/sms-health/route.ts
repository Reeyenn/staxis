/**
 * GET /api/admin/sms-health
 *
 * Per-hotel SMS health for the last 24h. Reeyen wants to know if any
 * one hotel's SMS is broken (e.g., unreachable phone numbers, Twilio
 * carrier issue) without that being hidden in a fleet-wide average.
 *
 * Returns one row per property that had any SMS activity in the window:
 *   - sent       (status='sent')
 *   - inFlight   (status in queued|sending — not yet delivered)
 *   - failed     (status in failed|dead)
 *   - deliveryPct = sent / (sent + failed) — undefined if no terminal sends
 *   - topErrors  (most common error_message values across failed rows)
 *
 * Properties with zero SMS in the window are NOT returned — the UI shows
 * those as a separate "no traffic" group when relevant.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

interface PerHotel {
  propertyId: string;
  propertyName: string | null;
  sent: number;
  inFlight: number;
  failed: number;
  deliveryPct: number | null;
  topErrors: { message: string; count: number }[];
}

const TERMINAL_FAIL = new Set(['failed', 'dead']);
const IN_FLIGHT = new Set(['queued', 'sending']);

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const hours = Math.min(parseInt(url.searchParams.get('hours') ?? '24', 10) || 24, 24 * 7);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  // Pull recent SMS rows and bucket in JS. supabase-js has no GROUP BY.
  // 24h × 300 hotels × ~10 SMS/day = 72k rows worst case — paginate at
  // 5k for now; revisit if real fleets ever push past that.
  const { data, error } = await supabaseAdmin
    .from('sms_jobs')
    .select('property_id, status, error_message, sent_at, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(5000);

  if (error) {
    log.error('sms-health query failed', { err: error, requestId });
    return err('sms-health query failed', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  // Per-property tally
  const byProperty = new Map<string, {
    sent: number; inFlight: number; failed: number;
    errorCounts: Map<string, number>;
  }>();

  for (const row of (data ?? [])) {
    const r = row as { property_id: string; status: string; error_message: string | null };
    let h = byProperty.get(r.property_id);
    if (!h) {
      h = { sent: 0, inFlight: 0, failed: 0, errorCounts: new Map() };
      byProperty.set(r.property_id, h);
    }
    if (r.status === 'sent') h.sent += 1;
    else if (TERMINAL_FAIL.has(r.status)) {
      h.failed += 1;
      const msg = (r.error_message ?? 'unknown error').trim();
      h.errorCounts.set(msg, (h.errorCounts.get(msg) ?? 0) + 1);
    } else if (IN_FLIGHT.has(r.status)) h.inFlight += 1;
  }

  // Pull names so the UI doesn't need a second round-trip
  const propertyIds = Array.from(byProperty.keys());
  let nameById = new Map<string, string | null>();
  if (propertyIds.length > 0) {
    const { data: nameRows, error: nameErr } = await supabaseAdmin
      .from('properties')
      .select('id, name')
      .in('id', propertyIds);
    if (nameErr) {
      return err(`sms-health name lookup failed: ${nameErr.message}`, { requestId, status: 500 });
    }
    nameById = new Map((nameRows ?? []).map((r) => [(r as { id: string; name: string | null }).id, (r as { id: string; name: string | null }).name]));
  }

  const perHotel: PerHotel[] = Array.from(byProperty.entries()).map(([propertyId, h]) => {
    const terminalTotal = h.sent + h.failed;
    const deliveryPct = terminalTotal > 0 ? Math.round((h.sent / terminalTotal) * 100) : null;
    const topErrors = Array.from(h.errorCounts.entries())
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    return {
      propertyId,
      propertyName: nameById.get(propertyId) ?? null,
      sent: h.sent,
      inFlight: h.inFlight,
      failed: h.failed,
      deliveryPct,
      topErrors,
    };
  });

  // Sort: failures first, then most active.
  perHotel.sort((a, b) => {
    if ((a.failed > 0) !== (b.failed > 0)) return b.failed > 0 ? 1 : -1;
    return (b.sent + b.failed) - (a.sent + a.failed);
  });

  return ok({
    hoursWindow: hours,
    perHotel,
  }, { requestId });
}
