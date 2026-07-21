// ═══════════════════════════════════════════════════════════════════════════
// Agent reminders — delayed one-shot reminders scheduled by the AI assistant.
//
// Backing table: agent_reminders (migration 0302), service-role only. This
// module owns the create / cancel / list / fire logic; the create_reminder,
// cancel_reminder, and list_reminders agent tools call it, and the
// process-agent-schedules cron calls fireDueReminders() on each tick.
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
import { randomUUID } from 'node:crypto';
import { isSectionEnabledForProperty } from '@/lib/sections/server';

const DELIVERY_LEASE_MS = 2 * 60_000;

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
  const post = async (
    conversationId: string,
    input: Parameters<typeof postMessage>[2],
  ): Promise<void> => {
    try {
      await postMessage(r.propertyId, conversationId, {
        ...input,
        meta: { ...(input.meta ?? {}), agent_reminder_id: r.id },
      });
    } catch (error) {
      // Migration 0333 makes this metadata key unique. A stale lease can be
      // retried after the message insert committed but before fired_at was
      // finalized. Confirm that the duplicate is this reminder in this exact
      // conversation before treating it as delivered; another unique
      // constraint must still fail loudly.
      if ((error as { code?: string } | null)?.code === '23505') {
        const existing = await supabaseAdmin
          .from('comms_messages')
          .select('id, conversation_id, created_at')
          .eq('property_id', r.propertyId)
          .contains('meta', { agent_reminder_id: r.id })
          .maybeSingle();
        if (
          existing.error
          || !existing.data
          || existing.data.conversation_id !== conversationId
        ) {
          throw existing.error ?? error;
        }

        // If the process died immediately after the insert, postMessage may
        // not have bumped the conversation ordering yet. Repair only when the
        // reminder is newer so a later human message can never be moved back.
        const conversation = await supabaseAdmin
          .from('comms_conversations')
          .select('last_message_at')
          .eq('id', conversationId)
          .eq('property_id', r.propertyId)
          .maybeSingle();
        if (conversation.error) throw conversation.error;
        if (
          !conversation.data?.last_message_at
          || conversation.data.last_message_at < existing.data.created_at
        ) {
          const { error: bumpError } = await supabaseAdmin
            .from('comms_conversations')
            .update({
              last_message_at: existing.data.created_at,
              updated_at: existing.data.created_at,
            })
            .eq('id', conversationId)
            .eq('property_id', r.propertyId);
          if (bumpError) throw bumpError;
        }
        return;
      }
      throw error;
    }
  };
  if (r.targetStaffId) {
    if (!r.createdByStaffId) {
      // A reminder whose creator was removed can't be a DM (DMs need two staff).
      // Fall back to the announcements feed so it isn't silently dropped.
      const convoId = await ensureAnnouncementConversation(r.propertyId);
      await post(convoId, { senderStaffId: null, senderKind: 'staff', body, msgType: 'announcement' });
      return;
    }
    if (r.createdByStaffId === r.targetStaffId) {
      // Self-reminder: a DM to yourself is illegal (ensureDmConversation throws).
      // Deliver it as an announcement so the person still gets the ping.
      const convoId = await ensureAnnouncementConversation(r.propertyId);
      await post(convoId, { senderStaffId: r.createdByStaffId, senderKind: 'staff', body, msgType: 'announcement' });
      return;
    }
    const convoId = await ensureDmConversation(r.propertyId, r.createdByStaffId, r.targetStaffId);
    await post(convoId, { senderStaffId: r.createdByStaffId, senderKind: 'staff', body });
    return;
  }
  // Department target.
  const dept = r.targetDepartment ?? 'general';
  const channel = departmentChannel(dept);
  if (channel) {
    const convoId = await ensureChannelConversation(r.propertyId, channel);
    await post(convoId, { senderStaffId: r.createdByStaffId, senderKind: 'staff', body });
  } else {
    const convoId = await ensureAnnouncementConversation(r.propertyId);
    await post(convoId, { senderStaffId: r.createdByStaffId, senderKind: 'staff', body, msgType: 'announcement' });
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
 * process-agent-schedules cron tick.
 */
export async function fireDueReminders(now: Date = new Date(), limit = 200): Promise<FireRemindersResult> {
  const nowIso = now.toISOString();
  const staleBeforeIso = new Date(now.getTime() - DELIVERY_LEASE_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from('agent_reminders')
    .select('*')
    .lte('fire_at', nowIso)
    .is('fired_at', null)
    .is('canceled_at', null)
    .or(`claim_token.is.null,claimed_at.is.null,claimed_at.lt.${staleBeforeIso}`)
    .order('fire_at', { ascending: true })
    .limit(limit);
  if (error) {
    log.error('[reminders] fireDueReminders query failed', { err: error.message });
    throw new Error(`failed to load due reminders: ${error.message}`);
  }
  const rows = (data ?? []).map((r) => mapRow(r as Record<string, unknown>));
  const communicationsEnabled = new Map<string, boolean>();
  for (const propertyId of new Set(rows.map((row) => row.propertyId))) {
    communicationsEnabled.set(
      propertyId,
      await isSectionEnabledForProperty(propertyId, 'communications'),
    );
  }
  let fired = 0;
  let failed = 0;
  for (const r of rows) {
    // Turning Communications off pauses pending reminders; it never silently
    // consumes or discards them. They remain due and resume if the section is
    // deliberately enabled again.
    if (!communicationsEnabled.get(r.propertyId)) continue;
    // Acquire a reclaimable lease behind the terminal/cancel guards. Exactly
    // one concurrent tick wins. A process crash leaves fired_at null, so a
    // later tick can reclaim the lease and idempotently finish delivery.
    const claimToken = randomUUID();
    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimError } = await supabaseAdmin
      .from('agent_reminders')
      .update({ claim_token: claimToken, claimed_at: claimedAt })
      .eq('id', r.id)
      .is('fired_at', null)
      .is('canceled_at', null)
      .or(`claim_token.is.null,claimed_at.is.null,claimed_at.lt.${staleBeforeIso}`)
      .select('id')
      .maybeSingle();
    if (claimError) {
      failed += 1;
      log.warn('[reminders] delivery lease acquisition failed', {
        reminderId: r.id,
        err: claimError.message,
      });
      continue;
    }
    if (!claimed) continue; // another tick claimed it, or it was canceled
    try {
      await deliverReminder(r);
      const { data: finalized, error: finalizeError } = await supabaseAdmin
        .from('agent_reminders')
        .update({ fired_at: new Date().toISOString(), claim_token: null, claimed_at: null })
        .eq('id', r.id)
        .eq('claim_token', claimToken)
        .is('canceled_at', null)
        .select('id')
        .maybeSingle();
      if (finalizeError || !finalized) {
        throw new Error(finalizeError?.message ?? 'reminder lease was lost before finalization');
      }
      fired += 1;
    } catch (e) {
      failed += 1;
      // Release only our lease. If the message insert already committed, its
      // metadata idempotency key turns the next attempt into a safe finalize.
      await supabaseAdmin
        .from('agent_reminders')
        .update({ claim_token: null, claimed_at: null })
        .eq('id', r.id)
        .eq('claim_token', claimToken)
        .then(undefined, () => undefined);
      log.warn('[reminders] delivery failed; released for next tick', {
        reminderId: r.id, err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { due: rows.length, fired, failed };
}
