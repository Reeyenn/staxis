/**
 * Regression tests for the cron-heartbeat status field (Phase 3.4).
 *
 * The heartbeat writer must thread an optional `status: 'ok' | 'degraded'`
 * through to the row's `notes._status` field so the doctor can surface
 * "cron is running but a stage was skipped" as a yellow banner without
 * paging.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeCronHeartbeat } from '../cron-heartbeat';

interface CapturedUpsert {
  cron_name: string;
  last_request_id: string | null;
  notes: Record<string, unknown>;
}

// Inject a mock supabase client via the same module path the writer uses.
// We do this by patching the module before each call. Since the writer
// imports supabaseAdmin at the top level, we monkey-patch through the
// module cache.
async function captureUpsert(extras: Parameters<typeof writeCronHeartbeat>[1]): Promise<CapturedUpsert> {
  let captured: CapturedUpsert | null = null;
  // Replace the module export. require() the module so we can mutate its
  // exports object. Node's CommonJS interop with TS via tsx makes this work.
  const supabaseAdminMod = await import('../supabase-admin');
  const original = supabaseAdminMod.supabaseAdmin;
  (supabaseAdminMod as { supabaseAdmin: unknown }).supabaseAdmin = {
    from: (_table: string) => ({
      upsert: (row: CapturedUpsert) => {
        captured = row;
        return Promise.resolve({ error: null });
      },
    }),
  };
  try {
    await writeCronHeartbeat('test-cron', extras);
  } finally {
    (supabaseAdminMod as { supabaseAdmin: unknown }).supabaseAdmin = original;
  }
  if (!captured) throw new Error('upsert was never called');
  return captured;
}

describe('writeCronHeartbeat (Phase 3.4)', () => {
  it('defaults notes._status to "ok" when no status is passed', async () => {
    const row = await captureUpsert({ requestId: 'req-1' });
    assert.equal(row.notes._status, 'ok');
  });

  it('writes notes._status === "degraded" when status: "degraded"', async () => {
    const row = await captureUpsert({ requestId: 'req-2', status: 'degraded' });
    assert.equal(row.notes._status, 'degraded');
  });

  it('preserves caller-provided notes alongside _status', async () => {
    const row = await captureUpsert({
      requestId: 'req-3',
      status: 'degraded',
      notes: { properties_skipped: 5 },
    });
    assert.equal(row.notes._status, 'degraded');
    assert.equal(row.notes.properties_skipped, 5);
  });

  it('passes requestId through to last_request_id', async () => {
    const row = await captureUpsert({ requestId: 'req-4', status: 'ok' });
    assert.equal(row.last_request_id, 'req-4');
  });
});
