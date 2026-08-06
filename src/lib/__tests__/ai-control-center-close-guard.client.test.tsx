/**
 * CLOSING THE CONTROL CENTER MUST NOT EAT YOUR PICKS.
 *
 * A model pick on this screen is a DRAFT until it has been tested and made
 * live. The drafts live in the component and nowhere else, so closing the
 * screen throws them away — which is exactly what happened: a whole screen of
 * picks was made, the screen was closed, and everything went silently.
 *
 * So the three ways out (the X, Escape, and a click on the backdrop) now stop
 * once and ask, and this file holds all three plus the two things that make the
 * question worth asking at all: it does NOT appear when there is nothing to
 * lose, and "Keep editing" really does keep the screen open.
 *
 * Mounts the REAL component against a stubbed transport. Nothing here asserts
 * on source text: it clicks the same buttons a person clicks and reads what the
 * DOM says afterwards.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Imported BEFORE jsdom is installed, so the singleton Supabase client stays in
// its quiet non-browser test mode. Pulled in after the globals exist, it starts
// a token refresh and a realtime socket and the test process never exits.
import { supabase } from '@/lib/supabase';

type ControlCenterModule = typeof import('@/app/admin/_components/AIControlCenter');

const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'Element',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'Node',
  'Event',
  'EventTarget',
  'MouseEvent',
  'KeyboardEvent',
  'FocusEvent',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
] as const;

let modulePromise: Promise<ControlCenterModule> | null = null;

/** The component imports a CSS module; node cannot parse one. */
function loadControlCenter(): Promise<ControlCenterModule> {
  if (modulePromise) return modulePromise;
  const nodeRequire = createRequire(import.meta.url);
  const extensions = nodeRequire.extensions as Record<
    string,
    (module: NodeModule, filename: string) => void
  >;
  const originalCssLoader = extensions['.css'];
  extensions['.css'] = (module) => { module.exports = {}; };
  modulePromise = import('@/app/admin/_components/AIControlCenter').finally(() => {
    if (originalCssLoader) extensions['.css'] = originalCssLoader;
    else delete extensions['.css'];
  });
  return modulePromise;
}

function installBrowser(): () => void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/admin',
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

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, requestId: 'close-guard-test', data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PRIMARY = {
  provider: 'anthropic' as const,
  modelId: 'claude-test-primary',
  displayName: 'Claude Test Primary',
  pricing: null,
};

const FEATURE = {
  key: 'agent.ask_staxis' as const,
  label: 'Ask Staxis',
  description: 'The chat a manager types into.',
  group: 'Agent' as const,
  runtimeProvider: 'anthropic' as const,
  runtimeProviders: ['anthropic'] as const,
  editable: true,
  switchable: true,
  modelSwitchable: true,
  fallbackAllowed: true,
  availability: 'available' as const,
  requiredCapabilities: ['text' as const],
  defaultConfig: { enabled: true, primary: PRIMARY, fallback: null, parameters: {} },
  activeConfig: {
    featureKey: 'agent.ask_staxis' as const,
    enabled: true,
    primary: PRIMARY,
    fallback: null,
    parameters: {},
    source: 'database' as const,
    versionId: 'version-1',
    version: 1,
  },
};

type SessionReader = { getSession(): Promise<{ data: { session: null }; error: null }> };

function stubTransport(context: TestContext): void {
  // Without this, fetchWithAuth asks the real client for a token.
  context.mock.method(
    supabase.auth as unknown as SessionReader,
    'getSession',
    async () => ({ data: { session: null }, error: null }),
  );
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/features')) {
        return envelope({
          features: [FEATURE],
          providers: ['anthropic'],
          generatedAt: '2026-08-06T00:00:00.000Z',
        });
      }
      if (url.includes('/models')) {
        return envelope({ models: [], provider: null, configuredProviders: ['anthropic'] });
      }
      if (url.includes('/configs')) return envelope({ configs: [], featureKey: null });
      return envelope({});
    },
  });
  context.after(() => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true, writable: true, value: originalFetch,
    });
  });
}

async function settle(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

async function mouseDown(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

async function escape(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }));
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

function byLabel(label: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  assert.ok(node, `no element labelled "${label}"`);
  return node;
}

function buttonSaying(text: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((node) => (node.textContent ?? '').trim() === text) ?? null;
}

function warningShown(): boolean {
  return document.querySelector('[data-testid="ai-control-discard-confirm"]') !== null;
}

function screenOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-labelledby="ai-control-title"]') !== null;
}

/** Mount, open the screen, and hand back the scrim the backdrop test clicks. */
async function openControlCenter(context: TestContext): Promise<HTMLButtonElement> {
  const restoreBrowser = installBrowser();
  stubTransport(context);
  const { AIControlCenter } = await loadControlCenter();
  supabase.auth.stopAutoRefresh();
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(<AIControlCenter />); });
  await settle();

  const trigger = container.querySelector<HTMLButtonElement>('button');
  assert.ok(trigger, 'the control center trigger did not render');
  await click(trigger);
  await settle();
  assert.ok(screenOpen(), 'the control center did not open');

  context.after(async () => {
    supabase.auth.stopAutoRefresh();
    await act(async () => { root.unmount(); });
    container.remove();
    restoreBrowser();
  });
  return trigger;
}

/** Stage a change without testing or activating it: the exact thing at risk. */
async function makeAnUntestedPick(): Promise<void> {
  await click(byLabel(`Disable ${FEATURE.label}`));
  await settle();
  assert.ok(
    (document.body.textContent ?? '').includes('1 unsaved'),
    'the fixture did not actually leave an unsaved pick behind',
  );
}

describe('closing the control center with untested picks', { concurrency: false }, () => {
  test('the X asks before throwing the picks away, and Keep editing stays put', async (context) => {
    await openControlCenter(context);
    await makeAnUntestedPick();

    await click(byLabel('Close AI Control Center'));
    await settle();
    assert.ok(warningShown(), 'closing with untested picks did not warn');
    assert.ok(screenOpen(), 'the screen closed even though it had asked a question');
    assert.match(
      document.querySelector('[data-testid="ai-control-discard-confirm"]')?.textContent ?? '',
      /never tested/i,
    );

    const keepEditing = buttonSaying('Keep editing');
    assert.ok(keepEditing, 'there was no way back from the warning');
    await click(keepEditing);
    await settle();
    assert.equal(warningShown(), false, 'Keep editing left the warning on screen');
    assert.ok(screenOpen(), 'Keep editing closed the screen');
    assert.ok(
      (document.body.textContent ?? '').includes('1 unsaved'),
      'Keep editing kept the screen but dropped the pick',
    );
  });

  test('Close and lose them is the only way out, and it does close', async (context) => {
    const trigger = await openControlCenter(context);
    await makeAnUntestedPick();

    await click(byLabel('Close AI Control Center'));
    await settle();
    const discard = buttonSaying('Close and lose them');
    assert.ok(discard, 'the warning offered no way to close');
    await click(discard);
    await settle();
    assert.equal(screenOpen(), false, 'answering the question did not close the screen');

    // And the picks really are gone. Telling somebody their work was thrown
    // away and then handing it back is the same lie the other way round.
    await click(trigger);
    await settle();
    assert.ok(screenOpen(), 'the screen did not reopen');
    assert.equal(
      (document.body.textContent ?? '').includes('unsaved'), false,
      'the picks came back after being described as lost',
    );
  });

  test('Escape asks too, and a second Escape means keep editing', async (context) => {
    await openControlCenter(context);
    await makeAnUntestedPick();

    await escape();
    await settle();
    assert.ok(warningShown(), 'Escape threw the picks away without asking');
    assert.ok(screenOpen(), 'Escape closed the screen with picks staged');

    await escape();
    await settle();
    assert.equal(warningShown(), false, 'Escape did not answer its own question');
    assert.ok(screenOpen(), 'Escape past the warning closed the screen anyway');
  });

  test('a click on the backdrop asks too', async (context) => {
    await openControlCenter(context);
    await makeAnUntestedPick();

    const scrim = document.querySelector('[data-testid="ai-control-scrim"]');
    assert.ok(scrim, 'the backdrop did not render');
    await mouseDown(scrim);
    await settle();
    assert.ok(warningShown(), 'the backdrop threw the picks away without asking');
    assert.ok(screenOpen(), 'the backdrop closed the screen with picks staged');
  });

  test('with nothing staged, closing is still one click', async (context) => {
    await openControlCenter(context);
    assert.equal(
      (document.body.textContent ?? '').includes('unsaved'), false,
      'the fixture started dirty, so this proves nothing',
    );

    await click(byLabel('Close AI Control Center'));
    await settle();
    assert.equal(warningShown(), false, 'a clean screen asked a question it had no reason to ask');
    assert.equal(screenOpen(), false, 'a clean screen did not close on the first click');
  });
});
