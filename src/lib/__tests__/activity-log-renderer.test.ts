/**
 * Activity log renderer — language fallback + per-event templates.
 *
 * Run via: npx tsx --test src/lib/__tests__/activity-log-renderer.test.ts
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
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

describe('renderDescription', () => {
  test('English path returns the pre-rendered description verbatim', () => {
    const row = makeRow();
    assert.equal(renderDescription(row, 'en'), 'Maria Lopez finished cleaning room 305 (22 min)');
  });

  test('Spanish translation for cleaning_completed', () => {
    const row = makeRow();
    const es = renderDescription(row, 'es');
    assert.match(es, /Maria Lopez/);
    assert.match(es, /habitación 305/);
    assert.match(es, /22 min/);
  });

  test('falls back to English description when no Spanish template exists', () => {
    const row = makeRow({ event_type: 'totally_unknown_event_type', description: 'A custom thing happened' });
    assert.equal(renderDescription(row, 'es'), 'A custom thing happened');
  });

  test('inspection_fail surfaces the issue count in Spanish', () => {
    const row = makeRow({
      event_type: 'inspection_fail',
      metadata: { room_number: '202', failed_items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      description: 'Room 202 failed inspection — 3 issues flagged',
    });
    const es = renderDescription(row, 'es');
    assert.match(es, /habitación 202/);
    assert.match(es, /3 problemas/);
  });

  test('singular issue (1) in Spanish drops the trailing s', () => {
    const row = makeRow({
      event_type: 'inspection_fail',
      metadata: { room_number: '101', failed_items: [{ id: 'a' }] },
      description: 'Room 101 failed inspection — 1 issue flagged',
    });
    const es = renderDescription(row, 'es');
    assert.match(es, /1 problema(?!s)/);
  });

  test('renders room_status_changed with the un-snake-cased status', () => {
    const row = makeRow({
      event_type: 'room_status_changed',
      metadata: { room_number: '410', status: 'vacant_clean' },
      description: 'Room 410 is now vacant clean',
    });
    const es = renderDescription(row, 'es');
    assert.match(es, /Habitación 410/);
    assert.match(es, /vacant clean/);
  });

  test('callout_reported with reason and actor', () => {
    const row = makeRow({
      event_type: 'callout_reported',
      actor_name: 'Ana',
      event_category: 'staff',
      metadata: { reason: 'sick' },
      description: 'Ana called out (sick)',
    });
    assert.match(renderDescription(row, 'es'), /Ana reportó ausencia \(sick\)/);
  });

  test('user_created in Spanish uses the role', () => {
    const row = makeRow({
      event_type: 'user_created',
      actor_name: 'New User',
      event_category: 'staff',
      metadata: { role: 'general_manager' },
      description: 'User New User was added with role general_manager',
    });
    assert.match(renderDescription(row, 'es'), /general_manager/);
  });

  test('falls back when metadata duration is missing/invalid', () => {
    const row = makeRow({ event_type: 'cleaning_completed', metadata: {} });
    const es = renderDescription(row, 'es');
    assert.match(es, /0 min/);
  });
});

describe('categoryLabel + sourceLabel', () => {
  test('English category labels are stable', () => {
    assert.equal(categoryLabel('housekeeping', 'en'), 'Housekeeping');
    assert.equal(categoryLabel('maintenance', 'en'), 'Maintenance');
    assert.equal(categoryLabel('staff', 'en'), 'Staff');
    assert.equal(categoryLabel('system', 'en'), 'System');
  });

  test('Spanish category labels are stable', () => {
    assert.equal(categoryLabel('housekeeping', 'es'), 'Limpieza');
    assert.equal(categoryLabel('maintenance', 'es'), 'Mantenimiento');
    assert.equal(categoryLabel('staff', 'es'), 'Personal');
  });

  test('source labels exist for every known source', () => {
    for (const src of [
      'housekeeper_app','manager_dashboard','admin_dashboard','cron',
      'cua_worker','rules_engine','pms_sync','system','sms','voice',
    ] as const) {
      assert.ok(sourceLabel(src, 'en').length > 0);
      assert.ok(sourceLabel(src, 'es').length > 0);
    }
  });
});
