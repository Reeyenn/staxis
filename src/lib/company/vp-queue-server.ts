import 'server-only';

// ═══════════════════════════════════════════════════════════════════════════
// Building the portfolio queue: two completely independent feeds, joined only
// at the ranking.
//
//   1. COMPANY-SCOPE CARDS  — the portfolio checks (company_findings). Born
//      here. Nobody at a hotel has ever seen one.
//   2. CLIMBED HOTEL CARDS  — findings at the company's hotels that reached the
//      bar in src/lib/company/vp-queue.ts. Read from the hotels' own ledgers,
//      as facts, never as "what did the GM do with this card".
//
// ─── THIS FILE READS NO TAP STATE, AND THAT IS THE POINT ──────────────────
// The founder's ruling: "Seen silences the feed, never the boss. A GM tap must
// not add to, hide from, or dress up the VP's view." So `shown_count`,
// `acted_count` and `ignored_count` are never read here, `known_problem` does
// not filter anything out, and — the other half of the same rule — this
// assembly never WRITES `shown_count` either. A VP scrolling twelve hotels'
// problems must not demote a detector at a hotel they will never open, which is
// exactly what reusing the hotel queue's GET would have done.
//
// ─── WALL A AND WALL B ────────────────────────────────────────────────────
// Wall A is resolved before this file by the authoritative all-authorized
// receipt. Wall B: this builder accepts only that already-resolved company
// scope, then narrows its exact hotel ids to a disclosed processing window.
// A caller-supplied organization id is never converted directly into hotels.
// ═══════════════════════════════════════════════════════════════════════════

import { log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { ManagerCaller } from '@/lib/team-auth';
import type { MembershipHat } from '@/lib/company/access';
import type { CompanyScopeRole } from '@/lib/company/roles';
import {
  DAILY_CARD_CAP,
  effectiveDisposition,
  isCardRenderable,
  type CardSignOff,
} from '@/components/concourse/finding-cards';
import { toQueueFinding } from '@/lib/findings/queue-projection';
import { hotelBasisSpanish } from '@/lib/findings/basis-spanish';
import type { Finding } from '@/lib/findings/types';
import { mapWithConcurrency } from '@/lib/agent/portfolio/hotels';
import {
  loadPortfolioQueueReadModel,
  type PortfolioQueueReadModel,
} from '@/lib/company/portfolio-queue-bulk-read';
import {
  PORTFOLIO_DATA_SECTIONS,
  portfolioFindingPolicyDecision,
  portfolioHotelFindingPolicyDecision,
  portfolioSectionDecision,
  resolvePortfolioQueuePolicy,
  type PortfolioQueuePolicy,
} from '@/lib/company/portfolio-data-policy';

import { listCompanyFindings, type CompanyFinding } from './company-findings';
import { portfolioSpanish } from './portfolio-checks';
import { loadApproverDirectory, resolveSignOff, type ApproverDirectory } from './signoff';
import {
  holdPortfolioDay,
  companyLocalToday,
  runPortfolioChecks,
  type PortfolioRunCompletion,
} from './portfolio-runner';
import {
  chipForHotel,
  climbReasonFor,
  daysOpen,
  hotelHasLiveWork,
  rankPortfolio,
  type ClimbCandidate,
  type HotelChip,
  type PortfolioCard,
} from './vp-queue';

// ─── Bounds ─────────────────────────────────────────────────────────────────

/**
 * How many hotels one portfolio load will read. This is a disclosed work bound,
 * not an authorization bound: 31/61-hotel companies are processed completely,
 * while very large companies receive explicit coverage/omission metadata.
 */
export const MAX_HOTELS_PER_LOAD = 250;
export const PORTFOLIO_QUEUE_READ_CONCURRENCY = 8;

// ─── Who is standing at the door ────────────────────────────────────────────

/**
 * Re-exported from the shared vocabulary rather than re-declared, so this file
 * and `company/portfolio.ts` (the copilot's portfolio door) cannot drift about
 * what a company-scope job even is.
 */
export type CompanyRole = CompanyScopeRole;

export interface CompanyScope {
  organizationId: string;
  organizationName: string;
  /** The strongest COMPANY-scope job this person holds here. */
  companyRole: CompanyRole;
  hats: MembershipHat[];
  propertyIds: string[];
  propertyNames: Map<string, string>;
  coverage: PortfolioCoverage;
}

export interface PortfolioCoverage {
  authorizedHotelCount: number;
  attemptedHotelCount: number;
  processedHotelCount: number;
  omittedHotelCount: number;
  unavailableHotelCount: number;
  portfolioChecksStatus: PortfolioRunCompletion;
  complete: boolean;
}

/** Structural adapter for the feature-independent authoritative resolver. */
export interface AuthoritativeCompanyQueueAccess {
  organizationId: string;
  organizationName: string | null;
  companyRole: CompanyRole;
  /** Exact, sorted, untruncated all-authorized receipt scope. */
  propertyIds: readonly string[];
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hydrate the bounded queue scope from one authoritative receipt.
 *
 * The resolver has already failed closed for ambiguous omitted selection and
 * proven every id belongs to this account at this company. The 250-hotel work
 * budget is deliberately retained, but it is no longer a hidden authorization
 * truncation: the exact total and omission count travel with every response.
 */
export async function companyQueueScopeFromAuthorization(
  caller: Pick<ManagerCaller, 'hats'>,
  access: AuthoritativeCompanyQueueAccess,
): Promise<CompanyScope> {
  if (!UUID_RX.test(access.organizationId)
    || access.propertyIds.length === 0
    || access.propertyIds.length > 5000
    || access.propertyIds.some((id) => !UUID_RX.test(id))
    || access.propertyIds.some((id, index) => index > 0 && id <= access.propertyIds[index - 1])) {
    throw new Error('authoritative company queue scope was not canonical');
  }
  const authorizedHotelCount = access.propertyIds.length;
  const propertyIds = [...access.propertyIds].slice(0, MAX_HOTELS_PER_LOAD);
  const processedHotelCount = propertyIds.length;
  const omittedHotelCount = Math.max(0, authorizedHotelCount - processedHotelCount);

  return {
    organizationId: access.organizationId,
    organizationName: access.organizationName ?? 'your company',
    companyRole: access.companyRole,
    // Sign-off still consumes legacy hats. Tenant reach and queue admission do
    // not: both came from the authoritative receipt before this adapter runs.
    hats: (caller.hats ?? []).filter((hat) => hat.organizationId === access.organizationId),
    propertyIds,
    propertyNames: await hotelNames(propertyIds),
    coverage: {
      authorizedHotelCount,
      attemptedHotelCount: processedHotelCount,
      processedHotelCount,
      omittedHotelCount,
      unavailableHotelCount: 0,
      // Conservative internal placeholder; buildPortfolioQueue replaces it
      // with the tri-state receipt returned by the deterministic check runner.
      portfolioChecksStatus: 'unavailable',
      complete: false,
    },
  };
}

async function hotelNames(propertyIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (propertyIds.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id, name')
    .in('id', [...propertyIds]);
  if (error || !Array.isArray(data)) return out;
  for (const row of data as Array<{ id: string; name: string | null }>) {
    out.set(row.id, row.name ?? 'this hotel');
  }
  return out;
}

// ─── The liveness rollup ────────────────────────────────────────────────────

export interface PortfolioRun {
  /** Sum of `detectors_checked` across the company's hotels' latest runs. */
  thingsChecked: number;
  /** How many of the company's hotels have ever been checked. */
  hotelsChecked: number;
  hotelsTotal: number;
  /** The most recent run at any of them, ISO. Null when none ever ran. */
  lastRunAt: string | null;
}

/**
 * "Checked 384 things overnight", assembled from the hotels' OWN run rows.
 *
 * There is deliberately no company-level runs table (see migration 0367): a
 * second liveness artifact would be a second, weaker copy of one that already
 * exists per hotel — and it would be able to disagree with what each GM sees on
 * their own screen about the same night.
 *
 * Null when not one hotel has ever been checked. That is the honest silence
 * rule one level up: a company whose hotels have never been scanned gets no
 * brief and no liveness claim, because every sentence either could print is a
 * claim about having looked.
 */
interface PortfolioRunLoad {
  run: PortfolioRun | null;
  unavailablePropertyIds: string[];
}

function portfolioRunFromReadModel(
  readModel: PortfolioQueueReadModel,
  authorizedHotelCount: number,
): PortfolioRunLoad {
  const unavailablePropertyIds = readModel.unavailableRunPropertyIds;
  const seen = [...readModel.latestRunByPropertyId.values()];
  if (seen.length === 0) return { run: null, unavailablePropertyIds };

  let lastRunAt: string | null = null;
  let thingsChecked = 0;
  for (const run of seen) {
    thingsChecked += Math.max(0, Math.round(run.detectorsChecked));
    if (!lastRunAt || run.runAt > lastRunAt) lastRunAt = run.runAt;
  }
  return {
    run: {
      thingsChecked,
      hotelsChecked: seen.length,
      hotelsTotal: Math.max(readModel.propertyIds.length, authorizedHotelCount),
      lastRunAt,
    },
    unavailablePropertyIds,
  };
}

export async function portfolioRun(
  propertyIds: readonly string[],
  authorizedHotelCount = propertyIds.length,
): Promise<PortfolioRun | null> {
  const readModel = await loadPortfolioQueueReadModel(propertyIds);
  return portfolioRunFromReadModel(readModel, authorizedHotelCount).run;
}

// ─── The health chip, per hotel ─────────────────────────────────────────────

/**
 * One chip per hotel for the command centre — the picker a company-scope person
 * lands on every morning.
 *
 * ─── WHY THIS IS NOT `buildPortfolioQueue().cards` GROUPED BY HOTEL ────────
 * It very nearly is, and it deliberately reuses the same three primitives
 * (`listFindings` at the same statuses, `isCardRenderable` + `effectiveDisposition`
 * to decide what counts as a card at all, `climbReasonFor` for what reaches the
 * company, `latestRunFacts` for liveness) so a chip can never disagree with the
 * queue it links to. What it does NOT do is the expensive half: no portfolio
 * check run, no approver directory, no per-proposal sign-off resolution, no
 * judged phrasing, no brief. Those exist to render sentences, and a chip has no
 * sentence to render — it has three words. The picker is the first screen of
 * the day and it must open now.
 *
 * ─── THE ONE PLACE THIS IS DELIBERATELY COARSER THAN THE QUEUE ────────────
 * `climbReasonFor` is asked with `awaitingMySignOff: false`, so a card that
 * climbed ONLY because the company's rulebook routes it to this reader shows up
 * as "waiting" rather than "needs you". That is not a miss: a proposal awaiting
 * a signature is by definition also a live `propose` finding, so it is already
 * counted, and resolving the rulebook for every proposal at every hotel would
 * put the whole sign-off machinery on the critical path of a sign-in.
 *
 * NEVER THROWS. One unreadable hotel yields a null chip — "we cannot say" —
 * rather than emptying the screen or, far worse, reporting the hotel as quiet.
 */
export async function hotelHealthChips(
  propertyIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, HotelChip | null>> {
  const out = new Map<string, HotelChip | null>();
  if (propertyIds.length === 0) return out;

  const bounded = propertyIds.slice(0, MAX_HOTELS_PER_LOAD);
  const readModel = await loadPortfolioQueueReadModel(bounded);
  const unavailableFindings = new Set(readModel.unavailableFindingPropertyIds);
  const unavailableRuns = new Set(readModel.unavailableRunPropertyIds);
  for (const propertyId of bounded) {
    if (unavailableFindings.has(propertyId) || unavailableRuns.has(propertyId)) {
      out.set(propertyId, null);
      continue;
    }
    const showable = (readModel.findingsByPropertyId.get(propertyId) ?? [])
      .filter((finding) => isCardRenderable({
        disposition: effectiveDisposition(finding),
        detectorId: finding.detectorId,
      }));
    let climbedCount = 0;
    for (const finding of showable) {
      const candidate: ClimbCandidate = {
        status: finding.status,
        price: finding.price,
        severity: finding.severity,
        firstSeenAt: finding.firstSeenAt,
        magnitude: finding.magnitude,
        silencedAtMagnitude: finding.silencedAtMagnitude,
        awaitingMySignOff: false,
      };
      if (climbReasonFor(candidate, now)) climbedCount += 1;
    }
    const { waitingCount, criticalCount } = liveFeedCounts(showable);
    const run = readModel.latestRunByPropertyId.get(propertyId) ?? null;
    const hoursSinceRun = run
      ? (now.getTime() - new Date(run.runAt).getTime()) / 3_600_000
      : null;
    out.set(propertyId, chipForHotel({
      climbedCount,
      waitingCount,
      criticalCount,
      hoursSinceRun: hoursSinceRun !== null && Number.isFinite(hoursSinceRun)
        ? Math.max(0, hoursSinceRun)
        : null,
    }));
  }
  return out;
}

/**
 * The hotel's OWN live feed, counted — the numbers behind both the picker chip
 * and the brief's "quiet" claim.
 *
 * ONE function on purpose. These two lines were written twice, in two files, and
 * the copies were identical right up until one screen said "2 WAITING" and the
 * other called the same hotel quiet. The two silences are excluded here even
 * though the CLIMBING rules deliberately see them: a manager who pressed "Seen"
 * has not left a decision waiting for anyone, which is a different question from
 * whether their boss should hear about it.
 */
function liveFeedCounts(
  showable: readonly Finding[],
): { waitingCount: number; criticalCount: number } {
  let waitingCount = 0;
  let criticalCount = 0;
  for (const finding of showable) {
    const live = finding.status === 'open' || finding.status === 'updated';
    if (!live) continue;
    if (effectiveDisposition(finding) === 'propose') waitingCount += 1;
    if (finding.severity === 'critical') criticalCount += 1;
  }
  return { waitingCount, criticalCount };
}

// ─── Feed 1: the company's own cards ────────────────────────────────────────

/**
 * Cross-hotel comparisons and portfolio aggregates.
 *
 * Read at LIVE statuses only — unlike the climbed hotel cards. The difference is
 * not an inconsistency: on a company card the VP IS the audience, so their own
 * "Seen" is the reader silencing their own feed, which is exactly the thing
 * `known_problem` has always meant. It is a GM's tap that must not reach up
 * here, and a GM has no way to touch a company card at all.
 */
async function companyCards(
  scope: CompanyScope,
  now: Date,
  policy: PortfolioQueuePolicy,
  canActOnFinding?: (finding: CompanyFinding) => Promise<boolean>,
): Promise<PortfolioCard[]> {
  const rows = await listCompanyFindings(scope.organizationId, {
    statuses: ['open', 'updated'],
    limit: 100,
  });
  return mapWithConcurrency(
    rows.filter((f) => (
      portfolioFindingPolicyDecision(f, policy) === 'allowed'
      && isCardRenderable({
        disposition: effectiveDisposition(f),
        detectorId: f.detectorId,
      })
    )),
    PORTFOLIO_QUEUE_READ_CONCURRENCY,
    async (f: CompanyFinding) => {
      // Spanish, rebuilt from this row's own receipt. `company_findings` has no
      // judged_* columns, so without this a company card is English on every
      // screen — including a Spanish-reading VP's, which is the only screen it
      // ever appears on. See portfolioSpanish for why it is derived rather than
      // stored.
      const es = portfolioSpanish(f.detectorId, f.evidence);
      return {
        ...toQueueFinding(f, {
          hotel: null,
          signOff: null,
          phrased: es ? { en: null, es: es.summary } : null,
          basisEs: es ? { price: es.priceBasis, evidence: es.basis } : null,
        }),
        hotel: null,
        climbReason: 'portfolio' as const,
        daysOpen: daysOpen(f.firstSeenAt, now),
        canAct: canActOnFinding ? await canActOnFinding(f).catch(() => false) : false,
      };
    },
  );
}

// ─── Feed 2: what climbed from the hotels ───────────────────────────────────

interface HotelClimb {
  cards: PortfolioCard[];
  /**
   * True when this hotel has live work of its own — the SAME predicate the
   * command centre's chip uses. Carried out of here rather than recomputed
   * because the findings were already read; see `hotelHasLiveWork` for the
   * live disagreement this closes ("2 WAITING" vs "quiet", same hotel).
   */
  hasLiveWork: boolean;
}

async function climbedCards(
  scope: CompanyScope,
  caller: ManagerCaller,
  directory: ApproverDirectory,
  readModel: PortfolioQueueReadModel,
  now: Date,
): Promise<{
  cards: PortfolioCard[];
  busyHotelIds: string[];
  unavailablePropertyIds: string[];
}> {
  const bulkUnavailable = new Set(readModel.unavailableFindingPropertyIds);
  const readablePropertyIds = scope.propertyIds.filter(
    (propertyId) => !bulkUnavailable.has(propertyId),
  );
  const perHotel = await mapWithConcurrency(
    readablePropertyIds,
    PORTFOLIO_QUEUE_READ_CONCURRENCY,
    async (propertyId) => {
    try {
      return {
        ...await climbedAtHotel(
          propertyId,
          scope,
          caller,
          directory,
          readModel,
          now,
        ),
        available: true as const,
      };
    } catch (e) {
      // One unreadable hotel must not empty a portfolio. It is reported as an
      // absence rather than a zero, which is the best this layer can do — the
      // liveness rollup is what tells the reader how many hotels answered.
      log.warn('[vp-queue] a hotel could not be read; it is missing from this portfolio', {
        organizationId: scope.organizationId,
        propertyId,
        err: e instanceof Error ? e.message : String(e),
      });
      // Neither quiet nor busy: both are claims. Coverage carries the failure
      // explicitly and the route suppresses the whole-company brief.
      return { cards: [] as PortfolioCard[], hasLiveWork: false, available: false as const };
    }
    },
  );
  return {
    cards: perHotel.flatMap((h) => h.cards),
    busyHotelIds: readablePropertyIds.filter((_, i) => (
      perHotel[i].available !== false && perHotel[i].hasLiveWork
    )),
    unavailablePropertyIds: [
      ...readModel.unavailableFindingPropertyIds,
      ...readablePropertyIds.filter((_, i) => perHotel[i].available === false),
    ],
  };
}

async function climbedAtHotel(
  propertyId: string,
  scope: CompanyScope,
  caller: ManagerCaller,
  directory: ApproverDirectory,
  readModel: PortfolioQueueReadModel,
  now: Date,
): Promise<HotelClimb> {
  const rows = readModel.findingsByPropertyId.get(propertyId) ?? [];
  const showable = rows.filter((f) => isCardRenderable({ disposition: effectiveDisposition(f), detectorId: f.detectorId }));
  if (showable.length === 0) return { cards: [], hasLiveWork: false };

  // Only a proposal can carry a live offer, and only a live offer can be
  // waiting on a signature. Filtering first keeps the action read proportional
  // to the decisions rather than to the whole ledger.
  const proposals = showable.filter((f) => effectiveDisposition(f) === 'propose');
  const actions = readModel.actionByFindingId;

  const signOffs = new Map<string, CardSignOff>();
  const awaitingMe = new Set<string>();
  for (const finding of proposals) {
    const action = actions.get(finding.id);
    if (action?.state !== 'proposed') continue;
    const requirement = await resolveSignOff({
      organizationId: scope.organizationId,
      propertyId,
      actionKind: action.kind,
      price: finding.price,
      callerAccountId: caller.accountId,
      callerHats: scope.hats,
      directory,
    });
    if (!requirement) continue;
    signOffs.set(finding.id, {
      approverRole: requirement.approverRole,
      approverNames: requirement.approvers
        .map((a) => a.name)
        .filter((n): n is string => !!n && n.trim().length > 0),
      thresholdCents: requirement.thresholdCents,
      callerMayApprove: requirement.callerMayApprove,
    });
    // The card is on THIS person's screen to be signed only when the signature
    // the company named is one they hold. A rule that routes to the owner does
    // not put the card in the VP's queue.
    if (requirement.callerMayApprove) awaitingMe.add(finding.id);
  }

  // Counted over the same rows, by the same function the picker chip uses.
  const { waitingCount, criticalCount } = liveFeedCounts(showable);

  const climbed: Array<{ finding: Finding; reason: NonNullable<ReturnType<typeof climbReasonFor>> }> = [];
  for (const finding of showable) {
    const candidate: ClimbCandidate = {
      status: finding.status,
      price: finding.price,
      severity: finding.severity,
      firstSeenAt: finding.firstSeenAt,
      magnitude: finding.magnitude,
      silencedAtMagnitude: finding.silencedAtMagnitude,
      awaitingMySignOff: awaitingMe.has(finding.id),
    };
    const reason = climbReasonFor(candidate, now);
    if (reason) climbed.push({ finding, reason });
  }
  const hasLiveWork = hotelHasLiveWork({
    climbedCount: climbed.length,
    waitingCount,
    criticalCount,
  });
  if (climbed.length === 0) return { cards: [], hasLiveWork };

  // Phrasing is read only for the survivors — the judge's wording matters on a
  // card somebody will read, and a `select('*')` per hotel over a whole ledger
  // to phrase cards that were filtered out is the kind of cost that turns a
  // portfolio screen into a slow one.
  const phrasing = readModel.phrasingByFindingId;
  const hotel = { propertyId, name: scope.propertyNames.get(propertyId) ?? 'this hotel' };

  return {
    cards: climbed.map(({ finding, reason }) => ({
      ...toQueueFinding(finding, {
        phrased: phrasing.get(finding.id) ?? null,
        action: actions.get(finding.id) ?? null,
        signOff: signOffs.get(finding.id) ?? null,
        hotel,
        // A CLIMBED card is a hotel finding on a VP's screen — the one place a
        // hotel detector's English basis is guaranteed to be read by somebody
        // who may not read English. Same producer the hotel queue uses, so the
        // card says the same thing in both places.
        basisEs: hotelBasisSpanish(finding.detectorId, finding.evidence),
      }),
      hotel,
      climbReason: reason,
      daysOpen: daysOpen(finding.firstSeenAt, now),
    })),
    hasLiveWork,
  };
}

// ─── The whole screen ───────────────────────────────────────────────────────

export interface PortfolioQueue {
  organizationId: string;
  organizationName: string;
  companyRole: CompanyRole;
  hotelCount: number;
  coverage: PortfolioCoverage;
  cards: PortfolioCard[];
  run: PortfolioRun | null;
  cap: number;
  /** Cache partition for every current section and money projection decision. */
  policyFingerprint: string;
  /**
   * Hotels the chip rule considers busy. Handed to the brief so its "N hotels
   * quiet" line cannot call a hotel quiet while the command centre's chip for
   * the same hotel says "2 waiting". See `hotelHasLiveWork`.
   */
  busyHotelIds: string[];
}

export interface PortfolioQueueActionability {
  canActAtHotel?: (propertyId: string) => boolean;
  canActOnCompanyFinding?: (finding: CompanyFinding) => Promise<boolean>;
}

/**
 * Everything a company-scope person's queue shows, ranked.
 *
 * Scope resolution is intentionally not repeated here: the route passes the
 * exact scope it used for rate limiting and will re-assert its receipt before
 * releasing the response.
 */
export async function buildPortfolioQueue(
  caller: ManagerCaller,
  scope: CompanyScope,
  now: Date = new Date(),
  actionability: PortfolioQueueActionability = {},
): Promise<PortfolioQueue> {
  // The portfolio checks run on the first load of the company's day, cached
  // against it. No cron to flip — see portfolio-runner.ts.
  let portfolioChecksStatus: PortfolioRunCompletion = 'unavailable';
  try {
    const summary = await runPortfolioChecks({ organizationId: scope.organizationId, now });
    portfolioChecksStatus = summary.completion;
    if (summary.ran && summary.completion === 'completed') {
      await holdPortfolioDay(scope.organizationId, summary.localDate, summary);
    }
  } catch (e) {
    portfolioChecksStatus = 'unavailable';
    log.warn('[vp-queue] the portfolio checks did not run; the climbed cards still stand', {
      organizationId: scope.organizationId,
      err: e instanceof Error ? e.message : String(e),
    });
  }

  const [directory, rawReadModel, policy] = await Promise.all([
    loadApproverDirectory(scope.organizationId),
    loadPortfolioQueueReadModel(scope.propertyIds),
    resolvePortfolioQueuePolicy(caller, scope.organizationId, scope.propertyIds),
  ]);
  const policyUnavailablePropertyIds = new Set<string>();
  const findingsByPropertyId = new Map<string, Finding[]>();
  for (const propertyId of scope.propertyIds) {
    if (PORTFOLIO_DATA_SECTIONS.some(
      (section) => portfolioSectionDecision(policy, section, propertyId) === 'unavailable',
    ) || policy.financials.get(propertyId) === 'unavailable') {
      policyUnavailablePropertyIds.add(propertyId);
    }
    const allowed: Finding[] = [];
    for (const finding of rawReadModel.findingsByPropertyId.get(propertyId) ?? []) {
      const decision = portfolioHotelFindingPolicyDecision(finding, policy);
      if (decision === 'allowed') allowed.push(finding);
      else if (decision === 'unavailable') policyUnavailablePropertyIds.add(propertyId);
    }
    findingsByPropertyId.set(propertyId, allowed);
  }
  const readModel: PortfolioQueueReadModel = {
    ...rawReadModel,
    findingsByPropertyId,
    unavailableFindingPropertyIds: [
      ...new Set([
        ...rawReadModel.unavailableFindingPropertyIds,
        ...policyUnavailablePropertyIds,
      ]),
    ],
  };
  const [company, climbed] = await Promise.all([
    companyCards(scope, now, policy, actionability.canActOnCompanyFinding),
    climbedCards(scope, caller, directory, readModel, now),
  ]);
  const runLoad = portfolioRunFromReadModel(
    readModel,
    scope.coverage.authorizedHotelCount,
  );
  const unavailablePropertyIds = new Set([
    ...climbed.unavailablePropertyIds,
    ...runLoad.unavailablePropertyIds,
  ]);
  const coverage: PortfolioCoverage = {
    ...scope.coverage,
    processedHotelCount: Math.max(
      0,
      scope.coverage.attemptedHotelCount - unavailablePropertyIds.size,
    ),
    unavailableHotelCount: unavailablePropertyIds.size,
    portfolioChecksStatus,
    complete: scope.coverage.omittedHotelCount === 0
      && unavailablePropertyIds.size === 0
      && (portfolioChecksStatus === 'completed' || portfolioChecksStatus === 'held'),
  };

  return {
    organizationId: scope.organizationId,
    organizationName: scope.organizationName,
    companyRole: scope.companyRole,
    hotelCount: scope.coverage.authorizedHotelCount,
    coverage,
    cards: rankPortfolio([
      ...company,
      ...climbed.cards.map((card) => ({
        ...card,
        canAct: card.hotel
          ? actionability.canActAtHotel?.(card.hotel.propertyId) === true
          : false,
      })),
    ]),
    run: runLoad.run,
    cap: DAILY_CARD_CAP,
    policyFingerprint: policy.fingerprint,
    busyHotelIds: climbed.busyHotelIds,
  };
}

/** The company's own calendar day — the brief's cache key. Re-exported so the
 *  route and the brief agree on one clock. */
export { companyLocalToday };
