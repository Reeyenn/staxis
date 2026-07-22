import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { processAccountLifecycleIntent } from '@/lib/account-lifecycle';
import { supabaseAdmin } from '@/lib/supabase-admin';

const OPERATION_ID = '11111111-2222-4333-8444-555555555555';
const ACCOUNT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const AUTH_USER_ID = '99999999-8888-4777-8666-555555555555';

type RpcFn = typeof supabaseAdmin.rpc;
type GetUserByIdFn = typeof supabaseAdmin.auth.admin.getUserById;
type UpdateUserFn = typeof supabaseAdmin.auth.admin.updateUserById;

const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUserById: GetUserByIdFn = supabaseAdmin.auth.admin.getUserById.bind(
  supabaseAdmin.auth.admin,
);
const originalUpdateUser: UpdateUserFn = supabaseAdmin.auth.admin.updateUserById.bind(
  supabaseAdmin.auth.admin,
);

interface UpdateBehavior {
  apply: boolean;
  error?: { message: string };
  throws?: boolean;
  adjustAppliedBanMs?: number;
}

interface LifecycleState {
  status: 'pending' | 'committed' | 'aborted';
  desiredActive: boolean;
  priorActive: boolean;
  accountActive: boolean;
  committedVersion: number;
  authBannedUntil: string | null;
  authSnapshotRecordedAt: string | null;
  authBannedUntilSnapshot: string | null;
  processorToken: string | null;
  authReadFailures: number;
  authReads: number;
  authUpdates: string[];
  updateBehaviors: UpdateBehavior[];
  rpcCalls: string[];
  events: string[];
  latestIntentVersion: number;
  claimBusy: boolean;
  claimStatusOverride: string | null;
  loseCommitResponse: boolean;
  compensationCalls: number;
}

let state: LifecycleState;

function resetState(): void {
  state = {
    status: 'pending',
    desiredActive: false,
    priorActive: true,
    accountActive: true,
    committedVersion: 0,
    authBannedUntil: null,
    authSnapshotRecordedAt: null,
    authBannedUntilSnapshot: null,
    processorToken: null,
    authReadFailures: 0,
    authReads: 0,
    authUpdates: [],
    updateBehaviors: [],
    rpcCalls: [],
    events: [],
    latestIntentVersion: 1,
    claimBusy: false,
    claimStatusOverride: null,
    loseCommitResponse: false,
    compensationCalls: 0,
  };
}

function intentRow(): Record<string, unknown> {
  return {
    status: state.status,
    operation_id: OPERATION_ID,
    account_id: ACCOUNT_ID,
    intent_version: 1,
    desired_active: state.desiredActive,
    prior_active: state.priorActive,
    auth_user_id: AUTH_USER_ID,
    active: state.accountActive,
    committed_version: state.committedVersion,
    latest_desired_active: state.desiredActive,
    latest_intent_version: state.latestIntentVersion,
    auth_banned_until: state.authBannedUntilSnapshot,
    auth_snapshot_recorded_at: state.authSnapshotRecordedAt,
  };
}

function applyBanDuration(duration: string): void {
  if (duration === 'none') {
    state.authBannedUntil = null;
    return;
  }
  const match = /^(\d+)([sh])$/.exec(duration);
  assert.ok(match, `unexpected test ban duration ${duration}`);
  const units = match[2] === 'h' ? 60 * 60 * 1000 : 1000;
  state.authBannedUntil = new Date(Date.now() + Number(match[1]) * units).toISOString();
}

function installStub(): void {
  supabaseAdmin.auth.admin.getUserById = (async () => {
    state.authReads += 1;
    if (state.authReadFailures > 0) {
      state.authReadFailures -= 1;
      return { data: { user: null }, error: { message: 'simulated Auth read outage' } };
    }
    return {
      data: {
        user: {
          id: AUTH_USER_ID,
          banned_until: state.authBannedUntil ?? undefined,
        },
      },
      error: null,
    };
  }) as unknown as GetUserByIdFn;

  supabaseAdmin.auth.admin.updateUserById = (async (
    _userId: string,
    attributes: { ban_duration?: string },
  ) => {
    const duration = attributes.ban_duration ?? '';
    state.authUpdates.push(duration);
    const behavior: UpdateBehavior = state.updateBehaviors.shift() ?? { apply: true };
    state.events.push('auth.update');
    if (behavior.apply) {
      applyBanDuration(duration);
      if (state.authBannedUntil && behavior.adjustAppliedBanMs) {
        state.authBannedUntil = new Date(
          Date.parse(state.authBannedUntil) + behavior.adjustAppliedBanMs,
        ).toISOString();
      }
    }
    if (behavior.throws) throw new Error(behavior.error?.message ?? 'simulated Auth throw');
    return { data: { user: null }, error: behavior.error ?? null };
  }) as unknown as UpdateUserFn;

  supabaseAdmin.rpc = (async (fn: string, args?: Record<string, unknown>) => {
    const safeArgs = args ?? {};
    state.rpcCalls.push(fn);
    state.events.push(fn);
    if (fn === 'staxis_get_account_lifecycle_intent') {
      return { data: intentRow(), error: null };
    }
    if (fn === 'staxis_claim_account_lifecycle_intent') {
      assert.equal(safeArgs.p_lease_seconds, 600);
      if (state.claimStatusOverride) {
        return { data: { status: state.claimStatusOverride }, error: null };
      }
      if (state.status !== 'pending') return { data: { status: state.status }, error: null };
      if (state.claimBusy) return { data: { status: 'busy' }, error: null };
      const token = safeArgs.p_processor_token as string;
      if (state.processorToken && state.processorToken !== token) {
        return { data: { status: 'busy' }, error: null };
      }
      state.processorToken = token;
      return { data: { status: 'claimed' }, error: null };
    }
    if (fn === 'staxis_record_account_lifecycle_auth_snapshot') {
      assert.equal(safeArgs.p_processor_token, state.processorToken);
      if (!state.authSnapshotRecordedAt) {
        state.authBannedUntilSnapshot = safeArgs.p_banned_until as string | null;
        state.authSnapshotRecordedAt = new Date().toISOString();
      }
      return { data: { status: 'pending' }, error: null };
    }
    if (fn === 'staxis_commit_account_lifecycle_intent') {
      assert.equal(safeArgs.p_processor_token, state.processorToken);
      const noop = state.priorActive === state.desiredActive;
      state.accountActive = state.desiredActive;
      state.committedVersion = 1;
      state.status = 'committed';
      state.processorToken = null;
      if (state.loseCommitResponse) throw new Error('response lost after commit');
      return {
        data: { status: 'committed', active: state.accountActive, noop },
        error: null,
      };
    }
    if (fn === 'staxis_compensate_account_lifecycle_intent') {
      state.compensationCalls += 1;
      assert.equal(safeArgs.p_processor_token, state.processorToken);
      state.status = 'aborted';
      state.processorToken = null;
      return { data: { status: 'aborted' }, error: null };
    }
    if (fn === 'staxis_release_account_lifecycle_processor') {
      state.processorToken = null;
      return { data: { status: state.status }, error: null };
    }
    if (fn === 'staxis_note_account_lifecycle_attempt') {
      return { data: { status: state.status }, error: null };
    }
    throw new Error(`unexpected lifecycle RPC ${fn}`);
  }) as unknown as RpcFn;
}

beforeEach(() => {
  resetState();
  installStub();
});

afterEach(() => {
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.admin.getUserById = originalGetUserById;
  supabaseAdmin.auth.admin.updateUserById = originalUpdateUser;
});

describe('durable account lifecycle processor', () => {
  test('never writes Auth or accounts.active when the Auth pre-read is unavailable', async () => {
    state.authReadFailures = 1;

    const result = await processAccountLifecycleIntent({
      operationId: OPERATION_ID,
      requestId: 'pre-read-test',
      source: 'route',
    });

    assert.equal(result.kind, 'pending');
    assert.equal(result.kind === 'pending' ? result.reason : '', 'auth_read_failed');
    assert.deepEqual(state.authUpdates, []);
    assert.equal(state.accountActive, true);
    assert.equal(state.status, 'pending');
  });

  test('commits when an Auth write reports an error but readback proves it applied', async () => {
    state.updateBehaviors.push({ apply: true, error: { message: 'ambiguous gateway error' } });

    const result = await processAccountLifecycleIntent({
      operationId: OPERATION_ID,
      requestId: 'ambiguous-write-test',
      source: 'route',
    });

    assert.equal(result.kind, 'committed');
    assert.equal(state.status, 'committed');
    assert.equal(state.accountActive, false);
    assert.deepEqual(state.authUpdates, ['876000h']);
    assert.ok(state.authReads >= 2, 'the ambiguous Auth write must be followed by readback');
    const dispatchIndex = state.events.indexOf('auth.update');
    assert.equal(
      state.events[dispatchIndex - 1],
      'staxis_claim_account_lifecycle_intent',
      'the 600-second lease must be renewed immediately before Auth dispatch',
    );
  });

  test('upgrades a short temporary ban to a durable deactivation before committing', async () => {
    state.authBannedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const result = await processAccountLifecycleIntent({
      operationId: OPERATION_ID,
      requestId: 'short-ban-test',
      source: 'route',
    });

    assert.equal(result.kind, 'committed');
    assert.deepEqual(state.authUpdates, ['876000h']);
    assert.equal(state.accountActive, false);
  });

  test('restores an exact finite ban and aborts when reactivation cannot be verified', async () => {
    const originalBan = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    state.desiredActive = true;
    state.priorActive = false;
    state.accountActive = false;
    state.authBannedUntil = originalBan;
    state.updateBehaviors.push(
      { apply: false, error: { message: 'Auth refused reactivation' } },
      { apply: true },
    );

    const result = await processAccountLifecycleIntent({
      operationId: OPERATION_ID,
      requestId: 'restore-test',
      source: 'route',
    });

    assert.equal(result.kind, 'aborted');
    assert.equal(state.status, 'aborted');
    assert.equal(state.accountActive, false);
    assert.equal(state.compensationCalls, 1);
    assert.equal(state.authUpdates[0], 'none');
    assert.match(state.authUpdates[1], /^\d+s$/);
    assert.ok(state.authBannedUntil);
    assert.ok(
      Math.abs(Date.parse(state.authBannedUntil) - Date.parse(originalBan)) <= 2_000,
      'the prior finite ban should be restored, not replaced by a permanent ban',
    );
  });

  test('rejects a restored finite ban that is more than one second early', async () => {
    const originalBan = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    state.desiredActive = true;
    state.priorActive = false;
    state.accountActive = false;
    state.authBannedUntil = originalBan;
    state.updateBehaviors.push(
      { apply: false, error: { message: 'Auth refused reactivation' } },
      { apply: true, adjustAppliedBanMs: -120_000 },
    );

    const result = await processAccountLifecycleIntent({
      operationId: OPERATION_ID,
      requestId: 'early-restore-test',
      source: 'route',
    });

    assert.equal(result.kind, 'pending');
    assert.equal(result.kind === 'pending' ? result.reason : '', 'auth_restore_mismatch');
    assert.equal(state.compensationCalls, 0);
    assert.equal(state.accountActive, false);
    assert.equal(state.status, 'pending');
  });

  test('treats a lost commit response as success after the durable intent reread', async () => {
    state.loseCommitResponse = true;

    const result = await processAccountLifecycleIntent({
      operationId: OPERATION_ID,
      requestId: 'lost-response-test',
      source: 'cron',
    });

    assert.equal(result.kind, 'committed');
    assert.equal(state.status, 'committed');
    assert.equal(state.accountActive, false);
    assert.equal(
      state.rpcCalls.filter((name) => name === 'staxis_commit_account_lifecycle_intent').length,
      1,
    );
    assert.equal(state.compensationCalls, 0);
  });

  test('does not touch Auth when another processor owns the repair lease', async () => {
    state.claimBusy = true;

    const result = await processAccountLifecycleIntent({
      operationId: OPERATION_ID,
      requestId: 'busy-lease-test',
      source: 'cron',
    });

    assert.equal(result.kind, 'pending');
    assert.equal(result.kind === 'pending' ? result.reason : '', 'already_processing');
    assert.equal(state.authReads, 0);
    assert.deepEqual(state.authUpdates, []);
    assert.equal(state.accountActive, true);
  });

  test('replays a superseded committed operation without claiming or touching historical Auth', async () => {
    state.status = 'committed';
    state.accountActive = false;
    state.committedVersion = 1;
    state.latestIntentVersion = 2;

    const result = await processAccountLifecycleIntent({
      operationId: OPERATION_ID,
      requestId: 'terminal-replay-test',
      source: 'route',
    });

    assert.equal(result.kind, 'conflict');
    assert.equal(result.kind === 'conflict' ? result.reason : '', 'superseded');
    assert.deepEqual(state.rpcCalls, ['staxis_get_account_lifecycle_intent']);
    assert.equal(state.authReads, 0);
    assert.deepEqual(state.authUpdates, []);
  });

  test('replays an aborted operation without claiming or touching historical Auth', async () => {
    state.status = 'aborted';
    state.latestIntentVersion = 2;

    const result = await processAccountLifecycleIntent({
      operationId: OPERATION_ID,
      requestId: 'aborted-replay-test',
      source: 'cron',
    });

    assert.equal(result.kind, 'aborted');
    assert.deepEqual(state.rpcCalls, ['staxis_get_account_lifecycle_intent']);
    assert.equal(state.authReads, 0);
    assert.deepEqual(state.authUpdates, []);
  });

  test('a pending operation discovered as superseded returns read-only without Auth access', async () => {
    state.claimStatusOverride = 'superseded';

    const result = await processAccountLifecycleIntent({
      operationId: OPERATION_ID,
      requestId: 'raced-superseded-test',
      source: 'cron',
    });

    assert.equal(result.kind, 'conflict');
    assert.equal(result.kind === 'conflict' ? result.reason : '', 'superseded');
    assert.equal(state.authReads, 0);
    assert.deepEqual(state.authUpdates, []);
  });
});
