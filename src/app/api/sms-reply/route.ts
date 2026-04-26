/**
 * POST /api/sms-reply
 *
 * Twilio inbound-SMS webhook. Under the new flow the outbound SMS is just a
 * link to the HK's personal page — there is no YES/NO prompt, no escalation,
 * no manager paging. Maria confirms availability in person at 3pm.
 *
 * The only reply we act on is a language switch:
 *
 *   ESPAÑOL → mirror language='es' to staff row + shift_confirmation row,
 *             then resend the link SMS in Spanish.
 *   ENGLISH → mirror language='en' and resend the link SMS in English.
 *   anything else → friendly "got your message, open your link" ack.
 *
 * Every code path returns an empty TwiML <Response/> so Twilio doesn't send
 * its own auto-reply on top of ours.
 *
 * Lookup path (Supabase):
 *   1. Normalise inbound From → E.164 (and also try a few common variants).
 *   2. Find the staff row with `phone_lookup` matching any of those variants.
 *   3. Find the newest `shift_confirmations` row for that staff_id with status
 *      in ('sent','pending'). That's the shift the reply belongs to.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';
import { errToString } from '@/lib/utils';
import { toE164 } from '@/lib/phone';
import { verifyTwilioSignature } from '@/lib/twilio-auth';

// Mask a phone number for log persistence — keep last 4 digits, redact the
// rest so PII doesn't pile up in webhook_log indefinitely.
function maskPhone(p: string | null | undefined): string {
  if (!p) return '';
  const digits = p.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
}

// Twilio expects TwiML (XML), not JSON. An empty <Response/> tells Twilio
// "handled, send no auto-reply" — we've fired our own sendSms() already.
function twimlOk(): NextResponse {
  return new NextResponse(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    { headers: { 'Content-Type': 'text/xml; charset=utf-8' } },
  );
}

function formatShiftDate(dateStr: string, lang: 'en' | 'es'): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  const locale = lang === 'es' ? 'es-US' : 'en-US';
  const dayName = d.toLocaleDateString(locale, { weekday: 'long' });
  const dateFormatted = d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return `${dayName}, ${dateFormatted}`;
}

function normalise(text: string): string {
  return text.trim().toUpperCase().replace(/[.!?¿¡,;:()"'`]/g, '').trim();
}

const ES_SET = new Set(['ESPANOL', 'ESPAÑOL', 'SPANISH', 'ESP']);
const EN_SET = new Set(['ENGLISH', 'INGLES', 'INGLÉS', 'EN']);

// Debug: write every webhook hit (and the final lookup outcome) to the
// `webhook_log` table so we can diagnose failures end-to-end.
async function logHit(payload: Record<string, unknown>): Promise<void> {
  try {
    await supabaseAdmin.from('webhook_log').insert({
      source: 'twilio-sms-reply',
      payload,
    });
  } catch (e) {
    console.error('logHit failed:', errToString(e));
  }
}

/** Best-effort: return the hotel's public base URL for links embedded in SMS.
 *  Mirrors whatever /api/send-shift-confirmations used on the outbound leg. */
function resolveBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    'https://hotelops-ai.vercel.app'
  );
}

export async function POST(req: NextRequest) {
  try {
    // Twilio sends form-encoded; some legacy senders send JSON.
    let fromNumber: string | undefined;
    let text: string | undefined;
    let rawBodyForLog = '';
    let rawBodyForSig = '';

    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const jsonText = await req.text();
      rawBodyForLog = jsonText;
      const body = JSON.parse(jsonText) as { fromNumber?: string; From?: string; text?: string; Body?: string };
      fromNumber = body.fromNumber ?? body.From;
      text = body.text ?? body.Body;
    } else {
      const rawBody = await req.text();
      rawBodyForLog = rawBody;
      rawBodyForSig = rawBody;
      const params = new URLSearchParams(rawBody);
      fromNumber = params.get('From') ?? params.get('fromNumber') ?? undefined;
      text = params.get('Body') ?? params.get('text') ?? undefined;
    }

    // Validate the Twilio signature on form-encoded webhooks (the only
    // shape Twilio actually sends). JSON callers are legacy/internal and
    // are bypassed — but the route only does write-ish work after staff
    // lookup succeeds, so spoofing JSON gains nothing without first
    // matching a real phone in our DB.
    if (rawBodyForSig) {
      const ok = await verifyTwilioSignature(req, rawBodyForSig);
      if (!ok) {
        // Don't log the body — it might be the attacker's payload.
        await logHit({ stage: 'twilio_signature_invalid' });
        return twimlOk();
      }
    }

    // Idempotency: Twilio retries inbound webhooks on non-2xx responses
    // (and occasionally even after 2xx, on flaky transports). We always
    // return 200 so retries shouldn't happen, but a duplicate fire would
    // double-send the language-switch confirmation SMS. MessageSid is
    // Twilio's globally-unique id for this inbound message — store it on
    // first sight and short-circuit on repeats.
    const messageSid = (() => {
      if (!rawBodyForSig) return null;
      const p = new URLSearchParams(rawBodyForSig);
      return p.get('MessageSid');
    })();
    if (messageSid) {
      const { data: dup } = await supabaseAdmin
        .from('webhook_log')
        .select('id')
        .eq('source', 'twilio-sms-reply-sid')
        .contains('payload', { MessageSid: messageSid })
        .limit(1)
        .maybeSingle();
      if (dup) {
        await logHit({ stage: 'duplicate_message_sid', sidSuffix: messageSid.slice(-6) });
        return twimlOk();
      }
      // Record the SID separately from the verbose received-log so the
      // dedup query stays fast (it only scans rows tagged with the SID
      // source).
      await supabaseAdmin.from('webhook_log').insert({
        source: 'twilio-sms-reply-sid',
        payload: { MessageSid: messageSid },
      });
    }

    await logHit({
      stage: 'received',
      contentType,
      // Mask the inbound number so webhook_log doesn't accumulate PII;
      // the matching query below uses the unmasked variants.
      fromNumber: maskPhone(fromNumber),
      textLen: text?.length ?? 0,
      rawBodyLen: rawBodyForLog.length,
    });

    if (!fromNumber || !text) {
      await logHit({ stage: 'drop_missing_from_or_text' });
      return twimlOk();
    }

    const phone164 = toE164(fromNumber);
    if (!phone164) return twimlOk();

    const reply = normalise(text);

    // Try a few likely phone_lookup values. The column is normalised on write
    // via `toE164(phone)`, so phone164 is the canonical match — but we also
    // try legacy shapes (raw, 10-digit, leading-1) in case older rows were
    // written before the normalisation was consistent.
    const digits = fromNumber.replace(/\D/g, '');
    const tenDigit = digits.length >= 10 ? digits.slice(-10) : digits;
    const variants = Array.from(new Set([
      phone164,
      fromNumber,
      tenDigit,
      `1${tenDigit}`,
    ].filter(Boolean) as string[]));

    // 1) Find the staff row. `.in('phone_lookup', variants)` returns any staff
    //    whose normalised phone matches one of our candidates.
    const { data: staffMatches, error: staffErr } = await supabaseAdmin
      .from('staff')
      .select('id, property_id, name, language')
      .in('phone_lookup', variants);

    if (staffErr) {
      await logHit({ stage: 'staff_lookup_error', error: staffErr.message });
      return twimlOk();
    }

    // Ambiguity: when two staff rows share a phone (married couple, etc.),
    // we want the one with an open shift_confirmation — that's almost
    // certainly who's actually replying. Falling back to "most recently
    // updated" picked whoever Maria last edited in the staff modal, which
    // bore no relation to the inbound message.
    let staff = (staffMatches ?? [])[0] ?? null;
    if ((staffMatches ?? []).length > 1) {
      const ids = (staffMatches ?? []).map(s => s.id as string);
      const { data: ownerOfOpenConf } = await supabaseAdmin
        .from('shift_confirmations')
        .select('staff_id')
        .in('staff_id', ids)
        .in('status', ['sent', 'pending'])
        .order('sent_at', { ascending: false, nullsFirst: false })
        .limit(1);
      const winner = ownerOfOpenConf?.[0]?.staff_id;
      if (winner) {
        const candidate = (staffMatches ?? []).find(s => s.id === winner);
        if (candidate) staff = candidate;
      } else {
        // No open confirmation for any of them — fall back to most recently
        // updated, same as before.
        const { data: newest } = await supabaseAdmin
          .from('staff')
          .select('id, property_id, name, language')
          .in('phone_lookup', variants)
          .order('updated_at', { ascending: false })
          .limit(1);
        if (newest && newest[0]) staff = newest[0];
      }
    }

    if (!staff) {
      await logHit({ stage: 'no_staff_match', variants });
      return twimlOk();
    }

    // 2) Find the newest open shift_confirmation for this staff_id.
    const { data: confs, error: confErr } = await supabaseAdmin
      .from('shift_confirmations')
      .select('token, property_id, staff_id, staff_name, staff_phone, shift_date, status, language')
      .eq('staff_id', staff.id)
      .in('status', ['sent', 'pending'])
      .order('sent_at', { ascending: false, nullsFirst: false })
      .limit(1);

    if (confErr) {
      await logHit({ stage: 'conf_lookup_error', error: confErr.message });
      return twimlOk();
    }

    const conf = (confs ?? [])[0];
    if (!conf) {
      await logHit({ stage: 'no_open_confirmation', staffId: staff.id });
      return twimlOk();
    }

    await logHit({
      stage: 'after_lookup',
      reply,
      phone164,
      staffId: staff.id,
      token: conf.token,
      shiftDate: conf.shift_date,
    });

    // Hotel name for signoff. One extra round-trip, but cheap.
    const { data: prop } = await supabaseAdmin
      .from('properties')
      .select('name')
      .eq('id', conf.property_id)
      .maybeSingle();
    const hotelName = prop?.name || 'the hotel';

    const firstName = (conf.staff_name ?? staff.name ?? 'there').split(' ')[0];
    const baseUrl = resolveBaseUrl();
    const hkUrl = `${baseUrl}/housekeeper/${staff.id}?pid=${encodeURIComponent(conf.property_id as string)}`;

    const renderLinkMessage = (targetLang: 'en' | 'es'): string => {
      const label = formatShiftDate(conf.shift_date as string, targetLang);
      return targetLang === 'es'
        ? `Hola ${firstName}! Tu lista para ${label}:\n${hkUrl}\n\nFor English, reply ENGLISH\n\n– ${hotelName}`
        : `Hi ${firstName}! Your list for ${label}:\n${hkUrl}\n\nPara español, responde ESPAÑOL\n\n– ${hotelName}`;
    };

    const mirrorLang = async (next: 'en' | 'es'): Promise<void> => {
      // Mirror the language onto:
      //   - the staff row (canonical — what the admin Staff modal reads/
      //     writes and what the HK personal page seeds from)
      //   - EVERY open shift_confirmation row for this staff, not just the
      //     newest one. When a HK works back-to-back days, replying ESPAÑOL
      //     mid-day used to flip only tomorrow's row — today's morning
      //     resend then went out in the wrong language.
      const [{ error: staffUpdErr }, { error: confUpdErr }] = await Promise.all([
        supabaseAdmin.from('staff').update({ language: next }).eq('id', staff!.id),
        supabaseAdmin
          .from('shift_confirmations')
          .update({ language: next })
          .eq('staff_id', staff!.id)
          .in('status', ['sent', 'pending', 'confirmed']),
      ]);
      if (staffUpdErr) console.error('[sms-reply] staff language update failed:', staffUpdErr.message);
      if (confUpdErr) console.error('[sms-reply] confirmation language update failed:', confUpdErr.message);
    };

    // ── ESPAÑOL — switch to Spanish and resend the link ─────────────────────
    if (ES_SET.has(reply)) {
      await mirrorLang('es');
      await sendSms(phone164, renderLinkMessage('es'));
      return twimlOk();
    }

    // ── ENGLISH — switch to English and resend the link ─────────────────────
    if (EN_SET.has(reply)) {
      await mirrorLang('en');
      await sendSms(phone164, renderLinkMessage('en'));
      return twimlOk();
    }

    // ── Anything else — friendly ack, point at their link ───────────────────
    const lang: 'en' | 'es' = (conf.language as 'en' | 'es') ?? 'en';
    const hint = lang === 'es'
      ? `¡Gracias, ${firstName}! Abre tu enlace para ver tu lista.\n– ${hotelName}`
      : `Thanks, ${firstName}! Open your link to see your list.\n– ${hotelName}`;
    await sendSms(phone164, hint);

    return twimlOk();
  } catch (err) {
    const msg = errToString(err);
    console.error('sms-reply error:', msg);
    try {
      await logHit({ stage: 'handler_error', error: msg });
    } catch {}
    // Always 200 so Twilio doesn't retry
    return twimlOk();
  }
}
