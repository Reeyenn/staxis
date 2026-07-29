'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type FreshSignInRecoveryState =
  | 'not-required'
  | 'waiting-for-auth'
  | 'resetting'
  | 'ready'
  | 'failed';

interface FreshSignInRecoveryOptions {
  required: boolean;
  authLoading: boolean;
  hasUser: boolean;
  /** True only while Attempt B (including its terminal navigation) owns auth. */
  attemptInFlight: boolean;
  resetLocalSession: () => Promise<void>;
}

interface FreshSignInRecoveryResult {
  state: FreshSignInRecoveryState;
  ready: boolean;
  error: string | null;
  retry: () => Promise<boolean>;
  /**
   * Run the same local reset immediately before a new password attempt. This
   * closes the gap in which a late auth event could arrive after the initial
   * recovery pass but before the user presses Sign In.
   */
  resetBeforeSubmit: () => Promise<boolean>;
}

const RESET_FAILED_MESSAGE =
  'We could not safely reset the previous sign-in. Try the reset again before continuing.';

/**
 * Own the `/signin?reason=auth-retry` recovery boundary.
 *
 * The previous document may have timed out while GoTrue was still able to
 * persist Session A. A full navigation stops that document, but the new one
 * must still clear any durable A session before it enables another attempt.
 * If A appears after the first reset (for example via a cross-tab auth event),
 * this hook returns to the reset state and clears it again. Once an explicit
 * Attempt B starts, the caller's exact-session guards own the flow and this
 * hook deliberately stops reacting to B's SIGNED_IN event.
 */
export function useFreshSignInRecovery({
  required,
  authLoading,
  hasUser,
  attemptInFlight,
  resetLocalSession,
}: FreshSignInRecoveryOptions): FreshSignInRecoveryResult {
  const [state, setState] = useState<FreshSignInRecoveryState>(
    required ? 'waiting-for-auth' : 'not-required',
  );
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const inFlightTokenRef = useRef<object | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runReset = useCallback((): Promise<boolean> => {
    if (!required) return Promise.resolve(true);
    const existing = inFlightRef.current;
    if (existing) return existing;

    if (mountedRef.current) {
      setState('resetting');
      setError(null);
    }

    const token = {};
    inFlightTokenRef.current = token;
    const pending = (async () => {
      try {
        await resetLocalSession();
        if (mountedRef.current) {
          setState('ready');
          setError(null);
        }
        return true;
      } catch (resetError) {
        console.error('Sign In: fresh-session reset failed', resetError);
        if (mountedRef.current) {
          setState('failed');
          setError(RESET_FAILED_MESSAGE);
        }
        return false;
      } finally {
        if (inFlightTokenRef.current === token) {
          inFlightTokenRef.current = null;
          inFlightRef.current = null;
        }
      }
    })();
    inFlightRef.current = pending;
    return pending;
  }, [required, resetLocalSession]);

  useEffect(() => {
    if (!required) {
      setState('not-required');
      setError(null);
      return;
    }
    // B's own SIGNED_IN event is expected while its password/trust/OTP flow is
    // active. Once that attempt ends without navigation, a remaining/later
    // session becomes recoverable again; the permanent redirect-suppression
    // ref on the page is intentionally not used for this state machine.
    if (attemptInFlight) return;
    if (authLoading) {
      if (state !== 'resetting') setState('waiting-for-auth');
      return;
    }
    if (state === 'waiting-for-auth' || (state === 'ready' && hasUser)) {
      void runReset();
    }
  }, [
    authLoading,
    attemptInFlight,
    hasUser,
    required,
    runReset,
    state,
  ]);

  return {
    state,
    // Render-time masking closes the one-paint gap before the passive effect
    // can move a late session back into `resetting`.
    ready: !required || (state === 'ready' && !authLoading && !hasUser),
    error,
    retry: runReset,
    resetBeforeSubmit: runReset,
  };
}
