/**
 * A housekeeper must never be told "no rooms" because a query failed.
 *
 * mergePmsRoomsForStaff is what fills the page a cleaner opens from her text
 * message. It works out which of the property's rooms are hers in one of two
 * ways:
 *
 *   - assigned_staff_id — a real person a manager picked in Staxis, or
 *   - housekeeper_name  — the name the PMS housekeeping report printed, which
 *                         is resolved against the property's staff roster.
 *
 * At Comfort Suites the second path carries most of the day: the report names
 * the cleaner, nobody re-picks her by hand in Staxis. That match needs the
 * roster. If the roster read fails and we treat it as "no staff", every
 * name-matched room resolves to nobody and the function returns an empty
 * array — a successful-looking answer that means "your shift is empty".
 *
 * That is the shape of the bug CLAUDE.md says has blanked this page three
 * times: a failed read rendering as an empty screen. The two sibling reads in
 * the same function (assignments, room_work) already throw for exactly this
 * reason; the roster was the one still failing quietly.
 *
 * These tests drive the real function against a fake Supabase and assert on
 * what it returns.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { mergePmsRoomsForStaff } from '@/lib/pms-rooms-server';

const PID = '11111111-1111-1111-1111-111111111111';
const MARIA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** Today, in the same UTC form the merge's date window uses. */
const TODAY = new Date().toISOString().slice(0, 10);

type FromFn = typeof supabaseAdmin.from;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);

/** Flip to make the roster read (the one WITHOUT an id filter) fail. */
let rosterReadFails = false;

const ROSTER = [
  { id: MARIA, name: 'Maria Lopez' },
  { id: ANA, name: 'Ana Reyes' },
];

/**
 * One room on today's PMS housekeeping report, printed with Maria's name and
 * no explicit Staxis assignment — the ordinary case at a live hotel.
 */
const MIRROR_ROWS = [
  {
    date: TODAY,
    room_number: '204',
    housekeeper_name: 'Maria Lopez',
    cleaning_type: 'departure',
    dnd_active: null,
  },
];

beforeEach(() => {
  rosterReadFails = false;
  supabaseAdmin.from = ((table: string) => {
    const filter: Record<string, unknown> = {};
    const result = (): { data: unknown[] | null; error: unknown } => {
      if (table === 'staff') {
        // Two different reads hit this table. The identity read is filtered by
        // id; the roster read is filtered by property only.
        if (filter.id !== undefined) {
          const row = ROSTER.find((s) => s.id === filter.id);
          return { data: row ? [row] : [], error: null };
        }
        if (rosterReadFails) {
          return { data: null, error: { message: 'connection reset by peer' } };
        }
        return { data: ROSTER, error: null };
      }
      if (table === 'pms_housekeeping_assignments') return { data: MIRROR_ROWS, error: null };
      // room_work, pms_room_status_log, pms_reservations, staff_aliases
      return { data: [], error: null };
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => { filter[col] = val; return builder; },
      neq: () => builder, is: () => builder, not: () => builder,
      lt: () => builder, gt: () => builder,
      gte: () => builder, lte: () => builder, in: () => builder, or: () => builder,
      filter: () => builder, contains: () => builder, overlaps: () => builder,
      order: () => builder, limit: () => builder, range: () => builder,
      maybeSingle: async () => {
        const r = result();
        return { data: (r.data ?? [])[0] ?? null, error: r.error };
      },
      single: async () => {
        const r = result();
        return { data: (r.data ?? [])[0] ?? null, error: r.error };
      },
      then: (resolve: (v: unknown) => unknown) => resolve(result()),
    };
    return builder;
  }) as unknown as FromFn;
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

describe("the housekeeper page's room list is honest about failure", () => {
  test('a room the report assigned by name reaches the housekeeper it names', async () => {
    // Baseline: this is why the roster read matters at all.
    const rooms = await mergePmsRoomsForStaff(PID, MARIA);
    assert.equal(rooms.length, 1, 'Maria should see the room the report printed her name on');
    assert.equal(rooms[0].number, '204');
  });

  test('that room does NOT show up on another housekeeper', async () => {
    const rooms = await mergePmsRoomsForStaff(PID, ANA);
    assert.deepEqual(rooms, [], "Ana must not inherit Maria's room");
  });

  test('a failed roster read raises an error instead of returning an empty shift', async () => {
    rosterReadFails = true;
    await assert.rejects(
      () => mergePmsRoomsForStaff(PID, MARIA),
      'a roster read failure must surface as an error. Returning [] tells a cleaner '
      + 'she has nothing to clean, and nobody can tell that apart from a real empty shift.',
    );
  });
});
