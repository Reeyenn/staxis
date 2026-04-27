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
import {
  validateUuid, validateString, validateEnum, sanitizeForSms, redactPhone, safeBaseUrl, LIMITS,
} from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';

function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

// Helper: lazy-import to avoid top-level coupling for routes that don't need it.
async function gateCronSecret(req: NextRequest) {
  const { requireCronSecret } = await import('@/lib/api-auth');
  return requireCronSecret(req);
}

export async function POST(req: NextRequest) {
  // Sends real SMS via Twilio + writes a test shift_confirmation row.
  // Was deliberately ungated for "easy testing" but that means anyone on
  // the internet can run our Twilio meter to zero. Lock behind CRON_SECRET
  // — testing is now a `curl -H "Authorization: Bearer $CRON_SECRET"` away.
  const unauthorized = await gateCronSecret(req);
  if (unauthorized) return unauthorized;
  try {
    // We previously did `req.json().catch(() => ({}))` here which silently
    // turned malformed JSON into an empty object — admins debugging a
    // bad payload would see "missing field" errors instead of "your JSON
    // is invalid". Surface the parse error explicitly.
    let body: {
      pid?: string; staffId?: string; phone?: string;
      language?: 'en' | 'es'; name?: string; uid?: string;
    };
    try {
      body = await req.json();
    } catch (parseErr) {
      return NextResponse.json(
        { error: `Invalid JSON body: ${parseErr instanceof Error ? parseErr.message : 'parse failed'}` },
        { status: 400 },
      );
    }
    // Strict validation — defense in depth (route is also gated behind
    // CRON_SECRET) so a typo'd staffId can't tunnel into a giant SQL string
    // and the error path can't leak a free-text phone number.
    const pidV = validateUuid(body.pid, 'pid');
    if (pidV.error) return NextResponse.json({ error: pidV.error }, { status: 400 });
    const sidV = validateUuid(body.staffId, 'staffId');
    if (sidV.error) return NextResponse.json({ error: sidV.error }, { status: 400 });
    const phoneRawV = validateString(body.phone, { max: 20, label: 'phone' });
    if (phoneRawV.error) return NextResponse.json({ error: phoneRawV.error }, { status: 400 });
    const langV = body.language == null
      ? { value: 'en' as const }
      : validateEnum(body.language, ['en', 'es'] as const, 'language');
    if (langV.error) return NextResponse.json({ error: langV.error }, { status: 400 });
    const nameV = body.name == null
      ? { value: 'Test' as const }
      : validateString(body.name, { max: LIMITS.STAFF_NAME_MAX, label: 'name' });
    if (nameV.error) return NextResponse.json({ error: nameV.error }, { status: 400 });

    const pid = pidV.value!;
    const staffId = sidV.value!;
    const language = langV.value!;
    const name = sanitizeForSms(nameV.value!);

    const phone164 = toE164(phoneRawV.value!);
    if (!phone164) {
      // Don't echo the raw phone back — it's PII even in an admin tool.
      return NextResponse.json({ error: `Can't normalize phone to E.164` }, { status: 400 });
    }
    // Cap at 50/hour/property — generous for an admin smoke test, tight
    // enough that a stuck script doesn't burn through Twilio credits.
    const limit = await checkAndIncrementRateLimit('test-sms-flow', pid);
    if (!limit.allowed) return rateLimitedResponse(limit.current, limit.cap, limit.retryAfterSec);

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
    const hotelName = sanitizeForSms(prop?.name || 'the hotel');

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

    // Whitelist the URL origin — protects the SMS body from being shaped
    // around a phishing host if the route is ever called with a spoofed
    // request URL (rare but cheap to defend against).
    const origin = safeBaseUrl(new URL(req.url).origin);
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
    // Log full detail server-side, generic 500 to caller — even though the
    // route is admin-gated, the err string can include staff_phone or PG
    // schema names that have no business in a response body.
    console.error('test-sms-flow error:', errToString(err));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  // ?check=<token> → return the current state of that confirmation row.
  // Same auth gate as POST — leaks staff_phone if open.
  const unauthorized = await gateCronSecret(req);
  if (unauthorized) return unauthorized;
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
  if (error) {
    console.error('test-sms-flow GET error:', errToString(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({
    token: data.token,
    status: data.status,
    // Redact the phone — admin-only or not, full E.164 in a response body
    // is not necessary for the smoke test.
    staffPhone: data.staff_phone ? redactPhone(data.staff_phone as string) : null,
    language: data.language,
    respondedAt: data.responded_at,
  });
}
