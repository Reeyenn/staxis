/**
 * Executable contract for migration 0392's immutable management-pattern plane.
 *
 * The fixture is deliberately 0367-shaped: the real migration must extend the
 * old mutable company_findings ledger without depending on later runtime code.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const ORG_A = '10000000-0000-4000-8000-000000000001';
const ORG_B = '10000000-0000-4000-8000-000000000002';
const PROPERTY_A = '20000000-0000-4000-8000-000000000001';
const PROPERTY_B = '20000000-0000-4000-8000-000000000002';
const PROPERTY_FOREIGN = '20000000-0000-4000-8000-000000000003';
const REL_A = '30000000-0000-4000-8000-000000000001';
const REL_B = '30000000-0000-4000-8000-000000000002';
const REL_FOREIGN = '30000000-0000-4000-8000-000000000003';
const LOCAL_FINDING = '40000000-0000-4000-8000-000000000001';
const OWNER_A = '50000000-0000-4000-8000-000000000001';
const OWNER_B = '50000000-0000-4000-8000-000000000002';
const ACCOUNT_A = '51000000-0000-4000-8000-000000000001';
const ACCOUNT_B = '51000000-0000-4000-8000-000000000002';
const SCOPE_RECEIPT_A = '52000000-0000-4000-8000-000000000001';
const SCOPE_RECEIPT_SUBSET = '52000000-0000-4000-8000-000000000002';
const SCOPE_RECEIPT_EXPIRED = '52000000-0000-4000-8000-000000000003';
const SCOPE_RECEIPT_REVOKED = '52000000-0000-4000-8000-000000000004';
const SCOPE_RECEIPT_CHANGED = '52000000-0000-4000-8000-000000000005';
const SCOPE_RECEIPT_BAD_COUNT = '52000000-0000-4000-8000-000000000006';
const SCOPE_RECEIPT_MISSING = '52000000-0000-4000-8000-000000000007';
const SCOPE_RECEIPT_NULL_FIELDS = '52000000-0000-4000-8000-000000000008';
const OUTCOME = '60000000-0000-4000-8000-000000000001';
const OUTCOME_NORMAL = '60000000-0000-4000-8000-000000000002';
const OUTCOME_CONFLICT_GATE = '60000000-0000-4000-8000-000000000003';
const OBSERVATION = '61000000-0000-4000-8000-000000000001';
const RECONCILIATION = '62000000-0000-4000-8000-000000000001';
const BUDGET_RECONCILIATION = '62000000-0000-4000-8000-000000000002';
const CONFLICT_RECONCILIATION = '62000000-0000-4000-8000-000000000003';
const EXTRA_DETECTOR_RECONCILIATION = '62000000-0000-4000-8000-000000000004';
const CANDIDATES = [
  '70000000-0000-4000-8000-000000000001',
  '70000000-0000-4000-8000-000000000002',
  '70000000-0000-4000-8000-000000000003',
  '70000000-0000-4000-8000-000000000004',
  '70000000-0000-4000-8000-000000000005',
  '70000000-0000-4000-8000-000000000006',
] as const;

const H = {
  input: 'a'.repeat(64),
  portfolio: 'b'.repeat(64),
  propertyA: 'c'.repeat(64),
  propertyB: 'd'.repeat(64),
  outcome: 'e'.repeat(64),
};

const SOURCE_CUTOFF = '2026-07-06T11:00:00Z';

function sourceAccessWatermark(extra: Record<string, unknown>) {
  return {
    ...extra,
    source_as_of: SOURCE_CUTOFF,
    requested_source_as_of: SOURCE_CUTOFF,
    effective_source_cutoff: SOURCE_CUTOFF,
    effective_source_cutoff_is_exclusive: false,
    effective_source_cutoff_reason: 'requested_source_as_of',
    effective_source_cutoff_proof_kind: 'request',
    effective_source_cutoff_proof_at: SOURCE_CUTOFF,
  };
}

function exactSupplySourceFacts(observationId = OBSERVATION) {
  const numerator = ['2026-01-01', '2026-02-01', '2026-03-01'].map((month, index) => {
    const periodEndAt = [
      '2026-02-01T06:00:00Z',
      '2026-03-01T06:00:00Z',
      '2026-04-01T05:00:00Z',
    ][index]!;
    const id = `71000000-0000-4000-8000-00000000000${index + 1}`;
    const updatedAt = periodEndAt;
    const factPayload = {
      id,
      month_start: month,
      timezone: 'America/Chicago',
      status: 'closed',
      month_start_at: `${month}T06:00:00Z`,
      end_at: periodEndAt,
      is_partial: false,
      purchase_source: 'manual_total',
      allocation_mode: 'total_only',
      confirmed_purchase_storage_cents: 40_000,
      logged_purchase_storage_cents: 40_000,
      manual_purchase_storage_cents: 0,
      logged_delivery_count: 4,
      uncosted_delivery_count: 0,
      quality_flags: [],
      quality_flags_oversize: false,
      source_window_compatible: true,
      closed_at: updatedAt,
      created_at: `${month}T06:00:00Z`,
      updated_at: updatedAt,
      source_query_id: 'management_pattern_inventory_month_closes',
      source_query_version: 'management-pattern-source-snapshot.v2',
      source_recorded_at: updatedAt,
      included_in_aggregate: true,
      numeric_value: 40_000,
    };
    return {
      observation_id: observationId,
      fact_role: 'numerator',
      fact_kind: 'supply_period',
      fact_key: month,
      source_query_id: factPayload.source_query_id,
      source_query_version: factPayload.source_query_version,
      source_recorded_at: updatedAt,
      included_in_aggregate: true,
      numeric_value: 40_000,
      fact_payload: factPayload,
    };
  });
  const denominator = Array.from({ length: 90 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
    const nextDate = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000)
      .toISOString().slice(0, 10);
    // This fixture spans Chicago's 2026 spring transition. Keep the expected
    // civil-time mapping explicit: local 04:00 is UTC-6 before Mar 8 and UTC-5
    // afterward. PostgreSQL independently recomputes and validates it.
    const chicagoOffsetHours = nextDate < '2026-03-08' ? 6 : 5;
    const coverageEnd = new Date(
      Date.parse(`${nextDate}T04:00:00.000Z`) + chicagoOffsetHours * 60 * 60_000,
    );
    const roomsSold = index === 0 ? 11 : 1;
    const updatedAt = `${date}T12:00:00Z`;
    const factPayload = {
      date,
      coverage_through: new Date(coverageEnd.getTime() - 1).toISOString(),
      rooms_sold: roomsSold,
      occupancy_source: 'pms_report',
      sealed_at: updatedAt,
      seal_version: 1,
      source_completeness_receipt: {
        occupancy_complete: true,
        occupancy_bucket: 'pms_report',
        source_completeness_fingerprint: '9'.repeat(64),
      },
      source_completeness_oversize: false,
      denominator_complete: true,
      created_at: `${date}T10:00:00Z`,
      updated_at: updatedAt,
      source_query_id: 'management_pattern_daily_log_occupancy',
      source_query_version: 'management-pattern-source-snapshot.v2',
      source_recorded_at: updatedAt,
      included_in_aggregate: true,
      numeric_value: roomsSold,
    };
    return {
      observation_id: observationId,
      fact_role: 'denominator',
      fact_kind: 'rooms_sold_day',
      fact_key: date,
      source_query_id: factPayload.source_query_id,
      source_query_version: factPayload.source_query_version,
      source_recorded_at: updatedAt,
      included_in_aggregate: true,
      numeric_value: roomsSold,
      fact_payload: factPayload,
    };
  });
  return [...numerator, ...denominator];
}

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0392_management_company_patterns.sql'),
  'utf8',
);

const SOURCE_MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0389_management_pattern_source_snapshot.sql'),
  'utf8',
);

let pg: PGlite;
let runId: string;

function portfolioManifest(properties: readonly {
  propertyId: string;
  relationshipId: string;
  hash: string;
  eligibility?: 'included' | 'excluded';
  exclusions?: readonly string[];
}[] = [
  { propertyId: PROPERTY_A, relationshipId: REL_A, hash: H.propertyA },
  { propertyId: PROPERTY_B, relationshipId: REL_B, hash: H.propertyB },
]) {
  return {
    schema_version: 2,
    organization_id: ORG_A,
    organization_type: 'management_company',
    evaluation_at: '2026-07-06T12:00:00Z',
    source_as_of: '2026-07-06T11:00:00Z',
    topology_as_of: '2026-07-06T00:00:00Z',
    analysis_window_anchor: '2026-07-06T00:00:00Z',
    property_count: properties.length,
    source_budget_exceeded: false,
    properties: properties.map((property) => ({
      property_id: property.propertyId,
      relationship_id: property.relationshipId,
      property_snapshot_hash: property.hash,
      eligibility_status: property.eligibility ?? 'included',
      exclusion_codes: [...(property.exclusions ?? [])],
    })),
  };
}

async function one<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const result = await pg.query<T>(sql, params);
  assert.ok(result.rows[0], `expected one row for ${sql}`);
  return result.rows[0];
}

async function claim(
  owner: string | null = OWNER_A,
  runKey = 'company-a:2026-07-06',
  projectionMode = 'shadow',
  portfolio = portfolioManifest(),
  supersedesRunId: string | null = null,
): Promise<{
  outcome: string;
  run_id: string;
  fencing_token: number;
}> {
  return one(
    `select * from public.claim_management_pattern_run(
       $1, $2, $3, 'engine-1', 1, 'cohort-1', 'normalization-1',
       'dedupe-1', 'scope-1', $4, $5::jsonb, $6,
       '2026-07-06T12:00:00Z', '2026-07-06T11:00:00Z', '2026-07-06T00:00:00Z',
       '2026-06-29T00:00:00Z', '2026-07-06T00:00:00Z', $7,
       'scheduled', '{"analysis_window_anchor":"2026-07-06T00:00:00Z"}'::jsonb,
       300, $8::uuid
     )`,
    [
      ORG_A,
      runKey,
      owner,
      H.input,
      JSON.stringify(portfolio),
      H.portfolio,
      projectionMode,
      supersedesRunId,
    ],
  );
}

async function expireRunLeaseForTest(targetRunId: string): Promise<void> {
  await pg.exec(`alter table public.management_pattern_runs
    disable trigger management_pattern_runs_update_guard`);
  try {
    await pg.query(
      `update public.management_pattern_runs
       set lease_expires_at = clock_timestamp() - interval '1 second'
       where organization_id = $1 and id = $2`,
      [ORG_A, targetRunId],
    );
  } finally {
    await pg.exec(`alter table public.management_pattern_runs
      enable trigger management_pattern_runs_update_guard`);
  }
}

async function insertCandidate(
  id: string,
  key: string,
  effectiveAt: string,
  magnitude: number,
  hashCharacter: string,
  options: {
    decision?: 'emit' | 'suppress';
    rootKey?: string;
    suppressionReasons?: readonly string[];
    checkOutcomeId?: string;
  } = {},
): Promise<void> {
  const decision = options.decision ?? 'emit';
  const rootKey = options.rootKey ?? 'root';
  const suppressionReasons = [...(options.suppressionReasons ?? [])];
  const checkOutcomeId = options.checkOutcomeId ?? OUTCOME;
  await pg.query(
    `insert into public.management_pattern_candidates (
       id, organization_id, run_id, run_fencing_token, check_outcome_id,
       candidate_key, projection_dedupe_key, semantic_family, root_key,
       classified_scope, scope_evidence, decision, suppression_reasons,
       summary, severity,
       disposition, receipt_query_id, evidence, effective_at, magnitude,
       materiality_score, confidence, confidence_kind,
       escalation_factor, escalation_min_delta, candidate_hash
     ) values (
       $1, $2, $3, 1, $4, $5, 'portfolio_supply:root', 'supply_efficiency',
       $10, 'peer_cohort', '{"basis":"peer receipt"}'::jsonb, $11, $12::text[],
       $6, 'attention', 'recommend', 'portfolio_supply_spend_gap',
       '{"reproducible":true}'::jsonb, $7, $8, 0.8, 0.8,
       'threshold_progress_not_probability', 2, 5, $9
     )`,
    [
      id,
      ORG_A,
      runId,
      checkOutcomeId,
      key,
      `Supply gap ${magnitude}`,
      effectiveAt,
      magnitude,
      hashCharacter.repeat(64),
      rootKey,
      decision,
      suppressionReasons,
    ],
  );
  await pg.query(
    `insert into public.management_pattern_candidate_outcomes (
       organization_id, run_id, run_fencing_token, candidate_id,
       check_outcome_id, manifestation_key, lineage_role, manifestation_evidence
     ) values ($1, $2, 1, $3, $4, $5, 'primary', '{}'::jsonb)`,
    [ORG_A, runId, id, checkOutcomeId, key],
  );
}

async function linkCandidate(id: string): Promise<void> {
  await pg.query(
    `insert into public.management_pattern_candidate_properties (
       organization_id, run_id, run_fencing_token, candidate_id, property_id,
       occurrence_role, occurrence_evidence
     ) values
       ($1, $2, 1, $3, $4, 'affected', '{"status":"open"}'::jsonb),
       ($1, $2, 1, $3, $5, 'comparator', '{}'::jsonb)`,
    [ORG_A, runId, id, PROPERTY_A, PROPERTY_B],
  );
}

async function linkLocal(id: string, localFindingId: string): Promise<void> {
  await pg.query(
    `insert into public.management_pattern_candidate_local_instances (
       organization_id, run_id, run_fencing_token, candidate_id, property_id,
       local_instance_id, local_finding_id, occurrence_at, local_finding_snapshot
     ) values ($1, $2, 1, $3, $4, gen_random_uuid(), $5,
       '2026-07-01T12:00:00Z', '{"status":"open"}'::jsonb)`,
    [ORG_A, runId, id, PROPERTY_A, localFindingId],
  );
}

describe('management-company patterns migration 0392', () => {
  before(async () => {
    pg = new PGlite({ extensions: { pgcrypto } });
    await pg.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role bypassrls nologin;

      create table public.properties (
        id uuid primary key,
        name text not null
      );
      create table public.accounts (
        id uuid primary key
      );
      create table public.organizations (
        id uuid primary key,
        name text not null,
        organization_type text not null
      );
      create table public.organization_property_relationships (
        id uuid primary key,
        organization_id uuid not null references public.organizations(id) on delete cascade,
        property_id uuid not null references public.properties(id) on delete cascade,
        relationship_type text not null default 'operator',
        is_primary_grouping boolean not null default true,
        starts_at timestamptz not null default '2020-01-01T00:00:00Z',
        ends_at timestamptz,
        created_at timestamptz not null default '2025-01-01T00:00:00Z',
        updated_at timestamptz not null default '2025-01-01T00:00:00Z',
        unique (id, organization_id, property_id)
      );
      create table public.organization_access_events (
        id uuid primary key default gen_random_uuid(),
        occurred_at timestamptz not null,
        target_type text not null,
        target_id text,
        before_state jsonb,
        after_state jsonb
      );
      create table public.portfolio_properties (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null,
        portfolio_id uuid not null,
        property_id uuid not null,
        assigned_at timestamptz not null,
        removed_at timestamptz
      );
      create table public.findings (
        id uuid primary key,
        property_id uuid not null references public.properties(id) on delete cascade,
        as_of timestamptz,
        last_seen_at timestamptz not null default now()
      );
      create table public.company_findings (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id) on delete cascade,
        detector_id text not null check (char_length(detector_id) between 1 and 64),
        dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
        summary text not null check (char_length(summary) between 1 and 500),
        severity text not null check (severity in ('critical','attention','info')),
        disposition text not null default 'fyi'
          check (disposition in ('propose','recommend','fyi','ask','drop')),
        status text not null default 'open'
          check (status in ('open','updated','resolved','known_problem','muted','expired')),
        receipt_query_id text not null,
        evidence jsonb not null default '{}'::jsonb,
        as_of timestamptz,
        weakest_input_age_days numeric,
        magnitude numeric not null default 0,
        price_low_cents integer,
        price_high_cents integer,
        price_currency text not null default 'USD',
        price_basis text,
        first_seen_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        occurrence_count integer not null default 1,
        status_changed_at timestamptz not null default now(),
        status_changed_by uuid references public.accounts(id) on delete set null,
        resolved_at timestamptz,
        silenced_at_magnitude numeric,
        escalated_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create unique index company_findings_one_active_per_problem_uq
        on public.company_findings (organization_id, dedupe_key)
        where status in ('open','updated','known_problem','muted');
      create table public.applied_migrations (
        version text primary key,
        description text not null
      );

      -- The certified Access migration owns this locking assertion in production.
      -- This narrow fixture preserves its public contract so 0392 can prove that
      -- it never trusts caller-supplied organization/property IDs.
      create or replace function public.staxis_assert_authorization_scope_receipt(
        p_receipt_id uuid,
        p_account_id uuid
      )
      returns jsonb
      language plpgsql
      volatile
      security definer
      set search_path = pg_catalog, public
      as $auth$
      declare
        v_properties uuid[];
        v_selected uuid[];
        v_organization_id uuid := '${ORG_A}'::uuid;
        v_selected_count integer;
      begin
        if p_account_id <> '${ACCOUNT_A}'::uuid then
          return jsonb_build_object('ok', false, 'reason', 'not_found');
        end if;
        if p_receipt_id = '${SCOPE_RECEIPT_EXPIRED}'::uuid then
          return jsonb_build_object('ok', false, 'reason', 'expired');
        elsif p_receipt_id = '${SCOPE_RECEIPT_REVOKED}'::uuid then
          return jsonb_build_object('ok', false, 'reason', 'revoked_or_changed');
        elsif p_receipt_id = '${SCOPE_RECEIPT_CHANGED}'::uuid then
          return jsonb_build_object('ok', false, 'reason', 'scope_changed');
        elsif p_receipt_id not in (
          '${SCOPE_RECEIPT_A}'::uuid,
          '${SCOPE_RECEIPT_SUBSET}'::uuid,
          '${SCOPE_RECEIPT_BAD_COUNT}'::uuid,
          '${SCOPE_RECEIPT_MISSING}'::uuid,
          '${SCOPE_RECEIPT_NULL_FIELDS}'::uuid
        ) then
          return jsonb_build_object('ok', false, 'reason', 'not_found');
        end if;

        if p_receipt_id = '${SCOPE_RECEIPT_MISSING}'::uuid then
          v_properties := array['${PROPERTY_A}'::uuid, '${PROPERTY_FOREIGN}'::uuid];
          v_selected := v_properties;
        else
          v_properties := array['${PROPERTY_A}'::uuid, '${PROPERTY_B}'::uuid];
          v_selected := case
            when p_receipt_id = '${SCOPE_RECEIPT_SUBSET}'::uuid
              then array['${PROPERTY_A}'::uuid]
            else v_properties
          end;
        end if;
        v_selected_count := cardinality(v_selected);
        if p_receipt_id = '${SCOPE_RECEIPT_BAD_COUNT}'::uuid then
          v_selected_count := v_selected_count + 1;
        end if;

        if p_receipt_id = '${SCOPE_RECEIPT_NULL_FIELDS}'::uuid then
          return jsonb_build_object(
            'ok', true,
            'receipt', jsonb_build_object(
              'id', p_receipt_id,
              'accountId', p_account_id,
              'organizationId', v_organization_id,
              'authorizedPropertyIds', to_jsonb(v_properties),
              'propertyIds', to_jsonb(v_selected),
              'authorizedPropertyCount', null,
              'selectedPropertyCount', null,
              'authorizationHash', null,
              'expiresAt', null
            )
          );
        end if;

        return jsonb_build_object(
          'ok', true,
          'receipt', jsonb_build_object(
            'id', p_receipt_id,
            'accountId', p_account_id,
            'organizationId', v_organization_id,
            'authorizedPropertyIds', to_jsonb(v_properties),
            'propertyIds', to_jsonb(v_selected),
            'authorizedPropertyCount', cardinality(v_properties),
            'selectedPropertyCount', v_selected_count,
            'authorizationHash', repeat('a', 64),
            'scopeHash', repeat('b', 64),
            'expiresAt', statement_timestamp() + interval '2 minutes'
          )
        );
      end
      $auth$;
      revoke all on function public.staxis_assert_authorization_scope_receipt(uuid,uuid)
        from public, anon, authenticated, service_role;

      insert into public.properties(id, name) values
        ('${PROPERTY_A}', 'Alpha'), ('${PROPERTY_B}', 'Bravo'),
        ('${PROPERTY_FOREIGN}', 'Foreign');
      insert into public.organizations(id, name, organization_type) values
        ('${ORG_A}', 'Company A', 'management_company'),
        ('${ORG_B}', 'Company B', 'management_company');
      insert into public.organization_property_relationships(
        id, organization_id, property_id, relationship_type, is_primary_grouping
      )
      values
        ('${REL_A}', '${ORG_A}', '${PROPERTY_A}', 'operator', true),
        ('${REL_B}', '${ORG_A}', '${PROPERTY_B}', 'operator', true),
        ('${REL_FOREIGN}', '${ORG_B}', '${PROPERTY_FOREIGN}', 'operator', true);
      insert into public.findings(id, property_id, as_of, last_seen_at)
      values ('${LOCAL_FINDING}', '${PROPERTY_A}',
        '2026-07-01T12:00:00Z', '2026-07-01T12:00:00Z');
    `);
    // Production numbering intentionally installs the fail-closed source
    // reader before the evidence/profile plane. Exercise that exact chain.
    await pg.exec(SOURCE_MIGRATION_SQL);
    const preCoreProfile = await pg.query<{ count: number }>(`
      select count(*)::integer as count
      from public.management_pattern_profile_at_v1(
        '${ORG_A}', '${PROPERTY_A}', '${REL_A}',
        '2026-07-06T00:00:00Z', '2026-07-06T11:00:00Z'
      )
    `);
    assert.equal(
      preCoreProfile.rows[0]?.count,
      0,
      '0389 must fail closed while the 0392 profile relation is absent',
    );
    await pg.exec(MIGRATION_SQL);
  });

  after(async () => {
    await pg.close().catch(() => undefined);
  });

  test('declares tenant-scoped immutable structures and locked security-definer APIs', async () => {
    for (const table of [
      'management_pattern_property_profiles',
      'management_pattern_runs',
      'management_pattern_run_properties',
      'management_pattern_cohorts',
      'management_pattern_cohort_members',
      'management_pattern_metric_observations',
      'management_pattern_metric_source_facts',
      'management_pattern_check_outcomes',
      'management_pattern_candidates',
      'management_pattern_candidate_outcomes',
      'management_pattern_candidate_properties',
      'management_pattern_candidate_local_instances',
      'management_pattern_run_roots',
      'management_pattern_reconciliations',
      'management_pattern_reconciliation_outcomes',
      'management_pattern_result_batches',
    ]) {
      const exists = await one<{ exists: boolean }>(
        `select to_regclass('public.${table}') is not null as exists`,
      );
      assert.equal(exists.exists, true, table);
    }

    assert.match(MIGRATION_SQL, /security definer\s+set search_path = pg_catalog, public/gi);
    assert.match(MIGRATION_SQL, /staxis_reject_management_pattern_evidence_update/);
    assert.match(MIGRATION_SQL, /confidence_kind/);
    assert.match(MIGRATION_SQL, /evidence_schema_version\s+integer not null default 2/i);
    assert.match(MIGRATION_SQL, /candidate_schema_version\s+integer not null default 2/i);
    assert.doesNotMatch(MIGRATION_SQL, /currency_code\s+text\s+not null\s+default/i);

    const rls = await pg.query<{ relname: string; relrowsecurity: boolean }>(`
      select relname, relrowsecurity
      from pg_class
      where relname like 'management_pattern_%' and relkind = 'r'
    `);
    assert.ok(rls.rows.length >= 11);
    assert.ok(rls.rows.every((row) => row.relrowsecurity));

    const migration = await one<{ count: number }>(
      `select count(*)::integer as count from public.applied_migrations where version = '0392'`,
    );
    assert.equal(migration.count, 1);

    const servicePrivileges = await one<{
      run_insert: boolean;
      evidence_delete: boolean;
      append_result_execute: boolean;
      project_candidate_execute: boolean;
      project_run_execute: boolean;
      profile_accessor_execute: boolean;
      portfolio_source_execute: boolean;
    }>(`
      select
        has_table_privilege('service_role', 'public.management_pattern_runs', 'INSERT')
          as run_insert,
        has_table_privilege('service_role', 'public.management_pattern_candidates', 'DELETE')
          as evidence_delete,
        has_function_privilege(
          'service_role',
          'public.append_management_pattern_result_batch(uuid,uuid,uuid,bigint,jsonb)',
          'EXECUTE'
        ) as append_result_execute,
        has_function_privilege(
          'service_role', 'public.project_management_pattern_candidate(uuid,uuid)', 'EXECUTE'
        ) as project_candidate_execute,
        has_function_privilege(
          'service_role', 'public.project_management_pattern_run(uuid,uuid)', 'EXECUTE'
        ) as project_run_execute,
        has_function_privilege(
          'service_role',
          'public.management_pattern_profile_at_v1(uuid,uuid,uuid,timestamptz,timestamptz)',
          'EXECUTE'
        ) as profile_accessor_execute,
        has_function_privilege(
          'service_role',
          'public.load_management_pattern_portfolio_findings_source(uuid,uuid,timestamptz,integer)',
          'EXECUTE'
        ) as portfolio_source_execute
    `);
    assert.deepEqual(servicePrivileges, {
      run_insert: false,
      evidence_delete: false,
      append_result_execute: true,
      project_candidate_execute: false,
      project_run_execute: false,
      profile_accessor_execute: false,
      portfolio_source_execute: true,
    });
    for (const role of ['anon', 'authenticated'] as const) {
      await pg.exec(`set role ${role}`);
      try {
        await assert.rejects(
          pg.query(`select * from public.management_pattern_runs`),
          /permission denied/i,
        );
        await assert.rejects(
          pg.query(`select * from public.management_pattern_metric_source_facts`),
          /permission denied/i,
        );
        await assert.rejects(
          claim(OWNER_A, `${role}-must-not-claim`),
          /permission denied/i,
        );
        await assert.rejects(
          pg.query(
            `select * from public.append_management_pattern_result_batch(
               $1, $2, $3, 1, '{}'::jsonb
             )`,
            [ORG_A, '90000000-0000-4000-8000-000000000001', OWNER_A],
          ),
          /permission denied/i,
        );
        await assert.rejects(
          pg.query(
            `select * from public.append_management_pattern_input_batch(
               $1, $2, $3, 1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
             )`,
            [ORG_A, '90000000-0000-4000-8000-000000000001', OWNER_A],
          ),
          /permission denied/i,
        );
        await assert.rejects(
          pg.query(
            `select public.load_management_pattern_portfolio_findings_source(
               $1, $2, statement_timestamp(), 40
             )`,
            [SCOPE_RECEIPT_A, ACCOUNT_A],
          ),
          /permission denied/i,
        );
      } finally {
        await pg.exec('reset role');
      }
    }

    await pg.exec('set role service_role');
    try {
      const noRun = await one<{ value: {
        status: string;
        candidates: unknown[];
        available_candidate_count: number;
      } }>(
        `select public.load_management_pattern_portfolio_findings_source(
           $1, $2, statement_timestamp(), 40
         ) as value`,
        [SCOPE_RECEIPT_A, ACCOUNT_A],
      );
      assert.deepEqual({
        status: noRun.value.status,
        candidates: noRun.value.candidates,
        available: noRun.value.available_candidate_count,
      }, {
        status: 'no_finalized_run',
        candidates: [],
        available: 0,
      });
      for (const refusal of [
        { receiptId: SCOPE_RECEIPT_A, accountId: ACCOUNT_B, reason: 'not_found' },
        { receiptId: SCOPE_RECEIPT_EXPIRED, accountId: ACCOUNT_A, reason: 'expired' },
        {
          receiptId: SCOPE_RECEIPT_REVOKED,
          accountId: ACCOUNT_A,
          reason: 'revoked_or_changed',
        },
        { receiptId: SCOPE_RECEIPT_CHANGED, accountId: ACCOUNT_A, reason: 'scope_changed' },
      ] as const) {
        const refused = await one<{ value: {
          status: string;
          authorization_reason: string;
          organization_id: string | null;
          selected_property_ids: string[];
          candidates: unknown[];
        } }>(
          `select public.load_management_pattern_portfolio_findings_source(
             $1, $2, statement_timestamp(), 40
           ) as value`,
          [refusal.receiptId, refusal.accountId],
        );
        assert.deepEqual({
          status: refused.value.status,
          authorization_reason: refused.value.authorization_reason,
          organization_id: refused.value.organization_id,
          selected_property_ids: refused.value.selected_property_ids,
          candidates: refused.value.candidates,
        }, {
          status: 'authorization_refused',
          authorization_reason: refusal.reason,
          organization_id: null,
          selected_property_ids: [],
          candidates: [],
        });
      }
      await assert.rejects(
        pg.query(
          `select public.load_management_pattern_portfolio_findings_source(
             $1, $2, statement_timestamp(), 40
           )`,
          [SCOPE_RECEIPT_BAD_COUNT, ACCOUNT_A],
        ),
        /authorization scope assertion returned an inconsistent receipt/i,
      );
      await assert.rejects(
        pg.query(
          `select public.load_management_pattern_portfolio_findings_source(
             $1, $2, statement_timestamp(), 40
           )`,
          [SCOPE_RECEIPT_NULL_FIELDS, ACCOUNT_A],
        ),
        /authorization scope assertion returned an inconsistent receipt/i,
      );
      const serviceClaim = await claim(OWNER_A, 'service-role-rpc-contract');
      assert.equal(serviceClaim.outcome, 'claimed');
      const inputReceipt = await one<{
        run_properties_inserted: number;
        metric_observations_inserted: number;
        metric_source_facts_inserted: number;
      }>(
        `select * from public.append_management_pattern_input_batch(
           $1, $2, $3, $4, '[]'::jsonb, '[]'::jsonb
         )`,
        [ORG_A, serviceClaim.run_id, OWNER_A, serviceClaim.fencing_token],
      );
      assert.deepEqual(inputReceipt, {
        run_properties_inserted: 0,
        metric_observations_inserted: 0,
        metric_source_facts_inserted: 0,
      });
      assert.equal((await one<{ outcome: string }>(
        `select * from public.append_management_pattern_result_batch(
           $1, $2, $3, $4, '{}'::jsonb
         )`,
        [ORG_A, serviceClaim.run_id, OWNER_A, serviceClaim.fencing_token],
      )).outcome, 'applied');
      await assert.rejects(
        pg.exec(`delete from public.management_pattern_candidates where false`),
        /permission denied/i,
      );
      await pg.query(`select count(*) from public.management_pattern_metric_source_facts`);
      await assert.rejects(
        pg.query(
          `insert into public.management_pattern_metric_source_facts (organization_id)
           values ($1)`,
          [ORG_A],
        ),
        /permission denied/i,
      );
      await assert.rejects(
        pg.query(
          `select * from public.project_management_pattern_candidate($1, $2)`,
          [ORG_A, CANDIDATES[0]],
        ),
        /permission denied/i,
      );
      assert.equal((await one<{ outcome: string }>(
        `select * from public.finalize_management_pattern_run(
           p_organization_id => $1,
           p_run_id => $2,
           p_owner_token => $3,
           p_fencing_token => $4,
           p_terminal_status => 'failed',
           p_error_detail => '{"code":"role_contract_test"}'::jsonb
         )`,
        [ORG_A, serviceClaim.run_id, OWNER_A, serviceClaim.fencing_token],
      )).outcome, 'finalized');
    } finally {
      await pg.exec('reset role');
    }
  });

  test('keeps comparison profile facts nullable, immutable, and knowledge-time reproducible', async () => {
    const profile = await one<{
      id: string;
      currency_code: string | null;
      created_at: string;
    }>(
      `insert into public.management_pattern_property_profiles (
         organization_id, property_id, property_relationship_id, profile_version, effective_from,
         service_level, source_kind, change_reason
       ) values ($1, $2, $3, 1, '2026-07-01', 'limited_service',
         'organization_override', 'Verified by portfolio owner')
       returning id, currency_code, created_at::text`,
      [ORG_A, PROPERTY_A, REL_A],
    );
    assert.equal(profile.currency_code, null, 'unknown currency must not become USD');
    const loadedProfile = await one<{ id: string; service_level: string | null }>(
      `select id, service_level
       from public.management_pattern_profile_at_v1(
         $1, $2, $3, '2026-07-15T00:00:00Z', now() + interval '1 hour'
       )`,
      [ORG_A, PROPERTY_A, REL_A],
    );
    assert.deepEqual(loadedProfile, {
      id: profile.id,
      service_level: 'limited_service',
    });
    await assert.rejects(
      pg.query(
        `update public.management_pattern_property_profiles
         set service_level = 'full_service' where id = $1`,
        [profile.id],
      ),
      /append-only/i,
    );
    await pg.query(
      `insert into public.accounts (id) values ($1) on conflict (id) do nothing`,
      [ACCOUNT_A],
    );
    const stamped = await one<{ id: string; created_at: string }>(
      `insert into public.management_pattern_property_profiles (
         organization_id, property_id, property_relationship_id, profile_version, effective_from,
         service_level, source_kind, change_reason, created_by_account_id, created_at
       ) values ($1, $2, $3, 2, '2026-07-01', 'full_service',
         'verified_import', 'Late verified historical correction', $4,
         '2099-01-01T00:00:00Z')
       returning id, created_at::text`,
      [ORG_A, PROPERTY_A, REL_A, ACCOUNT_A],
    );
    assert.ok(
      Date.parse(stamped.created_at) > Date.parse(profile.created_at),
      'database did not establish a strictly increasing source-knowledge order',
    );
    assert.deepEqual(
      await one<{ id: string; service_level: string | null }>(
        `select id, service_level
         from public.management_pattern_profile_at_v1(
           $1, $2, $3, '2026-07-15T00:00:00Z', $4
         )`,
        [ORG_A, PROPERTY_A, REL_A, profile.created_at],
      ),
      { id: profile.id, service_level: 'limited_service' },
      'the original source cutoff must not see the later correction',
    );
    assert.deepEqual(
      await one<{ id: string; service_level: string | null }>(
        `select id, service_level
         from public.management_pattern_profile_at_v1(
           $1, $2, $3, '2026-07-15T00:00:00Z', $4
         )`,
        [ORG_A, PROPERTY_A, REL_A, stamped.created_at],
      ),
      { id: stamped.id, service_level: 'full_service' },
      'the later source cutoff must deterministically resolve the correction',
    );
    assert.equal((await one<{ count: number }>(
      `select count(*)::integer as count
       from pg_constraint constraint_row
       join pg_class table_row on table_row.oid = constraint_row.conrelid
       where table_row.relname = 'management_pattern_property_profiles'
         and constraint_row.contype = 'f'
         and pg_get_constraintdef(constraint_row.oid) ilike '%accounts%'`,
    )).count, 0, 'append-only actor attribution must not be rewritten by a live account FK');
    await pg.query(`delete from public.accounts where id = $1`, [ACCOUNT_A]);
    assert.equal((await one<{ actor_id: string | null }>(
      `select created_by_account_id::text as actor_id
       from public.management_pattern_property_profiles where id = $1`,
      [stamped.id],
    )).actor_id, ACCOUNT_A, 'account deletion must not rewrite immutable attribution');
    await pg.query(
      `insert into public.accounts (id) values ($1) on conflict (id) do nothing`,
      [ACCOUNT_A],
    );
    await assert.rejects(
      pg.query(
        `insert into public.management_pattern_property_profiles (
           organization_id, property_id, property_relationship_id, profile_version, effective_from,
           service_level, source_kind, change_reason
         ) values ($1, $2, $3, 4, '2026-07-01', 'limited_service',
           'verified_import', 'Skipped revision must fail')`,
        [ORG_A, PROPERTY_A, REL_A],
      ),
      /next immutable property revision.*expected 3, received 4/i,
    );
    await assert.rejects(
      pg.query(
        `insert into public.management_pattern_property_profiles (
           organization_id, property_id, property_relationship_id, profile_version, effective_from,
           service_level, source_kind, change_reason, created_by_account_id
         ) values ($1, $2, $3, 3, '2026-09-01', 'limited_service',
           'verified_import', 'Unknown actor must fail closed', $4)`,
        [ORG_A, PROPERTY_A, REL_A, '51000000-0000-4000-8000-000000000099'],
      ),
      /actor is outside the live account ledger/i,
    );
    await assert.rejects(
      pg.query(
        `insert into public.management_pattern_property_profiles (
           organization_id, property_id, property_relationship_id, profile_version, effective_from,
           currency_code, currency_minor_unit_exponent, source_kind, change_reason
         ) values ($1, $2, $3, 3, '2026-09-01', 'usd', 2,
           'organization_override', 'Invalid lowercase currency')`,
        [ORG_A, PROPERTY_A, REL_A],
      ),
    );
  });

  test('accepts a late profile correction only for the exact audited pre-transfer relationship', async () => {
    await pg.exec('begin');
    try {
      const rejectWithoutAborting = async (
        savepoint: string,
        operation: () => Promise<unknown>,
        error: RegExp,
      ): Promise<void> => {
        await pg.exec(`savepoint ${savepoint}`);
        try {
          await assert.rejects(operation, error);
        } finally {
          await pg.exec(`rollback to savepoint ${savepoint}`);
          await pg.exec(`release savepoint ${savepoint}`);
        }
      };

      await pg.exec(`
        with before_row as (
          select to_jsonb(relationship) as state
          from public.organization_property_relationships relationship
          where relationship.id = '${REL_A}'
        ), moved as (
          update public.organization_property_relationships
          set organization_id = '${ORG_B}',
              updated_at = '2026-07-20T00:00:00Z'
          where id = '${REL_A}'
          returning to_jsonb(organization_property_relationships) as state
        )
        insert into public.organization_access_events (
          id, occurred_at, target_type, target_id, before_state, after_state
        )
        select '71000000-0000-4000-8000-000000000001',
          '2026-07-20T00:00:00Z',
          'organization_property_relationships', '${REL_A}',
          before_row.state, moved.state
        from before_row cross join moved;
      `);

      await rejectWithoutAborting(
        'unbounded_predecessor_profile',
        () => pg.query(
          `insert into public.management_pattern_property_profiles (
             organization_id, property_id, property_relationship_id, profile_version,
             effective_from, service_level, source_kind, change_reason
           ) values ($1, $2, $3, 3, '2026-07-01', 'select_service',
             'verified_import', 'Unbounded predecessor correction')`,
          [ORG_A, PROPERTY_A, REL_A],
        ),
        /exceeds proven membership loss/i,
      );
      const correction = await one<{ id: string; created_at: string }>(
        `insert into public.management_pattern_property_profiles (
           organization_id, property_id, property_relationship_id, profile_version,
           effective_from, effective_to, service_level, source_kind, change_reason
         ) values ($1, $2, $3, 3, '2026-07-01', '2026-07-20T00:00:00Z', 'select_service',
           'verified_import', 'Verified after the audited hotel transfer')
         returning id, created_at::text`,
        [ORG_A, PROPERTY_A, REL_A],
      );
      assert.deepEqual(
        await one<{ id: string; service_level: string | null }>(
          `select id, service_level
           from public.management_pattern_profile_at_v1(
             $1, $2, $3, '2026-07-15T00:00:00Z', $4
           )`,
          [ORG_A, PROPERTY_A, REL_A, correction.created_at],
        ),
        { id: correction.id, service_level: 'select_service' },
      );
      assert.equal((await one<{ count: number }>(
        `select count(*)::integer as count
         from public.management_pattern_profile_at_v1(
           $1, $2, $3, '2026-07-15T00:00:00Z', $4
         )`,
        [ORG_B, PROPERTY_A, REL_A, correction.created_at],
      )).count, 0, 'the predecessor profile must not cross the company boundary');
      await rejectWithoutAborting(
        'mismatched_relationship_profile',
        () => pg.query(
          `insert into public.management_pattern_property_profiles (
             organization_id, property_id, property_relationship_id, profile_version,
             effective_from, service_level, source_kind, change_reason
           ) values ($1, $2, $3, 1, '2026-07-01', 'select_service',
             'verified_import', 'Mismatched relationship identity')`,
          [ORG_B, PROPERTY_B, REL_A],
        ),
        /exact audited governing tenant\/property relationship/i,
      );
      await pg.exec(`
        insert into public.organization_access_events (
          id, occurred_at, target_type, target_id, before_state, after_state
        )
        select '71000000-0000-4000-8000-000000000002', occurred_at,
          target_type, target_id, before_state, after_state
        from public.organization_access_events
        where id = '71000000-0000-4000-8000-000000000001';
      `);
      await rejectWithoutAborting(
        'ambiguous_transfer_profile',
        () => pg.query(
          `insert into public.management_pattern_property_profiles (
             organization_id, property_id, property_relationship_id, profile_version,
             effective_from, effective_to, service_level, source_kind, change_reason
           ) values ($1, $2, $3, 4, '2026-07-01', '2026-07-20T00:00:00Z', 'select_service',
             'verified_import', 'Ambiguous transfer proof must fail')`,
          [ORG_A, PROPERTY_A, REL_A],
        ),
        /relationship history is causally ambiguous/i,
      );
    } finally {
      await pg.exec('rollback');
    }
  });

  test('claims/resumes with a lease and rejects a live competing owner', async () => {
    await assert.rejects(
      claim(OWNER_A, 'active-cutover-not-configured', 'active'),
      /active management-pattern projection is disabled/i,
    );
    const claimed = await claim();
    assert.equal(claimed.outcome, 'claimed');
    assert.equal(claimed.fencing_token, 1);
    runId = claimed.run_id;

    assert.equal((await claim()).outcome, 'resumed');
    assert.equal((await claim(OWNER_B)).outcome, 'busy');

    const heartbeat = await one<{ outcome: string }>(
      `select * from public.heartbeat_management_pattern_run($1, $2, $3, 1, 300)`,
      [ORG_A, runId, OWNER_A],
    );
    assert.equal(heartbeat.outcome, 'heartbeated');

    // An expired unguarded legacy claim can be safely taken over, and the old
    // fencing generation can no longer append evidence.
    const expiredRun = await one<{ id: string }>(
      `insert into public.management_pattern_runs (
         organization_id, run_key, engine_version, evidence_schema_version,
         cohort_policy_version, normalization_policy_version, dedupe_policy_version,
         scope_policy_version, input_hash, input_manifest,
         portfolio_snapshot, portfolio_snapshot_hash,
         evaluation_at, source_as_of, topology_as_of,
         window_start, window_end, projection_mode, status, owner_token,
         fencing_token, lease_expires_at, heartbeat_at, started_at
       ) values (
         $1, 'expired-run', 'engine-1', 1, 'cohort-1', 'normalization-1',
         'dedupe-1', 'scope-1', $2,
         '{"analysis_window_anchor":"2026-07-06T00:00:00Z"}'::jsonb,
         $5::jsonb, $3,
         '2026-07-06T12:00:00Z', '2026-07-06T11:00:00Z', '2026-07-06T00:00:00Z',
         '2026-06-29T00:00:00Z', '2026-07-06T00:00:00Z', 'shadow',
         'running', $4, 1, now() - interval '1 minute', now() - interval '2 minutes',
         now() - interval '2 minutes'
       ) returning id`,
      [
        ORG_A,
        H.input,
        H.portfolio,
        OWNER_A,
        JSON.stringify(portfolioManifest()),
      ],
    );
    const reclaimed = await claim(OWNER_B, 'expired-run');
    assert.equal(reclaimed.outcome, 'reclaimed');
    assert.equal(reclaimed.run_id, expiredRun.id);
    assert.equal(reclaimed.fencing_token, 2);
  });

  test('claims a bounded backfill only against one exact completed historical parent', async () => {
    const parentPortfolio = portfolioManifest();
    const parent = await one<{ id: string }>(
      `insert into public.management_pattern_runs (
         organization_id, run_key, triggered_by, projection_mode,
         engine_version, evidence_schema_version, cohort_policy_version,
         normalization_policy_version, dedupe_policy_version, scope_policy_version,
         input_hash, input_manifest, portfolio_snapshot, portfolio_snapshot_hash,
         evaluation_at, source_as_of, topology_as_of, window_start, window_end,
         status, owner_token, fencing_token, lease_expires_at, heartbeat_at,
         started_at, completed_at
       ) values (
         $1, 'historical-parent', 'scheduled', 'shadow', 'engine-1', 1,
         'cohort-1', 'normalization-1', 'dedupe-1', 'scope-1', $2,
         '{"analysis_window_anchor":"2026-07-06T00:00:00Z"}'::jsonb,
         $3::jsonb, $4, '2026-07-06T12:00:00Z', '2026-07-06T11:00:00Z',
         '2026-07-06T00:00:00Z', '2026-06-29T00:00:00Z',
         '2026-07-06T00:00:00Z', 'running', $5, 1,
         now() + interval '5 minutes', now(), now(), null
       ) returning id`,
      [ORG_A, H.input, JSON.stringify(parentPortfolio), H.portfolio, OWNER_A],
    );
    await pg.query(
      `insert into public.management_pattern_result_batches (
         organization_id, run_id, run_fencing_token, batch_hash, row_counts
       ) values ($1, $2, 1, $3, $4::jsonb)`,
      [
        ORG_A,
        parent.id,
        'f'.repeat(64),
        JSON.stringify(Object.fromEntries([
          'cohorts', 'cohort_members', 'check_outcomes', 'check_observations',
          'candidates', 'candidate_outcomes', 'candidate_properties',
          'candidate_local_instances', 'run_roots', 'reconciliations',
          'reconciliation_outcomes',
        ].map((key) => [key, 0]))),
      ],
    );
    await pg.exec(`alter table public.management_pattern_runs
      disable trigger management_pattern_runs_update_guard`);
    try {
      await pg.query(
        `update public.management_pattern_runs
         set status = 'abstained', completed_at = now()
         where organization_id = $1 and id = $2`,
        [ORG_A, parent.id],
      );
    } finally {
      await pg.exec(`alter table public.management_pattern_runs
        enable trigger management_pattern_runs_update_guard`);
    }
    const backfillPortfolio = {
      ...parentPortfolio,
      evaluation_at: '2026-07-20T12:00:00Z',
      source_as_of: '2026-07-20T10:00:00Z',
    };
    const backfill = await one<{ outcome: string; run_id: string }>(
      `select * from public.claim_management_pattern_run(
         $1, 'backfill:engine-1:2026-07-06T00:00:00.000Z', $2,
         'engine-1', 1, 'cohort-1', 'normalization-1', 'dedupe-1', 'scope-1',
         $3, $4::jsonb, $5, '2026-07-20T12:00:00Z',
         '2026-07-20T10:00:00Z', '2026-07-06T00:00:00Z',
         '2026-06-29T00:00:00Z', '2026-07-06T00:00:00Z',
         'shadow', 'backfill',
         '{"analysis_window_anchor":"2026-07-06T00:00:00Z"}'::jsonb,
         300, $6::uuid
       )`,
      [
        ORG_A,
        OWNER_B,
        '9'.repeat(64),
        JSON.stringify(backfillPortfolio),
        '8'.repeat(64),
        parent.id,
      ],
    );
    assert.equal(backfill.outcome, 'claimed');
    assert.deepEqual(await one<{
      triggered_by: string;
      supersedes_run_id: string;
      evaluation_at: string;
      source_as_of: string;
      topology_as_of: string;
    }>(
      `select triggered_by, supersedes_run_id,
              to_char(evaluation_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                as evaluation_at,
              to_char(source_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                as source_as_of,
              to_char(topology_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                as topology_as_of
       from public.management_pattern_runs where id = $1`,
      [backfill.run_id],
    ), {
      triggered_by: 'backfill',
      supersedes_run_id: parent.id,
      evaluation_at: '2026-07-20T12:00:00Z',
      source_as_of: '2026-07-20T10:00:00Z',
      topology_as_of: '2026-07-06T00:00:00Z',
    });

    await assert.rejects(
      pg.query(
        `select * from public.claim_management_pattern_run(
           $1, 'backfill:missing-parent', $2, 'engine-1', 1, 'cohort-1',
           'normalization-1', 'dedupe-1', 'scope-1', $3, $4::jsonb, $5,
           '2026-07-20T12:00:00Z', '2026-07-20T10:00:00Z',
           '2026-07-06T00:00:00Z', '2026-06-29T00:00:00Z',
           '2026-07-06T00:00:00Z', 'shadow', 'backfill',
           '{"analysis_window_anchor":"2026-07-06T00:00:00Z"}'::jsonb,
           300, null::uuid
         )`,
        [ORG_A, OWNER_B, '7'.repeat(64), JSON.stringify(backfillPortfolio), '6'.repeat(64)],
      ),
      /bounded historical parent receipt/i,
    );

    const failedParent = await claim(OWNER_A, 'historical-failed-parent');
    assert.equal((await one<{ outcome: string }>(
      `select * from public.finalize_management_pattern_run(
         p_organization_id => $1,
         p_run_id => $2,
         p_owner_token => $3,
         p_fencing_token => $4,
         p_terminal_status => 'failed',
         p_error_detail => '{"code":"historical_source_failure"}'::jsonb
       )`,
      [ORG_A, failedParent.run_id, OWNER_A, failedParent.fencing_token],
    )).outcome, 'finalized');
    const failedParentBackfill = await one<{ outcome: string }>(
      `select * from public.claim_management_pattern_run(
         $1, 'backfill:failed-scheduled-parent', $2,
         'engine-1', 1, 'cohort-1', 'normalization-1', 'dedupe-1', 'scope-1',
         $3, $4::jsonb, $5, '2026-07-20T12:00:00Z',
         '2026-07-20T10:00:00Z', '2026-07-06T00:00:00Z',
         '2026-06-29T00:00:00Z', '2026-07-06T00:00:00Z',
         'shadow', 'backfill',
         '{"analysis_window_anchor":"2026-07-06T00:00:00Z"}'::jsonb,
         300, $6::uuid
       )`,
      [
        ORG_A,
        OWNER_B,
        '5'.repeat(64),
        JSON.stringify(backfillPortfolio),
        '4'.repeat(64),
        failedParent.run_id,
      ],
    );
    assert.equal(failedParentBackfill.outcome, 'claimed');
  });

  test('rejects null ownership, fencing, and immutable claim CAS inputs', async () => {
    const guarded = await claim(OWNER_A, 'null-cas-guards');

    await assert.rejects(
      claim(null, 'null-cas-guards'),
      /organization and owner token are required/i,
    );
    await assert.rejects(
      pg.query(
        `select * from public.claim_management_pattern_run(
           $1, $2, $3, null::text, 1, 'cohort-1', 'normalization-1',
           'dedupe-1', 'scope-1', $4, $5::jsonb, $6,
           '2026-07-06T12:00:00Z', '2026-07-06T11:00:00Z',
           '2026-07-06T00:00:00Z', '2026-06-29T00:00:00Z',
           '2026-07-06T00:00:00Z', 'shadow'
         )`,
        [
          ORG_A,
          'null-cas-guards',
          OWNER_A,
          H.input,
          JSON.stringify(portfolioManifest()),
          H.portfolio,
        ],
      ),
      /claim immutable inputs are required/i,
    );

    const requiredCas = /organization, run, owner token, and fencing token are required/i;
    for (const [owner, fence] of [
      [null, guarded.fencing_token],
      [OWNER_A, null],
    ] as const) {
      await assert.rejects(
        pg.query(
          `select * from public.heartbeat_management_pattern_run(
             $1, $2, $3::uuid, $4::bigint, 300
           )`,
          [ORG_A, guarded.run_id, owner, fence],
        ),
        requiredCas,
      );
      await assert.rejects(
        pg.query(
          `select * from public.append_management_pattern_input_batch(
             $1, $2, $3::uuid, $4::bigint,
             '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
           )`,
          [ORG_A, guarded.run_id, owner, fence],
        ),
        requiredCas,
      );
      await assert.rejects(
        pg.query(
          `select * from public.append_management_pattern_result_batch(
             $1, $2, $3::uuid, $4::bigint, '{}'::jsonb
           )`,
          [ORG_A, guarded.run_id, owner, fence],
        ),
        requiredCas,
      );
      await assert.rejects(
        pg.query(
          `select * from public.finalize_management_pattern_run(
             p_organization_id => $1,
             p_run_id => $2,
             p_owner_token => $3::uuid,
             p_fencing_token => $4::bigint,
             p_terminal_status => 'failed',
             p_error_detail => '{"code":"must_not_finalize"}'::jsonb
           )`,
          [ORG_A, guarded.run_id, owner, fence],
        ),
        requiredCas,
      );
    }

    assert.equal((await one<{ outcome: string }>(
      `select * from public.heartbeat_management_pattern_run($1, $2, $3, $4, 300)`,
      [ORG_A, guarded.run_id, OWNER_A, guarded.fencing_token],
    )).outcome, 'heartbeated');
  });

  test('rejects SQL-null batches and incomplete portfolio manifests at the RPC boundary', async () => {
    const guarded = await claim(OWNER_A, 'null-json-guards');
    const inputBatchShape = /input batches must be JSON arrays/i;
    for (const batches of [
      [null, '[]', '[]'],
      ['[]', null, '[]'],
      ['[]', '[]', null],
    ] as const) {
      await assert.rejects(
        pg.query(
          `select * from public.append_management_pattern_input_batch(
             $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb
           )`,
          [ORG_A, guarded.run_id, OWNER_A, guarded.fencing_token, ...batches],
        ),
        inputBatchShape,
      );
    }
    await assert.rejects(
      pg.query(
        `select * from public.append_management_pattern_result_batch(
           $1, $2, $3, $4, null::jsonb
         )`,
        [ORG_A, guarded.run_id, OWNER_A, guarded.fencing_token],
      ),
      /result batch must be a JSON object/i,
    );
    await assert.rejects(
      pg.query(
        `select * from public.append_management_pattern_input_batch(
           $1, $2, $3, $4,
           jsonb_build_array(jsonb_build_object('padding', repeat('x', 16777216))),
           '[]'::jsonb, '[]'::jsonb
         )`,
        [ORG_A, guarded.run_id, OWNER_A, guarded.fencing_token],
      ),
      /input batch exceeds bounded row limit/i,
    );

    const requiredFields = [
      'schema_version', 'organization_id', 'properties', 'organization_type',
    ] as const;
    for (const [index, field] of requiredFields.entries()) {
      const malformed = structuredClone(portfolioManifest()) as Record<string, unknown>;
      delete malformed[field];
      await assert.rejects(
        claim(
          OWNER_A,
          `malformed-portfolio-${index}`,
          'shadow',
          malformed as ReturnType<typeof portfolioManifest>,
        ),
        /strict management-pattern v2 manifest|organization type differs/i,
      );
    }
  });

  test('accepts exact result/finalize retries and rejects changed or stale retries', async () => {
    const claimed = await claim(OWNER_A, 'result-batch-idempotency');
    const applied = await one<{ outcome: string; batch_hash: string }>(
      `select * from public.append_management_pattern_result_batch(
         $1, $2, $3, $4, '{}'::jsonb
       )`,
      [ORG_A, claimed.run_id, OWNER_A, claimed.fencing_token],
    );
    assert.equal(applied.outcome, 'applied');
    const retry = await one<{ outcome: string; batch_hash: string }>(
      `select * from public.append_management_pattern_result_batch(
         $1, $2, $3, $4, '{}'::jsonb
       )`,
      [ORG_A, claimed.run_id, OWNER_A, claimed.fencing_token],
    );
    assert.equal(retry.outcome, 'already_applied');
    assert.equal(retry.batch_hash, applied.batch_hash);
    await assert.rejects(
      pg.query(
        `select * from public.append_management_pattern_result_batch(
           $1, $2, $3, $4, '{}'::jsonb
         )`,
        [ORG_A, claimed.run_id, OWNER_B, claimed.fencing_token],
      ),
      /result batch retry rejected by run owner\/fence CAS/i,
    );
    await assert.rejects(
      pg.query(
        `select * from public.append_management_pattern_result_batch(
           $1, $2, $3, $4, '{}'::jsonb
         )`,
        [ORG_A, claimed.run_id, OWNER_A, claimed.fencing_token + 1],
      ),
      /result batch retry rejected by run owner\/fence CAS/i,
    );
    await assert.rejects(
      pg.query(
        `select * from public.append_management_pattern_result_batch(
           $1, $2, $3, $4, '{"cohorts":[]}'::jsonb
         )`,
        [ORG_A, claimed.run_id, OWNER_A, claimed.fencing_token],
      ),
      /input_conflict/i,
    );
    const finalize = (owner: string, errorCode: string) => one<{ outcome: string }>(
      `select * from public.finalize_management_pattern_run(
         p_organization_id => $1,
         p_run_id => $2,
         p_owner_token => $3,
         p_fencing_token => $4,
         p_terminal_status => 'failed',
         p_error_detail => jsonb_build_object('code', $5::text)
       )`,
      [ORG_A, claimed.run_id, owner, claimed.fencing_token, errorCode],
    );
    assert.equal((await finalize(OWNER_A, 'idempotent_terminal_retry')).outcome, 'finalized');
    assert.equal(
      (await finalize(OWNER_A, 'idempotent_terminal_retry')).outcome,
      'already_finalized',
    );
    await assert.rejects(
      finalize(OWNER_A, 'changed_terminal_retry'),
      /finalize retry differs from the sealed run receipt/i,
    );
    assert.equal((await finalize(OWNER_B, 'idempotent_terminal_retry')).outcome, 'stale_fence');
    assert.equal((await one<{ outcome: string }>(
      `select * from public.append_management_pattern_result_batch(
         $1, $2, $3, $4, '{}'::jsonb
       )`,
      [ORG_A, claimed.run_id, OWNER_A, claimed.fencing_token],
    )).outcome, 'already_applied');
  });

  test('seals expired receipt-only and run-root-only generations', async () => {
    const receiptOnly = await claim(OWNER_A, 'expired-empty-result-batch');
    assert.equal((await one<{ outcome: string }>(
      `select * from public.append_management_pattern_result_batch(
         $1, $2, $3, $4, '{}'::jsonb
       )`,
      [ORG_A, receiptOnly.run_id, OWNER_A, receiptOnly.fencing_token],
    )).outcome, 'applied');
    await expireRunLeaseForTest(receiptOnly.run_id);

    const receiptSealed = await claim(OWNER_B, 'expired-empty-result-batch');
    assert.deepEqual({
      outcome: receiptSealed.outcome,
      runId: receiptSealed.run_id,
      fence: receiptSealed.fencing_token,
    }, {
      outcome: 'partial_evidence_sealed',
      runId: receiptOnly.run_id,
      fence: receiptOnly.fencing_token + 1,
    });
    const sealedState = await one<{
      status: string;
      error_code: string;
    }>(
      `select status, error_detail->>'code' as error_code
       from public.management_pattern_runs
       where organization_id = $1 and id = $2`,
      [ORG_A, receiptOnly.run_id],
    );
    assert.deepEqual(sealedState, {
      status: 'failed',
      error_code: 'expired_generation_with_partial_evidence',
    });
    await assert.rejects(
      pg.query(
        `select * from public.append_management_pattern_result_batch(
           $1, $2, $3, $4, '{}'::jsonb
         )`,
        [ORG_A, receiptOnly.run_id, OWNER_A, receiptOnly.fencing_token],
      ),
      /result batch retry rejected by run owner\/fence CAS/i,
    );

    const superseding = await claim(
      OWNER_B,
      'expired-empty-result-batch:superseding',
      'shadow',
      portfolioManifest(),
      receiptOnly.run_id,
    );
    assert.equal(superseding.outcome, 'claimed');
    assert.notEqual(superseding.run_id, receiptOnly.run_id);

    const rootOnly = await claim(OWNER_A, 'expired-run-root-only');
    await pg.query(
      `insert into public.management_pattern_run_roots (
         organization_id, run_id, run_fencing_token, semantic_family,
         root_key, root_domain_key, detector_ids, detector_versions,
         expected_outcome_count, expected_outcome_keys,
         expected_outcome_set_hash, manifest_source, definition_hash
       ) values (
         $1, $2, $3, 'root_only_family', 'root_only', 'root_only',
         array['root_only_check'], '{"root_only_check":["v1"]}'::jsonb,
         1, array['root_only_outcome'],
         encode(pg_catalog.sha256(convert_to(
           array_to_json(array['root_only_outcome'])::text, 'UTF8'
         )), 'hex'),
         'detector_plan', repeat('7', 64)
       )`,
      [ORG_A, rootOnly.run_id, rootOnly.fencing_token],
    );
    await expireRunLeaseForTest(rootOnly.run_id);
    const rootSealed = await claim(OWNER_B, 'expired-run-root-only');
    assert.deepEqual({
      outcome: rootSealed.outcome,
      runId: rootSealed.run_id,
      fence: rootSealed.fencing_token,
    }, {
      outcome: 'partial_evidence_sealed',
      runId: rootOnly.run_id,
      fence: rootOnly.fencing_token + 1,
    });
  });

  test('rejects a stale non-nearest relationship audit proof after a move chain', async () => {
    await pg.exec('begin');
    try {
      await pg.query(
        `update public.organization_property_relationships
         set updated_at = '2026-07-07T00:00:00Z'
         where id = $1`,
        [REL_FOREIGN],
      );
      const stateA = {
        id: REL_FOREIGN,
        organization_id: ORG_A,
        property_id: PROPERTY_FOREIGN,
        relationship_type: 'operator',
        is_primary_grouping: true,
        starts_at: '2020-01-01T00:00:00Z',
        ends_at: null,
      };
      const stateB = { ...stateA, organization_id: ORG_B };
      await pg.query(
        `insert into public.organization_access_events(
           occurred_at, target_type, target_id, before_state, after_state
         ) values
           ('2026-07-04T00:00:00Z', 'organization_property_relationships', $1,
             null, $2::jsonb),
           ('2026-07-05T00:00:00Z', 'organization_property_relationships', $1,
             $2::jsonb, $3::jsonb)`,
        [REL_FOREIGN, JSON.stringify(stateA), JSON.stringify(stateB)],
      );
      const staleClaim = await claim(
        OWNER_A,
        'stale-relationship-audit-proof',
        'shadow',
        portfolioManifest([{
          propertyId: PROPERTY_FOREIGN,
          relationshipId: REL_FOREIGN,
          hash: 'f'.repeat(64),
        }]),
      );
      await assert.rejects(
        pg.query(
          `select * from public.append_management_pattern_input_batch(
             $1, $2, $3, $4, $5::jsonb, '[]'::jsonb, '[]'::jsonb
           )`,
          [
            ORG_A,
            staleClaim.run_id,
            OWNER_A,
            staleClaim.fencing_token,
            JSON.stringify([{
              property_id: PROPERTY_FOREIGN,
              property_name: 'Historical foreign',
              membership_relationship_id: REL_FOREIGN,
              membership_snapshot: {
                relationship: {
                  ...stateA,
                  history_proof_kind: 'event_at_or_before',
                  history_proof_at: '2026-07-04T00:00:00Z',
                },
              },
              eligibility_status: 'included',
              exclusion_codes: [],
              property_snapshot_hash: 'f'.repeat(64),
            }]),
          ],
        ),
        /canonical nearest receipt/i,
      );
    } finally {
      await pg.exec('rollback');
    }
  });

  test('batch-ingests exact tenant-paired raw and normalized observations', async () => {
    const forgedProperty = {
      property_id: PROPERTY_FOREIGN,
      property_name: 'Foreign',
      membership_relationship_id: REL_FOREIGN,
      membership_snapshot: {
        relationship: {
          id: REL_FOREIGN,
          relationship_type: 'operator',
          starts_at: '2020-01-01T00:00:00Z',
          ends_at: null,
          history_proof_kind: 'unchanged_current_row',
          history_proof_at: '2025-01-01T00:00:00Z',
        },
      },
      eligibility_status: 'included',
      exclusion_codes: [],
      property_snapshot_hash: 'f'.repeat(64),
    };
    const forgedClaim = await claim(
      OWNER_A,
      'forged-cross-tenant-portfolio',
      'shadow',
      portfolioManifest([{
        propertyId: PROPERTY_FOREIGN,
        relationshipId: REL_FOREIGN,
        hash: 'f'.repeat(64),
      }]),
    );
    assert.equal(forgedClaim.outcome, 'claimed');
    await assert.rejects(
      pg.query(
        `select * from public.append_management_pattern_input_batch(
           $1, $2, $3, $4, $5::jsonb, '[]'::jsonb
         )`,
        [
          ORG_A,
          forgedClaim.run_id,
          OWNER_A,
          forgedClaim.fencing_token,
          JSON.stringify([forgedProperty]),
        ],
      ),
      /no authoritative historical tenant proof/i,
    );
    await assert.rejects(
      pg.query(
        `select * from public.append_management_pattern_input_batch(
           $1, $2, $3, 1, $4::jsonb, '[]'::jsonb
         )`,
        [ORG_A, runId, OWNER_A, JSON.stringify([forgedProperty])],
      ),
      /differs from its claimed portfolio manifest/i,
    );
    await assert.rejects(
      pg.query(
        `select * from public.append_management_pattern_input_batch(
           $1, $2, $3, 1, $4::jsonb, '[]'::jsonb
         )`,
        [
          ORG_A,
          runId,
          OWNER_A,
          JSON.stringify([{
            ...forgedProperty,
            property_id: PROPERTY_A,
            membership_relationship_id: REL_A,
            membership_snapshot: {
              relationship: {
                ...forgedProperty.membership_snapshot.relationship,
                id: REL_A,
              },
            },
          }]),
        ],
      ),
      /differs from its claimed portfolio manifest/i,
    );

    const batch = await one<{
      run_properties_inserted: number;
      metric_observations_inserted: number;
      metric_source_facts_inserted: number;
    }>(
      `select * from public.append_management_pattern_input_batch(
         $1, $2, $3, 1, $4::jsonb, $5::jsonb
       )`,
      [
        ORG_A,
        runId,
        OWNER_A,
        JSON.stringify([
          {
            property_id: PROPERTY_A,
            property_name: 'Alpha',
            membership_relationship_id: REL_A,
            membership_snapshot: {
              relationship: {
                id: REL_A,
                relationship_type: 'operator',
                starts_at: '2020-01-01T00:00:00Z',
                ends_at: null,
                history_proof_kind: 'unchanged_current_row',
                history_proof_at: '2025-01-01T00:00:00Z',
              },
              groups: [],
              topology_exclusions: [],
            },
            timezone_name: 'America/Chicago',
            business_date_cutoff_hour: 4,
            currency_code: 'USD',
            currency_minor_unit_exponent: 2,
            eligibility_status: 'included',
            property_snapshot_hash: H.propertyA,
          },
          {
            property_id: PROPERTY_B,
            property_name: 'Bravo',
            membership_relationship_id: REL_B,
            membership_snapshot: {
              relationship: {
                id: REL_B,
                relationship_type: 'operator',
                starts_at: '2020-01-01T00:00:00Z',
                ends_at: null,
                history_proof_kind: 'unchanged_current_row',
                history_proof_at: '2025-01-01T00:00:00Z',
              },
              groups: [],
              topology_exclusions: [],
            },
            timezone_name: 'America/Chicago',
            business_date_cutoff_hour: 4,
            currency_code: 'USD',
            currency_minor_unit_exponent: 2,
            eligibility_status: 'included',
            property_snapshot_hash: H.propertyB,
          },
        ]),
        JSON.stringify([
          {
            id: OBSERVATION,
            property_id: PROPERTY_A,
            metric_key: 'inventory_purchase_spend',
            metric_version: '1',
            raw_value: 120000,
            raw_unit: 'cents',
            raw_currency_code: 'USD',
            raw_currency_minor_unit_exponent: 2,
            denominator_key: 'occupied_rooms',
            denominator_value: 100,
            denominator_unit: 'room_nights',
            denominator_window_kind: 'business_dates',
            denominator_window_start_local: '2026-01-01T04:00:00',
            denominator_window_end_local: '2026-04-01T04:00:00',
            denominator_window_timezone: 'America/Chicago',
            denominator_business_date_cutoff_hour: 4,
            denominator_window_start_utc: '2026-01-01T10:00:00Z',
            denominator_window_end_utc: '2026-04-01T09:00:00Z',
            denominator_as_of: SOURCE_CUTOFF,
            denominator_completeness_ratio: 1,
            denominator_freshness_age_seconds: 8280000.001,
            denominator_source_query_id: 'management_pattern_daily_log_occupancy',
            denominator_source_query_version: 'management-pattern-source-snapshot.v2',
            denominator_source_query: {
              parameters: { property_id: PROPERTY_A },
              extracted_at: SOURCE_CUTOFF,
              record_count: 90,
            },
            denominator_source_watermark: {
              fresh_through: '2026-04-01T08:59:59.999Z',
              source_revision: 'denominator-revision',
              receipt: sourceAccessWatermark({
                max_sealed_at: '2026-03-31T12:00:00Z',
                max_updated_at: '2026-03-31T12:00:00Z',
              }),
            },
            denominator_source_snapshot_hash: '7'.repeat(64),
            normalized_value: 1200,
            normalized_unit: 'cents_per_occupied_room',
            normalized_currency_code: 'USD',
            normalized_currency_minor_unit_exponent: 2,
            normalization_method: 'divide_by_occupied_rooms',
            normalization_policy_version: 'normalization-1',
            normalization_definition_hash: '8'.repeat(64),
            normalization_window_alignment: 'same_local_dates',
            window_kind: 'instant_range',
            window_start_local: '2026-01-01T00:00:00',
            window_end_local: '2026-04-01T00:00:00',
            window_timezone: 'America/Chicago',
            business_date_cutoff_hour: null,
            window_start_utc: '2026-01-01T06:00:00Z',
            window_end_utc: '2026-04-01T05:00:00Z',
            as_of: '2026-07-06T05:00:00Z',
            completeness_ratio: 1,
            freshness_age_seconds: 8294400.001,
            quality_status: 'usable',
            source_query_id: 'management_pattern_inventory_month_closes',
            source_query_version: 'management-pattern-source-snapshot.v2',
            source_query: {
              parameters: { property_id: PROPERTY_A },
              extracted_at: SOURCE_CUTOFF,
              record_count: 3,
            },
            source_watermark: {
              fresh_through: '2026-04-01T04:59:59.999Z',
              source_revision: 'numerator-revision',
              receipt: sourceAccessWatermark({ max_closed_at: '2026-04-01T05:00:00Z' }),
            },
            source_snapshot_hash: '1'.repeat(64),
            metadata: {
              source_coverage_receipt: {
                usable_periods: 3,
                denominator_observed_days: 90,
              },
            },
          },
        ]),
      ],
    );
    assert.deepEqual(batch, {
      run_properties_inserted: 2,
      metric_observations_inserted: 1,
      metric_source_facts_inserted: 0,
    });

    await assert.rejects(
      pg.query(
        `select * from public.finalize_management_pattern_run(
           p_organization_id => $1, p_run_id => $2, p_owner_token => $3,
           p_fencing_token => 1, p_terminal_status => 'succeeded'
         )`,
        [ORG_A, runId, OWNER_A],
      ),
      /exact replayable source-fact set/i,
    );

    const exactFacts = exactSupplySourceFacts();
    const forgedValue = structuredClone(exactFacts[0]!);
    forgedValue.numeric_value = 99_999;
    forgedValue.fact_payload.numeric_value = 99_999;
    await assert.rejects(
      pg.query(
        `select * from public.append_management_pattern_input_batch(
           $1, $2, $3, 1, '[]'::jsonb, '[]'::jsonb, $4::jsonb
         )`,
        [ORG_A, runId, OWNER_A, JSON.stringify([forgedValue])],
      ),
      /canonical scalar receipt/i,
    );

    const forgedInclusion = structuredClone(exactFacts[0]!);
    forgedInclusion.included_in_aggregate = false;
    forgedInclusion.fact_payload.included_in_aggregate = false;
    await assert.rejects(
      pg.query(
        `select * from public.append_management_pattern_input_batch(
           $1, $2, $3, 1, '[]'::jsonb, '[]'::jsonb, $4::jsonb
         )`,
        [ORG_A, runId, OWNER_A, JSON.stringify([forgedInclusion])],
      ),
      /canonical scalar receipt/i,
    );

    const exactNumeratorCoverage = exactFacts.find((fact) => (
      'end_at' in fact.fact_payload
    ));
    assert.ok(exactNumeratorCoverage);
    const forgedNumeratorCoverage = structuredClone(exactNumeratorCoverage);
    assert.ok('end_at' in forgedNumeratorCoverage.fact_payload);
    forgedNumeratorCoverage.fact_payload.end_at = '2026-03-01T06:00:00Z';
    await assert.rejects(
      pg.query(
        `select * from public.append_management_pattern_input_batch(
           $1, $2, $3, 1, '[]'::jsonb, '[]'::jsonb, $4::jsonb
         )`,
        [ORG_A, runId, OWNER_A, JSON.stringify([forgedNumeratorCoverage])],
      ),
      /canonical scalar receipt/i,
    );

    const afterCutoff = structuredClone(exactFacts[0]!);
    afterCutoff.source_recorded_at = '2026-07-06T11:00:01Z';
    afterCutoff.fact_payload.source_recorded_at = '2026-07-06T11:00:01Z';
    afterCutoff.fact_payload.updated_at = '2026-07-06T11:00:01Z';
    await assert.rejects(
      pg.query(
        `select * from public.append_management_pattern_input_batch(
           $1, $2, $3, 1, '[]'::jsonb, '[]'::jsonb, $4::jsonb
         )`,
        [ORG_A, runId, OWNER_A, JSON.stringify([afterCutoff])],
      ),
      /after its source extraction cutoff/i,
    );

    await assert.rejects(
      pg.query(
        `select * from public.append_management_pattern_input_batch(
           $1, $2, $3, 1, '[]'::jsonb, '[]'::jsonb, $4::jsonb
         )`,
        [ORG_A, runId, OWNER_A, JSON.stringify([exactFacts[0], exactFacts[0]])],
      ),
      /duplicate immutable identity/i,
    );

    const factBatch = await one<{
      run_properties_inserted: number;
      metric_observations_inserted: number;
      metric_source_facts_inserted: number;
    }>(
      `select * from public.append_management_pattern_input_batch(
         $1, $2, $3, 1, '[]'::jsonb, '[]'::jsonb, $4::jsonb
       )`,
      [ORG_A, runId, OWNER_A, JSON.stringify(exactFacts)],
    );
    assert.deepEqual(factBatch, {
      run_properties_inserted: 0,
      metric_observations_inserted: 0,
      metric_source_facts_inserted: 93,
    });

    const sourceFactReceipt = await one<{ fact_count: number; hash_count: number }>(
      `select count(*)::integer as fact_count,
              count(distinct fact_hash)::integer as hash_count
       from public.management_pattern_metric_source_facts
       where organization_id = $1 and run_id = $2`,
      [ORG_A, runId],
    );
    assert.deepEqual(sourceFactReceipt, { fact_count: 93, hash_count: 93 });

    const retry = await one<{
      run_properties_inserted: number;
      metric_observations_inserted: number;
      metric_source_facts_inserted: number;
    }>(
      `select * from public.append_management_pattern_input_batch(
         $1, $2, $3, 1,
         (select jsonb_agg(to_jsonb(p) - array[
            'organization_id','run_id','run_fencing_token','created_at'
          ]) from public.management_pattern_run_properties p
          where p.organization_id = $1 and p.run_id = $2),
         (select jsonb_agg(to_jsonb(o) - array[
            'organization_id','run_id','run_fencing_token','created_at'
          ]) from public.management_pattern_metric_observations o
          where o.organization_id = $1 and o.run_id = $2),
         (select jsonb_agg(to_jsonb(f) - array[
            'organization_id','run_id','run_fencing_token','fact_hash','created_at'
          ]) from public.management_pattern_metric_source_facts f
          where f.organization_id = $1 and f.run_id = $2)
       )`,
      [ORG_A, runId, OWNER_A],
    );
    assert.deepEqual(retry, {
      run_properties_inserted: 0,
      metric_observations_inserted: 0,
      metric_source_facts_inserted: 0,
    });

    const changedRetry = structuredClone(exactFacts[0]!) as
      (typeof exactFacts)[number] & { fact_payload: Record<string, unknown> };
    changedRetry.numeric_value = 50_000;
    changedRetry.fact_payload.numeric_value = 50_000;
    changedRetry.fact_payload.confirmed_purchase_storage_cents = 50_000;
    await assert.rejects(
      pg.query(
        `select * from public.append_management_pattern_input_batch(
           $1, $2, $3, 1, '[]'::jsonb, '[]'::jsonb, $4::jsonb
         )`,
        [ORG_A, runId, OWNER_A, JSON.stringify([changedRetry])],
      ),
      /input_conflict/i,
    );

    await assert.rejects(
      pg.query(
        `select * from public.append_management_pattern_input_batch(
           $1, $2, $3, 1, '[]'::jsonb,
           (select jsonb_build_array(jsonb_set(
              to_jsonb(o) - array['organization_id','run_id','run_fencing_token','created_at'],
              '{raw_value}', '999'::jsonb
            ))
            from public.management_pattern_metric_observations o
            where o.organization_id = $1 and o.run_id = $2 limit 1)
         )`,
        [ORG_A, runId, OWNER_A],
      ),
      /input_conflict/i,
    );

    const runPropertyPayload = (await one<{ payload: Record<string, unknown> }>(
      `select to_jsonb(p) - array[
         'organization_id','run_id','run_fencing_token','created_at'
       ] as payload
       from public.management_pattern_run_properties p
       where p.organization_id = $1 and p.run_id = $2 and p.property_id = $3`,
      [ORG_A, runId, PROPERTY_A],
    )).payload;
    const baseObservationPayload = (await one<{
      payload: Record<string, unknown>;
    }>(
      `select to_jsonb(o) - array[
         'organization_id','run_id','run_fencing_token','created_at'
       ] as payload
      from public.management_pattern_metric_observations o
       where o.organization_id = $1 and o.run_id = $2 and o.id = $3`,
      [ORG_A, runId, OBSERVATION],
    )).payload;
    const partialObservation = structuredClone(baseObservationPayload);
    const partialObservationId = '61000000-0000-4000-8000-000000000002';
    partialObservation.id = partialObservationId;
    partialObservation.raw_value = null;
    partialObservation.normalized_value = null;
    partialObservation.normalized_unit = null;
    partialObservation.normalized_currency_code = null;
    partialObservation.normalized_currency_minor_unit_exponent = null;
    partialObservation.normalization_method = null;
    partialObservation.denominator_value = 0;
    partialObservation.denominator_completeness_ratio = 0.01;
    partialObservation.denominator_freshness_age_seconds = 15966000.001;
    partialObservation.denominator_source_watermark = {
      fresh_through: '2026-01-02T09:59:59.999Z',
      source_revision: 'denominator-revision',
      receipt: sourceAccessWatermark({
        max_sealed_at: '2026-01-02T12:00:00Z',
        max_updated_at: '2026-01-02T12:00:00Z',
      }),
    };
    partialObservation.completeness_ratio = 0;
    partialObservation.freshness_age_seconds = -21600;
    partialObservation.quality_status = 'invalid';
    partialObservation.quality_reasons = [
      'numerator_missing',
      'occupancy_partial',
      'future_source_timestamp',
    ];
    (partialObservation.source_query as Record<string, unknown>).record_count = 0;
    (partialObservation.denominator_source_query as Record<string, unknown>).record_count = 2;
    partialObservation.source_watermark = {
      fresh_through: SOURCE_CUTOFF,
      source_revision: 'numerator-revision',
      receipt: sourceAccessWatermark({ max_closed_at: null }),
    };
    partialObservation.metadata = {
      source_coverage_receipt: {
        usable_periods: 0,
        denominator_observed_days: 1,
      },
    };

    const partialFacts = exactFacts
      .filter((fact) => fact.fact_role === 'denominator')
      .slice(0, 2)
      .map((fact) => structuredClone(fact) as
        Record<string, unknown> & { fact_payload: Record<string, unknown> });
    for (const fact of partialFacts) fact.observation_id = partialObservationId;
    partialFacts[0]!.numeric_value = 0;
    partialFacts[0]!.fact_payload.rooms_sold = 0;
    partialFacts[0]!.fact_payload.numeric_value = 0;
    partialFacts[1]!.numeric_value = null;
    partialFacts[1]!.included_in_aggregate = false;
    partialFacts[1]!.fact_payload.rooms_sold = null;
    partialFacts[1]!.fact_payload.numeric_value = null;
    partialFacts[1]!.fact_payload.denominator_complete = false;
    partialFacts[1]!.fact_payload.included_in_aggregate = false;
    partialFacts[1]!.fact_payload.source_completeness_receipt = {
      occupancy_complete: false,
      occupancy_bucket: null,
      source_completeness_fingerprint: '8'.repeat(64),
    };

    const partialPortfolio = portfolioManifest([{
      propertyId: PROPERTY_A,
      relationshipId: REL_A,
      hash: H.propertyA,
    }]);
    const partialClaim = await claim(
      OWNER_A,
      'partial-null-zero-source-facts',
      'shadow',
      partialPortfolio,
    );
    const partialReceipt = await one<{
      run_properties_inserted: number;
      metric_observations_inserted: number;
      metric_source_facts_inserted: number;
    }>(
      `select * from public.append_management_pattern_input_batch(
         $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb
       )`,
      [
        ORG_A,
        partialClaim.run_id,
        OWNER_A,
        partialClaim.fencing_token,
        JSON.stringify([runPropertyPayload]),
        JSON.stringify([partialObservation]),
        JSON.stringify(partialFacts),
      ],
    );
    assert.deepEqual(partialReceipt, {
      run_properties_inserted: 1,
      metric_observations_inserted: 1,
      metric_source_facts_inserted: 2,
    });
    await assert.rejects(
      pg.query(
        `select * from public.finalize_management_pattern_run(
           p_organization_id => $1, p_run_id => $2, p_owner_token => $3,
           p_fencing_token => $4, p_terminal_status => 'succeeded',
           p_property_count => 1, p_included_property_count => 1,
           p_observation_count => 1, p_source_fact_count => 2
         )`,
        [ORG_A, partialClaim.run_id, OWNER_A, partialClaim.fencing_token],
      ),
      /atomic derived-result batch receipt/i,
      'the partial NULL-numerator/zero-denominator facts must pass the exact fact gate',
    );

    await pg.exec(`alter table public.management_pattern_runs
      disable trigger management_pattern_runs_update_guard`);
    try {
      await pg.query(
        `update public.management_pattern_runs
         set lease_expires_at = now() - interval '1 minute'
         where organization_id = $1 and id = $2`,
        [ORG_A, partialClaim.run_id],
      );
    } finally {
      await pg.exec(`alter table public.management_pattern_runs
        enable trigger management_pattern_runs_update_guard`);
    }
    const sealedPartial = await claim(
      OWNER_B,
      'partial-null-zero-source-facts',
      'shadow',
      partialPortfolio,
    );
    assert.equal(sealedPartial.outcome, 'partial_evidence_sealed');
    assert.deepEqual(await one<{ status: string; source_fact_count: number }>(
      `select status, source_fact_count
       from public.management_pattern_runs where organization_id = $1 and id = $2`,
      [ORG_A, partialClaim.run_id],
    ), { status: 'failed', source_fact_count: 2 });

    const expectSourceFactGateRejection = async (input: Readonly<{
      runKey: string;
      observationId: string;
      mutateObservation: (observation: Record<string, unknown>) => void;
      mutateFacts?: (facts: Array<Record<string, unknown> & {
        fact_payload: Record<string, unknown>;
      }>) => void;
    }>) => {
      const observationPayload = structuredClone(baseObservationPayload);
      observationPayload.id = input.observationId;
      input.mutateObservation(observationPayload);
      const facts = exactSupplySourceFacts(input.observationId).map((fact) => (
        structuredClone(fact) as Record<string, unknown> & {
          fact_payload: Record<string, unknown>;
        }
      ));
      input.mutateFacts?.(facts);
      const factGateClaim = await claim(OWNER_A, input.runKey, 'shadow', partialPortfolio);
      await pg.query(
        `select * from public.append_management_pattern_input_batch(
           $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb
         )`,
        [
          ORG_A,
          factGateClaim.run_id,
          OWNER_A,
          factGateClaim.fencing_token,
          JSON.stringify([runPropertyPayload]),
          JSON.stringify([observationPayload]),
          JSON.stringify(facts),
        ],
      );
      await assert.rejects(
        pg.query(
          `select * from public.finalize_management_pattern_run(
             p_organization_id => $1, p_run_id => $2, p_owner_token => $3,
             p_fencing_token => $4, p_terminal_status => 'succeeded',
             p_property_count => 1, p_included_property_count => 1,
             p_observation_count => 1, p_source_fact_count => $5
           )`,
          [
            ORG_A,
            factGateClaim.run_id,
            OWNER_A,
            factGateClaim.fencing_token,
            facts.length,
          ],
        ),
        /exact replayable source-fact set/i,
      );
    };

    await expectSourceFactGateRejection({
      runKey: 'source-fact-sum-mismatch',
      observationId: '61000000-0000-4000-8000-000000000003',
      mutateObservation: (observationPayload) => {
        observationPayload.raw_value = 120_001;
      },
    });
    await expectSourceFactGateRejection({
      runKey: 'source-fact-extra-vs-query-receipt',
      observationId: '61000000-0000-4000-8000-000000000004',
      mutateObservation: (observationPayload) => {
        (observationPayload.source_query as Record<string, unknown>).record_count = 2;
      },
    });
    await expectSourceFactGateRejection({
      runKey: 'source-fact-date-gap',
      observationId: '61000000-0000-4000-8000-000000000005',
      mutateObservation: (observationPayload) => {
        (observationPayload.denominator_source_query as Record<string, unknown>)
          .record_count = 89;
        observationPayload.denominator_value = 99;
        observationPayload.metadata = {
          source_coverage_receipt: {
            usable_periods: 3,
            denominator_observed_days: 89,
          },
        };
      },
      mutateFacts: (facts) => {
        assert.equal(facts.at(-1)?.fact_role, 'denominator');
        facts.pop();
      },
    });
    await expectSourceFactGateRejection({
      runKey: 'source-fact-numerator-domain-freshness-mismatch',
      observationId: '61000000-0000-4000-8000-000000000006',
      mutateObservation: (observationPayload) => {
        const watermark = observationPayload.source_watermark as Record<string, unknown>;
        watermark.fresh_through = '2026-04-01T05:00:00Z';
        observationPayload.freshness_age_seconds = 8294400;
      },
    });
    await expectSourceFactGateRejection({
      runKey: 'source-fact-denominator-domain-freshness-mismatch',
      observationId: '61000000-0000-4000-8000-000000000007',
      mutateObservation: (observationPayload) => {
        const watermark = observationPayload.denominator_source_watermark as
          Record<string, unknown>;
        watermark.fresh_through = '2026-04-01T09:00:00Z';
        observationPayload.denominator_freshness_age_seconds = 8280000;
      },
    });
    await expectSourceFactGateRejection({
      runKey: 'source-fact-max-closed-lifecycle-mismatch',
      observationId: '61000000-0000-4000-8000-000000000008',
      mutateObservation: (observationPayload) => {
        const watermark = observationPayload.source_watermark as Record<string, unknown>;
        const receipt = watermark.receipt as Record<string, unknown>;
        receipt.max_closed_at = '2026-04-01T04:59:59Z';
      },
    });
    await expectSourceFactGateRejection({
      runKey: 'source-fact-max-sealed-lifecycle-mismatch',
      observationId: '61000000-0000-4000-8000-000000000009',
      mutateObservation: (observationPayload) => {
        const watermark = observationPayload.denominator_source_watermark as
          Record<string, unknown>;
        const receipt = watermark.receipt as Record<string, unknown>;
        receipt.max_sealed_at = '2026-03-31T11:59:59Z';
      },
    });
    await expectSourceFactGateRejection({
      runKey: 'source-fact-max-updated-lifecycle-mismatch',
      observationId: '61000000-0000-4000-8000-000000000010',
      mutateObservation: (observationPayload) => {
        const watermark = observationPayload.denominator_source_watermark as
          Record<string, unknown>;
        const receipt = watermark.receipt as Record<string, unknown>;
        receipt.max_updated_at = '2026-03-31T11:59:59Z';
      },
    });
    await expectSourceFactGateRejection({
      runKey: 'source-fact-numerator-exact-age-mismatch',
      observationId: '61000000-0000-4000-8000-000000000011',
      mutateObservation: (observationPayload) => {
        observationPayload.freshness_age_seconds = 8294400.002;
      },
    });
    await expectSourceFactGateRejection({
      runKey: 'source-fact-denominator-exact-age-mismatch',
      observationId: '61000000-0000-4000-8000-000000000012',
      mutateObservation: (observationPayload) => {
        observationPayload.denominator_freshness_age_seconds = 8280000.002;
      },
    });

    const poisonedZeroSetObservation = structuredClone(partialObservation);
    const poisonedZeroSetObservationId = '61000000-0000-4000-8000-000000000013';
    poisonedZeroSetObservation.id = poisonedZeroSetObservationId;
    poisonedZeroSetObservation.freshness_age_seconds = 0.001;
    const poisonedZeroSetWatermark = poisonedZeroSetObservation.source_watermark as
      Record<string, unknown>;
    poisonedZeroSetWatermark.fresh_through = '2026-07-06T04:59:59.999Z';
    const poisonedZeroSetFacts = partialFacts.map((fact) => {
      const clone = structuredClone(fact);
      clone.observation_id = poisonedZeroSetObservationId;
      return clone;
    });
    const poisonedZeroSetClaim = await claim(
      OWNER_A,
      'source-fact-zero-set-fallback-mismatch',
      'shadow',
      partialPortfolio,
    );
    await pg.query(
      `select * from public.append_management_pattern_input_batch(
         $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb
       )`,
      [
        ORG_A,
        poisonedZeroSetClaim.run_id,
        OWNER_A,
        poisonedZeroSetClaim.fencing_token,
        JSON.stringify([runPropertyPayload]),
        JSON.stringify([poisonedZeroSetObservation]),
        JSON.stringify(poisonedZeroSetFacts),
      ],
    );
    await assert.rejects(
      pg.query(
        `select * from public.finalize_management_pattern_run(
           p_organization_id => $1, p_run_id => $2, p_owner_token => $3,
           p_fencing_token => $4, p_terminal_status => 'succeeded',
           p_property_count => 1, p_included_property_count => 1,
           p_observation_count => 1, p_source_fact_count => 2
         )`,
        [
          ORG_A,
          poisonedZeroSetClaim.run_id,
          OWNER_A,
          poisonedZeroSetClaim.fencing_token,
        ],
      ),
      /exact replayable source-fact set/i,
    );

    const observation = await one<{
      raw_value: string;
      normalized_value: string;
      denominator_value: string;
    }>(
      `select raw_value, normalized_value, denominator_value
       from public.management_pattern_metric_observations
       where organization_id = $1 and run_id = $2`,
      [ORG_A, runId],
    );
    assert.deepEqual(observation, {
      raw_value: '120000',
      normalized_value: '1200',
      denominator_value: '100',
    });

    await assert.rejects(
      pg.query(
        `insert into public.management_pattern_run_properties (
           organization_id, run_id, run_fencing_token, property_id, property_name,
           membership_relationship_id, membership_snapshot, eligibility_status,
           property_snapshot_hash
         ) values ($1, $2, 99, $3, 'stale', $4, '{}'::jsonb, 'included', $5)`,
        [ORG_A, runId, PROPERTY_A, REL_A, H.propertyA],
      ),
      /fencing token/i,
    );
  });

  test('rejects non-finite numeric strings atomically at both fenced JSON boundaries', async () => {
    const storedObservation = (await one<{ payload: Record<string, unknown> }>(
      `select to_jsonb(observation) - array[
         'organization_id','run_id','run_fencing_token','created_at'
       ] as payload
       from public.management_pattern_metric_observations observation
       where observation.organization_id = $1
         and observation.run_id = $2
         and observation.id = $3`,
      [ORG_A, runId, OBSERVATION],
    )).payload;

    const observationCases: Array<Readonly<{
      field: string;
      special: 'NaN' | 'Infinity' | '-Infinity';
      prepare?: (payload: Record<string, unknown>) => void;
    }>> = [
      { field: 'raw_value', special: 'NaN' },
      { field: 'denominator_value', special: 'Infinity' },
      { field: 'denominator_completeness_ratio', special: 'NaN' },
      { field: 'denominator_freshness_age_seconds', special: '-Infinity' },
      { field: 'normalized_value', special: '-Infinity' },
      { field: 'completeness_ratio', special: 'NaN' },
      { field: 'freshness_age_seconds', special: 'Infinity' },
      {
        field: 'currency_conversion_rate',
        special: 'Infinity',
        prepare: (payload) => {
          payload.normalized_currency_code = 'EUR';
          payload.currency_conversion_as_of = SOURCE_CUTOFF;
          payload.currency_conversion_source_query_id = 'verified_currency_conversion';
          payload.currency_conversion_source_query_version = '1';
          payload.currency_conversion_source_snapshot_hash = '6'.repeat(64);
        },
      },
    ];
    for (const [index, numericCase] of observationCases.entries()) {
      const payload = structuredClone(storedObservation);
      payload.id = `66000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      payload.metric_key = `nonfinite_observation_${index + 1}`;
      payload.source_snapshot_hash = String((index % 8) + 2).repeat(64);
      numericCase.prepare?.(payload);
      payload[numericCase.field] = numericCase.special;
      await assert.rejects(
        pg.query(
          `select * from public.append_management_pattern_input_batch(
             $1, $2, $3, 1, '[]'::jsonb, $4::jsonb, '[]'::jsonb
           )`,
          [ORG_A, runId, OWNER_A, JSON.stringify([payload])],
        ),
        /check constraint|numeric/i,
        `${numericCase.field} accepted ${numericCase.special}`,
      );
    }

    const factObservation = structuredClone(storedObservation);
    const factObservationId = '66000000-0000-4000-8000-000000000090';
    factObservation.id = factObservationId;
    factObservation.source_snapshot_hash = '9'.repeat(64);
    const nonfiniteFact = structuredClone(exactSupplySourceFacts(factObservationId)[0]!) as
      Record<string, unknown> & { fact_payload: Record<string, unknown> };
    nonfiniteFact.numeric_value = 'NaN';
    nonfiniteFact.fact_payload.numeric_value = 'NaN';
    nonfiniteFact.fact_payload.confirmed_purchase_storage_cents = 'NaN';
    await assert.rejects(
      pg.query(
        `select * from public.append_management_pattern_input_batch(
           $1, $2, $3, 1, '[]'::jsonb, $4::jsonb, $5::jsonb
         )`,
        [
          ORG_A,
          runId,
          OWNER_A,
          JSON.stringify([factObservation]),
          JSON.stringify([nonfiniteFact]),
        ],
      ),
      /safe integer|check constraint|numeric|non-canonical value types/i,
    );

    const cohortId = '67000000-0000-4000-8000-000000000001';
    const cohort = {
      id: cohortId,
      cohort_key: 'nonfinite-cohort',
      definition_version: '1',
      definition_hash: '1'.repeat(64),
      target_property_id: PROPERTY_A,
      status: 'ready',
      fallback_level: 0,
      minimum_member_count: 1,
      eligible_member_count: 1,
      included_member_count: 1,
      excluded_member_count: 0,
      dimension_keys: ['service_level'],
      definition: {},
      quality: {},
      abstention_reason: null,
    };
    const cohortMember = {
      cohort_id: cohortId,
      property_id: PROPERTY_A,
      profile_id: null,
      membership_status: 'included',
      member_role: 'target',
      exclusion_codes: [],
      normalized_dimensions: {},
      distance_score: 0,
      comparison_weight: 1,
      decision_reason: 'exact match',
    };
    for (const numericCase of [
      { field: 'distance_score', special: 'NaN' },
      { field: 'comparison_weight', special: 'Infinity' },
    ] as const) {
      const member = { ...cohortMember, [numericCase.field]: numericCase.special };
      await assert.rejects(
        pg.query(
          `select * from public.append_management_pattern_result_batch(
             $1, $2, $3, 1, $4::jsonb
           )`,
          [
            ORG_A,
            runId,
            OWNER_A,
            JSON.stringify({ cohorts: [cohort], cohort_members: [member] }),
          ],
        ),
        /check constraint|numeric/i,
        `${numericCase.field} accepted ${numericCase.special}`,
      );
    }

    const numericOutcomeId = '68000000-0000-4000-8000-000000000001';
    const numericCandidateId = '69000000-0000-4000-8000-000000000001';
    const numericOutcome = {
      id: numericOutcomeId,
      outcome_key: 'nonfinite-candidate-outcome',
      check_id: 'nonfinite_guard',
      check_version: '1',
      semantic_family: 'numeric_guard',
      root_domain_key: 'numeric-root',
      target_property_id: PROPERTY_A,
      cohort_id: null,
      result: 'candidate',
      quality_gate: 'passed',
      deterministic: true,
      input_hash: H.input,
      outcome_hash: '2'.repeat(64),
      parameters: {},
      evidence: {},
      reason_codes: [],
      candidate_count: 1,
      rows_examined: 1,
      duration_ms: 1,
    };
    const numericCandidate: Record<string, unknown> = {
      id: numericCandidateId,
      check_outcome_id: numericOutcomeId,
      candidate_key: 'nonfinite-candidate',
      projection_dedupe_key: 'nonfinite-candidate',
      semantic_family: 'numeric_guard',
      root_key: 'numeric-root',
      classified_scope: 'property_local',
      scope_evidence: {},
      decision: 'emit',
      suppression_reasons: [],
      summary: 'Numeric guard fixture',
      severity: 'info',
      disposition: 'recommend',
      receipt_query_id: 'nonfinite_guard',
      evidence: {},
      effective_at: '2026-07-01T12:00:00Z',
      weakest_input_age_days: 0,
      magnitude: 1,
      materiality_score: 0.5,
      confidence: 0.5,
      confidence_kind: 'threshold_progress_not_probability',
      price_low_cents: null,
      price_high_cents: null,
      price_currency_code: null,
      price_basis: null,
      escalation_factor: 1.5,
      escalation_min_delta: 1,
      routing_metadata: {},
      quality_metadata: {},
      candidate_hash: '3'.repeat(64),
      candidate_schema_version: 1,
    };
    for (const numericCase of [
      { field: 'weakest_input_age_days', special: 'NaN' },
      { field: 'magnitude', special: 'Infinity' },
      { field: 'materiality_score', special: '-Infinity' },
      { field: 'confidence', special: 'NaN' },
      { field: 'escalation_factor', special: 'Infinity' },
      { field: 'escalation_min_delta', special: 'Infinity' },
    ] as const) {
      const candidate = { ...numericCandidate, [numericCase.field]: numericCase.special };
      await assert.rejects(
        pg.query(
          `select * from public.append_management_pattern_result_batch(
             $1, $2, $3, 1, $4::jsonb
           )`,
          [
            ORG_A,
            runId,
            OWNER_A,
            JSON.stringify({ check_outcomes: [numericOutcome], candidates: [candidate] }),
          ],
        ),
        /check constraint|numeric/i,
        `${numericCase.field} accepted ${numericCase.special}`,
      );
    }

    assert.deepEqual(await one<{
      observations: number;
      facts: number;
      cohorts: number;
      outcomes: number;
      candidates: number;
      batches: number;
    }>(
      `select
         count(*) filter (where observation.metric_key like 'nonfinite_observation_%')::integer
           as observations,
         (select count(*)::integer from public.management_pattern_metric_source_facts fact
          where fact.organization_id = $1 and fact.run_id = $2
            and fact.observation_id = $3) as facts,
         (select count(*)::integer from public.management_pattern_cohorts cohort
          where cohort.organization_id = $1 and cohort.run_id = $2
            and cohort.id = $4) as cohorts,
         (select count(*)::integer from public.management_pattern_check_outcomes outcome
          where outcome.organization_id = $1 and outcome.run_id = $2
            and outcome.id = $5) as outcomes,
         (select count(*)::integer from public.management_pattern_candidates candidate
          where candidate.organization_id = $1 and candidate.run_id = $2
            and candidate.id = $6) as candidates,
         (select count(*)::integer from public.management_pattern_result_batches batch
          where batch.organization_id = $1 and batch.run_id = $2) as batches
       from public.management_pattern_metric_observations observation
       where observation.organization_id = $1 and observation.run_id = $2`,
      [ORG_A, runId, factObservationId, cohortId, numericOutcomeId, numericCandidateId],
    ), {
      observations: 0,
      facts: 0,
      cohorts: 0,
      outcomes: 0,
      candidates: 0,
      batches: 0,
    });

    await assert.rejects(
      pg.query(
        `select * from public.finalize_management_pattern_run(
           p_organization_id => $1,
           p_run_id => $2,
           p_owner_token => $3,
           p_fencing_token => 1,
           p_terminal_status => 'succeeded',
           p_property_count => 2,
           p_included_property_count => 2,
           p_observation_count => 1,
           p_source_fact_count => 93
         )`,
        [ORG_A, runId, OWNER_A],
      ),
      /requires its atomic derived-result batch receipt/i,
    );
  });

  test('seals deterministic candidates, validates local links, and finalizes by CAS', async () => {
    await pg.query(
      `insert into public.management_pattern_check_outcomes (
         id, organization_id, run_id, run_fencing_token, outcome_key,
         check_id, check_version, semantic_family, root_domain_key,
         result, quality_gate, input_hash,
         outcome_hash, candidate_count, rows_examined
       ) values (
         $1, $2, $3, 1, 'supply:portfolio', 'portfolio_supply_spend_gap',
         '2', 'supply_efficiency', 'root', 'candidate', 'passed', $4, $5, 2, 2
       ), (
         $6, $2, $3, 1, 'supply:portfolio:normal', 'portfolio_supply_spend_guard',
         '3', 'supply_efficiency', 'root', 'candidate', 'passed', $4, $7, 1, 2
       ), (
         $8, $2, $3, 1, 'supply:portfolio:root-conflict',
         'portfolio_supply_spend_gap', '2', 'supply_efficiency', 'root',
         'abstained', 'failed', $4, $9, 0, 2
       )`,
      [
        OUTCOME,
        ORG_A,
        runId,
        H.input,
        H.outcome,
        OUTCOME_NORMAL,
        '4'.repeat(64),
        OUTCOME_CONFLICT_GATE,
        '5'.repeat(64),
      ],
    );
    await insertCandidate(CANDIDATES[0], 'first', '2026-07-01T12:00:00Z', 10, '1');
    await insertCandidate(
      CANDIDATES[1],
      'budget-suppressed',
      '2026-07-01T12:00:00Z',
      9,
      '2',
      {
        decision: 'suppress',
        rootKey: 'root:budget',
        suppressionReasons: ['candidate_budget_exceeded'],
      },
    );
    await insertCandidate(
      CANDIDATES[2],
      'conflicting-manifestation',
      '2026-07-01T12:00:00Z',
      11,
      '3',
      {
        decision: 'suppress',
        rootKey: 'root:conflict',
        suppressionReasons: ['conflicting_manifestations'],
        checkOutcomeId: OUTCOME_NORMAL,
      },
    );

    await linkCandidate(CANDIDATES[0]);
    await linkCandidate(CANDIDATES[1]);
    await linkCandidate(CANDIDATES[2]);
    await linkLocal(CANDIDATES[0], LOCAL_FINDING);
    await assert.rejects(
      linkLocal(CANDIDATES[0], '40000000-0000-4000-8000-000000000099'),
      /local|foreign key/i,
    );

    await pg.query(
      `insert into public.management_pattern_run_roots (
         organization_id, run_id, run_fencing_token, semantic_family, root_key,
         root_domain_key, detector_ids, detector_versions, expected_outcome_count,
         expected_outcome_keys, expected_outcome_set_hash,
         manifest_source, definition_hash
       ) values ($1, $2, 1, 'supply_efficiency', 'root', 'root',
         array['portfolio_supply_spend_gap','portfolio_supply_spend_guard'],
         '{"portfolio_supply_spend_gap":["2"],"portfolio_supply_spend_guard":["3"]}'::jsonb,
         2,
         array['supply:portfolio','supply:portfolio:normal'],
         encode(sha256(convert_to(array_to_json(
           array['supply:portfolio','supply:portfolio:normal']::text[])::text,
           'UTF8')), 'hex'), 'detector_plan', $3)`,
      [ORG_A, runId, '9'.repeat(64)],
    );
    await pg.query(
      `insert into public.management_pattern_run_roots (
         organization_id, run_id, run_fencing_token, semantic_family, root_key,
         root_domain_key, detector_ids, detector_versions, expected_outcome_count,
         expected_outcome_keys, expected_outcome_set_hash,
         manifest_source, definition_hash
       ) values ($1, $2, 1, 'supply_efficiency', 'root:budget', 'root',
         array['portfolio_supply_spend_gap'],
         '{"portfolio_supply_spend_gap":["2"]}'::jsonb, 1,
         array['supply:portfolio'],
         encode(sha256(convert_to(array_to_json(
           array['supply:portfolio']::text[])::text, 'UTF8')), 'hex'),
         'detector_plan', $3)`,
      [ORG_A, runId, '8'.repeat(64)],
    );
    await pg.query(
      `insert into public.management_pattern_run_roots (
         organization_id, run_id, run_fencing_token, semantic_family, root_key,
         root_domain_key, detector_ids, detector_versions, expected_outcome_count,
         expected_outcome_keys, expected_outcome_set_hash,
         manifest_source, definition_hash
       ) values ($1, $2, 1, 'supply_efficiency', 'root:conflict', 'root',
         array['portfolio_supply_spend_gap','portfolio_supply_spend_guard'],
         '{"portfolio_supply_spend_gap":["2"],"portfolio_supply_spend_guard":["3"]}'::jsonb,
         3,
         array[
           'supply:portfolio',
           'supply:portfolio:normal',
           'supply:portfolio:root-conflict'
         ],
         encode(sha256(convert_to(array_to_json(array[
           'supply:portfolio',
           'supply:portfolio:normal',
           'supply:portfolio:root-conflict'
         ]::text[])::text, 'UTF8')), 'hex'),
         'detector_plan', $3)`,
      [ORG_A, runId, '7'.repeat(64)],
    );
    await pg.query(
      `insert into public.management_pattern_reconciliations (
         id, organization_id, run_id, run_fencing_token, check_outcome_id,
         candidate_id, semantic_family, root_key, root_domain_key, detector_ids,
         detector_versions,
         conclusion, effective_at, evidence, reconciliation_hash
       ) values ($1, $2, $3, 1, $4, $5, 'supply_efficiency', 'root', 'root',
         array['portfolio_supply_spend_gap','portfolio_supply_spend_guard'],
         '{"portfolio_supply_spend_gap":["2"],"portfolio_supply_spend_guard":["3"]}'::jsonb,
         'present', '2026-07-01T12:00:00Z',
         '{"decision":"present"}'::jsonb, $6)`,
      [RECONCILIATION, ORG_A, runId, OUTCOME, CANDIDATES[0], 'a'.repeat(64)],
    );
    await pg.query(
      `insert into public.management_pattern_reconciliations (
         id, organization_id, run_id, run_fencing_token, check_outcome_id,
         candidate_id, semantic_family, root_key, root_domain_key,
         detector_ids, detector_versions,
         conclusion, effective_at, evidence, reconciliation_hash
       ) values ($1, $2, $3, 1, $4, $5, 'supply_efficiency', 'root:budget', 'root',
         array['portfolio_supply_spend_gap'],
         '{"portfolio_supply_spend_gap":["2"]}'::jsonb,
         'present', '2026-07-01T12:00:00Z',
         '{"decision":"present","reasonCodes":["candidate_budget_exceeded"]}'::jsonb, $6)`,
      [
        BUDGET_RECONCILIATION,
        ORG_A,
        runId,
        OUTCOME,
        CANDIDATES[1],
        'b'.repeat(64),
      ],
    );
    await pg.query(
      `insert into public.management_pattern_reconciliations (
         id, organization_id, run_id, run_fencing_token, check_outcome_id,
         candidate_id, semantic_family, root_key, root_domain_key,
         detector_ids, detector_versions,
         conclusion, effective_at, evidence, reconciliation_hash
       ) values ($1, $2, $3, 1, $4, null, 'supply_efficiency', 'root:conflict', 'root',
         array['portfolio_supply_spend_gap','portfolio_supply_spend_guard'],
         '{"portfolio_supply_spend_gap":["2"],"portfolio_supply_spend_guard":["3"]}'::jsonb,
         'abstained', '2026-07-01T12:00:00Z',
         '{"decision":"abstained","reasonCodes":["conflicting_manifestations"]}'::jsonb,
         $5)`,
      [
        CONFLICT_RECONCILIATION,
        ORG_A,
        runId,
        OUTCOME_CONFLICT_GATE,
        'c'.repeat(64),
      ],
    );
    await pg.query(
      `insert into public.management_pattern_reconciliation_outcomes (
         organization_id, run_id, run_fencing_token, reconciliation_id,
         check_outcome_id, lineage_role
       ) values
         ($1, $2, 1, $3, $4, 'primary'),
         ($1, $2, 1, $3, $5, 'supporting'),
         ($1, $2, 1, $6, $4, 'primary'),
         ($1, $2, 1, $7, $8, 'primary'),
         ($1, $2, 1, $7, $4, 'supporting'),
         ($1, $2, 1, $7, $5, 'supporting')`,
      [
        ORG_A,
        runId,
        RECONCILIATION,
        OUTCOME,
        OUTCOME_NORMAL,
        BUDGET_RECONCILIATION,
        CONFLICT_RECONCILIATION,
        OUTCOME_CONFLICT_GATE,
      ],
    );

    await pg.query(
      `insert into public.management_pattern_check_observations (
         organization_id, run_id, run_fencing_token, check_outcome_id,
         observation_id, usage_role
       )
       select $1::uuid, $2::uuid, 1, $3::uuid, o.id, 'target'
       from public.management_pattern_metric_observations o
       where o.organization_id = $1 and o.run_id = $2
       union all
       select $1::uuid, $2::uuid, 1, $4::uuid, o.id, 'target'
       from public.management_pattern_metric_observations o
       where o.organization_id = $1 and o.run_id = $2
       limit 2`,
      [ORG_A, runId, OUTCOME, OUTCOME_NORMAL],
    );

    await assert.rejects(
      pg.query(
        `select * from public.finalize_management_pattern_run(
           $1, $2, $3, 1, 'succeeded',
           2, 2, 0, 0, 0, 1, 93, 2, 2, 3, 3, 1
         )`,
        [ORG_A, runId, OWNER_A],
      ),
      /requires its atomic derived-result batch receipt/i,
    );

    await pg.exec('begin');
    try {
      await pg.query(
        `insert into public.management_pattern_run_roots (
           organization_id, run_id, run_fencing_token, semantic_family, root_key,
           root_domain_key, detector_ids, detector_versions, expected_outcome_count,
           expected_outcome_keys, expected_outcome_set_hash,
           manifest_source, definition_hash
         ) values ($1, $2, 1, 'supply_efficiency', 'root:extra-detector', 'root',
           array['phantom_detector','portfolio_supply_spend_gap'],
           '{"phantom_detector":["99"],"portfolio_supply_spend_gap":["2"]}'::jsonb,
           1, array['supply:portfolio:root-conflict'],
           encode(sha256(convert_to(array_to_json(
             array['supply:portfolio:root-conflict']::text[])::text, 'UTF8')), 'hex'),
           'detector_plan', $3)`,
        [ORG_A, runId, '6'.repeat(64)],
      );
      await pg.query(
        `insert into public.management_pattern_reconciliations (
           id, organization_id, run_id, run_fencing_token, check_outcome_id,
           candidate_id, semantic_family, root_key, root_domain_key,
           detector_ids, detector_versions,
           conclusion, effective_at, evidence, reconciliation_hash
         ) values ($1, $2, $3, 1, $4, null, 'supply_efficiency',
           'root:extra-detector', 'root',
           array['phantom_detector','portfolio_supply_spend_gap'],
           '{"phantom_detector":["99"],"portfolio_supply_spend_gap":["2"]}'::jsonb,
           'abstained', '2026-07-01T12:00:00Z',
           '{"decision":"abstained"}'::jsonb, $5)`,
        [
          EXTRA_DETECTOR_RECONCILIATION,
          ORG_A,
          runId,
          OUTCOME_CONFLICT_GATE,
          'd'.repeat(64),
        ],
      );
      await pg.query(
        `insert into public.management_pattern_reconciliation_outcomes (
           organization_id, run_id, run_fencing_token, reconciliation_id,
           check_outcome_id, lineage_role
         ) values ($1, $2, 1, $3, $4, 'primary')`,
        [ORG_A, runId, EXTRA_DETECTOR_RECONCILIATION, OUTCOME_CONFLICT_GATE],
      );
      await pg.query(
        `insert into public.management_pattern_result_batches (
           organization_id, run_id, run_fencing_token, batch_hash, row_counts
         ) values ($1, $2, 1, $3, jsonb_build_object(
           'cohorts', 0, 'cohort_members', 0,
           'check_outcomes', 3, 'check_observations', 2,
           'candidates', 3, 'candidate_outcomes', 3,
           'candidate_properties', 6, 'candidate_local_instances', 1,
           'run_roots', 4, 'reconciliations', 4,
           'reconciliation_outcomes', 7
         ))`,
        [ORG_A, runId, 'e'.repeat(64)],
      );
      await assert.rejects(
        pg.query(
          `select * from public.finalize_management_pattern_run(
             $1, $2, $3, 1, 'succeeded',
             2, 2, 0, 0, 0, 1, 93, 2, 2, 3, 3, 1
           )`,
          [ORG_A, runId, OWNER_A],
        ),
        /detector set is incomplete/i,
      );
    } finally {
      await pg.exec('rollback');
    }

    await pg.query(
      `insert into public.management_pattern_result_batches (
         organization_id, run_id, run_fencing_token, batch_hash, row_counts
       ) values ($1, $2, 1, $3, jsonb_build_object(
         'cohorts', 0, 'cohort_members', 0,
         'check_outcomes', 3, 'check_observations', 2,
         'candidates', 3, 'candidate_outcomes', 3,
         'candidate_properties', 6, 'candidate_local_instances', 1,
         'run_roots', 3, 'reconciliations', 3,
         'reconciliation_outcomes', 6
       ))`,
      [ORG_A, runId, 'f'.repeat(64)],
    );

    const finalized = await one<{ outcome: string }>(
      `select * from public.finalize_management_pattern_run(
         $1, $2, $3, 1, 'succeeded',
         2, 2, 0, 0, 0, 1, 93, 2, 2, 3, 3, 1
       )`,
      [ORG_A, runId, OWNER_A],
    );
    assert.equal(finalized.outcome, 'finalized');

    // Execute the bounded reader's full loaded branch over a real finalized
    // evidence graph. The test run uses a historical fixed evaluation instant,
    // so move only its validity timestamps inside a rolled-back transaction;
    // the sealed production rows remain unchanged after this assertion.
    await pg.exec('begin');
    try {
      await pg.exec(`set local time zone 'America/Chicago'`);
      for (const evaluationAt of [
        // America/Chicago moves forward inside this interval.
        '2026-03-07T12:00:00Z',
        // America/Chicago moves backward inside this interval.
        '2025-11-01T12:00:00Z',
      ]) {
        await pg.exec('alter table public.management_pattern_runs disable trigger user');
        await pg.query(
          `update public.management_pattern_runs
           set topology_as_of = $3::timestamptz - interval '2 hours',
               source_as_of = $3::timestamptz - interval '1 hour',
               evaluation_at = $3::timestamptz,
               started_at = $3::timestamptz - interval '1 hour',
               completed_at = $3::timestamptz + interval '1 hour'
           where organization_id = $1 and id = $2`,
          [ORG_A, runId, evaluationAt],
        );
        await pg.exec('alter table public.management_pattern_runs enable trigger user');
        const dstReceipt = await one<{ value: {
          status: string;
          run: { valid_through: string };
        } }>(
          `select public.load_management_pattern_portfolio_findings_source(
             $1, $2, $3::timestamptz + interval '2 hours', 40
           ) as value`,
          [SCOPE_RECEIPT_A, ACCOUNT_A, evaluationAt],
        );
        assert.equal(dstReceipt.value.status, 'shadow_only');
        assert.equal(
          new Date(dstReceipt.value.run.valid_through).toISOString(),
          new Date(Date.parse(evaluationAt) + 192 * 3_600_000).toISOString(),
          `validity horizon changed across DST for ${evaluationAt}`,
        );
      }

      await pg.exec('alter table public.management_pattern_runs disable trigger user');
      await pg.query(
        `update public.management_pattern_runs
         set evaluation_at = statement_timestamp() - interval '1 hour',
             completed_at = statement_timestamp()
         where organization_id = $1 and id = $2`,
        [ORG_A, runId],
      );
      await pg.exec('alter table public.management_pattern_runs enable trigger user');

      const shadow = await one<{ value: {
        status: string;
        projection_mode: string;
        available_candidate_count: number;
        candidates: unknown[];
        run: { id: string | null; coverage: { missing_from_run_count: number } };
      } }>(
        `select public.load_management_pattern_portfolio_findings_source(
           $1, $2, statement_timestamp(), 40
         ) as value`,
        [SCOPE_RECEIPT_A, ACCOUNT_A],
      );
      assert.deepEqual({
        status: shadow.value.status,
        projectionMode: shadow.value.projection_mode,
        available: shadow.value.available_candidate_count,
        candidates: shadow.value.candidates,
        redactedRunId: shadow.value.run.id,
        missing: shadow.value.run.coverage.missing_from_run_count,
      }, {
        status: 'shadow_only',
        projectionMode: 'shadow',
        available: 0,
        candidates: [],
        redactedRunId: null,
        missing: 0,
      });

      await pg.exec('alter table public.management_pattern_runs disable trigger user');
      await pg.query(
        `update public.management_pattern_runs
         set projection_mode = 'active'
         where organization_id = $1 and id = $2`,
        [ORG_A, runId],
      );
      await pg.exec('alter table public.management_pattern_runs enable trigger user');
      await pg.exec('alter table public.management_pattern_candidates disable trigger user');
      await pg.query(
        `update public.management_pattern_candidates
         set scope_evidence = jsonb_build_object(
           'organizationId', $1::uuid,
           'rootKey', root_key,
           'scope', classified_scope,
           'eligiblePropertyIds', to_jsonb($3::uuid[]),
           'evaluatedPropertyIds', to_jsonb($3::uuid[]),
           'affectedPropertyIds', jsonb_build_array($4::uuid),
           'matchedGroup', null,
           'fingerprint', $5::text
         )
         where organization_id = $1 and run_id = $2 and decision = 'emit'`,
        [ORG_A, runId, [PROPERTY_A, PROPERTY_B], PROPERTY_A, '5'.repeat(64)],
      );
      await pg.exec('alter table public.management_pattern_candidates enable trigger user');

      const loaded = await one<{ value: {
        status: string;
        available_candidate_count: number;
        candidates: Array<{
          candidate_id: string;
          affected_property_ids: string[];
          detector_receipts: unknown[];
          metric_receipts: unknown[];
          source_query_receipts: unknown[];
        }>;
      } }>(
        `select public.load_management_pattern_portfolio_findings_source(
           $1, $2, statement_timestamp(), 40
         ) as value`,
        [SCOPE_RECEIPT_A, ACCOUNT_A],
      );
      assert.equal(loaded.value.status, 'loaded');
      assert.equal(loaded.value.available_candidate_count, 1);
      assert.equal(loaded.value.candidates.length, 1);
      assert.equal(loaded.value.candidates[0]?.candidate_id, CANDIDATES[0]);
      assert.deepEqual(loaded.value.candidates[0]?.affected_property_ids, [PROPERTY_A]);
      assert.ok((loaded.value.candidates[0]?.detector_receipts.length ?? 0) > 0);
      assert.ok((loaded.value.candidates[0]?.metric_receipts.length ?? 0) > 0);
      assert.ok((loaded.value.candidates[0]?.source_query_receipts.length ?? 0) > 0);

      const restricted = await one<{ value: {
        status: string;
        available_candidate_count: number;
        candidates: unknown[];
      } }>(
        `select public.load_management_pattern_portfolio_findings_source(
           $1, $2, statement_timestamp(), 40
         ) as value`,
        [SCOPE_RECEIPT_SUBSET, ACCOUNT_A],
      );
      assert.equal(restricted.value.status, 'no_applicable_findings');
      assert.equal(restricted.value.available_candidate_count, 0);
      assert.deepEqual(restricted.value.candidates, []);

      const incomplete = await one<{ value: {
        status: string;
        available_candidate_count: number;
        candidates: unknown[];
        run: { id: string | null; coverage: { missing_from_run_count: number } };
      } }>(
        `select public.load_management_pattern_portfolio_findings_source(
           $1, $2, statement_timestamp(), 40
         ) as value`,
        [SCOPE_RECEIPT_MISSING, ACCOUNT_A],
      );
      assert.equal(incomplete.value.status, 'incomplete_scope');
      assert.equal(incomplete.value.available_candidate_count, 0);
      assert.deepEqual(incomplete.value.candidates, []);
      assert.equal(incomplete.value.run.id, null);
      assert.equal(incomplete.value.run.coverage.missing_from_run_count, 1);
    } finally {
      await pg.exec('rollback');
    }

    assert.deepEqual(await one<{ present_suppressed: number; present_emit: number }>(
      `select
         count(*) filter (where c.decision = 'suppress')::integer as present_suppressed,
         count(*) filter (where c.decision = 'emit')::integer as present_emit
       from public.management_pattern_reconciliations r
       join public.management_pattern_candidates c
         on c.organization_id = r.organization_id and c.id = r.candidate_id
       where r.organization_id = $1 and r.run_id = $2 and r.conclusion = 'present'`,
      [ORG_A, runId],
    ), { present_suppressed: 1, present_emit: 1 });

    await assert.rejects(
      pg.query(
        `update public.management_pattern_result_batches
         set batch_hash = $1 where organization_id = $2 and run_id = $3`,
        ['0'.repeat(64), ORG_A, runId],
      ),
      /append-only/i,
    );

    await assert.rejects(
      pg.query(
        `update public.management_pattern_candidates set summary = 'rewritten' where id = $1`,
        [CANDIDATES[0]],
      ),
      /append-only/i,
    );
    await assert.rejects(
      pg.query(
        `insert into public.management_pattern_check_outcomes (
           organization_id, run_id, run_fencing_token, outcome_key,
           check_id, check_version, semantic_family, root_domain_key,
           result, quality_gate, input_hash,
           outcome_hash, candidate_count
         ) values ($1, $2, 1, 'late', 'late', '1', 'late_family', 'late_root',
           'normal', 'passed', $3, $4, 0)`,
        [ORG_A, runId, H.input, '6'.repeat(64)],
      ),
      /sealed/i,
    );
  });

  test('keeps v2 shadow-only and retains immutable evidence without live relationship FKs', async () => {
    await assert.rejects(
      pg.query(
        `select * from public.project_management_pattern_candidate($1, $2)`,
        [ORG_A, CANDIDATES[0]],
      ),
      /active management-pattern projection is disabled/i,
    );
    await assert.rejects(
      pg.query(
        `select * from public.project_management_pattern_run($1, $2)`,
        [ORG_A, runId],
      ),
      /active management-pattern projection is disabled/i,
    );

    await pg.query(
      `delete from public.organization_property_relationships where id = $1`,
      [REL_A],
    );
    assert.equal((await one<{ count: number }>(
      `select count(*)::integer as count
       from public.management_pattern_run_properties
       where organization_id = $1 and run_id = $2 and property_id = $3`,
      [ORG_A, runId, PROPERTY_A],
    )).count, 1);

    await assert.rejects(
      pg.query(`delete from public.properties where id = $1`, [PROPERTY_A]),
      /retained management[- ]pattern evidence/i,
    );
    await assert.rejects(
      pg.query(`delete from public.organizations where id = $1`, [ORG_A]),
      /retained management[- ]pattern evidence/i,
    );
  });
});
