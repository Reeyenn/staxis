/**
 * Tests for src/lib/format-date.ts (staff-pages overhaul F10).
 *
 * Run via: npx tsx --test src/lib/__tests__/format-date.test.ts
 *
 * Most functions are faithful ports of private helpers duplicated across
 * src/app pages. Month-key labels are intentionally UTC-pinned because they
 * describe reporting buckets rather than viewer-local instants.
 *
 * Timezone strategy — tests must pass on any machine TZ (UTC CI, Chicago
 * dev): inputs for LOCAL-rendering functions are constructed with the local
 * Date constructor (new Date(y, m, d, …)), so the rendered wall-clock parts
 * are the same everywhere. UTC-pinned functions get hardcoded expectations
 * outright.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLocalDate,
  shortDateFromYmd,
  shortDateFromDate,
  fmtWhenAgo,
  fmtWhenDateTime,
  fmtDurationMins,
  fmtTimeOrDate,
  fmtTimeInZone,
  monthLabelFromYm,
  currentMonthLabel,
  shortMonthFromYmd,
} from '../format-date';

const DAY = 86_400_000;

// ─── parseLocalDate (QualityTab / DeepCleanTab) ─────────────────────────────

describe('parseLocalDate', () => {
  test('parses YYYY-MM-DD as LOCAL midnight, not UTC', () => {
    const d = parseLocalDate('2026-05-12');
    assert.ok(d);
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 4);
    assert.equal(d.getDate(), 12);
    assert.equal(d.getHours(), 0);
    // The original bug this guards against: new Date('2026-05-12') is UTC
    // midnight, which is May 11 west of Greenwich.
    assert.equal(d.getTime(), new Date(2026, 4, 12).getTime());
  });

  test('null / empty / malformed → null', () => {
    assert.equal(parseLocalDate(null), null);
    assert.equal(parseLocalDate(undefined), null);
    assert.equal(parseLocalDate(''), null);
    assert.equal(parseLocalDate('2026-05'), null);
    assert.equal(parseLocalDate('2026-05-xx'), null);
    assert.equal(parseLocalDate('not a date'), null);
  });

  test('out-of-range parts roll over like the original (no clamping)', () => {
    const d = parseLocalDate('2026-13-40');
    assert.ok(d);
    assert.equal(d.getTime(), new Date(2026, 12, 40).getTime());
  });
});

// ─── shortDateFromYmd (CheckbookTab / CapexTab) ─────────────────────────────

describe('shortDateFromYmd', () => {
  test("CheckbookTab variant: month-day, uppercased — 'JUL 4' / '4 JUL'", () => {
    assert.equal(shortDateFromYmd('2026-07-04', 'en', { fields: 'month-day', uppercase: true }), 'JUL 4');
    assert.equal(shortDateFromYmd('2026-07-04', 'es', { fields: 'month-day', uppercase: true }), '4 JUL');
  });

  test("CapexTab variant: month-year — 'Jul 2026' / 'jul 2026'", () => {
    assert.equal(shortDateFromYmd('2026-07-04', 'en', { fields: 'month-year' }), 'Jul 2026');
    assert.equal(shortDateFromYmd('2026-07-04', 'es', { fields: 'month-year' }), 'jul 2026');
  });

  test('parses AND renders in UTC — Jan 1 never slides to Dec 31 locally', () => {
    assert.equal(shortDateFromYmd('2026-01-01', 'en', { fields: 'month-day' }), 'Jan 1');
  });

  test('non-matching input echoes back unchanged (original regex fallback)', () => {
    assert.equal(shortDateFromYmd('07/04/2026', 'en', { fields: 'month-day' }), '07/04/2026');
    assert.equal(shortDateFromYmd('2026-7-4', 'en', { fields: 'month-day' }), '2026-7-4');
  });

  test("null / undefined / '' → '' (CapexTab's null guard)", () => {
    assert.equal(shortDateFromYmd(null, 'en', { fields: 'month-year' }), '');
    assert.equal(shortDateFromYmd(undefined, 'en', { fields: 'month-year' }), '');
    assert.equal(shortDateFromYmd('', 'en', { fields: 'month-day' }), '');
  });
});

// ─── shortDateFromDate (inventory HistoryPanel) ─────────────────────────────

describe('shortDateFromDate', () => {
  test("local render with the es-ES/en-US pair — 'Jan 5' / '5 ene'", () => {
    // Input built with the local constructor → same wall-clock parts on any TZ.
    assert.equal(shortDateFromDate(new Date(2026, 0, 5), 'en'), 'Jan 5');
    assert.equal(shortDateFromDate(new Date(2026, 0, 5), 'es'), '5 ene');
  });
});

// ─── fmtWhenAgo (front-desk LostFoundTab / PackagesTab) ─────────────────────

describe('fmtWhenAgo', () => {
  // Anchor "now" at a fixed local wall-clock instant so day math and the
  // date fallback are deterministic on every machine TZ.
  const NOW = new Date(2026, 2, 15, 12, 0, 0).getTime(); // local Mar 15 noon

  test('same day → today / hoy', () => {
    const iso = new Date(NOW - 3_600_000).toISOString();
    assert.equal(fmtWhenAgo(iso, 'en', NOW), 'today');
    assert.equal(fmtWhenAgo(iso, 'es', NOW), 'hoy');
  });

  test('future timestamps also read today (original days <= 0 branch)', () => {
    const iso = new Date(NOW + DAY).toISOString();
    assert.equal(fmtWhenAgo(iso, 'en', NOW), 'today');
  });

  test('1 day → yesterday / ayer', () => {
    const iso = new Date(NOW - DAY).toISOString();
    assert.equal(fmtWhenAgo(iso, 'en', NOW), 'yesterday');
    assert.equal(fmtWhenAgo(iso, 'es', NOW), 'ayer');
  });

  test('2–6 days → Nd ago / hace Nd', () => {
    const iso = new Date(NOW - 3 * DAY).toISOString();
    assert.equal(fmtWhenAgo(iso, 'en', NOW), '3d ago');
    assert.equal(fmtWhenAgo(iso, 'es', NOW), 'hace 3d');
    const six = new Date(NOW - 6 * DAY).toISOString();
    assert.equal(fmtWhenAgo(six, 'en', NOW), '6d ago');
  });

  test("7+ days → local short date with the es-US/en-US pair — 'Mar 5' / '5 mar'", () => {
    const iso = new Date(NOW - 10 * DAY).toISOString(); // local Mar 5 noon
    assert.equal(fmtWhenAgo(iso, 'en', NOW), 'Mar 5');
    assert.equal(fmtWhenAgo(iso, 'es', NOW), '5 mar');
  });

  test("null / unparseable → ''", () => {
    assert.equal(fmtWhenAgo(null, 'en', NOW), '');
    assert.equal(fmtWhenAgo(undefined, 'en', NOW), '');
    assert.equal(fmtWhenAgo('garbage', 'en', NOW), '');
  });
});

// ─── fmtWhenDateTime (dashboard LogBookCard) ────────────────────────────────

describe('fmtWhenDateTime', () => {
  test("local date+time with the bare es/en locales — 'Mar 5, 3:30 PM' / '5 mar, 15:30'", () => {
    const iso = new Date(2026, 2, 5, 15, 30).toISOString();
    assert.equal(fmtWhenDateTime(iso, 'en'), 'Mar 5, 3:30 PM');
    assert.equal(fmtWhenDateTime(iso, 'es'), '5 mar, 15:30');
  });

  test("invalid input → ''", () => {
    assert.equal(fmtWhenDateTime('garbage', 'en'), '');
    assert.equal(fmtWhenDateTime('', 'es'), '');
  });
});

// ─── fmtDurationMins (housekeeping ForecastDayCard) ─────────────────────────

describe('fmtDurationMins', () => {
  test('under an hour → Nm (including 0m)', () => {
    assert.equal(fmtDurationMins(0), '0m');
    assert.equal(fmtDurationMins(45), '45m');
    assert.equal(fmtDurationMins(59), '59m');
  });

  test('exact hours → Nh', () => {
    assert.equal(fmtDurationMins(60), '1h');
    assert.equal(fmtDurationMins(120), '2h');
  });

  test('mixed → Nh Mm', () => {
    assert.equal(fmtDurationMins(61), '1h 1m');
    assert.equal(fmtDurationMins(130), '2h 10m');
    assert.equal(fmtDurationMins(605), '10h 5m');
  });
});

// ─── fmtTimeOrDate (housekeeper redesign MessagesTab) ───────────────────────

describe('fmtTimeOrDate', () => {
  const NOW = new Date(2026, 5, 10, 20, 0); // local Jun 10, 8 PM

  test("same local day → 'h:mm a'", () => {
    const iso = new Date(2026, 5, 10, 14, 5).toISOString();
    assert.equal(fmtTimeOrDate(iso, NOW), '2:05 PM');
  });

  test("different day → 'MMM d' (English month, like the original)", () => {
    const iso = new Date(2026, 4, 3, 9, 0).toISOString();
    assert.equal(fmtTimeOrDate(iso, NOW), 'May 3');
  });

  test("null / invalid → '' (original try/catch)", () => {
    assert.equal(fmtTimeOrDate(null, NOW), '');
    assert.equal(fmtTimeOrDate(undefined, NOW), '');
    assert.equal(fmtTimeOrDate('garbage', NOW), '');
  });
});

// ─── fmtTimeInZone (housekeeping TimelineView) ──────────────────────────────

describe('fmtTimeInZone', () => {
  test('renders the clock in the EXPLICIT hotel timezone, en-US 12h', () => {
    assert.equal(fmtTimeInZone('2026-03-05T18:30:00Z', 'America/Chicago'), '12:30 PM');
    assert.equal(fmtTimeInZone('2026-03-05T18:30:00Z', 'UTC'), '6:30 PM');
    assert.equal(fmtTimeInZone('2026-03-05T18:30:00Z', 'America/New_York'), '1:30 PM');
  });
});

// ─── monthLabelFromYm (financials page / CapexTab) ──────────────────────────

describe('monthLabelFromYm', () => {
  test("UTC-pinned long label — 'July 2026' / 'julio de 2026'", () => {
    assert.equal(monthLabelFromYm('2026-07', 'en'), 'July 2026');
    assert.equal(monthLabelFromYm('2026-07', 'es'), 'julio de 2026');
  });

  test('January stays January on any machine TZ (timeZone: UTC)', () => {
    assert.equal(monthLabelFromYm('2026-01', 'en'), 'January 2026');
  });

  test("malformed input → 'Invalid Date' (originals did no validation)", () => {
    assert.equal(monthLabelFromYm('garbage', 'en'), 'Invalid Date');
  });
});

// ─── currentMonthLabel (inventory ReportsPanel) ─────────────────────────────

describe('currentMonthLabel', () => {
  test("long LOCAL month with the es-ES/en-US pair — 'July' / 'julio'", () => {
    const now = new Date(2026, 6, 15); // local Jul 15
    assert.equal(currentMonthLabel('en', now), 'July');
    assert.equal(currentMonthLabel('es', now), 'julio');
  });
});

// ─── shortMonthFromYmd (inventory ReportsPanel) ─────────────────────────────

describe('shortMonthFromYmd', () => {
  test('labels every YYYY-MM-DD bucket in its named month', () => {
    const expected = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    expected.forEach((label, index) => {
      const month = String(index + 1).padStart(2, '0');
      assert.equal(shortMonthFromYmd(`2026-${month}-01`, 'en'), label);
    });
  });

  test('also accepts a YYYY-MM month key and uses the requested language', () => {
    assert.equal(shortMonthFromYmd('2026-01', 'en'), 'Jan');
    assert.equal(shortMonthFromYmd('2026-07', 'en'), 'Jul');
    assert.match(shortMonthFromYmd('2026-07', 'es'), /^jul\.?$/i);
  });

  test("malformed or out-of-range month → '—'", () => {
    assert.equal(shortMonthFromYmd('garbage', 'en'), '—');
    assert.equal(shortMonthFromYmd('2026-00-01', 'en'), '—');
    assert.equal(shortMonthFromYmd('2026-13-01', 'en'), '—');
    assert.equal(shortMonthFromYmd('', 'en'), '—');
  });
});
