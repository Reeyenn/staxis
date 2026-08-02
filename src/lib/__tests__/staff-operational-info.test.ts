import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  fmtScheduledHours,
  isScheduledNow,
  weeklyCapMinutes,
  weeklyLimitStatus,
} from '@/lib/schedule-board';
import { propertyLocalClockMinutes } from '@/lib/schedule/local-date';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('staff operational information', () => {
  test('formats scheduled hours against the resolved weekly cap', () => {
    assert.equal(weeklyCapMinutes(undefined), 40 * 60);
    assert.equal(weeklyCapMinutes(0), 40 * 60);
    assert.equal(weeklyCapMinutes(32), 32 * 60);
    assert.equal(fmtScheduledHours(32 * 60, weeklyCapMinutes(40)), 'Scheduled 32/40h');
  });

  test('classifies near and over limits at exact boundaries', () => {
    assert.equal(weeklyLimitStatus(35 * 60 + 59, 40), null);
    assert.equal(weeklyLimitStatus(36 * 60, 40), 'near');
    assert.equal(weeklyLimitStatus(40 * 60, 40), 'near');
    assert.equal(weeklyLimitStatus(40 * 60 + 1, 40), 'over');
    assert.equal(weeklyLimitStatus(0, 2), null, 'an empty row is not a warning');
  });

  test('uses an inclusive start and exclusive end for scheduled-now state', () => {
    const dayShift = { startMin: 8 * 60, endMin: 16 * 60 };
    assert.equal(isScheduledNow(dayShift, 8 * 60), true);
    assert.equal(isScheduledNow(dayShift, 16 * 60 - 1), true);
    assert.equal(isScheduledNow(dayShift, 16 * 60), false);

    const overnight = { startMin: 23 * 60, endMin: 31 * 60 };
    assert.equal(isScheduledNow(overnight, 23 * 60), true);
    assert.equal(isScheduledNow(overnight, 23 * 60 + 59), true);
    assert.equal(isScheduledNow(overnight, 0), false, 'the row belongs to its start date');
  });

  test('reads the current minute in the property timezone, not the manager browser timezone', () => {
    const instant = new Date('2026-05-15T01:00:00Z');
    assert.equal(propertyLocalClockMinutes(instant, 'America/Chicago'), 20 * 60);
    assert.equal(propertyLocalClockMinutes(instant, 'Pacific/Kiritimati'), 15 * 60);
    assert.equal(propertyLocalClockMinutes(instant, null), 60);
    assert.equal(propertyLocalClockMinutes(instant, 'Not/A/Real/TZ'), 60);
  });

  test('keeps the approved placements compact and schedule-derived', () => {
    const weekRoster = source('src/app/staff/_components/schedule/WeekRoster.tsx');
    const dayBoard = source('src/app/staff/_components/schedule/DayBoard.tsx');

    assert.match(weekRoster, /fmtScheduledHours\(min, capMin\)/);
    assert.match(weekRoster, /'Near limit'/);
    assert.match(weekRoster, /'Over limit'/);
    assert.doesNotMatch(weekRoster, /worked hours|attendance|clocked in|on shift/i);

    const block = dayBoard.indexOf('{\/\* block \*\/}');
    const badge = dayBoard.indexOf("{'Scheduled now'}");
    const time = dayBoard.indexOf('{fmtMinRange(sh.startMin, sh.endMin)}');
    assert.ok(block >= 0 && block < badge && badge < time, 'Scheduled now stays beside the shift time');
    assert.match(dayBoard, /scheduledNow=\{isToday && isScheduledNow\(sh, nowMin\)\}/);
  });
});
