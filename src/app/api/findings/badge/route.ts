/**
 * GET /api/findings/badge?propertyId=<uuid>
 *   → { ok, data: { count } }
 *
 * One integer: how many "do this now" cards are waiting at this hotel. It is
 * the number on the Staxis pill in the nav bar, and it is read on every shell
 * mount and every time the tab comes back to the front — so it is deliberately
 * the cheapest read in the app (two `head: true` counts, no rows, no evidence
 * blobs, no judged-phrasing pass).
 *
 * WHY A SEPARATE ROUTE FROM /api/findings
 * The queue GET is not free and it is not idempotent: it loads up to 200 rows,
 * ranks them, and WRITES `shown_count` for whatever landed above the fold —
 * that write is how a detector earns its rest (src/lib/findings/demotion.ts).
 * Calling it to paint a badge would mean every page load in the app counted as
 * a manager looking at cards they never saw, and a detector could be demoted
 * into silence by navigation alone. This route only counts.
 *
 * WHAT COUNTS
 * Effective disposition `propose` — the judge's verdict when it has one, the
 * detector's default otherwise — on an open or updated finding. Nothing else:
 * `recommend`, `fyi`, `ask` and `drop` never light the badge. That is a
 * product decision, not an implementation detail (founder, 2026-07-26): the
 * badge means decisions, or it dies as noise.
 *
 * WHY THE property_id FILTER IS THE TENANT WALL HERE
 * `findings` is deny-all to anon and authenticated (migration 0360) — there is
 * no RLS policy to fall back on. The count goes through
 * src/lib/findings/store.ts, which routes through scopedDb(propertyId) and
 * applies the hotel filter before the query builder is handed back. The gate
 * that decides WHICH propertyId is legitimate is loadManagerCaller +
 * managerManagesHotel, right here.
 *
 * loadManagerCaller is the shared, schema-pinned account lookup. Do not
 * hand-roll another one: the last three times a route did, it selected a column
 * that does not exist (`accounts.name` most recently), PostgREST errored, the
 * route read the error as "no such account", and the feature was silently dead
 * for every user with a green build and a green suite.
 */

import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { loadManagerCaller, managerManagesHotel } from '@/lib/team-auth';
import { countProposeFindings } from '@/lib/findings/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const pidV = validateUuid(new URL(req.url).searchParams.get('propertyId'), 'propertyId');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const propertyId = pidV.value!;

  const caller = await loadManagerCaller(session.userId);
  if (!caller || !managerManagesHotel(caller, propertyId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  try {
    return ok({ count: await countProposeFindings(propertyId) }, { requestId });
  } catch (e) {
    // Deliberately an error, not `{ count: 0 }`. Zero is a CLAIM — "there is
    // nothing waiting for you" — and a failed read has not earned the right to
    // make it. The nav bar keeps whatever it last knew rather than quietly
    // going all-clear.
    log.error('[findings:badge] count failed', {
      requestId,
      err: e instanceof Error ? e.message : String(e),
    });
    return err('Could not count findings', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
