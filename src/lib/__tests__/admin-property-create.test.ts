/**
 * Behavior tests for the validation gate at the top of
 * POST /api/admin/properties/create.
 *
 * Phase M1 (2026-05-14). The route is the only path that creates new
 * hotels in the product. The validation here is the SECOND-of-two
 * defenses (after the form's client-side check) and the LAST one
 * before the DB-layer CHECK constraints fire.
 *
 * Per Phase L discipline rule #2: behavior tests seed inputs and
 * assert outputs. Each case below either accepts a known-valid payload
 * or rejects a known-invalid one with a useful reason string.
 *
 * What we DON'T test here: the property insert or organization-transfer RPC.
 * Pure-function unit tests cover the validation boundary that's easy to
 * regress in isolation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateBody, usesAtomicTestRoster } from '@/lib/admin-property-create-validation';
import { buildStandardTestRoomNumbers } from '@/lib/test-room-roster';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';

// ─── HAPPY PATH ────────────────────────────────────────────────────────────

describe('validateBody — happy path', () => {
  test('accepts a minimal valid payload', () => {
    const result = validateBody({
      name: 'Hampton Inn Beaumont',
      totalRooms: 80,
      timezone: 'America/Chicago',
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.values.name, 'Hampton Inn Beaumont');
      assert.equal(result.values.totalRooms, 80);
      assert.equal(result.values.timezone, 'America/Chicago');
      assert.equal(result.values.pmsType, null);
      assert.equal(result.values.brand, null);
      assert.equal(result.values.propertyKind, 'limited_service');
      assert.equal(result.values.isTest, false);
      assert.equal(result.values.organizationId, null);
    }
  });

  test('accepts a full valid payload with all optional fields', () => {
    const result = validateBody({
      name: 'Marriott Downtown Austin',
      totalRooms: 350,
      timezone: 'America/New_York',
      pmsType: 'choice_advantage',
      brand: 'Marriott',
      propertyKind: 'full_service',
      isTest: true,
      organizationId: ORGANIZATION_ID,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.values.pmsType, 'choice_advantage');
      assert.equal(result.values.brand, 'Marriott');
      assert.equal(result.values.propertyKind, 'full_service');
      assert.equal(result.values.isTest, true);
      assert.equal(result.values.organizationId, ORGANIZATION_ID);
    }
  });

  test('accepts the deterministic roster emitted by the test-property seed path', () => {
    const roomNumbers = buildStandardTestRoomNumbers(50);
    const result = validateBody({
      name: 'Seeded Test Hotel',
      totalRooms: 50,
      timezone: 'America/Chicago',
      isTest: true,
      roomNumbers,
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.values.roomNumbers, roomNumbers);
  });

  test('only an explicit is_test roster enters the atomic canonical creation path', () => {
    const testProperty = validateBody({
      name: 'Seeded Test Hotel',
      totalRooms: 50,
      timezone: 'America/Chicago',
      isTest: true,
      roomNumbers: buildStandardTestRoomNumbers(50),
    });
    const realProperty = validateBody({
      name: 'Real Customer Hotel',
      totalRooms: 50,
      timezone: 'America/Chicago',
      isTest: false,
    });
    const realPropertyWithOperatorList = validateBody({
      name: 'Real Customer Hotel With List',
      totalRooms: 2,
      timezone: 'America/Chicago',
      isTest: false,
      roomNumbers: ['101', '102'],
    });

    assert.equal(testProperty.ok, true);
    assert.equal(realProperty.ok, true);
    assert.equal(realPropertyWithOperatorList.ok, true);
    if (testProperty.ok) assert.equal(usesAtomicTestRoster(testProperty.values), true);
    if (realProperty.ok) assert.equal(usesAtomicTestRoster(realProperty.values), false);
    if (realPropertyWithOperatorList.ok) {
      assert.equal(usesAtomicTestRoster(realPropertyWithOperatorList.values), false);
    }
  });

  test('trims name whitespace', () => {
    const result = validateBody({
      name: '  Hilton Garden  ',
      totalRooms: 120,
      timezone: 'UTC',
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.values.name, 'Hilton Garden');
    }
  });

  test('treats empty-string optional fields as omitted', () => {
    // Form sends "" rather than omitting; we should accept that the
    // same way as undefined.
    const result = validateBody({
      name: 'Test Hotel',
      totalRooms: 50,
      timezone: 'America/Chicago',
      pmsType: '',
      brand: '',
      organizationId: '',
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.values.pmsType, null);
      assert.equal(result.values.brand, null);
      assert.equal(result.values.organizationId, null);
    }
  });

  test('accepts an empty shell payload with safe hotel defaults', () => {
    const result = validateBody({});
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.values.name, 'New hotel');
      assert.equal(result.values.totalRooms, 1);
      assert.equal(result.values.timezone, 'America/Chicago');
      assert.equal(result.values.organizationId, null);
    }
  });
});

// ─── NAME ──────────────────────────────────────────────────────────────────

describe('validateBody — name field', () => {
  test('accepts MISSING name — the shell uses a placeholder until an admin edits it', () => {
    const result = validateBody({
      totalRooms: 50,
      timezone: 'America/Chicago',
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.values.name, 'New hotel');
  });

  test('rejects non-string name', () => {
    const result = validateBody({
      name: 12345 as unknown,
      totalRooms: 50,
      timezone: 'America/Chicago',
    });
    assert.equal(result.ok, false);
  });

  test('rejects too-short name (< 3 chars after trim)', () => {
    const result = validateBody({
      name: '  X  ',
      totalRooms: 50,
      timezone: 'America/Chicago',
    });
    assert.equal(result.ok, false);
  });

  test('rejects too-long name (> 100 chars)', () => {
    const result = validateBody({
      name: 'X'.repeat(101),
      totalRooms: 50,
      timezone: 'America/Chicago',
    });
    assert.equal(result.ok, false);
  });
});

// ─── TOTAL_ROOMS ───────────────────────────────────────────────────────────

describe('validateBody — totalRooms field (mirrors DB CHECK from Phase K)', () => {
  test('rejects totalRooms = 0 (the original Phase K bug class)', () => {
    const result = validateBody({
      name: 'Test',
      totalRooms: 0,
      timezone: 'America/Chicago',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /totalRooms/);
  });

  test('rejects negative totalRooms', () => {
    const result = validateBody({
      name: 'Test',
      totalRooms: -5,
      timezone: 'America/Chicago',
    });
    assert.equal(result.ok, false);
  });

  test('rejects fractional totalRooms', () => {
    const result = validateBody({
      name: 'Test',
      totalRooms: 50.5,
      timezone: 'America/Chicago',
    });
    assert.equal(result.ok, false);
  });

  test('rejects string totalRooms', () => {
    const result = validateBody({
      name: 'Test',
      totalRooms: '50' as unknown,
      timezone: 'America/Chicago',
    });
    assert.equal(result.ok, false);
  });

  test('rejects unrealistic totalRooms (> 2000)', () => {
    const result = validateBody({
      name: 'Test',
      totalRooms: 5000,
      timezone: 'America/Chicago',
    });
    assert.equal(result.ok, false);
  });

  test('accepts boundary values 1 and 2000', () => {
    for (const n of [1, 2000]) {
      const result = validateBody({
        name: 'Test',
        totalRooms: n,
        timezone: 'America/Chicago',
      });
      assert.equal(result.ok, true, `totalRooms=${n} should pass`);
    }
  });

  test('accepts MISSING totalRooms — defaults to 1 until hotel details are completed', () => {
    const result = validateBody({ name: 'Test', timezone: 'America/Chicago' });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.values.totalRooms, 1);
  });
});

// ─── TIMEZONE (mirrors Phase L IANA validator) ─────────────────────────────

describe('validateBody — timezone field', () => {
  test('accepts standard IANA names', () => {
    for (const tz of ['America/Chicago', 'America/New_York', 'Europe/London', 'UTC', 'Asia/Tokyo']) {
      const result = validateBody({ name: 'Test', totalRooms: 50, timezone: tz });
      assert.equal(result.ok, true, `timezone=${tz} should pass`);
    }
  });

  test('rejects "Mars/Olympus" (Phase L bug 3 class)', () => {
    const result = validateBody({
      name: 'Test',
      totalRooms: 50,
      timezone: 'Mars/Olympus',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /timezone/i);
  });

  test('rejects bare "Chicago" (continent prefix missing)', () => {
    const result = validateBody({
      name: 'Test',
      totalRooms: 50,
      timezone: 'Chicago',
    });
    assert.equal(result.ok, false);
  });

  test('rejects path-traversal in timezone', () => {
    const result = validateBody({
      name: 'Test',
      totalRooms: 50,
      timezone: '../../etc/passwd',
    });
    assert.equal(result.ok, false);
  });

  test('accepts EMPTY timezone — defaults to America/Chicago until hotel details are completed', () => {
    const result = validateBody({
      name: 'Test',
      totalRooms: 50,
      timezone: '',
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.values.timezone, 'America/Chicago');
  });

  test('rejects non-string timezone', () => {
    const result = validateBody({
      name: 'Test',
      totalRooms: 50,
      timezone: 12345 as unknown,
    });
    assert.equal(result.ok, false);
  });
});

// ─── PMS_TYPE ──────────────────────────────────────────────────────────────

describe('validateBody — pmsType field', () => {
  test('accepts known PMS types', () => {
    for (const t of ['choice_advantage', 'manual_csv']) {
      const result = validateBody({
        name: 'Test', totalRooms: 50, timezone: 'America/Chicago', pmsType: t,
      });
      assert.equal(result.ok, true);
    }
  });

  test('rejects unknown PMS type (catches typos)', () => {
    const result = validateBody({
      name: 'Test', totalRooms: 50, timezone: 'America/Chicago',
      pmsType: 'choiceadvantge', // typo
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /pmsType/);
  });

  test('null/undefined/empty pmsType is allowed (not all hotels have a PMS yet)', () => {
    for (const t of [null, undefined, '']) {
      const result = validateBody({
        name: 'Test', totalRooms: 50, timezone: 'America/Chicago', pmsType: t,
      });
      assert.equal(result.ok, true, `pmsType=${JSON.stringify(t)} should pass`);
    }
  });
});

// ─── PROPERTY_KIND ─────────────────────────────────────────────────────────

describe('validateBody — propertyKind field', () => {
  test('accepts known kinds', () => {
    for (const k of ['limited_service', 'full_service', 'extended_stay', 'resort']) {
      const result = validateBody({
        name: 'Test', totalRooms: 50, timezone: 'America/Chicago', propertyKind: k,
      });
      assert.equal(result.ok, true);
    }
  });

  test('rejects unknown kind', () => {
    const result = validateBody({
      name: 'Test', totalRooms: 50, timezone: 'America/Chicago',
      propertyKind: 'casino',
    });
    assert.equal(result.ok, false);
  });

  test('defaults to limited_service when omitted', () => {
    const result = validateBody({
      name: 'Test', totalRooms: 50, timezone: 'America/Chicago',
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.values.propertyKind, 'limited_service');
  });
});

// ─── ORGANIZATION ASSIGNMENT ───────────────────────────────────────────────

describe('validateBody — organizationId field', () => {
  test('accepts a valid organization UUID', () => {
    const result = validateBody({
      name: 'Test', totalRooms: 50, timezone: 'America/Chicago',
      organizationId: ORGANIZATION_ID,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.values.organizationId, ORGANIZATION_ID);
  });

  test('defaults to independent when organizationId is omitted, null, or empty', () => {
    for (const organizationId of [undefined, null, '']) {
      const result = validateBody({
        name: 'Test', totalRooms: 50, timezone: 'America/Chicago', organizationId,
      });
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.values.organizationId, null);
    }
  });

  test('rejects a malformed organizationId before property creation', () => {
    for (const organizationId of ['not-a-uuid', '11111111-1111-1111', 42]) {
      const result = validateBody({
        name: 'Test', totalRooms: 50, timezone: 'America/Chicago', organizationId,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /organizationId/);
    }
  });
});
