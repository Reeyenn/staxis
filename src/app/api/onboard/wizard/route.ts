/**
 * Phase M1.5 (2026-05-14) — wizard state persistence.
 *
 * GET /api/onboard/wizard?code=XXXX
 *   Public endpoint (no auth required for steps 1-2 where the user
 *   hasn't created an account yet). Returns the property's current
 *   onboarding state + minimal hotel details so the wizard can render
 *   "Welcome to <Hotel Name>" without the user being signed in.
 *
 *   Auth is graceful: if a session has a fresh authoritative manage-settings
 *   grant for the property, more detail is returned. Otherwise just the bare
 *   welcome info.
 *
 * PATCH /api/onboard/wizard
 *   Body: { code, partialState }
 *   Merges partialState into properties.onboarding_state.
 *   Auth required for every write except two exact, bounded pre-session
 *   transitions: welcome → account, and the account-created fallback after a
 *   single-use owner/GM code has already been consumed. A join code is not a
 *   standing authorization grant for arbitrary onboarding/property writes.
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
import { parseSectionFlags, normalizeSectionFlags } from '@/lib/sections/registry';
import { validatePropertyUpdateField } from '@/lib/onboarding/property-update-validation';
import { accountCapabilityDecisionForProperty } from '@/lib/team-auth';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import {
  isOnboardingJoinCodeCapability,
  resolveJoinCodeCapability,
  type JoinCodeCapabilityResolution,
} from '@/lib/join-code-capability';

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
type PropertyCodeResolution =
  | {
    outcome: 'resolved';
    propertyId: string;
    codeRow: {
      id: string;
      code_kind: 'privileged_onboarding' | 'onboarding_resume';
      status: 'active' | 'used_up';
      role: string | null;
      revoked_at: null;
      expires_at: string;
      used_count: number;
      max_uses: number;
    };
  }
  | { outcome: 'not_found' }
  | { outcome: 'unavailable'; databaseCode: string | null };

function propertyResolutionFromCapability(
  resolution: JoinCodeCapabilityResolution,
): PropertyCodeResolution {
  if (resolution.outcome !== 'resolved') return resolution;
  const { receipt } = resolution;
  if (!isOnboardingJoinCodeCapability(receipt)) {
    return { outcome: 'not_found' };
  }
  return {
    outcome: 'resolved',
    propertyId: receipt.hotelId,
    codeRow: {
      id: receipt.codeId,
      code_kind: receipt.codeKind as 'privileged_onboarding' | 'onboarding_resume',
      status: receipt.status as 'active' | 'used_up',
      role: receipt.role,
      revoked_at: null,
      expires_at: receipt.expiresAt,
      used_count: receipt.usedCount,
      max_uses: receipt.maxUses,
    },
  };
}

async function resolvePropertyByCode(code: string): Promise<PropertyCodeResolution> {
  return propertyResolutionFromCapability(await resolveJoinCodeCapability(code));
}

async function settingsDecision(
  authUserId: string,
  propertyId: string,
) {
  return accountCapabilityDecisionForProperty(
    authUserId,
    'manage_settings',
    propertyId,
    { requireMutation: true, requireManager: true },
  );
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const code = new URL(req.url).searchParams.get('code') ?? '';

  const resolved = await resolvePropertyByCode(code);
  if (resolved.outcome === 'unavailable') {
    log.error('[onboard/wizard:GET] join-code capability unavailable', {
      requestId,
      databaseCode: resolved.databaseCode,
    });
    return capabilityUnavailableResponse(requestId);
  }
  if (resolved.outcome === 'not_found') {
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
    .select('id, name, total_rooms, timezone, brand, property_kind, pms_type, services_enabled, enabled_sections, onboarding_state, onboarding_completed_at')
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
  //   - Authenticated caller with current manager/settings authority → full payload
  //     (state + hotelDefaults), same as before.
  let sessionUserId: string | null = null;
  const session = await requireSession(req);
  if (session.ok) {
    const decision = await settingsDecision(session.userId, resolved.propertyId);
    if (decision === 'allowed') {
      sessionUserId = session.userId;
    }
  }

  // Already completed? Tell the caller so the wizard can redirect to /home.
  if (prop.onboarding_completed_at) {
    const canReadFullState = sessionUserId !== null
      && await settingsDecision(sessionUserId, resolved.propertyId) === 'allowed';
    return ok({
      propertyId: prop.id,
      propertyName: prop.name,
      currentStep: 8 as const,
      completed: true,
      state: canReadFullState
        ? ((prop.onboarding_state as OnboardingState) ?? { step: 8 })
        : { step: 8 } as OnboardingState,
      hotelDefaults: null,
      inviteRole: resolved.codeRow.role,
    }, { requestId });
  }

  let state = (prop.onboarding_state as OnboardingState) ?? { step: 1 };

  // Durable email-verified backfill (2026-06-15). An authenticated manager has,
  // by definition, already passed the email-OTP step — their session was
  // minted by verifyOtp, the second factor. But the client-side PATCH that
  // writes `emailVerifiedAt` at Step 3 can be lost if the browser navigates
  // away the instant the verified session lands (the "verify dumps me on the
  // dashboard" bug). Without this, resuming the wizard would bounce the owner
  // back to Step 3 forever — a redirect loop with the login-funnel gate. So
  // when an authorized session loads the wizard with an account created but
  // email-verified missing, write it now and advance. Idempotent; only ever
  // moves the step FORWARD, never sets onboarding_completed_at.
  if (sessionUserId && state.accountCreatedAt && !state.emailVerifiedAt) {
    const backfilled: OnboardingState = { ...state, emailVerifiedAt: new Date().toISOString() };
    backfilled.step = deriveCurrentStep(backfilled);
    // Authorization can be revoked or the hotel transferred after the first
    // decision. Recheck immediately before this service-role write.
    const backfillDecision = await settingsDecision(sessionUserId, resolved.propertyId);
    if (backfillDecision === 'allowed') {
      const { error: bfErr } = await supabaseAdmin
        .from('properties')
        .update({ onboarding_state: backfilled })
        .eq('id', resolved.propertyId);
      if (bfErr) {
        log.error('[onboard/wizard:GET] emailVerified backfill failed', { requestId, msg: errToString(bfErr) });
      } else {
        state = backfilled;
      }
    } else {
      sessionUserId = null;
    }
  }

  const currentStep = deriveCurrentStep(state);

  // A final decision prevents a role revocation or hotel transfer during this
  // request from turning a formerly-valid session into a full-state leak.
  const canReadFullState = sessionUserId !== null
    && await settingsDecision(sessionUserId, resolved.propertyId) === 'allowed';
  if (!canReadFullState) {
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
      // Per-hotel app on/off (WP4). Return the stored map so Step 4 can
      // re-hydrate its 8 toggles on back-nav instead of resetting to all-ON
      // and silently overwriting the owner's prior choices. Normalized so the
      // client always gets an object-or-null (never a jsonb string).
      enabledSections: normalizeSectionFlags(prop.enabled_sections),
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
  'enabled_sections',
]);

// Back-navigation allow-list. Clearing one of these completion markers makes
// deriveCurrentStep return the step that produced it, so the operator walks
// back one form. Deliberately EXCLUDES the auth markers accountCreatedAt +
// emailVerifiedAt: un-creating the account or un-verifying the email
// mid-signup would strand the login (the auth user already exists). Welcome→
// account is also not reversible here (nothing to edit on the welcome screen).
const CLEARABLE_STATE_KEYS = new Set<keyof OnboardingState>([
  'hotelDetailsAt', 'servicesAt', 'pmsCredentialsAt', 'pmsJobId',
  'mappingCompletedAt', 'staffAt', 'hotelContextAt',
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
  if (resolved.outcome === 'unavailable') {
    log.error('[onboard/wizard:PATCH] join-code capability unavailable', {
      requestId,
      databaseCode: resolved.databaseCode,
    });
    return capabilityUnavailableResponse(requestId);
  }
  if (resolved.outcome === 'not_found') {
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
      // Per-hotel app on/off (WP4). Store the SAME validated full 8-key map the
      // admin card writes — parseSectionFlags is the one source of truth, so an
      // invalid payload is rejected here rather than persisting garbage into the
      // enabled_sections column the section gate reads on every request.
      if (key === 'enabled_sections') {
        const parsed = parseSectionFlags(value);
        if (!parsed.ok) {
          return err(`Invalid enabled_sections: ${parsed.error}`, {
            requestId, status: 400, code: ApiErrorCode.ValidationFailed,
          });
        }
        propertyUpdates[key] = parsed.value;
        continue;
      }
      const fieldV = validatePropertyUpdateField(key, value);
      if (!fieldV.ok) {
        return err(`Invalid ${key}: ${fieldV.error}`, {
          requestId, status: 400, code: ApiErrorCode.ValidationFailed,
        });
      }
      propertyUpdates[key] = fieldV.value;
    }
  }

  // A valid code permits only the two transitions that must happen before an
  // authenticated session is reliably available. In particular it does not
  // authorize clearing progress, setting emailVerifiedAt, changing hotel
  // fields, completing setup, or writing arbitrary later-step timestamps.
  const partialKeys = Object.keys(partialState);
  const bodyKeys = Object.keys(body as Record<string, unknown>);
  const exactPartialOnlyBody = bodyKeys.every((key) => key === 'code' || key === 'partialState')
    && partialKeys.length === 1;
  const codeOnlyWelcomeTransition = exactPartialOnlyBody
    && partialState.step === 2;
  const accountCreatedAt = partialState.accountCreatedAt;
  const codeOnlyAccountCreatedFallback = exactPartialOnlyBody
    && typeof accountCreatedAt === 'string'
    && Number.isFinite(Date.parse(accountCreatedAt))
    && (resolved.codeRow.role === 'owner' || resolved.codeRow.role === 'general_manager')
    && resolved.codeRow.used_count >= resolved.codeRow.max_uses;
  const codeOnlyMinimalWrite = codeOnlyWelcomeTransition || codeOnlyAccountCreatedFallback;

  if (codeOnlyMinimalWrite) {
    const transition = codeOnlyAccountCreatedFallback ? 'account_created' : 'welcome';
    const { data: transitionData, error: transitionError } = await supabaseAdmin.rpc(
      'staxis_apply_onboarding_join_code_transition',
      {
        p_code_id: resolved.codeRow.id,
        p_hotel_id: resolved.propertyId,
        p_transition: transition,
        p_request_id: requestId,
      },
    );
    if (transitionError) {
      log.error('[onboard/wizard:PATCH] guarded code transition unavailable', {
        requestId,
        databaseCode: transitionError.code ?? null,
      });
      return capabilityUnavailableResponse(requestId);
    }
    const receipt = transitionData !== null
      && typeof transitionData === 'object'
      && !Array.isArray(transitionData)
      ? transitionData as Record<string, unknown>
      : null;
    if (receipt?.ok === false) {
      const exactFailure = Object.keys(receipt).sort().join(',') === 'ok,reason'
        && typeof receipt.reason === 'string';
      if (!exactFailure || receipt.reason === 'invalid' || receipt.reason === 'invalid_state') {
        log.error('[onboard/wizard:PATCH] guarded code transition malformed', { requestId });
        return capabilityUnavailableResponse(requestId);
      }
      return err('Invalid or expired code', {
        requestId,
        status: 404,
        code: ApiErrorCode.NotFound,
      });
    }
    const expectedKeys = [
      'ok', 'schemaVersion', 'status', 'hotelId', 'transition', 'currentStep',
    ].sort();
    const actualKeys = receipt ? Object.keys(receipt).sort() : [];
    const validReceipt = receipt?.ok === true
      && receipt.schemaVersion === 'onboarding-code-transition-v1'
      && (receipt.status === 'applied' || receipt.status === 'noop')
      && receipt.hotelId === resolved.propertyId
      && receipt.transition === transition
      && Number.isInteger(receipt.currentStep)
      && (receipt.currentStep as number) >= 1
      && (receipt.currentStep as number) <= 9
      && actualKeys.length === expectedKeys.length
      && actualKeys.every((key, index) => key === expectedKeys[index]);
    if (!validReceipt) {
      log.error('[onboard/wizard:PATCH] guarded code transition malformed', { requestId });
      return capabilityUnavailableResponse(requestId);
    }
    const currentStep = receipt.currentStep as OnboardingState['step'];
    return ok({
      propertyId: resolved.propertyId,
      state: { step: currentStep } as OnboardingState,
      currentStep,
      completed: false,
    }, { requestId });
  }

  const session = await requireSession(req);
  if (!session.ok) return session.response;
  const decision = await settingsDecision(session.userId, resolved.propertyId);
  if (decision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (decision === 'denied') {
    return err('Forbidden — your session cannot manage this property', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }
  const authorizedUserId = session.userId;

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

  // Service-role writes must be fenced at commit proximity. The account may
  // have been revoked or the hotel may have moved organizations since the
  // first decision above. The two deliberately unauthenticated minimal
  // transitions remain code-bound and never alter hotel data or completion.
  const commitDecision = await settingsDecision(authorizedUserId, resolved.propertyId);
  if (commitDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (commitDecision === 'denied') {
    return err('Forbidden — property access changed before the update', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
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
