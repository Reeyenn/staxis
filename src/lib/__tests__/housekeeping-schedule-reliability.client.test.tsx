import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  isCurrentScheduleBoardRequest,
  type ScheduleBoardRequestStamp,
} from '@/app/housekeeping/_components/ScheduleTab';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function source(): string {
  return readFileSync(
    join(process.cwd(), 'src', 'app', 'housekeeping', '_components', 'ScheduleTab.tsx'),
    'utf8',
  );
}

function section(contents: string, start: string, end: string): string {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  assert.ok(endIndex > startIndex, `missing section end: ${end}`);
  return contents.slice(startIndex, endIndex);
}

describe('Housekeeping board request ownership', () => {
  test('a deferred hotel/date A response cannot replace the newer B board', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const firstStamp: ScheduleBoardRequestStamp = { scopeKey: 'hotel-a:2026-07-27', sequence: 1 };
    const secondStamp: ScheduleBoardRequestStamp = { scopeKey: 'hotel-b:2026-07-28', sequence: 2 };
    const firstSignal = { aborted: false };
    const secondSignal = { aborted: false };
    let currentScopeKey: string | null = firstStamp.scopeKey;
    let latestSequence = firstStamp.sequence;
    let committed = '';

    const settle = async (
      request: Deferred<string>,
      stamp: ScheduleBoardRequestStamp,
      signal: { aborted: boolean },
    ) => {
      const value = await request.promise;
      if (isCurrentScheduleBoardRequest(currentScopeKey, latestSequence, stamp, signal)) {
        committed = value;
      }
    };

    const firstSettlement = settle(first, firstStamp, firstSignal);
    currentScopeKey = secondStamp.scopeKey;
    latestSequence = secondStamp.sequence;
    firstSignal.aborted = true;
    const secondSettlement = settle(second, secondStamp, secondSignal);

    second.resolve('hotel B board');
    await secondSettlement;
    first.resolve('stale hotel A board');
    await firstSettlement;

    assert.equal(committed, 'hotel B board');
  });

  test('an older response is stale even when a newer request has the same scope', async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const scopeKey = 'hotel-a:2026-07-27';
    const olderStamp = { scopeKey, sequence: 11 };
    const newerStamp = { scopeKey, sequence: 12 };
    let latestSequence = newerStamp.sequence;
    let committed = '';

    const settle = async (request: Deferred<string>, stamp: ScheduleBoardRequestStamp) => {
      const value = await request.promise;
      if (isCurrentScheduleBoardRequest(scopeKey, latestSequence, stamp)) committed = value;
    };

    const olderSettlement = settle(older, olderStamp);
    const newerSettlement = settle(newer, newerStamp);
    newer.resolve('newest board');
    await newerSettlement;
    older.resolve('older board');
    await olderSettlement;

    assert.equal(committed, 'newest board');
    latestSequence += 1;
    assert.equal(isCurrentScheduleBoardRequest(scopeKey, latestSequence, newerStamp), false);
  });
});

describe('Housekeeping board network reliability contract', () => {
  const schedule = source();
  const boardRead = section(schedule, '// Board fetch (rooms + crew + assignment).', '// ── Derived');
  const mutations = section(schedule, '// ── Mutations', '// ── Render');

  test('board reads abort their predecessor and gate every terminal state update', () => {
    assert.match(schedule, /const boardViewerKey = user[\s\S]*?user\.uid[\s\S]*?user\.role[\s\S]*?user\.propertyAccess/);
    assert.match(schedule, /boardResultScopeKey === boardScope\.key/);
    assert.match(schedule, /const currentBoardLoaded = boardLoaded && boardDataMatchesScope/);
    assert.match(boardRead, /const controller = new AbortController\(\)/);
    assert.match(boardRead, /activeBoardRequest\.current\?\.controller\.abort\(\)/);
    assert.match(boardRead, /\{ signal: controller\.signal \}/);
    assert.match(boardRead, /if \(!ownsRequest\(\)\) return false;[\s\S]*?setBoardData/);
    assert.match(boardRead, /catch \(e\) \{[\s\S]*?if \(!ownsRequest\(\)\) return false;[\s\S]*?setBoardErr/);
    assert.match(boardRead, /if \(ownsRequest\(\)\) \{[\s\S]*?setBoardResultScopeKey\(scope\.key\);[\s\S]*?setBoardLoaded\(true\)/);
    assert.match(boardRead, /active\.controller\.abort\(\)/);
  });

  test('all schedule writes have a terminal deadline and use their captured scope', () => {
    assert.equal((mutations.match(/fetchWithAuth\('/g) ?? []).length, 5);
    assert.equal(
      (mutations.match(/timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS/g) ?? []).length,
      5,
    );
    assert.doesNotMatch(mutations, /JSON\.stringify\(\{ propertyId: pid/);
    assert.match(mutations, /propertyId: scope\.propertyId/);
    assert.match(mutations, /date: scope\.date/);
  });

  test('every ambiguous write failure reconciles the stamped board before reporting', () => {
    for (const [start, end] of [
      ['const onReassign', 'const onUnassign'],
      ['const onUnassign', 'const onAutoAssign'],
      ['const onAutoAssign', '// Re-plan the whole day'],
      ['const onReplan', '// Removed 2026-07-24'],
    ] as const) {
      const action = section(mutations, start, end);
      assert.match(action, /catch \(e\) \{[\s\S]*?await refreshBoard\(scope\)/, start);
      assert.match(action, /boardScopeRef\.current === scope/, start);
    }

    const reassign = section(mutations, 'const onReassign', 'const onUnassign');
    const unassign = section(mutations, 'const onUnassign', 'const onAutoAssign');
    assert.doesNotMatch(section(reassign, '} catch (e) {', '\n    }\n  },'), /patchAssignee/);
    assert.doesNotMatch(section(unassign, '} catch (e) {', '\n    }\n  },'), /patchAssignee/);
  });

  test('does not run the obsolete plan fan-out for an always-null freshness stamp', () => {
    assert.doesNotMatch(schedule, /subscribeToPlanSnapshot|planSnapshot|planLoaded/);
    assert.match(schedule, /const pulledAtIso = dashboardNums\?\.pulledAt/);
    assert.match(schedule, /const pmsSummaryFailed = dashboardLoaded && dashboardNums === null/);
  });
});
