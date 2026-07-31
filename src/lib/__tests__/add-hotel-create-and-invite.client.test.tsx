/**
 * Admin "create a hotel, then invite from the confirmation".
 *
 * The create FORM asks nothing about people (founder ruling 2026-07-31, revised
 * after seeing the email-in-form version live). The confirmation offers "Invite
 * people", which opens the SAME dialog the My Hotel → People control opens for
 * a hotel with no direct account yet, scoped to the hotel just created.
 *
 * These drive the real components against a recorded transport, so they fail on
 * behavior rather than on renamed source text:
 *
 *   1. The form collects no person and the create sends exactly one request.
 *   2. "Invite people" opens the real dialog bound to the NEW hotel id, and
 *      sending posts to the one existing first-person invite route. A clone
 *      would show up here as a different URL or a different hotel id.
 *   3. Completing the dialog reports the outcome on the confirmation, and an
 *      undelivered email is not reported as sent.
 *   4. Opening the dialog and dismissing it invites nobody and leaves the
 *      invite-later pointer standing.
 *
 * The last test covers the admin Onboarding journey label for both paths: a
 * hotel invited now vs. one left for later.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
// react-dom must be imported AFTER a DOM exists: it latches `canUseDOM` at
// module load, and loading it first makes React fall back to its IE
// propertychange polyfill, which calls attachEvent on every typed character.
import type { Root } from 'react-dom/client';

import type { AddHotelModalProps } from '@/app/admin/_components/studio/AddHotelModal';

type AddHotelModule = typeof import('@/app/admin/_components/studio/AddHotelModal');
type OnboardingModule = typeof import('@/app/admin/_components/studio/surfaces/OnboardingSurface');
type Requester = NonNullable<AddHotelModalProps['request']>;

const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'HTMLButtonElement',
  'HTMLAnchorElement',
  'HTMLFormElement',
  'Node',
  'Event',
  'InputEvent',
  'SubmitEvent',
  'EventTarget',
  'MouseEvent',
  'KeyboardEvent',
  'FocusEvent',
  // Supabase's browser client opens a cross-tab BroadcastChannel on load.
  // Node's own global would outlive the test and hold the event loop open;
  // JSDOM's is torn down by window.close().
  'BroadcastChannel',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
] as const;

const HOTEL_ID = '33333333-3333-4333-8333-333333333333';
const SIGNUP_URL = 'https://staxis.test/onboard?code=HARBOR-4821';
const CREATE_URL = '/api/admin/properties/create';
const INVITE_URL = '/api/admin/properties/invite-first-person';

/** Load a module with CSS-module imports neutralized (the invite dialog and
 *  MapsManager both import a .module.css). */
function loadWithCssShim<T>(specifier: () => Promise<T>): Promise<T> {
  const nodeRequire = createRequire(import.meta.url);
  const extensions = nodeRequire.extensions as Record<
    string,
    (module: NodeModule, filename: string) => void
  >;
  const originalCssLoader = extensions['.css'];
  extensions['.css'] = (module) => { module.exports = {}; };
  return specifier().finally(() => {
    if (originalCssLoader) extensions['.css'] = originalCssLoader;
    else delete extensions['.css'];
  });
}

let addHotelPromise: Promise<AddHotelModule> | null = null;
function loadAddHotel(): Promise<AddHotelModule> {
  addHotelPromise ??= loadWithCssShim(
    () => import('@/app/admin/_components/studio/AddHotelModal'),
  );
  return addHotelPromise;
}

let onboardingPromise: Promise<OnboardingModule> | null = null;
function loadOnboarding(): Promise<OnboardingModule> {
  onboardingPromise ??= loadWithCssShim(
    () => import('@/app/admin/_components/studio/surfaces/OnboardingSurface'),
  );
  return onboardingPromise;
}

/** The dialog is a lazy import inside the modal. Preloading it with the CSS
 *  shim installed keeps Suspense from resolving mid-assertion. */
let dialogPromise: Promise<unknown> | null = null;
function loadInviteDialog(): Promise<unknown> {
  dialogPromise ??= loadWithCssShim(
    () => import('@/app/company/_components/HotelTeamDialogs'),
  );
  return dialogPromise;
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 14; index += 1) await Promise.resolve();
  });
}

interface RecordedCall { method: string; url: string; body: unknown }

const createOk = () => jsonResponse(
  { ok: true, data: { propertyId: HOTEL_ID, name: 'Harbor Inn' } },
  201,
);
const inviteOk = (emailSent = true) => jsonResponse({
  ok: true,
  data: {
    hotelId: HOTEL_ID,
    invitedEmail: 'gm@harbor.test',
    assignedRole: 'general_manager',
    signupUrl: SIGNUP_URL,
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    emailSent,
    emailError: emailSent ? null : 'Mail provider unavailable',
  },
}, 201);

interface Harness {
  container: HTMLElement;
  calls: RecordedCall[];
  createdWith: string[];
  type(label: string, value: string): Promise<void>;
  click(text: string): Promise<void>;
  buttonEl(text: string): HTMLButtonElement;
  press(element: Element): Promise<void>;
  /** The portalled invite dialog, or null when it is not open. */
  dialog(): HTMLElement | null;
  /** Fill and submit the invite dialog exactly as an admin would. */
  sendInvite(email: string, role: string): Promise<void>;
  /** Swap the transport mid-test (used to hold a request open). */
  setTransport(next: (url: string, init?: RequestInit) => Promise<Response>): void;
  text(): string;
  peopleLink(): HTMLAnchorElement | null;
}

async function mountModal(
  context: TestContext,
  handlers: Record<string, () => Response>,
): Promise<Harness> {
  const restoreBrowser = installBrowser();
  const { AddHotelModal } = await loadAddHotel();
  await loadInviteDialog();
  // The modal pulls in the authenticated fetch helper, which pulls in the
  // Supabase browser client. Its token auto-refresh timer would otherwise keep
  // the test process alive after the last assertion.
  const { supabase } = await import('@/lib/supabase');
  supabase.auth.stopAutoRefresh();
  const { createRoot } = await import('react-dom/client');

  const calls: RecordedCall[] = [];
  let transport: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
  const answer = async (url: string, init?: RequestInit): Promise<Response> => {
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ method: init?.method ?? 'GET', url, body });
    if (transport) return transport(url, init);
    const handler = handlers[url];
    if (!handler) return jsonResponse({ ok: false, error: `Unexpected request ${url}` }, 500);
    return handler();
  };

  // The modal's create goes through its injected seam. The DIALOG owns its own
  // transport (fetchWithAuth -> global fetch), which is exactly the point: the
  // test cannot fake the dialog's route, so the assertions below prove the real
  // invite route was called.
  const request: Requester = async (input, init) => answer(String(input), init);
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => answer(String(input), init),
  });

  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  const createdWith: string[] = [];
  await act(async () => {
    root.render(
      <AddHotelModal
        onClose={() => undefined}
        onCreated={(propertyId) => { createdWith.push(propertyId); }}
        request={request}
      />,
    );
  });

  context.after(async () => {
    supabase.auth.stopAutoRefresh();
    await act(async () => { root.unmount(); });
    container.remove();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true, writable: true, value: originalFetch,
    });
    restoreBrowser();
  });

  const setValue = async (element: Element, value: string, proto: 'input' | 'select') => {
    const prototype = proto === 'input'
      ? window.HTMLInputElement.prototype
      : window.HTMLSelectElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    assert.ok(valueSetter, 'JSDOM value setter must exist');
    await act(async () => {
      valueSetter.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    });
  };

  const press = async (element: Element): Promise<void> => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    await flush();
  };

  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const findButton = (text: string) => Array.from(container.querySelectorAll('button')).find(
    (candidate) => (candidate.textContent ?? '').includes(text),
  );

  return {
    container,
    calls,
    createdWith,
    setTransport(next) { transport = next; },
    async type(label, value) {
      const input = container.querySelector(`input[aria-label="${label}"]`);
      assert.ok(input, `input "${label}" must render`);
      await setValue(input, value, 'input');
    },
    async click(text) {
      const button = findButton(text);
      assert.ok(button, `button "${text}" must render`);
      await press(button);
    },
    buttonEl(text) {
      const button = findButton(text);
      assert.ok(button, `button "${text}" must render`);
      return button;
    },
    press,
    dialog,
    async sendInvite(email, role) {
      const open = dialog();
      assert.ok(open, 'the invite dialog must be open');
      const emailInput = open.querySelector('input[type="email"]');
      const roleSelect = open.querySelector('select');
      const form = open.querySelector('form');
      assert.ok(emailInput, 'the dialog must ask for an email');
      assert.ok(roleSelect, 'the dialog must ask for a role');
      assert.ok(form, 'the dialog must submit a form');
      await setValue(emailInput, email, 'input');
      await setValue(roleSelect, role, 'select');
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        for (let index = 0; index < 12; index += 1) await Promise.resolve();
      });
      await flush();
    },
    text: () => container.textContent ?? '',
    peopleLink: () => container.querySelector<HTMLAnchorElement>('a[href*="tab=people"]'),
  };
}

describe('Add hotel: invite from the confirmation', { concurrency: false }, () => {
  test('the create form asks nothing about people and sends only the create', async (context) => {
    const ui = await mountModal(context, { [CREATE_URL]: createOk });

    assert.equal(
      ui.container.querySelector('input[type="email"]'),
      null,
      'the form must not collect a first person',
    );
    assert.equal(ui.container.querySelector('select'), null, 'no role picker on the form');
    assert.doesNotMatch(ui.text(), /First person/i);
    ui.buttonEl('Create hotel');

    await ui.type('Hotel name (optional)', 'Harbor Inn');
    await ui.click('Create hotel');

    assert.deepEqual(ui.calls.map((call) => call.url), [CREATE_URL]);
    assert.deepEqual(ui.createdWith, [HOTEL_ID], 'the fleet refetches with the new hotel');
    assert.match(ui.text(), /is in your fleet/);
    assert.match(ui.text(), /Invite the first person now or later from People/);
  });

  test('Invite people opens the real People dialog bound to the hotel just created', async (context) => {
    const ui = await mountModal(context, {
      [CREATE_URL]: createOk,
      [INVITE_URL]: () => inviteOk(true),
    });

    await ui.type('Hotel name (optional)', 'Harbor Inn');
    await ui.click('Create hotel');
    assert.equal(ui.dialog(), null, 'the dialog stays shut until asked for');

    await ui.click('Invite people');
    const dialog = ui.dialog();
    assert.ok(dialog, 'the invite dialog opens in place, with no navigation');
    assert.match(dialog.textContent ?? '', /Add first person/);
    assert.match(dialog.textContent ?? '', /Harbor Inn/, 'scoped to the new hotel by name');

    await ui.sendInvite('GM@Harbor.test', 'general_manager');

    const invites = ui.calls.filter((call) => call.url === INVITE_URL);
    assert.equal(invites.length, 1, 'exactly one invitation, through the one existing route');
    assert.deepEqual(invites[0].body, {
      hotelId: HOTEL_ID,
      email: 'gm@harbor.test',
      role: 'general_manager',
    }, 'bound to the new hotel id, normalized, matching the People contract');
  });

  test('completing the dialog reports the invitation on the confirmation', async (context) => {
    const ui = await mountModal(context, {
      [CREATE_URL]: createOk,
      [INVITE_URL]: () => inviteOk(true),
    });

    await ui.click('Create hotel');
    assert.doesNotMatch(ui.text(), /Invitation sent/);

    await ui.click('Invite people');
    await ui.sendInvite('gm@harbor.test', 'general_manager');

    assert.match(ui.text(), /Invitation sent/);
    assert.match(ui.text(), /gm@harbor\.test/);
    assert.match(ui.text(), /General Manager/);
    assert.doesNotMatch(
      ui.text(),
      /Invite the first person now or later/,
      'the invite-later pointer retires once someone is invited',
    );
    // A hotel gets one first-person invitation; the server refuses a second for
    // a different address. Re-offering it here would send the admin at a wall.
    assert.doesNotMatch(ui.text(), /Invite people|Invite someone else/);
    assert.ok(ui.peopleLink(), 'People remains the way to do anything further');
  });

  test('an undelivered invitation email is not reported as sent', async (context) => {
    const ui = await mountModal(context, {
      [CREATE_URL]: createOk,
      [INVITE_URL]: () => inviteOk(false),
    });

    await ui.click('Create hotel');
    await ui.click('Invite people');
    await ui.sendInvite('gm@harbor.test', 'general_manager');

    assert.match(ui.text(), /Invitation ready, email not delivered/);
    assert.doesNotMatch(ui.text(), /Invitation sent/);
  });

  test('opening the dialog and dismissing it invites nobody and keeps the pointer', async (context) => {
    const ui = await mountModal(context, {
      [CREATE_URL]: createOk,
      [INVITE_URL]: () => inviteOk(true),
    });

    await ui.click('Create hotel');
    await ui.click('Invite people');
    assert.ok(ui.dialog());

    const close = document.querySelector<HTMLButtonElement>('[role="dialog"] button');
    assert.ok(close, 'the dialog offers a way out');
    await ui.press(close);

    assert.deepEqual(
      ui.calls.map((call) => call.url),
      [CREATE_URL],
      'dismissing the dialog must invite nobody',
    );
    assert.doesNotMatch(ui.text(), /Invitation sent|Invitation ready/);
    assert.match(ui.text(), /Invite the first person now or later from People/);
    assert.ok(ui.peopleLink(), 'the People control is still offered');
  });

  test('a double-fired submit creates exactly one hotel', async (context) => {
    const ui = await mountModal(context, { [CREATE_URL]: createOk });
    // Hold the create open so the second press lands while the first is still
    // in flight: that is the window the synchronous latch exists to close.
    let releaseCreate: ((response: Response) => void) | null = null;
    const gate = new Promise<Response>((resolve) => { releaseCreate = resolve; });
    ui.setTransport(() => gate);

    const submitButton = ui.buttonEl('Create hotel');
    await ui.press(submitButton);
    await ui.press(submitButton);

    assert.equal(
      ui.calls.filter((call) => call.url === CREATE_URL).length,
      1,
      'the second press must not start a second hotel',
    );

    assert.ok(releaseCreate);
    await act(async () => {
      (releaseCreate as (response: Response) => void)(createOk());
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    await flush();

    assert.equal(ui.calls.filter((call) => call.url === CREATE_URL).length, 1);
    assert.match(ui.text(), /is in your fleet/);
  });
});

describe('Admin onboarding journey reflects both invite paths', { concurrency: false }, () => {
  test('an invited hotel starts at Invitation ready, an uninvited one keeps the People pointer', async () => {
    const restoreBrowser = installBrowser();
    try {
      const { journeyOf } = await loadOnboarding();
      const { supabase } = await import('@/lib/supabase');
      supabase.auth.stopAutoRefresh();
      const base = {
        id: HOTEL_ID,
        name: 'Harbor Inn',
        createdAt: new Date().toISOString(),
        onboardingCompletedAt: null,
      };

      // Invited from the confirmation, or later from People: the guarded mint
      // stamps invitedEmail either way, so the journey reads the same.
      const invited = journeyOf({
        ...base,
        onboardingState: { step: 1, invitedEmail: 'gm@harbor.test' },
      });
      assert.equal(invited.step, 1);
      assert.equal(invited.label, 'Invitation ready');
      assert.doesNotMatch(invited.sub, /People control/);

      // Created and left for later.
      const uninvited = journeyOf({ ...base, onboardingState: { step: 1 } });
      assert.equal(uninvited.step, 1);
      assert.equal(uninvited.label, 'Waiting for first person');
      assert.match(uninvited.sub, /People control/);
    } finally {
      restoreBrowser();
    }
  });
});
