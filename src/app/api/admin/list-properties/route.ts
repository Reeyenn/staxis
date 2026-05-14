/**
 * GET /api/admin/list-properties
 *
 * Returns every property with a health summary. Used by the
 * /admin/properties page to give Reeyen a one-pane-of-glass view
 * across the fleet — what's live, what's broken, what's past trial.
 *
 * Health signals returned per property:
 *   - subscription_status (trial / active / past_due / canceled)
 *   - trial_ends_at (when the 14-day clock runs out)
 *   - pms_connected (boolean — credentials saved + recipe ready)
 *   - last_synced_at (latest successful PMS pull)
 *   - last_onboarding_job (status + step + age)
 *   - sync_freshness_minutes (now - last_synced_at, in minutes)
 *   - room_count, staff_count
 *   - onboarding_source (self_signup vs admin etc.)
 *
 * Pagination: returns up to 200 properties. Beyond that the page
 * needs proper paging — Reeyen is unlikely to scroll past 200 today,
 * but the cap stops one big query from killing the dashboard.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface PropertyRow {
  id: string;
  name: string | null;
  total_rooms: number | null;
  subscription_status: string | null;
  trial_ends_at: string | null;
  pms_type: string | null;
  pms_connected: boolean | null;
  last_synced_at: string | null;
  onboarding_source: string | null;
  property_kind: string | null;
  created_at: string;
  brand: string | null;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  // Phase M2 (2026-05-14): server-side search/filter/pagination params.
  // Default behavior unchanged for callers that omit them: 200-row cap,
  // sorted by health, summary computed. New optional params:
  //   ?search=X        — case-insensitive substring on name OR brand
  //   ?status=Y        — 'active' | 'trial' | 'past_due' | 'stale' | 'pms_disconnected' | 'all'
  //   ?page=N          — 1-indexed page (default 1)
  //   ?pageSize=M      — default 50, max 200
  const params = new URL(req.url).searchParams;
  const search = (params.get('search') ?? '').trim();
  const status = (params.get('status') ?? 'all').trim();
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(10, parseInt(params.get('pageSize') ?? '50', 10) || 50));

  // Build the base query. Search uses ilike OR — we apply it before the
  // server-side count so the summary reflects the filtered set, not all.
  let query = supabaseAdmin
    .from('properties')
    .select(`
      id, name, total_rooms, subscription_status, trial_ends_at,
      pms_type, pms_connected, last_synced_at,
      onboarding_source, property_kind, created_at, brand
    `, { count: 'exact' })
    .order('created_at', { ascending: false });

  if (search) {
    // Postgrest .or() for two ilike conditions on different columns.
    // Escape any commas/parens the user typed so they don't break the
    // .or() syntax — basic defense; full regex escaping is overkill.
    const safe = search.replace(/[,%(*)]/g, '');
    query = query.or(`name.ilike.%${safe}%,brand.ilike.%${safe}%`);
  }

  // Subscription status filter applied server-side. 'stale' and
  // 'pms_disconnected' are computed AFTER fetching (no SQL representation
  // for "no PMS sync in 2h"); those filter the in-memory result.
  if (status && status !== 'all' && ['active', 'trial', 'past_due', 'canceled'].includes(status)) {
    query = query.eq('subscription_status', status);
  }

  // Range for pagination. Postgrest treats range as inclusive on both
  // ends, 0-indexed, so page 1 = [0, pageSize-1].
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.range(from, to);

  const { data: rawProperties, error: propErr, count: totalMatching } = await query;

  if (propErr) {
    return err(`Could not list properties: ${propErr.message}`, {
      requestId, status: 500,
    });
  }

  const properties = (rawProperties ?? []) as PropertyRow[];
  const propertyIds = properties.map((p) => p.id);
  const now = Date.now();

  // ─── Latest onboarding_jobs row per property ────────────────────────────
  // We query in one shot then bucket in memory. For 200 properties × ~5 jobs
  // each that's ~1000 rows — well under any concern.
  const { data: jobs } = await supabaseAdmin
    .from('onboarding_jobs')
    .select('id, property_id, status, step, progress_pct, error, created_at, started_at, completed_at')
    .in('property_id', propertyIds.length > 0 ? propertyIds : ['00000000-0000-0000-0000-000000000000'])
    .order('created_at', { ascending: false })
    .limit(2000);

  const latestJobByProperty = new Map<string, NonNullable<typeof jobs>[number]>();
  for (const j of (jobs ?? [])) {
    const pid = j.property_id as string;
    if (!latestJobByProperty.has(pid)) {
      latestJobByProperty.set(pid, j);
    }
  }

  // ─── Staff counts per property ───────────────────────────────────────────
  // We need the count of active staff per property. supabase-js doesn't
  // expose GROUP BY directly, so we select just the property_id column
  // (one row per staff member, but tiny payload — just a UUID) and tally
  // in JS. At 300 properties × 10 staff = 3000 small rows ≈ ~120KB —
  // acceptable. Better than the previous version which fetched every
  // staff column.
  const { data: staffCountsRaw } = await supabaseAdmin
    .from('staff')
    .select('property_id')
    .eq('is_active', true)
    .in('property_id', propertyIds.length > 0 ? propertyIds : ['00000000-0000-0000-0000-000000000000']);

  const staffCount = new Map<string, number>();
  for (const row of (staffCountsRaw ?? [])) {
    const pid = (row as { property_id: string }).property_id;
    staffCount.set(pid, (staffCount.get(pid) ?? 0) + 1);
  }

  // ─── Build the response ─────────────────────────────────────────────────
  const enriched = properties.map((p) => {
    const job = latestJobByProperty.get(p.id);
    const lastSyncMs = p.last_synced_at ? Date.parse(p.last_synced_at) : null;
    const syncFreshnessMin = lastSyncMs ? Math.round((now - lastSyncMs) / 60_000) : null;

    // A property is "stale" if it has a PMS connected and sync is >2h old.
    // Only counts if pms_connected=true — fresh trial signups without
    // PMS connections aren't stale, they're just not started yet.
    const isStale = p.pms_connected && syncFreshnessMin !== null && syncFreshnessMin > 120;

    // Trial expired but still in trial status = needs nudging
    const trialExpired = p.subscription_status === 'trial'
      && p.trial_ends_at !== null
      && Date.parse(p.trial_ends_at) < now;

    return {
      id: p.id,
      name: p.name,
      totalRooms: p.total_rooms,
      subscriptionStatus: p.subscription_status,
      trialEndsAt: p.trial_ends_at,
      trialExpired,
      pmsType: p.pms_type,
      pmsConnected: !!p.pms_connected,
      lastSyncedAt: p.last_synced_at,
      syncFreshnessMin,
      isStale,
      staffCount: staffCount.get(p.id) ?? 0,
      onboardingSource: p.onboarding_source,
      propertyKind: p.property_kind,
      createdAt: p.created_at,
      latestJob: job
        ? {
            id: job.id,
            status: job.status,
            step: job.step,
            progressPct: job.progress_pct,
            error: job.error,
            createdAt: job.created_at,
            startedAt: job.started_at,
            completedAt: job.completed_at,
          }
        : null,
    };
  });

  // Sort by health: stale + past_due first, then trial_expired, then everything else
  enriched.sort((a, b) => {
    const score = (p: typeof a) => {
      if (p.subscriptionStatus === 'past_due') return 0;
      if (p.isStale) return 1;
      if (p.trialExpired) return 2;
      if (p.subscriptionStatus === 'trial') return 3;
      return 4;
    };
    const sa = score(a), sb = score(b);
    if (sa !== sb) return sa - sb;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });

  // Phase M2: in-memory filters for status values that have no SQL
  // column (computed from last_synced_at + pms_connected).
  let filtered = enriched;
  if (status === 'stale') {
    filtered = enriched.filter((p) => p.isStale);
  } else if (status === 'pms_disconnected') {
    filtered = enriched.filter((p) => !p.pmsConnected);
  }

  // Summary counts for the dashboard header. Computed against the
  // CURRENT page's enriched set + the server-reported total. The
  // pre-filter counts (active/trial/etc.) reflect the page; the
  // pagination block tells the UI the full universe.
  const summary = {
    total: enriched.length,
    trial: enriched.filter((p) => p.subscriptionStatus === 'trial').length,
    active: enriched.filter((p) => p.subscriptionStatus === 'active').length,
    pastDue: enriched.filter((p) => p.subscriptionStatus === 'past_due').length,
    canceled: enriched.filter((p) => p.subscriptionStatus === 'canceled').length,
    stale: enriched.filter((p) => p.isStale).length,
    trialExpired: enriched.filter((p) => p.trialExpired).length,
    pmsConnected: enriched.filter((p) => p.pmsConnected).length,
  };

  // Phase M2 pagination metadata. totalMatching reflects the SQL filter
  // (search + status='active'/'trial'/etc.); for in-memory-only filters
  // ('stale'/'pms_disconnected') we cap to the filtered length.
  const totalForUi = (status === 'stale' || status === 'pms_disconnected')
    ? filtered.length
    : (totalMatching ?? enriched.length);

  return ok({
    summary,
    properties: filtered,
    pagination: {
      page,
      pageSize,
      totalMatching: totalForUi,
      totalPages: Math.max(1, Math.ceil(totalForUi / pageSize)),
      hasMore: page * pageSize < totalForUi,
    },
    filters: { search, status },
  }, { requestId });
}
