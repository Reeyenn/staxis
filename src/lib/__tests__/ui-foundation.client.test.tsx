import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { UiButton, type UiButtonTheme } from '@/app/_components/ui/Button';
import { SurfaceCard } from '@/app/_components/ui/SurfaceCard';

const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'Element',
  'HTMLElement',
  'HTMLButtonElement',
  'Node',
  'Event',
  'EventTarget',
] as const;

function installBrowser(): () => void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/staff',
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const originalActFlag = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  for (const key of DOM_GLOBALS) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: dom.window[key as keyof typeof dom.window],
    });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
  return () => {
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    if (originalActFlag) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActFlag);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  };
}

function mount(context: TestContext): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  context.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, root };
}

const THEME: UiButtonTheme = {
  sizes: {
    sm: { height: 28, padding: '0 12px', fontSize: 12 },
    md: { height: 36, padding: '0 16px', fontSize: 13 },
  },
  variants: {
    primary: { background: '#3E5C48', color: '#fff', border: '#3E5C48', fontWeight: 600 },
    ghost: { background: 'transparent', color: '#5C625C', border: '#8A9187', fontWeight: 500 },
  },
  fontFamily: 'sans-serif',
  disabledOpacity: 0.45,
  focusRing: '#5C7A60',
};

describe('shared light-surface components', { concurrency: false }, () => {
  test('UiButton is a keyboard-safe native button with disabled styling', async (context) => {
    const restore = installBrowser();
    const { container, root } = mount(context);
    context.after(restore);

    await act(async () => {
      root.render(<UiButton theme={THEME} variant="primary">Save</UiButton>);
    });
    const button = container.querySelector('button');
    assert.ok(button);
    assert.equal(button.type, 'button');
    assert.equal(button.disabled, false);
    assert.equal(button.className, 'stx-ui-button');
    assert.equal(button.style.height, '36px');
    assert.equal(button.style.getPropertyValue('--stx-ui-focus-ring'), '#5C7A60');

    await act(async () => {
      root.render(<UiButton theme={THEME} variant="ghost" disabled>Save</UiButton>);
    });
    const disabled = container.querySelector('button');
    assert.ok(disabled);
    assert.equal(disabled.disabled, true);
    assert.equal(disabled.style.opacity, '0.45');
  });

  test('SurfaceCard preserves caller surface geometry and child content', async (context) => {
    const restore = installBrowser();
    const { container, root } = mount(context);
    context.after(restore);

    await act(async () => {
      root.render(
        <SurfaceCard
          data-testid="card"
          surface="#fff"
          border="1px solid #eee"
          radius={16}
          shadow="none"
          padding="18px 20px"
        >
          Card content
        </SurfaceCard>,
      );
    });
    const card = container.querySelector<HTMLElement>('[data-testid="card"]');
    assert.ok(card);
    assert.equal(card.textContent, 'Card content');
    assert.equal(card.style.borderWidth, '1px');
    assert.equal(card.style.borderStyle, 'solid');
    assert.equal(card.style.borderRadius, '16px');
    assert.equal(card.style.boxShadow, 'none');
  });
});
