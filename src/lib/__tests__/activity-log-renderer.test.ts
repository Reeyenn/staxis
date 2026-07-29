import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  categoryLabel,
  renderDescription,
  sourceLabel,
} from '../activity-log/renderer';
import type { ActivityLogRow } from '../activity-log/types';

function makeRow(over: Partial<ActivityLogRow> = {}): ActivityLogRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    property_id: '00000000-0000-0000-0000-000000000010',
    occurred_at: '2026-05-25T10:00:00Z',
    event_category: 'housekeeping',
    event_type: 'cleaning_completed',
    actor_account_id: null,
    actor_name: 'Maria Lopez',
    actor_role: 'housekeeping',
    target_type: 'room',
    target_id: '305',
    target_label: 'Room 305',
    description: 'Maria Lopez finished cleaning room 305 (22 min)',
    source: 'housekeeper_app',
    source_event_id: null,
    metadata: { room_number: '305', duration_minutes: 22 },
    created_at: '2026-05-25T10:00:00Z',
    ...over,
  };
}

describe('activity-log English rendering', () => {
  test('returns the stored English description verbatim', () => {
    assert.equal(
      renderDescription(makeRow()),
      'Maria Lopez finished cleaning room 305 (22 min)',
    );
  });

  test('category labels are stable', () => {
    assert.equal(categoryLabel('housekeeping'), 'Housekeeping');
    assert.equal(categoryLabel('maintenance'), 'Maintenance');
    assert.equal(categoryLabel('staff'), 'Staff');
    assert.equal(categoryLabel('system'), 'System');
  });

  test('source labels exist for every known source', () => {
    for (const source of [
      'housekeeper_app', 'manager_dashboard', 'admin_dashboard', 'cron',
      'cua_worker', 'rules_engine', 'pms_sync', 'system', 'sms', 'voice',
    ] as const) {
      assert.ok(sourceLabel(source).length > 0);
    }
  });
});
