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
  ACCOUNT_ANA,
  ORG_A,
  PID_A1,
  PID_A2,
  PID_B1,
  UID_ANA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

/** Not a property at all. The exact id that was accepted on production. */
const BOGUS = 'b6f0a05e-0000-0000-0000-000000000000';

let pg: PGlite;
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
    for (const file of ['0464_company_invite_rescope.sql', '0467_company_coverage_tenancy.sql']) {
      assert.ok(
        migrated.report.applied.includes(file),
        `${file}: ${JSON.stringify(migrated.report.failedAtRuntime.filter((f) => f.file === file))}`,
      );
    }
    await seedTwoCompanies(pg);
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
});
