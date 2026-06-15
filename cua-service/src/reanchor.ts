/**
 * reanchor.ts — RUNG-2 cheap self-heal DECISION CORE (feature/cua-self-heal-reach).
 *
 * When a feed's selector drifts, session-driver's self-repair today fires a $3
 * single-target vision RE-LEARN (rung-1). This module is the FREE rung-2 that runs
 * FIRST: re-match the drifted feed on the live logged-in page using STRUCTURE
 * (Chat 6's durable header anchors) + VALUE CERTIFICATION (column-recovery's
 * certifyColumns), at ZERO LLM cost. Only when re-anchoring is impossible or
 * uncertain do we fall through to the paid path.
 *
 * THIS FILE IS A PURE DECISION CORE — no Playwright, no Supabase, no Anthropic,
 * no process.env. The live-page DOM reads (navigate, read headers, extract per-
 * candidate column values) live in session-driver's thin driver step; this file
 * only DECIDES from the data it is handed. That keeps the risky part (a wrong
 * heal silently corrupts hotel data) unit-testable offline against the SAME
 * abstain-by-default safety core the mapper trusts.
 *
 * ABSTAIN-BY-DEFAULT is the whole contract: a WRONG re-anchor is worse than a
 * blank feed (it ships plausible-but-wrong data to a hotel). Every doubt — no
 * value evidence, an uncertified candidate, two candidates that both certify,
 * a plain-text column we cannot value-prove, a rowSelector that itself drifted —
 * returns ABSTAIN, and the caller falls through to the existing $3 re-learn.
 *
 * The safety cores are REUSED, never forked:
 *   - certifyColumns (column-recovery.ts) — the 3-state value verdict.
 *   - parseFirstNthIndex / rebaseNthIndex / normalizeHeaderText (extractors/
 *     dom-rows.ts) — the same positional-css rebasing the runtime reader uses.
 */

import type { Recipe, ActionRecipe, TieredSelector } from './types.js';
import { certifyColumns, type ActionKey } from './column-recovery.js';
import { CORE_TARGET_CONTRACTS, type LearnedTranslations } from './target-contract.js';
import { normalizeHeaderText, parseFirstNthIndex, rebaseNthIndex } from './extractors/dom-rows.js';

/** Minimum rows the fresh extraction must yield before ANY value judgement is
 *  trusted. Below this, certifyColumns' own thin-evidence guards would abstain
 *  anyway, but we floor it here too so a 1-2 row fluke can never drive a heal.
 *  A small hotel whose feed legitimately has <3 rows just falls through to the
 *  paid path — acceptable (abstain-by-default). */
export const MIN_REANCHOR_ROWS = 3;

/** Required column NAMES for a core target (the value contract). Non-core targets
 *  (optional money/booking feeds) have no contract → re-anchor abstains on them. */
export function requiredColumnsForTarget(actionKey: ActionKey): string[] {
  const contract = CORE_TARGET_CONTRACTS[actionKey];
  if (!contract) return [];
  return contract.columns.filter((c) => c.required).map((c) => c.name);
}

// ─── CASE A: transient-health confirmation ──────────────────────────────────
//
// Many self-repair fires are TRANSIENT — a slow page, a one-off empty render, a
// momentary login bounce. Before paying $3 to re-learn, the driver re-extracts
// the feed ONCE with the CURRENT selectors. If the feed now yields enough rows
// AND every required column value-certifies, the recipe is fine; we skip the
// paid repair and change NOTHING (zero risk — no recipe mutation).

export interface FeedHealthInput {
  actionKey: ActionKey;
  /** Required columns that currently SHIP (present + non-blank in the recipe). */
  requiredColumns: string[];
  /** Fresh probe values per column (same rows, same order). */
  allValues: Record<string, string[]>;
  /** Current learned selectors per column (for certifyColumns' duplicate check). */
  allSelectors: Record<string, string>;
  /** Rows the fresh extraction matched. */
  rowCount: number;
  learned?: LearnedTranslations;
  /** yyyy-mm-dd "today" — injectable for tests. */
  todayIso: string;
}

export type FeedHealthVerdict =
  | { healthy: true }
  | { healthy: false; reason: string };

/**
 * PURE. The feed is HEALTHY (skip paid repair, no recipe change) only when it
 * yields ≥ MIN_REANCHOR_ROWS AND EVERY required column certifies. Anything else
 * is NOT a confident "it's fine" → return unhealthy so the caller proceeds to a
 * column re-anchor attempt and ultimately the paid path. This is intentionally
 * STRICTER than a normal poll (which never certifies): we only suppress a paid
 * repair on positive value proof, never on "the extraction didn't throw".
 */
export function checkFeedHealth(input: FeedHealthInput): FeedHealthVerdict {
  if (input.requiredColumns.length === 0) {
    // No contract to prove against → cannot positively confirm health → defer.
    return { healthy: false, reason: 'no_required_columns_to_certify' };
  }
  if (input.rowCount < MIN_REANCHOR_ROWS) {
    return { healthy: false, reason: `too_few_rows:${input.rowCount}` };
  }
  const verdicts = certifyColumns({
    actionKey: input.actionKey,
    columns: input.requiredColumns,
    allValues: input.allValues,
    allSelectors: input.allSelectors,
    learned: input.learned,
    todayIso: input.todayIso,
    hasValueEvidence: true,
  });
  for (const col of input.requiredColumns) {
    const v = verdicts.get(col);
    if (!v || v.verdict !== 'certified') {
      return { healthy: false, reason: `uncertified:${col}:${v?.verdict ?? 'missing'}` };
    }
  }
  return { healthy: true };
}

// ─── CASE B: single-column re-anchor over the live header row ────────────────
//
// When the feed extracts rows but a REQUIRED column is blank/uncertified (its
// per-column selector drifted), the driver enumerates the live header cells,
// builds one candidate selector per header (rebasing the column's positional
// css onto that header's live index), and extracts that candidate column's
// values. This core then picks the UNIQUE candidate that value-certifies —
// preferring the candidate whose live header TEXT still equals the column's
// durable Chat-6 header anchor. Ambiguity (0 or ≥2 certifying) → ABSTAIN.

export interface ReanchorCandidate {
  /** 1-based live header index this candidate points at. */
  headerIndex: number;
  /** Candidate css selector (the column's positional css rebased to headerIndex). */
  selector: string;
  /** Values the driver extracted for THIS candidate (same rows/order as siblings). */
  values: string[];
  /** Normalized live header text at headerIndex (for anchor-text matching). */
  headerText: string;
}

export interface ColumnReanchorInput {
  actionKey: ActionKey;
  /** The drifted required column to re-anchor. */
  column: string;
  /** Current (drifted) selector for `column` — a candidate equal to this is NOT
   *  a heal and is skipped. */
  oldSelector: string;
  /** The column's durable header anchor text (columnsTiered[col].roleName.name,
   *  normalized) when one exists; undefined for a legacy positional-only recipe. */
  anchorHeaderText?: string;
  /** One candidate per plausible live header cell. */
  candidates: ReanchorCandidate[];
  /** The OTHER columns' values (unchanged) — feed certifyColumns' cross-column
   *  (mirror / constant / key-degeneracy) checks. */
  otherValues: Record<string, string[]>;
  /** The OTHER columns' current selectors (duplicate-selector check). */
  otherSelectors: Record<string, string>;
  learned?: LearnedTranslations;
  todayIso: string;
}

export type ColumnReanchorDecision =
  | { action: 'reanchor'; column: string; newSelector: string; headerIndex: number; reason: string }
  | { action: 'abstain'; reason: string };

/**
 * PURE. Decide whether a single drifted column can be confidently re-anchored.
 *
 * Confidence ladder (each step abstains on doubt):
 *   1. Each candidate (≠ oldSelector) is value-certified IN CONTEXT — its values
 *      slot into the full row alongside the unchanged columns so certifyColumns'
 *      cross-column checks (mirror/constant/key/date-order) all apply.
 *   2. If exactly ONE certifying candidate's live header text equals the column's
 *      durable anchor → re-anchor to it (strongest signal: right meaning + right
 *      values). ≥2 anchor-text matches that certify → ABSTAIN (can't disambiguate).
 *   3. No anchor-text match (header renamed / legacy recipe) → re-anchor ONLY when
 *      a SINGLE candidate certifies by value alone. ≥2 → ABSTAIN (e.g. arrival vs
 *      departure both look like dates — never guess which).
 *   4. Zero certifying → ABSTAIN.
 *
 * A plain-text column (no type-specific check) almost never yields a UNIQUE
 * value-certified candidate, so re-anchor abstains on free text unless the
 * anchor header text uniquely pins it — exactly the conservative behaviour we
 * want (you cannot value-prove which cell is "guest name").
 */
export function decideColumnReanchor(input: ColumnReanchorInput): ColumnReanchorDecision {
  if (input.candidates.length === 0) return { action: 'abstain', reason: 'no_candidates' };

  const certifying: ReanchorCandidate[] = [];
  for (const cand of input.candidates) {
    if (!cand.selector || cand.selector === input.oldSelector) continue; // not a change
    const allValues = { ...input.otherValues, [input.column]: cand.values };
    const allSelectors = { ...input.otherSelectors, [input.column]: cand.selector };
    const verdicts = certifyColumns({
      actionKey: input.actionKey,
      columns: [input.column],
      allValues,
      allSelectors,
      learned: input.learned,
      todayIso: input.todayIso,
      hasValueEvidence: true,
    });
    if (verdicts.get(input.column)?.verdict === 'certified') certifying.push(cand);
  }

  if (certifying.length === 0) return { action: 'abstain', reason: 'no_candidate_certified' };

  // Prefer the candidate whose live header text still equals the durable anchor.
  if (input.anchorHeaderText) {
    const wantedNorm = normalizeHeaderText(input.anchorHeaderText);
    const anchorMatches = certifying.filter(
      (c) => normalizeHeaderText(c.headerText) === wantedNorm,
    );
    if (anchorMatches.length === 1) {
      const win = anchorMatches[0]!;
      return {
        action: 'reanchor',
        column: input.column,
        newSelector: win.selector,
        headerIndex: win.headerIndex,
        reason: `anchor_text_match_certified(idx=${win.headerIndex})`,
      };
    }
    if (anchorMatches.length > 1) {
      return { action: 'abstain', reason: `ambiguous_anchor_matches:${anchorMatches.length}` };
    }
    // anchorMatches.length === 0 — header was renamed; fall through to value-only.
  }

  if (certifying.length === 1) {
    const win = certifying[0]!;
    return {
      action: 'reanchor',
      column: input.column,
      newSelector: win.selector,
      headerIndex: win.headerIndex,
      reason: `unique_value_certified(idx=${win.headerIndex})`,
    };
  }
  return { action: 'abstain', reason: `ambiguous_value_certified:${certifying.length}` };
}

// ─── Candidate generation (pure positional-css rebasing) ────────────────────
//
// Mirrors the runtime reader's positional rebasing so a re-anchored selector
// replays byte-identically: the column's drifted css keeps its shape and only
// its FIRST :nth-child(K) integer is rebased onto each live header index. A
// column whose css has no :nth-child anchor is not positionally rebaseable →
// it produces NO candidates here (→ abstain), never a guessed selector.

export interface BuildCandidateSelectorsInput {
  /** The column's current (drifted) positional css. */
  oldSelector: string;
  /** Live header cells (1-based index + normalized text), from readTableHeaders. */
  headers: Array<{ index: number; text: string }>;
}

/** PURE. One rebased candidate selector per live header index, or [] when the
 *  column's selector has no positional :nth-child to rebase (not safely
 *  re-anchorable by structure). The caller extracts values per candidate. */
export function buildCandidateSelectors(
  input: BuildCandidateSelectorsInput,
): Array<{ headerIndex: number; selector: string; headerText: string }> {
  // REUSE the runtime reader's exact positional helpers (never fork): a column
  // with no first :nth-child integer is not positionally rebaseable, so it
  // produces NO candidates (→ caller abstains) rather than a guessed selector.
  if (parseFirstNthIndex(input.oldSelector) === null) return [];
  return input.headers.map((h) => ({
    headerIndex: h.index,
    selector: rebaseNthIndex(input.oldSelector, h.index),
    headerText: h.text,
  }));
}

// ─── Apply a confident re-anchor to the recipe (pure clone + patch) ─────────

export interface ColumnChange {
  column: string;
  newSelector: string;
}

/**
 * PURE. Return a DEEP CLONE of `recipe` with the given column selector changes
 * applied to one table feed's hint — both the flat `columns` map AND the durable
 * `columnsTiered[col].css` (the roleName anchor is preserved). Everything else is
 * byte-identical, so the minted version differs from the active only in the
 * re-anchored selectors. Throws if the target isn't a table feed (re-anchor is a
 * table-only heal; the caller guards but we fail loud rather than silently no-op).
 */
export function applyColumnReanchor(
  recipe: Recipe,
  actionKey: ActionKey,
  changes: ColumnChange[],
): Recipe {
  const clone: Recipe = JSON.parse(JSON.stringify(recipe));
  const action = clone.actions[actionKey] as ActionRecipe | undefined;
  if (!action) throw new Error(`reanchor: target ${String(actionKey)} absent from recipe`);
  if (action.parse.mode !== 'table') {
    throw new Error(`reanchor: target ${String(actionKey)} is ${action.parse.mode}, not table`);
  }
  const hint = action.parse.hint;
  for (const { column, newSelector } of changes) {
    hint.columns[column] = newSelector;
    if (hint.columnsTiered && hint.columnsTiered[column]) {
      const tier: TieredSelector = hint.columnsTiered[column]!;
      // Keep the roleName meaning anchor; refresh only the positional css.
      hint.columnsTiered[column] = { ...tier, css: newSelector };
    }
  }
  return clone;
}
