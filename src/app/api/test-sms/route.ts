/**
 * TEMPORARY test endpoint to verify Twilio toll-free (+18555141450) SMS delivery.
 *
 * Delete this file after the verification test passes.
 *
 * POST /api/test-sms
 * Body: { "to": "+14098282023", "message": "hi", "secret": "<TOKEN>" }
 */
import { NextRequest, NextResponse } from 'next/server';
import { sendSms } from '@/lib/sms';

const TEST_SMS_SECRET = 'a10bdd799f31ed51532bf4e8d2945ea8';

export async function POST(req: NextRequest) {
  try {
    const { to, message, secret } = await req.json();

    if (secret !== TEST_SMS_SECRET) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    if (!to || !message) {
      return NextResponse.json({ error: 'missing to or message' }, { status: 400 });
    }

    await sendSms(to, message);
    return NextResponse.json({ ok: true, from: process.env.TWILIO_PHONE_NUMBER, to });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[test-sms] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
