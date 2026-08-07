import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import type { Root } from 'react-dom/client';

import type { CompanyAccessData, CompanyAccessViewerContext } from '@/lib/company-access/dto';

type CompanyPageModule = typeof import('@/app/(hotel)/company/page');

const HOTEL_ID = '33333333-3333-4333-8333-333333333333';
const ORGANIZATION_ID = '44444444-4444-4444-8444-444444444444';

const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'Element',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLInputElement',
  'Node',
  'Event',
  'InputEvent',
  'MouseEvent',
  'KeyboardEvent',
  'FocusEvent',
  'BroadcastChannel',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
] as const;

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

let companyPageModulePromise: Promise<CompanyPageModule> | null = null;
function loadCompanyPageModule(): Promise<CompanyPageModule> {
  companyPageModulePromise ??= loadWithCssShim(() => import('@/app/(hotel)/company/page'));
  return companyPageModulePromise;
}

function installBrowser(): () => void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/company?tab=hotels',
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

async function flushReact(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

const viewerContext: CompanyAccessViewerContext = {
  kind: 'staxis_admin_preview',
  readOnly: true,
  requestedPropertyId: HOTEL_ID,
  scope: 'organization',
  targetId: ORGANIZATION_ID,
  targetName: 'Northstar Management',
};

const previewData: CompanyAccessData = {
  organizations: [{
    id: ORGANIZATION_ID,
    name: 'Northstar Management',
    type: 'management_company',
    status: 'active',
  }],
  portfolios: [],
  properties: [{
    nodeId: `${ORGANIZATION_ID}:${HOTEL_ID}`,
    id: HOTEL_ID,
    name: 'Harbor Inn',
    organizationId: ORGANIZATION_ID,
    portfolioIds: [],
    relationshipType: 'operator',
    status: 'active',
  }],
  memberships: [],
  effectiveAccess: [],
  requests: [],
  activity: [],
  permissions: {
    viewHotels: true,
    viewPeople: true,
    managePeople: false,
    manageInvitations: false,
    viewAccess: true,
    manageAccess: false,
    viewActivity: true,
    requestAccess: false,
    availableProfiles: [],
    delegationPolicies: [],
  },
  legacyFallback: false,
  viewerContext,
};

interface HotelsHarness {
  text: () => string;
  click: (label: string) => Promise<void>;
  input: () => HTMLInputElement;
  setQuery: (value: string) => Promise<void>;
}

async function mountHotelsPanel(context: TestContext): Promise<HotelsHarness> {
  const restoreBrowser = installBrowser();
  const { HotelsPanel } = await loadCompanyPageModule();
  const { supabase } = await import('@/lib/supabase');
  supabase.auth.stopAutoRefresh();
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);

  function TestHotelsPanel() {
    const [query, setQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'not_active'>('all');
    return (
      <HotelsPanel
        data={previewData}
        structure={null}
        structureError={null}
        structureLoading={false}
        lang={'en'}
        query={query}
        onQueryChange={setQuery}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        onStructureRetry={() => undefined}
        onStructureChanged={() => undefined}
      />
    );
  }

  await act(async () => { root.render(<TestHotelsPanel />); });
  await flushReact();

  const findButton = (label: string): HTMLButtonElement | null => (
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => (
      (button.textContent ?? '').trim() === label
      || button.getAttribute('aria-label') === label
    )) ?? null
  );
  const click = async (label: string): Promise<void> => {
    const button = findButton(label);
    assert.ok(button, `button "${label}" must render`);
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    await flushReact();
  };
  const setQuery = async (value: string): Promise<void> => {
    const input = document.querySelector<HTMLInputElement>('input[type="search"]');
    assert.ok(input, 'Hotels search must render');
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    assert.ok(valueSetter, 'JSDOM input value setter must exist');
    await act(async () => {
      valueSetter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    await flushReact();
  };

  context.after(async () => {
    supabase.auth.stopAutoRefresh();
    await act(async () => { root.unmount(); });
    container.remove();
    restoreBrowser();
  });

  return {
    text: () => document.body.textContent ?? '',
    click,
    setQuery,
    input: () => {
      const input = document.querySelector<HTMLInputElement>('input[type="search"]');
      assert.ok(input, 'Hotels search must render');
      return input;
    },
  };
}

describe('Company Hub admin-preview Hotels panel', () => {
  test('renders the hotel hierarchy without the removed relationship entry point', async (context) => {
    const ui = await mountHotelsPanel(context);
    const text = ui.text();

    assert.match(text, /Search hotels or companies/);
    assert.match(text, /Northstar Management/);
    assert.match(text, /Harbor Inn/);
    assert.doesNotMatch(text, /Company relationship and status/);
    assert.doesNotMatch(text, /Manage relationship/);
    assert.equal(document.querySelector('[data-admin-hotel-relationship-manager]'), null);
  });

  test('keeps admin-preview Hotels filtering usable after the entry point is removed', async (context) => {
    const ui = await mountHotelsPanel(context);

    await ui.setQuery('Northstar');
    assert.match(ui.text(), /Northstar Management/);
    assert.match(ui.text(), /Harbor Inn/);
    assert.ok(document.querySelector('details'), 'matching company hierarchy must remain visible');

    await ui.setQuery('No matching hotel');
    assert.match(ui.text(), /No hotels match/);
    assert.doesNotMatch(ui.text(), /Harbor Inn/);

    await ui.click('Clear search');
    assert.match(ui.text(), /Harbor Inn/);

    await ui.click('Not active');
    assert.match(ui.text(), /No hotels match/);
    assert.doesNotMatch(ui.text(), /Harbor Inn/);

    await ui.click('Clear filters');
    assert.match(ui.text(), /Harbor Inn/);
    assert.equal(ui.input().placeholder, 'Search hotels or companies');
  });
});
