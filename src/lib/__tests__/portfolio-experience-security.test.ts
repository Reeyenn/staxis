process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import type { MembershipHat } from '@/lib/company/access';
import type { ManagerCaller } from '@/lib/team-auth';
import {
  loadPortfolioUiBootstrap,
  loadPortfolioUiSection,
  type PortfolioUiBulkRows,
  type PortfolioUiDataSource,
} from '@/lib/portfolio-ui/server';
import type { PortfolioUiSection } from '@/lib/portfolio-ui/contracts';
import { normalizeSameOriginAppPath } from '@/lib/portfolio-ui/context';

const ORG_A = '10000000-0000-4000-8000-000000000001';
const ORG_B = '10000000-0000-4000-8000-000000000002';
const ORG_X = '10000000-0000-4000-8000-000000000099';
const PID_A1 = '20000000-0000-4000-8000-000000000001';
const PID_A2 = '20000000-0000-4000-8000-000000000002';
const PID_B1 = '20000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-07-27T18:00:00.000Z');

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

function hat(
  organizationId: string,
  role: MembershipHat['role'],
  propertyIds: string[],
): MembershipHat {
  return {
    membershipId: `30000000-0000-4000-8000-${organizationId.slice(-12)}`,
    organizationId,
    accountId: '40000000-0000-4000-8000-000000000001',
    scope: 'company',
    role,
    jobTitle: null,
    coveredPropertyIds: propertyIds,
  };
}

function caller(overrides: Partial<ManagerCaller> = {}): ManagerCaller {
  return {
    accountId: '40000000-0000-4000-8000-000000000001',
    role: 'front_desk',
    staffId: null,
    displayName: 'Security Reviewer',
    propertyAccess: [],
    accessiblePropertyIds: [],
    reachesAllProperties: false,
    hats: [],
    ...overrides,
  };
}

interface PropertyRow {
  id: string;
  name: string;
  brand: string | null;
  region: string | null;
  total_rooms: number;
  timezone: string;
  enabled_sections: unknown;
  updated_at: string;
}

function property(id: string, name: string): PropertyRow {
  return {
    id,
    name,
    brand: null,
    region: 'Test',
    total_rooms: 100,
    timezone: 'America/Chicago',
    enabled_sections: null,
    updated_at: NOW.toISOString(),
  };
}

function dates(start: string, end: string): string[] {
  const out: string[] = [];
  for (
    let cursor = new Date(`${start}T00:00:00.000Z`);
    cursor.toISOString().slice(0, 10) <= end;
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    out.push(cursor.toISOString().slice(0, 10));
  }
  return out;
}

class AuditSource implements PortfolioUiDataSource {
  readonly rows = new Map<string, PropertyRow>();
  readonly propertyRequests: Array<readonly string[] | null> = [];
  readonly findingRunRequests: Array<readonly string[]> = [];
  readonly findingRequests: Array<readonly string[]> = [];
  readonly portfolioFindingRequests: Array<{
    organizationId: string;
    ids: readonly string[];
    limitPerProperty: number;
  }> = [];
  readonly sectionRequests: Array<{ section: PortfolioUiSection; ids: readonly string[] }> = [];
  readonly fail = new Set<string>();
  overrides: Array<{ property_id: string; role: string; allowed: boolean }> = [];
  findingRows: Array<Record<string, unknown>> = [];
  sectionRows: Array<Record<string, unknown>> = [];

  constructor(rows: PropertyRow[]) {
    for (const row of rows) this.rows.set(row.id, row);
  }

  async readOrganizations(ids: readonly string[]) {
    return ids.map((id) => ({ id, name: id === ORG_A ? 'Company A' : 'Company B' }));
  }

  async readProperties(ids: readonly string[] | null): Promise<PortfolioUiBulkRows<PropertyRow>> {
    this.propertyRequests.push(ids === null ? null : [...ids]);
    const requested = ids ?? [...this.rows.keys()];
    const rows = requested.flatMap((id) => {
      const row = this.rows.get(id);
      return row ? [row] : [];
    });
    return { rows, total: rows.length, complete: true };
  }

  async readFinancialOverrides(ids: readonly string[]) {
    const allowed = new Set(ids);
    return this.overrides.filter((row) => allowed.has(row.property_id));
  }

  async readCompanyChatSettings() {
    return [];
  }

  async readFindingRuns(ids: readonly string[]): Promise<PortfolioUiBulkRows<Record<string, unknown>>> {
    this.findingRunRequests.push([...ids]);
    return { rows: [], total: 0, complete: true };
  }

  async readFindings(ids: readonly string[]): Promise<PortfolioUiBulkRows<Record<string, unknown>>> {
    this.findingRequests.push([...ids]);
    if (this.fail.has('findings')) throw new Error('findings unavailable');
    const allowed = new Set(ids);
    const rows = this.findingRows.filter((row) => allowed.has(String(row.property_id)));
    return { rows, total: rows.length, complete: true };
  }

  async readPortfolioFindings(
    organizationId: string,
    ids: readonly string[],
    limitPerProperty: number,
  ): Promise<PortfolioUiBulkRows<Record<string, unknown>>> {
    this.portfolioFindingRequests.push({ organizationId, ids: [...ids], limitPerProperty });
    const read = await this.readFindings(ids);
    return {
      ...read,
      saturatedPropertyIds: [],
      unavailablePropertyIds: [],
    };
  }

  async readSectionRows(
    section: PortfolioUiSection,
    ids: readonly string[],
  ): Promise<PortfolioUiBulkRows<Record<string, unknown>>> {
    this.sectionRequests.push({ section, ids: [...ids] });
    if (this.fail.has('section')) throw new Error('section unavailable');
    const allowed = new Set(ids);
    const rows = this.sectionRows.filter((row) => allowed.has(String(row.property_id)));
    return { rows, total: rows.length, complete: true };
  }
}

describe('connected portfolio adversarial boundaries', () => {
  test('company selection narrows before any hotel read and tampering is rejected before reads', async () => {
    const account = caller({
      hats: [
        hat(ORG_A, 'vp', [PID_A1, PID_A2]),
        hat(ORG_B, 'owner', [PID_B1]),
      ],
    });
    const data = new AuditSource([
      property(PID_A1, 'A One'),
      property(PID_A2, 'A Two'),
      property(PID_B1, 'B One'),
    ]);

    const chooser = await loadPortfolioUiBootstrap({ account, source: data, now: NOW });
    assert.equal(chooser.ok, true);
    if (!chooser.ok) return;
    assert.equal(chooser.data.selection.state, 'needs_selection');
    assert.deepEqual(chooser.data.hotels, []);
    assert.deepEqual(data.propertyRequests[0], [], 'multi-company chooser must not read a flattened hotel union');

    const selected = await loadPortfolioUiBootstrap({
      account,
      source: data,
      now: NOW,
      requestedOrganizationId: ORG_B,
    });
    assert.equal(selected.ok, true);
    if (selected.ok) {
      assert.deepEqual(data.propertyRequests[1], [PID_B1]);
      assert.deepEqual(selected.data.hotels.map((hotel) => hotel.propertyId), [PID_B1]);
      assert.equal(JSON.stringify(selected.data).includes(PID_A1), true, 'chooser context retains opaque authorized ids');
      assert.equal(selected.data.hotels.some((hotel) => hotel.propertyId === PID_A1), false);
    }

    const untouched = new AuditSource([property(PID_A1, 'A One')]);
    const tampered = await loadPortfolioUiBootstrap({
      account,
      source: untouched,
      now: NOW,
      requestedOrganizationId: ORG_X,
    });
    assert.equal(tampered.ok, false);
    if (!tampered.ok) assert.equal(tampered.code, 'company_not_authorized');
    assert.equal(untouched.propertyRequests.length, 0);
  });

  test('a legacy hotel scope remains a deliberate choice beside one company context', async () => {
    const account = caller({
      role: 'general_manager',
      propertyAccess: [PID_B1],
      accessiblePropertyIds: [PID_A1, PID_A2, PID_B1],
      hats: [hat(ORG_A, 'vp', [PID_A1, PID_A2])],
    });
    const data = new AuditSource([
      property(PID_A1, 'A One'),
      property(PID_A2, 'A Two'),
      property(PID_B1, 'Independent One'),
    ]);

    const chooser = await loadPortfolioUiBootstrap({ account, source: data, now: NOW });
    assert.equal(chooser.ok, true);
    if (!chooser.ok) return;
    assert.equal(chooser.data.selection.state, 'needs_selection');
    assert.equal(chooser.data.entry.mode, 'company_picker');
    assert.equal(chooser.data.entry.legacyHotelCount, 1);
    assert.deepEqual(data.propertyRequests[0], [PID_B1]);
    assert.deepEqual(chooser.data.hotels.map((hotel) => hotel.propertyId), [PID_B1]);
  });

  test('a direct financial URL cannot read financial rows before capability authorization', async () => {
    const account = caller({ hats: [hat(ORG_A, 'finance', [PID_A1, PID_A2])] });
    const denied = new AuditSource([property(PID_A1, 'A One'), property(PID_A2, 'A Two')]);
    denied.overrides = [PID_A1, PID_A2].map((property_id) => ({
      property_id,
      role: 'front_desk',
      allowed: false,
    }));

    const result = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'financials',
      source: denied,
      now: NOW,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.equal(result.code, 'financials_forbidden');
    }
    assert.equal(denied.sectionRequests.length, 0, 'denial must happen before the revenue source is queried');

    const partialAccess = new AuditSource([property(PID_A1, 'A One'), property(PID_A2, 'A Two')]);
    partialAccess.overrides = [{ property_id: PID_A2, role: 'front_desk', allowed: false }];
    partialAccess.sectionRows = [
      ...dates('2026-07-01', '2026-07-27').map((businessDate, index) => ({
        id: `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        property_id: PID_A1,
        business_date: businessDate,
        total_revenue_cents: index === 0 ? 123_00 : 0,
        occupied_rooms: index === 0 ? 40 : 0,
        updated_at: NOW.toISOString(),
      })),
      ...dates('2026-06-01', '2026-06-27').map((businessDate, index) => ({
        id: `51000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        property_id: PID_A1,
        business_date: businessDate,
        total_revenue_cents: 0,
        occupied_rooms: 0,
        updated_at: NOW.toISOString(),
      })),
      { id: '50000000-0000-4000-8000-000000000002', property_id: PID_B1, date: '2026-07-27', total_revenue_cents: 999_999_00, occupied_rooms: 999, updated_at: NOW.toISOString() },
    ];
    const allowed = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'financials',
      source: partialAccess,
      now: NOW,
    });
    assert.equal(allowed.ok, true);
    assert.deepEqual(partialAccess.sectionRequests, [{ section: 'financials', ids: [PID_A1] }]);
    if (allowed.ok && allowed.data.summary.kind === 'financials') {
      assert.equal(allowed.data.summary.monthToDateRevenueCents, 123_00);
      assert.equal(JSON.stringify(allowed.data).includes('99999900'), false);
    }
  });

  test('partial source failures remain unknown/partial instead of becoming a false all-clear', async () => {
    const account = caller({ hats: [hat(ORG_A, 'owner', [PID_A1])] });
    const data = new AuditSource([property(PID_A1, 'A One')]);
    data.fail.add('findings');
    const bootstrap = await loadPortfolioUiBootstrap({ account, source: data, now: NOW });
    assert.equal(bootstrap.ok, true);
    if (bootstrap.ok) {
      assert.equal(bootstrap.data.partial, true);
      assert.equal(bootstrap.data.hotels[0].attention, null);
      assert.equal(bootstrap.data.hotels[0].status, 'unknown');
      assert.equal(bootstrap.data.hotels[0].indicators[0].value, null);
    }

    data.fail.delete('findings');
    data.fail.add('section');
    const section = await loadPortfolioUiSection({
      account,
      organizationId: ORG_A,
      section: 'maintenance',
      source: data,
      now: NOW,
    });
    assert.equal(section.ok, true);
    if (section.ok && section.data.summary.kind === 'maintenance') {
      assert.equal(section.data.partial, true);
      assert.equal(section.data.summary.openWorkOrders, null);
      assert.equal(section.data.hotels[0].freshness.state, 'unavailable');
    }
  });

  test('bootstrap does not read Staxis ledgers for hotels whose Staxis section is disabled', async () => {
    const account = caller({ hats: [hat(ORG_A, 'owner', [PID_A1, PID_A2])] });
    const disabled = { ...property(PID_A1, 'A One'), enabled_sections: { staxis: false } };
    const data = new AuditSource([disabled, property(PID_A2, 'A Two')]);

    const bootstrap = await loadPortfolioUiBootstrap({ account, source: data, now: NOW });
    assert.equal(bootstrap.ok, true);
    assert.deepEqual(data.findingRunRequests, [[PID_A2]]);
    assert.deepEqual(data.findingRequests, [[PID_A2]]);
    if (bootstrap.ok) {
      const hotel = bootstrap.data.hotels.find((candidate) => candidate.propertyId === PID_A1);
      assert.equal(hotel?.freshness.state, 'disabled');
      assert.equal(hotel?.attention, null);
      assert.equal(hotel?.partial, false, 'an intentional module disable is not an incomplete read');
    }
  });

  test('Portfolio Home counts only findings allowed by current source and financial policy', async () => {
    const account = caller({ hats: [hat(ORG_A, 'owner', [PID_A1])] });
    const restricted = {
      ...property(PID_A1, 'A One'),
      enabled_sections: { staxis: true, maintenance: false },
    };
    const data = new AuditSource([restricted]);
    data.overrides = [{ property_id: PID_A1, role: 'owner', allowed: false }];
    data.findingRows = [
      {
        id: '50000000-0000-4000-8000-000000000001',
        property_id: PID_A1,
        detector_id: 'cleaning_plan_health',
        summary: 'Housekeeping needs attention',
        evidence: { params: {} },
        severity: 'warning',
        updated_at: NOW.toISOString(),
      },
      {
        id: '50000000-0000-4000-8000-000000000002',
        property_id: PID_A1,
        detector_id: 'preventive_due',
        summary: 'Disabled maintenance detail must not affect the card',
        evidence: { params: {} },
        severity: 'critical',
        updated_at: NOW.toISOString(),
      },
      {
        id: '50000000-0000-4000-8000-000000000003',
        property_id: PID_A1,
        detector_id: 'supply_spend_baseline',
        summary: 'Restricted spend detail must not affect the card',
        evidence: { params: {} },
        severity: 'critical',
        price_low_cents: 10_000,
        price_high_cents: 20_000,
        price_currency: 'USD',
        price_basis: 'estimated spend',
        updated_at: NOW.toISOString(),
      },
    ];

    const bootstrap = await loadPortfolioUiBootstrap({ account, source: data, now: NOW });
    assert.equal(bootstrap.ok, true);
    if (!bootstrap.ok) return;
    const hotel = bootstrap.data.hotels[0];
    assert.equal(hotel.capabilities.canManageHotel, false, 'portfolio reach is not hotel write standing');
    assert.equal(hotel.capabilities.canViewFinancials, false);
    assert.equal(hotel.attention, true);
    assert.equal(hotel.status, 'attention', 'hidden critical findings must not raise the hotel status');
    assert.equal(hotel.indicators.find((item) => item.key === 'open_findings')?.value, 1);
    assert.equal(hotel.indicators.find((item) => item.key === 'critical_findings')?.value, 0);
  });

  test('return targets cannot escape the app origin, including encoded variants', () => {
    assert.equal(normalizeSameOriginAppPath('/portfolio?organizationId=' + ORG_A), `/portfolio?organizationId=${ORG_A}`);
    for (const value of [
      'https://evil.example/steal',
      '//evil.example/steal',
      '/%2f%2fevil.example/steal',
      '/%5cevil.example/steal',
      '/\\evil.example/steal',
      'javascript:alert(1)',
      '/%E0%A4%A',
      '/portfolio\u0000?safe=false',
    ]) {
      assert.equal(normalizeSameOriginAppPath(value), null, value);
    }
  });
});

describe('connected portfolio source-code ratchets', () => {
  test('every service-role domain read carries its tenant intersection', () => {
    const server = source('src/lib/portfolio-ui/server.ts');
    for (const table of [
      'finding_runs',
      'findings',
      'cleaning_tasks',
      'complaints',
      'work_orders',
      'inventory',
      'scheduled_shifts',
    ]) {
      assert.match(
        server,
        new RegExp(`\\.from\\('${table}'\\)[\\s\\S]{0,650}?\\.in\\('property_id', \\[\\.\\.\\.propertyIds\\]\\)`),
        `${table} lost its property intersection`,
      );
    }
    const propertyRevenueReads = [...server.matchAll(/\.from\('pms_revenue_daily_current'\)([\s\S]{0,650}?)\.in\('property_id', \[\.\.\.propertyIds\]\)/g)];
    const financialRevenueReads = [...server.matchAll(/\.from\('pms_revenue_daily_current'\)([\s\S]{0,650}?)\.in\('property_id', \[\.\.\.financialPropertyIds\]\)/g)];
    assert.equal(
      propertyRevenueReads.length,
      2,
      'dashboard occupancy and the authorized financial section must use exact property intersections',
    );
    assert.equal(
      financialRevenueReads.length,
      1,
      'dashboard money must be queried only for financial-authorized properties',
    );
    assert.match(
      server,
      /function portfolioFinancialHistoryStart\(now: Date\)[\s\S]{0,500}?utcToday\.endsWith\('-01'\)[\s\S]{0,160}?getUTCHours\(\) < 12/,
      'the first UTC hours of a month must include a western hotel’s prior local month',
    );
    assert.equal(
      [...server.matchAll(/const financialStart = portfolioFinancialHistoryStart\(now\)/g)].length,
      2,
      'dashboard and financials must share the UTC/local boundary-safe history start',
    );
    assert.match(server, /\.from\('organizations'\)[\s\S]{0,300}?\.in\('id', \[\.\.\.organizationIds\]\)/);
    assert.match(server, /\.from\('company_access_settings'\)[\s\S]{0,300}?\.in\('organization_id', \[\.\.\.organizationIds\]\)/);
  });

  test('My Portfolio company hats cannot widen through non-governing relationships', () => {
    const route = source('src/app/api/company-access/route.ts');
    assert.match(route, /row\.is_primary_grouping === true/);
    assert.match(route, /row\.relationship_type === 'operator' \|\| row\.relationship_type === 'owner'/);
    assert.match(route, /activeWindow\(row\.starts_at, row\.ends_at, nowMs\)/);
    assert.match(
      route,
      /relationship\.is_primary_grouping === true[\s\S]{0,140}?relationship\.relationship_type === 'operator' \|\| relationship\.relationship_type === 'owner'[\s\S]{0,140}?activeWindow\(relationship\.starts_at, relationship\.ends_at, projectionAtMs\)/,
      'brand, franchisor, vendor, and secondary relationships must not become company-hat hotel coverage',
    );
  });

  test('platform-wide identities cannot use bootstrap to merge customer portfolios', () => {
    const route = source('src/app/api/portfolio/v1/bootstrap/route.ts');
    const reject = route.indexOf("account.role === 'admin' || account.reachesAllProperties");
    const requestedOrganization = route.indexOf("searchParams.getAll('organizationId')");
    const portfolioRead = route.indexOf('loadPortfolioUiBootstrap({');
    assert.ok(reject >= 0 && requestedOrganization > reject && portfolioRead > requestedOrganization);
    assert.match(
      route.slice(reject, requestedOrganization),
      /status: 403[\s\S]{0,120}?code: 'customer_context_required'/,
    );
  });

  test('portfolio request boundaries distinguish access outages from empty or denied scope', () => {
    const resolver = source('src/lib/company/portfolio.ts');
    assert.match(resolver, /listAuthoritativePropertyAccess\(accountId\)/);
    assert.match(resolver, /resolveAuthorizationScope\(\{[\s\S]{0,180}?selector: \{ type: 'all_authorized' \}/);
    assert.match(resolver, /resolveManagementCompanyScopeUncached\(accountId, organizationId\)/);
    assert.match(resolver, /companyAccessSetting\(targetId, 'cross_hotel_ai_chat'\)/);

    for (const path of [
      'src/app/api/portfolio/v1/bootstrap/route.ts',
      'src/app/api/portfolio/v1/section/route.ts',
      'src/app/api/portfolio/v1/hotel-context/route.ts',
    ]) {
      const route = source(path);
      assert.match(route, /assertAuthorizationScopeReceipt/, `${path} lost its final receipt check`);
      assert.match(route, /status: 503/, `${path} must expose a retryable access outage`);
      assert.match(route, /status: 409/, `${path} must distinguish a changed scope`);
    }
    const queue = source('src/app/api/company/queue/route.ts');
    assert.match(queue, /resolveManagementCompanyScopeUncached/);
    assert.match(queue, /assertAuthorizationScopeReceipt/);
    assert.match(queue, /status: 503/);
  });

  test('navigation code cannot invoke an agent or model', () => {
    for (const path of [
      'src/contexts/PortfolioContext.tsx',
      'src/app/portfolio/PortfolioHomeClient.tsx',
      'src/app/portfolio/[section]/PortfolioSectionClient.tsx',
      'src/app/api/portfolio/v1/bootstrap/route.ts',
      'src/app/api/portfolio/v1/section/route.ts',
      'src/lib/portfolio-ui/server.ts',
    ]) {
      const text = source(path);
      assert.doesNotMatch(text, /streamAgent|generateText|\/api\/agent\/portfolio|@\/lib\/agent\//, path);
    }

    const ask = source('src/components/agent/PortfolioChat.tsx');
    assert.match(ask, /useAgentChat\(\{[\s\S]{0,160}?mode: 'portfolio',[\s\S]{0,100}?organizationId/);
    assert.match(ask, /sendMessage\(text\)/);
    assert.match(ask, /startNew\(\);[\s\S]{0,80}?sendMessage\(retryMessage\)/);
    assert.match(ask, /reloadConversations/);
    assert.match(ask, /role="log"/);
    assert.match(ask, /aria-busy=\{busy\}/);
    assert.match(ask, /aria-live="polite"/);

    const portfolioRoute = source('src/app/api/agent/portfolio/route.ts');
    const synthesis = portfolioRoute.indexOf('run = await dependencies.runSynthesis({');
    const finalScopeCheck = portfolioRoute.lastIndexOf('if (!await exactTurnScopeStillCurrent(receipt))');
    const release = portfolioRoute.lastIndexOf('return sseResponse([');
    assert.ok(synthesis >= 0 && finalScopeCheck > synthesis && release > finalScopeCheck);
    assert.match(
      portfolioRoute.slice(release, release + 500),
      /type: 'text_delta'[\s\S]{0,180}?type: 'done'/,
      'the route must release only its bounded, deterministic client frames',
    );
    assert.doesNotMatch(portfolioRoute, /ReadableStream|pipeThrough|providerStream/);
  });

  test('company URL switches suppress old-company responses before render', () => {
    const portfolioContext = source('src/contexts/PortfolioContext.tsx');
    assert.match(
      portfolioContext,
      /resource\.data\?\.selection\.requestedOrganizationId[\s\S]{0,100}?=== requestedOrganizationId/,
    );
    assert.match(portfolioContext, /safeData = responseMatchesRequest \? resource\.data : null/);

    const section = source('src/app/portfolio/[section]/PortfolioSectionClient.tsx');
    assert.match(
      section,
      /resource\.data\.organizationId !== organizationId \|\| resource\.data\.section !== section/,
    );
    assert.match(section, /data = responseMismatch \? null : resource\.data/);

    const queue = source('src/components/concourse/PortfolioQueueView.tsx');
    assert.match(queue, /resourceData\?\.scope[\s\S]{0,120}?resourceData\.scope\.organizationId !== organizationId/);
    assert.match(queue, /data = responseMismatch \? null : resourceData/);
  });

  test('portfolio resources key cached state to the signed-in viewer and suppress disabled identities synchronously', () => {
    const hook = source('src/lib/hooks/use-api-resource.ts');
    assert.match(hook, /identityKey\?: string \| number \| null/);
    assert.match(hook, /authorizationKey: identityKey/);
    assert.match(hook, /sameResourceIdentity\(identityState\.data, currentIdentity\)/);
    assert.match(hook, /const visibleData = enabled && \(dataMatchesCurrent \|\| canHoldDataAcrossSource\)/);
    assert.match(hook, /const visibleError = enabled && sameResourceIdentity\(identityState\.error, currentIdentity\)/);

    const bootstrap = source('src/contexts/PortfolioContext.tsx');
    assert.match(bootstrap, /identityKey: user[\s\S]{0,220}?user\.uid,[\s\S]{0,120}?authorizationFingerprint/);

    // Company URLs can remain identical while one browser account is replaced
    // by another. Every independently cached portfolio surface therefore needs
    // the viewer key, not only the bootstrap provider above.
    const section = source('src/app/portfolio/[section]/PortfolioSectionClient.tsx');
    assert.match(section, /identityKey: user[\s\S]{0,240}?user\.uid,[\s\S]{0,140}?organizationId/);
    const queue = source('src/components/concourse/PortfolioQueueView.tsx');
    assert.match(queue, /identityKey: authorizationKey/);
  });

  test('revoked scopes clear cached portfolio surfaces before focus reauthorization', () => {
    for (const path of [
      'src/contexts/PortfolioContext.tsx',
      'src/app/portfolio/[section]/PortfolioSectionClient.tsx',
      'src/components/concourse/PortfolioQueueView.tsx',
    ]) {
      const text = source(path);
      assert.match(text, /revalidateOnFocus: true/);
      assert.match(text, /clearDataOnFocusRevalidate: true/);
    }

    const company = source('src/app/(hotel)/company/page.tsx');
    assert.match(company, /const portfolio = usePortfolio\(\)/);
    assert.match(company, /portfolioMode[\s\S]{0,240}?portfolio\.data/);
    assert.match(company, /onRetry=\{\(\) => void portfolio\.reload\(\)\}/);

    const hook = source('src/lib/hooks/use-api-resource.ts');
    const focusRevalidate = hook.slice(
      hook.indexOf('const revalidate = () => {'),
      hook.indexOf('const onVisibilityChange', hook.indexOf('const revalidate = () => {')),
    );
    assert.match(focusRevalidate, /inFlightRef\.current && !clearOnFocusRef\.current/);
    assert.match(focusRevalidate, /dataRef\.current = null/);
    assert.match(focusRevalidate, /void load\('initial'\)/);
    assert.match(hook, /const ticket = gateRef\.current\.begin\(\)/);
  });

  test('conversation continuation is bound to its stored owner and company, not request company', () => {
    const route = source('src/app/api/agent/portfolio/route.ts');
    const load = route.search(/existingScope = await loadConversationScope\(body\.conversationId, caller\.accountId\)/);
    const rejectMismatch = route.indexOf('body.organizationId !== existingScope.organizationId');
    const reauthorize = route.indexOf('const organizationId = existingScope?.organizationId ?? body.organizationId ?? null');
    const history = route.indexOf('lockLoadAndRecordPortfolioUserTurn({');
    assert.ok(load >= 0 && rejectMismatch > load && reauthorize > rejectMismatch && history > reauthorize);
    assert.match(route, /existingScope\.conversationKind !== 'portfolio' \|\| !existingScope\.organizationId/);
    assert.match(route, /existingScope\.authorizationHash !== baseReceipt\.authorizationHash/);
    assert.match(route, /userAccountId: caller\.accountId/);

    const memory = source('src/lib/agent/memory.ts');
    assert.match(memory, /if \(!data \|\| data\.user_id !== userAccountId\) return null/);
    assert.match(memory, /const scope = conversationSecurityScopeFromRow\(data\)/);
    assert.match(memory, /if \(!scope\) return null/);
    assert.match(memory, /\.\.\.scope,[\s\S]{0,100}?propertyId: data\.property_id/);
  });

  test('portfolio conversation replay is bound to current hotel, module, and financial policy', () => {
    const policy = source('src/lib/company/portfolio-data-policy.ts');
    const fingerprint = policy.slice(
      policy.indexOf('function fingerprintFor('),
      policy.indexOf('export async function resolvePortfolioQueuePolicy'),
    );
    assert.match(fingerprint, /\[\.\.\.data\.propertyIds\]\.sort\(\)/);
    assert.match(fingerprint, /PORTFOLIO_DATA_SECTIONS\.map/);
    assert.match(fingerprint, /portfolioSectionDecision\(data, section, propertyId\)/);
    assert.match(fingerprint, /financials\.get\(propertyId\) \?\? 'unavailable'/);

    const route = source('src/app/api/agent/portfolio/route.ts');
    const policyResolve = route.indexOf('const conversationPolicy = await resolvePortfolioQueuePolicy(');
    const mismatch = route.indexOf(
      'portfolioPolicyFingerprintFromStamp(existingScope.promptVersion)',
      policyResolve,
    );
    const reservation = route.indexOf('dependencies.reserveBudget({', mismatch);
    const history = route.indexOf('lockLoadAndRecordPortfolioUserTurn({', mismatch);
    assert.ok(policyResolve >= 0 && mismatch > policyResolve);
    assert.ok(mismatch < reservation && mismatch < history, 'revoked history must be refused before billing or loading messages');
    assert.match(
      route,
      /createPortfolioConversation\(\{[\s\S]{0,300}?promptVersion: synthesisConversationPromptVersion/,
      'new portfolio conversations must carry the policy that authorized their history',
    );

    const authorization = source('src/app/api/agent/portfolio/conversations/_authorization.ts');
    assert.match(authorization, /policy = await resolvePortfolioQueuePolicy\(/);
    assert.match(authorization, /policyFingerprint: policy\.fingerprint/);
    const detail = source('src/app/api/agent/portfolio/conversations/[id]/route.ts');
    assert.match(detail, /policyFingerprint: initial\.policyFingerprint/);
    assert.match(detail, /samePortfolioConversationAuthorization\(initial, current\)/);

    const memory = source('src/lib/agent/memory.ts');
    assert.match(memory, /portfolioPolicyFingerprintFromStamp\(convo\.prompt_version as string \| null\)[\s\S]{0,60}opts\.policyFingerprint/);
    const stamp = source('src/lib/agent/portfolio/conversation.ts');
    assert.match(stamp, /POLICY_SEGMENT_PREFIX = 'policy:'/);
    assert.match(stamp, /portfolioPolicyFingerprintFromStamp/);
  });

  test('portfolio queue projections and company-card mutations reauthorize persisted evidence', () => {
    const queue = source('src/lib/company/vp-queue-server.ts');
    const readModelLoad = queue.indexOf('loadPortfolioQueueReadModel(scope.propertyIds)');
    const climbed = queue.indexOf('climbedCards(scope, caller, directory, readModel, now)');
    assert.ok(readModelLoad >= 0 && climbed > readModelLoad);
    assert.match(queue, /const actions = readModel\.actionByFindingId/);
    assert.match(queue, /action\?\.state !== 'proposed'/);

    const route = source('src/app/api/company/queue/route.ts');
    const finding = route.indexOf('loadCompanyFindingVerdictSnapshot(');
    const currentHotelAccess = route.indexOf('listAuthoritativePropertyAccess(caller.accountId)', finding);
    const exactReceipt = route.indexOf("selector: {", currentHotelAccess);
    const write = route.indexOf('commitCompanyFindingVerdict({', exactReceipt);
    assert.ok(finding >= 0 && currentHotelAccess > finding && exactReceipt > currentHotelAccess && write > exactReceipt);
    assert.match(route, /hotelMutationAllowed !== true/);

    const commit = source('src/lib/company/company-findings.ts');
    assert.match(commit, /staxis_set_company_finding_verdict_cas/);
    assert.match(commit, /p_expected_affected_property_ids: input\.snapshot\.affectedPropertyIds/);
    assert.match(commit, /p_authorization_receipt_id: input\.authorizationReceiptId/);

    const brief = source('src/lib/company/vp-brief-server.ts');
    assert.match(brief, /policyFingerprint: string/);
    assert.match(brief, /payload\.policyFingerprint !== policyFingerprint/);
  });

  test('hotel finding drill-down remains read-only unless current hotel or explicit company authority permits a write', () => {
    const findings = source('src/app/api/findings/route.ts');
    const getStart = findings.indexOf('export async function GET');
    const postStart = findings.indexOf('export async function POST');
    const get = findings.slice(getStart, postStart);
    const post = findings.slice(postStart);

    const readGate = get.indexOf('managerManagesHotel(caller, propertyId)');
    const firstRead = get.indexOf('listFindings(propertyId');
    assert.ok(readGate >= 0 && firstRead > readGate);

    const authority = post.indexOf('managerManagesHotel(caller, propertyId)');
    const mutationStanding = post.indexOf('callerCanMutateHotel(caller, propertyId)', authority);
    const firstMutation = Math.min(
      ...['recordFindingActed(', 'logPreventiveOutcome(', 'setFindingStatus(']
        .map((needle) => post.indexOf(needle, mutationStanding))
        .filter((index) => index >= 0),
    );
    assert.ok(authority >= 0 && mutationStanding > authority && firstMutation > mutationStanding);

    const actionRoute = source('src/app/api/findings/actions/route.ts');
    const actionAuthority = actionRoute.indexOf('managerManagesHotel(caller, propertyId)');
    const actionMutation = actionRoute.indexOf('callerCanMutateHotel(caller, propertyId)', actionAuthority);
    const actionLoad = actionRoute.indexOf('const action = await loadAction(', actionMutation);
    const execute = actionRoute.indexOf('await executeAction(', actionLoad);
    assert.ok(actionAuthority >= 0 && actionMutation > actionAuthority);
    assert.ok(actionLoad > actionMutation && execute > actionLoad);

    const queueRoute = source('src/app/api/company/queue/route.ts');
    assert.match(
      queueRoute,
      /Climbed hotel cards stay read-only[\s\S]{0,240}?canActOnCompanyFinding/,
      'portfolio hotel cards must stay read-only until their hotel-local transaction owns a receipt fence',
    );
    assert.doesNotMatch(
      queueRoute.slice(
        queueRoute.indexOf('const queue = await buildPortfolioQueue'),
        queueRoute.indexOf('let brief:', queueRoute.indexOf('const queue = await buildPortfolioQueue')),
      ),
      /canActAtHotel/,
    );

    const client = source('src/components/concourse/PortfolioQueueView.tsx');
    assert.match(client, /readOnlyFor=\{\(finding\) => byId\.get\(finding\.id\)\?\.canAct !== true\}/);
    assert.match(client, /organizationId: resolvedOrganizationId/);
  });

  test('portfolio hotel reach never becomes ordinary hotel write or private Communications authority', () => {
    const teamAuth = source('src/lib/team-auth.ts');
    const strictWrite = teamAuth.slice(
      teamAuth.indexOf('export async function hotelWriteDecisionForUserId('),
      teamAuth.indexOf('// ─── Manager identity', teamAuth.indexOf('export async function hotelWriteDecisionForUserId(')),
    );
    assert.match(strictWrite, /accountCapabilityDecisionForProperty\([\s\S]{0,160}?requireMutation: true/);
    assert.match(strictWrite, /listAuthoritativePropertyAccess\(account\.id as string\)/);
    assert.match(strictWrite, /hotelMutationAllowed === true/);

    for (const route of [
      'src/app/api/complaints/draft/route.ts',
      'src/app/api/complaints/log/route.ts',
      'src/app/api/complaints/update/route.ts',
      'src/app/api/housekeeping/auto-assign/route.ts',
      'src/app/api/housekeeping/reassign/route.ts',
      'src/app/api/housekeeping/reset-assignments/route.ts',
      'src/app/api/housekeeping/staff-priority/route.ts',
      'src/app/api/housekeeping/notices/route.ts',
      'src/app/api/housekeeping/inspections/start/route.ts',
      'src/app/api/housekeeping/inspections/[id]/complete/route.ts',
      'src/app/api/housekeeping/inspections/[id]/cancel/route.ts',
      'src/app/api/housekeeping/inspections/upload-photo/route.ts',
      'src/app/api/inventory/photo-count/route.ts',
      'src/app/api/inventory/post-count-process/route.ts',
      'src/app/api/maintenance/equipment/route.ts',
      'src/app/api/maintenance/equipment/[id]/route.ts',
      'src/app/api/walkthrough/start/route.ts',
      'src/app/api/walkthrough/step/route.ts',
    ]) {
      assert.match(source(route), /hotelWriteDecisionForUserId\(/, `${route} bypasses local write standing`);
    }
    assert.match(
      source('src/app/api/settings/wages/route.ts'),
      /req\.method !== 'GET'[\s\S]{0,240}?hotelMutationAllowed === true/,
    );

    const comms = source('src/lib/comms/route-helpers.ts');
    const strictGate = comms.indexOf('const standing = authoritativeStandingForProperty(');
    const staffIdentity = comms.indexOf('resolveStaffIdForAccount(', strictGate);
    assert.ok(strictGate >= 0 && staffIdentity > strictGate);
    assert.match(comms, /resolvePrivateHotelCommsStaffId\([\s\S]{0,180}?standing/);
    assert.match(comms, /standing\.hotelMutationAllowed !== true/);
    assert.match(comms, /role: standing\.operationalRole/);

    for (const route of [
      'src/app/api/comms/acknowledge/route.ts',
      'src/app/api/comms/action/route.ts',
      'src/app/api/comms/announce/route.ts',
      'src/app/api/comms/assistant/route.ts',
      'src/app/api/comms/detect-action/route.ts',
      'src/app/api/comms/dm/route.ts',
      'src/app/api/comms/logbook/route.ts',
      'src/app/api/comms/logbook/replies/route.ts',
      'src/app/api/comms/photo-presign/route.ts',
      'src/app/api/comms/pin/route.ts',
      'src/app/api/comms/polish/route.ts',
      'src/app/api/comms/react/route.ts',
      'src/app/api/comms/send/route.ts',
      'src/app/api/comms/tasks/route.ts',
      'src/app/api/comms/transcribe/route.ts',
    ]) {
      assert.match(source(route), /commsContext\(/, `${route} bypasses the local hotel context`);
    }
  });

  test('portfolio aggregates enforce financial access independently at every hotel', () => {
    const resolver = source('src/lib/company/portfolio-financial-access.ts');
    assert.match(
      resolver,
      /resolveManagementCompanyScopeUncached\([\s\S]{0,120}?input\.accountId,[\s\S]{0,80}?input\.organizationId/,
      'an access-store outage must never become an implicit financial grant',
    );
    assert.match(resolver, /resolved\.reason === 'authorization_unavailable'\) return unavailable\(\)/);
    assert.match(
      resolver,
      /\.from\('capability_overrides'\)[\s\S]{0,240}?\.in\('property_id', propertyIds\)[\s\S]{0,120}?\.eq\('capability', 'view_financials'\)/,
      'override lookup must be one bounded read over the freshly-authorized hotel ids',
    );
    assert.match(resolver, /if \(error \|\| !Array\.isArray\(data\)\) return unavailable\(\)/);
    assert.match(
      resolver,
      /standing\.seesFinancials && !explicitDeny \? 'allowed' : 'denied'/,
      'a company finance hat must retain its money dimension after legacy front-desk degradation',
    );
    assert.match(resolver, /if \(resolved\.access\.companyRole === 'owner'\) restrictingRoles\.add\('owner'\)/);

  });

  test('portfolio aggregates enforce each hotel section policy before domain reads', () => {
    const resolver = source('src/lib/company/portfolio-section-access.ts');
    assert.match(
      resolver,
      /\.from\('properties'\)[\s\S]{0,180}?\.select\('id, enabled_sections'\)[\s\S]{0,120}?\.in\('id', ids\)/,
      'section policy must be one bounded lookup over the freshly-authorized hotel ids',
    );
    assert.match(resolver, /if \(error \|\| !Array\.isArray\(data\)\) return unavailable\(\)/);
    assert.match(
      resolver,
      /const decisions = unavailable\(\)[\s\S]{0,400}?parseStoredEnabledSections\(row\.enabled_sections\)[\s\S]{0,220}?isSectionEnabled\(sections, section\)[\s\S]{0,220}?catch[\s\S]{0,120}?Initialized unavailable/,
      'malformed policy must be unavailable, never default-enabled',
    );

  });

  test('a conversation whose old anchor left the company cannot charge that former hotel', () => {
    const route = source('src/app/api/agent/portfolio/route.ts');
    const anchorStart = route.lastIndexOf('const anchorPropertyId');
    const anchor = route.slice(
      anchorStart,
      route.indexOf('const reservation', anchorStart),
    );
    assert.match(anchor, /receipt\.propertyIds\.includes\(existingScope\.propertyId\)/);
    assert.match(anchor, /anchorHotelFor\(receipt\.propertyIds\)/);
    const reservation = route.slice(anchorStart, route.indexOf('let conversationId', anchorStart));
    assert.match(reservation, /propertyId: anchorPropertyId/);
    const replay = route.slice(
      route.indexOf('lockLoadAndRecordPortfolioUserTurn({', anchorStart),
      route.indexOf('if \(!prep\.ok\)', anchorStart),
    );
    assert.match(replay, /userMessage: body\.message/);
  });

  test('ordinary hotel chat cannot replay a company-scoped conversation', () => {
    const command = source('src/app/api/agent/command/route.ts');
    const scopeLoad = command.indexOf('loadConversationScope(');
    const reservation = command.indexOf('reserveCostBudget({');
    const history = command.indexOf('lockLoadAndRecordUserTurn({');
    assert.ok(scopeLoad >= 0, 'hotel chat must inspect the stored conversation scope');
    assert.ok(scopeLoad < reservation, 'scope rejection must happen before model selection or cost reservation');
    assert.ok(scopeLoad < history, 'scope rejection must happen before cross-hotel history is loaded');
    assert.match(
      command.slice(scopeLoad, Math.min(reservation, history)),
      /conversationKind !== 'property'[\s\S]{0,500}?return Response\.json/,
      'portfolio conversations must be rejected by the per-hotel endpoint',
    );

    const resolve = source('src/app/api/agent/command/resolve-action/route.ts');
    const detailLoad = resolve.indexOf('loadConversation(pending.conversationId, userCtx.accountId)');
    const actionReservation = resolve.indexOf('reserveCostBudget({');
    assert.ok(detailLoad >= 0 && detailLoad < actionReservation);
    assert.match(
      resolve.slice(detailLoad, actionReservation),
      /!convo \|\| convo\.propertyId !== body\.pid[\s\S]{0,260}?return Response\.json/,
      'portfolio conversations must never acquire ordinary hotel approval actions',
    );
    const memory = source('src/lib/agent/memory.ts');
    const propertyConversationLoad = memory.slice(
      memory.indexOf('export async function loadConversation('),
      memory.indexOf('const UUID_RX', memory.indexOf('export async function loadConversation(')),
    );
    assert.match(propertyConversationLoad, /conversationSecurityScopeFromRow\(convo\)/);
    assert.match(propertyConversationLoad, /scope\.conversationKind !== 'property'/);

    const historyRoute = source('src/app/api/agent/conversations/route.ts');
    assert.match(
      historyRoute,
      /listConversations\([\s\S]{0,160}?'property',[\s\S]{0,160}?authority\.propertyIds/,
      'ordinary hotel history must not expose portfolio conversation ids or titles',
    );

    const propertyFilter = memory.indexOf("query = query.in('property_id', [...authorizedPropertyIds])");
    const historyLimit = memory.indexOf('.limit(limit)', propertyFilter);
    assert.ok(
      propertyFilter >= 0 && historyLimit > propertyFilter,
      'current hotel reach must constrain the conversation query before its limit and serialization',
    );

    const detail = source('src/app/api/agent/conversations/[id]/route.ts');
    const storedScope = detail.indexOf('loadConversationScope(id, account.id as string)');
    const authority = detail.indexOf('listAuthoritativePropertyAccess(account.id as string)', storedScope);
    const localReach = detail.indexOf('authority.propertyIds.includes(scope.propertyId)', authority);
    const messageLoad = detail.indexOf('loadConversation(id, account.id as string)', localReach);
    assert.ok(
      storedScope >= 0 && authority > storedScope && localReach > authority && messageLoad > localReach,
      'current authoritative hotel reach must be proven before ordinary conversation messages load',
    );
  });

  test('company reach alone never becomes a hotel Ask Staxis role or tool catalog', () => {
    const runner = source('src/app/api/agent/command/_stream-runner.ts');
    const loader = runner.slice(
      runner.indexOf('export async function loadAgentUserCtx'),
      runner.indexOf('export interface StreamRunnerContext'),
    );
    assert.match(
      loader,
      /\.select\('id, username, display_name, data_user_id, active'\)/,
    );
    assert.match(
      loader,
      /if \(accountErr \|\| !account \|\| account\.active !== true\)[\s\S]{0,100}?reason: 'account_not_found'/,
      'inactive and indeterminate account state must be rejected before hotel hats, staff, or tools are resolved',
    );
    assert.match(loader, /listAuthoritativePropertyAccess\(accountId\)/);
    assert.match(loader, /authoritativeStandingForProperty\(authority, propertyId\)/);
    assert.match(loader, /role: standing\.operationalRole/);
    assert.match(loader, /hotelMutationAllowed: standing\.hotelMutationAllowed/);
    assert.match(loader, /seesFinancials: standing\.seesFinancials/);
    assert.doesNotMatch(
      loader,
      /role:\s*(?:legacyRole|account\.role)[,}]/,
      'a global accounts.role must not be copied into hotel agent authorization',
    );

    for (const path of [
      'src/app/api/agent/command/route.ts',
      'src/app/api/agent/command/resolve-action/route.ts',
      'src/app/api/agent/activity/route.ts',
    ]) {
      const route = source(path);
      assert.match(route, /loadAgentUserCtx\(/, `${path} bypasses the hotel-role resolver`);
    }
  });

  test('agent snapshot outages stay unavailable instead of being mislabeled as manual hotels', () => {
    const snapshot = source('src/lib/agent/portfolio/snapshot.ts');
    const statusRead = snapshot.slice(
      snapshot.indexOf('let feedPulses: PortfolioFeedPulse[]'),
      snapshot.indexOf('const pulses:'),
    );
    assert.match(statusRead, /readPortfolioFeedPulses\(organizationId, propertyIds\)/);
    assert.doesNotMatch(statusRead, /mapWithConcurrency|getPropertyFeedStatus/);
    assert.match(statusRead, /catch[\s\S]{0,360}?mode: 'unavailable'/);
    assert.doesNotMatch(statusRead, /catch[\s\S]{0,360}?mode: 'manual'/);

    const helper = source('src/lib/company/portfolio-tool-reads.ts');
    const pulseRead = helper.slice(
      helper.indexOf('export async function readPortfolioFeedPulses'),
      helper.indexOf('export async function readPortfolioToolFindings'),
    );
    assert.match(pulseRead, /boundedScope\(organizationId, propertyIds\)/);
    assert.match(pulseRead, /supabaseAdmin\.rpc\('staxis_portfolio_feed_pulses'/);
    assert.match(pulseRead, /!propertyId \|\| !allowed\.has\(propertyId\)/);
    assert.match(pulseRead, /byPropertyId\.has\(propertyId\)[\s\S]{0,120}?duplicate property buckets/);
    assert.match(
      pulseRead,
      /ids\.map\(\(propertyId\) => byPropertyId\.get\(propertyId\) \?\? unavailableFeedPulse\(propertyId\)\)/,
      'an omitted company-intersection bucket must be unavailable, never manual',
    );
    assert.match(helper, /if \(!bucket\.session_present\)[\s\S]{0,100}?mode: 'manual'/);
    assert.match(
      snapshot,
      /else \{[\s\S]{0,160}?PMS feed status could not be read this turn — do not call this a manual hotel/,
    );
    assert.match(
      snapshot,
      /cacheKey\([\s\S]{0,120}?organizationId,[\s\S]{0,80}?hotels,[\s\S]{0,80}?omittedHotelCount,[\s\S]{0,80}?findingPolicy/,
    );
    assert.match(snapshot, /::omitted=\$\{omittedHotelCount\}/);
    assert.match(snapshot, /::policy=\$\{findingPolicy\.fingerprint\}/);
    assert.match(snapshot, /::staxis-disabled=\$\{disabled\.join\(','\)\}/);
    assert.match(snapshot, /::staxis-unavailable=\$\{unavailable\.join\(','\)\}/);
    assert.match(
      snapshot,
      /readPortfolioToolFindings\([\s\S]{0,80}?organizationId,[\s\S]{0,80}?findingPropertyIds,[\s\S]{0,80}?LIVE_FINDING_STATUSES,[\s\S]{0,80}?MAX_ROWS_PER_HOTEL \+ 1/,
    );
    assert.match(snapshot, /const MAX_ROWS_PER_HOTEL = 50/);
    assert.match(snapshot, /if \(sectionDecision === 'enabled' && rows\)/);
    assert.match(
      snapshot,
      /findingMode: sectionDecision === 'disabled'[\s\S]{0,120}?openFindings === null[\s\S]{0,80}?'unavailable'/,
    );
    assert.match(snapshot, /const findingWindowSaturated = rows\.length > MAX_ROWS_PER_HOTEL/);
    assert.match(
      snapshot,
      /const policyAllowed = rows\.slice\(0, MAX_ROWS_PER_HOTEL\)\.filter\([\s\S]{0,180}?findingForSnapshotPolicy\(row, propertyId\)[\s\S]{0,180}?portfolioHotelFindingPolicyDecision\(finding, findingPolicy\) === 'allowed'/,
    );
    const saturatedPolicyGate = snapshot.slice(
      snapshot.indexOf('if (!(findingWindowSaturated && policyAllowed.length === 0))'),
      snapshot.indexOf('const feed =', snapshot.indexOf('if (!(findingWindowSaturated && policyAllowed.length === 0))')),
    );
    assert.match(saturatedPolicyGate, /openFindings = policyAllowed\.length/);
    assert.match(
      saturatedPolicyGate,
      /else \{[\s\S]{0,80}?unavailablePropertyIds\.add\(propertyId\)/,
      'a saturated policy-zero window must be unknown instead of a false zero',
    );
    assert.match(
      snapshot,
      /needsDecision = findingWindowSaturated && proposed === 0 \? null : proposed/,
      'decision-count completeness must stay independent of the visible open count',
    );
    assert.match(snapshot, /findingCountLowerBound = findingWindowSaturated/);
    assert.match(snapshot, /\$\{hotel\.findingCountLowerBound \? 'at least ' : ''\}\$\{hotel\.openFindings\}/);
    assert.match(snapshot, /A shown count is only a known minimum when marked “at least”;[\s\S]{0,120}?all-clear/);

    assert.match(helper, /MAX_PORTFOLIO_TOOL_ROWS_PER_HOTEL = 51/);
    assert.match(helper, /MAX_PORTFOLIO_TOOL_BUCKET_BYTES = 65_536/);
    assert.match(helper, /rows\.length > requestedLimit[\s\S]{0,220}?per-property row contract/);
    assert.match(helper, /Buffer\.byteLength\(JSON\.stringify\(rows\)\)[\s\S]{0,160}?byte contract/);
    assert.match(helper, /assertFindingPolicyRows\(result\)/);
    assert.match(helper, /!bucket\.bucket_available[\s\S]{0,100}?bucket\.rows_json !== null/);

  });

  test('hotel drill-downs require a fresh narrowed server check and do not preactivate cached hotel state', () => {
    const acting = source('src/contexts/HotelActingContext.tsx');
    assert.match(acting, /const HOTEL_ACTING_CONTEXT_TIMEOUT_MS = 8_000/);
    assert.match(acting, /fetchWithAuth\(authorizationRequest\.endpoint,[\s\S]{0,180}?cache: 'no-store'/);
    assert.match(acting, /hotelActingContextMatchesRequest\(authorizationRequest, context\)/);
    assert.match(acting, /setSnapshot\(\{ requestIdentity, status: 'allowed', context/);

    const gate = source('src/components/layout/ActingContextBoundary.tsx');
    assert.match(gate, /if \(acting\.status === 'checking' \|\| acting\.status === 'inactive'\)/);
    assert.match(gate, /if \(acting\.status === 'error'\)/);
    assert.match(gate, /if \(acting\.status === 'denied'\)/);
    assert.match(
      gate,
      /if \(acting\.context\?\.source === 'portfolio'\)[\s\S]{0,2400}?\{children\}[\s\S]{0,1200}?acting\.context\?\.source === 'local'/,
    );

    const propertyContext = source('src/contexts/PropertyContext.tsx');
    assert.match(propertyContext, /portfolioScopeQuiescent = acting\?\.request\.kind === 'portfolio_scope'/);
    assert.match(
      propertyContext,
      /acting\?\.request\.kind === 'hotel'[\s\S]{0,100}?acting\.status === 'allowed'[\s\S]{0,100}?acting\.context\.property\.id/,
    );
    const propertyLoad = propertyContext.indexOf('getProperty(loadUserUid, loadActingHotelId)');
    const allowedGate = propertyContext.indexOf("acting.status === 'allowed'");
    assert.ok(allowedGate >= 0 && propertyLoad > allowedGate);
    assert.match(
      propertyContext,
      /if \(!userUid \|\| !propertyAuthorizationViewerKey \|\| authFlowActive \|\| portfolioScopeQuiescent\)[\s\S]{0,180}?setProperties\(\[\]\)/,
    );

    // Revocation is not the only transition to defend. React renders once with
    // the new active id before hotel-keyed effects can clear their old state,
    // so every provider value must suppress a snapshot whose identity/hotel key
    // no longer matches during that render. Late manual refreshes must be
    // discarded for the same reason.
    assert.match(
      propertyContext,
      /const exposedStaffSnapshot = staffViewerKey === expectedStaffViewerKey && expectedStaffViewerKey !== null/,
    );
    assert.match(
      propertyContext,
      /capabilitySnapshot\.viewerKey === expectedCapabilityViewerKey[\s\S]{0,100}?capabilitySnapshot\.propertyId === resolvedPropertyId/,
    );
    const refreshes = propertyContext.slice(propertyContext.indexOf('const refreshStaff'));
    assert.match(refreshes, /expectedStaffViewerKeyRef\.current !== refreshViewerKey/);
    assert.match(propertyContext, /expectedCapabilityViewerKeyRef\.current !== viewerKey/);

    const propertyReader = source('src/lib/db/properties.ts');
    assert.match(propertyReader, /readProperties\(`\?propertyId=\$\{encodeURIComponent\(pid\)\}`\)/);

    for (const path of [
      'src/app/portfolio/PortfolioHomeClient.tsx',
      'src/app/portfolio/[section]/PortfolioSectionClient.tsx',
    ]) {
      const text = source(path);
      assert.doesNotMatch(text, /onActivate:\s*\(\)\s*=>\s*setActivePropertyId/, path);
    }
  });
});
