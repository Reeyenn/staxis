/**
 * Does the public-page guard actually guard the public pages?
 *
 * CLAUDE.md names one bug as the most-recurring in this repo: a page an
 * unauthenticated visitor opens (the housekeeper SMS link, the laundry link,
 * sign-in) reads through the anon browser client, RLS returns 200 OK + [], and
 * the page renders empty with no error. It shipped three times in eight days.
 * scripts/audit-public-page-direct-supabase.mjs is the lint rule that is
 * supposed to make a fourth impossible.
 *
 * That rule decides "is this file part of a public page?" by looking at the
 * directory name under src/app. Next route groups — src/app/(public)/signin,
 * src/app/(staff-link)/housekeeper/[id] — are directories that contribute
 * NOTHING to the URL. When the public pages moved into them, the rule started
 * comparing "(public)" and "(staff-link)" against its segment list, matched
 * nothing, and reported "✓ no violations" while scanning zero real public
 * pages. A green lint said the housekeeper page was safe; the guard had never
 * opened it.
 *
 * These tests exercise the rule's real predicate against the real repo:
 *
 *   1. Every page.tsx whose URL the edge middleware lets an anonymous visitor
 *      open must be in the guard's scope.
 *   2. The named pages that have actually caused outages are pinned by name so
 *      nobody has to reason about route groups to see the regression.
 *
 * This is not a source-string grep. It runs the shipped predicate over the
 * shipped route tree and asserts on what it decides — the same question the
 * lint run asks, with the answer checked instead of assumed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { isPublicPath, PUBLIC_EXACT, PUBLIC_PREFIXES } from '@/lib/public-paths';

const REPO = join(__dirname, '..', '..', '..');
const APP = join(REPO, 'src', 'app');
const GUARD = join(REPO, 'scripts', 'audit-public-page-direct-supabase.mjs');

type Guard = {
  isInsidePublicRoute: (relPath: string) => boolean;
  publicRouteFiles: () => string[];
  PUBLIC_ROUTE_SEGMENTS: Set<string>;
};

// The guard is plain .mjs (it runs in `npm run lint` with no build step), so
// it loads through a dynamic import rather than a static one.
async function loadGuard(): Promise<Guard> {
  return (await import(GUARD)) as unknown as Guard;
}

/** A route group directory — `(public)`, `(staff-link)`. Not part of the URL. */
function isRouteGroup(segment: string): boolean {
  return segment.startsWith('(') && segment.endsWith(')');
}

/**
 * Map a page file to the URL it serves, the way Next does: drop route groups,
 * drop private `_folders`, and substitute a sample value for dynamic segments
 * (the allowlist matches on prefixes, so any value works).
 */
function routeUrlForPageFile(relPath: string): string {
  const parts = relPath.split(sep);
  // strip 'src', 'app', and the trailing 'page.tsx'
  const segments = parts
    .slice(2, -1)
    .filter((p) => !isRouteGroup(p) && !p.startsWith('_'))
    .map((p) => (p.startsWith('[') ? 'x' : p));
  return '/' + segments.join('/');
}

function walkPages(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkPages(p, out);
    else if (entry === 'page.tsx' || entry === 'page.jsx') out.push(p);
  }
  return out;
}

const pageFiles = walkPages(APP).map((p) => relative(REPO, p));

describe('public-page anon-client guard covers every page a logged-out visitor can open', () => {
  test('the repo actually has pages to check (harness sanity)', () => {
    assert.ok(pageFiles.length > 10, `expected many page files under src/app, found ${pageFiles.length}`);
  });

  test('every page on the middleware public allowlist is inside the guard scope', async () => {
    const guard = await loadGuard();

    const publicPages = pageFiles.filter((rel) => isPublicPath(routeUrlForPageFile(rel)));
    assert.ok(
      publicPages.length >= 10,
      `expected the middleware allowlist to match many pages, matched ${publicPages.length}`,
    );

    const unguarded = publicPages.filter((rel) => !guard.isInsidePublicRoute(rel));
    assert.deepEqual(
      unguarded,
      [],
      'these pages are reachable with no Staxis login, so an anon supabase.from() in them '
      + 'renders a silently-empty screen — but the guard does not scan them:\n  '
      + unguarded.join('\n  '),
    );
  });

  test('the housekeeper and laundry SMS-link pages are scanned', async () => {
    const guard = await loadGuard();
    // Pinned by name: these two are THE surface the bug keeps landing on, and
    // they are the ones the route-group move hid.
    assert.equal(
      guard.isInsidePublicRoute(join('src', 'app', '(staff-link)', 'housekeeper', '[id]', 'page.tsx')),
      true,
      'the housekeeper page a cleaner opens from her text message must be guarded',
    );
    assert.equal(
      guard.isInsidePublicRoute(join('src', 'app', '(staff-link)', 'laundry', '[id]', 'page.tsx')),
      true,
      'the laundry page must be guarded',
    );
    assert.equal(
      guard.isInsidePublicRoute(join('src', 'app', '(public)', 'signin', 'page.tsx')),
      true,
      'the sign-in page must be guarded',
    );
  });

  test('a signed-in-only page stays out of scope (the rule still discriminates)', async () => {
    const guard = await loadGuard();
    assert.equal(
      guard.isInsidePublicRoute(join('src', 'app', '(hotel)', 'financials', 'page.tsx')),
      false,
      'protected pages must not be pulled into the public-page rule',
    );
  });

  test('the guard scans a realistic number of files, not a handful of leaf components', async () => {
    const guard = await loadGuard();
    const files = guard.publicRouteFiles();
    assert.ok(
      files.length >= 25,
      `guard scope collapsed to ${files.length} file(s) — the public pages are almost certainly `
      + 'hidden behind a directory-name change again',
    );
  });

  test('every allowlisted URL segment has a matching guard segment', async () => {
    const guard = await loadGuard();
    // Both lists exist because the guard is .mjs and cannot import TypeScript.
    // This is the drift alarm: open a route in the middleware, and the guard
    // has to learn about it in the same change.
    const urlSegments = new Set<string>();
    for (const p of PUBLIC_EXACT) {
      const seg = p.split('/').filter(Boolean)[0];
      if (seg) urlSegments.add(seg);
    }
    for (const p of PUBLIC_PREFIXES) {
      const seg = p.split('/').filter(Boolean)[0];
      if (seg && seg !== 'api') urlSegments.add(seg);
    }
    const missing = [...urlSegments].filter((s) => !guard.PUBLIC_ROUTE_SEGMENTS.has(s));
    assert.deepEqual(
      missing,
      [],
      `public URL segments the anon-client guard does not know about: ${missing.join(', ')}`,
    );
  });
});
