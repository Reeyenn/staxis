// /api/auth/team — manage team members for a specific hotel.
//
//   GET     ?hotelId=…
//     List accounts with access to the hotel. Visible to admin/owner/GM
//     who can manage that hotel.
//
//   PUT
//     Body: { hotelId, accountId, displayName?, role?, password? }
//     Update a team member. Caller must manage the hotel. Targets cannot
//     be admins (admin accounts are managed via /api/auth/accounts).
//     Role changes are limited to assignable roles (no promotion to admin).
//
//   DELETE  ?hotelId=…&accountId=…
//     Remove a team member's access to that hotel (detach — the account
//     itself stays alive, just loses property_access for this hotel).
//     Targets cannot be admins. Caller cannot remove themselves.
//
// Admins still have access via /api/auth/accounts (full system view); this
// endpoint is what owners/GMs use to manage their own hotel's team.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import {
  verifyTeamManager,
  callerCapabilityDecision,
  type TeamCaller,
} from '@/lib/team-auth';
import type { CapabilityDecision } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { isAssignableRole, type AppRole } from '@/lib/roles';
import { writeAudit } from '@/lib/audit';
import { writeRoleChange } from '@/lib/audit-role-changes';
import { validateUuid } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizedHotelAccess(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((hotelId): hotelId is string => typeof hotelId === 'string' && hotelId.length > 0))];
}

/**
 * Name, role, and password live on the account row / auth user, so changing
 * any of them affects every hotel the target can enter. A hotel manager may
 * make those global changes only when they can manage_team at every one of
 * those hotels. Admin is the only safe actor for wildcard-access targets.
 */
async function controlsEveryTargetHotel(
  caller: TeamCaller,
  targetAccess: string[],
): Promise<CapabilityDecision> {
  if (caller.isAdmin) return 'allowed';
  if (targetAccess.length === 0 || targetAccess.includes('*')) return 'denied';

  // Avoid capability reads for hotels the caller plainly cannot access.
  if (!caller.propertyAccess.includes('*') && targetAccess.some((hotelId) => !caller.propertyAccess.includes(hotelId))) {
    return 'denied';
  }

  const decisions = await Promise.all(
    targetAccess.map((hotelId) => callerCapabilityDecision(caller, 'manage_team', hotelId)),
  );
  if (decisions.includes('unavailable')) return 'unavailable';
  return decisions.every((decision) => decision === 'allowed') ? 'allowed' : 'denied';
}

/** Mirrors the PUT/DELETE target hierarchy without making the client infer it. */
function canActOnTarget(
  caller: TeamCaller,
  targetRole: AppRole,
  isSelf: boolean,
): boolean {
  if (targetRole === 'admin') return false;
  if (targetRole === 'owner' && caller.role !== 'admin' && caller.role !== 'owner') return false;
  if (targetRole === 'general_manager' && caller.role === 'general_manager' && !isSelf) return false;
  return true;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const hotelIdRaw = searchParams.get('hotelId');
  if (!hotelIdRaw) return err('hotelId required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelIdCheck = validateUuid(hotelIdRaw, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;
  const capabilityDecision = await callerCapabilityDecision(caller, 'manage_team', hotelId);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const { data: rows, error: qErr } = await supabaseAdmin
    .from('accounts')
    .select('id, username, display_name, role, property_access, created_at, data_user_id, staff_id')
    .order('created_at', { ascending: true });
  if (qErr) {
    log.error('[team:GET] query failed', { requestId, msg: errToString(qErr) });
    return err('Failed to load team', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  // Hide admins from non-admin viewers. Staxis (us) is the platform
  // operator — customers shouldn't see our staff in their hotel's team
  // list. Admin-on-admin debug view: admins still see every row including
  // other admins, because for them this doubles as a quick "who has
  // access" check.
  const teamRows = (rows ?? []).filter(r => {
    if (r.role === 'admin') return caller.isAdmin;
    return Array.isArray(r.property_access) && r.property_access.includes(hotelId);
  });

  // accounts.staff_id is a legacy account-wide field. The organization
  // foundation keeps an exact (account, hotel) identity map, which prevents a
  // staff link from Hotel A being presented as linked while viewing Hotel B.
  const teamAccountIds = new Set(teamRows.map((row) => row.id));
  const staffIdByAccountId = new Map<string, string>();
  const { data: staffLinks, error: staffLinksErr } = await supabaseAdmin
    .from('account_property_staff_links')
    .select('account_id, staff_id')
    .eq('property_id', hotelId)
    .eq('is_active', true);
  if (staffLinksErr) {
    log.error('[team:GET] property staff-link query failed', {
      requestId,
      msg: errToString(staffLinksErr),
    });
    return err('Failed to load hotel staff links', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  } else {
    for (const link of staffLinks ?? []) {
      if (teamAccountIds.has(link.account_id)) {
        staffIdByAccountId.set(link.account_id, link.staff_id);
      }
    }
  }

  const emailByUserId = new Map<string, string>();
  const { data: authPage, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) {
    log.error('[team:GET] auth listUsers failed', { requestId, msg: errToString(listErr) });
  } else {
    for (const u of authPage?.users ?? []) {
      if (u.id && u.email) emailByUserId.set(u.id, u.email);
    }
  }

  const teamWithDecisions = await Promise.all(teamRows.map(async (r) => {
    const targetRole = r.role as AppRole;
    const isSelf = r.id === caller.accountId;
    const targetAccess = targetRole === 'admin' ? ['*'] : normalizedHotelAccess(r.property_access);
    const hasOtherHotelAccess = targetAccess.includes('*') || targetAccess.some((id) => id !== hotelId);
    const hotelAccessCount = targetAccess.includes('*') ? null : targetAccess.length;
    const hierarchyAllowsMutation = canActOnTarget(caller, targetRole, isSelf);

    // Self name/password edits remain self-service even if the caller has a
    // per-hotel manage_team restriction elsewhere. Other-person account-wide
    // edits require control of every hotel represented by this account.
    const controlsAllHotelsDecision: CapabilityDecision = isSelf
      ? 'allowed'
      : await controlsEveryTargetHotel(caller, targetAccess);
    const controlsAllHotels = controlsAllHotelsDecision === 'allowed';
    const canEditProfile = hierarchyAllowsMutation && (isSelf || controlsAllHotels);
    const canChangeRole = hierarchyAllowsMutation && !isSelf && controlsAllHotels;
    // Direct manager-set passwords cross the Postgres account boundary into
    // Supabase Auth and cannot be made atomic with a concurrent promotion.
    // Team members use the standard emailed recovery flow; only the signed-in
    // person can change their own password here.
    const canResetPassword = hierarchyAllowsMutation && isSelf;
    // Detach is intentionally hotel-scoped: a manager may remove Hotel A
    // access without controlling Hotel B. The atomic RPC preserves Hotel B.
    const canRemove = hierarchyAllowsMutation && !isSelf;
    const actions = { canEditProfile, canChangeRole, canResetPassword, canRemove };

    return {
      controlsAllHotelsDecision,
      row: {
        accountId: r.id,
        username: r.username,
        displayName: r.display_name,
        email: emailByUserId.get(r.data_user_id) ?? '',
        role: targetRole,
        propertyAccess: targetAccess,
        staffId: staffIdByAccountId.get(r.id) ?? null,
        createdAt: r.created_at,
        isSelf,
        isPlatformAdmin: targetRole === 'admin',
        hotelAccessCount,
        hasOtherHotelAccess,
        globalImpact: {
          displayNameAffectsAllHotels: true,
          roleAffectsAllHotels: true,
          passwordAffectsAllHotels: true,
          hotelAccessCount,
          hasOtherHotelAccess,
        },
        actions,
        // Flat aliases keep the contract convenient for existing/simple clients;
        // `actions` is the canonical grouped shape for the My Hotel UI.
        ...actions,
      },
    };
  }));

  if (teamWithDecisions.some(({ controlsAllHotelsDecision }) => controlsAllHotelsDecision === 'unavailable')) {
    return capabilityUnavailableResponse(requestId);
  }
  const team = teamWithDecisions.map(({ row }) => row);

  return ok({ team }, { requestId });
}

export async function PUT(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const body = await req.json().catch(() => ({})) as {
    hotelId?: string;
    accountId?: string;
    displayName?: string;
    role?: string;
    password?: string;
    // staffId: links accounts.staff_id to the staff roster row this login
    // represents. `null` unlinks. `undefined` (omitted) leaves it alone.
    staffId?: string | null;
  };
  const { displayName, role, password } = body;

  // Passwords live in Supabase Auth while names, roles, and staff links live
  // in Postgres. A combined request cannot be atomic across those stores: the
  // password could succeed and the profile update fail (or vice versa). Force
  // callers to use two truthful operations so each response describes exactly
  // one committed mutation and the UI can report a partial outcome honestly.
  const includesPassword = Object.prototype.hasOwnProperty.call(body, 'password');
  const includesProfileMutation = Object.prototype.hasOwnProperty.call(body, 'displayName')
    || Object.prototype.hasOwnProperty.call(body, 'role')
    || Object.prototype.hasOwnProperty.call(body, 'staffId');
  if (includesPassword && includesProfileMutation) {
    return err('Password changes must be saved separately from profile, role, or staff-link changes', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const hotelIdCheck = validateUuid(body.hotelId, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;

  const accountIdCheck = validateUuid(body.accountId, 'accountId');
  if (accountIdCheck.error) return err(accountIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const accountId = accountIdCheck.value!;

  const capabilityDecision = await callerCapabilityDecision(caller, 'manage_team', hotelId);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  // Load target.
  const { data: target, error: tErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, data_user_id, property_access, display_name, staff_id, updated_at')
    .eq('id', accountId)
    .maybeSingle();
  if (tErr || !target) {
    return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Guardrails:
  // - never let a non-admin manager touch an admin row.
  // - target must actually have access to this hotel (otherwise this isn't
  //   "the manager's team member" — could be cross-hotel snooping).
  if (target.role === 'admin') {
    return err('Cannot modify admin accounts from this view', {
      requestId, status: 403, code: ApiErrorCode.Unauthorized,
    });
  }
  const targetAccess = normalizedHotelAccess(target.property_access);
  if (!targetAccess.includes(hotelId)) {
    return err('Account does not have access to this hotel', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  // accounts.staff_id remains a legacy account-wide pointer. Until all staff
  // workflows write the per-property link table directly, changing it for a
  // multi-hotel account would silently disconnect that person at another
  // hotel. Fail closed instead of corrupting the other hotel's identity link.
  if (body.staffId !== undefined && (targetAccess.includes('*') || targetAccess.length !== 1)) {
    return err('Staff links for people who work at multiple hotels must be changed by Staxis support', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
    });
  }

  // Privilege-escalation matrix (mirrors /api/settings/users denyRoleChange).
  // Applies to EVERY mutation here — password reset, role change, staff link.
  // Without it a General Manager could reset the OWNER's password (account
  // takeover) since owner is not an admin. A manager may only act on accounts
  // at or below their own tier.
  const isSelf = accountId === caller.accountId;
  if (target.role === 'owner' && caller.role !== 'admin' && caller.role !== 'owner') {
    return err('Only an admin or another owner can modify an owner account', {
      requestId, status: 403, code: ApiErrorCode.Unauthorized,
    });
  }
  if (target.role === 'general_manager' && caller.role === 'general_manager' && !isSelf) {
    return err('Only an owner or admin can modify another General Manager', {
      requestId, status: 403, code: ApiErrorCode.Unauthorized,
    });
  }

  if (password && !isSelf) {
    return err('For security, team members must reset their own password from Forgot password', {
      requestId,
      status: 403,
      code: ApiErrorCode.Unauthorized,
    });
  }

  // Build updates. Role changes must stay in the assignable set (no
  // self-promotion to admin via this route).
  const updates: Record<string, unknown> = {};
  const nextDisplayName = typeof displayName === 'string' ? displayName.trim() : '';
  const changesDisplayName = !!nextDisplayName && nextDisplayName !== target.display_name;
  let nextRole: AppRole | undefined;
  if (role && role !== target.role) {
    if (!isAssignableRole(role)) {
      return err('Invalid role (admin not allowed here)', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    // Privilege-escalation: a manager can't grant a role above their own tier.
    if (role === 'owner' && caller.role !== 'admin' && caller.role !== 'owner') {
      return err('Only an existing owner can promote someone to owner (use Transfer Ownership)', {
        requestId, status: 403, code: ApiErrorCode.Unauthorized,
      });
    }
    if (role === 'general_manager' && caller.role !== 'admin' && caller.role !== 'owner') {
      return err('Only an owner or admin can promote someone to General Manager', {
        requestId, status: 403, code: ApiErrorCode.Unauthorized,
      });
    }
    // Block self-demotion through this path — owners shouldn't accidentally
    // strip their own management privileges. Admin route can still do it.
    if (accountId === caller.accountId) {
      return err('Cannot change your own role here', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    nextRole = role as AppRole;
  }

  // Account name and role are GLOBAL fields, just like the auth password.
  // Requiring manage_team at only the selected hotel let a Hotel A manager
  // rename or rerole someone who also worked at Hotel B. Enforce the complete
  // hotel set before any other-person global mutation. Self name/password edits
  // deliberately remain available; self role changes are already blocked.
  if (!isSelf && (changesDisplayName || nextRole || !!password)) {
    const controlsAllHotelsDecision = await controlsEveryTargetHotel(caller, targetAccess);
    if (controlsAllHotelsDecision === 'unavailable') {
      return capabilityUnavailableResponse(requestId);
    }
    if (controlsAllHotelsDecision === 'denied') {
      const mutation = nextRole
        ? 'change this person\'s role'
        : changesDisplayName
          ? 'change this person\'s name'
          : 'reset this person\'s password';
      return err(
        `This person also works at a hotel you do not manage. Only an admin or a manager of every hotel they can access can ${mutation}.`,
        { requestId, status: 403, code: ApiErrorCode.Unauthorized },
      );
    }
  }

  if (changesDisplayName) updates.display_name = nextDisplayName;
  if (nextRole) updates.role = nextRole;

  // ── staffId link/unlink ─────────────────────────────────────────────────
  // The /staff page's My Shifts view scopes to accounts.staff_id. Manager
  // sets this from the Directory edit modal. We allow null (unlink) or any
  // staff.id that belongs to this hotel. The DB itself has no per-hotel FK,
  // so the check happens here.
  let staffLinkChanged = false;
  if (body.staffId !== undefined) {
    const currentStaffId = (target as { staff_id?: string | null }).staff_id ?? null;
    if (body.staffId === null) {
      if (currentStaffId !== null) {
        updates.staff_id = null;
        staffLinkChanged = true;
      }
    } else {
      const staffIdCheck = validateUuid(body.staffId, 'staffId');
      if (staffIdCheck.error) return err(staffIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const nextStaffId = staffIdCheck.value!;
      if (nextStaffId !== currentStaffId) {
        // Verify the staff row exists and is in this hotel.
        const { data: staffRow, error: sErr } = await supabaseAdmin
          .from('staff')
          .select('id, property_id')
          .eq('id', nextStaffId)
          .maybeSingle();
        if (sErr || !staffRow) {
          return err('Staff record not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
        }
        if (staffRow.property_id !== hotelId) {
          return err('Staff record belongs to another hotel', {
            requestId, status: 400, code: ApiErrorCode.ValidationFailed,
          });
        }
        // Ensure this staff row isn't already linked to a different account.
        const { data: existing } = await supabaseAdmin
          .from('accounts')
          .select('id')
          .eq('staff_id', nextStaffId)
          .neq('id', accountId)
          .maybeSingle();
        if (existing) {
          return err('That staff record is already linked to another account', {
            requestId, status: 400, code: ApiErrorCode.ValidationFailed,
          });
        }
        updates.staff_id = nextStaffId;
        staffLinkChanged = true;
      }
    }
  }

  // Password reset: requires Supabase 6-char minimum.
  if (password) {
    if (password.length < 6) {
      return err('Password must be at least 6 characters', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(target.data_user_id, { password });
    if (pwErr) {
      log.error('[team:PUT] password update failed', { requestId, msg: errToString(pwErr) });
      return err(pwErr.message || 'Failed to update password', {
        requestId, status: 500, code: ApiErrorCode.InternalError,
      });
    }
  }

  if (Object.keys(updates).length > 0) {
    const { data: updatedRow, error: upErr } = await supabaseAdmin
      .from('accounts')
      .update(updates)
      .eq('id', accountId)
      .eq('updated_at', target.updated_at)
      .select('id')
      .maybeSingle();
    if (upErr) {
      log.error('[team:PUT] update failed', { requestId, msg: errToString(upErr) });
      return err('Failed to update account', {
        requestId, status: 500, code: ApiErrorCode.InternalError,
      });
    }
    if (!updatedRow) {
      return err('This account changed while you were editing it. Refresh and try again.', {
        requestId,
        status: 409,
        code: ApiErrorCode.IdempotencyConflict,
      });
    }
  }

  await writeAudit({
    action: 'account.team_update',
    actorUserId: caller.authUserId,
    actorEmail: caller.authEmail,
    targetType: 'account',
    targetId: accountId,
    hotelId,
    metadata: {
      display_name_changed: typeof updates.display_name === 'string',
      role_changed: nextRole ?? null,
      password_reset: !!password,
      staff_link_changed: staffLinkChanged,
    },
  });

  // Mirror role changes from this route into the structured role_changes
  // audit table — so a future "history of role X for user Y" UI sees the
  // same trail regardless of which surface (Accounts page vs Users page)
  // made the change. Best-effort; failure does not roll back.
  if (nextRole) {
    await writeRoleChange({
      accountId,
      propertyId: hotelId,
      changedByAccountId: caller.accountId,
      oldRole: target.role as AppRole,
      newRole: nextRole,
      changeKind: 'role_change',
      reason: null,
    });
  }

  return ok({ success: true }, { requestId });
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const hotelIdCheck = validateUuid(searchParams.get('hotelId'), 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;

  const accountIdCheck = validateUuid(searchParams.get('accountId'), 'accountId');
  if (accountIdCheck.error) return err(accountIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const accountId = accountIdCheck.value!;

  const capabilityDecision = await callerCapabilityDecision(caller, 'manage_team', hotelId);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }
  if (accountId === caller.accountId) {
    return err('Cannot remove yourself from a hotel', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  // Role guard — admins can only be modified through the admin route.
  // Cheap pre-check before invoking the atomic RPC.
  const { data: target, error: tErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, updated_at')
    .eq('id', accountId)
    .maybeSingle();
  if (tErr || !target) {
    return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  if (target.role === 'admin') {
    return err('Cannot remove admin accounts from this view', {
      requestId, status: 403, code: ApiErrorCode.Unauthorized,
    });
  }
  // Same owner/GM privilege matrix as PUT — a GM must not be able to detach an
  // owner (or another GM) from a hotel. (Audit review fix 2026-06-18.)
  if (target.role === 'owner' && caller.role !== 'admin' && caller.role !== 'owner') {
    return err('Only an admin or another owner can remove an owner', {
      requestId, status: 403, code: ApiErrorCode.Unauthorized,
    });
  }
  if (target.role === 'general_manager' && caller.role === 'general_manager') {
    return err('Only an owner or admin can remove another General Manager', {
      requestId, status: 403, code: ApiErrorCode.Unauthorized,
    });
  }

  // Concurrency audit #1: use the atomic RPC instead of read-filter-update.
  // Two concurrent removals on the same account from different hotels could
  // each compute a stale `next` array and clobber each other, silently re-
  // granting a hotel one of them had just removed.
  const { data: removalResult, error: rpcErr } = await supabaseAdmin.rpc(
    'staxis_remove_property_access_guarded',
    {
      p_account_id: accountId,
      p_hotel_id: hotelId,
      p_expected_role: target.role,
      p_expected_updated_at: target.updated_at,
    },
  );
  if (rpcErr) {
    log.error('[team:DELETE] guarded property removal failed', { requestId, msg: errToString(rpcErr) });
    return err('Failed to remove access', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  const guardedResult = removalResult && typeof removalResult === 'object'
    ? removalResult as { status?: string; remaining_hotels?: number }
    : null;
  if (guardedResult?.status === 'not_found') {
    return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  if (guardedResult?.status === 'not_attached') {
    return err('Account does not have access to this hotel', {
      requestId,
      status: 404,
      code: ApiErrorCode.NotFound,
    });
  }
  if (guardedResult?.status === 'conflict') {
    return err('This account changed while you were removing access. Refresh and try again.', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
    });
  }
  if (guardedResult?.status !== 'ok' || typeof guardedResult.remaining_hotels !== 'number') {
    log.error('[team:DELETE] guarded property removal returned an invalid result', { requestId });
    return err('Failed to remove access', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
  const remainingLen = guardedResult.remaining_hotels;

  await writeAudit({
    action: 'account.team_detach',
    actorUserId: caller.authUserId,
    actorEmail: caller.authEmail,
    targetType: 'account',
    targetId: accountId,
    hotelId,
    metadata: { remaining_hotels: remainingLen },
  });

  return ok({ success: true }, { requestId });
}
