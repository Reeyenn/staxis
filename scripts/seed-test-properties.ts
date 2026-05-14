#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Phase M1.4 (2026-05-14) — seed N representative test properties
 * via the live admin create endpoint.
 *
 * Why this exists:
 *   The admin console + cockpit need to be smoke-tested at fleet
 *   scale. Manually filling in the create-hotel modal 5-50 times to
 *   stress-test pagination/cron-stagger/RLS-perf is a waste of time.
 *   This script POSTs to /api/admin/properties/create with diverse
 *   archetypes (small/medium/large, different timezones, different
 *   PMS types) and marks them is_test=true so they're excluded from
 *   fleet aggregates.
 *
 * Usage:
 *   ./scripts/seed-test-properties.ts \
 *     --base https://staxis-preview.vercel.app \
 *     --token <admin-session-jwt> \
 *     [--count 5]
 *
 *   --cleanup: instead of creating, list every property where
 *   name LIKE 'Phase M1 Test %' and offer to delete via
 *   DELETE-by-id (TODO: needs a delete endpoint; for now just lists).
 *
 * The properties are tagged is_test=true which excludes them from:
 *   - Fleet ML rollups
 *   - Admin "Live hotels" main view (filtered by is_test)
 *   - Cost rollups
 *
 * NEVER run this against PROD with the real admin token unless you
 * intend to create test rows there. Default --base is the local dev
 * server.
 */

interface CreateResponse {
  ok?: boolean;
  data?: {
    propertyId: string;
    joinCode: string | null;
    signupUrl: string | null;
    expiresAt: string | null;
  };
  error?: string;
}

const ARCHETYPES: Array<{
  name: string;
  totalRooms: number;
  timezone: string;
  pmsType?: string;
  brand?: string;
  propertyKind: string;
}> = [
  // Small Eastern-time limited service
  { name: 'Phase M1 Test Hampton Inn', totalRooms: 80,  timezone: 'America/New_York',    pmsType: 'choice_advantage', brand: 'Hilton',    propertyKind: 'limited_service' },
  // Mid-size Central full service with PMS
  { name: 'Phase M1 Test Holiday Inn',  totalRooms: 150, timezone: 'America/Chicago',     pmsType: 'choice_advantage', brand: 'IHG',       propertyKind: 'full_service' },
  // Large Mountain extended-stay no PMS yet
  { name: 'Phase M1 Test Residence Inn', totalRooms: 250, timezone: 'America/Denver',      brand: 'Marriott',                              propertyKind: 'extended_stay' },
  // Small Pacific limited service no brand
  { name: 'Phase M1 Test Independent',   totalRooms: 45,  timezone: 'America/Los_Angeles', pmsType: 'manual_csv',                          propertyKind: 'limited_service' },
  // Resort UTC
  { name: 'Phase M1 Test Resort',        totalRooms: 400, timezone: 'UTC',                  brand: 'Independent',                          propertyKind: 'resort' },
];

function parseArgs(): { base: string; token: string; count: number; cleanup: boolean } {
  const args = process.argv.slice(2);
  let base = 'http://localhost:3000';
  let token = '';
  let count = ARCHETYPES.length;
  let cleanup = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base') base = args[++i] ?? base;
    else if (args[i] === '--token') token = args[++i] ?? '';
    else if (args[i] === '--count') count = Number(args[++i]) || ARCHETYPES.length;
    else if (args[i] === '--cleanup') cleanup = true;
  }
  return { base, token, count, cleanup };
}

async function createOne(
  base: string,
  token: string,
  archetype: typeof ARCHETYPES[number],
): Promise<CreateResponse> {
  const res = await fetch(`${base}/api/admin/properties/create`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ...archetype, isTest: true }),
  });
  return res.json() as Promise<CreateResponse>;
}

async function main() {
  const { base, token, count, cleanup } = parseArgs();

  if (cleanup) {
    console.log('Cleanup mode — listing test properties (deletion endpoint not yet built):');
    console.log(`  GET ${base}/api/admin/list-properties → filter by name LIKE "Phase M1 Test %"`);
    console.log('  Manually delete via Supabase dashboard or psql DELETE.');
    process.exit(0);
  }

  if (!token) {
    console.error('ERROR: --token <admin-session-jwt> is required.');
    console.error('Get the token from your browser dev tools → Application → Cookies → sb-access-token');
    process.exit(1);
  }

  console.log(`Seeding ${count} test properties against ${base} ...`);
  const results: Array<{ name: string; ok: boolean; propertyId?: string; joinCode?: string | null; error?: string }> = [];

  for (let i = 0; i < count && i < ARCHETYPES.length; i++) {
    const a = ARCHETYPES[i];
    process.stdout.write(`  [${i + 1}/${count}] ${a.name} ... `);
    try {
      const result = await createOne(base, token, a);
      if (result.ok && result.data) {
        console.log(`✓ ${result.data.propertyId} (code ${result.data.joinCode ?? 'NONE'})`);
        results.push({ name: a.name, ok: true, propertyId: result.data.propertyId, joinCode: result.data.joinCode });
      } else {
        console.log(`✗ ${result.error ?? 'unknown error'}`);
        results.push({ name: a.name, ok: false, error: result.error });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`✗ ${msg}`);
      results.push({ name: a.name, ok: false, error: msg });
    }
  }

  const successes = results.filter((r) => r.ok).length;
  console.log('');
  console.log(`Done: ${successes}/${results.length} properties created.`);
  if (successes < results.length) {
    console.log('Failed:');
    for (const r of results.filter((r) => !r.ok)) console.log(`  - ${r.name}: ${r.error}`);
  }
  console.log('');
  console.log('To use a property, sign up via its join code:');
  for (const r of results.filter((r) => r.ok && r.joinCode)) {
    console.log(`  ${r.name}: ${base}/signup?code=${encodeURIComponent(r.joinCode!)}`);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
