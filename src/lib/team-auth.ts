// ─── Team-management auth helper ─────────────────────────────────────────
// Used by /api/auth/invites/* and /api/auth/join-codes/* — admin can manage
// any hotel; owner/general_manager can only manage hotels they have access to.
//
// Audit 2026-05-22: this helper now routes JWT validation through
// requireSession() so the new server-side device-trust enforcement
// applies. Before this change, a leaked password JWT could call
// invite/code management without ever completing OTP — a path-around
// the requireSession gate added in the auth/2FA audit.

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canManageTeam, type AppRole } from '@/lib/roles';
import { requireSession } from '@/lib/api-auth';
import {
  canForProperty,
  capabilityDecisionForProperty,
  type CapabilityDecision,
} from '@/lib/capabilities/server';
import { MANAGER_FLOOR_CAPABILITIES, type CapabilityKey } from '@/lib/capabilities/registry';

export interface TeamCaller {
  accountId: string;
  authUserId: string;
  authEmail?: string;
  role: AppRole;
  propertyAccess: string[];
  isAdmin: boolean;
}

export async function verifyTeamManager(
  req: NextRequest,
  opts?: { capability?: CapabilityKey; propertyId?: string | null },
): Promise<TeamCaller | null> {
  // requireSession enforces device-trust by default (Phase 1 audit). If
  // it fails — invalid JWT, no device cookie, skip_2fa refusal — we
  // return null and the caller surfaces a generic 403. (We swallow the
  // typed 401 response here because the existing call sites expect a
  // null|TeamCaller shape; the typed shape is preserved in
  // requireAdmin / requireSession callers that have been migrated.)
  const session = await requireSession(req);
  if (!session.ok) return null;

  const { data: account, error: acctErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, property_access')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  if (acctErr || !account) return null;

  const role = account.role as AppRole;
  // Gate: when the caller names a capability, use the per-hotel resolver
  // (default: every role gets it; an admin can switch a role OFF for this hotel
  // from the Access tab). Pass propertyId to enforce that hotel's restrictions;
  // omit it for the everyone-default. Auth + 2FA above are untouched — this only
  // replaces the old manager-only role comparison. Legacy callers that pass no
  // capability keep the manager-only check unchanged.
  if (opts?.capability) {
    // Hard floor for manager-tier capabilities: account/credential management,
    // money/pay, the audit log, and PMS settings are admin/owner/GM ONLY, always
    // — a per-hotel override (or a future everyone-default regression) can
    // RESTRICT a manager further but can never grant them to line staff
    // (front_desk/housekeeping/maintenance). This mirrors can()'s step b.5 and
    // sits on top of each cap's manager-tier default in the registry (defense in
    // depth). Other capabilities (manage_shifts, manage_checklists, run_reports)
    // keep the everyone-default.
    if (MANAGER_FLOOR_CAPABILITIES.has(opts.capability) && !canManageTeam(role)) return null;
    if (!(await canForProperty({ role }, opts.capability, opts.propertyId ?? null))) return null;
  } else if (!canManageTeam(role)) {
    return null;
  }

  return {
    accountId: account.id,
    authUserId: session.userId,
    authEmail: session.email ?? undefined,
    role,
    propertyAccess: (account.property_access ?? []) as string[],
    isAdmin: role === 'admin',
  };
}

export function canManageHotel(caller: TeamCaller, hotelId: string): boolean {
  if (caller.isAdmin) return true;
  return caller.propertyAccess.includes(hotelId);
}

/**
 * Property-scope AND per-hotel capability in one check, for routes that resolve
 * the caller before they know the hotel. Returns true only if the caller has
 * access to `hotelId` (canManageHotel) AND the capability is allowed for their
 * role at that hotel (default: every role; an admin can switch it OFF per hotel
 * from the Access tab). Use this in place of a bare canManageHotel at the gate
 * site when the caller was resolved with an everyone-default capability.
 */
export async function callerCan(
  caller: TeamCaller,
  capability: CapabilityKey,
  hotelId: string,
): Promise<boolean> {
  if (!canManageHotel(caller, hotelId)) return false;
  return canForProperty({ role: caller.role }, capability, hotelId);
}

/**
 * Tri-state variant for API boundaries that must distinguish an explicit deny
 * from an override-store outage. Property-scope failures are ordinary denials;
 * only the capability read itself can be `unavailable`.
 */
export async function callerCapabilityDecision(
  caller: TeamCaller,
  capability: CapabilityKey,
  hotelId: string,
): Promise<CapabilityDecision> {
  if (!canManageHotel(caller, hotelId)) return 'denied';
  return capabilityDecisionForProperty({ role: caller.role }, capability, hotelId);
}

/**
 * Capability + property-scope check resolved straight from an authenticated
 * user id (no pre-fetched TeamCaller). Loads the account once, then requires
 * BOTH:
 *   (1) the per-hotel capability resolver allows it (default + override + the
 *       manager floor — e.g. manage_settings is owner/GM/admin only and
 *       override-proof), AND
 *   (2) the caller actually has access to `propertyId` (admin reaches all; the
 *       '*' wildcard reaches all; otherwise the id must be in property_access).
 *
 * Use this at a route boundary that already ran requireSession and just needs
 * "is this user allowed to do <capability> at <propertyId>?". The PMS write
 * routes use it to admit owner + GM (manage_settings) instead of the old
 * owner-id-only check, so a GM can save/onboard PMS credentials — matching the
 * /settings/pms page gate. (Access cleanup 2026-06-26.)
 */
export async function accountCanForProperty(
  authUserId: string,
  capability: CapabilityKey,
  propertyId: string | null | undefined,
): Promise<boolean> {
  if (!propertyId) return false;
  const { data: account, error } = await supabaseAdmin
    .from('accounts')
    .select('role, property_access')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (error || !account) return false;

  const role = (account.role as AppRole | null) ?? null;
  if (!role) return false;

  // (1) Capability (default + per-hotel override + manager floor).
  if (!(await canForProperty({ role }, capability, propertyId))) return false;

  // (2) Property scope — admin and '*' wildcard reach every property.
  const access = (account.property_access ?? []) as string[];
  return role === 'admin' || access.includes(propertyId) || access.includes('*');
}

/**
 * API-boundary variant of accountCanForProperty that preserves the same
 * capability-then-property-scope ordering while distinguishing an override
 * store outage from a real denial.
 */
export async function accountCapabilityDecisionForProperty(
  authUserId: string,
  capability: CapabilityKey,
  propertyId: string | null | undefined,
): Promise<CapabilityDecision> {
  if (!propertyId) return 'denied';
  const { data: account, error } = await supabaseAdmin
    .from('accounts')
    .select('role, property_access')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (error || !account) return 'denied';

  const role = (account.role as AppRole | null) ?? null;
  if (!role) return 'denied';

  const capabilityDecision = await capabilityDecisionForProperty(
    { role },
    capability,
    propertyId,
  );
  if (capabilityDecision !== 'allowed') return capabilityDecision;

  const access = (account.property_access ?? []) as string[];
  return role === 'admin' || access.includes(propertyId) || access.includes('*')
    ? 'allowed'
    : 'denied';
}
