#!/usr/bin/env node
// audit-api-route-tenant-scope — fails the build if an API route file
// imports supabaseAdmin (the service-role client that bypasses RLS) but
// doesn't reference any of the known auth guards.
//
// Why: a route using service-role to read or mutate data must either be
// admin-fleet (CRON_SECRET / requireAdmin) or per-property (must verify
// the caller has access to the property in the body/query). A route that
// just imports supabaseAdmin and uses `req.json().propertyId` without a
// guard would silently read or write across tenants. This script catches
// that class at PR time before merge.
//
// Scope:
//   - src/app/api/**/route.ts (every Next.js route handler).
//   - src/app/**/page.tsx, src/app/**/layout.tsx WITHOUT `'use client'`
//     (server components). Today none of them import supabaseAdmin or
//     createSupabaseServerClient; this script keeps it that way.
//
// Algorithm:
//   1. For each route.ts: parse it.
//   2. If it imports `supabaseAdmin` OR `createSupabaseServerClient` AND
//      contains any HTTP-method export (GET/POST/PATCH/PUT/DELETE), look
//      for at least one reference to a KNOWN_GUARD.
//   3. If no guard found, flag the file.
//   4. Honor escape marker `// @audit: tenant-scope-not-applicable — <reason>`
//      anywhere in the first 30 lines of the file.
//
// Escape marker is for legitimate exceptions like a webhook that signs its
// own payload (Twilio, Stripe) and validates the signature instead of a
// session — those routes still touch the DB via service-role but don't
// need a session-bound tenant check.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const APP = join(REPO, 'src', 'app');

const KNOWN_GUARDS = [
  // From src/lib/api-auth.ts
  'requireSession',
  'requireSessionOrCron',
  'requireCronSecret',
  'requireHeartbeatSecret',
  'userHasPropertyAccess',
  // From src/lib/admin-auth.ts
  'requireAdmin',
  'requireAdminOrCron',
  // From src/lib/team-auth.ts
  'verifyTeamManager',
  'canManageHotel',
  'canManageTeam',
  // Manual Supabase session validation (used by /api/auth/* routes that
  // accept bearer tokens directly instead of going through requireSession).
  'supabaseAdmin.auth.getUser',
  // Webhook signature verification — each of these IS the route's auth.
  // External webhook helpers (Stripe, Twilio, ElevenLabs, GitHub, Sentry).
  'verifyWebhookSignature', // Stripe (in src/lib/stripe.ts)
  'verifyTwilioRequest',
  'requireTwilioSignature',
  'verifyStripeSignature',
  'verifyElevenLabsSignature',
  'validateRequest', // twilio.validateRequest()
  // Inline HMAC verification — github-webhook, sentry-webhook, magic-link
  // consume paths construct their own HMAC + timingSafeEqual. The pair of
  // these in a file is a strong signal that the route is doing signature
  // auth itself rather than skipping it.
  'createHmac',
  'timingSafeEqual',
  // Public-page capability tuple — implies validateUuid + staff lookup.
  'validateUuid',
  // Trust-device cookie path (auth/check-trust, auth/revoke-trust, etc.):
  // route reads + hashes the cookie value before any DB write.
  'hashDeviceToken',
  'readDeviceCookie',
  // Rate-limit infra — typically paired with token/code-based auth on the
  // /api/auth/* routes that consume single-use credentials.
  'checkAndIncrementRateLimit',
];

// Inline capability-check patterns. If a file contains any of these
// expressions in source, it's doing per-property capability verification
// inline (typically against fetched staff/room rows) — which is a real
// guard even though it doesn't use a named helper.
//
// The canonical example is /api/housekeeper/room-action which fetches the
// staff row and asserts `staff.property_id !== pid` before any mutation.
const INLINE_CAPABILITY_PATTERNS = [
  /\bstaff\??\.property_id\s*!==?\s*(?:body\.)?pid\b/,
  /\broom\??\.property_id\s*!==?\s*(?:body\.)?pid\b/,
  /\bassigned_to\s*!==?\s*(?:body\.)?staffId\b/,
];

const ADMIN_IMPORT_RX = /from\s+['"](@\/lib\/supabase-admin|\.\.?\/(?:[^'"]*\/)?supabase-admin)['"]/;
const SERVER_CLIENT_IMPORT_RX = /from\s+['"]@\/lib\/supabase-server['"]/;
const METHOD_EXPORT_RX = /\bexport\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/;
const ESCAPE_RX = /\/\/\s*@audit:\s*tenant-scope-not-applicable\b/;
const USE_CLIENT_RX = /^['"]use client['"];?\s*$/m;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const allFiles = walk(APP);
const routeFiles = allFiles.filter((p) => /\/route\.(ts|tsx|js|jsx)$/.test(p));
const pageFiles = allFiles.filter((p) => /\/(page|layout)\.(ts|tsx)$/.test(p));

const violations = [];
let scanned = 0;
let escapeCount = 0;

function checkFile(f, kind) {
  const rel = relative(REPO, f);
  const src = readFileSync(f, 'utf8');

  if (kind === 'page' && USE_CLIENT_RX.test(src)) return; // client components OK

  const usesAdmin = ADMIN_IMPORT_RX.test(src);
  const usesServer = SERVER_CLIENT_IMPORT_RX.test(src);
  if (!usesAdmin && !usesServer) return;

  if (kind === 'route') {
    if (!METHOD_EXPORT_RX.test(src)) return; // not a handler-exporting file
  } else if (kind === 'page') {
    // Server components that import supabaseAdmin are a red flag in their
    // own right — the audit confirmed today there are none. Fail-loud if
    // one appears, regardless of guard presence: server components should
    // go through createSupabaseServerClient (RLS-enforced) instead.
    if (usesAdmin) {
      violations.push({
        file: rel,
        reason: 'server component imports supabaseAdmin — must use createSupabaseServerClient (RLS-enforced) instead',
      });
      scanned++;
      return;
    }
  }

  scanned++;

  // Escape marker.
  const firstChunk = src.split('\n').slice(0, 30).join('\n');
  if (ESCAPE_RX.test(firstChunk)) {
    escapeCount++;
    return;
  }

  // Look for any known guard helper.
  const guardFound = KNOWN_GUARDS.some((g) => {
    // Guards containing dots (e.g., 'supabaseAdmin.auth.getUser') are not
    // word-boundary-safe with \b, so escape and match literally.
    const escaped = g.replace(/[.]/g, '\\.');
    const rx = new RegExp(g.includes('.') ? escaped : `\\b${g}\\b`);
    return rx.test(src);
  });

  // Also accept inline capability-check patterns (e.g.,
  // `staff.property_id !== pid`).
  const inlineCapFound = guardFound
    ? false
    : INLINE_CAPABILITY_PATTERNS.some((rx) => rx.test(src));

  if (!guardFound && !inlineCapFound) {
    violations.push({
      file: rel,
      reason: 'imports supabaseAdmin/supabase-server but references no known auth guard',
    });
  }
}

for (const f of routeFiles) checkFile(f, 'route');
for (const f of pageFiles) checkFile(f, 'page');

if (violations.length > 0) {
  console.error(
    `✗ audit-api-route-tenant-scope: ${violations.length} file(s) use service-role client without a recognized auth guard:`,
  );
  for (const v of violations) {
    console.error(`    ${v.file}`);
    console.error(`        ${v.reason}`);
  }
  console.error('');
  console.error('Every route that touches supabaseAdmin must explicitly verify the caller:');
  console.error('  - requireAdmin / requireAdminOrCron        (fleet-wide admin operations)');
  console.error('  - requireSession + userHasPropertyAccess   (per-property user routes)');
  console.error('  - requireCronSecret / requireHeartbeatSecret  (cron / internal pings)');
  console.error('  - validateUuid("pid", ...) + staff capability check  (public SMS-link routes)');
  console.error('  - verifyTwilioRequest / verifyStripeSignature  (signed webhooks)');
  console.error('');
  console.error('If the route genuinely doesn\'t need a tenant scope (rare — e.g., a public');
  console.error('endpoint that returns global config), add to the top of the file:');
  console.error('  // @audit: tenant-scope-not-applicable — <reason>');
  process.exit(1);
}

const escNote = escapeCount > 0 ? ` (${escapeCount} file(s) marked @audit: tenant-scope-not-applicable)` : '';
console.log(
  `✓ audit-api-route-tenant-scope: scanned ${scanned} route/server-component file(s) using supabaseAdmin/server-client; all guarded${escNote}.`,
);
