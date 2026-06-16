// GET /api/onboard/resume
//
// Authenticated login-funnel helper. When the funnel (property-selector /
// dashboard) detects that the signed-in owner's property is mid-onboarding
// (isOnboardingInProgress), it points the browser here. We resolve the
// owner's incomplete property + a usable join code and 302-redirect into
// the wizard, so they finish the 9 steps instead of being dropped on an
// empty dashboard with no PMS connected.
//
// This is the server side of the fix for the 2026-06-15 bug: "I create the
// account, enter the 2FA code, and instead of the next onboarding step it
// logs me into my own (empty) hotel." The root is that verifying email makes
// the owner a fully-authenticated single-property user, and the funnel's
// "1 property → dashboard" auto-forward then treats them as a returning user.
// The gate + this route keep an unfinished onboarding INSIDE the wizard.
//
// Auth: requireSession (the caller is the owner, with a trusted device from
// the verify step). We never trust the URL — ownership is re-checked against
// the account's property_access before resolving anything.

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { log } from '@/lib/log';
import { isOnboardingInProgress, type OnboardingState } from '@/lib/onboarding/state';
import { generateJoinCode, OWNER_CODE_TTL_HOURS, OWNER_CODE_MAX_USES } from '@/lib/join-codes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const origin = new URL(req.url).origin;
  const to = (path: string) => NextResponse.redirect(new URL(path, origin));

  const session = await requireSession(req);
  if (!session.ok) {
    // Fail SOFT to the funnel — NEVER a hard /signin from here. The login gate
    // only sends an ALREADY-authenticated owner to this route (via a full-page
    // window.location.href), so a requireSession miss here is almost always a
    // transient full-page-nav cookie / device-trust read race — and ejecting
    // the owner to /signin the instant after they entered their 2FA code is
    // exactly the bounce this whole fix exists to kill. /property-selector
    // handles the genuinely-unauthenticated visitor itself (its own guard →
    // /signin), and for our authenticated-but-racing caller the one-shot
    // RESUME_GUARD_KEY makes the selector fall through to the dashboard instead
    // of looping back here. The dashboard's own gate then re-resumes once the
    // session read settles. Either way: no /signin bounce out of onboarding.
    return to('/property-selector');
  }

  // Who is this, and which hotels do they own?
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('id, property_access, role')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  const access = (account?.property_access ?? []) as string[];
  const isAdmin = account?.role === 'admin';
  const accountId = account?.id as string | undefined;

  // Admins have NO personal onboarding to resume — they manage hotels, they
  // don't own the signup. Routing an admin into a wizard would trap them in
  // (and, via the wizard's owner-session path, mutate) someone else's
  // onboarding. So an admin who ever reaches here just goes to the selector,
  // regardless of any ?propertyId.
  if (isAdmin) return to('/property-selector');
  if (access.length === 0) return to('/property-selector');

  // Candidate properties: the explicit ?propertyId= (must be owned), else the
  // caller's owned set.
  const requestedPid = new URL(req.url).searchParams.get('propertyId');

  let query = supabaseAdmin
    .from('properties')
    .select('id, onboarding_completed_at, onboarding_state');
  if (requestedPid) {
    query = query.eq('id', requestedPid);
  } else {
    query = query.in('id', access);
  }

  const { data: props, error: propErr } = await query;
  if (propErr) {
    log.error('onboard_resume_props_read_failed', { userId: session.userId, err: propErr.message });
    return to('/property-selector');
  }

  const target = (props ?? []).find(p =>
    access.includes(p.id as string) &&
    isOnboardingInProgress(
      p.onboarding_completed_at as string | null,
      p.onboarding_state as OnboardingState | null,
    ),
  );

  // Nothing mid-onboarding (already finished, or a stale redirect) — don't
  // trap them; hand back to the normal funnel.
  if (!target) return to('/property-selector');
  const propertyId = target.id as string;

  const code = await resolveOrMintResumeCode(propertyId, accountId, session.userId);
  if (!code) {
    log.error('onboard_resume_no_code', { userId: session.userId, propertyId });
    return to('/property-selector');
  }

  log.info('onboard_resume', { userId: session.userId, propertyId });
  return to(`/onboard?code=${encodeURIComponent(code)}`);
}

/**
 * Find a usable join code to resume the wizard with, minting one if the
 * original is gone.
 *
 * "Usable" = non-revoked AND non-expired. We deliberately do NOT require
 * `used_count < max_uses`: the original owner code is used up (used_count =
 * max_uses) after Step 2, yet the wizard's own resolver (resolvePropertyByCode)
 * accepts a used-up code — it only checks revoked/expired. Reusing the
 * used-up original is the safe path: it can resume the wizard but CANNOT be
 * replayed through /api/auth/use-join-code to mint a second owner account.
 *
 * Only when no non-expired code exists (owner abandoned onboarding for >7
 * days, then logged back in) do we mint a fresh one — and we mint it
 * PRE-CONSUMED (used_count = max_uses) for the same reason: resumable by the
 * wizard, but inert as a signup code.
 */
async function resolveOrMintResumeCode(
  hotelId: string,
  accountId: string | undefined,
  userId: string,
): Promise<string | null> {
  const nowIso = new Date().toISOString();

  const { data: existing } = await supabaseAdmin
    .from('hotel_join_codes')
    .select('code')
    .eq('hotel_id', hotelId)
    .is('revoked_at', null)
    .gt('expires_at', nowIso)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing?.code) return existing.code as string;

  // No usable code (original expired). Mint a fresh, pre-consumed one.
  // hotel_join_codes.created_by is NOT NULL → we need the owner's accounts.id;
  // if we somehow don't have it, bail rather than throw (caller falls back to
  // the selector instead of trapping the user).
  if (!accountId) {
    log.error('onboard_resume_mint_no_account', { userId, hotelId });
    return null;
  }
  const expiresAt = new Date(Date.now() + OWNER_CODE_TTL_HOURS * 3600 * 1000).toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateJoinCode();
    const { data, error } = await supabaseAdmin
      .from('hotel_join_codes')
      .insert({
        code,
        hotel_id: hotelId,
        role: 'owner',
        expires_at: expiresAt,
        max_uses: OWNER_CODE_MAX_USES,
        used_count: OWNER_CODE_MAX_USES, // pre-consumed: resumable, not a signup code
        created_by: accountId,
      })
      .select('code')
      .single();
    if (!error && data) return data.code as string;
    // 23505 = unique_violation on the code → retry with a fresh string.
    if (error && error.code !== '23505') {
      log.error('onboard_resume_mint_failed', { userId, hotelId, err: error.message });
      break;
    }
  }
  return null;
}
