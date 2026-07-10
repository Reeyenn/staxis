/**
 * Pure-logic tests for the shared Modal primitive's theme/style core
 * (src/app/_components/ui/modal-core.ts).
 *
 * The staff-pages overhaul migrates every area's hand-rolled modal onto one
 * Modal component whose entire look comes from a theme prop. These tests pin
 * the theme-resolution contract (caller values always win, neutral defaults
 * otherwise) and the variant geometry ('center' card vs 'sheet' bottom
 * sheet) so a regression here can't silently reskin every area at once.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MODAL_THEME_DEFAULTS,
  modalCardStyle,
  modalEnterTransform,
  modalExitTransform,
  modalScrimStyle,
  modalVariantSlides,
  resolveModalTheme,
} from '@/app/_components/ui/modal-core';

describe('resolveModalTheme', () => {
  test('no theme → neutral defaults for every field', () => {
    assert.deepEqual(resolveModalTheme(), MODAL_THEME_DEFAULTS);
    assert.deepEqual(resolveModalTheme({}), MODAL_THEME_DEFAULTS);
  });

  test('caller values win over defaults, field by field', () => {
    const t = resolveModalTheme({
      scrim: 'rgba(24,22,17,0.28)',
      scrimFilter: 'blur(3px)',
      bg: '#FCFBF7',
      border: '1px solid #E4E0D5',
      radius: '18px',
      maxWidth: '1080px',
      padding: '0px',
      shadow: '0 30px 80px -20px rgba(24,22,17,0.35)',
      zIndex: 2000,
    });
    assert.equal(t.scrim, 'rgba(24,22,17,0.28)');
    assert.equal(t.scrimFilter, 'blur(3px)');
    assert.equal(t.bg, '#FCFBF7');
    assert.equal(t.border, '1px solid #E4E0D5');
    assert.equal(t.radius, '18px');
    assert.equal(t.maxWidth, '1080px');
    assert.equal(t.padding, '0px');
    assert.equal(t.shadow, '0 30px 80px -20px rgba(24,22,17,0.35)');
    assert.equal(t.zIndex, 2000);
  });

  test('border + scrimFilter default to none (no look change for untouched areas)', () => {
    const t = resolveModalTheme({});
    assert.equal(t.border, 'none');
    assert.equal(t.scrimFilter, 'none');
  });

  test('partial theme keeps defaults for unspecified fields', () => {
    const t = resolveModalTheme({ bg: '#000' });
    assert.equal(t.bg, '#000');
    assert.equal(t.scrim, MODAL_THEME_DEFAULTS.scrim);
    assert.equal(t.zIndex, MODAL_THEME_DEFAULTS.zIndex);
  });

  test('zIndex 0 is respected (not treated as falsy)', () => {
    assert.equal(resolveModalTheme({ zIndex: 0 }).zIndex, 0);
  });
});

describe('modalScrimStyle', () => {
  const t = resolveModalTheme({ scrim: 'rgba(0,0,0,0.5)', zIndex: 1234 });

  test('is a fixed full-viewport layer using theme scrim + zIndex', () => {
    const s = modalScrimStyle('center', t);
    assert.equal(s.position, 'fixed');
    assert.equal(s.inset, 0);
    assert.equal(s.background, 'rgba(0,0,0,0.5)');
    assert.equal(s.zIndex, 1234);
  });

  test('theme scrimFilter reaches backdrop-filter (with -webkit- for iOS Safari)', () => {
    const blurred = resolveModalTheme({ scrimFilter: 'blur(3px)' });
    const s = modalScrimStyle('center', blurred);
    assert.equal(s.backdropFilter, 'blur(3px)');
    assert.equal(s.WebkitBackdropFilter, 'blur(3px)');
  });

  test('center variant vertically centers with breathing-room padding', () => {
    const s = modalScrimStyle('center', t);
    assert.equal(s.alignItems, 'center');
    assert.notEqual(s.padding, 0);
  });

  test('sheet variant bottom-aligns with zero padding (flush to edge)', () => {
    const s = modalScrimStyle('sheet', t);
    assert.equal(s.alignItems, 'flex-end');
    assert.equal(s.padding, 0);
  });

  test('drawer-right variant right-aligns full-height with zero padding', () => {
    const s = modalScrimStyle('drawer-right', t);
    assert.equal(s.justifyContent, 'flex-end');
    assert.equal(s.alignItems, 'stretch');
    assert.equal(s.padding, 0);
  });

  test('center and sheet keep their horizontal centering (unchanged by the new variant)', () => {
    assert.equal(modalScrimStyle('center', t).justifyContent, 'center');
    assert.equal(modalScrimStyle('sheet', t).justifyContent, 'center');
  });
});

describe('modalCardStyle', () => {
  const t = resolveModalTheme({
    bg: '#FFF',
    radius: '18px',
    maxWidth: '480px',
    padding: '24px',
    shadow: 'none',
  });

  test('center card caps width at theme maxWidth', () => {
    const s = modalCardStyle('center', t);
    assert.equal(s.width, 'min(100%, 480px)');
    assert.equal(s.borderRadius, '18px');
    assert.equal(s.padding, '24px');
    assert.equal(s.background, '#FFF');
  });

  test('theme border reaches the card in both variants (inventory Overlay parity)', () => {
    const bordered = resolveModalTheme({ border: '1px solid #E4E0D5' });
    assert.equal(modalCardStyle('center', bordered).border, '1px solid #E4E0D5');
    assert.equal(modalCardStyle('sheet', bordered).border, '1px solid #E4E0D5');
  });

  test('sheet card is full-width with top corners rounded only', () => {
    const s = modalCardStyle('sheet', t);
    assert.equal(s.width, '100%');
    assert.equal(s.borderRadius, '18px 18px 0 0');
  });

  test('all variants cap height so long content scrolls inside', () => {
    for (const variant of ['center', 'sheet', 'drawer-right'] as const) {
      const s = modalCardStyle(variant, t);
      assert.ok(typeof s.maxHeight === 'string' && s.maxHeight.endsWith('vh'));
      assert.equal(s.overflow, 'auto');
    }
  });

  test('drawer-right card is a full-height panel, theme maxWidth = its width, left corners rounded', () => {
    const s = modalCardStyle('drawer-right', t);
    assert.equal(s.width, 'min(100%, 480px)');
    assert.equal(s.height, '100%');
    assert.equal(s.borderRadius, '18px 0 0 18px');
    assert.equal(s.background, '#FFF');
    assert.equal(s.padding, '24px');
  });

  test('theme border reaches the drawer-right card too', () => {
    const bordered = resolveModalTheme({ border: '1px solid #E4E0D5' });
    assert.equal(modalCardStyle('drawer-right', bordered).border, '1px solid #E4E0D5');
  });
});

describe('enter/exit transforms', () => {
  test('sheet slides from/to the bottom edge', () => {
    assert.equal(modalEnterTransform('sheet'), 'translateY(100%)');
    assert.equal(modalExitTransform('sheet'), 'translateY(100%)');
  });

  test('drawer-right slides from/to the right edge', () => {
    assert.equal(modalEnterTransform('drawer-right'), 'translateX(100%)');
    assert.equal(modalExitTransform('drawer-right'), 'translateX(100%)');
  });

  test('center uses the Overlay-style rise + settle', () => {
    assert.match(modalEnterTransform('center'), /translateY\(.+\) scale\(.+\)/);
    assert.match(modalExitTransform('center'), /translateY\(.+\) scale\(.+\)/);
  });

  test('slide classification: sheet + drawer-right slide (opacity 1), center fades', () => {
    assert.equal(modalVariantSlides('sheet'), true);
    assert.equal(modalVariantSlides('drawer-right'), true);
    assert.equal(modalVariantSlides('center'), false);
  });
});
