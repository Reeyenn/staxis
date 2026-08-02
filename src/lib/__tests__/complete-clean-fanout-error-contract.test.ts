/** Component-room fanout is best-effort, but returned DB errors must be visible. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'housekeeper', 'complete-clean', 'route.ts'),
  'utf8',
);

test('complete-clean checks the resolved component fanout error', () => {
  assert.match(source, /const \{ error: fanoutWriteErr \} = await supabaseAdmin/);
  assert.match(source, /if \(fanoutWriteErr\)[\s\S]*component-room fanout write failed/);
});
