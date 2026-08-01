// ═══════════════════════════════════════════════════════════════════════════
// /api/companion/rules — the hotel's standing rules.
//
//   GET    ?pid=…             → { rules }
//   DELETE { pid, id }        → { removed }
//
// THERE IS NO POST HERE, AND THAT IS THE POINT. A standing rule is only ever
// created through the conversation, by the staxis_set_standing_rule tool, which
// reads the rule back and waits for a plain yes before writing. A create
// endpoint on this route would be a second door into the same table with none
// of that, and the whole charter clause is that the companion never acts
// without an explicit yes. Adding a form later means adding the confirmation
// too, not skipping it.
//
// WHO SEES WHAT
//   read    everyone signed in with access to this hotel. A person is governed
//           by these rules, so a person can read them. Same posture as the rest
//           of the told half of the Knows tab (canReadTold).
//   delete  managers only, re-checked here. The list renders a Remove button
//           only for a manager, and that is a render decision; this is the one
//           that counts.
// ═══════════════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import { commsContext, ONE_LIST_CTX } from '@/lib/comms/route-helpers';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import { validateUuid } from '@/lib/api-validate';
import { listStandingRules, removeStandingRule } from '@/lib/companion/rules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'), ONE_LIST_CTX);
  if (!ctx.ok) return ctx.response;

  const rl = await checkAndIncrementRateLimit(
    'companion-read',
    hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`),
  );
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const rules = await listStandingRules(ctx.pid);
  return ok(
    {
      rules: rules.map((r) => ({
        id: r.id,
        ruleText: r.ruleText,
        authorName: r.createdByName,
        authorRole: r.createdByRole,
        createdAt: r.createdAt,
      })),
      canRemove: ctx.isManager && ctx.hotelMutationAllowed,
    },
    { requestId: ctx.requestId, headers: ctx.headers },
  );
}

export async function DELETE(req: NextRequest): Promise<Response> {
  let body: { pid?: string; id?: unknown };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const ctx = await commsContext(req, typeof body.pid === 'string' ? body.pid : null, ONE_LIST_CTX);
  if (!ctx.ok) return ctx.response;

  if (!ctx.isManager || !ctx.hotelMutationAllowed) {
    return err('Only a manager at this hotel can remove a standing rule.', {
      requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers,
    });
  }

  const idV = validateUuid(body.id, 'id');
  if (idV.error) {
    return err(idV.error, {
      requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers,
    });
  }

  const rl = await checkAndIncrementRateLimit(
    'companion-write',
    hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`),
  );
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    // Scoped on property AND id inside the store, so an id belonging to another
    // hotel matches no row rather than deleting somebody else's rule.
    const result = await removeStandingRule({
      propertyId: ctx.pid,
      ruleId: idV.value!,
      accountId: ctx.accountId,
    });
    if (!result.ok) {
      return err('That did not save. Try again in a moment.', {
        requestId: ctx.requestId, status: 500, code: ApiErrorCode.RemoveFailed, headers: ctx.headers,
      });
    }
    if (!result.removed) {
      // Already gone, or never this hotel's. Same answer either way: telling a
      // caller which of those it was would confirm that some other hotel holds
      // a rule with that id.
      return err('That rule is no longer here.', {
        requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers,
      });
    }
    return ok(
      { removed: { id: result.removed.id, ruleText: result.removed.ruleText } },
      { requestId: ctx.requestId, headers: ctx.headers },
    );
  } catch (e) {
    log.error('[companion-rules] DELETE failed', {
      requestId: ctx.requestId, pid: ctx.pid, err: errToString(e),
    });
    return err('Internal server error', {
      requestId: ctx.requestId, status: 500, code: ApiErrorCode.InternalError, headers: ctx.headers,
    });
  }
}
