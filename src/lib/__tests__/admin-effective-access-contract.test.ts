import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { isLiveCapability } from '@/lib/capabilities/registry';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Admin authoritative permission integration', () => {
  it('replaces the property page legacy-array roster with the authoritative projection', () => {
    const page = source('src/app/(admin)/admin/properties/[id]/page.tsx');
    assert.match(page, /<AdminEffectiveAccess propertyId=\{propertyId\}/);
    assert.doesNotMatch(page, /propertyAccess\.includes\(propertyId\)/);
    assert.doesNotMatch(page, /\/api\/auth\/accounts/);
  });

  it('builds access rows from the authoritative roster and resolver', () => {
    const server = source('src/lib/company-access/admin-effective-access-server.ts');
    assert.match(server, /loadAuthoritativeHotelRoster\(propertyId, false\)/);
    assert.match(server, /listAuthoritativePropertyAccess\(account\.id\)/);
    assert.match(server, /standing\.entitlements/);
    assert.match(server, /standing\.portfolioIntelligenceRead/);
    assert.match(server, /standing\.seesFinancials/);
    assert.match(server, /loadOverridesForPropertyFresh/);
    assert.match(server, /organization_access_epochs/);
    assert.match(server, /resolveOrganizationPropertyTopology\(organizationId, now\)/);
    assert.match(server, /resolveCompanyForProperty\(propertyId\)/);
    assert.doesNotMatch(
      server,
      /targetEntitlements[\s\S]{0,300}?const organizationId/,
      'hotel company AI settings must come from topology, not current roster members',
    );
  });

  it('keeps global AI configuration separate from the company permission row', () => {
    const server = source('src/lib/company-access/admin-effective-access-server.ts');
    const route = source('src/app/api/admin/effective-access/route.ts');
    assert.match(server, /resolveAiFeatureConfig\('agent\.portfolio_chat'\)/);
    assert.match(server, /companyAccessSetting\(organizationId, 'cross_hotel_ai_chat'\)/);
    assert.match(route, /saveCompanyAccessSettings/);
    assert.match(route, /cross_hotel_ai_chat/);
  });

  it('keeps the projection and company setting platform-admin protected and no-store', () => {
    const route = source('src/app/api/admin/effective-access/route.ts');
    assert.match(route, /requireAdmin\(req\)/);
    assert.match(route, /Cache-Control': 'no-store, max-age=0'/);
  });

  it('uses the guarded authoritative mutations and refreshes from server truth', () => {
    const component = source('src/app/admin/_components/AdminEffectiveAccess.tsx');
    const route = source('src/app/api/admin/effective-access/route.ts');
    assert.match(component, /\/api\/admin\/effective-access/);
    assert.match(component, /\/api\/auth\/team\?hotelId=/);
    assert.match(route, /staxis_end_membership_hat_guarded/);
    assert.match(route, /guarded_membership_receipt_invalid/);
    assert.match(component, /if \(onChanged\) await onChanged\(\);\s*else await load\(\);/);
  });

  it('does not expose the ungated Lost & Found capability as a live toggle', () => {
    assert.equal(isLiveCapability('use_lost_and_found'), false);
    assert.equal(isLiveCapability('use_complaints'), true);
    const matrix = source('src/app/api/admin/access/matrix/route.ts');
    const toggle = source('src/app/api/admin/access/toggle/route.ts');
    assert.match(matrix, /filter\(\(m\) => m\.adminOnly \|\| isLiveCapability\(m\.key\)\)/);
    assert.match(toggle, /!isLiveCapability\(capability\)/);
  });
});
