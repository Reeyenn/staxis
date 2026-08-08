'use client';

import type { ReactNode } from 'react';
import { useEffect } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { usePortfolio } from '@/contexts/PortfolioContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useReliableNavigation } from '@/lib/hooks/use-reliable-navigation';
import {
  companyDefaultEntryDestination,
  sessionSelectionIsActive,
} from '@/lib/portfolio-ui/acting-scope';

/** Keep the public marketing page for signed-out visitors, but hand an
 * authenticated company-hat viewer to the same default-entry policy as Home. */
export default function ExistingSessionEntryRedirect({ children }: { children: ReactNode }) {
  const { user, loading: authLoading, authorizationChecked } = useAuth();
  const portfolio = usePortfolio();
  const { sessionHotelChoice } = useProperty();
  const navigation = useReliableNavigation();
  const companyHat = portfolio.data?.hasCompanyHat === true;
  let sessionSelected = false;
  if (typeof window !== 'undefined') {
    try {
      sessionSelected = window.sessionStorage.getItem('hotelops-session-selected') === '1';
    } catch {
      // A blocked sessionStorage must fail toward the company picker.
    }
  }
  const destination = !authLoading && user && !portfolio.loading
    ? companyDefaultEntryDestination({
        companyHat,
        sessionSelected: sessionSelectionIsActive({
          sessionMarker: sessionSelected,
          inMemoryChoice: sessionHotelChoice,
        }),
        bootstrapError: portfolio.enabled && portfolio.error !== null,
      })
    : null;

  useEffect(() => {
    if (destination) navigation.replace(destination);
  }, [destination, navigation]);

  const opening = authLoading
    || Boolean(user && !authorizationChecked)
    || Boolean(user && portfolio.enabled && !portfolio.data && !portfolio.error);
  const pending = opening || Boolean(destination);
  return (
    <>
      <div
        aria-hidden={pending ? 'true' : undefined}
        style={pending ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}
      >
        {children}
      </div>
      {pending && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            display: 'grid', placeItems: 'center',
            background: 'var(--bg)', color: 'var(--text-secondary)',
          }}
        >
          Opening Staxis…
        </div>
      )}
    </>
  );
}
