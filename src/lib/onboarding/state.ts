/**
 * Phase M1.5 (2026-05-14) — shared type for properties.onboarding_state.
 *
 * Mirrors the jsonb schema documented in migration 0119. Kept in a
 * separate file (not the wizard route, not the wizard page) so both
 * client + server import the same source of truth.
 */

export type OnboardingStep = 1 | 2 | 3 | 4 | 5 | 6;
export type OnboardingReviewStep = 1 | 2;

/**
 * Legacy placeholder retained for already-created records from the old
 * link-first admin flow. New platform-admin hotel creation names the shell
 * before a first person is invited, but Step 4 can still repair a retained
 * placeholder record when that person resumes setup.
 */
export const PLACEHOLDER_HOTEL_NAME = 'New hotel';

export interface OnboardingState {
  /**
   * Current step the wizard should resume to. Default 1 (welcome) for
   * a freshly-created property.
   */
  step: OnboardingStep;

  /** Email selected by the platform admin when the first person is invited. */
  invitedEmail?: string;

  /**
   * Account created from that invitation. This database-owned binding makes
   * the setup wizard resumable only by the exact first person, not by every
   * later Owner or General Manager at the hotel.
   */
  firstPersonAccountId?: string;

  /** Step 2: account creation completed. */
  accountCreatedAt?: string;

  /** Step 3: OTP verified. */
  emailVerifiedAt?: string;

  /** Step 4: hotel details (room count, timezone, brand, etc.) saved. */
  hotelDetailsAt?: string;

  /** Legacy, inert: onboarding-era PMS credentials marker. */
  pmsCredentialsAt?: string;

  /** Legacy, inert: onboarding-era mapping job id. */
  pmsJobId?: string;

  /** Legacy, inert: onboarding-era mapping completion marker. */
  mappingCompletedAt?: string;

  /**
   * Legacy, inert: the old onboarding PMS-skip marker. PMS is configured later
   * from the general integration settings.
   */
  pmsSkippedAt?: string;

  /** Legacy, inert: the old onboarding team marker. */
  staffAt?: string;

  /**
   * Step 5: the first person either told Staxis something about the hotel in the
   * open box, or skipped it. ENTIRELY OPTIONAL — the step is one paragraph and
   * a Skip button, and the timestamp is written either way so the wizard moves
   * on. Whatever they typed becomes UNCONFIRMED facts on the Knows screen
   * (/feed → Knows) for them to approve later; nothing here is treated as
   * established truth just because it was typed during setup.
   */
  hotelContextAt?: string;

  /**
   * Legacy, inert: the old onboarding free-text PMS name. Retained for stored
   * production-state compatibility.
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
 *   4 → 5 (about your hotel → your hotel) requires hotelDetailsAt
 *   5 → 6 (your hotel → done) requires hotelContextAt, which the step
 *         writes whether the owner typed something or pressed Skip
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
  // Optional, skippable, and never a wall: the step itself stamps
  // hotelContextAt on both "Add this" and "Skip", so the first person is one
  // click from Done either way. Legacy PMS/mapping/team markers remain stored
  // for compatibility but are intentionally inert in the shortened flow.
  if (!state.hotelContextAt) return 5;
  return 6;
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
 * Is this property one whose first person STARTED the signup wizard but hasn't
 * finished it? Used by the login funnel (Home, property-selector, dashboard)
 * to keep that exact person inside the wizard instead of dropping
 * them in the app before setup is complete.
 *
 * The signal is deliberately narrow:
 *   - `completedAt` set  → fully onboarded, never gated (normal login).
 *   - `accountCreatedAt` set + not completed → the invite minted the first
 *     account (Step 2) but the six stages aren't done → resume the wizard.
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

/** True only for the exact account created by the first-person invitation. */
export function isOnboardingForAccount(
  accountId: string | null | undefined,
  completedAt: string | null | undefined,
  state: OnboardingState | null | undefined,
): boolean {
  if (!accountId) return false;
  // New People invitations always bind the exact account. Historical
  // in-progress records predate this field; keep their prior manager resume
  // behavior instead of stranding a retained production onboarding record.
  if (state?.firstPersonAccountId && state.firstPersonAccountId !== accountId) return false;
  return isOnboardingInProgress(completedAt, state);
}

/**
 * Should the login funnel auto-open the setup wizard for this person on this
 * hotel? True only when ALL hold:
 *   - the caller is the invited Owner or General Manager (line staff and admins never
 *     see the wizard — a housekeeper who joins a half-set-up hotel just lands
 *     in the app),
 *   - the hotel's onboarding is genuinely mid-flight (isOnboardingInProgress),
 *   - the wizard has never been auto-opened for this hotel before
 *     (`promptShownAt` null). The resume route stamps it on first entry, so
 *     the 2nd/3rd/… login lands in the app instead of re-opening the wizard.
 * Single source of truth for the three funnel gates (property-selector, home,
 * dashboard) and the server-side resume route.
 */
export function shouldResumeOnboarding(
  accountId: string | null | undefined,
  role: string | null | undefined,
  completedAt: string | null | undefined,
  state: OnboardingState | null | undefined,
  promptShownAt: string | null | undefined,
): boolean {
  if (role !== 'owner' && role !== 'general_manager') return false;
  if (promptShownAt) return false;
  return isOnboardingForAccount(accountId, completedAt, state);
}

/**
 * sessionStorage property id, set by the login-funnel gate (Home /
 * property-selector / dashboard) right before it sends a mid-onboarding first person to
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
  'hotelContextAt',
] as const;
const ONBOARDING_STATE_KEYS = new Set<string>(['step', ...ONBOARDING_STATE_STRING_KEYS]);
/** Generous upper bound on any single client-owned persisted marker. Timestamps
 *  fit comfortably; this only
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ONBOARDING_STATE_KEYS.has(key)) return false;
  }
  if (obj.step !== undefined) {
    if (typeof obj.step !== 'number' || obj.step < 1 || obj.step > 6) return false;
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
