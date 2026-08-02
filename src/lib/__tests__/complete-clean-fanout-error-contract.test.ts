/** Component-room fanout is best-effort, but returned DB errors must be visible. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'housekeeper', 'complete-clean', 'route.ts'),
  'utf8',
);
const workflowSource = readFileSync(
  join(process.cwd(), 'src', 'lib', 'housekeeper-workflow', 'workflow-store.ts'),
  'utf8',
);
const pmsRoomsSource = readFileSync(
  join(process.cwd(), 'src', 'lib', 'pms-rooms-writes.ts'),
  'utf8',
);

test('complete-clean checks the resolved component fanout error', () => {
  assert.match(source, /const \{ error: fanoutWriteErr \} = await supabaseAdmin/);
  assert.match(source, /if \(fanoutWriteErr\)[\s\S]*component-room fanout write failed/);
});

test('Stage A leaves old direct room-work writers unchanged', () => {
  assert.match(workflowSource, /\.from\('room_work'\)\s*\.upsert/);
  assert.match(pmsRoomsSource, /\.from\('room_work'\)\s*\.update/);
  assert.match(pmsRoomsSource, /\.from\('room_work'\)\s*\.upsert/);
});
