// ═══════════════════════════════════════════════════════════════════════════
// Where the companion is allowed to exist at all.
//
// This is a DOOR BEHIND A DOOR. Today the housekeeper and laundry screens do
// not import AppLayout, so mounting the bubble inside AppLayout already
// excludes them by construction. That is a fact about today's file layout, and
// file layouts move. This gate does not depend on it: a companion asked to
// render on /housekeeper refuses even if somebody later wraps that page in the
// app shell.
//
// THE RULE IT ENFORCES (founder ruling, unchanged since the housekeeping
// lenses landed): Staxis never adds a step to a housekeeper's job. Their whole
// product is the room card on the phone they already carry. A helper bubble is
// one more thing to notice, learn, and be blamed for ignoring.
//
// Two independent reasons to refuse, checked in this order:
//   1. the SCREEN is a housekeeper-facing or public one, whoever is looking
//   2. the ROLE has no chat at this hotel (lenses.ts is the authority)
//
// Either alone is enough. A general manager opening a housekeeper's SMS link
// gets no bubble; a housekeeping-role account signed into the manager app gets
// no bubble.
// ═══════════════════════════════════════════════════════════════════════════

import type { AppRole } from '@/lib/roles';
import { chatIsMountedForRole } from '@/lib/agent/lenses';

/**
 * Route prefixes the companion must never appear on.
 *
 * Kept in step with the PUBLIC_EXACT / PUBLIC_PREFIXES lists in
 * src/middleware.ts. These are the screens a person reaches from an SMS link
 * with no Staxis login, so there is no session, no role, and nobody to greet.
 */
const OFF_LIMITS_PREFIXES: readonly string[] = [
  '/housekeeper',
  '/laundry',
  // Signed-out and setup surfaces. A greeting on a sign-in screen is noise at
  // best, and the onboarding wizard owns the welcome on /onboard (see
  // manners.ts and the promptShownAt guard it respects).
  '/signin',
  '/phone-signin',
  '/signup',
  '/join',
  '/invite',
  '/company-invite',
  '/onboard',
  '/consent',
  '/privacy',
  '/terms',
];

export type MountRefusal = 'off_limits_screen' | 'role_has_no_chat' | 'no_role';

export type MountDecision =
  | { mounts: true }
  | { mounts: false; refusal: MountRefusal };

/**
 * Is this a screen the companion may render on?
 *
 * Exact match or a `/prefix/...` child. `/housekeeping` (the manager board) is
 * deliberately NOT caught: prefix matching stops at a segment boundary, so the
 * manager screen keeps its bubble while `/housekeeper` and `/housekeeper/<id>`
 * lose theirs.
 */
export function companionAllowedOnPath(pathname: string | null | undefined): boolean {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return false;
  // Query and hash are not part of the decision, and a trailing slash must not
  // be a way around the list.
  const path = pathname.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
  for (const prefix of OFF_LIMITS_PREFIXES) {
    if (path === prefix || path.startsWith(prefix + '/')) return false;
  }
  return true;
}

/** The whole gate. Both reasons, in order, with the reason kept for tests. */
export function companionMounts(input: {
  pathname: string | null | undefined;
  role: AppRole | null | undefined;
}): MountDecision {
  if (!companionAllowedOnPath(input.pathname)) {
    return { mounts: false, refusal: 'off_limits_screen' };
  }
  if (!input.role) return { mounts: false, refusal: 'no_role' };
  if (!chatIsMountedForRole(input.role)) {
    return { mounts: false, refusal: 'role_has_no_chat' };
  }
  return { mounts: true };
}
