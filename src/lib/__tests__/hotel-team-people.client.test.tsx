import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

import type { AppUser } from '@/contexts/AuthContext';
import type { HotelTeamMember } from '@/app/(hotel)/company/_components/HotelTeamPanel';
import type { EmploymentLinkAccount } from '@/app/(hotel)/company/_components/PersonEmploymentForm';
import { buildHotelRoster } from '@/app/(hotel)/company/_components/people-roster';
import type { StaffMember } from '@/types';

type HotelTeamModule = typeof import('@/app/(hotel)/company/_components/HotelTeamPanel');
type EmploymentModule = typeof import('@/app/(hotel)/company/_components/PersonEmploymentForm');
type PeopleControllerModule = typeof import('@/app/(hotel)/company/_components/usePeopleController');

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
    () => import('@/app/(hotel)/company/_components/HotelTeamPanel'),
  );
  return hotelTeamPromise;
}

let employmentPromise: Promise<EmploymentModule> | null = null;
function loadEmployment(): Promise<EmploymentModule> {
  employmentPromise ??= loadWithCssShim(
    () => import('@/app/(hotel)/company/_components/PersonEmploymentForm'),
  );
  return employmentPromise;
}

let peopleControllerPromise: Promise<PeopleControllerModule> | null = null;
function loadPeopleController(): Promise<PeopleControllerModule> {
  peopleControllerPromise ??= loadWithCssShim(
    () => import('@/app/(hotel)/company/_components/usePeopleController'),
  );
  return peopleControllerPromise;
}

let dialogsPromise: Promise<unknown> | null = null;
function loadDialogs(): Promise<unknown> {
  dialogsPromise ??= loadWithCssShim(
    () => import('@/app/(hotel)/company/_components/HotelTeamDialogs'),
  );
  return dialogsPromise;
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

function jsonResponse(body: unknown, status = 200): Response {
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
  test('uses one identity-keyed team request and masks stale hotel/staff snapshots', async (context) => {
    const restoreBrowser = installBrowser();
    const { usePeopleController } = await loadPeopleController();
    const { supabase } = await import('@/lib/supabase');
    supabase.auth.stopAutoRefresh();
    const { createRoot } = await import('react-dom/client');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, (response: Response) => void>();
    let requestCount = 0;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        const requestedHotelId = url.searchParams.get('hotelId') ?? '';
        requestCount += 1;
        return new Promise<Response>((resolve) => {
          pending.set(requestedHotelId, resolve);
        });
      },
    });

    function ControllerProbe({ hotelId, viewerKey }: { hotelId: string; viewerKey: string }) {
      const state = usePeopleController({
        hotelId,
        viewerKey,
        enabled: true,
        adminPreview: false,
        readOnly: false,
        staff: [staff({ id: `${hotelId}-staff`, name: `${hotelId} staff`, isActive: true })],
        staffViewerKey: `${viewerKey}:staff`,
        staffExpectedViewerKey: `${viewerKey}:expected`,
        staffLoaded: true,
        staffLoadFailed: false,
        refreshStaff: async () => {},
      });
      return (
        <div
          data-team={state.team.map((member) => member.accountId).join(',')}
          data-team-loading={String(state.teamLoading)}
          data-staff-count={String(state.staff.length)}
          data-roster-unavailable={String(state.rosterUnavailable)}
        />
      );
    }

    const renderProbe = async (hotelId: string, viewerKey: string) => {
      await act(async () => {
        root.render(<ControllerProbe hotelId={hotelId} viewerKey={viewerKey} />);
      });
      await flush();
    };

    context.after(async () => {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      await act(async () => { root.unmount(); });
      container.remove();
      restoreBrowser();
    });

    await renderProbe(HOTEL_ID, 'viewer-a');
    assert.equal(requestCount, 1);
    assert.equal(container.firstElementChild?.getAttribute('data-team-loading'), 'true');
    assert.equal(container.firstElementChild?.getAttribute('data-staff-count'), '0');

    await renderProbe(HOTEL_ID, 'viewer-a');
    assert.equal(requestCount, 1, 'same identity rerenders must not fan out another team request');

    await renderProbe(OTHER_HOTEL_ID, 'viewer-b');
    assert.equal(requestCount, 2);
    assert.equal(container.firstElementChild?.getAttribute('data-team'), '');
    assert.equal(container.firstElementChild?.getAttribute('data-team-loading'), 'true');

    pending.get(HOTEL_ID)?.(jsonResponse({
      ok: true,
      data: { team: [account({ accountId: 'stale-hotel-a' })], hatsByAccountId: {} },
    }));
    await flush();
    assert.equal(container.firstElementChild?.getAttribute('data-team'), '', 'stale hotel response must not paint');

    pending.get(OTHER_HOTEL_ID)?.(jsonResponse({
      ok: true,
      data: { team: [account({ accountId: 'current-hotel-b' })], hatsByAccountId: {} },
    }));
    await flush();
    assert.equal(container.firstElementChild?.getAttribute('data-team'), 'current-hotel-b');
    assert.equal(container.firstElementChild?.getAttribute('data-team-loading'), 'false');
    assert.equal(container.firstElementChild?.getAttribute('data-roster-unavailable'), 'false');
  });

  // Archiving a schedule profile is a fact about SCHEDULING. It used to zero
  // every action on the person's LOGIN as well, which meant the login of the
  // exact person you archived could never again be renamed, disabled, or
  // removed from the hotel — and nothing in the app un-archives a staff row,
  // so it was permanent. The archive confirmation promises the opposite
  // ("Their login, if any, is kept and keeps working"). This test is the
  // promise: the account half stays live, the employment half goes read-only.
  test('an archived schedule profile leaves the login fully manageable', async (context) => {
    const restoreBrowser = installBrowser();
    const { HotelTeamPanel } = await loadHotelTeam();
    await loadEmployment();
    await loadDialogs();
    const { supabase } = await import('@/lib/supabase');
    supabase.auth.stopAutoRefresh();
    const { createRoot } = await import('react-dom/client');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const archivedAccount = account({
      historicalStaffId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      actions: {
        canEditProfile: true,
        canChangeRole: false,
        canResetPassword: false,
        canDeactivate: true,
        canReactivate: false,
        canRemove: true,
      },
    });
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/auth/team?')) {
          return jsonResponse({ ok: true, data: { team: [archivedAccount], hatsByAccountId: {} } });
        }
        if (url.includes('/api/staff/join-requests?')) {
          return jsonResponse({ ok: true, data: { requests: [] } });
        }
        if (url.includes('/api/staff/contacts?')) {
          return jsonResponse({ ok: true, data: { contacts: {} } });
        }
        return jsonResponse({ ok: false, error: `Unexpected request ${url}` }, 500);
      },
    });

    restoreAfter(context, restoreBrowser, root, container);
    context.after(() => {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    });
    await act(async () => {
      root.render(
        <HotelTeamPanel
          hotelId={HOTEL_ID}
          hotelName="Harbor Inn"
          currentUser={currentUser()}
          lang="en"
          canManageTeam
          inviteDialogOpen={false}
          onInviteDialogOpenChange={() => undefined}
          staffProfiles={[staff()]}
          onChanged={() => undefined}
        />,
      );
    });
    await flush();

    // ONE row: the login and the archived staff record are the same human.
    const rows = container.querySelectorAll('[role="listitem"]');
    assert.equal(rows.length, 1, 'the merged archived identity must appear exactly once');
    assert.match(container.textContent ?? '', /Off roster/);

    // The two account-level actions the old floor removed.
    const edit = container.querySelector<HTMLButtonElement>('button[aria-label="Edit Maria Archived"]');
    assert.ok(edit, 'archiving the schedule profile must not take away the login editor');
    assert.equal(edit.disabled, false);
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Maria Archived from this hotel"]',
    );
    assert.ok(remove, 'an archived person must still be removable from the hotel');
    assert.equal(remove.disabled, false);

    await act(async () => {
      edit.click();
      await Promise.resolve();
    });
    await flush();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog, 'clicking Edit must open the real person dialog');

    // Login half: live. The display name is editable and the lifecycle
    // control the server granted is offered.
    const displayName = Array.from(
      dialog.querySelectorAll<HTMLInputElement>('input[type="text"]'),
    ).find((input) => input.value === 'Maria Login');
    assert.ok(displayName, 'the login display name must be present');
    assert.equal(displayName.disabled, false, 'the login display name must stay editable');
    assert.match(dialog.textContent ?? '', /Disable login everywhere/);

    // Employment half: read-only, and honest about why. No editable
    // employment control, and no way to re-archive what is already archived.
    assert.match(dialog.textContent ?? '', /Schedule profile, archived/);
    assert.match(dialog.textContent ?? '', /Archived/);
    assert.doesNotMatch(dialog.textContent ?? '', /Save employment details/);
    assert.doesNotMatch(dialog.textContent ?? '', /Archive schedule profile/);
    assert.doesNotMatch(
      dialog.textContent ?? '',
      /You do not have permission to change this person/,
      'an archived profile must not blame the viewer’s permissions',
    );
  });

  test('keeps pending lifecycle row actions behind the existing disabled gate', async (context) => {
    const restoreBrowser = installBrowser();
    const { PersonRow } = await loadHotelTeam();
    const { supabase } = await import('@/lib/supabase');
    supabase.auth.stopAutoRefresh();
    const { createRoot } = await import('react-dom/client');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const pendingAccount = account({
      displayName: 'Pending Login',
      lifecyclePending: true,
      actions: {
        canEditProfile: true,
        canChangeRole: false,
        canResetPassword: false,
        canDeactivate: false,
        canReactivate: false,
        canRemove: true,
      },
    });
    const person = buildHotelRoster([pendingAccount], [])
      .flatMap((group) => group.people)
      .find((candidate) => candidate.account?.accountId === pendingAccount.accountId);
    assert.ok(person, 'the pending account must produce a row');

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

    const action = container.querySelector<HTMLButtonElement>('button[aria-label="Edit Pending Login"]');
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove Pending Login from this hotel"]');
    assert.ok(action);
    assert.ok(remove);
    assert.equal(action.disabled, true);
    assert.equal(remove.disabled, true);
    assert.match(container.textContent ?? '', /Status change pending/);
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
