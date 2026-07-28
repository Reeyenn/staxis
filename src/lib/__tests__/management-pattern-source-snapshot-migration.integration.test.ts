import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

import { prepareManagementPatternInputs } from '@/lib/company/management-patterns/prepare-inputs';
import { managementPatternSourceSnapshotSchema } from '@/lib/company/management-patterns/source-snapshot';

const ORG_A = '10000000-0000-4000-8000-000000000001';
const ORG_B = '10000000-0000-4000-8000-000000000002';
const PROPERTY_A = '20000000-0000-4000-8000-000000000001';
const PROPERTY_B = '20000000-0000-4000-8000-000000000002';
const REL_A = '30000000-0000-4000-8000-000000000001';
const REL_B = '30000000-0000-4000-8000-000000000002';
const REL_MOVE = '30000000-0000-4000-8000-000000000003';
const REL_OVERLAP = '30000000-0000-4000-8000-000000000004';
const REL_REKEYED = '30000000-0000-4000-8000-000000000005';
const PROFILE_A = '40000000-0000-4000-8000-000000000001';
const PROFILE_B = '40000000-0000-4000-8000-000000000002';
const GROUP_NORTH = '80000000-0000-4000-8000-000000000001';
const GROUP_SOUTH = '80000000-0000-4000-8000-000000000002';
const ASSIGNMENT_NORTH = '81000000-0000-4000-8000-000000000001';
const ASSIGNMENT_SOUTH = '81000000-0000-4000-8000-000000000002';
const ASSIGNMENT_REKEYED = '81000000-0000-4000-8000-000000000003';

const EVALUATION_AT = '2026-04-05T12:00:00Z';
const SOURCE_AS_OF = EVALUATION_AT;
const TOPOLOGY_AS_OF = EVALUATION_AT;

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0387_management_pattern_source_snapshot.sql'),
  'utf8',
);

let pg: PGlite;

async function snapshotAt(input: Readonly<{
  organizationId?: string;
  evaluationAt?: string;
  sourceAsOf?: string;
  topologyAsOf?: string;
}> = {}) {
  const organizationId = input.organizationId ?? ORG_A;
  const evaluationAt = input.evaluationAt ?? EVALUATION_AT;
  const sourceAsOf = input.sourceAsOf ?? SOURCE_AS_OF;
  const topologyAsOf = input.topologyAsOf ?? TOPOLOGY_AS_OF;
  const result = await pg.query<{ value: unknown }>(
    `select public.load_management_pattern_source_snapshot(
       $1, $2, $3, $4, '2026-01-01', '2026-03-31', 98, 50
     ) as value`,
    [organizationId, evaluationAt, sourceAsOf, topologyAsOf],
  );
  assert.ok(result.rows[0]);
  return managementPatternSourceSnapshotSchema.parse(result.rows[0].value);
}

async function snapshot(organizationId = ORG_A) {
  return snapshotAt({ organizationId });
}

describe('management pattern source snapshot migration 0387', () => {
  before(async () => {
    pg = new PGlite();
    await pg.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role bypassrls nologin;

      create table public.organizations (
        id uuid primary key,
        organization_type text not null,
        status text not null,
        legacy_property_id uuid,
        updated_at timestamptz not null
      );
      create table public.properties (
        id uuid primary key,
        name text not null,
        total_rooms integer,
        timezone text,
        business_date_cutoff_hour integer,
        property_kind text,
        brand text,
        region text,
        updated_at timestamptz not null
      );
      create table public.organization_property_relationships (
        id uuid primary key,
        organization_id uuid not null,
        property_id uuid not null,
        relationship_type text not null,
        is_primary_grouping boolean not null,
        starts_at timestamptz not null,
        ends_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        unique (id, organization_id, property_id)
      );
      create table public.organization_access_events (
        id uuid primary key,
        occurred_at timestamptz not null,
        organization_id uuid,
        event_type text not null,
        target_type text not null,
        target_id text,
        before_state jsonb,
        after_state jsonb
      );
      create table public.management_pattern_property_profiles (
        id uuid primary key,
        organization_id uuid not null,
        property_id uuid not null,
        property_relationship_id uuid not null,
        profile_version integer not null,
        effective_from timestamptz not null,
        effective_to timestamptz,
        source_kind text,
        source_reference text,
        room_count integer,
        timezone_name text,
        business_date_cutoff_hour integer,
        service_level text,
        market_type text,
        brand_class text,
        location_type text,
        operating_model text,
        amenity_tags text[],
        currency_code text,
        currency_minor_unit_exponent integer,
        comparison_attributes jsonb,
        created_at timestamptz not null
      );
      create table public.portfolios (
        id uuid primary key,
        organization_id uuid not null,
        name text not null,
        portfolio_type text not null,
        parent_id uuid,
        status text not null,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
      create table public.portfolio_properties (
        id uuid primary key,
        organization_id uuid not null,
        portfolio_id uuid not null,
        property_id uuid not null,
        property_relationship_id uuid not null,
        assigned_at timestamptz not null,
        removed_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
      create table public.inventory_month_closes (
        id uuid primary key,
        property_id uuid not null,
        month_start date not null,
        timezone text not null,
        status text not null,
        month_start_at timestamptz not null,
        end_at timestamptz not null,
        is_partial boolean not null,
        purchase_source text,
        allocation_mode text,
        confirmed_purchase_cents numeric,
        logged_purchase_cents numeric,
        manual_purchase_cents numeric,
        logged_delivery_count integer not null,
        uncosted_delivery_count integer not null,
        quality_flags jsonb not null,
        closed_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
      create table public.daily_logs (
        property_id uuid not null,
        date date not null,
        rooms_sold numeric,
        occupancy_source text,
        sealed_at timestamptz,
        seal_version integer not null,
        source_completeness jsonb,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
      create table public.inventory_counts (
        property_id uuid not null,
        counted_at timestamptz not null,
        count_session_id uuid,
        created_at timestamptz not null
      );
      create table public.work_orders (
        property_id uuid not null,
        created_at timestamptz,
        updated_at timestamptz not null
      );
      create table public.applied_migrations (
        version text primary key,
        description text not null
      );

      insert into public.organizations values
        ('${ORG_A}', 'management_company', 'active', null, '2025-01-01T00:00:00Z'),
        ('${ORG_B}', 'ownership_group', 'active', null, '2025-01-01T00:00:00Z');
      insert into public.properties values
        ('${PROPERTY_A}', 'Alpha', 100, 'America/Chicago', 4, 'hotel', 'A', 'Central',
          '2025-01-01T00:00:00Z'),
        ('${PROPERTY_B}', 'Bravo', 80, 'America/New_York', 3, 'hotel', 'B', 'East',
          '2025-01-01T00:00:00Z');
      insert into public.organization_property_relationships values
        ('${REL_A}', '${ORG_A}', '${PROPERTY_A}', 'operator', true,
          '2020-01-01T00:00:00Z', null, '2020-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
        ('${REL_B}', '${ORG_B}', '${PROPERTY_B}', 'owner', true,
          '2020-01-01T00:00:00Z', null, '2020-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
      insert into public.management_pattern_property_profiles values
        ('${PROFILE_A}', '${ORG_A}', '${PROPERTY_A}', '${REL_A}', 1,
          '2020-01-01T00:00:00Z', null, 'organization_override', 'fixture',
          100, 'America/Chicago', 4, 'limited_service', 'urban', 'upper_midscale',
          'city', 'select_service', array[]::text[], 'USD', 2, '{}'::jsonb,
          '2025-01-01T00:00:00Z'),
        ('${PROFILE_B}', '${ORG_B}', '${PROPERTY_B}', '${REL_B}', 1,
          '2020-01-01T00:00:00Z', null, 'organization_override', 'fixture',
          80, 'America/New_York', 3, 'limited_service', 'urban', 'midscale',
          'city', 'select_service', array[]::text[], 'USD', 2, '{}'::jsonb,
          '2025-01-01T00:00:00Z');

      insert into public.inventory_month_closes values
        ('50000000-0000-4000-8000-000000000001', '${PROPERTY_A}', '2026-01-01',
          'America/Chicago', 'closed', '2026-01-01T06:00:00Z', '2026-02-01T06:00:00Z',
          false, 'manual_total', 'total_only', 10000, 0, 10000, 0, 0, '[]',
          '2026-02-01T12:00:00Z', '2026-01-01T00:00:00Z', '2026-02-01T12:00:00Z'),
        ('50000000-0000-4000-8000-000000000002', '${PROPERTY_A}', '2026-02-01',
          'America/Chicago', 'closed', '2026-02-01T06:00:00Z', '2026-03-01T06:00:00Z',
          false, 'manual_total', 'total_only', 20000, 0, 20000, 0, 0, '[]',
          '2026-03-01T12:00:00Z', '2026-02-01T00:00:00Z', '2026-03-01T12:00:00Z'),
        ('50000000-0000-4000-8000-000000000003', '${PROPERTY_A}', '2026-03-01',
          'America/Chicago', 'closed', '2026-03-01T06:00:00Z', '2026-04-01T05:00:00Z',
          false, 'manual_total', 'total_only', 30000, 0, 30000, 0, 0, '[]',
          '2026-04-01T12:00:00Z', '2026-03-01T00:00:00Z', '2026-04-01T12:00:00Z'),
        ('50000000-0000-4000-8000-000000000011', '${PROPERTY_B}', '2026-01-01',
          'America/New_York', 'closed', '2026-01-01T05:00:00Z', '2026-02-01T05:00:00Z',
          false, 'manual_total', 'total_only', 99999, 0, 99999, 0, 0, '[]',
          '2026-02-01T12:00:00Z', '2026-01-01T00:00:00Z', '2026-02-01T12:00:00Z');

      insert into public.daily_logs (
        property_id, date, rooms_sold, occupancy_source, sealed_at, seal_version,
        source_completeness, created_at, updated_at
      )
      select '${PROPERTY_A}', day::date, 10, 'operator',
        (day + interval '1 day 10 hours')::timestamptz, 1,
        '{"occupancy_complete":true}'::jsonb,
        (day + interval '1 day 10 hours')::timestamptz,
        (day + interval '1 day 10 hours')::timestamptz
      from generate_series('2026-01-01'::timestamp, '2026-03-31'::timestamp, interval '1 day') day;

      insert into public.inventory_counts values
        ('${PROPERTY_A}', '2026-03-10T08:30:00Z',
          '60000000-0000-4000-8000-000000000001', '2026-03-10T08:31:00Z'),
        ('${PROPERTY_A}', '2026-03-10T09:30:00Z',
          '60000000-0000-4000-8000-000000000002', '2026-03-10T09:31:00Z'),
        ('${PROPERTY_B}', '2026-03-10T09:30:00Z',
          '60000000-0000-4000-8000-000000000003', '2026-03-10T09:31:00Z');
      insert into public.work_orders values
        ('${PROPERTY_A}', '2026-03-15T12:00:00Z', '2026-03-15T12:00:00Z');
    `);
    await pg.exec(MIGRATION_SQL);
  });

  after(async () => {
    await pg.close().catch(() => undefined);
  });

  test('enforces the source RPC role boundary and installs historical audit indexes', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      await pg.exec(`set role ${role}`);
      try {
        await assert.rejects(() => snapshot(), /permission denied/i);
      } finally {
        await pg.exec('reset role');
      }
    }

    await pg.exec('set role service_role');
    try {
      await assert.rejects(
        pg.query(
          `select * from public.management_pattern_profile_at_v1(
             $1, $2, $3, $4, $5
           )`,
          [ORG_A, PROPERTY_A, REL_A, TOPOLOGY_AS_OF, SOURCE_AS_OF],
        ),
        /permission denied/i,
      );
      const serviceSnapshot = await snapshot();
      assert.equal(serviceSnapshot.organization.id, ORG_A);
      assert.deepEqual(
        serviceSnapshot.properties.map((property) => property.property_id),
        [PROPERTY_A],
      );
    } finally {
      await pg.exec('reset role');
    }

    const indexes = await pg.query<{ name: string | null }>(`
      select to_regclass(name)::text as name
      from unnest(array[
        'public.organization_access_events_relationship_before_scope_idx',
        'public.organization_access_events_relationship_after_scope_idx',
        'public.organization_access_events_relationship_before_property_idx',
        'public.organization_access_events_relationship_after_property_idx',
        'public.organization_access_events_portfolio_property_before_scope_idx',
        'public.organization_access_events_portfolio_property_after_scope_idx'
      ]) name
    `);
    assert.equal(indexes.rows.length, 6);
    assert.ok(indexes.rows.every((row) => row.name !== null));

    await pg.exec('set enable_seqscan = off');
    try {
      const plans: string[] = [];
      for (const query of [
        `select before_state->>'property_id'
         from public.organization_access_events
         where target_type = 'organization_property_relationships'
           and before_state->>'organization_id' = '${ORG_A}'
           and before_state->>'property_id' is not null`,
        `select after_state->>'property_id'
         from public.organization_access_events
         where target_type = 'organization_property_relationships'
           and after_state->>'organization_id' = '${ORG_A}'
           and after_state->>'property_id' is not null`,
        `select before_state->>'property_id'
         from public.organization_access_events
         where target_type = 'portfolio_properties'
           and before_state->>'organization_id' = '${ORG_A}'
           and before_state->>'property_id' is not null`,
        `select after_state->>'property_id'
         from public.organization_access_events
         where target_type = 'portfolio_properties'
           and after_state->>'organization_id' = '${ORG_A}'
           and after_state->>'property_id' is not null`,
      ]) {
        const explained = await pg.query<Record<string, string>>(`explain ${query}`);
        plans.push(explained.rows.map((row) => Object.values(row)[0]).join('\n'));
      }
      assert.match(plans[0]!, /relationship_before_scope_idx/i);
      assert.match(plans[1]!, /relationship_after_scope_idx/i);
      assert.match(plans[2]!, /portfolio_property_before_scope_idx/i);
      assert.match(plans[3]!, /portfolio_property_after_scope_idx/i);
    } finally {
      await pg.exec('reset enable_seqscan');
    }
  });

  test('rejects explicit nulls that would disable source-query budgets', async () => {
    await assert.rejects(
      pg.query(
        `select public.load_management_pattern_source_snapshot(
           $1, $2, $3, $4, '2026-01-01', '2026-03-31', null, 50
         )`,
        [ORG_A, EVALUATION_AT, SOURCE_AS_OF, TOPOLOGY_AS_OF],
      ),
      /activity_history_days must be between 28 and 366/i,
    );
    await assert.rejects(
      pg.query(
        `select public.load_management_pattern_source_snapshot(
           $1, $2, $3, $4, '2026-01-01', '2026-03-31', 98, null
         )`,
        [ORG_A, EVALUATION_AT, SOURCE_AS_OF, TOPOLOGY_AS_OF],
      ),
      /supports exactly the fixed 50-property ceiling/i,
    );
  });

  test('returns a strict tenant-isolated receipt with distinct DST/cutoff windows', async () => {
    const result = await snapshot();
    assert.equal(result.property_count, 1);
    assert.deepEqual(result.properties.map((property) => property.property_id), [PROPERTY_A]);
    const property = result.properties[0]!;
    assert.equal(property.supply.confirmed_purchase_storage_cents, 60000);
    assert.equal(property.rooms_sold.room_nights_sold, 900);
    assert.equal(property.rooms_sold.normalization_eligible, true);
    assert.equal(
      new Date(property.supply.fresh_through!).toISOString(),
      '2026-04-01T04:59:59.999Z',
    );
    assert.equal(
      new Date(property.supply.source_watermark.max_closed_at!).toISOString(),
      '2026-04-01T12:00:00.000Z',
    );
    assert.equal(
      new Date(property.rooms_sold.fresh_through!).toISOString(),
      '2026-04-01T08:59:59.999Z',
    );
    assert.ok(
      Date.parse(property.rooms_sold.source_watermark.max_sealed_at!)
        > Date.parse(property.rooms_sold.fresh_through!),
      'sealed lifecycle time remains distinct from domain coverage freshness',
    );
    assert.deepEqual({
      ...property.windows.supply_inventory,
      start_utc: new Date(property.windows.supply_inventory.start_utc!).toISOString(),
      end_utc: new Date(property.windows.supply_inventory.end_utc!).toISOString(),
    }, {
      start_date: '2026-01-01',
      end_date: '2026-03-31',
      timezone: 'America/Chicago',
      date_basis: 'property_local_calendar_month',
      business_date_cutoff_hour: 0,
      start_utc: '2026-01-01T06:00:00.000Z',
      end_utc: '2026-04-01T05:00:00.000Z',
    });
    assert.equal(
      new Date(property.windows.supply_occupancy.start_utc!).toISOString(),
      '2026-01-01T10:00:00.000Z',
    );
    assert.equal(
      new Date(property.windows.supply_occupancy.end_utc!).toISOString(),
      '2026-04-01T09:00:00.000Z',
    );
    assert.notEqual(
      property.windows.supply_inventory.start_utc,
      property.windows.supply_occupancy.start_utc,
    );
    assert.deepEqual(property.activity.inventory_counts.event_dates, ['2026-03-09', '2026-03-10']);
    for (const stream of Object.values(property.activity).filter((value) => (
      typeof value === 'object' && value !== null && 'query_coverage_status' in value
    ))) {
      assert.equal(stream.query_coverage_status, 'not_evaluated');
      assert.equal(stream.absence_detection_eligible, false);
    }

    const other = await snapshot(ORG_B);
    assert.deepEqual(other.properties.map((property) => property.property_id), [PROPERTY_B]);
    assert.equal(other.properties[0]!.supply.confirmed_purchase_storage_cents, 99999);
    assert.equal(
      other.properties[0]!.supply.periods.some((period) => [
        '50000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000002',
        '50000000-0000-4000-8000-000000000003',
      ].includes(period.id)),
      false,
    );
  });

  test('rejects same-version activity eligibility or mutability drift', async () => {
    type DriftableStream = {
      query_coverage_status: string;
      absence_detection_eligible: boolean;
      recording_flow_support?: string;
    };
    type DriftableSnapshot = {
      properties: Array<{
        activity: {
          inventory_counts: DriftableStream;
          daily_log_closings: DriftableStream;
          work_order_flow: DriftableStream;
        };
      }>;
    };
    const baseline = await snapshot();
    const cases: ReadonlyArray<Readonly<{
      name: string;
      mutate: (snapshotInput: DriftableSnapshot) => void;
    }>> = [
      {
        name: 'inventory complete coverage',
        mutate: (value) => {
          value.properties[0]!.activity.inventory_counts.query_coverage_status = 'complete';
        },
      },
      {
        name: 'inventory absence eligibility',
        mutate: (value) => {
          value.properties[0]!.activity.inventory_counts.absence_detection_eligible = true;
        },
      },
      {
        name: 'daily-log absence eligibility despite unsupported history',
        mutate: (value) => {
          value.properties[0]!.activity.daily_log_closings.absence_detection_eligible = true;
        },
      },
      {
        name: 'live-current-state work-order proof',
        mutate: (value) => {
          value.properties[0]!.activity.work_order_flow.recording_flow_support = 'live_current_state';
        },
      },
    ];
    for (const contractCase of cases) {
      const drifted = structuredClone(baseline) as unknown as DriftableSnapshot;
      contractCase.mutate(drifted);
      assert.equal(
        managementPatternSourceSnapshotSchema.safeParse(drifted).success,
        false,
        contractCase.name,
      );
    }
  });

  test('freezes the original receipt while a later backfill admits genuinely late historical rows', async () => {
    await pg.exec('begin');
    try {
      await pg.exec(`
        delete from public.daily_logs
        where property_id = '${PROPERTY_A}' and date = '2026-02-01';
        update public.inventory_month_closes
        set status = 'open', closed_at = null,
            updated_at = '2026-04-05T10:00:00Z'
        where property_id = '${PROPERTY_A}' and month_start = '2026-03-01';
      `);
      const originalReceipt = await snapshot();
      const originalProperty = originalReceipt.properties[0]!;
      assert.equal(
        new Date(originalReceipt.analysis_window_anchor).toISOString(),
        new Date(TOPOLOGY_AS_OF).toISOString(),
      );
      assert.equal(originalProperty.supply.usable_periods, 2);
      assert.equal(originalProperty.supply.confirmed_purchase_storage_cents, 30000);
      assert.equal(originalProperty.rooms_sold.observed_days, 89);
      assert.equal(originalProperty.rooms_sold.room_nights_sold, 890);
      assert.equal(originalProperty.rooms_sold.normalization_eligible, false);
      assert.equal(
        originalProperty.rooms_sold.days.some((day) => day.date === '2026-02-01'),
        false,
      );

      await pg.exec(`
        insert into public.daily_logs (
          property_id, date, rooms_sold, occupancy_source, sealed_at, seal_version,
          source_completeness, created_at, updated_at
        ) values (
          '${PROPERTY_A}', '2026-02-01', 12, 'operator',
          '2026-04-06T00:00:00Z', 1, '{"occupancy_complete":true}'::jsonb,
          '2026-04-06T00:00:00Z', '2026-04-06T00:00:00Z'
        );
        update public.inventory_month_closes
        set status = 'closed', closed_at = '2026-04-06T00:00:00Z',
            updated_at = '2026-04-06T00:00:00Z'
        where property_id = '${PROPERTY_A}' and month_start = '2026-03-01';
      `);
      const correctedReceipt = await snapshotAt({
        evaluationAt: '2026-04-07T12:00:00Z',
        sourceAsOf: '2026-04-07T12:00:00Z',
        topologyAsOf: TOPOLOGY_AS_OF,
      });
      const correctedProperty = correctedReceipt.properties[0]!;
      assert.equal(
        new Date(correctedReceipt.analysis_window_anchor).toISOString(),
        new Date(TOPOLOGY_AS_OF).toISOString(),
      );
      assert.equal(
        new Date(correctedReceipt.topology_as_of).toISOString(),
        new Date(TOPOLOGY_AS_OF).toISOString(),
      );
      assert.equal(
        new Date(correctedReceipt.source_as_of).toISOString(),
        '2026-04-07T12:00:00.000Z',
      );
      assert.equal(correctedProperty.supply.usable_periods, 3);
      assert.equal(correctedProperty.supply.confirmed_purchase_storage_cents, 60000);
      assert.equal(correctedProperty.rooms_sold.observed_days, 90);
      assert.equal(correctedProperty.rooms_sold.room_nights_sold, 902);
      assert.equal(correctedProperty.rooms_sold.normalization_eligible, true);
      assert.equal(
        correctedProperty.rooms_sold.days.find((day) => day.date === '2026-02-01')?.rooms_sold,
        12,
      );
      assert.equal(
        new Date(correctedProperty.supply.fresh_through!).toISOString(),
        '2026-04-01T04:59:59.999Z',
      );
      assert.equal(
        new Date(correctedProperty.supply.source_watermark.max_closed_at!).toISOString(),
        '2026-04-06T00:00:00.000Z',
      );
      assert.equal(
        new Date(correctedProperty.rooms_sold.fresh_through!).toISOString(),
        '2026-04-01T08:59:59.999Z',
      );
      assert.equal(
        new Date(correctedProperty.rooms_sold.source_watermark.max_sealed_at!).toISOString(),
        '2026-04-06T00:00:00.000Z',
      );
      assert.equal(
        new Date(correctedProperty.rooms_sold.source_watermark.max_updated_at!).toISOString(),
        '2026-04-06T00:00:00.000Z',
      );
      const correctedPrepared = prepareManagementPatternInputs(correctedReceipt);
      assert.equal(correctedPrepared.properties[0]?.supply.normalization?.ok, true);
      assert.equal(
        correctedPrepared.properties[0]?.supply.reasonCodes.includes('denominator_from_future'),
        false,
      );
      assert.equal(
        correctedPrepared.properties[0]?.supply.reasonCodes.includes('observation_from_future'),
        false,
      );
    } finally {
      await pg.exec('rollback');
    }
  });

  test('reconstructs the pre-move relationship after audited update and delete mutations', async () => {
    await pg.exec('begin');
    try {
      await pg.exec(`
        with before_row as (
          select to_jsonb(r) as state
          from public.organization_property_relationships r
          where r.id = '${REL_A}'
        ), changed as (
          update public.organization_property_relationships
          set ends_at = '2026-04-06T00:00:00Z',
              updated_at = '2026-04-06T00:00:00Z'
          where id = '${REL_A}'
          returning to_jsonb(organization_property_relationships) as state
        )
        insert into public.organization_access_events (
          id, occurred_at, organization_id, event_type, target_type, target_id,
          before_state, after_state
        )
        select '70000000-0000-4000-8000-000000000001',
          '2026-04-06T00:00:00Z'::timestamptz, '${ORG_A}'::uuid,
          'organization_property_relationships.update',
          'organization_property_relationships', '${REL_A}',
          before_row.state, changed.state
        from before_row cross join changed;

        insert into public.organization_property_relationships values (
          '${REL_MOVE}', '${ORG_B}', '${PROPERTY_A}', 'operator', true,
          '2026-04-06T00:00:00Z', null,
          '2026-04-06T00:00:00Z', '2026-04-06T00:00:00Z'
        );
        insert into public.organization_access_events (
          id, occurred_at, organization_id, event_type, target_type, target_id,
          before_state, after_state
        )
        select '70000000-0000-4000-8000-000000000002',
          '2026-04-06T00:00:00Z', '${ORG_B}',
          'organization_property_relationships.insert',
          'organization_property_relationships', '${REL_MOVE}',
          null, to_jsonb(r)
        from public.organization_property_relationships r
        where r.id = '${REL_MOVE}';

        with deleted as (
          delete from public.organization_property_relationships
          where id = '${REL_A}'
          returning to_jsonb(organization_property_relationships) as state
        )
        insert into public.organization_access_events (
          id, occurred_at, organization_id, event_type, target_type, target_id,
          before_state, after_state
        )
        select '70000000-0000-4000-8000-000000000003',
          '2026-04-07T00:00:00Z', '${ORG_A}',
          'organization_property_relationships.delete',
          'organization_property_relationships', '${REL_A}',
          deleted.state, null
        from deleted;

        update public.properties
        set name = 'Post-transfer confidential rename',
            updated_at = '2026-04-07T00:00:00Z'
        where id = '${PROPERTY_A}';
        update public.inventory_month_closes
        set confirmed_purchase_cents = 999999,
            updated_at = '2026-04-07T00:00:00Z'
        where property_id = '${PROPERTY_A}' and month_start = '2026-03-01';
        update public.daily_logs
        set rooms_sold = 999,
            updated_at = '2026-04-07T00:00:00Z'
        where property_id = '${PROPERTY_A}' and date = '2026-02-02';
      `);

      const historicalA = await snapshot();
      assert.deepEqual(historicalA.properties.map((property) => property.property_id), [PROPERTY_A]);
      assert.equal(
        historicalA.properties[0]!.relationship.history_proof_kind,
        'event_after_before_state',
      );
      assert.equal(historicalA.properties[0]!.relationship.ends_at, null);

      const historicalB = await snapshot(ORG_B);
      assert.deepEqual(historicalB.properties.map((property) => property.property_id), [PROPERTY_B]);

      const laterSourceFrozenTopologyA = await snapshotAt({
        organizationId: ORG_A,
        evaluationAt: '2026-04-08T00:00:00Z',
        sourceAsOf: '2026-04-08T00:00:00Z',
        topologyAsOf: TOPOLOGY_AS_OF,
      });
      assert.deepEqual(
        laterSourceFrozenTopologyA.properties.map((property) => property.property_id),
        [PROPERTY_A],
      );
      const frozenProperty = laterSourceFrozenTopologyA.properties[0]!;
      assert.equal(frozenProperty.property_name, 'Historical property 20000000');
      assert.notEqual(frozenProperty.property_name, 'Post-transfer confidential rename');
      assert.equal(frozenProperty.relationship.source_access.effective_source_cutoff_reason,
        'audited_membership_loss');
      assert.equal(
        new Date(frozenProperty.relationship.source_access.effective_source_cutoff).toISOString(),
        '2026-04-06T00:00:00.000Z',
      );
      assert.equal(
        frozenProperty.relationship.source_access.effective_source_cutoff_is_exclusive,
        true,
      );
      assert.equal(
        new Date(frozenProperty.supply.source_watermark.requested_source_as_of).toISOString(),
        '2026-04-08T00:00:00.000Z',
      );
      assert.equal(
        new Date(frozenProperty.supply.source_watermark.source_as_of).toISOString(),
        '2026-04-06T00:00:00.000Z',
      );
      assert.equal(frozenProperty.supply.observed_periods, 2);
      assert.equal(frozenProperty.supply.confirmed_purchase_storage_cents, 30000);
      assert.equal(
        frozenProperty.supply.periods.some((period) => (
          period.confirmed_purchase_storage_cents === 999999
        )),
        false,
      );
      assert.equal(
        frozenProperty.rooms_sold.days.some((day) => day.rooms_sold === 999),
        false,
      );
      const laterSourceFrozenTopologyB = await snapshotAt({
        organizationId: ORG_B,
        evaluationAt: '2026-04-08T00:00:00Z',
        sourceAsOf: '2026-04-08T00:00:00Z',
        topologyAsOf: TOPOLOGY_AS_OF,
      });
      assert.deepEqual(
        laterSourceFrozenTopologyB.properties.map((property) => property.property_id),
        [PROPERTY_B],
      );

      const afterMoveB = await snapshotAt({
        organizationId: ORG_B,
        evaluationAt: '2026-04-08T00:00:00Z',
        sourceAsOf: '2026-04-08T00:00:00Z',
        topologyAsOf: '2026-04-08T00:00:00Z',
      });
      assert.deepEqual(
        afterMoveB.properties.map((property) => property.property_id).sort(),
        [PROPERTY_A, PROPERTY_B].sort(),
      );
    } finally {
      await pg.exec('rollback');
    }
  });

  test('rejects an audit receipt that rekeys a relationship across the topology boundary', async () => {
    await pg.exec('begin');
    try {
      await pg.exec(`
        with before_row as (
          select to_jsonb(relationship) as state
          from public.organization_property_relationships relationship
          where relationship.id = '${REL_A}'
        ), rekeyed as (
          update public.organization_property_relationships
          set id = '${REL_REKEYED}',
              updated_at = '2026-04-06T00:00:00Z'
          where id = '${REL_A}'
          returning to_jsonb(organization_property_relationships) as state
        )
        insert into public.organization_access_events (
          id, occurred_at, organization_id, event_type, target_type, target_id,
          before_state, after_state
        )
        select '70000000-0000-4000-8000-000000000099',
          '2026-04-06T00:00:00Z', '${ORG_A}',
          'organization_property_relationships.update',
          'organization_property_relationships', '${REL_REKEYED}',
          before_row.state, rekeyed.state
        from before_row cross join rekeyed;
      `);

      await assert.rejects(
        snapshotAt({
          evaluationAt: '2026-04-07T00:00:00Z',
          sourceAsOf: '2026-04-07T00:00:00Z',
          topologyAsOf: TOPOLOGY_AS_OF,
        }),
        /relationship topology history identity is unavailable/i,
      );
    } finally {
      await pg.exec('rollback');
    }
  });

  test('caps old-company source access when transfer uses a separate governing row', async () => {
    await pg.exec('begin');
    try {
      await pg.exec(`
        insert into public.organization_property_relationships values (
          '${REL_MOVE}', '${ORG_B}', '${PROPERTY_A}', 'owner', true,
          '2026-04-06T00:00:00Z', '2026-05-01T00:00:00Z',
          '2026-04-06T00:00:00Z', '2026-04-06T00:00:00Z'
        );
        update public.inventory_month_closes
        set confirmed_purchase_cents = 888888,
            updated_at = '2026-04-07T00:00:00Z'
        where property_id = '${PROPERTY_A}' and month_start = '2026-03-01';
      `);

      const frozen = await snapshotAt({
        organizationId: ORG_A,
        evaluationAt: '2026-04-08T00:00:00Z',
        sourceAsOf: '2026-04-08T00:00:00Z',
        topologyAsOf: TOPOLOGY_AS_OF,
      });
      const property = frozen.properties[0]!;
      assert.equal(
        property.relationship.source_access.effective_source_cutoff_reason,
        'audited_membership_loss',
      );
      assert.equal(
        property.relationship.source_access.effective_source_cutoff_proof_kind,
        'relationship_state',
      );
      assert.equal(
        new Date(property.relationship.source_access.effective_source_cutoff).toISOString(),
        '2026-04-06T00:00:00.000Z',
      );
      assert.equal(property.supply.observed_periods, 2);
      assert.equal(property.supply.confirmed_purchase_storage_cents, 30000);
      assert.equal(
        property.supply.periods.some((period) => (
          period.confirmed_purchase_storage_cents === 888888
        )),
        false,
      );
    } finally {
      await pg.exec('rollback');
    }
  });

  test('reconstructs exact pre-move region and group definition across audited move and deletion', async () => {
    await pg.exec('begin');
    try {
      await pg.exec(`
        insert into public.portfolios (
          id, organization_id, name, portfolio_type, parent_id, status, created_at, updated_at
        ) values
          ('${GROUP_NORTH}', '${ORG_A}', 'North', 'region', null, 'active',
            '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
          ('${GROUP_SOUTH}', '${ORG_A}', 'South', 'region', null, 'active',
            '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
        insert into public.portfolio_properties (
          id, organization_id, portfolio_id, property_id, property_relationship_id,
          assigned_at, removed_at, created_at, updated_at
        ) values (
          '${ASSIGNMENT_NORTH}', '${ORG_A}', '${GROUP_NORTH}', '${PROPERTY_A}', '${REL_A}',
          '2025-01-01T00:00:00Z', null,
          '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'
        );
      `);

      const beforeMove = await snapshot();
      assert.deepEqual(beforeMove.properties[0]?.groups.map((group) => ({
        id: group.group_id,
        name: group.name,
        kind: group.kind,
      })), [{ id: GROUP_NORTH, name: 'North', kind: 'region' }]);
      assert.equal(
        prepareManagementPatternInputs(beforeMove).properties[0]?.profile?.regionId,
        GROUP_NORTH.replaceAll('-', '_'),
      );

      await pg.exec(`
        with before_row as (
          select to_jsonb(assignment) as state
          from public.portfolio_properties assignment
          where assignment.id = '${ASSIGNMENT_NORTH}'
        ), removed as (
          update public.portfolio_properties
          set removed_at = '2026-04-06T00:00:00Z',
              updated_at = '2026-04-06T00:00:00Z'
          where id = '${ASSIGNMENT_NORTH}'
          returning to_jsonb(portfolio_properties) as state
        )
        insert into public.organization_access_events (
          id, occurred_at, organization_id, event_type, target_type, target_id,
          before_state, after_state
        )
        select '82000000-0000-4000-8000-000000000001',
          '2026-04-06T00:00:00Z', '${ORG_A}', 'portfolio_properties.update',
          'portfolio_properties', '${ASSIGNMENT_NORTH}', before_row.state, removed.state
        from before_row cross join removed;

        insert into public.portfolio_properties (
          id, organization_id, portfolio_id, property_id, property_relationship_id,
          assigned_at, removed_at, created_at, updated_at
        ) values (
          '${ASSIGNMENT_SOUTH}', '${ORG_A}', '${GROUP_SOUTH}', '${PROPERTY_A}', '${REL_A}',
          '2026-04-06T00:00:00Z', null,
          '2026-04-06T00:00:00Z', '2026-04-06T00:00:00Z'
        );
        insert into public.organization_access_events (
          id, occurred_at, organization_id, event_type, target_type, target_id,
          before_state, after_state
        )
        select '82000000-0000-4000-8000-000000000002',
          '2026-04-06T00:00:00Z', '${ORG_A}', 'portfolio_properties.insert',
          'portfolio_properties', '${ASSIGNMENT_SOUTH}', null, to_jsonb(assignment)
        from public.portfolio_properties assignment
        where assignment.id = '${ASSIGNMENT_SOUTH}';

        with before_group as (
          select to_jsonb(portfolio) as state
          from public.portfolios portfolio where portfolio.id = '${GROUP_NORTH}'
        ), renamed as (
          update public.portfolios
          set name = 'Confidential successor label',
              portfolio_type = 'division',
              updated_at = '2026-04-07T00:00:00Z'
          where id = '${GROUP_NORTH}'
          returning to_jsonb(portfolios) as state
        )
        insert into public.organization_access_events (
          id, occurred_at, organization_id, event_type, target_type, target_id,
          before_state, after_state
        )
        select '82000000-0000-4000-8000-000000000003',
          '2026-04-07T00:00:00Z', '${ORG_A}', 'portfolios.update',
          'portfolios', '${GROUP_NORTH}', before_group.state, renamed.state
        from before_group cross join renamed;

        with deleted_assignment as (
          delete from public.portfolio_properties
          where id = '${ASSIGNMENT_NORTH}'
          returning to_jsonb(portfolio_properties) as state
        )
        insert into public.organization_access_events (
          id, occurred_at, organization_id, event_type, target_type, target_id,
          before_state, after_state
        )
        select '82000000-0000-4000-8000-000000000004',
          '2026-04-08T00:00:00Z', '${ORG_A}', 'portfolio_properties.delete',
          'portfolio_properties', '${ASSIGNMENT_NORTH}', deleted_assignment.state, null
        from deleted_assignment;

        with deleted_group as (
          delete from public.portfolios
          where id = '${GROUP_NORTH}'
          returning to_jsonb(portfolios) as state
        )
        insert into public.organization_access_events (
          id, occurred_at, organization_id, event_type, target_type, target_id,
          before_state, after_state
        )
        select '82000000-0000-4000-8000-000000000005',
          '2026-04-08T00:00:00Z', '${ORG_A}', 'portfolios.delete',
          'portfolios', '${GROUP_NORTH}', deleted_group.state, null
        from deleted_group;
      `);

      const frozen = await snapshotAt({
        evaluationAt: '2026-04-09T00:00:00Z',
        sourceAsOf: '2026-04-09T00:00:00Z',
        topologyAsOf: TOPOLOGY_AS_OF,
      });
      const frozenProperty = frozen.properties[0]!;
      assert.equal(frozenProperty.group_scope_historically_reconstructable, true);
      assert.deepEqual(frozenProperty.group_scope_exclusion_codes, []);
      assert.deepEqual(frozenProperty.groups.map((group) => ({
        groupId: group.group_id,
        groupName: group.name,
        kind: group.kind,
        assignmentId: group.assignment_id,
        assignmentProof: group.assignment_history_proof_kind,
        groupProof: group.group_history_proof_kind,
      })), [{
        groupId: GROUP_NORTH,
        groupName: 'North',
        kind: 'region',
        assignmentId: ASSIGNMENT_NORTH,
        assignmentProof: 'event_after_before_state',
        groupProof: 'event_after_before_state',
      }]);
      assert.equal(
        frozenProperty.groups.some((group) => (
          group.group_id === GROUP_SOUTH
          || group.name === 'Confidential successor label'
        )),
        false,
      );
      assert.equal(
        prepareManagementPatternInputs(frozen).properties[0]?.profile?.regionId,
        GROUP_NORTH.replaceAll('-', '_'),
      );

      const afterMove = await snapshotAt({
        evaluationAt: '2026-04-09T00:00:00Z',
        sourceAsOf: '2026-04-09T00:00:00Z',
        topologyAsOf: '2026-04-09T00:00:00Z',
      });
      assert.deepEqual(afterMove.properties[0]?.groups.map((group) => group.group_id), [
        GROUP_SOUTH,
      ]);
      assert.equal(
        prepareManagementPatternInputs(afterMove).properties[0]?.profile?.regionId,
        GROUP_SOUTH.replaceAll('-', '_'),
      );
    } finally {
      await pg.exec('rollback');
    }
  });

  test('fails group scope closed on a same-target causal tie, but trusts the later final row', async () => {
    await pg.exec('begin');
    try {
      await pg.exec(`
        insert into public.portfolios (
          id, organization_id, name, portfolio_type, parent_id, status, created_at, updated_at
        ) values (
          '${GROUP_NORTH}', '${ORG_A}', 'North', 'region', null, 'active',
          '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'
        );
        insert into public.portfolio_properties (
          id, organization_id, portfolio_id, property_id, property_relationship_id,
          assigned_at, removed_at, created_at, updated_at
        ) values (
          '${ASSIGNMENT_NORTH}', '${ORG_A}', '${GROUP_NORTH}', '${PROPERTY_A}', '${REL_A}',
          '2025-01-01T00:00:00Z', null,
          '2025-01-01T00:00:00Z', '2026-04-06T00:00:00Z'
        );
        with states as (
          select
            jsonb_set(
              to_jsonb(assignment),
              '{updated_at}',
              to_jsonb('2025-01-01T00:00:00Z'::timestamptz)
            ) as original_state,
            to_jsonb(assignment) as final_state
          from public.portfolio_properties assignment
          where assignment.id = '${ASSIGNMENT_NORTH}'
        )
        insert into public.organization_access_events (
          id, occurred_at, organization_id, event_type, target_type, target_id,
          before_state, after_state
        )
        select '82000000-0000-4000-8000-000000000011'::uuid,
          '2026-04-06T00:00:00Z'::timestamptz, '${ORG_A}'::uuid,
          'portfolio_properties.update',
          'portfolio_properties', '${ASSIGNMENT_NORTH}', original_state, final_state
        from states
        union all
        select '82000000-0000-4000-8000-000000000012'::uuid,
          '2026-04-06T00:00:00Z'::timestamptz, '${ORG_A}'::uuid,
          'portfolio_properties.update',
          'portfolio_properties', '${ASSIGNMENT_NORTH}', final_state, final_state
        from states;
      `);

      const historical = await snapshot();
      assert.equal(
        historical.properties[0]?.group_scope_historically_reconstructable,
        false,
      );
      assert.deepEqual(historical.properties[0]?.groups, []);
      assert.deepEqual(
        historical.properties[0]?.group_scope_exclusion_codes,
        ['group_history_unavailable'],
      );

      const afterTie = await snapshotAt({
        evaluationAt: '2026-04-07T00:00:00Z',
        sourceAsOf: '2026-04-07T00:00:00Z',
        topologyAsOf: '2026-04-07T00:00:00Z',
      });
      assert.equal(
        afterTie.properties[0]?.group_scope_historically_reconstructable,
        true,
      );
      assert.deepEqual(afterTie.properties[0]?.groups.map((group) => group.group_id), [
        GROUP_NORTH,
      ]);
    } finally {
      await pg.exec('rollback');
    }
  });

  test('fails group scope closed when an assignment is rekeyed across the topology boundary', async () => {
    await pg.exec('begin');
    try {
      await pg.exec(`
        insert into public.portfolios (
          id, organization_id, name, portfolio_type, parent_id, status, created_at, updated_at
        ) values (
          '${GROUP_NORTH}', '${ORG_A}', 'North', 'region', null, 'active',
          '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'
        );
        insert into public.portfolio_properties (
          id, organization_id, portfolio_id, property_id, property_relationship_id,
          assigned_at, removed_at, created_at, updated_at
        ) values (
          '${ASSIGNMENT_NORTH}', '${ORG_A}', '${GROUP_NORTH}', '${PROPERTY_A}', '${REL_A}',
          '2025-01-01T00:00:00Z', null,
          '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'
        );

        with before_row as (
          select to_jsonb(assignment) as state
          from public.portfolio_properties assignment
          where assignment.id = '${ASSIGNMENT_NORTH}'
        ), rekeyed as (
          update public.portfolio_properties
          set id = '${ASSIGNMENT_REKEYED}',
              updated_at = '2026-04-06T00:00:00Z'
          where id = '${ASSIGNMENT_NORTH}'
          returning to_jsonb(portfolio_properties) as state
        )
        insert into public.organization_access_events (
          id, occurred_at, organization_id, event_type, target_type, target_id,
          before_state, after_state
        )
        select '82000000-0000-4000-8000-000000000099',
          '2026-04-06T00:00:00Z', '${ORG_A}',
          'portfolio_properties.update', 'portfolio_properties',
          '${ASSIGNMENT_REKEYED}', before_row.state, rekeyed.state
        from before_row cross join rekeyed;
      `);

      const historical = await snapshotAt({
        evaluationAt: '2026-04-07T00:00:00Z',
        sourceAsOf: '2026-04-07T00:00:00Z',
        topologyAsOf: TOPOLOGY_AS_OF,
      });
      assert.equal(
        historical.properties[0]?.group_scope_historically_reconstructable,
        false,
      );
      assert.deepEqual(historical.properties[0]?.groups, []);
      assert.deepEqual(
        historical.properties[0]?.group_scope_exclusion_codes,
        ['group_history_unavailable'],
      );
    } finally {
      await pg.exec('rollback');
    }
  });

  test('distinguishes safe future assignments from disputed backdated group corrections', async () => {
    await pg.exec('begin');
    try {
      await pg.exec(`
        insert into public.portfolios (
          id, organization_id, name, portfolio_type, parent_id, status, created_at, updated_at
        ) values (
          '${GROUP_SOUTH}', '${ORG_A}', 'South', 'region', null, 'active',
          '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'
        );
        insert into public.portfolio_properties (
          id, organization_id, portfolio_id, property_id, property_relationship_id,
          assigned_at, removed_at, created_at, updated_at
        ) values (
          '${ASSIGNMENT_SOUTH}', '${ORG_A}', '${GROUP_SOUTH}', '${PROPERTY_A}', '${REL_A}',
          '2026-04-06T00:00:00Z', null,
          '2026-04-06T00:00:00Z', '2026-04-06T00:00:00Z'
        );
        insert into public.organization_access_events (
          id, occurred_at, organization_id, event_type, target_type, target_id,
          before_state, after_state
        )
        select '82000000-0000-4000-8000-000000000021',
          '2026-04-06T00:00:00Z', '${ORG_A}', 'portfolio_properties.insert',
          'portfolio_properties', '${ASSIGNMENT_SOUTH}', null, to_jsonb(assignment)
        from public.portfolio_properties assignment
        where assignment.id = '${ASSIGNMENT_SOUTH}';
      `);
      const safeAbsence = await snapshot();
      assert.equal(
        safeAbsence.properties[0]?.group_scope_historically_reconstructable,
        true,
      );
      assert.deepEqual(safeAbsence.properties[0]?.groups, []);

      await pg.exec(`
        update public.portfolio_properties
        set assigned_at = '2026-04-01T00:00:00Z'
        where id = '${ASSIGNMENT_SOUTH}';
        update public.organization_access_events
        set after_state = jsonb_set(
          after_state,
          '{assigned_at}',
          to_jsonb('2026-04-01T00:00:00Z'::timestamptz)
        )
        where id = '82000000-0000-4000-8000-000000000021';
      `);
      const disputed = await snapshot();
      assert.equal(
        disputed.properties[0]?.group_scope_historically_reconstructable,
        false,
      );
      assert.deepEqual(disputed.properties[0]?.groups, []);
      assert.deepEqual(
        disputed.properties[0]?.group_scope_exclusion_codes,
        ['group_history_unavailable'],
      );
    } finally {
      await pg.exec('rollback');
    }
  });

  test('fails closed when same-transaction audit timestamps cannot order two states', async () => {
    await pg.exec('begin');
    try {
      await pg.exec(`
        with original as (
          select to_jsonb(r) as state
          from public.organization_property_relationships r
          where r.id = '${REL_A}'
        ), states as (
          select
            state,
            jsonb_set(
              jsonb_set(state, '{relationship_type}', '"owner"'::jsonb),
              '{updated_at}', to_jsonb('2026-04-06T00:00:00Z'::timestamptz)
            ) as state_one
          from original
        ), chained as (
          select state, state_one,
            jsonb_set(
              state_one, '{ends_at}', to_jsonb('2026-04-30T00:00:00Z'::timestamptz)
            ) as state_two
          from states
        )
        insert into public.organization_access_events (
          id, occurred_at, organization_id, event_type, target_type, target_id,
          before_state, after_state
        )
        select '70000000-0000-4000-8000-0000000000ff'::uuid,
          '2026-04-06T00:00:00Z'::timestamptz, '${ORG_A}'::uuid,
          'organization_property_relationships.update',
          'organization_property_relationships', '${REL_A}', state, state_one
        from chained
        union all
        select '70000000-0000-4000-8000-000000000001'::uuid,
          '2026-04-06T00:00:00Z', '${ORG_A}',
          'organization_property_relationships.update',
          'organization_property_relationships', '${REL_A}', state_one, state_two
        from chained;

        update public.organization_property_relationships
        set relationship_type = 'owner',
            ends_at = '2026-04-30T00:00:00Z',
            updated_at = '2026-04-06T00:00:00Z'
        where id = '${REL_A}';
      `);

      await assert.rejects(
        () => snapshot(),
        /relationship.*history.*(ambiguous|order)|ambiguous.*relationship/i,
      );
    } finally {
      await pg.exec('rollback');
    }
  });

  test('marks a same-property historical cross-company overlap ambiguous', async () => {
    await pg.exec('begin');
    try {
      await pg.exec(`
        insert into public.organization_property_relationships values (
          '${REL_OVERLAP}', '${ORG_B}', '${PROPERTY_A}', 'owner', true,
          '2020-01-01T00:00:00Z', '2026-04-06T00:00:00Z',
          '2020-01-01T00:00:00Z', '2025-01-01T00:00:00Z'
        );
      `);

      const resultA = await snapshot(ORG_A);
      const propertyA = resultA.properties.find((property) => property.property_id === PROPERTY_A);
      assert.ok(propertyA);
      assert.equal(propertyA.relationship.organization_active_count, 1);
      assert.equal(propertyA.relationship.exclusive_governing_relationship, false);
      assert.ok(propertyA.run_exclusion_codes.includes('topology_ambiguous'));

      const resultB = await snapshot(ORG_B);
      const overlapping = resultB.properties.find((property) => property.property_id === PROPERTY_A);
      assert.ok(overlapping);
      assert.equal(overlapping.relationship.exclusive_governing_relationship, false);
      assert.ok(overlapping.run_exclusion_codes.includes('topology_ambiguous'));
    } finally {
      await pg.exec('rollback');
    }
  });

  test('rejects broadened version constants', async () => {
    await assert.rejects(
      pg.query(`select public.load_management_pattern_source_snapshot(
        $1, $2, $3, $4, '2026-01-01', '2026-03-31', 98, 51
      )`, [ORG_A, EVALUATION_AT, SOURCE_AS_OF, TOPOLOGY_AS_OF]),
      /fixed 50-property ceiling/i,
    );
    await assert.rejects(
      pg.query(`select public.load_management_pattern_source_snapshot(
        $1, $2, $3, $4, '2026-01-01', '2026-02-28', 98, 50
      )`, [ORG_A, EVALUATION_AT, SOURCE_AS_OF, TOPOLOGY_AS_OF]),
      /exactly three complete supply months/i,
    );
  });
});
