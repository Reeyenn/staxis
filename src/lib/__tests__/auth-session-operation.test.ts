import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Session } from '@supabase/supabase-js';

import {
  AmbiguousSessionOperationError,
  settleSessionOperation,
} from '@/lib/auth/session-operation';
import {
  AUTH_LOCK_ACQUIRE_TIMEOUT_MS,
  AUTH_OPERATION_TIMEOUT_MS,
  AUTH_SESSION_OPERATION_TIMEOUT_MS,
} from '@/lib/api-fetch';

function session(tokenIdentity: string): Session {
  return {
    access_token: `access-${tokenIdentity}`,
    refresh_token: `refresh-${tokenIdentity}`,
    expires_in: 3_600,
    expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    token_type: 'bearer',
    user: { id: 'user-A' },
  } as Session;
}

describe('session-creating operation settlement', () => {
  test('a success that settles after the UI deadline is discarded by exact session identity', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let resolveOperation!: (value: { data: { session: Session | null } }) => void;
    const operation = new Promise<{ data: { session: Session | null } }>((resolve) => {
      resolveOperation = resolve;
    });
    const discarded: string[] = [];
    const pending = settleSessionOperation(operation, {
      timeoutMs: 25,
      label: 'Verify code',
      discardLateSession: (lateSession) => {
        discarded.push(lateSession.refresh_token);
      },
    });
    const rejected = assert.rejects(pending, AmbiguousSessionOperationError);

    context.mock.timers.tick(25);
    await rejected;
    assert.deepEqual(discarded, []);

    resolveOperation({ data: { session: session('late') } });
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(discarded, ['refresh-late']);
    context.mock.timers.reset();
  });

  test('an on-time session returns normally and is not discarded', async () => {
    const accepted = session('on-time');
    const discarded: string[] = [];
    const result = await settleSessionOperation(
      Promise.resolve({ data: { session: accepted } }),
      {
        timeoutMs: 100,
        label: 'Sign in',
        discardLateSession: (lateSession) => {
          discarded.push(lateSession.refresh_token);
        },
      },
    );

    assert.equal(result.data.session?.refresh_token, 'refresh-on-time');
    assert.deepEqual(discarded, []);
  });

  test('the outer budget includes lock acquisition plus the full auth transport deadline', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const accepted = session('lock-then-transport');
    const operation = new Promise<{ data: { session: Session | null } }>((resolve) => {
      setTimeout(() => {
        setTimeout(() => resolve({ data: { session: accepted } }), AUTH_OPERATION_TIMEOUT_MS);
      }, AUTH_LOCK_ACQUIRE_TIMEOUT_MS);
    });

    const pending = settleSessionOperation(operation, {
      timeoutMs: AUTH_SESSION_OPERATION_TIMEOUT_MS,
      label: 'Sign in',
      discardLateSession: () => {
        assert.fail('a result inside the lock+transport budget is not late');
      },
    });

    context.mock.timers.tick(AUTH_LOCK_ACQUIRE_TIMEOUT_MS);
    await Promise.resolve();
    context.mock.timers.tick(AUTH_OPERATION_TIMEOUT_MS);
    const result = await pending;

    assert.equal(result.data.session?.refresh_token, accepted.refresh_token);
    assert.ok(
      AUTH_SESSION_OPERATION_TIMEOUT_MS > AUTH_LOCK_ACQUIRE_TIMEOUT_MS + AUTH_OPERATION_TIMEOUT_MS,
      'session settlement must retain a persistence/listener margin',
    );
    context.mock.timers.reset();
  });
});
