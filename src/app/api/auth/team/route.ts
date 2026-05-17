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
import { log, getOrMintRequestId } from '@/lib/log';
import { verifyTeamManager, canManageHotel } from '@/lib/team-auth';
import { isAssignableRole, type AppRole } from '@/lib/roles';
import { writeAudit } from '@/lib/audit';
import { validateUuid } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const hotelIdRaw = searchParams.get('hotelId');
  if (!hotelIdRaw) return err('hotelId required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelIdCheck = validateUuid(hotelIdRaw, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;
  if (!canManageHotel(caller, hotelId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const { data: rows, error: qErr } = await supabaseAdmin
    .from('accounts')
    .select('id, username, display_name, role, property_access, created_at, data_user_id')
    .order('created_at', { ascending: true });
  if (qErr) {
    console.error('[team:GET] query failed', qErr);
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
    console.error('[team:GET] auth listUsers failed', listErr);
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
    createdAt: r.created_at,
  }));

  return ok({ team }, { requestId });
}

export async function PUT(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const body = await req.json().catch(() => ({})) as {
    hotelId?: string;
    accountId?: string;
    displayName?: string;
    role?: string;
    password?: string;
  };
  const { displayName, role, password } = body;

  const hotelIdCheck = validateUuid(body.hotelId, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;

  const accountIdCheck = validateUuid(body.accountId, 'accountId');
  if (accountIdCheck.error) return err(accountIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const accountId = accountIdCheck.value!;

  if (!canManageHotel(caller, hotelId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  // Load target.
  const { data: target, error: tErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, data_user_id, property_access, display_name')
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

  // Password reset: requires Supabase 6-char minimum.
  if (password) {
    if (password.length < 6) {
      return err('Password must be at least 6 characters', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(target.data_user_id, { password });
    if (pwErr) {
      log.error('[team:PUT] password update failed', { err: pwErr, requestId });
      return err('Failed to update password', {
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
      console.error('[team:PUT] update failed', upErr);
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
    },
  });

  return ok({ success: true }, { requestId });
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const hotelIdCheck = validateUuid(searchParams.get('hotelId'), 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;

  const accountIdCheck = validateUuid(searchParams.get('accountId'), 'accountId');
  if (accountIdCheck.error) return err(accountIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const accountId = accountIdCheck.value!;

  if (!canManageHotel(caller, hotelId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }
  if (accountId === caller.accountId) {
    return err('Cannot remove yourself from a hotel', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const { data: target, error: tErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, property_access')
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

  const current = Array.isArray(target.property_access) ? target.property_access : [];
  const next = current.filter((p: string) => p !== hotelId);
  if (next.length === current.length) {
    // Already not on this hotel — idempotent success.
    return ok({ success: true, alreadyRemoved: true }, { requestId });
  }

  const { error: upErr } = await supabaseAdmin
    .from('accounts')
    .update({ property_access: next })
    .eq('id', accountId);
  if (upErr) {
    console.error('[team:DELETE] update failed', upErr);
    return err('Failed to remove access', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  await writeAudit({
    action: 'account.team_detach',
    actorUserId: caller.authUserId,
    actorEmail: caller.authEmail,
    targetType: 'account',
    targetId: accountId,
    hotelId,
    metadata: { remaining_hotels: next.length },
  });

  return ok({ success: true }, { requestId });
}
