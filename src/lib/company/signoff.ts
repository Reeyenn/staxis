import 'server-only';

// ═══════════════════════════════════════════════════════════════════════════
// SIGN-OFF ROUTING — the rulebook decides whose finger goes on the button.
//
// The company writes "any order over $500 needs VP approval" once. From that
// moment, a one-tap fix Staxis offers at any of its hotels whose cost clears
// $500 must not be executable by the GM — and must be executable by the VP.
//
// THE FOUNDER'S RULE, AND WHY IT SHAPES THIS FILE: THE CARD IS LOCKED, NOT
// HIDDEN. The GM still sees the whole thing — the problem, the numbers, the
// receipt, the plan — with the button replaced by "Needs VP sign-off — sent to
// Maria". Hiding it would teach a GM that Staxis quietly withholds things,
// which is a worse product than one that says "not your signature".
//
// ─── WHY THE RULE IS RESOLVED AT SERVE TIME AND NOT FROZEN ON THE ROW ──────
// The hands freeze their PARAMS at proposal time and never re-read them: what
// runs must be what was shown. Routing is the opposite kind of question.
//
//   • A rule written today must govern offers made yesterday. Offers are
//     re-proposed nightly, and `proposeAction` returns 'unchanged' for an
//     identical plan — so a frozen routing column would never be rewritten and
//     the new rule would silently fail to apply to every standing card.
//   • A rule the company DELETED must stop applying immediately. A frozen
//     column would keep a card locked against a rule that no longer exists.
//   • The rulebook is the current law; the plan is the frozen artefact. Mixing
//     them would make "who may sign" as immutable as "what gets done", and only
//     one of those is supposed to be.
//
// The safety property is preserved by checking at BOTH ends: the queue route
// resolves it to decide what the card renders, and the execute route resolves
// it again before it calls the database. A stale browser cannot tap through a
// lock, because the browser is not what enforces it.
//
// ─── NULL IS NEVER "APPROVED" ──────────────────────────────────────────────
// `authorityRuleFor` returns null for "nothing in the rulebook governs this",
// and this file preserves that meaning exactly: no rule ⇒ no lock ⇒ the card
// behaves precisely as it did before companies existed. That is also the answer
// for an independent hotel, a company with an empty rulebook, and a database
// that could not be read. It is never an assertion that somebody approved.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import {
  listAuthorityRules,
  readAuthorityRuleFor,
  type AuthorityRule,
  type AuthorityRuleRead,
} from '@/lib/company/authority';
import { companyForProperty, loadHats, type MembershipHat } from '@/lib/company/access';
import { listFindings } from '@/lib/findings/store';
import { loadActionsForFindings } from '@/lib/findings/actions/store';
import { effectiveDisposition } from '@/components/concourse/finding-cards';
import type { AuthorityActionKind, AuthorityApproverRole } from '@/lib/company/rulebook-policy';
import type { FindingActionKind } from '@/lib/findings/actions/types';
import type { PriceRange } from '@/lib/findings/types';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── What kind of company decision is each one-tap fix? ─────────────────────

/**
 * The one place a Staxis action kind is translated into the vocabulary the
 * company's own rulebook uses. Both entries are judgement calls and both are
 * written down here rather than inferred anywhere else:
 *
 *   create_work_order            → 'expense'
 *     Tapping this books a repair the hotel will pay a vendor for. It is not a
 *     purchase order (nothing is being bought from a supplier) and it is not a
 *     capital project (a $600 compressor is not cap-ex). "Expense" is what a
 *     controller would call it, and the price range on the card is the money at
 *     stake.
 *
 *   raise_inventory_reorder_point → 'purchase_order'
 *     This changes WHAT and WHEN the hotel buys. No money moves at the tap, but
 *     the reason a company writes "orders over $500 need VP approval" is to
 *     control committed supply spend, and quietly raising the trigger that
 *     causes those orders is the same decision one step earlier.
 *
 * A kind that is NOT in this map routes to nothing — no rule can apply, so the
 * card behaves as it always has. Adding an action kind without adding it here
 * is therefore a safe omission rather than a silent bypass of a rule that would
 * otherwise have fired: a bypass requires a mapping to exist and be wrong.
 */
const ACTION_KIND_TO_AUTHORITY: Readonly<Record<FindingActionKind, AuthorityActionKind>> =
  Object.freeze({
    create_work_order: 'expense',
    raise_inventory_reorder_point: 'purchase_order',
  });

export function authorityKindForAction(kind: string): AuthorityActionKind | null {
  return (ACTION_KIND_TO_AUTHORITY as Record<string, AuthorityActionKind>)[kind] ?? null;
}

/**
 * The number a money rule is applied to: the TOP of the finding's price range.
 *
 * Prices in this product are ranges by law ("$400–800", never "$600"), so
 * routing has to pick an end, and it picks the expensive one. A company that
 * wrote "over $500 needs a VP" did not mean "unless it MIGHT come in at $400" —
 * routing on the low end would let every plan whose range straddles the
 * threshold through the gate that was written to catch exactly those.
 *
 * Null when the finding carries no price at all. That is not a loophole being
 * left open, it is the honest limit of the rulebook: every authority rule in the
 * product is a money threshold, and a plan with no dollar figure has no amount
 * for a money threshold to be about. The card behaves as an ordinary card,
 * which is what it was before this file existed.
 */
export function routingAmountCents(price: PriceRange | null | undefined): number | null {
  if (!price) return null;
  const high = price.highCents;
  return Number.isFinite(high) && high >= 0 ? Math.round(high) : null;
}

// ─── Who is allowed to sign ─────────────────────────────────────────────────

/**
 * Strong-to-weak, matching APPROVER_STRENGTH in authority.ts. A stronger job
 * may sign for a weaker one — an owner can approve what a regional manager was
 * named for, because a rulebook that made the owner ask the regional manager
 * for permission would be describing a company that does not exist.
 */
const APPROVER_STRENGTH: Record<AuthorityApproverRole, number> = {
  owner: 2,
  regional_manager: 1,
  general_manager: 0,
};

/** The hat roles that can ever hold a signature. Line staff never can. */
function approverRoleOfHat(hat: MembershipHat): AuthorityApproverRole | null {
  switch (hat.role) {
    case 'owner': return 'owner';
    case 'regional_manager': return 'regional_manager';
    case 'general_manager': return 'general_manager';
    default: return null;
  }
}

/**
 * Does one of this person's hats satisfy the named signature AT THIS HOTEL?
 *
 * Coverage is part of the question, not an afterthought: a GM of Beaumont
 * satisfies a "GM approves" rule at Beaumont and satisfies nothing at Lufkin.
 */
export function hatsSatisfyApprover(
  hats: readonly MembershipHat[],
  organizationId: string,
  propertyId: string | null,
  required: AuthorityApproverRole,
): boolean {
  return hats.some((hat) => {
    if (hat.organizationId !== organizationId) return false;
    // A company-scope hat covers every hotel the company operates; a
    // company-scope card (propertyId null) can only be signed by one.
    if (propertyId === null) {
      if (hat.scope !== 'company') return false;
    } else if (!hat.coveredPropertyIds.includes(propertyId)) {
      return false;
    }
    const role = approverRoleOfHat(hat);
    return role !== null && APPROVER_STRENGTH[role] >= APPROVER_STRENGTH[required];
  });
}

/**
 * A rule whose signature is the GM's OWN never leaves the hotel. The card is
 * the GM's to act on and climbs to nobody — a company that wrote "GMs approve
 * their own purchases up to X" wrote a rule that keeps the decision local, and
 * routing it upward would invent an escalation the company did not ask for.
 */
export function ruleLeavesTheHotel(rule: AuthorityRule): boolean {
  return rule.approverRole !== 'general_manager';
}

// ─── The requirement, as the card renders it ────────────────────────────────

export interface SignOffApprover {
  accountId: string;
  /** Display name, or null when the account has none. Cosmetic, never a gate. */
  name: string | null;
}

export interface SignOffRequirement {
  ruleId: string;
  organizationId: string;
  actionKind: AuthorityActionKind;
  approverRole: AuthorityApproverRole;
  thresholdCents: number;
  thresholdInclusive: boolean;
  /** The figure the rule was applied to — the top of the finding's range. */
  amountCents: number;
  /** People whose job satisfies the signature at this hotel. May be empty. */
  approvers: SignOffApprover[];
  /**
   * True when the person looking at this card may sign it themselves. The card
   * is LOCKED when this is false, and behaves normally when it is true — which
   * is what a VP opening a hotel's own queue should see.
   */
  callerMayApprove: boolean;
}

/**
 * Everybody at one company with their hats already resolved.
 *
 * Built ONCE per request and passed down, because the alternative is O(cards ×
 * members) calls to `loadHats` — three queries each — on a screen that renders
 * a dozen hotels. A VP queue that took four seconds to say "two need you" would
 * not be read.
 */
export type ApproverDirectory = ReadonlyArray<{
  accountId: string;
  name: string | null;
  hats: readonly MembershipHat[];
}>;

export interface ResolveSignOffArgs {
  organizationId: string | null;
  /** The hotel the card belongs to. Null for a company-scope card. */
  propertyId: string | null;
  actionKind: string;
  price: PriceRange | null | undefined;
  /** The person on the other end of the request. */
  callerAccountId: string;
  /** Pre-loaded hats for the caller, to avoid one lookup per card. */
  callerHats?: readonly MembershipHat[];
  /** Pre-loaded company directory, to avoid one lookup per card per member. */
  directory?: ApproverDirectory;
}

/**
 * The three answers, kept apart.
 *
 *   none         nothing in the rulebook governs this offer. The pre-company
 *                behaviour, and the overwhelmingly common case.
 *   requirement  a rule reaches it; `requirement.callerMayApprove` says whether
 *                the person looking at it holds the signature.
 *   unreadable   WE DO NOT KNOW. The rulebook could not be read.
 *
 * The third is not a variant of the first. A renderer may treat them alike and
 * draw an ordinary card; the execute gate must not, because "we could not check
 * whether this needs the owner's signature" and "the owner does not need to sign
 * this" are opposite statements and only one of them is safe to spend on.
 */
export type SignOffResolution =
  | { kind: 'none' }
  | { kind: 'requirement'; requirement: SignOffRequirement }
  | { kind: 'unreadable'; error: string };

/**
 * Does this offer need somebody else's signature, and whose — with "we could
 * not tell" kept as its own answer.
 *
 * Anything that WRITES calls this one. Anything that merely renders may call
 * `resolveSignOff` below, which folds `unreadable` into null.
 */
export async function resolveSignOffStrict(
  args: ResolveSignOffArgs,
): Promise<SignOffResolution> {
  const { organizationId, propertyId, callerAccountId } = args;
  if (!organizationId || !UUID_RX.test(organizationId)) return { kind: 'none' };

  const authorityKind = authorityKindForAction(args.actionKind);
  if (!authorityKind) return { kind: 'none' };

  const amountCents = routingAmountCents(args.price);
  if (amountCents === null) return { kind: 'none' };

  let read: AuthorityRuleRead;
  try {
    read = await readAuthorityRuleFor(organizationId, authorityKind, amountCents);
  } catch (e) {
    read = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!read.ok) {
    log.warn('[signoff] the rulebook could not be read', {
      organizationId,
      err: read.error,
    });
    return { kind: 'unreadable', error: read.error };
  }
  const rule = read.rule;
  if (!rule) return { kind: 'none' };

  const hats = args.callerHats ?? (await loadHats(callerAccountId));
  const callerMayApprove = hatsSatisfyApprover(
    hats,
    organizationId,
    propertyId,
    rule.approverRole,
  );

  return {
    kind: 'requirement',
    requirement: {
      ruleId: rule.id,
      organizationId,
      actionKind: rule.actionKind,
      approverRole: rule.approverRole,
      thresholdCents: rule.thresholdCents,
      thresholdInclusive: rule.thresholdInclusive,
      amountCents,
      approvers: approversFrom(
        args.directory ?? (await loadApproverDirectory(organizationId)),
        organizationId,
        propertyId,
        rule.approverRole,
      ),
      callerMayApprove,
    },
  };
}

/**
 * Does this offer need somebody else's signature, and whose?
 *
 * Returns null for "nothing governs this" — no company, no price, an unmapped
 * action kind, no rule that reaches this amount, or a store that could not
 * answer. Null is the pre-company behaviour, and it is never a claim that
 * anything was approved.
 *
 * FAIL-OPEN, DELIBERATELY, AND ONLY FOR READERS. A card that cannot resolve the
 * rulebook renders as an ordinary card — a cosmetic degradation that the execute
 * gate then catches, because /api/findings/actions calls
 * `resolveSignOffStrict` and REFUSES on `unreadable`. Never use this function to
 * decide whether something may run.
 */
export async function resolveSignOff(
  args: ResolveSignOffArgs,
): Promise<SignOffRequirement | null> {
  const resolution = await resolveSignOffStrict(args);
  return resolution.kind === 'requirement' ? resolution.requirement : null;
}

/**
 * Who, out of this company's people, satisfies the signature at this hotel.
 *
 * Pure, over a directory that was loaded once. Wall B is already enforced twice
 * over by the time it runs: the directory is filtered to `organizationId`, and
 * `hatsSatisfyApprover` re-checks each hat's own organization anyway — because
 * a helper whose correctness depends on its caller having filtered is a helper
 * that will one day be called by somebody who did not.
 */
export function approversFrom(
  directory: ApproverDirectory,
  organizationId: string,
  propertyId: string | null,
  required: AuthorityApproverRole,
): SignOffApprover[] {
  return directory
    .filter((person) => hatsSatisfyApprover(person.hats, organizationId, propertyId, required))
    .map((person) => ({ accountId: person.accountId, name: person.name }))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
}

/**
 * Everybody at this company, with hats resolved. One call per request.
 *
 * Wall B: the membership read is filtered to `organizationId`, and coverage is
 * resolved through `loadHats`, which only ever draws from a hat's own company.
 * There is no path here that can name a person from another company.
 *
 * Never throws. An unnamed approver still LOCKS the card — the company wrote
 * the rule, so the GM must not act on it, and the only thing a lookup failure
 * costs is the person's name in the sentence.
 */
export async function loadApproverDirectory(
  organizationId: string,
): Promise<ApproverDirectory> {
  if (!UUID_RX.test(organizationId ?? '')) return [];
  try {
    const { data, error } = await supabaseAdmin
      .from('organization_memberships')
      .select('account_id')
      .eq('organization_id', organizationId)
      .is('ended_at', null)
      .eq('status', 'active');
    if (error || !Array.isArray(data)) return [];

    const candidates = [...new Set((data as Array<{ account_id: string }>).map((r) => r.account_id))];
    if (candidates.length === 0) return [];

    // `display_name` — there is no `accounts.name`, and naming a column that
    // does not exist is how three separate features in this app silently died.
    const { data: people } = await supabaseAdmin
      .from('accounts')
      .select('id, display_name')
      .in('id', candidates);
    const names = new Map(
      ((people ?? []) as Array<{ id: string; display_name: string | null }>)
        .map((row) => [row.id, row.display_name ?? null]),
    );

    return await Promise.all(candidates.map(async (accountId) => ({
      accountId,
      name: names.get(accountId) ?? null,
      hats: await loadHats(accountId),
    })));
  } catch (e) {
    log.warn('[signoff] could not name the approvers; cards still lock', {
      organizationId,
      err: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

// ─── The badge's half of the rule ───────────────────────────────────────────

/**
 * How many of this hotel's waiting decisions are NOT this person's to make.
 *
 * The founder's rule is that badges stay honest on both sides: a card locked
 * behind a VP's signature never counts on the GM's badge, and does count on the
 * approver's. This is the subtraction that makes the first half true.
 *
 * ─── WHY IT SHORT-CIRCUITS THREE TIMES ────────────────────────────────────
 * The badge is the most-run read in the app — every shell mount, every time the
 * tab comes back to the front — and the whole reason /api/findings/badge exists
 * separately is that it is two `head: true` counts and nothing else. Adding an
 * unconditional company lookup to it would undo that.
 *
 *   1. `count === 0` ⇒ 0. There is nothing to subtract from. This is the great
 *      majority of polls, and it costs zero extra queries.
 *   2. no company ⇒ 0. Every hotel in the product today, at one indexed read.
 *   3. no authority rules ⇒ 0. A company that has not written a money rule
 *      cannot lock anything.
 *
 * Only a hotel that BOTH belongs to a rule-writing company AND has decisions
 * waiting pays for the full resolution.
 *
 * Never throws. A lock count that cannot be computed is 0, which means the badge
 * falls back to the number it showed before this existed — an over-count on the
 * GM's pill, never a card silently missing from it.
 */
export async function countLockedProposals(
  propertyId: string,
  callerAccountId: string,
  callerHats: readonly MembershipHat[],
  proposeCount: number,
): Promise<number> {
  if (proposeCount <= 0) return 0;
  try {
    const organizationId = await companyForProperty(propertyId);
    if (!organizationId) return 0;
    if ((await listAuthorityRules(organizationId)).length === 0) return 0;

    const rows = await listFindings(propertyId, { statuses: ['open', 'updated'], limit: 200 });
    const proposals = rows.filter((f) => effectiveDisposition(f) === 'propose');
    if (proposals.length === 0) return 0;

    const actions = await loadActionsForFindings(propertyId, proposals.map((f) => f.id));
    const directory = await loadApproverDirectory(organizationId);

    let locked = 0;
    for (const finding of proposals) {
      const action = actions.get(finding.id);
      if (action?.state !== 'proposed') continue;
      const requirement = await resolveSignOff({
        organizationId,
        propertyId,
        actionKind: action.kind,
        price: finding.price,
        callerAccountId,
        callerHats,
        directory,
      });
      if (requirement && !requirement.callerMayApprove) locked += 1;
    }
    return Math.min(locked, proposeCount);
  } catch (e) {
    log.warn('[signoff] could not count locked cards; the badge keeps its plain count', {
      propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
    return 0;
  }
}
