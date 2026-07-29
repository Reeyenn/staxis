import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const repo = join(__dirname, '..', '..', '..');
const migration = readFileSync(
  join(repo, 'supabase', 'migrations', '0389_portfolio_query_admission.sql'),
  'utf8',
);
const route = readFileSync(
  join(repo, 'src', 'app', 'api', 'agent', 'portfolio', 'route.ts'),
  'utf8',
);

test('portfolio admission is exact account+organization state and service-role only', () => {
  assert.match(migration, /primary key \(account_id, organization_id\)/i);
  assert.match(migration, /references public\.accounts\(id\)/i);
  assert.match(migration, /references public\.organizations\(id\)/i);
  assert.match(migration, /enable row level security/i);
  assert.match(
    migration,
    /revoke all on public\.portfolio_query_admissions from public, anon, authenticated, service_role/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.staxis_acquire_portfolio_query_lease[\s\S]*to service_role/i,
  );
  assert.doesNotMatch(migration, /\bapi_limits\b/i);
});

test('admission atomically counts attempts, locks the pair, and releases only the exact token', () => {
  const acquire = migration.slice(
    migration.indexOf('create or replace function public.staxis_acquire_portfolio_query_lease'),
    migration.indexOf('create or replace function public.staxis_release_portfolio_query_lease'),
  );
  assert.match(acquire, /for update/i);
  assert.match(acquire, /minute_count = v_minute_count/i);
  assert.match(acquire, /hour_count = v_hour_count/i);
  assert.ok(acquire.indexOf('minute_count = v_minute_count') < acquire.indexOf("'status', 'busy'"));
  assert.match(acquire, /lease_expires_at > v_now/i);
  assert.match(acquire, /least\(greatest\(p_lease_seconds, 65\), 120\)/i);

  const release = migration.slice(
    migration.indexOf('create or replace function public.staxis_release_portfolio_query_lease'),
  );
  assert.match(release, /v_row\.lease_token <> p_lease_token/i);
  assert.match(release, /'status', 'lease_lost'/i);
});

test('the POST route admits before metadata and releases before its last egress authorization check', () => {
  const acquire = route.indexOf('dependencies.acquireAdmission');
  const metadata = route.indexOf('dependencies.loadAuthorizedMetadata', acquire);
  const fanout = route.indexOf('runPortfolioIntelligence', metadata);
  assert.ok(acquire > 0 && acquire < metadata && metadata < fanout);

  const finalRelease = route.indexOf(
    'await releaseAdmissionOnce()',
    route.indexOf('// Reconciliation and lease release'),
  );
  const finalAuthorization = route.indexOf('if (!await exactReceiptStillCurrent(receipt))', finalRelease);
  const response = route.indexOf('return sseResponse([', finalAuthorization);
  assert.ok(finalRelease > 0 && finalRelease < finalAuthorization && finalAuthorization < response);
});
