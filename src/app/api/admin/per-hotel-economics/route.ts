/**
 * GET /api/admin/per-hotel-economics
 *
 * For each property: monthly recurring revenue, allocated cost (Claude
 * API + per-hotel SMS + amortized fleet costs), and margin.
 *
 * Pilot mode (subscription_status='active' but no Stripe revenue) shows
 * revenue=0 — the cost side still computes so Reeyen can see how
 * expensive each hotel is to run BEFORE billing flips on.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

interface HotelEcon {
  propertyId: string;
  propertyName: string | null;
  subscriptionStatus: string | null;
  // Revenue is per-month MRR. Pilot mode = 0.
  mrrCents: number;
  // Claude usage attributable to this hotel (last 30 days, in cents).
  claudeCostLast30dCents: number;
  // SMS attributable to this hotel (twilio per-message; placeholder fixed
  // estimate ~0.75¢ per sent until we instrument actual delivery cost).
  smsCostLast30dCents: number;
  // Fleet costs allocated proportionally (hosting, supabase, vercel, etc).
  // Computed as totalFleetExpenseLast30d * (1 / totalActiveHotels).
  fleetAllocatedCostLast30dCents: number;
  totalCostLast30dCents: number;
  marginCents: number;
}

const SMS_UNIT_COST_CENTS = 0.75;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const monthAgoIso = monthAgo.toISOString();

  // Pull everything in parallel.
  // monthly_amount_cents doesn't exist on properties yet — once billing
  // flips on we'll add it via migration. For now MRR is always 0.
  const [propsRes, claudeRes, smsRes, fleetExpRes] = await Promise.all([
    supabaseAdmin
      .from('properties')
      .select('id, name, subscription_status'),
    supabaseAdmin
      .from('claude_usage_log')
      .select('property_id, cost_micros')
      .gte('ts', monthAgoIso),
    supabaseAdmin
      .from('sms_jobs')
      .select('property_id, status')
      .eq('status', 'sent')
      .gte('created_at', monthAgoIso),
    supabaseAdmin
      .from('expenses')
      .select('amount_cents, category, property_id, source')
      .gte('incurred_on', monthAgoIso.slice(0, 10))
      .is('property_id', null), // fleet-level only
  ]);

  for (const r of [propsRes, claudeRes, smsRes, fleetExpRes]) {
    if (r.error) {
      log.error('per-hotel-economics query failed', { err: r.error, requestId });
      return err('per-hotel-economics query failed', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
  }

  const properties = (propsRes.data ?? []) as Array<{ id: string; name: string | null; subscription_status: string | null }>;
  const claudeRows = (claudeRes.data ?? []) as Array<{ property_id: string | null; cost_micros: number }>;
  const smsRows = (smsRes.data ?? []) as Array<{ property_id: string }>;
  const fleetRows = (fleetExpRes.data ?? []) as Array<{ amount_cents: number; category: string }>;

  // Build per-hotel buckets
  const claudeCentsBy = new Map<string, number>();
  for (const r of claudeRows) {
    if (!r.property_id) continue;
    // micros → cents: divide by 10_000 (1 cent = 10,000 micros)
    const cents = (r.cost_micros ?? 0) / 10_000;
    claudeCentsBy.set(r.property_id, (claudeCentsBy.get(r.property_id) ?? 0) + cents);
  }

  const smsCountBy = new Map<string, number>();
  for (const r of smsRows) {
    smsCountBy.set(r.property_id, (smsCountBy.get(r.property_id) ?? 0) + 1);
  }

  const fleetTotalCents = fleetRows.reduce((sum, r) => sum + (r.amount_cents ?? 0), 0);
  const activeHotels = properties.filter((p) => p.subscription_status === 'active').length || 1;
  const fleetPerHotelCents = fleetTotalCents / activeHotels;

  const hotels: HotelEcon[] = properties.map((p) => {
    const mrr = 0; // pilot mode — no monthly_amount_cents column yet
    const claudeCents = claudeCentsBy.get(p.id) ?? 0;
    const smsCents = (smsCountBy.get(p.id) ?? 0) * SMS_UNIT_COST_CENTS;
    const allocated = p.subscription_status === 'active' ? fleetPerHotelCents : 0;
    const total = claudeCents + smsCents + allocated;
    return {
      propertyId: p.id,
      propertyName: p.name,
      subscriptionStatus: p.subscription_status,
      mrrCents: mrr,
      claudeCostLast30dCents: Math.round(claudeCents),
      smsCostLast30dCents: Math.round(smsCents),
      fleetAllocatedCostLast30dCents: Math.round(allocated),
      totalCostLast30dCents: Math.round(total),
      marginCents: Math.round(mrr - total),
    };
  });

  hotels.sort((a, b) => a.marginCents - b.marginCents); // worst margin first

  const totals = {
    mrrCents: hotels.reduce((s, h) => s + h.mrrCents, 0),
    claudeCostLast30dCents: hotels.reduce((s, h) => s + h.claudeCostLast30dCents, 0),
    smsCostLast30dCents: hotels.reduce((s, h) => s + h.smsCostLast30dCents, 0),
    fleetAllocatedCostLast30dCents: Math.round(fleetTotalCents),
    totalCostLast30dCents: hotels.reduce((s, h) => s + h.totalCostLast30dCents, 0),
  };

  return ok({ hotels, totals, activeHotelCount: activeHotels }, { requestId });
}
