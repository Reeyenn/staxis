/**
 * GET /api/admin/diagnose?pid=
 *
 * Read-only snapshot for debugging the SMS flow:
 *   - Last 20 webhook_log entries (every inbound SMS hit + its lookup result)
 *   - Last 10 shift_confirmations for the given property (status + staff_phone)
 *   - Twilio number config + recent messages (inbound + outbound)
 *
 * Legacy `uid` query param accepted but ignored.
 */
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { requireCronSecret } from '@/lib/api-auth';

export async function GET(req: NextRequest) {
  // Lock this endpoint behind CRON_SECRET. It returns recent inbound SMS,
  // staff phone numbers, shift_confirmations, and Twilio operational
  // metadata — all PII / sensitive ops data. Open to the internet was
  // a real leak.
  const unauthorized = requireCronSecret(req);
  if (unauthorized) return unauthorized;
  try {
    const url = new URL(req.url);
    const pid = url.searchParams.get('pid');
    if (!pid) {
      return NextResponse.json({ error: 'need ?pid=' }, { status: 400 });
    }

    // ── Twilio REST helpers ────────────────────────────────────────────────
    async function getTwilioNumbers(): Promise<unknown> {
      try {
        const sid = process.env.TWILIO_ACCOUNT_SID;
        const tok = process.env.TWILIO_AUTH_TOKEN;
        if (!sid || !tok) return { error: 'twilio env vars missing' };
        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`,
          { headers: { Authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString('base64')}` } },
        );
        if (!res.ok) return { error: `twilio status ${res.status}` };
        const json = await res.json() as { incoming_phone_numbers?: Array<Record<string, unknown>> };
        return (json.incoming_phone_numbers ?? []).map(n => ({
          phoneNumber: n.phone_number,
          friendlyName: n.friendly_name,
          smsUrl: n.sms_url,
          smsMethod: n.sms_method,
          smsFallbackUrl: n.sms_fallback_url,
          statusCallback: n.status_callback,
          voiceUrl: n.voice_url,
          sid: n.sid,
        }));
      } catch (e) {
        return { error: errToString(e) };
      }
    }

    async function getTwilioMessages(): Promise<unknown> {
      try {
        const sid = process.env.TWILIO_ACCOUNT_SID;
        const tok = process.env.TWILIO_AUTH_TOKEN;
        if (!sid || !tok) return { error: 'twilio env vars missing' };
        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?PageSize=20`,
          { headers: { Authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString('base64')}` } },
        );
        if (!res.ok) return { error: `twilio status ${res.status}` };
        const json = await res.json() as { messages?: Array<Record<string, unknown>> };
        return (json.messages ?? []).map(m => ({
          sid: m.sid,
          direction: m.direction,
          status: m.status,
          errorCode: m.error_code,
          errorMessage: m.error_message,
          from: m.from,
          to: m.to,
          dateSent: m.date_sent,
          body: (m.body as string ?? '').slice(0, 120),
        }));
      } catch (e) {
        return { error: errToString(e) };
      }
    }

    const [logsRes, confsRes, twilioNumbers, twilioMessages] = await Promise.all([
      supabaseAdmin
        .from('webhook_log')
        .select('id, ts, source, payload')
        .order('ts', { ascending: false })
        .limit(20),
      supabaseAdmin
        .from('shift_confirmations')
        .select('token, staff_name, staff_phone, status, shift_date, sent_at, responded_at')
        .eq('property_id', pid)
        .order('sent_at', { ascending: false, nullsFirst: false })
        .limit(10),
      getTwilioNumbers(),
      getTwilioMessages(),
    ]);

    const webhookLogs = (logsRes.data ?? []).map(r => ({
      id: r.id,
      ts: r.ts,
      source: r.source,
      ...(r.payload as Record<string, unknown>),
    }));

    const confirmations = (confsRes.data ?? []).map(r => ({
      token: r.token,
      staffName: r.staff_name,
      staffPhone: r.staff_phone,
      status: r.status,
      shiftDate: r.shift_date,
      sentAt: r.sent_at,
      respondedAt: r.responded_at,
    }));

    return NextResponse.json({ webhookLogs, confirmations, twilioNumbers, twilioMessages });
  } catch (err) {
    const msg = errToString(err);
    console.error('[admin/diagnose] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
