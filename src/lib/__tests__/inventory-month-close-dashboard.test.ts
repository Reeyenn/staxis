import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getInventoryMonthCloseDashboard } from '../db/inventory-month-closes';

function clientWithPropertyTimezone(timezone: unknown): SupabaseClient {
  return {
    from(table: string) {
      assert.equal(table, 'properties', 'timezone validation must fail before finance dependencies load');
      const query = {
        select(columns: string) {
          assert.equal(columns, 'timezone');
          return query;
        },
        eq(column: string, value: string) {
          assert.equal(column, 'id');
          assert.equal(value, 'property-1');
          return query;
        },
        async maybeSingle() {
          return { data: { timezone }, error: null };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

describe('inventory month-close dashboard timezone gate', () => {
  for (const [label, timezone] of [
    ['null', null],
    ['blank', '   '],
    ['invalid', 'Hotel/Local'],
  ] as const) {
    test(`rejects a ${label} stored timezone before loading financial evidence`, async () => {
      await assert.rejects(
        () => getInventoryMonthCloseDashboard(
          clientWithPropertyTimezone(timezone),
          'property-1',
          '2026-07',
        ),
        /timezone is missing or invalid/i,
      );
    });
  }
});
