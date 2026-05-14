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
 * What we DON'T test here: the .insert() call itself or the join-code
 * minting. Those are exercised end-to-end by M1.5's smoke addition
 * (create + delete a sentinel property in dev). Pure-function unit
 * tests cover the part that's easy to regress in isolation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateBody } from '@/app/api/admin/properties/create/route';

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
      assert.equal(result.values.ownerEmail, null);
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
      ownerEmail: 'owner@hotel.com',
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.values.pmsType, 'choice_advantage');
      assert.equal(result.values.brand, 'Marriott');
      assert.equal(result.values.propertyKind, 'full_service');
      assert.equal(result.values.isTest, true);
      assert.equal(result.values.ownerEmail, 'owner@hotel.com');
    }
  });

  test('trims name whitespace and lowercases owner email', () => {
    const result = validateBody({
      name: '  Hilton Garden  ',
      totalRooms: 120,
      timezone: 'UTC',
      ownerEmail: '  Alice@HOTEL.com  ',
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.values.name, 'Hilton Garden');
      assert.equal(result.values.ownerEmail, 'alice@hotel.com');
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
      ownerEmail: '',
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.values.pmsType, null);
      assert.equal(result.values.brand, null);
      assert.equal(result.values.ownerEmail, null);
    }
  });
});

// ─── NAME ──────────────────────────────────────────────────────────────────

describe('validateBody — name field', () => {
  test('rejects missing name', () => {
    const result = validateBody({
      totalRooms: 50,
      timezone: 'America/Chicago',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /name/i);
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

  test('rejects empty timezone', () => {
    const result = validateBody({
      name: 'Test',
      totalRooms: 50,
      timezone: '',
    });
    assert.equal(result.ok, false);
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

// ─── OWNER_EMAIL ───────────────────────────────────────────────────────────

describe('validateBody — ownerEmail field', () => {
  test('rejects email without @', () => {
    const result = validateBody({
      name: 'Test', totalRooms: 50, timezone: 'America/Chicago',
      ownerEmail: 'notanemail',
    });
    assert.equal(result.ok, false);
  });

  test('accepts standard email', () => {
    const result = validateBody({
      name: 'Test', totalRooms: 50, timezone: 'America/Chicago',
      ownerEmail: 'owner@hotel.com',
    });
    assert.equal(result.ok, true);
  });
});
