// POST /api/auth/use-join-code
//
// Public endpoint. Body: { code, email, displayName, password, role, phone? }
//
// Looks up the code, verifies it's active (not revoked, not expired,
// used_count < max_uses), then creates the auth.users + accounts rows on
// the code's hotel with the role the staff member chose at signup.
//
// Role assignment:
//   - New-flow staff codes (role = null): the user picks their role at
//     signup. Restricted to staff roles — front_desk / housekeeping /
//     maintenance — so a shared code cannot be used to self-promote to
//     owner or admin.
//   - Admin-issued owner/GM invites (role = 'owner' | 'general_manager'):
//     the baked role wins. Allowed ONLY when the code is single-use
//     (max_uses = 1, enforced by migration 0273's CHECK) AND the hotel is
//     still UNCLAIMED — owned by the admin placeholder, onboarding not yet
//     completed. Multi-use privileged codes, or redemption against an
//     already-claimed hotel, are rejected (the owner-displacement threat
//     migration 0152 closed). See the gate just below the code lookup.
//   - Legacy codes with any other baked role: the baked role wins for
//     back-compat. We still accept role/phone in the payload but ignore it.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
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

  // ── Owner / General-Manager codes: single-use invites on UNCLAIMED hotels ──
  // Owner/GM redemption is an ownership-grant primitive — the path below
  // transfers properties.owner_id to the redeemer when finalRole === 'owner'
  // and grants full property_access either way. Two rules keep that from
  // becoming an account-takeover vector (F-06; migration 0152 banned all
  // owner/GM codes, 0273 relaxes that to single-use only):
  //
  //   1. MULTI-USE owner/GM codes are forbidden outright. A shared/reusable
  //      privileged code, if leaked, is a "seize this hotel" token. Migration
  //      0273's CHECK already blocks minting one; this is defense-in-depth in
  //      case a row rides a raw service-role write past the constraint.
  //
  //   2. A single-use owner/GM code may only be redeemed on an UNCLAIMED
  //      hotel — still owned by the admin placeholder set at creation AND
  //      with onboarding not yet completed. This makes owner-DISPLACEMENT
  //      impossible: once a real owner has claimed the hotel (or onboarding
  //      finished), no owner/GM code can rewrite ownership. Fail CLOSED — if
  //      we can't positively confirm the hotel is unclaimed, reject.
  //
  // New-flow codes (row.role === null) never reach this block; their role
  // comes from the request body and is clamped to STAFF_SIGNUP_ROLES below.
  //
  // Both rejections fire BEFORE the CAS increment so a probe burns no slot.
  let placeholderOwnerId: string | null = null;
  if (row.role === 'owner' || row.role === 'general_manager') {
    if (row.max_uses > 1) {
      await logSecurityEvent({
        action: 'auth.privileged_multiuse_code_rejected',
        propertyId: row.hotel_id,
        requestId,
        metadata: { codeId: row.id, bakedRole: row.role, maxUses: row.max_uses, email: normalizedEmail },
      });
      return err(
        'Owner and General Manager roles cannot be assigned via a shared (multi-use) join code — ask your admin for a single-use invite link.',
        { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict },
      );
    }

    // Single-use privileged code → enforce the unclaimed-hotel invariant.
    const { data: prop, error: propErr } = await supabaseAdmin
      .from('properties')
      .select('owner_id, onboarding_completed_at')
      .eq('id', row.hotel_id)
      .maybeSingle();

    let unclaimed = false;
    let rejectReason = 'owner_unverifiable';
    if (propErr || !prop) {
      rejectReason = 'property_read_failed';
    } else if (prop.onboarding_completed_at) {
      rejectReason = 'onboarding_completed';
    } else if (!prop.owner_id) {
      rejectReason = 'no_placeholder_owner';
    } else {
      // The current owner_id must belong to an ADMIN placeholder account —
      // i.e. the hotel has NOT yet been claimed by a real owner or GM.
      const { data: ownerAcct, error: ownerAcctErr } = await supabaseAdmin
        .from('accounts')
        .select('role')
        .eq('data_user_id', prop.owner_id)
        .maybeSingle();
      if (ownerAcctErr) {
        // Degenerate data (e.g. >1 account sharing a data_user_id makes
        // maybeSingle error) must NOT read as "unclaimed". Fail closed and
        // log loudly so the bad state is visible rather than silent.
        log.warn('[use-join-code] placeholder-owner lookup failed — failing closed', {
          requestId, hotelId: row.hotel_id, ownerId: prop.owner_id, err: ownerAcctErr.message,
        });
        rejectReason = 'owner_unverifiable';
      } else if (ownerAcct?.role === 'admin') {
        unclaimed = true;
        placeholderOwnerId = prop.owner_id as string;
      } else {
        rejectReason = 'already_claimed';
      }
    }

    if (!unclaimed) {
      await logSecurityEvent({
        action: 'auth.privileged_code_displacement_blocked',
        propertyId: row.hotel_id,
        requestId,
        metadata: { codeId: row.id, bakedRole: row.role, reason: rejectReason, email: normalizedEmail },
      });
      return err(
        'This hotel has already been set up — ask your admin for a new invite.',
        { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict },
      );
    }
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

  const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email: normalizedEmail,
    password,
    email_confirm: true,
    user_metadata: { username, displayName },
  });
  if (authErr || !authData.user) {
    log.error('[use-join-code] createUser failed', { err: authErr, requestId });
    await releaseSlot();
    return err('Failed to create account', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

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
      data_user_id: authData.user.id,
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
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id).catch(rollErr => {
      log.error('[use-join-code] AUTH ROLLBACK FAILED', {
        auth_user_id: authData.user.id,
        email: normalizedEmail,
        err: rollErr,
        requestId,
      });
      captureException(rollErr, {
        subsystem: 'auth',
        failure_mode: 'rollback_failed',
        auth_user_id: authData.user.id,
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
  const proofExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { error: proofErr } = await supabaseAdmin
    .from('password_signin_proofs')
    .insert({
      user_id: authData.user.id,
      expires_at: proofExpiresAt,
      user_agent: req.headers.get('user-agent') ?? null,
      ip: ip || null,
    });
  if (proofErr) {
    log.warn('[use-join-code] password_signin_proofs write failed (non-fatal)', {
      requestId, userId: authData.user.id, err: proofErr.message,
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
  //
  // Why only the OWNER path has a concurrent-claim CAS + rollback (below) and
  // the GM path does not: owner_id is EXCLUSIVE — two redeemers can't both be
  // owner of record, so a concurrent-claim loser MUST be rejected. GM access
  // is ADDITIVE (it only appends property_access; it displaces no one). A GM
  // invite redeemed in the same instant a hotel is claimed simply yields "this
  // admin-invited GM now manages this hotel" — the intended end state, not a
  // violation. Rolling that back would throw a spurious error at a legitimate
  // invitee for no security gain. The read-time unclaimed-guard above already
  // blocks the real threat (a privileged code redeemed on an ALREADY-claimed /
  // completed hotel); leaked-link-before-first-use is the email-bind follow-up.
  if (finalRole === 'owner') {
    if (!placeholderOwnerId) {
      // Unreachable in practice: owner codes always pass the unclaimed-guard
      // above, which sets placeholderOwnerId. If we somehow got here without
      // it, REFUSE to transfer rather than risk an unconditional overwrite
      // (the displacement vector). The account still has property_access.
      log.error('[use-join-code] owner transfer skipped — no verified placeholder (unexpected)', {
        requestId, hotelId: row.hotel_id, newOwner: authData.user.id,
      });
    } else {
      // Anti-displacement CAS: only transfer ownership while the hotel is
      // STILL the unclaimed placeholder we verified above. If a concurrent
      // redemption claimed it between the guard and here, this matches zero
      // rows and we do NOT overwrite the new owner.
      const { data: xferred, error: ownerXferErr } = await supabaseAdmin
        .from('properties')
        .update({ owner_id: authData.user.id })
        .eq('id', row.hotel_id)
        .eq('owner_id', placeholderOwnerId)
        .is('onboarding_completed_at', null)
        .select('id')
        .maybeSingle();
      if (ownerXferErr) {
        // Non-fatal: account is created; owner_id semantic is wrong but the
        // user can still operate the hotel via property_access. Log so ops
        // can repair manually.
        log.warn('[use-join-code] owner_id transfer failed (non-fatal)', {
          requestId, hotelId: row.hotel_id, newOwner: authData.user.id, err: ownerXferErr,
        });
      } else if (!xferred) {
        // CAS matched no rows → the hotel was claimed concurrently (e.g. a
        // second owner code for the same hotel won the race). owner_id
        // displacement was prevented — but we must NOT leave this redeemer
        // holding an owner-ROLE account with property_access to a hotel
        // someone else now owns. Roll the whole redemption back: delete the
        // account + auth user, release the code slot, and fail the request.
        await logSecurityEvent({
          action: 'auth.owner_transfer_cas_missed',
          propertyId: row.hotel_id,
          requestId,
          metadata: { codeId: row.id, attemptedOwner: authData.user.id, expectedPlaceholder: placeholderOwnerId },
        });
        log.warn('[use-join-code] owner_id CAS matched no rows — rolling back redemption (concurrent claim)', {
          requestId, hotelId: row.hotel_id, newOwner: authData.user.id,
        });
        await supabaseAdmin.from('accounts').delete().eq('data_user_id', authData.user.id);
        await supabaseAdmin.auth.admin.deleteUser(authData.user.id).catch(rollErr => {
          log.error('[use-join-code] AUTH ROLLBACK FAILED (cas-miss path)', {
            auth_user_id: authData.user.id, email: normalizedEmail, err: rollErr, requestId,
          });
          captureException(rollErr, {
            subsystem: 'auth', failure_mode: 'rollback_failed',
            auth_user_id: authData.user.id, flow: 'use-join-code',
          });
        });
        await releaseSlot();
        return err(
          'This hotel was just claimed by someone else — ask your admin for a new invite.',
          { requestId, status: 409, code: ApiErrorCode.IdempotencyConflict },
        );
      }
    }
  }

  await writeAudit({
    action: 'join_code.use',
    actorUserId: authData.user.id,
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
