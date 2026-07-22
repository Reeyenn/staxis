import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const route = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'settings', 'users', 'route.ts'),
  'utf8',
);

describe('legacy settings user lifecycle handoff', () => {
  test('rejects inactive callers and routes lifecycle work to My Hotel', () => {
    assert.match(route, /select\(['"]id, role, property_access, active, lifecycle_intent_version['"]\)/);
    assert.match(route, /data\.active !== true/);
    assert.match(route, /MOVED_TO_MY_HOTEL_ACTIONS[\s\S]*change_role[\s\S]*deactivate[\s\S]*reactivate/);
    assert.match(route, /Manage roles and account status from My Hotel/);
    assert.doesNotMatch(route, /updateUserById/);
    assert.doesNotMatch(route, /\.update\(\{\s*active:/);
  });

  test('uses only the Auth-bound atomic ownership RPC with durable replay', () => {
    assert.match(route, /action !== ['"]transfer_ownership['"]/);
    assert.match(route, /validateUuid\(body\.operationId, ['"]operationId['"]\)/);
    assert.match(route, /staxis_transfer_ownership_guarded/);
    assert.doesNotMatch(route, /['"]staxis_transfer_ownership['"]/);
    assert.match(route, /p_operation_id: operationId/);
    assert.match(route, /p_actor_auth_user_id: caller\.authUserId/);
    assert.match(route, /p_expected_old_intent_version: caller\.lifecycleIntentVersion/);
    assert.match(route, /parsed\?\.status === ['"]ok['"] \|\| parsed\?\.status === ['"]already_applied['"]/);
    assert.doesNotMatch(route, /pendingLifecycleIntentCheck/);
    assert.doesNotMatch(route, /writeRoleChange|writeAudit/);
    assert.match(route, /isPendingLifecycleFenceError\(rpcErr\)[\s\S]*status: 409/);
    assert.match(route, /same hotel access/);
    assert.match(route, /Manage company ownership separately/);
  });
});
