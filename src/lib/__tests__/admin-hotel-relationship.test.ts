import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  ADMIN_HOTEL_RELATIONSHIP_SCHEMA_VERSION,
  parseAdminHotelRelationshipProjection,
  validateAdminHotelRelationshipChange,
  validateAdminHotelRelationshipCommit,
  validateAdminHotelRelationshipIdempotencyKey,
  validateAdminHotelRelationshipQuery,
} from '@/lib/company-access/admin-hotel-relationship';

const HOTEL = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';
const REVISION = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

describe('admin hotel relationship request contracts', () => {
  test('accepts only exact company-managed or independent shapes', () => {
    assert.deepEqual(validateAdminHotelRelationshipChange({
      propertyId: HOTEL,
      targetOrganizationId: COMPANY,
      relationshipType: 'operator',
      expectedRelationshipRevision: REVISION,
    }), {
      ok: true,
      value: {
        propertyId: HOTEL,
        targetOrganizationId: COMPANY,
        relationshipType: 'operator',
        expectedRelationshipRevision: REVISION,
      },
    });
    assert.equal(validateAdminHotelRelationshipChange({
      propertyId: HOTEL,
      targetOrganizationId: null,
      relationshipType: null,
      expectedRelationshipRevision: REVISION,
    }).ok, true);
    assert.equal(validateAdminHotelRelationshipChange({
      propertyId: HOTEL,
      targetOrganizationId: null,
      relationshipType: 'operator',
      expectedRelationshipRevision: REVISION,
    }).ok, false);
    assert.equal(validateAdminHotelRelationshipChange({
      propertyId: HOTEL,
      targetOrganizationId: COMPANY,
      relationshipType: 'brand',
      expectedRelationshipRevision: REVISION,
    }).ok, false);
  });

  test('rejects extra authority fields and implicit confirmation', () => {
    assert.equal(validateAdminHotelRelationshipChange({
      propertyId: HOTEL,
      targetOrganizationId: COMPANY,
      relationshipType: 'owner',
      expectedRelationshipRevision: REVISION,
      actorAccountId: COMPANY,
    }).ok, false);
    assert.equal(validateAdminHotelRelationshipCommit({
      propertyId: HOTEL,
      targetOrganizationId: COMPANY,
      relationshipType: 'owner',
      expectedRelationshipRevision: REVISION,
      previewFingerprint: FINGERPRINT,
      confirmed: false,
    }).ok, false);
    assert.equal(validateAdminHotelRelationshipIdempotencyKey(KEY).ok, true);
    assert.equal(validateAdminHotelRelationshipIdempotencyKey('retry').ok, false);
  });

  test('bounds directory search and fails closed on malformed database JSON', () => {
    assert.equal(validateAdminHotelRelationshipQuery(HOTEL, ' Gulf ').ok, true);
    assert.equal(validateAdminHotelRelationshipQuery(HOTEL, 'x'.repeat(121)).ok, false);
    assert.equal(parseAdminHotelRelationshipProjection({
      schemaVersion: ADMIN_HOTEL_RELATIONSHIP_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      property: { id: HOTEL, name: 'Hotel', status: 'active' },
      lifecycleStatus: 'company_managed',
      currentRelationship: null,
      relationshipRevision: REVISION,
      organizationQuery: '',
      organizations: [],
      organizationResultLimit: 100,
      organizationResultsTruncated: false,
    }), null, 'company-managed status cannot omit the relationship');
  });
});

describe('existing /company Hotels-tab lifecycle surface', () => {
  const page = source('src', 'app', 'company', 'page.tsx');
  const component = source('src', 'app', 'company', '_components', 'AdminHotelRelationshipManager.tsx');
  const migration = source('supabase', 'migrations', '0384_admin_hotel_relationship_lifecycle.sql');
  const readRoute = source('src', 'app', 'api', 'admin', 'company-relationship', 'route.ts');
  const previewRoute = source('src', 'app', 'api', 'admin', 'company-relationship', 'preview', 'route.ts');
  const commitRoute = source('src', 'app', 'api', 'admin', 'company-relationship', 'commit', 'route.ts');

  test('keeps exactly Hotels, People, Access and renders lifecycle controls only in verified admin preview', () => {
    const tabBlock = page.slice(
      page.indexOf('const tabs = React.useMemo'),
      page.indexOf('React.useEffect(() => {', page.indexOf('const tabs = React.useMemo')),
    );
    assert.deepEqual(
      [...tabBlock.matchAll(/id: '([^']+)'/g)].map((match) => match[1]),
      ['hotels', 'people', 'access'],
    );
    assert.match(page, /data\.viewerContext\?\.kind === 'staxis_admin_preview'/);
    assert.match(page, /AdminHotelRelationshipManager/);
    assert.doesNotMatch(component, /adminToolsEnabled|Admin view is ON|Turn on Admin view/);
    assert.doesNotMatch(component, /Staxis platform administration/);
    assert.match(component, /Every lifecycle change starts with a fresh impact preview and explicit confirmation/);
    assert.match(component, /disabled=\{loading \|\| !projection\}/);
    assert.match(component, /Acquire and link hotel/);
    assert.match(component, /Deactivate company relationship/);
    assert.match(component, /Transfer hotel/);
    assert.match(component, /Change relationship type/);
  });

  test('independently gates every server route and every database operation as platform-admin-only', () => {
    for (const route of [readRoute, previewRoute, commitRoute]) {
      assert.match(route, /requireAdmin\(req\)/);
    }
    assert.match(migration, /_staxis_assert_active_platform_admin\(p_actor_account_id\)/);
    assert.match(migration, /actor\.role = 'admin'/);
    assert.match(migration, /actor\.active is true/);
    assert.match(migration, /check intentionally precedes idempotency replay/);
    assert.doesNotMatch(component, /accounts\.role|supabaseAdmin/);
  });

  test('requires a fresh preview, exact revision, confirmation, lock ordering, idempotency, and audit', () => {
    assert.match(component, /\/api\/admin\/company-relationship\/preview/);
    assert.match(component, /previewFingerprint: preview\.previewFingerprint/);
    assert.match(component, /confirmed: true/);
    assert.match(component, /Idempotency-Key/);
    assert.match(migration, /_staxis_admin_hotel_relationship_revision/);
    assert.match(migration, /p_expected_relationship_revision/);
    assert.match(migration, /p_preview_fingerprint/);
    assert.match(migration, /p_confirmed is not true/);
    assert.match(migration, /pg_advisory_xact_lock/);
    assert.match(migration, /_staxis_lock_organization/);
    assert.match(migration, /admin_hotel_relationship_mutation_requests/);
    assert.match(migration, /admin_hotel_relationship\.commit/);
  });

  test('uses bounded company search and does not expose customer identity data', () => {
    assert.match(migration, /ordinal <= 100/);
    assert.match(migration, /organizationResultsTruncated/);
    assert.match(component, /Narrow the search/);
    assert.doesNotMatch(migration.slice(
      migration.indexOf('staxis_admin_hotel_relationship_projection'),
      migration.indexOf('create or replace function public._staxis_preview_admin_hotel_relationship'),
    ), /email|membershipId|accountId/);
  });
});
