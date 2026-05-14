/**
 * Phase M1.5 (2026-05-14) — shared type for properties.onboarding_state.
 *
 * Mirrors the jsonb schema documented in migration 0119. Kept in a
 * separate file (not the wizard route, not the wizard page) so both
 * client + server import the same source of truth.
 */

export type OnboardingStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

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
  if (!state.accountCreatedAt) return 1;
  if (!state.emailVerifiedAt) return 3;
  if (!state.hotelDetailsAt) return 4;
  if (!state.servicesAt) return 5;
  if (!state.pmsCredentialsAt) return 6;
  if (!state.mappingCompletedAt) return 7;
  if (!state.staffAt) return 8;
  return 9;
}

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
