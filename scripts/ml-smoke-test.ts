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

async function checkAutoFillShape(baseUrl: string, propertyId: string, cronSecret: string): Promise<void> {
  // This endpoint is owner-only — using CRON_SECRET via the admin
  // bypass header is the simplest way to authenticate from a script.
  // If your prod doesn't have that bypass, mark this check as skipped
  // by returning the route as 401 + falling through with a warn.
  try {
    const res = await fetch(
      `${baseUrl}/api/inventory/auto-fill-map?propertyId=${propertyId}`,
      {
        headers: { Authorization: `Bearer ${cronSecret}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (res.status === 401 || res.status === 403) {
      // No admin bypass — can't shape-check from here. Don't fail.
      console.log('ℹ️  auto-fill endpoint requires session auth; shape check skipped.');
      return;
    }
    if (res.status !== 200) {
      fail('auto-fill-map', `HTTP ${res.status}`);
      return;
    }
    const json = (await res.json()) as {
      items?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(json.items)) {
      fail('auto-fill-map', 'response missing items[]');
      return;
    }
    if (json.items.length === 0) {
      console.log('ℹ️  No items in auto-fill response; shape check skipped (property has no graduated models).');
      return;
    }
    // Pick the first graduated item to verify Phase 1 band fields.
    const graduated = json.items.find(i => i.graduated === true);
    if (!graduated) {
      console.log('ℹ️  No graduated items; band-field check skipped.');
      return;
    }
    const required = ['predictedCurrentStock', 'predictedCurrentStockLow', 'predictedCurrentStockHigh'];
    const missing = required.filter(k => !(k in graduated));
    if (missing.length > 0) {
      fail('auto-fill-map', `graduated item missing fields: ${missing.join(', ')}`);
    }
  } catch (err) {
    fail('auto-fill-map', `request threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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
  await checkAutoFillShape(baseUrl, propertyId, cronSecret);
  await checkPropertyMisconfiguredEvents(propertyId);

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
