// POST /api/company-access/invitations/accept
// Authenticated acceptance for an existing Staxis account. The database
// atomically matches the account's verified auth email, re-checks the
// inviter's current authority, and creates the membership/grant.
//
// @tenant-scope session user -> accounts.id; the token is a single-use
// capability and no account, organization, profile, or scope is client-set.

import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ok, ApiErrorCode, buildOkBody } from '@/lib/api-response';
import { recordIdempotency } from '@/lib/idempotency';
import { isCompanyAccessUnavailable } from '@/lib/company-access/database-errors';
import { getOrMintRequestId, log } from '@/lib/log';
import { loadOrganizationActor } from '@/lib/organization-access/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RAW_TOKEN_RX = /^[0-9a-f]{64}$/i;
const CLAIM_ROUTE = 'company-invitation-register';

interface ClaimRow {
  claimed: boolean;
  existing_response: unknown;
  existing_status: number | null;
}

async function releasePendingClaim(claimKey: string, requestId: string) {
  const { error } = await supabaseAdmin.from('idempotency_log')
    .delete()
    .eq('key', claimKey)
    .eq('route', CLAIM_ROUTE)
    .eq('status_code', 0)
    .contains('response', { __pending__: true });
  if (error) log.warn('[company-access:invitation-accept] claim release failed', {
    requestId, code: error.code ?? null,
  });
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const token = body && typeof body === 'object' && typeof (body as { token?: unknown }).token === 'string'
    ? (body as { token: string }).token.trim()
    : '';
  if (!RAW_TOKEN_RX.test(token)) {
    return err('Invitation is invalid or expired', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const claimKey = `orginvite_${tokenHash}`;
  let ownsClaim = false;
  try {
    const actor = await loadOrganizationActor(session.userId, session.email);
    if (!actor) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });

    // Registration and authenticated acceptance consume the same token. A
    // shared atomic claim prevents either path from accepting while the other
    // is between auth creation and the DB transaction.
    const { data: claimData, error: claimError } = await supabaseAdmin.rpc('claim_idempotency_key', {
      p_key: claimKey,
      p_route: CLAIM_ROUTE,
    });
    if (claimError) {
      log.error('[company-access:invitation-accept] claim failed closed', {
        requestId, code: claimError.code ?? null,
      });
      return err('Invitation acceptance is temporarily unavailable', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    const claim = (Array.isArray(claimData) ? claimData[0] : claimData) as ClaimRow | undefined;
    if (!claim?.claimed) {
      const pending = Boolean(claim?.existing_response
        && typeof claim.existing_response === 'object'
        && (claim.existing_response as Record<string, unknown>).__pending__ === true);
      const existing = !pending && claim?.existing_response
        && typeof claim.existing_response === 'object'
        ? claim.existing_response as Record<string, unknown>
        : null;
      const existingData = existing?.data && typeof existing.data === 'object'
        ? existing.data as Record<string, unknown>
        : null;
      if (existing
        && claim?.existing_status === 200
        && existingData?.claimMode === 'authenticated_accept'
        && existingData.acceptedAccountId === actor.accountId) {
        return NextResponse.json(existing, { status: 200 });
      }
      return err(
        pending ? 'This invitation is already being accepted. Please wait and try again.' : 'Invitation is invalid, expired, or already used',
        {
          requestId,
          status: pending ? 409 : 410,
          code: ApiErrorCode.IdempotencyConflict,
        },
      );
    }
    ownsClaim = true;

    const { data, error: rpcError } = await supabaseAdmin.rpc(
      'staxis_accept_organization_invitation',
      { p_token_hash: tokenHash, p_account_id: actor.accountId },
    );
    if (rpcError) {
      const forbidden = rpcError.code === '42501';
      const unavailable = rpcError.code === '22023' || rpcError.code === '23514' || rpcError.code === '55000';
      const deploymentUnavailable = isCompanyAccessUnavailable(rpcError);
      log.warn('[company-access:invitation-accept] rejected', { requestId, code: rpcError.code ?? null });
      if (rpcError.code) {
        await releasePendingClaim(claimKey, requestId);
        ownsClaim = false;
      }
      return err(
        deploymentUnavailable ? 'Invitation acceptance is temporarily unavailable' : forbidden ? 'This invitation belongs to a different email or is no longer authorized' : 'Invitation is invalid, expired, or already used',
        {
          requestId,
          status: deploymentUnavailable ? 503 : forbidden ? 403 : unavailable ? 410 : 500,
          code: deploymentUnavailable ? ApiErrorCode.UpstreamFailure : forbidden ? ApiErrorCode.Forbidden : unavailable ? ApiErrorCode.IdempotencyConflict : ApiErrorCode.InternalError,
        },
      );
    }
    const accepted = Array.isArray(data) ? data[0] : data;
    const result = {
      membershipId: accepted?.membership_id ?? null,
      grantId: accepted?.grant_id ?? null,
      claimMode: 'authenticated_accept',
      // Load-bearing replay binding: a completed token claim is replayed only
      // to this same authenticated account. Registration and other accounts
      // continue to receive a conflict without learning acceptance details.
      acceptedAccountId: actor.accountId,
    };
    await recordIdempotency(claimKey, CLAIM_ROUTE, buildOkBody(result, requestId), 200);
    ownsClaim = false;
    return ok(result, { requestId });
  } catch (caught) {
    if (ownsClaim) await releasePendingClaim(claimKey, requestId);
    log.error('[company-access:invitation-accept] failed', { requestId, error: errToString(caught) });
    return err('Could not accept invitation', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
