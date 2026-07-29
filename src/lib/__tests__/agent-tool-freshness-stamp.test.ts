/**
 * executeTool stamps the data age onto PMS-backed tool results.
 *
 * The stamp happens ONCE in the dispatcher rather than in each tool handler,
 * so a new PMS tool cannot forget it — it can only forget the `pmsFreshness`
 * flag, which the completeness test catches. This file pins the dispatcher
 * half: who gets stamped, who doesn't, and what happens at a hotel with no
 * PMS at all (the case that must stay silent).
 *
 * The feed-status lookup underneath is exercised for real against a stubbed
 * database, so the resolution chain (in-house snapshot → session read → room
 * status sync) is covered here too rather than mocked away.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { executeTool, registerTool, type ToolContext } from '@/lib/agent/tools';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { installAgentToolAuthorityTestStore } from './helpers/agent-tool-authority';

const ACCOUNT = '00000000-0000-0000-0000-0000000000d0';
let authorityPropertyId = '00000000-0000-0000-0000-000000000001';

/** Each test uses a fresh property id — getPropertyFeedStatus caches per
 *  property for 30s, so reusing one would serve a previous test's answer. */
let nextProperty = 0;
function newPropertyId(): string {
  nextProperty += 1;
  return `00000000-0000-0000-0000-${String(nextProperty).padStart(12, 'd')}`;
}

function ctxFor(propertyId: string): ToolContext {
  authorityPropertyId = propertyId;
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
    requestId: 'req-freshness',
    surface: 'chat',
  };
}

// ─── Database stub ──────────────────────────────────────────────────────────

type Rows = Record<string, Record<string, unknown> | null>;
let tables: Rows = {};

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
let restoreAuthority: (() => void) | null = null;

beforeEach(() => {
  tables = {};
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => {
    const row = tables[table] ?? null;
    const api: Record<string, unknown> = {
      select: () => api,
      eq: () => api,
      is: () => api,
      order: () => api,
      limit: () => api,
      maybeSingle: async () => ({ data: row, error: null }),
      single: async () => ({ data: row, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: row ? [row] : [], error: null }).then(resolve),
    };
    return api;
  };
  restoreAuthority = installAgentToolAuthorityTestStore(() => [{
    accountId: ACCOUNT,
    authUserId: ACCOUNT,
    role: 'general_manager',
    propertyIds: [authorityPropertyId],
  }]);
});
afterEach(() => {
  restoreAuthority?.();
  restoreAuthority = null;
  supabaseAdmin.from = originalFrom;
});

/** Make the stubbed hotel look like a live-PMS property whose in-house
 *  snapshot was captured `minutesAgo` minutes ago. */
function liveHotelCapturedMinutesAgo(minutesAgo: number) {
  tables.property_sessions = {
    pms_family: 'choice_advantage',
    status: 'running',
    last_successful_read_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  };
  tables.pms_knowledge_files = {
    knowledge: {
      actions: {
        getRoomStatus: {}, getArrivals: {}, getDepartures: {},
        getWorkOrders: {}, getDashboardCounts: {},
      },
    },
  };
  tables.pms_in_house_snapshot = {
    captured_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    arrivals_remaining_today: 3,
    departures_remaining_today: 2,
    total_occupied_rooms: 62,
  };
}

// ─── Fixture tools ──────────────────────────────────────────────────────────

registerTool<Record<string, never>>({
  name: '__test_stamped_tool',
  description: 'fixture',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['general_manager'],
  mutates: false,
  pmsFreshness: 'stamped',
  handler: async () => ({ ok: true, data: { occupied: 62 } }),
});

registerTool<Record<string, never>>({
  name: '__test_independent_tool',
  description: 'fixture',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['general_manager'],
  mutates: false,
  pmsFreshness: 'independent',
  handler: async () => ({ ok: true, data: { occupied: 62 } }),
});

registerTool<Record<string, never>>({
  name: '__test_unflagged_tool',
  description: 'fixture',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['general_manager'],
  mutates: false,
  handler: async () => ({ ok: true, data: { occupied: 62 } }),
});

registerTool<Record<string, never>>({
  name: '__test_own_asof_tool',
  description: 'fixture — returns its own per-row capture time',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['general_manager'],
  mutates: false,
  pmsFreshness: 'stamped',
  handler: async () => ({
    ok: true,
    data: { asOf: '2020-01-01T00:00:00.000Z', balanceCents: 1234 },
  }),
});

registerTool<Record<string, never>>({
  name: '__test_stamped_failing_tool',
  description: 'fixture',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['general_manager'],
  mutates: false,
  pmsFreshness: 'stamped',
  handler: async () => ({ ok: false, error: 'nope' }),
});

registerTool<Record<string, never>>({
  name: '__test_stamped_array_tool',
  description: 'fixture — non-object payload',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['general_manager'],
  mutates: false,
  pmsFreshness: 'stamped',
  handler: async () => ({ ok: true, data: [1, 2, 3] }),
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('executeTool data-age stamp', () => {
  it('stamps a flagged read-only tool at a live-PMS hotel', async () => {
    const pid = newPropertyId();
    liveHotelCapturedMinutesAgo(22);
    const res = await executeTool('__test_stamped_tool', {}, ctxFor(pid));
    const data = res.data as Record<string, unknown>;
    assert.equal(res.ok, true);
    assert.equal(data.occupied, 62, 'the handler payload survives');
    assert.equal(typeof data.asOf, 'string');
    assert.equal(data.asOfSource, 'snapshot_capture');
    assert.equal(data.dataAgeMinutes, 22);
    assert.equal(data.dataFreshness, 'fresh');
  });

  it('reports a stale feed as stale rather than hiding it', async () => {
    const pid = newPropertyId();
    liveHotelCapturedMinutesAgo(200);
    const res = await executeTool('__test_stamped_tool', {}, ctxFor(pid));
    const data = res.data as Record<string, unknown>;
    assert.equal(data.dataFreshness, 'stale');
    assert.equal(data.dataAgeMinutes, 200);
  });

  it('leaves an unflagged tool completely alone', async () => {
    const pid = newPropertyId();
    liveHotelCapturedMinutesAgo(22);
    const res = await executeTool('__test_unflagged_tool', {}, ctxFor(pid));
    const data = res.data as Record<string, unknown>;
    assert.deepEqual(Object.keys(data), ['occupied']);
  });

  it('leaves an explicitly independent tool alone', async () => {
    const pid = newPropertyId();
    liveHotelCapturedMinutesAgo(22);
    const res = await executeTool('__test_independent_tool', {}, ctxFor(pid));
    const data = res.data as Record<string, unknown>;
    assert.deepEqual(Object.keys(data), ['occupied']);
  });

  it('says NOTHING about data age at a manual hotel', async () => {
    // No property_sessions row ⇒ mode 'no_pms' ⇒ the app is the system of
    // record and its numbers really are live. A staleness field here would be
    // the false-warning bug in the opposite direction.
    const pid = newPropertyId();
    const res = await executeTool('__test_stamped_tool', {}, ctxFor(pid));
    const data = res.data as Record<string, unknown>;
    assert.deepEqual(Object.keys(data), ['occupied']);
  });

  it('says nothing at an onboarding hotel (session, no active knowledge file)', async () => {
    const pid = newPropertyId();
    tables.property_sessions = {
      pms_family: 'choice_advantage',
      status: 'paused_no_knowledge_file',
      last_successful_read_at: null,
    };
    const res = await executeTool('__test_stamped_tool', {}, ctxFor(pid));
    const data = res.data as Record<string, unknown>;
    assert.deepEqual(Object.keys(data), ['occupied']);
  });

  it('honors a capture time the handler resolved itself', async () => {
    // pms_guest_balances etc. stamp captured_at on every row — a truer age
    // than the property-level signal, so the handler's value wins.
    const pid = newPropertyId();
    liveHotelCapturedMinutesAgo(5);
    const res = await executeTool('__test_own_asof_tool', {}, ctxFor(pid));
    const data = res.data as Record<string, unknown>;
    assert.equal(data.asOf, '2020-01-01T00:00:00.000Z');
    assert.equal(data.asOfSource, 'feed_capture');
    assert.equal(data.dataFreshness, 'very_stale', 'age is computed from the handler value');
    assert.ok((data.dataAgeMinutes as number) > 60 * 24);
  });

  it('does not touch a failed result or a non-object payload', async () => {
    const pid = newPropertyId();
    liveHotelCapturedMinutesAgo(22);
    const failed = await executeTool('__test_stamped_failing_tool', {}, ctxFor(pid));
    assert.equal(failed.ok, false);
    assert.equal(failed.data, undefined);

    const arr = await executeTool('__test_stamped_array_tool', {}, ctxFor(pid));
    assert.deepEqual(arr.data, [1, 2, 3]);
  });

  it('falls back to the session read when no snapshot has been captured', async () => {
    const pid = newPropertyId();
    liveHotelCapturedMinutesAgo(30);
    tables.pms_in_house_snapshot = null; // feed present, snapshot row absent
    const res = await executeTool('__test_stamped_tool', {}, ctxFor(pid));
    const data = res.data as Record<string, unknown>;
    assert.equal(data.asOfSource, 'session_read');
    assert.equal(data.dataFreshness, 'fresh');
  });

  it('falls back to the room-status sync when nothing else has a time', async () => {
    const pid = newPropertyId();
    liveHotelCapturedMinutesAgo(30);
    tables.pms_in_house_snapshot = null;
    (tables.property_sessions as Record<string, unknown>).last_successful_read_at = null;
    tables.pms_room_status_log = {
      last_synced_at: new Date(Date.now() - 12 * 60_000).toISOString(),
    };
    const res = await executeTool('__test_stamped_tool', {}, ctxFor(pid));
    const data = res.data as Record<string, unknown>;
    assert.equal(data.asOfSource, 'room_status_sync');
    assert.equal(data.dataAgeMinutes, 12);
  });

  it('says the age is unknown when no signal exists at all', async () => {
    const pid = newPropertyId();
    liveHotelCapturedMinutesAgo(30);
    tables.pms_in_house_snapshot = null;
    (tables.property_sessions as Record<string, unknown>).last_successful_read_at = null;
    const res = await executeTool('__test_stamped_tool', {}, ctxFor(pid));
    const data = res.data as Record<string, unknown>;
    assert.equal(data.asOf, null);
    assert.equal(data.dataAgeMinutes, null);
    assert.equal(data.dataFreshness, 'unknown');
  });
});
