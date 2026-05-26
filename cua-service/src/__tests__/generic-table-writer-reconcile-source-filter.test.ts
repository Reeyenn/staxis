/**
 * Tests for the reconcile-on-missing source-filter wiring in
 * cua-service/src/persistence/generic-table-writer.ts.
 *
 * Closes the regression that motivated migration 0225: voice-issue rows
 * (source='housekeeper_voice') in pms_work_orders_v2 must be invisible
 * to the CUA's full-snapshot auto-resolve pass. Without the filter, every
 * Staxis-originated ticket would be marked 'resolved' 30s after creation
 * on the next CUA sync because it has no PMS counterpart.
 *
 * Strategy: the RECONCILE_ON_MISSING constant is exported by the writer
 * specifically so this test can pin the configuration directly — a small
 * config-shape check is cheap, fast, and impossible to flake-fail vs. a
 * full chained-Supabase-mock that would have to simulate
 * .select().eq().neq().eq().then() correctly.
 *
 * The writer reads from this exact constant; a misconfiguration would be
 * observable both here and in production.
 */

// Pure-config test — does NOT import from generic-table-writer.js (which
// transitively constructs the Supabase client at module load and fails
// under Node 20 because @supabase/realtime-js needs a native WebSocket).
// Instead we import the config from its own isolated file.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RECONCILE_ON_MISSING } from '../persistence/reconcile-config.js';

describe('RECONCILE_ON_MISSING — pms_work_orders_v2 sourceFilter (migration 0225)', () => {
  test('pms_work_orders_v2 has sourceFilter scoped to source=pms_sync', () => {
    const config = RECONCILE_ON_MISSING['pms_work_orders_v2'];
    assert.ok(config, 'pms_work_orders_v2 must have a reconcile-on-missing config');
    assert.equal(config.column, 'status', 'auto-resolve writes to status column');
    assert.equal(config.value, 'resolved', 'auto-resolve target value is resolved');
    assert.ok(
      config.sourceFilter,
      'pms_work_orders_v2 MUST declare a sourceFilter — otherwise voice-issue rows ' +
        '(source=housekeeper_voice) get auto-resolved 30s after creation. ' +
        'See migration 0225 + the writer comments.',
    );
    assert.equal(config.sourceFilter?.column, 'source', 'sourceFilter targets the source column');
    assert.equal(config.sourceFilter?.value, 'pms_sync', 'only PMS-feed rows are reconciled');
  });

  test('pms_lost_and_found does NOT (currently) have a sourceFilter', () => {
    // The only other reconcile-mode table. It's currently single-source
    // (the CUA writes everything), so no filter is needed. If a future
    // feature adds a non-CUA writer to lost-and-found, this assertion is
    // the canary — fail it, update the config, audit the new write path.
    const config = RECONCILE_ON_MISSING['pms_lost_and_found'];
    assert.ok(config, 'pms_lost_and_found must have a reconcile-on-missing config');
    assert.equal(
      config.sourceFilter,
      undefined,
      'pms_lost_and_found has no non-CUA writers yet — if you added one, ' +
        'add a sourceFilter here too or it will get auto-resolved on every sync.',
    );
  });

  test('every reconcile table has a column + value (shape invariant)', () => {
    for (const [tableName, config] of Object.entries(RECONCILE_ON_MISSING)) {
      assert.ok(config.column, `${tableName}: column required`);
      assert.ok(config.value, `${tableName}: value required`);
      if (config.sourceFilter) {
        assert.ok(config.sourceFilter.column, `${tableName}: sourceFilter.column required`);
        assert.ok(config.sourceFilter.value, `${tableName}: sourceFilter.value required`);
      }
    }
  });
});
