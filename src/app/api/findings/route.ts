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
 * POST { propertyId, findingId, action }
 *   → { ok, data: { status } }
 *   known_problem   the manager armed the silencer: quiet from now on, EXCEPT
 *                   if the problem outgrows the size they consented to. The
 *                   store records that size; escalation is measured from it.
 *   muted           gone, unconditionally. Their call, no second-guessing.
 *   resolved        dealt with. A recurrence later is a genuinely new card.
 *   receipt_opened  not a verdict at all — the manager expanded the numbers.
 *                   Nothing about the card changes; it counts as engagement, so
 *                   a detector somebody actually reads does not quietly demote
 *                   itself for want of a button press (0362).
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
import { loadManagerCaller, managerManagesHotel } from '@/lib/team-auth';
import {
  judgedPhrasing,
  latestRunFacts,
  listFindings,
  recordFindingActed,
  recordFindingsShown,
  setFindingStatus,
} from '@/lib/findings/store';
import type { Finding, FindingStatus } from '@/lib/findings/types';
import {
  DAILY_CARD_CAP,
  effectiveDisposition,
  isCardRenderable,
  rankFindings,
  splitByCap,
  type QueueFinding,
} from '@/components/concourse/finding-cards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The three verdicts a manager may reach from a card. Nothing else — 'open',
 *  'expired' and the like belong to the runner, not to a button. */
const MANAGER_VERDICTS = ['known_problem', 'muted', 'resolved'] as const;
type ManagerVerdict = typeof MANAGER_VERDICTS[number];

/**
 * Not a verdict — a record that the manager engaged with the card without
 * deciding anything. Opening the receipt is someone reading, and a detector
 * somebody reads has earned its place on the screen whether or not they pressed
 * a button (see src/lib/findings/demotion.ts).
 */
const ENGAGEMENTS = ['receipt_opened'] as const;
type Engagement = typeof ENGAGEMENTS[number];

const POST_ACTIONS = [...MANAGER_VERDICTS, ...ENGAGEMENTS] as const;
type PostAction = typeof POST_ACTIONS[number];

function isEngagement(action: PostAction): action is Engagement {
  return (ENGAGEMENTS as readonly string[]).includes(action);
}

/**
 * Which verdicts count as engagement.
 *
 * `muted` is deliberately absent. It is a manager saying "never show me this
 * again", and counting it as a reason to keep showing the detector at full
 * volume would be reading a rejection as approval.
 */
function verdictIsEngagement(action: ManagerVerdict): boolean {
  return action === 'known_problem' || action === 'resolved';
}

/** Stored row → wire shape. Everything the card renders, nothing it does not. */
function toQueueFinding(f: Finding, phrased: { en: string | null; es: string | null } | undefined): QueueFinding {
  return {
    id: f.id,
    detectorId: f.detectorId,
    dedupeKey: f.dedupeKey,
    summary: f.summary,
    phrasedEn: phrased?.en ?? null,
    phrasedEs: phrased?.es ?? null,
    severity: f.severity,
    // The judge's verdict when it has one, the detector's default otherwise.
    // Which buttons a card offers — and whether it is a card at all — follows
    // the decision made WITH this hotel's numbers in front of it.
    disposition: effectiveDisposition(f),
    status: f.status,
    magnitude: f.magnitude,
    price: f.price,
    evidence: {
      queryId: f.evidence?.queryId ?? '',
      params: (f.evidence?.params ?? {}) as Record<string, unknown>,
      values: (f.evidence?.values ?? {}) as Record<string, unknown>,
      basis: f.evidence?.basis ?? '',
    },
    asOf: f.asOf,
    weakestInputAgeDays: f.weakestInputAgeDays,
    firstSeenAt: f.firstSeenAt,
    lastSeenAt: f.lastSeenAt,
    occurrenceCount: f.occurrenceCount,
  };
}

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
    const showable = rows.filter((f) => isCardRenderable({ disposition: effectiveDisposition(f) }));

    const phrasing = await judgedPhrasing(propertyId, showable.map((f) => f.id));
    const findings = showable.map((f) => toQueueFinding(f, phrasing.get(f.id)));

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
  if (!caller || !managerManagesHotel(caller, propertyId)) {
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

    const verdict = actionV.value! as ManagerVerdict;
    if (verdictIsEngagement(verdict)) {
      // Before the status change, because a resolved card is still the card the
      // manager engaged with — and after it the row may no longer be one this
      // hotel's queue reads back.
      await recordFindingActed(propertyId, idV.value!);
    }

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
