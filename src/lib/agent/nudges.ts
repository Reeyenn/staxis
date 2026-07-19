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

import { supabaseAdmin } from '@/lib/supabase-admin';
import { mergePmsRoomsForDate } from '@/lib/pms-rooms-server';
import { fetchTodayPropertyCounts } from '@/lib/db/today-room-work';
import { getPropertyFeedStatus } from '@/lib/pms-feed-status-server';
import { countsTrusted } from '@/lib/pms/feed-status';
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
      const dedupeKey = `daily_summary:${new Date().toISOString().slice(0, 10)}`;
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

async function checkOperationalAlerts(propertyId: string): Promise<NudgeDraft[]> {
  const drafts: NudgeDraft[] = [];

  // Plan v4: the legacy `rooms` table was dropped (migration 0204). Live room
  // status now flows into the pms_* tables, surfaced via the per-(property,
  // date) merge below (Room[] in the legacy camel-cased shape). Resolve the
  // property's local "today" the way the doctor does (Intl tz-aware) since
  // there is no rooms.date anymore.
  const date = await getPropertyToday(propertyId);
  const rooms = await mergePmsRoomsForDate(propertyId, date);

  // Overdue rooms: in_progress for > 90 minutes. The merge derives
  // status='in_progress' from a started-but-not-completed HK assignment, and
  // carries the start timestamp as startedAt — both real pms_* signals.
  const overdueCutoffMs = Date.now() - 90 * 60 * 1000;
  for (const r of rooms) {
    if (r.status !== 'in_progress' || !r.startedAt) continue;
    const startedTime = new Date(r.startedAt).getTime();
    if (Number.isNaN(startedTime) || startedTime > overdueCutoffMs) continue;
    const minutesAgo = Math.round((Date.now() - startedTime) / 60_000);
    // assignedName comes through the merge (housekeeper_name on the
    // assignment); no extra staff lookup needed.
    const staffName = r.assignedName ?? null;
    drafts.push({
      severity: 'warning',
      payload: {
        summary: `Room ${r.number} has been in progress for ${minutesAgo} min${staffName ? ` (${staffName})` : ''}. Usually takes ~25 min — worth checking in.`,
        type: 'overdue_room',
        roomNumber: r.number,
        staffName,
        minutesElapsed: minutesAgo,
      },
      // r.id is the composite "${date}:${room_number}" — stable per day,
      // so the dedupe key behaves the same as the old per-room-row id.
      dedupeKey: `overdue_room:${r.id}`,
    });
  }

  // Unresolved help requests > 5 min.
  // TODO(overlay): `helpRequested` is a housekeeper-set workflow field with
  // no pms_* home yet — it lands in a future overlay table. The merge shape
  // does not provide it (r.helpRequested is always undefined), so this check
  // produces nothing for now. That preserves current behavior: in prod the
  // legacy `rooms` table is empty (0 rows), so this alert never fired anyway.
  // Once the overlay lands, filter `rooms` on `r.helpRequested === true` here.
  for (const r of rooms) {
    if (!r.helpRequested) continue;
    // started_at is the proxy for "when did help get raised". If absent, skip.
    if (!r.startedAt) continue;
    const startedTime = new Date(r.startedAt).getTime();
    if (Number.isNaN(startedTime)) continue;
    const helpCutoffMs = Date.now() - 5 * 60 * 1000;
    if (startedTime > helpCutoffMs) continue;
    const minutesAgo = Math.round((Date.now() - startedTime) / 60_000);
    drafts.push({
      severity: 'urgent',
      payload: {
        summary: `Help requested for room ${r.number} ${minutesAgo} min ago — nobody has responded yet.`,
        type: 'unresolved_help',
        roomNumber: r.number,
        minutesAgo,
      },
      dedupeKey: `unresolved_help:${r.id}`,
    });
  }

  return drafts;
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
async function getPropertyToday(propertyId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from('properties')
    .select('timezone')
    .eq('id', propertyId)
    .maybeSingle();
  const tz = (data?.timezone as string) ?? null;
  return propertyLocalToday(new Date(), tz);
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
  let countsOk = true;
  try {
    countsOk = countsTrusted(await getPropertyFeedStatus(propertyId));
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

  return {
    summary: `Today: ${clean} rooms cleaned by ${uniqueStaff} housekeepers (${Math.round(totalLabor / 60 * 10) / 10}h total). ${dirty} dirty rooms remaining, ${issues} flagged issues.`,
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
      dedupeKey: `inventory_low:${new Date().toISOString().slice(0, 10)}`,
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
