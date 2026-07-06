// ═══════════════════════════════════════════════════════════════════════════
// Agent reminders — delayed one-shot reminders scheduled by the AI assistant.
//
// Backing table: agent_reminders (migration 0302), service-role only. This
// module owns the create / cancel / list / fire logic; the create_reminder,
// cancel_reminder, and list_reminders agent tools call it, and the
// process-sms-jobs cron calls fireDueReminders() on each tick.
//
// Delivery routes into the Communications hub (comms/core), reusing the same
// primitives the live chat uses:
//   • staff target      → a DM from the creator to the target person.
//   • department target → a post in that department's channel (front_desk /
//                         housekeeping / maintenance), or the announcements
//                         feed for the catch-all 'general' department.
//
// Everything here uses supabaseAdmin (the table is deny-all RLS).
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import {
  ensureDmConversation,
  ensureChannelConversation,
  ensureAnnouncementConversation,
  postMessage,
} from '@/lib/comms/core';
import type { ChannelKey } from '@/lib/comms/types';

/** Departments a reminder can target (mirrors comms_tasks + the CHECK in 0302). */
export const REMINDER_DEPARTMENTS = ['front_desk', 'housekeeping', 'maintenance', 'general'] as const;
export type ReminderDepartment = (typeof REMINDER_DEPARTMENTS)[number];

export interface CreateReminderInput {
  propertyId: string;
  createdByStaffId: string;
  /** Exactly one of targetStaffId / targetDepartment. */
  targetStaffId?: string | null;
  targetDepartment?: ReminderDepartment | null;
  body: string;
  fireAt: string; // ISO-8601
}

export interface ReminderRow {
  id: string;
  propertyId: string;
  createdByStaffId: string | null;
  targetStaffId: string | null;
  targetDepartment: string | null;
  body: string;
  fireAt: string;
  firedAt: string | null;
  canceledAt: string | null;
  createdAt: string;
}

function mapRow(r: Record<string, unknown>): ReminderRow {
  return {
    id: r.id as string,
    propertyId: r.property_id as string,
    createdByStaffId: (r.created_by_staff_id as string | null) ?? null,
    targetStaffId: (r.target_staff_id as string | null) ?? null,
    targetDepartment: (r.target_department as string | null) ?? null,
    body: r.body as string,
    fireAt: r.fire_at as string,
    firedAt: (r.fired_at as string | null) ?? null,
    canceledAt: (r.canceled_at as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

/** Insert a pending reminder. Returns the new row id. */
export async function createReminder(input: CreateReminderInput): Promise<{ id: string }> {
  const staffTarget = input.targetStaffId ?? null;
  const deptTarget = input.targetDepartment ?? null;
  // Enforce the one-target invariant at the app boundary too (the DB CHECK is
  // the backstop, but a clear error beats a 23514).
  if ((staffTarget && deptTarget) || (!staffTarget && !deptTarget)) {
    throw new Error('a reminder must target exactly one of a staff member or a department');
  }
  const { data, error } = await supabaseAdmin
    .from('agent_reminders')
    .insert({
      property_id: input.propertyId,
      created_by_staff_id: input.createdByStaffId,
      target_staff_id: staffTarget,
      target_department: deptTarget,
      body: input.body,
      fire_at: input.fireAt,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { id: data.id as string };
}

/** Cancel a still-pending reminder by id (scoped to the property). Returns true
 *  when a pending row was actually tombstoned. Already-fired / already-canceled
 *  rows are left untouched and return false. */
export async function cancelReminder(propertyId: string, reminderId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('agent_reminders')
    .update({ canceled_at: new Date().toISOString() })
    .eq('property_id', propertyId)
    .eq('id', reminderId)
    .is('fired_at', null)
    .is('canceled_at', null)
    .select('id')
    .maybeSingle();
  return !!data;
}

/** List a property's still-pending (not fired, not canceled) reminders,
 *  soonest first. */
export async function listPendingReminders(propertyId: string, limit = 50): Promise<ReminderRow[]> {
  const { data, error } = await supabaseAdmin
    .from('agent_reminders')
    .select('*')
    .eq('property_id', propertyId)
    .is('fired_at', null)
    .is('canceled_at', null)
    .order('fire_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => mapRow(r as Record<string, unknown>));
}

/** Map a target department to its comms channel key. 'general' has no dept
 *  channel — it broadcasts to the announcements feed instead (null here). */
function departmentChannel(dept: string): ChannelKey | null {
  if (dept === 'front_desk' || dept === 'housekeeping' || dept === 'maintenance') return dept;
  return null; // 'general' → announcements
}

/**
 * Deliver a single reminder into the Communications hub. Posts AS the creator
 * so the recipient sees it coming from a real colleague. Throws on failure so
 * the caller can leave the row un-fired for a retry on the next tick.
 */
async function deliverReminder(r: ReminderRow): Promise<void> {
  const body = `⏰ Reminder: ${r.body}`;
  if (r.targetStaffId) {
    if (!r.createdByStaffId) {
      // A reminder whose creator was removed can't be a DM (DMs need two staff).
      // Fall back to the announcements feed so it isn't silently dropped.
      const convoId = await ensureAnnouncementConversation(r.propertyId);
      await postMessage(r.propertyId, convoId, { senderStaffId: null, senderKind: 'staff', body, msgType: 'announcement' });
      return;
    }
    if (r.createdByStaffId === r.targetStaffId) {
      // Self-reminder: a DM to yourself is illegal (ensureDmConversation throws).
      // Deliver it as an announcement so the person still gets the ping.
      const convoId = await ensureAnnouncementConversation(r.propertyId);
      await postMessage(r.propertyId, convoId, { senderStaffId: r.createdByStaffId, senderKind: 'staff', body, msgType: 'announcement' });
      return;
    }
    const convoId = await ensureDmConversation(r.propertyId, r.createdByStaffId, r.targetStaffId);
    await postMessage(r.propertyId, convoId, { senderStaffId: r.createdByStaffId, senderKind: 'staff', body });
    return;
  }
  // Department target.
  const dept = r.targetDepartment ?? 'general';
  const channel = departmentChannel(dept);
  if (channel) {
    const convoId = await ensureChannelConversation(r.propertyId, channel);
    await postMessage(r.propertyId, convoId, { senderStaffId: r.createdByStaffId, senderKind: 'staff', body });
  } else {
    const convoId = await ensureAnnouncementConversation(r.propertyId);
    await postMessage(r.propertyId, convoId, { senderStaffId: r.createdByStaffId, senderKind: 'staff', body, msgType: 'announcement' });
  }
}

export interface FireRemindersResult {
  due: number;
  fired: number;
  failed: number;
}

/**
 * Fire every reminder that is due (fire_at <= now, not yet fired, not canceled).
 * Late firing is tolerated on purpose — an overdue reminder still goes out. Each
 * reminder is delivered then stamped fired_at independently, so one bad row
 * (e.g. a deleted target) never blocks the rest of the batch. Called from the
 * process-sms-jobs cron tick.
 */
export async function fireDueReminders(now: Date = new Date(), limit = 200): Promise<FireRemindersResult> {
  const nowIso = now.toISOString();
  const { data, error } = await supabaseAdmin
    .from('agent_reminders')
    .select('*')
    .lte('fire_at', nowIso)
    .is('fired_at', null)
    .is('canceled_at', null)
    .order('fire_at', { ascending: true })
    .limit(limit);
  if (error) {
    log.error('[reminders] fireDueReminders query failed', { err: error.message });
    return { due: 0, fired: 0, failed: 0 };
  }
  const rows = (data ?? []).map((r) => mapRow(r as Record<string, unknown>));
  let fired = 0;
  let failed = 0;
  for (const r of rows) {
    // CLAIM first: atomically stamp fired_at behind the is-null guards. Exactly
    // one concurrent tick wins the UPDATE, so a reminder is delivered once even
    // if two ticks overlap. If we lose the claim (no row returned), skip.
    const { data: claimed } = await supabaseAdmin
      .from('agent_reminders')
      .update({ fired_at: new Date().toISOString() })
      .eq('id', r.id)
      .is('fired_at', null)
      .is('canceled_at', null)
      .select('id')
      .maybeSingle();
    if (!claimed) continue; // another tick claimed it, or it was canceled
    try {
      await deliverReminder(r);
      fired += 1;
    } catch (e) {
      failed += 1;
      // Delivery failed after claiming — roll the claim back so the next tick
      // retries (better a duplicate risk than a silently dropped reminder).
      await supabaseAdmin
        .from('agent_reminders')
        .update({ fired_at: null })
        .eq('id', r.id)
        .then(undefined, () => undefined);
      log.warn('[reminders] delivery failed; released for next tick', {
        reminderId: r.id, err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { due: rows.length, fired, failed };
}
