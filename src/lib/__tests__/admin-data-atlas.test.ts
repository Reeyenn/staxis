import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildAtlasHotels,
  groupAtlasSchema,
  summarizeReportService,
  type AtlasPropertyRow,
} from '@/lib/admin-data-atlas';

const property: AtlasPropertyRow = {
  id: 'hotel-1',
  name: 'Harbor Hotel',
  total_rooms: 42,
  subscription_status: 'active',
  property_kind: 'hotel',
  pms_type: 'choice_advantage',
  onboarding_completed_at: '2026-01-01T00:00:00.000Z',
  enabled_sections: { inventory: false },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-07-31T00:00:00.000Z',
};

describe('database atlas schema grouping', () => {
  test('keeps an unknown future table visible in Other', () => {
    const domains = groupAtlasSchema([
      { tablename: 'properties', rls_enabled: true, policy_count: 2, has_tenant_column: true },
      { tablename: 'future_magic_table', rls_enabled: true, policy_count: 0, has_tenant_column: false },
    ]);

    assert.deepEqual(domains.find((domain) => domain.id === 'hotels-access')?.tables, ['properties']);
    assert.deepEqual(domains.find((domain) => domain.id === 'other')?.tables, ['future_magic_table']);
  });

  test('reports policy coverage as a count without inventing a security verdict', () => {
    const [domain] = groupAtlasSchema([
      { tablename: 'work_orders', rls_enabled: true, policy_count: 3, has_tenant_column: true },
      { tablename: 'equipment', rls_enabled: true, policy_count: 0, has_tenant_column: true },
    ]);

    assert.equal(domain.id, 'maintenance');
    assert.deepEqual(domain.security, {
      rlsEnabled: 2,
      withPolicies: 1,
      directTenantColumn: 2,
    });
    assert.equal('secure' in domain.security, false);
  });

  test('deduplicates table names from a defensive live read', () => {
    const domains = groupAtlasSchema([
      { tablename: 'inventory', rls_enabled: true, policy_count: 1, has_tenant_column: true },
      { tablename: 'inventory', rls_enabled: false, policy_count: 0, has_tenant_column: false },
    ]);
    assert.deepEqual(domains.find((domain) => domain.id === 'inventory')?.tables, ['inventory']);
  });

  test('keeps guest packages, AI supply models, and product reports in their real groups', () => {
    const domains = groupAtlasSchema([
      { tablename: 'packages', rls_enabled: true, policy_count: 1, has_tenant_column: true },
      { tablename: 'supply_predictions', rls_enabled: true, policy_count: 1, has_tenant_column: true },
      { tablename: 'report_runs', rls_enabled: true, policy_count: 1, has_tenant_column: true },
    ]);

    assert.deepEqual(domains.find((domain) => domain.id === 'messages')?.tables, ['packages']);
    assert.deepEqual(domains.find((domain) => domain.id === 'ai-intelligence')?.tables, ['supply_predictions']);
    assert.deepEqual(domains.find((domain) => domain.id === 'reports-exports')?.tables, ['report_runs']);
  });
});

describe('database atlas hotel truth', () => {
  test('distinguishes a successful no-expectations read from a health failure', () => {
    const withoutExpectations = buildAtlasHotels({
      properties: [property],
      activeStaff: [],
      propertyHealth: [],
    });
    const unavailable = buildAtlasHotels({
      properties: [property],
      activeStaff: null,
      propertyHealth: null,
    });

    assert.equal(withoutExpectations[0].report.state, 'no_expectations');
    assert.equal(withoutExpectations[0].activeStaff, 0);
    assert.equal(unavailable[0].report.state, 'unknown');
    assert.equal(unavailable[0].activeStaff, null);
  });

  test('uses the canonical database feed state and returns only aggregate hotel facts', () => {
    const [hotel] = buildAtlasHotels({
      properties: [property],
      activeStaff: [
        { id: 'staff-1', property_id: property.id },
        { id: 'staff-2', property_id: property.id },
      ],
      propertyHealth: [{
        property_id: property.id,
        worst_state: 'stale',
        feeds_total: 5,
        feeds_live: 4,
        feeds_stale: 1,
        feeds_learning: 0,
        feeds_unavailable: 0,
        required_feeds_degraded: 1,
        newest_signal_at: '2026-07-31T19:00:00.000Z',
        worst_minutes_late: 70,
        open_quarantine_total: 2,
        open_unmapped_total: 1,
      }],
    });

    assert.equal(hotel.report.state, 'stale');
    assert.equal(hotel.report.feedCount, 5);
    assert.equal(hotel.report.liveFeeds, 4);
    assert.equal(hotel.activeStaff, 2);
    assert.equal(hotel.enabledSectionCount, 7);
    assert.ok(hotel.report.warnings.some((warning) => warning.includes('required feed')));
    assert.equal('staffNames' in hotel, false);
  });

  test('does not call an empty or unreadable report-health result healthy', () => {
    assert.equal(summarizeReportService([]).status, 'setup');
    assert.equal(summarizeReportService(null).status, 'unknown');
  });

  test('treats deliberately disabled scheduled feeds as setup, not an outage', () => {
    const health = [{
      property_id: property.id,
      worst_state: 'unavailable',
      feeds_total: 2,
      feeds_live: 0,
      feeds_stale: 0,
      feeds_learning: 0,
      feeds_unavailable: 2,
      required_feeds_degraded: 0,
      newest_signal_at: null,
      worst_minutes_late: null,
      open_quarantine_total: 0,
      open_unmapped_total: 0,
    }];

    const [hotel] = buildAtlasHotels({ properties: [property], activeStaff: [], propertyHealth: health });
    assert.equal(hotel.report.state, 'unavailable');
    assert.deepEqual(hotel.report.warnings, []);
    assert.equal(summarizeReportService(health).status, 'setup');
  });
});

describe('database atlas route security contract', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'app', 'api', 'admin', 'data-atlas', 'route.ts'),
    'utf8',
  );

  test('authenticates a human admin before the first database read', () => {
    const authCall = source.indexOf('await requireAdmin(req)');
    const databaseRead = source.indexOf('await Promise.allSettled([');
    assert.ok(authCall >= 0);
    assert.ok(databaseRead > authCall);
    assert.doesNotMatch(source, /requireAdminOrCron|requireCronSecret/);
  });

  test('is GET-only, dynamic, and private no-store', () => {
    assert.match(source, /export const dynamic = ['"]force-dynamic['"]/);
    assert.match(source, /private, no-store, max-age=0/);
    assert.match(source, /export async function GET/);
    assert.doesNotMatch(source, /export async function (POST|PUT|PATCH|DELETE)/);
  });

  test('uses fixed metadata fields and performs no mutation or sample-row read', () => {
    assert.doesNotMatch(source, /\.select\(['"]\*['"]/);
    assert.doesNotMatch(source, /\.(insert|update|upsert|delete)\s*\(/);
    assert.doesNotMatch(source, /\.storage\.|auth\.admin/);
    assert.match(source, /tablename, rls_enabled, policy_count, has_tenant_column/);
    assert.match(source, /id, property_id/);
  });

  test('does not expose sensitive identity or report-content fields', () => {
    for (const forbidden of [
      'phone', 'email', 'hourly_wage', 'storage_path', 'content_sha256',
      'message_id', 'sender', 'subject', 'raw_content', 'stripe_customer_id',
    ]) {
      const selectedField = new RegExp(`(?:['"]|,\\s*)${forbidden}(?:\\s*,|['"])`);
      assert.doesNotMatch(source, selectedField, `route must not select ${forbidden}`);
    }
  });
});
