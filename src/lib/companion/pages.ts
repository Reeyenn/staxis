// ═══════════════════════════════════════════════════════════════════════════
// The screens the companion can walk somebody to, and what it says when they
// arrive.
//
// THE ALLOWLIST IS THE SECURITY BOUNDARY. Navigation targets are CONSTANTS
// declared in this file. Nothing the model writes, nothing the browser sends,
// and nothing stored in the database ever becomes an href. `resolveDestination`
// takes a key, not a URL, so "take me there" cannot be pointed at an external
// site, a javascript: URL, or another hotel's page. There is deliberately no
// function here that accepts an arbitrary string and returns somewhere to go.
//
// The intros do double duty: they are what the companion says after it walks
// you somewhere, and they are the script for the first-run tour. Writing them
// once means the tour can never describe a screen differently from the way the
// companion describes it on arrival.
//
// VOICE: one or two sentences. What the screen is FOR, in the words a manager
// would use. No feature lists, no "powerful", no exclamation marks, no em
// dashes. If a sentence could appear in a brochure, it is wrong.
// ═══════════════════════════════════════════════════════════════════════════

import type { AppRole } from '@/lib/roles';
import { canManageTeam } from '@/lib/roles';
import type { AppSection } from '@/lib/sections/registry';
import { isSectionEnabled, type EnabledSections } from '@/lib/sections/registry';

export type CompanionPageKey =
  | 'dashboard'
  | 'staxis'
  | 'inventory'
  | 'maintenance'
  | 'people'
  | 'knows'
  | 'messages'
  | 'settings';

export interface CompanionPage {
  key: CompanionPageKey;
  /** What the companion calls this screen out loud. Matches the top nav. */
  label: string;
  /** The ONLY href for this key. A constant, never assembled from input. */
  href: string;
  /** Pathname the href lands on, for "are they already here" checks. */
  path: string;
  /** Section gate, or null for screens outside the eight-section registry. */
  section: AppSection | null;
  /** True when only a manager, owner or admin should be offered this screen. */
  managerOnly: boolean;
  /** One or two sentences, spoken on arrival and used by the tour. */
  intro: string;
}

export const COMPANION_PAGES: readonly CompanionPage[] = [
  {
    key: 'staxis',
    label: 'Staxis',
    href: '/feed',
    path: '/feed',
    section: 'staxis',
    managerOnly: false,
    intro:
      'Staxis is your one list for running the hotel. Anything that needs a '
      + 'decision or a follow up turns up here, from every part of the app.',
  },
  {
    key: 'dashboard',
    label: 'Dashboard',
    href: '/dashboard',
    path: '/dashboard',
    section: 'dashboard',
    managerOnly: false,
    intro:
      'The dashboard is the hotel at a glance: who is in house, what is '
      + 'arriving, and what is not ready yet.',
  },
  {
    key: 'inventory',
    label: 'Inventory',
    href: '/inventory',
    path: '/inventory',
    section: 'inventory',
    managerOnly: false,
    intro:
      'Inventory is what you have on hand and what is running low. Count '
      + 'items, file invoices, and see what is worth reordering.',
  },
  {
    key: 'maintenance',
    label: 'Maintenance',
    href: '/maintenance',
    path: '/maintenance',
    section: 'maintenance',
    managerOnly: false,
    intro:
      'Maintenance is your work orders and the jobs that come round again. '
      + 'Log what broke, see what is still open, and keep the routine work on time.',
  },
  {
    key: 'messages',
    label: 'Messages',
    href: '/communications',
    path: '/communications',
    section: 'communications',
    managerOnly: false,
    intro:
      'Messages is where your team talks. Write to one person or a whole '
      + 'shift, and post the notices everybody should see.',
  },
  {
    key: 'knows',
    label: 'Knows',
    href: '/feed?tab=knows',
    path: '/feed',
    section: 'staxis',
    managerOnly: false,
    intro:
      'Knows is what Staxis believes about your hotel and where it learned '
      + 'each thing. If something is wrong, fix it here and it stops being used.',
  },
  {
    key: 'people',
    label: 'People',
    href: '/company?tab=people',
    path: '/company',
    section: null,
    managerOnly: true,
    intro:
      'People is your roster. Who works here, how to reach them, and what '
      + 'each person is allowed to see.',
  },
  {
    key: 'settings',
    label: 'Settings',
    href: '/settings',
    path: '/settings',
    section: null,
    managerOnly: true,
    intro:
      'Settings is where the hotel itself is set up: shifts, checklists, '
      + 'reports, and who has access.',
  },
];

const PAGE_BY_KEY: Readonly<Record<CompanionPageKey, CompanionPage>> = Object.fromEntries(
  COMPANION_PAGES.map((p) => [p.key, p]),
) as Record<CompanionPageKey, CompanionPage>;

export function isCompanionPageKey(x: unknown): x is CompanionPageKey {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(PAGE_BY_KEY, x);
}

/**
 * A key becomes a destination, or it does not.
 *
 * Returns null for an unknown key, for a screen this hat should not be sent to,
 * and for a section this hotel has switched off. Null means "do not offer",
 * never "offer it and let the page refuse" — walking somebody into a locked
 * door is worse than staying quiet.
 */
export function resolveDestination(
  key: unknown,
  ctx: { role: AppRole | null | undefined; enabledSections: EnabledSections | undefined },
): CompanionPage | null {
  if (!isCompanionPageKey(key)) return null;
  const page = PAGE_BY_KEY[key];
  if (!ctx.role) return null;
  if (page.managerOnly && !canManageTeam(ctx.role)) return null;
  if (page.section && !isSectionEnabled(ctx.enabledSections, page.section)) return null;
  return page;
}

/** Every screen this person may be offered, in tour order. */
export function pagesFor(ctx: {
  role: AppRole | null | undefined;
  enabledSections: EnabledSections | undefined;
}): CompanionPage[] {
  return COMPANION_PAGES.filter((p) => resolveDestination(p.key, ctx) !== null);
}

/** What the companion says on arrival. */
export function introFor(key: CompanionPageKey): string {
  return PAGE_BY_KEY[key].intro;
}

/**
 * Which screen the person is looking at right now, or null.
 *
 * Used for the one-voice rule (never walk somebody to the screen they are
 * already on) and to pick the right "what is this screen" answer. Matches on
 * pathname only: `/feed` and `/feed?tab=knows` share a path, so the first
 * declaration wins and the answer is "Staxis", which is what the tab strip
 * says on arrival.
 */
export function pageForPath(pathname: string | null | undefined): CompanionPage | null {
  if (typeof pathname !== 'string') return null;
  const path = pathname.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
  return COMPANION_PAGES.find((p) => p.path === path) ?? null;
}

/**
 * The first-run tour, sized to the hat.
 *
 * A front desk hire is shown their world, not the owner's. The order is "where
 * the work is" first and "where the settings are" last, because the tour is
 * meant to end with somebody able to do their job, not able to configure one.
 */
export function tourFor(ctx: {
  role: AppRole | null | undefined;
  enabledSections: EnabledSections | undefined;
}): CompanionPage[] {
  const available = pagesFor(ctx);
  const wanted: CompanionPageKey[] = ctx.role && canManageTeam(ctx.role)
    ? ['staxis', 'dashboard', 'inventory', 'maintenance', 'messages', 'knows', 'people', 'settings']
    : ['staxis', 'dashboard', 'maintenance', 'inventory', 'messages'];
  return wanted
    .map((k) => available.find((p) => p.key === k))
    .filter((p): p is CompanionPage => p !== undefined);
}
