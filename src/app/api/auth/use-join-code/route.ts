// POST /api/auth/use-join-code
//
// Public endpoint. Body: { code, email, displayName, password, role, phone? }
//
// Looks up the code, verifies it's active (not revoked, not expired,
// used_count < max_uses), then creates the auth.users + accounts rows on
// the code's hotel with the role the staff member chose at signup.
//
// Role assignment:
//   - New-flow codes (role = null): the user picks their role at signup.
//     Restricted to staff roles — front_desk / housekeeping / maintenance —
//     so a shared code cannot be used to self-promote to owner or admin.
//   - Baked-role codes: legacy staff codes remain compatible; owner/GM is
//     accepted only for the DB-typed, one-shot unclaimed-hotel bootstrap.
//     The baked role wins and the payload role is ignored.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { createOrReclaimAuthUser } from '@/lib/auth-create-user';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { logSecurityEvent } from '@/lib/audit';
import { checkAndIncrementRateLimit, rateLimitedResponse, trustedClientIp, ipToRateLimitKey } from '@/lib/api-ratelimit';
import type { AppRole } from '@/lib/roles';
import { captureException } from '@/lib/sentry';
import { isTwoFactorEnabled } from '@/lib/two-factor';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import {
  finalizeJoinCodeSignup,
  resolveJoinCodeCapability,
  type JoinCodeSignupFinalizationReceipt,
} from '@/lib/join-code-capability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Roles a staff member can self-assign with a shared join code. Owner / GM
// are intentionally NOT in this list — those should come through an
// admin-issued invite where the inviter explicitly picks the elevated role.
const STAFF_SIGNUP_ROLES: ReadonlySet<AppRole> = new Set(['front_desk', 'housekeeping', 'maintenance']);

function isEmail(s: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }

function deriveUsername(email: string): string {
  const local = email.split('@')[0]?.toLowerCase().replace(/[^a-z0-9._+-]/g, '') ?? '';
  return local.slice(0, 40) || `user${Date.now().toString(36)}`;
}

// Minimal phone normalization — strip everything except digits, +, leading
// space. Accept anything that looks vaguely phone-like; we surface this to
// owners for outreach, not for SMS routing yet.
function normalizePhone(p: string | undefined | null): string | null {
  if (!p) return null;
  const trimmed = p.trim();
  if (!trimmed) return null;
  // Reject obvious junk but don't be strict — international formats vary.
  // Count digits across the whole string: "(555) 010-2026" is a fine phone
  // number even though its longest consecutive digit run is only 4.
  if ((trimmed.match(/\d/g) ?? []).length < 7) return null;
  if (trimmed.length > 64) return null;
  return trimmed;
}

/**
 * Auth user creation cannot share the Postgres finalizer transaction. Before
 * deleting a newly provisioned identity after refusal, prove that no account
 * or property-owner edge was committed. This also protects against the
 * ambiguous "database committed, HTTP response was lost" failure mode.
 */
async function cleanupUnfinalizedAuthUser(args: {
  authUserId: string;
  email: string;
  requestId: string;
}): Promise<boolean> {
  const { authUserId, email, requestId } = args;
  try {
    const accountResult = await supabaseAdmin
      .from('accounts')
      .select('id')
      .eq('data_user_id', authUserId)
      .maybeSingle();
    const ownerResult = await supabaseAdmin
      .from('properties')
      .select('id')
      .eq('owner_id', authUserId)
      .limit(1)
      .maybeSingle();
    if (accountResult.error || ownerResult.error) {
      throw accountResult.error ?? ownerResult.error;
    }
    if (accountResult.data || ownerResult.data) {
      log.warn('[use-join-code] auth cleanup skipped: committed linkage exists', {
        auth_user_id: authUserId,
        hasAccount: !!accountResult.data,
        ownsProperty: !!ownerResult.data,
        requestId,
      });
      return false;
    }

    const deletion = await supabaseAdmin.auth.admin.deleteUser(authUserId);
    if (deletion.error) throw deletion.error;
    return true;
  } catch (rollErr) {
    log.error('[use-join-code] AUTH ROLLBACK FAILED', {
      auth_user_id: authUserId,
      email,
      err: rollErr,
      requestId,
    });
    captureException(rollErr, {
      subsystem: 'auth',
      failure_mode: 'rollback_failed',
      auth_user_id: authUserId,
      flow: 'use-join-code',
    });
    return false;
  }
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  // ── Rate limit (Codex audit 2026-05-12) ────────────────────────────────
  // This route is public and creates auth.users — without a cap, a bot can
  // brute-force low-entropy join codes or just hammer the create-user
  // path. 10/hour per source IP covers any legitimate human while
  // shutting down bot abuse.
  // Non-spoofable client IP (security audit 2026-06-26: leftmost XFF is
  // attacker-controlled on Vercel — see trustedClientIp). Reused below as the
  // diagnostic `ip` on the password-signin-proof row.
  const clientIp = trustedClientIp(req);
  const ipKey = ipToRateLimitKey(clientIp);
  const rl = await checkAndIncrementRateLimit('auth-use-join-code', ipKey);
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  const body = await req.json() as {
    code?: string;
    email?: string;
    displayName?: string;
    password?: string;
    role?: string;
    phone?: string;
    language?: string;
  };
  const { code, email, displayName, password, role: requestedRole, phone } = body;
  const language = body.language === 'es' ? 'es' : 'en';
  if (!code || !email || !displayName || !password) {
    return err('code, email, displayName, password required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (password.length < 6) {
    return err('Password must be at least 6 characters', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (!isEmail(normalizedEmail)) {
    return err('Invalid email', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const codeResolution = await resolveJoinCodeCapability(code);
  if (codeResolution.outcome === 'unavailable') {
    log.error('[use-join-code] capability resolution unavailable', {
      requestId,
      databaseCode: codeResolution.databaseCode,
    });
    return capabilityUnavailableResponse(requestId);
  }
  if (codeResolution.outcome === 'not_found') {
    return err('Code not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  const receipt = codeResolution.receipt;
  if (receipt.codeKind === 'onboarding_resume') {
    return err('Code is only valid for resuming hotel setup', {
      requestId,
      status: 410,
      code: ApiErrorCode.IdempotencyConflict,
    });
  }
  if (receipt.status === 'revoked') return err('Code has been revoked', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  if (receipt.status === 'expired') return err('Code has expired', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  if (receipt.status === 'used_up') return err('Code has been used up', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  const row = {
    id: receipt.codeId,
    hotel_id: receipt.hotelId,
    role: receipt.role,
    expires_at: receipt.expiresAt,
    max_uses: receipt.maxUses,
    used_count: receipt.usedCount,
    revoked_at: null,
  };

  // F-06: owner/GM-baked codes are an ownership-assignment primitive. The
  // redeem path below rewrites properties.owner_id when finalRole==='owner'
  // (transfer block further down), so an owner code is the lever that
  // claims (or, in the wrong hands, *displaces* the owner of) a hotel.
  //
  // The lean self-onboarding flow legitimately needs exactly one such
  // code: /api/admin/properties/create mints a SINGLE-USE owner/GM code on
  // a freshly-created hotel whose owner_id is still the admin placeholder
  // and whose onboarding hasn't finished — and the redeemer becomes the
  // real owner. We allow precisely that, and keep the lock for the actual
  // attack surface:
  //   • multi-use owner codes (the DB CHECK already forbids these, belt +
  //     suspenders here), and
  //   • owner codes aimed at a hotel that has ALREADY completed onboarding
  //     (a live, claimed hotel) — the displacement vector.
  // Migration 0398 also enforces the stronger invariant at the write boundary:
  // platform-admin placeholder ownership, no accountCreatedAt/completion, no
  // existing owner/GM operator, one active privileged code, and one use.
  //
  // Evaluate before Auth creation/finalization so a rejected probe cannot
  // create an identity or consume a slot. The database repeats the decisive
  // lifecycle check under the transfer lock before committing any access.
  if (row.role === 'owner' || row.role === 'general_manager') {
    const { data: claimTarget } = await supabaseAdmin
      .from('properties')
      .select('onboarding_completed_at')
      .eq('id', row.hotel_id)
      .maybeSingle();
    const isSingleUseOnboardingInvite =
      row.max_uses === 1 && !claimTarget?.onboarding_completed_at;

    if (!isSingleUseOnboardingInvite) {
      await logSecurityEvent({
        action: 'auth.legacy_privileged_code_rejected',
        propertyId: row.hotel_id,
        requestId,
        metadata: {
          codeId: row.id,
          bakedRole: row.role,
          email: normalizedEmail,
          maxUses: row.max_uses,
          onboardingComplete: !!claimTarget?.onboarding_completed_at,
        },
      });
      return err(
        'Owner and General Manager roles cannot be assigned via shared join codes — ask your admin for an emailed invite instead.',
        { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict },
      );
    }
    // Legitimate single-use onboarding invite for an unclaimed hotel —
    // fall through to redeem + owner_id transfer.
  }

  // Resolve and validate the requested role BEFORE reserving a use. A shared
  // code has row.role=null, and malformed/missing role input must not consume
  // one of its finite slots.
  let finalRole: AppRole;
  if (row.role) {
    finalRole = row.role as AppRole;
  } else {
    if (!requestedRole || !STAFF_SIGNUP_ROLES.has(requestedRole as AppRole)) {
      return err(
        'role required (front_desk, housekeeping, or maintenance)',
        { requestId, status: 400, code: ApiErrorCode.ValidationFailed },
      );
    }
    finalRole = requestedRole as AppRole;
  }

  const normalizedPhone = normalizePhone(phone);

  // Auth is an external system, so it is created immediately before the one
  // relational commit. No join-code slot or hotel/account row has changed at
  // this point. The finalizer below repeats every authority/lifecycle check
  // while holding the same property lock used by hotel transfer.
  let username = deriveUsername(normalizedEmail);

  // email_confirm:true so signInWithOtp (called by /signup right after)
  // triggers Supabase's MAGIC-LINK template — the one we customized to
  // show a 6-digit {{ .Token }} prominently. With email_confirm:false
  // Supabase instead sends its "Confirm Your Signup" template, which is
  // a link-only email with no code — useless for the verify-then-trust
  // flow we route the user to.
  //
  // Account-level "verification" is still gated behind the OTP step:
  // /signup redirects to /signin/verify, the user can't reach the
  // dashboard without entering the code, and the device-trust check on
  // the regular /signin path also requires an OTP for untrusted browsers.
  // So email-ownership is still proven before the user gets in; the only
  // thing email_confirm:true changes is which Supabase template is sent.
  // createOrReclaimAuthUser handles the orphan-login case: a prior hotel
  // delete may have left an auth.users row with no accounts row, which used
  // to make this createUser fail with "email already registered" for up to a
  // week (until the orphan sweeper ran). The helper reclaims that orphan;
  // and if the email belongs to a REAL account it refuses to touch it and
  // returns alreadyHasAccount so we can say "sign in instead."
  const authResult = await createOrReclaimAuthUser({
    email: normalizedEmail,
    password,
    userMetadata: { username, displayName },
  });
  if (authResult.alreadyHasAccount) {
    return err(
      'An account with this email already exists — please sign in instead.',
      { requestId, status: 409, code: ApiErrorCode.IdempotencyConflict },
    );
  }
  if (!authResult.user) {
    log.error('[use-join-code] createOrReclaimAuthUser failed', { err: authResult.error, requestId });
    return err('Failed to create account', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const authUser = authResult.user;

  let finalizationReceipt: JoinCodeSignupFinalizationReceipt | null = null;
  let terminalStatus: string | null = null;
  for (let i = 0; i < 5; i++) {
    const input = {
      codeId: row.id,
      code,
      hotelId: row.hotel_id,
      expectedUsedCount: row.used_count,
      authUserId: authUser.id,
      username,
      displayName,
      requestedRole: finalRole as Exclude<AppRole, 'admin' | 'staff'>,
      expectedPendingApproval: receipt.codeKind === 'staff_signup' && receipt.role === null,
      phone: normalizedPhone,
      language,
      requestId,
    } as const;
    let finalized = await finalizeJoinCodeSignup(input);
    // The RPC is idempotent by (code, Auth user), so one immediate retry safely
    // recovers a committed transaction whose HTTP response was lost.
    if (finalized.outcome === 'unavailable') {
      finalized = await finalizeJoinCodeSignup(input);
    }
    if (finalized.outcome === 'finalized') {
      finalizationReceipt = finalized.receipt;
      break;
    }
    terminalStatus = finalized.outcome === 'denied'
      ? finalized.status
      : 'unavailable';
    if (terminalStatus !== 'username_conflict') break;
    username = (username + Math.floor(Math.random() * 10000)).slice(0, 40);
  }

  if (!finalizationReceipt) {
    await cleanupUnfinalizedAuthUser({
      authUserId: authUser.id,
      email: normalizedEmail,
      requestId,
    });
    if (terminalStatus === 'conflict' || terminalStatus === 'account_exists') {
      return err(
        terminalStatus === 'account_exists'
          ? 'An account with this email already exists — please sign in instead.'
          : 'Code is being used by another signup — refresh and try again',
        { requestId, status: 409, code: ApiErrorCode.IdempotencyConflict },
      );
    }
    if (terminalStatus === 'revoked'
        || terminalStatus === 'expired'
        || terminalStatus === 'used_up'
        || terminalStatus === 'not_found'
        || terminalStatus === 'denied') {
      if (row.role === 'owner' || row.role === 'general_manager') {
        await logSecurityEvent({
          action: 'auth.legacy_privileged_code_rejected',
          propertyId: row.hotel_id,
          requestId,
          metadata: {
            codeId: row.id,
            bakedRole: row.role,
            email: normalizedEmail,
            reason: 'database_finalization_recheck',
          },
        });
      }
      return err(
        'This invitation is no longer claimable.',
        { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict },
      );
    }
    log.error('[use-join-code] atomic finalization unavailable', {
      requestId,
      finalizationStatus: terminalStatus ?? 'username_conflict_exhausted',
    });
    return capabilityUnavailableResponse(requestId);
  }

  const pendingApproval = finalizationReceipt.pendingApproval;

  // Hole #1 fix (audit 2026-05-22): write a password proof so the
  // client's first sign-in flow (signInWithOtp + verifyOtp + trust-device)
  // succeeds. admin.createUser doesn't issue a client JWT, so the
  // custom_access_token_hook doesn't fire here — we write the proof
  // explicitly. The user JUST set their password via this endpoint, so
  // the server can vouch for it.
  //
  // EMPIRICALLY VERIFIED 2026-05-22 (Codex review #8 follow-up):
  //   - @supabase/auth-js admin.createUser POSTs /admin/users and returns
  //     {user}, NOT {session} — no JWT minted, hook does not fire.
  //   - Both signup flows (/signup and /onboard) call signInWithOtp after
  //     this endpoint returns. signInWithOtp triggers the hook with
  //     authentication_method='otp', which is NOT the password branch —
  //     so the hook does NOT write a proof on the post-signup OTP either.
  //   - Without THIS manual write, a brand-new account has zero proofs →
  //     trust-device 403s with "Password sign-in required" → user is
  //     locked out of their own first device. NOT optional, NOT redundant.
  //
  // Non-fatal if the insert fails: the user can re-sign-in with the
  // password they just set via the regular /signin flow, which will
  // trigger the normal hook-based proof write.
  //
  // Window = 60 min (was 10). The proof is claimed by trust-device at the
  // OTP-verification step of onboarding/signup, which can be MUCH later than
  // account creation: the user has to receive the verification email, find
  // it, and enter the code — easily >10 min on a slow inbox or a real person
  // filling out the multi-step wizard. When the proof expired first,
  // trust-device 403'd, the device was never trusted, and the next
  // authenticated save bounced the user to "Your session ended" (confirmed in
  // prod 2026-06-13: onboarding accounts with proofs that expired unused).
  // The proof is single-use + user-scoped + only mints trust for the
  // brand-new account that JUST set this password, so a 60-min window is a
  // safe widening (it strictly extends an already-working fast path) and
  // roughly matches the email-OTP validity the user is racing anyway.
  const proofExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { error: proofErr } = await supabaseAdmin
    .from('password_signin_proofs')
    .insert({
      user_id: authUser.id,
      expires_at: proofExpiresAt,
      user_agent: req.headers.get('user-agent') ?? null,
      ip: clientIp || null,
    });
  if (proofErr) {
    log.warn('[use-join-code] password_signin_proofs write failed (non-fatal)', {
      requestId, userId: authUser.id, err: proofErr.message,
    });
  }

  // Global human-2FA switch (migration 0310): tell the client which
  // post-signup path to take. createOrReclaimAuthUser already creates every
  // login with email_confirm:true (see auth-create-user.ts), so when the
  // switch is OFF the client can signInWithPassword immediately — no OTP
  // email, no /signin/verify stop. When ON (or on any read error —
  // isTwoFactorEnabled fail-safes to true) the client keeps the existing
  // signInWithOtp → /signin/verify flow, unchanged.
  const twoFactorEnabled = await isTwoFactorEnabled();

  return ok({ email: normalizedEmail, twoFactorEnabled, pendingApproval }, { requestId });
}
