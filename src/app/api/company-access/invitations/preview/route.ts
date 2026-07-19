// POST /api/company-access/invitations/preview
//
// Public, token-capability preview for the invitation acceptance screen. It
// exposes only the human-readable terms already carried by the invitation
// email. The raw token is accepted in the request body so it never enters API
// query strings, access logs, or analytics URLs.

import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';

import { checkAndIncrementRateLimit, clientIpRateLimitKey, rateLimitedResponse } from '@/lib/api-ratelimit';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { isCompanyAccessUnavailable } from '@/lib/company-access/database-errors';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RAW_TOKEN_RX = /^[0-9a-f]{64}$/i;
const PRIVATE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
};

interface InvitationPreviewRow {
  organization_id: string;
  email: string;
  job_title: string | null;
  access_profile: string;
  scope_type: 'organization' | 'portfolio' | 'property';
  portfolio_id: string | null;
  property_relationship_id: string | null;
  property_id: string | null;
  grant_expires_at: string | null;
  status: string;
  expires_at: string;
}

function invalidInvitation(requestId: string) {
  return err('Invitation is invalid or expired', {
    requestId,
    status: 410,
    code: ApiErrorCode.IdempotencyConflict,
    headers: PRIVATE_HEADERS,
  });
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const limit = await checkAndIncrementRateLimit('company-invitation-preview', clientIpRateLimitKey(req));
  if (!limit.allowed) return rateLimitedResponse(limit.current, limit.cap, limit.retryAfterSec);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers: PRIVATE_HEADERS,
    });
  }
  const token = body && typeof body === 'object' && typeof (body as { token?: unknown }).token === 'string'
    ? (body as { token: string }).token.trim()
    : '';
  if (!RAW_TOKEN_RX.test(token)) return invalidInvitation(requestId);

  try {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const { data: invitationData, error: invitationError } = await supabaseAdmin
      .from('organization_invitations')
      .select('organization_id, email, job_title, access_profile, scope_type, portfolio_id, property_relationship_id, property_id, grant_expires_at, status, expires_at')
      .eq('token_hash', tokenHash)
      .maybeSingle();
    if (invitationError) throw invitationError;
    const invitation = invitationData as InvitationPreviewRow | null;
    if (!invitation
      || invitation.status !== 'pending'
      || new Date(invitation.expires_at).getTime() <= Date.now()) {
      return invalidInvitation(requestId);
    }

    const { data: organization, error: organizationError } = await supabaseAdmin
      .from('organizations')
      .select('name, status')
      .eq('id', invitation.organization_id)
      .maybeSingle();
    if (organizationError) throw organizationError;
    if (!organization || organization.status !== 'active') return invalidInvitation(requestId);

    let scopeLabel = organization.name as string;
    if (invitation.scope_type === 'portfolio') {
      if (!invitation.portfolio_id) return invalidInvitation(requestId);
      const { data: portfolio, error: portfolioError } = await supabaseAdmin
        .from('portfolios')
        .select('name, status')
        .eq('id', invitation.portfolio_id)
        .eq('organization_id', invitation.organization_id)
        .maybeSingle();
      if (portfolioError) throw portfolioError;
      if (!portfolio || portfolio.status !== 'active') return invalidInvitation(requestId);
      scopeLabel = portfolio.name as string;
    } else if (invitation.scope_type === 'property') {
      if (!invitation.property_relationship_id || !invitation.property_id) return invalidInvitation(requestId);
      const [{ data: relationship, error: relationshipError }, { data: property, error: propertyError }] = await Promise.all([
        supabaseAdmin
          .from('organization_property_relationships')
          .select('starts_at, ends_at')
          .eq('id', invitation.property_relationship_id)
          .eq('organization_id', invitation.organization_id)
          .eq('property_id', invitation.property_id)
          .maybeSingle(),
        supabaseAdmin.from('properties').select('name').eq('id', invitation.property_id).maybeSingle(),
      ]);
      if (relationshipError) throw relationshipError;
      if (propertyError) throw propertyError;
      const now = Date.now();
      const relationshipStartsAt = relationship ? new Date(relationship.starts_at).getTime() : Number.NaN;
      const relationshipEndsAt = relationship?.ends_at ? new Date(relationship.ends_at).getTime() : null;
      if (!relationship || !property || relationshipStartsAt > now || (relationshipEndsAt !== null && relationshipEndsAt <= now)) {
        return invalidInvitation(requestId);
      }
      scopeLabel = (property.name as string | null) ?? 'Unnamed hotel';
    }

    return ok({
      organizationName: organization.name as string,
      invitedEmail: invitation.email,
      jobTitle: invitation.job_title,
      accessProfile: invitation.access_profile,
      scopeType: invitation.scope_type,
      scopeLabel,
      accessExpiresAt: invitation.grant_expires_at,
      invitationExpiresAt: invitation.expires_at,
    }, { requestId, headers: PRIVATE_HEADERS });
  } catch (caught) {
    log.error('[company-invite:preview] failed', { requestId, error: errToString(caught) });
    return err('Invitation preview is temporarily unavailable', {
      requestId,
      status: 503,
      code: isCompanyAccessUnavailable(caught) ? ApiErrorCode.UpstreamFailure : ApiErrorCode.InternalError,
      headers: PRIVATE_HEADERS,
    });
  }
}
