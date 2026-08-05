import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  COMPANY_STRUCTURE_SCHEMA_VERSION,
  parseCompanyStructureProjection,
  validatePortfolioAssignmentCommitInput,
  validatePortfolioAssignmentInput,
  validateStructureIdempotencyKey,
} from '@/lib/company-access/structure';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROPERTY = '22222222-2222-4222-8222-222222222222';
const PORTFOLIO = '33333333-3333-4333-8333-333333333333';
const KEY = '44444444-4444-4444-8444-444444444444';
const FINGERPRINT = 'a'.repeat(64);

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

describe('company structure request contracts', () => {
  test('accepts an exact normalized portfolio assignment and sorts its ids', () => {
    const result = validatePortfolioAssignmentInput({
      organizationId: ORG,
      propertyId: PROPERTY,
      desiredPortfolioIds: [PORTFOLIO],
      expectedAccessEpoch: 7,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.desiredPortfolioIds, [PORTFOLIO]);
    assert.equal(result.value.expectedAccessEpoch, 7);
  });

  test('rejects guessed fields, duplicate ids, invalid epochs, and implicit confirmation', () => {
    assert.equal(validatePortfolioAssignmentInput({
      organizationId: ORG,
      propertyId: PROPERTY,
      desiredPortfolioIds: [],
      expectedAccessEpoch: 2,
      actorAccountId: ORG,
    }).ok, false);
    assert.equal(validatePortfolioAssignmentInput({
      organizationId: ORG,
      propertyId: PROPERTY,
      desiredPortfolioIds: [PORTFOLIO, PORTFOLIO],
      expectedAccessEpoch: 2,
    }).ok, false);
    assert.equal(validatePortfolioAssignmentInput({
      organizationId: ORG,
      propertyId: PROPERTY,
      desiredPortfolioIds: [],
      expectedAccessEpoch: 0,
    }).ok, false);
    assert.equal(validatePortfolioAssignmentCommitInput({
      organizationId: ORG,
      propertyId: PROPERTY,
      desiredPortfolioIds: [],
      expectedAccessEpoch: 2,
      previewFingerprint: FINGERPRINT,
      confirmed: false,
    }).ok, false);
  });

  test('requires a UUID idempotency key and exact preview fingerprint', () => {
    assert.equal(validateStructureIdempotencyKey(KEY).ok, true);
    assert.equal(validateStructureIdempotencyKey('retry-this').ok, false);
    assert.equal(validatePortfolioAssignmentCommitInput({
      organizationId: ORG,
      propertyId: PROPERTY,
      desiredPortfolioIds: [],
      expectedAccessEpoch: 2,
      previewFingerprint: FINGERPRINT,
      confirmed: true,
    }).ok, true);
    assert.equal(validatePortfolioAssignmentCommitInput({
      organizationId: ORG,
      propertyId: PROPERTY,
      desiredPortfolioIds: [],
      expectedAccessEpoch: 2,
      previewFingerprint: 'not-a-hash',
      confirmed: true,
    }).ok, false);
  });

  test('fails closed on malformed SECURITY DEFINER projections', () => {
    assert.equal(parseCompanyStructureProjection({
      schemaVersion: COMPANY_STRUCTURE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      organizations: [{ id: ORG, name: 'Unsafe Brand', type: 'brand' }],
    }), null);
    assert.equal(parseCompanyStructureProjection({
      schemaVersion: COMPANY_STRUCTURE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      organizations: [],
    })?.organizations.length, 0);
  });
});

describe('My Hotel structure surface contract', () => {
  const page = source('src', 'app', '(hotel)', 'company', 'page.tsx');
  const manager = source('src', 'app', '(hotel)', 'company', '_components', 'CompanyStructureManager.tsx');
  const migration = source('supabase', 'migrations', '0381_company_structure_management.sql');
  const previewRoute = source('src', 'app', 'api', 'company-access', 'structure', 'preview', 'route.ts');
  const commitRoute = source('src', 'app', 'api', 'company-access', 'structure', 'commit', 'route.ts');

  test('keeps exactly Hotels, People, and Access', () => {
    const tabBlock = page.slice(page.indexOf('const tabs = React.useMemo'), page.indexOf('React.useEffect(() => {', page.indexOf('const tabs = React.useMemo')));
    assert.deepEqual(
      [...tabBlock.matchAll(/id: '([^']+)'/g)].map((match) => match[1]),
      ['hotels', 'people', 'access'],
    );
    assert.doesNotMatch(tabBlock, /structure|portfolio|admin/i);
  });

  test('maps People to membership/invitations and Access to exact role/scope', () => {
    assert.match(page, /Memberships and invitations/);
    assert.match(page, /Invite company member/);
    assert.match(page, /AccessPersonRow/);
    assert.match(page, /People with hotel access/);
    assert.match(page, /buildAccessPeople\(/);
    assert.doesNotMatch(page, /Customer grants|Roles and scopes by person/);
    assert.match(page, /showGrantActions=\{false\}/);
    assert.match(page, /showMembershipActions=\{!adminPreview\}/);
    assert.doesNotMatch(page, /Company people/);
    assert.doesNotMatch(page, /Revocation is immediate and audited/);
  });

  test('requires impact preview and explicit confirmation in the existing Hotels tab', () => {
    assert.match(manager, /Preview access impact/);
    assert.match(manager, /confirmed: true/);
    assert.match(manager, /Idempotency-Key/);
    assert.match(manager, /takes effect immediately/);
    assert.match(manager, /Only a verified Staxis platform administrator can change or transfer it/);
    assert.doesNotMatch(page, /id: 'structure'|id: 'portfolio'/);
  });

  test('keeps structure load failures visible and the Hotels structure heading compact', () => {
    const managerSurface = manager.slice(manager.indexOf('export function CompanyStructureManager'));
    assert.match(page, /const \[structureError, setStructureError\]/);
    assert.match(page, /Company structure could not be loaded/);
    assert.match(page, /onStructureRetry=\{\(\) => setRetryKey\(\(value\) => value \+ 1\)\}/);
    assert.match(page, /disabled=\{structureLoading\}/);
    assert.match(managerSurface, /<h2 id="company-structure-management-title">\{'Company structure'\}<\/h2>/);
    assert.doesNotMatch(managerSurface, /Structure management|Company, portfolio, region, and hotel relationships|Portfolio assignments control inherited hotel reach|Audited access/);
  });

  test('keeps authorization, epoch, same-company topology, and audit inside SQL', () => {
    assert.match(migration, /security definer/g);
    assert.match(migration, /_staxis_nonlegacy_property_authorizations/);
    assert.match(migration, /_staxis_current_primary_property_relationships/);
    assert.match(migration, /active_primary_count = 1/);
    assert.match(migration, /portfolio\.organization_id = p_organization_id/);
    assert.match(migration, /v_epoch <> p_expected_access_epoch/);
    assert.match(migration, /_staxis_lock_organization/);
    assert.match(migration, /organization_access_events/);
    assert.match(migration, /company_structure_mutation_requests/);
    assert.match(migration, /idempotency key is already bound to a different request/);
  });

  test('does not expose customer relationship creation or cross-company transfer', () => {
    assert.match(migration, /DOES NOT expose customer RPCs/);
    assert.doesNotMatch(migration, /create or replace function public\.staxis_(?:create|set|transfer).*property_organization/);
    assert.match(migration, /organization_type in \('management_company', 'ownership_group'\)/);
    assert.match(migration, /actor cannot manage company portfolios/);
  });

  test('maps opaque-id denial and stale epochs without confirming foreign ids', () => {
    assert.match(previewRoute, /Company structure target not found/);
    assert.match(previewRoute, /You cannot change this hotel structure/);
    assert.match(commitRoute, /Company structure target not found/);
    assert.match(commitRoute, /The preview is stale/);
    assert.doesNotMatch(previewRoute, /organizationName|propertyName|portfolioName/);
    assert.doesNotMatch(commitRoute, /organizationName|propertyName|portfolioName/);
  });
});
