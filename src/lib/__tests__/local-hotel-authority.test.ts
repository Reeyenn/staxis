import assert from 'node:assert/strict';
import test from 'node:test';

import { standingHasLocalHotelContext } from '@/lib/portfolio-ui/local-hotel-authority';

const PROPERTY_ID = '11111111-1111-4111-8111-111111111111';

function standing(
  kind: 'legacy' | 'legacy_bridge' | 'membership_hat' | 'access_grant',
  scopeType: 'company' | 'organization' | 'portfolio' | 'property' | null,
  accessProfile: string | null = null,
) {
  return {
    propertyId: PROPERTY_ID,
    entitlements: [{ kind, scopeType, accessProfile, staxisRole: null }],
  };
}

test('legacy, bridge, and property-scoped hats preserve deliberate local hotel entry', () => {
  assert.equal(standingHasLocalHotelContext(standing('legacy', null)), true);
  assert.equal(standingHasLocalHotelContext(standing('legacy_bridge', null)), true);
  assert.equal(standingHasLocalHotelContext(standing('membership_hat', 'property')), true);
});

test('only the property-manager normalized grant opens local hotel context', () => {
  assert.equal(standingHasLocalHotelContext(
    standing('access_grant', 'property', 'property_manager'),
  ), true);
  assert.equal(standingHasLocalHotelContext(
    standing('access_grant', 'property', 'portfolio_manager'),
  ), false);
});

test('company, organization, and portfolio reach never launders into local context', () => {
  for (const scopeType of ['company', 'organization', 'portfolio'] as const) {
    assert.equal(standingHasLocalHotelContext(
      standing('membership_hat', scopeType),
    ), false);
    assert.equal(standingHasLocalHotelContext(
      standing('access_grant', scopeType, 'organization_owner'),
    ), false);
  }
  assert.equal(standingHasLocalHotelContext(null), false);
  assert.equal(standingHasLocalHotelContext({ propertyId: PROPERTY_ID, entitlements: [] }), false);
});
