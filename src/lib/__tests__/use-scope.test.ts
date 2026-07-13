/**
 * Tests for computeScope — the pure resolver behind useScope().
 *
 * Imports from scope-core.ts, NOT use-scope.ts: the test runner uses
 * `--conditions=react-server`, under which React has no createContext, so
 * importing the hook module (which pulls in AuthContext/PropertyContext)
 * would crash at module load. The hook itself is a one-line useMemo over
 * this function; the logic under test is all here.
 *
 * Contract being pinned:
 *   - ready === true  ⇔ both uid and pid are non-empty strings
 *   - truthiness semantics match the hand-typed guards this replaces
 *     (`if (!user || !activePropertyId) return`): '' / null / undefined
 *     all count as "not present"
 *   - empty strings normalize to null in the returned scope
 *   - present values pass through unchanged
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeScope, type Scope } from '@/lib/hooks/scope-core';

const UID = 'a2f5c9d0-1111-4222-8333-444455556666';
const PID = 'b3e6d0e1-7777-4888-9999-000011112222';

describe('computeScope', () => {
  test('ready when both uid and pid are present', () => {
    const scope = computeScope(UID, PID);
    assert.equal(scope.ready, true);
    assert.equal(scope.uid, UID);
    assert.equal(scope.pid, PID);
  });

  test('type narrowing: ready=true branch exposes string uid/pid', () => {
    const scope: Scope = computeScope(UID, PID);
    if (scope.ready) {
      // Compile-time check — these assignments fail tsc if the
      // discriminated union ever loses its narrowing.
      const uid: string = scope.uid;
      const pid: string = scope.pid;
      assert.equal(uid, UID);
      assert.equal(pid, PID);
    } else {
      assert.fail('expected ready scope');
    }
  });

  test('not ready when uid is missing (null / undefined / empty)', () => {
    for (const uid of [null, undefined, ''] as const) {
      const scope = computeScope(uid, PID);
      assert.equal(scope.ready, false, `uid=${JSON.stringify(uid)}`);
      assert.equal(scope.uid, null);
      assert.equal(scope.pid, PID);
    }
  });

  test('not ready when pid is missing (null / undefined / empty)', () => {
    for (const pid of [null, undefined, ''] as const) {
      const scope = computeScope(UID, pid);
      assert.equal(scope.ready, false, `pid=${JSON.stringify(pid)}`);
      assert.equal(scope.uid, UID);
      assert.equal(scope.pid, null);
    }
  });

  test('not ready when both are missing', () => {
    const scope = computeScope(null, null);
    assert.equal(scope.ready, false);
    assert.equal(scope.uid, null);
    assert.equal(scope.pid, null);
  });

  test('empty strings normalize to null (matches the falsy guards it replaces)', () => {
    const scope = computeScope('', '');
    assert.equal(scope.ready, false);
    assert.equal(scope.uid, null);
    assert.equal(scope.pid, null);
  });

  test('non-UUID strings still count as present (no format validation here)', () => {
    // Scope is a presence check, not a validator — pid formats vary in
    // tests/seeds and server routes do their own UUID validation.
    const scope = computeScope('user-1', 'prop-1');
    assert.equal(scope.ready, true);
    assert.equal(scope.uid, 'user-1');
    assert.equal(scope.pid, 'prop-1');
  });
});
