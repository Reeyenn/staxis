/**
 * The housekeeping board must not say "nothing to clean" when it could not read
 * the plan.
 *
 * GET /api/housekeeping/board is what the manager opens each morning to see
 * today's rooms, who has them, and how many nobody has. Every read in that
 * handler is load-bearing, and two of the three already fail loudly on a
 * database error — the staff read returns 500, and the property read returns
 * 500 with a comment explaining that confident wrong numbers are worse than an
 * error the tab can retry.
 *
 * The third read — the room plan itself, the actual list of rooms — did the
 * opposite. On a database error it logged a warning and answered 200 with
 * `{ tasks: [], housekeepers: [], unassigned: 0 }`. On screen that is
 * indistinguishable from a genuinely quiet day, and it is the answer a manager
 * acts on: send the crew home, nothing to do. The rooms stay dirty and nothing
 * anywhere says why.
 *
 * This is the same silent-empty shape CLAUDE.md names as the most-recurring bug
 * in this repo, on the manager side of the same feature.
 *
 * The tests drive the real route handler with a fake Supabase and assert on the
 * HTTP response.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase-admin';

const PID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
const AUTH_USER_ID = '44444444-4444-4444-4444-444444444444';
const DATE = '2026-08-07';

type FromFn = typeof supabaseAdmin.from;
type RpcFn = typeof supabaseAdmin.rpc;
type AuthGetUser = typeof supabaseAdmin.auth.getUser;

const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser: AuthGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const original2faFlag = process.env.DISABLE_SERVER_2FA_ENFORCEMENT;

/** Flip to make the canonical room-plan read fail. */
let planReadFails = false;

/** One ordinary room on today's plan, unassigned. */
const PLAN_ROWS = [
  {
    id: '55555555-5555-5555-5555-555555555555',
    property_id: PID,
    room_number: '204',
    cleaning_type: 'departure',
    priority: 'normal',
    due_by: null,
    estimated_minutes: 30,
    requires_inspection: false,
    extras: [],
    status: 'scheduled',
    assignee_id: null,
    queue_order: 0,
    assignment_reason: null,
    assigned_by: null,
  },
];

const STAFF_ROWS = [
  {
    id: '66666666-6666-6666-6666-666666666666',
    name: 'Maria Lopez',
    language: 'en',
    is_senior: false,
    is_active: true,
    schedule_priority: 'normal',
    phone: '+15550000000',
    department: 'housekeeping',
  },
];

/** The authority payload shape listAuthoritativePropertyAccess validates. */
const AUTHORITY_DTO = {
  ok: true,
  all: false,
  authorityMode: 'legacy',
  authorityVersion: 1,
  effectiveAccessHash: 'a'.repeat(64),
  propertyIds: [PID],
  legacyPropertyIds: [PID],
  membershipPropertyIds: [],
  propertyStandings: [{
    propertyId: PID,
    operationalRole: 'general_manager',
    seesFinancials: true,
    hotelMutationAllowed: true,
    portfolioIntelligenceRead: false,
    entitlements: [{
      kind: 'legacy',
      entitlementId: ACCOUNT_ID,
      organizationId: null,
      membershipId: null,
      accessProfile: null,
      staxisRole: null,
      scopeType: 'property',
      portfolioId: null,
    }],
  }],
};

beforeEach(() => {
  planReadFails = false;
  // Supported local-dev/test break-glass (src/lib/api-auth.ts): skips the
  // trusted-device check so the test can exercise the handler, not the 2FA
  // ceremony. Ignored on any production/preview deploy by design.
  process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

  supabaseAdmin.auth.getUser = (async () => ({
    data: { user: { id: AUTH_USER_ID, email: 'gm@example.test' } },
    error: null,
  })) as unknown as AuthGetUser;

  supabaseAdmin.from = ((table: string) => {
    const result = (): { data: unknown; error: unknown } => {
      if (table === 'room_work_plan_v1') {
        return planReadFails
          ? { data: null, error: { message: 'statement timeout' } }
          : { data: PLAN_ROWS, error: null };
      }
      if (table === 'staff') return { data: STAFF_ROWS, error: null };
      if (table === 'properties') {
        // enabled_sections null → every section defaults ON.
        return { data: { shift_minutes: 420, enabled_sections: null }, error: null };
      }
      if (table === 'accounts') {
        return { data: { id: ACCOUNT_ID, active: true }, error: null };
      }
      // scheduled_shifts, time_off_requests, clean-time standards → empty.
      return { data: [], error: null };
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder, neq: () => builder, is: () => builder, not: () => builder,
      lt: () => builder, gt: () => builder, gte: () => builder, lte: () => builder,
      in: () => builder, or: () => builder, filter: () => builder,
      order: () => builder, limit: () => builder, range: () => builder,
      maybeSingle: async () => {
        const r = result();
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
      },
      single: async () => {
        const r = result();
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
      },
      then: (resolve: (v: unknown) => unknown) => {
        const r = result();
        return resolve({
          data: Array.isArray(r.data) || r.data === null ? r.data : [r.data],
          error: r.error,
        });
      },
    };
    return builder;
  }) as unknown as FromFn;

  supabaseAdmin.rpc = (async (fn: string) => {
    if (fn === 'staxis_list_account_authorized_properties') {
      return { data: AUTHORITY_DTO, error: null };
    }
    if (fn === 'staxis_api_limit_hit') return { data: 1, error: null };
    return { data: null, error: null };
  }) as unknown as RpcFn;
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  if (original2faFlag === undefined) delete process.env.DISABLE_SERVER_2FA_ENFORCEMENT;
  else process.env.DISABLE_SERVER_2FA_ENFORCEMENT = original2faFlag;
});

function boardRequest(): NextRequest {
  return new Request(
    `https://staxis.test/api/housekeeping/board?propertyId=${PID}&date=${DATE}`,
    { headers: { authorization: 'Bearer test-access-token' } },
  ) as unknown as NextRequest;
}

describe('GET /api/housekeeping/board tells the truth about a failed read', () => {
  test('a readable plan comes back as a board with the room on it', async () => {
    const { GET } = await import('@/app/api/housekeeping/board/route');
    const res = await GET(boardRequest());
    assert.equal(res.status, 200);
    const json = await res.json() as { ok: boolean; data: { tasks: unknown[]; unassigned: number } };
    assert.equal(json.ok, true);
    assert.equal(json.data.tasks.length, 1, 'the one planned room should be on the board');
    assert.equal(json.data.unassigned, 1, 'nobody holds it yet');
  });

  test('a failed plan read is an error, not an empty board', async () => {
    planReadFails = true;
    const { GET } = await import('@/app/api/housekeeping/board/route');
    const res = await GET(boardRequest());
    assert.notEqual(
      res.status, 200,
      'answering 200 with zero rooms tells the manager the hotel is clean. '
      + 'A read failure has to look like a read failure so the tab can retry.',
    );
    assert.equal(res.status, 500);
  });
});
