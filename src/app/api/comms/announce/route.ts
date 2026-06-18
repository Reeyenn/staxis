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
import { commsContext, listAccessiblePropertyIds } from '@/lib/comms/route-helpers';
import { canForUserId } from '@/lib/capabilities/server';
import { postAnnouncement, createAckCampaign } from '@/lib/comms/core';
import { translateNoticeToSpanish } from '@/lib/notice-translate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30; // org-wide fan-out + one translate

interface Body { pid?: string; body?: string; requiresAck?: boolean; orgWide?: boolean }

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
  if (!ctx.ok) return ctx.response;

  if (!(await canForUserId(ctx.userId, 'post_announcements', ctx.pid))) {
    return err('posting announcements is restricted for your role at this property', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }

  const text = (body.body ?? '').trim();
  if (!text) {
    return err('announcement is empty', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }
  if (text.length > 2000) {
    return err('announcement too long (max 2000 chars)', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }

  const orgWide = body.orgWide === true;
  // Org-wide blasts are mandatory reads by definition; otherwise honor the flag.
  const requiresAck = orgWide ? true : body.requiresAck === true;

  const rl = await checkAndIncrementRateLimit('comms-send', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  // Translate to Spanish once for the legacy notice banner (best-effort). Reused
  // across every property in an org-wide blast.
  const bodyEs = ctx.lang === 'es' ? text : await translateNoticeToSpanish(text);

  // ── Org-wide mandatory-read campaign ──────────────────────────────────────
  if (orgWide) {
    // Derive the candidate targets FROM the caller's property scope — this is
    // the access check, so a campaign can never write into a hotel they can't reach.
    const candidatesRaw = await listAccessiblePropertyIds(ctx.role, ctx.propertyAccess);
    const candidates = candidatesRaw.includes(ctx.pid) ? candidatesRaw : [ctx.pid, ...candidatesRaw];
    if (candidates.length === 0) {
      return err('no properties to broadcast to', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    }
    // Re-check post_announcements PER target. property_access membership alone is
    // NOT enough — an admin may have switched this role OFF at some hotels via the
    // Access tab, and an org-wide mandatory-read blast must honor that per-hotel
    // restriction instead of forcing a notice into a hotel where it's revoked.
    // (Security audit 2026-06-18: org-wide fan-out previously skipped this.)
    const allowChecks = await Promise.all(
      candidates.map((p) => canForUserId(ctx.userId, 'post_announcements', p)),
    );
    const targets = candidates.filter((_, i) => allowChecks[i]);
    if (targets.length === 0) {
      return err('posting announcements is restricted for your role at the selected properties', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
    }

    const campaignId = await createAckCampaign(ctx.accountId, text.slice(0, 120));

    // Post one copy per property. senderStaffId is null ON PURPOSE: the author is
    // an account, not a per-property staff member. Resolving a staff id per
    // property would create phantom "active staff" rows at hotels they don't work
    // at, permanently inflating those properties' acknowledgement denominators.
    const results = await Promise.allSettled(
      targets.map((targetPid) => postAnnouncement(targetPid, {
        body: text,
        sourceLang: ctx.lang,
        senderStaffId: null,
        senderAccountId: ctx.accountId,
        bodyEs,
        requiresAck: true,
        ackCampaignId: campaignId,
      })),
    );
    const postedCount = results.filter((r) => r.status === 'fulfilled').length;
    const failedCount = results.length - postedCount;

    if (postedCount === 0) {
      return err('failed to post the campaign to any property', { requestId: ctx.requestId, status: 502, code: ApiErrorCode.UpstreamFailure, headers: ctx.headers });
    }

    return ok(
      { orgWide: true, campaignId, requiresAck: true, postedCount, failedCount, propertyCount: targets.length },
      { requestId: ctx.requestId, status: 201, headers: ctx.headers },
    );
  }

  // ── Single property (the original path; now with an optional require-ack) ──
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
