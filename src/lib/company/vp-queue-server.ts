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
// Wall A: `companyScopeFor` returns null for anyone without a COMPANY-scope
// hat, so a GM — even one who manages three hotels through property hats —
// never reaches this surface at all. Wall B: every hotel id comes from
// `propertiesOfOrganization(scope.organizationId)`, the one query that turns a
// company into a hotel list, and the organization id comes from the caller's
// own hats. There is no argument to this file that could name another company.
// ═══════════════════════════════════════════════════════════════════════════

import { log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { ManagerCaller } from '@/lib/team-auth';
import { propertiesOfOrganization, type MembershipHat } from '@/lib/company/access';
import {
  DAILY_CARD_CAP,
  effectiveDisposition,
  isCardRenderable,
  type CardSignOff,
} from '@/components/concourse/finding-cards';
import { judgedPhrasing, latestRunFacts, listFindings } from '@/lib/findings/store';
import { loadActionsForFindings } from '@/lib/findings/actions/store';
import { toQueueFinding } from '@/lib/findings/queue-projection';
import type { Finding } from '@/lib/findings/types';

import { listCompanyFindings, type CompanyFinding } from './company-findings';
import { loadApproverDirectory, resolveSignOff, type ApproverDirectory } from './signoff';
import { holdPortfolioDay, companyLocalToday, runPortfolioChecks } from './portfolio-runner';
import {
  climbReasonFor,
  daysOpen,
  rankPortfolio,
  type ClimbCandidate,
  type PortfolioCard,
} from './vp-queue';

// ─── Bounds ─────────────────────────────────────────────────────────────────

/**
 * How many hotels one portfolio load will read. A twenty-hotel company is a
 * real customer; a two-hundred-hotel one is a different product, and quietly
 * taking four seconds to render would be a worse answer than a bounded one.
 */
const MAX_HOTELS_PER_LOAD = 30;

/** Findings read per hotel before the climbing filter. */
const MAX_FINDINGS_PER_HOTEL = 100;

/**
 * Statuses the climbing rules are allowed to SEE.
 *
 * Deliberately includes the two silences: `known_problem` because a GM saying
 * "I know" must not hide a $3,100 problem from the person who could fund it,
 * and `muted` because the one case where mute is overridden (it grew past the
 * size it was muted at) cannot be evaluated on a row we never fetched. What is
 * excluded — `resolved`, `expired` — is excluded because those mean the problem
 * stopped being true, which is reality rather than a tap.
 */
const CLIMB_VISIBLE_STATUSES = ['open', 'updated', 'known_problem', 'muted'] as const;

// ─── Who is standing at the door ────────────────────────────────────────────

export type CompanyRole = 'owner' | 'vp' | 'finance';

export interface CompanyScope {
  organizationId: string;
  organizationName: string;
  /** The strongest COMPANY-scope job this person holds here. */
  companyRole: CompanyRole;
  hats: MembershipHat[];
  propertyIds: string[];
  propertyNames: Map<string, string>;
}

const COMPANY_ROLE_STRENGTH: Record<CompanyRole, number> = { owner: 3, vp: 2, finance: 1 };

/**
 * The company this person oversees, or null.
 *
 * NULL IS THE ANSWER FOR ALMOST EVERYBODY and it is Wall A: a hotel GM, a front
 * desk lead, a Staxis administrator, and every single-hotel account in the
 * product today all get null and never see this surface. A property-scope hat
 * — even one covering four hotels — is not oversight; it is four hotel jobs.
 *
 * When somebody wears company hats at two companies (rare, and legal), the
 * strongest job wins and the other company is simply not on this screen. That
 * beats merging two portfolios into one list, which would put two companies'
 * hotels side by side — the one thing Wall B exists to prevent.
 */
export async function companyScopeFor(caller: ManagerCaller): Promise<CompanyScope | null> {
  const companyHats = (caller.hats ?? []).filter((hat) => hat.scope === 'company');
  if (companyHats.length === 0) return null;

  let best: { hat: MembershipHat; role: CompanyRole } | null = null;
  for (const hat of companyHats) {
    const role = hat.role === 'owner' || hat.role === 'vp' || hat.role === 'finance'
      ? (hat.role as CompanyRole)
      : null;
    if (!role) continue;
    if (!best || COMPANY_ROLE_STRENGTH[role] > COMPANY_ROLE_STRENGTH[best.role]) {
      best = { hat, role };
    }
  }
  if (!best) return null;

  const organizationId = best.hat.organizationId;
  const propertyIds = (await propertiesOfOrganization(organizationId)).slice(0, MAX_HOTELS_PER_LOAD);

  return {
    organizationId,
    organizationName: await organizationName(organizationId),
    companyRole: best.role,
    // Only the hats at THIS company travel onward. A hat at another company
    // could otherwise satisfy an approver check here through a coverage list
    // that happens to overlap — it cannot today, because hatsSatisfyApprover
    // compares organization ids, but narrowing here means two independent
    // things would both have to be wrong.
    hats: (caller.hats ?? []).filter((hat) => hat.organizationId === organizationId),
    propertyIds,
    propertyNames: await hotelNames(propertyIds),
  };
}

async function organizationName(organizationId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from('organizations')
    .select('name')
    .eq('id', organizationId)
    .maybeSingle();
  return (data as { name?: string | null } | null)?.name ?? 'your company';
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
export async function portfolioRun(propertyIds: readonly string[]): Promise<PortfolioRun | null> {
  if (propertyIds.length === 0) return null;
  const runs = await Promise.all(
    propertyIds.map((propertyId) => latestRunFacts(propertyId).catch(() => null)),
  );
  const seen = runs.filter((run): run is NonNullable<typeof run> => run !== null);
  if (seen.length === 0) return null;

  let lastRunAt: string | null = null;
  let thingsChecked = 0;
  for (const run of seen) {
    thingsChecked += Math.max(0, Math.round(run.detectorsChecked));
    if (!lastRunAt || run.runAt > lastRunAt) lastRunAt = run.runAt;
  }
  return {
    thingsChecked,
    hotelsChecked: seen.length,
    hotelsTotal: propertyIds.length,
    lastRunAt,
  };
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
async function companyCards(scope: CompanyScope, now: Date): Promise<PortfolioCard[]> {
  const rows = await listCompanyFindings(scope.organizationId, {
    statuses: ['open', 'updated'],
    limit: 100,
  });
  return rows
    .filter((f) => isCardRenderable({ disposition: effectiveDisposition(f) }))
    .map((f: CompanyFinding) => ({
      ...toQueueFinding(f, { hotel: null, signOff: null }),
      hotel: null,
      climbReason: 'portfolio' as const,
      daysOpen: daysOpen(f.firstSeenAt, now),
    }));
}

// ─── Feed 2: what climbed from the hotels ───────────────────────────────────

async function climbedCards(
  scope: CompanyScope,
  caller: ManagerCaller,
  directory: ApproverDirectory,
  now: Date,
): Promise<PortfolioCard[]> {
  const perHotel = await Promise.all(scope.propertyIds.map(async (propertyId) => {
    try {
      return await climbedAtHotel(propertyId, scope, caller, directory, now);
    } catch (e) {
      // One unreadable hotel must not empty a portfolio. It is reported as an
      // absence rather than a zero, which is the best this layer can do — the
      // liveness rollup is what tells the reader how many hotels answered.
      log.warn('[vp-queue] a hotel could not be read; it is missing from this portfolio', {
        organizationId: scope.organizationId,
        propertyId,
        err: e instanceof Error ? e.message : String(e),
      });
      return [] as PortfolioCard[];
    }
  }));
  return perHotel.flat();
}

async function climbedAtHotel(
  propertyId: string,
  scope: CompanyScope,
  caller: ManagerCaller,
  directory: ApproverDirectory,
  now: Date,
): Promise<PortfolioCard[]> {
  const rows = await listFindings(propertyId, {
    statuses: [...CLIMB_VISIBLE_STATUSES],
    limit: MAX_FINDINGS_PER_HOTEL,
  });
  const showable = rows.filter((f) => isCardRenderable({ disposition: effectiveDisposition(f) }));
  if (showable.length === 0) return [];

  // Only a proposal can carry a live offer, and only a live offer can be
  // waiting on a signature. Filtering first keeps the action read proportional
  // to the decisions rather than to the whole ledger.
  const proposals = showable.filter((f) => effectiveDisposition(f) === 'propose');
  const actions = proposals.length > 0
    ? await loadActionsForFindings(propertyId, proposals.map((f) => f.id))
    : new Map();

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

  const climbed: Array<{ finding: Finding; reason: NonNullable<ReturnType<typeof climbReasonFor>> }> = [];
  for (const finding of showable) {
    const candidate: ClimbCandidate = {
      status: finding.status,
      price: finding.price,
      firstSeenAt: finding.firstSeenAt,
      magnitude: finding.magnitude,
      silencedAtMagnitude: finding.silencedAtMagnitude,
      awaitingMySignOff: awaitingMe.has(finding.id),
    };
    const reason = climbReasonFor(candidate, now);
    if (reason) climbed.push({ finding, reason });
  }
  if (climbed.length === 0) return [];

  // Phrasing is read only for the survivors — the judge's wording matters on a
  // card somebody will read, and a `select('*')` per hotel over a whole ledger
  // to phrase cards that were filtered out is the kind of cost that turns a
  // portfolio screen into a slow one.
  const phrasing = await judgedPhrasing(propertyId, climbed.map((c) => c.finding.id));
  const hotel = { propertyId, name: scope.propertyNames.get(propertyId) ?? 'this hotel' };

  return climbed.map(({ finding, reason }) => ({
    ...toQueueFinding(finding, {
      phrased: phrasing.get(finding.id) ?? null,
      action: actions.get(finding.id) ?? null,
      signOff: signOffs.get(finding.id) ?? null,
      hotel,
    }),
    hotel,
    climbReason: reason,
    daysOpen: daysOpen(finding.firstSeenAt, now),
  }));
}

// ─── The whole screen ───────────────────────────────────────────────────────

export interface PortfolioQueue {
  organizationId: string;
  organizationName: string;
  companyRole: CompanyRole;
  hotelCount: number;
  cards: PortfolioCard[];
  run: PortfolioRun | null;
  cap: number;
}

/**
 * Everything a company-scope person's queue shows, ranked.
 *
 * Returns null when the caller has no company job — Wall A, and the signal the
 * route uses to tell the client to render the ordinary hotel queue instead.
 */
export async function buildPortfolioQueue(
  caller: ManagerCaller,
  now: Date = new Date(),
): Promise<PortfolioQueue | null> {
  const scope = await companyScopeFor(caller);
  if (!scope) return null;

  // The portfolio checks run on the first load of the company's day, cached
  // against it. No cron to flip — see portfolio-runner.ts.
  try {
    const summary = await runPortfolioChecks({ organizationId: scope.organizationId, now });
    if (summary.ran) await holdPortfolioDay(scope.organizationId, summary.localDate, summary);
  } catch (e) {
    log.warn('[vp-queue] the portfolio checks did not run; the climbed cards still stand', {
      organizationId: scope.organizationId,
      err: e instanceof Error ? e.message : String(e),
    });
  }

  const directory = await loadApproverDirectory(scope.organizationId);
  const [company, climbed, run] = await Promise.all([
    companyCards(scope, now),
    climbedCards(scope, caller, directory, now),
    portfolioRun(scope.propertyIds),
  ]);

  return {
    organizationId: scope.organizationId,
    organizationName: scope.organizationName,
    companyRole: scope.companyRole,
    hotelCount: scope.propertyIds.length,
    cards: rankPortfolio([...company, ...climbed]),
    run,
    cap: DAILY_CARD_CAP,
  };
}

/** The company's own calendar day — the brief's cache key. Re-exported so the
 *  route and the brief agree on one clock. */
export { companyLocalToday };
