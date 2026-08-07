process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { MembershipHat } from '@/lib/company/access';
import type { ManagerCaller } from '@/lib/team-auth';
import {
  authorizedPortfolioUiContexts,
  loadPortfolioUiBootstrap,
  loadPortfolioUiSection,
  type PortfolioUiBulkRows,
  type PortfolioUiDataSource,
} from '@/lib/portfolio-ui/server';
import type { PortfolioUiSection } from '@/lib/portfolio-ui/contracts';

const ORG_A = '10000000-0000-4000-8000-000000000001';
const ORG_B = '10000000-0000-4000-8000-000000000002';
const ORG_X = '10000000-0000-4000-8000-000000000099';
const PID_A1 = '20000000-0000-4000-8000-000000000001';
const PID_A2 = '20000000-0000-4000-8000-000000000002';
const PID_B1 = '20000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-07-27T18:00:00.000Z');

function membership(
  organizationId: string,
  role: MembershipHat['role'],
  propertyIds: string[],
  scope: MembershipHat['scope'] = 'company',
): MembershipHat {
  return {
    membershipId: '30000000-0000-4000-8000-000000000001',
    organizationId,
    accountId: '40000000-0000-4000-8000-000000000001',
    scope,
    role,
    jobTitle: null,
    coveredPropertyIds: propertyIds,
  };
}

function caller(overrides: Partial<ManagerCaller> = {}): ManagerCaller {
  return {
    accountId: '40000000-0000-4000-8000-000000000001',
    role: 'general_manager',
    staffId: null,
    displayName: 'Portfolio Tester',
    propertyAccess: [],
    accessiblePropertyIds: [],
    reachesAllProperties: false,
    hats: [],
    ...overrides,
  };
}

interface FakeProperty {
  id: string;
  name: string;
  brand: string | null;
  region: string | null;
  total_rooms: number;
  timezone: string;
  enabled_sections: unknown;
  updated_at: string;
}

function fakeProperty(id: string, index: number): FakeProperty {
  return {
    id,
    name: `Hotel ${String(index).padStart(2, '0')}`,
    brand: index % 2 === 0 ? 'Staxis Suites' : null,
    region: index % 2 === 0 ? 'North' : 'South',
    total_rooms: 80 + index,
    timezone: 'America/Chicago',
    enabled_sections: null,
    updated_at: NOW.toISOString(),
  };
}

function sectionRow(
  source: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  return { ...row, __portfolio_source: source };
}

function dateRange(start: string, end: string): string[] {
  const values: string[] = [];
  for (
    let cursor = new Date(`${start}T00:00:00.000Z`);
    cursor.toISOString().slice(0, 10) <= end;
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    values.push(cursor.toISOString().slice(0, 10));
  }
  return values;
}

function financialDailyRows(
  propertyId: string,
  start: string,
  end: string,
  values: {
    revenue: number;
    roomsRevenue: number;
    occupied: number;
    available: number;
    grossOperatingProfit: number;
  },
  source = 'financial_daily',
  observedAt = NOW.toISOString(),
): Array<Record<string, unknown>> {
  return dateRange(start, end).map((businessDate, index) => sectionRow(source, {
    id: `a${businessDate.replaceAll('-', '')}${String(index).padStart(7, '0')}`,
    property_id: propertyId,
    business_date: businessDate,
    total_revenue_cents: values.revenue,
    rooms_revenue_cents: values.roomsRevenue,
    occupied_rooms: values.occupied,
    available_rooms: values.available,
    gross_operating_profit_cents: values.grossOperatingProfit,
    last_synced_at: observedAt,
  }));
}

class FakeSource implements PortfolioUiDataSource {
  properties = new Map<string, FakeProperty>();
  organizations = new Map<string, string>([[ORG_A, 'Company A'], [ORG_B, 'Company B']]);
  overrides: Array<{ property_id: string; role: string; allowed: boolean }> = [];
  chat: Array<{ organization_id: string; setting_value: string }> = [];
  runs: Array<Record<string, unknown>> = [];
  findings: Array<Record<string, unknown>> = [];
  sectionRows: Array<Record<string, unknown>> = [];
  propertyRowsOverride: FakeProperty[] | null = null;
  propertyTotalOverride: number | null | undefined;
  sectionRowsUnscoped = false;
  findingRunsComplete = true;
  findingsComplete = true;
  findingSaturatedPropertyIds = new Set<string>();
  findingUnavailablePropertyIds = new Set<string>();
  sectionComplete = true;
  fail = new Set<string>();
  calls: Record<string, number> = {};
  propertyRequests: Array<readonly string[] | null> = [];
  portfolioFindingRequests: Array<{
    organizationId: string;
    propertyIds: readonly string[];
    limitPerProperty: number;
  }> = [];
  sectionRequests: Array<{
    section: PortfolioUiSection;
    propertyIds: readonly string[];
    financialPropertyIds: readonly string[];
  }> = [];

  constructor(properties: FakeProperty[]) {
    for (const property of properties) this.properties.set(property.id, property);
  }

  private called(name: string) {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    if (this.fail.has(name)) throw new Error(`${name} failed`);
  }

  async readOrganizations(ids: readonly string[]) {
    this.called('organizations');
    return ids
      .filter((id) => this.organizations.has(id))
      .map((id) => ({ id, name: this.organizations.get(id) ?? null }));
  }

  async readProperties(ids: readonly string[] | null) {
    this.called('properties');
    this.propertyRequests.push(ids ? [...ids] : null);
    const requested = ids ?? [...this.properties.keys()];
    const rows = this.propertyRowsOverride ?? requested
      .map((id) => this.properties.get(id))
      .filter((row): row is FakeProperty => !!row);
    return {
      rows,
      total: this.propertyTotalOverride === undefined ? rows.length : this.propertyTotalOverride,
      complete: true,
    };
  }

  async readFinancialOverrides(ids: readonly string[]) {
    this.called('overrides');
    const allowed = new Set(ids);
    return this.overrides.filter((row) => allowed.has(row.property_id));
  }

  async readCompanyChatSettings(ids: readonly string[]) {
    this.called('chat');
    const allowed = new Set(ids);
    return this.chat.filter((row) => allowed.has(row.organization_id));
  }

  async readFindingRuns(ids: readonly string[]): Promise<PortfolioUiBulkRows<Record<string, unknown>>> {
    this.called('runs');
    const allowed = new Set(ids);
    const rows = this.runs.filter((row) => allowed.has(String(row.property_id)));
    return { rows, total: this.findingRunsComplete ? rows.length : rows.length + 1, complete: this.findingRunsComplete };
  }

  async readFindings(ids: readonly string[]): Promise<PortfolioUiBulkRows<Record<string, unknown>>> {
    this.called('findings');
    const allowed = new Set(ids);
    const rows = this.findings.filter((row) => allowed.has(String(row.property_id)));
    return { rows, total: this.findingsComplete ? rows.length : rows.length + 1, complete: this.findingsComplete };
  }

  async readPortfolioFindings(
    organizationId: string,
    ids: readonly string[],
    limitPerProperty: number,
  ): Promise<PortfolioUiBulkRows<Record<string, unknown>>> {
    this.called('findings');
    this.portfolioFindingRequests.push({
      organizationId,
      propertyIds: [...ids],
      limitPerProperty,
    });
    const unavailablePropertyIds = ids.filter((id) => this.findingUnavailablePropertyIds.has(id));
    const unavailable = new Set(unavailablePropertyIds);
    const saturatedPropertyIds = ids.filter((id) => (
      !unavailable.has(id)
      && (!this.findingsComplete
        || this.findingSaturatedPropertyIds.has(id)
        || this.findings.filter((row) => row.property_id === id).length >= limitPerProperty)
    ));
    const saturated = new Set(saturatedPropertyIds);
    const rows = ids.flatMap((id) => {
      if (unavailable.has(id)) return [];
      const bucket = this.findings.filter((row) => row.property_id === id);
      return bucket.slice(0, saturated.has(id) ? limitPerProperty - 1 : limitPerProperty);
    });
    const complete = saturatedPropertyIds.length === 0 && unavailablePropertyIds.length === 0;
    return {
      rows,
      total: complete ? rows.length : null,
      complete,
      saturatedPropertyIds,
      unavailablePropertyIds,
    };
  }

  async readSectionRows(
    section: PortfolioUiSection,
    ids: readonly string[],
    financialIds: readonly string[],
  ): Promise<PortfolioUiBulkRows<Record<string, unknown>>> {
    this.called('section');
    this.sectionRequests.push({
      section,
      propertyIds: [...ids],
      financialPropertyIds: [...financialIds],
    });
    const allowed = new Set(ids);
    const rows = this.sectionRowsUnscoped
      ? this.sectionRows
      : this.sectionRows.filter((row) => allowed.has(String(row.property_id)));
    return { rows, total: this.sectionComplete ? rows.length : rows.length + 1, complete: this.sectionComplete };
  }
}

describe('portfolio UI server access model', () => {
  test('lists every company context, never silently chooses across companies, and rejects tampering before reads', async () => {
    const account = caller({
      hats: [
        membership(ORG_A, 'regional_manager', [PID_A1, PID_A2]),
        membership(ORG_B, 'owner', [PID_B1]),
      ],
    });
    const source = new FakeSource([
      fakeProperty(PID_A1, 1),
      fakeProperty(PID_A2, 2),
      fakeProperty(PID_B1, 3),
    ]);

    const undecided = await loadPortfolioUiBootstrap({ account, source, now: NOW });
    assert.equal(undecided.ok, true);
    if (!undecided.ok) return;
    assert.equal(undecided.data.contexts.length, 2);
    assert.equal(undecided.data.selection.state, 'needs_selection');
    assert.equal(undecided.data.selectedCompany, null);
    assert.equal(undecided.data.entry.requiresCompanySelection, true);
    assert.deepEqual(undecided.data.hotels, [], 'companies must not be flattened before selection');
    assert.deepEqual(undecided.data.coverage, { total: 0, shown: 0, omitted: 0 });
    assert.deepEqual(source.propertyRequests[0], [], 'chooser bootstrap must not issue a merged hotel read');
    assert.deepEqual(undecided.data.contexts.map((context) => context.organizationId), [ORG_A, ORG_B]);
    assert.deepEqual(
      undecided.data.contexts.find((context) => context.organizationId === ORG_A)?.hotelIds,
      [PID_A1, PID_A2],
    );

    const narrowed = await loadPortfolioUiBootstrap({
      account,
      source,
      now: NOW,
      requestedOrganizationId: ORG_B,
    });
    assert.equal(narrowed.ok, true);
    if (narrowed.ok) {
      assert.equal(narrowed.data.selectedCompany?.organizationId, ORG_B);
      assert.deepEqual(narrowed.data.selectedCompany?.hotelIds, [PID_B1]);
      assert.equal(narrowed.data.contexts.length, 2, 'narrowing must not hide chooser options');
      assert.deepEqual(narrowed.data.hotels.map((hotel) => hotel.propertyId), [PID_B1]);
      assert.equal(
        narrowed.data.hotels[0].capabilities.canManageHotel,
        false,
        'a company owner has portfolio reach, not implicit GM write standing',
      );
      assert.deepEqual(narrowed.data.coverage, { total: 1, shown: 1, omitted: 0 });
      assert.deepEqual(source.propertyRequests.at(-1), [PID_B1]);
    }

    const cleanSource = new FakeSource([fakeProperty(PID_A1, 1)]);
    const tampered = await loadPortfolioUiBootstrap({
      account,
      source: cleanSource,
      now: NOW,
      requestedOrganizationId: ORG_X,
    });
    assert.deepEqual(tampered, {
      ok: false,
      status: 403,
      code: 'company_not_authorized',
      message: 'That company is not available to this account',
    });
    assert.equal(cleanSource.calls.properties ?? 0, 0, 'unowned org must be rejected before data reads');
  });

  test('preserves legacy GM hotel behavior without inventing a company context', async () => {
    const account = caller({
      role: 'general_manager',
      propertyAccess: [PID_A1],
      accessiblePropertyIds: [PID_A1],
      hats: [],
    });
    const source = new FakeSource([fakeProperty(PID_A1, 1)]);
    const result = await loadPortfolioUiBootstrap({ account, source, now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data.contexts, []);
    assert.equal(result.data.entry.mode, 'hotel');
    assert.equal(result.data.entry.legacyHotelCount, 1);
    assert.equal(result.data.hotels[0].roleAtHotel, 'general_manager');
    assert.equal(result.data.hotels[0].capabilities.canManageHotel, true);
    assert.equal(result.data.hotels[0].status, 'unknown');
    assert.equal(result.data.hotels[0].partial, true);
    assert.equal(result.data.partial, true);
    assert.equal(result.data.coverage.total, 1);
  });

  test('one company auto-selects only when no competing property-scope hat exists', async () => {
    const propertyScopeHotel = PID_B1;
    const account = caller({
      hats: [
        membership(ORG_A, 'regional_manager', [PID_A1, PID_A2]),
        membership(ORG_B, 'general_manager', [propertyScopeHotel], 'property'),
      ],
    });
    const source = new FakeSource([
      fakeProperty(PID_A1, 1),
      fakeProperty(PID_A2, 2),
      fakeProperty(propertyScopeHotel, 3),
    ]);

    const chooser = await loadPortfolioUiBootstrap({ account, source, now: NOW });
    assert.equal(chooser.ok, true);
    if (!chooser.ok) return;
    assert.equal(chooser.data.contexts.length, 1);
    assert.equal(chooser.data.selectedCompany, null);
    assert.equal(chooser.data.selection.state, 'needs_selection');
    assert.equal(chooser.data.entry.mode, 'company_picker');
    assert.equal(chooser.data.entry.legacyHotelCount, 1);
    assert.deepEqual(chooser.data.hotels.map((hotel) => hotel.propertyId), [propertyScopeHotel]);
    assert.deepEqual(source.propertyRequests[0], [propertyScopeHotel]);

    const narrowed = await loadPortfolioUiBootstrap({
      account,
      source,
      now: NOW,
      requestedOrganizationId: ORG_A,
    });
    assert.equal(narrowed.ok, true);
    if (narrowed.ok) {
      assert.equal(narrowed.data.selectedCompany?.organizationId, ORG_A);
      assert.deepEqual(
        narrowed.data.hotels.map((hotel) => hotel.propertyId).sort(),
        [PID_A1, PID_A2],
      );
      assert.equal(
        chooser.data.hotels[0].capabilities.canManageHotel,
        true,
        'a property-scope GM retains explicit hotel-management standing',
      );
      assert.equal(narrowed.data.hotels.some((hotel) => hotel.propertyId === propertyScopeHotel), false);
      assert.deepEqual(source.propertyRequests.at(-1), [PID_A1, PID_A2]);
    }
  });

  test('allows a company regional-manager hat while keeping sparse month-to-date ledgers partial and honors restrictions', async () => {
    const account = caller({
      role: 'front_desk',
      hats: [membership(ORG_A, 'regional_manager', [PID_A1, PID_A2])],
    });
    const source = new FakeSource([fakeProperty(PID_A1, 1), fakeProperty(PID_A2, 2)]);
    source.sectionRows = [
      {
        id: '50000000-0000-4000-8000-000000000001',
        property_id: PID_A1,
        date: '2026-07-27',
        total_revenue_cents: 125_000,
        occupied_rooms: 40,
        last_synced_at: NOW.toISOString(),
      },
      {
        id: '50000000-0000-4000-8000-000000000002',
        property_id: PID_A2,
        date: '2026-07-27',
        total_revenue_cents: 75_000,
        occupied_rooms: 25,
        last_synced_at: NOW.toISOString(),
      },
    ];

    const allowed = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'financials',
      source,
      now: NOW,
    });
    assert.equal(allowed.ok, true);
    if (allowed.ok) {
      assert.equal(allowed.data.capabilities.canViewFinancials, true);
      assert.equal(allowed.data.partial, true);
      assert.equal(allowed.data.hotels[0].freshness.reason, 'insufficient_date_coverage');
      assert.deepEqual(allowed.data.summary, {
        kind: 'financials',
        reportingHotels: null,
        monthToDateRevenueCents: null,
        occupiedRooms: null,
        comparisonHotels: null,
        priorPeriodRevenueCents: null,
        revenueChangePercent: null,
        occupancyPercent: null,
        adrCents: null,
        revparCents: null,
        grossOperatingProfitCents: null,
      });
    }

    source.overrides = [PID_A1, PID_A2].map((property_id) => ({
      property_id,
      role: 'front_desk',
      allowed: false,
    }));
    const denied = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'financials',
      source,
      now: NOW,
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.status, 403);
      assert.equal(denied.code, 'financials_forbidden');
    }

    source.fail.add('overrides');
    const unavailable = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'financials',
      source,
      now: NOW,
    });
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) {
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.code, 'access_unavailable');
    }
  });

  test('a revoked company hat closes the next section request before any section read', async () => {
    const active = caller({ hats: [membership(ORG_A, 'regional_manager', [PID_A1])] });
    const source = new FakeSource([fakeProperty(PID_A1, 1)]);
    const first = await loadPortfolioUiSection({
      account: active,
      organizationId: ORG_A,
      section: 'maintenance',
      source,
      now: NOW,
    });
    assert.equal(first.ok, true);

    const readsBefore = source.calls.properties ?? 0;
    const revoked = await loadPortfolioUiSection({
      account: caller({ hats: [] }),
      organizationId: ORG_A,
      section: 'maintenance',
      source,
      now: NOW,
    });
    assert.equal(revoked.ok, false);
    if (!revoked.ok) assert.equal(revoked.code, 'company_not_authorized');
    assert.equal(source.calls.properties ?? 0, readsBefore);
  });

  test('portfolio hotel-card finding counts honor source, financial, and provenance policy', async () => {
    const account = caller({ hats: [membership(ORG_A, 'regional_manager', [PID_A1, PID_A2, PID_B1])] });
    const source = new FakeSource([
      fakeProperty(PID_A1, 1),
      { ...fakeProperty(PID_A2, 2), enabled_sections: { maintenance: false } },
      fakeProperty(PID_B1, 3),
    ]);
    source.overrides = [{
      property_id: PID_A1,
      // A company hat projects least-privilege front-desk hotel standing with a
      // separate financial-read bit. The matching hotel role can restrict that
      // read but never elevate a different role.
      role: 'front_desk',
      allowed: false,
    }];
    source.runs = [PID_A1, PID_A2, PID_B1].map((property_id, index) => ({
      id: `51000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      property_id,
      run_at: NOW.toISOString(),
      run_date: '2026-07-27',
      detectors_checked: 4,
      detectors_skipped: 0,
      detectors_failed: 0,
    }));
    source.findings = [
      {
        id: '52000000-0000-4000-8000-000000000001',
        property_id: PID_A1,
        detector_id: 'cleaning_plan_health',
        summary: 'One cleaning assignment needs attention.',
        judged_summary_en: null,
        judged_summary_es: null,
        evidence: {},
        severity: 'attention',
        price_low_cents: null,
        price_high_cents: null,
        price_currency: 'USD',
        price_basis: null,
        updated_at: NOW.toISOString(),
      },
      {
        id: '52000000-0000-4000-8000-000000000002',
        property_id: PID_A1,
        detector_id: 'supply_spend_baseline',
        summary: 'Supply spend is outside its normal range.',
        judged_summary_en: null,
        judged_summary_es: null,
        evidence: {},
        severity: 'critical',
        price_low_cents: 200_000,
        price_high_cents: 300_000,
        price_currency: 'USD',
        price_basis: 'Recent invoices',
        updated_at: NOW.toISOString(),
      },
      {
        id: '52000000-0000-4000-8000-000000000003',
        property_id: PID_A2,
        detector_id: 'preventive_due',
        summary: 'Preventive maintenance is overdue.',
        judged_summary_en: null,
        judged_summary_es: null,
        evidence: {},
        severity: 'critical',
        price_low_cents: null,
        price_high_cents: null,
        price_currency: 'USD',
        price_basis: null,
        updated_at: NOW.toISOString(),
      },
      {
        id: '52000000-0000-4000-8000-000000000004',
        property_id: PID_B1,
        // Missing detector provenance must not become an aggregate side channel.
        summary: 'An unclassified source found something.',
        judged_summary_en: null,
        judged_summary_es: null,
        evidence: {},
        severity: 'critical',
        price_low_cents: null,
        price_high_cents: null,
        price_currency: 'USD',
        price_basis: null,
        updated_at: NOW.toISOString(),
      },
    ];

    const bootstrap = await loadPortfolioUiBootstrap({ account, source, now: NOW });
    assert.equal(bootstrap.ok, true);
    if (!bootstrap.ok) return;
    assert.deepEqual(source.portfolioFindingRequests, [{
      organizationId: ORG_A,
      propertyIds: [PID_A1, PID_A2, PID_B1],
      limitPerProperty: 51,
    }]);
    const hotels = new Map(bootstrap.data.hotels.map((hotel) => [hotel.propertyId, hotel]));
    const indicatorValue = (propertyId: string, key: string) => (
      hotels.get(propertyId)?.indicators.find((candidate) => candidate.key === key)
    );

    assert.equal(indicatorValue(PID_A1, 'open_findings')?.value, 1);
    assert.equal(indicatorValue(PID_A1, 'critical_findings')?.value, 0);
    assert.equal(hotels.get(PID_A1)?.status, 'attention');
    assert.equal(indicatorValue(PID_A2, 'open_findings')?.value, 0);
    assert.equal(indicatorValue(PID_A2, 'critical_findings')?.value, 0);
    assert.equal(hotels.get(PID_A2)?.status, 'neutral');
    assert.equal(indicatorValue(PID_B1, 'open_findings')?.value, null);
    assert.equal(indicatorValue(PID_B1, 'open_findings')?.lowerBound, false);
    assert.equal(hotels.get(PID_B1)?.status, 'unknown');
    assert.equal(hotels.get(PID_B1)?.partial, true);

    source.fail.add('overrides');
    const unavailable = await loadPortfolioUiBootstrap({ account, source, now: NOW });
    assert.equal(unavailable.ok, true);
    if (unavailable.ok) {
      const hotel = unavailable.data.hotels.find((candidate) => candidate.propertyId === PID_A1);
      assert.equal(hotel?.indicators.find((value) => value.key === 'open_findings')?.value, 1);
      assert.equal(hotel?.indicators.find((value) => value.key === 'open_findings')?.lowerBound, true);
      assert.equal(hotel?.attention, null);
      assert.equal(hotel?.status, 'unknown');
      assert.equal(hotel?.partial, true);
    }
  });

  test('keeps saturated policy windows and oversized evidence buckets unknown on Portfolio Home', async () => {
    const account = caller({ hats: [membership(ORG_A, 'owner', [PID_A1, PID_A2])] });
    const source = new FakeSource([
      { ...fakeProperty(PID_A1, 1), enabled_sections: { staxis: true, maintenance: false } },
      fakeProperty(PID_A2, 2),
    ]);
    source.runs = [PID_A1, PID_A2].map((property_id, index) => ({
      id: `53000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      property_id,
      run_at: NOW.toISOString(),
      run_date: '2026-07-27',
      detectors_checked: 2,
      detectors_skipped: 0,
      detectors_failed: 0,
    }));
    source.findings = [
      ...Array.from({ length: 51 }, (_, index) => ({
        id: `54000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        property_id: PID_A1,
        detector_id: 'preventive_due',
        summary: 'Hidden because maintenance is disabled.',
        evidence: { source: 'maintenance' },
        severity: 'warning',
        status: 'open',
        updated_at: NOW.toISOString(),
      })),
      {
        id: '55000000-0000-4000-8000-000000000001',
        property_id: PID_A2,
        detector_id: 'cleaning_plan_health',
        summary: 'Oversized bucket must not transfer.',
        evidence: { payload: `oversized-marker-${'x'.repeat(70_000)}` },
        severity: 'warning',
        status: 'open',
        updated_at: NOW.toISOString(),
      },
    ];
    source.findingUnavailablePropertyIds.add(PID_A2);

    const result = await loadPortfolioUiBootstrap({ account, source, now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const hotels = new Map(result.data.hotels.map((hotel) => [hotel.propertyId, hotel]));
    for (const propertyId of [PID_A1, PID_A2]) {
      const indicator = hotels.get(propertyId)?.indicators
        .find((candidate) => candidate.key === 'open_findings');
      assert.equal(indicator?.value, null, `${propertyId} cannot claim a quiet zero`);
      assert.equal(indicator?.lowerBound, false, `${propertyId} cannot render “At least 0”`);
      assert.equal(hotels.get(propertyId)?.attention, null);
      assert.equal(hotels.get(propertyId)?.status, 'unknown');
      assert.equal(hotels.get(propertyId)?.partial, true);
    }
    assert.equal(JSON.stringify(result.data).includes('oversized-marker'), false);
    assert.equal(source.calls.findings, 1, 'Portfolio Home uses one bounded findings adapter call');
    assert.deepEqual(source.portfolioFindingRequests, [{
      organizationId: ORG_A,
      propertyIds: [PID_A1, PID_A2],
      limitPerProperty: 51,
    }]);
  });

  test('supports more than fifty hotels with fixed query counts and reports missing or saturated data', async () => {
    const ids = Array.from({ length: 75 }, (_, index) => (
      `60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    ));
    const account = caller({ hats: [membership(ORG_A, 'regional_manager', ids)] });
    const source = new FakeSource(ids.map((id, index) => fakeProperty(id, index + 1)));
    source.chat = [{ organization_id: ORG_A, setting_value: 'true' }];

    const bootstrap = await loadPortfolioUiBootstrap({ account, source, now: NOW });
    assert.equal(bootstrap.ok, true);
    if (!bootstrap.ok) return;
    assert.deepEqual(bootstrap.data.coverage, { total: 75, shown: 75, omitted: 0 });
    assert.equal(bootstrap.data.contexts[0].hotelCount, 75);
    assert.equal(bootstrap.data.contexts[0].capabilities.canAskStaxis, true);
    assert.equal(bootstrap.data.contexts[0].chat.state, 'available');
    assert.equal(source.calls.properties, 1);
    assert.equal(source.calls.runs, 1);
    assert.equal(source.calls.findings, 1);
    assert.equal(source.calls.overrides, 1);
    assert.equal(source.calls.chat, 1);

    source.sectionRows = ids.map((property_id, index) => ({
      id: `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      property_id,
      status: 'submitted',
      severity: index === 0 ? 'urgent' : 'medium',
      updated_at: NOW.toISOString(),
    }));
    source.sectionComplete = false;
    const section = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'maintenance',
      source,
      now: NOW,
    });
    assert.equal(section.ok, true);
    if (section.ok) {
      assert.equal(section.data.partial, true);
      assert.equal(section.data.summary.kind, 'maintenance');
      if (section.data.summary.kind === 'maintenance') {
        assert.equal(section.data.summary.openWorkOrders, null);
      }
      assert.equal(section.data.hotels.length, 75);
      assert.equal(section.data.hotels[0].freshness.state, 'partial');
      assert.equal(section.data.hotels[0].indicators[0].lowerBound, true);
    }
    assert.equal(source.calls.section, 1, 'section aggregation must remain one bulk read');

    source.properties.delete(ids[74]);
    const missing = await loadPortfolioUiBootstrap({ account, source, now: NOW });
    assert.equal(missing.ok, true);
    if (missing.ok) {
      assert.deepEqual(missing.data.coverage, { total: 75, shown: 74, omitted: 1 });
      assert.deepEqual(missing.data.missingPropertyIds, [ids[74]]);
      assert.equal(missing.data.partial, true);
    }
  });

  test('degrades optional feeds to partial and never serializes communication or employee bodies', async () => {
    const account = caller({ hats: [membership(ORG_A, 'owner', [PID_A1])] });
    const source = new FakeSource([fakeProperty(PID_A1, 1)]);
    source.fail.add('findings');
    const bootstrap = await loadPortfolioUiBootstrap({ account, source, now: NOW });
    assert.equal(bootstrap.ok, true);
    if (bootstrap.ok) {
      assert.equal(bootstrap.data.partial, true);
      assert.equal(bootstrap.data.hotels[0].attention, null);
      assert.equal(bootstrap.data.hotels[0].status, 'unknown');
      assert.equal(bootstrap.data.hotels[0].indicators[0].value, null);
    }

    source.fail.delete('findings');
    source.sectionRows = [{
      id: '80000000-0000-4000-8000-000000000001',
      property_id: PID_A1,
      status: 'open',
      severity: 'high',
      updated_at: NOW.toISOString(),
      guest_name: 'Must Not Escape',
      guest_contact: 'secret@example.test',
      body: 'private message body',
      staff_id: '90000000-0000-4000-8000-000000000001',
    }];
    const communications = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'communications',
      source,
      now: NOW,
    });
    assert.equal(communications.ok, true);
    if (communications.ok) {
      const wire = JSON.stringify(communications.data);
      assert.equal(wire.includes('Must Not Escape'), false);
      assert.equal(wire.includes('secret@example.test'), false);
      assert.equal(wire.includes('private message body'), false);
      assert.equal(wire.includes('90000000-0000-4000-8000-000000000001'), false);
      assert.deepEqual(communications.data.summary, {
        kind: 'communications',
        reportingHotels: 1,
        openItems: 1,
        highSeverityItems: 1,
        announcements: null,
        companyAnnouncements: null,
        acknowledgementResponses: null,
        pendingAcknowledgements: null,
        acknowledgementPercent: null,
      });
      assert.deepEqual(
        communications.data.hotels[0].drilldownIds,
        ['80000000-0000-4000-8000-000000000001'],
      );
      assert.equal(communications.data.hotels[0].city, null);
      assert.equal(communications.data.hotels[0].region, 'South');
      assert.equal(communications.data.hotels[0].brand, null);
    }
  });

  test('fails closed on duplicate, malformed, and cross-company adapter property rows', async () => {
    const account = caller({ hats: [membership(ORG_A, 'regional_manager', [PID_A1])] });

    const crossed = new FakeSource([fakeProperty(PID_A1, 1), fakeProperty(PID_B1, 2)]);
    crossed.propertyRowsOverride = [fakeProperty(PID_B1, 2)];
    const crossedBootstrap = await loadPortfolioUiBootstrap({ account, source: crossed, now: NOW });
    assert.deepEqual(crossedBootstrap, {
      ok: false,
      status: 503,
      code: 'data_unavailable',
      message: 'Portfolio properties are temporarily unavailable',
    });
    assert.equal(crossed.calls.runs ?? 0, 0);
    assert.equal(crossed.calls.findings ?? 0, 0);

    const duplicate = new FakeSource([fakeProperty(PID_A1, 1)]);
    duplicate.propertyRowsOverride = [fakeProperty(PID_A1, 1), fakeProperty(PID_A1, 1)];
    const duplicateSection = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'maintenance',
      source: duplicate,
      now: NOW,
    });
    assert.deepEqual(duplicateSection, {
      ok: false,
      status: 503,
      code: 'data_unavailable',
      message: 'Portfolio properties are temporarily unavailable',
    });
    assert.equal(duplicate.calls.section ?? 0, 0);

    const malformed = new FakeSource([fakeProperty(PID_A1, 1)]);
    malformed.propertyRowsOverride = [{ ...fakeProperty(PID_A1, 1), id: 'not-a-property-id' }];
    const malformedSection = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'inventory',
      source: malformed,
      now: NOW,
    });
    assert.equal(malformedSection.ok, false);
    if (!malformedSection.ok) assert.equal(malformedSection.code, 'data_unavailable');
    assert.equal(malformed.calls.section ?? 0, 0);

    const falseComplete = new FakeSource([
      fakeProperty(PID_A1, 1),
      fakeProperty(PID_A2, 2),
    ]);
    falseComplete.propertyRowsOverride = [fakeProperty(PID_A1, 1)];
    falseComplete.propertyTotalOverride = 2;
    const falseCompleteResult = await loadPortfolioUiSection({
      account: caller({ hats: [membership(ORG_A, 'regional_manager', [PID_A1, PID_A2])] }),
      organizationId: ORG_A,
      section: 'maintenance',
      source: falseComplete,
      now: NOW,
    });
    assert.equal(falseCompleteResult.ok, false, 'complete cannot omit a counted row');
    if (!falseCompleteResult.ok) assert.equal(falseCompleteResult.code, 'data_unavailable');
  });

  test('contains a cross-company section adapter row without serializing or aggregating it', async () => {
    const account = caller({ hats: [membership(ORG_A, 'regional_manager', [PID_A1])] });
    const source = new FakeSource([fakeProperty(PID_A1, 1)]);
    source.sectionRowsUnscoped = true;
    source.sectionRows = [sectionRow('maintenance_open', {
      id: '81000000-0000-4000-8000-000000000001',
      property_id: PID_B1,
      status: 'submitted',
      severity: 'URGENT',
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    })];

    const result = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'maintenance',
      source,
      now: NOW,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.partial, true);
    assert.equal(result.data.hotels[0].freshness.state, 'unavailable');
    assert.equal(result.data.summary.kind, 'maintenance');
    assert.equal(result.data.summary.reportingHotels, null);
    assert.equal(JSON.stringify(result.data).includes(PID_B1), false);
    assert.equal(JSON.stringify(result.data).includes('81000000-0000-4000-8000-000000000001'), false);
  });

  test('rejects tagged malformed drilldown ids and contains malformed legacy adapter ids', async () => {
    const account = caller({ hats: [membership(ORG_A, 'regional_manager', [PID_A1])] });
    const tagged = new FakeSource([fakeProperty(PID_A1, 1)]);
    tagged.sectionRows = [sectionRow('maintenance_open', {
      id: 'private adapter text',
      property_id: PID_A1,
      severity: 'urgent',
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      __portfolio_drilldown: true,
    })];
    const rejected = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'maintenance',
      source: tagged,
      now: NOW,
    });
    assert.equal(rejected.ok, true);
    if (!rejected.ok) return;
    assert.equal(rejected.data.partial, true);
    assert.equal(rejected.data.hotels[0].freshness.state, 'unavailable');
    assert.equal(JSON.stringify(rejected.data).includes('private adapter text'), false);

    const legacy = new FakeSource([fakeProperty(PID_A1, 1)]);
    legacy.sectionRows = [{
      id: 'legacy private adapter text',
      property_id: PID_A1,
      severity: 'urgent',
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    }];
    const contained = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'maintenance',
      source: legacy,
      now: NOW,
    });
    assert.equal(contained.ok, true);
    if (!contained.ok) return;
    assert.equal(contained.data.hotels[0].partial, true);
    assert.deepEqual(contained.data.hotels[0].drilldownIds, []);
    assert.equal(JSON.stringify(contained.data).includes('legacy private adapter text'), false);
  });

  test('publishes financial comparisons only after exact current and prior daily coverage', async () => {
    const account = caller({
      role: 'front_desk',
      hats: [membership(ORG_A, 'regional_manager', [PID_A1])],
    });
    const source = new FakeSource([fakeProperty(PID_A1, 1)]);
    source.sectionRows = [
      ...financialDailyRows(PID_A1, '2026-07-01', '2026-07-27', {
        revenue: 10_000,
        roomsRevenue: 8_000,
        occupied: 10,
        available: 20,
        grossOperatingProfit: 2_000,
      }),
      ...financialDailyRows(PID_A1, '2026-06-01', '2026-06-27', {
        revenue: 5_000,
        roomsRevenue: 4_000,
        occupied: 8,
        available: 20,
        grossOperatingProfit: 1_000,
      }),
    ];

    const result = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'financials',
      source,
      now: NOW,
    });
    assert.equal(result.ok, true);
    if (!result.ok || result.data.summary.kind !== 'financials') return;
    assert.equal(result.data.partial, false);
    assert.deepEqual(result.data.summary, {
      kind: 'financials',
      reportingHotels: 1,
      monthToDateRevenueCents: 270_000,
      occupiedRooms: 270,
      comparisonHotels: 1,
      priorPeriodRevenueCents: 135_000,
      revenueChangePercent: 100,
      occupancyPercent: 50,
      adrCents: 800,
      revparCents: 400,
      grossOperatingProfitCents: 54_000,
    });

    source.sectionRows = source.sectionRows.map((row, index) => (
      index === 0 ? { ...row, gross_operating_profit_cents: null } : row
    ));
    const missingValue = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'financials',
      source,
      now: NOW,
    });
    assert.equal(missingValue.ok, true);
    if (!missingValue.ok || missingValue.data.summary.kind !== 'financials') return;
    assert.equal(missingValue.data.partial, true);
    assert.equal(missingValue.data.hotels[0].freshness.state, 'partial');
    assert.equal(missingValue.data.hotels[0].freshness.reason, 'invalid_source_values');
    assert.equal(missingValue.data.summary.grossOperatingProfitCents, null);
  });

  test('keeps a western hotel comparable during the first UTC hours of a month', async () => {
    const boundaryNow = new Date('2026-08-01T03:00:00.000Z');
    const account = caller({ hats: [membership(ORG_A, 'owner', [PID_A1])] });
    const source = new FakeSource([fakeProperty(PID_A1, 1)]);
    source.sectionRows = [
      ...financialDailyRows(PID_A1, '2026-07-01', '2026-07-31', {
        revenue: 10_000,
        roomsRevenue: 8_000,
        occupied: 10,
        available: 20,
        grossOperatingProfit: 2_000,
      }, 'financial_daily', boundaryNow.toISOString()),
      ...financialDailyRows(PID_A1, '2026-06-01', '2026-06-30', {
        revenue: 5_000,
        roomsRevenue: 4_000,
        occupied: 8,
        available: 20,
        grossOperatingProfit: 1_000,
      }, 'financial_daily', boundaryNow.toISOString()),
    ];

    const result = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'financials',
      source,
      now: boundaryNow,
    });
    assert.equal(result.ok, true);
    if (!result.ok || result.data.summary.kind !== 'financials') return;
    assert.equal(result.data.partial, false);
    assert.equal(result.data.summary.monthToDateRevenueCents, 310_000);
    assert.equal(result.data.summary.priorPeriodRevenueCents, 150_000);
    assert.equal(result.data.summary.revenueChangePercent, 100);
  });

  test('requires exact 7-day and month-to-date coverage for dashboard comparisons', async () => {
    const account = caller({ hats: [membership(ORG_A, 'owner', [PID_A1])] });
    const source = new FakeSource([fakeProperty(PID_A1, 1)]);
    source.sectionRows = [
      sectionRow('dashboard_occupancy', {
        id: '82000000-0000-4000-8000-000000000001',
        property_id: PID_A1,
        business_date: '2026-07-27',
        occupied_rooms: 10,
        available_rooms: 20,
        last_synced_at: NOW.toISOString(),
      }),
      sectionRow('dashboard_financial', {
        id: '82000000-0000-4000-8000-000000000002',
        property_id: PID_A1,
        business_date: '2026-07-27',
        total_revenue_cents: 10_000,
        last_synced_at: NOW.toISOString(),
      }),
    ];

    const sparse = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'dashboard',
      source,
      now: NOW,
    });
    assert.equal(sparse.ok, true);
    if (!sparse.ok || sparse.data.summary.kind !== 'dashboard') return;
    assert.equal(sparse.data.partial, true);
    assert.equal(sparse.data.hotels[0].freshness.reason, 'insufficient_date_coverage');
    assert.equal(sparse.data.summary.reportingHotels, 1);
    assert.equal(sparse.data.summary.recentOccupancyPercent, null);
    assert.equal(sparse.data.summary.occupancyComparisonHotels, null);
    assert.equal(sparse.data.summary.monthToDateRevenueCents, null);
    assert.equal(sparse.data.summary.financialComparisonHotels, null);

    source.sectionRows = [
      ...dateRange('2026-07-14', '2026-07-27').map((businessDate, index) => (
        sectionRow('dashboard_occupancy', {
          id: `83000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          property_id: PID_A1,
          business_date: businessDate,
          occupied_rooms: 10,
          available_rooms: 20,
          last_synced_at: NOW.toISOString(),
        })
      )),
      ...financialDailyRows(PID_A1, '2026-07-01', '2026-07-27', {
        revenue: 10_000,
        roomsRevenue: 0,
        occupied: 0,
        available: 0,
        grossOperatingProfit: 0,
      }, 'dashboard_financial'),
      ...financialDailyRows(PID_A1, '2026-06-01', '2026-06-27', {
        revenue: 5_000,
        roomsRevenue: 0,
        occupied: 0,
        available: 0,
        grossOperatingProfit: 0,
      }, 'dashboard_financial'),
    ];
    const complete = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'dashboard',
      source,
      now: NOW,
    });
    assert.equal(complete.ok, true);
    if (!complete.ok || complete.data.summary.kind !== 'dashboard') return;
    assert.equal(complete.data.partial, false);
    assert.equal(complete.data.summary.recentOccupancyPercent, 50);
    assert.equal(complete.data.summary.priorOccupancyPercent, 50);
    assert.equal(complete.data.summary.occupancyChangePoints, 0);
    assert.equal(complete.data.summary.occupancyComparisonHotels, 1);
    assert.equal(complete.data.summary.monthToDateRevenueCents, 270_000);
    assert.equal(complete.data.summary.priorPeriodRevenueCents, 135_000);
    assert.equal(complete.data.summary.revenueChangePercent, 100);
  });

  test('excludes employees hired after an announcement from its acknowledgement denominator', async () => {
    const account = caller({ hats: [membership(ORG_A, 'owner', [PID_A1])] });
    const source = new FakeSource([fakeProperty(PID_A1, 1)]);
    const senderId = '84000000-0000-4000-8000-000000000001';
    const recipientId = '84000000-0000-4000-8000-000000000002';
    const laterHireId = '84000000-0000-4000-8000-000000000003';
    const messageId = '85000000-0000-4000-8000-000000000001';
    source.sectionRows = [
      sectionRow('communications_announcement', {
        id: messageId,
        property_id: PID_A1,
        created_at: '2026-07-20T15:00:00.000Z',
        requires_ack: true,
        ack_campaign_id: '86000000-0000-4000-8000-000000000001',
        sender_staff_id: senderId,
      }),
      ...[
        [senderId, '2026-07-01T12:00:00.000Z'],
        [recipientId, '2026-07-01T12:00:00.000Z'],
        [laterHireId, '2026-07-25T12:00:00.000Z'],
      ].map(([id, createdAt]) => sectionRow('communications_roster', {
        id,
        property_id: PID_A1,
        created_at: createdAt,
        updated_at: NOW.toISOString(),
      })),
      sectionRow('communications_acknowledgement', {
        property_id: PID_A1,
        message_id: messageId,
        staff_id: recipientId,
        acknowledged_at: '2026-07-21T10:00:00.000Z',
      }),
    ];

    const result = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'communications',
      source,
      now: NOW,
    });
    assert.equal(result.ok, true);
    if (!result.ok || result.data.summary.kind !== 'communications') return;
    assert.equal(result.data.summary.reportingHotels, 1);
    assert.equal(result.data.summary.acknowledgementResponses, 1);
    assert.equal(result.data.summary.pendingAcknowledgements, 0);
    assert.equal(result.data.summary.acknowledgementPercent, 100);
    const wire = JSON.stringify(result.data);
    assert.equal(wire.includes(senderId), false);
    assert.equal(wire.includes(recipientId), false);
    assert.equal(wire.includes(laterHireId), false);
  });

  test('does not treat a roster or an orphan acknowledgement as communications reporting', async () => {
    const account = caller({ hats: [membership(ORG_A, 'owner', [PID_A1])] });
    const source = new FakeSource([fakeProperty(PID_A1, 1)]);
    source.sectionRows = [
      sectionRow('communications_roster', {
        id: '86100000-0000-4000-8000-000000000001',
        property_id: PID_A1,
        created_at: '2026-07-01T12:00:00.000Z',
        updated_at: NOW.toISOString(),
      }),
      sectionRow('communications_acknowledgement', {
        property_id: PID_A1,
        message_id: '86200000-0000-4000-8000-000000000001',
        staff_id: '86100000-0000-4000-8000-000000000001',
        acknowledged_at: NOW.toISOString(),
      }),
    ];

    const result = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'communications',
      source,
      now: NOW,
    });
    assert.equal(result.ok, true);
    if (!result.ok || result.data.summary.kind !== 'communications') return;
    assert.equal(result.data.summary.reportingHotels, null);
    assert.equal(result.data.hotels[0].freshness.state, 'missing');
    assert.equal(result.data.hotels[0].freshness.reason, 'no_source_record');
    assert.equal(result.data.hotels[0].indicators.every((value) => value.value == null), true);
  });

  test('keeps housekeeping and maintenance liveness source-specific', async () => {
    const account = caller({ hats: [membership(ORG_A, 'owner', [PID_A1])] });
    const source = new FakeSource([fakeProperty(PID_A1, 1)]);
    source.sectionRows = [sectionRow('housekeeping_shift', {
      id: '86300000-0000-4000-8000-000000000001',
      property_id: PID_A1,
      shift_date: '2026-07-27',
      kind: 'open',
      updated_at: NOW.toISOString(),
    })];
    const housekeeping = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'housekeeping',
      source,
      now: NOW,
    });
    assert.equal(housekeeping.ok, true);
    if (!housekeeping.ok || housekeeping.data.summary.kind !== 'housekeeping') return;
    assert.equal(housekeeping.data.summary.reportingHotels, null);
    assert.equal(housekeeping.data.summary.openTasks, null);
    assert.equal(housekeeping.data.summary.staffingReportingHotels, 1);
    assert.equal(housekeeping.data.summary.openStaffingSlots, 1);
    assert.equal(
      housekeeping.data.hotels[0].indicators.find((value) => value.key === 'open_tasks')?.value,
      null,
    );

    source.sectionRows = [sectionRow('maintenance_history', {
      id: '86400000-0000-4000-8000-000000000001',
      property_id: PID_A1,
      equipment_id: '86500000-0000-4000-8000-000000000001',
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    })];
    const maintenance = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'maintenance',
      source,
      now: NOW,
    });
    assert.equal(maintenance.ok, true);
    if (!maintenance.ok || maintenance.data.summary.kind !== 'maintenance') return;
    assert.equal(maintenance.data.summary.reportingHotels, 1);
    assert.equal(maintenance.data.summary.openWorkOrders, null);
    assert.equal(maintenance.data.summary.urgentWorkOrders, null);
    assert.equal(maintenance.data.summary.highPriorityWorkOrders, null);
    assert.equal(maintenance.data.summary.agingWorkOrders, null);
    for (const key of [
      'open_work_orders',
      'urgent_work_orders',
      'high_priority_work_orders',
      'aging_work_orders',
    ]) {
      assert.equal(
        maintenance.data.hotels[0].indicators.find((value) => value.key === key)?.value,
        null,
        key,
      );
    }
  });

  test('uses shared maintenance severity and inventory 70/30 status boundaries', async () => {
    const account = caller({ hats: [membership(ORG_A, 'owner', [PID_A1])] });
    const source = new FakeSource([fakeProperty(PID_A1, 1)]);
    source.sectionRows = [
      sectionRow('maintenance_open', {
        id: '87000000-0000-4000-8000-000000000001',
        property_id: PID_A1,
        severity: 'URGENT',
        created_at: '2026-07-27T12:00:00.000Z',
        updated_at: NOW.toISOString(),
      }),
      sectionRow('maintenance_open', {
        id: '87000000-0000-4000-8000-000000000002',
        property_id: PID_A1,
        severity: 'MAJOR',
        created_at: '2026-07-27T12:00:00.000Z',
        updated_at: NOW.toISOString(),
      }),
    ];
    const maintenance = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'maintenance',
      source,
      now: NOW,
    });
    assert.equal(maintenance.ok, true);
    if (!maintenance.ok || maintenance.data.summary.kind !== 'maintenance') return;
    assert.equal(maintenance.data.summary.openWorkOrders, 2);
    assert.equal(maintenance.data.summary.urgentWorkOrders, 1);
    assert.equal(maintenance.data.summary.highPriorityWorkOrders, 1);
    assert.equal(
      maintenance.data.hotels[0].indicators
        .find((indicator) => indicator.key === 'high_priority_work_orders')?.value,
      1,
    );

    source.sectionRows = [70, 30, 29].map((currentStock, index) => (
      sectionRow('inventory_item', {
        id: `88000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        property_id: PID_A1,
        current_stock: currentStock,
        par_level: 100,
        last_counted_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      })
    ));
    const inventory = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'inventory',
      source,
      now: NOW,
    });
    assert.equal(inventory.ok, true);
    if (!inventory.ok || inventory.data.summary.kind !== 'inventory') return;
    assert.equal(inventory.data.summary.trackedItems, 3);
    assert.equal(inventory.data.summary.lowStockItems, 2);
  });

  test('renders complete empty ledgers as missing, partial, and unknown rather than reassuring zeroes', async () => {
    const account = caller({ hats: [membership(ORG_A, 'owner', [PID_A1])] });
    const sections: PortfolioUiSection[] = [
      'dashboard',
      'housekeeping',
      'communications',
      'maintenance',
      'inventory',
      'staff',
      'financials',
    ];

    for (const section of sections) {
      const source = new FakeSource([fakeProperty(PID_A1, 1)]);
      const result = await loadPortfolioUiSection({
        account,
        organizationId: ORG_A,
        section,
        source,
        now: NOW,
      });
      assert.equal(result.ok, true, `${section} should keep a truthful empty state`);
      if (!result.ok) continue;
      assert.equal(result.data.partial, true, `${section} should mark its absent ledger partial`);
      assert.equal(result.data.summary.reportingHotels, null, `${section} has no reporting hotel`);
      assert.equal(result.data.hotels[0].freshness.state, 'missing', `${section} freshness`);
      assert.equal(result.data.hotels[0].freshness.reason, 'no_source_record', `${section} reason`);
      assert.equal(result.data.hotels[0].partial, true, `${section} hotel truth state`);
      assert.equal(
        result.data.hotels[0].indicators.every((indicator) => indicator.value === null),
        true,
        `${section} cannot emit a zero indicator without evidence`,
      );
    }
  });

  test('strongest same-company hat wins without merging another company', () => {
    const contexts = authorizedPortfolioUiContexts(caller({
      hats: [
        membership(ORG_A, 'regional_manager', [PID_A1]),
        membership(ORG_A, 'owner', [PID_A2]),
        membership(ORG_B, 'regional_manager', [PID_B1]),
      ],
    }));
    assert.deepEqual(contexts.map((context) => ({
      organizationId: context.organizationId,
      companyRole: context.companyRole,
      hotelIds: context.hotelIds,
    })), [
      { organizationId: ORG_A, companyRole: 'owner', hotelIds: [PID_A1, PID_A2] },
      { organizationId: ORG_B, companyRole: 'regional_manager', hotelIds: [PID_B1] },
    ]);
    assert.equal(contexts.every((context) => context.queueAvailable), true);
    assert.equal(
      contexts.every((context) => context.propertyStandings.every(
        (standing) => standing.canManageHotel === false,
      )),
      true,
    );
  });
});
