/**
 * Tests for the optional `propertyId` body field on
 * POST /api/admin/live-mapper/promote (feature/coverage-gated-feeds).
 *
 * The route accepts an OPTIONAL uuid `propertyId`; when present it becomes
 * promoteMap's `gateByPropertyCaptures`, so Make-live only lights up feeds with
 * a proven preview for that hotel. Absent/null → no gating (Manage-maps
 * rollback path). The response echoes `disabledFeeds` + `allFeedsDisabled`.
 *
 * The route validates propertyId with the SAME `validateUuid` helper it uses for
 * the map id, so we pin (1) that helper's accept/reject contract for the field's
 * inputs, and (2) via a source guard, that the route actually threads the field
 * into promoteMap and echoes the gate result (cheap regression fence, same
 * style as admin-routes-auth-gate.test.ts — a full HTTP harness would need to
 * mock requireAdmin + session cookies, which these unit tests deliberately
 * avoid).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateUuid } from '@/lib/api-validate';

const PID = '22222222-2222-2222-2222-222222222222';

describe('promote route — propertyId validation contract', () => {
  test('a valid uuid propertyId passes validateUuid', () => {
    const r = validateUuid(PID, 'propertyId');
    assert.equal(r.error, undefined);
    assert.equal(r.value, PID);
  });

  test('a non-uuid propertyId is rejected (would 400 the route)', () => {
    assert.ok(validateUuid('not-a-uuid', 'propertyId').error);
    assert.ok(validateUuid(123, 'propertyId').error);
    assert.ok(validateUuid('', 'propertyId').error);
  });
});

describe('promote route — source wiring guard', () => {
  const src = readFileSync(
    join(process.cwd(), 'src', 'app', 'api', 'admin', 'live-mapper', 'promote', 'route.ts'),
    'utf8',
  );

  test('only gates when propertyId is provided (undefined/null → no gate)', () => {
    // The guard branch must key off body.propertyId being present.
    assert.match(src, /body\.propertyId !== undefined/);
    assert.match(src, /gateByPropertyCaptures\s*=\s*\{\s*propertyId:/);
  });

  test('threads gateByPropertyCaptures into promoteMap', () => {
    assert.match(src, /promoteMap\(\{[\s\S]*gateByPropertyCaptures[\s\S]*\}\)/);
  });

  test('echoes disabledFeeds + allFeedsDisabled in the ok response', () => {
    assert.match(src, /disabledFeeds:\s*result\.disabledFeeds/);
    assert.match(src, /allFeedsDisabled:\s*result\.allFeedsDisabled/);
  });
});
