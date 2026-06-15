// ═══════════════════════════════════════════════════════════════════════════
// can() — the capability resolver. PURE + ISOMORPHIC: the exact same function
// decides access on the browser (via useCan) and on the server (via
// canForProperty in ./server). That single shared path is what guarantees the
// client never shows a button the server then 403s.
//
// Keep this file free of `server-only` and of any I/O — ./server.ts owns the
// supabaseAdmin reads and may not be imported from client components.
// ═══════════════════════════════════════════════════════════════════════════

import type { AppRole } from '@/lib/roles';
import {
  CAPABILITY_META,
  ROLE_DEFAULTS,
  isHotelRole,
  type CapabilityKey,
  type HotelRole,
} from './registry';

/** What an admin's restriction looks like once loaded for one hotel:
 *  capability → role → allowed. Only `false` rows are ever written in practice
 *  (a restriction); `true` is handled too so the resolver is idempotent. */
export type CapabilityOverrideMap = Partial<
  Record<CapabilityKey, Partial<Record<HotelRole, boolean>>>
>;

/** Minimal user shape the resolver needs — AppUser (client) and a server-resolved
 *  `{ role }` both satisfy it. */
export interface CapUser {
  role: AppRole | string | null | undefined;
}

/**
 * Decide whether `user` may use `capability` at a hotel, given that hotel's
 * loaded override map. Resolution order (fixed — see registry header):
 *
 *   (a) admin-only capability  → true ONLY if role === 'admin'. Never grantable
 *       to a hotel role by any override. (Closed even when overrides are absent.)
 *   (b) role === 'admin'       → true for every non-admin-only capability.
 *   (c) explicit override for this hotel's (capability, role) → use its `allowed`
 *       (a `false` here is the restriction — it beats the everyone-default).
 *   (d) otherwise              → ROLE_DEFAULTS (every hotel role gets everything).
 *
 * `overrides` undefined / not-yet-loaded → step (c) is skipped and we fall back
 * to defaults; admin-only still stays closed. We never fail open past defaults.
 */
export function can(
  user: CapUser | null | undefined,
  capability: CapabilityKey,
  overrides?: CapabilityOverrideMap | null,
): boolean {
  const role = user?.role ?? null;
  const meta = CAPABILITY_META[capability];

  // (a) Unknown or admin-only capability → admin and no one else, ever.
  if (!meta || meta.adminOnly) {
    return role === 'admin';
  }

  // (b) Admin gets every hotel-facing capability.
  if (role === 'admin') return true;

  // (c) Explicit per-hotel restriction for this (capability, role).
  if (overrides && role && isHotelRole(role)) {
    const roleMap = overrides[capability];
    if (roleMap && Object.prototype.hasOwnProperty.call(roleMap, role)) {
      const allowed = roleMap[role];
      if (typeof allowed === 'boolean') return allowed;
    }
  }

  // (d) Everyone-everything default.
  const defaults = ROLE_DEFAULTS[capability] as readonly string[];
  return !!role && defaults.includes(role);
}
