/**
 * Phase M1.5 (2026-05-14) — thin wrapper around Resend's HTTP API for
 * transactional sends. Raw fetch (no SDK) so we avoid a new dependency
 * — Resend's API is small enough that the SDK doesn't earn its weight.
 *
 * Why Resend (vs Supabase Auth's mailer):
 *   - Supabase's auth.admin.generateLink() ties the email to an auth
 *     event (magic link, password reset). Our "you're invited to onboard
 *     <hotel>" email is NOT auth-gated — the recipient hasn't created
 *     an account yet, the URL is just a static link.
 *   - Resend gives us per-message tracking, custom from address, tags
 *     for analytics, and decoupling from Supabase Auth's quota.
 *
 * Domain status: getstaxis.com is on Cloudflare (per project memory).
 * The 'from' address must use a verified Resend sending domain. If not
 * yet verified at the time of first send, the response will fail with
 * a clear "domain not verified" error and we log it.
 *
 * Failure handling: if a send fails, we LOG (admin_audit_log) and
 * RETURN the error to the caller — we do NOT throw. Callers decide
 * whether the failure is fatal (e.g., admin invite send is best-effort;
 * the URL is still copyable in the modal).
 */

import { createHash } from 'crypto';
import { writeAudit } from '@/lib/audit';
import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';

const RESEND_API_URL = 'https://api.resend.com/emails';

// Phase M1.5: getstaxis.com is the verified sending domain. If you
// change this, update Resend domain settings + DKIM/SPF records.
const DEFAULT_FROM = 'Staxis <noreply@getstaxis.com>';

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  // Optional Resend tags for filtering in their dashboard / webhooks.
  tags?: Array<{ name: string; value: string }>;
  // Optional from override — defaults to noreply@getstaxis.com.
  from?: string;
  // Optional audit metadata. The standard write to admin_audit_log
  // includes action, target, and the recipient; this lets callers
  // attach context like "hotel name" or "invite role".
  auditContext?: {
    actorUserId?: string;
    actorEmail?: string;
    targetType?: string;
    targetId?: string;
    hotelId?: string;
    metadata?: Record<string, unknown>;
  };
}

export type SendEmailResult =
  | { ok: true; id: string }
  | { ok: false; error: string; status?: number };

/**
 * Send a transactional email via Resend.
 *
 * Per Phase M1.5 discipline:
 *   - Per-recipient rate limit: 5/hour. The first send for a given
 *     recipient passes; subsequent sends in the same hour return
 *     `{ ok: false, error: 'rate_limited' }` and are NOT sent.
 *   - All outcomes (success + every failure mode) write to
 *     admin_audit_log with action 'email.sent' or 'email.failed'.
 *   - Missing RESEND_API_KEY is a soft-fail returning ok=false rather
 *     than throwing — onboarding link is still copyable in the modal,
 *     so a missing API key shouldn't block hotel creation.
 */
export async function sendTransactionalEmail(
  params: SendEmailParams,
): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    const result: SendEmailResult = {
      ok: false,
      error: 'RESEND_API_KEY not configured',
    };
    await logEmailOutcome(params, result);
    return result;
  }

  // Per-recipient rate limit (5/hour cap registered in api-ratelimit.ts
  // under 'email-transactional'). The pid argument expects a UUID-shape
  // string, so we hash the normalized email into one — same pattern as
  // ipToRateLimitKey() for IP-keyed limits.
  const rateKey = emailToRateLimitKey(params.to);
  const limited = await checkAndIncrementRateLimit('email-transactional', rateKey);
  if (!limited.allowed) {
    const result: SendEmailResult = {
      ok: false,
      error: `rate_limited: ${limited.current}/${limited.cap} in current hour, retry after ${limited.retryAfterSec}s`,
    };
    await logEmailOutcome(params, result);
    return result;
  }

  const body = {
    from: params.from ?? DEFAULT_FROM,
    to: [params.to],
    subject: params.subject,
    html: params.html,
    text: params.text,
    tags: params.tags,
  };

  let res: Response;
  try {
    res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const result: SendEmailResult = {
      ok: false,
      error: `network: ${e instanceof Error ? e.message : String(e)}`,
    };
    await logEmailOutcome(params, result);
    return result;
  }

  let payload: { id?: string; message?: string; name?: string } = {};
  try {
    payload = await res.json();
  } catch {
    // Resend's response should always be JSON; if it isn't, fall back
    // to status code only. Log the body for debugging.
    console.error('[email/resend] non-JSON response', { status: res.status });
  }

  if (!res.ok || !payload.id) {
    const result: SendEmailResult = {
      ok: false,
      error: payload.message ?? payload.name ?? `HTTP ${res.status}`,
      status: res.status,
    };
    await logEmailOutcome(params, result);
    return result;
  }

  const result: SendEmailResult = { ok: true, id: payload.id };
  await logEmailOutcome(params, result);
  return result;
}

/**
 * Normalize the recipient for rate-limiting: lowercase, trimmed,
 * plus-addressing collapsed (alice+staxis@example.com → alice@example.com).
 * Exported so the test can verify the same recipient maps to the same
 * key regardless of casing or plus-tag.
 */
export function normalizeEmailForRateLimit(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  if (at < 0) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at);
  const plus = local.indexOf('+');
  return (plus >= 0 ? local.slice(0, plus) : local) + domain;
}

/**
 * Convert a normalized recipient into a UUID-shaped key acceptable to
 * checkAndIncrementRateLimit's pid parameter. Same pattern as
 * ipToRateLimitKey() — sha256 → first 16 bytes → UUID format.
 */
function emailToRateLimitKey(email: string): string {
  const normalized = normalizeEmailForRateLimit(email);
  const hash = createHash('sha256').update(`email:${normalized}`).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

async function logEmailOutcome(
  params: SendEmailParams,
  result: SendEmailResult,
): Promise<void> {
  const ctx = params.auditContext ?? {};
  try {
    await writeAudit({
      action: result.ok ? 'email.sent' : 'email.failed',
      actorUserId: ctx.actorUserId,
      actorEmail: ctx.actorEmail,
      targetType: ctx.targetType ?? 'email',
      targetId: ctx.targetId ?? params.to,
      hotelId: ctx.hotelId,
      metadata: {
        recipient: params.to,
        subject: params.subject,
        tags: params.tags,
        ...ctx.metadata,
        ...(result.ok ? { resendId: result.id } : { error: result.error, status: result.status }),
      },
    });
  } catch (e) {
    // writeAudit is best-effort per the project convention; log but
    // don't propagate the failure.
    console.error('[email/resend] audit write failed', e);
  }
}
