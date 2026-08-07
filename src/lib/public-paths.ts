// ═══════════════════════════════════════════════════════════════════════════
// The allowlist of URL paths a visitor can open with NO Staxis login.
//
// This used to live inline in src/middleware.ts. It moved here because two
// other things need to agree with it and could not read it:
//
//   1. src/middleware.ts — the edge auth gate (the only consumer that decides
//      real traffic).
//   2. The public-page guards (scripts/audit-public-page-direct-supabase.mjs
//      + src/lib/__tests__/public-page-guard-coverage.test.ts) — the lint rule
//      that stops a public page from reading through the anon browser client,
//      which is the #1 recurring bug in this codebase (see CLAUDE.md).
//
// Why that mattered: the guard kept its own hand-written copy of "which route
// segments are public". When every public page moved into Next route groups
// — src/app/(public)/signin, src/app/(staff-link)/housekeeper/[id] — the copy
// stopped matching and the guard silently went from covering the housekeeper
// page to covering nothing but a handful of leaf components. A regression on
// the housekeeper page would have linted clean.
//
// One list, imported by the gate and asserted against by the guard. Adding a
// public route here is now the single action that both opens the door and
// puts the door under guard.
//
// Isomorphic + I/O-free: the middleware runs on the edge runtime, so keep this
// file free of `server-only`, node builtins and env access.
// ═══════════════════════════════════════════════════════════════════════════

/** Exact pathnames that are public. */
export const PUBLIC_EXACT: ReadonlySet<string> = new Set<string>([
  // Marketing / landing
  '/',
  // Legal + consent
  '/privacy',
  '/terms',
  '/consent',
  // Signup / onboarding flow
  '/signup',
  '/onboard',
  '/join',
  // SMS-linked staff pages — auth via the per-staff link token, not a session
  '/housekeeper',
  '/laundry',
]);

/** Pathname prefixes that are public (everything below them included). */
export const PUBLIC_PREFIXES: readonly string[] = [
  '/signin',         // /signin, /signin/verify, /signin/forgot, /signin/reset
  '/phone-signin',   // QR phone handoff; all data/auth gates live in /api routes
  '/onboard/',       // unified onboarding wizard sub-steps
  '/invite/',        // /invite/[token]
  '/company-invite/', // scoped organization invite (token-gated page)
  '/housekeeper/',   // /housekeeper/[id]
  '/laundry/',       // /laundry/[id]
  '/api/',           // every API route does its own auth
];

/** True when an unauthenticated visitor may open this pathname. */
export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  for (const prefix of PUBLIC_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  return false;
}
