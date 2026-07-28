'use client';

import { useEffect, useRef, useState } from 'react';

/** Same-tab access workflows can publish this after a grant lifecycle write. */
export const AUTHORIZATION_CHANGED_EVENT = 'staxis:authorization-changed';

const REFRESH_DEDUP_MS = 250;

/**
 * Add a live revalidation generation to an otherwise stable authorization
 * identity. A full account row does not carry company-hat revisions, so uid +
 * role + legacy grants alone cannot invalidate coverage after a live hat is
 * granted/revoked. Revalidate at the browser boundaries where stale access is
 * most dangerous: tab restore/focus, network recovery, bfcache restore, and an
 * explicit same-tab access lifecycle event.
 *
 * Consumers must use the returned key to stamp/mask their retained data. The
 * generation changes before their reload effect runs, so one company/hotel's
 * prior snapshot is never rendered while new coverage is being resolved.
 */
export function useAuthorizationRefreshKey(
  identityKey: string | null,
  enabled = true,
): string | null {
  const [revision, setRevision] = useState(0);
  const identityRef = useRef(identityKey);
  identityRef.current = identityKey;
  const lastRefreshRequestAtRef = useRef(0);

  useEffect(() => {
    if (!enabled || !identityKey || typeof window === 'undefined') return;

    let wasHidden = document.visibilityState === 'hidden';
    const requestRefresh = (force = false) => {
      if (!identityRef.current) return;
      const now = Date.now();
      if (!force && now - lastRefreshRequestAtRef.current < REFRESH_DEDUP_MS) return;
      lastRefreshRequestAtRef.current = now;
      setRevision((value) => value + 1);
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

  return identityKey ? `${identityKey}:authorization-revision:${revision}` : null;
}

export function notifyAuthorizationChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(AUTHORIZATION_CHANGED_EVENT));
}
