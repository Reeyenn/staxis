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

/** Find the accounts that should receive nudges for a property (owners + GMs). */
async function getNudgeRecipients(propertyId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from('accounts')
    .select('id, role, property_access')
    .in('role', ['owner', 'general_manager']);
  if (!data) return [];
  return data
    .filter(a => {
      const access = (a.property_access as string[]) ?? [];
      return access.includes(propertyId) || access.includes('*');
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

  // Overdue rooms: in_progress for > 90 minutes
  const overdueCutoff = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const { data: overdueRooms } = await supabaseAdmin
    .from('rooms')
    .select('id, number, started_at, assigned_to')
    .eq('property_id', propertyId)
    .eq('status', 'in_progress')
    .not('started_at', 'is', null)
    .lt('started_at', overdueCutoff);

  for (const r of overdueRooms ?? []) {
    const minutesAgo = Math.round((Date.now() - new Date(r.started_at as string).getTime()) / 60_000);
    let staffName: string | null = null;
    if (r.assigned_to) {
      const { data: s } = await supabaseAdmin
        .from('staff')
        .select('name')
        .eq('id', r.assigned_to)
        .maybeSingle();
      staffName = (s?.name as string) ?? null;
    }
    drafts.push({
      severity: 'warning',
      payload: {
        summary: `Room ${r.number} has been in progress for ${minutesAgo} min${staffName ? ` (${staffName})` : ''}. Usually takes ~25 min — worth checking in.`,
        type: 'overdue_room',
        roomNumber: r.number,
        staffName,
        minutesElapsed: minutesAgo,
      },
      dedupeKey: `overdue_room:${r.id}`,
    });
  }

  // Unresolved help requests > 5 min
  const helpCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: helpRooms } = await supabaseAdmin
    .from('rooms')
    .select('id, number, assigned_to, started_at')
    .eq('property_id', propertyId)
    .eq('help_requested', true);

  for (const r of helpRooms ?? []) {
    // Use started_at as the proxy for "when did help get raised". If null, default to now (skip).
    if (!r.started_at) continue;
    const startedTime = new Date(r.started_at as string).getTime();
    if (startedTime > new Date(helpCutoff).getTime()) continue;
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

async function buildDailySummary(propertyId: string): Promise<Record<string, unknown>> {
  const today = new Date().toISOString().slice(0, 10);
  const { data: rooms } = await supabaseAdmin
    .from('rooms')
    .select('status, is_dnd, issue_note')
    .eq('property_id', propertyId);
  const { data: events } = await supabaseAdmin
    .from('cleaning_events')
    .select('staff_id, duration_minutes')
    .eq('property_id', propertyId)
    .eq('date', today)
    .neq('status', 'discarded');

  let clean = 0, dirty = 0, inProgress = 0, dnd = 0, issues = 0;
  for (const r of rooms ?? []) {
    if (r.is_dnd) dnd++;
    else if (r.status === 'dirty') dirty++;
    else if (r.status === 'in_progress') inProgress++;
    else if (r.status === 'clean' || r.status === 'inspected') clean++;
    if (r.issue_note) issues++;
  }
  const totalLabor = (events ?? []).reduce((acc, e) => acc + Number(e.duration_minutes ?? 0), 0);
  const uniqueStaff = new Set((events ?? []).map(e => e.staff_id)).size;

  return {
    summary: `Today: ${clean} rooms cleaned by ${uniqueStaff} housekeepers (${Math.round(totalLabor / 60 * 10) / 10}h total). ${dirty} dirty rooms remaining, ${issues} flagged issues.`,
    type: 'daily_summary',
    date: today,
    roomsCleaned: clean,
    roomsRemaining: dirty + inProgress,
    dnd,
    issues,
    laborMinutes: Math.round(totalLabor),
    uniqueStaff,
  };
}

// ─── 3. Inventory ─────────────────────────────────────────────────────────

async function checkInventory(propertyId: string): Promise<NudgeDraft[]> {
  const drafts: NudgeDraft[] = [];
  // Try to read inventory_items — if the table doesn't exist for this property
  // or returns empty, skip silently.
  const { data, error } = await supabaseAdmin
    .from('inventory_items')
    .select('name, current_stock, reorder_threshold')
    .eq('property_id', propertyId);
  if (error || !data?.length) return drafts;

  const below = data.filter(
    i => Number(i.current_stock ?? 0) < Number(i.reorder_threshold ?? 0),
  );
  if (below.length > 0) {
    drafts.push({
      severity: 'warning',
      payload: {
        summary: `${below.length} inventory item${below.length === 1 ? '' : 's'} below reorder threshold: ${below.slice(0, 3).map(i => i.name).join(', ')}${below.length > 3 ? '…' : ''}`,
        type: 'inventory_low',
        items: below.map(i => ({
          name: i.name,
          current: Number(i.current_stock ?? 0),
          threshold: Number(i.reorder_threshold ?? 0),
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
