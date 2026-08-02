import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';

import { restoreDialogFocus } from '@/app/company/_components/dialog-focus';

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
    url: 'http://localhost/company?tab=people',
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();

  for (const key of DOM_GLOBALS) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const candidate = dom.window[key as keyof typeof dom.window];
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: candidate,
    });
  }

  return () => {
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

function focusRef(element: HTMLElement | null): { current: HTMLElement | null } {
  return { current: element };
}

function heading(): HTMLHeadingElement {
  const element = document.createElement('h2');
  element.tabIndex = -1;
  document.body.append(element);
  return element;
}

function button(): HTMLButtonElement {
  const element = document.createElement('button');
  document.body.append(element);
  return element;
}

function restoreAfter(testContext: TestContext): void {
  testContext.after(installBrowser());
}

describe('dialog focus restoration priority', { concurrency: false }, () => {
  test('usable explicit return focus wins over previous focus and heading', (context) => {
    restoreAfter(context);
    const explicit = button();
    const previous = button();
    const fallback = heading();
    previous.focus();

    restoreDialogFocus(focusRef(explicit), focusRef(fallback), previous);

    assert.equal(document.activeElement, explicit);
  });

  test('usable captured previous focus wins when explicit return is stale', (context) => {
    restoreAfter(context);
    const staleExplicit = document.createElement('button');
    const previous = button();
    const fallback = heading();
    previous.focus();

    restoreDialogFocus(focusRef(staleExplicit), focusRef(fallback), previous);

    assert.equal(document.activeElement, previous);
  });

  test('disabled or disconnected previous focus falls back to the heading', (context) => {
    restoreAfter(context);
    const disabledPrevious = button();
    disabledPrevious.disabled = true;
    const fallback = heading();

    restoreDialogFocus(undefined, focusRef(fallback), disabledPrevious);
    assert.equal(document.activeElement, fallback);

    const disconnectedPrevious = document.createElement('button');
    restoreDialogFocus(undefined, focusRef(fallback), disconnectedPrevious);
    assert.equal(document.activeElement, fallback);
  });

  test('body is never selected as a return target', (context) => {
    restoreAfter(context);
    const originalFocus = document.body.focus;
    let bodyFocusCalls = 0;
    document.body.focus = () => { bodyFocusCalls += 1; };

    restoreDialogFocus(undefined, focusRef(document.body), document.body);

    document.body.focus = originalFocus;
    assert.equal(bodyFocusCalls, 0);
  });
});
