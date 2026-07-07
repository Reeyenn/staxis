'use client';

// Client-side section gate. Reads the active hotel's enabled_sections (which
// rides along on PropertyContext.activeProperty — no extra fetch) and resolves
// it through the shared default-ON contract. FAIL-OPEN while the property is
// still loading (activeProperty null ⇒ every section ON) so the nav never
// flash-hides a tab and then pops it back.

import { useProperty } from '@/contexts/PropertyContext';
import { isSectionEnabled, resolveSections, type AppSection } from './registry';

/** Is a single section on for the active hotel? True while loading. */
export function useSectionEnabled(section: AppSection): boolean {
  const { activeProperty } = useProperty();
  return isSectionEnabled(activeProperty?.enabledSections, section);
}

/** The full resolved 8-key map for the active hotel (every missing key ⇒ ON).
 *  Handy for one-shot nav filtering in the Header. */
export function useEnabledSections(): Record<AppSection, boolean> {
  const { activeProperty } = useProperty();
  return resolveSections(activeProperty?.enabledSections);
}
