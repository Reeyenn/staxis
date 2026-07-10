// Regression tests for the maintenance boards' pure date/cadence helpers
// (src/app/maintenance/_components/mt-dates.ts), extracted from _mt-snow /
// PreventiveTab while fixing the Wave-2 verified bugs:
//   - "0d ago" for a work order submitted the previous calendar day (<24h ago)
//   - hardcoded-English date strings in the Spanish UI
//   - DST fall-back shifting midnight-anchored due dates a day early
//   - cadence labels lying (45 days → "every 2 mo", 84 days → "every 3 mo")

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  fmtSubmittedAt,
  fmtSubmittedAtCompact,
  daysBetween,
  addDaysLocal,
  cadenceLabel,
} from '@/app/maintenance/_components/mt-dates';

describe('fmtSubmittedAt', () => {
  test('yesterday 11pm viewed at 7am is "1d ago", never "0d ago"', () => {
    const now = new Date(2026, 4, 12, 7, 0);       // May 12, 7:00 AM local
    const d = new Date(2026, 4, 11, 23, 0);        // May 11, 11:00 PM local (8h earlier)
    const out = fmtSubmittedAt(d, false, now);
    assert.match(out, / · 1d ago$/);
    assert.doesNotMatch(out, /0d/);
  });

  test('same calendar day renders time · today', () => {
    const now = new Date(2026, 4, 12, 9, 30);
    const d = new Date(2026, 4, 12, 7, 51);
    assert.match(fmtSubmittedAt(d, false, now), / · today$/);
  });

  test('Spanish output has no English fragments', () => {
    const now = new Date(2026, 4, 12, 7, 0);
    const yesterday = new Date(2026, 4, 11, 23, 0);
    const today = new Date(2026, 4, 12, 6, 0);
    assert.match(fmtSubmittedAt(yesterday, true, now), / · hace 1d$/);
    assert.match(fmtSubmittedAt(today, true, now), / · hoy$/);
    for (const s of [fmtSubmittedAt(yesterday, true, now), fmtSubmittedAt(today, true, now)]) {
      assert.doesNotMatch(s, /today|ago/);
    }
  });

  test('several calendar days back counts calendar days', () => {
    const now = new Date(2026, 4, 12, 7, 0);
    const d = new Date(2026, 4, 9, 23, 59);        // 3 calendar days back, <3×24h elapsed
    assert.match(fmtSubmittedAt(d, false, now), / · 3d ago$/);
  });

  test('a week or more falls back to the full date', () => {
    const now = new Date(2026, 4, 12, 7, 0);
    const d = new Date(2026, 4, 1, 12, 0);
    assert.doesNotMatch(fmtSubmittedAt(d, false, now), /ago/);
    assert.match(fmtSubmittedAt(d, false, now), /2026/);
  });

  test('null date renders empty', () => {
    assert.equal(fmtSubmittedAt(null), '');
  });
});

describe('fmtSubmittedAtCompact (board-card byline)', () => {
  test('today = time only, no suffix', () => {
    const now = new Date(2026, 4, 12, 9, 30);
    const d = new Date(2026, 4, 12, 7, 51);
    const out = fmtSubmittedAtCompact(d, false, now);
    assert.doesNotMatch(out, /today|·/);
    assert.match(out, /7:51/);
  });

  test('yesterday <24h ago = "1d", not "0d"', () => {
    const now = new Date(2026, 4, 12, 7, 0);
    const d = new Date(2026, 4, 11, 23, 0);
    const out = fmtSubmittedAtCompact(d, false, now);
    assert.match(out, / · 1d$/);
    assert.doesNotMatch(out, /0d|ago/);
  });
});

describe('addDaysLocal (DST-safe calendar addition)', () => {
  test('midnight-anchored date + 90 days lands on the right calendar day at midnight', () => {
    // Aug 15 → Nov 13 spans the US fall-back; raw ms addition would land at
    // Nov 12 23:00 in a DST-observing zone.
    const start = new Date(2026, 7, 15, 0, 0, 0);  // Aug 15 2026, 00:00 local
    const out = addDaysLocal(start, 90);
    assert.equal(out.getFullYear(), 2026);
    assert.equal(out.getMonth(), 10);              // November
    assert.equal(out.getDate(), 13);
    assert.equal(out.getHours(), 0);
  });

  test('daysBetween round-trips with addDaysLocal across the transition', () => {
    const start = new Date(2026, 7, 15, 0, 0, 0);
    assert.equal(daysBetween(start, addDaysLocal(start, 90)), 90);
    assert.equal(daysBetween(start, addDaysLocal(start, 365)), 365);
  });

  test('preserves time-of-day', () => {
    const start = new Date(2026, 2, 1, 14, 30, 5, 250);
    const out = addDaysLocal(start, 45);
    assert.equal(out.getHours(), 14);
    assert.equal(out.getMinutes(), 30);
    assert.equal(out.getSeconds(), 5);
    assert.equal(out.getMilliseconds(), 250);
    assert.equal(daysBetween(start, out), 45);
  });
});

describe('cadenceLabel', () => {
  test('never rounds a non-month cadence into months', () => {
    assert.equal(cadenceLabel(45, false), 'every 45 days');   // was "every 2 mo"
    assert.equal(cadenceLabel(84, false), 'every 12 wk');     // 12 weeks — was "every 3 mo"
  });

  test('exact units keep their labels (preference: years > months > weeks)', () => {
    assert.equal(cadenceLabel(365, false), 'every 1 yr');
    assert.equal(cadenceLabel(730, false), 'every 2 yr');
    assert.equal(cadenceLabel(30, false), 'every 1 mo');
    assert.equal(cadenceLabel(90, false), 'every 3 mo');
    assert.equal(cadenceLabel(210, false), 'every 7 mo');     // divisible by 7 AND 30 → months
    assert.equal(cadenceLabel(14, false), 'every 2 wk');
    assert.equal(cadenceLabel(10, false), 'every 10 days');
  });

  test('singular/plural correct in both languages', () => {
    assert.equal(cadenceLabel(1, false), 'every day');
    assert.equal(cadenceLabel(1, true), 'cada día');
    assert.equal(cadenceLabel(30, true), 'cada 1 mes');
    assert.equal(cadenceLabel(60, true), 'cada 2 meses');
    assert.equal(cadenceLabel(365, true), 'cada 1 año');
    assert.equal(cadenceLabel(730, true), 'cada 2 años');
    assert.equal(cadenceLabel(45, true), 'cada 45 días');
    assert.equal(cadenceLabel(84, true), 'cada 12 sem');
  });
});

describe('daysBetween', () => {
  test('ignores time-of-day and signs correctly', () => {
    assert.equal(daysBetween(new Date(2026, 4, 11, 23, 0), new Date(2026, 4, 12, 7, 0)), 1);
    assert.equal(daysBetween(new Date(2026, 4, 12, 1, 0), new Date(2026, 4, 12, 23, 59)), 0);
    assert.equal(daysBetween(new Date(2026, 4, 12), new Date(2026, 4, 10)), -2);
  });
});
