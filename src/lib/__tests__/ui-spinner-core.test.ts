/**
 * Pure-logic tests for the shared Spinner primitive's core
 * (src/app/_components/ui/spinner-core.ts).
 *
 * Spinner/PageLoader replace the per-page `@keyframes spin` copies. These
 * tests pin the single keyframes declaration (name and rule must stay in
 * lockstep — the animation silently freezes if they drift) and the
 * size/color/track/thickness style contract.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SPIN_ANIMATION_NAME,
  SPIN_KEYFRAMES_CSS,
  resolveSpinnerThickness,
  spinnerStyle,
} from '@/app/_components/ui/spinner-core';

describe('keyframes constants', () => {
  test('the keyframes rule declares exactly the animation name spinners reference', () => {
    assert.ok(SPIN_KEYFRAMES_CSS.startsWith(`@keyframes ${SPIN_ANIMATION_NAME} `));
    assert.match(SPIN_KEYFRAMES_CSS, /rotate\(360deg\)/);
  });
});

describe('resolveSpinnerThickness', () => {
  test('explicit thickness wins', () => {
    assert.equal(resolveSpinnerThickness(20, 5), 5);
  });

  test('default scales with size', () => {
    assert.equal(resolveSpinnerThickness(20), 2);
    assert.equal(resolveSpinnerThickness(40), 4);
  });

  test('never thinner than 2px, even for tiny spinners', () => {
    assert.equal(resolveSpinnerThickness(8), 2);
    assert.equal(resolveSpinnerThickness(12), 2);
  });
});

describe('spinnerStyle', () => {
  test('defaults: 20px, currentColor arc, faint track, 800ms', () => {
    const s = spinnerStyle();
    assert.equal(s.width, 20);
    assert.equal(s.height, 20);
    assert.equal(s.borderTopColor, 'currentColor');
    assert.equal(s.border, '2px solid rgba(0,0,0,0.12)');
    assert.equal(s.animation, `${SPIN_ANIMATION_NAME} 800ms linear infinite`);
    assert.equal(s.borderRadius, '50%');
  });

  test('size, color, track, thickness, speed are all caller-controlled', () => {
    const s = spinnerStyle({
      size: 36,
      color: '#006565',
      track: 'rgba(0,101,101,0.15)',
      thickness: 3,
      speedMs: 1000,
    });
    assert.equal(s.width, 36);
    assert.equal(s.height, 36);
    assert.equal(s.border, '3px solid rgba(0,101,101,0.15)');
    assert.equal(s.borderTopColor, '#006565');
    assert.equal(s.animation, `${SPIN_ANIMATION_NAME} 1000ms linear infinite`);
  });

  test('border-box sizing so the ring never grows the layout box', () => {
    assert.equal(spinnerStyle().boxSizing, 'border-box');
    assert.equal(spinnerStyle().flex, 'none');
  });
});
