/**
 * Where the import control sits, and who is allowed to see it.
 *
 * The founder's placement is specific and load-bearing: LEFT of "Add item",
 * right of the Board toggle. A hotel arriving with a spreadsheet should meet
 * "bring in the file you have" before "type an item in". A CSS reshuffle or a
 * prop rename that moved it would be invisible to a source grep and obvious
 * here, because this renders the real FilterBar and reads the resulting DOM
 * order.
 */

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

import type { InventoryView } from '@/app/inventory/_components/FilterBar';

type FilterBarModule = typeof import('@/app/inventory/_components/FilterBar');

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'localStorage',
  'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
  'Node', 'Event', 'InputEvent', 'EventTarget', 'MouseEvent', 'KeyboardEvent',
  'FocusEvent', 'MutationObserver', 'requestAnimationFrame',
  'cancelAnimationFrame', 'getComputedStyle',
] as const;

function installBrowser(): () => void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/inventory',
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of DOM_GLOBALS) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const candidate = dom.window[key as keyof typeof dom.window];
    const value = typeof candidate === 'function' && (
      key === 'requestAnimationFrame'
      || key === 'cancelAnimationFrame'
      || key === 'getComputedStyle'
    ) ? candidate.bind(dom.window) : candidate;
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const actFlag = 'IS_REACT_ACT_ENVIRONMENT';
  originals.set(actFlag, Object.getOwnPropertyDescriptor(globalThis, actFlag));
  Object.defineProperty(globalThis, actFlag, { configurable: true, writable: true, value: true });
  return () => {
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

interface Handlers {
  onImport?: () => void;
  onAdd?: () => void;
}

async function renderFilterBar(t: TestContext, handlers: Handlers) {
  const restore = installBrowser();

  const [{ FilterBar }, { createRoot }] = await Promise.all([
    import('@/app/inventory/_components/FilterBar') as Promise<FilterBarModule>,
    import('react-dom/client'),
  ]);

  const host = document.createElement('div');
  document.body.appendChild(host);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(host);
    root.render(
      <FilterBar
        lang="en"
        bucket="all"
        onBucket={() => {}}
        query=""
        onQuery={() => {}}
        allCount={0}
        tabs={[]}
        hiddenBuiltins={[]}
        canManage
        onReorder={() => {}}
        onRemove={() => {}}
        onRestore={() => {}}
        onAddCategory={() => {}}
        view={'ledger' as InventoryView}
        onView={() => {}}
        onImport={handlers.onImport}
        onAdd={handlers.onAdd}
      />,
    );
  });
  // One hook, in one order: unmount while the DOM still exists, THEN tear the
  // DOM down. Two hooks would run in registration order and React would be
  // asked to unmount into a closed window.
  t.after(() => {
    act(() => { root?.unmount(); });
    host.remove();
    restore();
  });
  return host;
}

/** Every button on the bar, in document order. */
function buttonLabels(host: HTMLElement): string[] {
  return [...host.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
}

describe('the import control on the inventory toolbar', () => {
  test('renders to the LEFT of Add item', async (t) => {
    const host = await renderFilterBar(t, { onImport: () => {}, onAdd: () => {} });
    const labels = buttonLabels(host);
    const importIdx = labels.findIndex((l) => /import a file/i.test(l));
    const addIdx = labels.findIndex((l) => /add item/i.test(l));
    assert.ok(importIdx >= 0, `no import button rendered. Buttons: ${labels.join(' | ')}`);
    assert.ok(addIdx >= 0, `no add-item button rendered. Buttons: ${labels.join(' | ')}`);
    assert.ok(importIdx < addIdx, 'the import control must come before Add item');
  });

  test('renders to the RIGHT of the Board toggle', async (t) => {
    const host = await renderFilterBar(t, { onImport: () => {}, onAdd: () => {} });
    const labels = buttonLabels(host);
    const boardIdx = labels.findIndex((l) => /^board$/i.test(l));
    const importIdx = labels.findIndex((l) => /import a file/i.test(l));
    assert.ok(boardIdx >= 0, `no board toggle rendered. Buttons: ${labels.join(' | ')}`);
    assert.ok(boardIdx < importIdx, 'the import control must come after the view switch');
  });

  test('clicking it opens the importer', async (t) => {
    let opened = 0;
    const host = await renderFilterBar(t, { onImport: () => { opened += 1; }, onAdd: () => {} });
    const button = [...host.querySelectorAll('button')]
      .find((b) => /import a file/i.test(b.textContent ?? ''));
    assert.ok(button);
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.equal(opened, 1);
  });

  test('is absent for somebody who may not import, and Add item is unaffected', async (t) => {
    const host = await renderFilterBar(t, { onAdd: () => {} });
    const labels = buttonLabels(host);
    assert.equal(labels.some((l) => /import a file/i.test(l)), false);
    assert.equal(labels.some((l) => /add item/i.test(l)), true);
  });

  test('its label says what it does, in plain English with no em dash', async (t) => {
    const host = await renderFilterBar(t, { onImport: () => {}, onAdd: () => {} });
    const label = buttonLabels(host).find((l) => /import/i.test(l)) ?? '';
    assert.doesNotMatch(label, /—/);
    assert.match(label, /file/i);
  });
});
