/**
 * Client/server parity for capability resolution.
 *
 * The browser gate (useCan) and the server gate (canForProperty) both delegate
 * to the SAME pure can(), so given identical inputs they MUST return identical
 * verdicts — that is what prevents "show the button, then 403".
 *
 * This test pins that by cross-checking can() against an INDEPENDENT reference
 * implementation of the spec's resolution order across the full
 * capability × role × override matrix. If can() ever drifts from the spec, the
 * two diverge and this fails. (canForProperty itself only adds a supabaseAdmin
 * read in front of the very same can(), so we exercise the shared core here.)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { can, type CapabilityOverrideMap } from '@/lib/capabilities/can';
import {
  CAPABILITY_KEYS,
  CAPABILITY_META,
  HOTEL_ROLES,
  ROLE_DEFAULTS,
  isHotelRole,
  type CapabilityKey,
} from '@/lib/capabilities/registry';
import type { AppRole } from '@/lib/roles';

// Independent reference resolver — the spec order, written from scratch.
function reference(
  role: AppRole | string | null,
  cap: CapabilityKey,
  overrides?: CapabilityOverrideMap,
): boolean {
  const meta = CAPABILITY_META[cap];
  if (!meta || meta.adminOnly) return role === 'admin';
  if (role === 'admin') return true;
  if (overrides && role && isHotelRole(role)) {
    const r = overrides[cap];
    if (r && Object.prototype.hasOwnProperty.call(r, role)) return r[role] === true;
  }
  return !!role && (ROLE_DEFAULTS[cap] as readonly string[]).includes(role);
}

const ROLES: (AppRole | string | null)[] = [
  ...HOTEL_ROLES, 'admin', 'staff', 'ghost', null,
];

// A spread of override maps to exercise the override branch from every angle.
const OVERRIDE_MAPS: CapabilityOverrideMap[] = [
  {},
  { view_financials: { housekeeping: false } },
  { view_wages: { front_desk: false, maintenance: false } },
  { use_packages: { owner: false }, manage_inventory_orders: { housekeeping: false } },
  // An (illegal-but-defensive) attempt to grant an admin-only cap — must be ignored by both.
  { access_admin: { owner: true }, manage_pms_coverage: { general_manager: true } },
];

describe('resolver parity: can() matches the reference across the full matrix', () => {
  it('agrees for every (role, capability, overrides) combination', () => {
    let checks = 0;
    for (const overrides of OVERRIDE_MAPS) {
      for (const cap of CAPABILITY_KEYS) {
        for (const role of ROLES) {
          const a = can(role == null ? null : { role }, cap, overrides);
          const b = reference(role, cap, overrides);
          assert.equal(a, b, `mismatch role=${role} cap=${cap} overrides=${JSON.stringify(overrides)}: can()=${a} ref=${b}`);
          checks++;
        }
      }
    }
    assert.ok(checks > 0);
  });

  it('is a pure function of (role, capability, overrides) — deterministic', () => {
    const overrides: CapabilityOverrideMap = { view_financials: { housekeeping: false } };
    for (let i = 0; i < 5; i++) {
      assert.equal(can({ role: 'housekeeping' }, 'view_financials', overrides), false);
      assert.equal(can({ role: 'front_desk' }, 'view_financials', overrides), true);
    }
  });
});
