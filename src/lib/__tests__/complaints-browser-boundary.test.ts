import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { isComplaintDashboardSummary } from '@/lib/complaints-summary';

const source = (relativePath: string) => readFileSync(
  path.join(process.cwd(), relativePath),
  'utf8',
);

describe('Complaint browser privacy boundary', () => {
  test('accepts only the count-only dashboard contract', () => {
    assert.equal(isComplaintDashboardSummary({ visible: false }), true);
    assert.equal(isComplaintDashboardSummary({
      visible: true,
      open: 3,
      overdue: 1,
      callbacksDue: 2,
    }), true);
    assert.equal(isComplaintDashboardSummary({
      visible: true,
      open: 3,
      overdue: 1,
      callbacksDue: 2,
      guestName: 'must not be part of this contract',
    }), false);
    assert.equal(isComplaintDashboardSummary({ visible: true, open: -1, overdue: 0, callbacksDue: 0 }), false);
  });

  test('browser polling never selects or subscribes to raw complaint rows', () => {
    const client = source('src/lib/db/complaints.ts');
    assert.doesNotMatch(client, /\.from\(['"]complaints['"]\)/);
    assert.doesNotMatch(client, /subscribeTable|postgres_changes|select\(['"]\*['"]\)/);
    assert.match(client, /\/api\/complaints\/summary/);
  });

  test('summary route requires authoritative reach, intended role, and capability', () => {
    const route = source('src/app/api/complaints/summary/route.ts');
    assert.match(route, /requireSession/);
    assert.match(route, /loadSessionAccount/);
    assert.match(route, /callerReachesHotel/);
    assert.doesNotMatch(route, /callerCanMutateHotel/);
    assert.match(route, /callerRoleAtHotel/);
    assert.match(route, /worklistSeesAllSources/);
    assert.match(route, /capabilityDecisionForProperty[\s\S]*?'use_complaints'/);
    assert.match(route, /loadComplaintDashboardSummary/);
  });

  test('server projection counts IDs only and never selects guest PII', () => {
    const server = source('src/lib/complaints-summary-server.ts');
    assert.match(server, /select\('id', \{ count: 'exact', head: true \}\)/);
    for (const piiColumn of [
      'guest_name', 'guest_contact', 'description', 'room_number',
      'resolution_notes', 'callback_notes',
    ]) {
      assert.doesNotMatch(server, new RegExp(`select\\([^)]*${piiColumn}`), piiColumn);
    }
  });

  test('migration denies PostgREST reads and removes complaint realtime', () => {
    const migration = source('supabase/migrations/0414_complaints_server_read_boundary.sql');
    assert.match(migration, /drop policy if exists "owner read complaints"/);
    assert.match(migration, /for select to anon, authenticated[\s\S]*?using \(false\)/);
    assert.match(migration, /revoke select on public\.complaints from public, anon, authenticated/);
    assert.match(migration, /alter publication supabase_realtime drop table public\.complaints/);
  });
});
