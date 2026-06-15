/**
 * golden-fixtures.ts — GOLDEN-FIXTURE REGRESSION GATE (feature/cua-self-heal-reach).
 *
 * A per-PMS-family recipe is shared by EVERY hotel on that family, so a single
 * bad recipe change breaks the whole fleet at once. This module is the last
 * structural backstop before a recipe change reaches hotels: it snapshots a
 * feed's KNOWN-GOOD extraction shape once (a "golden fixture"), and on any later
 * recipe change re-judges the fresh extraction against that snapshot.
 *
 * THE HARD PART — distinguishing "the RECIPE regressed" (block) from "the DATA
 * legitimately changed" (allow). We gate on CERTIFICATION VERDICTS + column
 * STRUCTURE, never on row VALUES:
 *   - REGRESSED (block): a column the fixture had CERTIFIED is now FAILED (with
 *     value evidence present) or has been DROPPED from the recipe's shipping
 *     columns. The new recipe extracts wrong / fewer-meaning data.
 *   - CHANGED (allow): different row values, a different row count (including an
 *     empty work-order day or a new season), or a column that is merely
 *     `uncertain` now BECAUSE there is no value evidence today. None of these is
 *     evidence the recipe broke.
 *
 * ABSTAIN-BY-DEFAULT: we block ONLY on POSITIVE regression evidence (was
 * certified → now failed, with values present). No value evidence ⟹ we cannot
 * prove regression ⟹ ALLOW (a legitimately-empty day must never be re-parked).
 *
 * DEFAULT-OFF + ABSENT ⟹ SKIP: the gate only fires when (a) the caller's env
 * flag enables it AND (b) a fixture exists for the family+feed. The registry is
 * empty until a fixture is captured and committed, so on a fresh deploy the gate
 * is a no-op — today's behaviour exactly, the live fleet is never re-parked.
 *
 * PRIVACY: a fixture stores DERIVED structure only (column names, per-column
 * verdicts, coarse value-shape tokens, a row COUNT) — never raw rows. Guest
 * names / room numbers never land in a committed fixture.
 *
 * This file is a PURE diff/gate + an in-memory registry — no Playwright,
 * Supabase, Anthropic, fs, or process.env. The caller does the fresh extraction
 * and reads the env flag; this only decides.
 */

export type FixtureColumnVerdict = 'certified' | 'uncertain' | 'failed';

/** A privacy-safe known-good snapshot of one feed's extraction shape. */
export interface GoldenFixture {
  pmsFamily: string;
  /** Recipe action key, e.g. 'getArrivals'. */
  actionKey: string;
  /** ISO timestamp the fixture was captured. */
  capturedAt: string;
  /** Knowledge-file version the snapshot was taken from (provenance). */
  capturedFromVersion?: number;
  /** parse mode at capture ('table' | 'api' | 'csv' | 'inline_text'). */
  parseMode: string;
  /** Shipping column names at capture, sorted. */
  columns: string[];
  /** Per-column certification verdict at capture. */
  columnVerdicts: Record<string, FixtureColumnVerdict>;
  /** Per-column coarse value-shape token at capture (privacy-safe; observability
   *  + a soft drift hint — the gate decides on VERDICTS, not shapes). */
  columnShapes?: Record<string, string>;
  /** Rows the feed yielded at capture (a count only — never the rows). */
  rowCount: number;
}

/** The fresh extraction under the CANDIDATE recipe, as derived structure. */
export interface FreshExtractionShape {
  parseMode: string;
  /** Shipping column names now. */
  columns: string[];
  /** Per-column certification verdict computed on the fresh rows. */
  columnVerdicts: Record<string, FixtureColumnVerdict>;
  /** False when the fresh page yielded NO value evidence (empty/unreadable feed)
   *  — then NOTHING can be value-judged and the gate cannot prove regression. */
  hasValueEvidence: boolean;
  rowCount: number;
}

export interface GoldenFixtureGateInput {
  fixture: GoldenFixture;
  fresh: FreshExtractionShape;
}

export type GoldenFixtureVerdict =
  | { regressed: false; reason: string }
  | { regressed: true; reason: string; columns: string[] };

/**
 * PURE. Block a candidate recipe ONLY on positive regression evidence.
 *
 * For each column the fixture had CERTIFIED:
 *   - dropped from the candidate's shipping columns → REGRESSED.
 *   - present, fresh value evidence exists, now FAILED → REGRESSED.
 *   - present, no fresh value evidence → cannot prove regression → allow (the
 *     legitimately-empty-day case the task calls out).
 *   - present, fresh value evidence, now `uncertain` → ambiguous → allow. The
 *     promotion gate's own unproven-column check routes `uncertain` to founder
 *     review; double-blocking here would re-park a legitimately-thin feed.
 *
 * A parse-mode change is not gated directly: an upgrade (e.g. table→api) is
 * strictly stronger, and a downgrade that drops a column is caught by the
 * column-dropped check above.
 */
export function gateAgainstFixture(input: GoldenFixtureGateInput): GoldenFixtureVerdict {
  const { fixture, fresh } = input;
  const freshCols = new Set(fresh.columns);
  const regressed: string[] = [];

  for (const col of fixture.columns) {
    if (fixture.columnVerdicts[col] !== 'certified') continue; // only guard proven columns
    if (!freshCols.has(col)) {
      regressed.push(`${col}(dropped)`);
      continue;
    }
    if (!fresh.hasValueEvidence) continue; // empty day — cannot prove regression
    if (fresh.columnVerdicts[col] === 'failed') {
      regressed.push(`${col}(certified→failed)`);
    }
    // 'uncertain' with evidence → not blocked (see docstring).
  }

  if (regressed.length > 0) {
    return {
      regressed: true,
      columns: regressed,
      reason: `golden-fixture regression on ${fixture.actionKey}: ${regressed.join(', ')}`,
    };
  }
  return {
    regressed: false,
    reason: fresh.hasValueEvidence
      ? `no regression vs golden fixture (${fixture.columns.length} certified columns still hold)`
      : 'no fresh value evidence — cannot prove regression (legitimately-empty day allowed)',
  };
}

// ─── Builder (privacy-safe capture) ─────────────────────────────────────────

/** Coarse, privacy-safe value-shape token for a column's sampled values. Never
 *  echoes raw values — only describes TYPE/cardinality. */
export function deriveColumnShape(values: string[]): string {
  const nonBlank = values.map((v) => (v ?? '').trim()).filter((v) => v !== '');
  if (nonBlank.length === 0) return 'blank';
  const allMatch = (re: RegExp) => nonBlank.every((v) => re.test(v));
  if (allMatch(/^\d{4}-\d{2}-\d{2}/) || allMatch(/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/)) return 'date';
  if (allMatch(/^-?\d+$/)) return 'int';
  if (allMatch(/^-?\d+(\.\d+)?$/)) return 'numeric';
  if (allMatch(/^(true|false|yes|no|y|n)$/i)) return 'boolean';
  const distinct = new Set(nonBlank.map((v) => v.toLowerCase())).size;
  if (distinct <= Math.max(2, Math.ceil(nonBlank.length / 4))) return `enum:${distinct}`;
  return 'text';
}

export interface BuildGoldenFixtureInput {
  pmsFamily: string;
  actionKey: string;
  capturedAt: string;
  capturedFromVersion?: number;
  parseMode: string;
  /** Shipping columns to snapshot (sorted internally). */
  columns: string[];
  columnVerdicts: Record<string, FixtureColumnVerdict>;
  /** Optional sampled values per column → derive coarse shapes (privacy-safe). */
  allValues?: Record<string, string[]>;
  rowCount: number;
}

/** PURE. Build a privacy-safe golden fixture from a known-good extraction. */
export function buildGoldenFixture(input: BuildGoldenFixtureInput): GoldenFixture {
  const columns = [...input.columns].sort();
  const columnShapes: Record<string, string> = {};
  if (input.allValues) {
    for (const col of columns) {
      columnShapes[col] = deriveColumnShape(input.allValues[col] ?? []);
    }
  }
  return {
    pmsFamily: input.pmsFamily,
    actionKey: input.actionKey,
    capturedAt: input.capturedAt,
    ...(input.capturedFromVersion != null ? { capturedFromVersion: input.capturedFromVersion } : {}),
    parseMode: input.parseMode,
    columns,
    columnVerdicts: Object.fromEntries(columns.map((c) => [c, input.columnVerdicts[c] ?? 'uncertain'])),
    ...(input.allValues ? { columnShapes } : {}),
    rowCount: input.rowCount,
  };
}

// ─── In-memory registry (absent ⟹ skip) ────────────────────────────────────
//
// Production registers fixtures from a committed data module (out of scope to
// populate here — until a fixture is captured + committed the registry is empty
// and the gate is a no-op). Tests register fixtures loaded from
// __tests__/fixtures/*.json. NEVER reads fs at runtime.

const REGISTRY = new Map<string, GoldenFixture>();

function regKey(pmsFamily: string, actionKey: string): string {
  return `${pmsFamily}::${actionKey}`;
}

export function registerGoldenFixture(fixture: GoldenFixture): void {
  REGISTRY.set(regKey(fixture.pmsFamily, fixture.actionKey), fixture);
}

/** ABSENT ⟹ null ⟹ caller skips the gate (no-op = today's behaviour). */
export function loadGoldenFixture(pmsFamily: string, actionKey: string): GoldenFixture | null {
  return REGISTRY.get(regKey(pmsFamily, actionKey)) ?? null;
}

/** Test seam — drop all registered fixtures (then re-seed the committed set). */
export function clearGoldenFixtures(): void {
  REGISTRY.clear();
}

// ─── Committed production fixtures ──────────────────────────────────────────
//
// EMPTY by default ⟹ the gate is INERT in production (absent ⟹ skip = today's
// behaviour) — the live fleet is never re-parked on rollout. To ACTIVATE the
// gate for a family+feed, append a privacy-safe GoldenFixture captured from a
// known-good extraction (use buildGoldenFixture; column names + per-column
// verdicts + coarse shapes + a row COUNT only — NEVER raw rows). Registered at
// module load so any committed entry is live without an fs read or migration.
export const KNOWN_GOLDEN_FIXTURES: GoldenFixture[] = [];
for (const f of KNOWN_GOLDEN_FIXTURES) registerGoldenFixture(f);
