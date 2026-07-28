export function shouldAutoRedirectExistingSession(input: {
  handoffResolved: boolean;
  explicitAttemptStarted: boolean;
  freshRetry: boolean;
  loading: boolean;
  hasUser: boolean;
  signing: boolean;
}): boolean {
  return input.handoffResolved
    && !input.explicitAttemptStarted
    // A fresh-retry document exists specifically because the previous
    // session-creating operation had an ambiguous result. A late Session A
    // must be cleared, never treated as an ordinary trusted existing login.
    && !input.freshRetry
    && !input.loading
    && input.hasUser
    && !input.signing;
}

export function signInRedirectTarget(input: {
  user: { role: string; propertyAccess: readonly string[] } | null;
  requestedTarget: string;
  propertyIndependent: boolean;
}): string {
  const needsPropertySelection = Boolean(
    input.user
    && !input.propertyIndependent
    && (
      input.user.role === 'admin'
      || input.user.propertyAccess.includes('*')
      || input.user.propertyAccess.length !== 1
    )
  );
  if (!needsPropertySelection) return input.requestedTarget;
  return `/property-selector${
    input.requestedTarget === '/home' || input.requestedTarget.startsWith('/property-selector')
      ? ''
      : `?redirect=${encodeURIComponent(input.requestedTarget)}`
  }`;
}
