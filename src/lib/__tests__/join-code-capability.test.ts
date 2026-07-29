import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  finalizeJoinCodeSignup,
  isOnboardingJoinCodeCapability,
  resolveJoinCodeCapability,
} from '@/lib/join-code-capability';
import { supabaseAdmin } from '@/lib/supabase-admin';

const CODE_ID = 'a1000000-0000-4000-8000-000000000001';
const HOTEL_ID = 'a1000000-0000-4000-8000-000000000002';
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
let receipt: unknown;
let finalizationReceipt: unknown;
let databaseError: { code: string; message: string } | null;

function validReceipt(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    schemaVersion: 'join-code-capability-v1',
    status: 'active',
    codeId: CODE_ID,
    hotelId: HOTEL_ID,
    codeKind: 'staff_signup',
    role: null,
    expiresAt: FUTURE,
    maxUses: 100,
    usedCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  receipt = validReceipt();
  finalizationReceipt = {
    ok: true,
    schemaVersion: 'join-code-signup-finalization-v1',
    status: 'finalized',
    codeId: CODE_ID,
    hotelId: HOTEL_ID,
    accountId: 'a1000000-0000-4000-8000-000000000003',
    finalRole: 'housekeeping',
    username: 'test-user',
    pendingApproval: true,
    usedCount: 1,
  };
  databaseError = null;
  // @ts-expect-error narrow deterministic RPC facade
  supabaseAdmin.rpc = async (name: string) => {
    if (name === 'staxis_resolve_join_code_capability') {
      return { data: receipt, error: databaseError };
    }
    assert.equal(name, 'staxis_finalize_join_code_signup');
    return { data: finalizationReceipt, error: databaseError };
  };
});

afterEach(() => {
  supabaseAdmin.rpc = originalRpc;
});

describe('join-code capability receipt', () => {
  test('ordinary active and exhausted staff codes never become wizard capabilities', async () => {
    const active = await resolveJoinCodeCapability('TEAM-ABCD234567');
    assert.equal(active.outcome, 'resolved');
    if (active.outcome === 'resolved') {
      assert.equal(isOnboardingJoinCodeCapability(active.receipt), false);
    }

    receipt = validReceipt({ status: 'used_up', maxUses: 100, usedCount: 100 });
    const exhausted = await resolveJoinCodeCapability('TEAM-ABCD234567');
    assert.equal(exhausted.outcome, 'resolved');
    if (exhausted.outcome === 'resolved') {
      assert.equal(isOnboardingJoinCodeCapability(exhausted.receipt), false);
    }
  });

  test('only privileged onboarding and the closed pre-consumed resume kind enter the wizard', async () => {
    receipt = validReceipt({
      codeKind: 'privileged_onboarding', role: 'owner', maxUses: 1, usedCount: 0,
    });
    const privileged = await resolveJoinCodeCapability('BOOT-ABCD234567');
    assert.equal(privileged.outcome, 'resolved');
    if (privileged.outcome === 'resolved') {
      assert.equal(isOnboardingJoinCodeCapability(privileged.receipt), true);
    }

    receipt = validReceipt({
      codeKind: 'onboarding_resume', status: 'used_up', maxUses: 1, usedCount: 1,
    });
    const resume = await resolveJoinCodeCapability('RSME-ABCD234567');
    assert.equal(resume.outcome, 'resolved');
    if (resume.outcome === 'resolved') {
      assert.equal(isOnboardingJoinCodeCapability(resume.receipt), true);
    }
  });

  test('revoked and expired resume receipts remain closed denials, not contract outages', async () => {
    for (const lifecycle of [
      { status: 'revoked', expiresAt: FUTURE },
      { status: 'expired', expiresAt: PAST },
    ] as const) {
      receipt = validReceipt({
        codeKind: 'onboarding_resume',
        role: null,
        status: lifecycle.status,
        expiresAt: lifecycle.expiresAt,
        maxUses: 1,
        usedCount: 1,
      });
      const result = await resolveJoinCodeCapability('RSME-ABCD234567');
      assert.equal(result.outcome, 'resolved');
      if (result.outcome === 'resolved') {
        assert.equal(result.receipt.status, lifecycle.status);
        assert.equal(isOnboardingJoinCodeCapability(result.receipt), false);
      }
    }
  });

  test('fails closed on poisoned codeKind-role and lifecycle combinations', async () => {
    for (const poisoned of [
      validReceipt({ codeKind: 'staff_signup', role: 'owner' }),
      validReceipt({ codeKind: 'privileged_onboarding', role: null, maxUses: 1 }),
      validReceipt({ codeKind: 'privileged_onboarding', role: 'owner', maxUses: 2 }),
      validReceipt({ codeKind: 'legacy_revoked', role: 'owner', status: 'active' }),
      validReceipt({ codeKind: 'onboarding_resume', status: 'active', maxUses: 1, usedCount: 0 }),
      validReceipt({ codeKind: 'onboarding_resume', status: 'used_up', maxUses: 2, usedCount: 2 }),
    ]) {
      receipt = poisoned;
      const result = await resolveJoinCodeCapability('TEST-ABCD234567');
      assert.deepEqual(result, { outcome: 'unavailable', databaseCode: 'PGRST_CONTRACT' });
    }
  });

  test('malformed candidates do not call the RPC and resolver outages are retryable', async () => {
    let calls = 0;
    // @ts-expect-error narrow deterministic RPC facade
    supabaseAdmin.rpc = async () => {
      calls += 1;
      return { data: receipt, error: databaseError };
    };
    assert.deepEqual(await resolveJoinCodeCapability('bad code'), { outcome: 'not_found' });
    assert.equal(calls, 0);

    databaseError = { code: 'PGRST202', message: 'schema cache unavailable' };
    assert.deepEqual(
      await resolveJoinCodeCapability('TEST-ABCD234567'),
      { outcome: 'unavailable', databaseCode: 'PGRST202' },
    );
  });

  test('finalization accepts only a closed result bound to the requested code, hotel, and role', async () => {
    // The preceding malformed-input test installs a counting facade; restore
    // the finalization-shaped RPC response explicitly for this contract test.
    // @ts-expect-error narrow deterministic RPC facade
    supabaseAdmin.rpc = async (name: string) => {
      assert.equal(name, 'staxis_finalize_join_code_signup');
      return { data: finalizationReceipt, error: databaseError };
    };
    const input = {
      codeId: CODE_ID,
      code: 'TEST-ABCD234567',
      hotelId: HOTEL_ID,
      expectedUsedCount: 0,
      authUserId: 'a1000000-0000-4000-8000-000000000004',
      username: 'test-user',
      displayName: 'Test User',
      requestedRole: 'housekeeping' as const,
      expectedPendingApproval: true,
      phone: null,
      language: 'en' as const,
      requestId: 'join-code-capability-test',
    };
    assert.equal((await finalizeJoinCodeSignup(input)).outcome, 'finalized');

    for (const poisoned of [
      { ...(finalizationReceipt as Record<string, unknown>), hotelId: CODE_ID },
      { ...(finalizationReceipt as Record<string, unknown>), finalRole: 'owner' },
      { ...(finalizationReceipt as Record<string, unknown>), pendingApproval: false },
      { ...(finalizationReceipt as Record<string, unknown>), rawCode: 'SECRET' },
      { ok: false, status: 'revoked', reason: 'too much detail' },
    ]) {
      finalizationReceipt = poisoned;
      assert.deepEqual(
        await finalizeJoinCodeSignup(input),
        { outcome: 'unavailable', databaseCode: 'PGRST_CONTRACT' },
      );
    }

    finalizationReceipt = { ok: false, status: 'revoked' };
    assert.deepEqual(
      await finalizeJoinCodeSignup(input),
      { outcome: 'denied', status: 'revoked' },
    );
  });
});
