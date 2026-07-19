import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const PROPERTY = '11111111-1111-1111-1111-111111111111';
const STAFF = '22222222-2222-2222-2222-222222222222';
const OWNER = '33333333-3333-3333-3333-333333333333';
const GM = '44444444-4444-4444-4444-444444444444';
const ADMIN = '55555555-5555-5555-5555-555555555555';
const INVITEE = '66666666-6666-6666-6666-666666666666';
const INVITEE_USER = '77777777-7777-7777-7777-777777777777';
const LEADER = '88888888-8888-8888-8888-888888888888';
const LEADER_USER = '99999999-9999-9999-9999-999999999999';
const ADMIN_USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const NEW_PROPERTY = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const NEW_STAFF = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const NEW_ACCOUNT = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const NEW_USER = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const DEMOTED_ACCOUNT = 'f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0';
const DEMOTED_USER = 'f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1';
const LIFECYCLE_OWNER = '10101010-1010-1010-1010-101010101010';
const LIFECYCLE_ADMIN = '20202020-2020-2020-2020-202020202020';
const LIFECYCLE_MEMBER = '30303030-3030-3030-3030-303030303030';
const DELETE_PROPERTY = '40404040-4040-4040-4040-404040404040';
const DELETE_ACCOUNT = '50505050-5050-5050-5050-505050505050';
const DELETE_USER = '60606060-6060-6060-6060-606060606060';
const PRESERVED_ACCOUNT = '70707070-7070-7070-7070-707070707070';
const PRESERVED_USER = '80808080-8080-8080-8080-808080808080';
const FEED_ALLOWED_PROPERTY = 'a1000000-0000-0000-0000-000000000001';
const FEED_DENIED_PROPERTY = 'a1000000-0000-0000-0000-000000000002';
const FEED_FOREIGN_PROPERTY = 'a1000000-0000-0000-0000-000000000003';
const FEED_SCOPED_ACTOR = 'b1000000-0000-0000-0000-000000000001';
const FEED_OWNER_A = 'b1000000-0000-0000-0000-000000000002';
const FEED_OWNER_B = 'b1000000-0000-0000-0000-000000000003';
const FEED_TARGET_A = 'b1000000-0000-0000-0000-000000000004';
const FEED_TARGET_B = 'b1000000-0000-0000-0000-000000000005';

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0325_organization_access_foundation.sql'),
  'utf8',
);

describe('organization access migration — real SQL via PGlite', () => {
  let pg: PGlite;

  before(async () => {
    pg = new PGlite({ extensions: { pgcrypto } });
    await pg.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role bypassrls nologin;

      create schema auth;
      create table auth.users (
        id uuid primary key,
        email text
      );
      create function auth.uid()
      returns uuid
      language sql
      stable
      as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;

      create table public.properties (
        id uuid primary key,
        name text not null,
        onboarding_completed_at timestamptz
      );
      create table public.accounts (
        id uuid primary key,
        role text not null,
        display_name text,
        active boolean not null default true,
        property_access uuid[] not null default '{}',
        staff_id uuid,
        data_user_id uuid references auth.users(id) on delete cascade,
        created_at timestamptz not null default now()
      );
      create table public.staff (
        id uuid primary key,
        property_id uuid not null references public.properties(id) on delete cascade
      );
      alter table public.accounts
        add constraint accounts_staff_id_fkey
        foreign key (staff_id) references public.staff(id) on delete set null;
      create table public.applied_migrations (
        version text primary key,
        description text not null
      );
      create function public.claim_idempotency_key(
        p_key text, p_route text, p_pid uuid default null
      ) returns table (
        claimed boolean,
        existing_response jsonb,
        existing_status integer,
        existing_route text
      ) language sql as $$
        select true, null::jsonb, null::integer, p_route
      $$;

      insert into public.properties (id, name)
      values ('${PROPERTY}', 'Home2 Test');
      insert into public.staff (id, property_id)
      values ('${STAFF}', '${PROPERTY}');
      insert into auth.users (id, email)
      values
        ('${INVITEE_USER}', 'invitee@example.test'),
        ('${LEADER_USER}', 'leader@example.test');
      insert into public.accounts (
        id, role, display_name, property_access, staff_id, data_user_id, created_at
      ) values
        ('${OWNER}', 'owner', 'Legacy Owner', array['${PROPERTY}'::uuid], null, null, '2029-01-01'),
        ('${GM}', 'general_manager', 'Legacy GM', array['${PROPERTY}'::uuid], '${STAFF}', null, '2029-01-02'),
        ('${ADMIN}', 'admin', 'Staxis Admin', array['${PROPERTY}'::uuid], null, null, '2029-01-03'),
        ('${INVITEE}', 'staff', 'Invited Teammate', '{}', null, '${INVITEE_USER}', '2029-01-04'),
        ('${LEADER}', 'staff', 'Company Leader', '{}', null, '${LEADER_USER}', '2029-01-05');
    `);

    await pg.exec(MIGRATION_SQL);
  });

  after(async () => {
    await pg.close().catch(() => undefined);
  });

  test('backfills a hidden single-hotel anchor, customer memberships, grants, and staff link', async () => {
    const organizations = await pg.query<{ count: number }>(`
      select count(*)::int as count from public.organizations
      where organization_type = 'single_hotel' and legacy_property_id = '${PROPERTY}'
    `);
    assert.equal(organizations.rows[0].count, 1);

    const memberships = await pg.query<{ account_id: string }>(`
      select account_id from public.organization_memberships order by account_id
    `);
    assert.deepEqual(
      memberships.rows.map((row) => row.account_id).sort(),
      [OWNER, GM].sort(),
      'the Staxis admin must not become a customer organization member',
    );

    const effective = await pg.query<{ account_id: string; access_profile: string }>(`
      select account_id, access_profile
      from public.organization_effective_property_access
      where property_id = '${PROPERTY}'
      order by account_id
    `);
    assert.deepEqual(effective.rows, [
      { account_id: OWNER, access_profile: 'organization_owner' },
      { account_id: GM, access_profile: 'property_manager' },
    ]);

    const staffLinks = await pg.query<{ account_id: string; staff_id: string }>(`
      select account_id, staff_id from public.account_property_staff_links
    `);
    assert.deepEqual(staffLinks.rows, [{ account_id: GM, staff_id: STAFF }]);

    const backfillAudit = await pg.query<{ actor_kind: string; actor_account_id: string | null }>(`
      select actor_kind, actor_account_id
      from public.organization_access_events
      where event_type = 'organization_memberships.insert'
        and after_state->>'account_id' = '${OWNER}'
      order by occurred_at desc limit 1
    `);
    assert.deepEqual(backfillAudit.rows[0], {
      actor_kind: 'system',
      actor_account_id: null,
    });
  });

  test('keeps hidden single-hotel anchors out of company invitations and requests', async () => {
    const anchor = await pg.query<{ organization_id: string; membership_id: string }>(`
      select o.id as organization_id, m.id as membership_id
      from public.organizations o
      join public.organization_memberships m
        on m.organization_id = o.id and m.account_id = '${OWNER}'
      where o.organization_type = 'single_hotel'
        and o.legacy_property_id = '${PROPERTY}'
    `);
    const tokenHash = '9'.repeat(64);
    await assert.rejects(
      pg.query(`
        select public.staxis_create_organization_invitation(
          '${OWNER}', '${anchor.rows[0].organization_id}', 'legacy-invite@example.test',
          '${tokenHash}', 'other', 'Legacy invite', 'viewer', 'property',
          null, '${PROPERTY}', now() + interval '1 day', null
        )
      `),
      /legacy hotel team access must be changed through hotel role settings/i,
    );
    await assert.rejects(
      pg.query(`
        select public.staxis_create_organization_access_request(
          '${OWNER}', '${anchor.rows[0].membership_id}', 'viewer', 'property',
          'Should use hotel role settings', null, '${PROPERTY}'
        )
      `),
      /legacy hotel team access must be changed through hotel role settings/i,
    );
  });

  test('enforces one open primary grouping relationship per hotel', async () => {
    const org = await pg.query<{ id: string }>(`
      insert into public.organizations (name, organization_type)
      values ('Second Operator', 'management_company') returning id
    `);
    await assert.rejects(
      pg.query(`
        insert into public.organization_property_relationships (
          organization_id, property_id, relationship_type, is_primary_grouping
        ) values ($1, $2, 'operator', true)
      `, [org.rows[0].id, PROPERTY]),
      /organization_property_one_open_primary_idx|duplicate key/i,
    );
  });

  test('rejects account inserts and updates that would leave dangling hotel access', async () => {
    const missingProperty = '91919191-9191-9191-9191-919191919191';
    const insertedAccount = '92929292-9292-9292-9292-929292929292';
    await assert.rejects(
      pg.query(`
        update public.accounts
        set property_access = array['${missingProperty}'::uuid]
        where id = '${INVITEE}'
      `),
      /account property access references a missing hotel/i,
    );
    await assert.rejects(
      pg.query(`
        insert into public.accounts (id, role, property_access)
        values ('${insertedAccount}', 'staff', array['${missingProperty}'::uuid])
      `),
      /account property access references a missing hotel/i,
    );
  });

  test('protects the final active owner and keeps audit events immutable', async () => {
    const protectedOrganization = await pg.query<{ id: string }>(`
      insert into public.organizations (name, organization_type)
      values ('Protected Owner Test', 'management_company') returning id
    `);
    const protectedMembership = await pg.query<{ id: string }>(`
      insert into public.organization_memberships (
        organization_id, account_id, job_category, status
      ) values (
        '${protectedOrganization.rows[0].id}', '${OWNER}', 'owner_principal', 'active'
      ) returning id
    `);
    const ownerGrant = await pg.query<{ id: string }>(`
      insert into public.organization_access_grants (
        organization_id, membership_id, access_profile, scope_type,
        source, granted_by_account_id
      ) values (
        '${protectedOrganization.rows[0].id}', '${protectedMembership.rows[0].id}',
        'organization_owner', 'organization', 'manual', '${OWNER}'
      ) returning id
    `);
    await assert.rejects(
      pg.query(`
        update public.organization_access_grants
        set status = 'revoked', revoked_at = now(),
            revoked_by_account_id = '${ADMIN}', revocation_reason = 'test removal'
        where id = $1
      `, [ownerGrant.rows[0].id]),
      /final active organization owner/i,
    );

    const event = await pg.query<{ id: string }>(`
      select id from public.organization_access_events order by occurred_at limit 1
    `);
    await assert.rejects(
      pg.query(`update public.organization_access_events set metadata = '{"changed":true}' where id = $1`, [event.rows[0].id]),
      /append-only/i,
    );
  });

  test('denies direct browser-role access and rejects customer-created support sessions', async () => {
    await assert.rejects(async () => {
      await pg.exec('begin');
      try {
        await pg.exec('set local role authenticated');
        await pg.query('select * from public.organization_memberships');
      } finally {
        await pg.exec('rollback').catch(() => undefined);
      }
    }, /permission denied/i);

    const claimPrivileges = await pg.query<{ browser: boolean; service: boolean }>(`
      select
        has_function_privilege(
          'authenticated',
          'public.claim_idempotency_key(text,text,uuid)',
          'execute'
        ) as browser,
        has_function_privilege(
          'service_role',
          'public.claim_idempotency_key(text,text,uuid)',
          'execute'
        ) as service
    `);
    assert.deepEqual(claimPrivileges.rows[0], { browser: false, service: true });

    await assert.rejects(
      pg.query(`
        insert into public.staxis_support_sessions (
          operator_account_id, scope_type, property_id, reason, expires_at
        ) values ('${GM}', 'property', '${PROPERTY}',
                  'Customer accounts cannot open support sessions', now() + interval '1 hour')
      `),
      /must be a Staxis administrator/i,
    );
  });

  test('runs create, move, invite, accept, and revoke as atomic service RPCs', async () => {
    await assert.rejects(
      pg.query(
        `select public.staxis_create_organization($1, 'Forbidden Org', 'management_company')`,
        [GM],
      ),
      /only a Staxis administrator/i,
    );

    const created = await pg.query<{ organization_id: string }>(`
      select public.staxis_create_organization(
        '${ADMIN}', 'Northstar Management', 'management_company'
      ) as organization_id
    `);
    const organizationId = created.rows[0].organization_id;

    await assert.rejects(
      pg.query(`
        select public.staxis_bootstrap_organization_leader_invitation(
          '${GM}', '${organizationId}', 'leader@example.test', '${'d'.repeat(64)}',
          'owner_principal', 'President', 'organization_owner', now() + interval '1 day'
        )
      `),
      /only a Staxis administrator/i,
    );
    const bootstrapToken = 'c'.repeat(64);
    await pg.query(`
      select public.staxis_bootstrap_organization_leader_invitation(
        '${ADMIN}', '${organizationId}', 'leader@example.test', '${bootstrapToken}',
        'owner_principal', 'President', 'organization_owner', now() + interval '1 day'
      )
    `);
    await pg.query(`
      select * from public.staxis_accept_organization_invitation(
        '${bootstrapToken}', '${LEADER}'
      )
    `);
    const bootstrap = await pg.query<{ leader_count: number; admin_membership_count: number }>(`
      select
        count(*) filter (
          where m.account_id = '${LEADER}' and g.access_profile = 'organization_owner'
        )::int as leader_count,
        count(*) filter (where m.account_id = '${ADMIN}')::int as admin_membership_count
      from public.organization_memberships m
      left join public.organization_access_grants g on g.membership_id = m.id
      where m.organization_id = '${organizationId}'
    `);
    assert.deepEqual(bootstrap.rows[0], { leader_count: 1, admin_membership_count: 0 });

    const moved = await pg.query<{ relationship_id: string }>(`
      select public.staxis_set_primary_property_organization(
        '${ADMIN}', '${PROPERTY}', '${organizationId}', 'operator'
      ) as relationship_id
    `);
    assert.ok(moved.rows[0].relationship_id);

    const changedType = await pg.query<{ relationship_id: string }>(`
      select public.staxis_set_primary_property_organization(
        '${ADMIN}', '${PROPERTY}', '${organizationId}', 'owner'
      ) as relationship_id
    `);
    assert.notEqual(changedType.rows[0].relationship_id, moved.rows[0].relationship_id);
    const primaries = await pg.query<{ count: number; relationship_type: string }>(`
      select count(*)::int as count, max(relationship_type) as relationship_type
      from public.organization_property_relationships
      where property_id = '${PROPERTY}' and is_primary_grouping and ends_at is null
    `);
    assert.deepEqual(primaries.rows[0], { count: 1, relationship_type: 'owner' });

    const anchor = await pg.query<{ id: string }>(`
      select id from public.organizations where legacy_property_id = '${PROPERTY}'
    `);
    await assert.rejects(
      pg.query(`
        select public.staxis_set_primary_property_organization(
          '${ADMIN}', '${PROPERTY}', $1, 'operator'
        )
      `, [anchor.rows[0].id]),
      /system-managed single-hotel anchor/i,
    );

    const legacyOwnerStillEffective = await pg.query<{ count: number }>(`
      select count(*)::int as count
      from public.organization_effective_property_access
      where account_id = '${OWNER}' and property_id = '${PROPERTY}'
    `);
    assert.equal(
      legacyOwnerStillEffective.rows[0].count,
      1,
      'the hidden anchor remains active during management-company migration',
    );

    await pg.query(`
      select public.staxis_set_primary_property_organization(
        '${ADMIN}', '${PROPERTY}', null, 'operator'
      )
    `);
    const independentPrimary = await pg.query<{ organization_id: string }>(`
      select organization_id
      from public.organization_property_relationships
      where property_id = '${PROPERTY}' and is_primary_grouping and ends_at is null
    `);
    assert.equal(independentPrimary.rows[0].organization_id, anchor.rows[0].id);

    await pg.query(`
      select public.staxis_set_primary_property_organization(
        '${ADMIN}', '${PROPERTY}', '${organizationId}', 'owner'
      )
    `);

    const tokenHash = 'a'.repeat(64);
    const invitation = await pg.query<{ invitation_id: string }>(`
      select public.staxis_create_organization_invitation(
        '${LEADER}', '${organizationId}', 'invitee@example.test', '${tokenHash}',
        'general_manager', 'General Manager', 'property_manager', 'property',
        null, '${PROPERTY}', now() + interval '1 day', null
      ) as invitation_id
    `);
    assert.ok(invitation.rows[0].invitation_id);

    const accepted = await pg.query<{ membership_id: string; grant_id: string }>(`
      select * from public.staxis_accept_organization_invitation(
        '${tokenHash}', '${INVITEE}'
      )
    `);
    assert.equal(accepted.rows.length, 1);

    const effective = await pg.query<{ count: number }>(`
      select count(*)::int as count
      from public.organization_effective_property_access
      where account_id = '${INVITEE}' and property_id = '${PROPERTY}'
    `);
    assert.equal(effective.rows[0].count, 1);
    const revoked = await pg.query<{ revoked: boolean }>(`
      select public.staxis_revoke_organization_access(
        '${LEADER}', '${accepted.rows[0].grant_id}', 'Access no longer required'
      ) as revoked
    `);
    assert.equal(revoked.rows[0].revoked, true);
    await assert.rejects(
      pg.query(`
        select public.staxis_revoke_organization_access(
          '${GM}', '${accepted.rows[0].grant_id}', 'Cross-tenant retry'
        )
      `),
      /actor cannot revoke this profile or scope/i,
      'a revoked grant id must not be observable without current delegation authority',
    );
    const afterRevoke = await pg.query<{ count: number }>(`
      select count(*)::int as count
      from public.organization_effective_property_access
      where account_id = '${INVITEE}' and property_id = '${PROPERTY}'
    `);
    assert.equal(afterRevoke.rows[0].count, 0);
    const organizationAudit = await pg.query<{ organization_id: string }>(`
      select organization_id from public.organization_access_events
      where event_type = 'organizations.insert'
        and target_id = '${organizationId}'
      order by occurred_at desc limit 1
    `);
    assert.equal(organizationAudit.rows[0].organization_id, organizationId);
  });

  test('fails a pending invitation closed when its inviter loses authority', async () => {
    const organization = await pg.query<{ id: string }>(`
      select id from public.organizations where name = 'Northstar Management'
    `);
    const membership = await pg.query<{ id: string }>(`
      select id from public.organization_memberships
      where organization_id = '${organization.rows[0].id}' and account_id = '${INVITEE}'
    `);
    const managerGrant = await pg.query<{ id: string }>(`
      select public.staxis_grant_organization_access(
        '${LEADER}', '${membership.rows[0].id}', 'property_manager', 'property',
        null, '${PROPERTY}', now(), null, 'manual'
      ) as id
    `);
    const tokenHash = 'b'.repeat(64);
    await pg.query(`
      select public.staxis_create_organization_invitation(
        '${INVITEE}', '${organization.rows[0].id}', 'invitee@example.test', '${tokenHash}',
        'other', 'Auditor', 'viewer', 'property', null, '${PROPERTY}',
        now() + interval '1 day', null
      )
    `);

    await pg.query(`
      select public.staxis_revoke_organization_access(
        '${LEADER}', '${managerGrant.rows[0].id}', 'Manager scope removed before acceptance'
      )
    `);
    await assert.rejects(
      pg.query(`
        select * from public.staxis_accept_organization_invitation(
          '${tokenHash}', '${INVITEE}'
        )
      `),
      /inviter no longer has authority/i,
    );

    const invitation = await pg.query<{ status: string }>(`
      select status from public.organization_invitations where token_hash = '${tokenHash}'
    `);
    assert.equal(invitation.rows[0].status, 'pending');
  });

  test('atomically denies or approves access requests with live reviewer authority', async () => {
    const membership = await pg.query<{ id: string }>(`
      select m.id
      from public.organization_memberships m
      join public.organizations o on o.id = m.organization_id
      where m.account_id = '${INVITEE}' and o.name = 'Northstar Management'
    `);

    const deniedRequest = await pg.query<{ request_id: string }>(`
      select public.staxis_create_organization_access_request(
        '${INVITEE}', '${membership.rows[0].id}', 'viewer', 'property',
        'Need temporary reporting visibility', null, '${PROPERTY}'
      ) as request_id
    `);
    await assert.rejects(
      pg.query(`
        select public.staxis_review_organization_access_request(
          '${GM}', '${deniedRequest.rows[0].request_id}', 'denied',
          'Unauthorized reviewer attempt', null
        )
      `),
      /cannot review this requested profile or scope/i,
    );
    const denied = await pg.query<{ grant_id: string | null }>(`
      select public.staxis_review_organization_access_request(
        '${LEADER}', '${deniedRequest.rows[0].request_id}', 'denied',
        'This access is not required', null
      ) as grant_id
    `);
    assert.equal(denied.rows[0].grant_id, null);

    const approvedRequest = await pg.query<{ request_id: string }>(`
      select public.staxis_create_organization_access_request(
        '${INVITEE}', '${membership.rows[0].id}', 'property_manager', 'property',
        'Responsible for this hotel', null, '${PROPERTY}'
      ) as request_id
    `);
    const approved = await pg.query<{ grant_id: string }>(`
      select public.staxis_review_organization_access_request(
        '${LEADER}', '${approvedRequest.rows[0].request_id}', 'approved',
        'Approved after management review', null
      ) as grant_id
    `);
    assert.ok(approved.rows[0].grant_id);

    const state = await pg.query<{
      status: string;
      resulting_grant_id: string;
      grant_status: string;
      source: string;
    }>(`
      select r.status, r.resulting_grant_id, g.status as grant_status, g.source
      from public.organization_access_requests r
      join public.organization_access_grants g on g.id = r.resulting_grant_id
      where r.id = '${approvedRequest.rows[0].request_id}'
    `);
    assert.deepEqual(state.rows[0], {
      status: 'approved',
      resulting_grant_id: approved.rows[0].grant_id,
      grant_status: 'active',
      source: 'access_request',
    });
  });

  test('cancels invitations and suspends/removes memberships with hierarchy, audit, and idempotency', async () => {
    await pg.query(`
      insert into public.accounts (id, role, property_access, created_at)
      values
        ('${LIFECYCLE_OWNER}', 'owner', '{}', now()),
        ('${LIFECYCLE_ADMIN}', 'staff', '{}', now()),
        ('${LIFECYCLE_MEMBER}', 'staff', '{}', now())
    `);
    const organization = await pg.query<{ id: string }>(`
      insert into public.organizations (name, organization_type)
      values ('Lifecycle Test Company', 'management_company') returning id
    `);
    const memberships = await pg.query<{ id: string; account_id: string }>(`
      insert into public.organization_memberships (
        organization_id, account_id, job_category, status
      ) values
        ('${organization.rows[0].id}', '${LIFECYCLE_OWNER}', 'owner_principal', 'active'),
        ('${organization.rows[0].id}', '${LIFECYCLE_ADMIN}', 'operations', 'active'),
        ('${organization.rows[0].id}', '${LIFECYCLE_MEMBER}', 'hotel_employee', 'active')
      returning id, account_id
    `);
    const membershipByAccount = new Map(memberships.rows.map((row) => [row.account_id, row.id]));
    await pg.query(`
      insert into public.organization_access_grants (
        organization_id, membership_id, access_profile, scope_type,
        source, granted_by_account_id
      ) values
        ('${organization.rows[0].id}', '${membershipByAccount.get(LIFECYCLE_OWNER)}',
          'organization_owner', 'organization', 'manual', '${LIFECYCLE_OWNER}'),
        ('${organization.rows[0].id}', '${membershipByAccount.get(LIFECYCLE_ADMIN)}',
          'organization_admin', 'organization', 'manual', '${LIFECYCLE_OWNER}'),
        ('${organization.rows[0].id}', '${membershipByAccount.get(LIFECYCLE_MEMBER)}',
          'viewer', 'organization', 'manual', '${LIFECYCLE_OWNER}')
    `);

    const invitation = await pg.query<{ id: string }>(`
      select public.staxis_create_organization_invitation(
        '${LIFECYCLE_OWNER}', '${organization.rows[0].id}',
        'pending-lifecycle@example.test', '${'4'.repeat(64)}',
        'other', 'Analyst', 'viewer', 'organization', null, null,
        now() + interval '1 day', null
      ) as id
    `);
    const firstCancel = await pg.query<{ changed: boolean }>(`
      select public.staxis_cancel_organization_invitation(
        '${LIFECYCLE_ADMIN}', '${invitation.rows[0].id}',
        'Recipient no longer needs access'
      ) as changed
    `);
    const secondCancel = await pg.query<{ changed: boolean }>(`
      select public.staxis_cancel_organization_invitation(
        '${LIFECYCLE_ADMIN}', '${invitation.rows[0].id}',
        'Recipient no longer needs access'
      ) as changed
    `);
    assert.equal(firstCancel.rows[0].changed, true);
    assert.equal(secondCancel.rows[0].changed, false);

    await assert.rejects(
      pg.query(`
        select public.staxis_change_organization_membership_status(
          '${LIFECYCLE_OWNER}', '${membershipByAccount.get(LIFECYCLE_OWNER)}',
          'suspend', 'Attempted self suspension'
        )
      `),
      /own membership/i,
    );
    await assert.rejects(
      pg.query(`
        select public.staxis_change_organization_membership_status(
          '${LIFECYCLE_ADMIN}', '${membershipByAccount.get(LIFECYCLE_OWNER)}',
          'suspend', 'Peer hierarchy check'
        )
      `),
      /cannot manage owners or peer administrators/i,
    );

    await pg.query(`
      select public.staxis_create_organization_access_request(
        '${LIFECYCLE_MEMBER}', '${membershipByAccount.get(LIFECYCLE_MEMBER)}',
        'contributor', 'organization', 'Need contributor access for reporting',
        null, null
      )
    `);
    const firstSuspend = await pg.query<{ changed: boolean }>(`
      select public.staxis_change_organization_membership_status(
        '${LIFECYCLE_OWNER}', '${membershipByAccount.get(LIFECYCLE_MEMBER)}',
        'suspend', 'Temporary leave of absence'
      ) as changed
    `);
    const secondSuspend = await pg.query<{ changed: boolean }>(`
      select public.staxis_change_organization_membership_status(
        '${LIFECYCLE_OWNER}', '${membershipByAccount.get(LIFECYCLE_MEMBER)}',
        'suspend', 'Temporary leave of absence'
      ) as changed
    `);
    assert.equal(firstSuspend.rows[0].changed, true);
    assert.equal(secondSuspend.rows[0].changed, false);

    await pg.query(`update public.accounts set active = false where id = '${LIFECYCLE_MEMBER}'`);
    await assert.rejects(
      pg.query(`
        select public.staxis_change_organization_membership_status(
          '${LIFECYCLE_OWNER}', '${membershipByAccount.get(LIFECYCLE_MEMBER)}',
          'resume', 'Attempted return for an inactive account'
        )
      `),
      /inactive customer account cannot be resumed/i,
    );
    await pg.query(`update public.accounts set active = true where id = '${LIFECYCLE_MEMBER}'`);

    const firstResume = await pg.query<{ changed: boolean }>(`
      select public.staxis_change_organization_membership_status(
        '${LIFECYCLE_OWNER}', '${membershipByAccount.get(LIFECYCLE_MEMBER)}',
        'resume', 'The team member returned from leave'
      ) as changed
    `);
    const secondResume = await pg.query<{ changed: boolean }>(`
      select public.staxis_change_organization_membership_status(
        '${LIFECYCLE_OWNER}', '${membershipByAccount.get(LIFECYCLE_MEMBER)}',
        'resume', 'The team member returned from leave'
      ) as changed
    `);
    assert.equal(firstResume.rows[0].changed, true);
    assert.equal(secondResume.rows[0].changed, false);
    const resumedState = await pg.query<{
      membership_status: string;
      active_grants: number;
      pending_requests: number;
    }>(`
      select
        m.status as membership_status,
        (select count(*)::int from public.organization_access_grants g
          where g.membership_id = m.id and g.status = 'active') as active_grants,
        (select count(*)::int from public.organization_access_requests r
          where r.membership_id = m.id and r.status = 'pending') as pending_requests
      from public.organization_memberships m
      where m.id = '${membershipByAccount.get(LIFECYCLE_MEMBER)}'
    `);
    assert.deepEqual(resumedState.rows[0], {
      membership_status: 'active',
      active_grants: 1,
      pending_requests: 0,
    });

    const removed = await pg.query<{ changed: boolean }>(`
      select public.staxis_change_organization_membership_status(
        '${LIFECYCLE_OWNER}', '${membershipByAccount.get(LIFECYCLE_MEMBER)}',
        'remove', 'Employment with the company ended'
      ) as changed
    `);
    const removedAgain = await pg.query<{ changed: boolean }>(`
      select public.staxis_change_organization_membership_status(
        '${LIFECYCLE_OWNER}', '${membershipByAccount.get(LIFECYCLE_MEMBER)}',
        'remove', 'Employment with the company ended'
      ) as changed
    `);
    assert.equal(removed.rows[0].changed, true);
    assert.equal(removedAgain.rows[0].changed, false);

    const lifecycleState = await pg.query<{
      membership_status: string;
      ended: boolean;
      active_grants: number;
      pending_requests: number;
      reasoned_events: number;
    }>(`
      select
        m.status as membership_status,
        (m.ended_at is not null) as ended,
        (select count(*)::int from public.organization_access_grants g
          where g.membership_id = m.id and g.status = 'active') as active_grants,
        (select count(*)::int from public.organization_access_requests r
          where r.membership_id = m.id and r.status = 'pending') as pending_requests,
        (select count(*)::int from public.organization_access_events e
          where e.organization_id = m.organization_id
            and e.event_type in (
              'organization_invitation.cancelled',
              'organization_membership.suspended',
              'organization_membership.resumed',
              'organization_membership.removed'
            )
            and nullif(e.metadata->>'reason', '') is not null) as reasoned_events
      from public.organization_memberships m
      where m.id = '${membershipByAccount.get(LIFECYCLE_MEMBER)}'
    `);
    assert.deepEqual(lifecycleState.rows[0], {
      membership_status: 'revoked',
      ended: true,
      active_grants: 0,
      pending_requests: 0,
      reasoned_events: 4,
    });
  });

  test('keeps platform admins outside customer memberships and delegation', async () => {
    const organization = await pg.query<{ id: string }>(`
      select id from public.organizations where name = 'Northstar Management'
    `);
    await pg.query(`insert into auth.users (id, email) values ('${ADMIN_USER}', 'platform@example.test')`);
    await pg.query(`update public.accounts set data_user_id = '${ADMIN_USER}' where id = '${ADMIN}'`);
    await assert.rejects(
      pg.query(`
        select public.staxis_create_organization_invitation(
          '${ADMIN}', '${organization.rows[0].id}', 'customer@example.test', '${'0'.repeat(64)}',
          'other', 'Customer', 'viewer', 'organization', null, null,
          now() + interval '1 day', null
        )
      `),
      /cannot invite this profile or scope/i,
    );
    await assert.rejects(
      pg.query(`
        select public.staxis_bootstrap_organization_leader_invitation(
          '${ADMIN}', '${organization.rows[0].id}', 'platform@example.test', '${'1'.repeat(64)}',
          'executive', 'Platform Admin', 'organization_owner', now() + interval '1 day'
        )
      `),
      /cannot be invited into customer organizations/i,
    );
    await assert.rejects(
      pg.query(`
        insert into public.organization_memberships (
          organization_id, account_id, job_category, status
        ) values ('${organization.rows[0].id}', '${ADMIN}', 'other', 'active')
      `),
      /cannot be customer organization members/i,
    );
    await assert.rejects(
      pg.query(`update public.accounts set role = 'admin' where id = '${INVITEE}'`),
      /revoke customer organization memberships/i,
    );

    await pg.query(`
      insert into public.organization_invitations (
        organization_id, email, token_hash, job_category, job_title,
        access_profile, scope_type, invited_by_account_id, expires_at
      ) values (
        '${organization.rows[0].id}', 'platform@example.test', '${'2'.repeat(64)}',
        'executive', 'Platform Admin', 'organization_owner', 'organization',
        '${ADMIN}', now() + interval '1 day'
      )
    `);
    await assert.rejects(
      pg.query(`
        select * from public.staxis_accept_organization_invitation(
          '${'2'.repeat(64)}', '${ADMIN}'
        )
      `),
      /cannot accept customer organization invitations/i,
    );

    const recovery = await pg.query<{ id: string }>(`
      select public.staxis_bootstrap_organization_leader_invitation(
        '${ADMIN}', '${organization.rows[0].id}', 'recovery@example.test', '${'3'.repeat(64)}',
        'executive', 'Recovery Leader', 'organization_admin', now() + interval '1 day'
      ) as id
    `);
    assert.ok(recovery.rows[0].id, 'explicit platform recovery remains available');
  });

  test('denies every platform mutation when an administrator is deactivated', async () => {
    const organization = await pg.query<{ id: string }>(`
      select id from public.organizations where name = 'Northstar Management'
    `);
    await pg.query(`update public.accounts set active = false where id = '${ADMIN}'`);
    try {
      const attempts = [
        () => pg.query(`select public.staxis_create_organization('${ADMIN}', 'Blocked Company', 'management_company')`),
        () => pg.query(`select public.staxis_reconcile_legacy_organization_access('${ADMIN}', '${PROPERTY}')`),
        () => pg.query(`
          select public.staxis_set_primary_property_organization(
            '${ADMIN}', '${PROPERTY}', '${organization.rows[0].id}', 'operator'
          )
        `),
        () => pg.query(`
          select public.staxis_bootstrap_organization_leader_invitation(
            '${ADMIN}', '${organization.rows[0].id}', 'blocked@example.test',
            '${'4'.repeat(64)}', 'executive', 'Blocked', 'organization_admin',
            now() + interval '1 day'
          )
        `),
      ];
      for (const attempt of attempts) {
        await assert.rejects(attempt(), /only (?:an active|a) Staxis administrator may/i);
      }
    } finally {
      await pg.query(`update public.accounts set active = true where id = '${ADMIN}'`);
    }
  });

  test('transactionally cancels pending first-access requests when an account is deactivated', async () => {
    const requesterAccount = '94949494-9494-9494-9494-949494949494';
    const organization = await pg.query<{ id: string }>(`
      select id from public.organizations where name = 'Northstar Management'
    `);
    await pg.query(`
      insert into public.accounts (id, role, property_access)
      values ('${requesterAccount}', 'staff', '{}')
    `);
    const membership = await pg.query<{ id: string }>(`
      insert into public.organization_memberships (
        organization_id, account_id, job_category, status
      ) values ('${organization.rows[0].id}', '${requesterAccount}', 'other', 'active')
      returning id
    `);
    const request = await pg.query<{ id: string }>(`
      select public.staxis_create_organization_access_request(
        '${requesterAccount}', '${membership.rows[0].id}', 'viewer', 'organization',
        'Need initial company visibility', null, null
      ) as id
    `);

    await pg.query(`update public.accounts set active = false where id = '${requesterAccount}'`);
    const state = await pg.query<{ status: string; review_note: string }>(`
      select status, review_note
      from public.organization_access_requests
      where id = '${request.rows[0].id}'
    `);
    assert.deepEqual(state.rows[0], {
      status: 'cancelled',
      review_note: 'Account deactivated',
    });
  });

  test('reconciles properties and accounts created after migration without duplicates', async () => {
    await pg.query(`insert into public.properties (id, name) values ('${NEW_PROPERTY}', 'Post Migration Hotel')`);
    await pg.query(`insert into public.staff (id, property_id) values ('${NEW_STAFF}', '${NEW_PROPERTY}')`);
    await pg.query(`insert into auth.users (id, email) values ('${NEW_USER}', 'newgm@example.test')`);
    await pg.query(`
      insert into public.accounts (
        id, role, property_access, staff_id, data_user_id, created_at
      ) values (
        '${NEW_ACCOUNT}', 'general_manager', array['${NEW_PROPERTY}'::uuid],
        '${NEW_STAFF}', '${NEW_USER}', now()
      )
    `);

    const reconciled = await pg.query<{
      anchor_count: number;
      relationship_count: number;
      membership_count: number;
      grant_count: number;
      staff_link_count: number;
      effective_count: number;
    }>(`
      select
        (select count(*)::int from public.organizations
          where legacy_property_id = '${NEW_PROPERTY}') as anchor_count,
        (select count(*)::int from public.organization_property_relationships
          where property_id = '${NEW_PROPERTY}' and ends_at is null) as relationship_count,
        (select count(*)::int from public.organization_memberships m
          join public.organizations o on o.id = m.organization_id
          where o.legacy_property_id = '${NEW_PROPERTY}' and m.account_id = '${NEW_ACCOUNT}') as membership_count,
        (select count(*)::int from public.organization_access_grants g
          join public.organization_memberships m on m.id = g.membership_id
          where m.account_id = '${NEW_ACCOUNT}' and g.source = 'legacy_backfill') as grant_count,
        (select count(*)::int from public.account_property_staff_links
          where account_id = '${NEW_ACCOUNT}' and property_id = '${NEW_PROPERTY}') as staff_link_count,
        (select count(*)::int from public.organization_effective_property_access
          where account_id = '${NEW_ACCOUNT}' and property_id = '${NEW_PROPERTY}') as effective_count
    `);
    assert.deepEqual(reconciled.rows[0], {
      anchor_count: 1,
      relationship_count: 1,
      membership_count: 1,
      grant_count: 1,
      staff_link_count: 1,
      effective_count: 1,
    });

    // A legacy role change must rotate only the automatic grant. Otherwise a
    // former GM would retain property_manager delegation in Company Hub after
    // being demoted in the existing hotel-team UI.
    await pg.query(`update public.accounts set role = 'staff' where id = '${NEW_ACCOUNT}'`);
    const demotedLegacy = await pg.query<{
      job_category: string;
      job_title: string;
      active_profiles: string[];
      revoked_manager_grants: number;
    }>(`
      select
        m.job_category,
        m.job_title,
        array_agg(g.access_profile order by g.access_profile)
          filter (where g.status = 'active') as active_profiles,
        count(*) filter (
          where g.access_profile = 'property_manager' and g.status = 'revoked'
        )::int as revoked_manager_grants
      from public.organization_memberships m
      join public.organizations o on o.id = m.organization_id
      join public.organization_access_grants g on g.membership_id = m.id
      where o.legacy_property_id = '${NEW_PROPERTY}'
        and m.account_id = '${NEW_ACCOUNT}'
        and m.ended_at is null
      group by m.job_category, m.job_title
    `);
    assert.deepEqual(demotedLegacy.rows[0], {
      job_category: 'other',
      job_title: 'Staff',
      active_profiles: ['contributor'],
      revoked_manager_grants: 1,
    });

    // Removing the hotel retires the legacy grant, staff link, and now-orphaned
    // hidden-anchor membership. Re-adding it creates/reactivates exactly one of
    // each, proving the delta reconciliation is reversible and idempotent.
    await pg.query(`update public.accounts set property_access = '{}' where id = '${NEW_ACCOUNT}'`);
    const removedLegacy = await pg.query<{
      active_legacy_grants: number;
      current_memberships: number;
      active_staff_links: number;
      effective_count: number;
    }>(`
      select
        (select count(*)::int
         from public.organization_access_grants g
         join public.organization_memberships m on m.id = g.membership_id
         join public.organizations o on o.id = m.organization_id
         where o.legacy_property_id = '${NEW_PROPERTY}'
           and m.account_id = '${NEW_ACCOUNT}'
           and g.source = 'legacy_backfill' and g.status = 'active') as active_legacy_grants,
        (select count(*)::int
         from public.organization_memberships m
         join public.organizations o on o.id = m.organization_id
         where o.legacy_property_id = '${NEW_PROPERTY}'
           and m.account_id = '${NEW_ACCOUNT}' and m.ended_at is null) as current_memberships,
        (select count(*)::int from public.account_property_staff_links
         where account_id = '${NEW_ACCOUNT}' and property_id = '${NEW_PROPERTY}'
           and is_active) as active_staff_links,
        (select count(*)::int from public.organization_effective_property_access
         where account_id = '${NEW_ACCOUNT}' and property_id = '${NEW_PROPERTY}') as effective_count
    `);
    assert.deepEqual(removedLegacy.rows[0], {
      active_legacy_grants: 0,
      current_memberships: 0,
      active_staff_links: 0,
      effective_count: 0,
    });

    await pg.query(`
      update public.accounts
      set property_access = array['${NEW_PROPERTY}'::uuid]
      where id = '${NEW_ACCOUNT}'
    `);
    const restoredLegacy = await pg.query<{
      active_legacy_grants: number;
      current_memberships: number;
      active_staff_links: number;
      effective_count: number;
    }>(`
      select
        (select count(*)::int
         from public.organization_access_grants g
         join public.organization_memberships m on m.id = g.membership_id
         join public.organizations o on o.id = m.organization_id
         where o.legacy_property_id = '${NEW_PROPERTY}'
           and m.account_id = '${NEW_ACCOUNT}'
           and g.source = 'legacy_backfill' and g.status = 'active') as active_legacy_grants,
        (select count(*)::int
         from public.organization_memberships m
         join public.organizations o on o.id = m.organization_id
         where o.legacy_property_id = '${NEW_PROPERTY}'
           and m.account_id = '${NEW_ACCOUNT}' and m.ended_at is null) as current_memberships,
        (select count(*)::int from public.account_property_staff_links
         where account_id = '${NEW_ACCOUNT}' and property_id = '${NEW_PROPERTY}'
           and is_active) as active_staff_links,
        (select count(*)::int from public.organization_effective_property_access
         where account_id = '${NEW_ACCOUNT}' and property_id = '${NEW_PROPERTY}') as effective_count
    `);
    assert.deepEqual(restoredLegacy.rows[0], {
      active_legacy_grants: 1,
      current_memberships: 1,
      active_staff_links: 1,
      effective_count: 1,
    });

    const systemAudit = await pg.query<{ actor_kind: string; actor_account_id: string | null }>(`
      select actor_kind, actor_account_id
      from public.organization_access_events
      where event_type = 'organization_memberships.insert'
        and after_state->>'account_id' = '${NEW_ACCOUNT}'
      order by occurred_at desc limit 1
    `);
    assert.deepEqual(systemAudit.rows[0], { actor_kind: 'system', actor_account_id: null });

    await pg.query(`
      insert into auth.users (id, email)
      values ('${DEMOTED_USER}', 'former-admin@example.test')
    `);
    await pg.query(`
      insert into public.accounts (
        id, role, property_access, data_user_id, created_at
      ) values (
        '${DEMOTED_ACCOUNT}', 'admin', array['${NEW_PROPERTY}'::uuid],
        '${DEMOTED_USER}', now()
      )
    `);
    const beforeDemotion = await pg.query<{ count: number }>(`
      select count(*)::int as count
      from public.organization_memberships
      where account_id = '${DEMOTED_ACCOUNT}'
    `);
    assert.equal(beforeDemotion.rows[0].count, 0);
    await pg.query(`update public.accounts set role = 'staff' where id = '${DEMOTED_ACCOUNT}'`);
    const afterDemotion = await pg.query<{ count: number }>(`
      select count(*)::int as count
      from public.organization_effective_property_access
      where account_id = '${DEMOTED_ACCOUNT}' and property_id = '${NEW_PROPERTY}'
    `);
    assert.equal(afterDemotion.rows[0].count, 1);

    const before = await pg.query<{ memberships: number; grants: number }>(`
      select
        (select count(*)::int from public.organization_memberships) as memberships,
        (select count(*)::int from public.organization_access_grants) as grants
    `);
    await pg.query(`select public.staxis_reconcile_legacy_organization_access('${ADMIN}', '${NEW_PROPERTY}')`);
    await pg.query(`select public.staxis_reconcile_legacy_organization_access('${ADMIN}', '${NEW_PROPERTY}')`);
    const after = await pg.query<{ memberships: number; grants: number }>(`
      select
        (select count(*)::int from public.organization_memberships) as memberships,
        (select count(*)::int from public.organization_access_grants) as grants
    `);
    assert.deepEqual(after.rows[0], before.rows[0]);
  });

  test('fails portfolio access and delegation closed for future assignments and archived portfolios', async () => {
    const organization = await pg.query<{ id: string }>(`
      select id from public.organizations where name = 'Northstar Management'
    `);
    await pg.query(`
      select public.staxis_set_primary_property_organization(
        '${ADMIN}', '${NEW_PROPERTY}', '${organization.rows[0].id}', 'operator'
      )
    `);
    const relationships = await pg.query<{ property_id: string; id: string }>(`
      select property_id, id from public.organization_property_relationships
      where organization_id = '${organization.rows[0].id}'
        and property_id in ('${PROPERTY}', '${NEW_PROPERTY}')
        and is_primary_grouping and ends_at is null
    `);
    const relationshipByProperty = new Map(
      relationships.rows.map((row) => [row.property_id, row.id]),
    );
    const portfolio = await pg.query<{ id: string }>(`
      insert into public.portfolios (organization_id, name, portfolio_type)
      values ('${organization.rows[0].id}', 'North Region', 'region') returning id
    `);
    await pg.query(`
      insert into public.portfolio_properties (
        organization_id, portfolio_id, property_relationship_id, property_id, assigned_at
      ) values
        ('${organization.rows[0].id}', '${portfolio.rows[0].id}',
         '${relationshipByProperty.get(PROPERTY)}', '${PROPERTY}', now()),
        ('${organization.rows[0].id}', '${portfolio.rows[0].id}',
         '${relationshipByProperty.get(NEW_PROPERTY)}', '${NEW_PROPERTY}', now() + interval '1 day')
    `);
    const membership = await pg.query<{ id: string }>(`
      select id from public.organization_memberships
      where organization_id = '${organization.rows[0].id}' and account_id = '${INVITEE}'
    `);
    const grant = await pg.query<{ id: string }>(`
      select public.staxis_grant_organization_access(
        '${LEADER}', '${membership.rows[0].id}', 'portfolio_manager', 'portfolio',
        '${portfolio.rows[0].id}', null, now(), null, 'manual'
      ) as id
    `);
    await pg.query(`
      update public.organization_access_grants
         set status = 'revoked',
             revoked_at = now(),
             revoked_by_account_id = '${LEADER}',
             revocation_reason = 'Isolate portfolio authority test'
       where membership_id = '${membership.rows[0].id}'
         and id <> '${grant.rows[0].id}'
         and status = 'active'
    `);

    const beforeArchive = await pg.query<{ property_id: string }>(`
      select property_id from public.organization_effective_property_access
      where grant_id = '${grant.rows[0].id}' order by property_id
    `);
    assert.deepEqual(beforeArchive.rows, [{ property_id: PROPERTY }]);
    const futureDelegation = await pg.query<{ allowed: boolean }>(`
      select public._staxis_can_delegate_organization_access(
        '${INVITEE}', '${organization.rows[0].id}', 'viewer', 'property',
        null, '${NEW_PROPERTY}'
      ) as allowed
    `);
    assert.equal(futureDelegation.rows[0].allowed, false);

    await pg.query(`update public.portfolios set status = 'archived' where id = '${portfolio.rows[0].id}'`);
    const archivedAccess = await pg.query<{ count: number }>(`
      select count(*)::int as count from public.organization_effective_property_access
      where grant_id = '${grant.rows[0].id}'
    `);
    assert.equal(archivedAccess.rows[0].count, 0);
    const archivedDelegation = await pg.query<{ allowed: boolean }>(`
      select public._staxis_can_delegate_organization_access(
        '${INVITEE}', '${organization.rows[0].id}', 'viewer', 'property',
        null, '${PROPERTY}'
      ) as allowed
    `);
    assert.equal(archivedDelegation.rows[0].allowed, false);
  });

  test('retires expired invitations and grants before a same-scope renewal', async () => {
    const organization = await pg.query<{ id: string }>(`
      select id from public.organizations where name = 'Northstar Management'
    `);
    const oldInviteToken = 'e'.repeat(64);
    const newInviteToken = 'f'.repeat(64);
    await pg.query(`
      insert into public.organization_invitations (
        organization_id, email, token_hash, job_category, job_title,
        access_profile, scope_type, invited_by_account_id, created_at, expires_at
      ) values (
        '${organization.rows[0].id}', 'renew@example.test', '${oldInviteToken}',
        'consultant', 'Auditor', 'viewer', 'organization', '${LEADER}',
        now() - interval '2 days', now() - interval '1 day'
      )
    `);
    await pg.query(`
      select public.staxis_create_organization_invitation(
        '${LEADER}', '${organization.rows[0].id}', 'renew@example.test', '${newInviteToken}',
        'consultant', 'Auditor', 'viewer', 'organization', null, null,
        now() + interval '1 day', null
      )
    `);
    const inviteStates = await pg.query<{ token_hash: string; status: string }>(`
      select token_hash, status from public.organization_invitations
      where token_hash in ('${oldInviteToken}', '${newInviteToken}') order by token_hash
    `);
    assert.deepEqual(inviteStates.rows, [
      { token_hash: oldInviteToken, status: 'revoked' },
      { token_hash: newInviteToken, status: 'pending' },
    ]);

    const membership = await pg.query<{ id: string }>(`
      select id from public.organization_memberships
      where organization_id = '${organization.rows[0].id}' and account_id = '${INVITEE}'
    `);
    const relationship = await pg.query<{ id: string }>(`
      select id from public.organization_property_relationships
      where organization_id = '${organization.rows[0].id}'
        and property_id = '${PROPERTY}' and is_primary_grouping and ends_at is null
    `);
    const expired = await pg.query<{ id: string }>(`
      insert into public.organization_access_grants (
        organization_id, membership_id, access_profile, scope_type,
        property_relationship_id, property_id, starts_at, expires_at,
        source, granted_by_account_id
      ) values (
        '${organization.rows[0].id}', '${membership.rows[0].id}',
        'external_collaborator', 'property', '${relationship.rows[0].id}', '${PROPERTY}',
        now() - interval '2 days', now() - interval '1 day', 'manual', '${LEADER}'
      ) returning id
    `);
    const expiredEffective = await pg.query<{ count: number }>(`
      select count(*)::int as count
      from public.organization_effective_property_access
      where account_id = '${INVITEE}' and property_id = '${PROPERTY}'
    `);
    assert.equal(expiredEffective.rows[0].count, 0);
    const renewed = await pg.query<{ id: string }>(`
      select public.staxis_grant_organization_access(
        '${LEADER}', '${membership.rows[0].id}', 'external_collaborator', 'property',
        null, '${PROPERTY}', now(), now() + interval '1 day', 'manual'
      ) as id
    `);
    assert.notEqual(renewed.rows[0].id, expired.rows[0].id);
    const renewedEffective = await pg.query<{ count: number }>(`
      select count(*)::int as count
      from public.organization_effective_property_access
      where account_id = '${INVITEE}' and property_id = '${PROPERTY}'
    `);
    assert.equal(renewedEffective.rows[0].count, 1);
    const oldGrant = await pg.query<{
      status: string;
      revoked_by_account_id: string;
      revocation_reason: string;
    }>(`
      select status, revoked_by_account_id, revocation_reason
      from public.organization_access_grants where id = '${expired.rows[0].id}'
    `);
    assert.equal(oldGrant.rows[0].status, 'revoked');
    assert.equal(oldGrant.rows[0].revoked_by_account_id, LEADER);
    assert.match(oldGrant.rows[0].revocation_reason, /expired grant/i);
    await assert.rejects(
      pg.query(
        `select public.staxis_revoke_organization_access($1, $2, null)`,
        [LEADER, renewed.rows[0].id],
      ),
      /revocation reason is required/i,
    );
  });

  test('guards owner timing changes but permits deliberate cleanup after suspension', async () => {
    const organization = await pg.query<{ id: string }>(`
      select id from public.organizations where name = 'Northstar Management'
    `);
    const owner = await pg.query<{ membership_id: string; grant_id: string }>(`
      select m.id as membership_id, g.id as grant_id
      from public.organization_memberships m
      join public.organization_access_grants g on g.membership_id = m.id
      where m.organization_id = '${organization.rows[0].id}'
        and m.account_id = '${LEADER}' and g.access_profile = 'organization_owner'
        and g.status = 'active'
    `);

    await pg.exec('begin');
    try {
      await assert.rejects(
        pg.query(`update public.organization_access_grants
          set starts_at = now() + interval '1 day' where id = '${owner.rows[0].grant_id}'`),
        /final active organization owner/i,
      );
    } finally {
      await pg.exec('rollback');
    }

    await pg.exec('begin');
    try {
      await assert.rejects(
        pg.query(`update public.organization_memberships
          set starts_at = now() + interval '1 day' where id = '${owner.rows[0].membership_id}'`),
        /final active organization owner/i,
      );
    } finally {
      await pg.exec('rollback');
    }

    await pg.exec('begin');
    try {
      await pg.query(`update public.organizations set status = 'suspended'
        where id = '${organization.rows[0].id}'`);
      await pg.query(`update public.organization_access_grants
        set status = 'revoked', revoked_at = now(), revoked_by_account_id = '${ADMIN}',
            revocation_reason = 'Suspended organization cleanup'
        where id = '${owner.rows[0].grant_id}'`);
      const state = await pg.query<{ status: string }>(`
        select status from public.organization_access_grants where id = '${owner.rows[0].grant_id}'
      `);
      assert.equal(state.rows[0].status, 'revoked');
    } finally {
      await pg.exec('rollback');
    }
  });

  test('removes direct service-role writes while preserving scoped RPC execution', async () => {
    const deniedStatements = [
      `insert into public.organizations (name, organization_type)
       values ('Bypass Org', 'management_company')`,
      `insert into public.organization_access_events (
         actor_kind, event_type, target_type, metadata
       ) values ('system', 'forged.event', 'test', '{"forged":true}'::jsonb)`,
    ];
    for (const statement of deniedStatements) {
      await pg.exec('begin');
      try {
        await pg.exec('set local role service_role');
        await assert.rejects(pg.query(statement), /permission denied/i);
      } finally {
        await pg.exec('rollback');
      }
    }

    await pg.exec('begin');
    try {
      await pg.exec('set local role service_role');
      const selected = await pg.query<{ count: number }>(`
        select count(*)::int as count from public.organizations
      `);
      assert.ok(selected.rows[0].count > 0);
      const viaRpc = await pg.query<{ id: string }>(`
        select public.staxis_create_organization(
          '${ADMIN}', 'RPC Only Org', 'management_company'
        ) as id
      `);
      assert.ok(viaRpc.rows[0].id);
    } finally {
      await pg.exec('rollback');
    }
  });

  test('uses one organization lock across every customer access mutation', async () => {
    const functions = await pg.query<{ proname: string; prosrc: string }>(`
      select p.proname, p.prosrc
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in (
        '_staxis_reconcile_legacy_organization_access',
        'staxis_set_primary_property_organization',
        'staxis_grant_organization_access',
        'staxis_revoke_organization_access',
        'staxis_create_organization_invitation',
        'staxis_bootstrap_organization_leader_invitation',
        'staxis_accept_organization_invitation',
        'staxis_create_organization_access_request',
        'staxis_review_organization_access_request'
      )
    `);
    assert.equal(functions.rows.length, 9);
    for (const fn of functions.rows) {
      assert.match(
        fn.prosrc,
        /_staxis_lock_organization/,
        `${fn.proname} must serialize its authority check and write`,
      );
      assert.doesNotMatch(fn.prosrc, /staxis_support_sessions/);
    }

    const delegation = await pg.query<{ prosrc: string }>(`
      select p.prosrc from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = '_staxis_can_delegate_organization_access'
    `);
    assert.doesNotMatch(delegation.rows[0].prosrc, /role\s*=\s*'admin'/i);
  });

  test('cancels stale relationship work instead of rebinding it after a hotel move', async () => {
    const organization = await pg.query<{ id: string }>(`
      select id from public.organizations where name = 'Northstar Management'
    `);
    const membership = await pg.query<{ id: string }>(`
      select id from public.organization_memberships
      where organization_id = '${organization.rows[0].id}' and account_id = '${INVITEE}'
    `);
    const oldRelationship = await pg.query<{ id: string; relationship_type: string }>(`
      select id, relationship_type from public.organization_property_relationships
      where organization_id = '${organization.rows[0].id}'
        and property_id = '${PROPERTY}' and is_primary_grouping and ends_at is null
    `);
    const request = await pg.query<{ id: string }>(`
      select public.staxis_create_organization_access_request(
        '${INVITEE}', '${membership.rows[0].id}', 'viewer', 'property',
        'Need access before the hotel move', null, '${PROPERTY}'
      ) as id
    `);
    const token = '6'.repeat(64);
    await pg.query(`
      select public.staxis_create_organization_invitation(
        '${LEADER}', '${organization.rows[0].id}', 'scopechange@example.test', '${token}',
        'consultant', 'Consultant', 'contributor', 'property', null, '${PROPERTY}',
        now() + interval '1 day', null
      )
    `);

    const nextType = oldRelationship.rows[0].relationship_type === 'owner' ? 'operator' : 'owner';
    const moved = await pg.query<{ id: string }>(`
      select public.staxis_set_primary_property_organization(
        '${ADMIN}', '${PROPERTY}', '${organization.rows[0].id}', '${nextType}'
      ) as id
    `);
    assert.notEqual(moved.rows[0].id, oldRelationship.rows[0].id);

    const states = await pg.query<{ request_status: string; invitation_status: string }>(`
      select
        (select status from public.organization_access_requests
          where id = '${request.rows[0].id}') as request_status,
        (select status from public.organization_invitations
          where token_hash = '${token}') as invitation_status
    `);
    assert.deepEqual(states.rows[0], {
      request_status: 'cancelled',
      invitation_status: 'revoked',
    });
    await assert.rejects(
      pg.query(`
        select public.staxis_review_organization_access_request(
          '${LEADER}', '${request.rows[0].id}', 'approved', 'Too late', null
        )
      `),
      /already been reviewed/i,
    );
    const oldDependencies = await pg.query<{ active_grants: number; open_assignments: number }>(`
      select
        (select count(*)::int from public.organization_access_grants
          where property_relationship_id = '${oldRelationship.rows[0].id}' and status = 'active')
          as active_grants,
        (select count(*)::int from public.portfolio_properties
          where property_relationship_id = '${oldRelationship.rows[0].id}' and removed_at is null)
          as open_assignments
    `);
    assert.deepEqual(oldDependencies.rows[0], { active_grants: 0, open_assignments: 0 });

    const freshRequest = await pg.query<{ id: string }>(`
      select public.staxis_create_organization_access_request(
        '${INVITEE}', '${membership.rows[0].id}', 'viewer', 'property',
        'Fresh request for the new relationship', null, '${PROPERTY}'
      ) as id
    `);
    assert.ok(freshRequest.rows[0].id);
  });

  test('deletes a hotel, hidden anchor, and legacy-only accounts in one transaction', async () => {
    await pg.exec(`
      insert into public.properties (id, name, onboarding_completed_at)
      values ('${DELETE_PROPERTY}', 'Delete Transaction Test', now());
      insert into auth.users (id, email)
      values
        ('${DELETE_USER}', 'delete-me@example.test'),
        ('${PRESERVED_USER}', 'preserve-me@example.test');
      insert into public.accounts (id, role, property_access, data_user_id)
      values
        ('${DELETE_ACCOUNT}', 'owner', array['${DELETE_PROPERTY}'::uuid], '${DELETE_USER}'),
        ('${PRESERVED_ACCOUNT}', 'staff', array['${DELETE_PROPERTY}'::uuid], '${PRESERVED_USER}');

      with company as (
        insert into public.organizations (name, organization_type)
        values ('Preserved Company', 'management_company') returning id
      )
      insert into public.organization_memberships (
        organization_id, account_id, job_category, status
      )
      select id, '${PRESERVED_ACCOUNT}', 'operations', 'active' from company;

      -- Simulate a rename after an administrator read the confirmation name.
      update public.properties
      set name = 'Renamed Delete Transaction Test'
      where id = '${DELETE_PROPERTY}';
    `);

    await assert.rejects(
      pg.query(`
        select public.staxis_delete_property_and_legacy_accounts(
          '${ADMIN}', '${DELETE_PROPERTY}', 'Delete Transaction Test'
        )
      `),
      /confirmed hotel name does not match/i,
    );
    const survivedStaleConfirmation = await pg.query<{ count: number }>(`
      select count(*)::int as count from public.properties where id = '${DELETE_PROPERTY}'
    `);
    assert.equal(survivedStaleConfirmation.rows[0].count, 1);

    const result = await pg.query<{ result: { accountsRemoved: number; authUserIds: string[] } }>(`
      select public.staxis_delete_property_and_legacy_accounts(
        '${ADMIN}', '${DELETE_PROPERTY}', 'Renamed Delete Transaction Test'
      ) as result
    `);
    assert.equal(result.rows[0].result.accountsRemoved, 1);
    assert.deepEqual(result.rows[0].result.authUserIds, [DELETE_USER]);

    const remaining = await pg.query<{
      properties: number;
      organizations: number;
      accounts: number;
      preserved_accounts: number;
      preserved_property_access: string[];
      preserved_memberships: number;
    }>(`
      select
        (select count(*)::int from public.properties where id = '${DELETE_PROPERTY}') as properties,
        (select count(*)::int from public.organizations where legacy_property_id = '${DELETE_PROPERTY}') as organizations,
        (select count(*)::int from public.accounts where id = '${DELETE_ACCOUNT}') as accounts,
        (select count(*)::int from public.accounts where id = '${PRESERVED_ACCOUNT}') as preserved_accounts,
        (select property_access from public.accounts where id = '${PRESERVED_ACCOUNT}') as preserved_property_access,
        (select count(*)::int from public.organization_memberships where account_id = '${PRESERVED_ACCOUNT}') as preserved_memberships
    `);
    assert.deepEqual(remaining.rows[0], {
      properties: 0,
      organizations: 0,
      accounts: 0,
      preserved_accounts: 1,
      preserved_property_access: [],
      preserved_memberships: 1,
    });
  });

  test('bounds Company Hub feed visibility by tenant and live hotel scope', async () => {
    await pg.exec(`
      insert into public.properties (id, name) values
        ('${FEED_ALLOWED_PROPERTY}', 'Feed Allowed Hotel'),
        ('${FEED_DENIED_PROPERTY}', 'Feed Neighbor Hotel'),
        ('${FEED_FOREIGN_PROPERTY}', 'Feed Foreign Hotel');
      insert into auth.users (id, email) values
        ('${FEED_TARGET_A}', 'feed-target-a@example.test'),
        ('${FEED_TARGET_B}', 'feed-target-b@example.test');
      insert into public.accounts (
        id, role, display_name, property_access, data_user_id
      ) values
        ('${FEED_SCOPED_ACTOR}', 'staff', 'Scoped Feed Manager', '{}', null),
        ('${FEED_OWNER_A}', 'staff', 'Feed Owner A', '{}', null),
        ('${FEED_OWNER_B}', 'staff', 'Feed Owner B', '{}', null),
        ('${FEED_TARGET_A}', 'staff', 'Feed Target A', '{}', '${FEED_TARGET_A}'),
        ('${FEED_TARGET_B}', 'staff', 'Feed Target B', '{}', '${FEED_TARGET_B}');
    `);

    const organizations = await pg.query<{ id: string; name: string }>(`
      insert into public.organizations (name, organization_type) values
        ('Feed Company A', 'management_company'),
        ('Feed Company B', 'management_company')
      returning id, name
    `);
    const organizationA = organizations.rows.find((row) => row.name === 'Feed Company A')!.id;
    const organizationB = organizations.rows.find((row) => row.name === 'Feed Company B')!.id;

    const relationships = await pg.query<{ id: string; organization_id: string; property_id: string }>(`
      insert into public.organization_property_relationships (
        organization_id, property_id, relationship_type, is_primary_grouping
      ) values
        ('${organizationA}', '${FEED_ALLOWED_PROPERTY}', 'operator', false),
        ('${organizationA}', '${FEED_DENIED_PROPERTY}', 'operator', false),
        ('${organizationB}', '${FEED_FOREIGN_PROPERTY}', 'operator', false)
      returning id, organization_id, property_id
    `);
    const relationshipFor = (organizationId: string, propertyId: string) => (
      relationships.rows.find((row) => (
        row.organization_id === organizationId && row.property_id === propertyId
      ))!.id
    );
    const allowedRelationship = relationshipFor(organizationA, FEED_ALLOWED_PROPERTY);
    const deniedRelationship = relationshipFor(organizationA, FEED_DENIED_PROPERTY);
    const foreignRelationship = relationshipFor(organizationB, FEED_FOREIGN_PROPERTY);

    const memberships = await pg.query<{ id: string; organization_id: string; account_id: string }>(`
      insert into public.organization_memberships (
        organization_id, account_id, job_category, status
      ) values
        ('${organizationA}', '${FEED_OWNER_A}', 'owner_principal', 'active'),
        ('${organizationA}', '${FEED_SCOPED_ACTOR}', 'general_manager', 'active'),
        ('${organizationA}', '${FEED_TARGET_A}', 'hotel_employee', 'active'),
        ('${organizationB}', '${FEED_OWNER_B}', 'owner_principal', 'active'),
        ('${organizationB}', '${FEED_TARGET_B}', 'hotel_employee', 'active')
      returning id, organization_id, account_id
    `);
    const membershipFor = (organizationId: string, accountId: string) => (
      memberships.rows.find((row) => (
        row.organization_id === organizationId && row.account_id === accountId
      ))!.id
    );
    const ownerMembershipA = membershipFor(organizationA, FEED_OWNER_A);
    const scopedMembership = membershipFor(organizationA, FEED_SCOPED_ACTOR);
    const targetMembershipA = membershipFor(organizationA, FEED_TARGET_A);
    const ownerMembershipB = membershipFor(organizationB, FEED_OWNER_B);
    const targetMembershipB = membershipFor(organizationB, FEED_TARGET_B);

    await pg.exec(`
      insert into public.organization_access_grants (
        organization_id, membership_id, access_profile, scope_type,
        property_relationship_id, property_id, source, granted_by_account_id
      ) values
        ('${organizationA}', '${ownerMembershipA}', 'organization_owner',
          'organization', null, null, 'manual', '${FEED_OWNER_A}'),
        ('${organizationA}', '${scopedMembership}', 'property_manager',
          'property', '${allowedRelationship}', '${FEED_ALLOWED_PROPERTY}',
          'manual', '${FEED_OWNER_A}'),
        ('${organizationB}', '${ownerMembershipB}', 'organization_owner',
          'organization', null, null, 'manual', '${FEED_OWNER_B}');
    `);

    const createInvitation = async (
      ownerId: string,
      organizationId: string,
      email: string,
      tokenLabel: string,
      propertyId: string,
    ): Promise<string> => {
      const tokenHash = createHash('sha256').update(tokenLabel).digest('hex');
      const result = await pg.query<{ id: string }>(`
        select public.staxis_create_organization_invitation(
          '${ownerId}', '${organizationId}', '${email}',
          '${tokenHash}',
          'other', 'Feed Test', 'viewer', 'property', null, '${propertyId}',
          now() + interval '1 day', null
        ) as id
      `);
      return result.rows[0].id;
    };

    const pendingAllowed = await createInvitation(
      FEED_OWNER_A,
      organizationA,
      'feed-pending-allowed@example.test',
      'feed-pending-allowed',
      FEED_ALLOWED_PROPERTY,
    );
    const pendingDenied = await createInvitation(
      FEED_OWNER_A,
      organizationA,
      'feed-pending-denied@example.test',
      'feed-pending-denied',
      FEED_DENIED_PROPERTY,
    );
    const pendingForeign = await createInvitation(
      FEED_OWNER_B,
      organizationB,
      'feed-pending-foreign@example.test',
      'feed-pending-foreign',
      FEED_FOREIGN_PROPERTY,
    );

    const acceptedAllowed = await createInvitation(
      FEED_OWNER_A,
      organizationA,
      'feed-target-a@example.test',
      'feed-accepted-allowed',
      FEED_ALLOWED_PROPERTY,
    );
    const acceptedAllowedResult = await pg.query<{ grant_id: string }>(`
      select grant_id from public.staxis_accept_organization_invitation(
        '${createHash('sha256').update('feed-accepted-allowed').digest('hex')}',
        '${FEED_TARGET_A}'
      )
    `);
    const revokedAllowedGrant = acceptedAllowedResult.rows[0].grant_id;
    await pg.query(`
      select public.staxis_revoke_organization_access(
        '${FEED_OWNER_A}', '${revokedAllowedGrant}',
        'Retained for scoped feed history'
      )
    `);

    const acceptedDenied = await createInvitation(
      FEED_OWNER_A,
      organizationA,
      'feed-target-a@example.test',
      'feed-accepted-denied',
      FEED_DENIED_PROPERTY,
    );
    const acceptedDeniedResult = await pg.query<{ grant_id: string }>(`
      select grant_id from public.staxis_accept_organization_invitation(
        '${createHash('sha256').update('feed-accepted-denied').digest('hex')}',
        '${FEED_TARGET_A}'
      )
    `);
    const revokedDeniedGrant = acceptedDeniedResult.rows[0].grant_id;
    await pg.query(`
      select public.staxis_revoke_organization_access(
        '${FEED_OWNER_A}', '${revokedDeniedGrant}',
        'Neighbor hotel history must stay private'
      )
    `);

    const cancelledAllowed = await createInvitation(
      FEED_OWNER_A,
      organizationA,
      'feed-cancelled-allowed@example.test',
      'feed-cancelled-allowed',
      FEED_ALLOWED_PROPERTY,
    );
    await pg.query(`
      select public.staxis_cancel_organization_invitation(
        '${FEED_OWNER_A}', '${cancelledAllowed}', 'Cancelled feed visibility test'
      )
    `);
    const cancelledDenied = await createInvitation(
      FEED_OWNER_A,
      organizationA,
      'feed-cancelled-denied@example.test',
      'feed-cancelled-denied',
      FEED_DENIED_PROPERTY,
    );
    await pg.query(`
      select public.staxis_cancel_organization_invitation(
        '${FEED_OWNER_A}', '${cancelledDenied}', 'Cancelled neighboring hotel test'
      )
    `);

    const allowedRequest = await pg.query<{ id: string }>(`
      select public.staxis_create_organization_access_request(
        '${FEED_TARGET_A}', '${targetMembershipA}', 'viewer', 'property',
        'Allowed hotel request for feed visibility', null, '${FEED_ALLOWED_PROPERTY}'
      ) as id
    `);
    const deniedRequest = await pg.query<{ id: string }>(`
      select public.staxis_create_organization_access_request(
        '${FEED_TARGET_A}', '${targetMembershipA}', 'viewer', 'property',
        'Neighbor hotel request must remain private', null, '${FEED_DENIED_PROPERTY}'
      ) as id
    `);
    const foreignRequest = await pg.query<{ id: string }>(`
      select public.staxis_create_organization_access_request(
        '${FEED_TARGET_B}', '${targetMembershipB}', 'viewer', 'property',
        'Foreign tenant request must remain private', null, '${FEED_FOREIGN_PROPERTY}'
      ) as id
    `);

    interface FeedActivityRow {
      organization_id: string;
      actor_display_name: string | null;
      event_type: string;
      target_type: string;
      target_id: string | null;
      full_organization_scope: boolean;
      authorized_property_ids: string[];
    }
    interface FeedResult {
      invitations: Array<{ id: string; organization_id: string }>;
      requests: Array<{ id: string; organization_id: string }>;
      activity: FeedActivityRow[];
    }
    const loadFeedAsService = async (accountId: string): Promise<FeedResult> => {
      await pg.exec('begin');
      try {
        await pg.exec('set local role service_role');
        const result = await pg.query<{ feed: FeedResult }>(`
          select public.staxis_company_access_feed('${accountId}', 200) as feed
        `);
        return result.rows[0].feed;
      } finally {
        await pg.exec('rollback');
      }
    };

    const scopedFeed = await loadFeedAsService(FEED_SCOPED_ACTOR);
    const scopedInvitationIds = new Set(scopedFeed.invitations.map((row) => row.id));
    assert.equal(scopedInvitationIds.has(pendingAllowed), true);
    assert.equal(scopedInvitationIds.has(pendingDenied), false);
    assert.equal(scopedInvitationIds.has(pendingForeign), false);
    assert.ok(scopedFeed.invitations.every((row) => row.organization_id === organizationA));

    const scopedRequestIds = new Set(scopedFeed.requests.map((row) => row.id));
    assert.equal(scopedRequestIds.has(allowedRequest.rows[0].id), true);
    assert.equal(scopedRequestIds.has(deniedRequest.rows[0].id), false);
    assert.equal(scopedRequestIds.has(foreignRequest.rows[0].id), false);
    assert.ok(scopedFeed.requests.every((row) => row.organization_id === organizationA));

    assert.ok(scopedFeed.activity.some((row) => (
      row.target_id === acceptedAllowed
      && row.event_type === 'organization_invitations.update'
    )), 'accepted invitation history in the managed hotel must remain visible');
    assert.ok(scopedFeed.activity.some((row) => (
      row.target_id === cancelledAllowed
      && row.event_type === 'organization_invitation.cancelled'
    )), 'cancelled invitation history in the managed hotel must remain visible');
    assert.ok(scopedFeed.activity.some((row) => (
      row.target_id === revokedAllowedGrant
      && row.event_type === 'organization_access_grants.update'
    )), 'revoked grant history in the managed hotel must remain visible');
    assert.ok(scopedFeed.activity.some((row) => row.actor_display_name === 'Feed Owner A'));

    const forbiddenTargetIds = new Set([
      pendingDenied,
      pendingForeign,
      acceptedDenied,
      revokedDeniedGrant,
      cancelledDenied,
      deniedRequest.rows[0].id,
      foreignRequest.rows[0].id,
    ]);
    assert.ok(scopedFeed.activity.every((row) => !row.target_id || !forbiddenTargetIds.has(row.target_id)));
    assert.ok(scopedFeed.activity.every((row) => row.organization_id === organizationA));
    assert.ok(scopedFeed.activity.every((row) => row.full_organization_scope === false));
    assert.ok(scopedFeed.activity.every((row) => (
      row.authorized_property_ids.length === 1
      && row.authorized_property_ids[0] === FEED_ALLOWED_PROPERTY
    )));

    const ownerFeed = await loadFeedAsService(FEED_OWNER_A);
    assert.ok(ownerFeed.activity.some((row) => row.target_id === acceptedDenied));
    assert.ok(ownerFeed.activity.some((row) => row.target_id === revokedDeniedGrant));
    assert.ok(ownerFeed.activity.some((row) => row.target_id === cancelledDenied));
    assert.ok(ownerFeed.activity.every((row) => row.organization_id === organizationA));
    assert.ok(ownerFeed.activity.every((row) => row.full_organization_scope === true));
    assert.ok(ownerFeed.activity.every((row) => row.authorized_property_ids.length === 0));
  });

  test('keeps the bounded Company Hub feed service-role-only and hardened', async () => {
    const privileges = await pg.query<{
      anon: boolean;
      authenticated: boolean;
      service: boolean;
      security_definer: boolean;
      volatility: string;
      configuration: string[];
    }>(`
      select
        has_function_privilege(
          'anon', 'public.staxis_company_access_feed(uuid,integer)', 'execute'
        ) as anon,
        has_function_privilege(
          'authenticated', 'public.staxis_company_access_feed(uuid,integer)', 'execute'
        ) as authenticated,
        has_function_privilege(
          'service_role', 'public.staxis_company_access_feed(uuid,integer)', 'execute'
        ) as service,
        procedure.prosecdef as security_definer,
        procedure.provolatile as volatility,
        procedure.proconfig as configuration
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public'
        and procedure.proname = 'staxis_company_access_feed'
    `);
    assert.equal(privileges.rows.length, 1);
    assert.equal(privileges.rows[0].anon, false);
    assert.equal(privileges.rows[0].authenticated, false);
    assert.equal(privileges.rows[0].service, true);
    assert.equal(privileges.rows[0].security_definer, true);
    assert.equal(privileges.rows[0].volatility, 's');
    assert.ok(
      privileges.rows[0].configuration.includes('search_path=public, pg_temp'),
      'the security-definer feed must pin its search path',
    );

    await pg.exec('begin');
    try {
      await pg.exec('set local role authenticated');
      await assert.rejects(
        pg.query(`select public.staxis_company_access_feed('${OWNER}', 10)`),
        /permission denied/i,
      );
    } finally {
      await pg.exec('rollback');
    }
  });

  test('is safe to rerun without duplicate state, grants, audit rows, or policies', async () => {
    const before = await pg.query<{
      organizations: number;
      memberships: number;
      grants: number;
      events: number;
    }>(`
      select
        (select count(*)::int from public.organizations) as organizations,
        (select count(*)::int from public.organization_memberships) as memberships,
        (select count(*)::int from public.organization_access_grants) as grants,
        (select count(*)::int from public.organization_access_events) as events
    `);
    await pg.exec(MIGRATION_SQL);
    const after = await pg.query<{
      organizations: number;
      memberships: number;
      grants: number;
      events: number;
    }>(`
      select
        (select count(*)::int from public.organizations) as organizations,
        (select count(*)::int from public.organization_memberships) as memberships,
        (select count(*)::int from public.organization_access_grants) as grants,
        (select count(*)::int from public.organization_access_events) as events
    `);
    assert.deepEqual(after.rows[0], before.rows[0]);
  });
});
