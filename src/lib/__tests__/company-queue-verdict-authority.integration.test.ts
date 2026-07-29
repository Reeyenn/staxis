process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';

import {
  GET as companyQueueGet,
  POST as companyQueuePost,
} from '@/app/api/company/queue/route';
import { touchSilencedCompanyFinding } from '@/lib/company/company-findings';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
} from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_ANA,
  ACCOUNT_MARIA,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  PID_B1,
  UID_ANA,
  UID_MARIA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

type Verdict = 'known_problem' | 'muted' | 'resolved';
type RpcResult =
  | { ok: false }
  | {
    ok: true;
    status: Verdict;
    verdictRevision: number;
    alreadyApplied: boolean;
  };

let pg: PGlite;
let signedInAs: string | null = null;
let sequence = 0;
let requestSequence = 0;

const ORG_SIXTY_ONE = '61610000-0000-4000-8000-000000000061';
const ACCOUNT_SIXTY_ONE = '61611111-0000-4000-8000-000000000061';
const UID_SIXTY_ONE = '61612222-0000-4000-8000-000000000061';
const sixtyOnePropertyId = (index: number) => (
  `61616161-0000-4000-8000-${String(index).padStart(12, '0')}`
);

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

function request(url: string, init?: { method?: string; body?: unknown }): NextRequest {
  requestSequence += 1;
  return new NextRequest(url, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: 'Bearer company-verdict-authority-test',
      'content-type': 'application/json',
      'x-real-ip': `198.51.100.${(requestSequence % 200) + 1}`,
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function plantCompanyFinding(input: {
  organizationId?: string;
  detectorId?: string;
  semanticFamily?: string | null;
  affectedPropertyIds?: string[];
} = {}): Promise<string> {
  sequence += 1;
  const row = await pg.query<{ id: string }>(
    `insert into public.company_findings (
       organization_id, detector_id, dedupe_key, summary, severity,
       disposition, status, receipt_query_id, evidence, magnitude,
       affected_property_ids, semantic_family
     ) values (
       $1, $2, $3, $4, 'attention', 'recommend', 'open',
       'company_verdict_authority_probe', '{}'::jsonb, 7, $5::uuid[], $6
     ) returning id`,
    [
      input.organizationId ?? ORG_A,
      input.detectorId ?? 'portfolio_supply_spend_gap',
      `company-verdict-authority:${sequence}`,
      `Company verdict authority probe ${sequence}.`,
      input.affectedPropertyIds ?? [PID_A1],
      input.semanticFamily ?? null,
    ],
  );
  return row.rows[0]!.id;
}

async function mintAggregateReceipt(accountId: string, organizationId: string): Promise<string> {
  const row = await pg.query<{ result: { ok: boolean; receipt?: { id?: string } } }>(
    `select public.staxis_resolve_authorization_scope(
       $1, $2, 'all_authorized', null, null, 120
     ) as result`,
    [accountId, organizationId],
  );
  const result = row.rows[0]!.result;
  assert.equal(result.ok, true, 'fixture could not mint aggregate receipt');
  assert.match(result.receipt?.id ?? '', /^[0-9a-f-]{36}$/);
  return result.receipt!.id!;
}

async function callVerdict(input: {
  organizationId?: string;
  findingId: string;
  action: Verdict;
  accountId?: string;
  receiptId: string;
  expectedRevision?: number;
}): Promise<RpcResult> {
  const row = await pg.query<{ result: RpcResult }>(
    `select public.staxis_set_company_finding_status_authorized(
       $1, $2, $3, $4, $5, $6
     ) as result`,
    [
      input.organizationId ?? ORG_A,
      input.findingId,
      input.action,
      input.accountId ?? ACCOUNT_MARIA,
      input.receiptId,
      input.expectedRevision ?? 0,
    ],
  );
  return row.rows[0]!.result;
}

async function findingState(findingId: string): Promise<{
  status: string;
  verdict_revision: number;
  status_changed_by: string | null;
}> {
  const row = await pg.query<{
    status: string;
    verdict_revision: number;
    status_changed_by: string | null;
  }>(
    `select status, verdict_revision, status_changed_by
     from public.company_findings where id = $1`,
    [findingId],
  );
  return row.rows[0]!;
}

async function routePost(authUserId: string, body: Record<string, unknown>) {
  signedInAs = authUserId;
  const response = await companyQueuePost(request(
    'https://staxis.test/api/company/queue',
    { method: 'POST', body },
  ));
  const payload = await response.json().catch(() => ({})) as {
    error?: string;
    data?: { status: string; verdictRevision: number; alreadyApplied: boolean };
  };
  return { response, payload };
}

interface QueueCardWire {
  id: string;
  hotel: { propertyId: string; name: string } | null;
  verdictAllowed?: boolean;
  allowedVerdicts?: Verdict[];
  verdictRevision?: number;
}

async function routeGet(authUserId: string, organizationId: string) {
  signedInAs = authUserId;
  const response = await companyQueueGet(request(
    `https://staxis.test/api/company/queue?organizationId=${organizationId}`,
  ));
  const payload = await response.json().catch(() => ({})) as {
    data?: {
      cards: QueueCardWire[];
      canAct: boolean;
      coverage: {
        authorizedHotelCount: number;
        attemptedHotelCount: number;
        processedHotelCount: number;
        omittedHotelCount: number;
        unavailableHotelCount: number;
        excludedFindingCount: number;
        portfolioChecksStatus: string;
        complete: boolean;
      };
    };
  };
  return {
    response,
    cards: payload.data?.cards ?? [],
    canAct: payload.data?.canAct ?? false,
    coverage: payload.data?.coverage ?? null,
  };
}

before(async () => {
  const migrated = await applyMigrationsToPglite();
  pg = migrated.pg;
  const shim = createPglitePostgrest(pg, await loadCatalog(pg));
  // @ts-expect-error PGlite-backed runtime-compatible test client.
  supabaseAdmin.from = shim.from;
  // @ts-expect-error PGlite-backed runtime-compatible test client.
  supabaseAdmin.rpc = shim.rpc;
  // @ts-expect-error the session gate only consumes the auth user id.
  supabaseAdmin.auth.getUser = async () => (
    signedInAs
      ? { data: { user: { id: signedInAs, email: 'authority@example.test' } }, error: null }
      : { data: { user: null }, error: { message: 'no session', status: 401, name: 'AuthApiError' } }
  );
  await seedTwoCompanies(pg);
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  await pg?.close();
});

describe('0405 atomic company queue verdict', { concurrency: false }, () => {
  test('company-only Owner reach is read-only and mixed exact-hotel targets deny atomically', async () => {
    const ownerFinding = await plantCompanyFinding();
    const ownerReceipt = await mintAggregateReceipt(ACCOUNT_ANA, ORG_A);
    assert.deepEqual(await callVerdict({
      findingId: ownerFinding,
      action: 'resolved',
      accountId: ACCOUNT_ANA,
      receiptId: ownerReceipt,
    }), { ok: false });
    assert.deepEqual(await findingState(ownerFinding), {
      status: 'open', verdict_revision: 0, status_changed_by: null,
    });

    const mixed = await plantCompanyFinding({ affectedPropertyIds: [PID_A1, PID_A2] });
    const managerReceipt = await mintAggregateReceipt(ACCOUNT_MARIA, ORG_A);
    assert.deepEqual(await callVerdict({
      findingId: mixed,
      action: 'muted',
      receiptId: managerReceipt,
    }), { ok: false });
    assert.deepEqual(await findingState(mixed), {
      status: 'open', verdict_revision: 0, status_changed_by: null,
    });
  });

  test('empty, duplicate, out-of-order, cross-tenant, and unknown family targets share one denial', async () => {
    const receipt = await mintAggregateReceipt(ACCOUNT_MARIA, ORG_A);
    const probes = [
      await plantCompanyFinding({ affectedPropertyIds: [] }),
      await plantCompanyFinding({ affectedPropertyIds: [PID_A1, PID_A1] }),
      await plantCompanyFinding({ affectedPropertyIds: [PID_A2, PID_A1] }),
      await plantCompanyFinding({ detectorId: 'future_unknown_company_detector' }),
      await plantCompanyFinding({ semanticFamily: 'future_unknown_family' }),
      await plantCompanyFinding({
        affectedPropertyIds: Array.from({ length: 251 }, (_unused, index) => (
          `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
        )),
      }),
    ];
    for (const findingId of probes) {
      assert.deepEqual(await callVerdict({
        findingId,
        action: 'resolved',
        receiptId: receipt,
      }), { ok: false });
      assert.equal((await findingState(findingId)).status, 'open');
    }
    await pg.query(
      `update public.company_findings
       set status = 'expired', status_changed_at = clock_timestamp()
       where id = any($1::uuid[]) and status = 'open'`,
      [probes],
    );

    const foreign = await plantCompanyFinding({
      organizationId: ORG_B,
      detectorId: 'portfolio_activity_stopped',
      affectedPropertyIds: [PID_B1],
    });
    assert.deepEqual(await callVerdict({
      organizationId: ORG_B,
      findingId: foreign,
      action: 'known_problem',
      receiptId: receipt,
    }), { ok: false });
    assert.equal((await findingState(foreign)).status, 'open');
  });

  test('strict section state and stale receipts fail closed without touching the row', async () => {
    const findingId = await plantCompanyFinding();
    const receipt = await mintAggregateReceipt(ACCOUNT_MARIA, ORG_A);
    for (const section of [
      JSON.stringify({ staxis: false }),
      JSON.stringify({ staxis: null }),
      JSON.stringify('malformed'),
    ]) {
      await pg.query(
        'update public.properties set enabled_sections = $2::jsonb where id = $1',
        [PID_A1, section],
      );
      assert.deepEqual(await callVerdict({
        findingId,
        action: 'resolved',
        receiptId: receipt,
      }), { ok: false });
      assert.deepEqual(await findingState(findingId), {
        status: 'open', verdict_revision: 0, status_changed_by: null,
      });
    }
    await pg.query('update public.properties set enabled_sections = null where id = $1', [PID_A1]);

    await pg.query(
      `update public.account_authorization_state
       set authority_version = authority_version + 1 where account_id = $1`,
      [ACCOUNT_MARIA],
    );
    assert.deepEqual(await callVerdict({
      findingId,
      action: 'resolved',
      receiptId: receipt,
    }), { ok: false });
    assert.equal((await findingState(findingId)).status, 'open');
  });

  test('closed base and action capability overrides deny every affected hotel', async () => {
    const cases: Array<{
      detectorId: string;
      action: Verdict;
      capability: string;
    }> = [
      {
        detectorId: 'portfolio_supply_spend_gap',
        action: 'resolved',
        capability: 'view_financials',
      },
      {
        detectorId: 'portfolio_supply_spend_gap',
        action: 'known_problem',
        capability: 'manage_notifications',
      },
      {
        detectorId: 'portfolio_activity_stopped',
        action: 'resolved',
        capability: 'run_reports',
      },
    ];
    for (const probe of cases) {
      const findingId = await plantCompanyFinding({ detectorId: probe.detectorId });
      await pg.query(
        `insert into public.capability_overrides(
           property_id, capability, role, allowed
         ) values ($1, $2, 'general_manager', false)`,
        [PID_A1, probe.capability],
      );
      const receipt = await mintAggregateReceipt(ACCOUNT_MARIA, ORG_A);
      assert.deepEqual(await callVerdict({
        findingId,
        action: probe.action,
        receiptId: receipt,
      }), { ok: false });
      assert.deepEqual(await findingState(findingId), {
        status: 'open', verdict_revision: 0, status_changed_by: null,
      });
      await pg.query(
        `delete from public.capability_overrides
         where property_id = $1 and capability = $2 and role = 'general_manager'`,
        [PID_A1, probe.capability],
      );
    }
  });

  test('exact manager success CASes once, audits once, and lost-response retry is idempotent after fresh policy', async () => {
    const findingId = await plantCompanyFinding({ semanticFamily: 'supply_spend_control' });
    const receipt = await mintAggregateReceipt(ACCOUNT_MARIA, ORG_A);
    assert.deepEqual(await callVerdict({
      findingId,
      action: 'resolved',
      receiptId: receipt,
    }), {
      ok: true,
      status: 'resolved',
      verdictRevision: 1,
      alreadyApplied: false,
    });
    assert.deepEqual(await findingState(findingId), {
      status: 'resolved', verdict_revision: 1, status_changed_by: ACCOUNT_MARIA,
    });

    await pg.query(
      `update public.properties
       set enabled_sections = '{"staxis":false}'::jsonb where id = $1`,
      [PID_A1],
    );
    assert.deepEqual(await callVerdict({
      findingId,
      action: 'resolved',
      receiptId: receipt,
      expectedRevision: 0,
    }), { ok: false }, 'a retry bypassed fresh section policy');
    await pg.query('update public.properties set enabled_sections = null where id = $1', [PID_A1]);

    assert.deepEqual(await callVerdict({
      findingId,
      action: 'resolved',
      receiptId: receipt,
      expectedRevision: 0,
    }), {
      ok: true,
      status: 'resolved',
      verdictRevision: 1,
      alreadyApplied: true,
    });
    assert.deepEqual(await callVerdict({
      findingId,
      action: 'muted',
      receiptId: receipt,
      expectedRevision: 0,
    }), { ok: false }, 'a conflicting stale action was treated as a retry');

    const audit = await pg.query<{
      n: string;
      required_capabilities: string[];
      selector_type: string;
    }>(
      `select count(*)::text as n,
              min(event.required_capabilities)::text[] as required_capabilities,
              min(receipt.selector_type) as selector_type
       from public.company_finding_verdict_events event
       join public.authorization_scope_receipts receipt
         on receipt.id = event.exact_scope_receipt_id
       where event.finding_id = $1`,
      [findingId],
    );
    assert.equal(audit.rows[0]!.n, '1');
    assert.deepEqual(audit.rows[0]!.required_capabilities, [
      'manage_checklists', 'manage_inventory_orders', 'view_financials',
    ]);
    assert.equal(audit.rows[0]!.selector_type, 'property_subset');
    assert.equal((await pg.query<{ n: string }>(
      'select count(*)::text as n from public.company_finding_verdict_write_tokens',
    )).rows[0]!.n, '0');
  });

  test('a detector escalation invalidates an older lost-response retry', async () => {
    const findingId = await plantCompanyFinding();
    const receipt = await mintAggregateReceipt(ACCOUNT_MARIA, ORG_A);
    assert.deepEqual(await callVerdict({
      findingId,
      action: 'known_problem',
      receiptId: receipt,
    }), {
      ok: true,
      status: 'known_problem',
      verdictRevision: 1,
      alreadyApplied: false,
    });

    // This is the detector-owned edge used when a known problem grows enough
    // to break its silence. It deliberately does not mint a human revision.
    await pg.query(
      `update public.company_findings
       set status = 'updated', escalated_at = clock_timestamp(),
           status_changed_at = clock_timestamp()
       where id = $1 and status = 'known_problem'`,
      [findingId],
    );
    assert.deepEqual(await findingState(findingId), {
      status: 'updated', verdict_revision: 1, status_changed_by: ACCOUNT_MARIA,
    });
    assert.deepEqual(await callVerdict({
      findingId,
      action: 'known_problem',
      receiptId: receipt,
      expectedRevision: 0,
    }), { ok: false }, 'a historical audit edge was reported as the current status');
  });

  test('muted lineage expansion and known-problem lineage shift rearm atomically', async () => {
    const probes: Array<{
      action: Extract<Verdict, 'muted' | 'known_problem'>;
      affectedPropertyIds: string[];
      label: string;
    }> = [
      {
        action: 'muted',
        affectedPropertyIds: [PID_A1, PID_A2],
        label: 'expanded',
      },
      {
        action: 'known_problem',
        affectedPropertyIds: [PID_A2],
        label: 'shifted',
      },
    ];

    for (const probe of probes) {
      const findingId = await plantCompanyFinding();
      const receipt = await mintAggregateReceipt(ACCOUNT_MARIA, ORG_A);
      assert.deepEqual(await callVerdict({
        findingId,
        action: probe.action,
        receiptId: receipt,
      }), {
        ok: true,
        status: probe.action,
        verdictRevision: 1,
        alreadyApplied: false,
      });

      const summary = `Lineage ${probe.label} under fresh detector evidence.`;
      const observedAt = new Date(Date.now() + 1_000);
      const outcome = await touchSilencedCompanyFinding({
        organizationId: ORG_A,
        detectorId: 'portfolio_supply_spend_gap',
        dedupeKey: `company-verdict-authority:${sequence}`,
        affectedPropertyIds: probe.affectedPropertyIds,
        draft: {
          key: 'supply_spend',
          summary,
          severity: 'attention',
          magnitude: 8,
          evidence: {
            queryId: 'company_verdict_lineage_probe',
            params: { affected_property_ids: probe.affectedPropertyIds },
            values: { lineage: probe.label },
            basis: 'real SQL lineage epoch regression',
          },
          price: null,
          asOf: observedAt,
          weakestInputAgeDays: 0,
        },
        receiptQueryId: 'company_verdict_lineage_probe',
        disposition: 'recommend',
        now: observedAt,
      }, findingId);
      assert.equal(outcome, 'updated');

      const state = await pg.query<{
        status: string;
        verdict_revision: number;
        summary: string;
        affected_property_ids: string[];
        evidence: { values?: { lineage?: string } };
        occurrence_count: number;
        status_changed_at: string;
      }>(
        `select status, verdict_revision, summary, affected_property_ids,
                evidence, occurrence_count, status_changed_at
         from public.company_findings where id = $1`,
        [findingId],
      );
      assert.deepEqual(state.rows[0], {
        status: 'updated',
        verdict_revision: 2,
        summary,
        affected_property_ids: probe.affectedPropertyIds,
        evidence: {
          queryId: 'company_verdict_lineage_probe',
          params: { affected_property_ids: probe.affectedPropertyIds },
          values: { lineage: probe.label },
          basis: 'real SQL lineage epoch regression',
        },
        occurrence_count: 2,
        status_changed_at: state.rows[0]!.status_changed_at,
      });
      assert.ok(state.rows[0]!.status_changed_at, 'the lineage rearm was not timestamped');
      assert.deepEqual(await callVerdict({
        findingId,
        action: probe.action,
        receiptId: receipt,
        expectedRevision: 0,
      }), { ok: false }, 'an old-lineage lost-response retry survived the new epoch');
      await pg.query(
        `update public.company_findings
         set status = 'expired', status_changed_at = clock_timestamp()
         where id = $1 and status = 'updated'`,
        [findingId],
      );
    }
  });

  test('lost-response retry requires the audit event exact current hotel lineage', async () => {
    const findingId = await plantCompanyFinding();
    const receipt = await mintAggregateReceipt(ACCOUNT_MARIA, ORG_A);
    assert.equal((await callVerdict({
      findingId,
      action: 'resolved',
      receiptId: receipt,
    })).ok, true);

    // Simulate a poisoned pre-invariant database while leaving the current row,
    // action, actor and revision otherwise identical. Normal writes cannot do
    // this because the event is immutable; the explicit trigger suspension is
    // test-only proof that retry identity includes lineage, not just revision.
    await pg.exec(
      'alter table public.company_finding_verdict_events ' +
      'disable trigger company_finding_verdict_events_immutable',
    );
    try {
      await pg.query(
        `update public.company_finding_verdict_events
         set affected_property_ids = array[$2]::uuid[]
         where finding_id = $1`,
        [findingId, PID_A2],
      );
    } finally {
      await pg.exec(
        'alter table public.company_finding_verdict_events ' +
        'enable trigger company_finding_verdict_events_immutable',
      );
    }

    try {
      assert.deepEqual(await callVerdict({
        findingId,
        action: 'resolved',
        receiptId: receipt,
        expectedRevision: 0,
      }), { ok: false });
    } finally {
      await pg.exec(
        'alter table public.company_finding_verdict_events ' +
        'disable trigger company_finding_verdict_events_immutable',
      );
      try {
        await pg.query(
          `update public.company_finding_verdict_events
           set affected_property_ids = array[$2]::uuid[]
           where finding_id = $1`,
          [findingId, PID_A1],
        );
      } finally {
        await pg.exec(
          'alter table public.company_finding_verdict_events ' +
          'enable trigger company_finding_verdict_events_immutable',
        );
      }
    }
  });

  test('service-role direct writes and forged marker settings cannot bypass the exact RPC fence', async () => {
    const findingId = await plantCompanyFinding();
    let directError: unknown = null;
    await pg.exec('set role service_role');
    try {
      await pg.query(
        `update public.company_findings
         set status = 'muted', status_changed_by = $2,
             silenced_at_magnitude = magnitude
         where id = $1`,
        [findingId, ACCOUNT_MARIA],
      );
    } catch (error) {
      directError = error;
    } finally {
      await pg.exec('reset role');
    }
    assert.match(String(directError), /authorized RPC|permission denied/i);
    assert.equal((await findingState(findingId)).status, 'open');

    let forgedError: unknown = null;
    await pg.exec('set role service_role');
    try {
      await pg.query("select set_config('staxis.company_finding_verdict_token', $1, true)", [
        '11111111-1111-4111-8111-111111111111',
      ]);
      await pg.query(
        `update public.company_findings
         set status = 'resolved', status_changed_by = $2,
             resolved_at = now(), verdict_revision = verdict_revision + 1
         where id = $1`,
        [findingId, ACCOUNT_MARIA],
      );
    } catch (error) {
      forgedError = error;
    } finally {
      await pg.exec('reset role');
    }
    assert.match(String(forgedError), /authorized RPC|permission denied/i);
    assert.deepEqual(await findingState(findingId), {
      status: 'open', verdict_revision: 0, status_changed_by: null,
    });

    const receipt = await mintAggregateReceipt(ACCOUNT_MARIA, ORG_A);
    let browserRpcError: unknown = null;
    await pg.exec('set role authenticated');
    try {
      await pg.query(
        `select public.staxis_set_company_finding_status_authorized(
           $1, $2, 'resolved', $3, $4, 0
         )`,
        [ORG_A, findingId, ACCOUNT_MARIA, receipt],
      );
    } catch (error) {
      browserRpcError = error;
    } finally {
      await pg.exec('reset role');
    }
    assert.match(String(browserRpcError), /permission denied/i);
    assert.equal((await findingState(findingId)).status, 'open');

    assert.deepEqual(await callVerdict({
      findingId,
      action: 'resolved',
      receiptId: receipt,
    }), {
      ok: true,
      status: 'resolved',
      verdictRevision: 1,
      alreadyApplied: false,
    });
    let reopenError: unknown = null;
    await pg.exec('set role service_role');
    try {
      await pg.query(
        `update public.company_findings set status = 'open' where id = $1`,
        [findingId],
      );
    } catch (error) {
      reopenError = error;
    } finally {
      await pg.exec('reset role');
    }
    assert.match(String(reopenError), /authorized RPC|permission denied/i);
    assert.deepEqual(await findingState(findingId), {
      status: 'resolved', verdict_revision: 1, status_changed_by: ACCOUNT_MARIA,
    });
  });

  test('the immutable audit rejects owner updates too', async () => {
    const event = await pg.query<{ id: string }>(
      'select id from public.company_finding_verdict_events order by occurred_at limit 1',
    );
    assert.ok(event.rows[0]?.id);
    await assert.rejects(
      () => pg.query(
        `update public.company_finding_verdict_events
         set action = 'muted' where id = $1`,
        [event.rows[0]!.id],
      ),
      /immutable/i,
    );
  });
});

describe('company queue route and truthful GET affordances', { concurrency: false }, () => {
  test('POST requires explicit organization + CAS and maps every closed RPC denial to generic 403', async () => {
    const findingId = await plantCompanyFinding();
    const missingOrganization = await routePost(UID_MARIA, {
      findingId,
      action: 'resolved',
      expectedVerdictRevision: 0,
    });
    assert.equal(missingOrganization.response.status, 400);
    const missingRevision = await routePost(UID_MARIA, {
      organizationId: ORG_A,
      findingId,
      action: 'resolved',
    });
    assert.equal(missingRevision.response.status, 400);

    const ownerDenied = await routePost(UID_ANA, {
      organizationId: ORG_A,
      findingId,
      action: 'resolved',
      expectedVerdictRevision: 0,
    });
    assert.equal(ownerDenied.response.status, 403);
    assert.equal(ownerDenied.payload.error, 'Forbidden');
    assert.equal((await findingState(findingId)).status, 'open');

    const foreign = await plantCompanyFinding({
      organizationId: ORG_B,
      detectorId: 'portfolio_activity_stopped',
      affectedPropertyIds: [PID_B1],
    });
    const crossTenant = await routePost(UID_MARIA, {
      organizationId: ORG_A,
      findingId: foreign,
      action: 'resolved',
      expectedVerdictRevision: 0,
    });
    assert.equal(crossTenant.response.status, 403);
    assert.equal(crossTenant.payload.error, 'Forbidden');
    assert.equal((await findingState(foreign)).status, 'open');
  });

  test('POST succeeds for the exact manager and a lost-response retry does not duplicate it', async () => {
    const findingId = await plantCompanyFinding();
    const body = {
      organizationId: ORG_A,
      findingId,
      action: 'known_problem',
      expectedVerdictRevision: 0,
    };
    const first = await routePost(UID_MARIA, body);
    assert.equal(first.response.status, 200);
    assert.deepEqual(first.payload.data, {
      status: 'known_problem', verdictRevision: 1, alreadyApplied: false,
    });
    const retry = await routePost(UID_MARIA, body);
    assert.equal(retry.response.status, 200);
    assert.deepEqual(retry.payload.data, {
      status: 'known_problem', verdictRevision: 1, alreadyApplied: true,
    });
    assert.equal((await pg.query<{ n: string }>(
      `select count(*)::text as n from public.company_finding_verdict_events
       where finding_id = $1`,
      [findingId],
    )).rows[0]!.n, '1');
  });

  test('POST distinguishes only an explicit atomic-RPC outage as retryable 503', async () => {
    const findingId = await plantCompanyFinding();
    const previousRpc = supabaseAdmin.rpc;
    const callPrevious = previousRpc.bind(supabaseAdmin) as (
      functionName: string,
      args?: Record<string, unknown>,
    ) => unknown;
    supabaseAdmin.rpc = ((functionName: string, args?: Record<string, unknown>) => (
      functionName === 'staxis_set_company_finding_status_authorized'
        ? Promise.resolve({ data: null, error: { message: 'forced RPC outage', code: 'XX000' } })
        : callPrevious(functionName, args)
    )) as typeof supabaseAdmin.rpc;
    try {
      const result = await routePost(UID_MARIA, {
        organizationId: ORG_A,
        findingId,
        action: 'resolved',
        expectedVerdictRevision: 0,
      });
      assert.equal(result.response.status, 503);
      assert.equal(result.response.headers.get('retry-after'), '5');
      assert.equal((await findingState(findingId)).status, 'open');
    } finally {
      supabaseAdmin.rpc = previousRpc;
    }
  });

  test('GET grants exact company controls only where every target, section, and action capability passes', async () => {
    const exact = await plantCompanyFinding();
    const mixed = await plantCompanyFinding({ affectedPropertyIds: [PID_A1, PID_A2] });
    const unknown = await plantCompanyFinding({ detectorId: 'future_unknown_company_detector' });
    const crossScopeLineage = await plantCompanyFinding({ affectedPropertyIds: [PID_B1] });

    const maria = await routeGet(UID_MARIA, ORG_A);
    assert.equal(maria.response.status, 200);
    const exactCard = maria.cards.find((card) => card.id === exact);
    assert.equal(exactCard?.verdictAllowed, true);
    assert.deepEqual(exactCard?.allowedVerdicts, [
      'known_problem', 'muted', 'resolved',
    ]);
    assert.equal(exactCard?.verdictRevision, 0);
    assert.equal(maria.cards.find((card) => card.id === mixed)?.verdictAllowed, false);
    assert.equal(maria.cards.find((card) => card.id === unknown)?.verdictAllowed, false);
    assert.equal(
      maria.cards.find((card) => card.id === crossScopeLineage),
      undefined,
      'a poisoned cross-scope target lineage crossed the GET boundary read-only',
    );
    assert.equal(maria.coverage?.excludedFindingCount, 1);
    assert.equal(maria.coverage?.complete, false, 'a poisoned card produced complete coverage');

    const ana = await routeGet(UID_ANA, ORG_A);
    assert.equal(ana.response.status, 200);
    assert.equal(ana.cards.find((card) => card.id === exact)?.verdictAllowed, false);

    await pg.query(
      `insert into public.capability_overrides(
         property_id, capability, role, allowed
       ) values ($1, 'manage_notifications', 'general_manager', false)`,
      [PID_A1],
    );
    const capabilityRestricted = await routeGet(UID_MARIA, ORG_A);
    assert.deepEqual(
      capabilityRestricted.cards.find((card) => card.id === exact)?.allowedVerdicts,
      ['resolved'],
    );
    await pg.query(
      `delete from public.capability_overrides
       where property_id = $1 and capability = 'manage_notifications'
         and role = 'general_manager'`,
      [PID_A1],
    );

    await pg.query(
      `update public.properties
       set enabled_sections = '{"staxis":false}'::jsonb where id = $1`,
      [PID_A1],
    );
    const sectionRestricted = await routeGet(UID_MARIA, ORG_A);
    assert.equal(
      sectionRestricted.cards.find((card) => card.id === exact)?.verdictAllowed,
      false,
    );
    await pg.query('update public.properties set enabled_sections = null where id = $1', [PID_A1]);
  });

  test('61 authorized hotels keep full receipt coverage while bounded GET and chunked card authority stay truthful', async () => {
    await pg.query(
      `insert into auth.users(id, email) values ($1, 'sixty-one@example.test')
       on conflict (id) do nothing`,
      [UID_SIXTY_ONE],
    );
    await pg.query(
      `insert into public.accounts(
         id, username, password_hash, display_name, role, property_access, data_user_id
       ) values ($1, 'sixty_one_vp', 'x', 'Sixty One VP', 'front_desk', '{}', $2)
       on conflict (id) do nothing`,
      [ACCOUNT_SIXTY_ONE, UID_SIXTY_ONE],
    );
    await pg.query(
      `insert into public.organizations(id, name, organization_type, status)
       values ($1, 'Sixty One Hotels', 'management_company', 'active')
       on conflict (id) do nothing`,
      [ORG_SIXTY_ONE],
    );
    const propertyIds = Array.from({ length: 61 }, (_unused, index) => (
      sixtyOnePropertyId(index + 1)
    ));
    for (const [index, propertyId] of propertyIds.entries()) {
      await pg.query(
        `insert into public.properties(id, name, owner_id, total_rooms, timezone)
         values ($1, $2, $3, 60, 'America/Chicago')
         on conflict (id) do nothing`,
        [propertyId, `Sixty One Hotel ${index + 1}`, UID_SIXTY_ONE],
      );
      await pg.query(
        `update public.organization_property_relationships
         set is_primary_grouping = false
         where property_id = $1 and ends_at is null and is_primary_grouping`,
        [propertyId],
      );
      await pg.query(
        `insert into public.organization_property_relationships(
           organization_id, property_id, relationship_type, is_primary_grouping
         ) values ($1, $2, 'operator', true)`,
        [ORG_SIXTY_ONE, propertyId],
      );
    }
    await pg.query(
      `select public.staxis_set_membership_hat(
         $1, $2, $3, 'company', 'vp', null, 'VP'
       )`,
      [ACCOUNT_ADMIN, ORG_SIXTY_ONE, ACCOUNT_SIXTY_ONE],
    );
    const findingId = await plantCompanyFinding({
      organizationId: ORG_SIXTY_ONE,
      detectorId: 'portfolio_activity_stopped',
      semanticFamily: 'portfolio_activity_stopped',
      affectedPropertyIds: propertyIds,
    });

    const result = await routeGet(UID_SIXTY_ONE, ORG_SIXTY_ONE);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.coverage, {
      authorizedHotelCount: 61,
      attemptedHotelCount: 30,
      processedHotelCount: 30,
      omittedHotelCount: 31,
      unavailableHotelCount: 0,
      excludedFindingCount: 0,
      portfolioChecksStatus: 'completed',
      complete: false,
    });
    const card = result.cards.find((candidate) => candidate.id === findingId);
    assert.ok(card, 'the 61-target company card was truncated from GET');
    assert.equal(card.verdictAllowed, false, 'company-only VP received mutation controls');
  });
});
