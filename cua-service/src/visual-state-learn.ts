/**
 * visual-state-learn — orchestration: gather → vision-label → learn → certify.
 *
 * Ties together the DOM gatherer (visual-state-dom.ts) and the pure learn/certify
 * logic (visual-state.ts) into one map-time call the mapper makes when a contract
 * ENUM column reads a constant/uninformative textContent but its value is plainly
 * VISIBLE on screen (Choice Advantage's clean/dirty). The actual Claude vision
 * call is INJECTED (`VisionLabeler`) so this orchestration is unit-tested with a
 * mock — no API, no cost — while the mapper supplies the real vision impl.
 *
 * Two INDEPENDENT vision passes are made: pass 'learn' builds the rule, pass
 * 'certify' grades it. An inverted/wrong rule (e.g. vision mislabeled the learn
 * pass) fails the independent certify and the column is PARKED, never shipped.
 *
 * A fused / multi-column status (CA's occupied/vacant × clean/dirty) naturally
 * PARKS here: no single readable signal partitions a 4-way fused vision label, so
 * findDiscriminator returns null. Safe — no wrong data — and surfaced for review.
 */
import type { Page } from 'playwright';
import { gatherCellSignals } from './visual-state-dom.js';
import { findDiscriminator, certifyReplay, applyRule, type RowSignals } from './visual-state.js';

/** Injected vision call. Given the pass name, returns {rowKey -> canonical label}
 *  for the visible rows by reading the feed screenshot. Each call must be a FRESH,
 *  independent inference so 'learn' and 'certify' don't share a correlated error. */
export type VisionLabeler = (pass: 'learn' | 'certify') => Promise<Map<string, string>>;

export interface VisualLearnOutcome {
  ok: boolean;
  /** Authorable `css@attr` selector when ok. */
  selector?: string;
  /** raw signal value → canonical token (e.g. { C: 'clean', D: 'dirty' }). */
  valueMap?: Record<string, string>;
  /** Which signal was chosen (telemetry / founder display). */
  via?: string;
  /** Human-readable outcome / park reason. */
  reason: string;
}

const MIN_VISIBLE_ROWS = 5;

/**
 * Learn a durable read-rule for one visual-state column, or return a park reason.
 * Never authors anything itself — returns the selector + value map for the caller
 * to write into the recipe (and to gate on `ok`).
 */
export async function learnVisualStateColumn(opts: {
  page: Page;
  rowSelector: string;
  keyCellCss: string;
  targetCellCss: string;
  label: VisionLabeler;
  minRows?: number;
}): Promise<VisualLearnOutcome> {
  const minRows = opts.minRows ?? MIN_VISIBLE_ROWS;

  // 1. DOM signals (every attr/class on the target cell) per visible row, keyed
  //    by room number — the row identity the vision labels join against.
  const dom = await gatherCellSignals(opts.page, opts.rowSelector, opts.keyCellCss, opts.targetCellCss);
  if (dom.length < minRows) {
    return { ok: false, reason: `only ${dom.length} visible rows (<${minRows}) — too few to learn safely` };
  }
  // Duplicate row keys (two rows reading the same room number) make the vision↔DOM
  // join ambiguous — a label could bind to the wrong cell. Park rather than guess.
  const keyCounts = new Map<string, number>();
  for (const d of dom) keyCounts.set(d.rowKey, (keyCounts.get(d.rowKey) ?? 0) + 1);
  if ([...keyCounts.values()].some((n) => n > 1)) {
    return { ok: false, reason: 'duplicate row keys on the page — cannot bind vision labels safely' };
  }
  const domByKey = new Map(dom.map((d) => [d.rowKey, d]));

  // 2. Vision pass A → learn labels, joined to DOM signals by room number.
  const visionA = await opts.label('learn');
  const learnRows: RowSignals[] = [];
  for (const [key, lab] of visionA) {
    const d = domByKey.get(key);
    if (d && lab) learnRows.push({ ...d, visionLabel: lab });
  }
  // Gate on the JOINED rows, not the raw DOM count: findDiscriminator's row-unique
  // guard only kicks in at ≥5 rows, so a thin join (vision labeled few rows, or few
  // matched a DOM key) could otherwise learn a coincidental/row-unique signal.
  // Require ≥minRows joined AND ≥2 rows per label (both classes substantiated).
  if (learnRows.length < minRows) {
    return { ok: false, reason: `only ${learnRows.length} of ${dom.length} rows got a usable vision label (<${minRows})` };
  }
  const labelCounts: Record<string, number> = {};
  for (const r of learnRows) labelCounts[r.visionLabel] = (labelCounts[r.visionLabel] ?? 0) + 1;
  if (Object.keys(labelCounts).length < 2) {
    return { ok: false, reason: 'vision saw <2 distinct values — not a visual-state column (or all rows same state)' };
  }
  if (Object.values(labelCounts).some((n) => n < 2)) {
    return { ok: false, reason: 'a value appears on only 1 labeled row — too thin to learn safely' };
  }

  // Anti-zebra backstop — findDiscriminator's docstring REQUIRES this of its
  // caller, but no caller enforced it: the sample must contain at least one
  // ADJACENT pair of same-label rows in DOM source order. On a sample whose
  // labels perfectly alternate (clean/dirty/clean/dirty…), any presentation
  // attribute that stripes by row parity (e.g. alternating bgcolor on legacy
  // JSP tables) perfectly partitions the labels — and the certify pass,
  // which re-reads the SAME alternating rows, confirms the parity rule
  // instead of catching it. Every later poll where statuses stop alternating
  // would then write INVERTED statuses. Adjacency is checked on the `dom`
  // array (true source order) — the joined learnRows follow the vision map's
  // iteration order, where adjacency is meaningless.
  let hasAdjacentSameLabel = false;
  for (let i = 0; i + 1 < dom.length; i++) {
    const a = visionA.get(dom[i]!.rowKey);
    const b = visionA.get(dom[i + 1]!.rowKey);
    if (a && b && a === b) { hasAdjacentSameLabel = true; break; }
  }
  if (!hasAdjacentSameLabel) {
    return {
      ok: false,
      reason: 'labels perfectly alternate down the visible sample — cannot rule out a striping/parity signal; parked for review',
    };
  }

  // 3. Learn the single readable signal that partitions the labels.
  const disc = findDiscriminator(learnRows);
  if (!disc) {
    return { ok: false, reason: 'no single readable signal partitions the values (fused/multi-column status, or value not in the DOM)' };
  }
  if (disc.rule.kind !== 'attr') {
    // The runtime read path authors `css@attr` only; a class-encoded value is a
    // documented v1 limitation → park for review rather than ship unreadable.
    return { ok: false, reason: `value lives in a ${disc.rule.kind}, not an attribute — not authorable in v1` };
  }

  // 4. Independent vision pass B → certify the rule reproduces FRESH labels.
  //    This is the anti-inversion gate: a rule built off a mislabeled pass A fails
  //    here against an independent pass B.
  const visionB = await opts.label('certify');
  const certRows = [];
  for (const [key, lab] of visionB) {
    const d = domByKey.get(key);
    if (d && lab) certRows.push({ rowKey: key, visionLabel: lab, replayValue: applyRule(disc.rule, d) });
  }
  const cert = certifyReplay(certRows);
  if (!cert.ok) {
    return { ok: false, reason: `certify failed (${cert.reason}) — not shipping unproven` };
  }

  return {
    ok: true,
    selector: `${opts.targetCellCss}@${disc.rule.attr}`,
    valueMap: disc.rule.valueMap,
    via: disc.via,
    reason: `learned ${disc.via}; ${cert.reason}`,
  };
}
