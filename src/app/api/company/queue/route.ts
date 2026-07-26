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
 * ─── WHO GETS IN, AND WHAT FINANCE SEES ──────────────────────────────────
 * GET uses `loadSessionAccount`; the gate is `companyScopeFor`, which reads
 * nothing but the caller's own COMPANY-scope hats. It used to use
 * `loadManagerCaller`, and that was wrong in a way no test noticed: the manager
 * gate reads `accounts.role`, and the company vocabulary degrades
 * least-privilege into it — a `finance` hat becomes `front_desk`
 * (src/lib/company/roles.ts). So the picker deliberately admitted a company's
 * finance lead (see the bootstrap route's own note) and then this route answered
 * 403. She was shown the door to a room she was refused at.
 *
 * THE RULE, one line: a company-scope hat opens the company's queue, and what
 * it opens is decided by the hat, not by a degraded legacy word.
 *
 *   owner / vp   read the queue AND cast verdicts.
 *   finance      READ-ONLY. She sees the same cards, the same brief, the same
 *                money — the whole reason her job exists — and no verdict
 *                buttons. `canAct: false` in the payload is what tells the
 *                screen to draw it that way, so she never taps a control that
 *                403s. Silencing a hotel's problem is an operating decision;
 *                `hatCanManageTeam` and `canGrantHat` already say finance makes
 *                none, and this is the same answer on this surface.
 *
 * POST therefore still requires a manager AND a company scope — unchanged, and
 * now the honest mirror of what the GET renders rather than an accident of role
 * degradation.
 *
 * loadSessionAccount is the shared, schema-pinned account lookup. Do not
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
import { loadSessionAccount } from '@/lib/team-auth';
import {
  buildPortfolioQueue,
  companyLocalToday,
  companyScopeFor,
  type CompanyRole,
} from '@/lib/company/vp-queue-server';
import { getPortfolioBrief } from '@/lib/company/vp-brief-server';
import { setCompanyFindingStatus } from '@/lib/company/company-findings';
import type { FindingStatus } from '@/lib/findings/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The three verdicts a company card offers. Same set, same meanings. */
const VERDICTS = ['known_problem', 'muted', 'resolved'] as const;
type Verdict = typeof VERDICTS[number];

/**
 * MAY THIS COMPANY JOB CAST A VERDICT? The ONE predicate both halves of this
 * route use, so what the GET draws and what the POST accepts cannot drift.
 *
 * Asked of the HAT and of nothing else. Reading it off the degraded
 * `accounts.role` instead is what made this route 403 a company's finance lead
 * whom the picker had just admitted; it would equally have refused a VP whose
 * legacy word happened not to be a manager one, which is the same bug wearing
 * the other shoe.
 *
 * Finance is excluded because silencing a hotel's problem is an OPERATING
 * decision and finance makes none — the same answer `hatCanManageTeam` and
 * `canGrantHat` already give. She reads everything, including the money, which
 * is the entire reason her job exists.
 */
function verdictsAllowed(companyRole: CompanyRole): boolean {
  return companyRole === 'owner' || companyRole === 'vp';
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  // NOT loadManagerCaller — see the header. The gate is companyScopeFor below.
  const caller = await loadSessionAccount(session.userId);
  if (!caller) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  try {
    // Scope FIRST, and the limiter before the work — a cap you clear after
    // reading a dozen hotels' ledgers is a cap on the response, not on the
    // load. Wall A lives here too: no company job, no portfolio, and not an
    // error — the client renders their hotel's own queue.
    const scope = await companyScopeFor(caller);
    if (!scope) {
      return ok({ scope: null, cards: [], brief: null, run: null, canAct: false }, { requestId });
    }

    // Keyed on a REAL property id — one of the company's OWN hotels, because
    // api_limits.property_id FKs properties(id) and a company id there would
    // FK-violate, failing the endpoint for the wrong reason. Taken from the
    // company's hotel list rather than from the cards: a portfolio whose only
    // cards are company-scope has no hotel card to key on, and that would have
    // left the endpoint uncapped in exactly the case where the portfolio checks
    // are doing the most work. The organization is folded into the sub-key, so
    // two companies can never share a bucket.
    //
    // Fails OPEN: nothing here is billable, and losing a portfolio screen to a
    // limiter blip would be the worse failure.
    const anchor = scope.propertyIds[0] ?? null;
    if (anchor) {
      const limit = await checkAndIncrementRateLimit('company-queue', anchor, {
        subKey: scope.organizationId,
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

    const queue = await buildPortfolioQueue(caller);
    if (!queue) {
      return ok({ scope: null, cards: [], brief: null, run: null, canAct: false }, { requestId });
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
        // The chip rule's own answer. Without it the brief's "N hotels quiet"
        // and the command centre's "2 WAITING" contradicted each other about the
        // same hotel on the same morning — see hotelHasLiveWork.
        busyHotelIds: queue.busyHotelIds,
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
        // What the screen draws its controls from. False for finance: the same
        // cards, the same numbers, no verdict buttons. A button that 403s is a
        // worse answer than a button that is not there.
        canAct: verdictsAllowed(queue.companyRole),
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

  // The same loader and the same predicate the GET renders from, so a verdict
  // button that appears is a verdict this route will take, and one that does not
  // appear is one it refuses. Previously the two sides disagreed: the manager
  // gate here refused whoever `accounts.role` said was not a manager, which is
  // not the question — the question is what job this person holds at this
  // company.
  const caller = await loadSessionAccount(session.userId);
  if (!caller) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const scope = await companyScopeFor(caller);
  if (!scope || !verdictsAllowed(scope.companyRole)) {
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
