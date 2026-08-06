/**
 * The Knows page, rendered for real.
 *
 * The founder's brief for the 2026-08-05 rebuild was a shape, not a feature
 * list: ONE button on top, ONE list underneath in two groups, one plain
 * sentence per row, and nothing else. Every part of that is a claim about what
 * is on the screen, so it is checked against a real React render rather than
 * against the modules that feed it.
 *
 * What each test is protecting:
 *
 *   1. THE SHAPE. Tabs, section strips and a fact counter are exactly what
 *      grew here last time, one harmless-looking addition at a time. These
 *      assert their absence, not just the presence of the new page.
 *   2. THE BUTTON SET PER GROUP. "That's wrong" belongs to a guess and
 *      "Remove" to something a person said; swapping them tells a manager
 *      their own sentence was Staxis's idea.
 *   3. THE EMPTY STATE. A brand-new hotel must be invited, never congratulated.
 *   4. WHO GETS THE BUTTONS. A reader without write standing sees the list and
 *      no controls, which is how the front desk keeps reaching the emergency
 *      numbers without gaining the ability to edit the hotel's knowledge.
 *   5. THE TAP-TO-CALL LINK. The contact directory became sentences; the
 *      number in one still has to dial.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

// Imported before jsdom is installed so the singleton Supabase client stays in
// its quiet non-browser test mode. Constructed with a `window` present it
// starts auto-refresh timers that keep the test process alive forever.
import { supabase } from '@/lib/supabase';
import type { KnowsItem } from '@/lib/knows/page-model';

type KnowsModule = typeof import('@/components/concourse/KnowsView');

const PID = 'aaaaaaaa-0000-4000-8000-000000000001';

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'localStorage',
  'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
  'HTMLButtonElement', 'HTMLFormElement', 'HTMLAnchorElement',
  'Node', 'Event', 'InputEvent', 'SubmitEvent', 'EventTarget',
  'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'BroadcastChannel',
  'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame',
  'getComputedStyle',
] as const;

function installBrowser(): () => void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test/feed',
    pretendToBeVisual: true,
  });
  const originals = DOM_GLOBALS.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const key of DOM_GLOBALS) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    if (value !== undefined) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
  }
  const actFlag = 'IS_REACT_ACT_ENVIRONMENT';
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

interface Sent { url: string; body: unknown }

type SessionReader = {
  getSession(): Promise<{ data: { session: null }; error: null }>;
};

async function mountKnows(
  context: TestContext,
  page: { items: KnowsItem[]; canTeach: boolean; canSeeNoticed: boolean },
): Promise<{ container: HTMLElement; sent: Sent[] }> {
  const restoreBrowser = installBrowser();
  const { KnowsPropertyView } = await loadWithCssShim<KnowsModule>(
    () => import('@/components/concourse/KnowsView'),
  );
  supabase.auth.stopAutoRefresh();
  // fetchWithAuth preflights the token. Left real it would try to reach the
  // placeholder Supabase host and hang the run.
  context.mock.method(
    supabase.auth as unknown as SessionReader,
    'getSession',
    async () => ({ data: { session: null }, error: null }),
  );
  const { createRoot } = await import('react-dom/client');

  const sent: Sent[] = [];
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      if (init?.method === 'POST') {
        sent.push({ url, body: init.body ? JSON.parse(init.body) : null });
        return new Response(JSON.stringify({ ok: true, requestId: 'r', data: {} }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, requestId: 'r', data: page }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });

  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<KnowsPropertyView propertyId={PID} scopeKey={`u:${PID}`} />);
  });
  await flushReact();

  context.after(() => {
    act(() => { root.unmount(); });
    container.remove();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true, writable: true, value: originalFetch,
    });
    restoreBrowser();
  });
  return { container, sent };
}

function buttonLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim());
}

function item(over: Partial<KnowsItem> = {}): KnowsItem {
  return {
    id: over.id ?? 'i1',
    kind: over.kind ?? 'fact',
    group: over.group ?? 'taught',
    sentence: over.sentence ?? 'We buy towels from Riz Supply.',
    tel: over.tel ?? null,
    telText: over.telText ?? null,
    at: over.at ?? '2026-08-01T10:00:00.000Z',
  };
}

const NOTICED = item({
  id: 'n1', group: 'noticed', sentence: 'Room 214 loses hot water in winter.',
});
const TAUGHT = item({ id: 't1', group: 'taught' });

describe('the Knows page is one page', () => {
  test('one teach button on top, and no tab strip anywhere', async (t) => {
    const { container } = await mountKnows(t, {
      items: [NOTICED, TAUGHT], canTeach: true, canSeeNoticed: true,
    });

    const teach = buttonLabels(container).filter((label) => label.includes('Teach it something'));
    assert.equal(teach.length, 1, 'exactly one door into saying something');

    // The two half-tabs and the four section tabs were the complaint. They
    // were roles, so their absence is checkable rather than a matter of taste.
    assert.equal(container.querySelectorAll('[role="tablist"]').length, 0);
    assert.equal(container.querySelectorAll('[role="tab"]').length, 0);
  });

  test('the page keeps no score', async (t) => {
    const { container } = await mountKnows(t, {
      items: [NOTICED, TAUGHT], canTeach: true, canSeeNoticed: true,
    });
    const text = container.textContent ?? '';
    assert.ok(!/\bfacts?\b/i.test(text), `a fact counter came back: ${text}`);
    assert.ok(!/\d+ (known|confirmed|waiting)/i.test(text));
  });

  test('both groups are shown, each with its own heading', async (t) => {
    const { container } = await mountKnows(t, {
      items: [NOTICED, TAUGHT], canTeach: true, canSeeNoticed: true,
    });
    const text = container.textContent ?? '';
    assert.ok(text.includes("What it's noticed"));
    assert.ok(text.includes("What you've taught it"));
    assert.ok(text.includes('Room 214 loses hot water in winter.'));
    assert.ok(text.includes('We buy towels from Riz Supply.'));
  });

  test('a group with nothing in it is not a heading over nothing', async (t) => {
    const { container } = await mountKnows(t, {
      items: [TAUGHT], canTeach: true, canSeeNoticed: true,
    });
    const text = container.textContent ?? '';
    assert.ok(text.includes("What you've taught it"));
    assert.ok(!text.includes("What it's noticed"));
  });

  test('a guess can be called wrong; something you said can be taken back', async (t) => {
    const { container } = await mountKnows(t, {
      items: [NOTICED], canTeach: true, canSeeNoticed: true,
    });
    const labels = buttonLabels(container);
    assert.ok(labels.includes('Adjust'));
    assert.ok(labels.includes("That's wrong"));
    assert.ok(!labels.includes('Remove'), 'a guess is not something you take back');
  });

  test('a taught row offers Remove, never "that\'s wrong"', async (t) => {
    const { container } = await mountKnows(t, {
      items: [TAUGHT], canTeach: true, canSeeNoticed: true,
    });
    const labels = buttonLabels(container);
    assert.ok(labels.includes('Adjust'));
    assert.ok(labels.includes('Remove'));
    assert.ok(!labels.includes("That's wrong"));
  });

  test('an empty hotel is invited, not congratulated', async (t) => {
    const { container } = await mountKnows(t, { items: [], canTeach: true, canSeeNoticed: true });
    const text = container.textContent ?? '';
    assert.ok(text.includes('Nothing yet.'));
    assert.ok(text.includes('It learns as your hotel runs.'));
    // The honesty rule this page has always lived by: never a green all-clear.
    assert.ok(!/all set|up to date|all clear/i.test(text));
  });

  test('a reader without write standing sees the list and no controls', async (t) => {
    // The front desk reaches the emergency numbers through this page. They read
    // it; they do not edit the hotel's knowledge from it.
    const { container } = await mountKnows(t, {
      items: [TAUGHT], canTeach: false, canSeeNoticed: false,
    });
    const labels = buttonLabels(container);
    assert.ok((container.textContent ?? '').includes('We buy towels from Riz Supply.'));
    assert.ok(!labels.some((l) => l.includes('Teach it something')));
    assert.ok(!labels.includes('Adjust'));
    assert.ok(!labels.includes('Remove'));
  });
});

describe('the box everything is typed into', () => {
  test('the button opens one box with ghost examples inside it', async (t) => {
    const { container } = await mountKnows(t, { items: [], canTeach: true, canSeeNoticed: true });

    const teach = Array.from(container.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').includes('Teach it something'));
    assert.ok(teach, 'no teach button to press');
    await act(async () => { teach!.click(); });
    await flushReact();

    const box = document.querySelector<HTMLTextAreaElement>('.kn-pop textarea');
    assert.ok(box, 'pressing the button did not open a box');
    assert.equal(box!.value, '', 'the box starts empty');
    // Written for somebody who has never used anything like this: real
    // examples, not an instruction to type.
    assert.ok(box!.placeholder.includes('Try: We buy towels from Riz Supply'));
    assert.ok(box!.placeholder.includes('Try: Never book deliveries on Fridays'));

    // The paperclip is INSIDE the same box, not a separate feature beside it.
    const clip = document.querySelector('.kn-pop .kn-clip');
    assert.ok(clip, 'no paperclip in the box');
    assert.equal(document.querySelectorAll('.kn-pop input[type="file"]').length, 1);
  });

  test('an empty box cannot be saved', async (t) => {
    const { container } = await mountKnows(t, { items: [], canTeach: true, canSeeNoticed: true });
    const teach = Array.from(container.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').includes('Teach it something'));
    await act(async () => { teach!.click(); });
    await flushReact();

    const save = Array.from(document.querySelectorAll<HTMLButtonElement>('.kn-pop button'))
      .find((b) => (b.textContent ?? '').trim() === 'Save');
    assert.ok(save);
    assert.equal(save!.disabled, true);
  });

  test('Adjust opens the same box, already holding the sentence', async (t) => {
    const { container } = await mountKnows(t, {
      items: [TAUGHT], canTeach: true, canSeeNoticed: true,
    });
    const adjust = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => (b.textContent ?? '').trim() === 'Adjust');
    await act(async () => { adjust!.click(); });
    await flushReact();

    const box = document.querySelector<HTMLTextAreaElement>('.kn-pop textarea');
    assert.ok(box);
    assert.equal(box!.value, 'We buy towels from Riz Supply.');
  });

  test('"that\'s wrong" may be confirmed with nothing typed', async (t) => {
    // Typing what is right is optional on purpose. Demanding a replacement
    // sentence turns a correction into homework, and the row goes on being
    // believed until somebody does it.
    const { container, sent } = await mountKnows(t, {
      items: [NOTICED], canTeach: true, canSeeNoticed: true,
    });
    const wrong = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => (b.textContent ?? '').trim() === "That's wrong");
    await act(async () => { wrong!.click(); });
    await flushReact();

    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('.kn-pop button'))
      .find((b) => (b.textContent ?? '').trim() === 'Confirm');
    assert.ok(confirm, 'no confirm button');
    assert.equal(confirm!.disabled, false, 'an empty correction must still be confirmable');

    await act(async () => { confirm!.click(); });
    await flushReact();

    const write = sent.find((s) => s.url.includes('/api/memory/knows'));
    assert.ok(write, 'confirming wrote nothing');
    assert.deepEqual(write!.body, {
      propertyId: PID, action: 'wrong', kind: 'fact', id: 'n1',
    });
  });

  test('Remove writes straight through, with no box in the way', async (t) => {
    const { container, sent } = await mountKnows(t, {
      items: [TAUGHT], canTeach: true, canSeeNoticed: true,
    });
    const remove = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => (b.textContent ?? '').trim() === 'Remove');
    await act(async () => { remove!.click(); });
    await flushReact();

    assert.deepEqual(sent[0]?.body, {
      propertyId: PID, action: 'remove', kind: 'fact', id: 't1',
    });
  });
});

describe('a contact sentence still dials', () => {
  test('the number inside the sentence is a tel link', async (t) => {
    const { container } = await mountKnows(t, {
      items: [item({
        id: 'c1',
        kind: 'contact',
        group: 'taught',
        sentence: 'Fire dept is an emergency contact. (409) 555-1234.',
        tel: 'tel:4095551234',
        telText: '(409) 555-1234',
      })],
      canTeach: true,
      canSeeNoticed: true,
    });
    const link = container.querySelector<HTMLAnchorElement>('a[href^="tel:"]');
    assert.ok(link, 'the emergency number stopped being tappable');
    // The link wraps the number AS PRINTED, not the stripped dialable form:
    // before telText existed the row appended the bare digits a second time.
    assert.equal(link!.getAttribute('href'), 'tel:4095551234');
    assert.equal(link!.textContent, '(409) 555-1234');
    assert.equal(
      (container.textContent ?? '').match(/4095551234/g),
      null,
      'the stripped digits were printed as well as the formatted number',
    );
    // The rest of the sentence survives around the link.
    assert.ok((container.textContent ?? '').includes('Fire dept is an emergency contact.'));
  });
});
