/**
 * POST /api/admin/test-sms-flow
 *
 * Standalone end-to-end tester for the inbound-SMS reply flow. Inserts a
 * single `shift_confirmations` row for a real staff member, fires an SMS,
 * and returns the token so you can watch it flip when you reply.
 *
 * Body:
 *   { pid, staffId, phone, language?, name? }
 *
 * Deliberately NOT gated — safe to ship because it only writes a pending
 * confirmation and sends one text. The staff_id must reference a real row
 * in the staff table (the table has a FK constraint). Delete this route
 * once the flow is verified.
 *
 * Legacy `uid` body field is accepted but ignored.
 */
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';
import { errToString } from '@/lib/utils';

function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as {
      pid?: string; staffId?: string; phone?: string;
      language?: 'en' | 'es'; name?: string;
      uid?: string;
    };
    const { pid, staffId, phone } = body;
    const language = body.language ?? 'en';
    const name = body.name ?? 'Test';

    if (!pid || !staffId || !phone) {
      return NextResponse.json({ error: 'Need pid, staffId, phone' }, { status: 400 });
    }
    const phone164 = toE164(phone);
    if (!phone164) {
      return NextResponse.json({ error: `Can't normalize phone ${phone} to E.164` }, { status: 400 });
    }

    // Confirm the staff row exists and belongs to this property.
    const { data: staffRow, error: staffErr } = await supabaseAdmin
      .from('staff')
      .select('id, name, property_id')
      .eq('id', staffId)
      .eq('property_id', pid)
      .maybeSingle();
    if (staffErr) throw staffErr;
    if (!staffRow) {
      return NextResponse.json(
        { error: `No staff row found for id=${staffId} + property_id=${pid}. Pass a real staffId.` },
        { status: 404 },
      );
    }

    const { data: prop } = await supabaseAdmin
      .from('properties')
      .select('name')
      .eq('id', pid)
      .maybeSingle();
    const hotelName = prop?.name || 'the hotel';

    const shiftDate = new Date().toISOString().slice(0, 10); // today
    const token = `TEST_${shiftDate}_${staffId}_${Date.now()}`;

    // Insert the confirmation row.
    const { error: insErr } = await supabaseAdmin
      .from('shift_confirmations')
      .insert({
        token,
        property_id: pid,
        staff_id: staffId,
        staff_name: name,
        staff_phone: phone164,
        shift_date: shiftDate,
        status: 'pending',
        language,
        sent_at: new Date().toISOString(),
        sms_sent: false,
      });
    if (insErr) throw insErr;

    // Update staff.phone_lookup so sms-reply can resolve this phone.
    await supabaseAdmin
      .from('staff')
      .update({ phone_lookup: phone164 })
      .eq('id', staffId);

    const origin = new URL(req.url).origin;
    const hkUrl = `${origin}/housekeeper/${staffId}?pid=${encodeURIComponent(pid)}`;

    const message = language === 'es'
      ? `[TEST] Hola ${name}! Tu lista de prueba:\n${hkUrl}\n– ${hotelName}`
      : `[TEST] Hi ${name}! Your test list:\n${hkUrl}\n– ${hotelName}`;

    await sendSms(phone164, message);
    await supabaseAdmin
      .from('shift_confirmations')
      .update({ sms_sent: true })
      .eq('token', token);

    return NextResponse.json({
      ok: true,
      token,
      staffPhone: phone164,
      instructions: `Reply ENGLISH or ESPAÑOL to the text to flip language. Then GET this same URL again with ?check=${encodeURIComponent(token)} to see the row.`,
    });
  } catch (err) {
    const msg = errToString(err);
    console.error('test-sms-flow error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  // ?check=<token> → return the current state of that confirmation row.
  const url = new URL(req.url);
  const check = url.searchParams.get('check');
  if (!check) {
    return NextResponse.json({ error: 'Need ?check=<token>' }, { status: 400 });
  }
  const { data, error } = await supabaseAdmin
    .from('shift_confirmations')
    .select('token, status, staff_phone, language, responded_at')
    .eq('token', check)
    .maybeSingle();
  if (error) return NextResponse.json({ error: errToString(error) }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({
    token: data.token,
    status: data.status,
    staffPhone: data.staff_phone,
    language: data.language,
    respondedAt: data.responded_at,
  });
}
