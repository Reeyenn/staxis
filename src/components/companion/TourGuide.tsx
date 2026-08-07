'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The tour, on the screen.
//
// WHAT THIS OWNS: pixels, the router, and the clock. Nothing else. Which stop
// is showing, whether a `try` stop is still waiting, and what a Next or an
// Escape does are all decided by the pure reducers in src/lib/companion/tour.ts
// and are tested there without mounting anything, exactly like the manners
// engine. If you find yourself writing an `if` in this file that changes what
// the tour DOES, it belongs upstairs.
//
// ─── THE THREE THINGS IT DRAWS ─────────────────────────────────────────────
//
//   the cursor   flies to the control the stop is about, from wherever it was.
//                Purely a picture: `pointer-events: none`, dispatches nothing,
//                and there is no `.click()` in this tree.
//   the card     PointerPopup, unchanged, with the stop's sentence and the
//                tour's buttons. Reused rather than copied, so the tour gets
//                the geometry, the refusal to draw at a control that is not
//                there, the scroll-away behaviour and the companion-surface
//                avoidance for free, and cannot drift from them.
//   the slab     the fallback for a stop about a whole SCREEN rather than a
//                control. Two stops use it. It has no arrow because there is
//                nothing to point at, and inventing an anchor so that every
//                stop could have one would be the tour lying about what it is
//                describing.
//
// ─── WAITING IS NOT A TIMER ────────────────────────────────────────────────
//
// A `try` stop has no Next. It ends when the app reports the real write, and
// the report is fired by the screen that owns the write, after the server said
// yes. So a to-do that failed to save does not advance the tour, and a person
// who mistypes and retries is simply still on the same stop with the same
// arrow. The only way past without doing it is to leave the tour, which is a
// different button with a different consequence.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { tourLabels, tourProgressLine, tourStopParagraphs, type PointerButton } from '@/lib/companion/copy';
import { currentStop, tourProgress, type TourRun, type TourStop } from '@/lib/companion/tour';

import { PointerPopup } from './PointerPopup';
import { TourCursor } from './TourCursor';

export interface TourGuideProps {
  run: TourRun;
  /** Next, on a `watch` stop. Never rendered on a stop that is waiting. */
  onNext: () => void;
  /** The way out. Escape and the button both land here. */
  onSkip: () => void;
}

export function TourGuide({ run, onNext, onSkip }: TourGuideProps) {
  const stop = currentStop(run);
  // Set when a stop's control could not be found. The sentence still shows,
  // in the slab, with no arrow: a screen the tour cannot point at is still a
  // screen worth one sentence, and an arrow to nowhere is worse than none.
  const [lost, setLost] = useState(false);
  useEffect(() => { setLost(false); }, [stop?.key]);

  const labels = useMemo(() => tourLabels(), []);
  const progress = tourProgress(run);

  const buttons = useMemo<PointerButton[]>(() => {
    // A waiting stop offers exactly one thing, and it is the way out. Putting
    // a Next beside it would make "I will wait" a suggestion.
    if (run.waiting) return [{ label: labels.skip, answer: 'skip' }];
    const isLast = run.index === run.stops.length - 1;
    return [
      { label: isLast ? labels.done : labels.next, answer: 'next' },
      { label: labels.skip, answer: 'skip' },
    ];
  }, [run.waiting, run.index, run.stops.length, labels]);

  const onAnswer = useCallback((answer: string) => {
    if (answer === 'skip') { onSkip(); return; }
    // Escape on a waiting stop reads as `skip` (see escapeAnswer below), so a
    // stray `next` here cannot walk past a wait. Belt and braces: the reducer
    // refuses it too.
    if (answer === 'next' && !run.waiting) onNext();
  }, [onNext, onSkip, run.waiting]);

  const onNoTarget = useCallback(() => { setLost(true); }, []);

  if (!stop) return null;

  const paragraphs = tourStopParagraphs(stop);
  const footnote = run.waiting
    ? `${tourProgressLine(progress.at, progress.total)} · ${labels.waiting}`
    : tourProgressLine(progress.at, progress.total);

  // A stop about a control the browser can actually find.
  if (stop.anchor && !lost) {
    return (
      <>
        <TourCursor anchor={stop.anchor} onNoTarget={onNoTarget} />
        <PointerPopup
          // Keyed by stop so a new stop is a NEW popup rather than the old one
          // with different words: the popup resets its own geometry on an
          // anchor change, but a `watch` stop and a `try` stop on the SAME
          // anchor would otherwise reuse a spent `onShown`.
          key={stop.key}
          anchor={stop.anchor}
          paragraphs={paragraphs}
          buttons={buttons}
          footnote={footnote}
          // Escape is the way out of a tour, not a "not now". It is the only
          // keyboard exit and it must mean the same thing as the button.
          escapeAnswer="skip"
          onAnswer={onAnswer}
          onNoTarget={onNoTarget}
        />
      </>
    );
  }

  return (
    <TourSlab
      stop={stop}
      paragraphs={paragraphs}
      footnote={footnote}
      buttons={buttons}
      onAnswer={onAnswer}
      onSkip={onSkip}
    />
  );
}

// ─── The slab ───────────────────────────────────────────────────────────────
//
// For the stops that are about a screen rather than a button, and for the
// honest failure where a control did not render. Same ink, same shape, no
// arrow. Bottom centre rather than the middle of the window: the middle is
// where a dialog goes, and this is not asking for a decision, it is talking
// beside a screen the person is meant to be looking at.

function TourSlab({
  stop, paragraphs, footnote, buttons, onAnswer, onSkip,
}: {
  stop: TourStop;
  paragraphs: readonly string[];
  footnote: string;
  buttons: readonly PointerButton[];
  onAnswer: (answer: string) => void;
  onSkip: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      onSkip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSkip]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="cts-root" data-testid="tour-slab" data-tour-stop={stop.key}>
      <style dangerouslySetInnerHTML={{ __html: SLAB_CSS }} />
      <div className="cts-card" role="status" aria-live="polite">
        <span className="cts-star" aria-hidden>✦</span>
        {paragraphs.map((line, i) => <p className="cts-body" key={`p-${i}`}>{line}</p>)}
        <p className="cts-foot">{footnote}</p>
        <div className="cts-acts">
          {buttons.map((b, i) => (
            <button
              key={b.label}
              type="button"
              className={i === 0 ? 'cts-btn cts-btn-go' : 'cts-btn'}
              onClick={() => onAnswer(b.answer)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const SLAB_CSS = `
.cts-root{position:fixed;inset:0;z-index:53;pointer-events:none;display:flex;
  align-items:flex-end;justify-content:center;padding:0 16px 26px;
  --cts-ink:#1F231C;--cts-sage:#5C7A60;--cts-sage-l:#9EB7A6;--cts-white:#FCFDFB;
  --cts-soft:#B9C0B8;--cts-spring:cubic-bezier(.22,1,.36,1);
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.cts-root *{box-sizing:border-box;}
.cts-card{pointer-events:auto;width:min(420px,100%);border-radius:16px;padding:15px 17px 14px;
  background:radial-gradient(ellipse 320px 160px at 50% 130%,rgba(92,122,96,.30) 0%,rgba(92,122,96,0) 62%),var(--cts-ink);
  box-shadow:inset 0 1px 0 rgba(158,183,166,.14),0 24px 52px -26px rgba(31,42,32,.7);
  animation:ctsIn .3s var(--cts-spring) both;}
.cts-star{display:block;color:var(--cts-sage-l);font-size:11px;line-height:1;}
.cts-body{font-size:14px;line-height:1.55;color:var(--cts-white);margin:9px 0 0;text-wrap:pretty;}
.cts-foot{font-size:11.5px;line-height:1.4;color:var(--cts-sage-l);margin:11px 0 0;letter-spacing:.02em;}
.cts-acts{display:flex;align-items:center;gap:8px;margin-top:14px;flex-wrap:wrap;}
.cts-btn{height:32px;padding:0 12px;border-radius:9px;border:none;cursor:pointer;font:inherit;
  font-size:12.5px;background:rgba(255,255,255,.09);color:var(--cts-soft);}
@media (max-width:760px){.cts-btn{height:40px;padding:0 15px;font-size:13.5px;}}
.cts-btn:hover{background:rgba(255,255,255,.16);color:var(--cts-white);}
.cts-btn-go{background:var(--cts-sage-l);color:var(--cts-ink);font-weight:700;padding:0 16px;}
.cts-btn-go:hover{background:#B0C6B7;}
.cts-btn:focus-visible{outline:2px solid var(--cts-sage-l);outline-offset:2px;}
@keyframes ctsIn{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:none;}}
@media (prefers-reduced-motion: reduce){.cts-card{animation:none;}}
`;
