import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { PortfolioScopeOption } from './types';

type ScopeChooserModule = typeof import('./ScopeChooser');

const CHOICES: readonly PortfolioScopeOption[] = [
  {
    id: 'company-a',
    kind: 'portfolio',
    eyebrow: 'Portfolio',
    name: 'Company A',
    secondaryLabel: '3 authorized hotels',
  },
  {
    id: 'company-b',
    kind: 'portfolio',
    eyebrow: 'Portfolio',
    name: 'Company B',
    secondaryLabel: '2 authorized hotels',
  },
  {
    id: 'hotel-c',
    kind: 'hotel',
    eyebrow: 'Hotel',
    name: 'Hotel C',
    secondaryLabel: 'North region',
  },
];

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
  'KeyboardEvent',
  'MouseEvent',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
] as const;

let chooserModulePromise: Promise<ScopeChooserModule> | null = null;

function loadChooserModule(): Promise<ScopeChooserModule> {
  if (chooserModulePromise) return chooserModulePromise;
  const nodeRequire = createRequire(import.meta.url);
  const extensions = nodeRequire.extensions as Record<
    string,
    (module: NodeModule, filename: string) => void
  >;
  const originalCssLoader = extensions['.css'];
  extensions['.css'] = (module) => { module.exports = {}; };
  chooserModulePromise = import('./ScopeChooser').finally(() => {
    if (originalCssLoader) extensions['.css'] = originalCssLoader;
    else delete extensions['.css'];
  });
  return chooserModulePromise;
}

function installBrowser(): { restore(): void } {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/portfolio/choose',
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();

  for (const key of DOM_GLOBALS) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const candidate = dom.window[key as keyof typeof dom.window];
    const value = typeof candidate === 'function' && (
      key === 'requestAnimationFrame'
      || key === 'cancelAnimationFrame'
      || key === 'getComputedStyle'
    )
      ? candidate.bind(dom.window)
      : candidate;
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  const actFlag = 'IS_REACT_ACT_ENVIRONMENT';
  originals.set(actFlag, Object.getOwnPropertyDescriptor(globalThis, actFlag));
  Object.defineProperty(globalThis, actFlag, {
    configurable: true,
    writable: true,
    value: true,
  });

  return {
    restore() {
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

async function nextAnimationFrame(): Promise<void> {
  await new Promise<void>((resolve) => { window.requestAnimationFrame(() => resolve()); });
}

async function render(root: Root, element: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
}

describe('ScopeChooser client accessibility', { concurrency: false }, () => {
  test('arrow keys move the local radio state without committing navigation', async () => {
    const browser = installBrowser();
    const { ScopeChooser } = await loadChooserModule();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const committed: string[] = [];

    try {
      await render(root, (
        <ScopeChooser
          variant="page"
          title="Choose how you’re working"
          choices={CHOICES}
          selectedId="company-a"
          onSelect={(choice) => committed.push(choice.id)}
        />
      ));

      const radios = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
      assert.equal(radios.length, 3);
      radios[0].focus();

      await act(async () => {
        radios[0].dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        }));
      });

      assert.deepEqual(committed, [], 'arrowing must not activate a route selection');
      assert.equal(document.activeElement, radios[1]);
      assert.equal(radios[0].getAttribute('aria-checked'), 'false');
      assert.equal(radios[0].tabIndex, -1);
      assert.equal(radios[1].getAttribute('aria-checked'), 'true');
      assert.equal(radios[1].tabIndex, 0);

      await act(async () => {
        radios[1].dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }));
      });
      assert.deepEqual(committed, ['company-b']);

      await act(async () => {
        radios[1].dispatchEvent(new KeyboardEvent('keydown', {
          key: ' ',
          bubbles: true,
          cancelable: true,
        }));
      });
      assert.deepEqual(committed, ['company-b', 'company-b']);

      await act(async () => { radios[2].click(); });
      assert.deepEqual(committed, ['company-b', 'company-b', 'hotel-c']);
      assert.equal(radios[2].getAttribute('aria-checked'), 'true');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      browser.restore();
    }
  });

  test('loading and passive-empty dialogs focus and trap on the panel, then restore focus', async () => {
    const browser = installBrowser();
    const { ScopeChooser } = await loadChooserModule();
    const trigger = document.createElement('button');
    trigger.textContent = 'Open contexts';
    document.body.append(trigger);
    trigger.focus();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      for (const state of ['loading', 'empty'] as const) {
        await render(root, (
          <ScopeChooser
            variant="dialog"
            open
            title="Switch context"
            choices={[]}
            onSelect={() => {}}
            state={state}
            stateContent={state === 'empty' ? {
              title: 'No contexts are available',
              description: 'Your current access is unchanged.',
            } : undefined}
          />
        ));
        await act(nextAnimationFrame);

        const panel = container.querySelector<HTMLElement>('[role="dialog"]');
        assert.ok(panel);
        assert.equal(panel.tabIndex, -1);
        assert.equal(document.activeElement, panel);

        const tabEvent = new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        });
        await act(async () => { panel.dispatchEvent(tabEvent); });
        assert.equal(tabEvent.defaultPrevented, true);
        assert.equal(document.activeElement, panel);

        await render(root, (
          <ScopeChooser
            variant="dialog"
            open={false}
            title="Switch context"
            choices={[]}
            onSelect={() => {}}
          />
        ));
        assert.equal(document.activeElement, trigger);
        trigger.focus();
      }
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      trigger.remove();
      browser.restore();
    }
  });

  test('dialog close control has a contextual default accessible name', async () => {
    const browser = installBrowser();
    const { ScopeChooser } = await loadChooserModule();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await render(root, (
        <ScopeChooser
          variant="dialog"
          title="Switch acting context"
          choices={[]}
          onSelect={() => {}}
          onClose={() => {}}
          state="loading"
        />
      ));
      assert.ok(container.querySelector('button[aria-label="Close Switch acting context"]'));
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      browser.restore();
    }
  });

  test('dialog tab order excludes inactive roving radios', async () => {
    const browser = installBrowser();
    const { ScopeChooser } = await loadChooserModule();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await render(root, (
        <ScopeChooser
          variant="dialog"
          open
          title="Switch context"
          choices={CHOICES}
          selectedId="company-a"
          onSelect={() => {}}
        />
      ));
      await act(nextAnimationFrame);

      const radios = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
      assert.equal(radios[0].tabIndex, 0);
      assert.equal(radios[1].tabIndex, -1);
      assert.equal(radios[2].tabIndex, -1);
      assert.equal(document.activeElement, radios[0]);

      for (const shiftKey of [false, true]) {
        const event = new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey,
          bubbles: true,
          cancelable: true,
        });
        await act(async () => { radios[0].dispatchEvent(event); });
        assert.equal(event.defaultPrevented, true);
        assert.equal(document.activeElement, radios[0]);
      }
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      browser.restore();
    }
  });

  test('closing discards uncommitted arrow exploration before reopen', async () => {
    const browser = installBrowser();
    const { ScopeChooser } = await loadChooserModule();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let closeCount = 0;
    const chooser = (open: boolean) => (
      <ScopeChooser
        variant="dialog"
        open={open}
        title="Switch context"
        choices={CHOICES}
        selectedId="company-a"
        onSelect={() => {}}
        onClose={() => { closeCount += 1; }}
      />
    );

    try {
      await render(root, chooser(true));
      await act(nextAnimationFrame);
      let radios = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
      radios[0].focus();
      await act(async () => {
        radios[0].dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        }));
      });
      assert.equal(radios[1].getAttribute('aria-checked'), 'true');

      const panel = container.querySelector<HTMLElement>('[role="dialog"]');
      assert.ok(panel);
      await act(async () => {
        panel.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }));
      });
      assert.equal(closeCount, 1);
      await render(root, chooser(false));
      await render(root, chooser(true));
      await act(nextAnimationFrame);

      radios = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
      assert.equal(radios[0].getAttribute('aria-checked'), 'true');
      assert.equal(radios[1].getAttribute('aria-checked'), 'false');
      assert.equal(document.activeElement, radios[0]);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      browser.restore();
    }
  });
});
