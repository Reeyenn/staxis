/**
 * GET /api/admin/onboarding-detail?propertyId=<uuid>
 *
 * Mission-control detail for ONE hotel on the admin Onboarding timeline.
 * Powers the click-to-expand panel: everything the founder needs to watch
 * a hotel move through the 8-step journey without page-hopping —
 * especially the PMS connect phase (robot session + 5-feed freshness +
 * blockers), which is the part that actually goes wrong.
 *
 * Returns:
 *   property   — name/rooms/brand/timezone/services + wizard state
 *   owner      — who is onboarding (accounts via properties.owner_id)
 *   staff      — team added in step 8
 *   session    — property_sessions row (robot status, heartbeat, spend,
 *                restarts, failure streak, paused reason, browser URL)
 *   knowledge  — active recipe version for this hotel's PMS family
 *   feeds      — last_synced_at for each of the 5 polled feeds
 *   mapperJob  — in-flight mapper.learn job if the PMS is being learned
 *   lastHiccup — plain-English "what last went wrong" synthesis
 *
 * Admin-only (requireAdmin). Read-only — actions stay on
 * /api/admin/cua-sessions which the panel calls directly.
 */

import { NextRequest } from 'next/server';
import { isUuid } from '@/lib/api-validate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// The 5 polled feeds → the pms_* table whose last_synced_at is the
// freshness signal (mirrors TARGET_FEEDS in /api/admin/pms-coverage).
const FEED_TABLES = [
  { key: 'arrivals_departures', label: 'Arrivals & departures', table: 'pms_reservations' },
  { key: 'room_status', label: 'Room status', table: 'pms_room_status_log' },
  { key: 'housekeeping', label: 'Housekeeping', table: 'pms_housekeeping_assignments' },
  { key: 'work_orders', label: 'Work orders', table: 'pms_work_orders_v2' },
  { key: 'dashboard_counts', label: 'Live counts', table: 'pms_in_house_snapshot' },
] as const;

/**
 * The robot writes paused_reason as raw developer text (some of it still
 * pointing at pages that no longer exist, e.g. /admin/property-sessions).
 * The founder reads this on screen, so translate the known messages to
 * plain English here — the one place every admin consumer reads from.
 * Returns null to suppress entirely (a "learning" reason isn't a hiccup
 * while the learning run is actually in flight).
 */
function translatePausedReason(raw: string, mapperInFlight: boolean): string | null {
  if (/no active knowledge file/i.test(raw)) {
    // Expected state, not an error: the robot can't read this PMS until the
    // learning run finishes. The panel already shows the learning card.
    if (mapperInFlight) return null;
    return 'The robot doesn’t know this PMS yet — a learning run is queued and starts shortly.';
  }
  if (/exceeded .* restarts/i.test(raw)) {
    return 'The robot kept crashing and paused itself to be safe. Restart it once the cause is fixed.';
  }
  // Unknown message: show it, but strip any dead-page pointers.
  return raw.replace(/;?\s*check \/admin\/[a-z-]+ for progress\.?/i, '.').replace(/\s*\/admin\/[a-z-]+\s*/g, ' ').trim();
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const propertyId = new URL(req.url).searchParams.get('propertyId') ?? '';
  if (!isUuid(propertyId)) {
    return err('propertyId must be a UUID', { requestId, status: 400 });
  }

  const { data: prop, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('id, name, total_rooms, brand, timezone, pms_type, services_enabled, created_at, onboarding_state, onboarding_completed_at, owner_id')
    .eq('id', propertyId)
    .maybeSingle();
  if (propErr) return err(`Could not load property: ${propErr.message}`, { requestId, status: 500 });
  if (!prop) return err('Property not found', { requestId, status: 404 });

  // Everything else is independent — fetch in parallel.
  const [sessionQ, staffQ, ownerQ, mapperQ, ...feedQs] = await Promise.all([
    supabaseAdmin
      .from('property_sessions')
      .select('pms_family, status, paused_reason, last_alive_at, last_successful_read_at, current_browser_url, daily_claude_cost_micros, restart_count, read_failure_streak, updated_at')
      .eq('property_id', propertyId)
      .maybeSingle(),
    supabaseAdmin
      .from('staff')
      .select('name, department')
      .eq('property_id', propertyId)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(20),
    prop.owner_id
      ? supabaseAdmin
          .from('accounts')
          .select('display_name, username, phone')
          .eq('data_user_id', prop.owner_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabaseAdmin
      .from('workflow_jobs')
      .select('id, kind, status, attempts, max_attempts, claude_cost_micros, created_at, result')
      .eq('property_id', propertyId)
      .like('kind', 'mapper.%')
      .in('status', ['queued', 'running'])
      .order('created_at', { ascending: false })
      .limit(1),
    ...FEED_TABLES.map((f) =>
      supabaseAdmin
        .from(f.table)
        .select(f.table === 'pms_in_house_snapshot' ? 'last_synced_at, last_good_at, has_error' : 'last_synced_at')
        .eq('property_id', propertyId)
        .order('last_synced_at', { ascending: false })
        .limit(1),
    ),
  ]);

  const session = sessionQ.data ?? null;

  // Active recipe version for this hotel's PMS family (if any).
  const family = session?.pms_family ?? prop.pms_type;
  let knowledge: { version: number; learnedAt: string | null } | null = null;
  if (family) {
    const { data: kf } = await supabaseAdmin
      .from('pms_knowledge_files')
      .select('version, learned_at')
      .eq('pms_family', family)
      .eq('status', 'active')
      .is('deleted_at', null)
      .maybeSingle();
    if (kf) knowledge = { version: kf.version, learnedAt: kf.learned_at };
  }

  interface SnapshotRow { last_synced_at: string | null; last_good_at?: string | null; has_error?: boolean | null }
  const feeds = FEED_TABLES.map((f, i) => {
    const row = (feedQs[i]?.data?.[0] ?? null) as SnapshotRow | null;
    return {
      key: f.key,
      label: f.label,
      lastSyncedAt: row?.last_synced_at ?? null,
      hasError: f.key === 'dashboard_counts' ? (row?.has_error ?? false) : false,
    };
  });

  // Plain-English "what last went wrong" — paused reason wins, then a
  // bad-counts read (last-good preserved), then a validation streak.
  const mapperInFlight = (mapperQ.data?.length ?? 0) > 0;
  const snapshot = (feedQs[FEED_TABLES.length - 1]?.data?.[0] ?? null) as SnapshotRow | null;
  let lastHiccup: string | null = null;
  if (session?.paused_reason) {
    lastHiccup = translatePausedReason(session.paused_reason, mapperInFlight);
  } else if (snapshot?.has_error) {
    lastHiccup = 'Live counts hit a bad read — kept the last good numbers instead of overwriting.';
  } else if ((session?.read_failure_streak ?? 0) > 0) {
    lastHiccup = `${session?.read_failure_streak} read${(session?.read_failure_streak ?? 0) === 1 ? '' : 's'} in a row failed checks — robot is retrying.`;
  }

  const mapperRow = mapperQ.data?.[0] ?? null;
  const owner = (ownerQ.data ?? null) as { display_name: string | null; username: string | null; phone: string | null } | null;

  return ok({
    property: {
      id: prop.id,
      name: prop.name,
      totalRooms: prop.total_rooms,
      brand: prop.brand,
      timezone: prop.timezone,
      pmsType: prop.pms_type,
      servicesEnabled: prop.services_enabled ?? null,
      createdAt: prop.created_at,
      onboardingState: prop.onboarding_state ?? null,
      onboardingCompletedAt: prop.onboarding_completed_at,
    },
    owner: owner ? { name: owner.display_name, email: owner.username, phone: owner.phone } : null,
    staff: (staffQ.data ?? []).map((s) => ({ name: s.name, department: s.department })),
    session: session
      ? {
          pmsFamily: session.pms_family,
          status: session.status,
          pausedReason: session.paused_reason,
          lastAliveAt: session.last_alive_at,
          lastSuccessfulReadAt: session.last_successful_read_at,
          currentBrowserUrl: session.current_browser_url,
          dailySpendMicros: session.daily_claude_cost_micros ?? 0,
          capMicros: 5_000_000,
          restartCount: session.restart_count ?? 0,
          readFailureStreak: session.read_failure_streak ?? 0,
        }
      : null,
    knowledge,
    feeds,
    mapperJob: mapperRow
      ? {
          id: mapperRow.id,
          kind: mapperRow.kind,
          status: mapperRow.status,
          attempts: mapperRow.attempts,
          maxAttempts: mapperRow.max_attempts,
          costMicros: mapperRow.claude_cost_micros ?? 0,
          createdAt: mapperRow.created_at,
          // The robot is parked on a 2FA screen waiting for a one-time
          // code (mapper.ts setAwaitingMfa). The panel renders a code box
          // while this is set; POST /api/admin/pms-auth-code feeds it.
          awaiting2fa: Boolean((mapperRow.result as { awaiting_2fa?: unknown } | null)?.awaiting_2fa),
          awaiting2faSince:
            ((mapperRow.result as { awaiting_2fa?: { since?: string } } | null)?.awaiting_2fa?.since) ?? null,
        }
      : null,
    lastHiccup,
  }, { requestId });
}
