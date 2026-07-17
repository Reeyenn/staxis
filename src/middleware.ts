import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';

/**
 * Edge auth gate.
 *
 * Inverted matcher: any request whose pathname is NOT on the public
 * allowlist and does NOT carry an `sb-<projectRef>-auth-token` cookie
 * gets a 302 to `/signin?redirect=<pathname>`.
 *
 * This is a presence check, not a validity check. We do not call
 * `supabase.auth.getUser()` here — that would add a Supabase round-trip
 * to every request, and the browser client / API routes already validate
 * the token on the way through. The middleware's job is to close the
 * "flash of protected HTML" gap and make signed-out direct hits land on
 * the sign-in page from the server, not from a client-side bounce.
 *
 * Public allowlist below is exhaustive — anything not listed is treated
 * as protected. /api/* is included because each API route does its own
 * auth via requireSession / requireAdmin / requireCronSecret; redirecting
 * unauthenticated /api/* requests to /signin would break JSON consumers.
 */

const PUBLIC_EXACT = new Set<string>([
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
  // SMS-linked staff pages — auth via URL params (uid+pid+staffId), not session
  '/housekeeper',
  '/laundry',
  '/engineer',
]);

const PUBLIC_PREFIXES = [
  '/signin',         // /signin, /signin/verify, /signin/forgot, /signin/reset
  '/phone-signin',   // QR phone handoff; all data/auth gates live in /api routes
  '/onboard/',       // unified onboarding wizard sub-steps
  '/invite/',        // /invite/[token]
  '/housekeeper/',   // /housekeeper/[id]
  '/laundry/',       // /laundry/[id]
  '/engineer/',      // /engineer/[id] — engineering-compliance mobile page
  '/api/',           // every API route does its own auth
];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  for (const prefix of PUBLIC_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Derive the Supabase auth cookie name prefix from the project URL.
 * @supabase/ssr chunks the token across cookies named
 *   `sb-<projectRef>-auth-token`     (single chunk)
 *   `sb-<projectRef>-auth-token.0`   (multi-chunk)
 *   `sb-<projectRef>-auth-token.1`
 * Any chunk being present means the user has a session candidate.
 *
 * Cached at module init — the URL doesn't change per request.
 */
const PROJECT_REF = env.NEXT_PUBLIC_SUPABASE_URL
  .replace(/^https?:\/\//, '')
  .split('.')[0];
const AUTH_COOKIE_PREFIX = `sb-${PROJECT_REF}-auth-token`;

function hasAuthCookie(req: NextRequest): boolean {
  for (const c of req.cookies.getAll()) {
    if (c.name === AUTH_COOKIE_PREFIX || c.name.startsWith(`${AUTH_COOKIE_PREFIX}.`)) {
      return true;
    }
  }
  return false;
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (hasAuthCookie(req)) {
    return NextResponse.next();
  }

  // Protected path + no auth cookie → 302 to /signin with redirect param so
  // the user lands back on the originally-requested page after sign-in.
  const url = req.nextUrl.clone();
  url.pathname = '/signin';
  url.search = '';
  url.searchParams.set('redirect', pathname + (search || ''));
  return NextResponse.redirect(url);
}

/**
 * Skip the middleware function entirely for static assets and Next.js
 * internals — they never need an auth check and running the function on
 * every image/CSS request is wasted compute.
 *
 *   `_next/static`, `_next/image` — Next.js build output
 *   `favicon.ico`, `manifest.json`, `sw.js`, `robots.txt` — root statics
 *   `.*\\..*` — any path with a file extension (covers /elevenlabs/*.mjs,
 *               /wake-words/*.ppn, /icons/*.svg, etc.). Path segments that
 *               legitimately contain a dot in the route (none today) would
 *               also be excluded — fine for our route surface.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|robots.txt|.*\\..*).*)'],
};
