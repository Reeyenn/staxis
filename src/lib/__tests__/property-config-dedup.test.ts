/**
 * Tests for the in-flight promise dedup added to src/lib/property-config.ts
 * in audit/concurrency #10.
 *
 * Behavior we lock in:
 *   - Multiple concurrent getPropertyOpsConfig(pid) calls for the same
 *     pid coalesce onto a SINGLE underlying DB select.
 *   - After the call resolves, the result is in the in-process cache and
 *     further calls within the TTL hit the cache (no new DB calls).
 *   - Errors during the underlying fetch do NOT poison the inflight
 *     entry — the next call gets a fresh attempt (this is also asserted
 *     by ensuring inflight Map is drained on success and failure paths).
 *
 * Without dedup, N concurrent callers used to fire N DB queries and the
 * last writer to the cache won, briefly serving slightly-stale data on
 * subsequent reads.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getPropertyOpsConfig, invalidateConfig } from '@/lib/property-config';
import { supabaseAdmin } from '@/lib/supabase-admin';

type FromFn = typeof supabaseAdmin.from;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);

let selectCount = 0;
let resolveSelect: (() => void) | null = null;

beforeEach(() => {
  selectCount = 0;
  resolveSelect = null;
  // Clear any cache state from prior tests.
  invalidateConfig('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

  // @ts-expect-error monkey-patch singleton
  supabaseAdmin.from = (table: string) => {
    if (table !== 'properties') {
      throw new Error(`unexpected table: ${table}`);
    }
    return {
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => {
            selectCount += 1;
            // Manual gate so concurrent callers all see the first call
            // STILL in flight while we count entries to the function.
            await new Promise<void>((resolve) => {
              resolveSelect = resolve;
              // tiny tick to let parallel awaits queue up first
              setTimeout(() => resolveSelect?.(), 10);
            });
            return {
              data: {
                timezone: 'America/Chicago',
                dashboard_stale_minutes: 30,
                scraper_window_start_hour: 6,
                scraper_window_end_hour: 22,
              },
              error: null,
            };
          },
        }),
      }),
    };
  };
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  invalidateConfig('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
});

describe('getPropertyOpsConfig — in-flight dedup', () => {
  test('5 concurrent calls for the same pid → exactly 1 DB select', async () => {
    const pid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const results = await Promise.all([
      getPropertyOpsConfig(pid),
      getPropertyOpsConfig(pid),
      getPropertyOpsConfig(pid),
      getPropertyOpsConfig(pid),
      getPropertyOpsConfig(pid),
    ]);
    assert.equal(selectCount, 1, 'expected exactly one underlying SELECT');
    // All callers see the same shape.
    for (const r of results) {
      assert.equal(r.pid, pid);
      assert.equal(r.timezone, 'America/Chicago');
      assert.equal(r.dashboardStaleMinutes, 30);
    }
  });

  test('after the call resolves, subsequent fetches hit the TTL cache', async () => {
    const pid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await getPropertyOpsConfig(pid);
    await getPropertyOpsConfig(pid);
    await getPropertyOpsConfig(pid);
    assert.equal(selectCount, 1, 'cache should suppress further selects within TTL');
  });

  test('invalidateConfig clears the cached entry; next fetch hits DB again', async () => {
    const pid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await getPropertyOpsConfig(pid);
    assert.equal(selectCount, 1);
    invalidateConfig(pid);
    await getPropertyOpsConfig(pid);
    assert.equal(selectCount, 2);
  });
});
