/**
 * THE PORTFOLIO QUEUE — what a company-scope person sees instead of one hotel's
 * feed. COMPANY-SCOPE ONLY, service-role.
 *
 * GET ?organizationId=<selected company>
 *   → { ok, data: { scope, cards, brief, run, coverage, cap } }
 *   `scope` is null for everybody without a COMPANY-scope job — a hotel GM, a
 *   front-desk lead, a Staxis administrator, and every single-hotel account in
 *   the product today. That null is Wall A, and it is also the signal the client
 *   uses to render the ordinary hotel queue instead. There is no partial
 *   portfolio: either you oversee a company or this surface does not exist for
 *   you. Multi-company accounts must carry the picker selection; an omitted
 *   ambiguous company fails closed instead of choosing one.
 *
 * POST { organizationId, findingId, action }
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
 * The picker names a company because one person may hold jobs at several. The
 * id never turns directly into hotels: the authoritative resolver intersects
 * it with the caller's live grants, mints an exact all-authorized receipt, and
 * fails indistinguishably for another tenant. Every service-role read uses only
 * the receipt's hotel ids; the receipt is re-asserted before egress or mutation.
 *
 * ─── WHY THIS GET DOES NOT WRITE shown_count ──────────────────────────────
 * /api/findings deliberately records which cards were on a manager's screen —
 * that write is how a check this hotel ignores earns its rest (demotion.ts).
 * Reusing it here would let a VP scrolling twelve hotels' problems demote
 * detectors at hotels they will never open. A boss reading over your shoulder
 * is not you reading.
 *
 * ─── WHO GETS IN, AND WHAT FINANCE SEES ──────────────────────────────────
 * GET uses `loadSessionAccount`; the gate is the feature-independent
 * authoritative company resolver. It used to use
 * `loadManagerCaller`, and that was wrong in a way no test noticed: the manager
 * gate reads `accounts.role`, and the company vocabulary degrades
 * least-privilege into it — a `finance` hat becomes `front_desk`
 * (src/lib/company/roles.ts). So the picker deliberately admitted a company's
 * finance lead (see the bootstrap route's own note) and then this route answered
 * 403. She was shown the door to a room she was refused at.
 *
 * THE RULE, one line: a whole-company entitlement opens the selected company's
 * queue, and its authoritative receipt decides what it opens — never a degraded
 * legacy word or an unverified URL id.
 *
 * Company authority is READ authority here. A company Owner/VP/finance hat can
 * never stand in for permission to change a hotel's private operating state.
 * POST resolves the finding's exact affected hotels, then requires current
 * hotel mutation standing and the action/finding capabilities at every one of
 * them. The final check and row CAS happen together in PostgreSQL.
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
  assertAuthorizationScopeReceipt,
  authoritativeStandingForProperty,
  listAuthoritativePropertyAccess,
  resolveAuthorizationScope,
} from '@/lib/authorization/server';
import {
  resolveManagementCompanyScopeUncached,
  type ManagementCompanyScopeResult,
} from '@/lib/company/authoritative-scope';
import { companyQueueAvailableFromAuthorization } from '@/lib/company/company-queue-access';
import {
  buildPortfolioQueue,
  companyQueueScopeFromAuthorization,
  companyLocalToday,
} from '@/lib/company/vp-queue-server';
import { getPortfolioBrief } from '@/lib/company/vp-brief-server';
import type { PortfolioBrief } from '@/lib/company/vp-brief';
import {
  commitCompanyFindingVerdict,
  companyFindingVerdictRequirements,
  CompanyFindingVerdictScopeError,
  loadCompanyFindingVerdictSnapshot,
  type CompanyFinding,
} from '@/lib/company/company-findings';
import { can } from '@/lib/capabilities/can';
import { loadOverridesForPropertyFresh } from '@/lib/capabilities/server';
import { getEnabledSectionsFresh } from '@/lib/sections/server';
import { isSectionEnabled } from '@/lib/sections/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The three verdicts a company card offers. Same set, same meanings. */
const VERDICTS = ['known_problem', 'muted', 'resolved'] as const;
type Verdict = typeof VERDICTS[number];
type ManagementCompanyScopeRefusal = Extract<
  ManagementCompanyScopeResult,
  { ok: false }
>['reason'];

/**
 * The company queue contains organization-wide findings. A portfolio- or
 * property-scoped grant may use its own scoped intelligence surface, but it
 * must not receive opaque company cards whose affected hotels can sit outside
 * that grant. Both legacy company hats and normalized organization grants are
 * represented by these two receipt scope values.
 */
function scopeRefusalResponse(
  reason: ManagementCompanyScopeRefusal,
  requestId: string,
  options: { explicitSelection: boolean; allowNoCompanyFallback: boolean },
) {
  if (reason === 'ambiguous_company') {
    return err('Select a company before opening its queue', {
      requestId,
      status: 409,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  if (reason === 'authorization_unavailable') {
    return err('Could not verify your current company access', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
      headers: { 'Retry-After': '5' },
    });
  }
  if (reason === 'scope_too_large') {
    return err('That company scope is too large to load safely', {
      requestId,
      status: 413,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  if (options.allowNoCompanyFallback && !options.explicitSelection && reason === 'no_company_job') {
    return ok(
      {
        scope: null,
        cards: [],
        brief: null,
        run: null,
        coverage: null,
        canAct: false,
      },
      { requestId },
    );
  }
  // Same response for an unknown organization, another tenant's organization,
  // or an authorized company that currently has no queue scope.
  return err(options.explicitSelection ? 'Company access was not found' : 'Forbidden', {
    requestId,
    status: options.explicitSelection ? 404 : 403,
    code: options.explicitSelection ? ApiErrorCode.NotFound : ApiErrorCode.Forbidden,
  });
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const organizationValues = new URL(req.url).searchParams.getAll('organizationId');
  if (organizationValues.length > 1) {
    return err('organizationId must be provided once', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  let requestedOrganizationId = organizationValues[0] ?? null;
  if (requestedOrganizationId !== null) {
    const organizationV = validateUuid(requestedOrganizationId, 'organizationId');
    if (organizationV.error) {
      return err(organizationV.error, {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }
    requestedOrganizationId = organizationV.value!.toLowerCase();
  }

  // NOT loadManagerCaller — see the header. The gate is the authoritative
  // company receipt below.
  const caller = await loadSessionAccount(session.userId);
  if (!caller) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  try {
    // Scope FIRST, and the limiter before the work — a cap you clear after
    // reading a dozen hotels' ledgers is a cap on the response, not on the
    // load. Wall A lives here too: no company job, no portfolio, and not an
    // error — the client renders their hotel's own queue.
    const resolved = await resolveManagementCompanyScopeUncached(
      caller.accountId,
      requestedOrganizationId,
    );
    if (!resolved.ok) {
      return scopeRefusalResponse(resolved.reason, requestId, {
        explicitSelection: requestedOrganizationId !== null,
        allowNoCompanyFallback: true,
      });
    }
    if (!companyQueueAvailableFromAuthorization(resolved.access)) {
      return scopeRefusalResponse('no_company_job', requestId, {
        explicitSelection: requestedOrganizationId !== null,
        allowNoCompanyFallback: true,
      });
    }
    const scope = await companyQueueScopeFromAuthorization(caller, resolved.access);

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

    const standingByProperty = new Map(
      resolved.access.propertyStandings.map((standing) => [standing.propertyId, standing]),
    );
    const propertyPolicy = new Map<string, Promise<{
      overrides: Awaited<ReturnType<typeof loadOverridesForPropertyFresh>>;
      sections: Awaited<ReturnType<typeof getEnabledSectionsFresh>>;
    } | null>>();
    const loadPropertyPolicy = (propertyId: string) => {
      let pending = propertyPolicy.get(propertyId);
      if (!pending) {
        pending = Promise.all([
          loadOverridesForPropertyFresh(propertyId),
          getEnabledSectionsFresh(propertyId),
        ]).then(([overrides, sections]) => ({ overrides, sections })).catch(() => null);
        propertyPolicy.set(propertyId, pending);
      }
      return pending;
    };
    const canActOnCompanyFinding = async (finding: CompanyFinding): Promise<boolean> => {
      const requirements = companyFindingVerdictRequirements({
        detectorId: finding.detectorId,
        semanticFamily: finding.semanticFamily,
        activityStream: finding.activityStream,
      });
      if (!requirements
          || finding.affectedPropertyIds.length === 0
          || finding.affectedPropertyIds.some((id) => !standingByProperty.has(id))) return false;
      for (const propertyId of finding.affectedPropertyIds) {
        const standing = standingByProperty.get(propertyId);
        if (!standing?.canManageHotel || !standing.operationalRole) return false;
        const policy = await loadPropertyPolicy(propertyId);
        if (!policy) return false;
        if (requirements.requiredSections.some((section) => (
          !isSectionEnabled(policy.sections, section)
        ))) return false;
        if (requirements.requiredCapabilities.some((capability) => (
          !can({ role: standing.operationalRole }, capability, policy.overrides)
        ))) return false;
      }
      return true;
    };

    const queue = await buildPortfolioQueue(caller, scope, new Date(), {
      // Climbed hotel cards stay read-only in the company queue until the
      // hotel-local verdict endpoint has its own in-transaction receipt fence.
      // Company-card verdicts below already commit through 0405's exact CAS.
      canActOnCompanyFinding,
    });

    let brief: PortfolioBrief | null = null;
    let briefStopped = false;
    // A portfolio brief speaks about the company as a whole. A bounded hotel
    // read has not earned that claim, even though company-level cards may still
    // be independently complete and carry their own receipts.
    if (queue.coverage.complete) {
      const { localDate } = await companyLocalToday(queue.organizationId, new Date());
      const briefResult = await getPortfolioBrief({
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
      brief = briefResult.brief;
      briefStopped = briefResult.stopped === true;
    }

    // Authorization may be revoked while the bounded hotel ledgers are read.
    // Re-assert the immutable receipt immediately before data egress so stale
    // scope never becomes a successful response.
    const asserted = await assertAuthorizationScopeReceipt({
      receiptId: resolved.access.authorizationReceipt.id,
      accountId: caller.accountId,
    });
    if (!asserted.ok) {
      const unavailable = asserted.reason === 'store_unavailable';
      return err(
        unavailable
          ? 'Could not re-verify your current company access'
          : 'Your company access changed while this queue was loading',
        {
          requestId,
          status: unavailable ? 503 : 409,
          code: unavailable ? ApiErrorCode.UpstreamFailure : ApiErrorCode.IdempotencyConflict,
          ...(unavailable ? { headers: { 'Retry-After': '5' } } : {}),
        },
      );
    }

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
        // No brief because the Morning Briefer is switched off (admin AI Staff
        // page), as opposed to no brief because nothing has been checked yet.
        // The queue below is unaffected either way.
        briefStopped,
        run: queue.run,
        coverage: queue.coverage,
        cap: queue.cap,
        // What the screen draws its controls from. False for finance: the same
        // cards, the same numbers, no verdict buttons. A button that 403s is a
        // worse answer than a button that is not there.
        canAct: queue.cards.some((card) => card.canAct === true),
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
  organizationId?: unknown;
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

  if (body.organizationId === undefined) {
    return err('organizationId is required', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  const organizationV = validateUuid(body.organizationId, 'organizationId');
  if (organizationV.error) {
    return err(organizationV.error, {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  const organizationId = organizationV.value!.toLowerCase();

  const idV = validateUuid(body.findingId, 'findingId');
  if (idV.error) {
    return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const actionV = validateEnum<Verdict>(body.action, VERDICTS, 'action');
  if (actionV.error) {
    return err(actionV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // Company queue reach admits this aggregate read surface only. A card action
  // has a narrower trust boundary: after locating the tenant-filtered finding,
  // the route and final SQL transaction separately require current hotel-level
  // standing for every property that action would affect.
  const caller = await loadSessionAccount(session.userId);
  if (!caller) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const resolved = await resolveManagementCompanyScopeUncached(caller.accountId, organizationId);
  if (!resolved.ok) {
    return scopeRefusalResponse(resolved.reason, requestId, {
      explicitSelection: true,
      allowNoCompanyFallback: false,
    });
  }
  if (!companyQueueAvailableFromAuthorization(resolved.access)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  try {
    // Tenant-filter before inspecting scope. Bogus and foreign ids are the same
    // 404, so finding ids cannot be used as a cross-company existence oracle.
    const snapshot = await loadCompanyFindingVerdictSnapshot(
      resolved.access.organizationId,
      idV.value!,
    );
    if (!snapshot) {
      return err('No such finding', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }

    const broadAuthorized = new Set(resolved.access.authorizationReceipt.authorizedPropertyIds);
    if (snapshot.affectedPropertyIds.some((propertyId) => !broadAuthorized.has(propertyId))) {
      return err('That finding does not have an actionable hotel scope', {
        requestId,
        status: 409,
        code: ApiErrorCode.IdempotencyConflict,
      });
    }

    // Re-read the authoritative hotel standing at this tool boundary. Company-
    // only reach deliberately has hotelMutationAllowed=false even for Owner/VP.
    const currentPropertyAccess = await listAuthoritativePropertyAccess(caller.accountId);
    if (!currentPropertyAccess) {
      return err('Could not verify current hotel access', {
        requestId,
        status: 503,
        code: ApiErrorCode.UpstreamFailure,
        headers: { 'Retry-After': '5' },
      });
    }
    if (snapshot.affectedPropertyIds.some((propertyId) => (
      authoritativeStandingForProperty(currentPropertyAccess, propertyId)
        ?.hotelMutationAllowed !== true
    ))) {
      return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
    }

    // Mint an exact property-subset receipt. The all-authorized company receipt
    // admits the aggregate GET; this one proves only the hotels this verdict
    // would affect and is the receipt the transactional CAS reasserts.
    const actionScope = await resolveAuthorizationScope({
      accountId: caller.accountId,
      organizationId: resolved.access.organizationId,
      selector: {
        type: 'property_subset',
        propertyIds: snapshot.affectedPropertyIds,
      },
      ttlSeconds: 60,
    });
    if (!actionScope.ok) {
      const unavailable = actionScope.reason === 'store_unavailable';
      return err(unavailable ? 'Could not verify current hotel access' : 'Forbidden', {
        requestId,
        status: unavailable ? 503 : 403,
        code: unavailable ? ApiErrorCode.UpstreamFailure : ApiErrorCode.Forbidden,
        ...(unavailable ? { headers: { 'Retry-After': '5' } } : {}),
      });
    }

    const committed = await commitCompanyFindingVerdict({
      accountId: caller.accountId,
      organizationId: resolved.access.organizationId,
      authorizationReceiptId: actionScope.receipt.id,
      snapshot,
      action: actionV.value!,
    });
    if (!committed.ok) {
      if (committed.reason === 'conflict') {
        return err('That finding changed before your action could be saved', {
          requestId,
          status: 409,
          code: ApiErrorCode.IdempotencyConflict,
        });
      }
      if (committed.reason === 'unavailable') {
        return err('Could not re-verify access or save that action', {
          requestId,
          status: 503,
          code: ApiErrorCode.UpstreamFailure,
          headers: { 'Retry-After': '5' },
        });
      }
      return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
    }
    return ok({
      status: committed.status,
      outcome: committed.outcome,
      revision: committed.revision,
    }, { requestId });
  } catch (e) {
    if (e instanceof CompanyFindingVerdictScopeError) {
      return err('That finding does not have an actionable hotel scope', {
        requestId,
        status: 409,
        code: ApiErrorCode.IdempotencyConflict,
      });
    }
    log.error('[company:queue:POST] status change failed', {
      requestId,
      err: e instanceof Error ? e.message : String(e),
    });
    return err('Could not verify or save that action', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
      headers: { 'Retry-After': '5' },
    });
  }
}
