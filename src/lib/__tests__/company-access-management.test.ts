import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  COMPANY_ACCESS_EDITOR_SCHEMA_VERSION,
  parseCompanyAccessEditorProjection,
  validateCompanyAccessEditCommitInput,
  validateCompanyAccessEditInput,
  validateCompanyAccessEditorIdempotencyKey,
} from '@/lib/company-access/access-editor';

const ORG = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const HOTEL_A = '33333333-3333-4333-8333-333333333333';
const HOTEL_B = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';
const REVISION = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const GENERATED_AT = '2026-07-27T12:00:00.000Z';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

function validInput() {
  return {
    organizationId: ORG,
    membershipId: MEMBER,
    operation: 'replace',
    accessProfile: 'property_manager',
    scopeKind: 'selected_properties',
    portfolioId: null,
    propertyIds: [HOTEL_B, HOTEL_A],
    expiresAt: null,
    expectedAccessEpoch: 7,
    expectedAccessRevision: REVISION,
  };
}

describe('company access editor request contracts', () => {
  test('normalizes a bounded exact selected-hotel set', () => {
    const result = validateCompanyAccessEditInput(validInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.propertyIds, [HOTEL_A, HOTEL_B]);
    assert.equal(result.value.operation, 'replace');
  });

  test('rejects direct extras, duplicate ids, mismatched profiles, and implicit confirmation', () => {
    assert.equal(validateCompanyAccessEditInput({ ...validInput(), actorAccountId: ORG }).ok, false);
    assert.equal(validateCompanyAccessEditInput({
      ...validInput(), propertyIds: [HOTEL_A, HOTEL_A],
    }).ok, false);
    assert.equal(validateCompanyAccessEditInput({
      ...validInput(), accessProfile: 'organization_owner',
    }).ok, false);
    assert.equal(validateCompanyAccessEditCommitInput({
      ...validInput(), previewFingerprint: FINGERPRINT, confirmed: false,
    }).ok, false);
  });

  test('enforces expiration semantics and exact idempotency inputs', () => {
    assert.equal(validateCompanyAccessEditInput({
      ...validInput(), accessProfile: 'external_collaborator', expiresAt: null,
    }).ok, false);
    assert.equal(validateCompanyAccessEditInput({
      ...validInput(), accessProfile: 'organization_owner', scopeKind: 'organization',
      propertyIds: [], expiresAt: '2099-01-01T00:00:00.000Z',
    }).ok, false);
    assert.equal(validateCompanyAccessEditorIdempotencyKey(KEY).ok, true);
    assert.equal(validateCompanyAccessEditorIdempotencyKey('retry').ok, false);
  });

  test('fails closed on malformed SECURITY DEFINER projections', () => {
    assert.equal(parseCompanyAccessEditorProjection({
      schemaVersion: COMPANY_ACCESS_EDITOR_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      organizations: [{ id: ORG, name: 'Unsafe' }],
    }), null);
    assert.deepEqual(parseCompanyAccessEditorProjection({
      schemaVersion: COMPANY_ACCESS_EDITOR_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      organizations: [],
    })?.organizations, []);
  });

  test('accepts explicit membership-hat provenance and rejects ambiguous or invalid hat shapes', () => {
    const validProjection = {
      schemaVersion: COMPANY_ACCESS_EDITOR_SCHEMA_VERSION,
      generatedAt: GENERATED_AT,
      organizations: [{
        id: ORG,
        name: 'Example Management',
        accessEpoch: 7,
        profilePolicies: [],
        portfolios: [],
        properties: [{ id: HOTEL_A, name: 'Hotel A' }],
        memberships: [{
          id: MEMBER,
          accessRevision: REVISION,
          sourceKind: 'membership_hat',
          sourceRole: 'general_manager',
          sourceScope: 'property',
          canAdd: false,
          canReplace: true,
          blockedReason: null,
          currentGrants: [],
        }],
      }],
    };
    const parsed = parseCompanyAccessEditorProjection(validProjection);
    assert.equal(parsed?.organizations[0]?.memberships[0]?.sourceKind, 'membership_hat');

    const missingProvenance = structuredClone(validProjection);
    delete (missingProvenance.organizations[0].memberships[0] as Partial<{
      sourceKind: string;
    }>).sourceKind;
    assert.equal(parseCompanyAccessEditorProjection(missingProvenance), null);

    const mismatchedHat = structuredClone(validProjection);
    mismatchedHat.organizations[0].memberships[0].sourceRole = 'finance';
    assert.equal(parseCompanyAccessEditorProjection(mismatchedHat), null);

    const additiveHat = structuredClone(validProjection);
    additiveHat.organizations[0].memberships[0].canAdd = true;
    assert.equal(parseCompanyAccessEditorProjection(additiveHat), null);
  });
});

describe('existing Access-tab management surface contract', () => {
  const page = source('src', 'app', '(hotel)', 'company', 'page.tsx');
  const dialog = source('src', 'app', '(hotel)', 'company', '_components', 'AccessEditorDialog.tsx');
  const migration = source('supabase', 'migrations', '0383_company_access_management.sql');
  const bridgeMigration = source('supabase', 'migrations', '0390_authoritative_people_access_bridge.sql');
  const previewRoute = source('src', 'app', 'api', 'company-access', 'access-editor', 'preview', 'route.ts');
  const commitRoute = source('src', 'app', 'api', 'company-access', 'access-editor', 'commit', 'route.ts');

  test('adds existing-person editing without adding a fifth tab or page', () => {
    const tabBlock = page.slice(
      page.indexOf('const tabs = React.useMemo'),
      page.indexOf('React.useEffect(() => {', page.indexOf('const tabs = React.useMemo')),
    );
    assert.deepEqual(
      [...tabBlock.matchAll(/id: '([^']+)'/g)].map((match) => match[1]),
      ['hotels', 'people', 'access'],
    );
    assert.match(page, /Edit role and scope/);
    assert.match(page, /api\/company-access\/access-editor/);
    assert.match(dialog, /Replace current access/);
    assert.match(dialog, /Add another scope/);
    assert.match(dialog, /Selected hotels/);
  });

  test('requires server preview, explicit confirmation, revision, and idempotency', () => {
    assert.match(dialog, /Preview access impact/);
    assert.match(dialog, /previewFingerprint: preview\.previewFingerprint/);
    assert.match(dialog, /confirmed: true/);
    assert.match(dialog, /Idempotency-Key/);
    assert.match(migration, /p_expected_access_revision/);
    assert.match(migration, /_staxis_lock_organization/);
    assert.match(migration, /company_access_mutation_requests/);
    assert.match(migration, /company_access\.membership_grant_set_commit/);
    assert.match(bridgeMigration, /staxis_preview_company_access_edit_v2/);
    assert.match(bridgeMigration, /staxis_commit_company_access_edit_v2/);
    assert.match(bridgeMigration, /_staxis_preview_company_access_hat_conversion/);
    assert.match(bridgeMigration, /company-access-editor-v2/);
    assert.match(dialog, /This replaces the current [\s\S]* role with one normalized role and exact scope/);
  });

  test('keeps all opaque-id and authorization decisions server-side and converts hats atomically', () => {
    assert.match(migration, /_staxis_nonlegacy_property_authorizations/);
    assert.match(migration, /_staxis_current_primary_property_relationships/);
    assert.match(migration, /active_primary_count = 1/);
    assert.match(migration, /actor can no longer delegate this access/);
    assert.match(bridgeMigration, /sourceKind', 'membership_hat'/);
    assert.match(bridgeMigration, /update public\.organization_memberships[\s\S]*staxis_role = null/);
    assert.match(bridgeMigration, /company_access\.membership_hat_conversion_commit/);
    assert.match(bridgeMigration, /_staxis_guard_last_company_owner_hat/);
    assert.match(previewRoute, /You cannot edit this company access/);
    assert.match(commitRoute, /The preview is stale/);
    assert.doesNotMatch(previewRoute, /memberName|organizationName|hotelName/);
    assert.doesNotMatch(commitRoute, /memberName|organizationName|hotelName/);
  });
});
