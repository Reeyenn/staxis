// ═══════════════════════════════════════════════════════════════════════════
// GET /api/worklist?pid=...[&view=assigned-by-me]
//
// The unified worklist: every open actionable item across the property (manual
// to-dos, complaints, work orders, inspection-due rooms, preventive tasks, due
// reminders, decisions waiting on a manager), normalized + sorted. Authenticated
// via commsContext (session + 2FA + property access). All reads go through
// supabaseAdmin in gatherWorklist — the browser never queries these tables
// directly.
//
// THREE VIEWS, ONE ROUTE, because they are three parts of one question:
//   (default)         what is on MY list
//   assigned-by-me    what I handed to somebody else, and where it got to
//   assignees         who I could hand something to, and who I am
// A task is on exactly one of the first two, never both — that is the founder's
// rule and answering both from one place is what keeps it true.
//
// NOT gated on the Communications section: the list lives on the Staxis tab
// now. See ONE_LIST_CTX.
// ═══════════════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import { commsContext, ONE_LIST_CTX } from '@/lib/comms/route-helpers';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { gatherAssignedByMe, gatherWorklist, listAssignees, worklistSeesAllSources } from '@/lib/worklist/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'), ONE_LIST_CTX);
  if (!ctx.ok) return ctx.response;

  // Per-property bucket — raw pid (api_limits FK). Read path → fails open.
  const rl = await checkAndIncrementRateLimit('worklist-read', ctx.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const view = searchParams.get('view');
    if (view === 'assigned-by-me') {
      const assigned = await gatherAssignedByMe(ctx.pid, ctx.staffId);
      return ok({ assigned }, { requestId: ctx.requestId, headers: ctx.headers });
    }
    if (view === 'assignees') {
      // Who a to-do can go to, plus who the caller is. On this route rather than
      // a new one because assignment is a worklist concern and the caller's
      // staff identity is already resolved here: a fourth surface for "list the
      // people" is a fourth thing to secure and keep in step with the
      // housekeeper exclusion, which lives in listAssignees.
      const people = await listAssignees(ctx.pid);
      return ok({ me: { staffId: ctx.staffId }, people }, { requestId: ctx.requestId, headers: ctx.headers });
    }

    // Floor staff (housekeeping/maintenance/staff) see only their manual to-dos;
    // complaints/work-orders/inspections/pm stay management + front-desk only.
    // The viewer narrows it once more, to what is on THIS person's plate.
    const items = await gatherWorklist(ctx.pid, {
      tasksOnly: !worklistSeesAllSources(ctx.role),
      viewer: {
        staffId: ctx.staffId,
        accountId: ctx.accountId,
        role: ctx.role,
        dept: ctx.dept,
      },
    });
    return ok({ items }, { requestId: ctx.requestId, headers: ctx.headers });
  } catch (e) {
    log.error('[worklist] GET failed', { requestId: ctx.requestId, pid: ctx.pid, err: errToString(e) });
    return err('Internal server error', {
      requestId: ctx.requestId, status: 500, code: ApiErrorCode.InternalError, headers: ctx.headers,
    });
  }
}
