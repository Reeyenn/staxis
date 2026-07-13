/** Core cleaning actions must fail honestly when their request rejects. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src', 'app', 'housekeeper', '[id]', 'page.tsx'),
  'utf8',
);

test('guardedPost converts a network rejection into an unsuccessful result', () => {
  const guardedPost = source.match(
    /const guardedPost = useCallback\(([\s\S]*?)\n  \);\n\n  \/\/ Checklist/,
  )?.[1] ?? '';
  assert.ok(guardedPost, 'expected the guardedPost helper');
  assert.match(guardedPost, /catch \{[\s\S]*return \{ ok: false, data: null as unknown \}/);
  assert.match(guardedPost, /finally \{[\s\S]*inFlightRoomActionsRef\.current\.delete\(lockKey\)/);
});

test('online pending queue work remains visible to the housekeeper', () => {
  assert.match(source, /offline\.lastDrain\.pending > 0/);
  assert.match(source, /hkOfflineSyncing[\s\S]*offline\.lastDrain\.pending/);
});
