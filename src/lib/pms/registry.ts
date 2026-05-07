/**
 * PMS registry — the single source of truth for "what PMS families do we
 * support, what's their human-readable name, and what login URL hint do
 * we prefill in /settings/pms."
 *
 * This file is intentionally type-safe and side-effect-free so it can be
 * imported from both client components (the dropdown in
 * /settings/pms/page.tsx) and server modules (the API routes that
 * validate incoming pms_type values).
 *
 * Adapter execution lives elsewhere — see:
 *   - src/lib/pms/recipe-loader.ts (server-only) for loading the active
 *     recipe from pms_recipes
 *   - cua-service/ (Fly.io worker) for actually running recipes against
 *     real PMSes via Playwright + Claude vision
 */

import type { PMSType } from './types';
import { PMS_TYPES } from './types';

export interface PMSDefinition {
  id: PMSType;
  /** Display name shown in the dropdown. */
  label: string;
  /** What hotels this PMS is typical for. Helps GMs self-identify. */
  hint: string;
  /** Default login URL prefilled in the form when this is selected. */
  defaultLoginUrl?: string;
  /**
   * Whether the steady-state scraper for this PMS lives on Railway (the
   * existing fleet) or Fly.io (the new CUA-driven pool). New PMSes go on
   * Fly.io; choice_advantage stays on Railway until we've migrated it.
   */
  runtime: 'railway' | 'fly';
  /**
   * Tier 1 PMS = recipe is mature, onboarding is the 5-minute path.
   * Tier 2 PMS = recipe is mapped but not battle-tested, expect quirks.
   * Tier 3 PMS = no recipe yet, first onboarding will run a CUA mapping.
   */
  tier: 1 | 2 | 3;
}

export const PMS_REGISTRY: Record<PMSType, PMSDefinition> = {
  choice_advantage: {
    id: 'choice_advantage',
    label: 'Choice Advantage',
    hint: 'Comfort Suites, Quality Inn, Sleep Inn, MainStay, Cambria',
    defaultLoginUrl: 'https://www.choiceadvantage.com/choicehotels/Welcome.init',
    runtime: 'railway',
    tier: 1,
  },
  opera_cloud: {
    id: 'opera_cloud',
    label: 'Oracle Opera Cloud',
    hint: 'Marriott full-service, Hilton, Hyatt, IHG full-service',
    runtime: 'fly',
    tier: 3,
  },
  cloudbeds: {
    id: 'cloudbeds',
    label: 'Cloudbeds',
    hint: 'Independent hotels, hostels, B&Bs',
    defaultLoginUrl: 'https://hotels.cloudbeds.com/auth/login',
    runtime: 'fly',
    tier: 3,
  },
  roomkey: {
    id: 'roomkey',
    label: 'RoomKey PMS',
    hint: 'BestWestern, independent boutique hotels',
    runtime: 'fly',
    tier: 3,
  },
  skytouch: {
    id: 'skytouch',
    label: 'SkyTouch Hotel OS',
    hint: 'Choice Hotels brands (sister to Choice Advantage)',
    runtime: 'fly',
    tier: 3,
  },
  webrezpro: {
    id: 'webrezpro',
    label: 'WebRezPro',
    hint: 'Lodges, resorts, vacation properties',
    runtime: 'fly',
    tier: 3,
  },
  hotelogix: {
    id: 'hotelogix',
    label: 'Hotelogix',
    hint: 'Small to mid-size independent hotels',
    runtime: 'fly',
    tier: 3,
  },
  other: {
    id: 'other',
    label: 'Other / Not Listed',
    hint: 'Tell us your PMS — we will map it via CUA',
    runtime: 'fly',
    tier: 3,
  },
};

/** Ordered list for UI dropdowns. Tier 1 first, then alphabetical. */
export const PMS_DROPDOWN_OPTIONS: PMSDefinition[] = (() => {
  const all = PMS_TYPES.map((t) => PMS_REGISTRY[t]);
  return all.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.id === 'other') return 1;
    if (b.id === 'other') return -1;
    return a.label.localeCompare(b.label);
  });
})();

export function getPMSDefinition(t: PMSType): PMSDefinition {
  return PMS_REGISTRY[t];
}
