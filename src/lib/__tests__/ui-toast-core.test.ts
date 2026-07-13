/**
 * Pure-logic tests for the shared toast primitive's core
 * (src/app/_components/ui/toast-core.ts).
 *
 * useToast()/<ToastHost/> replace three hand-rolled toasts (housekeeper
 * error toast, front-desk pill, inventory banner). These tests pin the list
 * operations (add/remove/cap), the auto-dismiss duration contract
 * (number | null-sticky | default), and the placement + banner styles that
 * every page's exact current look is rebuilt from.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  addToast,
  markToastExiting,
  removeToast,
  resolveDurationMs,
  toastContainerStyle,
  bannerStyle,
  type ToastItem,
} from '@/app/_components/ui/toast-core';

const t = (id: number, tone = 'default'): ToastItem => ({ id, message: `m${id}`, tone });

describe('addToast / removeToast', () => {
  test('appends without mutating the original list', () => {
    const list = [t(1)];
    const next = addToast(list, t(2));
    assert.equal(list.length, 1);
    assert.deepEqual(next.map((x) => x.id), [1, 2]);
  });

  test('re-adding an existing id replaces it (timer-reset re-show)', () => {
    // Housekeeper behavior: showing the same toast again resets it rather
    // than stacking a duplicate.
    const list = [t(1), t(2)];
    const next = addToast(list, { id: 1, message: 'updated', tone: 'error' });
    assert.equal(next.length, 2);
    assert.equal(next[1].id, 1);
    assert.equal(next[1].message, 'updated');
  });

  test('max cap drops the oldest', () => {
    let list: ToastItem[] = [];
    for (let i = 1; i <= 5; i++) list = addToast(list, t(i), 3);
    assert.deepEqual(list.map((x) => x.id), [3, 4, 5]);
  });

  test('no max → unbounded', () => {
    let list: ToastItem[] = [];
    for (let i = 1; i <= 5; i++) list = addToast(list, t(i));
    assert.equal(list.length, 5);
  });

  test('removeToast removes only the matching id', () => {
    const next = removeToast([t(1), t(2), t(3)], 2);
    assert.deepEqual(next.map((x) => x.id), [1, 3]);
  });

  test('removeToast with unknown id is a no-op', () => {
    const list = [t(1)];
    assert.deepEqual(removeToast(list, 99), list);
  });
});

describe('markToastExiting — exit-transition hold', () => {
  test('flags only the matching toast, without mutating the original list', () => {
    const list = [t(1), t(2)];
    const next = markToastExiting(list, 1);
    assert.equal(next[0].exiting, true);
    assert.equal(next[1].exiting, undefined);
    assert.equal(list[0].exiting, undefined, 'input list must not be mutated');
  });

  test('unknown id is a no-op (same list back)', () => {
    const list = [t(1)];
    assert.equal(markToastExiting(list, 99), list);
  });

  test('already-exiting toast is a no-op (same list back)', () => {
    const once = markToastExiting([t(1)], 1);
    assert.equal(markToastExiting(once, 1), once);
  });

  test('an exiting toast is still removable by removeToast', () => {
    const next = removeToast(markToastExiting([t(1), t(2)], 1), 1);
    assert.deepEqual(next.map((x) => x.id), [2]);
  });
});

describe('resolveDurationMs', () => {
  test('explicit number wins over the default', () => {
    assert.equal(resolveDurationMs(2500, 4000), 2500);
  });

  test('0 is a valid explicit duration (not treated as falsy)', () => {
    assert.equal(resolveDurationMs(0, 4000), 0);
  });

  test('null means sticky — no timer', () => {
    assert.equal(resolveDurationMs(null, 4000), null);
  });

  test('undefined falls back to the hook default', () => {
    assert.equal(resolveDurationMs(undefined, 4500), 4500);
  });
});

describe('toastContainerStyle', () => {
  test('top position anchors to the top with the given offset', () => {
    const s = toastContainerStyle('top', 'env(safe-area-inset-top, 12px)', 1000);
    assert.equal(s.position, 'fixed');
    assert.equal((s as Record<string, unknown>).top, 'env(safe-area-inset-top, 12px)');
    assert.equal((s as Record<string, unknown>).bottom, undefined);
    assert.equal(s.zIndex, 1000);
  });

  test('bottom position anchors to the bottom and stacks upward', () => {
    const s = toastContainerStyle('bottom', '24px', 1100);
    assert.equal((s as Record<string, unknown>).bottom, '24px');
    assert.equal((s as Record<string, unknown>).top, undefined);
    assert.equal(s.flexDirection, 'column-reverse');
  });

  test('is horizontally centered and click-through (toasts re-enable pointer events)', () => {
    const s = toastContainerStyle('top', '16px', 1000);
    assert.equal(s.left, '50%');
    assert.equal(s.transform, 'translateX(-50%)');
    assert.equal(s.pointerEvents, 'none');
  });
});

describe('bannerStyle', () => {
  test('matches the inventory banner() shape: 1px border + 3px left stripe', () => {
    const s = bannerStyle({ borderColor: '#1F7A4D', background: '#FCFBF7', color: '#181611' });
    assert.equal(s.border, '1px solid #1F7A4D');
    assert.equal(s.borderLeft, '3px solid #1F7A4D');
    assert.equal(s.background, '#FCFBF7');
    assert.equal(s.color, '#181611');
    assert.equal(s.borderRadius, 10);
  });

  test('accentColor overrides the left stripe independently', () => {
    const s = bannerStyle({ borderColor: '#CCC', accentColor: '#B3261E' });
    assert.equal(s.border, '1px solid #CCC');
    assert.equal(s.borderLeft, '3px solid #B3261E');
  });

  test('no options → neutral, palette-free defaults', () => {
    const s = bannerStyle();
    assert.equal(s.background, 'transparent');
    assert.equal(s.color, 'inherit');
    assert.equal(s.fontFamily, 'inherit');
  });
});
