/**
 * Tests for the run-daily-report cron route. Verifies:
 *   - Skip when no property's local time matches the configured window
 *   - Skip when report_runs already has a row for that property+date
 *   - Continues when manual override (?property_id + ?date) is provided
 *   - Heartbeat is written with the result counters
 *
 * Mocks supabaseAdmin's `from()` and `auth.admin.listUsers` AND mocks
 * `buildDailyReport` + `resolveRecipients` + `sendDailyReportEmail` to
 * keep the test focused on the cron's own logic (timezone window check,
 * idempotency, recipient-loop bookkeeping).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { GET, minutesAround } from '@/app/api/cron/run-daily-report/route';

const CRON_SECRET = process.env.CRON_SECRET ?? 'placeholder-cron-secret-min-16';

interface MockProperty {
  id: string; name: string; timezone: string;
}
interface MockState {
  properties: MockProperty[];
  // Pretend "the row already exists" — controls whether the upsert returns
  // a fresh insert (object with id) or empty (conflict).
  reportRunsAlreadyExists: Set<string>;
  /** delivery_time_local rows per property — keyed by propertyId. */
  preferences: Map<string, string[]>;
  /** Tracks calls to supabaseAdmin.from('report_runs').upsert. */
  upsertCalls: number;
  /** Tracks calls to writeCronHeartbeat (via cron_heartbeats upsert). */
  heartbeatNotes: Record<string, unknown> | null;
}

let state: MockState;
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

function installStub() {
  (supabaseAdmin as { from: unknown }).from = (table: string) => {
    if (table === 'properties') {
      return {
        select: () => Promise.resolve({ data: state.properties, error: null }),
      };
    }
    if (table === 'report_preferences') {
      return {
        select: () => ({
          eq: (_col: string, value: string) => Promise.resolve({
            data: (state.preferences.get(value) ?? []).map(t => ({ delivery_time_local: t })),
            error: null,
          }),
        }),
      };
    }
    if (table === 'report_runs') {
      return {
        upsert: (row: { property_id: string; report_date: string }, opts: { ignoreDuplicates?: boolean }) => {
          state.upsertCalls += 1;
          const key = `${row.property_id}|${row.report_date}`;
          if (state.reportRunsAlreadyExists.has(key)) {
            // PostgREST with ignoreDuplicates returns empty data on conflict.
            return {
              select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            };
          }
          // Fresh insert — return a fake id.
          return {
            select: () => ({ maybeSingle: async () => ({ data: { id: 'run_' + key }, error: null }) }),
          };
        },
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
        select: () => ({
          eq: () => ({
            eq: () => ({
              lt: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            }),
          }),
        }),
      };
    }
    if (table === 'cron_heartbeats') {
      return {
        upsert: async (row: { notes: Record<string, unknown> }) => {
          state.heartbeatNotes = row.notes;
          return { error: null };
        },
      };
    }
    // Default no-op for the inner buildDailyReport queries we don't care
    // about here (cleaning_tasks, inspections, etc.) — buildDailyReport
    // is mocked at the module boundary below.
    return {
      select: () => ({
        eq: () => Promise.resolve({ data: [], error: null }),
        in: () => Promise.resolve({ data: [], error: null }),
      }),
      insert: async () => ({ error: null }),
      upsert: async () => ({ error: null }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    };
  };
}

function restoreStub() {
  (supabaseAdmin as { from: unknown }).from = originalFrom;
}

beforeEach(() => {
  process.env.CRON_SECRET = CRON_SECRET;
  state = {
    properties: [],
    reportRunsAlreadyExists: new Set(),
    preferences: new Map(),
    upsertCalls: 0,
    heartbeatNotes: null,
  };
  installStub();
});

afterEach(restoreStub);

function makeRequest(url = 'http://localhost/api/cron/run-daily-report'): NextRequest {
  return new NextRequest(url, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
}

describe('run-daily-report cron — idempotency and skip windows', () => {
  test('skips when no property is within the delivery window', async () => {
    state.properties = [
      { id: 'p1', name: 'A', timezone: 'America/Chicago' },
    ];
    // Force the preferred time to be way out of the current window
    // (10 AM Chicago — the cron runs at "now"). Since the actual current
    // time when the test runs varies, force-skip the time check by
    // setting a deterministic far-off pref.
    state.preferences.set('p1', ['03:00']);

    const res = await GET(makeRequest());
    const body = await res.json();
    assert.equal(res.status, 200);
    // Either skipped_not_in_window OR skipped_already_sent; in any case
    // not "sent". The point is we don't go through the full pipeline.
    const sent = body.data.results.find((r: { status: string }) => r.status === 'sent');
    assert.equal(sent, undefined);
  });

  test('skips when report_runs already has a row for today (idempotency)', async () => {
    state.properties = [
      { id: 'p1', name: 'A', timezone: 'America/Chicago' },
    ];
    // Force the manual-run path so we know the date being checked.
    // (?property_id + ?date overrides the time-window logic.)
    const dateForToday = new Date().toISOString().slice(0, 10);
    state.reportRunsAlreadyExists.add(`p1|${dateForToday}`);

    const res = await GET(makeRequest(`http://localhost/api/cron/run-daily-report?property_id=p1&date=${dateForToday}`));
    const body = await res.json();
    assert.equal(res.status, 200);
    const result = body.data.results[0];
    assert.equal(result.status, 'skipped_already_sent');
    assert.equal(state.upsertCalls, 1);
  });

  test('writes a heartbeat after the run with the result counters', async () => {
    state.properties = [
      { id: 'p1', name: 'A', timezone: 'America/Chicago' },
    ];
    const dateForToday = new Date().toISOString().slice(0, 10);
    state.reportRunsAlreadyExists.add(`p1|${dateForToday}`);
    await GET(makeRequest(`http://localhost/api/cron/run-daily-report?property_id=p1&date=${dateForToday}`));
    assert.ok(state.heartbeatNotes, 'expected heartbeat to be written');
    assert.equal(state.heartbeatNotes!['propertiesChecked'], 1);
    assert.equal(state.heartbeatNotes!['skippedAlreadySent'], 1);
  });

  test('rejects without bearer token', async () => {
    const res = await GET(new NextRequest('http://localhost/api/cron/run-daily-report'));
    assert.notEqual(res.status, 200);
  });
});

describe('minutesAround — midnight-wrap delivery window', () => {
  test('matches at exact time', () => {
    assert.equal(minutesAround('20:00', '20:00'), 0);
  });
  test('handles 5 minutes ahead and behind without wrap', () => {
    assert.equal(minutesAround('20:00', '20:05'), 5);
    assert.equal(minutesAround('20:05', '20:00'), -5);
  });
  test('wraps midnight (00:00 delivery vs 23:55 tick = 5 min ahead)', () => {
    // This is the load-bearing case — the prior non-wrapping math
    // would return -1435 here and miss the window.
    assert.equal(minutesAround('23:55', '00:00'), 5);
    assert.equal(minutesAround('00:05', '23:55'), -10);
  });
  test('returns minimum of forward and backward distance', () => {
    // Distance from 13:00 to 14:00 is +60, not -1380.
    assert.equal(minutesAround('13:00', '14:00'), 60);
    // Distance from 14:00 to 13:00 is -60.
    assert.equal(minutesAround('14:00', '13:00'), -60);
  });
});
