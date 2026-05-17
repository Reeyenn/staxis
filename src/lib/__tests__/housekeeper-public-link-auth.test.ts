/**
 * Auth/capability tests for POST /api/housekeeper/room-action.
 *
 * The housekeeper page is publicly linkable by design — Mario texts a
 * URL like /housekeeper/{staffId}?pid={pid}&token={hashed} and the
 * housekeeper opens it on their phone with no Staxis login. The route
 * uses service-role to bypass RLS, so the capability model lives
 * entirely in the route handler's checks:
 *
 *   1. staff.property_id === pid               (cross-property block)
 *   2. room.property_id === pid                (cross-property block)
 *   3. room.assigned_to IS NULL OR === staffId (per-housekeeper scope)
 *
 * Staff UUIDs are listable via the public /api/staff-list endpoint, so
 * the (pid, staffId) pair alone isn't a strong capability — the
 * assigned_to scoping is what closes the staff-UUID enumeration gap.
 *
 * Audit Flow 3 #9: these tests pin the capability model so a future
 * refactor that relaxes ANY of the three checks lands as a red diff
 * BEFORE it ships. The audit explicitly called out "never relax the
 * assigned_to check without re-auditing the enumeration surface" — these
 * tests are that enforcement.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Test fixtures ───────────────────────────────────────────────────────

const PROPERTY_A = '11111111-1111-1111-1111-111111111111';
const PROPERTY_B = '22222222-2222-2222-2222-222222222222';
const STAFF_A_AT_PROPERTY_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STAFF_B_AT_PROPERTY_A = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const STAFF_C_AT_PROPERTY_B = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ROOM_ASSIGNED_TO_A = 'd0000000-0000-0000-0000-000000000001';
const ROOM_ASSIGNED_TO_B = 'd0000000-0000-0000-0000-000000000002';
const ROOM_UNASSIGNED = 'd0000000-0000-0000-0000-000000000003';
const ROOM_AT_PROPERTY_B = 'd0000000-0000-0000-0000-000000000004';

interface StaffFixture {
  id: string;
  property_id: string;
  name: string;
  is_active: boolean;
}
interface RoomFixture {
  id: string;
  property_id: string;
  type: 'vacant' | 'checkout' | 'stayover';
  number: string;
  date: string;
  assigned_to: string | null;
  started_at: string | null;
  completed_at: string | null;
}

const STAFF_BY_ID: Record<string, StaffFixture> = {
  [STAFF_A_AT_PROPERTY_A]: { id: STAFF_A_AT_PROPERTY_A, property_id: PROPERTY_A, name: 'Alice', is_active: true },
  [STAFF_B_AT_PROPERTY_A]: { id: STAFF_B_AT_PROPERTY_A, property_id: PROPERTY_A, name: 'Bob', is_active: true },
  [STAFF_C_AT_PROPERTY_B]: { id: STAFF_C_AT_PROPERTY_B, property_id: PROPERTY_B, name: 'Carol', is_active: true },
};

const ROOM_BY_ID: Record<string, RoomFixture> = {
  [ROOM_ASSIGNED_TO_A]: {
    id: ROOM_ASSIGNED_TO_A, property_id: PROPERTY_A, type: 'vacant',
    number: '101', date: '2026-05-17', assigned_to: STAFF_A_AT_PROPERTY_A,
    started_at: null, completed_at: null,
  },
  [ROOM_ASSIGNED_TO_B]: {
    id: ROOM_ASSIGNED_TO_B, property_id: PROPERTY_A, type: 'vacant',
    number: '102', date: '2026-05-17', assigned_to: STAFF_B_AT_PROPERTY_A,
    started_at: null, completed_at: null,
  },
  [ROOM_UNASSIGNED]: {
    id: ROOM_UNASSIGNED, property_id: PROPERTY_A, type: 'vacant',
    number: '103', date: '2026-05-17', assigned_to: null,
    started_at: null, completed_at: null,
  },
  [ROOM_AT_PROPERTY_B]: {
    id: ROOM_AT_PROPERTY_B, property_id: PROPERTY_B, type: 'vacant',
    number: '201', date: '2026-05-17', assigned_to: STAFF_C_AT_PROPERTY_B,
    started_at: null, completed_at: null,
  },
};

// ─── Mock infrastructure ─────────────────────────────────────────────────

type FromFn = typeof supabaseAdmin.from;
type RpcFn = typeof supabaseAdmin.rpc;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);

beforeEach(() => {
  // Service-role 'from' chains — we mock only the ones the route uses
  // (staff lookup, rooms lookup, rooms update, cleaning_events lookup).
  supabaseAdmin.from = ((table: string) => {
    let filter: Record<string, unknown> = {};
    const builder: any = {
      select: () => builder,
      eq: (col: string, val: unknown) => { filter[col] = val; return builder; },
      neq: () => builder,
      lt: () => builder,
      gte: () => builder,
      order: () => builder,
      limit: () => builder,
      in: () => builder,
      update: () => builder,
      upsert: () => builder,
      maybeSingle: async () => {
        if (table === 'staff') {
          const row = STAFF_BY_ID[filter.id as string];
          return { data: row ?? null, error: null };
        }
        if (table === 'rooms') {
          const row = ROOM_BY_ID[filter.id as string];
          return { data: row ?? null, error: null };
        }
        if (table === 'cleaning_events') {
          return { data: null, error: null };
        }
        return { data: null, error: null };
      },
      // `await supabaseAdmin.from(...).update(...).eq(...)` is a thenable.
      then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
    };
    return builder;
  }) as unknown as FromFn;

  // Rate-limit RPC — always allow.
  supabaseAdmin.rpc = (async (fn: string) => {
    if (fn === 'staxis_api_limit_hit') return { data: 1, error: null };
    return { data: null, error: null };
  }) as unknown as RpcFn;
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new Request('https://staxis.test/api/housekeeper/room-action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('POST /api/housekeeper/room-action — capability model', () => {

  test('staffA CANNOT mutate a room assigned to staffB → 403', async () => {
    const { POST } = await import('@/app/api/housekeeper/room-action/route');
    const res = await POST(makeRequest({
      pid: PROPERTY_A,
      staffId: STAFF_A_AT_PROPERTY_A,
      roomId: ROOM_ASSIGNED_TO_B,
      action: 'finish',
    }));
    assert.equal(res.status, 403,
      'staff-UUID enumeration vector: staffA must NOT be able to act on staffB\'s rooms even with a valid staffId+pid pair');
  });

  test('staffA CAN mutate an unassigned room (cascade-NULL recovery path) → 200', async () => {
    // 2026-05-12 audit decided that rooms with assigned_to=null can be
    // claimed by any active staff in the property (so a HK can pick up
    // work after another HK is deleted mid-shift). This test pins that
    // recovery path so it can't accidentally regress.
    const { POST } = await import('@/app/api/housekeeper/room-action/route');
    const res = await POST(makeRequest({
      pid: PROPERTY_A,
      staffId: STAFF_A_AT_PROPERTY_A,
      roomId: ROOM_UNASSIGNED,
      action: 'finish',
      // Vacant room → no cleaningContext required (Cluster E guard).
    }));
    assert.equal(res.status, 200, 'unassigned room must accept any staff in property');
  });

  test('staffA CAN mutate their own assigned room → 200', async () => {
    const { POST } = await import('@/app/api/housekeeper/room-action/route');
    const res = await POST(makeRequest({
      pid: PROPERTY_A,
      staffId: STAFF_A_AT_PROPERTY_A,
      roomId: ROOM_ASSIGNED_TO_A,
      action: 'finish',
    }));
    assert.equal(res.status, 200, 'normal happy path: staffA acts on staffA\'s room');
  });

  test('staffC (property B) CANNOT mutate a property A room → 403', async () => {
    // Cross-property block via staff.property_id check.
    const { POST } = await import('@/app/api/housekeeper/room-action/route');
    const res = await POST(makeRequest({
      pid: PROPERTY_A,                       // claims A
      staffId: STAFF_C_AT_PROPERTY_B,        // but staff belongs to B
      roomId: ROOM_ASSIGNED_TO_A,
      action: 'finish',
    }));
    assert.equal(res.status, 403, 'staff/property mismatch must reject');
  });

  test('valid (staffA, propertyA) cannot reach a property B room → 403', async () => {
    // Cross-property block via room.property_id check.
    const { POST } = await import('@/app/api/housekeeper/room-action/route');
    const res = await POST(makeRequest({
      pid: PROPERTY_A,
      staffId: STAFF_A_AT_PROPERTY_A,
      roomId: ROOM_AT_PROPERTY_B,            // room belongs to other property
      action: 'finish',
    }));
    assert.equal(res.status, 403, 'room/property mismatch must reject even with a valid staff pair');
  });

  test('unknown staffId → 403 (not 404) so the error shape doesn\'t leak which side was wrong', async () => {
    const { POST } = await import('@/app/api/housekeeper/room-action/route');
    const res = await POST(makeRequest({
      pid: PROPERTY_A,
      staffId: 'deadbeef-dead-beef-dead-beefdeadbeef',
      roomId: ROOM_UNASSIGNED,
      action: 'finish',
    }));
    assert.equal(res.status, 403, 'unknown staff returns same response as cross-property mismatch');
  });

  test('unknown roomId → 404', async () => {
    const { POST } = await import('@/app/api/housekeeper/room-action/route');
    const res = await POST(makeRequest({
      pid: PROPERTY_A,
      staffId: STAFF_A_AT_PROPERTY_A,
      roomId: 'd0000000-0000-0000-0000-deadbeefdead',
      action: 'finish',
    }));
    assert.equal(res.status, 404, 'unknown roomId is a distinct case (404 not 403)');
  });

  test('invalid action enum → 400 (not 200 or 500)', async () => {
    const { POST } = await import('@/app/api/housekeeper/room-action/route');
    const res = await POST(makeRequest({
      pid: PROPERTY_A,
      staffId: STAFF_A_AT_PROPERTY_A,
      roomId: ROOM_ASSIGNED_TO_A,
      action: 'evil_unknown_action',
    }));
    assert.equal(res.status, 400);
  });

  test('finish on a cleanable (checkout) room WITHOUT cleaningContext → 400', async () => {
    // Cluster E enforcement: the rooms row would otherwise flip to clean
    // without an audit row being written. This test pins the requirement.
    const checkoutRoom = 'd0000000-0000-0000-0000-000000000099';
    ROOM_BY_ID[checkoutRoom] = {
      id: checkoutRoom, property_id: PROPERTY_A, type: 'checkout',
      number: '999', date: '2026-05-17', assigned_to: STAFF_A_AT_PROPERTY_A,
      started_at: null, completed_at: null,
    };
    const { POST } = await import('@/app/api/housekeeper/room-action/route');
    const res = await POST(makeRequest({
      pid: PROPERTY_A,
      staffId: STAFF_A_AT_PROPERTY_A,
      roomId: checkoutRoom,
      action: 'finish',
      // intentionally no cleaningContext
    }));
    assert.equal(res.status, 400, 'finish on cleanable room without cleaningContext must reject');
    delete ROOM_BY_ID[checkoutRoom];
  });
});
