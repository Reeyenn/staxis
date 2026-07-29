import 'server-only';

import { isSectionEnabled, type AppSection } from '@/lib/sections/registry';
import { parseStoredEnabledSections } from '@/lib/sections/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

export type PortfolioSectionDecision = 'enabled' | 'disabled' | 'unavailable';

export type PortfolioSectionsAccess = ReadonlyMap<
  AppSection,
  ReadonlyMap<string, PortfolioSectionDecision>
>;

/**
 * Resolve one module policy across an already-authorized hotel set in one
 * bounded read. A malformed/missing row is unavailable for that hotel; a read
 * outage makes the whole decision unavailable. Neither path defaults ON.
 */
export async function resolvePortfolioSectionAccess(
  propertyIds: readonly string[],
  section: AppSection,
): Promise<Map<string, PortfolioSectionDecision>> {
  const resolved = await resolvePortfolioSectionsAccess(propertyIds, [section]);
  return new Map(resolved.get(section) ?? []);
}

/** Resolve several module policies from one properties read and one strict parse. */
export async function resolvePortfolioSectionsAccess(
  propertyIds: readonly string[],
  sections: readonly AppSection[],
): Promise<PortfolioSectionsAccess> {
  const ids = [...new Set(propertyIds)];
  const requested = [...new Set(sections)];
  const unavailableFor = () => new Map<string, PortfolioSectionDecision>(
    ids.map((propertyId) => [propertyId, 'unavailable' as const]),
  );
  const unavailable = () => new Map(
    requested.map((section) => [section, unavailableFor()] as const),
  );
  if (ids.length === 0 || requested.length === 0) return unavailable();

  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id, enabled_sections')
    .in('id', ids);
  if (error || !Array.isArray(data)) return unavailable();

  const allowed = new Set(ids);
  const decisions = unavailable();
  for (const row of data as Array<{ id: string; enabled_sections: unknown }>) {
    if (!allowed.has(row.id)) return unavailable();
    try {
      const sections = parseStoredEnabledSections(row.enabled_sections);
      for (const section of requested) {
        (decisions.get(section) as Map<string, PortfolioSectionDecision>).set(
          row.id,
          isSectionEnabled(sections, section) ? 'enabled' : 'disabled',
        );
      }
    } catch {
      // Initialized unavailable for every requested section at this hotel.
    }
  }
  return decisions;
}
