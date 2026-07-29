/**
 * WHAT JOB DO YOU HOLD *AT THIS HOTEL*? — capacity, reach, and the gap between.
 *
 * Against a real Postgres holding two companies, because none of this is
 * provable against a mock: the whole finding is that two correct-looking
 * answers were never multiplied together.
 *
 * ─── THE BUG (H2) ───────────────────────────────────────────────────────────
 * Two questions, answered in two places, never intersected:
 *
 *   CAPACITY  `loadManagerCaller` asked the GLOBAL `accounts.role`. One word
 *             per person, for the whole product.
 *   REACH     `managerManagesHotel` admitted the hotel if ANY hat covered it —
 *             whatever job that hat named.
 *
 * So a person whose login still carries a legacy `general_manager` role, given
 * a HOUSEKEEPING hat at a company hotel, passed both halves: 200 on that
 * hotel's findings queue, and the right to mute its manager-only cards — while
 * `effectiveRole` told anybody who asked that she was a housekeeper there. The
 * hat was meant to be the DEMOTION. It was read only as an admission ticket.
 *
 * Vicky below is that person, and she is not a hypothetical: a hotel GM whose
 * account predates the company spine, hired by a management company into a
 * housekeeping-supervisor job at one of its other hotels, is an ordinary
 * Tuesday at a company that buys hotels.
 *
 * ─── AND THE REVERSE ────────────────────────────────────────────────────────
 * The same gate, read the other way, refused people it should serve. A
 * company's finance lead degrades to `front_desk` on purpose (least privilege,
 * `legacyRoleForHat`), so a manager question at the door would 403 her out of
 * her own company's rulebook. The fix must NOT do that, which is why Fiona
 * appears in every block below: she is the control that proves the tightening
 * did not become a wall around the wrong people.
 *
 * ─── WHAT EACH BLOCK WOULD CATCH ────────────────────────────────────────────
 *   CAPACITY      Vicky refused at the hotel where her hat says housekeeper,
 *                 and served at the hotel her legacy array names. Both halves,
 *                 because "refuse everybody" also passes half of them.
 *   FINANCE       Fiona still reads the rulebook and the portfolio.
 *   CONTROL       Wanda and Hank — every account in the product today.
 *   TIE-BREAK     one hotel, two companies, and no silent winner (H4).
 *   RULEBOOK      line staff no longer read the company's money policies (M5).
 *   CARD NAMES    a GM is not handed the portfolio's hotel names (M6).
 *   CROSS-TENANT  the database refuses a work order pointed at another
 *                 hotel's schedule (M11, migration 0370).
 *
 * PGlite runs as the table owner, exactly as the service-role key bypasses RLS
 * in production. What is under test is the app's own scoping.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
// Device-trust is a separate boundary with its own suite. Honored only outside
// production — this is what lets the tests drive the REAL route handlers.
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  companyForProperty,
  effectiveRole,
  loadHats,
  propertiesOfOrganization,
  resolveCompanyForProperty,
  resolveOrganizationPropertyTopology,
} from '@/lib/company/access';
import { loadFreshCompanyInviteAuthorityContext } from '@/lib/company/account-invite-authority';
import { rulebookStandingFor } from '@/lib/company/rulebook-access';
import { clearPortfolioAccessCache } from '@/lib/company/portfolio';

import { GET as findingsGet } from '@/app/api/findings/route';
import { GET as badgeGet } from '@/app/api/findings/badge/route';
import { GET as briefGet } from '@/app/api/findings/brief/route';
import { GET as rulebookGet } from '@/app/api/company/rulebook/route';
import { GET as portfolioGet } from '@/app/api/company/queue/route';
import { GET as listHats } from '@/app/api/auth/team/hats/route';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import { createPglitePostgrest, loadCatalog, type PglitePostgrest } from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_FIONA,
  ACCOUNT_FRANK,
  ACCOUNT_MARIA,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  PID_B1,
  PID_L1,
  UID_FIONA,
  UID_FRANK,
  UID_HANK,
  UID_MARIA,
  UID_WANDA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

let pg: PGlite;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

let signedInAs: string | null = null;

/**
 * VICKY. The whole finding, as one person.
 *
 * Her `accounts.role` is `general_manager` — a legacy login from before the
 * company spine, still naming her own hotel (Waco Inn, which belongs to no
 * company). Gulf Coast then hired her into a HOUSEKEEPING job at Beaumont.
 *
 * At Waco she is a manager and always was. At Beaumont she is a housekeeper,
 * and `effectiveRole` has always said so. The manager gates did not ask.
 */
const ACCOUNT_VICKY = 'aaaa1111-0000-4000-8000-0000000000v1'.replace('v1', 'c1');
const UID_VICKY = 'aaaa2222-0000-4000-8000-0000000000v1'.replace('v1', 'c1');

/** A hotel Gulf Coast operates AND Piney Woods also claims. The H4 probe. */
const PID_DISPUTED = 'dddddddd-0000-4000-8000-00000000000d';
const ORG_PROVEN_EMPTY = 'dddddddd-0000-4000-8000-00000000000e';

// ─── Request helpers ────────────────────────────────────────────────────────

function req(url: string): NextRequest {
  return new NextRequest(url, {
    method: 'GET',
    headers: {
      authorization: 'Bearer capacity-test-token',
      'content-type': 'application/json',
      'x-real-ip': '203.0.113.92',
    },
  });
}

async function statusOf(
  handler: (r: NextRequest) => Promise<Response>,
  authUserId: string,
  url: string,
): Promise<number> {
  signedInAs = authUserId;
  const res = await handler(req(url));
  return res.status;
}

/**
 * Run `body` with every read of `table` failing the way a dropped connection
 * fails: `{ data: null, error }`, not a throw. That is the shape PostgREST
 * actually returns, and the shape the old code read as "no company".
 */
async function withReadFailure<T>(table: string, body: () => Promise<T>): Promise<T> {
  const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
  const failure = { data: null, error: { message: 'connection reset by peer', code: '08006' } };
  const erroring = () => {
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'is', 'not', 'order', 'limit', 'filter']) {
      builder[method] = () => builder;
    }
    builder.maybeSingle = () => Promise.resolve(failure);
    builder.single = () => Promise.resolve(failure);
    builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(failure).then(resolve, reject);
    return builder;
  };
  // Cast rather than @ts-expect-error throughout this file: the suppression has
  // to sit on whichever line tsc happens to report, and that line moves whenever
  // the block is reformatted — which is what left type-check red on main for 25
  // commits. A cast cannot drift.
  supabaseAdmin.from = ((name: string) =>
    (name === table ? erroring() : realFrom(name))) as unknown as typeof supabaseAdmin.from;
  try {
    return await body();
  } finally {
    supabaseAdmin.from = realFrom;
  }
}

/** Every manager-gated findings route, asked about one hotel. */
async function findingsRouteStatuses(authUserId: string, propertyId: string): Promise<number[]> {
  const base = 'https://staxis.test/api';
  return [
    await statusOf(findingsGet, authUserId, `${base}/findings?propertyId=${propertyId}`),
    await statusOf(badgeGet, authUserId, `${base}/findings/badge?propertyId=${propertyId}`),
    await statusOf(briefGet, authUserId, `${base}/findings/brief?propertyId=${propertyId}`),
  ];
}

// ─── Fixture ────────────────────────────────────────────────────────────────

before(async () => {
  const migrated = await applyMigrationsToPglite();
  pg = migrated.pg;
  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);
  // The pglite-backed client, installed on the singleton. Casts, not
  // suppressions — see `withReadFailure` above.
  supabaseAdmin.from = shim.from as unknown as typeof supabaseAdmin.from;
  supabaseAdmin.rpc = shim.rpc as unknown as typeof supabaseAdmin.rpc;
  supabaseAdmin.auth.getUser = (async () => (
    signedInAs
      ? { data: { user: { id: signedInAs, email: 'someone@example.test' } }, error: null }
      : { data: { user: null }, error: { message: 'no session', status: 401, name: 'AuthApiError' } }
  )) as unknown as typeof supabaseAdmin.auth.getUser;

  await seedTwoCompanies(pg);

  // ── Vicky ────────────────────────────────────────────────────────────────
  await pg.query(
    `insert into auth.users (id, email) values ($1, 'vicky@example.test')
     on conflict (id) do nothing`,
    [UID_VICKY],
  );
  await pg.query(
    `insert into accounts (id, username, password_hash, display_name, role, property_access, data_user_id)
     values ($1, 'vicky', 'x', 'Vicky', 'general_manager', $2, $3)
     on conflict (id) do nothing`,
    [ACCOUNT_VICKY, [PID_L1], UID_VICKY],
  );
  // The hat, through the only door production has. Vicky needs a foot in the
  // door first: 0370 refuses a hat on somebody with no membership or invitation
  // at the company (a Staxis admin acting is exempt, which is this call).
  await pg.query(
    `select public.staxis_set_membership_hat($1, $2, $3, 'property', 'housekeeping', $4, 'Housekeeping Supervisor')`,
    [ACCOUNT_ADMIN, ORG_A, ACCOUNT_VICKY, JSON.stringify([PID_A1])],
  );

  // Findings at both of Vicky's hotels, so a 200 is a real answer rather than
  // an empty ledger that would 200 for anybody.
  for (const [pid, key] of [[PID_A1, 'beaumont'], [PID_L1, 'waco']] as const) {
    await pg.query(
      `insert into findings
         (property_id, detector_id, dedupe_key, summary, severity, disposition, status, receipt_query_id, magnitude)
       values ($1, 'probe', $2, 'Something needs a decision here.', 'attention', 'propose', 'open', 'probe_receipt', 3)`,
      [pid, `probe:${key}`],
    );
  }
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  await pg?.close();
});

// ═══ CAPACITY — the reviewer's probe, both directions ═══════════════════════

describe('the job you hold AT THIS HOTEL is the job the gate uses', () => {
  test('the fixture really is the dangerous shape', async () => {
    const account = await pg.query<{ role: string; property_access: string[] }>(
      'select role, property_access from accounts where id = $1', [ACCOUNT_VICKY],
    );
    assert.equal(account.rows[0].role, 'general_manager', 'fixture drift: her legacy role moved');
    assert.deepEqual(account.rows[0].property_access, [PID_L1]);

    const hats = await loadHats(ACCOUNT_VICKY);
    assert.deepEqual(hats.map((h) => h.role), ['housekeeping'], 'fixture drift: her hat moved');
    assert.deepEqual(hats[0].coveredPropertyIds, [PID_A1]);

    // The spine has ALWAYS answered this correctly. The gates just never asked.
    assert.equal((await effectiveRole(ACCOUNT_VICKY, PID_A1)).role, 'housekeeping');
    assert.equal((await effectiveRole(ACCOUNT_VICKY, PID_L1)).role, 'general_manager');
  });

  // THE FLAGGED BUG. Mutation: make `managerManagesHotel` answer reach only —
  // i.e. restore `caller.hats.some(hat => hat.coveredPropertyIds.includes(id))`
  // — and all three of these go 200.
  test('a housekeeping hat is refused every manager-only findings route at that hotel', async () => {
    assert.deepEqual(
      await findingsRouteStatuses(UID_VICKY, PID_A1), [403, 403, 403],
      'a housekeeper was served her hotel\'s manager queue because her OTHER login says manager',
    );
  });

  // The other half, and the reason "refuse everybody" is not a fix: her legacy
  // manager role at her own hotel is untouched.
  test('and served every one of them at the hotel her legacy role actually names', async () => {
    assert.deepEqual(
      await findingsRouteStatuses(UID_VICKY, PID_L1), [200, 200, 200],
      'tightening the gate took away access she has always legitimately had',
    );
  });

  test('a property GM can read that hotel, while a company-only VP cannot read another hotel\'s private queue', async () => {
    // Maria: property GM at Beaumont + company VP over the rest. The explicit
    // hotel hat grants the private queue at Beaumont. Her broad company role is
    // portfolio-read authority, not an implicit GM assignment at Lufkin.
    assert.deepEqual(await findingsRouteStatuses(UID_MARIA, PID_A1), [200, 200, 200]);
    assert.deepEqual(
      await findingsRouteStatuses(UID_MARIA, PID_A2), [403, 403, 403],
      'a company-only VP was incorrectly promoted into private hotel-manager authority',
    );
  });

  test('a front-desk hat is refused, as it always was', async () => {
    assert.deepEqual(await findingsRouteStatuses(UID_FRANK, PID_A1), [403, 403, 403]);
  });

  test('and the company wall still holds — company B cannot ask about company A', async () => {
    assert.deepEqual(await findingsRouteStatuses(UID_MARIA, PID_B1), [403, 403, 403]);
  });
});

// ═══ FINANCE — the reverse failure the fix must not cause ═══════════════════

describe('the finance lead keeps every read path she was given', () => {
  // Mutation: gate `/api/company/rulebook` on manager capacity instead of
  // reach. Fiona's finance hat degrades to `front_desk`, so she 403s out of the
  // book her own company governs her by — the exact regression the hat-access
  // pass fixed and this tightening could have re-introduced.
  test('she reads her company rulebook', async () => {
    assert.equal(
      await statusOf(rulebookGet, UID_FIONA, `https://staxis.test/api/company/rulebook?organizationId=${ORG_A}`),
      200,
      'the finance lead was refused the company book again',
    );
    const standing = await rulebookStandingFor(ACCOUNT_FIONA, ORG_A);
    assert.equal(standing.canView, true);
    assert.equal(standing.canEdit, false, 'finance was handed the pen');
  });

  test('and she reads the portfolio queue', async () => {
    signedInAs = UID_FIONA;
    clearPortfolioAccessCache();
    const res = await portfolioGet(req('https://staxis.test/api/company/queue'));
    assert.equal(res.status, 200);
    const body = await res.json() as { data?: { scope?: { companyRole?: string }; canAct?: boolean } };
    assert.equal(body.data?.scope?.companyRole, 'finance');
    assert.equal(body.data?.canAct, false, 'finance was offered verdict buttons');
  });

  // She is finance, not a manager. The findings queue is a manager surface and
  // was never hers; this states that the fix did not accidentally widen her.
  test('but a hotel findings queue is still not hers', async () => {
    assert.deepEqual(await findingsRouteStatuses(UID_FIONA, PID_A1), [403, 403, 403]);
  });
});

// ═══ CONTROL GROUP — every account in the product today ════════════════════

describe('the legacy accounts are exactly where they were', () => {
  test('a legacy owner still runs her own hotel and nothing else', async () => {
    assert.deepEqual(await findingsRouteStatuses(UID_WANDA, PID_L1), [200, 200, 200]);
    assert.deepEqual(await findingsRouteStatuses(UID_WANDA, PID_A1), [403, 403, 403]);
  });

  test('a legacy housekeeper is refused, as she always was', async () => {
    assert.deepEqual(await findingsRouteStatuses(UID_HANK, PID_L1), [403, 403, 403]);
  });
});

// ═══ ONE HOTEL, TWO COMPANIES (H4) ═════════════════════════════════════════

describe('a hotel two companies both claim has NO company, not the lower UUID', () => {
  test('a hotel with one governing operator resolves to that company', async () => {
    assert.equal(await companyForProperty(PID_A1), ORG_A);
    assert.equal(await companyForProperty(PID_B1), ORG_B);
    assert.equal(await companyForProperty(PID_L1), null, 'an independent hotel grew a company');
  });

  // Mutation: drop the relationship_type / is_primary_grouping filter from
  // `readCompanyForProperty`. This hotel silently resolves to whichever
  // organization sorts first by UUID — and with it goes whose rulebook, whose
  // approval thresholds and whose staff list apply.
  test('a NON-governing claim does not make a company', async () => {
    await pg.query(
      `insert into properties (id, name, owner_id, total_rooms, timezone)
       select $1, 'Disputed Inn', owner_id, 60, 'America/Chicago' from properties where id = $2`,
      [PID_DISPUTED, PID_A1],
    );
    // 0325 auto-creates a single_hotel anchor as the primary. Stand it down and
    // give Gulf Coast the governing row, exactly as the attach RPC does.
    await pg.query(
      `update organization_property_relationships set is_primary_grouping = false
        where property_id = $1 and ends_at is null and is_primary_grouping`,
      [PID_DISPUTED],
    );
    await pg.query(
      `insert into organization_property_relationships
         (organization_id, property_id, relationship_type, is_primary_grouping)
       values ($1, $2, 'operator', true)`,
      [ORG_A, PID_DISPUTED],
    );
    // Piney Woods holds a BRAND link to the same hotel — a real relationship
    // that is not operating it. Before the filter, this alone was enough to put
    // the hotel in two companies and hand the tie to a UUID comparison.
    await pg.query(
      `insert into organization_property_relationships
         (organization_id, property_id, relationship_type, is_primary_grouping)
       values ($1, $2, 'brand', false)`,
      [ORG_B, PID_DISPUTED],
    );

    assert.equal(
      await companyForProperty(PID_DISPUTED), ORG_A,
      'a brand link was read as running the hotel',
    );
    // …and Piney Woods' people are not admitted by it.
    assert.deepEqual(
      (await loadHats('bbbb1111-0000-4000-8000-000000000002'))
        .flatMap((hat) => hat.coveredPropertyIds),
      [PID_B1],
      'a brand link handed another company\'s VP a hotel',
    );
  });

  test('two GOVERNING claims resolve to no company at all, never to a winner', async () => {
    // Supported writers now serialize and reject this state. Emulate a row
    // that predates that guard: a future-ended primary plus a NULL-ended
    // primary is schema-valid under the historical partial unique index. Only
    // this DB-owner fixture disables the one write guard, and it re-enables it
    // before exercising the read wall.
    const original = await pg.query<{ id: string }>(
      `update organization_property_relationships
          set ends_at = clock_timestamp() + interval '1 day'
        where organization_id = $1
          and property_id = $2
          and relationship_type = 'operator'
          and is_primary_grouping is true
          and ends_at is null
        returning id`,
      [ORG_A, PID_DISPUTED],
    );
    assert.equal(original.rows.length, 1);

    let corruptRelationshipId: string | null = null;
    try {
      await pg.query(
        `alter table organization_property_relationships
           disable trigger trg_organization_property_relationships_primary_window_guard`,
      );
      try {
        const corrupt = await pg.query<{ id: string }>(
          `insert into organization_property_relationships
             (organization_id, property_id, relationship_type, is_primary_grouping)
           values ($1, $2, 'owner', true)
           returning id`,
          [ORG_B, PID_DISPUTED],
        );
        corruptRelationshipId = corrupt.rows[0]?.id ?? null;
      } finally {
        await pg.query(
          `alter table organization_property_relationships
             enable trigger trg_organization_property_relationships_primary_window_guard`,
        );
      }

      assert.equal(
        await companyForProperty(PID_DISPUTED), null,
        'a hotel claimed by two live companies picked one silently',
      );
      assert.deepEqual(
        await resolveOrganizationPropertyTopology(ORG_A),
        { ok: false, reason: 'store_unavailable' },
        'company A received a partial topology after one of its hotels became ambiguous',
      );
      assert.deepEqual(
        await resolveOrganizationPropertyTopology(ORG_B),
        { ok: false, reason: 'store_unavailable' },
        'company B received a partial topology after one of its hotels became ambiguous',
      );
      assert.deepEqual(
        await propertiesOfOrganization(ORG_A),
        [],
        'the lenient company helper leaked company A\'s partial hotel set',
      );
      assert.deepEqual(
        await propertiesOfOrganization(ORG_B),
        [],
        'the lenient company helper leaked company B\'s partial hotel set',
      );
      assert.equal(
        (await loadHats(ACCOUNT_MARIA)).some((hat) => hat.organizationId === ORG_A),
        false,
        'a raw company hat kept cross-company coverage after authoritative reach denied it',
      );

      // The company queue and rulebook consume the same strict topology rather
      // than service-reading the ambiguous hotel's data. The authoritative
      // queue now fails the whole request closed instead of returning a
      // successful empty scope that could hide an authorization outage.
      clearPortfolioAccessCache();
      signedInAs = UID_MARIA;
      const queue = await portfolioGet(req('https://staxis.test/api/company/queue'));
      assert.equal(queue.status, 503);
      const queueBody = await queue.json() as {
        data?: { scope?: unknown; cards?: unknown[] };
      };
      assert.equal(queueBody.data?.scope ?? null, null);
      assert.deepEqual(queueBody.data?.cards ?? [], []);
      assert.equal(
        await statusOf(
          rulebookGet,
          UID_MARIA,
          `https://staxis.test/api/company/rulebook?organizationId=${ORG_A}`,
        ),
        503,
        'the rulebook kept reading a partial company during topology ambiguity',
      );
      assert.deepEqual(
        await loadFreshCompanyInviteAuthorityContext({
          accountId: ACCOUNT_MARIA,
          anchorPropertyId: PID_A1,
          expectedOrganizationId: ORG_A,
        }),
        { kind: 'unavailable' },
        'an invitation preview treated a partial company topology as authoritative',
      );
    } finally {
      // Best-effort re-enable first, even if fixture insertion/assertion failed.
      await pg.query(
        `alter table organization_property_relationships
           enable trigger trg_organization_property_relationships_primary_window_guard`,
      );
      if (corruptRelationshipId) {
        await pg.query(
          `delete from organization_property_relationships where id = $1`,
          [corruptRelationshipId],
        );
      }
      await pg.query(
        `update organization_property_relationships
            set ends_at = null
          where id = $1`,
        [original.rows[0].id],
      );
    }
    assert.equal(await companyForProperty(PID_DISPUTED), ORG_A, 'the fixture did not restore');
    assert.deepEqual(
      await propertiesOfOrganization(ORG_A),
      [PID_A1, PID_A2, PID_DISPUTED].sort(),
      'company A did not recover after the conflicting primary was repaired',
    );
  });

  test('strict topology distinguishes a proven empty company from a store outage', async () => {
    await pg.query(
      `insert into organizations (id, name, organization_type, status)
       values ($1, 'Proven Empty Group', 'management_company', 'active')`,
      [ORG_PROVEN_EMPTY],
    );
    try {
      const empty = await resolveOrganizationPropertyTopology(ORG_PROVEN_EMPTY);
      assert.equal(empty.ok, true, JSON.stringify(empty));
      if (empty.ok) assert.deepEqual(empty.topology.propertyIds, []);
      assert.deepEqual(await propertiesOfOrganization(ORG_PROVEN_EMPTY), []);

      const realRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
      supabaseAdmin.rpc = ((fn: string, args?: Record<string, unknown>) => (
        fn === 'staxis_resolve_organization_property_topology'
          ? Promise.resolve({
            data: {
              ok: true,
              schemaVersion: 'organization-property-topology-v1',
              organizationId: args?.p_organization_id,
              effectiveAt: args?.p_effective_at,
              propertyIds: [PID_A1],
              attackerControlledExtraKey: PID_B1,
            },
            error: null,
          })
          : realRpc(fn, args as never)
      )) as unknown as typeof supabaseAdmin.rpc;
      try {
        assert.deepEqual(
          await resolveOrganizationPropertyTopology(ORG_A),
          { ok: false, reason: 'store_unavailable' },
          'a non-closed service DTO was accepted as authoritative topology',
        );
      } finally {
        supabaseAdmin.rpc = realRpc as unknown as typeof supabaseAdmin.rpc;
      }

      supabaseAdmin.rpc = ((fn: string, args?: unknown) => (
        fn === 'staxis_resolve_organization_property_topology'
          ? Promise.resolve({
            data: null,
            error: { message: 'connection reset by peer', code: '08006' },
          })
          : realRpc(fn, args as never)
      )) as unknown as typeof supabaseAdmin.rpc;
      try {
        assert.deepEqual(
          await resolveOrganizationPropertyTopology(ORG_A),
          { ok: false, reason: 'store_unavailable' },
        );
        assert.deepEqual(await propertiesOfOrganization(ORG_A), []);
        assert.equal(
          (await loadHats(ACCOUNT_MARIA)).some((hat) => hat.organizationId === ORG_A),
          false,
        );
      } finally {
        supabaseAdmin.rpc = realRpc as unknown as typeof supabaseAdmin.rpc;
      }
    } finally {
      await pg.query('delete from organizations where id = $1', [ORG_PROVEN_EMPTY]);
    }
  });

  // ── "we could not tell" is not "nobody runs it" ───────────────────────────
  //
  // `companyForProperty` answers `string | null`, and a read it could not
  // complete answered `null` — the same word as an independent hotel. Every
  // RENDERER is right to treat those the same: show no company section. A GATE
  // is not. The sign-off gate asks "does a company rule govern this action?"
  // and reads `null` as "no rule governs, go ahead", so one dropped connection
  // becomes a silent approval of a spend a VP was supposed to see. That is the
  // same fail-open class the execute-gate fix closed on the money side, and it
  // arrives through this function.
  //
  // Mutation: make `readCompanyResolution` return `{ status: 'independent' }`
  // on an errored read. The first assertion below goes red and the lenient
  // wrapper stays green — which is exactly the state that shipped.
  test('a read that FAILED is not the same answer as a hotel with no company', async () => {
    const failed = await withReadFailure(
      'organization_property_relationships',
      () => resolveCompanyForProperty(PID_A1),
    );
    assert.equal(failed.status, 'unavailable', 'a dropped read reported a definite answer');

    // The second read can fail too, after the relationships came back fine.
    const orgFailed = await withReadFailure(
      'organizations',
      () => resolveCompanyForProperty(PID_A1),
    );
    assert.equal(orgFailed.status, 'unavailable', 'only the first read was honest about failing');

    // …and the definite answers stay definite, or the distinction is useless.
    assert.deepEqual(
      await resolveCompanyForProperty(PID_A1), { status: 'company', organizationId: ORG_A },
    );
    assert.deepEqual(
      await resolveCompanyForProperty(PID_L1), { status: 'independent' },
      'an independent hotel must stay a definite answer — otherwise a strict gate refuses everything',
    );
  });

  test('the lenient wrapper still answers null for all three, exactly as it always did', async () => {
    // Every existing caller renders from this. Nothing about them may move: a
    // company section is drawn for a company and not drawn otherwise, and an
    // unreadable rulebook has always drawn nothing rather than failed the turn.
    assert.equal(await companyForProperty(PID_A1), ORG_A);
    assert.equal(await companyForProperty(PID_L1), null);
    assert.equal(
      await withReadFailure('organizations', () => companyForProperty(PID_A1)), null,
      'a failed read stopped rendering as a plain hotel',
    );
  });
});

// ═══ WHO READS THE COMPANY RULEBOOK (M5) ═══════════════════════════════════

describe('the company rulebook is for company leadership and GMs, not the floor', () => {
  // Mutation: restore `canView = companyRole !== null || gmsSee`. Frank — a
  // front-desk hat at one hotel — reads the company's money policies, its
  // vendor deals and, through the route's payload, how many hotels it owns.
  test('a front-desk hat at one hotel cannot read the company book', async () => {
    const standing = await rulebookStandingFor(ACCOUNT_FRANK, ORG_A);
    assert.equal(standing.canView, false, 'line staff read the whole company rulebook');
    assert.equal(
      await statusOf(rulebookGet, UID_FRANK, `https://staxis.test/api/company/rulebook?propertyId=${PID_A1}`),
      403,
    );
  });

  test('a GM does — that was the founder\'s ruling and it still holds', async () => {
    const standing = await rulebookStandingFor(ACCOUNT_MARIA, ORG_A);
    assert.equal(standing.canView, true, 'the GM ruling was over-narrowed');
    assert.equal(
      await statusOf(rulebookGet, UID_MARIA, `https://staxis.test/api/company/rulebook?propertyId=${PID_A1}`),
      200,
    );
  });

  test('and a housekeeping hat does not, whatever their other login says', async () => {
    assert.equal((await rulebookStandingFor(ACCOUNT_VICKY, ORG_A)).canView, false);
  });
});

// ═══ A PERSON'S CARD NAMES ONLY HOTELS YOU CAN REACH (M6) ══════════════════

describe('the hats card discloses only the caller\'s exact scope intersection', () => {
  // A property-scope GM opening a company person's card must not receive
  // sibling ids/names, sibling-only job lines, or even a count that can be used
  // as a portfolio-size oracle through an arbitrary account id.
  test('a GM sees intersecting jobs with no breadth signal or sister-only line', async () => {
    // Gwen: a GM at Beaumont ONLY, with no company-scope job. She has every
    // right to open Maria's card and no right to a directory.
    const ACCOUNT_GWEN = 'aaaa1111-0000-4000-8000-0000000000g1'.replace('g1', 'e1');
    const UID_GWEN = 'aaaa2222-0000-4000-8000-0000000000g1'.replace('g1', 'e1');
    await pg.query(
      `insert into auth.users (id, email) values ($1, 'gwen@example.test') on conflict (id) do nothing`,
      [UID_GWEN],
    );
    await pg.query(
      `insert into accounts (id, username, password_hash, display_name, role, property_access, data_user_id)
       values ($1, 'gwen', 'x', 'Gwen', 'general_manager', '{}', $2) on conflict (id) do nothing`,
      [ACCOUNT_GWEN, UID_GWEN],
    );
    const gwenMembership = await pg.query<{ id: string }>(
      `select public.staxis_set_membership_hat(
         $1, $2, $3, 'property', 'general_manager', $4, 'General Manager'
       ) as id`,
      [ACCOUNT_ADMIN, ORG_A, ACCOUNT_GWEN, JSON.stringify([PID_A1])],
    );
    const sisterOnly = await pg.query<{ id: string }>(
      `select public.staxis_set_membership_hat(
         $1, $2, $3, 'property', 'maintenance', $4, 'Sister-only engineer'
       ) as id`,
      [ACCOUNT_ADMIN, ORG_A, ACCOUNT_MARIA, JSON.stringify([PID_A2])],
    );

    try {
      signedInAs = UID_GWEN;
      const res = await listHats(req(
        `https://staxis.test/api/auth/team/hats?hotelId=${PID_A1}&accountId=${ACCOUNT_MARIA}`,
      ));
      assert.equal(res.status, 200, 'a GM could not open a colleague\'s card at her own hotel');
      const body = await res.json() as {
        data: { hats: Array<{
          membershipId: string;
          role: string;
          propertyIds: string[];
          propertyNames: string[];
          otherHotelCount?: number;
        }> };
      };

      const oversees = body.data.hats.find((h) => h.role === 'vp');
      assert.ok(oversees, 'Maria\'s company job vanished from her card');
      assert.deepEqual(
        oversees.propertyNames, ['Beaumont Suites'],
        'a property-scope GM was handed the portfolio\'s hotel names',
      );
      assert.deepEqual(oversees.propertyIds, [PID_A1], 'ids leak the same reach names do');
      assert.equal(oversees.otherHotelCount, 0, 'hidden hotel count became a size oracle');
      assert.equal(
        Object.hasOwn(oversees, 'coverageRedacted'),
        false,
        'a redaction marker proved that hidden sister coverage exists',
      );
      assert.equal(
        body.data.hats.some((hat) => hat.membershipId === sisterOnly.rows[0].id),
        false,
        'a sister-only job line leaked through a direct target-account id',
      );

      // And the complete truth is still told to somebody who may hear it:
      // Maria's own company hat reaches the portfolio.
      signedInAs = UID_MARIA;
      const asMaria = await listHats(req(
        `https://staxis.test/api/auth/team/hats?hotelId=${PID_A1}&accountId=${ACCOUNT_MARIA}`,
      ));
      const mariaBody = await asMaria.json() as {
        data: { hats: Array<{
          role: string;
          propertyNames: string[];
          otherHotelCount?: number;
        }> };
      };
      const mariaOversees = mariaBody.data.hats.find((h) => h.role === 'vp');
      assert.ok((mariaOversees?.propertyNames.length ?? 0) > 1, 'the VP lost her own portfolio');
      assert.equal(mariaOversees?.otherHotelCount, 0);

      // Revoke the viewer exactly when the route begins its final actor read.
      // A stale implementation would return the already-assembled card.
      const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
      let accountReads = 0;
      let revokedAtFinalRead = false;
      supabaseAdmin.from = ((table: string) => {
        const builder = realFrom(table);
        if (table === 'accounts') {
          const mutable = builder as unknown as {
            select: (...args: unknown[]) => unknown;
          };
          const originalSelect = mutable.select.bind(mutable);
          mutable.select = (...args: unknown[]) => {
            const selected = originalSelect(...args) as {
              maybeSingle: () => Promise<unknown>;
            };
            const originalMaybeSingle = selected.maybeSingle.bind(selected);
            selected.maybeSingle = async () => {
              accountReads += 1;
              if (accountReads === 3) {
                revokedAtFinalRead = true;
                await pg.query(`select public.staxis_end_membership_hat($1,$2)`, [
                  ACCOUNT_ADMIN, gwenMembership.rows[0].id,
                ]);
              }
              return originalMaybeSingle();
            };
            return selected;
          };
        }
        return builder;
      }) as unknown as typeof supabaseAdmin.from;
      try {
        signedInAs = UID_GWEN;
        const stale = await listHats(req(
          `https://staxis.test/api/auth/team/hats?hotelId=${PID_A1}&accountId=${ACCOUNT_MARIA}`,
        ));
        assert.equal(revokedAtFinalRead, true, 'test did not hit the final receipt boundary');
        assert.equal(stale.status, 403, 'a revoked viewer received a pre-revocation card');
      } finally {
        supabaseAdmin.from = realFrom;
      }
    } finally {
      await pg.query(`select public.staxis_end_membership_hat($1,$2)`, [
        ACCOUNT_ADMIN, sisterOnly.rows[0].id,
      ]);
    }
  });
});

// ═══ THE DATABASE REFUSES A CROSS-TENANT WRITE (M11 / migration 0370) ══════

describe('a link carries its hotel with it', () => {
  // Mutation: drop `work_orders_preventive_task_same_property_fk`. work_orders
  // grants DML to `authenticated`, so this is reachable from a browser: point a
  // ticket at another hotel's upkeep schedule, close it, and the 0366 trigger
  // stamps that hotel's schedule as done from outside it.
  test('a work order cannot point at another hotel\'s upkeep schedule', async () => {
    const task = await pg.query<{ id: string }>(
      `insert into preventive_tasks (property_id, name, area, frequency_days)
       values ($1, 'Water heater flush', 'Building', 90) returning id`,
      [PID_B1],
    );
    await assert.rejects(
      pg.query(
        `insert into work_orders (property_id, room_number, description, severity, status, preventive_task_id)
         values ($1, '101', 'probe', 'MAJOR', 'submitted', $2)`,
        [PID_A1, task.rows[0].id],
      ),
      /same_property|foreign key/i,
      'company A wrote a ticket against company B\'s schedule',
    );
    // The same write inside one hotel is ordinary and must still work.
    await pg.query(
      `insert into work_orders (property_id, room_number, description, severity, status, preventive_task_id)
       values ($1, '101', 'probe', 'MAJOR', 'submitted', $2)`,
      [PID_B1, task.rows[0].id],
    );
  });

  test('a proposed fix cannot be attached to another hotel\'s finding', async () => {
    const finding = await pg.query<{ id: string }>(
      `select id from findings where property_id = $1 limit 1`, [PID_L1],
    );
    await assert.rejects(
      pg.query(
        `insert into finding_actions
           (property_id, finding_id, action_kind, params, idempotency_key)
         values ($1, $2, 'create_work_order', '{}'::jsonb, 'probe:cross-tenant')`,
        [PID_A1, finding.rows[0].id],
      ),
      /same_property|foreign key/i,
      'a one-tap fix at one hotel was attached to another hotel\'s problem',
    );
  });

  test('a schedule name has a ceiling', async () => {
    await assert.rejects(
      pg.query(
        `insert into preventive_tasks (property_id, name, area, frequency_days)
         values ($1, repeat('z', 121), 'Building', 90)`,
        [PID_A1],
      ),
      /preventive_tasks_name_len_ck/i,
      'an unbounded schedule name reaches the nightly model call six times per card',
    );
  });
});

// ═══ A HAT LANDS ONLY ON SOMEBODY WHO BELONGS HERE (M8 / 0370) ═════════════

describe('staxis_set_membership_hat checks who the hat is FOR', () => {
  // Mutation: delete the membership/invitation requirement from the RPC. An
  // owner can then attach a job at their company to any active account id in
  // the product — including a stranger's, who silently gains their hotels.
  test('an owner cannot hand a job to somebody with no tie to the company', async () => {
    await assert.rejects(
      pg.query(
        `select public.staxis_set_membership_hat($1, $2, $3, 'property', 'front_desk', $4, null)`,
        // Ana owns Gulf Coast. Wanda owns an independent hotel and has never
        // heard of them.
        ['aaaa1111-0000-4000-8000-000000000001', ORG_A,
          '1e6ac41e-0000-4000-8000-000000000002', JSON.stringify([PID_A1])],
      ),
      /no job or invitation/i,
      'a company owner attached a job to a stranger\'s account',
    );
  });

  // Mutation: delete the superior-target loop. A GM can then put a housekeeping
  // hat on the company's owner.
  test('a GM cannot attach a job to somebody whose job they could not have given', async () => {
    await assert.rejects(
      pg.query(
        `select public.staxis_set_membership_hat($1, $2, $3, 'property', 'housekeeping', $4, null)`,
        // Maria (GM at Beaumont, VP over Gulf Coast) → Ana, the owner.
        [ACCOUNT_MARIA, ORG_A, 'aaaa1111-0000-4000-8000-000000000001', JSON.stringify([PID_A1])],
      ),
      /could not have given/i,
      'a subordinate attached a job to the company\'s owner',
    );
  });

  test('a Staxis administrator is refused as a target', async () => {
    await assert.rejects(
      pg.query(
        `select public.staxis_set_membership_hat($1, $2, $3, 'property', 'front_desk', $4, null)`,
        [ACCOUNT_ADMIN, ORG_A, ACCOUNT_ADMIN, JSON.stringify([PID_A1])],
      ),
      /administrators cannot hold/i,
    );
  });

  // The grant matrix itself is untouched — every refusal it already made, it
  // still makes, and every grant it already allowed still lands.
  test('the existing grant matrix is unchanged', async () => {
    // Refusal: a company owner reaching into the other company.
    await assert.rejects(
      pg.query(
        `select public.staxis_set_membership_hat($1, $2, $3, 'company', 'vp', null, null)`,
        ['bbbb1111-0000-4000-8000-000000000001', ORG_A, ACCOUNT_FRANK],
      ),
      /may not grant this job/i,
    );
    // Grant: an admin widening a member's existing hat still works.
    const id = await pg.query<{ staxis_set_membership_hat: string }>(
      `select public.staxis_set_membership_hat($1, $2, $3, 'property', 'front_desk', $4, null)
         as staxis_set_membership_hat`,
      [ACCOUNT_ADMIN, ORG_A, ACCOUNT_FRANK, JSON.stringify([PID_A1, PID_A2])],
    );
    assert.ok(id.rows[0].staxis_set_membership_hat, 'the ordinary widening path broke');
    // Put the world back for any test that reads Frank's coverage after this.
    await pg.query(
      `select public.staxis_set_membership_hat($1, $2, $3, 'property', 'front_desk', $4, null)`,
      [ACCOUNT_ADMIN, ORG_A, ACCOUNT_FRANK, JSON.stringify([PID_A1])],
    );
  });
});
