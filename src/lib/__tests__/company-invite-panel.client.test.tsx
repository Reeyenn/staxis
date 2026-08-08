import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import type { Root } from 'react-dom/client';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const HOTEL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOTEL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HOTEL_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const HOTEL_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLInputElement',
  'HTMLSelectElement', 'HTMLButtonElement', 'HTMLFormElement', 'Node', 'Event',
  'InputEvent', 'MouseEvent', 'MutationObserver', 'requestAnimationFrame',
  'cancelAnimationFrame', 'getComputedStyle', 'BroadcastChannel',
] as const;

function installBrowser(): () => void {
  const dom = new JSDOM('<!doctype html><html><body /></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/company?tab=people',
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of DOM_GLOBALS) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const candidate = dom.window[key as keyof typeof dom.window];
    const value = typeof candidate === 'function'
      && (key === 'requestAnimationFrame' || key === 'cancelAnimationFrame' || key === 'getComputedStyle')
      ? candidate.bind(dom.window)
      : candidate;
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  originals.set('IS_REACT_ACT_ENVIRONMENT', Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'));
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  return () => {
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 18; index += 1) await Promise.resolve();
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
  await flush();
}

async function setValue(element: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  const prototype = element instanceof HTMLSelectElement
    ? window.HTMLSelectElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  assert.ok(setter, 'JSDOM should expose a value setter');
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

function listing(organizationId: string, invites: unknown[] = []) {
  const hotels = organizationId === ORG_B
    ? [
        { id: HOTEL_C, name: 'B First Hotel' },
        { id: HOTEL_D, name: 'B Second Hotel' },
      ]
    : [
        { id: HOTEL_A, name: 'First Hotel' },
        { id: HOTEL_B, name: 'Second Hotel' },
      ];
  return {
    ok: true,
    data: {
      invites,
      options: {
        choosesHotels: true,
        organizationId,
        jobs: [{
          value: 'owner',
          scope: 'company',
          label: { en: 'Owner' },
          allowedPropertyIds: hotels.map((hotel) => hotel.id),
        }],
        hotels,
        allowsAllIncludingFuture: false,
      },
    },
  };
}

const pendingAuthorized = {
  id: 'invite-authorized',
  email: 'authorized@example.com',
  role: 'owner',
  status: 'pending',
  isExpired: false,
  propertyNames: ['Second Hotel'],
  canRevoke: true,
};

const pendingUnauthorized = {
  id: 'invite-unauthorized',
  email: 'read-only@example.com',
  role: 'owner',
  status: 'pending',
  isExpired: false,
  propertyNames: ['First Hotel'],
  canRevoke: false,
};

const styles = {
  sectionBlock: 'section',
  headingWithAction: 'heading',
  primaryButton: 'primary',
  listCard: 'list',
};

describe('mounted company invitation panel', { concurrency: false }, () => {
  test('anchors explicit coverage in the selected subset and masks reversed organization responses', async (context) => {
    const restoreBrowser = installBrowser();
    const { supabase } = await import('@/lib/supabase');
    supabase.auth.stopAutoRefresh();
    context.mock.method(
      supabase.auth as unknown as { getSession: () => Promise<unknown> },
      'getSession',
      async () => ({ data: { session: null }, error: null }),
    );
    const { default: CompanyInvitePanel } = await import('@/app/(hotel)/company/_components/CompanyInvitePanel');
    const { createRoot } = await import('react-dom/client');
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, Array<(value: Response) => void>>();
    const postBodies: Array<Record<string, unknown>> = [];
    context.mock.method(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method?.toUpperCase() ?? 'GET';
      if (method === 'POST') {
        postBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Promise.resolve(response({ ok: true }));
      }
      const organizationId = url.searchParams.get('organizationId') ?? '';
      return new Promise<Response>((resolve) => {
        const queue = pending.get(organizationId) ?? [];
        queue.push(resolve);
        pending.set(organizationId, queue);
      });
    });

    const resolveNext = (organizationId: string, value: Response) => {
      const queue = pending.get(organizationId) ?? [];
      queue.shift()?.(value);
      pending.set(organizationId, queue);
    };

    function Switcher() {
      const [organizationId, setOrganizationId] = useState(ORG_A);
      return (
        <>
          <button type="button" onClick={() => setOrganizationId(ORG_B)}>{'Switch organization'}</button>
          <CompanyInvitePanel organizationId={organizationId} styles={styles} />
        </>
      );
    }

    const container = document.createElement('div');
    document.body.append(container);
    const root: Root = createRoot(container);
    context.after(async () => {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: originalFetch });
      await act(async () => { root.unmount(); });
      container.remove();
      restoreBrowser();
    });

    await act(async () => { root.render(<Switcher />); });
    await flush();
    assert.equal(container.querySelector('[role="status"]')?.textContent, 'Loading company invitations…');
    assert.equal(container.querySelector('button.primary'), null, 'loading must not expose an invite action');

    resolveNext(ORG_A, response(listing(ORG_A, [pendingAuthorized])));
    await flush();
    assert.match(container.textContent ?? '', /authorized@example\.com/);

    const inviteButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Invite company person'));
    assert.ok(inviteButton);
    await click(inviteButton);
    const secondHotel = container.querySelector<HTMLInputElement>(`#company-invite-hotel-${HOTEL_B}`);
    assert.ok(secondHotel);
    await click(secondHotel);
    const email = container.querySelector<HTMLInputElement>('#company-invite-email');
    assert.ok(email);
    await setValue(email, 'new@example.com');
    const form = container.querySelector('form');
    assert.ok(form);
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    assert.equal(postBodies[0]?.hotelId, HOTEL_B, 'the selected hotel is the authority anchor');
    assert.deepEqual(postBodies[0]?.propertyIds, [HOTEL_B], 'explicit coverage stays inside the selected subset');

    await click(container.querySelector('button[type="button"]')!);
    await flush();
    assert.equal(container.querySelector('[role="status"]')?.textContent, 'Loading company invitations…');
    assert.doesNotMatch(container.textContent ?? '', /authorized@example\.com/);
    resolveNext(ORG_B, response(listing(ORG_B, [pendingUnauthorized])));
    await flush();
    // The old organization response arrives after the switch and must not win.
    resolveNext(ORG_A, response(listing(ORG_A, [pendingAuthorized])));
    await flush();
    assert.match(container.textContent ?? '', /read-only@example\.com/);
    assert.doesNotMatch(container.textContent ?? '', /authorized@example\.com/);

    const bInviteButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Invite company person'));
    assert.ok(bInviteButton);
    await click(bInviteButton);
    const bSecondHotel = container.querySelector<HTMLInputElement>(`#company-invite-hotel-${HOTEL_D}`);
    assert.ok(bSecondHotel);
    await click(bSecondHotel);
    const bEmail = container.querySelector<HTMLInputElement>('#company-invite-email');
    assert.ok(bEmail);
    await setValue(bEmail, 'b@example.com');
    const bForm = container.querySelector('form');
    assert.ok(bForm);
    await act(async () => { bForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    assert.equal(postBodies[1]?.hotelId, HOTEL_D, 'the switched organization uses an anchor from its own loaded options');
    assert.deepEqual(postBodies[1]?.propertyIds, [HOTEL_D]);
  });

  test('shows initial failures with Retry, and keeps cancellation authorized, confirmed, and honest', async (context) => {
    const restoreBrowser = installBrowser();
    const { supabase } = await import('@/lib/supabase');
    supabase.auth.stopAutoRefresh();
    context.mock.method(
      supabase.auth as unknown as { getSession: () => Promise<unknown> },
      'getSession',
      async () => ({ data: { session: null }, error: null }),
    );
    const { default: CompanyInvitePanel } = await import('@/app/(hotel)/company/_components/CompanyInvitePanel');
    const { createRoot } = await import('react-dom/client');
    const originalFetch = globalThis.fetch;
    let getCount = 0;
    let deleteCount = 0;
    context.mock.method(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method?.toUpperCase() ?? 'GET';
      if (method === 'DELETE') {
        deleteCount += 1;
        return Promise.resolve(response({ ok: false, error: 'The invitation could not be revoked.' }, 503));
      }
      getCount += 1;
      return Promise.resolve(getCount === 1
        ? response({ ok: false, error: 'Company invitations are unavailable right now.' }, 503)
        : response(listing(ORG_A, [pendingAuthorized, pendingUnauthorized])));
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root: Root = createRoot(container);
    context.after(async () => {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: originalFetch });
      await act(async () => { root.unmount(); });
      container.remove();
      restoreBrowser();
    });
    await act(async () => { root.render(<CompanyInvitePanel organizationId={ORG_A} styles={styles} />); });
    await flush();
    assert.ok(container.querySelector('[role="alert"]'));
    assert.ok([...container.querySelectorAll('button')].some((button) => button.textContent === 'Retry'));
    assert.equal(container.querySelector('button.primary'), null, 'failed loading must not leave a stale invite action');

    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry');
    assert.ok(retry);
    await click(retry);
    assert.match(container.textContent ?? '', /authorized@example\.com/);
    const revokeButtons = [...container.querySelectorAll('button')].filter((button) => button.textContent === 'Revoke');
    assert.equal(revokeButtons.length, 1, 'unauthorized rows have no revoke control');
    const revokeAgain = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Revoke');
    assert.ok(revokeAgain);
    await click(revokeAgain);
    assert.ok(container.querySelector('[role="group"]'));
    const no = [...container.querySelectorAll('button')].find((button) => button.textContent === 'No');
    assert.ok(no);
    await click(no);
    assert.equal(deleteCount, 0, 'the accessible cancellation prompt must be able to decline without a DELETE');
    assert.match(container.textContent ?? '', /authorized@example\.com/);
    const revokeAfterNo = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Revoke');
    assert.ok(revokeAfterNo);
    await click(revokeAfterNo);
    const yes = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Yes, revoke');
    assert.ok(yes);
    await click(yes);
    assert.equal(deleteCount, 1);
    assert.match(container.textContent ?? '', /authorized@example\.com/);
    assert.match(container.textContent ?? '', /The invitation could not be revoked/);
  });

  test('a successful cancellation removes the row, but a failed refresh removes stale controls and stays retryable', async (context) => {
    const restoreBrowser = installBrowser();
    const { supabase } = await import('@/lib/supabase');
    supabase.auth.stopAutoRefresh();
    context.mock.method(
      supabase.auth as unknown as { getSession: () => Promise<unknown> },
      'getSession',
      async () => ({ data: { session: null }, error: null }),
    );
    const { default: CompanyInvitePanel } = await import('@/app/(hotel)/company/_components/CompanyInvitePanel');
    const { createRoot } = await import('react-dom/client');
    const originalFetch = globalThis.fetch;
    let getCount = 0;
    let deleteCount = 0;
    context.mock.method(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method?.toUpperCase() ?? 'GET';
      if (method === 'DELETE') {
        deleteCount += 1;
        return Promise.resolve(response({ ok: true }));
      }
      getCount += 1;
      return Promise.resolve(getCount === 1
        ? response(listing(ORG_A, [pendingAuthorized, pendingUnauthorized]))
        : response({ ok: false, error: 'Company invitations are unavailable right now.' }, 503));
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root: Root = createRoot(container);
    context.after(async () => {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: originalFetch });
      await act(async () => { root.unmount(); });
      container.remove();
      restoreBrowser();
    });

    await act(async () => { root.render(<CompanyInvitePanel organizationId={ORG_A} styles={styles} />); });
    await flush();
    const revoke = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Revoke');
    assert.ok(revoke);
    await click(revoke);
    const yes = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Yes, revoke');
    assert.ok(yes);
    await click(yes);
    assert.equal(deleteCount, 1);
    assert.ok(container.querySelector('[role="alert"]'));
    assert.ok([...container.querySelectorAll('button')].some((button) => button.textContent === 'Retry'));
    assert.doesNotMatch(container.textContent ?? '', /authorized@example\.com/);
    assert.equal([...container.querySelectorAll('button')].filter((button) => button.textContent === 'Revoke').length, 0);
    assert.equal(container.querySelector('button.primary'), null, 'failed refresh must not leave a stale open/invite action');
  });
});
