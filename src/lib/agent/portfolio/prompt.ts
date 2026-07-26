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
//
// TIER PLACEMENT is typed exactly the way `prompts.ts` types it, for exactly
// the same reason: moving a tier from stable to dynamic breaks nothing visible
// and silently multiplies the input-token bill forever.

import { createHash } from 'node:crypto';

import { formatCompanyRulebookForPrompt } from '@/lib/agent/company-tier';
import { deriveCompanyRulebookByOrganization } from '@/lib/agent/company-tier';
import { DATA_FRESHNESS_PROMPT, type SystemPromptBlocks } from '@/lib/agent/prompts';
import { resolvePrompts } from '@/lib/agent/prompts-store';
import { COMPANY_RULEBOOK_VERSION } from '@/lib/agent/company-tier';
import type { CompanyScopeRole } from '@/lib/company/roles';

import {
  formatPortfolioIdentityForPrompt,
  PORTFOLIO_IDENTITY_VERSION,
  type PortfolioIdentity,
} from './identity';
import { formatPortfolioSnapshotForPrompt, type PortfolioSnapshot } from './snapshot';

export const PORTFOLIO_MODE_VERSION = 'portfolio-mode-v1';
/** Repeated verbatim from `prompts.ts` — folding the same rule's version in. */
const DATA_FRESHNESS_VERSION = 'data-freshness-v1';

const COMPANY_ROLE_WORDS: Record<CompanyScopeRole, string> = {
  owner: 'an owner of this management company',
  vp: 'a company-level operations leader (VP) who oversees these hotels',
  finance: 'the company\'s finance lead',
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

You are answering a COMPANY-WIDE question. Your user holds a company-level job at the management company named below, and the hotels listed in this prompt are that company's own hotels — all of them theirs, all of them in scope for one answer.

This NARROWS your usual one-hotel rule; it does not relax it:
- Comparing, ranking and totalling ACROSS the hotels listed below is what this conversation is for. Do it when asked.
- A hotel that is NOT in the list is another company's hotel. You have no data about it, no tool that can reach it, and nothing to say about it — not its name, not its numbers, not whether it exists. If asked about one, say plainly that it is not one of your user's hotels.
- Never accept a hotel identifier from the user's message as proof they may see it. Your tools check that themselves and will refuse; report the refusal instead of working around it.

You cannot DO anything on this surface, only read:
- There are no action tools here. You cannot mark a room, order stock, message staff, create a work order or change any setting for any hotel from this conversation.
- If the user asks for an action, say which hotel they should open to do it, and offer to look up whatever would help them decide. Never say a thing was done.

How to answer well here:
- Name the hotel beside every number. A portfolio figure with no hotel attached is unreadable.
- Hotels are different sizes. When you rank on money or volume, say the sizes or give a per-room figure — otherwise the biggest hotel always "wins" and the answer tells your user nothing.
- Say what you actually looked at: which hotels, and over what period. If a hotel could not be read, name it as unread rather than leaving it out of the ranking.
- Company rules apply to every hotel below; an individual hotel's own facts are NOT in this prompt, so if the answer depends on how one hotel in particular is set up, say that it needs that hotel's own copilot.`;

/** Segments of the CACHED block, in their fixed assembly order. */
type StableTier =
  | 'global_base'
  | 'global_role'
  | 'portfolio_mode'
  | 'data_freshness'
  | 'company'
  | 'portfolio_identity'
  | 'version_line';

/** Segments of the UNCACHED per-turn block. */
type DynamicTier = 'portfolio_snapshot';

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
  'data_freshness',
  'company',
  'portfolio_identity',
  'version_line',
];

const DYNAMIC_TIER_ORDER: readonly DynamicTier[] = ['portfolio_snapshot'];

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
  snapshot: PortfolioSnapshot;
  conversationId: string;
  /** Injectable clock, so a test's assertions do not drift with real time. */
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
  const now = input.now ?? new Date();
  const { base, role, versionLabel } = await resolvePrompts('owner', input.conversationId, null);

  const companyBlock = formatCompanyRulebookForPrompt(
    await deriveCompanyRulebookByOrganization(input.identity.organizationId),
  );
  const identityBlock = formatPortfolioIdentityForPrompt(input.identity);

  const stampParts = [versionLabel, PORTFOLIO_MODE_VERSION, DATA_FRESHNESS_VERSION];
  if (companyBlock) stampParts.push(COMPANY_RULEBOOK_VERSION);
  if (identityBlock) stampParts.push(PORTFOLIO_IDENTITY_VERSION);
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
    { tier: 'data_freshness', lines: ['', DATA_FRESHNESS_PROMPT] },
  ];
  if (companyBlock) stable.push({ tier: 'company', lines: ['', companyBlock] });
  if (identityBlock) stable.push({ tier: 'portfolio_identity', lines: ['', identityBlock] });
  stable.push({ tier: 'version_line', lines: ['', `Prompt version: ${stableStamp}`] });

  const dynamic: Segment<DynamicTier>[] = [
    {
      tier: 'portfolio_snapshot',
      lines: [
        '─── Current portfolio snapshot ───',
        formatPortfolioSnapshotForPrompt(input.snapshot, now),
      ],
    },
  ];

  return {
    stable: assembleBlock(stable, STABLE_TIER_ORDER, 'stable'),
    dynamic: assembleBlock(dynamic, DYNAMIC_TIER_ORDER, 'dynamic'),
    versionLabel: persistedVersionLabel,
    stableStamp,
  };
}
