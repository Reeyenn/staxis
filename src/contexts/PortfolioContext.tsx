'use client';

import React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

import { useApiResource } from '@/lib/hooks/use-api-resource';
import type { PortfolioUiBootstrapV1 } from '@/lib/portfolio-ui/contracts';
import { shouldLoadPortfolioBootstrap } from '@/lib/portfolio-ui/entry-routing';
import { useAuth } from '@/contexts/AuthContext';

interface PortfolioContextValue {
  data: PortfolioUiBootstrapV1 | null;
  loading: boolean;
  error: string | null;
  requestedOrganizationId: string | null;
  reload: () => Promise<void>;
}

const PortfolioContext = React.createContext<PortfolioContextValue | null>(null);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function PortfolioProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const {
    user,
    loading: authLoading,
    authorizationFingerprint,
    authorizationChecked,
    platformAdmin,
    propertyStandings,
  } = useAuth();
  const rawOrganizationId = searchParams.get('organizationId');
  const requestedOrganizationId = rawOrganizationId && UUID.test(rawOrganizationId)
    ? rawOrganizationId
    : null;
  const malformedSelection = rawOrganizationId !== null && requestedOrganizationId === null;
  const portfolioRoute = pathname === '/portfolio' || pathname.startsWith('/portfolio/');
  const portfolioQuery = searchParams.get('scope') === 'portfolio';
  const hotelDrilldown = searchParams.get('scope') === 'hotel';
  const entryRoute = (pathname === '/home' || pathname === '/property-selector') && !hotelDrilldown;
  const adminPortfolioContext = user?.role === 'admin' && (portfolioRoute || portfolioQuery);
  const enabled = shouldLoadPortfolioBootstrap({
    signedIn: Boolean(user),
    authLoading,
    browserRoleIsAdmin: user?.role === 'admin',
    authorizationChecked,
    platformAdmin,
    propertyStandings,
    explicitPortfolioContext: portfolioRoute || portfolioQuery,
    entryRoute,
  });
  const endpoint = requestedOrganizationId
    ? `/api/portfolio/v1/bootstrap?organizationId=${encodeURIComponent(requestedOrganizationId)}`
    : '/api/portfolio/v1/bootstrap';
  const resource = useApiResource<PortfolioUiBootstrapV1>(endpoint, {
    enabled: enabled && !malformedSelection,
    identityKey: user
      ? JSON.stringify([
          user.uid,
          user.accountId,
          user.role,
          authorizationChecked,
          authorizationFingerprint,
        ])
      : null,
    keepDataOnError: false,
    revalidateOnFocus: true,
    clearDataOnFocusRevalidate: true,
  });
  const responseMatchesRequest = resource.data?.selection.requestedOrganizationId
    === requestedOrganizationId;
  const mismatchedResponse = resource.data !== null && !responseMatchesRequest;
  const safeData = responseMatchesRequest ? resource.data : null;

  const value = React.useMemo<PortfolioContextValue>(() => ({
    data: safeData,
    loading: enabled && !malformedSelection ? resource.loading : false,
    error: adminPortfolioContext
      ? 'Platform administrators must enter through an explicitly authorized customer context.'
      : malformedSelection && enabled
      ? 'That portfolio link is not valid.'
      : mismatchedResponse
        ? 'The portfolio response did not match the requested company.'
        : resource.error,
    requestedOrganizationId,
    reload: resource.reload,
  }), [adminPortfolioContext, enabled, malformedSelection, mismatchedResponse, requestedOrganizationId, resource.error, resource.loading, resource.reload, safeData]);

  return <PortfolioContext.Provider value={value}>{children}</PortfolioContext.Provider>;
}

export function usePortfolio(): PortfolioContextValue {
  const value = React.useContext(PortfolioContext);
  if (!value) throw new Error('usePortfolio must be used inside PortfolioProvider');
  return value;
}

export function useOptionalPortfolio(): PortfolioContextValue | null {
  return React.useContext(PortfolioContext);
}
