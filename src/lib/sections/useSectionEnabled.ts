'use client';

// Client-side section gate. Reads the ACTIVE SCOPE from PropertyContext and
// resolves it through the shared per-scope contract in
// @/lib/portfolio-ui/acting-scope.
//
// THIS USED TO FAIL OPEN. While the property was null every section resolved ON
// so the nav would not flash-hide a tab, while useCan failed CLOSED for exactly
// the same state. Under an unresolved scope that pairing renders the whole
// navigation with every button dead, which is worse than a tab arriving a beat
// late. Both gates now refuse an unresolved scope, and sectionsForScope is
// where that rule lives so a test can hold the two together.

import { useProperty } from '@/contexts/PropertyContext';
import { sectionsForScope } from '@/lib/portfolio-ui/acting-scope';
import type { AppSection } from './registry';

/** The full resolved 8-key map for the current scope. */
export function useEnabledSections(): Record<AppSection, boolean> {
  const { activeScope, activeProperty, properties } = useProperty();
  const companyPropertyIds = activeScope.kind === 'company'
    ? new Set(activeScope.scope.propertyIds)
    : null;
  return sectionsForScope(activeScope, {
    hotel: activeProperty?.enabledSections,
    company: companyPropertyIds
      ? properties
        .filter((property) => companyPropertyIds.has(property.id.toLowerCase()))
        .map((property) => property.enabledSections)
      : [],
  });
}

/** Is a single section on at the current scope? */
export function useSectionEnabled(section: AppSection): boolean {
  return useEnabledSections()[section];
}
