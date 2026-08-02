// ═══════════════════════════════════════════════════════════════════════════
// THE RULEBOOK EVERY PIPELINE CARRIES
//
// Staxis calls a foundation model from three places, not one:
//
//   1. hotel chat        /api/agent/command (+ its approval-resume sibling)
//   2. walkthrough       /api/walkthrough/step
//   3. portfolio chat    /api/agent/portfolio
//
// Until this module existed, the safety rules lived inside the hotel chat's
// assembler (`prompts.ts`) and reached the other two by whoever happened to
// import a constant. The walkthrough imported none of them: it hand-rolled a
// 78-line plain string, and so the one surface that drives a manager around
// their own app was the one surface with no data-age rule, no number-honesty
// rule and no knowledge of anything the hotel had ever told the companion.
// Nothing was broken in a way anyone could see, which is exactly why it stayed
// that way.
//
// ─── THE PROPERTY THIS FILE EXISTS TO HOLD ─────────────────────────────────
//
//   Adding a rule HERE reaches all three pipelines with no other edit.
//
// That is why the tiers are a REGISTRY (an array the assemblers iterate) rather
// than named constants each assembler mentions by hand. Named constants are how
// the divergence happened: `prompts.ts` grew a tier, nobody thought about the
// other two, and there was no place where the omission was visible. An array
// makes the omission testable, and `agent-shared-rule-tiers.test.ts` walks it
// across all three assemblers so a tier added tomorrow is asserted in all three
// without anyone remembering to extend the test.
//
// ─── WHAT BELONGS HERE, AND WHAT DOES NOT ──────────────────────────────────
//
// BELONGS: a rule that is CODE-OWNED (no operator can edit it), that is true on
// every surface, and that constrains what the model may SAY. Data age. Number
// honesty. The envelope discipline that keeps somebody else's text from wearing
// Staxis's authority.
//
// DOES NOT BELONG: anything that is one surface's job description. The hotel
// chat's approval-card framing, the portfolio ceiling's "you cannot DO anything
// here", the walkthrough's "pick one element and stop" all stay with their own
// assembler. A shared module that grows surface-specific branches is just the
// old problem with an extra import.
//
// ─── SCOPE IS NOT SHARED, EVEN WHEN THE RULE IS ────────────────────────────
//
// The code-owned rules are universal. The hotel's own STANDING RULES are not:
// a standing rule belongs to exactly one hotel. The portfolio surface answers
// over N hotels at once, and rendering hotel A's house rules on a turn that
// also covers B and C would be the same leak the company tier is gated against
// (see hotel-rules-tier.ts and company-tier.ts). So the hotel tier is reached
// through `exactHotelScope()`, which returns an id only when the turn's scope
// is exactly ONE hotel, and null otherwise. A portfolio turn over twenty hotels
// renders no standing-rule section at all, which is the honest answer.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';

import {
  deriveStandingRules,
  formatStandingRulesForPrompt,
  HOTEL_RULES_VERSION,
} from './hotel-rules-tier';

// ─── Code-owned rule: how old the numbers are ──────────────────────────────

/**
 * A2 — code-owned data-age rule. The hotel's numbers arrive in scheduled PMS
 * reports, not continuously, so "what's our occupancy right now" can only ever
 * be answered as of a moment in the past.
 *
 * This is the constant RULE and belongs in the STABLE (cached) block: it is
 * identical for every turn of every conversation on a given deploy, so the
 * cached prefix stays byte-identical. The as-of VALUE lives in the dynamic
 * snapshot block, which llm.ts appends without cache_control. Moving the value
 * up here to "make sure the model sees it" would break the prompt cache on
 * EVERY turn — a large, silent, recurring bill increase. That is what the
 * cache-purity test exists to prevent.
 */
export const DATA_FRESHNESS_PROMPT = `─── How old the numbers are ───

- The hotel snapshot is NOT live. Room, occupancy, arrival/departure and money numbers arrive in scheduled PMS reports, typically every 30-60 minutes. The snapshot's "PMS data as of" line is the moment those numbers describe, and tool results carry the same moment as \`asOf\` with \`dataAgeMinutes\`.
- When your answer USES occupancy, room counts, arrivals/departures, balances or money — or when the user asks about "now", "right now", "currently", "at the moment" — give the as-of time in your answer ("As of the 2:40 PM report, 62 of 88 rooms are occupied").
- When the snapshot or a tool result marks the data older than one report cycle, say so plainly and give its age.
- Otherwise stay quiet about freshness: no disclaimers, and don't repeat the as-of time on questions that aren't about the current state (policies, schedules, history, to-dos, knowledge documents).
- NEVER tell the user to refresh the page. Refreshing does not fetch new PMS numbers — those only change when the next report arrives.
- If a number looks wrong to the user, do not claim refreshing updates it. Say when it was last captured, and that a manager can check the hotel's report connection.`;

export const DATA_FRESHNESS_VERSION = 'data-freshness-v1';

// ─── Code-owned rule: numbers you may say ──────────────────────────────────
// `src/lib/agent/number-guard.ts` CHECKS this. This text is why the check
// should almost never fire: a model that knows the rule quotes instead of
// calculating, and a guard that never has to fire is a guard nobody is tempted
// to switch off.
//
// Both halves are needed and neither is sufficient. A prompt rule alone is what
// we had — the model is asked to be careful and mostly is, until it isn't, and
// nothing notices. A check alone would retract honest arithmetic the model had
// no way to know it was not allowed to do.
//
// Deliberately does NOT say "a guard will catch you". Telling a model it is
// being graded on numerals invites it to avoid numerals — and an answer that
// dodges the figure is a worse answer to a manager who asked for the figure.

export const NUMBER_HONESTY_PROMPT = `─── Numbers you may say ───

- Every number in your answer must come from somewhere you were SHOWN it: a tool result, the hotel snapshot, this hotel's own confirmed facts, or what the user just typed. Copy it; do not adjust it.
- Do NOT calculate a new number. No percentages, averages, per-room figures, totals, differences or "on pace to" projections worked out in your head — not even from numbers you were correctly given. Arithmetic done in prose is where wrong figures come from, and a manager cannot tell one of those from a real one.
- The tools already carry the derived figures people ask for: percent of budget used, what is left, cost per occupied room, share of the month's spend, how far into the month you are, and what an amount someone is thinking of spending would do to their budget. When a question needs one, CALL THE TOOL WITH THE RIGHT ARGUMENT and quote what comes back. Read the tool's arguments before deciding you cannot answer — "what percent of my budget is $600" is a question the tool answers when you hand it the $600.
- If the number that answers the question is not in front of you, say that plainly and offer to look it up: "I don't have that figure — want me to check?" Never estimate, never round to a comfortable number, never say "roughly" over a figure you made up.
- Do not lecture the user about any of this. They asked a question; either give them the figure or tell them in one short sentence that you don't have it. Never explain that you are not allowed to do arithmetic, never mention your rules, and never tell a manager to work the number out themselves — that is a worse answer than no answer.
- Never quote a tool's field names or its notes to you back at the user. They have never seen "pctUsed", "pctElapsed" or "the tool returned"; they see a hotel. Say "61% of the budget used" and "87% through the month" and leave the plumbing out of it.
- Money is the strictest case. Never invent a price, a total, a fee or a cost, and never turn a range into a single number — "$750–$1,750" is the claim; "$750" and "about $1,200" are not.

En español, la misma regla: los números se copian tal cual del dato que tienes delante. No calcules porcentajes ni promedios ni totales de cabeza. Si no tienes la cifra, dilo — "esa cifra no la tengo" — y ofrécete a buscarla. Nunca inventes un precio.`;

export const NUMBER_HONESTY_VERSION = 'number-honesty-v3';

// ─── The registry ──────────────────────────────────────────────────────────

export type CodeOwnedRuleTierId = 'data_freshness' | 'number_honesty';

export interface CodeOwnedRuleTier {
  id: CodeOwnedRuleTierId;
  /** Folded into every pipeline's printed version stamp, so "which rules was
   *  this turn run under" is answerable from a persisted stamp alone. */
  version: string;
  /** The rule itself. Cached-block content: constant per deploy. */
  text: string;
}

/**
 * THE REGISTRY. Every code-owned rule that must reach every model call.
 *
 * ORDER IS THE CONFLICT RULE, as everywhere else in this codebase: later text
 * wins. Data age before number honesty is deliberate and matches the order the
 * hotel chat has always assembled them in, so no cached prefix moves.
 *
 * Adding an entry here is the whole edit. All three assemblers iterate this
 * array; none of them names a tier.
 */
export const CODE_OWNED_RULE_TIERS: readonly CodeOwnedRuleTier[] = Object.freeze([
  Object.freeze({
    id: 'data_freshness' as const,
    version: DATA_FRESHNESS_VERSION,
    text: DATA_FRESHNESS_PROMPT,
  }),
  Object.freeze({
    id: 'number_honesty' as const,
    version: NUMBER_HONESTY_VERSION,
    text: NUMBER_HONESTY_PROMPT,
  }),
]);

/**
 * The registry rendered as cached-block lines, blank-line separated.
 *
 * Every assembler in the codebase separates tiers with a leading `''`, so this
 * emits the same shape and the three stable blocks stay byte-identical to what
 * they produced before the extraction.
 */
export function codeOwnedRuleTierLines(): string[] {
  return CODE_OWNED_RULE_TIERS.flatMap((tier) => ['', tier.text]);
}

/** The registry's version stamps, in assembly order. */
export function codeOwnedRuleTierVersions(): string[] {
  return CODE_OWNED_RULE_TIERS.map((tier) => tier.version);
}

// ─── Hotel-scoped rules ────────────────────────────────────────────────────

/**
 * The one hotel this turn is about, or null when the turn is not about exactly
 * one hotel.
 *
 * The whole point of the function is the `null`. A standing rule is scoped to a
 * single hotel, so "which hotel's rules apply" has an answer only when the turn
 * has exactly one hotel in it. Two hotels is not "pick the first"; it is a turn
 * where no hotel's house rules are the right ones to state, and the honest
 * render is no section at all.
 *
 * Same hygiene the company tier gets, arrived at from the other direction: that
 * one withholds company text from a hotel line role, this one withholds hotel
 * text from a company-wide turn.
 */
export function exactHotelScope(hotelIds: readonly string[]): string | null {
  return hotelIds.length === 1 ? hotelIds[0] : null;
}

export interface HotelScopedRuleTier {
  /** Fully rendered, fenced block. Never null when returned. */
  block: string;
  version: string;
}

/**
 * The hotel's own standing rules, ready to push into a cached block.
 *
 * Returns null for: a turn with no exact hotel scope, a hotel with no rules,
 * and an unreachable store. All three render no section, which is the rule this
 * codebase applies to every optional tier: an empty section is a CLAIM about
 * the hotel ("you have told me nothing"), and a missing section asserts nothing.
 */
export async function hotelScopedRuleTier(
  hotelScope: string | null,
): Promise<HotelScopedRuleTier | null> {
  if (!hotelScope) return null;
  const block = formatStandingRulesForPrompt(await deriveStandingRules(hotelScope));
  return block ? { block, version: HOTEL_RULES_VERSION } : null;
}

// ─── The envelope discipline ───────────────────────────────────────────────

/**
 * Re-exported, not defined here. The shape belongs to the leaf module
 * `prompt-tiers.ts` alongside the predicates that decide what may go inside it,
 * because the tiers that render an envelope (family, company, hotel rules) are
 * the tiers this file imports — defining it here would close a cycle.
 *
 * It is surfaced from this module anyway, because this is the file a fourth
 * fenced tier's author reads: "the rulebook every pipeline carries" is where
 * you look for how to fence somebody else's text, and a re-export costs nothing
 * to keep that true.
 */
export { renderTrustEnvelope } from './prompt-tiers';
