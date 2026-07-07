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
import { mapPropertySessionStatusToJobShape } from '@/lib/cua-session-job-mapping';
import { normalizeSectionFlags, resolveSections } from '@/lib/sections/registry';

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
  // jsonb map of step → ISO timestamp (accountCreatedAt, emailVerifiedAt, …).
  // Drives the live onboarding-timeline on the admin surface.
  onboarding_state: Record<string, string | null> | null;
  onboarding_completed_at: string | null;
  // Per-hotel section on/off map (jsonb). Missing/null ⇒ all 8 sections on.
  enabled_sections: Record<string, boolean> | null;
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
      onboarding_source, property_kind, created_at, brand,
      onboarding_state, onboarding_completed_at, enabled_sections
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

  // ─── Property session state (v4) ─────────────────────────────────────
  // Replaced the old onboarding_jobs lookup (post-v4 those rows are
  // an empty stub). property_sessions is one-row-per-hotel with the
  // canonical CUA driver state. Used by OnboardingTab to bucket
  // hotels into the onboarding funnel.
  const { data: sessionsRaw } = await supabaseAdmin
    .from('property_sessions')
    .select(
      'property_id, status, paused_reason, last_alive_at, last_successful_read_at, updated_at',
    )
    .in('property_id', propertyIds.length > 0 ? propertyIds : ['00000000-0000-0000-0000-000000000000']);

  interface SessionLite {
    property_id: string;
    status: string;
    paused_reason: string | null;
    last_alive_at: string | null;
    last_successful_read_at: string | null;
    updated_at: string;
  }
  const sessionByProperty = new Map<string, SessionLite>();
  for (const s of (sessionsRaw ?? []) as SessionLite[]) {
    sessionByProperty.set(s.property_id, s);
  }

  // Project a session row → legacy onboarding-job shape so the
  // PropertyRow.latestJob field the UI already consumes keeps working.
  // Status/step/progressPct projection is centralized in
  // src/lib/cua-session-job-mapping.ts (also used by /api/admin/onboarding-jobs
  // and /api/pms/job-status). One source of truth — no drift.
  const mapSessionToJob = (s: SessionLite) => {
    const mapped = mapPropertySessionStatusToJobShape(s.status);
    return {
      id: s.property_id,
      status: mapped.status,
      step: mapped.step,
      progressPct: mapped.progressPct,
      error: s.paused_reason,
      createdAt: s.updated_at,
      startedAt: s.updated_at,
      completedAt: s.last_alive_at,
    };
  };

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
    const session = sessionByProperty.get(p.id);
    const mapped = session ? mapSessionToJob(session) : null;

    // In v4 the truth-of-record for "is data flowing" is property_sessions,
    // not properties.last_synced_at (which nothing writes anymore). Treat
    // session.last_successful_read_at as the freshness signal; fall back to
    // properties.last_synced_at for legacy display.
    const lastSyncIso = session?.last_successful_read_at ?? p.last_synced_at;
    const lastSyncMs = lastSyncIso ? Date.parse(lastSyncIso) : null;
    const syncFreshnessMin = lastSyncMs ? Math.round((now - lastSyncMs) / 60_000) : null;

    // In v4, "pms connected" = there's a session row for this hotel.
    // Fall back to the legacy boolean column if the session table is
    // empty (shouldn't happen post-0206, but defensive).
    const pmsConnected = !!session || !!p.pms_connected;

    // A property is "stale" if it has a PMS connected and sync is >2h old.
    // Only counts if pmsConnected — fresh trial signups without PMS
    // connections aren't stale, they're just not started yet.
    const isStale = pmsConnected && syncFreshnessMin !== null && syncFreshnessMin > 120;

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
      pmsConnected,
      lastSyncedAt: lastSyncIso,
      syncFreshnessMin,
      isStale,
      staffCount: staffCount.get(p.id) ?? 0,
      onboardingSource: p.onboarding_source,
      propertyKind: p.property_kind,
      createdAt: p.created_at,
      // v4 session state — added 0206 rewire. OnboardingTab uses this
      // to bucket hotels into the funnel stages.
      sessionStatus: session?.status ?? null,
      sessionPausedReason: session?.paused_reason ?? null,
      latestJob: mapped,
      // Live onboarding-timeline inputs: the customer's per-step timestamps
      // and the wizard-finished marker. The admin surface derives the
      // 1-of-9 journey position from these + sessionStatus.
      onboardingState: p.onboarding_state ?? null,
      onboardingCompletedAt: p.onboarding_completed_at ?? null,
      // Full resolved 8-key section map (default-ON coalesced) so the Live
      // card can show a "N off" pill and the Sections modal can pre-hydrate.
      enabledSections: resolveSections(normalizeSectionFlags(p.enabled_sections)),
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
