/**
 * The findings queue — what Staxis currently believes is wrong at one hotel,
 * and the manager's three verdicts on it. MANAGER ONLY, service-role.
 *
 * GET  ?propertyId=<uuid>
 *   → { ok, data: { findings, run, cap } }
 *   Open + updated findings for this hotel, worst-money-first ordering applied
 *   on the client. `run` is the last findings-runner execution (or null when
 *   this hotel has never been checked — the screen says nothing about checking
 *   rather than implying a clean night that never happened).
 *
 * GET  ?propertyId=<uuid>&lens=maintenance
 *   → { ok, data: { findings, history, run, cap } }
 *   The same queue narrowed to the checks about the BUILDING, plus the paper
 *   trail for each one, for the patterns popup on the Maintenance tab. Which
 *   checks count as maintenance — and why it is a hand-kept list rather than a
 *   field on the detector — is src/lib/findings/maintenance-lens.ts.
 *
 *   THREE THINGS THIS LENS DELIBERATELY DOES NOT DO, all for the same reason:
 *   it is a second window onto the queue, not a second queue.
 *     1. It does not record cards as SHOWN. `shown_count` feeds self-demotion
 *        (src/lib/findings/demotion.ts), whose question is "does the manager
 *        read their queue". A card glimpsed in a maintenance popup has not
 *        been shown on the queue, and counting it there would quieten checks
 *        on the strength of a screen the manager never treated as their feed.
 *        /api/company/queue omits the same write for the same reason.
 *     2. It does not load attached fixes or sign-off locks. The cards render
 *        read-only, so an offer with no button would be an offer that looks
 *        broken. Approving a fix stays in one place — the Staxis tab — and the
 *        popup says so.
 *     3. It writes nothing at all. Every verdict button is absent rather than
 *        disabled, so there is no second path to the same status change to keep
 *        in step with this one.
 *
 * POST { propertyId, findingId, action }
 *   → { ok, data: { status } }
 *   known_problem   "Seen" / "Known problem". The manager armed the silencer:
 *                   quiet from now on, EXCEPT if the problem outgrows the size
 *                   they consented to. The store records that size; escalation
 *                   is measured from it. It says NOTHING about the problem being
 *                   over — see below.
 *   muted           "Not doing this" / "Mute". Gone, unconditionally. Their
 *                   call, no second-guessing.
 *   resolved        "Handled it" / "Fixed". Dealt with. A recurrence later is a
 *                   genuinely new card, because the handling did not take.
 *   receipt_opened  not a verdict at all — the manager expanded the numbers.
 *                   Nothing about the card changes.
 *
 * ALL FOUR COUNT AS ENGAGEMENT. Every tap is a manager reading this check and
 * deciding something, and the only signal left that means "nobody here reads
 * this" is silence — which is what silence should mean.
 *
 * BUT THE KINDS ARE NOT THE SAME, AND DEMOTION KNOWS THE DIFFERENCE. Handled
 * it, Seen and the receipt are somebody taking the check UP; "Not doing this"
 * is somebody turning it DOWN. The counter here does not distinguish them —
 * `status` a line later already does, and one fact in two columns is one fact
 * that can disagree with itself. What demotion.ts does with that: five distinct
 * problems refused over a week or more, with nothing taken up in the same
 * stretch, quietens the check by one rung, exactly as three ignored weeks
 * would. One refusal quietens nothing beyond the problem it was about.
 *
 * SEEN IS NOT HANDLED, IN THE DATA AS WELL AS ON THE SCREEN. `known_problem`
 * never writes resolved_at and never stands in for an outcome anywhere: the
 * morning brief's "cleared on its own" reads `expired` only, and the target
 * chips treat both silences as decisions rather than resolutions. A manager
 * telling the feed to be quiet must never turn into Staxis telling the owner
 * the problem was fixed.
 *
 * The GET also records which cards were ON SCREEN, once per hotel-day. Both
 * halves feed the same thing: src/lib/findings/demotion.ts, which is how a
 * check this hotel ignores steps down and eventually rests.
 *
 * WHY THE property_id FILTER IS THE TENANT WALL HERE
 * `findings` and `finding_runs` are deny-all to anon and authenticated
 * (migration 0360) — there is no RLS policy to fall back on. Every read and
 * write below goes through src/lib/findings/store.ts, which routes through
 * scopedDb(propertyId) and applies the hotel filter before the query builder
 * is handed back. The gate that decides WHICH propertyId is legitimate is
 * loadManagerCaller + managerManagesHotel, right here.
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
import {
  callerCanMutateHotel,
  loadManagerCaller,
  managerManagesHotel,
  type ManagerCaller,
} from '@/lib/team-auth';
import {
  judgedPhrasing,
  latestRunFacts,
  listFindings,
  recordFindingActed,
  recordFindingsShown,
  setFindingStatus,
} from '@/lib/findings/store';
import { logPreventiveOutcome } from '@/lib/findings/preventive-log';
import type { Finding, FindingStatus } from '@/lib/findings/types';
import { loadActionsForFindings } from '@/lib/findings/actions/store';
import type { FindingAction } from '@/lib/findings/actions/types';
import { toQueueFinding } from '@/lib/findings/queue-projection';
import { hotelBasisSpanish } from '@/lib/findings/basis-spanish';
import {
  MAINTENANCE_LENS_DETECTOR_IDS,
  buildPatternHistory,
  isMaintenanceFinding,
  spanishHistoryTitle,
} from '@/lib/findings/maintenance-lens';
import { companyForProperty } from '@/lib/company/access';
import { loadApproverDirectory, resolveSignOff } from '@/lib/company/signoff';
import {
  DAILY_CARD_CAP,
  cardPhrasing,
  effectiveDisposition,
  isCardRenderable,
  rankFindings,
  splitByCap,
  type CardSignOff,
} from '@/components/concourse/finding-cards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The three verdicts a manager may reach from a card. Nothing else — 'open',
 *  'expired' and the like belong to the runner, not to a button. */
const MANAGER_VERDICTS = ['known_problem', 'muted', 'resolved'] as const;
type ManagerVerdict = typeof MANAGER_VERDICTS[number];

/**
 * The preventive pair — verdicts that also record a FACT ABOUT THE BUILDING.
 *
 * The three above change only how a card is filed. These two additionally move a
 * date on the hotel's upkeep schedule, because the thing they describe (the
 * flush happened / somebody has been called) is not an opinion about a card, it
 * is what occurred in the boiler room. Both then close the card as `resolved`,
 * for the same reason "Handled it" does: the state it was reporting has changed,
 * and a card still sitting there afterwards would be reporting the past.
 *
 * WHY THEY LIVE HERE AND NOT ON A NEW /api/maintenance/... ROUTE
 * A second route would have needed its own copy of every gate this one already
 * has — session, loadManagerCaller, managerManagesHotel, the rate limiter, the
 * envelope — and the only thing it would not have shared is the four lines that
 * dispatch. Four lines of dispatch is a smaller surface to secure and understand
 * than a whole second door into the same data (CLAUDE.md, extend before you
 * add). The domain work itself is NOT here: it is in
 * src/lib/findings/preventive-log.ts, which is also where the reasoning about
 * resolving the schedule server-side rather than trusting the browser lives.
 */
const PREVENTIVE_VERDICTS = ['pm_done', 'pm_called'] as const;
type PreventiveVerdict = typeof PREVENTIVE_VERDICTS[number];

function isPreventiveVerdict(action: PostAction): action is PreventiveVerdict {
  return (PREVENTIVE_VERDICTS as readonly string[]).includes(action);
}

/**
 * Not a verdict — a record that the manager engaged with the card without
 * deciding anything. Opening the receipt is someone reading, and a detector
 * somebody reads has earned its place on the screen whether or not they pressed
 * a button (see src/lib/findings/demotion.ts).
 */
const ENGAGEMENTS = ['receipt_opened'] as const;
type Engagement = typeof ENGAGEMENTS[number];

const POST_ACTIONS = [...MANAGER_VERDICTS, ...PREVENTIVE_VERDICTS, ...ENGAGEMENTS] as const;
type PostAction = typeof POST_ACTIONS[number];

function isEngagement(action: PostAction): action is Engagement {
  return (ENGAGEMENTS as readonly string[]).includes(action);
}

/**
 * The company signature standing on each of these cards, keyed by finding id.
 *
 * Resolved HERE rather than frozen on the action row, so a rule the company
 * writes today governs an offer made yesterday and a rule they delete stops
 * applying immediately — see the header of src/lib/company/signoff.ts. This is
 * the RENDERING of the lock; the enforcement is in /api/findings/actions, which
 * resolves the same requirement again before it calls the database.
 *
 * Costs nothing at a hotel with no company: `companyForProperty` returns null
 * and this returns an empty map without touching the rulebook at all.
 */
async function signOffsFor(
  propertyId: string,
  caller: ManagerCaller,
  findings: readonly Finding[],
  actions: Map<string, FindingAction>,
): Promise<Map<string, CardSignOff>> {
  const out = new Map<string, CardSignOff>();
  const withOffers = findings.filter((f) => actions.get(f.id)?.state === 'proposed');
  if (withOffers.length === 0) return out;

  const organizationId = await companyForProperty(propertyId);
  if (!organizationId) return out;

  const directory = await loadApproverDirectory(organizationId);
  for (const f of withOffers) {
    const action = actions.get(f.id)!;
    const requirement = await resolveSignOff({
      organizationId,
      propertyId,
      actionKind: action.kind,
      price: f.price,
      callerAccountId: caller.accountId,
      callerHats: caller.hats ?? [],
      directory,
    });
    if (!requirement) continue;
    out.set(f.id, {
      approverRole: requirement.approverRole,
      approverNames: requirement.approvers
        .map((a) => a.name)
        .filter((n): n is string => !!n && n.trim().length > 0),
      thresholdCents: requirement.thresholdCents,
      callerMayApprove: requirement.callerMayApprove,
    });
  }
  return out;
}

/** The lenses this route knows. Absent = the whole hotel queue, as before. */
const LENSES = ['maintenance'] as const;
type Lens = typeof LENSES[number];

/**
 * Every status a finding can hold, so the popup's history covers the archive
 * as well as what is standing. `resolved` and `expired` are exactly the rows
 * the ledger keeps BECAUSE nothing is ever deleted; without them "came back"
 * could not be said at all.
 */
const ALL_STATUSES: readonly FindingStatus[] = [
  'open', 'updated', 'resolved', 'known_problem', 'muted', 'expired',
];

/**
 * The Maintenance tab's patterns popup: what is standing about the building
 * right now, and what became of each pattern over time.
 */
async function maintenanceLensPayload(propertyId: string) {
  const rows = (await listFindings(propertyId, {
    statuses: ALL_STATUSES,
    detectorId: MAINTENANCE_LENS_DETECTOR_IDS,
    limit: 500,
  })).filter(isMaintenanceFinding);

  const phrasing = await judgedPhrasing(propertyId, rows.map((f) => f.id));
  // One projection per row, reused for both halves — the cards ARE the rows the
  // history describes, and phrasing them twice by two routes is how the card
  // and its own history line end up disagreeing about what the problem is.
  const cards = new Map(rows.map((f) => [f.id, toQueueFinding(f, {
    phrased: phrasing.get(f.id) ?? null,
    // No action and no sign-off on purpose — see the header.
    action: null,
    signOff: null,
    basisEs: hotelBasisSpanish(f.detectorId, f.evidence),
  })]));

  const standing = rows
    .filter((f) => f.status === 'open' || f.status === 'updated')
    .map((f) => cards.get(f.id)!)
    .filter((c) => isCardRenderable({ disposition: c.disposition, detectorId: c.detectorId }));

  const history = buildPatternHistory(propertyId, rows, (f) => {
    const card = cards.get(f.id)!;
    return {
      en: cardPhrasing(card, 'en'),
      // Not cardPhrasing's Spanish: on a list with no "See the numbers" button
      // its template fallback names nothing and repeats. See the helper.
      es: spanishHistoryTitle(
        card.phrasedEs,
        card.evidence.basisEs,
        cardPhrasing(card, 'es'),
      ),
    };
  });

  return { findings: standing, history };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const url = new URL(req.url);
  const pidV = validateUuid(url.searchParams.get('propertyId'), 'propertyId');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const propertyId = pidV.value!;

  const rawLens = url.searchParams.get('lens');
  const lensV = rawLens === null
    ? { value: null as Lens | null, error: undefined }
    : validateEnum<Lens>(rawLens, LENSES, 'lens');
  if (lensV.error) {
    return err(lensV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const caller = await loadManagerCaller(session.userId);
  if (!caller || !managerManagesHotel(caller, propertyId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  try {
    if (lensV.value === 'maintenance') {
      const lens = await maintenanceLensPayload(propertyId);
      const run = await latestRunFacts(propertyId);
      // No cap: a manager who opened "show me the patterns" asked for all of
      // them, and folding half of them behind "show all" on a surface that
      // exists to be complete would be the wrong lesson from the queue.
      return ok(
        { ...lens, run, cap: Math.max(lens.findings.length, 1) },
        { requestId },
      );
    }

    // Open + updated only. known_problem and muted still occupy the ledger's
    // one-row-per-problem slot — that is what stops a silenced problem coming
    // back as a fresh card — but they are silences the manager armed and this
    // screen honours them by not asking again.
    const rows = await listFindings(propertyId, { statuses: ['open', 'updated'], limit: 200 });

    // `ask` is a question and belongs to the drip-question card, not here
    // (src/lib/findings/ask-drip.ts routes it there); `drop` is the judge's
    // "not worth surfacing", kept for audit, never shown. Judged FIRST, because
    // both verdicts are ones only the judge ever reaches — filtering on the
    // detector's default would render every ask finding as a card as well as a
    // question.
    // `detectorId` matters here: a check whose card is the ONLY place its
    // outcome can be recorded stays a card even when the judge sorted it to
    // `ask`, because the question surface has no buttons that write to a
    // schedule (DETECTORS_WITH_DOMAIN_CLOSURE). The drip pipeline declines the
    // same rows from the other side, so nothing is rendered twice.
    const showable = rows.filter((f) =>
      isCardRenderable({ disposition: effectiveDisposition(f), detectorId: f.detectorId }),
    );

    const ids = showable.map((f) => f.id);
    const phrasing = await judgedPhrasing(propertyId, ids);
    // Never throws: a card whose attached fix could not be read renders as the
    // plain finding it was before the hands existed, which is a degradation
    // rather than a lie.
    const actions = await loadActionsForFindings(propertyId, ids);
    // Which offers the company's rulebook says are not this person's to make.
    // A locked card still renders in full — the button is what changes.
    const signOffs = await signOffsFor(propertyId, caller, showable, actions);
    const findings = showable.map((f) => toQueueFinding(f, {
      phrased: phrasing.get(f.id) ?? null,
      action: actions.get(f.id) ?? null,
      signOff: signOffs.get(f.id) ?? null,
      // The receipt lines, in Spanish, rebuilt from this row's own evidence.
      // Without it a Spanish-reading manager got a Spanish headline over an
      // English "based on…" line on every card this product produces — the
      // `basisEs` seam existed from the start and only the portfolio checks
      // were filling it. Null for a detector whose basis cannot be rebuilt
      // from what it stores, and the card keeps its English there.
      basisEs: hotelBasisSpanish(f.detectorId, f.evidence),
    }));

    const run = await latestRunFacts(propertyId);

    // ── what was actually SHOWN ─────────────────────────────────────────────
    // Recorded here, on the server, through the SAME pure functions the screen
    // ranks and folds with — so "shown" means "was above the fold on the
    // manager's screen", not "was in a payload". A card behind "show all" has
    // not been shown, and counting it would let a detector be demoted for cards
    // nobody ever laid eyes on.
    //
    // A write on a GET is deliberate, and it is why this route is
    // force-dynamic. It is also idempotent per hotel-day (store.ts holds that
    // guarantee), so a refresh loop cannot inflate it.
    const onScreen = splitByCap(rankFindings(findings), DAILY_CARD_CAP).prominent;
    await recordFindingsShown(propertyId, onScreen.map((f) => f.id));

    return ok({ findings, run, cap: DAILY_CARD_CAP }, { requestId });
  } catch (e) {
    // Deliberately an ERROR, not an empty list. An empty queue is a claim
    // ("nothing is wrong here") and we have no right to make it when the read
    // failed; the screen renders "couldn't check just now" instead.
    log.error('[findings:GET] failed', {
      requestId,
      err: e instanceof Error ? e.message : String(e),
    });
    return err('Could not load findings', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}

interface PostBody {
  propertyId?: unknown;
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

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const propertyId = pidV.value!;

  const idV = validateUuid(body.findingId, 'findingId');
  if (idV.error) {
    return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const actionV = validateEnum<PostAction>(body.action, POST_ACTIONS, 'action');
  if (actionV.error) {
    return err(actionV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const caller = await loadManagerCaller(session.userId);
  if (!caller
      || !managerManagesHotel(caller, propertyId)
      || !callerCanMutateHotel(caller, propertyId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // Keyed on the RAW property id — api_limits.property_id has an FK to
  // properties(id), so a hashed composite would FK-violate and this endpoint
  // would fail for the wrong reason. Not billing-impacting (no model call, no
  // message send) so it fails OPEN: a Supabase blip must never swallow a
  // manager's decision to silence something.
  const limit = await checkAndIncrementRateLimit('findings-verdict', propertyId);
  if (!limit.allowed) {
    return err('Too many changes, try again shortly', {
      requestId,
      status: 429,
      code: ApiErrorCode.RateLimited,
      headers: { 'Retry-After': String(limit.retryAfterSec) },
    });
  }

  try {
    // Engagement, not a decision: the card stays exactly where it is and only
    // the counters move.
    if (isEngagement(actionV.value!)) {
      const seen = await recordFindingActed(propertyId, idV.value!);
      if (!seen) {
        return err('No such finding', { requestId, status: 404, code: ApiErrorCode.NotFound });
      }
      return ok({ status: 'unchanged' }, { requestId });
    }

    // ── the preventive pair ────────────────────────────────────────────────
    // The schedule write happens FIRST. If it fails, the card stays exactly
    // where it is and the manager can try again — whereas closing the card
    // first and then failing to move the date would leave them believing they
    // had recorded a flush that Staxis has no record of, and the schedule would
    // go on reporting overdue with no card left to say so.
    if (isPreventiveVerdict(actionV.value!)) {
      const logged = await logPreventiveOutcome(
        propertyId,
        idV.value!,
        actionV.value! === 'pm_done' ? 'done' : 'called',
        caller.displayName,
      );

      if (!logged.ok) {
        if (logged.because === 'not_a_preventive_finding') {
          return err('That card is not about an upkeep schedule', {
            requestId,
            status: 400,
            code: ApiErrorCode.ValidationFailed,
          });
        }
        // Both remaining cases — no such finding at this hotel, and a schedule
        // that has been deleted since the card was written — are "there is
        // nothing here to record that against".
        return err('No such finding', { requestId, status: 404, code: ApiErrorCode.NotFound });
      }

      await recordFindingActed(propertyId, idV.value!);
      const closed = await setFindingStatus(
        propertyId,
        idV.value!,
        'resolved',
        caller.accountId,
      );
      return ok(
        { status: closed?.status ?? 'resolved', preventive: logged.result },
        { requestId },
      );
    }

    const verdict = actionV.value! as ManagerVerdict;
    // EVERY verdict counts, including "not doing this". Before the status
    // change, because a resolved card is still the card the manager engaged
    // with — and after it the row may no longer be one this hotel's queue reads
    // back.
    //
    // `muted` used to be excluded here, on the theory that counting a rejection
    // as approval would keep a detector loud that a manager plainly dislikes.
    // That reasoning had the failure mode backwards. The counters feed
    // self-demotion, whose question is "does anyone at this hotel READ this
    // check" — and a manager who read the card and decided against it read the
    // card. Excluding mute made a deliberate decision look identical to a
    // scroll-past, which is the one thing these counters exist to tell apart.
    // Silence is now the only ambiguous signal, which is what silence is.
    //
    // The half of that worry which was RIGHT — that repeated rejection should
    // not keep a check loud — is answered where it belongs, in demotion.ts,
    // which reads `status = 'muted'` off the rows and treats a run of refusals
    // as a reason to step the check down. It is not answered by refusing to
    // write a number down.
    await recordFindingActed(propertyId, idV.value!);

    const updated = await setFindingStatus(
      propertyId,
      idV.value!,
      verdict as FindingStatus,
      caller.accountId,
    );
    // Null means the hotel filter matched nothing: either the id is bogus or it
    // belongs to another hotel. Same answer either way — this hotel has no such
    // finding — so the response cannot be used to probe another hotel's ids.
    if (!updated) {
      return err('No such finding', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }
    return ok({ status: updated.status }, { requestId });
  } catch (e) {
    log.error('[findings:POST] status change failed', {
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
