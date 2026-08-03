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

describe('admin hotel relationship backend lifecycle contracts', () => {
  const migration = source('supabase', 'migrations', '0384_admin_hotel_relationship_lifecycle.sql');
  const readRoute = source('src', 'app', 'api', 'admin', 'company-relationship', 'route.ts');
  const previewRoute = source('src', 'app', 'api', 'admin', 'company-relationship', 'preview', 'route.ts');
  const commitRoute = source('src', 'app', 'api', 'admin', 'company-relationship', 'commit', 'route.ts');

  test('independently gates every server route and every database operation as platform-admin-only', () => {
    for (const route of [readRoute, previewRoute, commitRoute]) {
      assert.match(route, /requireAdmin\(req\)/);
    }
    assert.match(migration, /_staxis_assert_active_platform_admin\(p_actor_account_id\)/);
    assert.match(migration, /actor\.role = 'admin'/);
    assert.match(migration, /actor\.active is true/);
    assert.match(migration, /check intentionally precedes idempotency replay/);
  });

  test('requires a fresh preview, exact revision, confirmation, lock ordering, idempotency, and audit', () => {
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
    assert.doesNotMatch(migration.slice(
      migration.indexOf('staxis_admin_hotel_relationship_projection'),
      migration.indexOf('create or replace function public._staxis_preview_admin_hotel_relationship'),
    ), /email|membershipId|accountId/);
  });
});
