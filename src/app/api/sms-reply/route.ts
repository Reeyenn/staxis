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
import { log } from '@/lib/log';
import { safeBaseUrl, redactPhone } from '@/lib/api-validate';
import twilio from 'twilio';

// Twilio expects TwiML (XML), not JSON. An empty <Response/> tells Twilio
// "handled, send no auto-reply" — we've fired our own sendSms() already.
function twimlOk(): NextResponse {
  return new NextResponse(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    { headers: { 'Content-Type': 'text/xml; charset=utf-8' } },
  );
}

// 403 forbidden — used when the X-Twilio-Signature check fails. Returning
// a non-2xx makes Twilio retry, which is what we want for a transient
// signing-key drift, but the body is irrelevant for the rejection.
function forbidden(reason: string): NextResponse {
  return new NextResponse(reason, {
    status: 403,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * Verify the X-Twilio-Signature header so anyone outside Twilio can't post
 * to this webhook and trigger SMS sends through our account or spoof a
 * housekeeper's reply. Twilio computes the signature as
 *   HMAC-SHA1( authToken, fullUrl + sortedParamsConcatenated )
 * and base64-encodes it. We delegate to the official `twilio` SDK's
 * `validateRequest` helper which handles the form-encoded path.
 *
 * For JSON bodies we fall back to comparing against the URL with no params
 * (Twilio's recommended form for non-form-encoded webhooks). In practice
 * Twilio always posts form-encoded for SMS replies, but we keep the JSON
 * path so a future migration doesn't break.
 *
 * Behind a Vercel proxy the request URL must be reconstructed from the
 * `X-Forwarded-*` headers — `req.url` is already correct for Next on Vercel,
 * but we read it explicitly to make the matching obvious.
 */
function verifyTwilioSignature(
  url: string,
  signature: string | null,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return false;
  try {
    return twilio.validateRequest(authToken, signature, url, params);
  } catch {
    return false;
  }
}

/**
 * Reconstruct the public URL Twilio used when computing the signature.
 * On Vercel `req.nextUrl` is the deployed URL (https://hotelops-ai.vercel.app/...)
 * because Next normalises the proxy headers for us. But we strip out the
 * `_next/data` and locale prefixes that App Router can sometimes add — the
 * Twilio dashboard's webhook URL is the bare path.
 */
function reconstructWebhookUrl(req: NextRequest): string {
  // Prefer the X-Forwarded headers so we match exactly what Twilio saw.
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host  = req.headers.get('x-forwarded-host')  ?? req.headers.get('host') ?? new URL(req.url).host;
  const path  = new URL(req.url).pathname;
  const search = new URL(req.url).search;
  return `${proto}://${host}${path}${search}`;
}

function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
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
//
// PII redaction: any field that holds a phone number is redacted to
// "+1***1234" before insertion. webhook_log is service-role only via
// RLS, but we still don't want full E.164 phones in cleartext on disk.
// If a future migration mistakenly opens read access to the table the
// blast radius stays small.
async function logHit(payload: Record<string, unknown>): Promise<void> {
  try {
    const PHONE_KEYS = new Set([
      'fromNumber', 'fromHeader', 'phone', 'phone164',
      'staffPhone', 'From',
    ]);
    const redacted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (PHONE_KEYS.has(k) && typeof v === 'string') {
        redacted[k] = redactPhone(v);
      } else {
        redacted[k] = v;
      }
    }
    await supabaseAdmin.from('webhook_log').insert({
      source: 'twilio-sms-reply',
      payload: redacted,
    });
  } catch (e) {
    log.warn('sms-reply logHit failed', { err: e });
  }
}

/**
 * Return the hotel's public base URL for links embedded in SMS replies.
 *
 * IMPORTANT: this used to read NEXT_PUBLIC_* envs and trust them blindly.
 * If any of those envs were tampered with (or drifted across deploys),
 * the SMS would carry a link pointing at an attacker-controlled host —
 * and housekeepers click these links without scrutiny. The safeBaseUrl()
 * helper enforces a whitelist of known-good origins (defined in
 * api-validate.ts) so the worst case is we fall back to the canonical
 * production URL instead of a phishing host.
 */
function resolveBaseUrl(): string {
  const candidate =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    'https://getstaxis.com';
  return safeBaseUrl(candidate);
}

export async function POST(req: NextRequest) {
  try {
    // Twilio sends form-encoded; some legacy senders send JSON.
    let fromNumber: string | undefined;
    let text: string | undefined;
    let rawBodyForLog = '';
    // For form-encoded payloads we also build a `params` map so we can pass
    // it to Twilio's signature validator.
    let formParams: Record<string, string> = {};

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
      const params = new URLSearchParams(rawBody);
      fromNumber = params.get('From') ?? params.get('fromNumber') ?? undefined;
      text = params.get('Body') ?? params.get('text') ?? undefined;
      params.forEach((value, key) => { formParams[key] = value; });
    }

    // ── Twilio signature verification ─────────────────────────────────────
    // Without this, anyone can POST to this URL with arbitrary `From` /
    // `Body` and trigger sendSms() callbacks through our Twilio account
    // (potentially racking up charges and spoofing housekeeper replies).
    //
    // The April 16 bug-tracker run found this route was open. Adding it
    // now via the official `twilio` SDK's `validateRequest`.
    //
    // 2026-05-12: Codex audit flagged that JSON requests were accepted
    // without ANY signature check. Twilio doesn't sign JSON SMS webhooks
    // — so the JSON path was a free pass for anyone with the URL.
    // Restrict JSON to non-production environments only (for ad-hoc dev
    // testing); production traffic is form-encoded from Twilio.
    //
    // Fail-closed: if TWILIO_ACCOUNT_SID is set on this deploy (Twilio is
    // actually wired up) but TWILIO_AUTH_TOKEN is missing, the signature
    // check would silently no-op and leave the route open. Refuse to
    // process — this is config drift, not a dev environment. Pure-dev
    // setups (no SID, no token) still pass through unsigned because
    // there's no Twilio side to spoof.
    const signatureHeader = req.headers.get('x-twilio-signature');
    const isFormEncoded = !contentType.includes('application/json');
    if (!isFormEncoded && process.env.NODE_ENV === 'production') {
      await logHit({
        stage: 'json_rejected_in_production',
        contentType,
        fromHeader: fromNumber ?? null,
      });
      return forbidden('json payloads not accepted in production');
    }
    if (isFormEncoded) {
      const twilioWired = !!process.env.TWILIO_ACCOUNT_SID;
      const haveToken = !!process.env.TWILIO_AUTH_TOKEN;
      if (twilioWired && !haveToken) {
        await logHit({
          stage: 'config_drift_missing_auth_token',
          fromHeader: fromNumber ?? null,
        });
        return forbidden('sms-reply not configured (auth token missing)');
      }
      if (haveToken) {
        const url = reconstructWebhookUrl(req);
        const ok = verifyTwilioSignature(url, signatureHeader, formParams);
        if (!ok) {
          await logHit({
            stage: 'signature_invalid',
            url,
            hasSignatureHeader: !!signatureHeader,
            fromHeader: fromNumber ?? null,
          });
          return forbidden('invalid twilio signature');
        }
      }
    }

    await logHit({
      stage: 'received',
      contentType,
      fromNumber: fromNumber ?? null,
      text: text ?? null,
      rawBodyLen: rawBodyForLog.length,
      rawBodyPreview: rawBodyForLog.slice(0, 500),
    });

    if (!fromNumber || !text) {
      await logHit({ stage: 'drop_missing_from_or_text', fromNumber, text });
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

    // Ambiguity: if two different staff rows match the same number (shouldn't
    // happen, but defensive), pick the most recently-updated one.
    let staff = (staffMatches ?? [])[0] ?? null;
    if ((staffMatches ?? []).length > 1) {
      const { data: newest } = await supabaseAdmin
        .from('staff')
        .select('id, property_id, name, language')
        .in('phone_lookup', variants)
        .order('updated_at', { ascending: false })
        .limit(1);
      if (newest && newest[0]) staff = newest[0];
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
      // Mirror the language onto both places so everything stays in sync:
      // the staff row (canonical — what the admin Staff modal reads/writes
      // and what the HK personal page seeds from) and the current
      // shift_confirmation row.
      //
      // Audit P0.3 (2026-05-17): previously these were two parallel
      // .update()s with errors only logged. One could land and the other
      // fail silently, then tomorrow's outgoing SMS picks the stale
      // language from whichever side won the race. Now atomic via RPC —
      // both rows update or neither does. See
      // supabase/migrations/0134_rpc_set_staff_language.sql.
      const { error: rpcErr } = await supabaseAdmin.rpc('staxis_set_staff_language', {
        p_staff: staff!.id,
        p_conf_token: conf.token as string,
        p_lang: next,
      });
      if (rpcErr) log.warn('[sms-reply] set_staff_language RPC failed', { err: rpcErr });
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
    log.error('sms-reply error', { err });
    try {
      await logHit({ stage: 'handler_error', error: msg });
    } catch (logErr) {
      log.warn('sms-reply: logHit failed in error path', {
        err: logErr instanceof Error ? logErr : new Error(String(logErr)),
      });
    }
    // Always 200 so Twilio doesn't retry
    return twimlOk();
  }
}
