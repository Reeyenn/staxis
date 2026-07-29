import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const retiredRoute = source('src', 'app', 'api', 'settings', 'users', 'route.ts');
const transferRoute = source(
  'src', 'app', 'api', 'company-access', 'legacy-ownership-transfer', 'route.ts',
);
const transferPut = transferRoute.slice(transferRoute.indexOf('export async function PUT'));
const replayCheckIndex = transferPut.indexOf("'staxis_check_ownership_transfer_replay'");
const putRosterIndex = transferPut.indexOf('loadAuthoritativeHotelRoster(propertyId');
const guardedMutationIndex = transferPut.indexOf("'staxis_transfer_ownership_guarded'");
const transferPutBeforeMutation = transferPut.slice(
  0,
  guardedMutationIndex,
);

describe('retired Settings user API', () => {
  test('all stale-client methods return one authenticated, non-mutating migration response', () => {
    assert.match(retiredRoute, /requireSession\(req, \{ requestId \}\)/);
    assert.match(retiredRoute, /status: 409/);
    assert.match(retiredRoute, /ApiErrorCode\.IdempotencyConflict/);
    assert.match(retiredRoute, /details: \{ href: DESTINATION \}/);
    assert.match(retiredRoute, /const DESTINATION = ['"]\/company\?tab=access['"]/);
    for (const method of ['GET', 'PUT', 'POST', 'PATCH', 'DELETE']) {
      assert.match(retiredRoute, new RegExp(`export const ${method} = moved`));
    }
    assert.doesNotMatch(retiredRoute, /staxis_transfer_ownership|supabaseAdmin|\.rpc\(/);
  });
});

describe('legacy ownership handoff in Company Access', () => {
  test('rejects inactive callers and routes every mutation through the Auth-bound atomic RPC', () => {
    assert.match(transferRoute, /select\(['"]id, role, property_access, active, lifecycle_intent_version['"]\)/);
    assert.match(transferRoute, /data\.active !== true/);
    assert.match(transferRoute, /requireSession\(req\)/);
    assert.match(transferRoute, /loadAuthoritativeHotelRoster\(pidV\.value!, caller\.role === ['"]admin['"]\)/);
    assert.match(transferRoute, /callerRoster\.managementSurface !== ['"]legacy_hotel['"][\s\S]*Manage normalized company ownership/);
    assert.match(transferRoute, /filter\(\(account\) => account\.managementSurface === ['"]legacy_hotel['"]\)/);
    assert.ok(replayCheckIndex > 0);
    assert.ok(putRosterIndex > replayCheckIndex);
    assert.ok(guardedMutationIndex > putRosterIndex);
    assert.doesNotMatch(transferPut.slice(0, putRosterIndex), /\.from\(['"]accounts['"]\)/);
    assert.match(transferPutBeforeMutation, /replay\?\.status === ['"]already_applied['"]/);
    assert.match(transferPutBeforeMutation, /replay\?\.status !== ['"]not_applied['"]/);
    assert.match(transferPutBeforeMutation, /callerRoster\.managementSurface !== ['"]legacy_hotel['"]/);
    assert.match(transferPutBeforeMutation, /targetRoster\.managementSurface !== ['"]legacy_hotel['"]/);
    assert.match(transferPutBeforeMutation, /capabilityDecisionForProperty[\s\S]*['"]manage_users['"]/);
    assert.match(transferRoute, /capabilityDecisionForProperty/);
    assert.match(transferRoute, /staxis_check_ownership_transfer_replay/);
    assert.match(transferRoute, /staxis_transfer_ownership_guarded/);
    assert.doesNotMatch(transferRoute, /['"]staxis_transfer_ownership['"]/);
    assert.doesNotMatch(transferRoute, /updateUserById|\.update\(\{\s*role:/);
    assert.doesNotMatch(transferRoute, /auth\.admin\.listUsers|lastSignInAt|emailByUserId/);
  });

  test('binds durable replay to both accounts, caller Auth identity, fresh snapshots, and pending-work fences', () => {
    assert.match(transferRoute, /validateUuid\(body\.operationId, ['"]operationId['"]\)/);
    assert.match(transferRoute, /p_old_owner_account_id: caller\.accountId/);
    assert.match(transferRoute, /p_operation_id: operationId/);
    assert.match(transferRoute, /p_actor_auth_user_id: caller\.authUserId/);
    assert.match(transferRoute, /p_expected_old_intent_version: caller\.lifecycleIntentVersion/);
    assert.match(transferRoute, /p_expected_new_intent_version: newOwner\.lifecycle_intent_version/);
    assert.match(transferRoute, /parsed\?\.status === ['"]ok['"] \|\| parsed\?\.status === ['"]already_applied['"]/);
    assert.match(transferRoute, /isPendingLifecycleFenceError\(rpcErr\)[\s\S]*status: 409/);
    assert.match(transferRoute, /same hotel access/);
    assert.match(transferRoute, /Only the current owner can transfer ownership/);
  });
});
