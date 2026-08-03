export type FirstPersonOnboardingStatus = 'none' | 'pending' | 'created';

export interface FirstPersonOnboardingSnapshot {
  status: FirstPersonOnboardingStatus;
  invitedEmail: string | null;
  accountId: string | null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Project the existing properties.onboarding_state marker into the small
 * People-panel lifecycle contract. A minted first-person invitation has an
 * invitedEmail but no accountCreatedAt or firstPersonAccountId. Signup writes
 * one of the latter markers, so the panel can leave pending state without any
 * access-model mutation or a schema change.
 */
export function projectFirstPersonOnboardingState(
  value: unknown,
  completedAt: unknown,
): FirstPersonOnboardingSnapshot {
  const state = recordOf(value);
  const invitedEmail = typeof state?.invitedEmail === 'string'
    && state.invitedEmail.trim().length > 0
    ? state.invitedEmail.trim().toLowerCase()
    : null;
  const accountId = isUuid(state?.firstPersonAccountId)
    ? state.firstPersonAccountId
    : null;
  const accountCreated = typeof state?.accountCreatedAt === 'string'
    && state.accountCreatedAt.trim().length > 0;

  if (completedAt !== null && completedAt !== undefined) {
    return { status: 'created', invitedEmail, accountId };
  }
  if (accountId || accountCreated) {
    return { status: 'created', invitedEmail, accountId };
  }
  if (invitedEmail) {
    return { status: 'pending', invitedEmail, accountId: null };
  }
  return { status: 'none', invitedEmail: null, accountId: null };
}
