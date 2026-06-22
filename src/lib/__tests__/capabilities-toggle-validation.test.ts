/**
 * Validation invariants the Access toggle API relies on
 * (/api/admin/access/toggle). The route accepts a write only when the capability
 * is a known, NON-admin-only key and the role is one of the 5 hotel roles. These
 * guards are the gate that stops an override row from ever granting/restricting a
 * Staxis-internal capability, or targeting a non-hotel role.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isCapabilityKey,
  isHotelRole,
  isAdminOnlyCapability,
  CAPABILITY_KEYS,
  HOTEL_ROLES,
} from '@/lib/capabilities/registry';

// Mirror of the toggle route's accept rule (kept in lockstep with route.ts).
function toggleWouldAccept(capability: unknown, role: unknown): boolean {
  if (!isCapabilityKey(capability)) return false;
  if (isAdminOnlyCapability(capability)) return false; // never grantable/restrictable
  if (!isHotelRole(role)) return false;
  return true;
}

describe('isCapabilityKey', () => {
  it('accepts every registered key and rejects junk', () => {
    for (const k of CAPABILITY_KEYS) assert.equal(isCapabilityKey(k), true);
    for (const k of ['', 'nope', 'view_financial', 'admin', null, undefined, 42, {}]) {
      assert.equal(isCapabilityKey(k as unknown), false);
    }
  });
});

describe('isHotelRole', () => {
  it('accepts the 5 hotel roles only — not admin, not staff', () => {
    for (const r of HOTEL_ROLES) assert.equal(isHotelRole(r), true);
    for (const r of ['admin', 'staff', '', 'manager', null, undefined, 7]) {
      assert.equal(isHotelRole(r as unknown), false);
    }
  });
});

describe('isAdminOnlyCapability', () => {
  it('flags exactly the Staxis-internal capabilities', () => {
    assert.equal(isAdminOnlyCapability('access_admin'), true);
    assert.equal(isAdminOnlyCapability('manage_pms_coverage'), true);
    assert.equal(isAdminOnlyCapability('view_financials'), false);
    assert.equal(isAdminOnlyCapability('manage_knowledge'), false);
  });
});

describe('toggle accept rule', () => {
  it('rejects admin-only capabilities for every hotel role', () => {
    for (const cap of ['access_admin', 'manage_pms_coverage']) {
      for (const role of HOTEL_ROLES) assert.equal(toggleWouldAccept(cap, role), false);
    }
  });
  it('rejects unknown capabilities and non-hotel roles', () => {
    assert.equal(toggleWouldAccept('made_up', 'owner'), false);
    assert.equal(toggleWouldAccept('view_financials', 'admin'), false);
    assert.equal(toggleWouldAccept('view_financials', 'staff'), false);
    assert.equal(toggleWouldAccept('view_financials', 'nobody'), false);
  });
  it('accepts a real hotel capability for a real hotel role', () => {
    assert.equal(toggleWouldAccept('view_financials', 'housekeeping'), true);
    assert.equal(toggleWouldAccept('manage_inventory_orders', 'front_desk'), true);
  });
});
