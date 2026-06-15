/**
 * Self-serve user management for hotel owners + GMs.
 *
 *   GET    ?propertyId=…
 *     List every account with access to the hotel, including their
 *     email, role, active flag, last_sign_in_at, and a friendly
 *     displayName. Visible to admin/owner/GM. Hides Staxis admins
 *     from non-admin viewers.
 *
 *   PUT
 *     Body: { propertyId, accountId, action, ...payload }
 *       action: 'change_role'        — { newRole }
 *               'deactivate'         — sets active=false
 *               'reactivate'         — sets active=true
 *               'transfer_ownership' — { newOwnerAccountId } — promotes
 *                                       newOwnerAccountId to 'owner' and
 *                                       demotes the caller to 'general_manager'.
 *
 * Every action writes a row to role_changes (the structured audit) AND
 * a parallel admin_audit_log entry (the generic audit). The structured
 * table makes a future "show me the history of this user's role" UI
 * cheap; the generic table keeps the security-review trail intact.
 *
 * Role guardrails:
 *   - Only an owner can demote another owner OR run transfer_ownership.
 *   - GMs can manage all non-owner/admin roles.
 *   - Nobody can modify an admin account from this UI.
 *   - Nobody can deactivate their own account.
 *   - Transfer-ownership requires the caller to actually be an owner and
 *     for the target to currently be a GM or front_desk staff member.
 *
 * Auth: requireSession (the manager/owner) — NOT requireCronSecret.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeAudit } from '@/lib/audit';
import { writeRoleChange } from '@/lib/audit-role-changes';
import { validateUuid } from '@/lib/api-validate';
import { isAssignableRole, type AppRole, type AssignableRole } from '@/lib/roles';
import { canForProperty } from '@/lib/capabilities/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CallerContext {
  authUserId: string;
  authEmail: string | null;
  accountId: string;
  role: AppRole;
  propertyAccess: string[];
}

async function loadCaller(authUserId: string, authEmail: string | null): Promise<CallerContext | null> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id, role, property_access')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    authUserId,
    authEmail,
    accountId: data.id,
    role: data.role as AppRole,
    propertyAccess: Array.isArray(data.property_access) ? data.property_access : [],
  };
}

function callerCanManageProperty(caller: CallerContext, propertyId: string): boolean {
  if (caller.role === 'admin') return true;
  if (caller.propertyAccess.includes('*')) return true;
  return caller.propertyAccess.includes(propertyId);
}

/**
 * Permission matrix for role changes within a single hotel.
 * Returns null when allowed; an error string when blocked.
 * Exported for unit tests.
 */
export function denyRoleChange(args: {
  caller: CallerContext;
  targetCurrentRole: AppRole;
  newRole: AssignableRole;
  isSelf: boolean;
}): string | null {
  const { caller, targetCurrentRole, newRole, isSelf } = args;
  if (targetCurrentRole === 'admin') return 'Cannot modify admin accounts here';
  if (newRole === 'owner' as AssignableRole && caller.role !== 'admin' && caller.role !== 'owner') {
    return 'Only an existing owner can promote someone to owner (use Transfer Ownership)';
  }
  if (targetCurrentRole === 'owner' && caller.role !== 'admin' && caller.role !== 'owner') {
    return 'Only an admin or another owner can change an owner\'s role';
  }
  // GMs can manage non-GM, non-owner, non-admin staff. They can't demote
  // (or promote) another GM — that's an owner/admin decision so power
  // doesn't quietly migrate sideways within the GM tier. Same logic
  // applies to promoting a non-GM to GM: requires owner/admin.
  if (caller.role === 'general_manager') {
    if (targetCurrentRole === 'general_manager') {
      return 'Only an owner or admin can change another General Manager\'s role';
    }
    // Target is not currently a GM (early return above). Block promotions
    // into the GM tier by other GMs — keeps "manage your team" scoped
    // away from "create new managers."
    if (newRole === 'general_manager') {
      return 'Only an owner or admin can promote someone to General Manager';
    }
  }
  if (isSelf && newRole !== caller.role) {
    return 'Cannot change your own role here — use Transfer Ownership instead';
  }
  return null;
}

interface UserRow {
  accountId: string;
  username: string;
  displayName: string;
  email: string;
  role: AppRole;
  active: boolean;
  lastSignInAt: string | null;
  propertyAccess: string[];
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const caller = await loadCaller(session.userId, session.email);
  if (!caller) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  // The "who can manage users" gate moved below to a per-hotel manage_users
  // capability check (needs the property id). Default: every role; an admin can
  // switch a role OFF per hotel. The fine-grained owner/GM privilege-escalation
  // rules in validateRoleChange still apply on top of this.

  const url = new URL(req.url);
  const pidV = validateUuid(url.searchParams.get('propertyId'), 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!callerCanManageProperty(caller, pidV.value!) || !(await canForProperty({ role: caller.role }, 'manage_users', pidV.value!))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const { data: accountRows, error: qErr } = await supabaseAdmin
    .from('accounts')
    .select('id, username, display_name, role, active, data_user_id, property_access, created_at')
    .order('created_at', { ascending: true });
  if (qErr) {
    log.error('[settings/users:GET] accounts query failed', { requestId, err: qErr.message });
    return err('Failed to load users', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  // Filter to accounts with access to this hotel. Hide admins from
  // non-admin viewers (Staxis platform team is not part of the hotel
  // org chart).
  const rows = (accountRows ?? []).filter((r: { role: string; property_access: string[] | null }) => {
    if (r.role === 'admin') return caller.role === 'admin';
    return Array.isArray(r.property_access) && r.property_access.includes(pidV.value!);
  });

  const emailByUserId = new Map<string, string>();
  // Supabase Auth tracks last_sign_in_at natively on auth.users — that is
  // the single source of truth. There is intentionally NO last_sign_in_at
  // column on `accounts` (see migration 0220) — do not SELECT it here, or
  // the whole accounts query 500s.
  const lastSignInByUserId = new Map<string, string | null>();
  const { data: authPage } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of authPage?.users ?? []) {
    if (u.id) {
      if (u.email) emailByUserId.set(u.id, u.email);
      lastSignInByUserId.set(u.id, u.last_sign_in_at ?? null);
    }
  }

  const users: UserRow[] = rows.map((r: {
    id: string; username: string; display_name: string; role: string; active: boolean;
    data_user_id: string; property_access: string[] | null;
  }) => ({
    accountId: r.id,
    username: r.username,
    displayName: r.display_name,
    email: emailByUserId.get(r.data_user_id) ?? '',
    role: r.role as AppRole,
    active: r.active !== false,
    lastSignInAt: lastSignInByUserId.get(r.data_user_id) ?? null,
    propertyAccess: Array.isArray(r.property_access) ? r.property_access : [],
  }));

  return ok({ users }, { requestId });
}

interface ActionBody {
  propertyId?: unknown;
  accountId?: unknown;
  action?: unknown;
  newRole?: unknown;
  newOwnerAccountId?: unknown;
  reason?: unknown;
}

export async function PUT(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = await req.json().catch(() => null) as ActionBody | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const caller = await loadCaller(session.userId, session.email);
  if (!caller) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  // The "who can manage users" gate moved below to a per-hotel manage_users
  // capability check (needs the property id). Default: every role; an admin can
  // switch a role OFF per hotel. The fine-grained owner/GM privilege-escalation
  // rules in validateRoleChange still apply on top of this.

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!callerCanManageProperty(caller, pidV.value!) || !(await canForProperty({ role: caller.role }, 'manage_users', pidV.value!))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const accountIdV = validateUuid(body.accountId, 'accountId');
  if (accountIdV.error) return err(accountIdV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const action = typeof body.action === 'string' ? body.action : '';
  const propertyId = pidV.value!;
  const accountId = accountIdV.value!;

  // Load the target row. We need data_user_id so deactivate/reactivate
  // can flip ban_duration on the matching auth.users row — without that,
  // the deactivated user could still sign in (auth is fully client-side
  // via Supabase Auth; the active column alone is not a sign-in gate).
  const { data: target, error: tErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, active, property_access, display_name, data_user_id')
    .eq('id', accountId)
    .maybeSingle();
  if (tErr || !target) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!Array.isArray(target.property_access) || !target.property_access.includes(propertyId)) {
    return err('Account is not associated with this hotel', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (target.role === 'admin') {
    return err('Cannot modify admin accounts here', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const isSelf = accountId === caller.accountId;

  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;

  switch (action) {
    case 'change_role': {
      if (typeof body.newRole !== 'string' || !isAssignableRole(body.newRole)) {
        return err('Invalid newRole', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      }
      const newRole = body.newRole;
      const denied = denyRoleChange({
        caller,
        targetCurrentRole: target.role as AppRole,
        newRole,
        isSelf,
      });
      if (denied) return err(denied, { requestId, status: 403, code: ApiErrorCode.Forbidden });
      if (newRole === target.role) return ok({ noop: true }, { requestId });

      const { error: upErr } = await supabaseAdmin
        .from('accounts')
        .update({ role: newRole })
        .eq('id', accountId);
      if (upErr) {
        log.error('[settings/users:PUT] change_role failed', { requestId, err: upErr.message });
        return err('Failed to update role', { requestId, status: 500, code: ApiErrorCode.InternalError });
      }

      await writeRoleChange({
        accountId, propertyId,
        changedByAccountId: caller.accountId,
        oldRole: target.role as AppRole,
        newRole,
        changeKind: 'role_change',
        reason,
      });
      await writeAudit({
        action: 'account.role_change',
        actorUserId: caller.authUserId, actorEmail: caller.authEmail ?? undefined,
        targetType: 'account', targetId: accountId, hotelId: propertyId,
        metadata: { old_role: target.role, new_role: newRole, reason },
      });
      return ok({ accountId, newRole }, { requestId });
    }

    case 'deactivate': {
      if (isSelf) return err('Cannot deactivate your own account', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      if (target.role === 'owner' && caller.role !== 'admin' && caller.role !== 'owner') {
        return err('Only an owner or admin can deactivate an owner account', { requestId, status: 403, code: ApiErrorCode.Forbidden });
      }
      if (target.active === false) return ok({ noop: true }, { requestId });

      // Block sign-in FIRST via Supabase Auth's ban_duration. If this
      // succeeds and the subsequent accounts update fails, the user is
      // still blocked at the auth layer — which is the actual security
      // boundary. We use a far-future ban (100y) rather than 'permanent'
      // because the gotrue API expects a Go-duration string. Reactivate
      // sets it back to 'none' to clear.
      const { error: banErr } = await supabaseAdmin.auth.admin.updateUserById(
        target.data_user_id as string,
        { ban_duration: '876000h' },
      );
      if (banErr) {
        log.error('[settings/users:PUT] deactivate ban failed', { requestId, err: banErr.message });
        return err('Failed to block sign-in for account', { requestId, status: 500, code: ApiErrorCode.InternalError });
      }

      const { error: upErr } = await supabaseAdmin
        .from('accounts')
        .update({ active: false })
        .eq('id', accountId);
      if (upErr) {
        // Roll back the auth ban so we don't leave the user signed-out
        // but flagged active in the app DB (the inverse split-brain).
        await supabaseAdmin.auth.admin.updateUserById(target.data_user_id as string, { ban_duration: 'none' });
        log.error('[settings/users:PUT] deactivate failed (rolled back ban)', { requestId, err: upErr.message });
        return err('Failed to deactivate account', { requestId, status: 500, code: ApiErrorCode.InternalError });
      }
      await writeRoleChange({
        accountId, propertyId,
        changedByAccountId: caller.accountId,
        oldRole: target.role as AppRole,
        newRole: target.role as AppRole,
        changeKind: 'deactivate',
        reason,
      });
      await writeAudit({
        action: 'account.deactivate',
        actorUserId: caller.authUserId, actorEmail: caller.authEmail ?? undefined,
        targetType: 'account', targetId: accountId, hotelId: propertyId,
        metadata: { role: target.role, reason, sign_in_blocked: true },
      });
      return ok({ accountId, active: false }, { requestId });
    }

    case 'reactivate': {
      if (target.active === true) return ok({ noop: true }, { requestId });

      // Clear the auth ban first so the user can sign in immediately
      // once the accounts row flips. Symmetric to deactivate: even if
      // the accounts update fails, the user becomes signable-in (which
      // is the right product outcome — reactivation should be lenient).
      const { error: banErr } = await supabaseAdmin.auth.admin.updateUserById(
        target.data_user_id as string,
        { ban_duration: 'none' },
      );
      if (banErr) {
        log.error('[settings/users:PUT] reactivate ban-clear failed', { requestId, err: banErr.message });
        return err('Failed to unblock sign-in for account', { requestId, status: 500, code: ApiErrorCode.InternalError });
      }

      const { error: upErr } = await supabaseAdmin
        .from('accounts')
        .update({ active: true })
        .eq('id', accountId);
      if (upErr) {
        log.error('[settings/users:PUT] reactivate failed', { requestId, err: upErr.message });
        return err('Failed to reactivate account', { requestId, status: 500, code: ApiErrorCode.InternalError });
      }
      await writeRoleChange({
        accountId, propertyId,
        changedByAccountId: caller.accountId,
        oldRole: target.role as AppRole,
        newRole: target.role as AppRole,
        changeKind: 'reactivate',
        reason,
      });
      await writeAudit({
        action: 'account.reactivate',
        actorUserId: caller.authUserId, actorEmail: caller.authEmail ?? undefined,
        targetType: 'account', targetId: accountId, hotelId: propertyId,
        metadata: { role: target.role, reason, sign_in_blocked: false },
      });
      return ok({ accountId, active: true }, { requestId });
    }

    case 'transfer_ownership': {
      if (caller.role !== 'admin' && caller.role !== 'owner') {
        return err('Only the current owner can transfer ownership', { requestId, status: 403, code: ApiErrorCode.Forbidden });
      }
      const newOwnerV = validateUuid(body.newOwnerAccountId, 'newOwnerAccountId');
      if (newOwnerV.error) return err(newOwnerV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const newOwnerId = newOwnerV.value!;
      if (newOwnerId === caller.accountId) {
        return err('You are already the owner', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      }

      // Pre-load the new owner so we can fail fast with a friendly
      // message (the DB function repeats these checks atomically so a
      // race between the read here and the RPC can't slip through).
      const { data: newOwner, error: noErr } = await supabaseAdmin
        .from('accounts')
        .select('id, role, active, property_access')
        .eq('id', newOwnerId)
        .maybeSingle();
      if (noErr || !newOwner) return err('Proposed new owner not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
      if (newOwner.role === 'admin') return err('Cannot transfer ownership to an admin account', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      if (newOwner.active === false) return err('Cannot transfer ownership to a deactivated account', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      if (!Array.isArray(newOwner.property_access) || !newOwner.property_access.includes(propertyId)) {
        return err('Proposed new owner does not have access to this hotel', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      }

      const oldOwnerOldRole = caller.role as AppRole;
      const newOwnerOldRole = newOwner.role as AppRole;

      // Atomic swap inside one transaction via the SECURITY DEFINER
      // helper added by migration 0220. Replaces the prior two-step
      // UPDATE pattern, which could leave the hotel with two owners
      // (or zero) if the second update failed and the rollback also
      // failed.
      const { data: rpcRes, error: rpcErr } = await supabaseAdmin.rpc(
        'staxis_transfer_ownership',
        {
          p_property_id: propertyId,
          p_old_owner_account_id: caller.accountId,
          p_new_owner_account_id: newOwnerId,
        },
      );
      if (rpcErr) {
        log.error('[settings/users:PUT] transfer rpc failed', { requestId, err: rpcErr.message });
        return err('Failed to transfer ownership', { requestId, status: 500, code: ApiErrorCode.InternalError });
      }
      // The function returns a JSON-shaped TEXT — Supabase wraps it as
      // `data: "<string>"`. Parse it once to surface the guard error
      // (e.g. "caller is not currently the owner") as a 400 the UI can
      // show verbatim.
      let parsed: { ok?: boolean; error?: string } = {};
      try { parsed = JSON.parse(typeof rpcRes === 'string' ? rpcRes : ''); } catch { /* fall through */ }
      if (!parsed.ok) {
        return err(parsed.error ?? 'Ownership transfer rejected by the database guard', {
          requestId, status: 400, code: ApiErrorCode.ValidationFailed,
        });
      }

      await Promise.all([
        writeRoleChange({
          accountId: newOwnerId, propertyId,
          changedByAccountId: caller.accountId,
          oldRole: newOwnerOldRole, newRole: 'owner',
          changeKind: 'transfer_ownership',
          reason,
        }),
        writeRoleChange({
          accountId: caller.accountId, propertyId,
          changedByAccountId: caller.accountId,
          oldRole: oldOwnerOldRole, newRole: 'general_manager',
          changeKind: 'transfer_ownership',
          reason,
        }),
        writeAudit({
          action: 'account.transfer_ownership',
          actorUserId: caller.authUserId, actorEmail: caller.authEmail ?? undefined,
          targetType: 'account', targetId: newOwnerId,
          hotelId: propertyId,
          metadata: {
            from_account_id: caller.accountId,
            from_old_role: oldOwnerOldRole,
            to_old_role: newOwnerOldRole,
            reason,
          },
        }),
      ]);

      return ok({ newOwnerId, oldOwnerId: caller.accountId }, { requestId });
    }

    default:
      return err('Unknown action', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
}
