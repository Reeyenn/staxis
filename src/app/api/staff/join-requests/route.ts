// /api/staff/join-requests — the Directory's "waiting to approve" queue.
//
//   GET  ?hotelId=…
//     List pending join requests for the hotel (name, department, language,
//     phone, when they signed up). Manager-only (manage_team).
//
//   PUT
//     Body: { hotelId, requestId, decision: 'approve' | 'deny' }
//     Approve: create the staff row from the request (name/phone/language/
//     department), link accounts.staff_id, append property_access, mark the
//     request approved. Deny: mark denied — the account keeps existing but
//     never gains access to the hotel.
//
// join_requests has RLS with no policies (migration 0315) — service-role
// only, so all reads/writes live here. Rows are written by
// /api/auth/use-join-code at signup time.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { verifyTeamManager, callerCan } from '@/lib/team-auth';
import { validateUuid } from '@/lib/api-validate';
import { writeAudit } from '@/lib/audit';
import { toStaffRow } from '@/lib/db-mappers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface JoinRequestRow {
  id: string;
  property_id: string;
  account_id: string;
  name: string;
  phone: string | null;
  language: 'en' | 'es';
  department: string;
  status: 'pending' | 'approved' | 'denied';
  created_at: string;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const hotelIdCheck = validateUuid(searchParams.get('hotelId'), 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;
  if (!(await callerCan(caller, 'manage_team', hotelId))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const { data, error: qErr } = await supabaseAdmin
    .from('join_requests')
    .select('id, name, phone, language, department, created_at')
    .eq('property_id', hotelId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (qErr) {
    log.error('[join-requests:GET] query failed', { requestId, msg: errToString(qErr) });
    return err('Failed to load join requests', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  return ok({ requests: data ?? [] }, { requestId });
}

export async function PUT(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const body = await req.json().catch(() => ({})) as {
    hotelId?: string; requestId?: string; decision?: string;
  };
  const hotelIdCheck = validateUuid(body.hotelId, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;
  const reqIdCheck = validateUuid(body.requestId, 'requestId');
  if (reqIdCheck.error) return err(reqIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const joinRequestId = reqIdCheck.value!;
  if (body.decision !== 'approve' && body.decision !== 'deny') {
    return err('decision must be approve | deny', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (!(await callerCan(caller, 'manage_team', hotelId))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const { data: jr, error: jrErr } = await supabaseAdmin
    .from('join_requests')
    .select('id, property_id, account_id, name, phone, language, department, status, created_at')
    .eq('id', joinRequestId)
    .eq('property_id', hotelId)
    .maybeSingle();
  if (jrErr || !jr) return err('Request not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  const request = jr as JoinRequestRow;
  if (request.status !== 'pending') {
    return err('Request has already been decided', { requestId, status: 409, code: ApiErrorCode.IdempotencyConflict });
  }

  // Claim the request first (pending → decided) with a status guard, so two
  // managers tapping Approve at once can't double-create the staff row.
  const decidedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from('join_requests')
    .update({
      status: body.decision === 'approve' ? 'approved' : 'denied',
      decided_at: decidedAt,
      decided_by: caller.accountId,
    })
    .eq('id', request.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (claimErr || !claimed) {
    return err('Request has already been decided', { requestId, status: 409, code: ApiErrorCode.IdempotencyConflict });
  }

  if (body.decision === 'deny') {
    await writeAudit({
      action: 'join_request.deny',
      actorUserId: caller.authUserId,
      targetType: 'join_request',
      targetId: request.id,
      hotelId,
      metadata: { name: request.name, department: request.department },
    });
    return ok({ decided: 'denied' }, { requestId });
  }

  // ── Approve ────────────────────────────────────────────────────────────
  // Order matters for recoverability: staff row → account link+access →
  // done. If a later step fails we revert the claim to 'pending' so the
  // manager can simply tap Approve again.
  const revertClaim = async () => {
    await supabaseAdmin
      .from('join_requests')
      .update({ status: 'pending', decided_at: null, decided_by: null })
      .eq('id', request.id)
      .then(({ error: revErr }) => {
        if (revErr) log.error('[join-requests:PUT] claim revert failed', { requestId, joinRequestId: request.id, msg: errToString(revErr) });
      });
  };

  const { data: account, error: accErr } = await supabaseAdmin
    .from('accounts')
    .select('id, property_access, staff_id')
    .eq('id', request.account_id)
    .maybeSingle();
  if (accErr || !account) {
    // Account deleted since signup (e.g. admin cleanup). Nothing to grant —
    // leave the request denied-equivalent by keeping the claim, but record
    // what happened.
    await writeAudit({
      action: 'join_request.approve_orphaned',
      actorUserId: caller.authUserId,
      targetType: 'join_request',
      targetId: request.id,
      hotelId,
      metadata: { name: request.name, reason: 'account no longer exists' },
    });
    return err('That signup no longer exists — the account was deleted.', { requestId, status: 410, code: ApiErrorCode.NotFound });
  }
  if (account.staff_id) {
    await revertClaim();
    return err('That login is already linked to a staff member.', { requestId, status: 409, code: ApiErrorCode.IdempotencyConflict });
  }

  const staffRow = {
    ...toStaffRow({
      name: request.name,
      phone: request.phone ?? '',
      language: request.language,
      department: request.department as never,
      isSenior: false,
      isActive: true,
      maxWeeklyHours: 40,
      maxDaysPerWeek: 5,
      scheduledToday: false,
      weeklyHours: 0,
    }),
    property_id: hotelId,
  };
  const { data: staffIns, error: staffErr } = await supabaseAdmin
    .from('staff').insert(staffRow).select('id').single();
  if (staffErr || !staffIns) {
    log.error('[join-requests:PUT] staff insert failed', { requestId, msg: errToString(staffErr) });
    await revertClaim();
    return err('Failed to add them to the directory — try again.', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  const staffId = String(staffIns.id);

  const nextAccess = Array.isArray(account.property_access) && account.property_access.includes(hotelId)
    ? account.property_access
    : [...(account.property_access ?? []), hotelId];
  const { data: linkedAccount, error: linkErr } = await supabaseAdmin
    .from('accounts')
    .update({ staff_id: staffId, property_access: nextAccess })
    .eq('id', request.account_id)
    .is('staff_id', null)
    .select('id')
    .maybeSingle();
  if (linkErr || !linkedAccount) {
    if (linkErr) {
      log.error('[join-requests:PUT] account link failed', { requestId, msg: errToString(linkErr) });
    } else {
      log.warn('[join-requests:PUT] account link lost concurrency race', {
        requestId,
        accountId: request.account_id,
      });
    }
    await supabaseAdmin.from('staff').delete().eq('id', staffId).then(({ error: delErr }) => {
      if (delErr) log.error('[join-requests:PUT] staff rollback failed', { requestId, staffId, msg: errToString(delErr) });
    });
    await revertClaim();
    return err(
      linkErr
        ? 'Failed to link their login — try again.'
        : 'That login was linked to another staff member. Refresh and try again.',
      {
        requestId,
        status: linkErr ? 500 : 409,
        code: linkErr ? ApiErrorCode.InternalError : ApiErrorCode.IdempotencyConflict,
      },
    );
  }

  await writeAudit({
    action: 'join_request.approve',
    actorUserId: caller.authUserId,
    targetType: 'join_request',
    targetId: request.id,
    hotelId,
    metadata: { name: request.name, department: request.department, staffId, accountId: request.account_id },
  });
  return ok({ decided: 'approved', staffId }, { requestId });
}
