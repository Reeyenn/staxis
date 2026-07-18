/** Core cleaning actions must fail honestly when their request rejects. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src', 'app', 'housekeeper', '[id]', 'page.tsx'),
  'utf8',
);

test('room-action posts convert a network rejection into an unsuccessful result', () => {
  // The catch lives in postStaffAction — the single POST scaffold every
  // room-action write (guardedPost callers AND direct callers like
  // reset-clean) goes through.
  const postStaffAction = source.match(
    /const postStaffAction = useCallback\(([\s\S]*?)\n  \);\n/,
  )?.[1] ?? '';
  assert.ok(postStaffAction, 'expected the postStaffAction helper');
  assert.match(postStaffAction, /catch \{[\s\S]*return \{ ok: false, data: null as unknown \}/);

  const guardedPost = source.match(
    /const guardedPost = useCallback\(([\s\S]*?)\n  \);\n/,
  )?.[1] ?? '';
  assert.ok(guardedPost, 'expected the guardedPost helper');
  assert.match(guardedPost, /finally \{[\s\S]*inFlightRoomActionsRef\.current\.delete\(lockKey\)/);
});

test('online pending queue work remains visible to the housekeeper', () => {
  assert.match(source, /offline\.lastDrain\.pending > 0/);
  assert.match(source, /hkOfflineSyncing[\s\S]*offline\.lastDrain\.pending/);
});
