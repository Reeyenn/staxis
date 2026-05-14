/**
 * Tests for validateAction in src/app/api/walkthrough/step/route.ts.
 *
 * Run via: npx tsx --test src/lib/__tests__/walkthrough-validate-action.test.ts
 *
 * validateAction is the safety net between Claude's free-form tool_use
 * output and what the client overlay will actually act on. If this
 * function ever lets through a malformed click action, the overlay would
 * try to byId.get(undefined) and crash. If it accepts an elementId not
 * in the snapshot, the cursor would point at nothing. If it accepts an
 * empty narration, the user sees a silent cursor.
 *
 * Tests here are the regression guard for those failure modes.
 *
 * Scale-readiness Phase 3B (2026-05-14).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateAction } from '../../app/api/walkthrough/step/route';
import type { SnapshotElement } from '../../components/walkthrough/snapshotDom';

function makeElement(id: string, name = 'Test'): SnapshotElement {
  return {
    id,
    tag: 'button',
    role: 'button',
    name,
    rawName: name,
    rect: { x: 0, y: 0, width: 100, height: 36 },
    inViewport: true,
  };
}

describe('validateAction — happy paths', () => {
  test('valid click with known elementId returns a typed click action', () => {
    const elements = [makeElement('el_0', 'Settings'), makeElement('el_1', 'Housekeeping')];
    const out = validateAction(
      { type: 'click', elementId: 'el_0', narration: 'Click Settings to open your preferences.' },
      elements,
    );
    assert.deepEqual(out, {
      type: 'click',
      elementId: 'el_0',
      narration: 'Click Settings to open your preferences.',
    });
  });

  test('done action passes (no elementId required)', () => {
    const out = validateAction(
      { type: 'done', narration: "You're all set." },
      [],
    );
    assert.deepEqual(out, { type: 'done', narration: "You're all set." });
  });

  test('cannot_help action passes (no elementId required)', () => {
    const out = validateAction(
      { type: 'cannot_help', narration: 'This is not a feature in the app.' },
      [],
    );
    assert.deepEqual(out, { type: 'cannot_help', narration: 'This is not a feature in the app.' });
  });

  test('narration trimmed and capped at 280 chars', () => {
    const long = 'x'.repeat(500);
    const out = validateAction({ type: 'done', narration: '   ' + long + '   ' }, []);
    assert.ok(out);
    assert.equal(out!.type, 'done');
    assert.equal(out!.narration.length, 280);
  });
});

describe('validateAction — rejection paths', () => {
  test('rejects missing type', () => {
    const out = validateAction({ narration: 'no type field' }, []);
    assert.equal(out, null);
  });

  test('rejects unknown type', () => {
    const out = validateAction(
      { type: 'launch_rocket', narration: 'foo' },
      [],
    );
    assert.equal(out, null);
  });

  test('rejects empty narration', () => {
    const out = validateAction(
      { type: 'click', elementId: 'el_0', narration: '' },
      [makeElement('el_0')],
    );
    assert.equal(out, null);
  });

  test('rejects whitespace-only narration', () => {
    const out = validateAction(
      { type: 'done', narration: '   \n  ' },
      [],
    );
    assert.equal(out, null);
  });

  test('rejects click with missing elementId', () => {
    const out = validateAction(
      { type: 'click', narration: 'Click something.' },
      [makeElement('el_0')],
    );
    assert.equal(out, null);
  });

  test('rejects click with elementId NOT in elements list (Claude hallucination)', () => {
    const out = validateAction(
      { type: 'click', elementId: 'el_99', narration: 'Click something.' },
      [makeElement('el_0'), makeElement('el_1')],
    );
    assert.equal(out, null);
  });

  test('rejects null input', () => {
    // @ts-expect-error — testing the runtime check, not the type
    const out = validateAction(null, []);
    assert.equal(out, null);
  });

  test('rejects non-object input', () => {
    // @ts-expect-error — testing the runtime check
    const out = validateAction('a string', []);
    assert.equal(out, null);
  });
});
