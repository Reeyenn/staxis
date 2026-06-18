/**
 * Invariants for the capability resolver `can()` — the single shared path the
 * browser (useCan) and the server (canForProperty) both run.
 *
 * Locks in the four rules from the spec:
 *   1. admin → true for every capability.
 *   2. admin-only capabilities are NEVER grantable to a hotel role — not even
 *      with an explicit allowed:true override.
 *   3. an allowed:false override beats the everyone-default (the restriction).
 *   4. default (no override) = every hotel role gets every hotel-facing cap.
 *   + overrides not loaded → fall back to defaults; admin-only stays closed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { can, type CapabilityOverrideMap } from '@/lib/capabilities/can';
import {
  CAPABILITY_KEYS,
  HOTEL_ROLES,
  isAdminOnlyCapability,
} from '@/lib/capabilities/registry';

const ADMIN_CAPS = CAPABILITY_KEYS.filter(isAdminOnlyCapability);
const HOTEL_CAPS = CAPABILITY_KEYS.filter((k) => !isAdminOnlyCapability(k));

describe('can() — admin', () => {
  it('admin gets every capability (hotel + admin-only)', () => {
    for (const cap of CAPABILITY_KEYS) {
      assert.equal(can({ role: 'admin' }, cap), true, `admin should have ${cap}`);
      assert.equal(can({ role: 'admin' }, cap, {}), true);
    }
  });
});

describe('can() — admin-only capabilities are never grantable', () => {
  it('every hotel role is denied admin-only caps, even with an allowed:true override', () => {
    for (const cap of ADMIN_CAPS) {
      for (const role of HOTEL_ROLES) {
        assert.equal(can({ role }, cap), false, `${role} must not have ${cap}`);
        const grant: CapabilityOverrideMap = { [cap]: { [role]: true } };
        assert.equal(can({ role }, cap, grant), false, `override must not grant ${cap} to ${role}`);
      }
    }
  });
  it('staff (legacy) and unknown roles are denied admin-only caps', () => {
    for (const cap of ADMIN_CAPS) {
      assert.equal(can({ role: 'staff' }, cap), false);
      assert.equal(can({ role: 'nonsense' }, cap), false);
      assert.equal(can({ role: null }, cap), false);
    }
  });
});

describe('can() — everyone-everything default', () => {
  // Account/credential-management caps are manager-only by default (security
  // audit 2026-06-18) — every OTHER hotel-facing cap keeps the everyone-default.
  const MANAGER_ONLY_DEFAULT = new Set(['manage_team', 'manage_users']);
  const LINE_STAFF_ROLES = ['front_desk', 'housekeeping', 'maintenance'];

  it('with no overrides, every hotel role has every hotel-facing cap (except account-management, which is manager-only)', () => {
    for (const cap of HOTEL_CAPS) {
      for (const role of HOTEL_ROLES) {
        const expected = !(MANAGER_ONLY_DEFAULT.has(cap) && LINE_STAFF_ROLES.includes(role));
        assert.equal(can({ role }, cap), expected, `${role} default-have ${cap} should be ${expected}`);
        assert.equal(can({ role }, cap, undefined), expected);
        assert.equal(can({ role }, cap, {}), expected);
      }
    }
  });
  it('account-management caps (manage_team/manage_users) are manager-only by default', () => {
    for (const cap of MANAGER_ONLY_DEFAULT) {
      for (const role of LINE_STAFF_ROLES) {
        assert.equal(can({ role }, cap), false, `${role} must NOT default-have ${cap}`);
      }
      assert.equal(can({ role: 'owner' }, cap), true, `owner should default-have ${cap}`);
      assert.equal(can({ role: 'general_manager' }, cap), true, `general_manager should default-have ${cap}`);
    }
  });
  it('legacy staff role gets the everyone-default for hotel caps except account-management', () => {
    for (const cap of HOTEL_CAPS) {
      assert.equal(can({ role: 'staff' }, cap), !MANAGER_ONLY_DEFAULT.has(cap));
    }
  });
  it('null / unknown role gets nothing', () => {
    assert.equal(can({ role: null }, 'view_financials'), false);
    assert.equal(can({ role: undefined }, 'view_financials'), false);
    assert.equal(can(null, 'view_financials'), false);
    assert.equal(can({ role: 'ghost' }, 'view_financials'), false);
  });
});

describe('can() — allowed:false beats the default (the restriction)', () => {
  it('a false override denies exactly that (capability, role) and nothing else', () => {
    const overrides: CapabilityOverrideMap = { view_financials: { housekeeping: false } };
    assert.equal(can({ role: 'housekeeping' }, 'view_financials', overrides), false);
    // Other roles at this hotel keep the default.
    assert.equal(can({ role: 'front_desk' }, 'view_financials', overrides), true);
    assert.equal(can({ role: 'owner' }, 'view_financials', overrides), true);
    // Other capabilities for the restricted role keep the default.
    assert.equal(can({ role: 'housekeeping' }, 'view_wages', overrides), true);
    // Admin is unaffected by any override.
    assert.equal(can({ role: 'admin' }, 'view_financials', overrides), true);
  });
  it('an allowed:true override is honored (idempotent re-allow)', () => {
    const overrides: CapabilityOverrideMap = { view_wages: { maintenance: true } };
    assert.equal(can({ role: 'maintenance' }, 'view_wages', overrides), true);
  });
});

describe('can() — overrides not yet loaded', () => {
  it('falls back to defaults for hotel caps and stays closed for admin-only', () => {
    assert.equal(can({ role: 'housekeeping' }, 'view_financials', undefined), true);
    assert.equal(can({ role: 'housekeeping' }, 'access_admin', undefined), false);
  });
});
