/**
 * Render gating for the "Switch account" block in the avatar menu.
 *
 * The server refuses a non-admin caller on its own, so this is not the
 * security boundary. It is the honesty boundary: a hotel manager must never
 * see a list of other people to become, and a switched session must never be
 * able to forget that it is switched. Both are decided entirely by props here,
 * which is why the block was pulled out of ConcourseBar (10 hooks and a portal,
 * un-mountable in these runners) into a hook-free component.
 *
 * Mounted for real in JSDOM and asserted against the DOM, so a plausible bug
 * (dropping the admin gate, putting the way back below the roster, letting the
 * current person be clicked) fails a named case.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  AccountSwitcherMenuSection,
  readSwitchHint,
  type AccountSwitcherMenuSectionProps,
  type SwitchablePerson,
} from '@/components/concourse/AccountSwitcherMenuSection';

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLButtonElement',
  'Node', 'Event', 'EventTarget', 'MouseEvent', 'KeyboardEvent', 'FocusEvent',
  'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
] as const;

function installBrowser(): () => void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/home',
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of DOM_GLOBALS) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const candidate = dom.window[key as keyof typeof dom.window];
    const value =
      typeof candidate === 'function' &&
      (key === 'requestAnimationFrame' || key === 'cancelAnimationFrame' || key === 'getComputedStyle')
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

const PEOPLE: SwitchablePerson[] = [
  { accountId: 'aaaa0000-0000-4000-8000-000000000001', displayName: 'Maria Delgado', roleLine: 'VP of Operations, Testing Hotel' },
  { accountId: 'aaaa0000-0000-4000-8000-000000000002', displayName: 'Oona Ortega', roleLine: 'Owner, Testing Hotel' },
];

function props(overrides: Partial<AccountSwitcherMenuSectionProps> = {}): AccountSwitcherMenuSectionProps {
  return {
    isPlatformAdmin: false,
    switchedBackTo: null,
    currentDisplayName: 'Reeyen Patel',
    people: [],
    currentAccountId: null,
    busy: false,
    onSwitch: () => undefined,
    onReturn: () => undefined,
    ...overrides,
  };
}

async function render(
  overrides: Partial<AccountSwitcherMenuSectionProps> = {},
): Promise<{ host: HTMLElement; root: Root; teardown: () => void }> {
  const restore = installBrowser();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(AccountSwitcherMenuSection, props(overrides)));
  });
  return {
    host,
    root,
    teardown: () => {
      act(() => root.unmount());
      host.remove();
      restore();
    },
  };
}

function buttons(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll('button')] as HTMLButtonElement[];
}

describe('the switch-account block only appears for the people it is for', () => {
  test('a hotel manager sees nothing at all', async () => {
    const { host, teardown } = await render({ isPlatformAdmin: false, people: PEOPLE });
    try {
      assert.equal(host.textContent, '');
      assert.equal(buttons(host).length, 0);
    } finally {
      teardown();
    }
  });

  test('a hotel manager still sees nothing when a roster is cached from a previous admin', async () => {
    // A shared browser could hold the cached names in localStorage. Passing
    // them in must not be enough to draw the menu.
    const { host, teardown } = await render({
      isPlatformAdmin: false,
      switchedBackTo: null,
      people: PEOPLE,
    });
    try {
      assert.doesNotMatch(host.textContent ?? '', /Maria Delgado/);
    } finally {
      teardown();
    }
  });

  test('a platform admin sees the demo people with a one-line role each', async () => {
    const { host, teardown } = await render({ isPlatformAdmin: true, people: PEOPLE });
    try {
      const text = host.textContent ?? '';
      assert.match(text, /Switch account/);
      assert.match(text, /Maria Delgado/);
      assert.match(text, /VP of Operations, Testing Hotel/);
      assert.match(text, /Oona Ortega/);
      assert.equal(buttons(host).length, 2);
      // No way back is offered while you are still yourself.
      assert.equal(host.querySelector('[data-testid="account-switch-return"]'), null);
    } finally {
      teardown();
    }
  });

  test('a platform admin with an empty roster sees no empty header', async () => {
    const { host, teardown } = await render({ isPlatformAdmin: true, people: [] });
    try {
      assert.equal(host.textContent, '');
    } finally {
      teardown();
    }
  });
});

describe('a switched session always knows it is switched', () => {
  test('the way back is the first item, above the roster', async () => {
    const { host, teardown } = await render({
      isPlatformAdmin: false,
      switchedBackTo: 'Reeyen Patel',
      currentDisplayName: 'Maria Delgado',
      people: PEOPLE,
      currentAccountId: PEOPLE[0].accountId,
    });
    try {
      const rows = buttons(host);
      assert.equal(rows[0].dataset.testid, 'account-switch-return');
      assert.match(rows[0].textContent ?? '', /Back to Reeyen Patel/);

      const banner = host.querySelector('[data-testid="account-switch-banner"]');
      assert.ok(banner);
      assert.equal(banner.textContent, 'You are Maria Delgado (switched)');
    } finally {
      teardown();
    }
  });

  test('the person you currently are is marked and cannot be re-picked', async () => {
    const clicked: string[] = [];
    const { host, teardown } = await render({
      switchedBackTo: 'Reeyen Patel',
      currentDisplayName: 'Maria Delgado',
      people: PEOPLE,
      currentAccountId: PEOPLE[0].accountId,
      onSwitch: (id) => clicked.push(id),
    });
    try {
      const current = host.querySelector<HTMLButtonElement>(
        `[data-testid="account-switch-person-${PEOPLE[0].accountId}"]`,
      );
      const other = host.querySelector<HTMLButtonElement>(
        `[data-testid="account-switch-person-${PEOPLE[1].accountId}"]`,
      );
      assert.ok(current && other);
      assert.equal(current.disabled, true);
      assert.match(current.className, /cx-on/);
      assert.equal(other.disabled, false);

      await act(async () => { other.click(); });
      assert.deepEqual(clicked, [PEOPLE[1].accountId]);
    } finally {
      teardown();
    }
  });

  test('a switch already in flight cannot be double-fired', async () => {
    const clicked: string[] = [];
    const returned: number[] = [];
    const { host, teardown } = await render({
      switchedBackTo: 'Reeyen Patel',
      currentDisplayName: 'Maria Delgado',
      people: PEOPLE,
      busy: true,
      onSwitch: (id) => clicked.push(id),
      onReturn: () => returned.push(1),
    });
    try {
      for (const button of buttons(host)) {
        assert.equal(button.disabled, true);
        await act(async () => { button.click(); });
      }
      assert.deepEqual(clicked, []);
      assert.deepEqual(returned, []);
    } finally {
      teardown();
    }
  });

  test('tapping the way back calls it once', async () => {
    let calls = 0;
    const { host, teardown } = await render({
      switchedBackTo: 'Reeyen Patel',
      currentDisplayName: 'Maria Delgado',
      onReturn: () => { calls += 1; },
    });
    try {
      const back = host.querySelector<HTMLButtonElement>('[data-testid="account-switch-return"]');
      assert.ok(back);
      await act(async () => { back.click(); });
      assert.equal(calls, 1);
    } finally {
      teardown();
    }
  });
});

describe('reading the switched-session hint off the browser cookie', () => {
  test('finds the name among other cookies, whatever the order', () => {
    assert.equal(
      readSwitchHint('sb-abc-auth-token=x; staxis_switch_hint=Reeyen%20Patel; staxis_device=y'),
      'Reeyen Patel',
    );
    assert.equal(readSwitchHint('staxis_switch_hint=Reeyen%20Patel'), 'Reeyen Patel');
  });

  test('an absent, empty, or lookalike cookie means "not switched"', () => {
    assert.equal(readSwitchHint(''), null);
    assert.equal(readSwitchHint('staxis_device=y'), null);
    assert.equal(readSwitchHint('staxis_switch_hint='), null);
    // A prefix match must not count, or signing out would leave a phantom.
    assert.equal(readSwitchHint('staxis_switch_hint_old=Someone'), null);
  });

  test('an undecodable value is treated as not switched rather than throwing', () => {
    assert.equal(readSwitchHint('staxis_switch_hint=%E0%A4%A'), null);
  });
});

describe('copy rules', () => {
  test('nothing rendered here uses an em dash or the two letters Reeyen banned', async () => {
    const { host, teardown } = await render({
      isPlatformAdmin: true,
      switchedBackTo: 'Reeyen Patel',
      currentDisplayName: 'Maria Delgado',
      people: PEOPLE,
    });
    try {
      const text = host.textContent ?? '';
      assert.ok(text.length > 0);
      assert.doesNotMatch(text, /—/, 'no em dashes in user-facing copy');
      assert.doesNotMatch(text, /\bAI\b/, '"AI" never appears in the product UI');
    } finally {
      teardown();
    }
  });
});
