/**
 * POST /api/sms/callout
 *
 * Twilio inbound-SMS webhook for sick callouts. A housekeeper texts
 * SICK / OUT / ENFERMO / FUERA to the hotel's Twilio number; we look up
 * the sender phone, find the matching staff record, and create a
 * callout event with reported_by='sms'.
 *
 * Why a dedicated route (vs. extending /api/sms-reply):
 *   The shift-reply webhook (/api/sms-reply) handles ENGLISH/ESPAÑOL
 *   keywords for active shift confirmations. Co-mingling callout intent
 *   in the same handler would mean every shift-reply request hits the
 *   callout classifier — a bigger blast radius on bugs and harder to
 *   reason about. This route is single-purpose. Reeyen can point the
 *   Twilio number at whichever URL the operator prefers; the classifier
 *   in sms-parser.ts is pure and reusable from either route.
 *
 * Signature verification + dedup mirror the shift-reply route line-for-line
 * so the security posture is consistent.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import { recordWebhookLog } from '@/lib/event-recorder';
import { redactPhone } from '@/lib/api-validate';
import {
  checkAndIncrementRateLimit,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import twilio from 'twilio';
import { env } from '@/lib/env';
import {
  classifyCalloutSms,
  createCallout,
  runRedistributionForCallout,
  sendCalloutNotifications,
} from '@/lib/sick-callout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function twimlOk(): NextResponse {
  return new NextResponse(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    { headers: { 'Content-Type': 'text/xml; charset=utf-8' } },
  );
}

function twimlReply(message: string): NextResponse {
  // Escape XML special chars so a message body can't break out of the tag.
  const safe = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return new NextResponse(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`,
    { headers: { 'Content-Type': 'text/xml; charset=utf-8' } },
  );
}

function forbidden(reason: string): NextResponse {
  return new NextResponse(reason, {
    status: 403,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

function verifyTwilioSignature(
  url: string,
  signature: string | null,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!authToken) return false;
  try {
    return twilio.validateRequest(authToken, signature, url, params);
  } catch {
    return false;
  }
}

function reconstructWebhookUrl(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host  = req.headers.get('x-forwarded-host')  ?? req.headers.get('host') ?? new URL(req.url).host;
  const path  = new URL(req.url).pathname;
  const search = new URL(req.url).search;
  return `${proto}://${host}${path}${search}`;
}

async function logHit(payload: Record<string, unknown>): Promise<void> {
  try {
    const PHONE_KEYS = new Set(['fromNumber', 'fromHeader', 'phone', 'phone164', 'From']);
    const redacted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (PHONE_KEYS.has(k) && typeof v === 'string') {
        redacted[k] = redactPhone(v);
      } else {
        redacted[k] = v;
      }
    }
    await recordWebhookLog({
      source: 'twilio-sms-callout',
      payload: redacted,
    });
  } catch (e) {
    log.warn('[sms/callout] logHit failed', { err: e });
  }
}

function todayBusinessDate(): string {
  // Same convention as the rest of the app: business_date is the ISO date
  // of the calling instant in UTC. Properties on non-UTC timezones still
  // get a consistent date because the cron uses the same source.
  return new Date().toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
  try {
    // Twilio sends form-encoded; some test rigs send JSON.
    let fromNumber: string | undefined;
    let text: string | undefined;
    const formParams: Record<string, string> = {};

    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const jsonText = await req.text();
      try {
        const j = JSON.parse(jsonText) as { From?: unknown; Body?: unknown };
        fromNumber = typeof j.From === 'string' ? j.From : undefined;
        text = typeof j.Body === 'string' ? j.Body : undefined;
      } catch {
        // fall through with undefined
      }
    } else {
      const form = await req.formData();
      for (const [k, v] of form.entries()) {
        formParams[k] = typeof v === 'string' ? v : '';
      }
      fromNumber = formParams.From;
      text = formParams.Body;
    }

    // ── Webhook authentication (security audit 2026-06-26) ─────────────────
    // middleware skips /api/*, so this signature check is the ONLY auth on
    // the inbound webhook. The previous version skipped verification entirely
    // whenever TWILIO_AUTH_TOKEN was unset/blank — so during a config-drift
    // window (token dropped mid-rotation) an attacker could POST
    // `From=<real staff phone>&Body=SICK` to spoof a call-out, trigger room
    // reassignment, and fan out SMS. Mirror sms-reply's fail-closed posture.
    const isFormEncoded = !contentType.includes('application/json');

    // Twilio never signs JSON — only accept it when explicitly opted in
    // (local test rigs set ALLOW_UNSIGNED_SMS_WEBHOOK=1).
    if (!isFormEncoded && env.ALLOW_UNSIGNED_SMS_WEBHOOK !== '1') {
      await logHit({ stage: 'json_rejected', fromHeader: fromNumber ?? null, contentType });
      return forbidden('json payloads not accepted without ALLOW_UNSIGNED_SMS_WEBHOOK=1');
    }

    if (isFormEncoded) {
      const twilioWired = !!env.TWILIO_ACCOUNT_SID;
      const haveToken = !!env.TWILIO_AUTH_TOKEN;
      // Config drift: Twilio is wired up (SID present) but the auth token is
      // missing/blank → refuse rather than process unsigned.
      if (twilioWired && !haveToken) {
        await logHit({ stage: 'config_drift_missing_auth_token', fromHeader: fromNumber ?? null });
        return forbidden('callout webhook not configured (auth token missing)');
      }
      if (haveToken) {
        const url = reconstructWebhookUrl(req);
        const sig = req.headers.get('x-twilio-signature');
        const valid = verifyTwilioSignature(url, sig, formParams);
        if (!valid) {
          await logHit({
            stage: 'signature_failed',
            fromHeader: fromNumber ?? null,
            contentType, url,
          });
          return forbidden('invalid signature');
        }
      }
    }

    if (!fromNumber || !text) {
      await logHit({ stage: 'missing_fields', fromHeader: fromNumber ?? null, hasBody: !!text });
      return twimlOk();
    }

    // Rate-limit per source phone hashed. 20/hr is generous for a real
    // housekeeper who texts back twice, but bounds a runaway loop.
    const rl = await checkAndIncrementRateLimit(
      'callout-sms',
      hashToRateLimitKey(fromNumber),
    );
    if (!rl.allowed) {
      await logHit({ stage: 'rate_limited', fromNumber, retryAfterSec: rl.retryAfterSec });
      return twimlOk();
    }

    const classification = classifyCalloutSms(text);
    if (classification.kind === 'not_callout') {
      // Not a callout — log and ignore (the shift-reply webhook may handle
      // it if Twilio is also pointed there).
      await logHit({ stage: 'not_callout', fromNumber, body: text.slice(0, 200) });
      return twimlOk();
    }

    // Normalise sender → look up staff. Try the canonical E.164 first,
    // then a 10-digit fallback (US norm without country code).
    const e164 = toE164(fromNumber);
    const digits = fromNumber.replace(/\D/g, '');
    const phoneVariants = [e164, fromNumber, digits, digits.slice(-10)]
      .filter((p): p is string => !!p);

    const staffLookup = await supabaseAdmin
      .from('staff')
      .select('id, property_id, name, language')
      .in('phone_lookup', phoneVariants)
      .limit(1)
      .maybeSingle();

    if (staffLookup.error) {
      log.error('[sms/callout] staff lookup failed', { err: errToString(staffLookup.error) });
      await logHit({ stage: 'staff_lookup_error', fromNumber });
      return twimlOk();
    }
    if (!staffLookup.data) {
      // Phone not in our system. Don't reveal that to the sender — they
      // could be a wrong number, a scammer probing the webhook, or a
      // staff member who hasn't been added yet.
      await logHit({ stage: 'no_staff_match', fromNumber });
      return twimlOk();
    }

    const staff = staffLookup.data as {
      id: string; property_id: string; name: string; language: string | null;
    };
    const businessDate = todayBusinessDate();
    const language = staff.language === 'es' ? 'es' : 'en';

    const result = await createCallout(supabaseAdmin, {
      propertyId: staff.property_id,
      staffId: staff.id,
      businessDate,
      reportedBy: 'sms',
      reason: classification.reason,
      note: classification.note,
      // SMS callouts default to "now" — the housekeeper isn't going through
      // the mid-shift "when?" picker.
      leaveTiming: null,
    });

    // Fire redistribute + notifications inline. We respond with a TwiML
    // confirmation message so the housekeeper knows it landed.
    try {
      await runRedistributionForCallout(supabaseAdmin, result.calloutId);
      try {
        const fresh = await supabaseAdmin
          .from('callout_events')
          .select('*')
          .eq('id', result.calloutId)
          .maybeSingle();
        if (fresh.data) {
          await sendCalloutNotifications(supabaseAdmin, fresh.data);
        }
      } catch (notifyErr) {
        log.warn('[sms/callout] notification fanout failed', {
          calloutId: result.calloutId,
          err: errToString(notifyErr),
        });
      }
    } catch (redistErr) {
      log.warn('[sms/callout] inline redistribute failed; cron will retry', {
        calloutId: result.calloutId,
        err: errToString(redistErr),
      });
    }

    await logHit({
      stage: 'callout_recorded',
      fromNumber,
      staffId: staff.id,
      calloutId: result.calloutId,
      created: result.created,
      reason: classification.reason,
    });

    const ack =
      language === 'es'
        ? `Recibido. Tu ausencia fue registrada. Tus habitaciones se están repartiendo. Avísanos si esto fue un error.`
        : `Got it — your callout is recorded and your rooms are being redistributed. Reply if this was a mistake.`;
    return twimlReply(ack);
  } catch (caughtErr) {
    log.error('[sms/callout] unexpected error', { err: errToString(caughtErr) });
    await logHit({ stage: 'unexpected_error', err: errToString(caughtErr) });
    // Always return 2xx so Twilio doesn't retry an inherently-broken request.
    return twimlOk();
  }
}
