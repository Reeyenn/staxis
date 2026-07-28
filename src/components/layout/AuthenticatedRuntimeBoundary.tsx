'use client';

import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { RouteErrorState, RouteLoadingState } from './RouteResourceState';

const AUTHENTICATED_PATH_PREFIXES = [
  '/home',
  '/feed',
  '/dashboard',
  '/housekeeping',
  '/communications',
  '/maintenance',
  '/inventory',
  '/staff',
  '/financials',
  '/company',
  '/settings',
  '/admin',
  '/property-selector',
] as const;

export function AuthenticatedRuntimeBoundary({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, loading, sessionError, sessionErrorKind, retrySession } = useAuth();
  const protectedRoute = AUTHENTICATED_PATH_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ));

  if (protectedRoute && sessionError) {
    return (
      <div style={{ minHeight: '100dvh', background: 'var(--staxis-app-background, radial-gradient(ellipse 1000px 500px at 50% 0%, #fff 0%, #f5f7f4 100%))' }}>
        <RouteErrorState
          title={sessionErrorKind === 'ended' ? 'Your session has ended' : 'Your session could not be confirmed'}
          message={sessionError}
          retryLabel={sessionErrorKind === 'ended' ? 'Sign in again' : 'Try again'}
          onRetry={retrySession}
        />
      </div>
    );
  }

  if (protectedRoute && loading) {
    return (
      <div style={{ minHeight: '100dvh', background: 'var(--staxis-app-background, radial-gradient(ellipse 1000px 500px at 50% 0%, #fff 0%, #f5f7f4 100%))' }}>
        <RouteLoadingState title="Confirming your session…" message="Opening the current Staxis workspace." />
      </div>
    );
  }

  if (protectedRoute && !user) {
    return (
      <div style={{ minHeight: '100dvh', background: 'var(--staxis-app-background, radial-gradient(ellipse 1000px 500px at 50% 0%, #fff 0%, #f5f7f4 100%))' }}>
        <RouteErrorState
          title="Sign in to continue"
          message="This browser no longer has an active Staxis session. Your hotel data was not changed."
          retryLabel="Sign in again"
          onRetry={() => {
            const target = `${window.location.pathname}${window.location.search}${window.location.hash}`;
            const params = new URLSearchParams({ reason: 'session-ended', redirect: target });
            window.location.assign(`/signin?${params.toString()}`);
          }}
        />
      </div>
    );
  }

  return children;
}
