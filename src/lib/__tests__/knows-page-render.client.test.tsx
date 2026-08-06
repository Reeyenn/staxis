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
 *   6. THE WAY A DOCUMENT GETS IN. Three affordances (a labelled button, the
 *      ghost line naming files, and dropping one on the box) that must all
 *      land on the ONE upload seam. See the block comment above them.
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

interface Sent { url: string; method: string; body: unknown }

/** What the presign step answers with, so the PUT has a real URL to go to. */
const PRESIGN = {
  path: 'hotel/handbook.pdf',
  signedUrl: 'https://storage.test/signed-put',
  contentType: 'application/pdf',
};

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
    value: async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        sent.push({
          url,
          method,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        });
        // The document cabinet's first step has to answer with somewhere to
        // PUT the bytes, or the upload sequence stops before it reaches the
        // register call this file asserts on.
        const data = url.includes('/presign') ? PRESIGN : {};
        return new Response(JSON.stringify({ ok: true, requestId: 'r', data }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      // The bytes themselves. Recorded so a test can prove the file that
      // reached storage is the one that was dropped.
      if (method === 'PUT') {
        sent.push({ url, method, body: init?.body ?? null });
        return new Response(null, { status: 200 });
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

function buttonSaying(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>('button'))
    .find((b) => (b.textContent ?? '').trim() === label);
}

/** Press "Teach it something" and wait for the box. */
async function openTeachBox(container: HTMLElement): Promise<HTMLElement> {
  const teach = Array.from(container.querySelectorAll('button'))
    .find((b) => (b.textContent ?? '').includes('Teach it something'));
  assert.ok(teach, 'no teach button to press');
  await act(async () => { teach!.click(); });
  await flushReact();
  const box = document.querySelector<HTMLElement>('.kn-pop');
  assert.ok(box, 'pressing the button did not open a box');
  return box!;
}

/**
 * A drag event with a dataTransfer on it.
 *
 * jsdom implements neither DragEvent nor DataTransfer, so the payload is
 * hand-built. React reads `dataTransfer` straight off the native event when it
 * builds the synthetic one, which is the only part of the real thing the box
 * touches.
 */
function dragEvent(type: string, carrying: { types: string[]; files?: File[] }): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: carrying.types, files: carrying.files ?? [], dropEffect: 'none' },
  });
  return event;
}

const FILE_DRAG = { types: ['Files'] };

async function fire(target: EventTarget, event: Event): Promise<void> {
  await act(async () => { target.dispatchEvent(event); });
  await flushReact();
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
    await openTeachBox(container);

    const box = document.querySelector<HTMLTextAreaElement>('.kn-pop textarea');
    assert.ok(box, 'pressing the button did not open a box');
    assert.equal(box!.value, '', 'the box starts empty');
    // Written for somebody who has never used anything like this: real
    // examples, not an instruction to type.
    assert.ok(box!.placeholder.includes('Try: We buy towels from Riz Supply'));
    assert.ok(box!.placeholder.includes('Try: Never book deliveries on Fridays'));

    // The picker is INSIDE the same box, not a separate feature beside it.
    assert.equal(document.querySelectorAll('.kn-pop input[type="file"]').length, 1);
  });

  test('the ghost text names the file route as well as the sentence one', async (t) => {
    // Three "Try:" sentences teach one lesson only: this box takes sentences.
    // Nothing in the box used to say a handbook could go in the same place.
    const { container } = await mountKnows(t, { items: [], canTeach: true, canSeeNoticed: true });
    await openTeachBox(container);

    const box = document.querySelector<HTMLTextAreaElement>('.kn-pop textarea');
    assert.ok(box);
    assert.ok(
      box!.placeholder.includes('Or add a file, like your employee handbook or vendor price list.'),
      box!.placeholder,
    );
  });

  test('an empty box cannot be saved', async (t) => {
    const { container } = await mountKnows(t, { items: [], canTeach: true, canSeeNoticed: true });
    await openTeachBox(container);

    const save = buttonSaying(document.querySelector('.kn-pop')!, 'Save');
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

// ═══════════════════════════════════════════════════════════════════════════
// Putting a DOCUMENT in the box.
//
// The box has always taken files. Until 2026-08-06 the only way in was a bare
// paperclip in the top-right corner of the text area, and the founder's verdict
// on reviewing it live was that nobody would ever guess it was for documents.
// An icon with no word beside it only reads to somebody who already knows what
// it does, which is nobody at a hotel front desk on their first week.
//
// So the way in is now three things that all land on the SAME upload seam:
// a labelled button, a line of ghost text naming files, and dropping one on
// the box. These check that they are all present AND that they all still go
// through presign → PUT → register rather than growing a second path.
// ═══════════════════════════════════════════════════════════════════════════

const DROPPED = () => new File(['handbook bytes'], 'handbook.pdf', { type: 'application/pdf' });

describe('putting a document in the box', () => {
  test('the way in says what it is, in words, and not in a corner', async (t) => {
    const { container } = await mountKnows(t, { items: [], canTeach: true, canSeeNoticed: true });
    const box = await openTeachBox(container);

    const add = buttonSaying(box, 'Add a document');
    assert.ok(add, 'no labelled way to add a document');
    // On the footer rail with Cancel and Save, not floating in the text area.
    assert.ok(add!.closest('.kn-popacts'), 'the button is not on the action rail');
    // The unlabelled corner clip is what this replaced. Its absence is the
    // point, so it is asserted rather than assumed.
    assert.equal(box.querySelectorAll('.kn-clip').length, 0, 'the bare corner clip came back');
  });

  test('the labelled button opens the same picker the corner clip did', async (t) => {
    const { container } = await mountKnows(t, { items: [], canTeach: true, canSeeNoticed: true });
    const box = await openTeachBox(container);

    const picker = box.querySelector<HTMLInputElement>('input[type="file"]');
    assert.ok(picker, 'the file picker went missing');
    let opened = 0;
    picker!.addEventListener('click', () => { opened += 1; });

    await act(async () => { buttonSaying(box, 'Add a document')!.click(); });
    await flushReact();

    assert.equal(opened, 1, 'the button did not open the picker');
    // Still the accept list the document cabinet has always used.
    assert.ok((picker!.getAttribute('accept') ?? '').includes('.pdf'));
  });

  test('a file dragged over the box lights the whole box up', async (t) => {
    const { container } = await mountKnows(t, { items: [], canTeach: true, canSeeNoticed: true });
    const box = await openTeachBox(container);
    assert.equal(document.querySelectorAll('.kn-drop').length, 0, 'lit up before any drag');

    await fire(box, dragEvent('dragenter', FILE_DRAG));
    assert.equal(document.querySelectorAll('.kn-drop').length, 1, 'no drop state on a file drag');
    assert.ok((document.querySelector('.kn-drop')?.textContent ?? '').includes('Drop your file here'));
    assert.ok(document.querySelector('.kn-pop')!.classList.contains('kn-over'));
  });

  test('crossing onto something inside the box does not flicker the highlight', async (t) => {
    // dragenter and dragleave fire for EVERY element under the pointer, so a
    // plain boolean drops the highlight the instant the cursor moves from the
    // sheet onto the textarea inside it. This is the counter, checked.
    const { container } = await mountKnows(t, { items: [], canTeach: true, canSeeNoticed: true });
    const box = await openTeachBox(container);
    const inner = box.querySelector('textarea');
    assert.ok(inner);

    await fire(box, dragEvent('dragenter', FILE_DRAG));
    await fire(inner!, dragEvent('dragenter', FILE_DRAG));
    await fire(inner!, dragEvent('dragleave', FILE_DRAG));
    assert.equal(
      document.querySelectorAll('.kn-drop').length, 1,
      'the highlight went out while the pointer was still over the box',
    );

    await fire(box, dragEvent('dragleave', FILE_DRAG));
    assert.equal(document.querySelectorAll('.kn-drop').length, 0, 'the highlight stayed on after leaving');
  });

  test('a drag carrying no file leaves the box alone', async (t) => {
    // Dragging selected text across the sheet is a legitimate thing to do:
    // the textarea takes text drops. Promising a file drop would be a lie.
    const { container } = await mountKnows(t, { items: [], canTeach: true, canSeeNoticed: true });
    const box = await openTeachBox(container);

    await fire(box, dragEvent('dragenter', { types: ['text/plain'] }));
    assert.equal(document.querySelectorAll('.kn-drop').length, 0, 'a text drag lit the box up');

    await fire(box, dragEvent('drop', { types: ['text/plain'] }));
    assert.equal(document.querySelectorAll('.kn-file').length, 0, 'a text drag attached something');
  });

  test('a dropped file goes up exactly the way a picked one does', async (t) => {
    const { container, sent } = await mountKnows(t, {
      items: [], canTeach: true, canSeeNoticed: true,
    });
    const box = await openTeachBox(container);

    await fire(box, dragEvent('dragenter', FILE_DRAG));
    await fire(box, dragEvent('drop', { types: ['Files'], files: [DROPPED()] }));

    // The highlight clears and the file is named back, so nobody presses Save
    // wondering whether it took.
    assert.equal(document.querySelectorAll('.kn-drop').length, 0, 'the drop state stuck');
    assert.ok((box.textContent ?? '').includes('handbook.pdf'), 'the dropped file was not named back');

    const save = buttonSaying(document.querySelector('.kn-pop')!, 'Save');
    assert.ok(save, 'no save button');
    assert.equal(save!.disabled, false, 'a file on its own must be savable');
    await act(async () => { save!.click(); });
    await flushReact();

    // presign → PUT → register, the document cabinet's own three steps.
    const presign = sent.find((s) => s.url.includes('/api/knowledge/documents/presign'));
    assert.ok(presign, 'the dropped file never reached the upload seam');
    assert.deepEqual(presign!.body, { pid: PID, filename: 'handbook.pdf' });

    const put = sent.find((s) => s.method === 'PUT');
    assert.ok(put, 'the bytes were never sent');
    assert.equal(put!.url, PRESIGN.signedUrl);
    assert.equal((put!.body as File).name, 'handbook.pdf', 'a different file reached storage');

    const register = sent.find(
      (s) => s.method === 'POST' && s.url.endsWith('/api/knowledge/documents'),
    );
    assert.ok(register, 'the file was never filed');
    const body = register!.body as Record<string, unknown>;
    assert.equal(body.pid, PID);
    assert.equal(body.title, 'handbook');
    assert.equal(body.path, PRESIGN.path);
    assert.equal(body.mimeType, PRESIGN.contentType);
    assert.equal(body.visibility, 'all_staff');
  });

  test('only the first of several dropped files is taken', async (t) => {
    const { container } = await mountKnows(t, { items: [], canTeach: true, canSeeNoticed: true });
    const box = await openTeachBox(container);

    await fire(box, dragEvent('dragenter', FILE_DRAG));
    await fire(box, dragEvent('drop', {
      types: ['Files'],
      files: [DROPPED(), new File(['other'], 'prices.csv', { type: 'text/csv' })],
    }));

    assert.equal(document.querySelectorAll('.kn-file').length, 1, 'more than one attachment');
    assert.ok((box.textContent ?? '').includes('handbook.pdf'));
    assert.ok(!(box.textContent ?? '').includes('prices.csv'), 'the second file was taken too');
  });

  test('a correction box takes no file at all', async (t) => {
    // Adjust and "That's wrong" are corrections to ONE existing sentence. A
    // handbook is not a correction to a sentence, so neither the button nor
    // the drop target is there to imply otherwise.
    const { container } = await mountKnows(t, {
      items: [TAUGHT], canTeach: true, canSeeNoticed: true,
    });
    await act(async () => { buttonSaying(container, 'Adjust')!.click(); });
    await flushReact();

    const box = document.querySelector<HTMLElement>('.kn-pop');
    assert.ok(box);
    assert.equal(buttonSaying(box!, 'Add a document'), undefined);
    await fire(box!, dragEvent('dragenter', FILE_DRAG));
    assert.equal(document.querySelectorAll('.kn-drop').length, 0);
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
