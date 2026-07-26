/**
 * The hands. A manager approves the fix Staxis attached to a card, or undoes
 * one they approved. MANAGER ONLY, service-role.
 *
 * POST { propertyId, actionId, intent: 'execute' | 'undo' }
 *   → { ok, data: { state, code, receipt?, changed?, why? } }
 *
 *   execute   Runs the plan that was frozen when the card was written. There is
 *             no model call here and nothing is decided at request time: the
 *             database re-derives the finding's receipt inside the SAME
 *             transaction that does the work and DECLINES if the facts moved
 *             (`code: 'declined_changed'`, with what changed). A second tap
 *             returns the first tap's receipt — `finding_actions` makes a
 *             double tap one action, and this route does not have to be careful
 *             about it.
 *   undo      Reverses it. Refuses, with a reason, when a human has already
 *             worked on the result.
 *
 * WHY THE TENANT WALL IS THE property_id ARGUMENT
 * `finding_actions` is deny-all to anon and authenticated (migration 0363) —
 * there is no RLS policy to fall back on. Every call below goes through
 * src/lib/findings/actions/store.ts, which routes through scopedDb(propertyId);
 * the two RPCs additionally take the hotel as an argument and filter on it
 * themselves, so a hotel B action id sent with a hotel A propertyId matches no
 * row and comes back 'not_found'. The gate that decides WHICH propertyId is
 * legitimate for this session is loadManagerCaller + managerManagesHotel, here.
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
import { loadManagerCaller, managerManagesHotel, type ManagerCaller } from '@/lib/team-auth';
import { executeAction, loadAction, undoAction } from '@/lib/findings/actions/store';
import { loadFinding, recordFindingActed } from '@/lib/findings/store';
import type { FindingAction } from '@/lib/findings/actions/types';
import { resolveCompanyForProperty } from '@/lib/company/access';
import { resolveSignOffStrict } from '@/lib/company/signoff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What the company's rulebook says about this fix, at the gate.
 *
 *   allowed      nothing routes it away from this person
 *   blocked      a rule sends it to somebody else; `why` is the sentence
 *   unavailable  WE COULD NOT TELL. Refused, loudly — see below.
 *
 * The price the rule is applied to comes from the FINDING, not from the request
 * — the caller names an action id and nothing else, so there is no number here
 * a caller could shrink to slip under a threshold.
 *
 * ═══ WHY "WE COULD NOT TELL" REFUSES HERE AND NOWHERE ELSE ═══
 * Every read in this function used to fail open, and there are THREE of them —
 * which company operates this hotel, which finding this action answers, and
 * which rule governs the amount. A stale PostgREST schema cache — the single
 * most common operational fault in this app, and one that follows every
 * migration — made `company_authority_rules` unreadable, which returned "no rule
 * governs this", which let a GM tap through a lock their company had written.
 * The failure is invisible from both ends: the button simply works, and the
 * money is spent. The company read had the same hole one question earlier, and
 * one more besides: a hotel two live companies both claim has no answer to
 * "whose rulebook applies", and answering "nobody's" would be a decision nobody
 * made.
 *
 * A CARD may still fail open (finding-cards renders the pre-company card, and
 * `resolveSignOff` keeps that behaviour on purpose) because a card is a
 * rendering and this is the gate. A gate that guesses is not a gate.
 */
type SignOffGate =
  | { state: 'allowed' }
  | { state: 'blocked'; why: string }
  | { state: 'unavailable'; because: string };

async function signOffBlocking(
  propertyId: string,
  caller: ManagerCaller,
  action: FindingAction,
): Promise<SignOffGate> {
  // `companyForProperty` would answer `null` here for THREE different worlds:
  // an independent hotel, a read that failed, and a hotel two live companies
  // both claim to run. Only the first is a safe proceed, and collapsing the
  // other two into it is the same fail-open this gate exists to close — one
  // question earlier. So the gate asks the four-answer resolver.
  const company = await resolveCompanyForProperty(propertyId);
  if (company.status === 'unavailable') {
    return { state: 'unavailable', because: 'we could not tell which company operates this hotel' };
  }
  if (company.status === 'ambiguous') {
    // Two companies claim to run this building, so there is no answer to "whose
    // rulebook governs this money". A human has to settle it; until they do,
    // nothing here spends on either company's behalf.
    return {
      state: 'unavailable',
      because: `two live companies claim this hotel (${company.organizationIds.join(', ')})`,
    };
  }
  if (company.status === 'independent') return { state: 'allowed' };
  const organizationId = company.organizationId;

  // `loadFinding` rather than a status-filtered list scan: the price this rule
  // is applied to is a fact about the card, not about whether the card is still
  // live, and a manager tapping the button on a row that just moved to
  // `known_problem` must still be routed by the same rule. It is also one query
  // against the id instead of two hundred rows filtered in memory.
  //
  // It THROWS on a read error, which the caller turns into a 500 — the same
  // refusal by a different door. A null is the other unknown: the action exists
  // at this hotel but the problem it answers does not, so there is no price to
  // apply the rulebook to. That cannot happen through the schema (the finding id
  // is a cascading foreign key), which is exactly why it is refused rather than
  // waved through — an impossible state is not a state to spend money in.
  const finding = await loadFinding(propertyId, action.findingId);
  if (!finding) {
    return { state: 'unavailable', because: 'the finding behind this action could not be read' };
  }

  const resolution = await resolveSignOffStrict({
    organizationId,
    propertyId,
    actionKind: action.kind,
    price: finding.price,
    callerAccountId: caller.accountId,
    callerHats: caller.hats ?? [],
  });
  if (resolution.kind === 'unreadable') {
    return { state: 'unavailable', because: `the company rulebook could not be read: ${resolution.error}` };
  }
  if (resolution.kind === 'none' || resolution.requirement.callerMayApprove) {
    return { state: 'allowed' };
  }

  const named = resolution.requirement.approvers
    .map((a) => a.name)
    .filter((n): n is string => !!n && n.trim().length > 0);
  return {
    state: 'blocked',
    why: named.length > 0
      ? `Your company's rules send this one to ${named.join(', ')}.`
      : "Your company's rules send this one to somebody else to sign off.",
  };
}

const INTENTS = ['execute', 'undo'] as const;
type Intent = typeof INTENTS[number];

interface PostBody {
  propertyId?: unknown;
  actionId?: unknown;
  intent?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body) {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const propertyId = pidV.value!;

  const idV = validateUuid(body.actionId, 'actionId');
  if (idV.error) {
    return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const actionId = idV.value!;

  const intentV = validateEnum<Intent>(body.intent, INTENTS, 'intent');
  if (intentV.error) {
    return err(intentV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const intent = intentV.value!;

  const caller = await loadManagerCaller(session.userId);
  if (!caller || !managerManagesHotel(caller, propertyId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // Keyed on the RAW property id — api_limits.property_id has an FK to
  // properties(id). Fails OPEN: the database already guarantees a double tap is
  // one action, so a limiter blip cannot duplicate work, and swallowing a
  // manager's approval would be the worse failure.
  const limit = await checkAndIncrementRateLimit('findings-action', propertyId);
  if (!limit.allowed) {
    return err('Too many changes, try again shortly', {
      requestId,
      status: 429,
      code: ApiErrorCode.RateLimited,
      headers: { 'Retry-After': String(limit.retryAfterSec) },
    });
  }

  try {
    // Read first, and through the hotel filter. Null means this hotel has no
    // such action: either the id is bogus or it belongs to somebody else. Same
    // answer either way, so the response cannot be used to probe another
    // hotel's ids.
    const action = await loadAction(propertyId, actionId);
    if (!action) {
      return err('No such action', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }

    // ── the company's signature, enforced ────────────────────────────────────
    // The card renders a lock, but a card is a rendering and this is the gate.
    // A stale tab, a replayed request or a hand-rolled POST all arrive here, and
    // all three are refused the same way. Resolved fresh rather than read off
    // the row, for the reasons in src/lib/company/signoff.ts: a rule written
    // this morning governs an offer frozen last night.
    //
    // UNDO IS DELIBERATELY NOT GATED. If a fix ran, the ability to reverse it
    // must not depend on the rulebook having changed since — a manager left
    // holding an action they can no longer undo is worse off than one who was
    // never allowed to run it.
    if (intent === 'execute') {
      const gate = await signOffBlocking(propertyId, caller, action);
      if (gate.state === 'blocked') {
        return err(gate.why, {
          requestId,
          status: 403,
          code: ApiErrorCode.Forbidden,
        });
      }
      if (gate.state === 'unavailable') {
        // 503, not 403: the manager is not being refused permission, we are
        // saying we cannot check right now. Retry-able, and it says so — a
        // permanent-sounding 403 would send a GM to their VP over a thirty-second
        // schema-cache blip.
        log.error('[findings:actions:POST] sign-off could not be resolved; refusing to execute', {
          requestId,
          propertyId,
          because: gate.because,
        });
        return err('Could not check your company\'s rules just now — try again in a moment', {
          requestId,
          status: 503,
          code: ApiErrorCode.InternalError,
          headers: { 'Retry-After': '15' },
        });
      }
    }

    const result =
      intent === 'execute'
        ? await executeAction(propertyId, actionId, caller.accountId)
        : await undoAction(propertyId, actionId, caller.accountId);

    if (result.code === 'not_found') {
      return err('No such action', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }

    // Approving or undoing a fix is the strongest engagement signal a card can
    // produce: a manager did not just read this check, they acted on it. Best
    // effort — recordFindingActed never throws — because a counter that could
    // fail the approval it measures would be worse than no counter (0362).
    await recordFindingActed(propertyId, action.findingId);

    // Re-read so the card renders the state the DATABASE ended up in rather
    // than a state this route inferred. They agree today; a card that renders
    // an inference is how they stop agreeing without anyone noticing.
    const settled = await loadAction(propertyId, actionId);

    return ok(
      {
        state: settled?.state ?? action.state,
        code: result.code,
        receipt: result.receipt ?? settled?.receipt ?? null,
        changed: result.changed ?? settled?.changedFacts ?? null,
        why: result.why ?? null,
        failureReason: settled?.failureReason ?? result.error ?? null,
      },
      { requestId },
    );
  } catch (e) {
    log.error('[findings:actions:POST] failed', {
      requestId,
      intent,
      err: e instanceof Error ? e.message : String(e),
    });
    // Deliberately NOT "it worked": an error here means we do not know what the
    // database did, and a card that claims success on an unknown outcome is the
    // exact failure the whole re-verification layer exists to prevent.
    return err('Could not do that just now', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
