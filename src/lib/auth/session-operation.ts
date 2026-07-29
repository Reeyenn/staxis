'use client';

import type { Session } from '@supabase/supabase-js';
import { withPromiseDeadline } from '@/lib/fetch-deadline';

type SessionResult = {
  data: { session: Session | null };
};

export class AmbiguousSessionOperationError extends Error {
  constructor(label: string, options?: { cause?: unknown }) {
    super(`${label} did not settle before its safety deadline. Start a fresh sign-in.`);
    this.name = 'AmbiguousSessionOperationError';
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

/**
 * Bound an SDK operation that can persist a new browser session.
 *
 * A Promise deadline cannot cancel Supabase's post-response session writes.
 * If the outer deadline wins by a few milliseconds, observe the original
 * Promise through settlement and discard an eventual session by its exact
 * refresh token. Callers must enter terminal fresh-sign-in recovery after an
 * ambiguous exception; they must not let the user immediately reuse the form.
 */
export async function settleSessionOperation<T extends SessionResult>(
  operation: PromiseLike<T>,
  options: {
    timeoutMs: number;
    label: string;
    discardLateSession: (session: Session) => unknown | Promise<unknown>;
  },
): Promise<T> {
  let originalSettled = false;
  const original = Promise.resolve(operation).then(
    (result) => {
      originalSettled = true;
      return result;
    },
    (error) => {
      originalSettled = true;
      throw error;
    },
  );
  try {
    return await withPromiseDeadline(original, {
      timeoutMs: options.timeoutMs,
      label: options.label,
    });
  } catch (error) {
    // If the SDK itself rejected, there is no late session to recover and the
    // caller may handle the concrete error normally. Only the outer deadline
    // winning while the SDK Promise is still live is ambiguous.
    if (originalSettled) throw error;
    void original.then(
      (result) => {
        if (result.data.session) {
          try {
            void Promise.resolve(options.discardLateSession(result.data.session)).catch(() => undefined);
          } catch {
            // Cleanup is best-effort here; the owning UI is already locked in
            // fresh-sign-in recovery and cannot start a competing attempt.
          }
        }
      },
      () => undefined,
    );
    throw new AmbiguousSessionOperationError(options.label, { cause: error });
  }
}
