/**
 * 0467 — a company hat's hotel list is checked, honoured, and not overstated.
 *
 * These go through the RPCs DIRECTLY, never the route. The route already
 * validated `propertyIds` upstream, which is exactly why the database side was
 * able to trust the list for a year without anybody noticing: the last line of
 * defence is only a defence if it is tested as one.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { resolveHatCoverage } from '@/lib/company/access';
import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_ANA,
  ACCOUNT_FIONA,
  ACCOUNT_FRANK,
  ACCOUNT_MARIA,
  ORG_A,
  PID_A1,
  PID_A2,
  PID_B1,
  UID_ADMIN,
  UID_ANA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

/** Not a property at all. The exact id that was accepted on production. */
const BOGUS = 'b6f0a05e-0000-0000-0000-000000000000';

let pg: PGlite;
let companies: Awaited<ReturnType<typeof seedTwoCompanies>>;
let seq = 0;

function tokenHash(): string {
  seq += 1;
  return seq.toString(16).padStart(64, 'a');
}

async function createInvite(input: {
  covered: string[] | null;
  scope?: 'company' | 'property';
  role?: string;
  hash?: string;
}): Promise<Record<string, unknown>> {
  const scope = input.scope ?? 'company';
  const result = await pg.query<{ value: Record<string, unknown> }>(
    `select public.staxis_create_account_invite_guarded(
       $1, $2, $3, $4, $5, $6, clock_timestamp() + interval '1 day',
       $7, $8, $9, $10, null
     ) as value`,
    [
      ACCOUNT_ANA, UID_ANA, PID_A1,
      `cov-${seq}-${Math.random().toString(36).slice(2, 8)}@example.test`,
      input.role ?? (scope === 'company' ? 'regional_manager' : 'front_desk'),
      input.hash ?? tokenHash(), ORG_A, scope, input.covered, `cov-${seq}`,
    ],
  );
  return result.rows[0].value;
}

describe('0467 company coverage tenancy', () => {
  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    // Both migrations must APPLY, not merely be attempted — the runner records
    // a file that throws and carries on, which would leave every assertion
    // below reading a database neither migration touched.
    for (const file of [
      '0464_company_invite_rescope.sql',
      '0467_company_coverage_tenancy.sql',
      '0468_company_coverage_never_empty.sql',
    ]) {
      assert.ok(
        migrated.report.applied.includes(file),
        `${file}: ${JSON.stringify(migrated.report.failedAtRuntime.filter((f) => f.file === file))}`,
      );
    }
    companies = await seedTwoCompanies(pg);
  });

  after(async () => {
    await pg?.close();
  });

  test('a covered list naming anything outside the company is refused, not filtered', async () => {
    // The production repro: one real Gulf Coast hotel plus a uuid that is not a
    // property at all. This returned ok and stored the bogus id.
    assert.deepEqual(
      await createInvite({ covered: [PID_A1, BOGUS] }),
      { ok: false, reason: 'denied' },
    );
    // A real hotel, belonging to a DIFFERENT company. Wall B at the write.
    assert.deepEqual(
      await createInvite({ covered: [PID_A1, PID_B1] }),
      { ok: false, reason: 'denied' },
    );
    // Structurally junk lists are refused on the same line.
    assert.deepEqual(
      await createInvite({ covered: [PID_A1, PID_A1] }),
      { ok: false, reason: 'denied' },
    );
    assert.deepEqual(await createInvite({ covered: [] }), { ok: false, reason: 'denied' });
    // The property shape was already checked and must stay checked.
    assert.deepEqual(
      await createInvite({ covered: [PID_A1, BOGUS], scope: 'property' }),
      { ok: false, reason: 'denied' },
    );
    // Refused means nothing was written. A filtered list would have left rows.
    assert.equal(
      (await pg.query<{ n: string }>(
        `select count(*)::text as n from public.account_invites
          where covered_property_ids @> array[$1]::uuid[]`,
        [BOGUS],
      )).rows[0].n,
      '0',
    );
  });

  // The same hole through the SUPPORTED door: the jsonb writer turns [] into
  // NULL, so an empty selection asked for "no hotels" and was handed the
  // company. Mutation: drop the refusal and this hat is created covering
  // everything.
  test('the jsonb writer refuses an explicitly empty selection', async () => {
    await assert.rejects(
      () => pg.query(
        `select public.staxis_set_membership_hat(
           $1, $2, $3, 'company', 'regional_manager', '[]'::jsonb, 'Regional Manager'
         )`,
        [ACCOUNT_ANA, ORG_A, ACCOUNT_ANA],
      ),
      /at least one hotel/i,
    );
  });

  test('the two legitimate shapes still write, and mean different things', async () => {
    const list = await createInvite({ covered: [PID_A1, PID_A2] });
    assert.equal(list.ok, true);
    const all = await createInvite({ covered: null });
    assert.equal(all.ok, true);

    const rows = (await pg.query<{ covered: string | null }>(
      `select covered_property_ids::text as covered from public.account_invites
        where id in ($1, $2) order by covered_property_ids nulls last`,
      [list.inviteId, all.inviteId],
    )).rows;
    // An explicit list is stored exactly; NULL stays NULL, which is the
    // all-hotels-including-future promise and names nothing to validate.
    assert.match(rows[0].covered ?? '', /a1a1a1a1/);
    assert.match(rows[0].covered ?? '', /a2a2a2a2/);
    assert.equal(rows[1].covered, null);
  });

  test('the other guarded writers are gated by the same judge', async () => {
    // staxis_set_membership_hat, straight at the hat.
    await assert.rejects(
      () => pg.query(
        `select public.staxis_set_membership_hat(
           $1, $2, $3, 'company', 'regional_manager', $4::jsonb, 'Regional Manager'
         )`,
        [ACCOUNT_ANA, ORG_A, ACCOUNT_ANA, JSON.stringify([PID_A1, BOGUS])],
      ),
      /may not grant|not permitted|denied|forbidden/i,
    );
    // …and the existing-account grant.
    const granted = (await pg.query<{ value: Record<string, unknown> }>(
      `select public.staxis_grant_existing_account_invite_guarded(
         $1, $2, $3, $4, 'grant-probe@example.test', 'regional_manager',
         $5, 'company', $6, null, 'cov-grant'
       ) as value`,
      [ACCOUNT_ANA, UID_ANA, PID_A1, ACCOUNT_ANA, ORG_A, [PID_A1, BOGUS]],
    )).rows[0].value;
    assert.equal(granted.ok, false);
  });

  test('an explicit-list invitation can actually be accepted, and keeps its list', async () => {
    // Before 0467 this raised "invitation topology or promised job is no longer
    // valid": acceptance discarded the promised list, then refused the
    // invitation for having one. The feature could be offered and never used.
    const hash = tokenHash();
    const created = await createInvite({ covered: [PID_A1, PID_A2], hash });
    assert.equal(created.ok, true);

    const claim = 'cccc9999-0000-4000-8000-0000000000c1';
    const authUser = 'cccc9999-0000-4000-8000-0000000000a1';
    await pg.query(`select public.staxis_claim_account_invite_acceptance($1, $2)`, [hash, claim]);
    await pg.query(
      `insert into auth.users(id, email)
       select $1, email from public.account_invites where token_hash = $2`,
      [authUser, hash],
    );
    const accepted = (await pg.query<{ value: Record<string, unknown> }>(
      `select public.staxis_accept_account_invite($1, $2, $3, 'listjoiner', 'List Joiner') as value`,
      [hash, claim, authUser],
    )).rows[0].value;
    assert.equal(accepted.ok, true);

    // …as the list it promised. Storing NULL here would silently hand a
    // two-hotel Regional Manager every hotel the company will ever own.
    const covered = (await pg.query<{ covered: string | null }>(
      `select covered_property_ids::text as covered from public.organization_memberships
        where id = $1`,
      [accepted.membershipId],
    )).rows[0].covered;
    assert.match(covered ?? '', /a1a1a1a1/);
    assert.match(covered ?? '', /a2a2a2a2/);
  });

  test('acceptance refuses a promise the company can no longer keep', async () => {
    const hash = tokenHash();
    const created = await createInvite({ covered: [PID_A1, PID_A2], hash });
    assert.equal(created.ok, true);

    // The hotel leaves the company between the invitation and the acceptance.
    await pg.query(
      // The window must CLOSE, and ends_at must stay after starts_at. The seed
      // starts these relationships at ~now, so pushing the start back two days
      // and ending it one day ago satisfies both and leaves no race with the
      // acceptance a few milliseconds later.
      `update public.organization_property_relationships
          set starts_at = clock_timestamp() - interval '2 days',
              ends_at = clock_timestamp() - interval '1 day'
        where organization_id = $1 and property_id = $2 and ends_at is null`,
      [ORG_A, PID_A2],
    );

    const claim = 'cccc9999-0000-4000-8000-0000000000c2';
    const authUser = 'cccc9999-0000-4000-8000-0000000000a2';
    await pg.query(`select public.staxis_claim_account_invite_acceptance($1, $2)`, [hash, claim]);
    await pg.query(
      `insert into auth.users(id, email)
       select $1, email from public.account_invites where token_hash = $2`,
      [authUser, hash],
    );
    // REJECT, not intersect: the invitation named a set, and honouring a named
    // list partially without telling anyone is worse than asking for a new one.
    // This is the same answer the property shape has always given here.
    await assert.rejects(
      () => pg.query(
        `select public.staxis_accept_account_invite($1, $2, $3, 'shrunk', 'Shrunk') as value`,
        [hash, claim, authUser],
      ),
      /no longer valid|changed company/i,
    );

    await pg.query(
      `update public.organization_property_relationships
          set ends_at = null
        where organization_id = $1 and property_id = $2 and ends_at is not null`,
      [ORG_A, PID_A2],
    );
  });

  // WHAT THE SCREEN SAYS AND WHAT THE DATABASE DOES, ON THE SAME HAT.
  //
  // Two implementations of one rule is how one of them ends up wrong, and one
  // of them WAS: `resolveHatCoverage` returned every operated hotel for any
  // company hat while the SQL resolver honoured the list. This asks both the
  // same question for both shapes and requires the same answer.
  test('presentation matches the canonical resolver for both company shapes', async () => {
    const operated = (await pg.query<{ id: string }>(
      `select distinct relationship.property_id as id
         from public._staxis_current_primary_property_relationships() relationship
        where relationship.organization_id = $1 and relationship.active_primary_count = 1`,
      [ORG_A],
    )).rows.map((r) => r.id);

    const resolverSays = async () => (await pg.query<{ id: string }>(
      `select distinct authorized.property_id as id
         from public._staxis_nonlegacy_property_authorizations($1) authorized
        where authorized.organization_id = $2
          and authorized.entitlement_kind = 'membership_hat'
          and authorized.scope_type = 'company'`,
      [ACCOUNT_ANA, ORG_A],
    )).rows.map((r) => r.id).sort();

    const hatCovered = async () => {
      const raw = (await pg.query<{ covered: string[] | null }>(
        `select covered_property_ids as covered from public.organization_memberships
          where organization_id = $1 and account_id = $2
            and membership_scope = 'company' and ended_at is null`,
        [ORG_A, ACCOUNT_ANA],
      )).rows[0].covered;
      // NULL travels as NULL now: that is the all-including-future signal, and
      // flattening it to [] here would be the exact plumbing bug being fixed.
      return resolveHatCoverage('company', raw, operated).sort();
    };

    // Shape 1: no list. Both must say every operated hotel.
    assert.deepEqual(await hatCovered(), await resolverSays());
    assert.deepEqual(await hatCovered(), [...operated].sort());

    // Shape 2: a named list. Both must say exactly that hotel.
    await pg.query(
      `update public.organization_memberships
          set covered_property_ids = array[$3]::uuid[]
        where organization_id = $1 and account_id = $2
          and membership_scope = 'company' and ended_at is null`,
      [ORG_A, ACCOUNT_ANA, PID_A1],
    );
    assert.deepEqual(await hatCovered(), [PID_A1]);
    assert.deepEqual(await hatCovered(), await resolverSays());

    await pg.query(
      `update public.organization_memberships
          set covered_property_ids = null
        where organization_id = $1 and account_id = $2
          and membership_scope = 'company' and ended_at is null`,
      [ORG_A, ACCOUNT_ANA],
    );
  });

  test('a hat naming some hotels does not read as the whole company', async () => {
    const rights = async (accountId: string) => (await pg.query<{
      whole_company_view: boolean;
    }>(
      `select whole_company_view
         from public._staxis_company_structure_actor_rights($1, $2)`,
      [accountId, ORG_A],
    )).rows[0];

    // Ana wears the all-hotels-including-future Owner hat the seed gives her.
    const ana = await rights(ACCOUNT_ANA);
    assert.equal(ana.whole_company_view, true);

    // Narrow that same hat to one hotel and both claims must stop being true.
    await pg.query(
      `update public.organization_memberships
          set covered_property_ids = array[$3]::uuid[]
        where organization_id = $1 and account_id = $2
          and membership_scope = 'company' and ended_at is null`,
      [ORG_A, ACCOUNT_ANA, PID_A1],
    );
    const narrowed = await rights(ACCOUNT_ANA);
    assert.equal(narrowed.whole_company_view, false);

    await pg.query(
      `update public.organization_memberships
          set covered_property_ids = null
        where organization_id = $1 and account_id = $2
          and membership_scope = 'company' and ended_at is null`,
      [ORG_A, ACCOUNT_ANA],
    );
  });

  // ─── 0468: a hat never ends up naming zero hotels ────────────────────────
  //
  // 0467 wrote a cardinality-based hat-shape CHECK, watched it turn the Stage C
  // contract suite red, and backed it out because the write path producing '{}'
  // had not been identified. There were two, both using `array(subquery)` to
  // prune a hotel out of a property hat's list — a construct that returns '{}'
  // rather than NULL over zero rows. These are those two paths, asked directly.

  const hatRow = async (accountId: string, role: string) => (await pg.query<{
    status: string;
    ended_at: string | null;
    covered_property_ids: string[] | null;
  }>(
    `select status, ended_at, covered_property_ids
       from public.organization_memberships
      where account_id = $1 and membership_scope = 'property' and staxis_role = $2`,
    [accountId, role],
  )).rows[0];

  const emptyCoverageRows = async () => (await pg.query<{ n: number }>(
    `select count(*)::int as n from public.organization_memberships
      where covered_property_ids is not null
        and cardinality(covered_property_ids) = 0`,
  )).rows[0].n;

  test('deleting a hotel ends a hat that named only it, instead of emptying the list', async () => {
    const ANNEX = 'aaaa9999-0000-4000-8000-000000000009';
    await companies.attachPropertyToOrganization(pg, ORG_A, ANNEX, 'Audit Annex');
    await pg.query(
      `select public.staxis_set_membership_hat($1, $2, $3, 'property', 'housekeeping', $4::jsonb, 'Housekeeping')`,
      [ACCOUNT_ADMIN, ORG_A, ACCOUNT_MARIA, JSON.stringify([ANNEX])],
    );
    assert.deepEqual((await hatRow(ACCOUNT_MARIA, 'housekeeping')).covered_property_ids, [ANNEX]);

    await pg.query(
      `select public.staxis_delete_property_and_legacy_accounts($1, $2, null)`,
      [ACCOUNT_ADMIN, ANNEX],
    );

    // Before this fix the row stayed ACTIVE with an empty list: a live hat
    // covering nothing, and the shape that made the CHECK uninstallable. There
    // was no follow-up revoke on this path at all.
    const after = await hatRow(ACCOUNT_MARIA, 'housekeeping');
    assert.equal(after.status, 'revoked');
    assert.notEqual(after.ended_at, null);
    assert.deepEqual(
      after.covered_property_ids,
      [ANNEX],
      'the ended hat keeps the record of which hotel it covered',
    );
    assert.equal(await emptyCoverageRows(), 0);
  });

  test('detaching the last covered hotel ends the hat, and a multi-hotel hat is only pruned', async () => {
    const EXTRA = 'aaaa9999-0000-4000-8000-00000000000a';
    await companies.attachPropertyToOrganization(pg, ORG_A, EXTRA, 'Audit Extra');

    const detach = async (accountId: string, propertyId: string) => {
      const state = (await pg.query<{
        authority_version: number; updated_at: string; role: string;
      }>(
        `select state.authority_version, account.updated_at, account.role
           from public.account_authorization_state state
           join public.accounts account on account.id = state.account_id
          where state.account_id = $1`,
        [accountId],
      )).rows[0];
      const result = await pg.query<{ value: Record<string, unknown> }>(
        `select public.staxis_remove_property_access_authoritative(
           $1, $2, 'ana@example.test', $3, $4, $5, $6, $7, 'audit-0468'
         ) as value`,
        [
          ACCOUNT_ANA, UID_ANA, accountId, propertyId,
          state.role, state.authority_version, state.updated_at,
        ],
      );
      return result.rows[0].value;
    };

    // Maria's maintenance hat names TWO hotels. Removing one must prune, and
    // must leave the hat alive at the other.
    await pg.query(
      `select public.staxis_set_membership_hat($1, $2, $3, 'property', 'maintenance', $4::jsonb, 'Maintenance')`,
      [ACCOUNT_ADMIN, ORG_A, ACCOUNT_FRANK, JSON.stringify([PID_A2, EXTRA])],
    );
    assert.equal((await detach(ACCOUNT_FRANK, EXTRA)).status, 'ok');
    const pruned = await hatRow(ACCOUNT_FRANK, 'maintenance');
    assert.equal(pruned.status, 'active');
    assert.deepEqual(pruned.covered_property_ids, [PID_A2]);

    // Now the last one. The hat is over: ended, list intact, nothing emptied.
    assert.equal((await detach(ACCOUNT_FRANK, PID_A2)).status, 'ok');
    const ended = await hatRow(ACCOUNT_FRANK, 'maintenance');
    assert.equal(ended.status, 'revoked');
    assert.notEqual(ended.ended_at, null);
    assert.deepEqual(ended.covered_property_ids, [PID_A2]);
    assert.equal(await emptyCoverageRows(), 0);
  });

  test('the shape check refuses an empty list on either hat shape', async () => {
    // `array_length('{}', 1)` is NULL and a CHECK reads NULL as satisfied, which
    // is how 0464's constraint admitted an empty array on both branches.
    for (const [scope, role] of [
      ['company', 'regional_manager'],
      ['property', 'front_desk'],
    ] as const) {
      await assert.rejects(
        pg.query(
          `insert into public.organization_memberships
             (organization_id, account_id, job_category, status,
              membership_scope, staxis_role, covered_property_ids)
           values ($1, $2, 'hotel_employee', 'active', $3, $4, '{}'::uuid[])`,
          [ORG_A, ACCOUNT_FIONA, scope, role],
        ),
        /hat_shape_check/,
        `${scope}/${role} accepted a list naming zero hotels`,
      );
      await pg.exec('rollback;').catch(() => undefined);
    }

    // And NULL is still refused on the property shape, so "write NULL instead
    // of '{}'" is not the fix it looks like: NULL is the company shape and it
    // means every hotel including future ones.
    await assert.rejects(
      pg.query(
        `insert into public.organization_memberships
           (organization_id, account_id, job_category, status,
            membership_scope, staxis_role, covered_property_ids)
         values ($1, $2, 'hotel_employee', 'active', 'property', 'front_desk', null)`,
        [ORG_A, ACCOUNT_FIONA],
      ),
      /hat_shape_check/,
    );
    await pg.exec('rollback;').catch(() => undefined);
  });

  // ─── 0468: a subset hat may not speak for the whole company ─────────────
  //
  // 0467 narrowed `whole_company_view` and deliberately left two neighbours
  // alone. Both turn out to be reach rather than presentation.

  const narrowAnaTo = async (propertyIds: string[] | null) => {
    await pg.query(
      `update public.organization_memberships
          set covered_property_ids = $3::uuid[]
        where organization_id = $1 and account_id = $2
          and membership_scope = 'company' and staxis_role = 'owner'
          and ended_at is null`,
      [ORG_A, ACCOUNT_ANA, propertyIds],
    );
  };

  test('a subset Owner cannot move a hotel into another group\'s portfolio', async () => {
    const MINE = 'ffff0000-0000-4000-8000-000000000001';
    const THEIRS = 'ffff0000-0000-4000-8000-000000000002';
    await pg.query(
      `insert into public.portfolios (id, organization_id, name, portfolio_type, status)
       values ($1,$3,'Group One','region','active'), ($2,$3,'Other Owners Group','region','active')
       on conflict (id) do nothing`,
      [MINE, THEIRS, ORG_A],
    );
    for (const [propertyId, portfolioId] of [[PID_A1, MINE], [PID_A2, THEIRS]] as const) {
      const relationship = await pg.query<{ id: string }>(
        `select id from public._staxis_current_primary_property_relationships()
          where organization_id = $1 and property_id = $2`,
        [ORG_A, propertyId],
      );
      await pg.query(
        `insert into public.portfolio_properties
           (organization_id, portfolio_id, property_id, property_relationship_id, assigned_at)
         values ($1,$2,$3,$4, now() - interval '1 day')
         on conflict do nothing`,
        [ORG_A, portfolioId, propertyId, relationship.rows[0].id],
      );
    }

    const manageable = async () => (await pg.query<{ manageable_portfolio_ids: string[] }>(
      `select manageable_portfolio_ids
         from public._staxis_company_structure_actor_rights($1, $2)`,
      [ACCOUNT_ANA, ORG_A],
    )).rows[0].manageable_portfolio_ids;

    // All-hotels Ana genuinely manages every portfolio. Nothing changes for her.
    assert.deepEqual([...await manageable()].sort(), [MINE, THEIRS].sort());

    await narrowAnaTo([PID_A1]);
    // Beaumont is hers. Lufkin, and the portfolio that holds it, are not.
    assert.deepEqual(
      await manageable(),
      [],
      'a hat naming one hotel was handed every portfolio in the company',
    );

    const epoch = (await pg.query<{ version: number }>(
      `select version from public.organization_access_epochs where organization_id = $1`,
      [ORG_A],
    )).rows[0].version;
    await assert.rejects(
      pg.query(
        `select public._staxis_preview_company_portfolio_assignment($1,$2,$3,$4::uuid[],$5)`,
        [ACCOUNT_ANA, ORG_A, PID_A1, [THEIRS], epoch],
      ),
      /outside the actor/i,
      'a subset Owner moved her own hotel into a portfolio she cannot reach',
    );
    await pg.exec('rollback;').catch(() => undefined);
    await narrowAnaTo(null);
  });

  test('a subset Owner cannot delegate whole-company access to somebody else', async () => {
    const canDelegate = async (profile: string, scope: string, portfolioId: string | null) => (
      await pg.query<{ v: boolean }>(
        `select public._staxis_company_access_can_delegate($1,$2,$3,$4,$5,null) as v`,
        [ACCOUNT_ANA, ORG_A, profile, scope, portfolioId],
      )
    ).rows[0].v;

    assert.equal(await canDelegate('organization_owner', 'organization', null), true);

    await narrowAnaTo([PID_A1]);
    // The escalation this closes: she cannot reach Lufkin, but an
    // organization-scope grant does, so minting one hands somebody else
    // everything she was deliberately not given.
    assert.equal(
      await canDelegate('organization_owner', 'organization', null),
      false,
      'a one-hotel Owner could still mint a whole-company owner',
    );
    assert.equal(await canDelegate('organization_admin', 'organization', null), false);
    assert.equal(await canDelegate('viewer', 'organization', null), false);
    await narrowAnaTo(null);
  });

  test('the existing-account door carries a company hotel list instead of refusing it', async () => {
    const NEW_USER = 'eeee2222-0000-4000-8000-00000000000b';
    const NEW_ACCOUNT = 'eeee1111-0000-4000-8000-00000000000b';
    await pg.query(`insert into auth.users (id, email) values ($1,'colleague@example.test')`, [NEW_USER]);
    await pg.query(
      `insert into public.accounts (id, username, password_hash, display_name, role, data_user_id)
       values ($1,'colleague','x','Colleague','front_desk',$2)`,
      [NEW_ACCOUNT, NEW_USER],
    );

    const granted = (await pg.query<{ value: Record<string, unknown> }>(
      `select public.staxis_grant_existing_account_invite_guarded(
         $1,$2,$3,$4,'colleague@example.test','regional_manager',$5,'company',$6,null,'cov-existing'
       ) as value`,
      [ACCOUNT_ADMIN, UID_ADMIN, PID_A1, NEW_ACCOUNT, ORG_A, [PID_A1]],
    )).rows[0].value;
    assert.equal(granted.ok, true, JSON.stringify(granted));

    // The promise is kept exactly. Storing NULL here would have been the
    // all-hotels shape: a one-hotel Regional Manager silently given the lot.
    const stored = (await pg.query<{ covered_property_ids: string[] | null }>(
      `select covered_property_ids from public.organization_memberships
        where account_id = $1 and membership_scope = 'company'`,
      [NEW_ACCOUNT],
    )).rows[0];
    assert.deepEqual(stored.covered_property_ids, [PID_A1]);

    // A list that omits the hotel the grant is anchored at cannot activate, so
    // it is refused with a reason rather than raised on at the assertion.
    const mismatched = (await pg.query<{ value: Record<string, unknown> }>(
      `select public.staxis_grant_existing_account_invite_guarded(
         $1,$2,$3,$4,'colleague@example.test','regional_manager',$5,'company',$6,null,'cov-existing-2'
       ) as value`,
      [ACCOUNT_ADMIN, UID_ADMIN, PID_A1, NEW_ACCOUNT, ORG_A, [PID_A2]],
    )).rows[0].value;
    // 'denied' rather than 'role_conflict': the shared invitation gate
    // `_staxis_can_control_account_invite` sees the mismatch first and this
    // door reports its refusals that way. Either answer is a refusal; what
    // matters is that no unacceptable promise is written.
    assert.equal(mismatched.ok, false);
    assert.equal(mismatched.reason, 'denied');
  });

  test('a company invitation cannot promise hotels that exclude its own anchor', async () => {
    // Creatable before 0468, and its acceptance raised "promised normalized
    // entitlement did not activate" every single time: offered, emailed,
    // claimed, never acceptable. Exactly the shape 0467 closed for empty lists.
    const refused = await createInvite({
      covered: [PID_A2],
      scope: 'company',
      role: 'regional_manager',
    });
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.reason, 'denied');

    // The same list WITH the anchor is still fine.
    const allowed = await createInvite({
      covered: [PID_A1, PID_A2],
      scope: 'company',
      role: 'regional_manager',
    });
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
  });
});
