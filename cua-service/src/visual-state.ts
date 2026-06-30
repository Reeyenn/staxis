/**
 * visual-state — auto-learn for "visual-state" table columns.
 *
 * A visual-state column is one whose value is encoded in something OTHER than its
 * plain textContent: an attribute (Choice Advantage's clean/dirty lives in
 * `tablesort_sortvalue="C"|"D"`), a class, a DOM property, an icon, or — last
 * resort — computed style. The cell's textContent is uninformative (CA reads
 * "Ready" for BOTH clean and dirty rooms), so the normal text reader captures a
 * constant and the column dies.
 *
 * At LEARN time (with Claude vision available), the mapper:
 *   1. DETECTS such a column (a contract enum whose textContent is constant across
 *      rows while vision reads ≥2 distinct values),
 *   2. labels a few sample rows by VISION, keyed by a stable per-row key (room
 *      number) — NOT by row index (a single index shift silently inverts every
 *      label below it),
 *   3. LEARNS the discriminator here (`findDiscriminator`) — the single readable
 *      signal whose value perfectly partitions the rows by vision label,
 *   4. CERTIFIES here (`certifyReplay`) — replays the learned rule with NO vision
 *      and requires it reproduce vision's label on EVERY row, both classes
 *      present — the only guard against shipping an INVERTED map (C→dirty) on a
 *      headerless feed with no backend oracle.
 *
 * The runtime then reads the learned signal for FREE every poll (a plain DOM read,
 * no Claude). This module is PURE (no DOM, no network) so the correctness-critical
 * partition/anti-inversion logic is unit-tested without a browser or vision.
 *
 * Build-once scope: cheap readable hooks only — attribute and class. DOM
 * properties / icon@src / computed-style are deferred (the read path supports
 * attributes today; the rest is additive later).
 */

/** Every readable signal gathered from ONE sample row's target cell at learn time.
 *  `rowKey` is a stable per-row identity (e.g. the room number, read from a TEXT
 *  column); `visionLabel` is the canonical value vision read for THIS row. */
export interface RowSignals {
  rowKey: string;
  visionLabel: string;
  /** Plain textContent of the cell (the uninformative/constant value). */
  text: string;
  /** Every attribute on the cell: name → value. */
  attrs: Record<string, string>;
  /** The cell's classList. */
  classes: string[];
}

/** A durable, replayable read-rule for a visual-state column. The mapper authors
 *  the cell css separately; this carries WHICH signal on the cell holds the value
 *  and how to translate the raw signal value → the canonical enum token. */
export type VisualReadRule =
  | { kind: 'attr'; attr: string; valueMap: Record<string, string> }
  | { kind: 'class'; classMap: Record<string, string> };

/** Class names that are presentation/striping noise, never a data signal — a
 *  2-row sample where clean/dirty happens to alternate would otherwise "discover"
 *  zebra striping as the discriminator. Matches as a case-insensitive SUBSTRING so
 *  it catches CamelCase compounds like Choice Advantage's real `CHI_EvenRowCell`
 *  (no `_`/`-` boundary around "Even"/"Row"). A false-positive only costs a
 *  founder-review park (safe-side), never wrong data. The real guard is the
 *  perfect-partition-over-a-non-alternating-sample requirement below; this is
 *  belt-and-suspenders. */
const STRIPE_CLASS_RE = /(even|odd|stripe|zebra|alternat|altrow|rowalt|nthchild|rowcell|evenrow|oddrow)/i;

/** A signal value that is unique per row (a row id, a timestamp) can "perfectly
 *  partition" a sample by coincidence — reject it. Only conclusive on a real-sized
 *  sample (≥5 rows): a genuine low-cardinality enum (C/D) REPEATS by then, while an
 *  id stays all-distinct. Below that, two distinct values are normal for a binary
 *  signal, so we don't flag (the ≥2-rows-per-class certify gate is the backstop). */
function isRowUnique(valuesByRow: string[]): boolean {
  const nonEmpty = valuesByRow.filter((v) => v !== '');
  if (nonEmpty.length < 5) return false;
  return new Set(nonEmpty).size === nonEmpty.length;
}

/** Does `valuesByRow` perfectly PARTITION the rows by `labels`? Perfect =
 *  every distinct signal value maps to exactly ONE label (a consistent value→label
 *  function), the mapping covers ≥2 labels, and every label is reachable. Returns
 *  the value→label map on success, else null. A signal that's blank on some rows
 *  fails (blank is ambiguous — can't certify it). */
function partitionMap(valuesByRow: string[], labels: string[]): Record<string, string> | null {
  if (valuesByRow.length !== labels.length) return null;
  const map: Record<string, string> = {};
  for (let i = 0; i < valuesByRow.length; i++) {
    const v = valuesByRow[i]!;
    const label = labels[i]!;
    if (v === '') return null; // ambiguous: no signal on this row
    if (v in map) { if (map[v] !== label) return null; } // value maps to 2 labels → not a partition
    else map[v] = label;
  }
  const labelsHit = new Set(Object.values(map));
  const distinctLabels = new Set(labels);
  if (labelsHit.size < 2) return null;                 // must separate ≥2 classes
  if (labelsHit.size !== distinctLabels.size) return null; // must reach every observed label
  return map;
}

export interface DiscriminatorResult {
  rule: VisualReadRule;
  /** The signal that was chosen, for telemetry / founder display. */
  via: string;
}

/**
 * Find the single readable signal whose value perfectly partitions the sample
 * rows by their vision label. Prefers a cheap, semantic ATTRIBUTE over a class.
 * Rejects row-unique values and striping/parity classes. Returns null when no
 * signal cleanly + safely partitions (→ caller abstains / parks for review).
 *
 * REQUIREMENTS the caller must satisfy for a trustworthy result (the anti-zebra
 * guard): pass ≥5 sample rows with BOTH labels present AND ≥2 rows of the SAME
 * label that are ADJACENT in source order — so a parity/zebra signal (which
 * alternates) cannot perfectly-partition labels that don't actually alternate.
 */
export function findDiscriminator(rows: RowSignals[]): DiscriminatorResult | null {
  if (rows.length < 2) return null;
  const labels = rows.map((r) => r.visionLabel);
  if (new Set(labels).size < 2) return null; // need both classes to learn (and to not invert)

  // 1) Attribute candidates (preferred): every attribute name seen on any row,
  //    EXCEPT `class` and `style` — those are presentation surfaces handled
  //    separately (class via the stripe-filtered class loop below; style is
  //    computed-style territory, deferred). Critically, the `class` ATTRIBUTE
  //    value is the full class string, which on a zebra-striped table carries the
  //    row-parity class (CA's CHI_EvenRowCell). On a perfectly-alternating
  //    viewport that string would partition clean/dirty by luck and — being read
  //    here as a plain attr BEFORE the stripe filter — get authored as `@class`,
  //    a parity signal that's wrong on every non-alternating row. Excluding it is
  //    the load-bearing guard; the partition-over-a-non-alternating-sample check
  //    is the backstop. (Codex review BLOCKER.)
  const PRESENTATION_ATTRS = new Set(['class', 'style']);
  const attrNames = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.attrs)) if (!PRESENTATION_ATTRS.has(k)) attrNames.add(k);
  // Deterministic order so a tie picks the same attr every run.
  for (const name of [...attrNames].sort()) {
    const valuesByRow = rows.map((r) => (r.attrs[name] ?? '').trim());
    if (isRowUnique(valuesByRow)) continue;
    const map = partitionMap(valuesByRow, labels);
    if (map) return { rule: { kind: 'attr', attr: name, valueMap: map }, via: `@${name}` };
  }

  // 2) Class candidates (fallback): each class's presence (1/0) across rows,
  //    skipping obvious striping/parity classes.
  const classNames = new Set<string>();
  for (const r of rows) for (const c of r.classes) classNames.add(c);
  for (const cls of [...classNames].sort()) {
    if (STRIPE_CLASS_RE.test(cls)) continue;
    const valuesByRow = rows.map((r) => (r.classes.includes(cls) ? '1' : '0'));
    const map = partitionMap(valuesByRow, labels);
    // A bare present/absent class only distinguishes 2 classes — fine for binary.
    if (map) {
      const classMap: Record<string, string> = {};
      if ('1' in map) classMap[cls] = map['1']!;
      // '0' (absent) label is the "else" — represented by mapping the OTHER class
      // name(s) is impractical here, so a class rule only supports the present case;
      // the runtime treats "class present → its label, else the other label".
      return { rule: { kind: 'class', classMap }, via: `.${cls}` };
    }
  }

  return null;
}

export interface CertifyRow {
  rowKey: string;
  visionLabel: string;
  /** The canonical value produced by REPLAYING the learned rule with NO vision. */
  replayValue: string;
}

export interface CertifyResult { ok: boolean; reason: string }

/**
 * Certify a learned rule: the no-vision replay must reproduce vision's label on
 * EVERY sampled row, with both classes present. This is the ONLY guard against an
 * INVERTED map (C→dirty) on a headerless, oracle-less feed — an inverted map is
 * still in-vocabulary, so membership checks pass it; only per-row agreement with
 * vision catches it. Rows are matched by `rowKey` (room number), never index.
 */
export function certifyReplay(rows: CertifyRow[]): CertifyResult {
  if (rows.length < 2) return { ok: false, reason: 'too few rows to certify' };
  const labels = new Set(rows.map((r) => r.visionLabel));
  if (labels.size < 2) return { ok: false, reason: 'single class in sample — inversion would be invisible' };
  // Both classes must each have ≥2 rows (a 1-row class can coincide).
  const perLabel: Record<string, number> = {};
  for (const r of rows) perLabel[r.visionLabel] = (perLabel[r.visionLabel] ?? 0) + 1;
  if (Object.values(perLabel).some((n) => n < 2)) {
    return { ok: false, reason: 'each class needs ≥2 rows to certify' };
  }
  const seenKeys = new Set<string>();
  for (const r of rows) {
    if (seenKeys.has(r.rowKey)) return { ok: false, reason: `duplicate rowKey ${r.rowKey} — binding unsafe` };
    seenKeys.add(r.rowKey);
    if (r.replayValue === '') return { ok: false, reason: `row ${r.rowKey}: replay read nothing` };
    if (r.replayValue !== r.visionLabel) {
      return { ok: false, reason: `row ${r.rowKey}: replay='${r.replayValue}' vision='${r.visionLabel}' (mismatch/inversion)` };
    }
  }
  return { ok: true, reason: `certified ${rows.length} rows, ${labels.size} classes` };
}

/** Apply a learned rule to one row's signals → canonical value (the runtime/replay
 *  read). Returns '' when the signal is absent/unknown (→ abstain, never guess). */
export function applyRule(rule: VisualReadRule, signals: { attrs: Record<string, string>; classes: string[] }): string {
  if (rule.kind === 'attr') {
    const raw = (signals.attrs[rule.attr] ?? '').trim();
    return rule.valueMap[raw] ?? '';
  }
  // class rule: present → its label; the binary "else" is the other class, which a
  // single-class map can't name — so a class rule only confidently emits the
  // present case and abstains otherwise (binary callers resolve the else upstream).
  for (const [cls, label] of Object.entries(rule.classMap)) {
    if (signals.classes.includes(cls)) return label;
  }
  return '';
}
