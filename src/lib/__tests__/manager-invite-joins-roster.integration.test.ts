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
  ORG_B,
  PID_A1,
  PID_B1,
  UID_BO,
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
