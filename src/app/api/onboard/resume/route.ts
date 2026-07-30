// GET /api/onboard/resume
//
// Authenticated login-funnel helper. When the funnel (property-selector /
// dashboard) detects that the signed-in first person's hotel is mid-onboarding
// (isOnboardingInProgress), it points the browser here. We resolve the
// incomplete hotel + a usable join code and 302-redirect into the wizard, so
// they finish the six stages instead of being dropped into the app early.
//
// This is the server side of the fix for the 2026-06-15 bug: "I create the
// account, enter the 2FA code, and instead of the next onboarding step it
// logs me into my own (empty) hotel." The root is that verifying email makes
// the owner a fully-authenticated single-property user, and the funnel's
// "1 property → dashboard" auto-forward then treats them as a returning user.
// The gate + this route keep an unfinished onboarding INSIDE the wizard.
//
// Auth: requireSession (the caller is the invited Owner/GM, with a trusted device from
// the verify step). We never trust the URL or legacy property_access snapshot:
// current per-property manage-settings authority is resolved and rechecked
// before each service-role write.

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { getOrMintRequestId, log } from '@/lib/log';
import { isOnboardingForAccount, type OnboardingState } from '@/lib/onboarding/state';
import { generateJoinCode } from '@/lib/join-codes';
import { accountCapabilityDecisionForProperty } from '@/lib/team-auth';
import {
  listAuthoritativePropertyAccess,
} from '@/lib/authorization/server';
import { canManageTeam } from '@/lib/roles';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { isUuid } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
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
    // RESUME_GUARD_KEY makes the selector fall through to Home instead
    // of looping back here. Either way: no /signin bounce out of onboarding;
    // the next authenticated session can retry because shared sign-out clears
    // the guard.
    return to('/property-selector');
  }

  // Resolve the live account, then discover candidate hotels through the
  // authoritative mode switch. A normalized account's property_access is a
  // rollback snapshot and is never an input here.
  const { data: account, error: accountError } = await supabaseAdmin
    .from('accounts')
    .select('id, role, active')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  const accountId = account?.id as string | undefined;

  // Only the Owner/GM account created by the first-person invitation can own
  // this setup. Legacy unbound records retain the prior capability fallback.
  if (accountError || !accountId || account?.active !== true
      || (account?.role !== 'owner' && account?.role !== 'general_manager')) {
    return to('/property-selector');
  }
  const authority = await listAuthoritativePropertyAccess(accountId);
  if (!authority || authority.all) return to('/property-selector');

  // Start from exact structural reach. A bound first person does not need the
  // general manage-settings capability to finish their own setup; that
  // capability remains the compatibility authority for an unbound legacy row.
  const requestedPid = new URL(req.url).searchParams.get('propertyId');
  const structurallyReached = authority.propertyStandings
    .map((standing) => standing.propertyId);
  const managerCandidates = authority.propertyStandings
    .filter((standing) => standing.hotelMutationAllowed && canManageTeam(standing.operationalRole))
    .map((standing) => standing.propertyId);
  const requestedCandidates = requestedPid
    ? (structurallyReached.includes(requestedPid) ? [requestedPid] : [])
    : structurallyReached;
  if (requestedCandidates.length === 0) return to('/property-selector');

  const legacyAllowed = new Set<string>();
  for (const propertyId of requestedCandidates.filter(id => managerCandidates.includes(id))) {
    const decision = await accountCapabilityDecisionForProperty(
      session.userId,
      'manage_settings',
      propertyId,
      { requireMutation: true, requireManager: true },
    );
    if (decision === 'allowed') legacyAllowed.add(propertyId);
  }

  const query = supabaseAdmin
    .from('properties')
    .select('id, onboarding_completed_at, onboarding_state, onboarding_prompt_shown_at')
    .in('id', requestedCandidates);

  const { data: props, error: propErr } = await query;
  if (propErr) {
    log.error('onboard_resume_props_read_failed', { userId: session.userId, err: propErr.message });
    return to('/property-selector');
  }

  // The wizard auto-opens at most once per hotel. Skip any property already
  // stamped (onboarding_prompt_shown_at) so a later login lands in the app,
  // even if onboarding never finished.
  const target = (props ?? []).find((p) => {
    const state = p.onboarding_state as OnboardingState | null;
    const identityAllowed = state?.firstPersonAccountId
      ? state.firstPersonAccountId === accountId
      : legacyAllowed.has(p.id as string);
    return identityAllowed
      && !p.onboarding_prompt_shown_at
      && isOnboardingForAccount(
        accountId,
        p.onboarding_completed_at as string | null,
        state,
      );
  });

  // Nothing to resume (finished, already-shown, or a stale redirect) — don't
  // trap them; hand back to the normal funnel.
  if (!target) return to('/property-selector');
  const propertyId = target.id as string;
  const targetState = target.onboarding_state as OnboardingState | null;
  const isBoundFirstPerson = targetState?.firstPersonAccountId === accountId;

  // Minting a replacement resume code is a write. Recheck the exact property
  // after all candidate reads and immediately before that helper can insert.
  if (!isBoundFirstPerson) {
    const codeDecision = await accountCapabilityDecisionForProperty(
      session.userId,
      'manage_settings',
      propertyId,
      { requireMutation: true, requireManager: true },
    );
    if (codeDecision !== 'allowed') return to('/property-selector');
  }

  const codeResolution = await resolveOrMintResumeCode(
    propertyId,
    accountId,
    session.userId,
    requestId,
  );
  if (codeResolution.outcome === 'unavailable') {
    return capabilityUnavailableResponse(requestId);
  }
  if (codeResolution.outcome === 'denied') {
    log.error('onboard_resume_no_code', { userId: session.userId, propertyId });
    return to('/property-selector');
  }
  const code = codeResolution.code;

  // Consume the one-shot: stamp the hotel now that we're actually opening the
  // wizard. Guarded on IS NULL so it records only the first entry; a failed
  // resume above never reaches here, so it never burns the shot. Non-fatal.
  if (!isBoundFirstPerson) {
    const stampDecision = await accountCapabilityDecisionForProperty(
      session.userId,
      'manage_settings',
      propertyId,
      { requireMutation: true, requireManager: true },
    );
    if (stampDecision !== 'allowed') return to('/property-selector');
  }
  let stampQuery = supabaseAdmin
    .from('properties')
    .update({ onboarding_prompt_shown_at: new Date().toISOString() })
    .eq('id', propertyId)
    .is('onboarding_prompt_shown_at', null);
  if (isBoundFirstPerson) {
    stampQuery = stampQuery.eq('onboarding_state->>firstPersonAccountId', accountId);
  }
  const { error: stampErr } = await stampQuery;
  if (stampErr) {
    log.error('onboard_resume_stamp_failed', { userId: session.userId, propertyId, err: stampErr.message });
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
 * days, then logged back in) do we mint a fresh one. It is role-neutral and
 * PRE-CONSUMED (used_count = max_uses): resumable by the authenticated wizard,
 * but inert as either a staff signup or a privileged account credential.
 */
async function resolveOrMintResumeCode(
  hotelId: string,
  accountId: string | undefined,
  userId: string,
  requestId: string,
): Promise<
  | { outcome: 'resolved'; code: string }
  | { outcome: 'denied' }
  | { outcome: 'unavailable' }
> {
  if (!accountId) {
    log.error('onboard_resume_mint_no_account', { userId, hotelId });
    return { outcome: 'denied' };
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateJoinCode();
    const { data, error } = await supabaseAdmin.rpc(
      'staxis_resolve_or_mint_resume_join_code_guarded',
      {
        p_actor_account_id: accountId,
        p_actor_auth_user_id: userId,
        p_hotel_id: hotelId,
        p_code: candidate,
        p_request_id: requestId,
      },
    );
    if (error) {
      log.error('onboard_resume_code_rpc_failed', {
        userId,
        hotelId,
        requestId,
        databaseCode: error.code ?? null,
      });
      return { outcome: 'unavailable' };
    }

    const record = data !== null && typeof data === 'object' && !Array.isArray(data)
      ? data as Record<string, unknown>
      : null;
    if (record?.ok === false) {
      const exactFailureKeys = Object.keys(record).sort().join(',') === 'ok,reason';
      if (!exactFailureKeys || typeof record.reason !== 'string') {
        log.error('onboard_resume_code_rpc_malformed', { userId, hotelId, requestId });
        return { outcome: 'unavailable' };
      }
      if (record.reason === 'code_collision') continue;
      if (record.reason === 'denied' || record.reason === 'not_found') {
        return { outcome: 'denied' };
      }
      return { outcome: 'unavailable' };
    }

    const expectedKeys = [
      'ok', 'schemaVersion', 'status', 'created', 'codeId', 'hotelId', 'code', 'expiresAt',
    ].sort();
    const actualKeys = record ? Object.keys(record).sort() : [];
    const valid = record?.ok === true
      && record.schemaVersion === 'join-code-resume-v1'
      && (record.status === 'created' || record.status === 'existing')
      && record.created === (record.status === 'created')
      && actualKeys.length === expectedKeys.length
      && actualKeys.every((key, index) => key === expectedKeys[index])
      && isUuid(record.codeId)
      && record.hotelId === hotelId
      && typeof record.code === 'string'
      && /^[A-Z0-9][A-Z0-9-]{4,126}[A-Z0-9]$/.test(record.code)
      && typeof record.expiresAt === 'string'
      && Number.isFinite(Date.parse(record.expiresAt))
      && Date.parse(record.expiresAt) > Date.now();
    if (!valid) {
      log.error('onboard_resume_code_rpc_malformed', { userId, hotelId, requestId });
      return { outcome: 'unavailable' };
    }
    return { outcome: 'resolved', code: record.code as string };
  }
  return { outcome: 'unavailable' };
}
