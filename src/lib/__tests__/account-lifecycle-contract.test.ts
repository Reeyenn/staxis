import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const statusRoute = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'auth', 'team', 'status', 'route.ts'),
  'utf8',
);
const lifecycleProcessor = readFileSync(
  join(process.cwd(), 'src', 'lib', 'account-lifecycle.ts'),
  'utf8',
);
const lifecycleCron = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'cron', 'sweep-account-lifecycle', 'route.ts'),
  'utf8',
);
const teamRoute = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'auth', 'team', 'route.ts'),
  'utf8',
);
const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0335_account_lifecycle_intents.sql'),
  'utf8',
);
const authoritativeLifecycleMigration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0395_authoritative_people_lifecycle.sql'),
  'utf8',
);

describe('account lifecycle rollout contract', () => {
  test('only promises automatic retry after a durable pending intent exists', () => {
    assert.match(
      statusRoute,
      /const message = pending[\s\S]*It will retry automatically\.[\s\S]*Account status is temporarily unavailable\. It is safe to try again\./,
    );
    assert.match(
      statusRoute,
      /return lifecycleUnavailable\(requestId, lifecycleOperationId, false\);/,
    );
    assert.match(statusRoute, /details: \{ operationId, pending \}/);
  });

  test('requires a caller operation UUID and has no direct active-write fallback', () => {
    assert.match(statusRoute, /validateUuid\(body\.operationId, ['"]operationId['"]\)/);
    assert.match(statusRoute, /staxis_register_account_lifecycle_intent/);
    assert.match(statusRoute, /processAccountLifecycleIntent/);
    assert.doesNotMatch(statusRoute, /\.update\(\{\s*active\s*:/);
  });

  test('bounds both processor callers to 60 seconds under a 600-second renewable lease', () => {
    assert.match(statusRoute, /export const maxDuration = 60/);
    assert.match(lifecycleCron, /export const maxDuration = 60/);
    assert.match(statusRoute, /processAccountLifecycleIntent/);
    assert.match(lifecycleCron, /processAccountLifecycleIntent/);
    assert.match(lifecycleProcessor, /const PROCESSOR_LEASE_SECONDS = 600/);
    assert.match(lifecycleProcessor, /p_lease_seconds: PROCESSOR_LEASE_SECONDS/);
    assert.doesNotMatch(lifecycleProcessor, /convergeSupersededIntent/);
  });

  test('keeps role mutation and lifecycle intent mutation behind guarded RPCs', () => {
    assert.match(teamRoute, /staxis_change_hotel_team_role_guarded/);
    assert.doesNotMatch(teamRoute, /updates\.role\s*=/);
    assert.match(
      migration,
      /revoke all on table public\.account_lifecycle_intents\s+from public, anon, authenticated, service_role;\s+grant select on table public\.account_lifecycle_intents to service_role;/i,
    );
    assert.doesNotMatch(
      migration,
      /grant\s+(?:insert|update|delete|all)[^;]*account_lifecycle_intents[^;]*service_role/i,
    );
  });

  test('installs identity uniqueness, pending mutation fences, leases, and atomic audit RPCs', () => {
    assert.match(migration, /accounts_data_user_id_unique_idx/);
    assert.match(migration, /account_lifecycle_intents_one_pending_idx/);
    assert.match(migration, /account_lifecycle_intents_one_processor_idx/);
    assert.match(migration, /_staxis_guard_pending_account_lifecycle_mutation/);
    assert.match(migration, /staxis_claim_account_lifecycle_intent/);
    assert.match(migration, /staxis_commit_account_lifecycle_intent/);
    assert.match(migration, /insert into public\.role_changes/i);
    assert.match(migration, /insert into public\.admin_audit_log/i);
  });

  test('captures and rechecks exact actor and target authority before lifecycle commit', () => {
    assert.match(authoritativeLifecycleMigration, /actor_authority_version_snapshot bigint/);
    assert.match(authoritativeLifecycleMigration, /target_authority_version_snapshot bigint/);
    assert.match(authoritativeLifecycleMigration, /target_authorized_property_ids_snapshot uuid\[\]/);
    assert.match(authoritativeLifecycleMigration, /_staxis_structural_account_property_ids/);
    assert.match(authoritativeLifecycleMigration, /invariant_conflict', 'reason', 'authorization_changed/);
    assert.match(authoritativeLifecycleMigration, /invariant_conflict', 'reason', 'target_scope_changed/);
    assert.match(authoritativeLifecycleMigration, /invariant_conflict', 'reason', 'actor_scope_changed/);
    assert.match(authoritativeLifecycleMigration, /invariant_conflict', 'reason', 'actor_hierarchy_changed/);
  });

  test('makes hotel detach actor-bound, commit-time authorized, and atomically audited', () => {
    assert.match(teamRoute, /staxis_remove_property_access_guarded_v2/);
    assert.match(teamRoute, /p_actor_account_id: caller\.accountId/);
    assert.match(teamRoute, /p_actor_auth_user_id: caller\.authUserId/);
    assert.match(teamRoute, /guardedResult\.audit_written !== true/);
    assert.match(authoritativeLifecycleMigration, /create or replace function public\.staxis_remove_property_access_guarded_v2/);
    assert.match(authoritativeLifecycleMigration, /_staxis_account_can_manage_users_at_property/);
    assert.match(authoritativeLifecycleMigration, /insert into public\.role_changes/);
    assert.match(authoritativeLifecycleMigration, /'audit_written', true/);
    assert.match(
      authoritativeLifecycleMigration,
      /revoke execute on function public\.staxis_remove_property_access_guarded\([\s\S]*from service_role/,
    );
  });
});
