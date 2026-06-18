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
import { verifyTeamManager, callerCan } from '@/lib/team-auth';
import { isAssignableRole, type AppRole } from '@/lib/roles';
import { writeAudit } from '@/lib/audit';
import { writeRoleChange } from '@/lib/audit-role-changes';
import { validateUuid } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  if (!(await callerCan(caller, 'manage_team', hotelId))) {
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

  const emailByUserId = new Map<string, string>();
  const { data: authPage, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) {
    log.error('[team:GET] auth listUsers failed', { requestId, msg: errToString(listErr) });
  } else {
    for (const u of authPage?.users ?? []) {
      if (u.id && u.email) emailByUserId.set(u.id, u.email);
    }
  }

  const team = teamRows.map(r => ({
    accountId: r.id,
    username: r.username,
    displayName: r.display_name,
    email: emailByUserId.get(r.data_user_id) ?? '',
    role: r.role as AppRole,
    propertyAccess: r.role === 'admin' ? ['*'] : (r.property_access ?? []),
    staffId: (r as { staff_id?: string | null }).staff_id ?? null,
    createdAt: r.created_at,
  }));

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

  const hotelIdCheck = validateUuid(body.hotelId, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;

  const accountIdCheck = validateUuid(body.accountId, 'accountId');
  if (accountIdCheck.error) return err(accountIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const accountId = accountIdCheck.value!;

  if (!(await callerCan(caller, 'manage_team', hotelId))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  // Load target.
  const { data: target, error: tErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, data_user_id, property_access, display_name, staff_id')
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
  const targetAccess = Array.isArray(target.property_access) ? target.property_access : [];
  if (!targetAccess.includes(hotelId)) {
    return err('Account does not have access to this hotel', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
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

  // Multi-hotel credential protection (audit #12, CONSERVATIVE DEFAULT — relax
  // if you want managers to have broader reach). A password reset is a GLOBAL
  // credential change: it logs the person out of EVERY hotel they work at, not
  // just this one. So a non-admin manager may only reset the password of someone
  // whose hotel access is fully within the manager's own control. If the target
  // also works at a hotel this manager doesn't manage, require an admin —
  // otherwise a manager at hotel A could lock out (or hijack) a person who also
  // works at hotel B. (Self-service is unaffected; '*'/admin callers bypass.)
  if (password && !isSelf && caller.role !== 'admin' && !caller.propertyAccess.includes('*')) {
    const outsideCallerControl = targetAccess.filter(
      (h) => h !== '*' && !caller.propertyAccess.includes(h),
    );
    if (outsideCallerControl.length > 0) {
      return err('This person also has access to another hotel — only an admin can reset their password.', {
        requestId, status: 403, code: ApiErrorCode.Unauthorized,
      });
    }
  }

  // Build updates. Role changes must stay in the assignable set (no
  // self-promotion to admin via this route).
  const updates: Record<string, unknown> = {};
  if (typeof displayName === 'string' && displayName.trim() && displayName.trim() !== target.display_name) {
    updates.display_name = displayName.trim();
  }
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
    updates.role = role;
    nextRole = role as AppRole;
  }

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
    const { error: upErr } = await supabaseAdmin
      .from('accounts')
      .update(updates)
      .eq('id', accountId);
    if (upErr) {
      log.error('[team:PUT] update failed', { requestId, msg: errToString(upErr) });
      return err('Failed to update account', {
        requestId, status: 500, code: ApiErrorCode.InternalError,
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

  if (!(await callerCan(caller, 'manage_team', hotelId))) {
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
    .select('id, role')
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
  const { data: remaining, error: rpcErr } = await supabaseAdmin.rpc(
    'staxis_remove_property_access',
    { p_account_id: accountId, p_hotel_id: hotelId },
  );
  if (rpcErr) {
    log.error('[team:DELETE] staxis_remove_property_access failed', { requestId, msg: errToString(rpcErr) });
    return err('Failed to remove access', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  // RPC contract: returns -1 if the account row no longer exists, otherwise
  // the resulting property_access length (0 = nothing left).
  const remainingLen = typeof remaining === 'number' ? remaining : -1;
  if (remainingLen < 0) {
    return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

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
