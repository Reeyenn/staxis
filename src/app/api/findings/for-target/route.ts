/**
 * "Does this hotel have an open pattern about THIS thing?" — the one lookup
 * behind the chip that appears on room 214's work order and on an inventory
 * item's own record. MANAGER ONLY, service-role.
 *
 * GET ?propertyId=<uuid>&kind=room&value=214
 *   → { ok, data: { kind, value, findingIds: [...] } }
 *
 * `findingIds` and nothing else. The chip is a SIGNPOST: it says a pattern
 * exists and links to the card in the queue, where the summary, the receipt, the
 * price range and the three verdicts already live. Sending the summary here
 * would create a second copy of a card's content that has to be kept in sync
 * with the queue's — which is precisely the "duplicated card state" the founder
 * ruled out. An id is enough to draw a link, and an id cannot drift.
 *
 * WHY `value` IS REQUIRED, AND WHY THAT IS A PRODUCT RULE RATHER THAN A
 * VALIDATION DETAIL
 * The decision was "on the thing, not the tab". A route that answered "give me
 * every finding for this hotel" would be a tab-level feed, and the strip at the
 * top of the Maintenance tab would be one afternoon away from existing. So there
 * is no such request to make: without a specific thing this endpoint is a 400.
 *
 * WHY THE property_id FILTER IS THE TENANT WALL HERE
 * `findings` is deny-all to anon AND authenticated (migration 0360) — there is
 * no RLS policy standing behind this route. The read goes through
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
import { validateUuid, validateEnum } from '@/lib/api-validate';
import { loadManagerCaller, managerManagesHotel } from '@/lib/team-auth';
import { listFindings } from '@/lib/findings/store';
import { findingsForTarget, normalizeTargetValue } from '@/lib/findings/targeting';
import type { FindingTargetKind } from '@/lib/findings/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS: readonly FindingTargetKind[] = ['room', 'inventory_item', 'preventive_task'] as const;

/**
 * How many of this hotel's live findings to weigh.
 *
 * The runner's own per-detector caps (DetectorDeclaration.maxPerRun) keep a
 * hotel's open set far below this in practice; 200 is the same ceiling the queue
 * route reads with, so the chip and the queue can never disagree about what is
 * open because one of them looked at a shorter list.
 */
const SCAN_LIMIT = 200;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const params = new URL(req.url).searchParams;

  const pidV = validateUuid(params.get('propertyId'), 'propertyId');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const propertyId = pidV.value!;

  const kindV = validateEnum<FindingTargetKind>(params.get('kind'), KINDS, 'kind');
  if (kindV.error) {
    return err(kindV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // No thing, no answer. See the header: this is the product rule that keeps
  // the chip on the thing and off the tab.
  const value = normalizeTargetValue(params.get('value'));
  if (!value) {
    return err('value is required — this lookup answers for one thing, never for a whole hotel', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const caller = await loadManagerCaller(session.userId);
  if (!caller || !managerManagesHotel(caller, propertyId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  try {
    const rows = await listFindings(propertyId, {
      statuses: ['open', 'updated'],
      limit: SCAN_LIMIT,
    });
    const matched = findingsForTarget(rows, kindV.value!, value);
    return ok(
      { kind: kindV.value!, value, findingIds: matched.map((f) => f.id) },
      { requestId },
    );
  } catch (e) {
    // An error, not an empty list. "No pattern here" is a CLAIM about this
    // hotel's room, and a failed read has no right to make it — the chip
    // renders nothing on an error, which is the same as no pattern to look at,
    // but the log says which one actually happened.
    log.error('[findings:for-target] failed', {
      requestId,
      err: e instanceof Error ? e.message : String(e),
    });
    return err('Could not check for patterns', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
