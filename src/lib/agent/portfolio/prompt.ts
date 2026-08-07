import 'server-only';

// ─── The portfolio system prompt ────────────────────────────────────────────
//
// A DIFFERENT PROMPT, NOT A FLAG ON THE HOTEL ONE.
//
// `buildSystemPrompt` assembles global → PMS family → company → THIS HOTEL, and
// every one of those last three tiers is keyed on a single `propertyId`. A
// portfolio turn has no single hotel, so bolting a mode flag onto that function
// would mean four `if (portfolio)` branches inside the one piece of code whose
// ASSEMBLY ORDER is the conflict rule for facts. This file is the portfolio
// surface's own assembler, and the two share the pieces that are genuinely
// shared: the global base + role rows, the code-owned data-freshness rule, the
// company rulebook renderer, and the `SystemPromptBlocks` contract.
//
// WHAT IS DELIBERATELY ABSENT
//   • the PMS-family tier — it is "how THIS PMS's reports read", and a company
//     can run three PMSs. Twenty hotels' worth of family addenda in one cached
//     prompt would be paid on every turn to answer nothing.
//   • the hotel-identity tier — one hotel's private setup (its housekeeping
//     level, its checklists, its roster shape). See identity.ts for why.
//   • every `<staxis-memory>` fact — hotel-scope by construction (INV-TIER-3).
//   • the inventory-accounting routing block — it routes to per-hotel inventory
//     tools that do not exist on this surface.
//
// WHAT IS PRESENT AND WHY
//   • the COMPANY rulebook, resolved from the ORGANIZATION rather than from a
//     hotel. This is the one tier that is genuinely company-shaped, and the
//     portfolio surface is the only place it is being read at its own scope.
//   • the portfolio identity block: names + sizes, cached, sanitised.
//   • a code-owned PORTFOLIO ceiling — the rules that make this surface safe,
//     printed by this file and not editable from any row.
//   • the SHARED code-owned rule registry (`../rule-tiers.ts`) — data age and
//     number honesty today, whatever is added there tomorrow. Iterated, not
//     named, so a rule reaches this surface without an edit in this file.
//   • the hotel's own STANDING RULES, but ONLY on a turn whose selected scope
//     is exactly one hotel. On a multi-hotel turn there is no hotel whose house
//     rules are the right ones to state, and the block is absent. See the gate
//     at the call to `exactHotelScope` below.
//
// TIER PLACEMENT is typed exactly the way `prompts.ts` types it, for exactly
// the same reason: moving a tier from stable to dynamic breaks nothing visible
// and silently multiplies the input-token bill forever.

import { createHash } from 'node:crypto';

import {
  composeKnowledgeTier,
  resolveCompanyKnowledgePresentation,
  type CompanyKnowledgeMode,
  type KnowledgeTurn,
} from '@/lib/agent/knowledge-door';
import type { SystemPromptBlocks } from '@/lib/agent/prompts';
import {
  codeOwnedRuleTierLines,
  codeOwnedRuleTierVersions,
} from '@/lib/agent/rule-tiers';
import { resolvePrompts } from '@/lib/agent/prompts-store';
import type { CompanyScopeRole } from '@/lib/company/roles';

import { type PortfolioIdentity } from './identity';

// v2: the code-owned ceiling gained the never-do-arithmetic rule (2026-07-26).
// The stamp is part of the cached prefix's identity, so it moves whenever the
// text does — otherwise a stale cache entry could serve the old ceiling.
export const PORTFOLIO_MODE_VERSION = 'portfolio-mode-v4';

const COMPANY_ROLE_WORDS: Record<CompanyScopeRole, string> = {
  owner: 'an owner of this management company',
  regional_manager:
    'a regional manager who oversees the hotels they are responsible for',
};

/**
 * THE CEILING for the portfolio surface. Code-owned, versioned, unreachable
 * from any row — the same discipline the family and company tiers get.
 *
 * Each rule below closes a specific way this surface could go wrong, and the
 * first two are the ones that would matter most:
 *
 *  • The global base prompt tells the model to answer about "the one hotel in
 *    your snapshot" and to never reveal another property's data. On THIS
 *    surface that instruction is wrong in a way that would make the copilot
 *    refuse the question it exists to answer, so it is restated rather than
 *    left to be inferred — narrowed, not relaxed: the boundary moved from one
 *    hotel to one COMPANY, and the refusal outside that boundary is unchanged.
 *  • There are no action tools here at all. A model that believes it can act
 *    and then reports having acted is the exact failure INV-41 catches after
 *    the fact; saying so up front stops the sentence being written.
 */
export const PORTFOLIO_MODE_NOTE = `─── Portfolio mode ───

You are answering under the EXACT TURN SCOPE resolved below. That scope may be the user's whole authorized company, one region/portfolio, selected hotels, or one named hotel. The listed hotels—and no others—are in scope for this answer.

This changes the grain of your usual one-hotel rule; it does not relax authorization:
- Compare, rank and total across the listed hotels only when more than one is selected. For one listed hotel, answer at hotel grain without inventing a company comparison.
- A hotel not listed may simply be outside this turn's selected subset, or it may be outside the user's authorization. Never infer which. Say it is not in the active answer scope and require the resolver to establish a new scope on a later turn.
- A hotel outside the user's current authorization is another company's hotel. You have no data about it and must not confirm whether it exists.
- Never accept a hotel identifier from the user's message as proof they may see it. Your tools check that themselves and will refuse; report the refusal instead of working around it.
- Every answer states its active scope and exact coverage. Do not silently carry one hotel's scope into the next turn, and never carry any scope across companies.

You cannot DO anything on this surface, only read:
- There are no action tools here. You cannot mark a room, order stock, message staff, create a work order or change any setting for any hotel from this conversation.
- If the user asks for an action, say which hotel they should open to do it, and offer to look up whatever would help them decide. Never say a thing was done.

EVERY NUMBER YOU SAY MUST BE COPIED FROM DETERMINISTIC EVIDENCE OR A TOOL RESULT. You never calculate one.
- Do not divide, multiply, total, average, or work out a percentage, a rate, a per-room figure or a "3 times worse than" in your answer. Not even from two numbers a tool just gave you correctly.
- The evidence carries code-computed totals, denominators, normalized values, comparisons and coverage. Quote those fields exactly.
- If the figure the user wants is not in deterministic evidence or a tool result, say you do not have it. That is a real answer. A number you worked out yourself is not.

How to answer well here:
- Name the hotel beside every number. A portfolio figure with no hotel attached is unreadable.
- Hotels are different sizes. When you rank on money or volume, say the sizes or quote the per-room figure the tool gave you — otherwise the biggest hotel always "wins" and the answer tells your user nothing.
- Say what you actually looked at: which hotels, and over what period. If a hotel could not be read, name it as unread rather than leaving it out of the ranking.
- Company rules apply to every hotel below; an individual hotel's own facts are NOT in this prompt, so if the answer depends on how one hotel in particular is set up, say that it needs that hotel's own copilot.`;

/** Segments of the CACHED block, in their fixed assembly order. */
type StableTier =
  | 'global_base'
  | 'global_role'
  | 'portfolio_mode'
  // ONE slot for the whole shared registry — see the twin comment in
  // ../prompts.ts. A rule added to rule-tiers.ts must land here without an edit.
  | 'code_rules'
  | 'company'
  | 'portfolio_identity'
  | 'hotel_rules'
  | 'version_line';

// THERE IS NO UNCACHED PER-TURN BLOCK ON THIS SURFACE, and the absence is the
// design rather than an omission.
//
// There was one until 2026-08-06: a `portfolio_snapshot` tier carrying twenty
// hotels' live pulse with a per-hotel as-of line. Portfolio Intelligence
// replaced it with a deterministic metric evidence package it assembles itself
// — `portfolio-intelligence/prompt.ts` overwrites `dynamic` wholesale — and the
// tier had been unreachable on every live path ever since, because the one
// production entry point omitted the input that switched it on. Stage 2 of the
// knowledge door deleted the store and its module rather than carry a rendering
// no prompt contains.
//
// So this assembler returns an EMPTY dynamic half and the layer above fills it.
// Anything per-turn added here in future needs the `Segment`/order machinery
// back, for the reason the stable half still has it: a per-turn value that ends
// up in the CACHED block breaks nothing visibly and multiplies the input-token
// bill forever.

/**
 * FIXED ASSEMBLY ORDER — later text wins, exactly as on the hotel surface.
 * The company rulebook sits above the portfolio identity for the same reason
 * the hotel's identity sits above the company's on the other surface: the more
 * specific description of what you are looking at goes last.
 */
const STABLE_TIER_ORDER: readonly StableTier[] = [
  'global_base',
  'global_role',
  'portfolio_mode',
  'code_rules',
  'company',
  'portfolio_identity',
  // LAST of the content tiers, and only ever present on a one-hotel turn. Same
  // conflict rule as the hotel surface: an instruction a manager gave about
  // this specific hotel beats the company standard and the portfolio framing.
  'hotel_rules',
  'version_line',
];

/** Tiers that instruct rather than state a fact about these hotels — excluded
 *  from `factual`. See the twin list in ../prompts.ts for the full reasoning. */
const INSTRUCTIONAL_STABLE_TIERS: ReadonlySet<StableTier> = new Set<StableTier>([
  'global_base',
  'global_role',
  'portfolio_mode',
  'code_rules',
  'version_line',
]);

interface Segment<T extends string> {
  tier: T;
  lines: string[];
}

function assembleBlock<T extends string>(
  segments: Segment<T>[],
  order: readonly T[],
  blockName: string,
): string {
  let lastIndex = -1;
  for (const seg of segments) {
    const idx = order.indexOf(seg.tier);
    if (idx <= lastIndex) {
      throw new Error(
        `[portfolio-prompt] ${blockName} block tier "${seg.tier}" is duplicated or out of order`,
      );
    }
    lastIndex = idx;
  }
  return segments.flatMap((s) => s.lines).join('\n');
}

export interface PortfolioPromptInput {
  identity: PortfolioIdentity;
  companyRole: CompanyScopeRole;
  /** Portfolio Intelligence supplies one bounded, provenance-recorded overlay
   * and disables this legacy second rulebook read to avoid duplicate facts.
   * Arbitrated by `resolveCompanyKnowledgePresentation` in the knowledge door,
   * where both renderings of `company_knowledge` are registered. */
  companyKnowledgeMode?: CompanyKnowledgeMode;
  conversationId: string;
  /**
   * Injectable clock, so a test's assertions do not drift with real time.
   *
   * READ BY NOTHING IN THIS ASSEMBLER, and that is the invariant rather than an
   * oversight: everything this file prints lands in the CACHED half, so a value
   * that moved with the clock would rewrite the cached prefix on every turn.
   * It is carried on the input for the layer that fills the uncached half —
   * `portfolio-intelligence/prompt.ts` renders its evidence package against it
   * — so both halves of one turn are measured against one clock.
   */
  now?: Date;
}

/**
 * Build a portfolio turn's system prompt.
 *
 * THE ROLE ROW IS ALWAYS `owner`, whatever hat the person wears. The three
 * company-scope jobs degrade to three different legacy words
 * (`legacyRoleForHat`), and using them here would hand a VP the general
 * manager's row — "assign 302 to Maria", "show me the deep clean queue" — a
 * page of instructions about tools this surface does not have. The `owner` row
 * is the multi-property, trends-and-money row, which is what every one of the
 * three is doing here. Who they actually are is stated in the portfolio block
 * instead, where it is one sentence rather than a page.
 *
 * That choice does NOT widen anything: authority on this surface comes from the
 * spine and the tool registry, never from which prompt row was rendered.
 */
export async function buildPortfolioSystemPrompt(
  input: PortfolioPromptInput,
): Promise<SystemPromptBlocks> {
  const { base, role, versionLabel } = await resolvePrompts('owner', input.conversationId, null);

  // ─── The knowledge tiers, composed BY NAME through the door ──────────────
  //
  // `hotelIds` is the turn's SELECTED SET, built by the route from the
  // authorization receipt's `propertyIds`. The door gates the hotel-scoped
  // stores on it through `exactHotelScope`, so a multi-hotel turn renders no
  // standing-rule section at all: a standing rule belongs to exactly ONE hotel,
  // and putting the first hotel's manager's instructions in front of a question
  // about twenty others is the same leak the company tier is gated against,
  // arrived at from the other direction.
  //
  // `companyPolicyVisible: true` because every hat that reaches this surface is
  // a company-scope hat (owner, VP, finance) — the hotel surface's line-role
  // gate has no analogue here, and stating it rather than defaulting it is what
  // keeps the two surfaces' answers comparable.
  //
  // `held.portfolioIdentity` is the receipt this route was authorized against.
  // The door renders it and never looks it up: a fresh query here would replace
  // "the hotels this person was checked against" with "the hotels a query
  // returned", which is the same boundary the `hotelIds` gate above protects,
  // lost one line later.
  //
  // NO ACTOR. Three company-scope hats reach this surface and none of them has
  // a lens — a lens narrows a hat AT ONE HOTEL, and this conversation answers
  // for a company. Leaving it off is the honest way to say so; the door's
  // person-scoped composers then render nothing rather than guessing a role.
  const turn: KnowledgeTurn = {
    hotelIds: input.identity.hotels.map((hotel) => hotel.id),
    organizationId: input.identity.organizationId,
    companyPolicyVisible: true,
    held: { portfolioIdentity: input.identity },
  };

  // Exactly one presentation of `company_knowledge` may render on a turn. When
  // Portfolio Intelligence supplies its bounded overlay in the dynamic half,
  // this stable-block rulebook stands down: the same facts twice, under two
  // envelopes and two versions, would be duplicate cost and a conflict the
  // model has to resolve. The door owns that arbitration because the door is
  // where both renderings are registered.
  const company = resolveCompanyKnowledgePresentation(input.companyKnowledgeMode) === 'company_rulebook_tier'
    ? await composeKnowledgeTier('company_knowledge', turn)
    : null;
  const identity = await composeKnowledgeTier('portfolio_identity', turn);
  const standingRules = await composeKnowledgeTier('hotel_standing_rules', turn);

  const stampParts = [
    versionLabel, PORTFOLIO_MODE_VERSION, ...codeOwnedRuleTierVersions(),
  ];
  if (company) stampParts.push(company.version);
  if (identity) stampParts.push(identity.version);
  if (standingRules) stampParts.push(standingRules.version);
  const stableStamp = stampParts.join('+');

  // The persisted receipt records WHICH hotels this turn was answered over, as
  // a digest rather than a list: "why did it not mention Lufkin" is answerable
  // afterwards, and the digest is not printed, so the cached prefix is safe.
  const reach = createHash('sha256')
    .update(input.identity.hotels.map((h) => h.id).join(','))
    .digest('hex')
    .slice(0, 8);
  const persistedVersionLabel = [
    stableStamp,
    `org:${input.identity.organizationId}`,
    `hotels:${input.identity.hotels.length}/${reach}`,
  ].join('+');

  const stable: Segment<StableTier>[] = [
    { tier: 'global_base', lines: [base.content] },
    { tier: 'global_role', lines: ['', '─── Role context ───', role.content] },
    {
      tier: 'portfolio_mode',
      lines: [
        '',
        PORTFOLIO_MODE_NOTE,
        '',
        `You are talking to ${COMPANY_ROLE_WORDS[input.companyRole]}.`,
      ],
    },
    { tier: 'code_rules', lines: codeOwnedRuleTierLines() },
  ];
  if (company) stable.push({ tier: 'company', lines: ['', company.block] });
  if (identity) stable.push({ tier: 'portfolio_identity', lines: ['', identity.block] });
  if (standingRules) stable.push({ tier: 'hotel_rules', lines: ['', standingRules.block] });
  stable.push({ tier: 'version_line', lines: ['', `Prompt version: ${stableStamp}`] });

  return {
    stable: assembleBlock(stable, STABLE_TIER_ORDER, 'stable'),
    // Empty on purpose — see the note above `STABLE_TIER_ORDER`. The layer that
    // owns the uncached half (`portfolio-intelligence/prompt.ts`) replaces this
    // wholesale with its deterministic evidence package.
    dynamic: '',
    // Same contract as the hotel surface: the instruction tiers are dropped so
    // the number guard's receipt is what the runtime said about these HOTELS,
    // not the role prompts' worked examples. Built by subtraction — a tier
    // added later is kept, i.e. the guard fails permissive. See
    // src/lib/agent/number-guard.ts.
    factual: assembleBlock(
      stable.filter((s) => !INSTRUCTIONAL_STABLE_TIERS.has(s.tier)),
      STABLE_TIER_ORDER,
      'factual',
    ),
    versionLabel: persistedVersionLabel,
    stableStamp,
  };
}
