// POST /api/auth/invite-preview — what an invitation says, BEFORE accepting it.
//
// The public /invite/[token] page used to ask a stranger for their full name
// and a password while telling them nothing: no who, no where, no what job. A
// person who cannot see what they are joining cannot tell a real invitation
// from a phishing page wearing the same layout, and the honest ones just guess.
// This route is the answer to "what am I accepting?" and nothing more.
//
// ─── RLS BUG CLASS ─────────────────────────────────────────────────────────
// The visitor is NOT signed in. Every read here therefore goes through
// `supabaseAdmin` (service role) inside this route. A public page that reads
// through the browser client gets the anon role, RLS returns `200 OK` with
// `[]`, and the page silently renders empty while the owner cannot reproduce it
// because they are signed in. See CLAUDE.md; this has bitten the app repeatedly.
//
// ─── THE CAPABILITY IS THE TOKEN ───────────────────────────────────────────
// There is no session to check. Holding the raw token IS the authorization,
// exactly as it is for /api/auth/accept-invite, and the token only ever existed
// in one email to one address. It is 24 random bytes; the raw value is never
// stored, only its SHA-256, and only the hash is ever compared.
//
// WHY NO RATE LIMITER: `checkAndIncrementRateLimit` is keyed on a real property
// id (FK to api_limits), and there is no property to key on until AFTER the
// token has been looked up — so limiting could only ever throttle VALID tokens,
// which is the opposite of useful. What actually protects this endpoint is that
// guessing a 192-bit token is infeasible, and that the work per call is one
// indexed lookup with no model call, no email, and no write.
//
// ─── WHAT IT REFUSES TO SAY ────────────────────────────────────────────────
// Never the token hash, never an account/property/organization id, never the
// inviter's email. And a bad token, an expired one and an already-accepted one
// all fail IDENTICALLY — same status, same code, same words — so this cannot be
// used to learn which tokens exist or which invitations are still open.

import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { HAT_ROLE_LABELS, isHatRole } from '@/lib/company/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

/** One refusal for every reason. See "WHAT IT REFUSES TO SAY" above. */
function unusable(requestId: string) {
  return err('This invitation link is not usable. Ask whoever invited you to send a new one.', {
    requestId,
    status: 404,
    code: ApiErrorCode.NotFound,
  });
}

interface PreviewInviteRow {
  hotel_id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
  invited_by: string | null;
  organization_id: string | null;
  membership_scope: string | null;
  covered_property_ids: string[] | null;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  let body: { token?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return err('A valid JSON body is required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  // Shape-check before touching the database. The tokens this app mints are
  // 24 random bytes rendered as hex.
  if (!/^[0-9a-f]{16,128}$/i.test(token)) return unusable(requestId);

  let invite: PreviewInviteRow | null = null;
  try {
    const { data, error } = await supabaseAdmin
      .from('account_invites')
      .select(
        'hotel_id, email, role, expires_at, accepted_at, invited_by, organization_id, membership_scope, covered_property_ids',
      )
      .eq('token_hash', hashToken(token))
      .maybeSingle();
    if (error) throw error;
    invite = (data as PreviewInviteRow | null) ?? null;
  } catch (lookupError) {
    log.error('[invite-preview] invitation lookup failed', {
      requestId, msg: errToString(lookupError),
    });
    return err('Something went wrong. Try again in a moment.', {
      requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      headers: { 'Retry-After': '5' },
    });
  }

  // Not found, already used, and expired are ONE outcome to the caller.
  if (!invite
      || invite.accepted_at !== null
      || !invite.expires_at
      || new Date(invite.expires_at).getTime() <= Date.now()) {
    return unusable(requestId);
  }

  const isCompanyScope = invite.membership_scope === 'company'
    && invite.organization_id !== null;

  // WHICH HOTELS this invitation names. A company invitation with no list
  // reaches the whole company, and says so in words rather than by listing
  // hotels the person cannot see yet.
  const namedPropertyIds = isCompanyScope
    ? (invite.covered_property_ids ?? [])
    : (invite.covered_property_ids ?? [invite.hotel_id]);

  let hotelNames: string[] = [];
  let companyName: string | null = null;
  let invitedByName: string | null = null;
  try {
    if (namedPropertyIds.length > 0) {
      const { data, error } = await supabaseAdmin
        .from('properties')
        .select('id, name')
        .in('id', namedPropertyIds.slice(0, 200));
      if (error) throw error;
      hotelNames = (data ?? [])
        .map((row) => (typeof row.name === 'string' ? row.name.trim() : ''))
        .filter((name) => name.length > 0)
        .sort((left, right) => left.localeCompare(right));
    }
    if (invite.organization_id) {
      const { data, error } = await supabaseAdmin
        .from('organizations')
        .select('name')
        .eq('id', invite.organization_id)
        .maybeSingle();
      if (error) throw error;
      const name = typeof data?.name === 'string' ? data.name.trim() : '';
      companyName = name.length > 0 ? name : null;
    }
    if (invite.invited_by) {
      const { data, error } = await supabaseAdmin
        .from('accounts')
        .select('display_name')
        .eq('id', invite.invited_by)
        .maybeSingle();
      if (error) throw error;
      const name = typeof data?.display_name === 'string' ? data.display_name.trim() : '';
      invitedByName = name.length > 0 ? name : null;
    }
  } catch (contextError) {
    // The names are the whole point of the screen. Rendering "You have been
    // invited to  as " would look broken and read as untrustworthy, so an
    // incomplete projection is a retry, not a half-filled page.
    log.error('[invite-preview] invitation context projection failed', {
      requestId, msg: errToString(contextError),
    });
    return err('Something went wrong. Try again in a moment.', {
      requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      headers: { 'Retry-After': '5' },
    });
  }

  return ok({
    email: invite.email,
    roleLabel: isHatRole(invite.role) ? HAT_ROLE_LABELS[invite.role].en : 'Team member',
    scope: isCompanyScope ? 'company' as const : 'hotel' as const,
    companyName,
    hotelNames,
    /** True when a company invitation follows the company into new hotels. */
    coversAllIncludingFuture: isCompanyScope && invite.covered_property_ids === null,
    invitedByName,
    expiresAt: invite.expires_at,
  }, { requestId });
}
