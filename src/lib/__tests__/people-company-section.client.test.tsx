/**
 * The Company section, as a manager actually sees it.
 *
 * The merge rule is unit-tested and the route's scoping is pinned against a
 * real database. What neither of those can show is the screen: that the company
 * people appear in their OWN section, under a heading that says why, and with
 * no way to edit, remove or schedule them from a hotel that does not employ
 * them. Read-only here means "there is no button", not "the button is disabled",
 * so this counts buttons.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

import type { AppUser } from '@/contexts/AuthContext';
import type {
  CompanyJobLine,
  HotelTeamMember,
} from '@/app/(hotel)/company/_components/HotelTeamPanel';
import type { PeopleControllerState } from '@/app/(hotel)/company/_components/usePeopleController';
import type { StaffMember } from '@/types';

type HotelTeamPanelModule = typeof import('@/app/(hotel)/company/_components/HotelTeamPanel');

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
  'HTMLFormElement',
  'HTMLImageElement',
  'Node',
  'Event',
  'InputEvent',
  'SubmitEvent',
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

const HOTEL_ID = '33333333-3333-4333-8333-333333333333';
const SIBLING_HOTEL_ID = '44444444-4444-4444-8444-444444444444';

const USER: AppUser = {
  uid: 'user-1',
  accountId: 'account-gm',
  username: 'gm',
  displayName: 'Gil Manager',
  role: 'general_manager',
  propertyAccess: [HOTEL_ID],
  staffId: null,
  isDemo: false,
};

const BASE_MEMBER: HotelTeamMember = {
  accountId: 'account-gm',
  username: 'gm',
  displayName: 'Gil Manager',
  email: 'gm@example.com',
  role: 'general_manager',
  active: true,
  updatedAt: '2026-08-01T00:00:00.000Z',
  ownerProtected: false,
  lastSignInKnown: true,
  lastSignInAt: null,
  propertyAccess: [HOTEL_ID],
  staffId: null,
  historicalStaffId: null,
  staffLinkAllowed: false,
  managementSurface: 'legacy_hotel',
};

const GM: HotelTeamMember = { ...BASE_MEMBER, staffId: 'staff-gm' };
const VP: HotelTeamMember = {
  ...BASE_MEMBER,
  accountId: 'account-vp',
  username: 'vp',
  displayName: 'Vera Oversight',
  email: 'vp@example.com',
  role: 'front_desk',
  managementSurface: 'company_access',
};
const COMPANY_OWNER: HotelTeamMember = {
  ...BASE_MEMBER,
  accountId: 'account-owner',
  username: 'owner',
  displayName: 'Ana Owner',
  email: 'owner@example.com',
  role: 'owner',
  managementSurface: 'company_access',
};

const GM_STAFF: StaffMember = {
  id: 'staff-gm',
  name: 'Gil Manager',
  language: 'en',
  isSenior: false,
  department: 'other',
  scheduledToday: false,
  weeklyHours: 0,
  maxWeeklyHours: 40,
};
const HOUSEKEEPER: StaffMember = {
  id: 'staff-hk',
  name: 'Riley Housekeeper',
  language: 'en',
  isSenior: false,
  department: 'housekeeping',
  scheduledToday: false,
  weeklyHours: 0,
  maxWeeklyHours: 40,
};

const JOBS: Record<string, CompanyJobLine[]> = {
  'account-gm': [{
    membershipId: 'm-gm',
    scope: 'property',
    role: 'general_manager',
    label: { en: 'GM' },
    propertyIds: [HOTEL_ID],
    propertyNames: ['Harbor Inn'],
  }],
  'account-vp': [{
    membershipId: 'm-vp',
    scope: 'company',
    role: 'vp',
    label: { en: 'Oversees' },
    propertyIds: [HOTEL_ID],
    propertyNames: ['Harbor Inn'],
  }],
  'account-owner': [{
    membershipId: 'm-owner',
    scope: 'company',
    role: 'owner',
    label: { en: 'Owner' },
    propertyIds: [HOTEL_ID],
    propertyNames: ['Harbor Inn'],
  }],
};

function installBrowser(): () => void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/company',
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of DOM_GLOBALS) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const candidate = dom.window[key as keyof typeof dom.window];
    const value = typeof candidate === 'function' && (
      key === 'requestAnimationFrame'
      || key === 'cancelAnimationFrame'
      || key === 'getComputedStyle'
    ) ? candidate.bind(dom.window) : candidate;
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

async function flushReact(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 18; index += 1) await Promise.resolve();
  });
}

function controllerWith(
  team: HotelTeamMember[],
  jobsByAccountId: Record<string, CompanyJobLine[]>,
  staff: StaffMember[],
): PeopleControllerState {
  return {
    team,
    jobsByAccountId,
    teamLoading: false,
    teamError: '',
    teamSettled: true,
    teamSnapshotCurrent: true,
    firstPersonOnboarding: { status: 'none', invitedEmail: null, accountId: null },
    staff,
    staffLoaded: true,
    rosterUnavailable: false,
    staffViewerKey: 'people-company-section-stamp',
    previewHiddenStaffIds: new Set<string>(),
    refreshTeam: async () => undefined,
    refresh: async () => undefined,
  };
}

async function mountPeople(
  context: TestContext,
  team: HotelTeamMember[],
  jobsByAccountId: Record<string, CompanyJobLine[]>,
  staff: StaffMember[],
): Promise<HTMLElement> {
  const restoreBrowser = installBrowser();
  const { HotelTeamPanel } = await loadWithCssShim<HotelTeamPanelModule>(
    () => import('@/app/(hotel)/company/_components/HotelTeamPanel'),
  );
  const { supabase } = await import('@/lib/supabase');
  supabase.auth.stopAutoRefresh();
  const { createRoot } = await import('react-dom/client');

  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async () => new Response(
      JSON.stringify({ ok: true, data: { requests: [], invites: [], contacts: {} } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  });

  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <HotelTeamPanel
        hotelId={HOTEL_ID}
        hotelName={'Harbor Inn'}
        currentUser={USER}
        lang={'en'}
        canManageTeam
        canInviteAccounts
        canViewWages={false}
        readOnly={false}
        adminPreview={false}
        inviteDialogOpen={false}
        onInviteDialogOpenChange={() => undefined}
        staffProfiles={staff}
        rosterUnavailable={false}
        canAddStaff
        peopleController={controllerWith(team, jobsByAccountId, staff)}
        onChanged={() => undefined}
      />,
    );
  });
  await flushReact();

  context.after(() => {
    act(() => { root.unmount(); });
    container.remove();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    restoreBrowser();
  });
  return container;
}

function listNames(container: HTMLElement, label: string): string[] {
  const list = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!list) return [];
  return Array.from(list.querySelectorAll<HTMLElement>('[role="listitem"] strong'))
    .map((node) => (node.textContent ?? '').replace(/You$/, '').trim());
}

describe('the Company section on My Hotel People', () => {
  test('company people are listed apart from the hotel roster', async (t) => {
    const container = await mountPeople(
      t,
      [GM, VP, COMPANY_OWNER],
      JOBS,
      [GM_STAFF, HOUSEKEEPER],
    );

    assert.deepEqual(
      listNames(container, 'People at this hotel').sort(),
      ['Gil Manager', 'Riley Housekeeper'],
    );
    assert.deepEqual(
      listNames(container, 'Company people responsible for this hotel').sort(),
      ['Ana Owner', 'Vera Oversight'],
    );
  });

  test('it says what the section is, in words a manager reads once', async (t) => {
    const container = await mountPeople(t, [GM, VP], JOBS, [GM_STAFF]);
    const text = container.textContent ?? '';
    assert.equal(text.includes('Company'), true);
    assert.equal(text.includes('responsible for this hotel'), true);
    assert.equal(text.includes('Oversees this hotel'), true);
    // Founder ruling 2026-07-28. Named because it is invisible in a diff.
    const EM_DASH = String.fromCharCode(0x2014);
    assert.equal(text.includes(EM_DASH), false, 'no em dashes in anything a person reads');
  });

  test('there is nothing to press on a company person', async (t) => {
    const container = await mountPeople(t, [GM, VP, COMPANY_OWNER], JOBS, [GM_STAFF]);
    const companyList = container.querySelector<HTMLElement>(
      '[aria-label="Company people responsible for this hotel"]',
    );
    assert.ok(companyList, 'the section must render');
    assert.equal(
      companyList.querySelectorAll('button').length,
      0,
      'read-only means no button at all, not a disabled one',
    );
    assert.equal(companyList.querySelectorAll('input, select').length, 0);
  });

  test('a company job that does not reach this hotel produces no section', async (t) => {
    const container = await mountPeople(
      t,
      [GM, VP],
      {
        ...JOBS,
        'account-vp': [{
          membershipId: 'm-vp',
          scope: 'company',
          role: 'vp',
          label: { en: 'Oversees' },
          propertyIds: [SIBLING_HOTEL_ID],
          propertyNames: ['Other Inn'],
        }],
      },
      [GM_STAFF],
    );
    assert.equal(
      container.querySelector('[aria-label="Company people responsible for this hotel"]'),
      null,
    );
  });

  test('a hotel whose only people are company people still says so honestly', async (t) => {
    const container = await mountPeople(t, [VP], JOBS, []);
    assert.deepEqual(listNames(container, 'People at this hotel'), []);
    assert.deepEqual(
      listNames(container, 'Company people responsible for this hotel'),
      ['Vera Oversight'],
    );
    assert.equal(
      (container.textContent ?? '').includes('Nobody is on this hotel'),
      true,
      'an empty hotel list must be said out loud, not left as a blank strip',
    );
  });
});
