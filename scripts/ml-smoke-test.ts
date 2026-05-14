/**
 * scripts/ml-smoke-test.ts — Phase 4 nightly ML smoke
 *
 * Verifies the end-to-end ML stack is shipping data with the expected
 * response shape (Phase 1+2+3 invariants). Does NOT mutate any state —
 * read-only against live endpoints with a designated smoke-test
 * property. Complements the post-deploy doctor smoke (which validates
 * env vars + auth) by catching schema-shape regressions that doctor
 * wouldn't notice.
 *
 * Asserts:
 *   1. Doctor returns ok=true (or only warns — degraded heartbeat is acceptable)
 *   2. Cockpit auto-fill endpoint includes the Phase 1 band fields
 *      (predictedCurrentStockLow / predictedCurrentStockHigh)
 *   3. No property_misconfigured events in the last 24h that haven't
 *      been acknowledged (Phase 3.3 + 3.5 surface check)
 *
 * Skips silently when SMOKE_PROPERTY_ID is not set (smoke isn't a unit
 * test — needs a running prod URL + a real property to read from).
 *
 * Env:
 *   SMOKE_BASE_URL          (default https://getstaxis.com)
 *   SMOKE_PROPERTY_ID       — required; UUID of a property to read from
 *   CRON_SECRET             — Bearer token for /api/admin/doctor
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — for app_events read
 */

import { createClient } from '@supabase/supabase-js';

interface SmokeFailure {
  name: string;
  detail: string;
}

const failures: SmokeFailure[] = [];

function fail(name: string, detail: string): void {
  failures.push({ name, detail });
}

async function checkDoctor(baseUrl: string, cronSecret: string): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/api/admin/doctor`, {
      headers: { Authorization: `Bearer ${cronSecret}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status !== 200 && res.status !== 503) {
      fail('doctor', `HTTP ${res.status}`);
      return;
    }
    const json = (await res.json()) as {
      ok: boolean;
      checks: Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail?: string }>;
    };
    const hardFails = json.checks.filter(c => c.status === 'fail');
    if (hardFails.length > 0) {
      fail(
        'doctor',
        `${hardFails.length} hard-fail check(s): ${hardFails.map(c => `${c.name}: ${c.detail}`).join(' | ')}`,
      );
    }
  } catch (err) {
    fail('doctor', `request threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Codex follow-up 2026-05-13 (#4): the previous version of this script
// called /api/inventory/auto-fill-map, a route that does not exist in
// the codebase (the helper is imported directly by the inventory page).
// The shape check is now performed server-side by the doctor's
// `inventory_auto_fill_shape` check — which has admin auth + the
// helper imported — and surfaces here transitively via checkDoctor().
// Keeping a placeholder so future re-introduction is straightforward.

async function checkPropertyMisconfiguredEvents(propertyId: string): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.log('ℹ️  SUPABASE creds not in env; property_misconfigured event check skipped.');
    return;
  }
  const supabase = createClient(supabaseUrl, supabaseKey);
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('app_events')
    .select('id, event_type, metadata, ts')
    .eq('event_type', 'property_misconfigured')
    .eq('property_id', propertyId)
    .gte('ts', cutoff)
    .limit(10);
  if (error) {
    fail('property_misconfigured_events', `supabase read failed: ${error.message}`);
    return;
  }
  if ((data?.length ?? 0) > 0) {
    fail(
      'property_misconfigured_events',
      `property has ${data?.length} property_misconfigured events in last 24h — onboarding fields likely missing. First: ${JSON.stringify(data?.[0])}`,
    );
  }
}

/**
 * Phase M1.5 (2026-05-14) — confirm the admin property-create endpoint
 * is reachable AND properly rejects unauthenticated requests. We do NOT
 * actually create a property here (would require an admin session JWT
 * that the smoke runner doesn't have) — but we DO verify:
 *   - The route exists (returns 401/403, not 404)
 *   - The route enforces auth (401/403, not 200)
 *
 * If a deploy accidentally removes the route OR loosens its auth gate,
 * the next nightly smoke fails loudly. Real end-to-end create+delete
 * needs a delete endpoint (not built yet) — defer to M2 or later.
 */
async function checkAdminPropertyCreateEndpoint(baseUrl: string): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/api/admin/properties/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'smoke-probe', totalRooms: 1, timezone: 'UTC' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      fail('admin_property_create_endpoint', `route returned 404 — was it removed or renamed?`);
      return;
    }
    if (res.status === 200 || res.status === 201) {
      fail(
        'admin_property_create_endpoint',
        `route returned ${res.status} for an unauthenticated request — auth gate is broken!`,
      );
      return;
    }
    if (res.status !== 401 && res.status !== 403) {
      // Acceptable failure modes: 401 (no session) or 403 (session but
      // not admin). Anything else is a regression worth investigating.
      fail(
        'admin_property_create_endpoint',
        `unexpected status ${res.status} for an unauthenticated request (expected 401 or 403)`,
      );
    }
  } catch (e) {
    fail(
      'admin_property_create_endpoint',
      `request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function main(): Promise<void> {
  const baseUrl = process.env.SMOKE_BASE_URL ?? 'https://getstaxis.com';
  const propertyId = process.env.SMOKE_PROPERTY_ID;
  const cronSecret = process.env.CRON_SECRET;

  if (!propertyId) {
    console.log('SMOKE_PROPERTY_ID not set — skipping (smoke is a smoke test, not a unit test).');
    process.exit(0);
  }
  if (!cronSecret) {
    console.log('CRON_SECRET not set — skipping.');
    process.exit(0);
  }

  console.log(`── ML smoke against ${baseUrl} (property ${propertyId}) ──`);

  await checkDoctor(baseUrl, cronSecret);
  // checkAutoFillShape removed (Codex #4 follow-up): moved server-side
  // into doctor's inventory_auto_fill_shape check — already validated
  // by checkDoctor above.
  await checkPropertyMisconfiguredEvents(propertyId);
  await checkAdminPropertyCreateEndpoint(baseUrl);

  if (failures.length > 0) {
    console.error('\n── FAILED ──');
    for (const f of failures) {
      console.error(`✗ ${f.name}: ${f.detail}`);
    }
    process.exit(1);
  }

  console.log('✓ All smoke checks passed.');
  process.exit(0);
}

main().catch(err => {
  console.error('smoke test crashed:', err);
  process.exit(2);
});
