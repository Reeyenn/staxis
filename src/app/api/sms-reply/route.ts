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
import { parseStringField, parseUnionField } from '@/lib/db-mappers';
import {
  checkAndIncrementRateLimit,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import { env } from '@/lib/env';
import { captureException } from '@/lib/sentry';
import {
  twimlOk,
  forbidden,
  verifyTwilioSignature,
  reconstructWebhookUrl,
  toE164,
  makeWebhookLogger,
} from '@/lib/twilio-webhook';
import {
  ES_SET,
  EN_SET,
  classifyReply,
} from '@/lib/sms-reply-keywords';

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

// ES_SET / EN_SET / STOP_SET / START_SET / classifyReply / ReplyClass
// live in src/lib/sms-reply-keywords.ts so they can be unit-tested without
// standing up the full webhook plumbing. Imported above.

// Debug: write every webhook hit (and the final lookup outcome) to the
// `webhook_log` table so we can diagnose failures end-to-end. Phone-number
// fields are redacted before insertion — see makeWebhookLogger in
// src/lib/twilio-webhook.ts.
const logHit = makeWebhookLogger('twilio-sms-reply');

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
  return safeBaseUrl(env.NEXT_PUBLIC_APP_URL);
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
      // Audit M2: narrow each field at runtime — a JSON body that delivers
      // `From: 15551234567` (number) instead of a string used to slip past
      // the cast and crash `.replace()` downstream. typeof guards make the
      // dev-only path symmetric with the form-encoded branch below.
      let parsedJson: unknown;
      try { parsedJson = JSON.parse(jsonText); } catch { parsedJson = null; }
      if (parsedJson && typeof parsedJson === 'object') {
        const body = parsedJson as Record<string, unknown>;
        fromNumber = parseStringField(body.fromNumber) ?? parseStringField(body.From);
        text = parseStringField(body.text) ?? parseStringField(body.Body);
      }
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
    // Accept JSON ONLY when ALLOW_UNSIGNED_SMS_WEBHOOK is explicitly
    // set to '1' on this deploy. Previously this was gated on
    // `NODE_ENV !== 'production'`, but Vercel preview deploys and any
    // staging environment with NODE_ENV=production would still expose
    // the unsigned JSON path. Defaulting to closed forces opt-in via
    // a dedicated env var that ops can scrub from prod-shape deploys
    // entirely. Audit Flow 3 #14.
    if (!isFormEncoded && env.ALLOW_UNSIGNED_SMS_WEBHOOK !== '1') {
      await logHit({
        stage: 'json_rejected',
        contentType,
        fromHeader: fromNumber ?? null,
      });
      return forbidden('json payloads not accepted without ALLOW_UNSIGNED_SMS_WEBHOOK=1');
    }
    if (isFormEncoded) {
      const twilioWired = !!env.TWILIO_ACCOUNT_SID;
      const haveToken = !!env.TWILIO_AUTH_TOKEN;
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

    // Webhook dedup (audit/concurrency #7). Twilio re-delivers inbound
    // webhooks on any non-2xx response or operator request — without
    // dedup, the second delivery would fire another language-switch /
    // ack SMS to the housekeeper. INSERT-then-detect-conflict using
    // the same shape as stripe_processed_events.
    const messageSid = formParams['MessageSid']
      ?? formParams['SmsMessageSid']
      ?? null;
    if (messageSid) {
      const { error: dupErr } = await supabaseAdmin
        .from('processed_twilio_webhooks')
        .insert({
          message_sid: messageSid,
          webhook_kind: 'inbound-sms',
          metadata: {
            from: fromNumber ?? null,
            text_len: text?.length ?? 0,
          },
        });
      if (dupErr) {
        const code = (dupErr as { code?: string }).code;
        if (code === '23505') {
          // Already processed — Twilio's retry. Ack 2xx so they stop.
          await logHit({ stage: 'duplicate_webhook', messageSid });
          return twimlOk();
        }
        // Any OTHER error means the dedup table is unreachable. Fail
        // closed — Twilio will retry; meanwhile we don't risk a true
        // duplicate slipping through unchecked.
        log.error('[sms-reply] dedup insert failed', { err: dupErr, messageSid });
        await logHit({ stage: 'dedup_table_error', messageSid });
        return new NextResponse('', { status: 503 });
      }
    }

    // Comms-voice audit P2 (2026-05-22): minimize PII stored in webhook_log.
    // The previous shape persisted the full `text` and a 500-char
    // `rawBodyPreview` for every inbound SMS. A housekeeper texting personal
    // medical or employment info ended up with that content sitting in our
    // database. Twilio's own console retains the body if we ever genuinely
    // need to reconstruct an incident — we just need the MessageSid (kept
    // in the dedup table at line 287). Here we log classification + length
    // only, plus the already-redacted phone.
    await logHit({
      stage: 'received',
      contentType,
      fromNumber: fromNumber ?? null,
      textLen: text?.length ?? 0,
      rawBodyLen: rawBodyForLog.length,
    });

    if (!fromNumber || !text) {
      await logHit({
        stage: 'drop_missing_from_or_text',
        fromNumber,
        hasFromNumber: !!fromNumber,
        hasText: !!text,
        textLen: text?.length ?? 0,
      });
      return twimlOk();
    }

    const phone164 = toE164(fromNumber);
    if (!phone164) return twimlOk();

    // Comms-voice audit P1 (2026-05-22): STOP/START classification runs
    // BEFORE the rate-limit check so a rate-limited sender can still opt
    // out (compliance: opt-out is higher priority than rate-limiting), and
    // AFTER webhook dedup (line 281-309) so Twilio retries don't double-log
    // the same opt-out event.
    //
    // We send NO reply on STOP/START — Twilio's carrier handles the
    // confirmation template on its side. Replying would mean texting a
    // user who just asked us to stop, which is the bug we're fixing.
    const earlyNormalised = normalise(text);
    const earlyClass = classifyReply(earlyNormalised);
    if (earlyClass === 'STOP') {
      await logHit({
        stage: 'opt_out_request',
        replyClass: 'STOP',
        phone164,
        textLen: text.length,
      });
      return twimlOk();
    }
    if (earlyClass === 'START') {
      await logHit({
        stage: 'opt_in_request',
        replyClass: 'START',
        phone164,
        textLen: text.length,
      });
      return twimlOk();
    }

    // 2026-05-20 audit M3 — per-sender rate limit. Twilio signature
    // validation is the primary gate; this is defense in depth. Keyed
    // on the housekeeper's phone so a runaway sender can't flood the
    // route. We return twimlOk on cap-hit (rather than 429) so Twilio
    // doesn't retry-storm the webhook — silently dropping replies past
    // the cap is the right UX here. The cap is logged so a real abuse
    // signal still appears in Sentry / logs.
    const rl = await checkAndIncrementRateLimit(
      'sms-reply',
      hashToRateLimitKey(phone164),
    );
    if (!rl.allowed) {
      await logHit({
        stage: 'rate_limited',
        capHit: rl.cap,
        current: rl.current,
        retryAfterSec: rl.retryAfterSec,
      });
      return twimlOk();
    }

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

    const confRaw = (confs ?? [])[0];
    // Audit M3: validate the shift_confirmations row shape at the SELECT
    // boundary so a column rename produces "no_open_confirmation" instead
    // of building a URL with `?pid=undefined`. We need token, property_id,
    // shift_date as strings; language must be one of the supported codes.
    const conf = confRaw && typeof confRaw === 'object' ? (() => {
      const r = confRaw as Record<string, unknown>;
      const token = parseStringField(r.token);
      const property_id = parseStringField(r.property_id);
      const shift_date = parseStringField(r.shift_date);
      if (!token || !property_id || !shift_date) return null;
      return {
        token,
        property_id,
        shift_date,
        staff_name: parseStringField(r.staff_name) ?? null,
        language: parseUnionField(r.language, ['en', 'es'] as const, 'en'),
      };
    })() : null;
    if (!conf) {
      await logHit({ stage: 'no_open_confirmation', staffId: staff.id });
      return twimlOk();
    }

    // Comms-voice audit P2 (2026-05-22): `reply` is normalise()'d but still
    // free-form user text — a housekeeper texting "I am sick today" would
    // land here as "I AM SICK TODAY". Log classification instead so PII
    // doesn't leak into webhook_log on the post-lookup hop either.
    await logHit({
      stage: 'after_lookup',
      replyClass: classifyReply(reply),
      replyLen: reply.length,
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
    const hkUrl = `${baseUrl}/housekeeper/${staff.id}?pid=${encodeURIComponent(conf.property_id)}`;

    const renderLinkMessage = (targetLang: 'en' | 'es'): string => {
      const label = formatShiftDate(conf.shift_date, targetLang);
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
      //
      // M3 (type-safety audit): conf.token is already typed `string` by
      // parseStringField above, so no inline cast is needed.
      const { error: rpcErr } = await supabaseAdmin.rpc('staxis_set_staff_language', {
        p_staff: staff!.id,
        p_conf_token: conf.token,
        p_lang: next,
      });
      if (rpcErr) log.warn('[sms-reply] set_staff_language RPC failed', { err: rpcErr });
    };

    // Comms-voice audit P5 (2026-05-22): the three outbound `sendSms` calls
    // below used to throw on Twilio failure, which the outer catch turned
    // into a non-2xx response. That triggered Twilio's inbound-webhook retry,
    // which then re-fired the language-switch / friendly-ack on the next
    // delivery — duplicate outbound SMS to a housekeeper for a single
    // inbound. Webhook dedup is per-MessageSid (line 281-309), not
    // per-action, so the retry slips past it on the first one-shot send.
    //
    // Now: capture the failure to Sentry, log to webhook_log, and return
    // twimlOk so Twilio does NOT retry. We accept one missed outbound ack
    // over the retry-storm alternative.
    const safeOutboundSend = async (
      msg: string,
      subStage: 'lang-switch-es' | 'lang-switch-en' | 'friendly-ack',
    ): Promise<void> => {
      try {
        await sendSms(phone164, msg);
      } catch (e) {
        captureException(e, {
          subsystem: 'sms-reply',
          failure_mode: 'outbound_send_failed',
          subStage,
          phone: redactPhone(phone164),
        });
        await logHit({
          stage: 'outbound_send_failed',
          subStage,
          phone164,
          errMsg: (e instanceof Error ? e.message : String(e)).slice(0, 200),
        });
      }
    };

    // ── ESPAÑOL — switch to Spanish and resend the link ─────────────────────
    if (ES_SET.has(reply)) {
      await mirrorLang('es');
      await safeOutboundSend(renderLinkMessage('es'), 'lang-switch-es');
      return twimlOk();
    }

    // ── ENGLISH — switch to English and resend the link ─────────────────────
    if (EN_SET.has(reply)) {
      await mirrorLang('en');
      await safeOutboundSend(renderLinkMessage('en'), 'lang-switch-en');
      return twimlOk();
    }

    // ── Anything else — friendly ack, point at their link ───────────────────
    const lang = conf.language;
    const hint = lang === 'es'
      ? `¡Gracias, ${firstName}! Abre tu enlace para ver tu lista.\n– ${hotelName}`
      : `Thanks, ${firstName}! Open your link to see your list.\n– ${hotelName}`;
    await safeOutboundSend(hint, 'friendly-ack');

    return twimlOk();
  } catch (err) {
    const msg = errToString(err);
    log.error('sms-reply error', { err });
    try {
      await logHit({ stage: 'handler_error', error: msg });
    } catch (logErr) {
      // Audit M5: the previous } catch {} swallowed the meta-failure
      // silently. logHit already self-catches internally, but a future
      // refactor of that helper could let an exception through — surface
      // it here so we'd notice.
      log.warn('sms-reply: logHit failed in error path', {
        err: logErr instanceof Error ? logErr : new Error(String(logErr)),
      });
    }
    // Always 200 so Twilio doesn't retry
    return twimlOk();
  }
}
