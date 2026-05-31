/**
 * GET /api/cron/send-complaint-nudges
 *
 * Smart nudges for the complaints log (cron-gated):
 *   1. Satisfaction callbacks DUE — callback_at has passed, not done yet →
 *      text the property's alert phone so the desk/manager calls the guest.
 *   2. High-severity ESCALATION — a high complaint still open/in_progress >4h →
 *      text the alert phone to chase it.
 *
 * Idempotent: each path stamps callback_nudged_at / escalation_nudged_at so a
 * complaint is nudged once per cycle, not on every tick. SMS is billing-gated.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';
import { sendSms } from '@/lib/sms';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { COMPLAINT_OVERDUE_HOURS_HIGH } from '@/lib/complaints-shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TICK_LIMIT = 100;

interface Row {
  id: string;
  property_id: string;
  room_number: string | null;
  guest_name: string | null;
  description: string | null;
  severity: string | null;
  callback_at: string | null;
  callback_nudged_at: string | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const escalateBeforeIso = new Date(nowMs - COMPLAINT_OVERDUE_HOURS_HIGH * 3600_000).toISOString();

  // Per-property alert-phone cache (null = looked up, none on file).
  const phoneCache = new Map<string, string | null>();
  async function alertPhone(pid: string): Promise<string | null> {
    if (phoneCache.has(pid)) return phoneCache.get(pid)!;
    const { data } = await supabaseAdmin.from('properties').select('alert_phone').eq('id', pid).maybeSingle();
    const phone = (data?.alert_phone as string | null) ?? null;
    phoneCache.set(pid, phone);
    return phone;
  }

  let callbacksSent = 0, escalationsSent = 0, skippedNoPhone = 0, rateLimited = 0;

  try {
    // ── 1. Callbacks due ──────────────────────────────────────────────────
    const { data: cbRows, error: cbErr } = await supabaseAdmin
      .from('complaints')
      .select('id, property_id, room_number, guest_name, description, severity, callback_at, callback_nudged_at')
      .eq('callback_done', false)
      .not('callback_at', 'is', null)
      .lte('callback_at', nowIso)
      .order('callback_at', { ascending: true })
      .limit(TICK_LIMIT);
    if (cbErr) throw cbErr;

    for (const r of (cbRows ?? []) as Row[]) {
      // Skip if already nudged for this (or a later) callback time.
      if (r.callback_nudged_at && r.callback_at && Date.parse(r.callback_nudged_at) >= Date.parse(r.callback_at)) continue;
      const phone = await alertPhone(r.property_id);
      if (!phone) { skippedNoPhone++; continue; }
      const smsRl = await checkAndIncrementRateLimit('complaints-sms', r.property_id);
      if (!smsRl.allowed) { rateLimited++; continue; }
      try {
        const who = r.guest_name ? ` (${r.guest_name})` : '';
        const room = r.room_number ? ` Room ${r.room_number}` : '';
        await sendSms(phone, `Staxis: satisfaction callback due —${room}${who}. Please follow up with the guest.`);
        await supabaseAdmin.from('complaints').update({ callback_nudged_at: nowIso }).eq('id', r.id);
        callbacksSent++;
      } catch (e) {
        log.warn('[cron/complaint-nudges] callback SMS failed', { requestId, id: r.id, err: errToString(e) });
      }
    }

    // ── 2. High-severity escalations ──────────────────────────────────────
    const { data: escRows, error: escErr } = await supabaseAdmin
      .from('complaints')
      .select('id, property_id, room_number, guest_name, description, severity, callback_at, callback_nudged_at')
      .eq('severity', 'high')
      .in('status', ['open', 'in_progress'])
      .is('escalation_nudged_at', null)
      .lte('created_at', escalateBeforeIso)
      .order('created_at', { ascending: true })
      .limit(TICK_LIMIT);
    if (escErr) throw escErr;

    for (const r of (escRows ?? []) as Row[]) {
      const phone = await alertPhone(r.property_id);
      if (!phone) { skippedNoPhone++; continue; }
      const smsRl = await checkAndIncrementRateLimit('complaints-sms', r.property_id);
      if (!smsRl.allowed) { rateLimited++; continue; }
      try {
        const room = r.room_number ? ` Room ${r.room_number}:` : ':';
        const desc = String(r.description ?? '').slice(0, 120);
        await sendSms(phone, `Staxis: HIGH-severity complaint still unresolved —${room} ${desc}`);
        await supabaseAdmin.from('complaints').update({ escalation_nudged_at: nowIso }).eq('id', r.id);
        escalationsSent++;
      } catch (e) {
        log.warn('[cron/complaint-nudges] escalation SMS failed', { requestId, id: r.id, err: errToString(e) });
      }
    }

    log.info('[cron/complaint-nudges] tick', { requestId, callbacksSent, escalationsSent, skippedNoPhone, rateLimited });
    await writeCronHeartbeat('send-complaint-nudges', {
      requestId,
      notes: { callbacksSent, escalationsSent, skippedNoPhone, rateLimited },
    });
    return ok({ callbacksSent, escalationsSent, skippedNoPhone, rateLimited }, { requestId });
  } catch (caughtErr) {
    log.error('[cron/complaint-nudges] failed', { requestId, err: errToString(caughtErr) });
    return err('send-complaint-nudges failed', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
