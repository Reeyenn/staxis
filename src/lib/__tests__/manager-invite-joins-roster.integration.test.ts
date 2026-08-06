/**
 * A manager who accepts an invitation can be handed work the same day.
 *
 * End to end, against a real database: create the invitation the way the People
 * screen creates it, accept it through the real public route, and then ask the
 * two questions that were broken before.
 *
 *   ROSTER      the new manager has an employment record at that hotel, linked
 *               to their login, in a department that is not housekeeping.
 *   ASSIGNABLE  they appear in the to-do Who list, which reads the staff table
 *               and was deliberately NOT widened to make this work. If somebody
 *               "fixes" assignability by loosening listAssignees instead, this
 *               still passes and the roster test above is what catches it; if
 *               somebody removes the bridge, this fails.
 *   RECEIPT     the person who handed them the to-do gets told when it is done.
 *
 * The control is a housekeeper invitation accepted the same way. Nothing may
 * appear on the roster for them: housekeepers work from the housekeeping board,
 * never the to-do list, and the founder's standing rule is that no feature adds
 * a step to their job.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { POST as acceptInvite } from '@/app/api/auth/accept-invite/route';
import { loadAuthoritativeHotelRoster } from '@/lib/authorization/hotel-account-roster';
import { log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { gatherAssignedByMe, listAssignees } from '@/lib/worklist/core';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_BO,
  ACCOUNT_WANDA,
  ORG_B,
  PID_A1,
  PID_B1,
  PID_L1,
  UID_BO,
  UID_WANDA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

let pg: PGlite;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalCreateUser = supabaseAdmin.auth.admin.createUser.bind(supabaseAdmin.auth.admin);
const originalListUsers = supabaseAdmin.auth.admin.listUsers.bind(supabaseAdmin.auth.admin);
const originalDeleteUser = supabaseAdmin.auth.admin.deleteUser.bind(supabaseAdmin.auth.admin);

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Create the invitation exactly as POST /api/auth/invites does. */
async function inviteToHotel(options: {
  email: string;
  role: 'general_manager' | 'housekeeping';
  hotelId: string;
}): Promise<string> {
  const token = randomBytes(24).toString('hex');
  const { data, error } = await supabaseAdmin.rpc('staxis_create_account_invite_guarded', {
    p_actor_account_id: ACCOUNT_BO,
    p_actor_auth_user_id: UID_BO,
    p_hotel_id: options.hotelId,
    p_email: options.email,
    p_role: options.role,
    p_token_hash: hashToken(token),
    p_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    p_organization_id: ORG_B,
    p_membership_scope: 'property',
    p_covered_property_ids: [options.hotelId],
    p_request_id: randomUUID(),
    p_target_staff_id: null,
  });
  const receipt = data as { ok?: boolean; reason?: string } | null;
  assert.equal(error, null, `invite creation failed: ${error?.message}`);
  assert.equal(receipt?.ok, true, `invite refused: ${JSON.stringify(receipt)}`);
  return token;
}

async function acceptAs(token: string, displayName: string): Promise<number> {
  const request = new NextRequest('https://staxis.test/api/auth/accept-invite', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.31' },
    body: JSON.stringify({ token, displayName, password: 'not-a-real-password' }),
  });
  const response = await acceptInvite(request);
  return response.status;
}

async function rosterAt(propertyId: string, email: string): Promise<{
  staffId: string | null;
  department: string | null;
  linkedAccountId: string | null;
  linkSource: string | null;
}> {
  const rows = await pg.query<{
    staff_id: string | null;
    department: string | null;
    account_id: string | null;
    source: string | null;
  }>(
    `select staff_row.id as staff_id,
            staff_row.department,
            staff_link.account_id,
            staff_link.source
       from public.accounts account
       join auth.users auth_user on auth_user.id = account.data_user_id
       left join public.account_property_staff_links staff_link
              on staff_link.account_id = account.id
             and staff_link.property_id = $1
             and staff_link.is_active
       left join public.staff staff_row
              on staff_row.id = staff_link.staff_id
      where lower(auth_user.email) = lower($2)`,
    [propertyId, email],
  );
  const row = rows.rows[0];
  return {
    staffId: row?.staff_id ?? null,
    department: row?.department ?? null,
    linkedAccountId: row?.account_id ?? null,
    linkSource: row?.source ?? null,
  };
}

before(async () => {
  const migrated = await applyMigrationsToPglite();
  pg = migrated.pg;
  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.from = shim.from;
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.rpc = shim.rpc;
  // @ts-expect-error the acceptance flow only needs an id and an email back
  supabaseAdmin.auth.admin.createUser = async (params: { email: string }) => {
    const id = randomUUID();
    await pg.query(
      `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
      [id, params.email.toLowerCase()],
    );
    return { data: { user: { id, email: params.email.toLowerCase() } }, error: null };
  };
  // @ts-expect-error the reclaim probe only needs a page it can read
  supabaseAdmin.auth.admin.listUsers = async () => ({ data: { users: [] }, error: null });
  // @ts-expect-error rollback is never expected to run in these tests
  supabaseAdmin.auth.admin.deleteUser = async () => ({ data: { user: null }, error: null });

  await seedTwoCompanies(pg);
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.admin.createUser = originalCreateUser;
  supabaseAdmin.auth.admin.listUsers = originalListUsers;
  supabaseAdmin.auth.admin.deleteUser = originalDeleteUser;
  await pg?.close();
});

describe('an invited manager joins the hotel staff list', () => {
  const email = 'new.gm@example.test';

  test('accepting the invitation creates the employment record and links it', async () => {
    assert.deepEqual(
      (await listAssignees(PID_B1)).map((person) => person.name),
      [],
      'nobody at this hotel can be handed anything yet',
    );

    const token = await inviteToHotel({ email, role: 'general_manager', hotelId: PID_B1 });
    assert.equal(await acceptAs(token, 'Nina Newmanager'), 200);

    const roster = await rosterAt(PID_B1, email);
    assert.notEqual(roster.staffId, null, 'the manager must have an employment record');
    assert.notEqual(roster.linkedAccountId, null, 'and it must be linked to their login');
    assert.equal(roster.linkSource, 'invitation');
    assert.notEqual(
      roster.department,
      'housekeeping',
      'a manager must never land in the department the to-do list refuses',
    );
  });

  test('and therefore appears in the to-do Who list, which was not widened', async () => {
    const assignees = await listAssignees(PID_B1);
    assert.deepEqual(assignees.map((person) => person.name), ['Nina Newmanager']);

    const roster = await rosterAt(PID_B1, email);
    assert.equal(assignees[0]?.staffId, roster.staffId);
  });

  test('the other hotel is untouched', async () => {
    assert.deepEqual(await listAssignees(PID_A1), []);
  });

  test('work handed to them comes back to the person who handed it over', async () => {
    const roster = await rosterAt(PID_B1, email);
    const assignerStaffId = randomUUID();
    await pg.query(
      `insert into public.staff (id, property_id, name, department, is_active, language)
       values ($1, $2, 'Bo Owner', 'other', true, 'en')`,
      [assignerStaffId, PID_B1],
    );
    const taskId = randomUUID();
    await pg.query(
      `insert into public.comms_tasks
         (id, property_id, title, assigned_staff_id, created_by_staff_id, status)
       values ($1, $2, 'Check the lobby vending machine', $3, $4, 'open')`,
      [taskId, PID_B1, roster.staffId, assignerStaffId],
    );

    const waiting = await gatherAssignedByMe(PID_B1, assignerStaffId);
    assert.equal(waiting.length, 1, 'the assigner can see what they handed over');
    assert.equal(waiting[0]?.state, 'waiting');
    assert.equal(waiting[0]?.assigneeName, 'Nina Newmanager');

    await pg.query(
      `update public.comms_tasks
          set status = 'done', completed_at = now(), completed_by_staff_id = $2
        where id = $1`,
      [taskId, roster.staffId],
    );

    const settled = await gatherAssignedByMe(PID_B1, assignerStaffId);
    assert.equal(settled.length, 1);
    assert.equal(settled[0]?.state, 'done', 'and is told when it is finished');
    assert.equal(settled[0]?.settledByStaffId, roster.staffId);
  });
});

describe('a housekeeper invitation stays a login only', () => {
  const email = 'new.housekeeper@example.test';

  test('accepting it adds nothing to the roster', async () => {
    const token = await inviteToHotel({ email, role: 'housekeeping', hotelId: PID_B1 });
    assert.equal(await acceptAs(token, 'Hana Housekeeper'), 200);

    const roster = await rosterAt(PID_B1, email);
    assert.equal(roster.staffId, null, 'the two lifecycles stay separate for floor staff');
    assert.equal(roster.linkedAccountId, null);
  });

  test('and the Who list still names only the manager', async () => {
    assert.deepEqual(
      (await listAssignees(PID_B1)).map((person) => person.name),
      ['Bo Owner', 'Nina Newmanager'],
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The same visit, at a hotel with no management company
//
// Waco Inn is nobody's hotel but its owner's. That is how the first paying
// customer is set up, and after the access cutover it was the shape nothing
// had been exercised against: three separate places assumed "canonical
// authority" meant "managed by a company", and each of them failed a hotel
// that has no company at all.
// ═══════════════════════════════════════════════════════════════════════════

/** Create a PLAIN invitation: no company, no scope, no covered hotels. This is
 *  the only kind an independent hotel can send. */
async function inviteToIndependentHotel(options: {
  email: string;
  role: 'general_manager' | 'housekeeping';
}): Promise<string> {
  const token = randomBytes(24).toString('hex');
  const { data, error } = await supabaseAdmin.rpc('staxis_create_account_invite_guarded', {
    p_actor_account_id: ACCOUNT_WANDA,
    p_actor_auth_user_id: UID_WANDA,
    p_hotel_id: PID_L1,
    p_email: options.email,
    p_role: options.role,
    p_token_hash: hashToken(token),
    p_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    p_organization_id: null,
    p_membership_scope: null,
    p_covered_property_ids: null,
    p_request_id: randomUUID(),
    p_target_staff_id: null,
  });
  const receipt = data as { ok?: boolean; reason?: string } | null;
  assert.equal(error, null, `invite creation failed: ${error?.message}`);
  assert.equal(receipt?.ok, true, `invite refused: ${JSON.stringify(receipt)}`);
  return token;
}

describe('an independent hotel can still bring somebody on', () => {
  const email = 'waco.gm@example.test';

  test('its Users list loads at all', async () => {
    // The roster response for an independent hotel is normalized authority on
    // the hotel surface at the same time. That combination used to be read as
    // a corrupt response, so this threw and every consumer fell back to
    // "temporarily unavailable" for the real customer.
    const roster = await loadAuthoritativeHotelRoster(PID_L1, false);
    assert.ok(roster.accounts.length > 0, 'the owner must be on their own hotel roster');
    const owner = roster.accounts.find((account) => account.accountId === ACCOUNT_WANDA);
    assert.ok(owner, 'the independent owner must appear');
    assert.equal(owner.authorityMode, 'normalized');
    assert.equal(owner.managementSurface, 'legacy_hotel');
    assert.deepEqual(owner.propertyIds, [PID_L1]);
  });

  test('a plain invitation is accepted outright, not rescued', async () => {
    // The acceptance transaction reports normalized authority on BOTH of its
    // branches. The route used to demand that the word mirror the invitation
    // shape instead, so every plain invitation, the only kind an independent
    // hotel can send, was declared a failure after it had already committed.
    // The ambiguity net then quietly rescued it, which is why the person
    // usually still got in: the acceptance was logged as a hard failure, the
    // reconciliation path ran on every single one, and a slow read there
    // answers "please retry shortly" to somebody whose account already exists
    // and whose invitation is already spent. Asserting only the 200 would
    // therefore pass with the bug present, so this asserts the route did not
    // need rescuing.
    const failures: string[] = [];
    const realLogError = log.error;
    log.error = (message: string, fields?: Record<string, unknown>) => {
      failures.push(message);
      return realLogError(message, fields);
    };

    const token = await inviteToIndependentHotel({ email, role: 'general_manager' });
    let status: number;
    try {
      status = await acceptAs(token, 'Wes Newmanager');
    } finally {
      log.error = realLogError;
    }
    assert.equal(status, 200);
    assert.deepEqual(
      failures.filter((message) => message.includes('transactional acceptance failed')),
      [],
      'a successful acceptance must not be recorded as a failed one',
    );

    const { rows } = await pg.query<{ account_id: string; authority_mode: string }>(
      `select account.id as account_id, state.authority_mode
         from public.accounts account
         join auth.users auth_user on auth_user.id = account.data_user_id
         join public.account_authorization_state state on state.account_id = account.id
        where lower(auth_user.email) = lower($1)`,
      [email],
    );
    assert.equal(rows.length, 1, 'the login must survive the acceptance');
    assert.equal(rows[0]?.authority_mode, 'normalized');
  });

  test('and the manager lands on the hotel staff list, linked', async () => {
    const roster = await rosterAt(PID_L1, email);
    assert.notEqual(roster.staffId, null);
    assert.notEqual(roster.linkedAccountId, null, 'the roster row must be linked to the login');
    assert.equal(roster.linkSource, 'invitation');
    assert.notEqual(roster.department, 'housekeeping');
    assert.deepEqual(
      (await listAssignees(PID_L1)).map((person) => person.name),
      ['Wes Newmanager'],
    );
  });
});

describe('the roster link is written only through its guarded operation', () => {
  test('the service role cannot touch the link table directly, but the operation can', async () => {
    // Production truth since the access lockdown: SELECT and nothing else.
    // The bridge used to write this table directly, which passed here (the
    // test role owns the tables) and failed in production on every single
    // link. Running as the real role is what makes that visible.
    const roster = await rosterAt(PID_L1, 'waco.gm@example.test');
    assert.ok(roster.staffId && roster.linkedAccountId, 'this test needs the linked manager');

    await pg.exec('begin; set local role service_role;');
    let directWriteError: string | null = null;
    try {
      await pg.query(
        `update public.account_property_staff_links
            set source = 'manual'
          where account_id = $1 and property_id = $2`,
        [roster.linkedAccountId, PID_L1],
      );
    } catch (error) {
      directWriteError = error instanceof Error ? error.message : String(error);
    }
    await pg.exec('rollback;').catch(() => undefined);
    assert.match(
      directWriteError ?? '',
      /permission denied/i,
      'a direct write must stay denied for the service role',
    );

    await pg.exec('begin; set local role service_role;');
    let linked: { ok?: boolean; status?: string; reason?: string } | null = null;
    try {
      const result = await pg.query<{ value: { ok?: boolean; status?: string; reason?: string } }>(
        `select public.staxis_bridge_manager_roster_link($1, $2, $3, $4, $5) as value`,
        [roster.linkedAccountId, PID_L1, roster.staffId, 'system', null],
      );
      linked = result.rows[0]?.value ?? null;
      await pg.exec('commit;');
    } catch (error) {
      await pg.exec('rollback;').catch(() => undefined);
      throw error;
    }
    assert.equal(linked?.ok, true, `the guarded operation must write it: ${JSON.stringify(linked)}`);
    assert.equal(linked?.status, 'unchanged');
  });

  test('it refuses a hotel the person has no authority over', async () => {
    const roster = await rosterAt(PID_L1, 'waco.gm@example.test');
    const strangerStaffId = randomUUID();
    await pg.query(
      `insert into public.staff (id, property_id, name, department, is_active, language)
       values ($1, $2, 'Stranger', 'other', true, 'en')`,
      [strangerStaffId, PID_B1],
    );

    await pg.exec('begin; set local role service_role;');
    const result = await pg.query<{ value: { ok?: boolean; reason?: string } }>(
      `select public.staxis_bridge_manager_roster_link($1, $2, $3, $4, $5) as value`,
      [roster.linkedAccountId, PID_B1, strangerStaffId, 'system', null],
    );
    await pg.exec('rollback;').catch(() => undefined);
    assert.equal(result.rows[0]?.value?.ok, false);
    assert.equal(result.rows[0]?.value?.reason, 'not_authorized');
  });
});
