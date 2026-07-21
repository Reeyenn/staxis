import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

function routeFilesBelow(path: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(process.cwd(), path))) {
    const rel = join(path, entry);
    const absolute = join(process.cwd(), rel);
    if (statSync(absolute).isDirectory()) routeFilesBelow(rel, out);
    else if (entry === 'route.ts') out.push(rel);
  }
  return out;
}

describe('staff pilot reliability contracts', () => {
  test('manager schedule blocks the mutation surface until a snapshot loads', () => {
    const ui = source('src/app/staff/_components/schedule/index.tsx');
    const guard = ui.indexOf('if (data.loading || data.loadError)');
    const view = ui.indexOf('<ScheduleView');
    assert.ok(guard >= 0 && view > guard, 'load/error guard must precede ScheduleView');
    assert.match(ui, /className="staff-schedule-toolbar"/);
    assert.match(ui, /@media \(max-width: 640px\)[\s\S]*\.staff-schedule-toolbar[\s\S]*flex-wrap: wrap/);
  });

  test('fill fails closed on time-off lookup and deletes stale rows last', () => {
    const route = source('src/app/api/staff-schedule/fill/route.ts');
    assert.match(route, /error: torErr/);
    assert.match(route, /if \(torErr\)[\s\S]*Failed to verify approved time off/);
    const insert = route.indexOf("from('scheduled_shifts').insert(toInsert)");
    const deletion = route.indexOf("from('scheduled_shifts').delete()", insert);
    assert.ok(insert >= 0 && deletion > insert, 'destructive delete must follow insert/update work');
  });

  test('join approval verifies the conditional account link affected a row', () => {
    const route = source('src/app/api/staff/join-requests/route.ts');
    assert.match(route, /\.is\('staff_id', null\)[\s\S]*\.select\('id'\)[\s\S]*\.maybeSingle\(\)/);
    assert.match(route, /if \(linkErr \|\| !linkedAccount\)/);
    assert.match(route, /account link lost concurrency race/);
  });

  test('public staff roster stays retired and emits no staff data', () => {
    const route = source('src/app/api/staff-list/route.ts');
    assert.match(route, /status: 410/);
    assert.doesNotMatch(route, /supabaseAdmin|\.from\(['"]staff['"]\)/);
  });

  test('every public housekeeper/laundry action carries the bearer-token gate', () => {
    const runner = source('src/lib/housekeeper-workflow/room-action-runner.ts');
    const gate = source('src/lib/housekeeper-workflow/auth.ts');
    assert.match(runner, /gateHousekeeperRequest<TBody>\(req, endpoint\)/);
    assert.match(gate, /verifyStaffLinkToken\(req, \{ pid, staffId, requestId, bodyToken \}\)/);
    const routes = [
      ...routeFilesBelow('src/app/api/housekeeper'),
      ...routeFilesBelow('src/app/api/laundry'),
      'src/app/api/housekeeping/notices/route.ts',
      'src/app/api/housekeeping/notice-dismiss/route.ts',
      'src/app/api/save-fcm-token/route.ts',
    ];
    const capabilityOnly = new Set([
      // The single-use magic code is itself the credential; telemetry touches
      // no tenant data and is rate-limited.
      'src/app/api/housekeeper/exchange-code/route.ts',
      'src/app/api/housekeeper/log-legacy-token/route.ts',
    ]);
    for (const file of routes) {
      if (capabilityOnly.has(file)) continue;
      const route = source(file);
      assert.match(
        route,
        /verifyStaffLinkToken|gateHousekeeperRequest|runHousekeeperRoomAction/,
        `${file} must verify the per-staff bearer token`,
      );
    }
  });

  test('migration 0330 keeps roster reads scoped and mutations behind manage_team + MFA', () => {
    const migration = source('supabase/migrations/0330_staff_management_write_gate.sql');
    assert.match(migration, /drop policy if exists "owner rw staff"/);
    assert.match(migration, /create policy staff_property_roster_select[\s\S]*user_owns_property\(property_id\)[\s\S]*mfa_verified_or_grace\(\)/);
    for (const policy of ['staff_manage_insert', 'staff_manage_update', 'staff_manage_delete']) {
      assert.match(migration, new RegExp(`create policy ${policy}[\\s\\S]*staxis_user_can_manage_staff\\(property_id\\)[\\s\\S]*mfa_verified_or_grace\\(\\)`));
    }
    assert.match(migration, /capability = 'manage_team'[\s\S]*allowed = false/);
  });
});
