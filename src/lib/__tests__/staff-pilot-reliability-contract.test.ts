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

  test('fill delegates the complete multi-day replacement to one database transaction', () => {
    const route = source('src/app/api/staff-schedule/fill/route.ts');
    const migration = source('supabase/migrations/0412_staff_schedule_authority_and_history.sql');
    assert.equal(
      (route.match(/rpc\('staxis_replace_staff_schedule_days'/g) ?? []).length,
      1,
    );
    assert.doesNotMatch(route, /\.from\('scheduled_shifts'\)|\.from\('time_off_requests'\)|\.from\('week_publications'\)/);
    const rpc = migration.slice(migration.indexOf('create or replace function public.staxis_replace_staff_schedule_days'));
    assert.match(rpc, /v_has_approved_leave/);
    assert.match(rpc, /inactive_staff\.is_active is false/);
    assert.match(rpc, /insert into public\.week_publications/);
    assert.match(rpc, /grant execute[\s\S]*to service_role/);
  });

  test('join approval delegates the whole decision to the authoritative transaction', () => {
    const route = source('src/app/api/staff/join-requests/route.ts');
    const migration = source('supabase/migrations/0393_transactional_invite_and_join_acceptance.sql');
    assert.match(route, /callerCapabilityDecisionFresh\(caller, 'manage_team', hotelId\)/);
    assert.match(route, /staxis_decide_staff_join_request/);
    assert.doesNotMatch(route, /from\('staff'\)\.insert|property_access: nextAccess/);
    assert.match(migration, /create or replace function public\.staxis_decide_staff_join_request/);
    assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(p_property_id::text, 0\)\)/);
    assert.match(migration, /_staxis_manage_team_context\(p_actor_account_id, p_property_id\)/);
    assert.match(migration, /insert into public\.account_property_staff_links/);
    assert.match(migration, /insert into public\.organization_memberships/);
    assert.match(migration, /update public\.join_requests[\s\S]*status = 'approved'/);
  });

  test('public staff roster stays retired and emits no staff data', () => {
    const route = source('src/app/api/staff-list/route.ts');
    assert.match(route, /status: 410/);
    assert.doesNotMatch(route, /supabaseAdmin|\.from\(['"]staff['"]\)/);
  });

  test('private roster refreshes without requesting restricted Realtime columns', () => {
    const staffDb = source('src/lib/db/staff.ts');
    const commonDb = source('src/lib/db/_common.ts');
    assert.match(staffDb, /STAFF_READ_RETRY_DELAYS_MS = \[200, 500, 1_000\]/);
    assert.match(staffDb, /isTransientStaffReadError[\s\S]*42501[\s\S]*pgrst301/);
    assert.match(staffDb, /readStaffRosterWithRetry\(pid, from, to\)/);
    assert.match(staffDb, /subscribeByPolling<StaffMember>[\s\S]*pollIntervalMs: STAFF_ROSTER_POLL_INTERVAL_MS/);
    assert.match(staffDb, /isEqual: \(previous, next\) => JSON\.stringify\(previous\) === JSON\.stringify\(next\)/);
    assert.match(commonDb, /export function subscribeByPolling<T>/);
    assert.match(commonDb, /requestChain\.then\(runOnce\)/);
    assert.match(commonDb, /return \{ refresh, unsubscribe \}/);
    assert.match(commonDb, /if \(!hasPublished\) onFetchError\?\.\(error\)/);
    assert.match(commonDb, /navigator\.onLine !== false/);
    assert.match(commonDb, /setInterval\(onPoll, pollIntervalMs\)/);
    assert.match(commonDb, /addEventListener\('visibilitychange', onVisibility\)/);
    assert.match(commonDb, /addEventListener\('online', onOnline\)/);
    assert.match(commonDb, /clearInterval\(pollTimer\)/);
    const propertyContext = source('src/contexts/PropertyContext.tsx');
    assert.match(propertyContext, /staffSubscriptionRef\.current = \{[\s\S]*refresh: staffSubscription\.refresh/);
    assert.match(propertyContext, /subscription\?\.viewerKey === refreshViewerKey[\s\S]*await subscription\.refresh\(\)/);
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
