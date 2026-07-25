/**
 * Operational nudges are computed on the DATA's clock, not the wall clock.
 *
 * THE BUG BEING FIXED: room states arrive in scheduled PMS reports. A room
 * that started 40 minutes before the report was captured has been in progress
 * for 40 observed minutes — but if that report lands an hour later, wall-clock
 * math calls it 100 minutes overdue and pushes a "Room 214 is stuck" alert at
 * a manager for a room that is very likely already finished. The first test
 * below is exactly that scenario, and it fails against the pre-A2 code.
 *
 * The 90-minute threshold has NOT changed. Only the reference frame has.
 *
 * Both clocks are injected as parameters, which is the enforcement: there is
 * no ambient Date.now() inside the draft builders for a later edit to reach
 * for.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  overdueRoomDrafts,
  unresolvedHelpDrafts,
  checkOperationalAlerts,
  OVERDUE_ROOM_MINUTES,
  type NudgeRoomInput,
} from '@/lib/agent/nudges';
import { supabaseAdmin } from '@/lib/supabase-admin';

const PID = '00000000-0000-0000-0000-0000000000a1';
const CAPTURED_AT = new Date('2026-07-24T19:40:00.000Z'); // 2:40 PM America/Chicago

/** `minutes` before the capture time. */
function startedBeforeCapture(minutes: number): Date {
  return new Date(CAPTURED_AT.getTime() - minutes * 60_000);
}

function room(over: Partial<NudgeRoomInput> = {}): NudgeRoomInput {
  return {
    id: '2026-07-24:214',
    number: '214',
    status: 'in_progress',
    startedAt: startedBeforeCapture(40),
    assignedName: 'Maria',
    ...over,
  };
}

describe('overdueRoomDrafts — the data clock', () => {
  it('does NOT flag a room that was 40 observed minutes in when the report was captured, even an hour later', () => {
    // Wall clock says 100 minutes since startedAt. Observed elapsed is 40.
    const now = new Date(CAPTURED_AT.getTime() + 60 * 60_000);
    const drafts = overdueRoomDrafts([room()], PID, CAPTURED_AT, now);
    assert.deepEqual(drafts, [], 'a late report must not manufacture an overdue room');
  });

  it('DOES flag a room that was genuinely 95 observed minutes in', () => {
    const now = new Date(CAPTURED_AT.getTime() + 60 * 60_000);
    const drafts = overdueRoomDrafts(
      [room({ startedAt: startedBeforeCapture(95) })],
      PID,
      CAPTURED_AT,
      now,
      '2:40 PM',
    );
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].severity, 'warning');
    assert.equal(drafts[0].payload.minutesElapsed, 95);
    assert.equal(drafts[0].payload.type, 'overdue_room');
    assert.equal(drafts[0].payload.roomNumber, '214');
    assert.equal(drafts[0].payload.asOf, CAPTURED_AT.toISOString());
    assert.equal(drafts[0].dedupeKey, `overdue_room:${PID}:2026-07-24:214`);
  });

  it('puts the as-of time in the manager-visible summary', () => {
    const drafts = overdueRoomDrafts(
      [room({ startedAt: startedBeforeCapture(95) })],
      PID,
      CAPTURED_AT,
      CAPTURED_AT,
      '2:40 PM',
    );
    assert.equal(
      drafts[0].payload.summary,
      'Room 214 had been in progress for 95 min as of 2:40 PM (Maria) — usually takes ~25 min, worth checking in.',
    );
  });

  it('holds the 90-minute threshold exactly where it was', () => {
    const under = overdueRoomDrafts(
      [room({ startedAt: startedBeforeCapture(OVERDUE_ROOM_MINUTES - 1) })],
      PID, CAPTURED_AT, CAPTURED_AT,
    );
    const at = overdueRoomDrafts(
      [room({ startedAt: startedBeforeCapture(OVERDUE_ROOM_MINUTES) })],
      PID, CAPTURED_AT, CAPTURED_AT,
    );
    assert.equal(under.length, 0);
    assert.equal(at.length, 1);
  });

  it('falls back to the wall clock for a hotel with no capture time', () => {
    // A manual hotel IS its own system of record — its room states really are
    // live, so `now` is the correct reference and behaviour is unchanged.
    const now = new Date(CAPTURED_AT.getTime() + 60 * 60_000);
    const drafts = overdueRoomDrafts([room()], PID, null, now);
    assert.equal(drafts.length, 1, '40 min before capture + 60 min of wall clock = 100 observed');
    assert.equal(drafts[0].payload.minutesElapsed, 100);
    // No capture time ⇒ no as-of claim in the payload or the summary.
    assert.equal(drafts[0].payload.asOf, undefined);
    assert.match(drafts[0].payload.summary as string, /has been in progress for 100 min \(Maria\)/);
  });

  it('ignores rooms that are not in progress or have no start time', () => {
    const rooms = [
      room({ id: 'a', status: 'dirty', startedAt: startedBeforeCapture(300) }),
      room({ id: 'b', status: 'clean', startedAt: startedBeforeCapture(300) }),
      room({ id: 'c', startedAt: null }),
      room({ id: 'd', startedAt: 'not-a-date' }),
    ];
    assert.deepEqual(overdueRoomDrafts(rooms, PID, CAPTURED_AT, CAPTURED_AT), []);
  });

  it('accepts an ISO string start time as well as a Date', () => {
    const drafts = overdueRoomDrafts(
      [room({ startedAt: startedBeforeCapture(95).toISOString() })],
      PID, CAPTURED_AT, CAPTURED_AT,
    );
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].payload.minutesElapsed, 95);
  });
});

describe('unresolvedHelpDrafts', () => {
  it('raises a request that appears in a report, with no 5-minute grace', () => {
    // The old wall-clock window was meaningless against a 30-60 min report
    // cadence: anything visible in a report is already older than the lag.
    const drafts = unresolvedHelpDrafts(
      [room({ helpRequested: true, startedAt: startedBeforeCapture(2) })],
      PID, CAPTURED_AT, CAPTURED_AT, '2:40 PM',
    );
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].severity, 'urgent');
    assert.equal(drafts[0].payload.minutesAgo, 2);
    assert.match(drafts[0].payload.summary as string, /Help requested for room 214 2 min ago \(as of 2:40 PM\)/);
    assert.equal(drafts[0].dedupeKey, `unresolved_help:${PID}:2026-07-24:214`);
  });

  it('still raises when no start time is available, without inventing one', () => {
    const drafts = unresolvedHelpDrafts(
      [room({ helpRequested: true, startedAt: null })],
      PID, CAPTURED_AT, CAPTURED_AT,
    );
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].payload.minutesAgo, null);
    assert.equal(/min ago/.test(drafts[0].payload.summary as string), false);
  });

  it('ignores rooms with no help request', () => {
    assert.deepEqual(unresolvedHelpDrafts([room()], PID, CAPTURED_AT, CAPTURED_AT), []);
  });
});

// ─── Run-level staleness guard ──────────────────────────────────────────────

type Rows = Record<string, Record<string, unknown> | null>;
let tables: Rows = {};
let touchedTables: string[] = [];
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

let nextProperty = 0;
function newPropertyId(): string {
  nextProperty += 1;
  return `00000000-0000-0000-0000-${String(nextProperty).padStart(12, 'b')}`;
}

beforeEach(() => {
  tables = {};
  touchedTables = [];
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => {
    touchedTables.push(table);
    const row = tables[table] ?? null;
    const api: Record<string, unknown> = {
      select: () => api, eq: () => api, is: () => api, in: () => api,
      gte: () => api, lte: () => api, order: () => api, limit: () => api,
      maybeSingle: async () => ({ data: row, error: null }),
      single: async () => ({ data: row, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: row ? [row] : [], error: null }).then(resolve),
    };
    return api;
  };
});
afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

/** A live-PMS hotel whose in-house snapshot was captured `minutesAgo` ago. */
function liveHotel(minutesAgo: number) {
  tables.properties = { timezone: 'America/Chicago' };
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
  };
}

describe('checkOperationalAlerts — staleness suppression', () => {
  it('produces nothing, and does not even look at room state, when the feed is 90 minutes stale', async () => {
    // A push notification computed from data older than one report cycle is
    // worse than no push: the room-level conclusion is a guess. The right
    // alert during an ingestion outage is "reports stopped arriving", which
    // the ingestion layer owns.
    liveHotel(90);
    const drafts = await checkOperationalAlerts(newPropertyId());
    assert.deepEqual(drafts, []);
    assert.equal(
      touchedTables.includes('pms_rooms_inventory'),
      false,
      'a stale feed must short-circuit before the room merge',
    );
  });

  it('produces nothing when the feed age is unknown', async () => {
    liveHotel(10);
    tables.pms_in_house_snapshot = null;
    (tables.property_sessions as Record<string, unknown>).last_successful_read_at = null;
    const drafts = await checkOperationalAlerts(newPropertyId());
    assert.deepEqual(drafts, []);
    assert.equal(touchedTables.includes('pms_rooms_inventory'), false);
  });

  it('runs the checks normally when the feed is fresh', async () => {
    liveHotel(10);
    const drafts = await checkOperationalAlerts(newPropertyId());
    // The stub has no inventory rows, so there is nothing to flag — the point
    // is that it got far enough to ASK, unlike the stale cases above.
    assert.deepEqual(drafts, []);
    assert.equal(touchedTables.includes('pms_rooms_inventory'), true);
  });

  it('runs the checks at a manual hotel (no PMS connection at all)', async () => {
    tables.properties = { timezone: 'America/Chicago' };
    const drafts = await checkOperationalAlerts(newPropertyId());
    assert.deepEqual(drafts, []);
    assert.equal(
      touchedTables.includes('pms_rooms_inventory'),
      true,
      'a manual hotel must never be suppressed — its data is genuinely live',
    );
  });
});
