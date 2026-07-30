'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

/** Same-tab access workflows can publish this after a grant lifecycle write. */
export const AUTHORIZATION_CHANGED_EVENT = 'staxis:authorization-changed';

const REFRESH_DEDUP_MS = 250;

export interface AuthorizationRefreshKey {
  /**
   * The key consumers STAMP AND MASK their retained data with.
   *
   * Deliberately stable across browser boundaries. It moves only when the
   * authorization identity itself moves (uid / account row / role / grants /
   * acting context) or when an authoritative same-tab access event fires.
   * Masking on this key means a real access change blanks stale coverage
   * instantly, while a tab refocus does not.
   */
  authorizationKey: string | null;
  /**
   * Bumped at every revalidation boundary — tab restore/focus, network
   * recovery, bfcache restore — and on authoritative events too.
   *
   * Belongs in a reload effect's dependency list, NEVER in a masking
   * comparison. It means "go check again", not "what you are showing is
   * wrong".
   */
  revalidationToken: number;
  /**
   * `authorizationKey` + `revalidationToken` in one string, i.e. a key that
   * changes at every boundary. For consumers that genuinely want to discard
   * and refetch on every restore rather than revalidate behind their data.
   */
  refreshKey: string | null;
}

/**
 * Add a live revalidation generation to an otherwise stable authorization
 * identity. A full account row does not carry company-hat revisions, so uid +
 * role + legacy grants alone cannot invalidate coverage after a live hat is
 * granted/revoked. Revalidate at the browser boundaries where stale access is
 * most dangerous: tab restore/focus, network recovery, bfcache restore, and an
 * explicit same-tab access lifecycle event.
 *
 * ⚠️ THE TWO RETURN VALUES ARE NOT INTERCHANGEABLE, and swapping them
 * reintroduces a bug that made the app unusable for hotel staff.
 *
 * This hook used to return ONE key that changed at every boundary. Consumers
 * both stamp/mask with it and reload on it, so every window focus masked the
 * hotel list to [], nulled the active hotel, flipped the shell back to loading
 * and remounted the tree. Staff click back into the tab dozens of times a
 * shift; they watched the page blank and refetch every single time.
 *
 * So the two concerns are now split. `authorizationKey` answers "is what I am
 * showing still attributable to this viewer?" and holds still while a
 * revalidation runs. `revalidationToken` answers "should I go re-check?" and
 * ticks at every boundary. Consumers keep their snapshot on screen, refetch
 * behind it, and commit only a genuine difference — see
 * `src/lib/property-coverage.ts` for the commit rules.
 *
 * A same-tab grant/revoke is different in kind: it is authoritative new
 * information, so it moves `authorizationKey` and masks immediately, exactly
 * as before.
 */
export function useAuthorizationRefreshKey(
  identityKey: string | null,
  enabled = true,
): AuthorizationRefreshKey {
  const [revision, setRevision] = useState(0);
  const [revalidation, setRevalidation] = useState(0);
  const identityRef = useRef(identityKey);
  identityRef.current = identityKey;
  const lastRefreshRequestAtRef = useRef(0);

  useEffect(() => {
    if (!enabled || !identityKey || typeof window === 'undefined') return;

    let wasHidden = document.visibilityState === 'hidden';
    const requestRefresh = (authoritative = false) => {
      if (!identityRef.current) return;
      const now = Date.now();
      if (!authoritative && now - lastRefreshRequestAtRef.current < REFRESH_DEDUP_MS) return;
      lastRefreshRequestAtRef.current = now;
      // Every boundary asks for a re-check.
      setRevalidation((value) => value + 1);
      // Only an authoritative access change invalidates what is on screen.
      if (authoritative) setRevision((value) => value + 1);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        wasHidden = true;
        return;
      }
      if (wasHidden) {
        wasHidden = false;
        requestRefresh();
      }
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) requestRefresh();
    };
    const onFocus = () => requestRefresh();
    const onOnline = () => requestRefresh();
    // A same-tab grant/revoke is authoritative new information, not a noisy
    // browser boundary. Never let the focus/visibility debounce suppress it.
    const onAuthorizationChanged = () => requestRefresh(true);

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener(AUTHORIZATION_CHANGED_EVENT, onAuthorizationChanged);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener(AUTHORIZATION_CHANGED_EVENT, onAuthorizationChanged);
    };
  }, [enabled, identityKey]);

  return useMemo(() => {
    const authorizationKey = identityKey
      ? `${identityKey}:authorization-revision:${revision}`
      : null;
    return {
      authorizationKey,
      revalidationToken: revalidation,
      refreshKey: authorizationKey
        ? `${authorizationKey}:revalidation:${revalidation}`
        : null,
    };
  }, [identityKey, revision, revalidation]);
}

export function notifyAuthorizationChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(AUTHORIZATION_CHANGED_EVENT));
}
