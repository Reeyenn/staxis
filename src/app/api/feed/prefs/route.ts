// ═══════════════════════════════════════════════════════════════════════════
// /api/feed/prefs — one person's choices about their Staxis list.
//   GET ?pid=...                 → { prefs }
//   PUT { pid, logbookInList }   → { prefs }
//
// Today it holds exactly one switch: "Include log book in Staxis". A new route
// rather than a field on an existing one because there was no per-person
// preference surface in the product at all — /api/settings/notifications is
// report-delivery shaped and orphaned since the report crons were deleted, and
// hanging an unrelated toggle off it would make two features share a lifecycle
// they do not share. A second per-person toggle later is a field here.
//
// NOT gated on the Communications section: the switch belongs to the Staxis
// list. See ONE_LIST_CTX.
// ═══════════════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import { commsContext, ONE_LIST_CTX } from '@/lib/comms/route-helpers';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { readFeedPrefs, writeFeedPrefs } from '@/lib/feed/prefs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'), ONE_LIST_CTX);
  if (!ctx.ok) return ctx.response;

  const rl = await checkAndIncrementRateLimit('comms-read', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const prefs = await readFeedPrefs(ctx.accountId, ctx.pid);
  return ok({ prefs }, { requestId: ctx.requestId, headers: ctx.headers });
}

export async function PUT(req: NextRequest): Promise<Response> {
  let body: { pid?: string; logbookInList?: unknown };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null, ONE_LIST_CTX);
  if (!ctx.ok) return ctx.response;

  if (typeof body.logbookInList !== 'boolean') {
    return err('logbookInList must be true or false', {
      requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers,
    });
  }

  // Keyed per person, not per property: a toggle a person flips is bounded by
  // how fast they can tap it, and a shared per-property bucket would let one
  // impatient manager lock out their colleagues.
  const rl = await checkAndIncrementRateLimit('feed-prefs-write', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const prefs = await writeFeedPrefs(ctx.accountId, ctx.pid, { logbookInList: body.logbookInList });
    return ok({ prefs }, { requestId: ctx.requestId, headers: ctx.headers });
  } catch (e) {
    log.error('[feed-prefs] PUT failed', { requestId: ctx.requestId, pid: ctx.pid, err: errToString(e) });
    return err('Internal server error', {
      requestId: ctx.requestId, status: 500, code: ApiErrorCode.InternalError, headers: ctx.headers,
    });
  }
}
