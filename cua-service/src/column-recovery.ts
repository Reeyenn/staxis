/**
 * Blank required-column recovery — pure decision core (feature/cua-column-recovery).
 *
 * Live failure this exists for (prod knowledge file 56980b3b, choice_advantage
 * v1, quarantined 2026-06-12): the mapper found the arrivals / departures /
 * work-orders pages and learned working selectors for SOME columns, but emitted
 * empty-string selectors for required columns it couldn't see in the row
 * (arrival_date/departure_date; pms_work_order_id/status/out_of_order). The old
 * completeness re-ask re-read the same row with a generic hint and gave up →
 * the promotion gate (correctly) quarantined the feeds.
 *
 * This module is the verification + acceptance brain the mapper uses to fix
 * extraction instead: classify which required columns are actually DEAD against
 * the live DOM, and gate every RECOVERED candidate selector by the values it
 * extracts — with the exact parser chain the runtime will apply at poll time.
 * A wrong cell's value is worse than a blank (it silently corrupts hotel data),
 * so every check here is abstain-by-default: doubt → reject → the feed parks
 * honestly with its gap recorded.
 *
 * PURE module: no playwright / anthropic / supabase imports. Everything is
 * unit-testable offline. Generic by construction — keyed entirely off
 * CORE_TARGET_CONTRACTS / DISCOVERY_* (target-level config), zero PMS-specific
 * logic.
 */

import type { Recipe } from './types.js';
import {
  CORE_TARGET_CONTRACTS,
  TARGET_VALUE_CONTRACTS,
  requiredLearnedFor,
  missingFromList,
  resolveColumnParser,
  type LearnedTranslations,
  type CoreColumn,
} from './target-contract.js';
import { DISCOVERY_KEY_COLUMNS, DISCOVERY_SEMANTIC_DATE_COLUMNS } from './oracle-verify.js';
import { getParser } from './parsers/registry.js';
import { sanitizeEnumMapping } from './value-learning.js';
// Side-effect import — registers the generic_* parsers. The gate MUST evaluate
// candidates with the same registered parsers the runtime uses; without this,
// applyParser would pass raw values through and junk would "parse".
import './parsers/generic.js';

export type ActionKey = keyof Recipe['actions'];

// ─── Bounds (all hard caps — see plan ADDENDUM) ─────────────────────────────

/** Rows sampled for VALUE-level gating (acceptance + cross-checks). */
export const VALUE_PROBE_ROW_CAP = 8;
/** Rows scanned for DEADNESS (all-blank detection). Deliberately much larger
 *  than the value probe: a sparse-but-real column (e.g. out_of_order set on 1
 *  row in 50) must not be misclassified dead off a tiny sample. */
export const DEADNESS_ROW_CAP = 200;
/** Minimum non-blank samples before a column may be declared `unparseable`.
 *  Below this the evidence is too thin — keep today's accept-as-is behavior. */
export const MIN_UNPARSEABLE_SAMPLES = 3;
/** Stage-2 drill bounds (consumed by mapper.ts; kept here so the whole budget
 *  story is in one reviewed place). The drill envelope is measured from drill
 *  start and is deliberately EXEMPT from the per-target soft-abort (already
 *  ~spent by the time recovery escalates) but stays under the job cost cap,
 *  wallclock and token ceilings. Worst case ≈ $1.10/target, documented. */
export const RECOVERY_DRILL_STEP_CAP = 16;
export const RECOVERY_DRILL_COST_CAP_MICROS = 600_000; // $0.60
/** Max rows the RUNTIME will detail-enrich per poll (template-runner). Shared
 *  here so stage-2 acceptance can refuse lists the runtime could never cover —
 *  a gate-passing feed that hard-fails every poll would be worse than parking. */
export const DETAIL_PER_POLL_MAX = 60;

const trimmed = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function contractColumn(actionKey: ActionKey, column: string): CoreColumn | undefined {
  return CORE_TARGET_CONTRACTS[actionKey]?.columns.find((c) => c.name === column);
}

/** Resolve + apply the SAME parser chain the runtime will use for this column.
 *  Returns `assessable:false` when no parser applies (plain text) or the parser
 *  isn't registered (applyParser would pass raw through — that must never count
 *  as "parses fine" for gating). */
function parseLikeRuntime(
  actionKey: ActionKey,
  column: string,
  value: string,
  learned?: LearnedTranslations,
): { assessable: false } | { assessable: true; parsed: unknown } {
  const resolved = resolveColumnParser(actionKey, column, learned);
  if (!resolved) return { assessable: false };
  const fn = getParser(resolved.parser);
  if (!fn) return { assessable: false };
  try {
    return { assessable: true, parsed: fn(value, resolved.config) };
  } catch {
    return { assessable: true, parsed: null };
  }
}

// ─── Stage 0: classification ────────────────────────────────────────────────

export interface RequiredColumnAudit {
  /** Selector absent or blank in the learned map (today's structural check). */
  structurallyMissing: string[];
  /** Selector present, but the extracted value is blank in EVERY scanned row. */
  dead: string[];
  /** ≥ MIN_UNPARSEABLE_SAMPLES non-blank values and ZERO parse with the
   *  runtime parser — the selector points at the wrong cell (e.g. a status
   *  string in a date column). Caught here instead of at poll time. */
  unparseable: string[];
  /** Union of the above, deduped, contract order. */
  recoveryTargets: string[];
}

export const emptyAudit = (): RequiredColumnAudit =>
  ({ structurallyMissing: [], dead: [], unparseable: [], recoveryTargets: [] });

/**
 * Classify a learned column map against rows extracted from the live feed page
 * (full extraction, ≤ DEADNESS_ROW_CAP). `rows.length === 0` (legitimately
 * empty feed today, or non-DOM page) → value checks are vacuous; only the
 * structural check applies — exactly today's behavior.
 */
export function auditRequiredColumns(
  actionKey: ActionKey,
  columns: Record<string, string>,
  rows: Array<Record<string, string>>,
  learned?: LearnedTranslations,
): RequiredColumnAudit {
  const required = requiredLearnedFor(actionKey);
  if (required.length === 0) return emptyAudit();

  const structurallyMissing = missingFromList(required, columns);
  const structurallySet = new Set(structurallyMissing);
  const dead: string[] = [];
  const unparseable: string[] = [];

  if (rows.length > 0) {
    for (const col of required) {
      if (structurallySet.has(col)) continue;
      const values = rows.map((r) => trimmed(r[col]));
      const nonBlank = values.filter((v) => v !== '');
      if (nonBlank.length === 0) {
        dead.push(col);
        continue;
      }
      if (nonBlank.length < MIN_UNPARSEABLE_SAMPLES) continue;
      let assessable = 0;
      let parsedOk = 0;
      for (const v of nonBlank) {
        const r = parseLikeRuntime(actionKey, col, v, learned);
        if (!r.assessable) break; // text column — blankness is the only signal
        assessable++;
        if (r.parsed != null) parsedOk++;
      }
      if (assessable === nonBlank.length && parsedOk === 0) unparseable.push(col);
    }
  }

  const recoveryTargets = required.filter(
    (c) => structurallySet.has(c) || dead.includes(c) || unparseable.includes(c),
  );
  return { structurallyMissing, dead, unparseable, recoveryTargets };
}

// ─── Acceptance gate for recovered candidates ───────────────────────────────

export interface GateContext {
  actionKey: ActionKey;
  /** Candidate column being accepted. */
  column: string;
  /** Trimmed probe values for the candidate (≤ VALUE_PROBE_ROW_CAP rows). */
  values: string[];
  /** Probe values for every learned column (same rows, same order) — drives
   *  the cross-column checks. Include the candidate itself. */
  allValues: Record<string, string[]>;
  /** Candidate's selector + the full selector map (duplicate detection). */
  selector: string;
  allSelectors: Record<string, string>;
  /** In-flight learned translations (this action's sanitized enumMappings +
   *  the provisional pooled date format) so gating matches what the runtime
   *  will eventually be configured with. */
  learned?: LearnedTranslations;
  /** yyyy-mm-dd "today" — injectable for tests. */
  todayIso: string;
}

export type GateVerdict = { ok: true } | { ok: false; reason: string };

const dayNumber = (iso: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) / 86_400_000;
};

/** Indexes where BOTH vectors are non-blank; equal iff values match there. */
function identicalOnComparable(a: string[], b: string[], minComparable: number): boolean {
  let comparable = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === '' || b[i] === '') continue;
    if (a[i] !== b[i]) return false;
    comparable++;
  }
  return comparable >= minComparable;
}

/**
 * Decide whether a recovered selector's VALUES prove it is the right column.
 * Abstain-by-default: any failed check rejects the candidate and the column
 * stays blank (worse-than-blank rule). Checks, in order:
 *   1. ≥1 non-blank value.
 *   2. Not string-identical to another learned column's selector.
 *   3. Runtime-parser majority: strictly more than half of the non-blank values
 *      must parse non-null with the SAME parser chain the runtime will apply
 *      (tolerates one junk header/footer row in the probe; a wrong cell fails
 *      across the board). Skipped for plain-text columns (no parser).
 *   4. Date columns: not vector-identical to another date column (≥3 comparable
 *      rows); arrival_date ≤ departure_date on every comparable row; the
 *      target's SEMANTIC date column (arrivals→arrival_date, departures→
 *      departure_date) must have >50% of parsed values within ±1 day of today.
 *   5. The target's KEY column: ≥2 distinct when ≥3 non-blank; not a 1-based
 *      consecutive integer run (row numbers); not vector-identical to another
 *      column.
 *   6. Enum columns: not vector-identical to another enum column (a priority
 *      column self-graded through model-emitted mappings must not pass as
 *      status).
 */
export function gateRecoveredColumn(ctx: GateContext): GateVerdict {
  const { actionKey, column } = ctx;
  const values = ctx.values.map((v) => trimmed(v));
  const nonBlank = values.filter((v) => v !== '');
  if (nonBlank.length === 0) return { ok: false, reason: 'all_blank' };

  const mySelector = trimmed(ctx.selector);
  for (const [other, sel] of Object.entries(ctx.allSelectors)) {
    if (other === column) continue;
    if (trimmed(sel) !== '' && trimmed(sel) === mySelector) {
      return { ok: false, reason: `duplicate_selector:${other}` };
    }
  }

  const contract = contractColumn(actionKey, column);

  // Runtime-parser majority + collect parsed values for the date checks.
  const parsedByValue = new Map<string, unknown>();
  let assessable = false;
  {
    let parsedOk = 0;
    for (const v of nonBlank) {
      const r = parseLikeRuntime(actionKey, column, v, ctx.learned);
      if (!r.assessable) break;
      assessable = true;
      parsedByValue.set(v, r.parsed);
      if (r.parsed != null) parsedOk++;
    }
    if (assessable && parsedOk * 2 <= nonBlank.length) {
      return { ok: false, reason: `parse_majority:${parsedOk}/${nonBlank.length}` };
    }
  }

  if (contract?.type === 'date') {
    const allContractCols = CORE_TARGET_CONTRACTS[actionKey]?.columns ?? [];
    for (const other of allContractCols) {
      if (other.name === column || other.type !== 'date') continue;
      const otherVals = (ctx.allValues[other.name] ?? []).map((v) => trimmed(v));
      if (otherVals.length > 0 && identicalOnComparable(values, otherVals, 3)) {
        return { ok: false, reason: `identical_date_vector:${other.name}` };
      }
    }

    const hasPair =
      allContractCols.some((c) => c.name === 'arrival_date') &&
      allContractCols.some((c) => c.name === 'departure_date') &&
      (column === 'arrival_date' || column === 'departure_date');
    if (hasPair) {
      const otherName = column === 'arrival_date' ? 'departure_date' : 'arrival_date';
      const otherVals = (ctx.allValues[otherName] ?? []).map((v) => trimmed(v));
      for (let i = 0; i < Math.min(values.length, otherVals.length); i++) {
        if (values[i] === '' || otherVals[i] === '') continue;
        const mine = parseLikeRuntime(actionKey, column, values[i]!, ctx.learned);
        const theirs = parseLikeRuntime(actionKey, otherName, otherVals[i]!, ctx.learned);
        if (!mine.assessable || !theirs.assessable) break;
        if (typeof mine.parsed !== 'string' || typeof theirs.parsed !== 'string') continue;
        const arrival = column === 'arrival_date' ? mine.parsed : theirs.parsed;
        const departure = column === 'arrival_date' ? theirs.parsed : mine.parsed;
        if (arrival > departure) return { ok: false, reason: 'date_order_violation' };
      }
    }

    if (DISCOVERY_SEMANTIC_DATE_COLUMNS[actionKey] === column) {
      const today = dayNumber(ctx.todayIso);
      if (today != null) {
        let inWindow = 0;
        let parsedCount = 0;
        for (const v of nonBlank) {
          const parsed = parsedByValue.get(v);
          if (typeof parsed !== 'string') continue;
          const day = dayNumber(parsed);
          if (day == null) continue;
          parsedCount++;
          if (Math.abs(day - today) <= 1) inWindow++;
        }
        if (parsedCount > 0 && inWindow * 2 <= parsedCount) {
          return { ok: false, reason: `semantic_date_window:${inWindow}/${parsedCount}` };
        }
      }
    }
  }

  if (DISCOVERY_KEY_COLUMNS[actionKey] === column) {
    const distinct = new Set(nonBlank);
    if (nonBlank.length >= 3 && distinct.size < 2) {
      return { ok: false, reason: 'constant_key' };
    }
    if (nonBlank.length >= 3 && nonBlank.every((v) => /^\d+$/.test(v))) {
      const nums = [...new Set(nonBlank.map((v) => parseInt(v, 10)))].sort((a, b) => a - b);
      const consecutive = nums.every((n, i) => i === 0 || n === nums[i - 1]! + 1);
      if (consecutive && nums[0] === 1) {
        return { ok: false, reason: 'sequential_key' };
      }
    }
    for (const [other, otherRaw] of Object.entries(ctx.allValues)) {
      if (other === column) continue;
      const otherVals = otherRaw.map((v) => trimmed(v));
      if (identicalOnComparable(values, otherVals, 3)) {
        return { ok: false, reason: `key_mirrors:${other}` };
      }
    }
  }

  if (contract && (contractEnumValues(actionKey, column)?.length ?? 0) > 0) {
    const allContractCols = CORE_TARGET_CONTRACTS[actionKey]?.columns ?? [];
    for (const other of allContractCols) {
      if (other.name === column) continue;
      if ((contractEnumValues(actionKey, other.name)?.length ?? 0) === 0) continue;
      const otherVals = (ctx.allValues[other.name] ?? []).map((v) => trimmed(v));
      if (otherVals.length > 0 && identicalOnComparable(values, otherVals, 3)) {
        return { ok: false, reason: `enum_vector_collision:${other.name}` };
      }
    }
  }

  return { ok: true };
}

/** Canonical enum set for a column from the VALUE contract (what the gate and
 *  the recovery hint teach the model) — TARGET_VALUE_CONTRACTS stays the one
 *  source of truth. */
export function contractEnumValues(actionKey: ActionKey, column: string): string[] | undefined {
  return TARGET_VALUE_CONTRACTS[actionKey]?.columns.find((c) => c.name === column)?.enumValues;
}

/**
 * Build the in-flight LearnedTranslations the gate should evaluate with: the
 * model's same-turn enumMappings (sanitized against the canonical sets, keyed
 * `${table}.${column}` exactly like the persisted knowledge file) plus the
 * provisional pooled date format. valueTranslations is ALWAYS an object (never
 * undefined) so resolveColumnParser takes the new-style generic_enum path —
 * matching how THIS recipe will resolve at poll time — and never the legacy
 * ca_* fallback.
 */
export function learnedForGate(
  actionKey: ActionKey,
  payloadEnums: Record<string, Record<string, string>> | undefined,
  provisionalDateFormat?: LearnedTranslations['dateFormat'],
): LearnedTranslations {
  const table = CORE_TARGET_CONTRACTS[actionKey]?.table;
  const valueTranslations: Record<string, Record<string, string>> = {};
  if (table && payloadEnums) {
    for (const [col, mapping] of Object.entries(payloadEnums)) {
      const canonical = contractEnumValues(actionKey, col);
      if (!canonical || canonical.length === 0) continue;
      const clean = sanitizeEnumMapping(mapping, canonical);
      if (Object.keys(clean).length > 0) valueTranslations[`${table}.${col}`] = clean;
    }
  }
  return {
    valueTranslations,
    ...(provisionalDateFormat ? { dateFormat: provisionalDateFormat } : {}),
  };
}

// ─── Focused re-ask hint ────────────────────────────────────────────────────

export interface RecoveryProblem {
  column: string;
  kind: 'missing' | 'dead' | 'unparseable' | 'rejected';
  /** Gate-failure reason or probe context for the model to act on. */
  detail?: string;
  probedRows?: number;
}

/** Human-shaped expected-value description per contract column — what the
 *  model is told to look for. Generic: derived from the descriptor type. */
export function expectedShapeFor(actionKey: ActionKey, column: string): string {
  if (DISCOVERY_KEY_COLUMNS[actionKey] === column) {
    return 'a unique identifier per row — often only in a link\'s href or a row attribute like data-id';
  }
  const enumValues = contractEnumValues(actionKey, column);
  if (enumValues && enumValues.length > 0) {
    return `a status/category (the PMS's own words are fine — also report enumMappings to: ${enumValues.join(', ')})`;
  }
  const col = contractColumn(actionKey, column);
  switch (col?.type) {
    case 'date': return 'a calendar date (e.g. 06/15/2026 — any format, copied as shown)';
    case 'boolean': return 'a yes/no flag (Y/N, ✓, checkbox — its state may live in an attribute, not text)';
    case 'integer': return 'a whole number';
    case 'bigint': return column.endsWith('_cents') ? 'a money amount' : 'a whole number';
    case 'numeric': return 'a number';
    default: return 'text';
  }
}

const problemPhrase = (p: RecoveryProblem): string => {
  switch (p.kind) {
    case 'missing': return 'has NO selector yet';
    case 'dead': return `has a selector, but it extracts an EMPTY value from every one of the ${p.probedRows ?? 'sampled'} rows checked`;
    case 'unparseable': return `extracts text that is NOT this field (checked ${p.probedRows ?? 'several'} rows${p.detail ? `; ${p.detail}` : ''})`;
    case 'rejected': return `was re-mapped but the new selector failed verification (${p.detail ?? 'wrong values'})`;
  }
};

/**
 * The focused supervisor hint for one recovery attempt. Replaces the old
 * generic "re-read the row" text. Always keeps a softened escape (re-emit with
 * "" if truly absent) — a cornered model otherwise emits `unavailable`/prose
 * and the whole already-found feed is at risk (plan review P1-4).
 */
export function buildRecoveryHint(
  actionKey: ActionKey,
  problems: RecoveryProblem[],
  attempt: number,
  maxAttempts: number,
): string {
  const lines = problems.map(
    (p) => `  - ${p.column}: ${problemPhrase(p)}. Expected: ${expectedShapeFor(actionKey, p.column)}.`,
  );
  return (
    `Hint from your supervisor (verification ${attempt}/${maxAttempts}): I ran your selectors ` +
    `against the live page. These REQUIRED fields are still not extracting real values:\n` +
    `${lines.join('\n')}\n` +
    `The value is probably on this page but somewhere you haven't looked:\n` +
    `(a) under a DIFFERENT column than the label suggests — re-read every column header;\n` +
    `(b) in a smaller sub-line / second line INSIDE each row block — inspect a row closely;\n` +
    `(c) only in an HTML attribute. You may append @attributeName to any selector to read an ` +
    `attribute instead of text — e.g. "td:nth-child(2) a@href", ".@data-id", "td span@title";\n` +
    `(d) off-screen — scroll the table horizontally and down, then take a fresh screenshot.\n` +
    `Investigate with screenshots, then RE-EMIT the complete first-line JSON ` +
    `(url/rowSelector/columns plus valueSamples and enumMappings) with working selectors for the ` +
    `fields above, using these EXACT key names. If, after genuinely re-checking, a field appears ` +
    `nowhere in the rows, re-emit the full JSON with that field as an empty string "".`
  );
}
