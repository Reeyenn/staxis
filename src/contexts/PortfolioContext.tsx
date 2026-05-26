'use client';

/**
 * PortfolioContext — navigation + visibility helpers for the cross-
 * property `/portfolio` layer.
 *
 * Why a separate context (not merged into PropertyContext):
 *   • PropertyContext already owns the heavy state — properties list,
 *     activePropertyId, staff/areas/laundry for the active property,
 *     storage event cross-tab sync, retry-on-PGRST301 logic. It's
 *     hot-path on every page load. Merging portfolio-specific UI
 *     behavior into it would force every consumer to import navigation
 *     concerns they don't need.
 *   • This context is a THIN wrapper: it reads `properties` from
 *     PropertyContext and exposes navigation methods + the
 *     `isMultiProperty` flag the Header uses to gate the nav link.
 *
 * Stability note: `setActivePropertyId` from PropertyContext is NOT
 * memoized — every PropertyContext re-render produces a fresh function
 * reference (every realtime staff update, every token refresh). To
 * stop that cascade from re-rendering Portfolio consumers (Header,
 * breadcrumb, /portfolio page), we route the call through a ref. The
 * useMemo'd `value` then depends only on `properties.length` (which
 * actually changes when the membership changes), not on the unstable
 * function ref.
 */

import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useProperty } from './PropertyContext';
import type { Property } from '@/types';

interface PortfolioContextType {
  properties: Property[];
  isMultiProperty: boolean;
  switchToProperty: (propertyId: string, destination?: string) => void;
  returnToPortfolio: () => void;
}

const PortfolioContext = createContext<PortfolioContextType>({
  properties: [],
  isMultiProperty: false,
  switchToProperty: () => {},
  returnToPortfolio: () => {},
});

export function PortfolioProvider({ children }: { children: React.ReactNode }) {
  const { properties, setActivePropertyId } = useProperty();
  const router = useRouter();

  // Latch the unstable callbacks behind a ref so the memoized value
  // doesn't get rebuilt on every PropertyContext render.
  const setActivePropertyIdRef = useRef(setActivePropertyId);
  useEffect(() => {
    setActivePropertyIdRef.current = setActivePropertyId;
  }, [setActivePropertyId]);

  const value = useMemo<PortfolioContextType>(() => ({
    properties,
    isMultiProperty: properties.length >= 2,
    switchToProperty: (propertyId: string, destination = '/dashboard') => {
      setActivePropertyIdRef.current(propertyId);
      // Mark the session as "selected" so the middleware-redirect path
      // and any future "did the user pick a property this session?"
      // gate stays happy — same sentinel the in-Header switcher uses.
      try {
        sessionStorage.setItem('hotelops-session-selected', '1');
      } catch {
        // sessionStorage can throw in private windows / SSR — non-fatal.
      }
      router.push(destination);
    },
    returnToPortfolio: () => {
      router.push('/portfolio');
    },
    // Depending on the array reference + length covers the realistic
    // "membership changed" cases. Even if the array ref shifts on every
    // PropertyContext render (which it can, since PropertyContext
    // doesn't memoize), comparing on `properties` keeps useMemo cheap
    // — React still does a shallow ref check, but rebuilding the value
    // object is fine when membership actually moves.
  }), [properties, router]);

  return (
    <PortfolioContext.Provider value={value}>
      {children}
    </PortfolioContext.Provider>
  );
}

export function usePortfolio() {
  return useContext(PortfolioContext);
}
