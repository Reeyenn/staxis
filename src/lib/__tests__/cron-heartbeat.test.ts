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

// Inject a mock supabase client via writeCronHeartbeat's optional
// `client` parameter. (Earlier this test tried to monkey-patch the
// supabaseAdmin module export, but ESM module bindings are read-only
// at the consumer's side, so the assignment threw "Cannot set property
// supabaseAdmin of #<Object> which has only a getter".)
async function captureUpsert(extras: Parameters<typeof writeCronHeartbeat>[1]): Promise<CapturedUpsert> {
  let captured: CapturedUpsert | null = null;
  // Minimal SupabaseClient stub: the writer only ever calls .from().upsert(),
  // so we only implement those two methods. The cast through `unknown` keeps
  // TypeScript happy without pulling in 50+ unused query-builder methods.
  const mockClient = {
    from: (_table: string) => ({
      upsert: (row: CapturedUpsert) => {
        captured = row;
        return Promise.resolve({ error: null });
      },
    }),
  } as unknown as Parameters<typeof writeCronHeartbeat>[2];
  await writeCronHeartbeat('test-cron', extras, mockClient);
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
