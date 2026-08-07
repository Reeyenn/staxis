'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The tail — what makes the offer card and the mark ONE being talking.
//
// The card is the companion SPEAKING, and a dark slab hanging in the corner
// beside the mark read as a second object that had arrived from somewhere
// else. This is the same two marks the pointer already draws on the page (one
// sage hairline, one solid head landing on the thing) at the size of the gap
// the dock leaves between the card and the mark. Same sage, same 1.6px
// hairline, same arrowhead: it is the same companion doing the same thing at a
// smaller size, and a second visual language for it would read as a second
// product.
//
// ─── WHY AN ANCHORED TAIL IS ENOUGH, AND NO GEOMETRY ENGINE ────────────────
// placePeek centres the card on the mark's own centre line, and its vertical
// clamp can never bite: a legally docked mark's centre is always further from
// the window edge than the clamp's bound is. So "the card's vertical middle"
// and "the mark's vertical middle" are the same y at every size the card can
// be, from a one-line peek to a four-line offer with two buttons under it. The
// tail sits at 50% of the card and aims true without measuring anything.
//
// It is drawn OUTSIDE the card and takes no pointer events, so it can never
// sit on a button or swallow a tap meant for one.
//
// ─── WHY IT IS ITS OWN FILE ────────────────────────────────────────────────
// So it can be mounted. AskStaxisBar's module graph reaches a CSS module,
// which the node test runner cannot load, and the one thing about this worth
// holding onto (that it exists, and is pinned to the side the mark is on) is
// exactly the thing that would break silently.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';

import { DOCK_GAP } from '@/lib/companion/dock';

export function PeekTail({ side }: { side: 'left' | 'right' }) {
  return <span className={`asx-peek-tail asx-peek-tail-${side}`} aria-hidden />;
}

/** Folded into ASX_CSS by AskStaxisBar, so there is still one sheet. */
export const PEEK_TAIL_CSS = `
.asx-peek-tail{position:absolute;top:50%;width:${DOCK_GAP}px;height:9px;
  transform:translateY(-50%);pointer-events:none;}
.asx-peek-tail-left{right:-${DOCK_GAP}px;}
.asx-peek-tail-right{left:-${DOCK_GAP}px;}
.asx-peek-tail::before{content:"";position:absolute;top:50%;left:0;right:0;height:1.6px;
  transform:translateY(-50%);border-radius:1px;background:var(--asx-sage);}
.asx-peek-tail::after{content:"";position:absolute;top:50%;width:0;height:0;
  transform:translateY(-50%);border-top:4.5px solid transparent;border-bottom:4.5px solid transparent;}
.asx-peek-tail-left::after{right:0;border-left:7px solid var(--asx-sage);}
.asx-peek-tail-right::after{left:0;border-right:7px solid var(--asx-sage);}
`;
