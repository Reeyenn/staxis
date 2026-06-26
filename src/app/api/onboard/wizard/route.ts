/**
 * Phase M1.5 (2026-05-14) — wizard state persistence.
 *
 * GET /api/onboard/wizard?code=XXXX
 *   Public endpoint (no auth required for steps 1-2 where the user
 *   hasn't created an account yet). Returns the property's current
 *   onboarding state + minimal hotel details so the wizard can render
 *   "Welcome to <Hotel Name>" without the user being signed in.
 *
 *   Auth is graceful: if a session exists AND owns the property, more
 *   detail is returned. Otherwise just the bare welcome info.
 *
 * PATCH /api/onboard/wizard
 *   Body: { code, partialState }
 *   Merges partialState into properties.onboarding_state.
 *   Auth required for steps 3+ (after account creation). The endpoint
 *   accepts either a session token OR the code+still-valid join_code
 *   for steps 1-2 transitions (welcome → account).
 *
 *   Idempotent: re-PATCHing the same partialState produces the same
 *   end state.
 *
 * Per Phase L discipline:
 *   - Verify-before-fix: the schema (onboarding_state jsonb,
 *     onboarding_completed_at timestamptz) added by migration 0119
 *     was confirmed before this code was written.
 *   - All swallow patterns log structured events.
 */

import { NextRequest, after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { requireSession } from '@/lib/api-auth';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  ipToRateLimitKey,
  trustedClientIp,
} from '@/lib/api-ratelimit';
import { triggerMlTraining } from '@/lib/ml-invoke';
import {
  deriveCurrentStep,
  isValidPartialState,
  type OnboardingState,
} from '@/lib/onboarding/state';

/**
 * Extract a stable IP for rate-limit keying. Vercel sets `x-forwarded-for`;
 * we take the first entry (the original client) and fall back through
 * `x-real-ip` / the request's remote address. Used to scope the
 * `onboard-wizard` bucket per-attacker, not per-property (the attacker
 * doesn't know the property until they brute-force a code).
 *
 * Security review 2026-05-16 (Pattern G): without this rate limit, the
 * ~50-bit join code is brute-forceable from a single IP. Combined with
 * the helper this caps spray attacks at 10/hr per source IP, which
 * stretches an exhaustive search to ~10⁴ years before a successful hit.
 */
function clientIp(req: NextRequest): string | null {
  // Security audit 2026-06-26: the leftmost X-Forwarded-For token is
  // attacker-controlled on Vercel (the platform appends the real IP to the
  // right), which let an attacker rotate it for a fresh rate-limit bucket
  // per request — defeating the join-code brute-force cap entirely. Use the
  // platform-trusted source instead.
  return trustedClientIp(req) || null;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Look up the property associated with a join code, validating the
 * code is non-revoked and non-expired. Returns the property + the
 * code row, or null if not found / not usable.
 *
 * Used by both GET and PATCH to authenticate "user holds a valid
 * code, therefore is allowed to read/write the wizard state for the
 * property the code is bound to."
 */
async function resolvePropertyByCode(code: string): Promise<{
  propertyId: string;
  codeRow: { role: string | null; revoked_at: string | null; expires_at: string };
} | null> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;

  const { data: codeRow, error: codeErr } = await supabaseAdmin
    .from('hotel_join_codes')
    .select('hotel_id, role, revoked_at, expires_at')
    .eq('code', normalized)
    .maybeSingle();
  if (codeErr || !codeRow) return null;
  if (codeRow.revoked_at) return null;
  if (new Date(codeRow.expires_at).getTime() <= Date.now()) return null;
  return {
    propertyId: codeRow.hotel_id as string,
    codeRow: {
      role: codeRow.role as string | null,
      revoked_at: codeRow.revoked_at as string | null,
      expires_at: codeRow.expires_at as string,
    },
  };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const code = new URL(req.url).searchParams.get('code') ?? '';

  const resolved = await resolvePropertyByCode(code);
  if (!resolved) {
    // Rate-limit ONLY invalid-code probes (per IP). The bucket exists to cap
    // blind code-spray enumeration — checking it only on the MISS path keeps
    // that protection while never throttling a legitimate in-progress
    // onboarding, which makes many valid GET/PATCH calls (now including
    // back-navigation). Mirrors /api/onboard/mapping-status. Security review
    // 2026-05-16 (Pattern G); refined 2026-06-13 to not 429-lock real
    // operators who go back to fix a form.
    const limit = await checkAndIncrementRateLimit('onboard-wizard', ipToRateLimitKey(clientIp(req)));
    if (!limit.allowed) return rateLimitedResponse(limit.current, limit.cap, limit.retryAfterSec);
    return err('Invalid or expired code', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Read property + onboarding state. Use service-role to bypass RLS
  // since unauthenticated users (steps 1-2) need to see the welcome.
  // We're already gated by the join code's validity — that's the trust
  // anchor for unauth reads here.
  const { data: prop, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('id, name, total_rooms, timezone, brand, property_kind, pms_type, services_enabled, onboarding_state, onboarding_completed_at')
    .eq('id', resolved.propertyId)
    .maybeSingle();
  if (propErr || !prop) {
    log.error('[onboard/wizard:GET] property fetch failed', { requestId, propertyId: resolved.propertyId, msg: errToString(propErr) });
    return err('Property not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Plan v2 M-2 — narrow the unauth-callable response. The route is
  // gated by a join code, but a brute-forced or phished code used to
  // leak total_rooms, brand, pms_type, and the full onboarding_state
  // JSON to anyone holding the code. Doctor's RLS tripwire can't see
  // this because the read goes through a service-role API surface.
  //
  // New shape:
  //   - Unauthenticated caller → { propertyName, currentStep, completed,
  //     inviteRole }. Enough to render the welcome card.
  //   - Authenticated caller who owns the property → full payload
  //     (state + hotelDefaults), same as before.
  let sessionUserId: string | null = null;
  // Distinct from isOwnerSession (which is also true for ANY admin viewing the
  // hotel): callerOwnsProperty is true only for the actual property owner. The
  // durable emailVerified backfill below keys on THIS so an admin merely
  // looking at a mid-onboarding hotel never mutates the owner's onboarding.
  let callerOwnsProperty = false;
  const session = await requireSession(req);
  if (session.ok) {
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('property_access, role')
      .eq('data_user_id', session.userId)
      .maybeSingle();
    const access = (account?.property_access ?? []) as string[];
    const isAdmin = account?.role === 'admin';
    callerOwnsProperty = access.includes(resolved.propertyId);
    if (isAdmin || callerOwnsProperty) {
      sessionUserId = session.userId;
    }
  }
  const isOwnerSession = sessionUserId !== null;

  // Already completed? Tell the caller so the wizard can redirect to /dashboard.
  if (prop.onboarding_completed_at) {
    return ok({
      propertyId: prop.id,
      propertyName: prop.name,
      currentStep: 8 as const,
      completed: true,
      state: isOwnerSession
        ? ((prop.onboarding_state as OnboardingState) ?? { step: 8 })
        : { step: 8 } as OnboardingState,
      hotelDefaults: null,
      inviteRole: resolved.codeRow.role,
    }, { requestId });
  }

  let state = (prop.onboarding_state as OnboardingState) ?? { step: 1 };

  // Durable email-verified backfill (2026-06-15). An authenticated owner has,
  // by definition, already passed the email-OTP step — their session was
  // minted by verifyOtp, the second factor. But the client-side PATCH that
  // writes `emailVerifiedAt` at Step 3 can be lost if the browser navigates
  // away the instant the verified session lands (the "verify dumps me on the
  // dashboard" bug). Without this, resuming the wizard would bounce the owner
  // back to Step 3 forever — a redirect loop with the login-funnel gate. So
  // when an owner session loads the wizard with an account created but
  // email-verified missing, write it now and advance. Idempotent; only ever
  // moves the step FORWARD, never sets onboarding_completed_at.
  if (callerOwnsProperty && state.accountCreatedAt && !state.emailVerifiedAt) {
    const backfilled: OnboardingState = { ...state, emailVerifiedAt: new Date().toISOString() };
    backfilled.step = deriveCurrentStep(backfilled);
    const { error: bfErr } = await supabaseAdmin
      .from('properties')
      .update({ onboarding_state: backfilled })
      .eq('id', resolved.propertyId);
    if (bfErr) {
      log.error('[onboard/wizard:GET] emailVerified backfill failed', { requestId, msg: errToString(bfErr) });
    } else {
      state = backfilled;
    }
  }

  const currentStep = deriveCurrentStep(state);

  if (!isOwnerSession) {
    return ok({
      propertyId: prop.id,
      propertyName: prop.name,
      currentStep,
      completed: false,
      // Minimal state — just the step number — so the wizard can
      // render the welcome without exposing operator progress.
      state: { step: currentStep } as OnboardingState,
      hotelDefaults: null,
      inviteRole: resolved.codeRow.role,
    }, { requestId });
  }

  return ok({
    propertyId: prop.id,
    propertyName: prop.name,
    currentStep,
    completed: false,
    state,
    hotelDefaults: {
      name: prop.name,
      totalRooms: prop.total_rooms,
      timezone: prop.timezone,
      brand: prop.brand,
      propertyKind: prop.property_kind,
      pmsType: prop.pms_type,
      // Back-nav (2026-06-13): expose saved service toggles so Step 5 can
      // re-hydrate them when the operator navigates back, instead of resetting
      // every toggle to ON and silently overwriting their prior choices.
      servicesEnabled: (prop.services_enabled as Record<string, boolean> | null) ?? null,
    },
    inviteRole: resolved.codeRow.role,
  }, { requestId });
}

interface PatchBody {
  code?: unknown;
  partialState?: unknown;
  // Steps 4-8 may also bundle property updates (name change, services,
  // etc.) into the same PATCH so the client doesn't need 2 round-trips.
  propertyUpdates?: unknown;
  // When the wizard hits Step 9 + the user clicks "Go to Dashboard",
  // the client sends finalize=true so we set onboarding_completed_at.
  finalize?: unknown;
  // Back-navigation: the "← Back" / "Re-enter login" buttons send a list of
  // onboarding_state keys to clear, which makes deriveCurrentStep land on an
  // earlier step so the operator can edit a form they got wrong. Only keys in
  // CLEARABLE_STATE_KEYS are honored.
  clearStateKeys?: unknown;
}

const ALLOWED_PROPERTY_UPDATE_FIELDS = new Set([
  'name', 'total_rooms', 'timezone', 'brand', 'property_kind',
  'region', 'climate_zone', 'size_tier', 'services_enabled',
]);

// Back-navigation allow-list. Clearing one of these completion markers makes
// deriveCurrentStep return the step that produced it, so the operator walks
// back one form. Deliberately EXCLUDES the auth markers accountCreatedAt +
// emailVerifiedAt: un-creating the account or un-verifying the email
// mid-signup would strand the login (the auth user already exists). Welcome→
// account is also not reversible here (nothing to edit on the welcome screen).
const CLEARABLE_STATE_KEYS = new Set<keyof OnboardingState>([
  'hotelDetailsAt', 'servicesAt', 'pmsCredentialsAt', 'pmsJobId',
  'mappingCompletedAt', 'staffAt',
]);

export async function PATCH(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return err('Invalid JSON', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const code = typeof body.code === 'string' ? body.code : '';
  const resolved = await resolvePropertyByCode(code);
  if (!resolved) {
    // Rate-limit ONLY invalid-code probes (per IP) — caps brute-force code
    // enumeration without throttling a legitimate operator who makes many
    // valid PATCHes (now including back-navigation). Same model as GET above
    // + /api/onboard/mapping-status. Security review 2026-05-16 (Pattern G);
    // refined 2026-06-13.
    const limit = await checkAndIncrementRateLimit('onboard-wizard', ipToRateLimitKey(clientIp(req)));
    if (!limit.allowed) return rateLimitedResponse(limit.current, limit.cap, limit.retryAfterSec);
    return err('Invalid or expired code', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Validate partialState shape if present.
  let partialState: Partial<OnboardingState> = {};
  if (body.partialState !== undefined) {
    if (!isValidPartialState(body.partialState)) {
      return err('Invalid partialState shape', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    partialState = body.partialState;
  }

  // Validate clearStateKeys shape if present (back-navigation). Must be a
  // short array; a non-array or oversized payload is a client bug → 400
  // (consistent with propertyUpdates' strict checks). Unknown / non-clearable
  // keys are filtered later via the CLEARABLE_STATE_KEYS allow-list.
  if (body.clearStateKeys !== undefined &&
      (!Array.isArray(body.clearStateKeys) || body.clearStateKeys.length > 16)) {
    return err('Invalid clearStateKeys shape', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // Validate propertyUpdates: each key must be in the allow-list.
  // Don't trust the client to send arbitrary column names.
  const propertyUpdates: Record<string, unknown> = {};
  if (body.propertyUpdates !== undefined && body.propertyUpdates !== null) {
    if (typeof body.propertyUpdates !== 'object') {
      return err('Invalid propertyUpdates shape', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    for (const [key, value] of Object.entries(body.propertyUpdates as Record<string, unknown>)) {
      if (!ALLOWED_PROPERTY_UPDATE_FIELDS.has(key)) {
        return err(`propertyUpdates.${key} is not in the allow-list`, {
          requestId, status: 400, code: ApiErrorCode.ValidationFailed,
        });
      }
      propertyUpdates[key] = value;
    }
  }

  // For steps that mutate property data (4+), the user MUST be signed
  // in and own the property. Steps 1-3 only touch onboarding_state and
  // are gated by code validity alone.
  const isMutatingProperty = Object.keys(propertyUpdates).length > 0 || body.finalize === true;
  if (isMutatingProperty) {
    const session = await requireSession(req);
    if (!session.ok) return session.response;
    // Verify session owns the property via accounts.property_access.
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('property_access, role')
      .eq('data_user_id', session.userId)
      .maybeSingle();
    const access = (account?.property_access ?? []) as string[];
    const isAdmin = account?.role === 'admin';
    if (!isAdmin && !access.includes(resolved.propertyId)) {
      return err('Forbidden — your session does not own this property', {
        requestId, status: 403, code: ApiErrorCode.Unauthorized,
      });
    }
  }

  // Read current state so we can MERGE (not overwrite) onboarding_state.
  const { data: current, error: readErr } = await supabaseAdmin
    .from('properties')
    .select('onboarding_state')
    .eq('id', resolved.propertyId)
    .maybeSingle();
  if (readErr || !current) {
    log.error('[onboard/wizard:PATCH] state read failed', { requestId, msg: errToString(readErr) });
    return err('Property not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  const currentState = (current.onboarding_state as OnboardingState) ?? { step: 1 };
  const mergedState: OnboardingState = {
    ...currentState,
    ...partialState,
  };
  // Defensive server-side cap on the free-text "Other" PMS name (Fix 1):
  // isValidPartialState accepts any string here, so without this a hostile
  // client could PATCH a multi-MB value straight into the onboarding_state
  // jsonb (read on every wizard GET). Trim + clamp to a sane label length.
  if (typeof mergedState.pmsOtherName === 'string') {
    mergedState.pmsOtherName = mergedState.pmsOtherName.trim().slice(0, 120);
  }
  // Back-navigation (2026-06-13): the "← Back" buttons (and "Re-enter login"
  // on a failed mapping) send clearStateKeys to walk the operator back to an
  // earlier form. We can't express "clear a key" through partialState
  // (JSON.stringify drops undefined, and isValidPartialState rejects null), so
  // handle it here: delete each allow-listed completion marker, which makes
  // deriveCurrentStep return the corresponding earlier step. Auth markers are
  // not in the allow-list, so a back can never strand the login.
  //
  // PMS retry note: going back from a FAILED mapping leaves the failed mapper
  // job in place on purpose — it holds the per-property idempotency key, so
  // the session driver can't auto-re-run with the OLD bad credentials in the
  // gap before the operator re-submits. That job is cleared (and the session
  // re-armed) in /api/pms/save-credentials once NEW creds are saved.
  if (Array.isArray(body.clearStateKeys)) {
    for (const k of body.clearStateKeys) {
      if (typeof k === 'string' && CLEARABLE_STATE_KEYS.has(k as keyof OnboardingState)) {
        delete mergedState[k as keyof OnboardingState];
      }
    }
  }
  // Recompute step from the merged state (don't trust client-sent step).
  mergedState.step = deriveCurrentStep(mergedState);

  // Build the UPDATE payload.
  const update: Record<string, unknown> = {
    onboarding_state: mergedState,
    ...propertyUpdates,
  };
  if (body.finalize === true) {
    update.onboarding_completed_at = new Date().toISOString();
  }

  const { error: updErr } = await supabaseAdmin
    .from('properties')
    .update(update)
    .eq('id', resolved.propertyId);
  if (updErr) {
    log.error('[onboard/wizard:PATCH] update failed', { requestId, msg: errToString(updErr) });
    return err(`Update failed: ${updErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // Phase M3.1 (2026-05-14): on wizard finalize, trigger demand+supply
  // cold-start ML training for the property AFTER response is sent.
  // Without this, a hotel onboarded Monday waits up to 6 days for the
  // weekly training cron (Sunday 03:00 CT) — Day-1 promise broken.
  // Inventory is NOT triggered here; inventory cold-start runs on first
  // count and the existing path is correct.
  //
  // Fire-and-forget via next/server's after() — Next.js holds the
  // function alive past the response so this completes (vs raw fire-
  // and-forget where Vercel may freeze before the fetch resolves).
  // Failures are non-fatal: the daily aggregator + weekly cron remain
  // the safety nets. triggerMlTraining never throws.
  if (body.finalize === true) {
    const propertyId = resolved.propertyId;
    after(async () => {
      const results = await Promise.allSettled([
        triggerMlTraining(propertyId, 'demand', { requestId }),
        triggerMlTraining(propertyId, 'supply', { requestId }),
      ]);
      log.info('onboard_finalize_ml_kick', {
        requestId,
        pid: propertyId,
        demandStatus: results[0].status === 'fulfilled' ? results[0].value.status : 'rejected',
        supplyStatus: results[1].status === 'fulfilled' ? results[1].value.status : 'rejected',
      });
    });
  }

  return ok({
    propertyId: resolved.propertyId,
    state: mergedState,
    currentStep: mergedState.step,
    completed: body.finalize === true,
  }, { requestId });
}
