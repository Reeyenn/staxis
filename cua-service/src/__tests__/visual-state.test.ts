/**
 * visual-state — pure unit coverage for the auto-learn of "visual-state" columns
 * (a cell whose value lives in an attribute/class, not textContent).
 *
 * The centerpiece fixture is Choice Advantage's REAL housekeeping markup, where
 * clean vs dirty cells differ in TWO places: the genuine signal
 * `tablesort_sortvalue="C"|"D"` AND a row-parity zebra class `CHI_EvenRowCell`.
 * A naive 2-row diff "discovers" both; the suite proves the learner picks the
 * real attribute and rejects the parity class, and that the certify step catches
 * an inverted (C→dirty) map — the one failure that ships silently wrong data on a
 * headerless feed with no backend oracle.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findDiscriminator,
  certifyReplay,
  applyRule,
  type RowSignals,
  type CertifyRow,
} from '../visual-state.js';

// Choice Advantage housekeeping rows, derived from the real captured cell HTML:
//   CLEAN(odd):  <td class="UBcontainer CHI_EvenCell" tablesort_sortvalue="C">
//   DIRTY(even): <td class="UBcontainer CHI_EvenCell CHI_EvenRowCell" tablesort_sortvalue="D">
// CHI_EvenRowCell is present on EVEN table rows (a zebra class), NOT on the value.
function caRow(room: string, label: 'clean' | 'dirty', evenRow: boolean): RowSignals {
  return {
    rowKey: room,
    visionLabel: label,
    text: 'Ready', // constant for BOTH clean and dirty — the uninformative textContent
    attrs: { edit: 'false', tablesort_sortvalue: label === 'clean' ? 'C' : 'D' },
    classes: evenRow ? ['UBcontainer', 'CHI_EvenCell', 'CHI_EvenRowCell'] : ['UBcontainer', 'CHI_EvenCell'],
  };
}

// A realistic multi-row sample: clean/dirty do NOT align with row parity
// (105 odd-clean, 106 even-clean are consecutive same-label across a parity flip),
// so the parity class cannot perfectly-partition the labels.
const CA_SAMPLE: RowSignals[] = [
  caRow('101', 'clean', false),
  caRow('102', 'dirty', true),
  caRow('103', 'clean', false),
  caRow('104', 'dirty', true),
  caRow('105', 'clean', false),
  caRow('106', 'clean', true), // even + clean — breaks the parity↔label correlation
  caRow('201', 'dirty', true),
];

describe('findDiscriminator — learns the real signal, rejects parity', () => {
  test('CA: picks tablesort_sortvalue (attr), NOT the CHI_EvenRowCell zebra class', () => {
    const res = findDiscriminator(CA_SAMPLE);
    assert.ok(res, 'should learn a rule');
    assert.equal(res.rule.kind, 'attr');
    if (res.rule.kind !== 'attr') return;
    assert.equal(res.rule.attr, 'tablesort_sortvalue');
    assert.deepEqual(res.rule.valueMap, { C: 'clean', D: 'dirty' });
    assert.equal(res.via, '@tablesort_sortvalue');
  });

  test('the parity class alone (no real attr) is rejected → null (abstain)', () => {
    // Strip the genuine attr; only the zebra class is left as a "signal".
    const stripped = CA_SAMPLE.map((r) => ({ ...r, attrs: { edit: 'false' } }));
    const res = findDiscriminator(stripped);
    assert.equal(res, null, 'must NOT learn a parity/zebra class as the discriminator');
  });

  test('even the 2-row trap (101 clean vs 201 dirty) picks the attr, not the class', () => {
    // With only these two rows the parity class ALSO perfectly partitions — but
    // attribute priority means the real attr wins regardless.
    const res = findDiscriminator([caRow('101', 'clean', false), caRow('201', 'dirty', true)]);
    assert.ok(res);
    assert.equal(res!.rule.kind, 'attr');
  });

  test('rejects a row-unique attribute (an id) even if it "partitions"', () => {
    // ≥5 rows so the id (all-distinct) is distinguishable from the real binary
    // signal `s` (which repeats C/D). 'rowid' sorts before 's' so a naive learner
    // would grab it first.
    const rows: RowSignals[] = [
      { rowKey: '101', visionLabel: 'clean', text: 'Ready', attrs: { rowid: 'r1', s: 'C' }, classes: [] },
      { rowKey: '102', visionLabel: 'dirty', text: 'Ready', attrs: { rowid: 'r2', s: 'D' }, classes: [] },
      { rowKey: '103', visionLabel: 'clean', text: 'Ready', attrs: { rowid: 'r3', s: 'C' }, classes: [] },
      { rowKey: '104', visionLabel: 'dirty', text: 'Ready', attrs: { rowid: 'r4', s: 'D' }, classes: [] },
      { rowKey: '105', visionLabel: 'clean', text: 'Ready', attrs: { rowid: 'r5', s: 'C' }, classes: [] },
      { rowKey: '106', visionLabel: 'dirty', text: 'Ready', attrs: { rowid: 'r6', s: 'D' }, classes: [] },
    ];
    const res = findDiscriminator(rows);
    assert.ok(res);
    assert.equal(res!.rule.kind, 'attr');
    if (res!.rule.kind === 'attr') assert.equal(res!.rule.attr, 's'); // 's', never 'rowid'
  });

  test('a clean semantic class IS learnable when no attr carries the value', () => {
    const rows: RowSignals[] = [
      { rowKey: '101', visionLabel: 'clean', text: 'Ready', attrs: { edit: 'false' }, classes: ['cellClean'] },
      { rowKey: '102', visionLabel: 'dirty', text: 'Ready', attrs: { edit: 'false' }, classes: ['cellDirty'] },
      { rowKey: '103', visionLabel: 'clean', text: 'Ready', attrs: { edit: 'false' }, classes: ['cellClean'] },
      { rowKey: '104', visionLabel: 'dirty', text: 'Ready', attrs: { edit: 'false' }, classes: ['cellDirty'] },
    ];
    const res = findDiscriminator(rows);
    assert.ok(res);
    assert.equal(res!.rule.kind, 'class');
  });

  test('returns null when only one class is present (cannot learn, inversion-blind)', () => {
    const oneClass = [caRow('101', 'clean', false), caRow('103', 'clean', false), caRow('105', 'clean', false)];
    assert.equal(findDiscriminator(oneClass), null);
  });

  test('returns null on <2 rows', () => {
    assert.equal(findDiscriminator([caRow('101', 'clean', false)]), null);
  });
});

describe('certifyReplay — anti-inversion gate', () => {
  // Replay the CA sample THROUGH the learned rule (correct map) and certify.
  const correctRule = { kind: 'attr' as const, attr: 'tablesort_sortvalue', valueMap: { C: 'clean', D: 'dirty' } };
  const invertedRule = { kind: 'attr' as const, attr: 'tablesort_sortvalue', valueMap: { C: 'dirty', D: 'clean' } };

  function replayWith(rule: { kind: 'attr'; attr: string; valueMap: Record<string, string> }): CertifyRow[] {
    return CA_SAMPLE.map((r) => ({
      rowKey: r.rowKey,
      visionLabel: r.visionLabel,
      replayValue: applyRule(rule, r),
    }));
  }

  test('correct map certifies (100% match, both classes ≥2 rows)', () => {
    const res = certifyReplay(replayWith(correctRule));
    assert.equal(res.ok, true, res.reason);
  });

  test('INVERTED map (C→dirty) is caught — the core guarantee', () => {
    const res = certifyReplay(replayWith(invertedRule));
    assert.equal(res.ok, false);
    assert.match(res.reason, /mismatch|inversion/);
  });

  test('single-class sample refuses to certify (inversion would be invisible)', () => {
    const rows: CertifyRow[] = [
      { rowKey: '101', visionLabel: 'clean', replayValue: 'clean' },
      { rowKey: '103', visionLabel: 'clean', replayValue: 'clean' },
    ];
    const res = certifyReplay(rows);
    assert.equal(res.ok, false);
    assert.match(res.reason, /single class/);
  });

  test('a class with only ONE row refuses (a 1-row class can coincide)', () => {
    const rows: CertifyRow[] = [
      { rowKey: '101', visionLabel: 'clean', replayValue: 'clean' },
      { rowKey: '103', visionLabel: 'clean', replayValue: 'clean' },
      { rowKey: '102', visionLabel: 'dirty', replayValue: 'dirty' }, // only 1 dirty
    ];
    const res = certifyReplay(rows);
    assert.equal(res.ok, false);
    assert.match(res.reason, /≥2 rows/);
  });

  test('duplicate rowKey is rejected (binding unsafe)', () => {
    const rows: CertifyRow[] = [
      { rowKey: '101', visionLabel: 'clean', replayValue: 'clean' },
      { rowKey: '101', visionLabel: 'dirty', replayValue: 'dirty' },
      { rowKey: '102', visionLabel: 'dirty', replayValue: 'dirty' },
      { rowKey: '103', visionLabel: 'clean', replayValue: 'clean' },
    ];
    const res = certifyReplay(rows);
    assert.equal(res.ok, false);
    assert.match(res.reason, /duplicate rowKey/);
  });

  test('a blank replay (signal absent on a row) fails certify, never guesses', () => {
    const rows: CertifyRow[] = [
      { rowKey: '101', visionLabel: 'clean', replayValue: 'clean' },
      { rowKey: '103', visionLabel: 'clean', replayValue: 'clean' },
      { rowKey: '102', visionLabel: 'dirty', replayValue: '' }, // signal missing
      { rowKey: '104', visionLabel: 'dirty', replayValue: 'dirty' },
    ];
    const res = certifyReplay(rows);
    assert.equal(res.ok, false);
    assert.match(res.reason, /read nothing/);
  });
});

describe('applyRule — runtime/replay read', () => {
  const rule = { kind: 'attr' as const, attr: 'tablesort_sortvalue', valueMap: { C: 'clean', D: 'dirty' } };

  test('reads the attr → canonical', () => {
    assert.equal(applyRule(rule, { attrs: { tablesort_sortvalue: 'C' }, classes: [] }), 'clean');
    assert.equal(applyRule(rule, { attrs: { tablesort_sortvalue: 'D' }, classes: [] }), 'dirty');
  });

  test('abstains ("") on an unknown raw value — never guesses', () => {
    assert.equal(applyRule(rule, { attrs: { tablesort_sortvalue: 'X' }, classes: [] }), '');
    assert.equal(applyRule(rule, { attrs: {}, classes: [] }), '');
  });

  test('class rule reads present-class → its label', () => {
    const cls = { kind: 'class' as const, classMap: { cellDirty: 'dirty' } };
    assert.equal(applyRule(cls, { attrs: {}, classes: ['x', 'cellDirty'] }), 'dirty');
    assert.equal(applyRule(cls, { attrs: {}, classes: ['x'] }), '');
  });
});
