/**
 * Sick-callout notifications — SMS fanout to affected housekeepers.
 *
 * Why not push notifications: the existing rollout uses Twilio SMS as the
 * notification channel for housekeepers (the housekeeper page itself is
 * delivered as an SMS link), so wiring up web push or APNs would mean
 * introducing a second channel just for this feature. Reuse the SMS path
 * the team already trusts; future push support can replace these calls
 * one-for-one.
 *
 * Cost considerations:
 *   - SMS fans out to ALL receivers — every HK who picked up at least one
 *     room from the sick HK gets ONE message (not one per room).
 *   - Failures are non-fatal — the callout + redistribution succeed even
 *     if every SMS fails. The notification log table will surface this.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendSms } from '@/lib/sms';
import { isSmsConfigured } from '@/lib/env';
import { log } from '@/lib/log';
import type { Language } from '@/lib/translations';
import type { CalloutEvent, ImpactedAssignment } from './types';
// Pure-function builders live in sms-bodies.ts so the test suite can
// exercise them without paying the @sentry/nextjs import side effect
// that @/lib/sms drags in.
import {
  buildPickupSms,
  buildRevertSms,
} from './sms-bodies';

export {
  buildPickupSms,
  buildRevertSms,
} from './sms-bodies';

interface StaffContact {
  id: string;
  name: string;
  phone: string | null;
  language: Language;
}

// ───────────────────────────────────────────────────────────────────────
// SEND FUNCTIONS
// ───────────────────────────────────────────────────────────────────────

/**
 * Send pickup-notification SMS to each affected housekeeper. Returns a
 * counter for observability; never throws.
 */
export async function sendCalloutNotifications(
  supabase: SupabaseClient,
  callout: CalloutEvent,
): Promise<{ smsSent: number; smsFailed: number }> {
  if (!isSmsConfigured()) {
    log.info('[sick-callout/notify] skipping SMS — Twilio not configured', {
      calloutId: callout.id,
    });
    return { smsSent: 0, smsFailed: 0 };
  }
  let smsSent = 0;
  let smsFailed = 0;

  const sickStaff = await fetchStaffContact(supabase, callout.staff_id);
  if (!sickStaff) {
    log.warn('[sick-callout/notify] sick staff record missing — abandoning notifications', {
      calloutId: callout.id, staffId: callout.staff_id,
    });
    return { smsSent: 0, smsFailed: 0 };
  }

  // Group impacted assignments by receiver so each receiver gets one SMS.
  const byReceiver = new Map<string, ImpactedAssignment[]>();
  for (const a of callout.impacted_assignments ?? []) {
    if (!a.redistributed_to) continue;
    const list = byReceiver.get(a.redistributed_to) ?? [];
    list.push(a);
    byReceiver.set(a.redistributed_to, list);
  }

  // Fetch each receiver's contact info — phone + language for the
  // receiver-side SMS.
  const receiverIds = Array.from(byReceiver.keys());
  const receivers = await fetchStaffContacts(supabase, receiverIds);

  // Pull each receiver's current total room count (post-redistribution)
  // so the SMS can show "New total: 14 rooms." rather than just the delta.
  const totalsByReceiver = await fetchRoomTotalsByStaff(
    supabase,
    callout.property_id,
    callout.business_date,
    receiverIds,
  );

  for (const receiver of receivers) {
    if (!receiver.phone) {
      log.info('[sick-callout/notify] receiver has no phone, skipping', {
        calloutId: callout.id, receiverId: receiver.id,
      });
      continue;
    }
    const assignments = byReceiver.get(receiver.id) ?? [];
    const roomNumbers = assignments.map((a) => a.room_number);
    const totalRooms = totalsByReceiver.get(receiver.id) ?? roomNumbers.length;
    const body = buildPickupSms(sickStaff.name, roomNumbers, totalRooms, receiver.language);
    try {
      await sendSms(receiver.phone, body);
      smsSent += 1;
    } catch (err) {
      smsFailed += 1;
      log.warn('[sick-callout/notify] pickup SMS failed', {
        calloutId: callout.id, receiverId: receiver.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { smsSent, smsFailed };
}

export async function sendRevertNotifications(
  supabase: SupabaseClient,
  callout: CalloutEvent,
): Promise<{ smsSent: number; smsFailed: number }> {
  if (!isSmsConfigured()) {
    return { smsSent: 0, smsFailed: 0 };
  }
  let smsSent = 0;
  let smsFailed = 0;

  const sickStaff = await fetchStaffContact(supabase, callout.staff_id);
  if (!sickStaff) {
    return { smsSent: 0, smsFailed: 0 };
  }

  // Notify everyone who picked up at least one room — they need to know
  // the rooms came back off their queue (or, if they already started,
  // that the situation is back to normal even if their queue stayed).
  const receiverIds = Array.from(
    new Set(
      (callout.impacted_assignments ?? [])
        .map((a) => a.redistributed_to)
        .filter((id): id is string => !!id),
    ),
  );
  const receivers = await fetchStaffContacts(supabase, receiverIds);

  for (const receiver of receivers) {
    if (!receiver.phone) continue;
    const body = buildRevertSms(sickStaff.name, receiver.language);
    try {
      await sendSms(receiver.phone, body);
      smsSent += 1;
    } catch (err) {
      smsFailed += 1;
      log.warn('[sick-callout/notify] revert SMS failed', {
        calloutId: callout.id, receiverId: receiver.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { smsSent, smsFailed };
}

// ───────────────────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────────────────

async function fetchStaffContact(
  supabase: SupabaseClient,
  staffId: string,
): Promise<StaffContact | null> {
  const lookup = await supabase
    .from('staff')
    .select('id, name, phone, language')
    .eq('id', staffId)
    .maybeSingle();
  if (lookup.error || !lookup.data) return null;
  const row = lookup.data as { id: string; name: string; phone: string | null; language: string | null };
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    language: row.language === 'es' ? 'es' : 'en',
  };
}

async function fetchStaffContacts(
  supabase: SupabaseClient,
  ids: string[],
): Promise<StaffContact[]> {
  if (ids.length === 0) return [];
  const lookup = await supabase
    .from('staff')
    .select('id, name, phone, language')
    .in('id', ids);
  if (lookup.error) return [];
  return (lookup.data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    phone: (row.phone as string | null) ?? null,
    language: (row.language as string | null) === 'es' ? 'es' : 'en',
  }));
}

async function fetchRoomTotalsByStaff(
  supabase: SupabaseClient,
  propertyId: string,
  businessDate: string,
  staffIds: string[],
): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  if (staffIds.length === 0) return totals;
  const lookup = await supabase
    .from('cleaning_tasks')
    .select('assignee_id')
    .eq('property_id', propertyId)
    .eq('business_date', businessDate)
    .in('assignee_id', staffIds);
  if (lookup.error || !lookup.data) return totals;
  for (const row of lookup.data as Array<{ assignee_id: string | null }>) {
    if (!row.assignee_id) continue;
    totals.set(row.assignee_id, (totals.get(row.assignee_id) ?? 0) + 1);
  }
  return totals;
}
