import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

import type { AppUser } from '@/contexts/AuthContext';
import type { HotelTeamMember } from '@/app/company/_components/HotelTeamPanel';
import type { EmploymentLinkAccount } from '@/app/company/_components/PersonEmploymentForm';
import { buildHotelRoster } from '@/app/company/_components/people-roster';
import type { StaffMember } from '@/types';

type HotelTeamModule = typeof import('@/app/company/_components/HotelTeamPanel');
type EmploymentModule = typeof import('@/app/company/_components/PersonEmploymentForm');

const HOTEL_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_HOTEL_ID = '22222222-2222-4222-8222-222222222222';

const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'Element',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'HTMLTextAreaElement',
  'Node',
  'Event',
  'InputEvent',
  'MouseEvent',
  'KeyboardEvent',
  'FocusEvent',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
  'BroadcastChannel',
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

let hotelTeamPromise: Promise<HotelTeamModule> | null = null;
function loadHotelTeam(): Promise<HotelTeamModule> {
  hotelTeamPromise ??= loadWithCssShim(
    () => import('@/app/company/_components/HotelTeamPanel'),
  );
  return hotelTeamPromise;
}

let employmentPromise: Promise<EmploymentModule> | null = null;
function loadEmployment(): Promise<EmploymentModule> {
  employmentPromise ??= loadWithCssShim(
    () => import('@/app/company/_components/PersonEmploymentForm'),
  );
  return employmentPromise;
}

function installBrowser(): () => void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/company?tab=people',
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

function currentUser(): AppUser {
  return {
    uid: '90000000-0000-4000-8000-000000000001',
    accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    username: 'manager',
    displayName: 'Alex Manager',
    role: 'owner',
    propertyAccess: [HOTEL_ID],
    staffId: null,
    isDemo: false,
  };
}

function account(overrides: Partial<HotelTeamMember> = {}): HotelTeamMember {
  return {
    accountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    username: 'maria.login',
    displayName: 'Maria Login',
    email: 'maria@example.test',
    role: 'housekeeping',
    active: true,
    updatedAt: '2026-07-01T12:00:00.000Z',
    ownerProtected: false,
    lastSignInKnown: false,
    lastSignInAt: null,
    lifecyclePending: false,
    lifecycleDesiredActive: null,
    propertyAccess: [HOTEL_ID],
    staffId: null,
    historicalStaffId: null,
    staffLinkAllowed: true,
    managementSurface: 'legacy_hotel',
    actions: {
      canEditProfile: true,
      canChangeRole: false,
      canResetPassword: false,
      canDeactivate: false,
      canReactivate: false,
      canRemove: false,
    },
    ...overrides,
  };
}

function staff(overrides: Partial<StaffMember> = {}): StaffMember {
  return {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    name: 'Maria Archived',
    language: 'en',
    isSenior: false,
    department: 'housekeeping',
    scheduledToday: false,
    weeklyHours: 0,
    maxWeeklyHours: 40,
    maxDaysPerWeek: 5,
    isActive: false,
    ...overrides,
  };
}

function employmentAccount(overrides: Partial<EmploymentLinkAccount> = {}): EmploymentLinkAccount {
  return {
    accountId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    displayName: 'Eligible Login',
    username: 'eligible.login',
    role: 'housekeeping',
    staffId: null,
    historicalStaffId: null,
    propertyAccess: [HOTEL_ID],
    managementSurface: 'legacy_hotel',
    staffLinkAllowed: true,
    lifecyclePending: false,
    ...overrides,
  };
}

function restoreAfter(context: TestContext, restoreBrowser: () => void, root: Root, container: HTMLElement): void {
  context.after(async () => {
    const { supabase } = await import('@/lib/supabase');
    supabase.auth.stopAutoRefresh();
    await act(async () => { root.unmount(); });
    container.remove();
    restoreBrowser();
  });
}

describe('My Hotel People mounted identity and actions', { concurrency: false }, () => {
  test('renders an archived linked identity once with a View-only off-roster action', async (context) => {
    const restoreBrowser = installBrowser();
    const { PersonRow } = await loadHotelTeam();
    const { supabase } = await import('@/lib/supabase');
    supabase.auth.stopAutoRefresh();
    const { createRoot } = await import('react-dom/client');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const archivedAccount = account({ historicalStaffId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    const person = buildHotelRoster([archivedAccount], [staff()])
      .flatMap((group) => group.people)
      .find((candidate) => candidate.account?.accountId === archivedAccount.accountId);
    assert.ok(person, 'the archived account must produce a merged person');

    restoreAfter(context, restoreBrowser, root, container);
    await act(async () => {
      root.render(
        <PersonRow
          person={person}
          lang="en"
          currentUser={currentUser()}
          currentAccountId={currentUser().accountId}
          locked={false}
          jobsByAccountId={{}}
          pendingLifecycle={undefined}
          serverLifecyclePollingPaused={false}
          onOpen={() => undefined}
          onRemoveAccess={() => undefined}
        />,
      );
    });

    const rows = container.querySelectorAll('[role="listitem"]');
    assert.equal(rows.length, 1);
    assert.equal((container.textContent ?? '').match(/Maria Archived/g)?.length, 1);
    assert.match(container.textContent ?? '', /STAXIS LOGIN/);
    assert.match(container.textContent ?? '', /Off roster/);
    const action = container.querySelector<HTMLButtonElement>('button[aria-label="View Maria Archived"]');
    assert.ok(action, 'an inactive off-roster person still has a safe view action');
    assert.equal(action.textContent?.trim(), 'View');
    assert.equal(container.querySelector('button[aria-label="Edit Maria Archived"]'), null);
  });

  test('offers only server-compatible accounts in the linked-login picker', async (context) => {
    const restoreBrowser = installBrowser();
    const { PersonEmploymentForm } = await loadEmployment();
    const { supabase } = await import('@/lib/supabase');
    supabase.auth.stopAutoRefresh();
    const { createRoot } = await import('react-dom/client');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    restoreAfter(context, restoreBrowser, root, container);

    const accounts = [
      employmentAccount(),
      employmentAccount({
        accountId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        displayName: 'Company Access',
        username: 'company.access',
        managementSurface: 'company_access',
        staffLinkAllowed: false,
      }),
      employmentAccount({
        accountId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        displayName: 'Multi Hotel',
        username: 'multi.hotel',
        propertyAccess: [HOTEL_ID, OTHER_HOTEL_ID],
        staffLinkAllowed: false,
      }),
      employmentAccount({
        accountId: '11111111-1111-4111-8111-111111111112',
        displayName: 'Pending Login',
        username: 'pending.login',
        lifecyclePending: true,
        staffLinkAllowed: false,
      }),
      employmentAccount({
        accountId: '11111111-1111-4111-8111-111111111113',
        displayName: 'Archived Login',
        username: 'archived.login',
        historicalStaffId: '11111111-1111-4111-8111-111111111114',
        staffLinkAllowed: false,
      }),
    ];

    await act(async () => {
      root.render(
        <PersonEmploymentForm
          hotelId={HOTEL_ID}
          uid={currentUser().uid}
          lang="en"
          staff={staff({ isActive: true })}
          accounts={accounts}
          canEdit
          canViewWages={false}
          wages={{}}
          contacts={{}}
          contactsReady
          contactsUnavailable={false}
          onWageSaved={() => undefined}
          onContactSaved={() => undefined}
          onChanged={() => undefined}
          onClosePanel={() => undefined}
        />,
      );
    });

    const linkedLogin = Array.from(container.querySelectorAll('select')).find((select) => (
      Array.from(select.options).some((option) => option.textContent === 'No login linked')
    ));
    assert.ok(linkedLogin, 'the linked-login picker must render');
    const labels = Array.from(linkedLogin.options).map((option) => option.textContent ?? '');
    assert.ok(labels.some((label) => label.includes('Eligible Login')));
    assert.ok(labels.includes('No login linked'));
    assert.ok(!labels.some((label) => label.includes('Company Access')));
    assert.ok(!labels.some((label) => label.includes('Multi Hotel')));
    assert.ok(!labels.some((label) => label.includes('Pending Login')));
    assert.ok(!labels.some((label) => label.includes('Archived Login')));
    const describedBy = linkedLogin!.getAttribute('aria-describedby');
    assert.ok(describedBy && describedBy.length > 0);
  });
});
