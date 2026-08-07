/**
 * THE OFFER CARD AND THE MARK ARE ONE BEING TALKING.
 *
 * The card the companion speaks through sits beside the mark in the corner,
 * and with nothing between them it read as a second object that had arrived
 * from somewhere else rather than as the mark saying something. The tail is
 * the same two marks the pointer already draws on the page, at the size of the
 * gap the dock leaves: one sage hairline out of the card's mark-facing edge,
 * one solid head landing on the mark.
 *
 * ─── WHAT IS WORTH CHECKING, AND WHAT IS NOT ───────────────────────────────
 * jsdom lays nothing out, so "does the arrowhead touch the circle" is not a
 * question this file can answer; that was measured in Chrome during the build
 * (tail starts 0px off the card's edge and lands 0px off the mark, with zero
 * aim error at every card height). What a test can hold onto is the thing that
 * silently breaks: the tail existing at all, and it being pinned to the side
 * the mark is actually on. Pin it to the wrong side and the card grows a spur
 * pointing into empty page, which looks like a rendering fault and would ship.
 */

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { PeekTail, PEEK_TAIL_CSS } from '@/components/agent/PeekTail';
import { DOCK_GAP, MARK_SIZE, placePeek } from '@/lib/companion/dock';

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'Element', 'HTMLElement', 'Node',
  'Event', 'EventTarget', 'getComputedStyle',
] as const;

function installBrowser(): () => void {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    pretendToBeVisual: true, url: 'http://localhost/feed',
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of [...DOM_GLOBALS, 'IS_REACT_ACT_ENVIRONMENT'] as const) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  for (const key of DOM_GLOBALS) {
    const candidate = dom.window[key as keyof typeof dom.window];
    const value = key === 'getComputedStyle' && typeof candidate === 'function'
      ? candidate.bind(dom.window)
      : candidate;
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true, writable: true, value: true,
  });
  return () => {
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

/** The card as the bar renders it, with the real sheet applied after it. */
function mountCard(_context: TestContext, side: 'left' | 'right'): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root: Root = createRoot(host);
  act(() => {
    root.render(
      <div className={`asx-peek asx-peek-${side} asx-peek-live`}>
        <PeekTail side={side} />
        <span className="asx-peek-head">
          <span className="asx-peek-dot asx-sev-urgent" />
          <span className="asx-peek-text">The fire panel check is 3 days overdue.</span>
        </span>
        <span className="asx-peek-acts">
          <button type="button" className="asx-peek-btn asx-peek-btn-yes">Make the work order</button>
          <button type="button" className="asx-peek-btn">Not now</button>
        </span>
      </div>,
    );
  });
  const sheet = document.createElement('style');
  sheet.textContent = PEEK_TAIL_CSS;
  document.body.append(sheet);
  return host;
}

function tailIn(host: HTMLElement): HTMLElement {
  const el = host.querySelector<HTMLElement>('.asx-peek-tail');
  assert.ok(el, 'the card has no tail: it floats disconnected from the mark');
  return el;
}

describe('the offer card is joined to the mark it speaks from', () => {
  test('the card carries a tail, and it is inside the card so it travels with it', (t) => {
    t.after(installBrowser());
    const host = mountCard(t, 'left');
    const tail = tailIn(host);
    assert.equal(tail.closest('.asx-peek')?.className.includes('asx-peek'), true);
    // Decoration, not a control: it says nothing a reader has not already read
    // in the sentence beside it.
    assert.equal(tail.getAttribute('aria-hidden'), 'true');
  });

  test('it is pinned to the side the mark is actually on', (t) => {
    // The one thing that silently breaks. Pinned to the wrong edge the card
    // grows a spur pointing into empty page.
    t.after(installBrowser());

    const onLeft = tailIn(mountCard(t, 'left'));
    // The card is LEFT of the mark, so the mark is off its right edge.
    assert.equal(getComputedStyle(onLeft).right, `-${DOCK_GAP}px`);

    const onRight = tailIn(mountCard(t, 'right'));
    assert.equal(getComputedStyle(onRight).left, `-${DOCK_GAP}px`);
  });

  test('it spans exactly the gap the dock leaves, and takes no taps', (t) => {
    t.after(installBrowser());
    const tail = tailIn(mountCard(t, 'left'));
    const style = getComputedStyle(tail);
    assert.equal(style.width, `${DOCK_GAP}px`, 'the tail is not the length of the gap it crosses');
    assert.equal(style.position, 'absolute');
    // Outside the card and transparent to the pointer, so it can never sit on
    // a button or swallow a tap meant for one.
    assert.equal(style.pointerEvents, 'none');
  });

  test('anchoring it at the card centre aims it at the mark at every card height', () => {
    // Why the tail needs no measuring: placePeek centres the card on the
    // mark's own centre, and its vertical clamp can never bite, because a
    // docked mark's centre is always further from the window edge than the
    // clamp's bound. Checked here rather than asserted in prose, because the
    // day that stops being true the tail starts pointing past the mark and
    // nothing else in the app would notice.
    const viewport = { width: 1280, height: 900 };
    for (let y = 12; y <= viewport.height - MARK_SIZE - 12; y += 24) {
      for (const x of [12, 400, viewport.width - MARK_SIZE - 12]) {
        const at = placePeek({ x, y }, viewport);
        assert.equal(
          at.centerY, Math.round(y + MARK_SIZE / 2),
          `the card stopped sharing the mark's centre line at ${x},${y}`,
        );
      }
    }
  });
});
