/**
 * Phase M1.5 (2026-05-14) — shared type for properties.onboarding_state.
 *
 * Mirrors the jsonb schema documented in migration 0119. Kept in a
 * separate file (not the wizard route, not the wizard page) so both
 * client + server import the same source of truth.
 */

export type OnboardingStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type OnboardingReviewStep = 1 | 2;

/**
 * Placeholder name a property is created with when the admin generates an
 * onboarding link WITHOUT naming the hotel (the lean admin flow — the
 * owner names the hotel themselves in the wizard's "Hotel Details" step).
 * The wizard UI shows a friendly fallback ("your hotel") while the stored
 * name still equals this sentinel, and Step 4's PATCH overwrites it with
 * the owner's real hotel name.
 */
export const PLACEHOLDER_HOTEL_NAME = 'New hotel';

export interface OnboardingState {
  /**
   * Current step the wizard should resume to. Default 1 (welcome) for
   * a freshly-created property.
   */
  step: OnboardingStep;

  /** Step 2: account creation completed. */
  accountCreatedAt?: string;

  /** Step 3: OTP verified. */
  emailVerifiedAt?: string;

  /** Step 4: hotel details (room count, timezone, brand, etc.) saved. */
  hotelDetailsAt?: string;

  /** Step 5: PMS credentials saved. */
  pmsCredentialsAt?: string;

  /** Step 5→6: onboarding_jobs.id of the active CUA mapping job. */
  pmsJobId?: string;

  /** Step 6: CUA mapping completed (pms_connected flipped to true). */
  mappingCompletedAt?: string;

  /**
   * Step 5: the owner clicked "Skip — this hotel doesn't use a PMS". No
   * credentials saved, no CUA robot queued; the hotel goes live with no PMS
   * ("No system detected") — e.g. an inventory-only property. Satisfies BOTH
   * the PMS-connect (5) and mapping (6) gates in deriveCurrentStep so the wizard
   * jumps straight to Team. The owner can connect a PMS later from Settings.
   */
  pmsSkippedAt?: string;

  /** Step 7: at least one staff row inserted (or step skipped). */
  staffAt?: string;

  /**
   * Step 5: when the operator picks "Other / Not Listed" as their PMS, the
   * free-text name they typed for their booking system. Persisted so it isn't
   * lost (the registry only knows the generic `other` id) and so whoever maps
   * the new PMS later can see what it is. Length-capped server-side in the
   * wizard PATCH handler.
   */
  pmsOtherName?: string;

  /**
   * Legacy field — the old Step 5 "Which services?" toggle screen wrote a
   * `servicesAt` timestamp. That step was removed (apps now auto-light in the
   * nav based on real usage), so we no longer read or require this. Kept here,
   * optional, only so a mid-flight wizard state persisted before the change
   * still type-checks and is harmlessly ignored.
   */
  servicesAt?: string;
}

/**
 * Determine which step a fresh wizard load should start on, given the
 * persisted state. The wizard resumes at the FIRST unfinished step.
 *
 * Order of completion:
 *   1 → 2 (welcome → account)
 *   2 → 3 (account → verify email) requires accountCreatedAt
 *   3 → 4 (verify → hotel details) requires emailVerifiedAt
 *   4 → 5 (hotel → PMS) requires hotelDetailsAt
 *   5 → 6 (PMS → mapping) requires pmsCredentialsAt + pmsJobId
 *   6 → 7 (mapping → team) requires mappingCompletedAt
 *   7 → 8 (team → done) requires staffAt
 */
export function deriveCurrentStep(state: OnboardingState): OnboardingStep {
  // The welcome→account hop is the only transition with no completion
  // timestamp — Step 1 persists `step: 2` when "Begin" is clicked, and we
  // honor exactly that value here. Anything later still requires the real
  // completion timestamps below, so a client can't skip ahead by sending
  // a bigger `step` (it falls back to 1 until accountCreatedAt exists).
  if (!state.accountCreatedAt) return state.step === 2 ? 2 : 1;
  if (!state.emailVerifiedAt) return 3;
  if (!state.hotelDetailsAt) return 4;
  // PMS is optional: the owner can Skip it (inventory-only hotel, no robot).
  // pmsSkippedAt satisfies BOTH the connect (5) and mapping (6) gates so the
  // wizard jumps straight to Team. Legacy flows (no pmsSkippedAt) are unchanged.
  if (!state.pmsCredentialsAt && !state.pmsSkippedAt) return 5;
  if (!state.mappingCompletedAt && !state.pmsSkippedAt) return 6;
  if (!state.staffAt) return 7;
  return 8;
}

/**
 * Keep early-step review navigation separate from durable onboarding progress.
 * Welcome and Account are safe to revisit as read-only screens after the
 * account exists; rewinding the persisted auth markers is not safe because it
 * would strand an already-created Supabase user in the signup flow.
 */
export function resolveOnboardingDisplayStep(
  currentStep: OnboardingStep,
  reviewStep: OnboardingReviewStep | null,
): OnboardingStep {
  return reviewStep !== null && reviewStep < currentStep ? reviewStep : currentStep;
}

/**
 * Is this property an owner who STARTED the signup wizard but hasn't
 * finished it? Used by the login funnel (Home, property-selector, dashboard)
 * to keep a mid-onboarding owner inside the wizard instead of dropping
 * them on an empty app with no PMS connected.
 *
 * The signal is deliberately narrow:
 *   - `completedAt` set  → fully onboarded, never gated (normal login).
 *   - `accountCreatedAt` set + not completed → the wizard minted an owner
 *     account (Step 2) but the 8 steps aren't done → resume the wizard.
 *
 * Legacy / admin-imported hotels (e.g. Test Hotel) have BOTH null —
 * `accountCreatedAt` was never written — so they are treated as fully
 * live and log in normally. This is the load-bearing guard that stops
 * the gate from trapping existing hotels in a wizard they can't finish.
 */
export function isOnboardingInProgress(
  completedAt: string | null | undefined,
  state: OnboardingState | null | undefined,
): boolean {
  if (completedAt) return false;
  return !!state?.accountCreatedAt;
}

/**
 * sessionStorage property id, set by the login-funnel gate (Home /
 * property-selector / dashboard) right before it sends a mid-onboarding owner to
 * /api/onboard/resume. It is a ONE-SHOT loop-breaker: if the resume route
 * can't complete (e.g. the device-trust/2FA session lapsed, or no join code
 * could be produced) it falls back to /property-selector — which would
 * otherwise re-fire the gate for a single-property owner and loop forever.
 * With that property's id already set, the gate degrades gracefully to Home
 * instead of re-attempting. A different unfinished hotel can still resume in
 * the same tab. The wizard clears it on successful load, and sign-out clears it.
 */
export const RESUME_GUARD_KEY = 'staxis-onboard-resume-tried';

/** Every key the PATCH endpoint will accept into onboarding_state. */
const ONBOARDING_STATE_STRING_KEYS = [
  'accountCreatedAt', 'emailVerifiedAt', 'hotelDetailsAt',
  'servicesAt', 'pmsCredentialsAt', 'pmsJobId',
  'mappingCompletedAt', 'staffAt', 'pmsOtherName', 'pmsSkippedAt',
] as const;
const ONBOARDING_STATE_KEYS = new Set<string>(['step', ...ONBOARDING_STATE_STRING_KEYS]);
/** Generous upper bound on any single persisted string field. Timestamps (~30),
 *  job UUIDs (36) and the free-text pmsOtherName all fit comfortably; this only
 *  exists to bound the jsonb so a caller can't grow the row unboundedly. */
const ONBOARDING_STATE_MAX_STRING = 200;

/**
 * Validate that an arbitrary input matches the OnboardingState shape.
 * Used by the PATCH endpoint to reject malformed client submissions.
 *
 * Security audit 2026-06-26: now REJECTS unknown keys and length-caps every
 * string field. Previously it accepted arbitrary extra keys ("forward-compat"),
 * which let a holder of a valid join code grow properties.onboarding_state
 * (unbounded jsonb) with attacker-chosen keys/values. A genuinely new wizard
 * field just needs adding to ONBOARDING_STATE_STRING_KEYS.
 */
export function isValidPartialState(value: unknown): value is Partial<OnboardingState> {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ONBOARDING_STATE_KEYS.has(key)) return false;
  }
  if (obj.step !== undefined) {
    if (typeof obj.step !== 'number' || obj.step < 1 || obj.step > 8) return false;
  }
  for (const key of ONBOARDING_STATE_STRING_KEYS) {
    const v = obj[key];
    if (v !== undefined) {
      if (typeof v !== 'string') return false;
      if (v.length > ONBOARDING_STATE_MAX_STRING) return false;
    }
  }
  return true;
}
