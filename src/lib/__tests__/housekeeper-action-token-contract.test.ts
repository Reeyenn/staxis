/** Regression guard: every public housekeeper action must forward the
 * staff-link bearer from the SMS URL. A raw pid/staffId pair is not auth. */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(
    process.cwd(),
    'src', 'app', 'housekeeper', '[id]', '_components', 'RoomCardActionButtons.tsx',
  ),
  'utf8',
);

describe('housekeeper room-card staff-link auth', () => {
  test('Add Note forwards the staff-link token in its body', () => {
    assert.match(
      source,
      /endpoint:\s*['"]\/api\/housekeeper\/add-note['"][\s\S]{0,220}body:\s*withStaffLinkTokenBody\(/,
    );
  });

  test('Mark for Inspection forwards the staff-link token in its body', () => {
    assert.match(
      source,
      /endpoint:\s*['"]\/api\/housekeeper\/mark-for-inspection['"][\s\S]{0,220}body:\s*withStaffLinkTokenBody\(/,
    );
  });
});
