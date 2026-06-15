/**
 * Phase M1.5 (2026-05-14) — shared type for properties.onboarding_state.
 *
 * Mirrors the jsonb schema documented in migration 0119. Kept in a
 * separate file (not the wizard route, not the wizard page) so both
 * client + server import the same source of truth.
 */

export type OnboardingStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

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

  /** Step 5: services_enabled saved. */
  servicesAt?: string;

  /** Step 6: PMS credentials saved. */
  pmsCredentialsAt?: string;

  /** Step 6→7: onboarding_jobs.id of the active CUA mapping job. */
  pmsJobId?: string;

  /** Step 7: CUA mapping completed (pms_connected flipped to true). */
  mappingCompletedAt?: string;

  /** Step 8: at least one staff row inserted (or step skipped). */
  staffAt?: string;
}

/**
 * Determine which step a fresh wizard load should start on, given the
 * persisted state. The wizard resumes at the FIRST unfinished step.
 *
 * Order of completion:
 *   1 → 2 (welcome → account)
 *   2 → 3 (account → verify email) requires accountCreatedAt
 *   3 → 4 (verify → hotel details) requires emailVerifiedAt
 *   4 → 5 (hotel → services) requires hotelDetailsAt
 *   5 → 6 (services → PMS) requires servicesAt
 *   6 → 7 (PMS → mapping) requires pmsCredentialsAt + pmsJobId
 *   7 → 8 (mapping → team) requires mappingCompletedAt
 *   8 → 9 (team → done) requires staffAt
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
  if (!state.servicesAt) return 5;
  if (!state.pmsCredentialsAt) return 6;
  if (!state.mappingCompletedAt) return 7;
  if (!state.staffAt) return 8;
  return 9;
}

/**
 * Is this property an owner who STARTED the signup wizard but hasn't
 * finished it? Used by the login funnel (property-selector + dashboard)
 * to keep a mid-onboarding owner inside the wizard instead of dropping
 * them on an empty dashboard with no PMS connected.
 *
 * The signal is deliberately narrow:
 *   - `completedAt` set  → fully onboarded, never gated (normal login).
 *   - `accountCreatedAt` set + not completed → the wizard minted an owner
 *     account (Step 2) but the 9 steps aren't done → resume the wizard.
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
 * sessionStorage flag, set by the login-funnel gate (property-selector /
 * dashboard) right before it sends a mid-onboarding owner to
 * /api/onboard/resume. It is a ONE-SHOT loop-breaker: if the resume route
 * can't complete (e.g. the device-trust/2FA session lapsed, or no join code
 * could be produced) it falls back to /property-selector — which would
 * otherwise re-fire the gate for a single-property owner and loop forever.
 * With the flag already set, the gate degrades gracefully to the dashboard
 * instead of re-attempting. The wizard clears it on successful load (so a
 * later resume works), and sign-out clears it too.
 */
export const RESUME_GUARD_KEY = 'staxis-onboard-resume-tried';

/**
 * Validate that an arbitrary input matches the OnboardingState shape.
 * Used by the PATCH endpoint to reject malformed client submissions.
 *
 * Permissive: only validates that present fields are the right type.
 * Doesn't require any field. Doesn't reject extra fields (forward-
 * compat with future steps).
 */
export function isValidPartialState(value: unknown): value is Partial<OnboardingState> {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.step !== undefined) {
    if (typeof obj.step !== 'number' || obj.step < 1 || obj.step > 9) return false;
  }
  for (const key of [
    'accountCreatedAt', 'emailVerifiedAt', 'hotelDetailsAt',
    'servicesAt', 'pmsCredentialsAt', 'pmsJobId',
    'mappingCompletedAt', 'staffAt',
  ]) {
    if (obj[key] !== undefined && typeof obj[key] !== 'string') return false;
  }
  return true;
}
