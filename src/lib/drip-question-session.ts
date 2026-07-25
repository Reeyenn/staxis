// ─── "At most one question per session" — the client half of the rule ────────
//
// The server hands back at most ONE question per call. That alone is not the
// product rule: a manager who answers a question and then clicks around the app
// would remount the Staxis screen and be handed the NEXT one, which is exactly
// the queue-of-questions this feature must never become.
//
// So the first call in a browser session marks the session as spent — whether a
// question came back or not — and nothing asks again until they come back
// tomorrow (or open a new tab set). Deliberately sessionStorage and not
// localStorage: "session" means this sitting, not this laptop forever.
//
// Storage is injected rather than reached for, so the rule is testable without
// a DOM and so a browser with sessionStorage disabled (Safari private mode,
// some kiosk configs) degrades to "ask nothing" instead of throwing.

/** The slice of `Storage` this needs. `window.sessionStorage` satisfies it. */
export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Per hotel: switching properties mid-session is a different hotel's question. */
export function dripSessionKey(propertyId: string): string {
  return `staxis:drip-question-asked:${propertyId}`;
}

/**
 * Has this session already used up its one question for this hotel?
 *
 * Returns TRUE when the store is unavailable or throws. Failing this way means
 * an unreadable store makes Staxis quieter, never chattier — the safe direction
 * for a feature whose only real failure mode is asking too much.
 */
export function alreadyAskedThisSession(
  store: SessionStore | null | undefined,
  propertyId: string,
): boolean {
  if (!store) return true;
  try {
    return store.getItem(dripSessionKey(propertyId)) !== null;
  } catch {
    return true;
  }
}

/** Spend this session's single question. Safe to call more than once. */
export function markAskedThisSession(
  store: SessionStore | null | undefined,
  propertyId: string,
): void {
  if (!store) return;
  try {
    store.setItem(dripSessionKey(propertyId), '1');
  } catch {
    // A full or disabled store just means the guard is unavailable; the server
    // still records the ask, so the day-level guard keeps this from repeating.
  }
}

/** `window.sessionStorage`, or null when there isn't one (SSR, or blocked). */
export function browserSessionStore(): SessionStore | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
