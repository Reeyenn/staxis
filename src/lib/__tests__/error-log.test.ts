/**
 * Tests for src/lib/error-log.ts.
 *
 * Run via: npx tsx --test src/lib/__tests__/error-log.test.ts
 *
 * The four API routes that used to hand-roll a try/catch around an
 * error_logs insert (May 2026 audit findings M2-M5) now call
 * writeErrorLog. The contract this file pins:
 *   - happy path: insert called once with the expected shape
 *   - secondary-write failure: function still resolves AND log.warn is
 *     called, so a Postgres outage doesn't disappear silently
 *   - stack defaults to null when caller omits it
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { writeErrorLog } from '@/lib/error-log';
import { supabaseAdmin } from '@/lib/supabase-admin';

type FromFn = typeof supabaseAdmin.from;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalWarn = console.warn;

let inserted: Record<string, unknown> | null = null;
let throwOnInsert = false;
let warnCalls: unknown[][] = [];

beforeEach(() => {
  inserted = null;
  throwOnInsert = false;
  warnCalls = [];
  console.warn = (...args: unknown[]) => { warnCalls.push(args); };
  // @ts-expect-error monkey-patching singleton for the test
  supabaseAdmin.from = (table: string) => {
    if (table !== 'error_logs') throw new Error(`unexpected table: ${table}`);
    return {
      insert: async (row: Record<string, unknown>) => {
        if (throwOnInsert) throw new Error('insert failed');
        inserted = row;
        return { data: null, error: null };
      },
    };
  };
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  console.warn = originalWarn;
});

describe('writeErrorLog', () => {
  test('happy path: inserts the expected row shape', async () => {
    await writeErrorLog({
      source: '/api/foo',
      message: 'boom',
      stack: 'Error: boom\n  at line 1',
    });

    assert.equal(inserted?.source, '/api/foo');
    assert.equal(inserted?.message, 'boom');
    assert.equal(inserted?.stack, 'Error: boom\n  at line 1');
  });

  test('stack defaults to null when caller omits it', async () => {
    await writeErrorLog({ source: '/api/bar', message: 'no stack here' });
    assert.equal(inserted?.stack, null);
  });

  test('explicit null stack stays null', async () => {
    await writeErrorLog({ source: '/api/bar', message: 'm', stack: null });
    assert.equal(inserted?.stack, null);
  });

  test('insert failure does NOT throw and warn-logs the source', async () => {
    throwOnInsert = true;

    // Must resolve, not reject. If this throws, the calling route would
    // return 500 from a secondary observability concern — defeating the
    // whole "best effort" point.
    await assert.doesNotReject(
      writeErrorLog({ source: '/api/baz', message: 'primary error' }),
    );

    // log.warn → console.warn under the hood. The single line is JSON.
    assert.equal(warnCalls.length, 1);
    const line = String(warnCalls[0][0]);
    assert.match(line, /\[error-log\] write failed/);
    assert.match(line, /"source":"\/api\/baz"/);
  });
});
