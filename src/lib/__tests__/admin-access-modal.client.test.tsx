import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { AccessPopoverProps } from '@/app/admin/_components/AccessPopover';

type AccessModule = typeof import('@/app/admin/_components/AccessPopover');
type Requester = NonNullable<AccessPopoverProps['request']>;

const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'Element',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLSelectElement',
  'Node',
  'Event',
  'EventTarget',
  'MouseEvent',
  'KeyboardEvent',
  'FocusEvent',
  'BroadcastChannel',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
] as const;

let accessModulePromise: Promise<AccessModule> | null = null;

function loadAccessModule(): Promise<AccessModule> {
  if (accessModulePromise) return accessModulePromise;
  const nodeRequire = createRequire(import.meta.url);
  const extensions = nodeRequire.extensions as Record<
    string,
    (module: NodeModule, filename: string) => void
  >;
  const originalCssLoader = extensions['.css'];
  extensions['.css'] = (module) => { module.exports = {}; };
  accessModulePromise = import('@/app/admin/_components/AccessPopover').finally(() => {
    if (originalCssLoader) extensions['.css'] = originalCssLoader;
    else delete extensions['.css'];
  });
  return accessModulePromise;
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

  const originalElementScrollTo = HTMLElement.prototype.scrollTo;
  HTMLElement.prototype.scrollTo = () => undefined;
  const originalWindowScrollTo = window.scrollTo;
  window.scrollTo = () => undefined;

  return () => {
    HTMLElement.prototype.scrollTo = originalElementScrollTo;
    window.scrollTo = originalWindowScrollTo;
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

const HOTEL_ID = '11111111-1111-4111-8111-111111111111';
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';

const HOTEL_MATRIX = {
  hotelRoles: ['owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'],
  groups: [
    { key: 'money', label_en: 'Money' },
    { key: 'operations', label_en: 'Operations' },
    { key: 'front_desk', label_en: 'Front desk' },
    { key: 'comms', label_en: 'Communication & content' },
    { key: 'team_settings', label_en: 'Team & settings' },
    { key: 'admin', label_en: 'Staxis admin (always you)' },
  ],
  capabilities: [
    { key: 'view_financials', adminOnly: false, live: true, managerFloor: true, group: 'money', label_en: 'Financials', desc_en: 'Revenue and profit' },
    { key: 'assign_work', adminOnly: false, live: true, group: 'operations', label_en: 'Assign work', desc_en: 'Assign hotel work' },
    { key: 'use_complaints', adminOnly: false, live: true, group: 'front_desk', label_en: 'Complaints', desc_en: 'Guest complaints' },
    { key: 'post_announcements', adminOnly: false, live: true, group: 'comms', label_en: 'Post announcements', desc_en: 'Hotel notices' },
    { key: 'manage_team', adminOnly: false, live: true, managerFloor: true, group: 'team_settings', label_en: 'Team & accounts', desc_en: 'Hotel accounts' },
    { key: 'access_admin', adminOnly: true, live: false, group: 'admin', label_en: 'Staxis admin console', desc_en: 'Admin only' },
  ],
  overrides: {},
};

function baseRequest(calls: string[] = []): Requester {
  return async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.startsWith('/api/admin/list-properties')) {
      return jsonResponse({ ok: true, data: { properties: [{ id: HOTEL_ID, name: 'Harbor Hotel' }] } });
    }
    if (url.startsWith('/api/admin/access/matrix')) {
      return jsonResponse({ ok: true, data: HOTEL_MATRIX });
    }
    if (url === '/api/admin/organizations') {
      return jsonResponse({
        ok: true,
        data: {
          schemaReady: true,
          organizations: [{
            id: ORGANIZATION_ID,
            name: 'Gulf Coast Hotels',
            type: 'management_company',
            status: 'active',
            hotelCount: 3,
            warnings: [],
          }],
        },
      });
    }
    if (url === '/api/admin/access/toggle') return jsonResponse({ ok: true, data: {} });
    if (url === '/api/admin/access/apply-to-all') {
      return jsonResponse({ ok: true, data: { hotelsUpdated: 2 } });
    }
    return jsonResponse({ ok: false, error: 'Unexpected request' }, 500);
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

async function keyDown(target: Document | Element, key: string, shiftKey = false): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      shiftKey,
      bubbles: true,
      cancelable: true,
    }));
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
  });
}

async function mountAccess(context: TestContext, request: Requester = baseRequest()): Promise<{
  root: Root;
  trigger: HTMLButtonElement;
}> {
  const restoreBrowser = installBrowser();
  const { AccessPopover } = await loadAccessModule();
  const { supabase } = await import('@/lib/supabase');
  supabase.auth.stopAutoRefresh();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<AccessPopover request={request} />); });
  const trigger = container.querySelector<HTMLButtonElement>('button');
  assert.ok(trigger);

  context.after(async () => {
    supabase.auth.stopAutoRefresh();
    await act(async () => { root.unmount(); });
    container.remove();
    restoreBrowser();
  });
  return { root, trigger };
}

describe('Admin Access modal behavior', { concurrency: false }, () => {
  test('renders truthful loading and authorization-error states for the hotel directory', async (context) => {
    let resolveHotels: ((response: Response) => void) | null = null;
    const request: Requester = async (input) => {
      if (String(input).startsWith('/api/admin/list-properties')) {
        return new Promise<Response>((resolve) => { resolveHotels = resolve; });
      }
      return jsonResponse({ ok: false, error: 'Unexpected request' }, 500);
    };
    const { trigger } = await mountAccess(context, request);
    await click(trigger);
    await settle();
    assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /Loading hotels/);

    assert.ok(resolveHotels);
    await act(async () => {
      resolveHotels?.(jsonResponse({ ok: false, error: 'Admin access is required.' }, 403));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Admin access is required/);
    assert.match(document.body.textContent ?? '', /Try again/);
  });

  test('opens as one modal, traps focus, locks scroll, closes on Escape, and restores focus', async (context) => {
    const { trigger } = await mountAccess(context);
    trigger.focus();
    await click(trigger);
    await settle();

    const dialog = document.querySelector<HTMLElement>('[data-access-modal-dialog]');
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close access settings"]');
    assert.ok(dialog);
    assert.equal(dialog.getAttribute('role'), 'dialog');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.ok(close);
    assert.equal(document.activeElement, close, 'Close receives initial focus');
    assert.equal(document.body.dataset.accessScrollLocked, 'true');
    assert.equal(document.body.style.overflow, 'hidden');
    assert.equal(document.documentElement.style.overflow, 'hidden');

    const action = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes("Apply this hotel's setup"),
    );
    assert.ok(action);
    action.focus();
    await keyDown(document, 'Tab');
    assert.equal(document.activeElement, close, 'Tab wraps from the last control to Close');

    await keyDown(document, 'Escape');
    await settle();
    assert.equal(document.querySelector('[data-access-modal-dialog]'), null);
    assert.equal(document.body.dataset.accessScrollLocked, undefined);
    assert.equal(document.body.style.overflow, '');
    assert.equal(document.activeElement, trigger, 'focus returns to the Access trigger');
  });

  test('uses the existing backdrop-close convention and exposes both complete modes with truthful counts', async (context) => {
    const { trigger } = await mountAccess(context);
    await click(trigger);
    await settle();

    assert.match(document.body.textContent ?? '', /5 configurable capabilities · 5 roles/);
    for (const group of HOTEL_MATRIX.groups) {
      assert.ok((document.body.textContent ?? '').includes(group.label_en));
    }
    assert.doesNotMatch(document.body.textContent ?? '', /0\s*[–-]\s*100 of/);

    const organizationTab = document.querySelector<HTMLButtonElement>('#access-mode-organization');
    assert.ok(organizationTab);
    await click(organizationTab);
    await settle();

    assert.equal(organizationTab.getAttribute('aria-selected'), 'true');
    assert.ok(document.querySelector('[aria-label="Organization role and capability matrix"]'));
    assert.match(document.body.textContent ?? '', /13 fixed capabilities · 8 profiles/);
    assert.match(document.body.textContent ?? '', /Owner · Company scope/);
    // 0464 collapsed the company vocabulary. The chip row walks
    // COMPANY_SCOPE_ROLES, so these two are the whole row: a stray third chip
    // would mean the surface is naming a job nobody can hold.
    assert.match(document.body.textContent ?? '', /Regional Manager · Company scope/);
    assert.doesNotMatch(document.body.textContent ?? '', /(VP|Finance) · Company scope/);
    assert.match(document.body.textContent ?? '', /Portfolio manager · Portfolio \/ region/);
    assert.match(document.body.textContent ?? '', /Transfer ownership/);
    assert.match(document.body.textContent ?? '', /authorization is rechecked at commit/i);

    await keyDown(organizationTab, 'ArrowRight');
    await settle();
    assert.equal(document.querySelector('#access-mode-hotel')?.getAttribute('aria-selected'), 'true');

    const backdrop = document.querySelector<HTMLElement>('[data-access-modal-backdrop]');
    assert.ok(backdrop);
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    });
    await settle();
    assert.equal(document.querySelector('[data-access-modal-dialog]'), null);
  });

  test('announces saving and surfaces a commit-time authorization failure without keeping the optimistic change', async (context) => {
    let resolveToggle: ((response: Response) => void) | null = null;
    const calls: string[] = [];
    const request = baseRequest(calls);
    const controlledRequest: Requester = async (input, init) => {
      if (String(input) === '/api/admin/access/toggle') {
        calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
        return new Promise<Response>((resolve) => { resolveToggle = resolve; });
      }
      return request(input, init);
    };
    const { trigger } = await mountAccess(context, controlledRequest);
    await click(trigger);
    await settle();

    const financialsOwner = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label^="Financials for Owner"]',
    );
    assert.ok(financialsOwner);
    assert.equal(financialsOwner.getAttribute('aria-checked'), 'true');
    await click(financialsOwner);
    assert.match(document.body.textContent ?? '', /Saving hotel access change/);
    assert.equal(financialsOwner.disabled, true);

    assert.ok(resolveToggle);
    await act(async () => {
      resolveToggle?.(jsonResponse({ ok: false, error: 'Your Admin authorization changed. Reload and try again.' }, 403));
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    await settle();

    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Admin authorization changed/);
    assert.equal(
      document.querySelector('button[role="switch"][aria-label^="Financials for Owner"]')?.getAttribute('aria-checked'),
      'true',
      'the failed optimistic restriction is reconciled to server truth',
    );
    assert.ok(calls.includes('POST /api/admin/access/toggle'));
    assert.ok(calls.filter((call) => call.startsWith('GET /api/admin/access/matrix')).length >= 2);
  });
});
