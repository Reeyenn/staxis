import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { buildCompanyAccessViewerKey } from '@/lib/company-access/viewer-key';

const baseIdentity = {
  uid: 'auth-user-a',
  accountId: 'account-a',
  role: 'owner',
  propertyAccess: ['hotel-b', 'hotel-a'],
  resolvedPropertyKey: 'hotel-a,hotel-b',
  adminTargetPropertyId: null,
} as const;

describe('company access viewer identity', () => {
  test('is order-insensitive for grants but changes for every authorization dimension', () => {
    const original = buildCompanyAccessViewerKey(baseIdentity);

    assert.equal(buildCompanyAccessViewerKey({
      ...baseIdentity,
      propertyAccess: ['hotel-a', 'hotel-b'],
    }), original);
    assert.equal(buildCompanyAccessViewerKey({
      ...baseIdentity,
      role: ' OWNER ',
      propertyAccess: ['hotel-a', 'hotel-b', 'hotel-a'],
    }), original);

    for (const changed of [
      { ...baseIdentity, uid: 'auth-user-b' },
      { ...baseIdentity, accountId: 'account-b' },
      { ...baseIdentity, role: 'general_manager' },
      { ...baseIdentity, propertyAccess: ['hotel-a'] },
      { ...baseIdentity, resolvedPropertyKey: 'hotel-a' },
    ]) {
      assert.notEqual(buildCompanyAccessViewerKey(changed), original);
    }
  });

  test('includes the selected preview target only for an admin viewer', () => {
    const admin = { ...baseIdentity, role: 'admin', propertyAccess: ['*'] };
    assert.notEqual(
      buildCompanyAccessViewerKey({ ...admin, adminTargetPropertyId: 'hotel-a' }),
      buildCompanyAccessViewerKey({ ...admin, adminTargetPropertyId: 'hotel-b' }),
    );

    assert.equal(
      buildCompanyAccessViewerKey({ ...baseIdentity, adminTargetPropertyId: 'hotel-a' }),
      buildCompanyAccessViewerKey({ ...baseIdentity, adminTargetPropertyId: 'hotel-b' }),
    );
  });

  test('stamps request results and masks the prior authorization identity synchronously', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/(hotel)/company/page.tsx'), 'utf8');

    assert.match(
      page,
      /const currentViewerKey = user[\s\S]*?uid: user\.uid[\s\S]*?accountId: user\.accountId[\s\S]*?role: user\.role[\s\S]*?propertyAccess: user\.propertyAccess[\s\S]*?resolvedPropertyKey: propertyKey[\s\S]*?adminTargetPropertyId:/,
    );
    assert.match(page, /const requestedViewerKey = currentViewerKey;/);
    assert.match(page, /setDataViewerKey\(requestedViewerKey\)/);
    assert.match(
      page,
      /const dataBelongsToCurrentViewer = Boolean\(currentViewerKey && dataViewerKey === currentViewerKey\)/,
    );
    assert.match(
      page,
      /const unscopedCurrentData = adminTargetIsCurrent[\s\S]*?&& dataBelongsToCurrentViewer[\s\S]*?&& adminDataMatchesSelection/,
    );
    assert.match(
      page,
      /const selectedPortfolioCompany = portfolioMode[\s\S]*?selectedOrganizationId === portfolio\.requestedOrganizationId/,
    );
    assert.match(
      page,
      /const currentData = portfolioMode[\s\S]*?selectCompanyAccessContext\([\s\S]*?selectedPortfolioCompany\.organizationId[\s\S]*?: unscopedCurrentData/,
    );
  });
});
