/**
 * Invariants for the capability resolver `can()` — the single shared path the
 * browser (useCan) and the server (canForProperty) both run.
 *
 * Locks in the rules from the spec:
 *   1. admin → true for every capability.
 *   2. admin-only capabilities are NEVER grantable to a hotel role — not even
 *      with an explicit allowed:true override.
 *   3. an allowed:false override beats the everyone-default (the restriction).
 *   4. default (no override) = every hotel role gets every hotel-facing cap,
 *      EXCEPT the manager-floor caps (money / pay / audit / settings / team mgmt),
 *      which default to owner/GM/admin only.
 *   5. the manager floor is OVERRIDE-PROOF: an allowed:true override can never
 *      grant a manager-floor cap to line staff.
 *   + overrides not loaded → fall back to defaults; admin-only stays closed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { can, type CapabilityOverrideMap } from '@/lib/capabilities/can';
import {
  CAPABILITY_KEYS,
  HOTEL_ROLES,
  MANAGER_FLOOR_CAPABILITIES,
  isAdminOnlyCapability,
  type CapabilityKey,
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
  // Manager-floor caps (money / pay / audit / settings / team mgmt) are
  // manager-only by default (security audit 2026-06-18, extended 2026-06-26) —
  // every OTHER hotel-facing cap keeps the everyone-default. Derived from the
  // registry so this set can never drift from the real floor.
  const MANAGER_ONLY_DEFAULT = MANAGER_FLOOR_CAPABILITIES;
  const LINE_STAFF_ROLES = ['front_desk', 'housekeeping', 'maintenance'];

  it('with no overrides, every hotel role has every hotel-facing cap (except manager-floor caps, which are manager-only)', () => {
    for (const cap of HOTEL_CAPS) {
      for (const role of HOTEL_ROLES) {
        const expected = !(MANAGER_ONLY_DEFAULT.has(cap) && LINE_STAFF_ROLES.includes(role));
        assert.equal(can({ role }, cap), expected, `${role} default-have ${cap} should be ${expected}`);
        assert.equal(can({ role }, cap, undefined), expected);
        assert.equal(can({ role }, cap, {}), expected);
      }
    }
  });
  it('manager-floor caps are owner/GM only by default (line staff denied)', () => {
    for (const cap of MANAGER_ONLY_DEFAULT) {
      for (const role of LINE_STAFF_ROLES) {
        assert.equal(can({ role }, cap), false, `${role} must NOT default-have ${cap}`);
      }
      assert.equal(can({ role: 'owner' }, cap), true, `owner should default-have ${cap}`);
      assert.equal(can({ role: 'general_manager' }, cap), true, `general_manager should default-have ${cap}`);
    }
  });
  it('the manager floor covers the sensitive caps it should (wages/financials/audit/settings/team)', () => {
    for (const cap of ['view_wages', 'view_financials', 'view_activity_log', 'manage_settings', 'manage_team', 'manage_users'] as CapabilityKey[]) {
      assert.equal(MANAGER_FLOOR_CAPABILITIES.has(cap), true, `${cap} should be a manager-floor cap`);
    }
    // A clearly line-staff-safe cap must NOT be floored.
    assert.equal(MANAGER_FLOOR_CAPABILITIES.has('use_packages'), false);
  });
  it('legacy staff role gets the everyone-default for hotel caps except manager-floor caps', () => {
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
    // use_packages is an everyone-default (non-floored) cap.
    const overrides: CapabilityOverrideMap = { use_packages: { housekeeping: false } };
    assert.equal(can({ role: 'housekeeping' }, 'use_packages', overrides), false);
    // Other roles at this hotel keep the default.
    assert.equal(can({ role: 'front_desk' }, 'use_packages', overrides), true);
    assert.equal(can({ role: 'owner' }, 'use_packages', overrides), true);
    // Other capabilities for the restricted role keep the default.
    assert.equal(can({ role: 'housekeeping' }, 'assign_work', overrides), true);
    // Admin is unaffected by any override.
    assert.equal(can({ role: 'admin' }, 'use_packages', overrides), true);
  });
  it('an allowed:true override is honored for a non-floored cap (idempotent re-allow)', () => {
    const overrides: CapabilityOverrideMap = { manage_inventory_orders: { maintenance: true } };
    assert.equal(can({ role: 'maintenance' }, 'manage_inventory_orders', overrides), true);
  });
});

describe('can() — manager floor is override-proof (security)', () => {
  const LINE_STAFF_ROLES = ['front_desk', 'housekeeping', 'maintenance', 'staff'];
  it('an allowed:true override can NEVER grant a manager-floor cap to line staff', () => {
    for (const cap of MANAGER_FLOOR_CAPABILITIES) {
      for (const role of LINE_STAFF_ROLES) {
        // Closed by default.
        assert.equal(can({ role }, cap), false, `${role} must not default-have ${cap}`);
        // And a stray allowed:true override cannot lift it.
        const grant: CapabilityOverrideMap = { [cap]: { [role]: true } };
        assert.equal(can({ role }, cap, grant), false, `override must NOT grant ${cap} to ${role}`);
      }
    }
  });
  it('owner / GM keep manager-floor caps by default, and an admin can still restrict a manager further', () => {
    for (const cap of MANAGER_FLOOR_CAPABILITIES) {
      assert.equal(can({ role: 'owner' }, cap), true);
      assert.equal(can({ role: 'general_manager' }, cap), true);
      // A false override restricts a MANAGER further (allowed — admin can do this).
      const denyOwner: CapabilityOverrideMap = { [cap]: { owner: false } };
      assert.equal(can({ role: 'owner' }, cap, denyOwner), false, `admin can restrict owner for ${cap}`);
    }
  });
  it('admin keeps every manager-floor cap regardless of overrides', () => {
    for (const cap of MANAGER_FLOOR_CAPABILITIES) {
      assert.equal(can({ role: 'admin' }, cap), true);
      const deny: CapabilityOverrideMap = { [cap]: {} };
      assert.equal(can({ role: 'admin' }, cap, deny), true);
    }
  });
});

describe('can() — overrides not yet loaded', () => {
  it('falls back to defaults for non-floored hotel caps; floored + admin-only stay closed', () => {
    // Non-floored cap falls back to the everyone-default.
    assert.equal(can({ role: 'housekeeping' }, 'use_packages', undefined), true);
    // Manager-floor cap stays closed to line staff even with no overrides loaded.
    assert.equal(can({ role: 'housekeeping' }, 'view_financials', undefined), false);
    assert.equal(can({ role: 'housekeeping' }, 'view_wages', undefined), false);
    // Admin-only stays closed.
    assert.equal(can({ role: 'housekeeping' }, 'access_admin', undefined), false);
  });
});
