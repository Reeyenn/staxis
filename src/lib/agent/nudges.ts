// ─── Proactive nudge engine ───────────────────────────────────────────────
// Runs on Vercel Cron every 5 min. For each property, checks the 4
// categories of trigger conditions (operational, daily summary, inventory,
// revenue/occupancy) and inserts agent_nudges rows when conditions met.
//
// dedupe_key prevents the same condition from generating duplicate nudges
// while still in 'pending' state (unique partial index in migration 0079).
//
// V1 scope: implement operational alerts + daily summary fully. Inventory
// and revenue anomalies are scaffolded but return early when data isn't
// available — we don't want to fabricate alerts.
//
// DATA-AGE CONTRACT (A2, 2026-07-24): room state arrives in scheduled PMS
// reports, so "how long has this room been in progress?" is measured against
// the report's CAPTURE time, never the wall clock — otherwise a room whose
// report lands 60 minutes late looks 60 minutes more overdue than it is and
// the manager gets a false alarm. When the feed itself is older than one
// report cycle the whole run is suppressed: a push notification computed from
// stale data is worse than none (the correct alert during an ingestion outage
// is "reports stopped arriving", which the ingestion layer owns).

import { supabaseAdmin } from '@/lib/supabase-admin';
import { mergePmsRoomsForDate } from '@/lib/pms-rooms-server';
import { fetchTodayPropertyCounts } from '@/lib/db/today-room-work';
import { getPropertyFeedStatus } from '@/lib/pms-feed-status-server';
import { countsFresh, formatAsOfClock, freshnessTier } from '@/lib/pms/feed-status';
import { propertyLocalToday } from '@/lib/schedule/local-date';

export interface NudgeRunResult {
  propertyId: string;
  nudgesInserted: number;
  skipped: number;
  errors: string[];
}

/** Run all nudge checks for a single property. */
export async function runNudgeChecksForProperty(propertyId: string): Promise<NudgeRunResult> {
  const result: NudgeRunResult = {
    propertyId,
    nudgesInserted: 0,
    skipped: 0,
    errors: [],
  };

  // Resolve the property's owner / managers — they receive the nudges.
  const recipients = await getNudgeRecipients(propertyId);
  if (recipients.length === 0) {
    result.skipped += 1;
    return result;
  }

  // 1. Operational alerts
  try {
    const ops = await checkOperationalAlerts(propertyId);
    for (const nudge of ops) {
      for (const userId of recipients) {
        const inserted = await insertNudgeIfNew({
          userId,
          propertyId,
          category: 'operational',
          severity: nudge.severity,
          payload: nudge.payload,
          dedupeKey: nudge.dedupeKey,
        });
        if (inserted) result.nudgesInserted += 1;
        else result.skipped += 1;
      }
    }
  } catch (e) {
    result.errors.push(`operational: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. Daily summary — only fires once per day per property, gated by time.
  try {
    if (await shouldFireDailySummary(propertyId)) {
      const summary = await buildDailySummary(propertyId);
      // dedupe_key MUST be property-scoped: the unique partial index is on
      // (user_id, category, dedupe_key) with NO property_id, and a single
      // owner/GM account can be a recipient for multiple properties. Without
      // the propertyId here, the second property's daily summary collides on
      // the same key and is swallowed as a 23505 duplicate.
      const dedupeKey = `daily_summary:${propertyId}:${new Date().toISOString().slice(0, 10)}`;
      for (const userId of recipients) {
        const inserted = await insertNudgeIfNew({
          userId,
          propertyId,
          category: 'daily_summary',
          severity: 'info',
          payload: summary,
          dedupeKey,
        });
        if (inserted) result.nudgesInserted += 1;
        else result.skipped += 1;
      }
    }
  } catch (e) {
    result.errors.push(`daily_summary: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3. Inventory — scaffolded, returns empty when no inventory data
  try {
    const inv = await checkInventory(propertyId);
    for (const nudge of inv) {
      for (const userId of recipients) {
        const inserted = await insertNudgeIfNew({
          userId,
          propertyId,
          category: 'inventory',
          severity: nudge.severity,
          payload: nudge.payload,
          dedupeKey: nudge.dedupeKey,
        });
        if (inserted) result.nudgesInserted += 1;
        else result.skipped += 1;
      }
    }
  } catch (e) {
    result.errors.push(`inventory: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 4. Revenue / occupancy anomalies — scaffolded, returns empty for v1
  try {
    const anomalies = await checkRevenueOccupancy(propertyId);
    for (const nudge of anomalies) {
      for (const userId of recipients) {
        const inserted = await insertNudgeIfNew({
          userId,
          propertyId,
          category: 'revenue_occupancy',
          severity: nudge.severity,
          payload: nudge.payload,
          dedupeKey: nudge.dedupeKey,
        });
        if (inserted) result.nudgesInserted += 1;
        else result.skipped += 1;
      }
    }
  } catch (e) {
    result.errors.push(`revenue_occupancy: ${e instanceof Error ? e.message : String(e)}`);
  }

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

interface NudgeDraft {
  severity: 'info' | 'warning' | 'urgent';
  payload: Record<string, unknown>;
  dedupeKey: string;
}

/** The slice of a merged Room the operational checks actually read. Narrow on
 *  purpose so the pure draft builders can be exercised without a live merge. */
export interface NudgeRoomInput {
  /** Composite "${date}:${room_number}" — stable per day, used for dedupe. */
  id: string;
  number: string;
  status: string;
  startedAt?: Date | string | null;
  assignedName?: string | null;
  helpRequested?: boolean;
}

/** How long a room may sit in progress before it's worth a look. Measured in
 *  OBSERVED minutes (capture time − start time), not elapsed wall time. */
export const OVERDUE_ROOM_MINUTES = 90;

function toMillis(v: Date | string | null | undefined): number | null {
  if (!v) return null;
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Find the accounts that should receive nudges for a property.
 *
 * Codex adversarial review 2026-05-13 (A-H9): the prior version included
 * any account whose property_access contained '*' (wildcard) — i.e. admins
 * received every property's nudges × every category × every 5-min cron tick.
 * With one admin (Reeyen) it's a few extra rows; the first support hire
 * would receive ~144,000 nudges/day at 50 properties.
 *
 * New policy:
 *   1. Check properties.nudge_subscription (migration 0088) for an explicit
 *      override. enabled=false → send to nobody. recipient_account_ids set →
 *      send to those accounts.
 *   2. Otherwise fall back to owners + general_managers whose property_access
 *      INCLUDES this propertyId. Wildcard '*' (admins) is intentionally NOT
 *      a fallback — admins use a dedicated admin view, not the cron fan-out.
 *
 * Exported so tool handlers (e.g. request_help in room-actions.ts) can route
 * user-driven nudges to the right inbox without duplicating this logic. */
export async function getNudgeRecipients(propertyId: string): Promise<string[]> {
  // 1. Per-property override.
  const { data: prop } = await supabaseAdmin
    .from('properties')
    .select('nudge_subscription')
    .eq('id', propertyId)
    .maybeSingle();
  const sub = (prop?.nudge_subscription as { enabled?: boolean; recipient_account_ids?: string[] } | null) ?? null;
  if (sub) {
    if (sub.enabled === false) return [];
    if (Array.isArray(sub.recipient_account_ids) && sub.recipient_account_ids.length > 0) {
      // Codex post-merge review 2026-05-13 (N3 + B.5): defense-in-depth
      // against cross-tenant nudge exfiltration. The DB trigger from
      // migration 0095 is the durable guard, but stale state (raw SQL,
      // pre-trigger data) could let invalid UUIDs slip through. Validate
      // here too: every recipient must have role='admin' OR property_access
      // (uuid[]) containing this propertyId.
      const { data: validated } = await supabaseAdmin
        .from('accounts')
        .select('id, role, property_access')
        .in('id', sub.recipient_account_ids);
      return (validated ?? [])
        .filter(a => {
          if (a.role === 'admin') return true;
          const access = (a.property_access as string[]) ?? [];
          return access.includes(propertyId);
        })
        .map(a => a.id as string);
    }
  }

  // 2. Default: owners + GMs whose property_access INCLUDES this propertyId.
  //    No wildcard match.
  const { data } = await supabaseAdmin
    .from('accounts')
    .select('id, role, property_access')
    .in('role', ['owner', 'general_manager']);
  if (!data) return [];
  return data
    .filter(a => {
      const access = (a.property_access as string[]) ?? [];
      return access.includes(propertyId);
    })
    .map(a => a.id as string);
}

/** Insert nudge unless a pending one with the same (user, category, dedupe_key) exists. */
async function insertNudgeIfNew(opts: {
  userId: string;
  propertyId: string;
  category: string;
  severity: 'info' | 'warning' | 'urgent';
  payload: Record<string, unknown>;
  dedupeKey: string;
}): Promise<boolean> {
  const { error } = await supabaseAdmin.from('agent_nudges').insert({
    user_id: opts.userId,
    property_id: opts.propertyId,
    category: opts.category,
    severity: opts.severity,
    payload: opts.payload,
    dedupe_key: opts.dedupeKey,
  });
  if (error) {
    // 23505 = unique violation (the partial index caught a duplicate). Expected, swallow.
    if ((error as { code?: string }).code === '23505') return false;
    console.error('[nudges] insert failed', error);
    return false;
  }
  return true;
}

// ─── 1. Operational alerts ────────────────────────────────────────────────

/**
 * Rooms that have been in progress too long — measured on the DATA's clock.
 *
 * `capturedAt` is the moment the room states were read. Elapsed time is
 * `capturedAt − startedAt` (OBSERVED elapsed), not `now − startedAt`: the
 * report tells us the room was still in progress AT capture, and nothing
 * since. The 90-minute threshold is unchanged — only the reference frame is.
 * A room reported an hour late used to look an hour more overdue than it was;
 * that false-alarm class is the whole point of this function.
 *
 * `capturedAt === null` means the hotel has no PMS capture time (a manual
 * hotel, where Staxis IS the system of record) — those numbers really are
 * live, so `now` is the correct reference and behaviour is unchanged.
 *
 * Pure, with both clocks injected: there is no ambient `Date.now()` in here
 * for a future edit to reach for.
 */
export function overdueRoomDrafts(
  rooms: NudgeRoomInput[],
  propertyId: string,
  capturedAt: Date | null,
  now: Date,
  asOfLabel: string | null = null,
): NudgeDraft[] {
  const drafts: NudgeDraft[] = [];
  const reference = (capturedAt ?? now).getTime();
  for (const r of rooms) {
    if (r.status !== 'in_progress') continue;
    const startedTime = toMillis(r.startedAt);
    if (startedTime === null) continue;
    const observedMinutes = Math.round((reference - startedTime) / 60_000);
    if (observedMinutes < OVERDUE_ROOM_MINUTES) continue;
    // assignedName comes through the merge (housekeeper_name on the
    // assignment); no extra staff lookup needed.
    const staffName = r.assignedName ?? null;
    const who = staffName ? ` (${staffName})` : '';
    const summary = asOfLabel
      ? `Room ${r.number} had been in progress for ${observedMinutes} min as of ${asOfLabel}${who} — usually takes ~25 min, worth checking in.`
      : `Room ${r.number} has been in progress for ${observedMinutes} min${who}. Usually takes ~25 min — worth checking in.`;
    drafts.push({
      severity: 'warning',
      payload: {
        summary,
        type: 'overdue_room',
        roomNumber: r.number,
        staffName,
        minutesElapsed: observedMinutes,
        ...(capturedAt ? { asOf: capturedAt.toISOString() } : {}),
      },
      // r.id is the composite "${date}:${room_number}" — stable per day,
      // so the dedupe key behaves the same as the old per-room-row id.
      // Property-scoped so two properties sharing a room number (e.g. "302")
      // on the same date don't collide on the (user, category, dedupe_key)
      // unique index for a multi-property owner.
      dedupeKey: `overdue_room:${propertyId}:${r.id}`,
    });
  }
  return drafts;
}

/**
 * Unresolved help requests.
 *
 * The old 5-minute wall-clock window is gone: against a 30-60 minute report
 * cadence any help request that shows up in a report is ALREADY older than
 * the report lag, so the window only ever suppressed the first cycle's worth
 * of genuine requests. Per-day dedupe (the composite room id) is what keeps
 * this from repeating.
 *
 * TODO(overlay): `helpRequested` is a housekeeper-set workflow field with no
 * pms_* home yet — the merge shape never sets it, so this branch is dormant
 * today. It stays here so the overlay lands into a correct clock, not a
 * wall-clock one.
 */
export function unresolvedHelpDrafts(
  rooms: NudgeRoomInput[],
  propertyId: string,
  capturedAt: Date | null,
  now: Date,
  asOfLabel: string | null = null,
): NudgeDraft[] {
  const drafts: NudgeDraft[] = [];
  const reference = (capturedAt ?? now).getTime();
  for (const r of rooms) {
    if (!r.helpRequested) continue;
    // startedAt is the proxy for "when did help get raised"; when it's absent
    // we still raise the alert (a pending request is urgent regardless) and
    // simply omit the elapsed time rather than inventing one.
    const startedTime = toMillis(r.startedAt);
    const observedMinutes =
      startedTime === null ? null : Math.max(0, Math.round((reference - startedTime) / 60_000));
    const when = observedMinutes === null ? '' : ` ${observedMinutes} min ago`;
    const asOf = asOfLabel ? ` (as of ${asOfLabel})` : '';
    drafts.push({
      severity: 'urgent',
      payload: {
        summary: `Help requested for room ${r.number}${when}${asOf} — nobody has responded yet.`,
        type: 'unresolved_help',
        roomNumber: r.number,
        minutesAgo: observedMinutes,
        ...(capturedAt ? { asOf: capturedAt.toISOString() } : {}),
      },
      dedupeKey: `unresolved_help:${propertyId}:${r.id}`,
    });
  }
  return drafts;
}

/** Exported for `agent-nudge-data-clock.test.ts`, which pins the run-level
 *  staleness guard (a stale feed must not even look at room state). */
export async function checkOperationalAlerts(propertyId: string): Promise<NudgeDraft[]> {
  const now = new Date();

  // Plan v4: the legacy `rooms` table was dropped (migration 0204). Live room
  // status now flows into the pms_* tables, surfaced via the per-(property,
  // date) merge below (Room[] in the legacy camel-cased shape). Resolve the
  // property's local "today" the way the doctor does (Intl tz-aware) since
  // there is no rooms.date anymore.
  const { today: date, timezone } = await getPropertyDay(propertyId);

  // A2 run-level guard. Only live-PMS hotels have a data age at all; for a
  // manual hotel `capturedAt` stays null and the checks run on the wall clock
  // exactly as before.
  let capturedAt: Date | null = null;
  let asOfLabel: string | null = null;
  try {
    const fs = await getPropertyFeedStatus(propertyId);
    if (fs.mode === 'live') {
      const tier = freshnessTier(fs.freshness?.capturedAt, fs.freshness?.source ?? 'none', now);
      // Older than one report cycle (PMS_FRESH_MAX_MINUTES), or age unknown
      // ⇒ every room-level conclusion is a guess. Say nothing rather than
      // push a false alarm.
      if (tier === 'stale' || tier === 'very_stale' || tier === 'unknown') return [];
      const iso = fs.freshness?.capturedAt ?? null;
      if (iso) {
        const at = new Date(iso);
        if (!Number.isNaN(at.getTime())) {
          capturedAt = at;
          asOfLabel = formatAsOfClock(iso, timezone, now)?.time ?? null;
        }
      }
      // 'change_only' does NOT suppress — absence of change is not evidence
      // of staleness — but it does force the as-of wording above.
    }
  } catch {
    // Fail-safe: a status lookup hiccup must not silence real alerts.
  }

  const rooms = await mergePmsRoomsForDate(propertyId, date);
  return [
    ...overdueRoomDrafts(rooms, propertyId, capturedAt, now, asOfLabel),
    ...unresolvedHelpDrafts(rooms, propertyId, capturedAt, now, asOfLabel),
  ];
}

// ─── 2. Daily summary ─────────────────────────────────────────────────────

/**
 * Fires once per property between 8pm and 9pm local time. v1: uses UTC for
 * the time check since most properties don't have timezone set. A future
 * pass should respect properties.timezone properly.
 */
async function shouldFireDailySummary(propertyId: string): Promise<boolean> {
  // V1 simplification: fire if it's currently 8pm-9pm in the property's
  // local time. If timezone isn't set, use server local time as a fallback.
  const { data } = await supabaseAdmin
    .from('properties')
    .select('timezone')
    .eq('id', propertyId)
    .maybeSingle();
  const tz = (data?.timezone as string) ?? null;

  let hour: number;
  try {
    if (tz) {
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false });
      hour = parseInt(fmt.format(new Date()), 10);
    } else {
      hour = new Date().getHours();
    }
  } catch {
    hour = new Date().getHours();
  }

  // Only check once during the 8pm hour. dedupe_key on date prevents repeats.
  return hour === 20;
}

/** The property's local "today" as YYYY-MM-DD.
 *
 * Plan v4 dropped `rooms` (and with it the `rooms.date` column that used to
 * define "current rooms date"). Room data now lives in the pms_* tables keyed
 * by an explicit date. We mirror the doctor's Intl.DateTimeFormat approach via
 * the shared `propertyLocalToday` helper: format `now` in the property's IANA
 * timezone, falling back to UTC when timezone is null/invalid. */
async function getPropertyDay(
  propertyId: string,
): Promise<{ today: string; timezone: string | null }> {
  const { data } = await supabaseAdmin
    .from('properties')
    .select('timezone')
    .eq('id', propertyId)
    .maybeSingle();
  const tz = (data?.timezone as string) ?? null;
  return { today: propertyLocalToday(new Date(), tz), timezone: tz };
}

async function getPropertyToday(propertyId: string): Promise<string> {
  return (await getPropertyDay(propertyId)).today;
}

async function buildDailySummary(propertyId: string): Promise<Record<string, unknown>> {
  const today = await getPropertyToday(propertyId);

  // Room-state counts: pull from the today_property_counts_v1 RPC, NOT the
  // 5-query pms_* merge. The RPC is the cheaper count source (single
  // SECURITY-DEFINER call over pms_in_house_snapshot + pms_reservations +
  // pms_rooms_inventory) and is the canonical occupancy/clean/dirty/ooo feed.
  // This is a per-property cron path, so the count RPC is the right tool.
  //   clean  ← vacant_clean   (rooms clean and ready, from the in-house snapshot)
  //   dirty  ← vacant_dirty   (rooms still needing a turn)
  const counts = await fetchTodayPropertyCounts(propertyId, today);
  // Review pass (fake-empty hunter #6) — vacant_clean/vacant_dirty are
  // snapshot-COALESCE-0s when the counts feed has no source; a daily
  // "0 rooms cleaned, 0 dirty remaining" summary would be a confident wrong
  // claim written every day. Null + note instead. Fail-safe: error → as-is.
  // D4 (2026-07-24): countsFresh, not countsTrusted. A NUDGE speaks first —
  // nobody asked, and nobody sees an as-of stamp on a push. Summarising
  // "0 rooms cleaned" off a room-status report that last arrived nine hours
  // ago is worse than sending nothing. (Answering a direct question is a
  // different bargain: there countsTrusted plus the stamp is right, which is
  // why the agent tools keep countsTrusted.)
  let countsOk = true;
  try {
    countsOk = countsFresh(await getPropertyFeedStatus(propertyId));
  } catch { /* non-fatal */ }
  const clean = countsOk ? counts.vacant_clean : null;
  const dirty = countsOk ? counts.vacant_dirty : null;

  // TODO(overlay): in-progress, DND, and flagged-issue counts have no pms_*
  // home. The legacy `rooms` table carried per-room `status='in_progress'`,
  // `is_dnd`, and `issue_note` (housekeeper-set workflow fields). Those land
  // in a future overlay table; until then report 0 rather than fabricate.
  // In prod the legacy `rooms` table is empty (0 rows), so these were already
  // 0 — behaviour-preserving. The in-house snapshot does NOT expose a separate
  // in-progress or DND bucket, so we do not derive them from the merge either.
  const inProgress = 0;
  const dnd = 0;
  const issues = 0;

  // cleaning_events stays UNCHANGED — it's the labor-audit source of truth and
  // is independent of the pms_* migration.
  const { data: events } = await supabaseAdmin
    .from('cleaning_events')
    .select('staff_id, duration_minutes')
    .eq('property_id', propertyId)
    .eq('date', today)
    .neq('status', 'discarded');

  const totalLabor = (events ?? []).reduce((acc, e) => acc + Number(e.duration_minutes ?? 0), 0);
  const uniqueStaff = new Set((events ?? []).map(e => e.staff_id)).size;

  // When the occupancy feed is untrusted, clean/dirty are null (never zero).
  // Don't interpolate null into the sentence — the labor figures still come
  // from cleaning_events and are valid, so report those and flag the counts
  // as unavailable instead of writing the literal word "null".
  const hours = Math.round((totalLabor / 60) * 10) / 10;
  const summaryText = clean === null
    ? `Today: ${uniqueStaff} housekeeper${uniqueStaff === 1 ? '' : 's'} logged ${hours}h of cleaning. Room counts unavailable — the PMS occupancy feed isn't synced for this hotel.`
    : `Today: ${clean} rooms cleaned by ${uniqueStaff} housekeepers (${hours}h total). ${dirty} dirty rooms remaining, ${issues} flagged issues.`;

  return {
    summary: summaryText,
    type: 'daily_summary',
    date: today,
    roomsCleaned: clean,
    roomsRemaining: dirty !== null ? dirty + inProgress : null,
    dnd,
    issues,
    laborMinutes: Math.round(totalLabor),
    uniqueStaff,
    ...(clean === null
      ? { pmsDataNote: 'room counts unavailable — PMS occupancy feed not provided/synced for this hotel; null is not zero' }
      : {}),
  };
}

// ─── 3. Inventory ─────────────────────────────────────────────────────────

async function checkInventory(propertyId: string): Promise<NudgeDraft[]> {
  const drafts: NudgeDraft[] = [];
  // Codex adversarial review 2026-05-13 (A-C8 / Codex F4): the prior version
  // queried `inventory_items` (doesn't exist) with field `reorder_threshold`
  // (also doesn't exist). Real table is `inventory` with `current_stock` and
  // `reorder_at` (per supabase/migrations/0001_initial_schema.sql:285-301).
  // The wrong-table query silently returned empty and low-stock nudges
  // NEVER fired despite real data.
  const { data, error } = await supabaseAdmin
    .from('inventory')
    .select('name, category, current_stock, reorder_at, unit')
    .eq('property_id', propertyId)
    .is('archived_at', null);
  if (error) {
    // Surface schema errors loudly so we notice if the table changes again.
    console.error('[nudges] inventory query failed', error);
    throw new Error(`inventory query failed: ${error.message}`);
  }
  if (!data?.length) return drafts;

  const below = data.filter(
    i => Number(i.current_stock ?? 0) < Number(i.reorder_at ?? 0),
  );
  if (below.length > 0) {
    drafts.push({
      severity: 'warning',
      payload: {
        summary: `${below.length} inventory item${below.length === 1 ? '' : 's'} below reorder threshold: ${below.slice(0, 3).map(i => i.name).join(', ')}${below.length > 3 ? '…' : ''}`,
        type: 'inventory_low',
        items: below.map(i => ({
          name: i.name,
          category: i.category,
          current: Number(i.current_stock ?? 0),
          threshold: Number(i.reorder_at ?? 0),
          unit: i.unit ?? null,
        })),
      },
      dedupeKey: `inventory_low:${propertyId}:${new Date().toISOString().slice(0, 10)}`,
    });
  }
  return drafts;
}

// ─── 4. Revenue / occupancy anomalies ─────────────────────────────────────

async function checkRevenueOccupancy(_propertyId: string): Promise<NudgeDraft[]> {
  // V1: revenue data pipeline isn't wired up. Return empty rather than
  // fabricate alerts. When the pipeline lands, this is where the comparison
  // against the rolling-4-week average belongs.
  return [];
}
