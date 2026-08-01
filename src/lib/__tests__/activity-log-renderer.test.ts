/**
 * Activity log — what text actually reaches the manager.
 *
 * Two layers:
 *   1. Label + description rendering (categoryLabel / sourceLabel /
 *      renderDescription).
 *   2. The em-dash seam. `activity_log.description` and `.target_label`
 *      are PERSISTED sentences written by the 0228 trigger functions, so
 *      rows stored before migration 0415 still carry the dash the founder
 *      ruled out of user-facing copy on 2026-07-28. Every read path runs
 *      them through sanitizeActivityRowCopy; these tests hold that seam in
 *      place at the helper AND at the two query entry points that feed the
 *      timeline, the side panel, and the exports.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  categoryLabel,
  renderDescription,
  sourceLabel,
} from '../activity-log/renderer';
import { sanitizeActivityRowCopy } from '../activity-log/pure';
import { getActivityEvent, queryActivityLog } from '../activity-log/query';
import type { ActivityLogRow } from '../activity-log/types';

/** U+2014. Named because it is invisible in a diff otherwise. */
const EM_DASH = '—';

const PID = '00000000-0000-0000-0000-000000000010';

function makeRow(over: Partial<ActivityLogRow> = {}): ActivityLogRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    property_id: PID,
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

describe('sanitizeActivityRowCopy', () => {
  test('strips the em dash from a description written before 0415', () => {
    const cleaned = sanitizeActivityRowCopy(makeRow({
      description: `Room 305 failed inspection ${EM_DASH} 3 issues flagged`,
    }));
    assert.equal(cleaned.description.includes(EM_DASH), false);
    assert.ok(cleaned.description.includes('Room 305 failed inspection'));
    assert.ok(cleaned.description.includes('3 issues flagged'));
  });

  test('strips the em dash from target_label too', () => {
    const cleaned = sanitizeActivityRowCopy(makeRow({
      target_label: `Room 305 ${EM_DASH} stayover`,
    }));
    assert.equal(cleaned.target_label?.includes(EM_DASH), false);
    assert.ok(cleaned.target_label?.includes('Room 305'));
  });

  test('cleans both columns on the same row', () => {
    const cleaned = sanitizeActivityRowCopy(makeRow({
      description: `Maria called out (sick) ${EM_DASH} marked by manager`,
      target_label: `Room 305 ${EM_DASH} stayover`,
    }));
    assert.equal(`${cleaned.description}${cleaned.target_label}`.includes(EM_DASH), false);
  });

  test('leaves a clean row untouched, identity and all', () => {
    const row = makeRow();
    const cleaned = sanitizeActivityRowCopy(row);
    assert.equal(cleaned, row);
  });

  test('survives a null target_label and never invents one', () => {
    const cleaned = sanitizeActivityRowCopy(makeRow({ target_label: null }));
    assert.equal(cleaned.target_label, null);
  });

  test('carries every other field through unchanged', () => {
    const row = makeRow({ description: `A ${EM_DASH} B` });
    const cleaned = sanitizeActivityRowCopy(row);
    assert.equal(cleaned.id, row.id);
    assert.equal(cleaned.occurred_at, row.occurred_at);
    assert.equal(cleaned.actor_name, row.actor_name);
    assert.equal(cleaned.source, row.source);
    assert.deepEqual(cleaned.metadata, row.metadata);
  });

  test('renderDescription on a sanitized row shows no dash', () => {
    const dashed = makeRow({ description: `Work order created on Room 305 ${EM_DASH} plumbing` });
    assert.equal(renderDescription(sanitizeActivityRowCopy(dashed)).includes(EM_DASH), false);
  });
});

// ─── The seam must be WIRED, not merely available ───────────────────────────
//
// The plausible bug this catches: someone adds sanitizeActivityRowCopy,
// tests it in isolation, and forgets the `.map(...)` in queryActivityLog or
// the call in getActivityEvent. Both entry points are exercised for real
// against a stubbed supabaseAdmin (the idiom agent-activity.test.ts uses).

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

function installActivityLogStore(rows: ActivityLogRow[]) {
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => {
    if (table !== 'activity_log') throw new Error(`unexpected table ${table}`);
    const result = { data: rows, error: null, count: rows.length };
    const single = { data: rows[0] ?? null, error: null };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      gte: () => builder,
      lt: () => builder,
      in: () => builder,
      or: () => builder,
      order: () => builder,
      range: () => builder,
      maybeSingle: async () => single,
      // Awaiting the builder is how queryActivityLog finishes its chain.
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  };
}

describe('query path applies the em-dash seam', () => {
  afterEach(() => { supabaseAdmin.from = originalFrom; });

  test('queryActivityLog cleans every row it returns', async () => {
    installActivityLogStore([
      makeRow({ id: 'a', description: `Room 305 failed inspection ${EM_DASH} 3 issues flagged` }),
      makeRow({ id: 'b', target_label: `Room 401 ${EM_DASH} deep clean` }),
      makeRow({ id: 'c' }),
    ]);
    const out = await queryActivityLog({ propertyId: PID });
    assert.equal(out.rows.length, 3);
    for (const row of out.rows) {
      assert.equal(row.description.includes(EM_DASH), false, `row ${row.id} description`);
      assert.equal(row.target_label?.includes(EM_DASH) ?? false, false, `row ${row.id} target_label`);
    }
  });

  test('queryActivityLog still reports the real total and page size', async () => {
    installActivityLogStore([makeRow({ description: `A ${EM_DASH} B` })]);
    const out = await queryActivityLog({ propertyId: PID, pageSize: 25 });
    assert.equal(out.total, 1);
    assert.equal(out.page, 1);
    assert.equal(out.pageSize, 25);
  });

  test('getActivityEvent cleans the side-panel row', async () => {
    installActivityLogStore([makeRow({
      description: `Maria called out (sick) ${EM_DASH} marked by manager`,
      target_label: `Room 305 ${EM_DASH} stayover`,
    })]);
    const row = await getActivityEvent(PID, '00000000-0000-0000-0000-000000000001');
    assert.ok(row);
    assert.equal(row.description.includes(EM_DASH), false);
    assert.equal(row.target_label?.includes(EM_DASH), false);
  });

  test('getActivityEvent still returns null when there is no row', async () => {
    installActivityLogStore([]);
    assert.equal(await getActivityEvent(PID, '00000000-0000-0000-0000-000000000001'), null);
  });
});
