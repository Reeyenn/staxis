/**
 * Per-property hourly rate limit for SMS-firing endpoints.
 *
 * Storage: a single Postgres table `api_limits` keyed by
 * (property_id, endpoint, hour_bucket). On each call we INCREMENT and
 * compare against a per-endpoint cap. Hits are atomic (a single SQL
 * upsert) so two concurrent requests can't both squeak under the limit.
 *
 * Why Postgres and not Redis: we already have a single Postgres
 * dependency, and the SMS-fire rate is at most ~1 RPS per property at
 * peak. The cost of one extra round-trip per SMS is acceptable. If we
 * ever need higher throughput, swap the body of `checkAndIncrement`
 * with an Upstash Redis call without touching call sites.
 *
 * Migration `0008_api_limits.sql` creates the table.
 */

import { createHash } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

/** Endpoint identifier — keep these short and stable. */
export type RateLimitEndpoint =
  | 'send-shift-confirmations'
  | 'help-request'
  | 'notify-backup'
  | 'morning-resend'
  | 'sms-reply-resend'
  | 'test-sms-flow'
  | 'sync-room-assignments'
  | 'populate-rooms-from-plan'
  | 'notify-housekeepers-sms'
  // PMS onboarding endpoints — tight caps because each onboarding
  // job spawns a Fly worker that potentially burns Claude tokens.
  // A malicious authenticated user shouldn't be able to queue 1000
  // jobs and exhaust the daily budget.
  | 'pms-save-credentials'
  | 'pms-onboard'
  // Admin actions that incur Claude API cost. Even though only admins
  // hit them, a compromised admin account or scripted retry storm
  // could rack up real spend. Cap at 10/hr per property.
  | 'admin-regenerate-recipe'
  // Invoice OCR — Claude Vision call per image ($0.003-0.01/scan).
  // Maria might scan 5-10 invoices a week in normal use; 50/hr per
  // property is generous headroom. A compromised session or buggy
  // retry loop hits the cap fast. May 2026 audit pass-5.
  | 'scan-invoice'
  // Shelf photo counting — same Claude Vision pricing as scan-invoice.
  // Originally shipped without a cap; Codex audit (pass-6) flagged it
  // as the largest unbounded-spend exposure in the inventory surface.
  | 'photo-count'
  // Public signup — keyed on a per-IP UUID (sha256(ip) → UUID shape).
  // No auth gate, creates auth.users + properties + Stripe customer +
  // bcrypt CPU work, so trivially abusable without a rate cap. (Pass-3
  // fix — H6.)
  | 'signup-ip'
  // Public join-code signup and invite acceptance — IP-keyed. Both
  // create auth.users without any prior auth gate and do bcrypt CPU
  // work; codes/tokens are low-entropy enough that brute-force or
  // token-spray attacks matter. (Codex audit 2026-05-12.)
  | 'auth-use-join-code'
  | 'auth-accept-invite'
  // Onboard wizard PATCH + GET — IP-keyed. Pre-account paths (steps 1-3)
  // are gated only by a hotel-join-code, which is brute-forceable at
  // ~50 bits without a rate limit. Without this cap, an attacker could
  // enumerate codes by hammering /api/onboard/wizard. Same 10/hr bucket
  // shape as auth-use-join-code. (Security review 2026-05-16, Pattern G.)
  | 'onboard-wizard'
  // Phase M1.5 (2026-05-14) — transactional email send via Resend.
  // Keyed on the recipient (normalized email, plus-addressing collapsed)
  // so an admin can't accidentally spam alice@hotel.com by re-clicking
  // "send invite". 5/hour matches our most conservative outbound caps.
  | 'email-transactional';

/** Per-endpoint hourly caps. Tuned to "real-world ops use" headroom. */
const HOURLY_CAPS: Record<RateLimitEndpoint, number> = {
  // PMS onboarding — testing creds is cheap so 30/hr handles a GM
  // typo-fixing iteratively. Onboard kicks off a real CUA mapping
  // run that costs $1-3, so 5/hr is plenty (one onboarding usually
  // succeeds the first time; this leaves room for a few retries).
  'pms-save-credentials':       30,
  'pms-onboard':                 5,
  // Admin recipe regeneration costs $1-3 each. 10/hour/property is
  // generous for legitimate ops use; tight enough to stop a runaway.
  'admin-regenerate-recipe':    10,
  // Invoice scans cost $0.003-0.01 each; 50/hr per property absorbs
  // legitimate use (Maria scanning a stack of weekly invoices) but
  // caps runaway loops fast.
  'scan-invoice':               50,
  // Shelf photo counting — same per-call cost as scan-invoice; same cap.
  // A staff member doing inventory rounds might fire 20-30 photos in a
  // session; 50/hr per property covers that with headroom.
  'photo-count':                50,
  // Maria might re-send shift confirmations 2-3 times if she tweaks the
  // schedule. 10/hour gives plenty of room without unlimited resend abuse.
  'send-shift-confirmations': 10,
  // One HK rarely needs help more than a few times an hour.
  'help-request':              20,
  // Manager dispatching backups — same scale.
  'notify-backup':             20,
  // Cron route — one or two real calls per day max.
  'morning-resend':             5,
  // ENGLISH/ESPAÑOL replies look like loops if abused.
  'sms-reply-resend':          30,
  'test-sms-flow':             50,
  // Schedule autosave is debounced client-side but a runaway tab could
  // hammer this. 200/hr is "click 3x per minute for an hour" headroom.
  'sync-room-assignments':    200,
  'populate-rooms-from-plan':  20,
  // SMS fan-out to housekeepers — Maria might re-broadcast after schedule
  // tweaks. 30/hr covers normal use and stops a runaway loop dead.
  'notify-housekeepers-sms':   30,
  // Public signup — 5/hour per source IP. Real signups are rare; a
  // legitimate person filling out the form 5 times in an hour is
  // already a customer-support situation, not a happy path. Anything
  // higher is bot/abuse and should 429.
  'signup-ip':                  5,
  // Public join-code signup — 10/hour per source IP. Same logic as
  // 'signup-ip' (real signups are rare, anything higher is abuse).
  'auth-use-join-code':         10,
  'onboard-wizard':             10,
  // Invite acceptance — 10/hour per source IP. One-shot per token in
  // normal use; the cap exists to bound token-spray brute force.
  'auth-accept-invite':         10,
  // Phase M1.5 transactional email — keyed on recipient. 5/hour stops
  // an admin click-spamming "send invite" from blasting one inbox; a
  // legitimate admin re-sending after a typo has 4 retries before they
  // need to wait. Per-recipient (not per-property) so different hotels'
  // invites don't compete with each other.
  'email-transactional':         5,
};

/**
 * Hash a request's source IP into a deterministic UUID-shaped string,
 * suitable as the `pid` argument to checkAndIncrementRateLimit. Used
 * by routes (like /api/signup) that have no property_id at the time
 * they want to rate-limit. The same IP always maps to the same key,
 * so the bucket counts every request from that IP within an hour.
 *
 * IPv4 and IPv6 inputs are normalized lowercase; the hash is stable
 * across processes/regions. Fail-soft on missing IP — returns the
 * NO_PROPERTY_RATE_LIMIT_KEY so all "unknown IP" callers share one
 * bucket (which is itself a defense against header-spoofing attacks).
 */
export function ipToRateLimitKey(ip: string | null | undefined): string {
  const trimmed = (ip ?? '').trim().toLowerCase();
  if (!trimmed) return NO_PROPERTY_RATE_LIMIT_KEY;
  const h = createHash('sha256').update(trimmed).digest();
  // Format the first 16 bytes as a UUID (8-4-4-4-12 hex). Not a real
  // RFC4122 UUID — we don't set the version/variant bits — but it
  // satisfies the api_limits.property_id UUID column shape.
  return [
    h.slice(0, 4).toString('hex'),
    h.slice(4, 6).toString('hex'),
    h.slice(6, 8).toString('hex'),
    h.slice(8, 10).toString('hex'),
    h.slice(10, 16).toString('hex'),
  ].join('-');
}

/**
 * Sentinel UUID used as the property_id when an SMS-fan-out endpoint accepts
 * a payload without a `pid` (legacy callers). The zero-UUID is reserved for
 * "no specific property" and will rate-limit such calls in a single global
 * bucket — defense in depth against a runaway legacy caller hammering the
 * route. Real properties never use this UUID.
 */
export const NO_PROPERTY_RATE_LIMIT_KEY = '00000000-0000-0000-0000-000000000000';

/**
 * Check the rate limit for (property_id, endpoint) and increment the hour
 * counter atomically. Returns:
 *   { allowed: true }  → call may proceed
 *   { allowed: false, retryAfterSec, current, cap }  → caller should 429
 *
 * If the rate-limit table doesn't exist yet (e.g. running before the
 * migration is applied), we fail-open with a console warning rather than
 * blocking all SMS sends. Production should always have the migration
 * applied; this guard avoids a deploy-order footgun.
 */
export async function checkAndIncrementRateLimit(
  endpoint: RateLimitEndpoint,
  pid: string,
): Promise<
  | { allowed: true }
  | { allowed: false; retryAfterSec: number; current: number; cap: number }
> {
  const cap = HOURLY_CAPS[endpoint];
  const hourBucket = new Date().toISOString().slice(0, 13);  // "2026-04-27T17"
  try {
    // Atomic upsert: increment count, return new value.
    const { data, error } = await supabaseAdmin.rpc('staxis_api_limit_hit', {
      p_property_id: pid,
      p_endpoint: endpoint,
      p_hour_bucket: hourBucket,
    });
    if (error) {
      // ── Fail-open visibility (May 2026 audit pass-3) ──────────────
      // Production safety default: a Postgres hiccup must NOT block all
      // SMS sends. But the old code was a console.warn — invisible in
      // Vercel's log noise, completely undetected at fleet scale.
      // Promoted to log.error so it lands in Sentry + the doctor's
      // logging surface, with the endpoint + property tagged so
      // dashboards can chart "how many fail-opens did the SMS pipeline
      // eat today, on which routes". Paired with the doctor's new
      // api_limits_writable check that probes the same RPC.
      log.error('[ratelimit] rpc failed — FAILING OPEN', {
        endpoint, pid, rpcError: error.message,
        // Tag for Sentry dashboards (see src/lib/sentry.ts tag-lift).
        route: `ratelimit:${endpoint}`,
      });
      return { allowed: true };
    }
    const current = Number(data) || 0;
    if (current > cap) {
      // Compute seconds until the next hour bucket.
      const now = new Date();
      const nextHour = new Date(now);
      nextHour.setUTCMinutes(0, 0, 0);
      nextHour.setUTCHours(now.getUTCHours() + 1);
      const retryAfterSec = Math.max(1, Math.ceil((nextHour.getTime() - now.getTime()) / 1000));
      return { allowed: false, retryAfterSec, current, cap };
    }
    return { allowed: true };
  } catch (e) {
    log.error('[ratelimit] threw — FAILING OPEN', {
      endpoint, pid,
      err: e instanceof Error ? e : new Error(String(e)),
      route: `ratelimit:${endpoint}`,
    });
    return { allowed: true };
  }
}

/** Convenience: return a NextResponse for a denied limit. */
export function rateLimitedResponse(
  current: number,
  cap: number,
  retryAfterSec: number,
): Response {
  return new Response(
    JSON.stringify({
      error: 'rate_limited',
      detail: `${current}/${cap} for this property in the past hour. Try again in ${retryAfterSec}s.`,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSec),
      },
    },
  );
}
