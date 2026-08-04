import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import type { Root } from 'react-dom/client';

import type { AppUser } from '@/contexts/AuthContext';
import type { StaffMember } from '@/types';

type HotelTeamPanelModule = typeof import('@/app/company/_components/HotelTeamPanel');
type CompanyPageModule = typeof import('@/app/company/page');
type PeoplePanelProps = Parameters<CompanyPageModule['PeoplePanel']>[0];

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
const USER: AppUser = {
  uid: 'user-1',
  accountId: 'account-1',
  username: 'owner',
  displayName: 'Harbor Owner',
  role: 'owner',
  propertyAccess: [HOTEL_ID],
  staffId: null,
  isDemo: false,
};
const STAFF: StaffMember = {
  id: 'staff-1',
  name: 'Riley Housekeeper',
  language: 'en',
  isSenior: false,
  department: 'housekeeping',
  scheduledToday: false,
  weeklyHours: 0,
  maxWeeklyHours: 40,
};
const ADMIN_PREVIEW_STAFF: StaffMember = {
  id: 'admin-staff',
  name: 'Hidden Admin Schedule',
  language: 'en',
  isSenior: false,
  department: 'housekeeping',
  scheduledToday: false,
  weeklyHours: 0,
  maxWeeklyHours: 40,
};

const VALID_OPTIONS = {
  choosesHotels: false,
  organizationId: null,
  jobs: [{
    value: 'housekeeping',
    scope: 'property' as const,
    label: { en: 'Housekeeping' },
    allowedPropertyIds: [HOTEL_ID],
  }],
  hotels: [],
};
const VALID_CODE = {
  id: 'code-1',
  code: 'HARBOR-4821',
  role: null,
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  max_uses: 10,
  used_count: 0,
  created_at: new Date(Date.now() - 60_000).toISOString(),
};
const REPLACED_CODE = { ...VALID_CODE, id: 'code-2', code: 'HARBOR-7359' };
const VALID_INVITE = {
  id: 'invite-1',
  email: 'pending@example.com',
  role: 'housekeeping',
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  created_at: new Date(Date.now() - 60_000).toISOString(),
  organizationId: null,
  scope: 'hotel' as const,
  propertyIds: [HOTEL_ID],
  propertyNames: ['Harbor Inn'],
  canRevoke: true,
};

const PREVIEW_TEAM = [
  {
    accountId: 'platform-admin',
    username: 'staxis.admin',
    displayName: 'Staxis Platform Admin',
    email: 'admin@example.com',
    role: 'admin',
    active: true,
    updatedAt: '2026-07-01T12:00:00.000Z',
    ownerProtected: false,
    lastSignInKnown: true,
    lastSignInAt: '2026-07-15T12:00:00.000Z',
    propertyAccess: [HOTEL_ID],
    staffId: 'admin-staff',
    isPlatformAdmin: true,
    managementSurface: 'legacy_hotel',
    actions: {
      canEditProfile: true,
      canChangeRole: true,
      canDeactivate: true,
      canReactivate: true,
      canRemove: true,
    },
  },
  {
    accountId: 'account-owner-2',
    username: 'owner.two',
    displayName: 'Owner Two',
    email: 'owner.two@example.com',
    role: 'owner',
    active: true,
    updatedAt: '2026-07-01T12:00:00.000Z',
    ownerProtected: true,
    lastSignInKnown: true,
    lastSignInAt: '2026-07-15T12:00:00.000Z',
    propertyAccess: [HOTEL_ID],
    staffId: null,
    managementSurface: 'legacy_hotel',
    actions: {
      canEditProfile: true,
      canChangeRole: true,
      canDeactivate: true,
      canReactivate: true,
      canRemove: true,
    },
  },
  {
    accountId: 'account-gm',
    username: 'general.manager',
    displayName: 'General Manager Login',
    email: 'gm@example.com',
    role: 'general_manager',
    active: true,
    updatedAt: '2026-07-01T12:00:00.000Z',
    ownerProtected: false,
    lastSignInKnown: true,
    lastSignInAt: '2026-07-15T12:00:00.000Z',
    propertyAccess: [HOTEL_ID],
    staffId: 'staff-1',
    managementSurface: 'legacy_hotel',
    actions: {
      canEditProfile: true,
      canChangeRole: true,
      canDeactivate: true,
      canReactivate: true,
      canRemove: true,
    },
  },
  {
    accountId: 'account-disabled',
    username: 'front.desk',
    displayName: 'Disabled Front Desk',
    email: 'frontdesk@example.com',
    role: 'front_desk',
    active: false,
    updatedAt: '2026-07-01T12:00:00.000Z',
    ownerProtected: false,
    lastSignInKnown: true,
    lastSignInAt: null,
    propertyAccess: [HOTEL_ID],
    staffId: null,
    managementSurface: 'legacy_hotel',
    actions: {
      canEditProfile: false,
      canChangeRole: false,
      canDeactivate: false,
      canReactivate: true,
      canRemove: true,
    },
  },
];
const PREVIEW_REQUEST = {
  id: 'request-1',
  name: 'Pending Applicant',
  phone: null,
  language: 'en',
  department: 'housekeeping',
  created_at: '2026-07-15T12:00:00.000Z',
};

interface CapabilityState {
  canManageTeam: boolean;
  canInviteAccounts: boolean;
  readOnly: boolean;
  adminPreview: boolean;
}

interface ResponseSpec {
  body: unknown;
  status?: number;
}

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

interface InviteFlowHarness {
  calls: RecordedCall[];
  dialog: () => HTMLElement | null;
  text: () => string;
  buttonLabels: () => string[];
  click: (label: string) => Promise<void>;
  clickNth: (label: string, index: number) => Promise<void>;
  setInput: (selector: string, value: string) => Promise<void>;
  setSelect: (selector: string, value: string) => Promise<void>;
  submit: () => Promise<void>;
  setCapabilities: (next: CapabilityState) => Promise<void>;
  setInviteResponses: (...responses: ResponseSpec[]) => void;
  setCodeResponses: (...responses: ResponseSpec[]) => void;
  holdNextInviteLoad: () => void;
  releaseHeldInvite: (response: ResponseSpec) => void;
  flush: () => Promise<void>;
}

interface RosterFixtureOptions {
  staff?: StaffMember[];
  team?: unknown[];
  requests?: unknown[];
  canAddStaff?: boolean;
  canViewTeam?: boolean;
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

let panelModulePromise: Promise<HotelTeamPanelModule> | null = null;
function loadPanelModule(): Promise<HotelTeamPanelModule> {
  panelModulePromise ??= loadWithCssShim(
    () => import('@/app/company/_components/HotelTeamPanel'),
  );
  return panelModulePromise;
}

let companyPageModulePromise: Promise<CompanyPageModule> | null = null;
function loadCompanyPageModule(): Promise<CompanyPageModule> {
  companyPageModulePromise ??= loadWithCssShim(
    () => import('@/app/company/page'),
  );
  return companyPageModulePromise;
}

let dialogsModulePromise: Promise<unknown> | null = null;
function loadDialogsModule(): Promise<unknown> {
  dialogsModulePromise ??= loadWithCssShim(
    () => import('@/app/company/_components/HotelTeamDialogs'),
  );
  return dialogsModulePromise;
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

async function flushReact(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 18; index += 1) await Promise.resolve();
  });
}

function responseFor(spec: ResponseSpec): Response {
  return jsonResponse(spec.body, spec.status ?? 200);
}

function parseRequestBody(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string') return null;
  try { return JSON.parse(init.body); } catch { return init.body; }
}

async function mountInviteFlow(
  context: TestContext,
  initialCapabilities: CapabilityState,
  initialInviteResponse: ResponseSpec = {
    body: { ok: true, data: { invites: [VALID_INVITE], options: VALID_OPTIONS } },
  },
  roster: RosterFixtureOptions = {},
): Promise<InviteFlowHarness> {
  const restoreBrowser = installBrowser();
  const { HotelTeamPanel } = await loadPanelModule();
  await loadDialogsModule();
  const { supabase } = await import('@/lib/supabase');
  supabase.auth.stopAutoRefresh();
  const { createRoot } = await import('react-dom/client');

  const calls: RecordedCall[] = [];
  let inviteResponses: ResponseSpec[] = [initialInviteResponse];
  let codeResponses: ResponseSpec[] = [{ body: { ok: true, data: { codes: [VALID_CODE] } } }];
  let holdNextInvite = false;
  let heldInviteResolver: ((response: Response) => void) | null = null;
  const controls = {
    setCapabilities: (_next: CapabilityState): void => undefined,
    inviteOpen: false,
  };

  const nextResponse = (responses: ResponseSpec[], fallback: ResponseSpec): Response => (
    responseFor(responses.shift() ?? fallback)
  );
  const answer = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: parseRequestBody(init) });

    if (url.startsWith('/api/auth/team?')) {
      return jsonResponse({ ok: true, data: { team: roster.team ?? [], hatsByAccountId: {} } });
    }
    if (url.startsWith('/api/staff/join-requests?')) {
      return jsonResponse({ ok: true, data: { requests: roster.requests ?? [] } });
    }
    if (url.startsWith('/api/staff/contacts?')) {
      return jsonResponse({ ok: true, data: { contacts: {} } });
    }
    if (url.startsWith('/api/auth/join-codes?') && method === 'GET') {
      return nextResponse(codeResponses, { body: { ok: true, data: { codes: [] } } });
    }
    if (url === '/api/auth/join-codes' && method === 'POST') {
      return jsonResponse({ ok: true, data: { joinCode: REPLACED_CODE } });
    }
    if (url.startsWith('/api/auth/join-codes?') && method === 'DELETE') {
      return jsonResponse({ ok: true, data: { success: true } });
    }
    if (url.startsWith('/api/auth/invites?') && method === 'GET') {
      if (holdNextInvite) {
        holdNextInvite = false;
        return new Promise<Response>((resolve) => { heldInviteResolver = resolve; });
      }
      return nextResponse(inviteResponses, {
        body: { ok: true, data: { invites: [], options: VALID_OPTIONS } },
      });
    }
    if (url === '/api/auth/invites' && method === 'POST') {
      return jsonResponse({
        ok: true,
        data: {
          emailSent: true,
          deliveryStatus: 'sent',
          inviteLink: 'https://staxis.test/company-invite/new',
          accessGranted: false,
          profileLinked: true,
        },
      });
    }
    if (url.startsWith('/api/auth/invites?') && method === 'DELETE') {
      return jsonResponse({ ok: true, data: { success: true } });
    }
    return jsonResponse({ ok: false, error: `Unexpected request ${method} ${url}` }, 500);
  };

  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => answer(input, init),
  });

  function TestPanel() {
    const [capabilities, setCapabilities] = useState(initialCapabilities);
    const [inviteOpen, setInviteOpen] = useState(false);
    controls.setCapabilities = setCapabilities;
    controls.inviteOpen = inviteOpen;
    return (
      <HotelTeamPanel
        hotelId={HOTEL_ID}
        hotelName={'Harbor Inn'}
        currentUser={USER}
        lang={'en'}
        canManageTeam={capabilities.canManageTeam}
        canInviteAccounts={capabilities.canInviteAccounts}
        canViewWages={false}
        readOnly={capabilities.readOnly}
        adminPreview={capabilities.adminPreview}
        inviteDialogOpen={inviteOpen}
        onInviteDialogOpenChange={setInviteOpen}
        staffProfiles={[STAFF]}
        rosterUnavailable={false}
        canAddStaff={roster.canAddStaff ?? capabilities.canManageTeam}
        onChanged={() => undefined}
      />
    );
  }

  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(<TestPanel />); });
  await flushReact();

  const clickNth = async (label: string, index: number): Promise<void> => {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter((button) => (
      !button.disabled && (button.textContent ?? '').includes(label)
    ));
    const button = buttons[index] ?? null;
    assert.ok(button, `button "${label}" at index ${index} must be available`);
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    await flushReact();
  };
  const click = (label: string): Promise<void> => clickNth(label, 0);
  const setValue = async (element: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> => {
    const prototype = element instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    assert.ok(valueSetter, 'JSDOM value setter must exist');
    await act(async () => {
      valueSetter.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
  };
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

  context.after(async () => {
    if (heldInviteResolver) {
      heldInviteResolver(responseFor({
        body: { ok: true, data: { invites: [], options: VALID_OPTIONS } },
      }));
      heldInviteResolver = null;
    }
    supabase.auth.stopAutoRefresh();
    await act(async () => { root.unmount(); });
    container.remove();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    restoreBrowser();
  });

  return {
    calls,
    dialog,
    text: () => document.body.textContent ?? '',
    buttonLabels: () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .map((button) => (button.textContent ?? '').replace(/\s+/g, ' ').trim()),
    click,
    clickNth,
    async setInput(selector, value) {
      const input = document.querySelector<HTMLInputElement>(selector);
      assert.ok(input, `input "${selector}" must be available`);
      await setValue(input, value);
    },
    async setSelect(selector, value) {
      const select = document.querySelector<HTMLSelectElement>(selector);
      assert.ok(select, `select "${selector}" must be available`);
      await setValue(select, value);
    },
    async submit() {
      const form = dialog()?.querySelector<HTMLFormElement>('form');
      assert.ok(form, 'invite form must be available');
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        for (let index = 0; index < 16; index += 1) await Promise.resolve();
      });
      await flushReact();
    },
    async setCapabilities(next) {
      await act(async () => {
        controls.setCapabilities(next);
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      });
      await flushReact();
    },
    setInviteResponses(...responses) { inviteResponses = [...responses]; },
    setCodeResponses(...responses) { codeResponses = [...responses]; },
    holdNextInviteLoad() { holdNextInvite = true; },
    releaseHeldInvite(response) {
      assert.ok(heldInviteResolver, 'an invite load must be held before release');
      heldInviteResolver(responseFor(response));
      heldInviteResolver = null;
    },
    flush: flushReact,
  };
}

interface PeoplePanelHarness {
  calls: RecordedCall[];
  text: () => string;
  buttonLabels: () => string[];
  dialog: () => HTMLElement | null;
  click: (label: string) => Promise<void>;
  setCapabilities: (next: CapabilityState) => Promise<void>;
  flushWithFrame: () => Promise<void>;
}

async function mountPeoplePanel(
  context: TestContext,
  initialCapabilities: CapabilityState,
  options: RosterFixtureOptions & { adminPreview?: boolean; inviteDialogOpen?: boolean } = {},
): Promise<PeoplePanelHarness> {
  const restoreBrowser = installBrowser();
  const { PeoplePanel } = await loadCompanyPageModule();
  await loadDialogsModule();
  const { supabase } = await import('@/lib/supabase');
  supabase.auth.stopAutoRefresh();
  const { createRoot } = await import('react-dom/client');

  const controls = {
    setCapabilities: (_next: CapabilityState): void => undefined,
  };
  const calls: RecordedCall[] = [];
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, body: parseRequestBody(init) });
      if (url.startsWith('/api/auth/team?')) {
        return jsonResponse({ ok: true, data: { team: options.team ?? [], hatsByAccountId: {} } });
      }
      if (url.startsWith('/api/staff/join-requests?')) {
        return jsonResponse({ ok: true, data: { requests: options.requests ?? [] } });
      }
      if (url.startsWith('/api/staff/contacts?')) {
        return jsonResponse({ ok: true, data: { contacts: {} } });
      }
      if (url.startsWith('/api/auth/join-codes?') && method === 'GET') {
        return jsonResponse({ ok: true, data: { codes: [VALID_CODE] } });
      }
      if (url.startsWith('/api/auth/invites?') && method === 'GET') {
        return jsonResponse({ ok: true, data: { invites: [], options: VALID_OPTIONS } });
      }
      return jsonResponse({ ok: false, error: `Unexpected request ${method} ${url}` }, 500);
    },
  });

  function TestPeoplePanel() {
    const [capabilities, setCapabilities] = useState(initialCapabilities);
    const [inviteOpen, setInviteOpen] = useState(Boolean(options.inviteDialogOpen));
    controls.setCapabilities = setCapabilities;
    const data = {
      permissions: { viewPeople: true, manageInvitations: false },
      memberships: [],
      invitations: [],
      organizations: [],
      viewerContext: {
        kind: options.adminPreview ? 'staxis_admin_preview' : 'customer',
        readOnly: Boolean(options.adminPreview),
      },
    } as unknown as PeoplePanelProps['data'];
    return (
      <PeoplePanel
        data={data}
        staff={options.staff ?? [STAFF]}
        hotelRosterUnavailable={false}
        lang={'en'}
        currentUser={USER}
        currentAccountId={USER.accountId}
        activeProperty={{ id: HOTEL_ID, name: 'Harbor Inn' } as PeoplePanelProps['activeProperty']}
        canManageTeam={capabilities.canManageTeam}
        canViewTeam={options.canViewTeam ?? (capabilities.canManageTeam || Boolean(options.adminPreview))}
        canInviteAccounts={capabilities.canInviteAccounts}
        canViewWages={false}
        canAddOperationalStaff={options.canAddStaff ?? false}
        inviteDialogOpen={inviteOpen}
        onInviteDialogOpenChange={setInviteOpen}
        onChanged={() => undefined}
        onLifecycleAction={() => undefined}
      />
    );
  }

  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(<TestPeoplePanel />); });
  await flushReact();

  const findButton = (label: string): HTMLButtonElement | null => (
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => (
      !button.disabled && (button.textContent ?? '').includes(label)
    )) ?? null
  );
  const click = async (label: string): Promise<void> => {
    const button = findButton(label);
    assert.ok(button, `button "${label}" must be available`);
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    await flushReact();
  };
  const flushWithFrame = async (): Promise<void> => {
    await flushReact();
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await flushReact();
  };

  context.after(async () => {
    supabase.auth.stopAutoRefresh();
    await act(async () => { root.unmount(); });
    container.remove();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    restoreBrowser();
  });

  return {
    calls,
    text: () => document.body.textContent ?? '',
    buttonLabels: () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .map((button) => (button.textContent ?? '').replace(/\s+/g, ' ').trim()),
    dialog: () => document.querySelector<HTMLElement>('[role="dialog"]'),
    click,
    async setCapabilities(next) {
      await act(async () => {
        controls.setCapabilities(next);
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      });
      await flushWithFrame();
    },
    flushWithFrame,
  };
}

describe('mounted hotel invite flow', { concurrency: false }, () => {
  test('manager reaches the compact destination, replaces a shared code, and sends a roster-linked email invite', async (context) => {
    const ui = await mountInviteFlow(context, {
      canManageTeam: true,
      canInviteAccounts: true,
      readOnly: false,
      adminPreview: false,
    });

    await ui.click('Invite people');
    assert.match(ui.text(), /What does this person need\?/);
    assert.match(ui.text(), /NO LOGIN/);
    assert.match(ui.text(), /STAXIS LOGIN/);

    await ui.click('STAXIS LOGIN');
    await ui.flush();
    const destinationText = ui.text();
    assert.match(destinationText, /Hotel invite/);
    assert.match(destinationText, /Email one person/);
    assert.match(destinationText, /Link/);
    assert.match(destinationText, /QR code/);
    assert.match(destinationText, /Signup code/);
    assert.match(destinationText, /Send invite/);
    assert.match(destinationText, /Pending email invitations/);
    assert.doesNotMatch(destinationText, /Shared hotel invite|Email one person\s+Email one person|Done/);

    await ui.click('Create a new link');
    await ui.click('Replace link');
    assert.ok(ui.calls.some((call) => call.method === 'DELETE' && call.url.startsWith('/api/auth/join-codes?')));
    assert.ok(ui.calls.some((call) => call.method === 'POST' && call.url === '/api/auth/join-codes'));

    await ui.setInput('input[type="email"]', '  Invitee@Example.com ');
    await ui.setSelect('form select', 'housekeeping');
    await ui.setSelect('select[aria-describedby]', 'staff-1');
    ui.setInviteResponses({
      body: { ok: true, data: { invites: [], options: VALID_OPTIONS } },
    });
    await ui.submit();

    const sent = ui.calls.find((call) => call.method === 'POST' && call.url === '/api/auth/invites');
    assert.ok(sent, 'email submission must use the existing invite route');
    assert.deepEqual(sent.body, {
      hotelId: HOTEL_ID,
      email: 'invitee@example.com',
      role: 'housekeeping',
      staffId: 'staff-1',
    });
    assert.doesNotMatch(ui.text(), /Pending email invitations/);
  });

  test('account-invite-only viewers see email loading, bounded errors, and a true zero-pending state', async (context) => {
    const ui = await mountInviteFlow(context, {
      canManageTeam: false,
      canInviteAccounts: true,
      readOnly: false,
      adminPreview: false,
    });
    ui.holdNextInviteLoad();

    await ui.click('Invite people');
    assert.match(ui.text(), /STAXIS LOGIN/);
    assert.doesNotMatch(ui.text(), /NO LOGIN/);
    await ui.click('STAXIS LOGIN');
    assert.match(ui.text(), /Email one person/);
    assert.match(ui.text(), /Loading invitations…/);
    assert.doesNotMatch(ui.text(), /Hotel invite|Create hotel invite/);
    assert.equal(ui.calls.filter((call) => call.url.startsWith('/api/auth/join-codes')).length, 0);

    ui.releaseHeldInvite({ body: { ok: false, error: 'Pending invitations are unavailable.' }, status: 503 });
    await ui.flush();
    assert.match(ui.text(), /Pending invitations are unavailable\./);
    assert.match(ui.text(), /Retry/);

    ui.setInviteResponses({
      body: { ok: true, data: { invites: [], options: VALID_OPTIONS } },
    });
    await ui.click('Retry');
    assert.doesNotMatch(ui.text(), /Pending email invitations/);
    assert.match(ui.text(), /Send invite/);
  });

  test('malformed successful payloads stay errors while valid empty arrays remain empty', async (context) => {
    const ui = await mountInviteFlow(context, {
      canManageTeam: true,
      canInviteAccounts: true,
      readOnly: false,
      adminPreview: false,
    }, {
      body: { ok: true, data: { options: VALID_OPTIONS } },
    });
    ui.setCodeResponses({ body: { ok: true, data: {} } });

    await ui.click('Invite people');
    await ui.click('STAXIS LOGIN');
    await ui.flush();
    assert.match(ui.text(), /Couldn't load the staff invite link\./);
    assert.match(ui.text(), /Couldn't load manager invitations\./);
    assert.doesNotMatch(ui.text(), /Create hotel invite|Pending email invitations/);

    ui.setCodeResponses({ body: { ok: true, data: { codes: [] } } });
    ui.setInviteResponses({
      body: { ok: true, data: { invites: [], options: VALID_OPTIONS } },
    });
    await ui.click('Retry');
    await ui.click('Retry');
    assert.doesNotMatch(ui.text(), /Couldn't load the staff invite link|Couldn't load manager invitations/);
    assert.match(ui.text(), /Create hotel invite/);
    assert.doesNotMatch(ui.text(), /Pending email invitations/);
  });

  test('capability revocation closes both dialog layers, restores focus safely, and does not resurrect draft state', async (context) => {
    const ui = await mountInviteFlow(context, {
      canManageTeam: true,
      canInviteAccounts: true,
      readOnly: false,
      adminPreview: false,
    });

    await ui.click('Invite people');
    await ui.click('STAXIS LOGIN');
    await ui.setInput('input[type="email"]', 'draft@example.com');

    await ui.setCapabilities({
      canManageTeam: false,
      canInviteAccounts: true,
      readOnly: false,
      adminPreview: false,
    });
    await ui.flush();
    assert.equal(ui.dialog(), null);
    assert.equal(document.activeElement?.id, 'hotel-team-title');

    await ui.setCapabilities({
      canManageTeam: true,
      canInviteAccounts: true,
      readOnly: false,
      adminPreview: false,
    });
    await ui.flush();
    assert.equal(ui.dialog(), null);
    assert.equal(ui.text().includes('draft@example.com'), false);

    await ui.click('Invite people');
    await ui.click('STAXIS LOGIN');
    const email = ui.dialog()?.querySelector<HTMLInputElement>('input[type="email"]');
    assert.ok(email, 'reopened invite form must render');
    assert.equal(email.value, '');

    await ui.setInput('input[type="email"]', 'account-only-draft@example.com');
    await ui.setCapabilities({
      canManageTeam: false,
      canInviteAccounts: false,
      readOnly: false,
      adminPreview: false,
    });
    assert.equal(ui.dialog(), null);
    assert.equal(document.activeElement?.id, 'hotel-team-title');
    assert.equal(ui.text().includes('account-only-draft@example.com'), false);

    await ui.setCapabilities({
      canManageTeam: false,
      canInviteAccounts: true,
      readOnly: false,
      adminPreview: false,
    });
    await ui.click('Invite people');
    await ui.click('STAXIS LOGIN');
    const accountOnlyEmail = ui.dialog()?.querySelector<HTMLInputElement>('input[type="email"]');
    assert.ok(accountOnlyEmail, 'reopened account-only invite form must render');
    assert.equal(accountOnlyEmail.value, '');
  });

  test('the page-level PeoplePanel remount restores focus to the newly mounted heading', async (context) => {
    const ui = await mountPeoplePanel(context, {
      canManageTeam: true,
      canInviteAccounts: true,
      readOnly: false,
      adminPreview: false,
    });

    await ui.click('Invite people');
    await ui.click('STAXIS LOGIN');
    assert.match(ui.text(), /Hotel invite/);
    assert.match(ui.text(), /Email one person/);

    await ui.setCapabilities({
      canManageTeam: false,
      canInviteAccounts: true,
      readOnly: false,
      adminPreview: false,
    });
    assert.equal(ui.dialog(), null);
    assert.equal(document.activeElement?.id, 'hotel-team-title');
  });

  test('admin preview shows the roster but exposes no first-person or roster mutations', async (context) => {
    const ui = await mountPeoplePanel(context, {
      canManageTeam: false,
      canInviteAccounts: true,
      readOnly: false,
      adminPreview: true,
    }, {
      adminPreview: true,
      inviteDialogOpen: true,
      team: PREVIEW_TEAM,
      requests: [PREVIEW_REQUEST],
      staff: [STAFF, ADMIN_PREVIEW_STAFF],
      canAddStaff: true,
      canViewTeam: true,
    });

    await ui.flushWithFrame();
    assert.match(ui.text(), /Owner Two/);
    assert.match(ui.text(), /Riley Housekeeper/);
    assert.match(ui.text(), /Pending Applicant/);
    assert.doesNotMatch(ui.text(), /Staxis Platform Admin|Hidden Admin Schedule/);
    assert.equal(ui.dialog(), null);

    const buttons = ui.buttonLabels().join(' | ');
    assert.match(buttons, /View/);
    assert.doesNotMatch(
      buttons,
      /Add first person|Invite people|Add to|Edit|Remove|Approve|Deny|Disable|Reactivate/,
    );
    await ui.click('View');
    assert.ok(ui.dialog(), 'preview may open a read-only person view');
    const mutationButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .filter((button) => /Save changes|Disable login everywhere|Reactivate login|Remove/.test(button.textContent ?? ''));
    assert.ok(mutationButtons.length > 0, 'the person view must expose its disabled mutation affordances truthfully');
    assert.ok(mutationButtons.every((button) => button.disabled), 'preview person view must keep every mutation disabled');
    assert.ok(ui.calls.length > 0, 'preview should load the selected hotel roster data');
    assert.ok(ui.calls.every((call) => call.method === 'GET'), 'preview must not reach any write endpoint');
  });

  test('an authorized customer manager keeps invite, approval, edit, lifecycle, and remove actions', async (context) => {
    const ui = await mountInviteFlow(context, {
      canManageTeam: true,
      canInviteAccounts: true,
      readOnly: false,
      adminPreview: false,
    }, undefined, {
      team: PREVIEW_TEAM,
      requests: [PREVIEW_REQUEST],
      canAddStaff: true,
    });

    await ui.flush();
    const buttons = ui.buttonLabels().join(' | ');
    assert.match(buttons, /Invite people/);
    assert.match(buttons, /Add to Housekeeping/);
    assert.match(buttons, /Edit/);
    assert.match(buttons, /Remove/);
    assert.match(buttons, /Approve/);
    assert.match(buttons, /Deny/);

    await ui.clickNth('Edit', 1);
    await ui.flush();
    assert.match(ui.text(), /Disable login everywhere/);
    assert.ok(ui.dialog(), 'an authorized manager may open the member editor');
  });
});
