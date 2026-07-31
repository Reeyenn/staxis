/**
 * Admin "create a hotel and invite its first person in one motion".
 *
 * These exercise the real AddHotelModal against a recorded request seam, so
 * they fail on the behavior that matters rather than on renamed source text:
 *
 *   1. An email in the new field must reach the EXISTING first-person invite
 *      route exactly once. There is one invite system; a clone would show up
 *      here as a different URL or a second call.
 *   2. A blank email must send nothing at all and keep the People pointer.
 *   3. A create that succeeds while its invite fails must say exactly that,
 *      must never claim an invitation went out, and must let the admin retry
 *      the invitation WITHOUT creating a second hotel.
 *   4. A malformed email must be rejected before the create fires, so a typo
 *      cannot leave an orphan hotel behind (the create is not idempotent).
 *
 * The last test covers the admin Onboarding journey label, which reads the
 * `invitedEmail` the guarded mint stamps onto the hotel: a hotel created WITH
 * an invitation must start at "Invitation ready", not at the pointer state.
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
  'Node',
  'Event',
  'InputEvent',
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

/** Load a studio module with CSS-module imports neutralized (MapsManager, which
 *  OnboardingSurface pulls in, imports a .module.css). */
function loadStudioModule<T>(specifier: () => Promise<T>): Promise<T> {
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
  addHotelPromise ??= loadStudioModule(
    () => import('@/app/admin/_components/studio/AddHotelModal'),
  );
  return addHotelPromise;
}

let onboardingPromise: Promise<OnboardingModule> | null = null;
function loadOnboarding(): Promise<OnboardingModule> {
  onboardingPromise ??= loadStudioModule(
    () => import('@/app/admin/_components/studio/surfaces/OnboardingSurface'),
  );
  return onboardingPromise;
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
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

interface RecordedCall { method: string; url: string; body: unknown }

/** Records every request the modal makes and answers from the given handlers.
 *  An unmatched URL fails loudly instead of silently succeeding. */
function recorder(handlers: Record<string, () => Response>): {
  calls: RecordedCall[];
  request: Requester;
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    request: async (input, init) => {
      const url = String(input);
      let body: unknown = null;
      if (typeof init?.body === 'string') {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
      }
      calls.push({ method: init?.method ?? 'GET', url, body });
      const handler = handlers[url];
      if (!handler) return jsonResponse({ ok: false, error: `Unexpected request ${url}` }, 500);
      return handler();
    },
  };
}

const createOk = () => jsonResponse(
  { ok: true, data: { propertyId: HOTEL_ID, name: 'Harbor Inn' } },
  201,
);
const inviteOk = (emailSent = true) => jsonResponse({
  ok: true,
  data: {
    hotelId: HOTEL_ID,
    invitedEmail: 'gm@harbor.test',
    assignedRole: 'owner',
    signupUrl: SIGNUP_URL,
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    emailSent,
    emailError: emailSent ? null : 'Mail provider unavailable',
  },
}, 201);

const CREATE_URL = '/api/admin/properties/create';
const INVITE_URL = '/api/admin/properties/invite-first-person';

interface Harness {
  container: HTMLElement;
  createdWith: string[];
  type(label: string, value: string): Promise<void>;
  choose(label: string, value: string): Promise<void>;
  click(text: string): Promise<void>;
  text(): string;
  link(): HTMLAnchorElement | null;
  /** The onboarding link lives in an input value, which textContent never sees. */
  signupLink(): string | null;
}

async function mountModal(
  context: TestContext,
  request: Requester,
): Promise<Harness> {
  const restoreBrowser = installBrowser();
  const { AddHotelModal } = await loadAddHotel();
  // The modal pulls in the authenticated fetch helper, which pulls in the
  // Supabase browser client. Its token auto-refresh timer would otherwise keep
  // the test process alive after the last assertion.
  const { supabase } = await import('@/lib/supabase');
  supabase.auth.stopAutoRefresh();
  const { createRoot } = await import('react-dom/client');
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

  return {
    container,
    createdWith,
    async type(label, value) {
      const input = container.querySelector(`input[aria-label="${label}"]`);
      assert.ok(input, `input "${label}" must render`);
      await setValue(input, value, 'input');
    },
    async choose(label, value) {
      const select = container.querySelector(`select[aria-label="${label}"]`);
      assert.ok(select, `select "${label}" must render`);
      await setValue(select, value, 'select');
    },
    async click(text) {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => (candidate.textContent ?? '').includes(text),
      );
      assert.ok(button, `button "${text}" must render`);
      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
      });
      await flush();
    },
    text: () => container.textContent ?? '',
    link: () => container.querySelector<HTMLAnchorElement>('a[href*="tab=people"]'),
    signupLink: () => container.querySelector<HTMLInputElement>(
      'input[aria-label="First-person onboarding link"]',
    )?.value ?? null,
  };
}

describe('Add hotel: create and invite in one motion', { concurrency: false }, () => {
  test('an entered first person is invited through the existing invite route, exactly once', async (context) => {
    const { calls, request } = recorder({
      [CREATE_URL]: createOk,
      [INVITE_URL]: () => inviteOk(true),
    });
    const ui = await mountModal(context, request);

    await ui.type('Hotel name (optional)', 'Harbor Inn');
    await ui.type("First person's email (optional)", '  GM@Harbor.test  ');
    await ui.choose("First person's role", 'general_manager');
    await ui.click('Create hotel and invite');

    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      [`POST ${CREATE_URL}`, `POST ${INVITE_URL}`],
      'the create runs first, then the one existing invite route',
    );
    assert.equal(
      calls.filter((call) => call.url === INVITE_URL).length,
      1,
      'exactly one invitation is sent',
    );
    assert.deepEqual(calls[1].body, {
      hotelId: HOTEL_ID,
      email: 'gm@harbor.test',
      role: 'general_manager',
    }, 'the invite body matches the People control contract, normalized');
    assert.deepEqual(ui.createdWith, [HOTEL_ID], 'the fleet refetches with the new hotel');
    assert.match(ui.text(), /Invitation sent/);
    assert.match(ui.text(), /gm@harbor\.test/);
    assert.equal(ui.signupLink(), SIGNUP_URL, 'the onboarding link is available to copy');
  });

  test('a blank first person sends no invitation and keeps the People pointer', async (context) => {
    const { calls, request } = recorder({ [CREATE_URL]: createOk });
    const ui = await mountModal(context, request);

    await ui.type('Hotel name (optional)', 'Harbor Inn');
    await ui.click('Create hotel');

    assert.deepEqual(
      calls.map((call) => call.url),
      [CREATE_URL],
      'no invitation machinery runs when the field is left blank',
    );
    assert.doesNotMatch(ui.text(), /Invitation sent|Invitation ready/);
    assert.match(ui.text(), /Add the first person from the hotel/);
    assert.equal(ui.container.querySelector('select'), null, 'the role picker stays hidden');
  });

  test('a created hotel whose invitation failed says so, points at People, and retries only the invitation', async (context) => {
    let inviteShouldFail = true;
    const { calls, request } = recorder({
      [CREATE_URL]: createOk,
      [INVITE_URL]: () => (inviteShouldFail
        ? jsonResponse({ ok: false, error: 'First-person invitations are temporarily unavailable' }, 503)
        : inviteOk(true)),
    });
    const ui = await mountModal(context, request);

    await ui.type("First person's email (optional)", 'gm@harbor.test');
    await ui.click('Create hotel and invite');

    assert.match(ui.text(), /The hotel was created\. The invitation was not sent\./);
    assert.match(ui.text(), /First-person invitations are temporarily unavailable/);
    assert.match(ui.text(), /Nobody has been emailed/);
    assert.doesNotMatch(ui.text(), /Invitation sent/, 'never claims an invitation went out');
    assert.deepEqual(ui.createdWith, [HOTEL_ID], 'the hotel is still real and still surfaced');
    const peopleLink = ui.link();
    assert.ok(peopleLink, 'the failure state points at the exact hotel People control');
    assert.equal(peopleLink.getAttribute('href'), `/company?tab=people&pid=${HOTEL_ID}`);

    inviteShouldFail = false;
    await ui.click('Send invitation again');

    assert.equal(
      calls.filter((call) => call.url === CREATE_URL).length,
      1,
      'the retry never creates a second hotel',
    );
    assert.equal(calls.filter((call) => call.url === INVITE_URL).length, 2);
    assert.match(ui.text(), /Invitation sent/);
    assert.doesNotMatch(ui.text(), /The invitation was not sent/);
  });

  test('a created invitation whose email bounced is not reported as sent', async (context) => {
    const { request } = recorder({
      [CREATE_URL]: createOk,
      [INVITE_URL]: () => inviteOk(false),
    });
    const ui = await mountModal(context, request);

    await ui.type("First person's email (optional)", 'gm@harbor.test');
    await ui.click('Create hotel and invite');

    assert.match(ui.text(), /Invitation ready, email not delivered/);
    assert.doesNotMatch(ui.text(), /Invitation sent/);
    assert.equal(ui.signupLink(), SIGNUP_URL, 'the link is the recovery path when mail fails');
  });

  test('a malformed first-person email is rejected before any hotel is created', async (context) => {
    const { calls, request } = recorder({
      [CREATE_URL]: createOk,
      [INVITE_URL]: () => inviteOk(true),
    });
    const ui = await mountModal(context, request);

    await ui.type('Hotel name (optional)', 'Harbor Inn');
    await ui.type("First person's email (optional)", 'gm@harbor');
    await ui.click('Create hotel and invite');

    assert.deepEqual(calls, [], 'no hotel is left behind by a doomed submission');
    assert.deepEqual(ui.createdWith, []);
    assert.match(
      ui.container.querySelector('[role="alert"]')?.textContent ?? '',
      /valid email for the first person/,
    );
  });
});

describe('Admin onboarding journey reflects a create-time invitation', { concurrency: false }, () => {
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

      const invited = journeyOf({
        ...base,
        onboardingState: { step: 1, invitedEmail: 'gm@harbor.test' },
      });
      assert.equal(invited.step, 1);
      assert.equal(invited.label, 'Invitation ready');
      assert.doesNotMatch(invited.sub, /People control/);

      const uninvited = journeyOf({ ...base, onboardingState: { step: 1 } });
      assert.equal(uninvited.step, 1);
      assert.equal(uninvited.label, 'Waiting for first person');
      assert.match(uninvited.sub, /People control/);
    } finally {
      restoreBrowser();
    }
  });
});
