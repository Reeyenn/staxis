import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const route = source('src/app/api/auth/team/route.ts');
const panel = source('src/app/company/_components/HotelTeamPanel.tsx');
const migration = source('supabase/migrations/0329_guard_hotel_team_detach_snapshot.sql');

describe('hotel team mutation concurrency guards', () => {
  test('profile writes compare the account version and return a conflict when stale', () => {
    assert.match(route, /\.eq\('updated_at', target\.updated_at\)/);
    assert.match(route, /This account changed while you were editing it/);
  });

  test('hotel removal locks and compares the target snapshot in PostgreSQL', () => {
    assert.match(route, /staxis_remove_property_access_guarded/);
    assert.match(route, /p_expected_role: target\.role/);
    assert.match(route, /p_expected_updated_at: target\.updated_at/);
    assert.match(migration, /for update;/i);
    assert.match(migration, /v_role is distinct from p_expected_role/i);
    assert.match(migration, /v_updated_at is distinct from p_expected_updated_at/i);
    assert.match(migration, /return jsonb_build_object\('status', 'conflict'\)/i);
    assert.match(migration, /return jsonb_build_object\('status', 'not_attached'\)/i);
    assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated/i);
    assert.match(migration, /grant execute on function[\s\S]*to service_role/i);
  });

  test('another person cannot receive a direct manager-set password', () => {
    assert.match(route, /if \(password && !isSelf\)/);
    assert.match(route, /reset their own password from Forgot password/);
    assert.match(panel, /const passwordFloor = canEdit && self/);
  });
});
