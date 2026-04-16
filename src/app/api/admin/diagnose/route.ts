/**
 * GET /api/admin/diagnose?uid=&pid=
 *
 * Read-only snapshot for debugging the SMS flow:
 *   - Last 20 webhookLog entries (every inbound SMS hit and its lookup result)
 *   - Last 10 shiftConfirmations for the given uid/pid (status + staffPhone)
 */
import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const uid = url.searchParams.get('uid');
    const pid = url.searchParams.get('pid');
    if (!uid || !pid) {
      return NextResponse.json({ error: 'need ?uid=&pid=' }, { status: 400 });
    }

    const db = admin.firestore();

    // Also hit Twilio's REST API to check how the toll-free number is actually
    // configured — specifically the SmsUrl/SmsMethod for inbound-SMS webhooks.
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
        return { error: String(e) };
      }
    }

    const [logSnap, confSnap, twilioNumbers] = await Promise.all([
      db.collection('webhookLog').orderBy('ts', 'desc').limit(20).get(),
      db.collection('users').doc(uid)
        .collection('properties').doc(pid)
        .collection('shiftConfirmations').get(),
      getTwilioNumbers(),
    ]);

    const logs = logSnap.docs.map(d => {
      const x = d.data();
      return {
        ...x,
        ts: x.ts?.toDate?.()?.toISOString() ?? null,
      };
    });

    const confs = confSnap.docs.map(d => {
      const x = d.data();
      return {
        docId: d.id,
        staffName: x.staffName,
        staffPhone: x.staffPhone,
        status: x.status,
        shiftDate: x.shiftDate,
        sentAt: x.sentAt?.toDate?.()?.toISOString() ?? null,
        respondedAt: x.respondedAt?.toDate?.()?.toISOString() ?? null,
      };
    }).sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? '')).slice(0, 10);

    return NextResponse.json({ webhookLogs: logs, confirmations: confs, twilioNumbers });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
