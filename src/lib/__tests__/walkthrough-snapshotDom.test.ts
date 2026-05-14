/**
 * Tests for src/components/walkthrough/snapshotDom.ts.
 *
 * Run via: npx tsx --test src/lib/__tests__/walkthrough-snapshotDom.test.ts
 *
 * These tests stand the snapshot logic up against real jsdom to validate
 * the four invariants the route relies on:
 *   - hidden / pointer-events:none / disabled elements are filtered out
 *   - tabindex="-1" is filtered; tabindex="0" is kept
 *   - duplicate accessible names get parent-section qualifiers
 *   - in-viewport elements sort BEFORE off-viewport ones
 *
 * If snapshotDom is refactored, these must still pass. They're the
 * regression guard for the Phase C refactor that landed in commit
 * 42e4cbe and the Phase D fingerprint depended on.
 *
 * Scale-readiness Phase 3A (2026-05-14).
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Build a jsdom Document + install the globals snapshotDom expects.
// jsdom.window has Document, Element, HTMLElement, getComputedStyle —
// snapshotDom calls all of these. The function also reads
// `window.location.pathname`, `window.CSS?.escape`, and
// `doc.documentElement.client{Width,Height}`. jsdom provides all of
// them except clientWidth/clientHeight which are 0 by default — we
// override on a per-test basis.

let dom: JSDOM;
let snapshotInteractiveElements: typeof import('../../components/walkthrough/snapshotDom').snapshotInteractiveElements;

before(async () => {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/dashboard',
    pretendToBeVisual: true,
  });
  // Establish globals BEFORE importing snapshotDom (top-level checks
  // reference `window` and `document`).
  const win = dom.window as unknown as Window & typeof globalThis;
  (globalThis as unknown as { window: Window }).window = win;
  (globalThis as unknown as { document: Document }).document = win.document;
  (globalThis as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement = win.HTMLElement;
  (globalThis as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement = win.HTMLInputElement;
  (globalThis as unknown as { HTMLSelectElement: typeof HTMLSelectElement }).HTMLSelectElement = win.HTMLSelectElement;
  (globalThis as unknown as { HTMLTextAreaElement: typeof HTMLTextAreaElement }).HTMLTextAreaElement = win.HTMLTextAreaElement;
  (globalThis as unknown as { HTMLImageElement: typeof HTMLImageElement }).HTMLImageElement = win.HTMLImageElement;
  (globalThis as unknown as { Node: typeof Node }).Node = win.Node;

  // Force a non-zero viewport so the inViewport flag is meaningful.
  Object.defineProperty(win.document.documentElement, 'clientWidth', {
    configurable: true,
    value: 1280,
  });
  Object.defineProperty(win.document.documentElement, 'clientHeight', {
    configurable: true,
    value: 800,
  });

  ({ snapshotInteractiveElements } = await import('../../components/walkthrough/snapshotDom'));
});

// Helper: replace body innerHTML and patch getBoundingClientRect for every
// element so we can place them at deterministic coordinates per test.
function setup(html: string, rects: Record<string, DOMRect>): Document {
  const doc = dom.window.document;
  doc.body.innerHTML = html;
  for (const [selector, rect] of Object.entries(rects)) {
    const el = doc.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`setup: selector ${selector} not found in fixture`);
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect,
    });
  }
  return doc;
}

function makeRect(x: number, y: number, w: number, h: number): DOMRect {
  return {
    x, y, width: w, height: h,
    top: y, left: x, right: x + w, bottom: y + h,
    toJSON() { return this; },
  } as DOMRect;
}

describe('snapshotInteractiveElements — visibility filtering', () => {
  test('keeps a visible button with non-trivial area', () => {
    const doc = setup(
      '<button id="b1">Save</button>',
      { '#b1': makeRect(10, 10, 80, 36) },
    );
    const snap = snapshotInteractiveElements(doc);
    assert.equal(snap.elements.length, 1);
    assert.equal(snap.elements[0].name, 'Save');
    assert.equal(snap.elements[0].role, 'button');
    assert.equal(snap.elements[0].inViewport, true);
  });

  test('filters display:none', () => {
    const doc = setup(
      '<button id="b1" style="display:none">Hidden</button><button id="b2">Visible</button>',
      {
        '#b1': makeRect(10, 10, 80, 36),
        '#b2': makeRect(100, 10, 80, 36),
      },
    );
    const snap = snapshotInteractiveElements(doc);
    assert.equal(snap.elements.length, 1);
    assert.equal(snap.elements[0].name, 'Visible');
  });

  test('filters opacity:0', () => {
    const doc = setup(
      '<button id="b1" style="opacity:0">Faded</button><button id="b2">Solid</button>',
      {
        '#b1': makeRect(10, 10, 80, 36),
        '#b2': makeRect(100, 10, 80, 36),
      },
    );
    const snap = snapshotInteractiveElements(doc);
    assert.equal(snap.elements.length, 1);
    assert.equal(snap.elements[0].name, 'Solid');
  });

  test('filters elements smaller than the MIN_AREA threshold', () => {
    const doc = setup(
      '<button id="b1">Tiny</button><button id="b2">Normal</button>',
      {
        '#b1': makeRect(0, 0, 4, 4),     // below MIN_AREA_PX=12
        '#b2': makeRect(100, 100, 80, 36),
      },
    );
    const snap = snapshotInteractiveElements(doc);
    assert.equal(snap.elements.length, 1);
    assert.equal(snap.elements[0].name, 'Normal');
  });

  test('filters disabled button (selector-level)', () => {
    const doc = setup(
      '<button id="b1" disabled>Disabled</button><button id="b2">Active</button>',
      {
        '#b1': makeRect(10, 10, 80, 36),
        '#b2': makeRect(100, 10, 80, 36),
      },
    );
    const snap = snapshotInteractiveElements(doc);
    assert.equal(snap.elements.length, 1);
    assert.equal(snap.elements[0].name, 'Active');
  });

  test('skips elements with empty accessible name AND no data-staxis-id', () => {
    const doc = setup(
      '<button id="b1"></button><button id="b2">Named</button>',
      {
        '#b1': makeRect(10, 10, 80, 36),
        '#b2': makeRect(100, 10, 80, 36),
      },
    );
    const snap = snapshotInteractiveElements(doc);
    assert.equal(snap.elements.length, 1);
    assert.equal(snap.elements[0].name, 'Named');
  });

  test('keeps an empty-name button if data-staxis-id is set', () => {
    const doc = setup(
      '<button id="b1" data-staxis-id="settings-gear" aria-label=""></button>',
      { '#b1': makeRect(10, 10, 40, 40) },
    );
    const snap = snapshotInteractiveElements(doc);
    assert.equal(snap.elements.length, 1);
    assert.equal(snap.elements[0].staxisId, 'settings-gear');
  });
});

describe('snapshotInteractiveElements — selector breadth (Phase C widening)', () => {
  test('includes <summary> (disclosure widget)', () => {
    const doc = setup(
      '<details><summary id="b1">More info</summary><p>Body</p></details>',
      { '#b1': makeRect(10, 10, 80, 24) },
    );
    const snap = snapshotInteractiveElements(doc);
    assert.ok(snap.elements.some(e => e.tag === 'summary' && e.name === 'More info'));
  });

  test('includes [tabindex="0"]; filters [tabindex="-1"]', () => {
    const doc = setup(
      '<div id="b1" tabindex="0">Focusable</div><div id="b2" tabindex="-1">Programmatic</div>',
      {
        '#b1': makeRect(10, 10, 80, 30),
        '#b2': makeRect(100, 10, 80, 30),
      },
    );
    const snap = snapshotInteractiveElements(doc);
    assert.equal(snap.elements.length, 1);
    assert.equal(snap.elements[0].name, 'Focusable');
  });
});

describe('snapshotInteractiveElements — viewport-first prioritization (Phase C)', () => {
  test('in-viewport elements sort before off-viewport ones', () => {
    const doc = setup(
      `
      <button id="b-far">Far button</button>
      <button id="b-near">Near button</button>
      `,
      {
        '#b-far': makeRect(10, 2000, 80, 36),   // way below viewport
        '#b-near': makeRect(10, 100, 80, 36),   // in viewport
      },
    );
    const snap = snapshotInteractiveElements(doc);
    // Two interactive elements; in-viewport one is first.
    assert.equal(snap.elements.length, 2);
    assert.equal(snap.elements[0].name, 'Near button');
    assert.equal(snap.elements[0].inViewport, true);
    assert.equal(snap.elements[1].name, 'Far button');
    assert.equal(snap.elements[1].inViewport, false);
  });
});

describe('snapshotInteractiveElements — duplicate-name disambiguation (Phase C)', () => {
  test('two "Save" buttons in different sections get parent-section qualifiers', () => {
    const doc = setup(
      `
      <section aria-label="Add Staff Member">
        <button id="b1">Save</button>
      </section>
      <aside aria-label="Sidebar">
        <button id="b2">Save</button>
      </aside>
      `,
      {
        '#b1': makeRect(10, 10, 80, 36),
        '#b2': makeRect(200, 10, 80, 36),
      },
    );
    const snap = snapshotInteractiveElements(doc);
    assert.equal(snap.elements.length, 2);
    const names = snap.elements.map(e => e.name).sort();
    assert.deepEqual(names, [
      'Save (inside Add Staff Member)',
      'Save (inside Sidebar)',
    ]);
    // rawName is preserved unqualified for the fingerprint (Phase D).
    assert.deepEqual(snap.elements.map(e => e.rawName).sort(), ['Save', 'Save']);
    // Each element knows its parent section.
    assert.equal(snap.elements.find(e => e.name.includes('Add Staff'))?.parentSection, 'Add Staff Member');
  });

  test('single occurrence is not qualified', () => {
    const doc = setup(
      `<section aria-label="Settings"><button id="b1">Save</button></section>`,
      { '#b1': makeRect(10, 10, 80, 36) },
    );
    const snap = snapshotInteractiveElements(doc);
    assert.equal(snap.elements.length, 1);
    // Single occurrence keeps the bare rawName.
    assert.equal(snap.elements[0].name, 'Save');
    assert.equal(snap.elements[0].rawName, 'Save');
    // parentSection is still computed for fingerprinting.
    assert.equal(snap.elements[0].parentSection, 'Settings');
  });
});

describe('snapshotInteractiveElements — byId map', () => {
  test('byId returns the live node, suitable for animating to', () => {
    const doc = setup(
      '<button id="real-button">Click me</button>',
      { '#real-button': makeRect(10, 10, 80, 36) },
    );
    const snap = snapshotInteractiveElements(doc);
    assert.equal(snap.elements.length, 1);
    const node = snap.byId.get(snap.elements[0].id);
    assert.ok(node);
    assert.equal(node!.id, 'real-button');
    assert.equal(node!.textContent, 'Click me');
  });
});
