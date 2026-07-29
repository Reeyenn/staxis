'use client';

import React from 'react';
import { flushSync } from 'react-dom';
import { usePathname, useSearchParams } from 'next/navigation';

import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import {
  hotelActingContextMatchesRequest,
  resolveHotelActingRequest,
  type HotelActingRequest,
} from '@/lib/portfolio-ui/hotel-acting-request';
import {
  parseHotelActingContext,
  type HotelActingContextV1,
} from '@/lib/portfolio-ui/hotel-acting-contract';

export type HotelActingAuthorizationStatus =
  | 'inactive'
  | 'checking'
  | 'allowed'
  | 'denied'
  | 'error';

interface AuthorizationSnapshot {
  requestIdentity: string;
  status: Exclude<HotelActingAuthorizationStatus, 'inactive'>;
  context: HotelActingContextV1 | null;
  httpStatus: number | null;
}

export interface HotelActingContextValue {
  request: HotelActingRequest;
  status: HotelActingAuthorizationStatus;
  context: HotelActingContextV1 | null;
  httpStatus: number | null;
  /** True for company/region/subset pages and portfolio-origin hotel views. */
  portfolioScoped: boolean;
  retry: () => void;
}

const HotelActingContext = React.createContext<HotelActingContextValue | null>(null);
const HOTEL_ACTING_CONTEXT_TIMEOUT_MS = 8_000;

function responseData(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record.ok === true ? record.data : null;
}

export function HotelActingProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const searchKey = searchParams.toString();
  const request = React.useMemo(
    () => resolveHotelActingRequest({ pathname, search: searchKey }),
    [pathname, searchKey],
  );
  const userUid = user?.uid ?? null;
  const viewerAuthorizationKey = user
    ? JSON.stringify([
        user.uid,
        user.accountId,
        user.role,
        user.staffId,
        [...user.propertyAccess].sort(),
      ])
    : 'anonymous';
  const requestIdentity = `${viewerAuthorizationKey}:${request.requestKey}`;
  const requestRef = React.useRef(request);
  // Update only after React commits this location. A discarded concurrent
  // render must never retarget a retry/effect through a render-time ref write.
  React.useLayoutEffect(() => {
    requestRef.current = request;
  }, [request]);
  const [attempt, setAttempt] = React.useState(0);
  const [snapshot, setSnapshot] = React.useState<AuthorizationSnapshot | null>(null);
  const generationRef = React.useRef(0);
  const activeControllerRef = React.useRef<AbortController | null>(null);
  const pageHiddenRef = React.useRef(false);

  const invalidate = React.useCallback(() => {
    if (request.kind !== 'hotel') return;
    generationRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    setSnapshot({
      requestIdentity,
      status: 'checking',
      context: null,
      httpStatus: null,
    });
    setAttempt((value) => value + 1);
  }, [request.kind, requestIdentity]);

  React.useEffect(() => {
    const authorizationRequest = requestRef.current;
    if (authorizationRequest.kind !== 'hotel') return;
    // pagehide can flush a pending passive effect before the browser captures a
    // BFCache snapshot. Refuse to start work synchronously once hide begins so
    // that flush can never create a fresh request capable of republishing data.
    if (pageHiddenRef.current || document.visibilityState === 'hidden') {
      setSnapshot({ requestIdentity, status: 'checking', context: null, httpStatus: null });
      return;
    }
    if (authLoading) {
      setSnapshot({ requestIdentity, status: 'checking', context: null, httpStatus: null });
      return;
    }
    if (!userUid) {
      setSnapshot({ requestIdentity, status: 'denied', context: null, httpStatus: 401 });
      return;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const controller = new AbortController();
    activeControllerRef.current?.abort();
    activeControllerRef.current = controller;
    const mayCommit = () => generationRef.current === generation
      && activeControllerRef.current === controller
      && !controller.signal.aborted;
    setSnapshot({ requestIdentity, status: 'checking', context: null, httpStatus: null });
    const timeout = window.setTimeout(() => {
      if (generationRef.current !== generation || activeControllerRef.current !== controller) return;
      controller.abort(new Error('Hotel acting-context request timed out'));
      activeControllerRef.current = null;
      setSnapshot({ requestIdentity, status: 'error', context: null, httpStatus: null });
    }, HOTEL_ACTING_CONTEXT_TIMEOUT_MS);

    void (async () => {
      try {
        const response = await fetchWithAuth(authorizationRequest.endpoint, {
          cache: 'no-store',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!mayCommit()) return;
        if (!response.ok) {
          const status = response.status;
          setSnapshot({
            requestIdentity,
            status: status === 400 || status === 403 || status === 404
              ? 'denied'
              : 'error',
            context: null,
            httpStatus: status,
          });
          return;
        }
        const decoded = await response.json().catch(() => null);
        if (!mayCommit()) return;
        const context = parseHotelActingContext(responseData(decoded));
        if (!context || !hotelActingContextMatchesRequest(authorizationRequest, context)) {
          setSnapshot({ requestIdentity, status: 'error', context: null, httpStatus: 503 });
          return;
        }
        setSnapshot({ requestIdentity, status: 'allowed', context, httpStatus: response.status });
      } catch (error) {
        if (!mayCommit()) return;
        // fetchWithAuth already cleared the session and initiated navigation.
        // Do not replace that transition with a retry surface.
        if (error instanceof SessionEndedError
          || (error instanceof Error && error.name === 'SessionEndedError')) return;
        setSnapshot({ requestIdentity, status: 'error', context: null, httpStatus: null });
      } finally {
        window.clearTimeout(timeout);
      }
    })();

    return () => {
      window.clearTimeout(timeout);
      if (activeControllerRef.current === controller) activeControllerRef.current = null;
      controller.abort();
    };
  }, [attempt, authLoading, requestIdentity, userUid]);

  // A background tab can outlive its grant. Clear the full hotel subtree before
  // every foreground recheck; pagehide also destroys the current verdict so a
  // back/forward cache restore can never paint it before pageshow reauthorizes.
  React.useEffect(() => {
    if (request.kind !== 'hotel') return;
    let foregroundTimer: number | null = null;
    const revalidate = () => {
      if (document.visibilityState === 'hidden') return;
      pageHiddenRef.current = false;
      if (foregroundTimer !== null) return;
      // A single foreground transition commonly dispatches visibilitychange,
      // pageshow and focus. Mask immediately on the first event, then use a
      // short cooldown only to suppress the duplicate events. Delaying the
      // first invalidation would briefly repaint the old authorized subtree.
      foregroundTimer = window.setTimeout(() => {
        foregroundTimer = null;
      }, 50);
      flushSync(() => invalidate());
    };
    const hide = () => {
      // Set this before aborting or flushing state. flushSync is allowed to run
      // pending passive effects, and those effects must see the page as hidden.
      pageHiddenRef.current = true;
      if (foregroundTimer !== null) {
        window.clearTimeout(foregroundTimer);
        foregroundTimer = null;
      }
      generationRef.current += 1;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
      // BFCache snapshots the already-rendered DOM. Commit the fail-closed
      // state before pagehide returns so a persisted restore cannot paint the
      // prior hotel subtree before pageshow starts a fresh authorization read.
      flushSync(() => {
        setSnapshot({ requestIdentity, status: 'checking', context: null, httpStatus: null });
      });
    };
    window.addEventListener('focus', revalidate);
    window.addEventListener('pageshow', revalidate);
    window.addEventListener('pagehide', hide);
    document.addEventListener('visibilitychange', revalidate);
    return () => {
      if (foregroundTimer !== null) window.clearTimeout(foregroundTimer);
      window.removeEventListener('focus', revalidate);
      window.removeEventListener('pageshow', revalidate);
      window.removeEventListener('pagehide', hide);
      document.removeEventListener('visibilitychange', revalidate);
    };
  }, [invalidate, request.kind, requestIdentity]);

  let status: HotelActingAuthorizationStatus = 'inactive';
  let context: HotelActingContextV1 | null = null;
  let httpStatus: number | null = null;
  if (request.kind === 'invalid') {
    status = 'denied';
    httpStatus = 400;
  } else if (request.kind === 'hotel') {
    const currentSnapshot = snapshot?.requestIdentity === requestIdentity ? snapshot : null;
    status = currentSnapshot?.status ?? 'checking';
    context = currentSnapshot?.status === 'allowed' ? currentSnapshot.context : null;
    httpStatus = currentSnapshot?.httpStatus ?? null;
  }

  const value = React.useMemo<HotelActingContextValue>(() => ({
    request,
    status,
    context,
    httpStatus,
    portfolioScoped: request.kind === 'portfolio_scope' || context?.source === 'portfolio',
    retry: invalidate,
  }), [context, httpStatus, invalidate, request, status]);

  return <HotelActingContext.Provider value={value}>{children}</HotelActingContext.Provider>;
}

export function useHotelActingContext(): HotelActingContextValue {
  const value = React.useContext(HotelActingContext);
  if (!value) throw new Error('useHotelActingContext must be used inside HotelActingProvider');
  return value;
}

export function useOptionalHotelActingContext(): HotelActingContextValue | null {
  return React.useContext(HotelActingContext);
}
