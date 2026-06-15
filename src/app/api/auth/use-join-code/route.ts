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
//   - Legacy codes (role set on the row): the baked-in role wins for
//     back-compat. We still accept role/phone in the payload but ignore
//     the legacy code's role.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { createOrReclaimAuthUser } from '@/lib/auth-create-user';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { writeAudit, logSecurityEvent } from '@/lib/audit';
import { checkAndIncrementRateLimit, rateLimitedResponse, ipToRateLimitKey } from '@/lib/api-ratelimit';
import type { AppRole } from '@/lib/roles';
import { captureException } from '@/lib/sentry';

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
  if (!/[\d]{7,}/.test(trimmed)) return null;
  return trimmed;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  // ── Rate limit (Codex audit 2026-05-12) ────────────────────────────────
  // This route is public and creates auth.users — without a cap, a bot can
  // brute-force low-entropy join codes or just hammer the create-user
  // path. 10/hour per source IP covers any legitimate human while
  // shutting down bot abuse.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')?.trim()
    || '';
  const ipKey = ipToRateLimitKey(ip);
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
  };
  const { code, email, displayName, password, role: requestedRole, phone } = body;
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

  const normalizedCode = code.trim().toUpperCase();
  const { data: row, error: codeErr } = await supabaseAdmin
    .from('hotel_join_codes')
    .select('id, hotel_id, role, expires_at, max_uses, used_count, revoked_at')
    .eq('code', normalizedCode)
    .maybeSingle();
  if (codeErr || !row) {
    return err('Code not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  if (row.revoked_at) return err('Code has been revoked', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  if (new Date(row.expires_at).getTime() <= Date.now()) return err('Code has expired', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  if (row.used_count >= row.max_uses) return err('Code has been used up', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });

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
  // Single-use is self-limiting too: the CAS increment below consumes the
  // code on first redeem, so it can only ever assign ownership once.
  //
  // Evaluate BEFORE the CAS increment so a rejected probe doesn't burn a slot.
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

  // ── Atomic CAS increment (May 2026 audit pass-4) ──────────────────────
  // Old code did SELECT-then-UPDATE with the increment at the END after
  // account creation. Two parallel signups with the same code (max_uses=1)
  // could both pass the SELECT guard at line above, both create accounts,
  // then both try to increment. Net effect: one valid code consumed twice;
  // an unintended second user joins the hotel with a "used-up" invite.
  //
  // Fix: increment used_count atomically RIGHT NOW with optimistic-
  // concurrency on the current used_count value. If another concurrent
  // request beat us to the increment, our .eq('used_count', row.used_count)
  // matches zero rows; we return 409 without creating an account. Auth
  // creation happens AFTER the increment succeeds — and if auth creation
  // fails, we decrement to release the slot.
  const { data: cas, error: casErr } = await supabaseAdmin
    .from('hotel_join_codes')
    .update({ used_count: row.used_count + 1 })
    .eq('id', row.id)
    .eq('used_count', row.used_count)
    .select('id')
    .maybeSingle();
  if (casErr || !cas) {
    return err(
      'Code is being used by another signup — refresh and try again',
      { requestId, status: 409, code: ApiErrorCode.IdempotencyConflict },
    );
  }

  // Pick the role:
  //   - Legacy code with row.role set → use it (back-compat).
  //   - New-flow code (row.role null) → require role from the payload,
  //     restricted to STAFF_SIGNUP_ROLES so users can't grant themselves
  //     owner/admin via a shared code.
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

  // Audit P3.1 (2026-05-17): dropped the SELECT-then-INSERT pre-check
  // loop. We now trust the UNIQUE constraint on accounts.username
  // (migration 0001) and retry the INSERT below with a digit suffix on
  // SQLSTATE 23505 — saves N round-trips on the no-collision path.
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
  // Helper: decrement used_count to release the slot we reserved above.
  // Used when account creation fails — without it, a transient auth
  // failure would permanently burn one slot of the join code.
  //
  // Atomic unconditional decrement via RPC (audit/concurrency #3). The
  // old conditional eq('used_count', row.used_count + 1) silently no-op'd
  // if another signup had incremented the counter in the meantime,
  // leaking a slot forever. The CAS at the top of this route already
  // prevents over-grant, so the release just needs to subtract one
  // atomically (floored at zero).
  const releaseSlot = async () => {
    try {
      await supabaseAdmin.rpc('staxis_release_join_code_slot', { p_id: row.id });
    } catch {
      // best-effort; the slot stays consumed for the rest of the hour
      // bucket if this race-rare path also flakes
    }
  };

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
    await releaseSlot();
    return err(
      'An account with this email already exists — please sign in instead.',
      { requestId, status: 409, code: ApiErrorCode.IdempotencyConflict },
    );
  }
  if (!authResult.user) {
    log.error('[use-join-code] createOrReclaimAuthUser failed', { err: authResult.error, requestId });
    await releaseSlot();
    return err('Failed to create account', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const authUser = authResult.user;

  // Insert with collision-retry against accounts.username UNIQUE. On any
  // non-unique-violation error, bail to the cleanup path below (release
  // slot + delete auth user).
  let insErr: { code?: string; message?: string } | null = null;
  for (let i = 0; i < 5; i++) {
    const { error } = await supabaseAdmin.from('accounts').insert({
      username,
      display_name: displayName,
      role: finalRole,
      property_access: [row.hotel_id],
      data_user_id: authUser.id,
      phone: normalizedPhone,
    });
    if (!error) { insErr = null; break; }
    insErr = error;
    if (error.code !== '23505') break;
    username = (username + Math.floor(Math.random() * 10000)).slice(0, 40);
  }
  if (insErr) {
    log.error('[use-join-code] accounts insert failed', { err: insErr, requestId });
    // Audit finding #4: pre-2026-05-17 this was `.catch(() => {})` which
    // silently swallowed rollback failures, leaving orphan auth.users
    // rows. Log loudly + Sentry so the orphan sweeper cron and on-call
    // both have visibility if rollback fails.
    await supabaseAdmin.auth.admin.deleteUser(authUser.id).catch(rollErr => {
      log.error('[use-join-code] AUTH ROLLBACK FAILED', {
        auth_user_id: authUser.id,
        email: normalizedEmail,
        err: rollErr,
        requestId,
      });
      captureException(rollErr, {
        subsystem: 'auth',
        failure_mode: 'rollback_failed',
        auth_user_id: authUser.id,
        flow: 'use-join-code',
      });
    });
    await releaseSlot();
    return err('Failed to create account', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  // Slot already incremented via the CAS at the top.

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
      ip: ip || null,
    });
  if (proofErr) {
    log.warn('[use-join-code] password_signin_proofs write failed (non-fatal)', {
      requestId, userId: authUser.id, err: proofErr.message,
    });
  }

  // Phase M1.5 (2026-05-14): when an OWNER signs up via an admin-issued
  // owner code, transfer properties.owner_id from the placeholder admin
  // (set at hotel creation time in /api/admin/properties/create) to the
  // actual owner. Without this, owner_id semantics are wrong — every
  // hotel "owned by" Reeyen forever.
  //
  // GM signups do NOT transfer owner_id. The GM has property_access
  // (full read/write) but isn't the owner of record.
  if (finalRole === 'owner') {
    const { error: ownerXferErr } = await supabaseAdmin
      .from('properties')
      .update({ owner_id: authUser.id })
      .eq('id', row.hotel_id);
    if (ownerXferErr) {
      // Non-fatal: account is created; owner_id semantic is wrong but
      // the user can still operate the hotel via property_access.
      // Log so ops can repair manually.
      log.warn('[use-join-code] owner_id transfer failed (non-fatal)', {
        requestId,
        hotelId: row.hotel_id,
        newOwner: authUser.id,
        err: ownerXferErr,
      });
    }
  }

  await writeAudit({
    action: 'join_code.use',
    actorUserId: authUser.id,
    actorEmail: normalizedEmail,
    targetType: 'join_code',
    targetId: row.id,
    hotelId: row.hotel_id,
    metadata: {
      code: normalizedCode, role: finalRole, username,
      hasPhone: !!normalizedPhone,
      ownerIdTransferred: finalRole === 'owner',
    },
  });

  return ok({ email: normalizedEmail }, { requestId });
}
