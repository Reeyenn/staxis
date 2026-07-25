/**
 * get_pms_status — the tool a manager reaches for when they ask
 * "is the PMS connected?".
 *
 * IT WAS BROKEN ON EVERY CALL. The handler selected `last_poll_at` from
 * property_sessions; that column has never existed (0201 defines
 * last_alive_at / last_successful_read_at only). PostgREST answered 42703,
 * the handler took its error branch, and every manager got
 * "Failed to read PMS status." No test covered it, so nothing noticed.
 *
 * This file is the test that WOULD have caught it: it exercises the handler
 * against a stubbed database and asserts a non-error result. The stub answers
 * only the relation the handler actually asks for, so a handler that reaches
 * for the wrong table or a column the view does not expose fails here rather
 * than in front of a customer.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getTool, type ToolContext, type ToolResult } from '@/lib/agent/tools';
import { scopedDb } from '@/lib/agent/scoped-db';
import { supabaseAdmin } from '@/lib/supabase-admin';
import '@/lib/agent/tools/management';

const ACCOUNT = '00000000-0000-0000-0000-0000000000e0';

let nextProperty = 0;
function newPropertyId(): string {
  nextProperty += 1;
  return `00000000-0000-0000-0000-${String(nextProperty).padStart(12, 'e')}`;
}

function ctxFor(propertyId: string): ToolContext & { db: ReturnType<typeof scopedDb> } {
  return {
    user: {
      uid: ACCOUNT,
      accountId: ACCOUNT,
      username: 'gm',
      displayName: 'GM',
      role: 'general_manager',
      propertyAccess: [propertyId],
    },
    propertyId,
    staffId: null,
    requestId: 'req-pms-status',
    surface: 'chat',
    db: scopedDb(propertyId),
  };
}

/** Rows the stub will serve, keyed by relation name. Anything not listed
 *  answers as "relation not known to this stub" so a handler that reaches for
 *  the wrong table is a visible failure, not a silent empty result. */
let tables: Record<string, Array<Record<string, unknown>>> = {};
let asked: string[] = [];

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

beforeEach(() => {
  tables = {};
  asked = [];
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => {
    asked.push(table);
    const known = Object.prototype.hasOwnProperty.call(tables, table);
    const rows = tables[table] ?? [];
    const result = known
      ? { data: rows, error: null }
      : { data: null, error: { code: '42P01', message: `relation "${table}" does not exist` } };
    const api: Record<string, unknown> = {
      select: () => api,
      eq: () => api,
      is: () => api,
      in: () => api,
      order: () => api,
      limit: () => api,
      maybeSingle: async () => ({ data: known ? (rows[0] ?? null) : null, error: known ? null : result.error }),
      single: async () => ({ data: known ? (rows[0] ?? null) : null, error: known ? null : result.error }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return api;
  };
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

async function run(propertyId: string): Promise<ToolResult> {
  const tool = getTool('get_pms_status');
  assert.ok(tool, 'get_pms_status must stay registered — prompts and evals reference it by name');
  return tool.handler({}, ctxFor(propertyId));
}

function healthRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    property_id: 'ignored-by-the-stub',
    feed_key: 'roomStatus',
    label: 'Room status',
    required: true,
    target_table: 'pms_room_status_log',
    report_type: 'Housekeeping Status',
    enabled: true,
    cadence_kind: 'interval',
    expected_every_minutes: 30,
    grace_minutes: 20,
    alert_channel: 'doctor_warn',
    last_report_at: '2026-07-24T11:40:00.000Z',
    last_delivery_at: '2026-07-24T11:40:00.000Z',
    last_signal_at: '2026-07-24T11:40:00.000Z',
    minutes_late: 0,
    open_quarantine_count: 0,
    open_unmapped_count: 0,
    state: 'live',
    ...over,
  };
}

describe('get_pms_status', () => {
  it('does NOT error when the hotel has report health — the regression that shipped broken', async () => {
    const pid = newPropertyId();
    tables['pms_feed_health_v1'] = [healthRow()];
    const result = await run(pid);
    assert.equal(result.ok, true, `expected a real answer, got: ${JSON.stringify(result)}`);
  });

  it('reads the feed-health view, not the retired robot session table', async () => {
    const pid = newPropertyId();
    tables['pms_feed_health_v1'] = [healthRow()];
    await run(pid);
    assert.ok(asked.includes('pms_feed_health_v1'));
    assert.ok(
      !asked.includes('property_sessions'),
      'property_sessions describes a robot that no longer runs — and the column the old handler read never existed',
    );
  });

  it('reports each feed with its state and when it last arrived', async () => {
    const pid = newPropertyId();
    tables['pms_feed_health_v1'] = [
      healthRow(),
      healthRow({ feed_key: 'workOrders', label: 'Work orders', state: 'stale', minutes_late: 128.4 }),
    ];
    const result = await run(pid);
    assert.equal(result.ok, true);
    const data = result.data as { configured: boolean; feeds: Array<Record<string, unknown>>; summary: string; asOf: string | null };
    assert.equal(data.configured, true);
    assert.equal(data.feeds.length, 2);
    const wo = data.feeds.find((f) => f.feedKey === 'workOrders')!;
    assert.equal(wo.state, 'stale');
    assert.equal(wo.minutesLate, 128);
    assert.equal(data.asOf, '2026-07-24T11:40:00.000Z');
  });

  it('says "on time" in plain English when everything is arriving', async () => {
    const pid = newPropertyId();
    tables['pms_feed_health_v1'] = [healthRow(), healthRow({ feed_key: 'arrivals', label: 'Arrivals' })];
    const result = await run(pid);
    const data = result.data as { summary: string };
    assert.match(data.summary, /arriving on time/i);
  });

  it('names the late report rather than saying "connected"', async () => {
    const pid = newPropertyId();
    tables['pms_feed_health_v1'] = [
      healthRow({ feed_key: 'workOrders', label: 'Work orders', state: 'stale', minutes_late: 240 }),
    ];
    const result = await run(pid);
    const data = result.data as { summary: string };
    assert.match(data.summary, /Work orders/);
    assert.match(data.summary, /240 min past due/);
  });

  it('a manual hotel gets a clear answer, never an error', async () => {
    const pid = newPropertyId();
    tables['pms_feed_health_v1'] = [];
    const result = await run(pid);
    assert.equal(result.ok, true);
    const data = result.data as { configured: boolean; summary: string };
    assert.equal(data.configured, false);
    assert.match(data.summary, /no PMS report schedule/i);
  });

  it('surfaces a genuine read failure instead of pretending everything is fine', async () => {
    const pid = newPropertyId();
    // No entry for pms_feed_health_v1 at all → the stub answers 42P01.
    const result = await run(pid);
    assert.equal(result.ok, false);
  });

  it('still declares itself a data-age-stamped tool', async () => {
    // The freshness fields ARE the answer to this tool's question; dropping
    // the flag would silently strip asOf / dataAgeMinutes from the payload.
    assert.equal(getTool('get_pms_status')?.pmsFreshness, 'stamped');
  });
});
