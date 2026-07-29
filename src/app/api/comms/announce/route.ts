/**
 * POST /api/comms/announce  — Body: { pid, body, requiresAck?, orgWide? }
 * Managers broadcast an announcement to everyone. This is the ONE broadcast
 * path: it posts to the Communications announcement feed AND mirrors to the
 * legacy housekeeping_notices banner (so housekeeper phones still show it).
 * Each reader sees it auto-translated into their language. NO SMS.
 *
 * requiresAck (additive, default false): demand an explicit "I read & understand"
 *   from every recipient and give the manager a live who-has/hasn't tracker.
 * orgWide (additive, default false): an owner/admin posts ONE mandatory-read
 *   announcement to ALL their accessible properties at once, grouped under a
 *   campaign so completion aggregates across properties. Org-wide is always
 *   require-ack. A normal announcement (both flags off) behaves exactly as before.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { requireSectionEnabled } from '@/lib/sections/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { accountCapabilityDecisionForProperty } from '@/lib/team-auth';
import { postAnnouncement } from '@/lib/comms/core';
import { translateNoticeToSpanish } from '@/lib/notice-translate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30; // org-wide fan-out + one translate

interface Body { pid?: string; body?: string; requiresAck?: boolean; orgWide?: boolean }

export async function POST(req: NextRequest): Promise<Response> {
  const deadlineAt = Date.now() + 12_000;
  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
  if (!ctx.ok) return ctx.response;

  const capabilityDecision = await accountCapabilityDecisionForProperty(
    ctx.userId,
    'post_announcements',
    ctx.pid,
    { requireMutation: true, requireManager: true },
  );
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(ctx.requestId);
  if (capabilityDecision === 'denied') {
    return err('posting announcements is restricted for your role at this property', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }

  // Section gate (add-on, on top of the tenant guard above): if Communications is off for this hotel, block this route.
  const sectionGate = await requireSectionEnabled(req, ctx.pid, 'communications');
  if (!sectionGate.ok) return sectionGate.response;

  const text = (body.body ?? '').trim();
  if (!text) {
    return err('announcement is empty', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }
  if (text.length > 2000) {
    return err('announcement too long (max 2000 chars)', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }

  const orgWide = body.orgWide === true;
  // Cross-hotel writes are deliberately disabled until they use the same
  // preview → exact targets → confirmation → commit reauthorization →
  // idempotency/audit contract as company Access. A boolean in one POST is not
  // meaningful confirmation and previously allowed stale legacy scope to fan
  // out into a transferred hotel.
  if (orgWide) {
    return err(
      'Cross-hotel announcements require an exact preview and confirmation workflow and are temporarily unavailable. Post to one hotel at a time.',
      { requestId: ctx.requestId, status: 409, code: ApiErrorCode.ValidationFailed, headers: ctx.headers },
    );
  }
  const requiresAck = body.requiresAck === true;

  const rl = await checkAndIncrementRateLimit('comms-send', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  // Translate to Spanish once for the legacy notice banner (best-effort). Reused
  // across every property in an org-wide blast.
  const bodyEs = ctx.lang === 'es'
    ? text
    : await translateNoticeToSpanish(text, 'communications.announcement_translation', {
        deadlineAt,
        abortSignal: req.signal,
        // The AI runtime records the spend itself (agent_costs, kind=background).
        ledger: {
          userId: ctx.accountId,
          propertyId: ctx.pid,
          requestId: ctx.requestId,
          feature: 'communications.announcement_translation',
        },
      });

  // ── Single property (the original path; now with an optional require-ack) ──
  // Re-resolve immediately before the write so a transfer/revocation during
  // translation cannot use the earlier context verdict.
  const commitDecision = await accountCapabilityDecisionForProperty(
    ctx.userId,
    'post_announcements',
    ctx.pid,
    { requireMutation: true, requireManager: true },
  );
  if (commitDecision === 'unavailable') return capabilityUnavailableResponse(ctx.requestId);
  if (commitDecision === 'denied') {
    return err('posting announcements is restricted for your role at this property', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }
  const res = await postAnnouncement(ctx.pid, {
    body: text,
    sourceLang: ctx.lang,
    senderStaffId: ctx.staffId,
    senderAccountId: ctx.accountId,
    bodyEs,
    requiresAck,
  });

  return ok({ id: res.id, requiresAck }, { requestId: ctx.requestId, status: 201, headers: ctx.headers });
}
