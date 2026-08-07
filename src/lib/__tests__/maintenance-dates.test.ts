// Regression tests for the maintenance boards' pure date/cadence helpers
// (src/app/maintenance/_components/mt-dates.ts), extracted from _mt-snow /
// PreventiveTab while fixing the Wave-2 verified bugs:
//   - "0d ago" for a work order submitted the previous calendar day (<24h ago)
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
  workOrderEnding,
  workOrderHistoryCount,
  newScheduleStart,
  newScheduleStartNote,
  nextDueDate,
  daysUntilDue,
  bandFor,
  dueChipLabel,
  nextDueLine,
  writeFailureMessage,
} from '@/app/maintenance/_components/mt-dates';
import { fromWorkOrderRow } from '@/lib/db-mappers';

describe('fmtSubmittedAt', () => {
  test('yesterday 11pm viewed at 7am is "1d ago", never "0d ago"', () => {
    const now = new Date(2026, 4, 12, 7, 0);       // May 12, 7:00 AM local
    const d = new Date(2026, 4, 11, 23, 0);        // May 11, 11:00 PM local (8h earlier)
    const out = fmtSubmittedAt(d, now);
    assert.match(out, / · 1d ago$/);
    assert.doesNotMatch(out, /0d/);
  });

  test('same calendar day renders time · today', () => {
    const now = new Date(2026, 4, 12, 9, 30);
    const d = new Date(2026, 4, 12, 7, 51);
    assert.match(fmtSubmittedAt(d, now), / · today$/);
  });

  test('several calendar days back counts calendar days', () => {
    const now = new Date(2026, 4, 12, 7, 0);
    const d = new Date(2026, 4, 9, 23, 59);        // 3 calendar days back, <3×24h elapsed
    assert.match(fmtSubmittedAt(d, now), / · 3d ago$/);
  });

  test('a week or more falls back to the full date', () => {
    const now = new Date(2026, 4, 12, 7, 0);
    const d = new Date(2026, 4, 1, 12, 0);
    assert.doesNotMatch(fmtSubmittedAt(d, now), /ago/);
    assert.match(fmtSubmittedAt(d, now), /2026/);
  });

  test('null date renders empty', () => {
    assert.equal(fmtSubmittedAt(null), '');
  });
});

describe('fmtSubmittedAtCompact (board-card byline)', () => {
  test('today = time only, no suffix', () => {
    const now = new Date(2026, 4, 12, 9, 30);
    const d = new Date(2026, 4, 12, 7, 51);
    const out = fmtSubmittedAtCompact(d, now);
    assert.doesNotMatch(out, /today|·/);
    assert.match(out, /7:51/);
  });

  test('yesterday <24h ago = "1d", not "0d"', () => {
    const now = new Date(2026, 4, 12, 7, 0);
    const d = new Date(2026, 4, 11, 23, 0);
    const out = fmtSubmittedAtCompact(d, now);
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
    assert.equal(cadenceLabel(45), 'every 45 days');   // was "every 2 mo"
    assert.equal(cadenceLabel(84), 'every 12 wk');     // 12 weeks — was "every 3 mo"
  });

  test('exact units keep their labels (preference: years > months > weeks)', () => {
    assert.equal(cadenceLabel(365), 'every 1 yr');
    assert.equal(cadenceLabel(730), 'every 2 yr');
    assert.equal(cadenceLabel(30), 'every 1 mo');
    assert.equal(cadenceLabel(90), 'every 3 mo');
    assert.equal(cadenceLabel(210), 'every 7 mo');     // divisible by 7 AND 30 → months
    assert.equal(cadenceLabel(14), 'every 2 wk');
    assert.equal(cadenceLabel(10), 'every 10 days');
  });

  test('singular day label is stable', () => {
    assert.equal(cadenceLabel(1), 'every day');
  });
});

describe('daysBetween', () => {
  test('ignores time-of-day and signs correctly', () => {
    assert.equal(daysBetween(new Date(2026, 4, 11, 23, 0), new Date(2026, 4, 12, 7, 0)), 1);
    assert.equal(daysBetween(new Date(2026, 4, 12, 1, 0), new Date(2026, 4, 12, 23, 59)), 0);
    assert.equal(daysBetween(new Date(2026, 4, 12), new Date(2026, 4, 10)), -2);
  });
});

// ── the work-order History popup: what it claims the hotel did ──────────────
//
// The popup is this hotel's record of the maintenance it carried out. It had
// one sentence for two endings: a ticket somebody looked at and judged not to
// be a fault ("Not actually a problem", stored status 'closed') arrived there
// with a green "Done", counted under "N resolved", and the name of whoever
// dismissed it printed under "Fixed by". That is a repair the hotel never
// performed, in the only place anybody would go to check what it did.

describe('what the history popup says a settled ticket was', () => {
  const row = (status: string) => ({
    id: 'a1a1a1a1-0000-4000-8000-000000000009',
    property_id: 'p',
    room_number: 'Pool',
    description: 'Heater making a noise',
    severity: 'medium',
    status,
    completed_by_name: 'Dana',
    resolved_at: '2026-08-06T15:00:00.000Z',
  });

  test('a repair is a repair', () => {
    const w = fromWorkOrderRow(row('resolved'));
    assert.equal(w.status, 'done');
    assert.equal(w.settledAs, 'resolved');
    const ending = workOrderEnding(w.settledAs);
    assert.equal(ending.label, 'Done');
    assert.equal(ending.byLabel, 'Fixed by');
    assert.equal(ending.countsAsRepair, true);
  });

  test('a non issue is off the board WITHOUT claiming anybody fixed anything', () => {
    const w = fromWorkOrderRow(row('closed'));
    assert.equal(w.status, 'done', 'still off the board — the lanes are unchanged');
    assert.equal(w.settledAs, 'closed', 'but which ending it got survives the mapper');
    const ending = workOrderEnding(w.settledAs);
    assert.equal(ending.countsAsRepair, false);
    assert.notEqual(ending.label, 'Done');
    assert.notEqual(ending.byLabel, 'Fixed by', 'nobody fixed it, so nobody is named as having');
    assert.notEqual(ending.tone, 'sage', 'and it must not wear the completed-repair colour');
  });

  test('a live ticket has no ending at all, however it is stalled', () => {
    for (const status of ['submitted', 'assigned', 'in_progress', 'deferred']) {
      const w = fromWorkOrderRow(row(status));
      assert.equal(w.status, 'open', status);
      assert.equal(w.settledAs, null, status);
    }
  });

  test('the header counts repairs, not everything that left the board', () => {
    assert.equal(workOrderHistoryCount(4, 0), '4 repairs · everything closed out');
    assert.equal(workOrderHistoryCount(1, 0), '1 repair · everything closed out');
    // The line that was wrong: four dismissals and no repairs used to read
    // "4 resolved · everything closed out".
    assert.equal(workOrderHistoryCount(0, 4), '0 repairs · 4 were not a problem');
    assert.equal(workOrderHistoryCount(3, 1), '3 repairs · 1 was not a problem');
  });

  test('no em dashes reach the popup copy', () => {
    // Founder ruling, checked by walking the producers rather than the source.
    const strings = [
      workOrderHistoryCount(3, 1), workOrderHistoryCount(2, 0), workOrderHistoryCount(0, 1),
      ...['resolved', 'closed', null].flatMap((s) => {
        const e = workOrderEnding(s as 'resolved' | 'closed' | null);
        return [e.label, e.byLabel];
      }),
    ];
    for (const s of strings) assert.doesNotMatch(s, /—/, s);
  });
});

// ── setting a new upkeep schedule going ────────────────────────────────────
//
// The New-task form used to write the creator's own name into
// `last_completed_by`, so a manager who typed "Fire extinguisher check, every
// 6 months" and pressed Add became, permanently and in this hotel's own
// maintenance record, the person who last performed that service. The companion
// reads that column back (agent/tools/staxis-findings.ts exposes it as
// lastDoneBy) and will repeat it as fact. The chat door has always refused to
// write it for exactly this reason.

describe('starting a new upkeep schedule', () => {
  const now = new Date(2026, 7, 6, 9, 0);

  test('a backfilled date is taken at face value, and says nothing extra', () => {
    const start = newScheduleStart('2026-03-01T00:00:00.000Z', now);
    assert.equal(start.startsFromToday, false);
    assert.equal(start.lastCompletedAt.toISOString(), '2026-03-01T00:00:00.000Z');
    assert.equal(newScheduleStartNote(start.startsFromToday), '');
  });

  test('a blank box starts the count today, and the form has to say so', () => {
    const start = newScheduleStart(null, now);
    assert.equal(start.startsFromToday, true);
    assert.equal(start.lastCompletedAt.getTime(), now.getTime());
    const note = newScheduleStartNote(start.startsFromToday);
    assert.match(note, /starts today/i);
    assert.match(note, /nothing is recorded/i, 'and that nobody is being credited with the work');
    assert.doesNotMatch(note, /—/, 'founder ruling: no em dashes in what a person reads');
  });

  test('an unusable stored date is treated as no date, never as an invalid one', () => {
    const start = newScheduleStart('not a date', now);
    assert.equal(start.startsFromToday, true);
    assert.equal(start.lastCompletedAt.getTime(), now.getTime());
  });

  test('nothing this produces can name a person as having done the work', () => {
    // The whole point. There is no field here for a completer, because typing a
    // schedule in is not performing the service.
    for (const iso of ['2026-03-01T00:00:00.000Z', null]) {
      const start = newScheduleStart(iso, now);
      assert.deepEqual(
        Object.keys(start).sort(),
        ['lastCompletedAt', 'startsFromToday'],
        'a name reappearing here is the bug this exists to stop',
      );
    }
  });
});

// ── an upkeep schedule nobody has ever recorded doing ───────────────────────
//
// The board's next-due used to fall back to `new Date()` for a schedule with no
// last-done date, so it landed under "Due this month" and its card read "due
// today · next <today>" — a due date the hotel never gave, on a job it never
// said it had done. The nightly detector refuses to make that claim on the same
// data (findings/detectors/preventive-due.ts) and says the date is missing
// instead. Reachable in ordinary use: setting a schedule up through the Staxis
// chat stores no date at all when the manager does not know.

describe('a schedule with no last-done date', () => {
  const now = new Date(2026, 7, 6, 9, 0);
  const sched = (lastCompletedAt: Date | null, frequencyDays = 180) => ({ lastCompletedAt, frequencyDays });

  test('has no due date, rather than one of today', () => {
    assert.equal(nextDueDate(sched(null)), null);
    assert.equal(daysUntilDue(sched(null), now), null);
  });

  test('gets its own band, and is not filed as due this month or as overdue', () => {
    const band = bandFor(sched(null), now);
    assert.equal(band, 'unstarted');
    assert.notEqual(band, 'soon');
    assert.notEqual(band, 'overdue', 'never recorded is not the same as late');
  });

  test('and its card claims neither a lateness nor a date', () => {
    assert.equal(dueChipLabel(null), 'no due date');
    assert.doesNotMatch(dueChipLabel(null), /today|overdue|due in/i);
    const line = nextDueLine(null);
    assert.match(line, /last-done date/i, 'it says what is missing');
    assert.doesNotMatch(line, /\d{4}|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/);
    assert.doesNotMatch(line, /—/);
  });

  test('while a schedule that HAS a date keeps counting exactly as before', () => {
    const done = new Date(2026, 1, 6, 9, 0);            // Feb 6 2026
    const due = nextDueDate(sched(done, 180));
    assert.ok(due);
    assert.equal(daysBetween(done, due!), 180);
    assert.equal(bandFor(sched(done, 180), now), 'overdue', 'Feb 6 + 180d is Aug 5, so Aug 6 is late');
    assert.equal(bandFor(sched(new Date(2026, 7, 1), 30), now), 'soon');
    assert.equal(bandFor(sched(new Date(2026, 7, 1), 365), now), 'upcoming');
    assert.match(dueChipLabel(daysUntilDue(sched(done, 180), now)), /overdue/);
    assert.match(nextDueLine(due!), /^next · /);
  });
});

// ── what a refused board write is allowed to blame ─────────────────────────
//
// Every write on both maintenance boards goes through the browser client, and
// the policies behind work_orders (0396) and preventive_tasks (0334) check that
// this person may change this hotel. Postgres refuses with 42501, which is not
// a dropped connection. The Work orders board said it was one, so somebody
// whose access had been narrowed was told to check their wifi and try again,
// which they then did, repeatedly.

describe('what a refused maintenance write tells the person', () => {
  const network = "Couldn't mark it done. Check your connection and try again.";

  test('a permission refusal is never reported as a connection problem', () => {
    const said = writeFailureMessage({ code: '42501' }, network, 'work orders');
    assert.match(said, /permission/i);
    assert.match(said, /work orders/);
    assert.doesNotMatch(said, /connection|try again/i);
    assert.doesNotMatch(said, /—/);
  });

  test('and each board names what the person cannot change', () => {
    assert.match(writeFailureMessage({ code: '42501' }, network, 'upkeep schedules'), /upkeep schedules/);
    assert.match(writeFailureMessage({ code: '42501' }, network, 'work orders'), /work orders/);
  });

  test('a real failure still gets the real message', () => {
    for (const e of [new Error('network down'), { code: '08006' }, null, undefined, 'boom']) {
      assert.equal(writeFailureMessage(e, network, 'work orders'), network);
    }
  });
});
