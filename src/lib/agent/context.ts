// ─── Live hotel context fetcher ───────────────────────────────────────────
// Per-turn snapshot of the hotel state the agent should know about. Gets
// stringified into the system prompt so Claude can answer "what's the
// occupancy" or "any overdue rooms" without having to call a tool first.
//
// Keep this cheap — runs on every user turn. Heavy queries (financial
// reports, multi-day aggregations) should be left for explicit tool calls.
//
// DATA-AGE CONTRACT (A2, 2026-07-24): the room / occupancy / reservation
// numbers below are NOT live — they are as old as the last PMS report, so the
// snapshot carries the raw capture TIME (never a pre-rendered age, which the
// 30s cache would freeze) and formatSnapshotForPrompt renders the as-of line
// at prompt-build time. The line is emitted ONLY for `mode === 'live'` hotels:
// a manual hotel is its own system of record and warning it about staleness
// would be a lie in the opposite direction.

import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AppRole } from '@/lib/roles';
import { computeRoomTotal } from './tools/_helpers';
import { fetchTodayPropertyCounts } from '@/lib/db/today-room-work';
import { mergePmsRoomsForDate } from '@/lib/pms-rooms-server';
import { getPropertyFeedStatus } from '@/lib/pms-feed-status-server';
import {
  learningFeeds,
  countsTrusted,
  isDataPending,
  freshnessTier,
  formatAsOfClock,
  PMS_STALE_MAX_MINUTES,
  type FreshnessSource,
} from '@/lib/pms/feed-status';
import { isPMSType, type PMSType } from '@/lib/pms/types';
import { propertyLocalToday } from '@/lib/schedule/local-date';

export interface HotelSnapshot {
  /** ISO date string YYYY-MM-DD in the property's local time. */
  today: string;
  property: {
    id: string;
    name: string | null;
    timezone: string | null;
    /**
     * A3 — which PMS family this hotel is on (`properties.pms_type`,
     * normalized through `isPMSType`; junk or unset degrades to null).
     *
     * This is a key for the STABLE (cached) half of the system prompt: it
     * selects the shared PMS-family prompt addendum. `formatSnapshotForPrompt`
     * must NEVER render it — printing a tier key into the per-turn block costs
     * tokens on every turn and buys nothing.
     *
     * Optional so existing snapshot literals (tests, fixtures) stay valid;
     * absent and null both mean "no family tier for this hotel".
     */
    pmsFamily?: PMSType | null;
  };
  rooms: {
    total: number;
    /** Rooms that still need a turn: PMS vacant-dirty + today's checkouts.
     *  Sourced from today_property_counts_v1 (the live pms_* feed). */
    dirty: number;
    /** Always 0 for now — "in progress" is a housekeeping-workflow state
     *  that lives in the future overlay table, not the PMS feed. */
    in_progress: number;
    /** Rooms confirmed vacant-and-clean in the PMS in-house snapshot. */
    clean: number;
    /** Always 0 for now — DND is an overlay-table workflow flag. */
    dnd: number;
    /** Always 0 for now — issue notes are an overlay-table field. */
    issuesFlagged: number;
    /** Always 0 for now — "help requested" is an overlay-table field. */
    helpRequested: number;
    /** Today's departures (checkout cleans) from pms_reservations. */
    checkouts: number;
    /** Stayover rooms (occupied tonight too) from pms_reservations. */
    stayovers: number;
    /** Occupied rooms right now (pms_in_house_snapshot). */
    inHouse: number;
    /** Out-of-order rooms (pms_in_house_snapshot). */
    outOfOrder: number;
    /** When > 0, the live PMS feed knows about fewer rooms than the
     *  property's master inventory. Surfaced to the agent so it doesn't
     *  claim "100% occupancy" while looking at a partial picture. */
    seedingGap: number;
  };
  staff: {
    activeToday: number;
    assignedHousekeepers: number;
  };
  /**
   * feat/cua-partial-promotion — PMS feeds that are still being learned for
   * this property (partial promotion). When non-empty, the room/reservation
   * counts above may be zero because the SOURCE is missing, not because the
   * hotel is empty — formatSnapshotForPrompt emits an explicit caveat so
   * the agent says "still syncing" instead of confidently stating zeros.
   */
  pmsLearningFeeds?: string[];
  /** Review pass — the in-house snapshot has no source (counts feed
   *  learning/unavailable): clean/occupied/dirty-vacancy numbers above are
   *  COALESCE-0s, not facts. Distinct from learning: it may never arrive. */
  pmsCountsUnavailable?: boolean;
  /** Review pass — first sync hasn't landed: EVERY pms-derived number above
   *  is an empty-table zero. */
  pmsConnectionPending?: boolean;
  /**
   * A2 — ISO time the PMS numbers above were captured, or null when this
   * hotel's feed carries no capture time. Raw ISO on purpose: a pre-rendered
   * "22 min ago" would be frozen by the 30s snapshot cache and go on claiming
   * 22 minutes for half a minute after it was true.
   *
   * `pmsDataSource` is the GATE, not this field: it is set if and only if the
   * property is a live-PMS hotel, so `undefined` means "manual or onboarding
   * hotel — say nothing about data age", while `pmsDataCapturedAt: null` means
   * "live PMS hotel whose feed has no capture time — say the age is unknown".
   */
  pmsDataCapturedAt?: string | null;
  /** A2 — which signal produced pmsDataCapturedAt. Present ⇔ live-PMS hotel. */
  pmsDataSource?: FreshnessSource;
  // Only populated for housekeeping role — their own assigned rooms.
  myRooms?: Array<{
    id: string;
    number: string;
    status: string;
    is_dnd: boolean;
    has_issue: boolean;
    help_requested: boolean;
  }>;
}

// 30-second in-process cache keyed by property+role. Hot path; avoids hitting
// the DB on every Enter keypress when the user fires a few quick messages.
type CacheKey = string;
const cache = new Map<CacheKey, { snapshot: HotelSnapshot; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

// In-flight dedup (audit/concurrency #11). Without it, two simultaneous
// agent turns for the same (property, role, staff) both miss the cache,
// both fire ~5 DB queries, and the second's write overwrites the first
// in the cache. Coalescing concurrent misses onto a single shared
// promise removes the stampede.
//
// Multi-instance SLA: each Vercel function instance has its own `cache`.
// Stale snapshots up to CACHE_TTL_MS=30s after a write are acceptable
// here because the agent's reply latency dominates user perception of
// "is this current" anyway, and the snapshot's primary downstream uses
// (room counts, today summary) tolerate brief staleness.
const inflight = new Map<CacheKey, Promise<HotelSnapshot>>();

function cacheKey(propertyId: string, role: AppRole, staffId: string | null): CacheKey {
  return `${propertyId}::${role}::${staffId ?? '-'}`;
}

/**
 * Build a fresh snapshot of the hotel. Pulls ~5 cheap queries from the DB.
 * If a query fails, the corresponding section is null-ish but the snapshot
 * still returns — the agent should be resilient to incomplete context.
 */
export async function buildHotelSnapshot(
  propertyId: string,
  role: AppRole,
  staffId: string | null = null,
): Promise<HotelSnapshot> {
  const key = cacheKey(propertyId, role, staffId);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.snapshot;
  }
  const existing = inflight.get(key);
  if (existing) return existing;

  const pending = buildHotelSnapshotUncached(propertyId, role, staffId, key)
    .finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

async function buildHotelSnapshotUncached(
  propertyId: string,
  role: AppRole,
  staffId: string | null,
  key: CacheKey,
): Promise<HotelSnapshot> {
  // Property name + timezone + total_rooms + room_inventory (cheap; one query).
  //
  // Round 14 (2026-05-14): room_inventory is the truth about how many rooms
  // a property has. Plan v4: live room status now flows into the pms_*
  // tables (written by the persistent CUA per hotel), surfaced here via the
  // today_property_counts_v1 RPC. Reading inventory length here means the
  // agent reports the correct total even when the PMS feed is mid-bootstrap;
  // rooms the feed doesn't know about yet surface as vacant (the safe
  // default — absence of data means no guest).
  //
  // A3 (2026-07-24): pms_type rides along on this same query — it is the
  // PMS-family key for the shared prompt tier, and adding it costs nothing
  // here versus a second round trip at prompt-build time. `property_sessions
  // .pms_family` is the CUA-era copy and is deliberately NOT read: it stopped
  // being written when intake moved to scheduled report emails.
  let propertyName: string | null = null;
  let timezone: string | null = null;
  let pmsFamily: PMSType | null = null;
  let configuredTotalRooms = 0;
  let inventoryLength = 0;
  try {
    const { data } = await supabaseAdmin
      .from('properties')
      .select('name, timezone, total_rooms, room_inventory, pms_type')
      .eq('id', propertyId)
      .maybeSingle();
    if (data) {
      propertyName = (data.name as string) ?? null;
      timezone = (data.timezone as string) ?? null;
      // Normalize through the guard so an unrecognized value degrades to
      // "no family tier" instead of minting a cache key nothing resolves.
      pmsFamily = isPMSType(data.pms_type) ? data.pms_type : null;
      configuredTotalRooms = Number(data.total_rooms ?? 0);
      const inv = data.room_inventory as string[] | null;
      inventoryLength = Array.isArray(inv) ? inv.length : 0;
    }
  } catch {
    // non-fatal — snapshot continues with nulls
  }

  // Plan v4: there is no `rooms.date` anymore. "Today" is the property's
  // local calendar date — mirrors the doctor's Intl.DateTimeFormat('en-CA',
  // { timeZone }) approach via the shared propertyLocalToday helper. UTC
  // today disagrees with the property's local date for ~5 hours every
  // evening in CST/CDT (where the pilot hotels live), so we must anchor on
  // the property timezone. Falls back to UTC today when timezone is null.
  const today = propertyLocalToday(new Date(), timezone);

  // Room summary — live PMS counts for `today` via today_property_counts_v1
  // (one RPC; the housekeeping Schedule tab + dashboard read the same).
  //
  // This is the hot path: buildHotelSnapshot runs on EVERY agent turn. We
  // deliberately use the count RPC here instead of mergePmsRoomsForDate
  // (which fires ~5 queries to build full Room rows) — counts are all the
  // snapshot needs, and one RPC keeps the per-turn cost ~50ms.
  //
  // 2026-05-14 history: the old `rooms`-table query had no date filter and
  // reported every historical day's rows as "today's rooms" (557 dirty for
  // a 100-room property). The RPC is inherently single-date (it takes the
  // date as a parameter), so that class of bug can't recur here.
  const rooms = {
    total: 0,
    dirty: 0,
    in_progress: 0,   // TODO(overlay): HK-workflow state, not in the PMS feed.
    clean: 0,
    dnd: 0,            // TODO(overlay): DND is an overlay-table flag.
    issuesFlagged: 0,  // TODO(overlay): issue notes live in the overlay table.
    helpRequested: 0,  // TODO(overlay): "help requested" lives in the overlay table.
    checkouts: 0,
    stayovers: 0,
    inHouse: 0,
    outOfOrder: 0,
    seedingGap: 0,
  };
  let pmsRoomCount = 0;
  try {
    const counts = await fetchTodayPropertyCounts(propertyId, today);
    // Map PMS-state counts onto the snapshot. The PMS feed reports room
    // states (vacant_clean / vacant_dirty / ooo / in_house) + reservation-
    // derived work (checkouts / stayovers) — NOT housekeeping-workflow
    // states (in_progress / dnd / issue / help), which come from the future
    // overlay table and stay 0 above.
    //   dirty = vacant-dirty + today's checkouts (rooms that still need a
    //           turn). Excludes OOO (blocked, not a turn).
    //   clean = vacant-clean (confirmed clean & ready).
    rooms.dirty = counts.vacant_dirty + counts.checkouts;
    rooms.clean = counts.vacant_clean;
    rooms.checkouts = counts.checkouts;
    rooms.stayovers = counts.stayovers;
    rooms.inHouse = counts.in_house;
    rooms.outOfOrder = counts.ooo;
    // pmsRoomCount = how many rooms the live feed has accounted for today.
    // Used only to compute the seeding gap against the configured total.
    pmsRoomCount =
      counts.vacant_clean + counts.vacant_dirty + counts.ooo + counts.in_house;
  } catch {
    // non-fatal — snapshot continues with zeroed room counts.
  }

  // Round 14: total comes from inventory when configured. Round 15 (Codex
  // finding A): also consider properties.total_rooms — take the max of the
  // three signals so a stale or empty inventory can't silently under-report.
  // Third signal is now the live PMS room count (was the seeded `rooms` row
  // count). The doctor check fails loud when inventory and total_rooms
  // disagree (INV-24).
  const totalDerived = computeRoomTotal(inventoryLength, configuredTotalRooms, pmsRoomCount);
  rooms.total = totalDerived.total;
  rooms.seedingGap = totalDerived.seedingGap;

  // Sanity check: the live feed shouldn't account for more rooms than the
  // configured property size (which the manager set at onboarding). If it
  // does, the PMS feed is double-counting somewhere — log loudly so we can
  // spot it before the agent reports inflated numbers to a user.
  if (configuredTotalRooms > 0 && pmsRoomCount > configuredTotalRooms) {
    console.warn(
      `[agent/context] pmsRoomCount=${pmsRoomCount} exceeds properties.total_rooms=${configuredTotalRooms} ` +
      `for property=${propertyId} date=${today} — possible PMS feed double-count`,
    );
  }

  // Active staff (today). is_active=true; the housekeeper public-link flow
  // doesn't reliably check-in/check-out so we use is_active as a proxy.
  let activeToday = 0;
  let assignedHousekeepers = 0;
  try {
    const { data } = await supabaseAdmin
      .from('staff')
      // `department`, NOT `role`: the staff table has never had a `role`
      // column (roles live on `accounts`). PostgREST answered this select with
      // "column staff.role does not exist", the catch below swallowed it, and
      // every snapshot silently reported 0 active staff and 0 housekeepers.
      // Found 2026-07-25 by the pglite tenant-isolation harness, which runs
      // these queries against the real migrated schema.
      .select('id, department, is_active')
      .eq('property_id', propertyId)
      .eq('is_active', true);
    if (data) {
      activeToday = data.length;
      assignedHousekeepers = data.filter(
        s => (s.department as string)?.toLowerCase().includes('housekeep'),
      ).length;
    }
  } catch {
    // non-fatal
  }

  // For housekeeping role, also include their assigned rooms so they can ask
  // "what's next" without an extra tool call. Plan v4: pull the live merged
  // Room[] for today from the pms_* feeds and filter to this housekeeper.
  // mergePmsRoomsForDate resolves assignedTo by collision-aware name match
  // (pms_housekeeping_assignments.housekeeper_name → staff.id), so filtering
  // on assignedTo === staffId gives exactly this person's rooms for today.
  let myRooms: HotelSnapshot['myRooms'] | undefined;
  if (role === 'housekeeping' && staffId) {
    try {
      const merged = await mergePmsRoomsForDate(propertyId, today);
      const mine = merged
        .filter(r => r.assignedTo === staffId)
        .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
      myRooms = mine.map(r => ({
        id: r.id,
        number: r.number,
        status: r.status,
        is_dnd: !!r.isDnd,
        // TODO(overlay): has_issue (issueNote) + help_requested live in the
        // future overlay table; the merged Room doesn't carry them yet, so
        // they're always false here (they were empty on the legacy `rooms`
        // table too — behaviour-preserving).
        has_issue: !!r.issueNote,
        help_requested: !!r.helpRequested,
      }));
    } catch {
      // non-fatal
    }
  }

  // feat/cua-partial-promotion — which PMS feeds are still being learned.
  // Cheap (its own 30s cache) and fail-safe: errors yield "no caveat",
  // which is exactly today's behavior.
  let pmsLearningFeeds: string[] | undefined;
  let pmsCountsUnavailable = false;
  let pmsConnectionPending = false;
  // A2 — capture time. Only ever set for mode==='live'; its presence is what
  // tells formatSnapshotForPrompt this hotel gets an as-of line at all.
  let pmsDataSource: FreshnessSource | undefined;
  let pmsDataCapturedAt: string | null = null;
  try {
    const fs = await getPropertyFeedStatus(propertyId);
    if (fs.mode === 'live') {
      const learning = learningFeeds(fs);
      if (learning.length > 0) pmsLearningFeeds = learning;
      pmsCountsUnavailable = !countsTrusted(fs);
      pmsConnectionPending = isDataPending(fs);
      // Same cached object — zero extra queries.
      pmsDataSource = fs.freshness?.source ?? 'none';
      pmsDataCapturedAt = fs.freshness?.capturedAt ?? null;
    }
  } catch {
    // non-fatal
  }

  const snapshot: HotelSnapshot = {
    today,
    property: { id: propertyId, name: propertyName, timezone, pmsFamily },
    rooms,
    staff: { activeToday, assignedHousekeepers },
    ...(myRooms ? { myRooms } : {}),
    ...(pmsLearningFeeds ? { pmsLearningFeeds } : {}),
    ...(pmsCountsUnavailable ? { pmsCountsUnavailable: true } : {}),
    ...(pmsConnectionPending ? { pmsConnectionPending: true } : {}),
    ...(pmsDataSource ? { pmsDataSource, pmsDataCapturedAt } : {}),
  };

  cache.set(key, { snapshot, expiresAt: Date.now() + CACHE_TTL_MS });
  return snapshot;
}

/** Format the snapshot as a compact string the system prompt can embed.
 *
 * Codex adversarial review 2026-05-13 (A-C2): wrap the snapshot in
 * trust-boundary tags. Anything that flows from the database (including
 * fields ultimately derived from PMS imports or staff/guest input) is
 * marked `trust="system"` here — we trust this source today. Tool results
 * (handled in llm.ts) are wrapped `trust="untrusted"` because they can
 * include user-provided text (issue_note, help message) that a prior
 * housekeeper might have crafted to coerce a future model turn.
 *
 * Codex round-7 fix F4, 2026-05-13: escape XML metacharacters in every
 * interpolated dynamic field so a property/room/staff value containing
 * literal "</staxis-snapshot>" can't close the trust boundary and inject
 * "trusted" instructions into the system block. Same defense applied to
 * tool_result wrap in llm.ts. property.name + room.number are the most
 * realistic vectors today; staff names + issue_note arrive here via
 * future snapshot extensions.
 */
function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * A2 — the single data-age line, or null when this hotel must not get one.
 *
 * Suppressed for:
 *   • manual (no_pms) and onboarding hotels — `pmsDataSource` is undefined for
 *     them. Warning a manual hotel that its own numbers might be stale is the
 *     exact opposite of honesty: the app IS its system of record.
 *   • a live-PMS hotel whose first sync hasn't landed — the existing
 *     pmsConnectionPending CAUTION already says something stronger.
 *
 * The age is computed from `now` at RENDER time (not stored on the snapshot),
 * so the 30s snapshot cache can never serve a frozen "22 min ago".
 */
function asOfLine(snap: HotelSnapshot, now: Date): string | null {
  if (!snap.pmsDataSource) return null;
  if (snap.pmsConnectionPending) return null;

  const unknown =
    'PMS data age unknown — this hotel\'s feed carries no capture time. ' +
    'Do NOT state the room, occupancy or reservation numbers below as current; ' +
    'say you can\'t tell how old they are.';

  const capturedAt = snap.pmsDataCapturedAt ?? null;
  const tier = freshnessTier(capturedAt, snap.pmsDataSource, now);
  if (tier === 'unknown' || !capturedAt) return unknown;

  const clock = formatAsOfClock(capturedAt, snap.property.timezone, now);
  if (!clock) return unknown;

  const at = esc(clock.time);
  const stamp = `${at} (${esc(clock.zone)})`;
  const age = esc(clock.age);

  switch (tier) {
    case 'fresh':
      return (
        `PMS data as of ${stamp}, ${age} — the room, occupancy and reservation ` +
        'numbers below describe that moment.'
      );
    case 'stale':
      return (
        `PMS data as of ${stamp}, ${age}. CAUTION: that is older than one report cycle. ` +
        `The room, occupancy and reservation numbers below are from ${at}, not now — ` +
        'say the as-of time whenever you use them.'
      );
    case 'very_stale':
      return (
        `PMS data as of ${stamp}, ${age}. CAUTION: this hotel's PMS reports have not ` +
        `arrived in over ${PMS_STALE_MAX_MINUTES / 60} hours. Do NOT state the room, ` +
        'occupancy or reservation numbers below as the current situation — say the last ' +
        `update landed at ${at} and the connection looks stuck.`
      );
    case 'change_only':
      return (
        `PMS data last CHANGED at ${stamp}, ${age}; this hotel's connection does not ` +
        'report when it last checked, so the numbers below may be newer. Give ' +
        `${at} as the as-of time and don't claim they are live.`
      );
  }
}

export function formatSnapshotForPrompt(snap: HotelSnapshot, now: Date = new Date()): string {
  const lines: string[] = [];
  lines.push('<staxis-snapshot trust="system">');
  lines.push(`Today: ${esc(snap.today)}`);
  lines.push(
    `Property: ${esc(snap.property.name ?? 'Unnamed')} (${esc(snap.property.id)})` +
    (snap.property.timezone ? `, timezone ${esc(snap.property.timezone)}` : ''),
  );
  const asOf = asOfLine(snap, now);
  if (asOf) lines.push(asOf);
  // PMS-state counts from the live pms_* feed. dirty/clean/checkouts/
  // stayovers/in-house/OOO are real; in_progress/DND/issue/help are
  // overlay-table workflow fields that stay 0 until that table lands —
  // only render them when non-zero so the line auto-upgrades later without
  // misleading the agent with hard-coded zeros today.
  lines.push(
    `Rooms: ${snap.rooms.total} total — ${snap.rooms.dirty} dirty, ` +
    `${snap.rooms.clean} clean, ${snap.rooms.inHouse} occupied, ` +
    `${snap.rooms.checkouts} checking out today, ${snap.rooms.stayovers} stayover` +
    (snap.rooms.outOfOrder ? `, ${snap.rooms.outOfOrder} out of order` : '') +
    (snap.rooms.in_progress ? `, ${snap.rooms.in_progress} in progress` : '') +
    (snap.rooms.dnd ? `, ${snap.rooms.dnd} DND` : '') +
    (snap.rooms.issuesFlagged ? `, ${snap.rooms.issuesFlagged} with issue notes` : '') +
    (snap.rooms.helpRequested ? `, ${snap.rooms.helpRequested} requesting help` : ''),
  );
  if (snap.pmsConnectionPending) {
    // First sync hasn't landed: every pms-derived number above is an
    // empty-table zero. Strongest caveat; subsumes the per-feed ones.
    lines.push(
      'CAUTION: this hotel\'s PMS connection has not completed its first sync. ' +
      'ALL room/reservation/occupancy counts above are unreliable empty-table zeros. ' +
      'Do NOT state any of them as fact — say the PMS connection is still syncing.',
    );
  } else {
    if (snap.pmsLearningFeeds?.length) {
      // feat/cua-partial-promotion — the single most important honesty rule
      // for the chat copilot: a zero that comes from a missing feed is
      // not a fact about the hotel. Name the feeds and forbid zero-claims.
      const names: Record<string, string> = {
        roomStatus: 'room statuses',
        arrivals: 'arrivals',
        departures: 'departures',
        workOrders: 'PMS work orders',
        dashboardCounts: 'occupancy counts',
      };
      const list = snap.pmsLearningFeeds.map((f) => names[f] ?? f).join(', ');
      lines.push(
        `CAUTION: this hotel's PMS connection is still learning these feeds: ${list}. ` +
        `Counts derived from them above may read 0 because the data is missing, not because nothing is happening. ` +
        `Do NOT state zero ${list} as fact — say that data is still syncing from the hotel's PMS instead.`,
      );
    }
    if (snap.pmsCountsUnavailable) {
      // Review pass (fake-empty hunter #5) — the occupancy snapshot feed is
      // outside the learnable catalogue for most PMS connections, so the
      // clean/occupied/in-house numbers above are permanent COALESCE-0s,
      // not facts. Not "learning" — it may never arrive.
      lines.push(
        'CAUTION: this PMS connection does not provide occupancy snapshot counts. ' +
        'The clean / occupied / in-house numbers above may read 0 because the source is absent. ' +
        'Do NOT state them as fact — if asked about occupancy, say that count isn\'t available from this hotel\'s PMS connection.',
      );
    }
  }
  if (snap.rooms.seedingGap > 0) {
    // The agent needs to know it's looking at a partial picture so it
    // doesn't claim "100% occupancy" or "all rooms occupied" when the live
    // PMS feed simply hasn't accounted for some rooms yet.
    const seeded = snap.rooms.total - snap.rooms.seedingGap;
    lines.push(
      `Heads-up: the live PMS feed has accounted for ${seeded} of ${snap.rooms.total} rooms; ` +
      `the missing ${snap.rooms.seedingGap} are reported as vacant.`,
    );
  }
  lines.push(
    `Staff active today: ${snap.staff.activeToday} ` +
    `(${snap.staff.assignedHousekeepers} housekeepers)`,
  );
  if (snap.myRooms?.length) {
    lines.push(`Your ${snap.myRooms.length} assigned rooms:`);
    for (const r of snap.myRooms) {
      const flags: string[] = [];
      if (r.is_dnd) flags.push('DND');
      if (r.has_issue) flags.push('issue');
      if (r.help_requested) flags.push('help-pending');
      lines.push(
        `  • Room ${esc(r.number)} — ${esc(r.status)}` +
        (flags.length ? ` [${flags.join(', ')}]` : ''),
      );
    }
  }
  lines.push('</staxis-snapshot>');
  return lines.join('\n');
}
