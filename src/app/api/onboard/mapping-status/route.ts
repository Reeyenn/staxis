// @audit: tenant-scope-not-applicable — code-gated public onboarding status poll. Tenant scope IS enforced, but via the join-code capability check (resolvePropertyId → hotel_join_codes), not a session: the code is the bearer credential, same trust model as GET /api/onboard/wizard. Deliberately not session-gated (polled ~every 3s; fetchWithAuth would sign the user out on a transient 2FA refresh) and returns only aggregate room counts, no guest PII. Invalid-code probes are IP-rate-limited (dedicated bucket) to bound enumeration; valid polling is never limited.
/**
 * GET /api/onboard/mapping-status?code=XXXX
 *
 * Public, code-gated live status for the onboarding wizard's step 7
 * ("Learning your PMS"). Replaces the frozen "mapping · 50% · Awaiting
 * mapper" bar the step used to get from /api/pms/job-status (which only
 * reads the coarse property_sessions.status).
 *
 * WHY A NEW ROUTE: the wizard only knows `pmsJobId === propertyId`. But the
 * rich mapper progress lives somewhere the wizard never looks — the mapper
 * runs as a `workflow_jobs` row (kind='mapper.learn_pms_family',
 * property_id=<pid>, its OWN id) and broadcasts friendly per-feed
 * milestones on the Supabase realtime channel `mapping:{workflow_jobs.id}`.
 * The session row sits at `paused_no_knowledge_file` (=50%) the entire time
 * the mapper runs, and STAYS there for the `park_draft` outcome (the live
 * driver only flips to `alive` on `auto_promote`) — so the old bar could
 * never advance. This route bridges propertyId → the mapper job → a single
 * coherent { phase, outcome, channel, feedsFound, live numbers } payload.
 *
 * AUTH: the join code is the trust anchor, exactly like GET
 * /api/onboard/wizard (resolvePropertyByCode). We return onboarding
 * progress + AGGREGATE room counts only — no guest PII. The step polls this
 * every ~3s for up to ~30 min, so it is deliberately:
 *   - NOT session-gated: fetchWithAuth can sign the user out on a transient
 *     2FA refresh mid-poll (see onboard/page.tsx step-3 trust-device note).
 *   - NOT rate-limited on the poll: code discovery is already capped at
 *     10/hr per IP on the wizard GET, so this route can't be reached without
 *     an already-valid code.
 *
 * RLS BUG CLASS: this is a public page, so every DB read here goes through
 * supabaseAdmin — the page NEVER calls supabase.from() in the browser. (The
 * page DOES open a realtime BROADCAST channel for live milestones, but
 * broadcast is pub/sub, not a table read, so the silent-empty-state RLS bug
 * cannot apply.)
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString, todayStr } from '@/lib/utils';
import { PMS_REGISTRY } from '@/lib/pms/registry';
import type { PMSType } from '@/lib/pms/types';
import { checkAndIncrementRateLimit, rateLimitedResponse, ipToRateLimitKey } from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

type Phase = 'preparing' | 'learning' | 'mfa' | 'done' | 'failed';
type Outcome = 'auto_promote' | 'park_draft' | 'quarantine';
type FailReason = 'login' | 'login_url' | 'stopped' | 'generic';

interface Metric {
  value: number | null;
  available: boolean;
}
/** Build a metric. When unavailable the value is forced to null so the
 *  client can never accidentally render a stale/derived number as real. */
function metric(value: number | null, available: boolean): Metric {
  return { value: available ? value : null, available };
}

interface LiveNumbers {
  anyAvailable: boolean;
  capturedAt: string | null;
  totalRooms: number | null;
  occupancyPct: Metric;
  occupiedRooms: Metric;
  guestsInHouse: Metric;
  arrivalsToday: Metric;
  departuresToday: Metric;
}

/**
 * Resolve a join code → propertyId. Local copy of the canonical lookup in
 * src/app/api/onboard/wizard/route.ts (resolvePropertyByCode) — duplicated,
 * not imported, so this additive route never has to edit the shared wizard
 * route. Keep the two in sync if hotel_join_codes changes.
 */
async function resolvePropertyId(code: string): Promise<string | null> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  const { data, error } = await supabaseAdmin
    .from('hotel_join_codes')
    .select('hotel_id, revoked_at, expires_at')
    .eq('code', normalized)
    .maybeSingle();
  if (error || !data) return null;
  if (data.revoked_at) return null;
  if (new Date(data.expires_at as string).getTime() <= Date.now()) return null;
  return data.hotel_id as string;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Best-effort client IP for rate-limit keying (Vercel sets x-forwarded-for).
 *  Mirrors the helper in the wizard route. */
function clientIp(req: NextRequest): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() ?? null;
  return req.headers.get('x-real-ip');
}

/** Count pms_reservations rows for a property with optional extra filters.
 *  Returns null on error (so the caller can treat it as "feed unknown"). */
async function countReservations(
  propertyId: string,
  refine?: (q: ReturnType<typeof baseResQuery>) => ReturnType<typeof baseResQuery>,
): Promise<number | null> {
  let q = baseResQuery(propertyId);
  if (refine) q = refine(q);
  const { count, error } = await q;
  if (error) return null;
  return count ?? 0;
}
function baseResQuery(propertyId: string) {
  return supabaseAdmin
    .from('pms_reservations')
    .select('id', { count: 'exact', head: true })
    .eq('property_id', propertyId);
}

/**
 * Live "eyeball accuracy" numbers, each independently degradable. Prefers
 * direct snapshot fields; reservation counts complement / fall back. A 0 is
 * surfaced ONLY when its source row/feed demonstrably exists — otherwise the
 * metric is `available: false` and the UI shows "counts arriving shortly"
 * instead of a fake 0. A separate chat owns the mapper's data-write fix, so
 * at first this may be entirely unavailable — that's expected and handled.
 */
async function computeNumbers(
  propertyId: string,
  totalRooms: number | null,
  timezone: string,
  requestId: string,
): Promise<LiveNumbers> {
  let today: string;
  try {
    today = todayStr(timezone);
  } catch {
    // Invalid IANA tz string would otherwise throw and 500 every poll.
    // timezone comes from a controlled dropdown, so this is purely defensive.
    today = todayStr('America/Chicago');
  }

  const [{ data: snap, error: snapErr }, resTotal] = await Promise.all([
    supabaseAdmin
      .from('pms_in_house_snapshot')
      .select('total_occupied_rooms, total_guests_in_house, arrivals_remaining_today, departures_remaining_today, checked_in_today_count, checked_out_today_count, captured_at, last_good_at, has_error')
      .eq('property_id', propertyId)
      .maybeSingle(),
    countReservations(propertyId),
  ]);
  if (snapErr) {
    log.warn('[onboard/mapping-status] snapshot read failed', { requestId, propertyId, msg: errToString(snapErr) });
  }

  // Reservation counts are a FALLBACK for arrivals/departures when the
  // in-house snapshot is absent. Stayovers are intentionally NOT derived
  // from pms_reservations: for Choice Advantage that feed is arrivals +
  // departures only (migration 0202), so it cannot honestly count in-house
  // stayovers — a 0 there would read as real. Omitted until a reliable
  // in-house feed exists.
  const reservationsExist = (resTotal ?? 0) > 0;
  let arrivalsRes: number | null = null;
  let departuresRes: number | null = null;
  if (reservationsExist) {
    [arrivalsRes, departuresRes] = await Promise.all([
      countReservations(propertyId, (q) => q.eq('arrival_date', today)),
      countReservations(propertyId, (q) => q.eq('departure_date', today)),
    ]);
  }

  const occupied = num(snap?.total_occupied_rooms);
  const guests = num(snap?.total_guests_in_house);
  const checkedIn = num(snap?.checked_in_today_count);
  const arrRemain = num(snap?.arrivals_remaining_today);
  const checkedOut = num(snap?.checked_out_today_count);
  const depRemain = num(snap?.departures_remaining_today);

  // Arrivals today = checked-in + still-to-arrive. Require BOTH snapshot
  // components: the snapshot is written atomically, so a lone non-null half
  // signals partial/garbage data — summing it would undercount and still
  // read as a real number. Fall back to the reservations arrival_date count;
  // else mark unavailable. Symmetric for departures.
  let arrivalsVal: number | null = null;
  let arrivalsAvail = false;
  if (checkedIn !== null && arrRemain !== null) {
    arrivalsVal = checkedIn + arrRemain;
    arrivalsAvail = true;
  } else if (arrivalsRes !== null) {
    arrivalsVal = arrivalsRes;
    arrivalsAvail = true;
  }
  let departuresVal: number | null = null;
  let departuresAvail = false;
  if (checkedOut !== null && depRemain !== null) {
    departuresVal = checkedOut + depRemain;
    departuresAvail = true;
  } else if (departuresRes !== null) {
    departuresVal = departuresRes;
    departuresAvail = true;
  }

  const occAvail = occupied !== null && totalRooms !== null && totalRooms > 0;
  const occupancyPct = occAvail ? Math.round((occupied! / totalRooms!) * 100) : null;

  // Prefer last_good_at when the latest read errored (safety layer preserves
  // last-good values for the in-house snapshot).
  const capturedAt = snap
    ? ((snap.has_error ? (snap.last_good_at as string | null) : (snap.captured_at as string | null)) ??
        (snap.captured_at as string | null) ??
        (snap.last_good_at as string | null))
    : null;

  const metrics = {
    occupancyPct: metric(occupancyPct, occAvail),
    occupiedRooms: metric(occupied, occupied !== null),
    guestsInHouse: metric(guests, guests !== null),
    arrivalsToday: metric(arrivalsVal, arrivalsAvail),
    departuresToday: metric(departuresVal, departuresAvail),
  };
  const anyAvailable = Object.values(metrics).some((m) => m.available);

  return { anyAvailable, capturedAt, totalRooms, ...metrics };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const code = new URL(req.url).searchParams.get('code') ?? '';

  const propertyId = await resolvePropertyId(code);
  if (!propertyId) {
    // Rate-limit ONLY invalid-code probes (per IP) to bound brute-force
    // enumeration of the join-code space. Valid polling of a real code is
    // never limited — the limiter is checked AFTER the lookup and only on the
    // miss path. Dedicated bucket so it can't eat into the wizard's budget.
    const limit = await checkAndIncrementRateLimit('onboard-mapping-status', ipToRateLimitKey(clientIp(req)));
    if (!limit.allowed) return rateLimitedResponse(limit.current, limit.cap, limit.retryAfterSec);
    return err('Invalid or expired code', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  const { data: prop, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('id, pms_type, total_rooms, timezone')
    .eq('id', propertyId)
    .maybeSingle();
  if (propErr || !prop) {
    log.error('[onboard/mapping-status] property fetch failed', { requestId, propertyId, msg: errToString(propErr) });
    return err('Property not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  const pmsType = (prop.pms_type as string | null) ?? 'choice_advantage';
  const pmsLabel = PMS_REGISTRY[pmsType as PMSType]?.label ?? 'your PMS';
  const totalRooms = num(prop.total_rooms);
  const timezone = (prop.timezone as string | null) ?? 'America/Chicago';

  const [{ data: sessionRow }, { data: mapperJob }] = await Promise.all([
    supabaseAdmin
      .from('property_sessions')
      .select('status, paused_reason, last_alive_at')
      .eq('property_id', propertyId)
      .maybeSingle(),
    supabaseAdmin
      .from('workflow_jobs')
      .select('id, status, result, error, created_at')
      .eq('property_id', propertyId)
      .like('kind', 'mapper.%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const sessionStatus = (sessionRow?.status as string | null) ?? null;

  let phase: Phase;
  let outcome: Outcome | null = null;
  let feedsFound: number | null = null;
  let pct: number | null = null;
  let failReason: FailReason | null = null;
  let workflowJobId: string | null = null;

  if (mapperJob) {
    workflowJobId = mapperJob.id as string;
    const jobStatus = mapperJob.status as string;
    const result = (mapperJob.result as Record<string, unknown> | null) ?? null;
    if (jobStatus === 'completed') {
      phase = 'done';
      // Read result defensively: mapping-driver returns camelCase
      // (promotionDecision/targetsFound) but its doc header shows snake_case,
      // so accept either rather than silently miss the outcome.
      const decision = (result?.promotionDecision ?? result?.promotion_decision) as string | undefined;
      outcome =
        decision === 'auto_promote' || decision === 'park_draft' || decision === 'quarantine'
          ? decision
          : 'park_draft'; // friendliest "learned, finalizing" default if the field is missing
      feedsFound = num(result?.targetsFound ?? result?.targets_found);
      pct = 100;
    } else if (jobStatus === 'failed' || jobStatus === 'cancelled') {
      phase = 'failed';
      if (jobStatus === 'cancelled') {
        failReason = 'stopped'; // admin aborted the run
      } else {
        const raw = ((mapperJob.error as string | null) ?? '').toLowerCase();
        // Credential/login failures → "check username & password", checked
        // FIRST so an error mentioning both creds AND a URL isn't miscategorised
        // as a URL problem. Pure pre-flight / bad-URL → "check the login URL".
        failReason =
          raw.includes('login failed') || raw.includes('credential') || raw.includes('password') ||
          raw.includes('sign in') || raw.includes('sign-in') || raw.includes('invalid username')
            ? 'login'
            : raw.includes('pre-flight') || raw.includes('preflight') || raw.includes('login url')
              ? 'login_url'
              : 'generic';
      }
    } else {
      // queued / running. A run parked on a PMS 2FA prompt sets
      // result.awaiting_2fa (cua-service mapper.ts setAwaitingMfa) — surface
      // that as a calm "security check" instead of an endless "learning".
      const awaiting2fa =
        result && typeof result === 'object'
          ? (result as Record<string, unknown>).awaiting_2fa
          : null;
      if (awaiting2fa) {
        phase = 'mfa';
        pct = 70;
      } else {
        phase = 'learning';
        pct = jobStatus === 'running' ? 40 : 10;
      }
    }
  } else {
    // No mapper job row yet — lean on the coarse session status.
    switch (sessionStatus) {
      case 'alive':
        // PMS family already known (shared knowledge file) → went live with
        // no mapping run. Treat as done/auto_promote (no feed count).
        phase = 'done';
        outcome = 'auto_promote';
        pct = 100;
        break;
      case 'paused_mfa':
        phase = 'mfa';
        pct = 70;
        break;
      case 'failed_restart':
        phase = 'failed';
        failReason = 'login';
        break;
      case 'stopped':
        phase = 'failed';
        failReason = 'stopped';
        break;
      case 'paused_circuit_breaker':
        phase = 'failed';
        failReason = 'generic';
        break;
      case 'starting':
        phase = 'preparing';
        pct = 20;
        break;
      case 'paused_no_knowledge_file':
      case 'paused_cost_cap':
      default:
        phase = 'preparing';
        pct = 10;
        break;
    }
  }

  const channel = workflowJobId ? `mapping:${workflowJobId}` : null;

  let numbers: LiveNumbers | null = null;
  if (phase === 'done') {
    numbers = await computeNumbers(propertyId, totalRooms, timezone, requestId);
  }

  return ok(
    { phase, outcome, workflowJobId, channel, pmsLabel, feedsFound, pct, failReason, numbers },
    { requestId },
  );
}
