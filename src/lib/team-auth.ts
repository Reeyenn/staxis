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
import { can, type CapabilityOverrideMap } from '@/lib/capabilities/can';
import {
  isCapabilityKey,
  isHotelRole,
  MANAGER_FLOOR_CAPABILITIES,
  type CapabilityKey,
} from '@/lib/capabilities/registry';
import { loadHats, resolveEffectiveRole, type MembershipHat } from '@/lib/company/access';

export interface TeamCaller {
  accountId: string;
  authUserId: string;
  authEmail?: string;
  role: AppRole;
  propertyAccess: string[];
  isAdmin: boolean;
  /**
   * ADDITIVE (company spine, 0364). `propertyAccess` UNION every hotel this
   * person's company jobs cover. Empty-hat accounts — every single-hotel
   * account in the product — get exactly `propertyAccess` back, so nothing
   * about them changes.
   */
  accessiblePropertyIds?: string[];
  /** The jobs behind that union, for surfaces that show a person's hats. */
  hats?: MembershipHat[];
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
    .select('id, role, property_access, active')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  if (acctErr || !account || account.active !== true) return null;

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

  const propertyAccess = (account.property_access ?? []) as string[];

  // Company hats are ADDITIVE and must never be able to fail the gate. An
  // account with no hats pays one indexed lookup that finds nothing.
  let hats: MembershipHat[] = [];
  if (role !== 'admin') {
    try {
      hats = await loadHats(account.id);
    } catch {
      hats = [];
    }
  }

  return {
    accountId: account.id,
    authUserId: session.userId,
    authEmail: session.email ?? undefined,
    role,
    propertyAccess,
    isAdmin: role === 'admin',
    accessiblePropertyIds: [...new Set([
      ...propertyAccess,
      ...hats.flatMap((hat) => hat.coveredPropertyIds),
    ])].filter((id) => id !== '*').sort(),
    hats,
  };
}

/**
 * Does this manager manage that hotel?
 *
 * Company spine (0364): a job at a company that operates the hotel counts, in
 * addition to the legacy `property_access` array. Strictly additive — every
 * hotel that answered true before still answers true, and a hotel that is in
 * neither list is still refused, which is Wall A and Wall B at this boundary.
 */
export function canManageHotel(caller: TeamCaller, hotelId: string): boolean {
  if (caller.isAdmin) return true;
  // Reach first — asked of the JOBS rather than of the pre-computed union, so a
  // caller that narrows `propertyAccess` on a copy of this object gets the
  // narrower answer it asked for instead of the union quietly overruling it.
  const reaches = caller.propertyAccess.includes(hotelId)
    || (caller.hats ?? []).some((hat) => hat.coveredPropertyIds.includes(hotelId));
  if (!reaches) return false;
  // …then CAPACITY, in the job held here. `verifyTeamManager` decided
  // manager-ness from the global `accounts.role`; without this, a legacy
  // manager given a housekeeping hat at a company hotel could invite people and
  // change jobs at a hotel where her actual job is cleaning rooms. Same fix,
  // same reasoning, as `managerManagesHotel` — see its header.
  const roleHere = teamCallerRoleAtHotel(caller, hotelId);
  return roleHere !== null && canManageTeam(roleHere);
}

/** The job this caller holds AT this hotel. See `callerRoleAtHotel`. */
function teamCallerRoleAtHotel(caller: TeamCaller, hotelId: string): AppRole | null {
  return resolveEffectiveRole({
    legacyRole: caller.role,
    legacyPropertyAccess: caller.propertyAccess,
    hats: caller.hats ?? [],
  }, hotelId).role;
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
  // The role AT THIS HOTEL, not the global word. An owner-by-legacy-role who
  // holds a GM hat at this hotel is a GM here, and a per-hotel override that
  // restricts general_manager has to actually reach her.
  const role = teamCallerRoleAtHotel(caller, hotelId) ?? caller.role;
  return canForProperty({ role }, capability, hotelId);
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
  const role = teamCallerRoleAtHotel(caller, hotelId) ?? caller.role;
  return capabilityDecisionForProperty({ role }, capability, hotelId);
}

/**
 * Uncached capability resolution for the last authorization check immediately
 * before a sensitive write. Ordinary route reads use the request cache; a CAS
 * retry must instead observe an override revoked earlier in the same request.
 */
export async function callerCapabilityDecisionFresh(
  caller: TeamCaller,
  capability: CapabilityKey,
  hotelId: string,
): Promise<CapabilityDecision> {
  if (!canManageHotel(caller, hotelId)) return 'denied';
  if (caller.isAdmin) return 'allowed';

  const { data, error } = await supabaseAdmin
    .from('capability_overrides')
    .select('capability, role, allowed')
    .eq('property_id', hotelId);
  if (error || !Array.isArray(data)) return 'unavailable';

  const overrides: CapabilityOverrideMap = {};
  for (const row of data as Array<{ capability: string; role: string; allowed: boolean }>) {
    if (!isCapabilityKey(row.capability) || !isHotelRole(row.role)) continue;
    (overrides[row.capability] ??= {})[row.role] = !!row.allowed;
  }
  const role = teamCallerRoleAtHotel(caller, hotelId) ?? caller.role;
  return can({ role }, capability, overrides) ? 'allowed' : 'denied';
}

/**
 * Account roles, display names, passwords, and lifecycle state are global even
 * when the UI starts from one hotel. A non-admin caller may make one of those
 * changes only when they both have access to every target hotel and hold the
 * required capability at every one. Wildcard target access remains admin-only.
 */
export async function callerControlsEveryTargetHotel(
  caller: TeamCaller,
  capability: CapabilityKey,
  targetAccess: readonly string[],
  opts?: { fresh?: boolean },
): Promise<CapabilityDecision> {
  if (caller.isAdmin) return 'allowed';
  const hotelIds = [...new Set(targetAccess.filter((hotelId) => hotelId.length > 0))];
  if (hotelIds.length === 0 || hotelIds.includes('*')) return 'denied';

  // Company spine (0364): a hotel reached through a company job counts the
  // same as one listed in the legacy array. Never narrower than before.
  if (!caller.propertyAccess.includes('*')
    && hotelIds.some((hotelId) => !canManageHotel(caller, hotelId))) {
    return 'denied';
  }

  const decisions = await Promise.all(
    hotelIds.map((hotelId) => (
      opts?.fresh
        ? callerCapabilityDecisionFresh(caller, capability, hotelId)
        : callerCapabilityDecision(caller, capability, hotelId)
    )),
  );
  if (decisions.includes('unavailable')) return 'unavailable';
  return decisions.every((decision) => decision === 'allowed') ? 'allowed' : 'denied';
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

// ─── Manager identity for a resolved session ─────────────────────────────────

/**
 * A manager, already identified. Same shape three "what does Staxis know about
 * this hotel" routes were each hand-rolling; keeping it here means one place
 * has to be right about the `accounts` columns.
 */
export interface ManagerCaller {
  accountId: string;
  role: AppRole;
  /** For attributing an authored fact to a person. Cosmetic — never a gate. */
  displayName: string | null;
  propertyAccess: string[];
  /**
   * ADDITIVE (company spine, 0364). Every job this person holds at a company,
   * with its hotels resolved. Empty for every single-hotel account, which is
   * why nothing about them changes. See src/lib/company/access.ts.
   */
  hats?: MembershipHat[];
  /**
   * ADDITIVE. `propertyAccess` UNION every hat's coverage — the honest answer
   * to "which hotels can this person reach". Never smaller than
   * `propertyAccess`. `'*'` and admin still mean everything, and are signalled
   * by `reachesAllProperties`.
   */
  accessiblePropertyIds?: string[];
  reachesAllProperties?: boolean;
}

/**
 * The person behind an already-validated session, WHATEVER their job is.
 *
 * Identical to `loadManagerCaller` in every respect but one: it does not
 * require the role to manage a team. Housekeeping, front desk and maintenance
 * accounts resolve here and are refused there.
 *
 * WHY THIS EXISTS AS ITS OWN FUNCTION. The hotel picker has to answer "which
 * hotels may this person open" for EVERYBODY who can sign in, and a company's
 * finance lead — a company-scope job by the spine's own vocabulary — carries a
 * legacy `accounts.role` of `front_desk`, so the manager gate would have shown
 * them an empty picker. Splitting the read from the gate means the `accounts`
 * column list still lives in exactly one place, which is the whole point of
 * the shared lookup.
 *
 * NOTE for future editors: the display name column is `display_name`. There is
 * no `accounts.name`, and naming a column that does not exist makes PostgREST
 * error, which reads at the call site as "no such account" and silently turns
 * the whole feature off for every user. That exact bug shipped once and is
 * pinned by a test against the real schema.
 */
export async function loadSessionAccount(authUserId: string): Promise<ManagerCaller | null> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id, role, display_name, property_access, active')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (error || !data) return null;

  const row = data as {
    id: string;
    role: string | null;
    display_name: string | null;
    property_access: unknown;
    active: boolean | null;
  };
  if (row.active === false) return null;

  const role = (row.role as AppRole | null) ?? null;
  if (!role) return null;

  const propertyAccess = Array.isArray(row.property_access) ? (row.property_access as string[]) : [];
  const reachesAllProperties = role === 'admin' || propertyAccess.includes('*');

  // Company hats are ADDITIVE and must never be able to fail the load. An
  // account with no hats — every single-hotel account today — pays one indexed
  // lookup that returns nothing, and the caller sees exactly the shape it saw
  // before this field existed.
  let hats: MembershipHat[] = [];
  if (!reachesAllProperties) {
    try {
      hats = await loadHats(row.id);
    } catch {
      hats = [];
    }
  }
  const membershipPropertyIds = hats.flatMap((hat) => hat.coveredPropertyIds);

  return {
    accountId: row.id,
    role,
    displayName: row.display_name ?? null,
    propertyAccess,
    hats,
    accessiblePropertyIds: [...new Set([...propertyAccess, ...membershipPropertyIds])]
      .filter((id) => id !== '*')
      .sort(),
    reachesAllProperties,
  };
}

/**
 * Load the manager behind an already-validated session (requireSession first).
 *
 * Returns null when there is no account row, the account is deactivated, or the
 * role cannot manage a team. Deliberately NOT a session check — the caller owns
 * that, so this stays usable from routes that need their own 401 semantics.
 */
export async function loadManagerCaller(authUserId: string): Promise<ManagerCaller | null> {
  const account = await loadSessionAccount(authUserId);
  if (!account || !canManageTeam(account.role)) return null;
  return account;
}

/**
 * Can this person OPEN that hotel at all? Reach, and only reach.
 *
 * Admins and wildcard access reach everything; otherwise the legacy array or a
 * hat covering the hotel. Strictly additive — every hotel that answered true
 * before the company spine still answers true.
 *
 * DELIBERATELY NOT A MANAGER GATE. Two surfaces need reach without capacity: a
 * company's finance lead reads her company's rulebook and portfolio (her hat
 * degrades to `front_desk`, so a manager check would refuse the person the
 * screen was written for), and the hotel picker has to list hotels for
 * everybody who can sign in. Those call this. Anything that then WRITES, or
 * shows a manager-only screen, calls `managerManagesHotel` below.
 */
export function callerReachesHotel(caller: ManagerCaller, propertyId: string): boolean {
  if (caller.role === 'admin') return true;
  if (caller.propertyAccess.includes(propertyId) || caller.propertyAccess.includes('*')) return true;
  // Asked of the JOBS, not of the pre-computed union — see canManageHotel.
  return (caller.hats ?? []).some((hat) => hat.coveredPropertyIds.includes(propertyId));
}

/**
 * What job does this person hold AT THIS HOTEL — the per-hotel answer, resolved
 * from what the caller is already carrying. No database round trip.
 *
 * The rule itself is `resolveEffectiveRole` in `src/lib/company/access.ts`; this
 * is that rule fed from a `ManagerCaller`.
 */
export function callerRoleAtHotel(caller: ManagerCaller, propertyId: string): AppRole | null {
  return resolveEffectiveRole({
    legacyRole: caller.role,
    legacyPropertyAccess: caller.propertyAccess,
    hats: caller.hats ?? [],
  }, propertyId).role;
}

/**
 * Does this person manage that hotel — in the capacity they actually hold THERE?
 *
 * THE BUG THIS CLOSES. Capacity and reach were answered by two different
 * questions that were never intersected. `loadManagerCaller` decided
 * manager-ness from the GLOBAL `accounts.role`; this function then admitted the
 * hotel if ANY hat covered it, whatever that hat's job was. So a person whose
 * login still carries a legacy `general_manager` role, given a HOUSEKEEPING hat
 * at a company hotel, passed both halves: 200 on that hotel's findings queue,
 * and the right to mute its manager-only cards — while `effectiveRole` said, to
 * anybody who asked, that she was a housekeeper there. The hat was supposed to
 * be the demotion; it was read only as an admission ticket.
 *
 * Now the two are one question. The hat's own job governs at a hotel the hat
 * covers, exactly as `effectiveRole` has always said it does, and the legacy
 * role answers only where the legacy array names the hotel — which is every
 * account in the product today, unchanged.
 *
 * Finance is refused HERE and that is correct: `finance` degrades to
 * `front_desk` on purpose (least privilege — see `legacyRoleForHat`), and her
 * read paths go through `callerReachesHotel` plus `rulebookStandingFor` /
 * `verdictsAllowed`, which are written to answer about her.
 */
export function managerManagesHotel(caller: ManagerCaller, propertyId: string): boolean {
  if (caller.role === 'admin') return true;
  if (!callerReachesHotel(caller, propertyId)) return false;
  const roleHere = callerRoleAtHotel(caller, propertyId);
  return roleHere !== null && canManageTeam(roleHere);
}
