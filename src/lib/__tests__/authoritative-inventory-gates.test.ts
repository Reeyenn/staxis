import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('inventory HTTP gates use the authoritative per-hotel standing', () => {
  test('hardened count and invoice storage policies retain the MFA boundary', () => {
    const migration = source(
      'supabase/migrations/0396_authoritative_browser_mutation_boundary.sql',
    );
    const policies = [
      ['owner read counts', 1],
      ['authorized write counts', 1],
      ['authorized update counts', 2],
      ['authorized delete counts', 1],
      ['owner read invoices', 1],
      ['authorized write invoices', 1],
      ['authorized update invoices', 2],
      ['authorized delete invoices', 1],
    ] as const;
    for (const [name, expectedMfaChecks] of policies) {
      const start = migration.indexOf(`create policy "${name}"`);
      assert.ok(start >= 0, `missing storage policy ${name}`);
      const end = migration.indexOf(';', start);
      assert.ok(end > start, `unterminated storage policy ${name}`);
      const definition = migration.slice(start, end + 1);
      assert.equal(
        definition.match(/public\.mfa_verified_or_grace\(\)/g)?.length ?? 0,
        expectedMfaChecks,
        `${name} must enforce MFA in every applicable predicate`,
      );
    }
  });

  test('ordering never authorizes from the legacy role/property snapshot', () => {
    const gate = source('src/lib/ordering/api-gate.ts');
    assert.match(gate, /listAuthoritativePropertyAccess\(account\.id as string\)/);
    assert.match(gate, /authoritativeStandingForProperty\(authority, pid\)/);
    assert.match(gate, /const role = standing\.operationalRole/);
    assert.match(gate, /!isReadOnlyRequest\(req\) && !standing\.hotelMutationAllowed/);
    assert.ok(
      gate.indexOf('authoritativeStandingForProperty(authority, pid)')
        < gate.indexOf('capabilityDecisionForProperty('),
      'property reach must be proven before reading property-specific capability state',
    );
    assert.doesNotMatch(gate, /account\.property_access|\.select\([^\n]*property_access/);
  });

  test('inventory history uses exact reach and the explicit finance-read bit', () => {
    const route = source('src/app/api/inventory/history/route.ts');
    assert.match(route, /listAuthoritativePropertyAccess\(account\.id as string\)/);
    assert.match(route, /authoritativeStandingForProperty\(authority, propertyId\)/);
    assert.match(route, /const role = standing\.operationalRole/);
    assert.match(route, /!standing\.seesFinancials/);
    assert.doesNotMatch(route, /account\.property_access|\.select\([^\n]*property_access/);
  });

  test('both gates fail closed and retryably when central authority is unavailable', () => {
    for (const path of [
      'src/lib/ordering/api-gate.ts',
      'src/app/api/inventory/history/route.ts',
    ]) {
      const gate = source(path);
      assert.match(gate, /authorization_unavailable/);
      assert.match(gate, /status: 503/);
      assert.match(gate, /Retry-After/);
    }
  });

  test('service-role staff/settings/event gates do not authorize from property_access', () => {
    const routes = [
      'src/app/api/staff/operational/route.ts',
      'src/app/api/staff/wages/route.ts',
      'src/app/api/settings/wages/route.ts',
      'src/app/api/settings/notifications/route.ts',
      'src/app/api/settings/clean-times/route.ts',
      'src/app/api/memory/recap/route.ts',
      'src/app/api/events/route.ts',
      'src/app/api/feedback/route.ts',
      'src/app/api/staff-schedule/presets/route.ts',
      'src/app/api/staff-schedule/pickup/route.ts',
      'src/app/api/staff-schedule/time-off/route.ts',
    ];
    for (const path of routes) {
      const route = source(path);
      assert.doesNotMatch(route, /\.select\([^\n]*property_access/,
        `${path} must not read the rollback property_access array as authority`);
      assert.match(
        route,
        /loadSessionAccount|accountCapabilityDecisionForProperty|verifyTeamManager|userHasPropertyAccess/,
        `${path} must delegate to a current central authority resolver`,
      );
    }
  });

  test('the Admin Notifications toggle is enforced by its backing read and write route', () => {
    const route = source('src/app/api/settings/notifications/route.ts');
    assert.match(route, /capabilityDecisionForProperty\(\{ role \}, 'manage_notifications', propertyId\)/);
    assert.match(route, /capabilityDecision === 'unavailable'[\s\S]{0,100}?capabilityUnavailableResponse/);
    assert.equal(
      route.match(/notificationCapabilityDecision\(account, pidV\.value!\)/g)?.length,
      2,
      'both GET and PUT must consume the capability displayed by Admin',
    );
  });

  test('hotel writes are fenced from read-only company standings', () => {
    const mutationRoutes = [
      'src/app/api/staff/wages/route.ts',
      'src/app/api/settings/wages/route.ts',
      'src/app/api/settings/clean-times/route.ts',
      'src/app/api/memory/recap/route.ts',
      'src/app/api/staff-schedule/presets/route.ts',
      'src/app/api/staff-schedule/pickup/route.ts',
      'src/app/api/staff-schedule/time-off/route.ts',
    ];
    for (const path of mutationRoutes) {
      const route = source(path);
      assert.match(
        route,
        /hotelMutationAllowed|callerCanMutateHotel|teamCallerCanMutateHotel/,
        `${path} must enforce the normalized mutation bit`,
      );
    }
  });

  test('housekeeping setup and board-photo use exact normalized manager authority', () => {
    const setup = source('src/app/api/housekeeping/setup/route.ts');
    const photo = source('src/app/api/housekeeping/setup/board-photo/route.ts');

    assert.match(setup, /userHasPropertyAccess\(ctx\.userId, propertyId\)/);
    for (const route of [setup, photo]) {
      assert.match(route, /accountCapabilityDecisionForProperty\([\s\S]*?'manage_clean_times'[\s\S]*?\{ requireMutation: true, requireManager: true \}/);
      assert.match(route, /=== 'unavailable'[\s\S]*?capabilityUnavailableResponse/);
      assert.doesNotMatch(route, /\.select\([^\n]*property_access/);
    }

    const decision = photo.indexOf('await accountCapabilityDecisionForProperty(');
    const commitDecision = photo.lastIndexOf('await accountCapabilityDecisionForProperty(');
    for (const sideEffect of [
      "checkAndIncrementRateLimit('housekeeping-setup-board-photo'",
      '.upload(path, bytes',
      'assertAudioBudget(',
      'visionExtractJSON<BoardExtraction>',
    ]) {
      assert.ok(photo.indexOf(sideEffect) > decision, `${sideEffect} must follow authority`);
    }
    assert.ok(
      commitDecision < photo.indexOf("checkAndIncrementRateLimit('housekeeping-setup-board-photo'"),
      'board upload must reauthorize after parsing and before side effects',
    );
    assert.ok(
      setup.lastIndexOf('await accountCapabilityDecisionForProperty(')
        < setup.indexOf(".update({ housekeeping_setup: setup })"),
      'setup save must reauthorize at the commit boundary',
    );
  });
});
