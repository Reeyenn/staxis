/**
 * The one-way bridge: a manager invitation joins the hotel's staff list.
 *
 * Three things are worth failing a build over, and they are what this file
 * exercises:
 *   1. WHO. A hotel-scoped manager, and nobody else. A housekeeper invitation
 *      must never mint a roster row, and a company regional manager must never be put on a
 *      hotel's staff list at all.
 *   2. ONCE. Accepting twice, or arriving after Communications already minted a
 *      row, produces exactly one active row. Testing Hotel really does carry
 *      four active "Reeyen Patel" rows from that path, so the collapse to one
 *      is tested on that exact shape.
 *   3. THEREFORE ASSIGNABLE. The whole point. After the bridge runs, the
 *      manager appears in the to-do Who list, which reads the staff table and
 *      was NOT widened to make this work.
 *
 * The Supabase client is a small in-memory double rather than the full
 * PostgREST stub: what is under test is the decision, not PostgREST.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { commsStaffIdentityId } from '@/lib/comms/identity';
import {
  ensureManagerStaffIdentity,
  isHotelScopedManagerGrant,
  managerRosterPropertyIds,
  planManagerStaffIdentity,
  MANAGER_ROSTER_DEPARTMENT,
} from '@/lib/schedule/staff-identity';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { listAssignees } from '@/lib/worklist/core';

const HOTEL_A = '11111111-1111-4111-8111-111111111111';
const HOTEL_B = '22222222-2222-4222-8222-222222222222';
const GM_ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GM_USER = 'aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb';
const OTHER_ACCOUNT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_USER = 'cccccccc-cccc-4ccc-8ccc-dddddddddddd';
const INVITER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

interface StaffRow {
  id: string;
  property_id: string;
  auth_user_id: string | null;
  name: string;
  department: string | null;
  is_active: boolean;
  created_at: string | null;
  language?: string;
}

interface LinkRow {
  account_id: string;
  property_id: string;
  staff_id: string;
  is_active: boolean;
  source: string;
  linked_by_account_id: string | null;
  linked_at?: string | null;
  deactivated_at?: string | null;
  deactivated_by_account_id?: string | null;
  updated_at?: string | null;
}

interface Db {
  staff: StaffRow[];
  links: LinkRow[];
}

let db: Db;
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;

type FromFn = typeof supabaseAdmin.from;
type RpcFn = typeof supabaseAdmin.rpc;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);

/** Minimal PostgREST-shaped double covering exactly the chains this code uses. */
function installDouble(): void {
  // @ts-expect-error monkey-patching the singleton for the test
  supabaseAdmin.from = (table: string) => {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    const source = (): Record<string, unknown>[] => (
      (table === 'staff' ? db.staff : db.links) as unknown as Record<string, unknown>[]
    );
    const run = () => source().filter((row) => filters.every((keep) => keep(row)));

    const api = {
      select: () => api,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return api;
      },
      in: (column: string, values: readonly unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return api;
      },
      order: () => api,
      limit: () => api,
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      insert: (row: Record<string, unknown>) => {
        if (table === 'account_property_staff_links') {
          const denied = {
            data: null,
            error: { code: '42501', message: 'permission denied for table account_property_staff_links' },
          };
          return { select: () => ({ maybeSingle: async () => denied }) };
        }
        const exists = source().some((existing) => existing.id === row.id);
        const written = exists ? null : row;
        if (written && table === 'staff') {
          const inserted = written as unknown as StaffRow;
          db.staff.push({ ...inserted, created_at: inserted.created_at ?? new Date().toISOString() });
        }
        return {
          select: () => ({
            maybeSingle: async () => (written
              ? { data: { id: written.id }, error: null }
              : { data: null, error: { code: '23505', message: 'duplicate key' } }),
          }),
        };
      },
      // Production reality since the Stage C lockdown: the service role holds
      // SELECT and nothing else on account_property_staff_links. A direct link
      // write is exactly the bug this file guards, so the double answers the
      // way Postgres does rather than quietly succeeding.
      upsert: async () => ({
        data: null,
        error: table === 'account_property_staff_links'
          ? { code: '42501', message: 'permission denied for table account_property_staff_links' }
          : null,
      }),
      update: async () => ({
        data: null,
        error: table === 'account_property_staff_links'
          ? { code: '42501', message: 'permission denied for table account_property_staff_links' }
          : null,
      }),
      then: (
        resolve: (value: { data: unknown; error: null }) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve({ data: run(), error: null }).then(resolve, reject),
    };
    return api;
  };

  supabaseAdmin.rpc = (async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (fn === 'staxis_archive_staff_member') {
      const propertyId = args.p_property_id as string;
      const staffId = args.p_staff_id as string;
      const row = db.staff.find(
        (staff) => staff.id === staffId && staff.property_id === propertyId,
      );
      if (!row) return { data: { ok: false, reason: 'not_found' }, error: null };
      row.is_active = false;
      for (const link of db.links) {
        if (link.property_id === propertyId && link.staff_id === staffId) link.is_active = false;
      }
      return { data: { ok: true, alreadyArchived: false }, error: null };
    }

    // 0454. The only way the link row is allowed to be written. The refusals
    // modelled here are the ones the real function returns, so a caller that
    // stops checking `ok` fails the tests below.
    if (fn === 'staxis_bridge_manager_roster_link') {
      const accountId = args.p_account_id as string;
      const propertyId = args.p_property_id as string;
      const staffId = args.p_staff_id as string;
      const source = args.p_source as string;
      if (source !== 'invitation' && source !== 'system') {
        return { data: { ok: false, reason: 'invalid' }, error: null };
      }
      const staffRow = db.staff.find(
        (row) => row.id === staffId && row.property_id === propertyId && row.is_active,
      );
      if (!staffRow) return { data: { ok: false, reason: 'staff_not_found' }, error: null };
      if ((staffRow.department ?? 'housekeeping') === 'housekeeping') {
        return { data: { ok: false, reason: 'department_conflict' }, error: null };
      }
      if (db.links.some((link) => (
        link.staff_id === staffId && link.is_active && link.account_id !== accountId
      ))) {
        return { data: { ok: false, reason: 'staff_in_use' }, error: null };
      }
      const index = db.links.findIndex((link) => (
        link.account_id === accountId && link.property_id === propertyId
      ));
      const now = new Date().toISOString();
      const next: LinkRow = {
        account_id: accountId,
        property_id: propertyId,
        staff_id: staffId,
        is_active: true,
        source,
        linked_by_account_id: (args.p_linked_by_account_id as string | null) ?? null,
        // The real function keeps the first link time and refreshes updated_at.
        linked_at: index >= 0 ? db.links[index].linked_at ?? now : now,
        deactivated_at: null,
        deactivated_by_account_id: null,
        updated_at: now,
      };
      if (index >= 0) db.links[index] = { ...db.links[index], ...next };
      else db.links.push(next);
      return { data: { ok: true, status: 'linked', staffId }, error: null };
    }

    throw new Error(`unexpected rpc ${fn}`);
  }) as unknown as RpcFn;
}

function staff(overrides: Partial<StaffRow> & { id: string }): StaffRow {
  return {
    property_id: HOTEL_A,
    auth_user_id: GM_USER,
    name: 'Reeyen Patel',
    department: 'other',
    is_active: true,
    created_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  db = { staff: [], links: [] };
  rpcCalls = [];
  installDouble();
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
});

describe('who the bridge is for', () => {
  test('a hotel-scoped GM hat is a manager of that hotel', () => {
    assert.equal(
      isHotelScopedManagerGrant({
        role: 'general_manager',
        membershipScope: 'property',
        organizationId: 'org',
      }),
      true,
    );
  });

  test('a plain invitation at an independent hotel counts for owner and GM', () => {
    for (const role of ['owner', 'general_manager']) {
      assert.equal(
        isHotelScopedManagerGrant({ role, membershipScope: null, organizationId: null }),
        true,
        role,
      );
    }
  });

  test('housekeeping, front desk and maintenance are never bridged', () => {
    for (const role of ['housekeeping', 'front_desk', 'maintenance']) {
      assert.equal(
        isHotelScopedManagerGrant({ role, membershipScope: 'property', organizationId: 'org' }),
        false,
        `${role} property hat`,
      );
      assert.equal(
        isHotelScopedManagerGrant({ role, membershipScope: null, organizationId: null }),
        false,
        `${role} plain invitation`,
      );
    }
  });

  test('company-scope people are never put on a hotel staff list', () => {
    // 0464 collapsed the company vocabulary to these two.
    for (const role of ['owner', 'regional_manager']) {
      assert.equal(
        isHotelScopedManagerGrant({ role, membershipScope: 'company', organizationId: 'org' }),
        false,
        role,
      );
    }
  });
});

describe('which hotels the bridge runs at', () => {
  test('a manager of three hotels joins all three staff lists', () => {
    const covered = [HOTEL_B, HOTEL_A, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'];
    assert.deepEqual(
      managerRosterPropertyIds({
        role: 'general_manager',
        membershipScope: 'property',
        organizationId: 'org',
        hotelId: HOTEL_A,
        coveredPropertyIds: covered,
      }),
      [...covered].sort(),
      'the Who list is per hotel, so being on only the anchor list strands the others',
    );
  });

  test('a plain invitation names its one hotel', () => {
    assert.deepEqual(
      managerRosterPropertyIds({
        role: 'general_manager',
        membershipScope: null,
        organizationId: null,
        hotelId: HOTEL_A,
        coveredPropertyIds: null,
      }),
      [HOTEL_A],
    );
  });

  test('a grant that is not hotel-scoped manager work names nothing', () => {
    for (const grant of [
      { role: 'regional_manager', membershipScope: 'company' as const, organizationId: 'org' },
      { role: 'housekeeping', membershipScope: 'property' as const, organizationId: 'org' },
    ]) {
      assert.deepEqual(
        managerRosterPropertyIds({
          ...grant,
          hotelId: HOTEL_A,
          coveredPropertyIds: [HOTEL_A],
        }),
        [],
        grant.role,
      );
    }
  });

  test('a malformed covered list falls back to the anchor hotel rather than nothing', () => {
    assert.deepEqual(
      managerRosterPropertyIds({
        role: 'general_manager',
        membershipScope: 'property',
        organizationId: 'org',
        hotelId: HOTEL_A,
        coveredPropertyIds: 'not-an-array',
      }),
      [HOTEL_A],
    );
  });
});

describe('choosing one roster row', () => {
  const deterministic = commsStaffIdentityId(HOTEL_A, GM_ACCOUNT);
  const fresh = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

  test('nothing there yet: the deterministic Communications id is used, so the two paths converge', () => {
    const plan = planManagerStaffIdentity({
      accountId: GM_ACCOUNT,
      deterministicStaffId: deterministic,
      freshStaffId: fresh,
      activeLinkStaffId: null,
      candidates: [],
    });
    assert.deepEqual(plan, {
      keeperStaffId: null,
      createStaffId: deterministic,
      archiveStaffIds: [],
      outcome: 'created',
    });
  });

  test('an existing active row is adopted, never duplicated', () => {
    const plan = planManagerStaffIdentity({
      accountId: GM_ACCOUNT,
      deterministicStaffId: deterministic,
      freshStaffId: fresh,
      activeLinkStaffId: null,
      candidates: [
        { id: deterministic, isActive: true, createdAt: '2026-06-01T00:00:00Z', activeLinkAccountId: null },
      ],
    });
    assert.equal(plan.outcome, 'adopted');
    assert.equal(plan.keeperStaffId, deterministic);
    assert.deepEqual(plan.archiveStaffIds, []);
  });

  test('the four active duplicates collapse to the oldest, the rest are archived', () => {
    const plan = planManagerStaffIdentity({
      accountId: GM_ACCOUNT,
      deterministicStaffId: deterministic,
      freshStaffId: fresh,
      activeLinkStaffId: null,
      candidates: [
        { id: 'd0000000-0000-4000-8000-000000000004', isActive: true, createdAt: '2026-07-04T00:00:00Z', activeLinkAccountId: null },
        { id: deterministic, isActive: true, createdAt: '2026-07-01T00:00:00Z', activeLinkAccountId: null },
        { id: 'd0000000-0000-4000-8000-000000000002', isActive: true, createdAt: '2026-07-02T00:00:00Z', activeLinkAccountId: null },
        { id: 'd0000000-0000-4000-8000-000000000003', isActive: true, createdAt: '2026-07-03T00:00:00Z', activeLinkAccountId: GM_ACCOUNT },
      ],
    });
    assert.equal(plan.outcome, 'deduped');
    assert.equal(plan.keeperStaffId, deterministic);
    assert.equal(plan.archiveStaffIds.length, 3);
    assert.equal(plan.archiveStaffIds.includes(deterministic), false);
  });

  test('a row already linked to this account keeps its link even if an older row exists', () => {
    const linked = 'd0000000-0000-4000-8000-00000000000b';
    const plan = planManagerStaffIdentity({
      accountId: GM_ACCOUNT,
      deterministicStaffId: deterministic,
      freshStaffId: fresh,
      activeLinkStaffId: linked,
      candidates: [
        { id: deterministic, isActive: true, createdAt: '2026-01-01T00:00:00Z', activeLinkAccountId: null },
        { id: linked, isActive: true, createdAt: '2026-09-01T00:00:00Z', activeLinkAccountId: GM_ACCOUNT },
      ],
    });
    assert.equal(plan.keeperStaffId, linked);
    assert.deepEqual(plan.archiveStaffIds, [deterministic]);
  });

  test('a row claimed by somebody else is never taken', () => {
    const plan = planManagerStaffIdentity({
      accountId: GM_ACCOUNT,
      deterministicStaffId: deterministic,
      freshStaffId: fresh,
      activeLinkStaffId: null,
      candidates: [
        { id: deterministic, isActive: true, createdAt: '2026-01-01T00:00:00Z', activeLinkAccountId: OTHER_ACCOUNT },
      ],
    });
    assert.equal(plan.outcome, 'created');
    assert.equal(plan.createStaffId, fresh, 'the taken deterministic id must not be reused');
  });

  test('an archived row is history, not a row to revive', () => {
    const plan = planManagerStaffIdentity({
      accountId: GM_ACCOUNT,
      deterministicStaffId: deterministic,
      freshStaffId: fresh,
      activeLinkStaffId: null,
      candidates: [
        { id: deterministic, isActive: false, createdAt: '2026-01-01T00:00:00Z', activeLinkAccountId: null },
      ],
    });
    assert.equal(plan.outcome, 'created');
    assert.equal(plan.createStaffId, fresh);
    assert.deepEqual(plan.archiveStaffIds, [], 'an archived row is left exactly as it was');
  });
});

describe('ensuring the row', () => {
  test('a manager with no roster row gets one, in a department that is not housekeeping', async () => {
    const result = await ensureManagerStaffIdentity({
      accountId: GM_ACCOUNT,
      propertyId: HOTEL_A,
      authUserId: GM_USER,
      displayName: 'Dana Manager',
      actorAccountId: INVITER,
      source: 'invitation',
    });

    assert.equal(result.outcome, 'created');
    assert.equal(db.staff.length, 1);
    assert.equal(db.staff[0].name, 'Dana Manager');
    assert.equal(db.staff[0].department, MANAGER_ROSTER_DEPARTMENT);
    assert.notEqual(db.staff[0].department, 'housekeeping');
    assert.equal(db.staff[0].auth_user_id, GM_USER);
    assert.deepEqual(db.links, [{
      account_id: GM_ACCOUNT,
      property_id: HOTEL_A,
      staff_id: result.staffId,
      is_active: true,
      source: 'invitation',
      linked_by_account_id: INVITER,
      linked_at: db.links[0].linked_at,
      deactivated_at: null,
      deactivated_by_account_id: null,
      updated_at: db.links[0].updated_at,
    } as unknown as LinkRow]);
  });

  test('the link is written through the guarded operation, not straight into the table', async () => {
    // The whole bridge worked in tests and half-worked in production: the
    // roster rows appeared, and every link write came back "permission denied
    // for table account_property_staff_links" because the service role holds
    // SELECT only on it. The double above answers that way now, so this test
    // fails the moment the link goes back to a direct write.
    const result = await ensureManagerStaffIdentity({
      accountId: GM_ACCOUNT,
      propertyId: HOTEL_A,
      authUserId: GM_USER,
      displayName: 'Dana Manager',
      actorAccountId: INVITER,
      source: 'invitation',
    });

    const linkCall = rpcCalls.find((call) => call.fn === 'staxis_bridge_manager_roster_link');
    assert.ok(linkCall, 'the bridge must ask the guarded operation to write the link');
    assert.deepEqual(linkCall.args, {
      p_account_id: GM_ACCOUNT,
      p_property_id: HOTEL_A,
      p_staff_id: result.staffId,
      p_source: 'invitation',
      p_linked_by_account_id: INVITER,
    });
    assert.equal(db.links.length, 1);
    assert.equal(db.links[0].staff_id, result.staffId);
  });

  test('a refused link is reported, never treated as linked', async () => {
    // A housekeeping employment record is not a manager identity, and the
    // guarded operation says so. Best-effort means the person who caused this
    // is not failed; it never means a refusal is recorded as a link, because
    // then nothing would go looking for that person again.
    const deterministic = commsStaffIdentityId(HOTEL_A, GM_ACCOUNT);
    db.staff.push(staff({ id: deterministic, department: 'housekeeping' }));

    await assert.rejects(
      ensureManagerStaffIdentity({
        accountId: GM_ACCOUNT,
        propertyId: HOTEL_A,
        authUserId: GM_USER,
        displayName: 'Dana Manager',
        actorAccountId: INVITER,
        source: 'invitation',
      }),
      /department_conflict/,
    );
    assert.equal(
      db.links.filter((link) => link.account_id === GM_ACCOUNT).length,
      0,
      'no link may be recorded for the manager whose write was refused',
    );
  });

  test('accepting twice does not create a second person', async () => {
    const first = await ensureManagerStaffIdentity({
      accountId: GM_ACCOUNT,
      propertyId: HOTEL_A,
      authUserId: GM_USER,
      displayName: 'Dana Manager',
      actorAccountId: INVITER,
      source: 'invitation',
    });
    const second = await ensureManagerStaffIdentity({
      accountId: GM_ACCOUNT,
      propertyId: HOTEL_A,
      authUserId: GM_USER,
      displayName: 'Dana Manager',
      actorAccountId: INVITER,
      source: 'invitation',
    });

    assert.equal(second.outcome, 'adopted');
    assert.equal(second.staffId, first.staffId);
    assert.equal(db.staff.filter((row) => row.is_active).length, 1);
    assert.equal(db.links.length, 1);
  });

  test('the row Communications already minted is adopted, not duplicated', async () => {
    const deterministic = commsStaffIdentityId(HOTEL_A, GM_ACCOUNT);
    db.staff.push(staff({ id: deterministic, name: 'Reeyen Patel' }));

    const result = await ensureManagerStaffIdentity({
      accountId: GM_ACCOUNT,
      propertyId: HOTEL_A,
      authUserId: GM_USER,
      displayName: 'Reeyen Patel',
      actorAccountId: INVITER,
      source: 'invitation',
    });

    assert.equal(result.outcome, 'adopted');
    assert.equal(result.staffId, deterministic);
    assert.equal(db.staff.length, 1);
  });

  test('four active duplicates become one active row and three archived ones', async () => {
    const deterministic = commsStaffIdentityId(HOTEL_A, GM_ACCOUNT);
    db.staff.push(
      staff({ id: deterministic, created_at: '2026-07-01T00:00:00.000Z' }),
      staff({ id: 'd0000000-0000-4000-8000-000000000002', created_at: '2026-07-02T00:00:00.000Z' }),
      staff({ id: 'd0000000-0000-4000-8000-000000000003', created_at: '2026-07-03T00:00:00.000Z' }),
      staff({ id: 'd0000000-0000-4000-8000-000000000004', created_at: '2026-07-04T00:00:00.000Z' }),
    );

    const result = await ensureManagerStaffIdentity({
      accountId: GM_ACCOUNT,
      propertyId: HOTEL_A,
      authUserId: GM_USER,
      displayName: 'Reeyen Patel',
      actorAccountId: INVITER,
      source: 'system',
    });

    assert.equal(result.outcome, 'deduped');
    assert.equal(result.staffId, deterministic);
    assert.equal(result.archivedStaffIds.length, 3);
    // Nothing is deleted. History survives as archived rows.
    assert.equal(db.staff.length, 4);
    assert.deepEqual(
      db.staff.filter((row) => row.is_active).map((row) => row.id),
      [deterministic],
    );
  });

  test('another hotel is never touched', async () => {
    const otherHotelRow = staff({
      id: 'd0000000-0000-4000-8000-0000000000b1',
      property_id: HOTEL_B,
      name: 'Reeyen Patel',
    });
    db.staff.push(otherHotelRow);

    await ensureManagerStaffIdentity({
      accountId: GM_ACCOUNT,
      propertyId: HOTEL_A,
      authUserId: GM_USER,
      displayName: 'Reeyen Patel',
      actorAccountId: INVITER,
      source: 'invitation',
    });

    assert.equal(otherHotelRow.is_active, true, 'hotel B keeps its row');
    assert.equal(
      db.staff.filter((row) => row.property_id === HOTEL_B).length,
      1,
      'no row is created at hotel B',
    );
    assert.equal(db.links.every((link) => link.property_id === HOTEL_A), true);
  });

  test('a roster row claimed by a different login is left alone', async () => {
    const deterministic = commsStaffIdentityId(HOTEL_A, GM_ACCOUNT);
    db.staff.push(staff({ id: deterministic, auth_user_id: OTHER_USER }));
    db.links.push({
      account_id: OTHER_ACCOUNT,
      property_id: HOTEL_A,
      staff_id: deterministic,
      is_active: true,
      source: 'manual',
      linked_by_account_id: null,
    });

    const result = await ensureManagerStaffIdentity({
      accountId: GM_ACCOUNT,
      propertyId: HOTEL_A,
      authUserId: GM_USER,
      displayName: 'Dana Manager',
      actorAccountId: INVITER,
      source: 'invitation',
    });

    assert.equal(result.outcome, 'created');
    assert.notEqual(result.staffId, deterministic);
    const claimed = db.links.find((link) => link.staff_id === deterministic);
    assert.equal(claimed?.account_id, OTHER_ACCOUNT, 'the other login keeps its identity');
    assert.equal(claimed?.is_active, true);
  });
});

describe('assignability follows, without widening anything', () => {
  test('an invited manager becomes someone the to-do list can be handed to', async () => {
    assert.deepEqual(
      await listAssignees(HOTEL_A),
      [],
      'before the bridge there is nobody to hand work to',
    );

    const result = await ensureManagerStaffIdentity({
      accountId: GM_ACCOUNT,
      propertyId: HOTEL_A,
      authUserId: GM_USER,
      displayName: 'Dana Manager',
      actorAccountId: INVITER,
      source: 'invitation',
    });

    assert.deepEqual(await listAssignees(HOTEL_A), [
      { staffId: result.staffId, name: 'Dana Manager', department: MANAGER_ROSTER_DEPARTMENT },
    ]);
  });

  test('a manager at hotel B never appears in hotel A Who list', async () => {
    await ensureManagerStaffIdentity({
      accountId: GM_ACCOUNT,
      propertyId: HOTEL_A,
      authUserId: GM_USER,
      displayName: 'Dana Manager',
      actorAccountId: INVITER,
      source: 'invitation',
    });
    await ensureManagerStaffIdentity({
      accountId: OTHER_ACCOUNT,
      propertyId: HOTEL_B,
      authUserId: OTHER_USER,
      displayName: 'Sam Sibling',
      actorAccountId: INVITER,
      source: 'invitation',
    });

    const hotelA = await listAssignees(HOTEL_A);
    const hotelB = await listAssignees(HOTEL_B);
    assert.deepEqual(hotelA.map((person) => person.name), ['Dana Manager']);
    assert.deepEqual(hotelB.map((person) => person.name), ['Sam Sibling']);
  });

  test('an archived duplicate stops being assignable the moment it is archived', async () => {
    const deterministic = commsStaffIdentityId(HOTEL_A, GM_ACCOUNT);
    db.staff.push(
      staff({ id: deterministic, name: 'Reeyen Patel', created_at: '2026-07-01T00:00:00.000Z' }),
      staff({ id: 'd0000000-0000-4000-8000-000000000002', name: 'Reeyen Patel', created_at: '2026-07-02T00:00:00.000Z' }),
    );
    assert.equal((await listAssignees(HOTEL_A)).length, 2, 'the duplicate is the bug');

    await ensureManagerStaffIdentity({
      accountId: GM_ACCOUNT,
      propertyId: HOTEL_A,
      authUserId: GM_USER,
      displayName: 'Reeyen Patel',
      actorAccountId: INVITER,
      source: 'system',
    });

    const after = await listAssignees(HOTEL_A);
    assert.equal(after.length, 1);
    assert.equal(after[0].staffId, deterministic);
  });
});
