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
 * Pagination: returns up to 200 properties per page. Filters backed by
 * database columns are paged in PostgREST. Computed health filters are
 * evaluated across the matching fleet first, then paged, so a stale or
 * disconnected property cannot disappear merely because it was outside
 * the first unfiltered page.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { mapPropertySessionStatusToJobShape } from '@/lib/cua-session-job-mapping';
import { normalizeSectionFlags, resolveSections } from '@/lib/sections/registry';
import { FLEET_STALE_SYNC_MINUTES } from '@/lib/admin-property-health';

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
  //   ?status=Y        — 'active' | 'trial' | 'past_due' | 'stale' | 'pms_disconnected' | 'no_pms' | 'all'
  //   ?page=N          — 1-indexed page (default 1)
  //   ?pageSize=M      — default 50, max 200
  const params = new URL(req.url).searchParams;
  const search = (params.get('search') ?? '').trim();
  const status = (params.get('status') ?? 'all').trim();
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(10, parseInt(params.get('pageSize') ?? '50', 10) || 50));

  const isComputedStatus = status === 'stale' || status === 'pms_disconnected';
  const databaseStatuses = ['active', 'trial', 'past_due', 'canceled'];

  // Build a fresh query for each batch. Supabase query builders are mutable,
  // so reusing one while walking multiple ranges would stack range clauses.
  const buildPropertyQuery = () => {
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
      // Escape commas/parens/wildcards so input cannot alter the filter.
      const safe = search.replace(/[,%_(*)]/g, '');
      query = query.or(`name.ilike.%${safe}%,brand.ilike.%${safe}%`);
    }

    if (databaseStatuses.includes(status)) {
      query = query.eq('subscription_status', status);
    } else if (status === 'no_pms') {
      query = query.is('pms_type', null);
    }

    return query;
  };

  // PostgREST ranges are inclusive and zero-indexed.
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  let properties: PropertyRow[] = [];
  let totalMatching: number | null = null;

  if (isComputedStatus) {
    // Staleness and connection state depend on property_sessions, so applying
    // the requested page before enrichment would lose matches on later pages.
    const batchSize = 200;
    for (let offset = 0; ; offset += batchSize) {
      const { data, error: propErr, count } = await buildPropertyQuery()
        .range(offset, offset + batchSize - 1);

      if (propErr) {
        return err(`Could not list properties: ${propErr.message}`, {
          requestId, status: 500,
        });
      }

      const batch = (data ?? []) as PropertyRow[];
      properties.push(...batch);
      totalMatching ??= count;

      if (batch.length < batchSize || (count !== null && properties.length >= count)) {
        break;
      }
    }
  } else {
    const { data, error: propErr, count } = await buildPropertyQuery().range(from, to);

    if (propErr) {
      return err(`Could not list properties: ${propErr.message}`, {
        requestId, status: 500,
      });
    }

    properties = (data ?? []) as PropertyRow[];
    totalMatching = count;
  }

  const propertyIds = properties.map((p) => p.id);
  const now = Date.now();

  // ─── Property session state (v4) ─────────────────────────────────────
  // Replaced the old onboarding_jobs lookup (post-v4 those rows are
  // an empty stub). property_sessions is one-row-per-hotel with the
  // canonical CUA driver state. Used by OnboardingTab to bucket
  // hotels into the onboarding funnel.
  interface SessionLite {
    property_id: string;
    status: string;
    paused_reason: string | null;
    last_alive_at: string | null;
    last_successful_read_at: string | null;
    updated_at: string;
  }
  const sessionsRaw: SessionLite[] = [];
  const idBatchSize = 100;
  for (let index = 0; index < propertyIds.length; index += idBatchSize) {
    const ids = propertyIds.slice(index, index + idBatchSize);
    const { data, error: sessionsErr } = await supabaseAdmin
      .from('property_sessions')
      .select(
        'property_id, status, paused_reason, last_alive_at, last_successful_read_at, updated_at',
      )
      .in('property_id', ids);

    if (sessionsErr) {
      return err(`Could not load property sessions: ${sessionsErr.message}`, {
        requestId, status: 500,
      });
    }

    sessionsRaw.push(...((data ?? []) as SessionLite[]));
  }

  const sessionByProperty = new Map<string, SessionLite>();
  for (const s of sessionsRaw) {
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
  // expose GROUP BY directly, so we select only id + property_id (one row
  // per staff member) and tally in JS. The id gives paged reads a stable
  // order. At 300 properties × 10 staff the payload remains small —
  // acceptable. Better than the previous version which fetched every
  // staff column.
  const staffCountsRaw: Array<{ id: string; property_id: string }> = [];
  for (let index = 0; index < propertyIds.length; index += idBatchSize) {
    const ids = propertyIds.slice(index, index + idBatchSize);
    const staffPageSize = 1_000;

    for (let offset = 0; ; offset += staffPageSize) {
      const { data, error: staffErr } = await supabaseAdmin
        .from('staff')
        .select('id, property_id')
        .eq('is_active', true)
        .in('property_id', ids)
        .order('id', { ascending: true })
        .range(offset, offset + staffPageSize - 1);

      if (staffErr) {
        return err(`Could not load staff counts: ${staffErr.message}`, {
          requestId, status: 500,
        });
      }

      const batch = (data ?? []) as Array<{ id: string; property_id: string }>;
      staffCountsRaw.push(...batch);
      if (batch.length < staffPageSize) break;
    }
  }

  const staffCount = new Map<string, number>();
  for (const row of staffCountsRaw) {
    const pid = row.property_id;
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

    // A stopped session is the canonical detached state. For properties
    // without any session row, retain the legacy boolean as a fallback.
    const pmsConnected = session ? session.status !== 'stopped' : !!p.pms_connected;

    // A property is "stale" if it has a PMS connected and sync is >12h old.
    // Only counts if pmsConnected — fresh trial signups without PMS
    // connections aren't stale, they're just not started yet.
    const isStale = pmsConnected
      && syncFreshnessMin !== null
      && syncFreshnessMin > FLEET_STALE_SYNC_MINUTES;

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

  // Summary counts for the dashboard header. Computed filters enrich the
  // whole search-matching fleet; database-backed filters retain page-level
  // summary behavior for backwards compatibility.
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
  const totalForUi = isComputedStatus
    ? filtered.length
    : (totalMatching ?? enriched.length);

  const propertiesForPage = isComputedStatus
    ? filtered.slice(from, to + 1)
    : filtered;

  return ok({
    summary,
    properties: propertiesForPage,
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
