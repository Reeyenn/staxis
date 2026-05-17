/**
 * Tests for src/lib/event-recorder.ts.
 *
 * Two surfaces under test:
 *   1. Inserts must never throw, even when supabase errors or the
 *      insert throws synchronously. This is the load-bearing guarantee
 *      callers depend on (replaces the pre-2026 `try {} catch {}`
 *      patterns).
 *   2. Sustained failures (≥3 in 60s for the same table) escalate to
 *      Sentry once per window. A Supabase outage must not flood
 *      Sentry with thousands of events.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  recordErrorLog,
  recordWebhookLog,
  recordAppEvent,
  trackFailureAndShouldEscalate,
  __resetEventRecorderFailureWindowsForTests,
} from '@/lib/event-recorder';
import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Mock supabaseAdmin.from(...).insert ────────────────────────────────────

interface FromCall {
  table: string;
  rows: unknown;
}

let fromCalls: FromCall[] = [];
let nextInsertResult: { error: { message: string } | null } | 'throw' = { error: null };
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

function installSupabaseStub(): void {
  (supabaseAdmin as { from: unknown }).from = (table: string) => {
    return {
      insert: async (rows: unknown) => {
        fromCalls.push({ table, rows });
        if (nextInsertResult === 'throw') {
          throw new Error('supabase exploded');
        }
        return nextInsertResult;
      },
    };
  };
}

function restoreSupabase(): void {
  (supabaseAdmin as { from: unknown }).from = originalFrom;
}

// ─── Mock console.error ─────────────────────────────────────────────────────
//
// We can't monkey-patch sentry's captureException because the module
// export is an ESM getter. Instead we test the rate-limit decision
// directly via `trackFailureAndShouldEscalate` — the integration test
// just confirms the helpers don't throw.

const originalConsoleError = console.error;
let consoleErrorCalls: Array<{ msg: string; ctx: unknown }> = [];

function installLoggerStubs(): void {
  console.error = ((msg: string, ctx?: unknown) => {
    consoleErrorCalls.push({ msg, ctx });
  }) as typeof console.error;
}

function restoreLoggerStubs(): void {
  console.error = originalConsoleError;
}

beforeEach(() => {
  fromCalls = [];
  consoleErrorCalls = [];
  nextInsertResult = { error: null };
  __resetEventRecorderFailureWindowsForTests();
  installSupabaseStub();
  installLoggerStubs();
});

afterEach(() => {
  restoreSupabase();
  restoreLoggerStubs();
});

// ─── recordErrorLog ──────────────────────────────────────────────────────────

describe('recordErrorLog', () => {
  test('inserts into error_logs with source/message/stack', async () => {
    await recordErrorLog({ source: '/api/foo', message: 'boom', stack: 'at foo:1' });
    assert.equal(fromCalls.length, 1);
    assert.equal(fromCalls[0].table, 'error_logs');
    const row = (fromCalls[0].rows as { source: string; message: string; stack: string });
    assert.equal(row.source, '/api/foo');
    assert.equal(row.message, 'boom');
    assert.equal(row.stack, 'at foo:1');
  });

  test('does not throw when supabase returns an error', async () => {
    nextInsertResult = { error: { message: 'connection refused' } };
    await assert.doesNotReject(
      recordErrorLog({ source: '/api/foo', message: 'boom' }),
    );
  });

  test('logs a structured event_insert_failed line on supabase error', async () => {
    nextInsertResult = { error: { message: 'connection refused' } };
    await recordErrorLog({ source: '/api/foo', message: 'boom' });
    assert.equal(consoleErrorCalls.length, 1);
    assert.equal(consoleErrorCalls[0].msg, 'event_insert_failed');
  });

  test('does not throw when the insert itself throws', async () => {
    nextInsertResult = 'throw';
    await assert.doesNotReject(
      recordErrorLog({ source: '/api/foo', message: 'boom' }),
    );
  });
});

// ─── recordWebhookLog ────────────────────────────────────────────────────────

describe('recordWebhookLog', () => {
  test('inserts into webhook_log', async () => {
    await recordWebhookLog({ source: 'twilio', payload: { msg_sid: 'SM123' } });
    assert.equal(fromCalls[0].table, 'webhook_log');
  });

  test('does not throw on supabase error', async () => {
    nextInsertResult = { error: { message: 'unique violation' } };
    await assert.doesNotReject(
      recordWebhookLog({ source: 'twilio', payload: {} }),
    );
  });
});

// ─── recordAppEvent ──────────────────────────────────────────────────────────

describe('recordAppEvent', () => {
  test('inserts a single row', async () => {
    await recordAppEvent({
      property_id: 'p1',
      user_id: 'u1',
      user_role: 'staff',
      event_type: 'page_view',
      metadata: { path: '/' },
    });
    assert.equal(fromCalls.length, 1);
    assert.equal(fromCalls[0].table, 'app_events');
    assert.ok(Array.isArray(fromCalls[0].rows));
    assert.equal((fromCalls[0].rows as unknown[]).length, 1);
  });

  test('inserts an array of rows in a single batch', async () => {
    await recordAppEvent([
      { property_id: 'p1', user_id: null, user_role: 'system', event_type: 'a', metadata: {} },
      { property_id: 'p1', user_id: null, user_role: 'system', event_type: 'b', metadata: {} },
    ]);
    assert.equal(fromCalls.length, 1);
    assert.equal((fromCalls[0].rows as unknown[]).length, 2);
  });

  test('does nothing when called with an empty array', async () => {
    await recordAppEvent([]);
    assert.equal(fromCalls.length, 0);
  });

  test('does not throw on supabase error', async () => {
    nextInsertResult = { error: { message: 'boom' } };
    await assert.doesNotReject(
      recordAppEvent({
        property_id: 'p1',
        user_id: null,
        user_role: 'system',
        event_type: 'x',
        metadata: {},
      }),
    );
  });
});

// ─── Failure-window escalation rate limit ──────────────────────────────────

describe('trackFailureAndShouldEscalate', () => {
  test('first failure does not escalate', () => {
    assert.equal(trackFailureAndShouldEscalate('error_logs'), false);
  });

  test('third failure in the window escalates', () => {
    assert.equal(trackFailureAndShouldEscalate('error_logs'), false);
    assert.equal(trackFailureAndShouldEscalate('error_logs'), false);
    assert.equal(trackFailureAndShouldEscalate('error_logs'), true);
  });

  test('subsequent failures in same window do NOT escalate again', () => {
    trackFailureAndShouldEscalate('error_logs');
    trackFailureAndShouldEscalate('error_logs');
    assert.equal(trackFailureAndShouldEscalate('error_logs'), true);
    assert.equal(trackFailureAndShouldEscalate('error_logs'), false);
    assert.equal(trackFailureAndShouldEscalate('error_logs'), false);
  });

  test('different tables count separately', () => {
    trackFailureAndShouldEscalate('error_logs');
    trackFailureAndShouldEscalate('error_logs');
    assert.equal(trackFailureAndShouldEscalate('error_logs'), true);
    // webhook_log has its own counter
    assert.equal(trackFailureAndShouldEscalate('webhook_log'), false);
    assert.equal(trackFailureAndShouldEscalate('webhook_log'), false);
    assert.equal(trackFailureAndShouldEscalate('webhook_log'), true);
  });
});
