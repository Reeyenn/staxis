'use client';

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useLang } from '@/contexts/LanguageContext';
import { NavigationFailurePortal } from '@/components/layout/RouteResourceState';

/** A client transition has this long to commit a new pathname before the UI
 * offers a retry and a document-navigation escape hatch. This is deliberately
 * longer than the warm-navigation performance budget: it is a correctness
 * backstop for a wedged router, stale deployment chunk, or lost RSC request.
 */
export const NAVIGATION_COMMIT_TIMEOUT_MS = 8_000;

const AUTHENTICATED_NAV_PREFIXES = [
  '/home', '/feed', '/dashboard', '/housekeeping', '/communications',
  '/maintenance', '/inventory', '/staff', '/financials', '/company',
  '/settings', '/admin', '/property-selector',
] as const;

export type NavigationMode = 'push' | 'replace';

export interface PendingNavigation {
  href: string;
  mode: NavigationMode;
  attempt: number;
  sourcePathname: string;
  trigger: 'hook' | 'link' | 'history';
}

export interface ReliableNavigation {
  pendingHref: string | null;
  failure: PendingNavigation | null;
  push: (href: string) => void;
  replace: (href: string) => void;
  prefetch: (href: string) => void;
  retry: () => void;
  openDirectly: () => void;
}

export interface ReliableNavigationRouter {
  push: (href: string) => void;
  replace: (href: string) => void;
  prefetch: (href: string) => void | Promise<void>;
  refresh: () => void;
}

export interface ReliableNavigationRuntimeProviderProps {
  children?: ReactNode;
  router: ReliableNavigationRouter;
  pathname: string;
  lang: 'en' | 'es';
  documentNavigate?: (href: string) => void;
}

interface ReliableNavigationContextValue extends ReliableNavigation {
  markReady: (pathname: string) => void;
}

const ReliableNavigationContext = createContext<ReliableNavigationContextValue | null>(null);

function targetPathname(href: string): string {
  try {
    const base = typeof window === 'undefined' ? 'https://getstaxis.com' : window.location.href;
    return new URL(href, base).pathname;
  } catch {
    return href.split(/[?#]/, 1)[0] || '/';
  }
}

/**
 * Next's router methods do not expose transition completion or rejection.
 * Track the current attempt against the committed pathname so an interrupted
 * client transition can never leave only a permanent spinner. A retry remains
 * client-side; "Open directly" deliberately performs a document navigation,
 * which also recovers from stale client chunks and a wedged router runtime.
 */
export function ReliableNavigationProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { lang } = useLang();

  return createElement(
    ReliableNavigationRuntimeProvider,
    { router, pathname, lang },
    children,
  );
}

/**
 * Runtime state machine separated from Next's hooks so the silent-transition
 * watchdog can be exercised as behavior, including a pathname commit whose
 * destination never renders. Production uses ReliableNavigationProvider.
 */
export function ReliableNavigationRuntimeProvider({
  children,
  router,
  pathname,
  lang,
  documentNavigate,
}: ReliableNavigationRuntimeProviderProps) {
  const attemptRef = useRef(0);
  const pendingRef = useRef<PendingNavigation | null>(null);
  const failureRef = useRef<PendingNavigation | null>(null);
  const [pending, setPending] = useState<PendingNavigation | null>(null);
  const [failure, setFailure] = useState<PendingNavigation | null>(null);

  const clearPending = useCallback(() => {
    pendingRef.current = null;
    failureRef.current = null;
    setPending(null);
    setFailure(null);
  }, []);

  const armNavigation = useCallback((href: string, mode: NavigationMode, trigger: PendingNavigation['trigger']) => {
    const next: PendingNavigation = {
      href,
      mode,
      attempt: ++attemptRef.current,
      sourcePathname: pathname,
      trigger,
    };
    pendingRef.current = next;
    failureRef.current = null;
    setFailure(null);
    setPending(next);
    return next;
  }, [pathname]);

  // Next <Link> is used throughout Settings and secondary authenticated
  // surfaces. Observe same-origin anchor activation at the persistent root so
  // those transitions receive the same watchdog as Concourse button clicks.
  // This never prevents the event or starts a second navigation.
  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      if (!AUTHENTICATED_NAV_PREFIXES.some((prefix) => (
        pathname === prefix || pathname.startsWith(`${prefix}/`)
      ))) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const destination = `${url.pathname}${url.search}${url.hash}`;
      if (destination === current) return;
      // Readiness is destination-owned through usePathname(). A successful
      // search/hash-only change does not produce a new pathname effect, so it
      // must not be armed as though a new route were expected to render.
      if (url.pathname === window.location.pathname) return;
      if (pendingRef.current?.href === destination && !failureRef.current) return;
      armNavigation(destination, 'push', 'link');
    };
    document.addEventListener('click', onDocumentClick, true);
    return () => document.removeEventListener('click', onDocumentClick, true);
  }, [armNavigation, pathname]);

  // Back/forward is an explicit user choice that supersedes an in-flight pill
  // click, but it is still a client route transition and can wedge on the same
  // cold RSC/chunk failures as router.push(). Arm the destination already
  // selected by browser history without starting a duplicate navigation.
  useEffect(() => {
    const onPopState = () => {
      const destination = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (targetPathname(destination) === pathname) {
        clearPending();
        return;
      }
      armNavigation(destination, 'replace', 'history');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [armNavigation, clearPending, pathname]);

  // A different navigation can supersede the one we started (redirect,
  // onboarding handoff, browser extension). A pathname commit to the EXPECTED
  // destination deliberately does not clear here: root loading.tsx can already
  // be visible while the destination RSC remains suspended. AppLayout (or the
  // property selector) calls markReady only once destination code is rendered.
  useEffect(() => {
    const current = pendingRef.current;
    if (!current) return;
    const destination = targetPathname(current.href);
    if (pathname !== current.sourcePathname && pathname !== destination) {
      clearPending();
    }
  }, [pathname, clearPending]);

  useEffect(() => {
    if (!pending) return;
    const timeout = window.setTimeout(() => {
      if (failureRef.current) return;
      failureRef.current = pending;
      setFailure(pending);
    }, NAVIGATION_COMMIT_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [pending]);

  const navigate = useCallback((href: string, mode: NavigationMode, force = false) => {
    // Section navigation in Staxis changes pathname. Avoid manufacturing a
    // timeout when the active destination is tapped again.
    if (!force && href === pathname) return;
    if (!force && targetPathname(href) === pathname) {
      // Query/hash state on the current route is allowed to change, but it
      // cannot use the pathname-owned completion signal below.
      router[mode](href);
      return;
    }
    // Pointerdown/click and rapid repeated taps can arrive in one transition.
    // One in-flight attempt is enough; Retry deliberately bypasses this guard.
    if (
      !force
      && pendingRef.current?.href === href
      && pendingRef.current.trigger === 'hook'
      && !failureRef.current
    ) return;

    const attempt = armNavigation(href, mode, 'hook');
    try {
      // When a failed transition has already committed its pathname, another
      // push to the identical URL is normally deduplicated by Next. Refresh the
      // suspended destination while arming a genuinely new bounded attempt.
      if (force && targetPathname(href) === pathname) router.refresh();
      else router[mode](href);
    } catch {
      // A synchronous router failure is immediately actionable; most failed
      // RSC transitions are silent and arrive through the timer above.
      failureRef.current = attempt;
      setFailure(attempt);
    }
  }, [armNavigation, pathname, router]);

  const push = useCallback((href: string) => navigate(href, 'push'), [navigate]);
  const replace = useCallback((href: string) => navigate(href, 'replace'), [navigate]);
  const prefetch = useCallback((href: string) => {
    try {
      void router.prefetch(href);
    } catch {
      // Prefetch is only an optimization. The click starts a measured attempt.
    }
  }, [router]);
  const retry = useCallback(() => {
    if (!failure) return;
    navigate(failure.href, failure.mode, true);
  }, [failure, navigate]);
  const openDirectly = useCallback(() => {
    if (!failure || typeof window === 'undefined') return;
    if (documentNavigate) documentNavigate(failure.href);
    else window.location.assign(failure.href);
  }, [documentNavigate, failure]);
  const markReady = useCallback((readyPathname: string) => {
    const current = pendingRef.current;
    if (!current || targetPathname(current.href) !== readyPathname) return;
    clearPending();
  }, [clearPending]);

  const value: ReliableNavigationContextValue = {
    pendingHref: pending?.href ?? null,
    failure,
    push,
    replace,
    prefetch,
    retry,
    openDirectly,
    markReady,
  };

  return createElement(
    ReliableNavigationContext.Provider,
    { value },
    children,
    createElement(NavigationFailurePortal, {
      visible: failure !== null,
      lang,
      onRetry: retry,
      onOpenDirectly: openDirectly,
    }),
  );
}

function useReliableNavigationContext(): ReliableNavigationContextValue {
  const value = useContext(ReliableNavigationContext);
  if (!value) throw new Error('useReliableNavigation must be used inside ReliableNavigationProvider');
  return value;
}

export function useReliableNavigation(): ReliableNavigation {
  const { markReady: _markReady, ...navigation } = useReliableNavigationContext();
  return navigation;
}

/**
 * Mark the current pathname rendered. Call from destination-owned components,
 * never from root loading.tsx. The effect does not re-run merely because a
 * navigation attempt starts, so the still-mounted source page cannot mark the
 * destination ready.
 */
export function useNavigationReady(): void {
  const pathname = usePathname();
  useNavigationReadyPathname(pathname);
}

/** Runtime seam used by destination-owned renderers and deterministic tests. */
export function useNavigationReadyPathname(pathname: string): void {
  const { markReady } = useReliableNavigationContext();
  useEffect(() => {
    markReady(pathname);
  }, [markReady, pathname]);
}
