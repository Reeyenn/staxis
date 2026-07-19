/**
 * Validation-gate tests for POST /api/admin/mapper/assist
 * (feature/cua-assist-board — takeover enabled).
 *
 * The route is the founder's only control channel into a live mapping
 * run: flipping a mapping_help_requests row to 'answered' resumes the
 * robot, and for actionType='takeover' the stored responseCoordinate is
 * physically CLICKED in the hotel's PMS by the robot. A bad coordinate
 * reaching the robot means a wrong click inside a real PMS — so the gate
 * must reject anything malformed or out of the screenshot's bounds.
 *
 * Pattern per repo convention (see admin-property-create.test.ts): the
 * route exports its pure validation pieces — validateAssistBody (shape)
 * and validateCoordinateBounds (viewport bounds, applied after the row
 * fetch) — and the tests exercise those directly. The DB UPDATE + its
 * status='pending' idempotency guard are SQL-level and exercised live.
 * Robot-side mirror: cua-service/src/mapper.ts validateSupervisorCoordinate
 * (tested in cua-service/src/__tests__/learning-board-state.test.ts) —
 * keep the two rule-sets in sync.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateAssistBody, validateCoordinateBounds } from '@/lib/pms/takeover-validate';

const REQ_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ─── validateAssistBody — existing actions stay unchanged ──────────────────

describe('validateAssistBody — guidance / unavailable / abort (unchanged contract)', () => {
  test('guidance with text is accepted', () => {
    const v = validateAssistBody({ requestId: REQ_ID, actionType: 'guidance', responseText: 'Reports → Audit' });
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.actionType, 'guidance');
      assert.equal(v.responseText, 'Reports → Audit');
      assert.equal(v.coordinate, null);
    }
  });

  test('guidance / unavailable without text are rejected', () => {
    for (const actionType of ['guidance', 'unavailable']) {
      const v = validateAssistBody({ requestId: REQ_ID, actionType });
      assert.equal(v.ok, false);
      const blank = validateAssistBody({ requestId: REQ_ID, actionType, responseText: '   ' });
      assert.equal(blank.ok, false);
    }
  });

  test('abort needs no text', () => {
    const v = validateAssistBody({ requestId: REQ_ID, actionType: 'abort' });
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.responseText, null);
  });

  test('bad uuid / unknown action / non-object body are rejected', () => {
    assert.equal(validateAssistBody({ requestId: 'nope', actionType: 'abort' }).ok, false);
    assert.equal(validateAssistBody({ requestId: REQ_ID, actionType: 'hack' }).ok, false);
    assert.equal(validateAssistBody(null).ok, false);
    assert.equal(validateAssistBody('text').ok, false);
  });
});

// ─── validateAssistBody — takeover ──────────────────────────────────────────

describe('validateAssistBody — takeover', () => {
  const SCREENSHOT = 'job-1/1234-getDepartures.png';

  test('takeover with a numeric coordinate + screenshot identity is accepted; note is optional', () => {
    const v = validateAssistBody({
      requestId: REQ_ID, actionType: 'takeover',
      responseCoordinate: { x: 640, y: 400 }, screenshotPath: SCREENSHOT,
    });
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.actionType, 'takeover');
      assert.deepEqual(v.coordinate, { x: 640, y: 400 });
      assert.equal(v.screenshotPath, SCREENSHOT);
      assert.equal(v.responseText, null); // route fills a default at write time
    }
    const withNote = validateAssistBody({
      requestId: REQ_ID, actionType: 'takeover', responseText: 'the Reports menu',
      responseCoordinate: { x: 1, y: 2 }, screenshotPath: SCREENSHOT,
    });
    assert.equal(withNote.ok, true);
    if (withNote.ok) assert.equal(withNote.responseText, 'the Reports menu');
  });

  test('takeover without a coordinate is rejected', () => {
    for (const responseCoordinate of [undefined, null, 'x,y', { x: 5 }, { y: 5 }, { x: '5', y: '6' }, { x: NaN, y: 10 }, { x: 10, y: Infinity }]) {
      const v = validateAssistBody({ requestId: REQ_ID, actionType: 'takeover', responseCoordinate, screenshotPath: SCREENSHOT });
      assert.equal(v.ok, false, `should reject coordinate ${JSON.stringify(responseCoordinate)}`);
    }
  });

  test('takeover without the screenshot identity is rejected — the click must be tied to the frame it was chosen on', () => {
    for (const screenshotPath of [undefined, null, '', '   ', 42]) {
      const v = validateAssistBody({
        requestId: REQ_ID, actionType: 'takeover',
        responseCoordinate: { x: 10, y: 10 }, screenshotPath,
      });
      assert.equal(v.ok, false, `should reject screenshotPath ${JSON.stringify(screenshotPath)}`);
    }
  });

  test('non-takeover actions ignore screenshotPath (no requirement)', () => {
    const v = validateAssistBody({ requestId: REQ_ID, actionType: 'abort' });
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.screenshotPath, null);
  });
});

// ─── validateCoordinateBounds — the robot must never get an unclickable point

describe('validateCoordinateBounds — viewport bounds (1280×800 capture)', () => {
  test('accepts corners and center; rounds fractional clicks', () => {
    assert.deepEqual(validateCoordinateBounds({ x: 0, y: 0 }, 1280, 800), { x: 0, y: 0 });
    assert.deepEqual(validateCoordinateBounds({ x: 1279, y: 799 }, 1280, 800), { x: 1279, y: 799 });
    assert.deepEqual(validateCoordinateBounds({ x: 639.6, y: 400.4 }, 1280, 800), { x: 640, y: 400 });
  });

  test('rejects outside the viewport (and the == width/height edge)', () => {
    assert.equal(validateCoordinateBounds({ x: -1, y: 10 }, 1280, 800), null);
    assert.equal(validateCoordinateBounds({ x: 10, y: -0.6 }, 1280, 800), null);
    assert.equal(validateCoordinateBounds({ x: 1280, y: 10 }, 1280, 800), null);
    assert.equal(validateCoordinateBounds({ x: 10, y: 800 }, 1280, 800), null);
    assert.equal(validateCoordinateBounds({ x: 99999, y: 99999 }, 1280, 800), null);
  });

  test('honors per-row viewport sizes (not hardcoded to 1280×800)', () => {
    assert.equal(validateCoordinateBounds({ x: 700, y: 300 }, 640, 480), null);
    assert.deepEqual(validateCoordinateBounds({ x: 500, y: 300 }, 640, 480), { x: 500, y: 300 });
    assert.deepEqual(validateCoordinateBounds({ x: 1500, y: 900 }, 1920, 1080), { x: 1500, y: 900 });
  });
});
