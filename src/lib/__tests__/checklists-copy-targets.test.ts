/**
 * Tests for partitionTargets — the pure cross-tenant-write guard used by the
 * checklist copy-to-properties route. No DB, no network: it only reasons over
 * a TeamCaller's access list, so the isolation rule is exercised directly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { partitionTargets } from '@/lib/checklists/access';
import type { TeamCaller } from '@/lib/team-auth';

function caller(over: Partial<TeamCaller> = {}): TeamCaller {
  return {
    accountId: over.accountId ?? 'acct-1',
    authUserId: over.authUserId ?? 'user-1',
    authEmail: over.authEmail,
    role: over.role ?? 'general_manager',
    propertyAccess: over.propertyAccess ?? [],
    isAdmin: over.isAdmin ?? false,
  };
}

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';

describe('partitionTargets', () => {
  it('authorizes only properties in the caller access list', () => {
    const c = caller({ propertyAccess: [A, B] });
    const { authorized, denied } = partitionTargets(c, [A, B, C]);
    assert.deepEqual(authorized, [A, B]);
    assert.deepEqual(denied, [C]);
  });

  it('denies everything for a manager with no access', () => {
    const c = caller({ propertyAccess: [] });
    const { authorized, denied } = partitionTargets(c, [A, B]);
    assert.deepEqual(authorized, []);
    assert.deepEqual(denied, [A, B]);
  });

  it('authorizes every target for an admin', () => {
    const c = caller({ role: 'admin', isAdmin: true, propertyAccess: [] });
    const { authorized, denied } = partitionTargets(c, [A, B, C]);
    assert.deepEqual(authorized, [A, B, C]);
    assert.deepEqual(denied, []);
  });

  it('dedupes repeated ids and drops blanks', () => {
    const c = caller({ propertyAccess: [A] });
    const { authorized, denied } = partitionTargets(c, [A, A, '', '   ', C]);
    assert.deepEqual(authorized, [A]);
    assert.deepEqual(denied, [C]);
  });
});
