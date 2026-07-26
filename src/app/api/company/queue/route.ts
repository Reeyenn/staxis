/**
 * THE PORTFOLIO QUEUE — what a company-scope person sees instead of one hotel's
 * feed. COMPANY-SCOPE ONLY, service-role.
 *
 * GET
 *   → { ok, data: { scope, cards, brief, run, cap } }
 *   `scope` is null for everybody without a COMPANY-scope job — a hotel GM, a
 *   front-desk lead, a Staxis administrator, and every single-hotel account in
 *   the product today. That null is Wall A, and it is also the signal the client
 *   uses to render the ordinary hotel queue instead. There is no partial
 *   portfolio: either you oversee a company or this surface does not exist for
 *   you.
 *
 * POST { findingId, action }
 *   A verdict on a COMPANY-SCOPE card (a cross-hotel comparison, a portfolio
 *   aggregate). The same three verdicts a hotel card offers, with the same
 *   meanings — "Seen" silences the feed and says nothing about the outcome;
 *   "Handled it" closes it out; "Not doing this" stops the watching.
 *
 *   Deliberately NOT a route for climbed HOTEL cards. Those live in their
 *   hotel's own ledger and are silenced through /api/findings with that hotel's
 *   id, which is the same door the GM uses — one problem has one row and one
 *   verdict, whoever is looking at it.
 *
 * ─── WHY THERE IS NO propertyId PARAMETER ─────────────────────────────────
 * Nothing a caller sends decides which company this is about. The organization
 * id comes from the caller's own hats (`companyScopeFor`), and every hotel id
 * comes from `propertiesOfOrganization` on that id. There is no argument to
 * this route through which a second company could be named, which is Wall B at
 * this boundary.
 *
 * ─── WHY THIS GET DOES NOT WRITE shown_count ──────────────────────────────
 * /api/findings deliberately records which cards were on a manager's screen —
 * that write is how a check this hotel ignores earns its rest (demotion.ts).
 * Reusing it here would let a VP scrolling twelve hotels' problems demote
 * detectors at hotels they will never open. A boss reading over your shoulder
 * is not you reading.
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
import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';
import { loadManagerCaller } from '@/lib/team-auth';
import { buildPortfolioQueue, companyLocalToday, companyScopeFor } from '@/lib/company/vp-queue-server';
import { getPortfolioBrief } from '@/lib/company/vp-brief-server';
import { setCompanyFindingStatus } from '@/lib/company/company-findings';
import type { FindingStatus } from '@/lib/findings/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The three verdicts a company card offers. Same set, same meanings. */
const VERDICTS = ['known_problem', 'muted', 'resolved'] as const;
type Verdict = typeof VERDICTS[number];

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const caller = await loadManagerCaller(session.userId);
  if (!caller) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  try {
    const queue = await buildPortfolioQueue(caller);
    // Wall A. Not an error — this person simply does not oversee a company, and
    // the client renders their hotel's own queue.
    if (!queue) return ok({ scope: null, cards: [], brief: null, run: null }, { requestId });

    // Keyed on a REAL property id — api_limits.property_id FKs properties(id),
    // so a company id there would FK-violate and the endpoint would fail for the
    // wrong reason. The company is folded into the sub-key instead, so one
    // company's traffic cannot exhaust another's bucket even when they happen to
    // share an anchor hotel (they cannot, but the bucket should not depend on
    // that). Fails OPEN: nothing here is billable and losing a portfolio screen
    // to a limiter blip would be the worse failure.
    const anchor = queue.cards.find((c) => c.hotel)?.hotel?.propertyId ?? null;
    if (anchor) {
      const limit = await checkAndIncrementRateLimit('company-queue', anchor, {
        subKey: queue.organizationId,
      });
      if (!limit.allowed) {
        return err('Too many requests, try again shortly', {
          requestId,
          status: 429,
          code: ApiErrorCode.RateLimited,
          headers: { 'Retry-After': String(limit.retryAfterSec) },
        });
      }
    }

    const { localDate } = await companyLocalToday(queue.organizationId, new Date());
    const { brief } = await getPortfolioBrief({
      accountId: caller.accountId,
      input: {
        organizationId: queue.organizationId,
        localDate,
        hotelCount: queue.hotelCount,
        cards: queue.cards,
        run: queue.run,
        now: new Date(),
      },
    });

    return ok(
      {
        scope: {
          organizationId: queue.organizationId,
          organizationName: queue.organizationName,
          companyRole: queue.companyRole,
          hotelCount: queue.hotelCount,
        },
        cards: queue.cards,
        brief,
        run: queue.run,
        cap: queue.cap,
      },
      { requestId },
    );
  } catch (e) {
    // Deliberately an ERROR, not an empty portfolio. An empty queue is a claim
    // ("nothing across your hotels needs you") and a failed read has not earned
    // the right to make it.
    log.error('[company:queue:GET] failed', {
      requestId,
      err: e instanceof Error ? e.message : String(e),
    });
    return err('Could not load your portfolio', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}

interface PostBody {
  findingId?: unknown;
  action?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body) {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const idV = validateUuid(body.findingId, 'findingId');
  if (idV.error) {
    return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const actionV = validateEnum<Verdict>(body.action, VERDICTS, 'action');
  if (actionV.error) {
    return err(actionV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const caller = await loadManagerCaller(session.userId);
  if (!caller) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const scope = await companyScopeFor(caller);
  if (!scope) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  try {
    // The organization filter is the tenant wall — `company_findings` is
    // deny-all RLS and the id came from the caller's OWN hats, never from the
    // body. A company B finding id sent by a company A owner matches no row.
    const updated = await setCompanyFindingStatus(
      scope.organizationId,
      idV.value!,
      actionV.value! as FindingStatus,
      caller.accountId,
    );
    // Null means the filter matched nothing: either the id is bogus or it
    // belongs to another company. Same answer either way, so the response
    // cannot be used to probe another company's ids.
    if (!updated) {
      return err('No such finding', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }
    return ok({ status: updated.status }, { requestId });
  } catch (e) {
    log.error('[company:queue:POST] status change failed', {
      requestId,
      err: e instanceof Error ? e.message : String(e),
    });
    return err('Could not save that', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
