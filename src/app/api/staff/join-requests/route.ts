// /api/staff/join-requests — the "waiting to approve" queue on
// My Hotel → People.
//
//   GET  ?hotelId=…
//     List pending join requests for the hotel (name, department, language,
//     phone, when they signed up). Manager-only (manage_team).
//
//   PUT
//     Body: { hotelId, requestId, decision: 'approve' | 'deny' }
//     Approve: one database transaction creates the staff identity/link and
//     grants normalized property authority at a company hotel (or preserves
//     the legacy array model at an independent hotel), then marks approved and
//     audits. Deny is transactional too; the account never gains hotel access.
//
// join_requests has RLS with no policies (migration 0315) — service-role
// only, so all reads/writes live here. Rows are written by
// /api/auth/use-join-code at signup time.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import {
  verifyTeamManager,
  callerCapabilityDecision,
  callerCapabilityDecisionFresh,
} from '@/lib/team-auth';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { validateUuid } from '@/lib/api-validate';
import { requireSectionEnabled } from '@/lib/sections/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const hotelIdCheck = validateUuid(searchParams.get('hotelId'), 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;
  const capabilityDecision = await callerCapabilityDecision(caller, 'manage_team', hotelId);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }
  const sectionGate = await requireSectionEnabled(req, hotelId, 'staff');
  if (!sectionGate.ok) return sectionGate.response;

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
  const capabilityDecision = await callerCapabilityDecision(caller, 'manage_team', hotelId);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }
  const sectionGate = await requireSectionEnabled(req, hotelId, 'staff');
  if (!sectionGate.ok) return sectionGate.response;

  // Refresh the override store immediately before entering the database
  // transaction. The RPC independently recomputes authoritative reach after
  // taking the same property lock as a company transfer; this route check is a
  // fast explicit denial, not the commit-time authority source.
  const commitCapability = await callerCapabilityDecisionFresh(caller, 'manage_team', hotelId);
  if (commitCapability === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (commitCapability === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const { data, error: rpcError } = await supabaseAdmin.rpc(
    'staxis_decide_staff_join_request',
    {
      p_actor_account_id: caller.accountId,
      p_join_request_id: joinRequestId,
      p_property_id: hotelId,
      p_decision: body.decision,
    },
  );
  if (rpcError) {
    log.error('[join-requests:PUT] transactional decision failed', {
      requestId, joinRequestId, code: rpcError.code, msg: errToString(rpcError),
    });
    return err('Failed to decide the request. Try again.', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  const result = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null;
  if (!result || result.ok !== true) {
    const reason = typeof result?.reason === 'string' ? result.reason : 'unavailable';
    if (reason === 'not_found' || reason === 'property_not_found') {
      return err('Request not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }
    if (reason === 'forbidden' || reason === 'normalized_manager_required') {
      return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
    }
    if (reason === 'account_unavailable') {
      return err('That signup no longer exists. The account was deleted.', {
        requestId, status: 410, code: ApiErrorCode.NotFound,
      });
    }
    if (reason === 'already_decided' || reason === 'already_linked') {
      return err('Request has already been decided', {
        requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
      });
    }
    if (reason === 'normalized_independent_grant_unsupported'
      || reason === 'target_scope_not_empty'
      || reason === 'role_mismatch'
      || reason === 'ambiguous_topology'
      || reason === 'invalid_topology') {
      return err('This signup cannot be granted safely. Refresh the hotel access setup and try again.', {
        requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
      });
    }
    return err('Failed to decide the request. Try again.', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  const decided = result.decided === 'denied' ? 'denied' : 'approved';
  return ok({
    decided,
    ...(decided === 'approved' && typeof result.staffId === 'string'
      ? { staffId: result.staffId }
      : {}),
  }, { requestId });
}
