/**
 * Tests for src/lib/pms/draft-edit-ops.ts — the PURE payload builders that
 * produce the four draft-targeted ops the worker's 'mapper.edit_recipe' job
 * kind understands (fix/cua-draft-resign).
 *
 * These pin the EXACT worker contract byte-for-byte — a drift here (a renamed
 * key, a dropped field, an inferred scope) would make the worker silently
 * no-op the draft edit, leaving the seal-breaking bug un-fixed. The route does
 * the fast-fail validation; this module owns only the shape, so it is trivially
 * unit-testable without a DB.
 *
 * Contract (cua-service/src/ recipe-edit draft ops):
 *   draft_delete_feeds      { pms_family, draft_id, feed_keys: string[] }
 *   draft_delete_column     { pms_family, draft_id, feed_key, column_name }
 *   draft_add_custom_column { pms_family, draft_id, feed_key, column_key,
 *                             selector, scope ('row'|'page') }
 *   draft_set_column        { pms_family, draft_id, feed_key, column_name,
 *                             selector, is_custom: boolean }
 *
 * (pms_family + property_id are spread onto the payload by the ROUTE, not these
 * builders — the builders own the edit_op-specific fragment only.)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  draftDeleteColumnPayload,
  draftDeleteFeedsPayload,
  draftAddCustomColumnPayload,
  draftSetColumnPayload,
} from '@/lib/pms/draft-edit-ops';

const DRAFT = '11111111-1111-1111-1111-111111111111';

describe('draftDeleteColumnPayload', () => {
  test('produces the exact draft_delete_column op', () => {
    const p = draftDeleteColumnPayload({ draftId: DRAFT, feedKey: 'arrivals', columnName: 'rate_plan' });
    assert.deepEqual(p, {
      edit_op: 'draft_delete_column',
      draft_id: DRAFT,
      feed_key: 'arrivals',
      column_name: 'rate_plan',
    });
  });
});

describe('draftDeleteFeedsPayload', () => {
  test('produces the PLURAL feed_keys array (single-element for one click)', () => {
    const p = draftDeleteFeedsPayload({ draftId: DRAFT, feedKeys: ['work_orders'] });
    assert.deepEqual(p, {
      edit_op: 'draft_delete_feeds',
      draft_id: DRAFT,
      feed_keys: ['work_orders'],
    });
    // feed_keys must be an array (worker iterates it), even for one feed.
    assert.ok(Array.isArray(p.feed_keys));
    assert.equal(p.feed_keys.length, 1);
  });
});

describe('draftAddCustomColumnPayload', () => {
  test('per-row column → scope:"row" sent explicitly', () => {
    const p = draftAddCustomColumnPayload({
      draftId: DRAFT, feedKey: 'arrivals', columnKey: 'rate_plan',
      selector: 'td:nth-child(7)', scope: 'row',
    });
    assert.deepEqual(p, {
      edit_op: 'draft_add_custom_column',
      draft_id: DRAFT,
      feed_key: 'arrivals',
      column_key: 'rate_plan',
      selector: 'td:nth-child(7)',
      scope: 'row',
    });
  });

  test('page-scope value → scope:"page" carried through', () => {
    const p = draftAddCustomColumnPayload({
      draftId: DRAFT, feedKey: 'dashboard', columnKey: 'occupancy',
      selector: '#kpi:nth-of-type(2)', scope: 'page',
    });
    assert.equal(p.scope, 'page');
    assert.equal(p.selector, '#kpi:nth-of-type(2)');
  });
});

describe('draftSetColumnPayload', () => {
  test('built-in column → is_custom:false', () => {
    const p = draftSetColumnPayload({
      draftId: DRAFT, feedKey: 'arrivals', columnName: 'guest_name',
      selector: 'td:nth-child(3)', isCustom: false,
    });
    assert.deepEqual(p, {
      edit_op: 'draft_set_column',
      draft_id: DRAFT,
      feed_key: 'arrivals',
      column_name: 'guest_name',
      selector: 'td:nth-child(3)',
      is_custom: false,
    });
  });

  test('custom column → is_custom:true', () => {
    const p = draftSetColumnPayload({
      draftId: DRAFT, feedKey: 'arrivals', columnName: 'rate_plan',
      selector: 'td:nth-child(9)', isCustom: true,
    });
    assert.equal(p.is_custom, true);
  });
});

describe('every op carries draft_id and an edit_op tag', () => {
  test('all four ops target the draft by id and are edit_op-tagged', () => {
    const payloads = [
      draftDeleteFeedsPayload({ draftId: DRAFT, feedKeys: ['x'] }),
      draftDeleteColumnPayload({ draftId: DRAFT, feedKey: 'x', columnName: 'c' }),
      draftAddCustomColumnPayload({ draftId: DRAFT, feedKey: 'x', columnKey: 'c', selector: 's', scope: 'row' }),
      draftSetColumnPayload({ draftId: DRAFT, feedKey: 'x', columnName: 'c', selector: 's', isCustom: false }),
    ];
    for (const p of payloads) {
      assert.equal(p.draft_id, DRAFT);
      assert.match(p.edit_op, /^draft_/);
    }
  });
});
