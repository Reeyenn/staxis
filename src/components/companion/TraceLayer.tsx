'use client';

// ─── The Trace — the companion reaching into the page ──────────────────────
//
// The reveal, and nothing else. The ASK happens where every other thing the
// companion says happens (the peek beside the mark, the block inside the
// panel); this component only ever renders after somebody said yes, and it
// clears completely on Escape, on a No, and on navigation.
//
// WHAT IT DRAWS, IN ONE SENTENCE: a scrim with a hole punched over each real
// row the pattern is about, hairlines running from those rows down through the
// page's own empty band to a rail, and the companion's ink card hanging off the
// middle of it. Nothing on the page is covered, nothing is moved, and the page
// itself is not asked to cooperate beyond carrying a `data-trace-anchor`
// attribute on its rows.
//
// WHY THE GEOMETRY IS NOT IN HERE. It is in src/lib/companion/trace/geometry.ts
// with the rest of the pure modules, for the reason everything else in this
// feature is: the suite runs under --conditions=react-server and cannot mount a
// component, so anything with a consequence has to be reachable without one.
// What is left here is measurement, listeners and pixels.
//
// HONESTY RULES THAT LIVE IN THIS FILE
//   • A row that is not in the DOM is never drawn to. It is named in the card's
//     own words instead, which is what `present: false` on an anchor is for.
//   • A row that is off screen is SCROLLED TO before anything is drawn, once,
//     so the line always lands on something the person can see.
//   • Every anchor missing means the card still appears, saying its piece, with
//     no lines at all. A trace with nothing to point at is a sentence.
//   • Reduced motion turns the drawing into a plain fade. Nothing is animated
//     into place; it is simply there.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  isOnScreen,
  layoutTrace,
  scrimPath,
  type MeasuredAnchor,
  type TraceGeometry,
  type TraceViewport,
} from '@/lib/companion/trace/geometry';
import type { TracePattern } from '@/lib/companion/trace/types';

export interface TraceReceipt {
  table: string;
  id: string;
  kind: 'created';
  label: string;
  where: string | null;
}

interface Props {
  pattern: TracePattern;
  /** Runs the one thing the card offered. Resolves to what was written. */
  onAct: (actionIndex: number) => Promise<{ done: boolean; receipt?: TraceReceipt; reason?: string }>;
  /** Escape, "not interested", or a click on nothing. Counts as a decline. */
  onDismiss: () => void;
  /** The trace is finished with. Clears without counting as a decline. */
  onClose: () => void;
}

/** How long the receipt stays up before the trace lets go of the screen. */
const RECEIPT_MS = 5200;

function readViewport(): TraceViewport {
  if (typeof window === 'undefined') return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * The node a `wo:<id>` / `inv:<id>` anchor names, or null.
 *
 * `data-trace-anchor` first, because that is the attribute this feature owns
 * and the one a new page adds. The maintenance board is checked by its existing
 * `data-wo-id` as well, so the hero page needed no edit at all to receive a
 * trace, which is the strongest possible evidence that the baseline works.
 */
function findAnchorNode(domId: string): HTMLElement | null {
  if (typeof document === 'undefined' || !domId) return null;
  const escaped = domId.replace(/["\\]/g, '\\$&');
  const direct = document.querySelector<HTMLElement>(`[data-trace-anchor="${escaped}"]`);
  if (direct) return direct;
  const [kind, id] = domId.split(':');
  if (kind === 'wo' && id) {
    return document.querySelector<HTMLElement>(`[data-wo-id="${id.replace(/["\\]/g, '\\$&')}"]`);
  }
  if (kind === 'inv' && id) {
    return document.querySelector<HTMLElement>(`[data-flip-id="${id.replace(/["\\]/g, '\\$&')}"]`);
  }
  return null;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function TraceLayer({ pattern, onAct, onDismiss, onClose }: Props) {
  const [geometry, setGeometry] = useState<TraceGeometry | null>(null);
  const [found, setFound] = useState<number | null>(null);
  const [receipt, setReceipt] = useState<TraceReceipt | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const scrolledRef = useRef(false);
  const frameRef = useRef<number | null>(null);

  const wanted = useMemo(() => pattern.anchors.filter((a) => a.present), [pattern]);
  const absent = useMemo(() => pattern.anchors.filter((a) => !a.present), [pattern]);

  // ── Measuring ────────────────────────────────────────────────────────────
  const measure = useCallback(() => {
    const viewport = readViewport();
    const measured: MeasuredAnchor[] = [];
    for (const anchor of wanted) {
      const node = findAnchorNode(anchor.domId);
      if (!node) continue;
      const box = node.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
      measured.push({
        domId: anchor.domId,
        label: anchor.label,
        rect: { left: box.left, top: box.top, width: box.width, height: box.height },
      });
    }
    setFound(measured.length);
    // Draw only to what is actually visible. A row scrolled past the top of the
    // window has a real rect with a negative top, and a hairline running off the
    // edge of the screen to reach it is a line pointing at nothing.
    const onScreen = measured.filter((m) => isOnScreen(m.rect, viewport));
    setGeometry(layoutTrace(onScreen, viewport));
  }, [wanted]);

  // First measure, after bringing the rows into view if they are not.
  useEffect(() => {
    let cancelled = false;
    const first = wanted.length > 0 ? findAnchorNode(wanted[0].domId) : null;
    if (first && !scrolledRef.current) {
      scrolledRef.current = true;
      const box = first.getBoundingClientRect();
      if (!isOnScreen({ left: box.left, top: box.top, width: box.width, height: box.height }, readViewport())) {
        first.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
      }
    }
    // Two frames, then a settle: one for the scroll to start, one for layout,
    // and a short timer for a smooth scroll to land. Measuring once, early,
    // was the version that drew the rail across the middle of the board.
    const raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => { if (!cancelled) measure(); });
    });
    const settle = setTimeout(() => { if (!cancelled) measure(); }, reduced ? 60 : 420);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      clearTimeout(settle);
    };
  }, [measure, wanted, reduced]);

  // Re-measure on anything that can move a row.
  useEffect(() => {
    const schedule = () => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        measure();
      });
    };
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [measure]);

  // ── Escape is the cheapest possible no ───────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (receipt) onClose();
      else onDismiss();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onDismiss, onClose, receipt]);

  // The receipt says its piece and then the trace lets go of the screen.
  useEffect(() => {
    if (!receipt) return;
    const timer = setTimeout(onClose, RECEIPT_MS);
    return () => clearTimeout(timer);
  }, [receipt, onClose]);

  const act = useCallback(async (index: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await onAct(index);
      if (result.done && result.receipt) setReceipt(result.receipt);
      else setRefusal(result.reason ?? 'I could not do that just now, so I left it alone.');
    } finally {
      setBusy(false);
    }
  }, [busy, onAct]);

  if (typeof document === 'undefined') return null;

  const viewport = readViewport();
  const cardBox = geometry?.card ?? {
    // No rows to point at. The card still says its piece, from the band the
    // page leaves at the bottom, with nothing drawn to anything.
    left: Math.round(Math.max(24, (viewport.width - Math.min(660, viewport.width - 48)) / 2)),
    width: Math.min(660, viewport.width - 48),
    top: null as number | null,
    bottom: 150 as number | null,
  };
  const drew = geometry !== null;
  const everythingGone = found === 0 && wanted.length > 0;

  return createPortal(
    <div className={`trc-root${reduced ? ' trc-still' : ''}`} data-testid="trace-layer">
      <style dangerouslySetInnerHTML={{ __html: TRACE_CSS }} />

      {/* The page steps back. One shape, holes punched over the real rows, so
          nothing the pattern is about is painted over and nothing else is left
          at full brightness. */}
      <svg className="trc-scrim" width={viewport.width} height={viewport.height} aria-hidden>
        <path d={scrimPath(geometry?.cutouts ?? [], viewport)} fillRule="evenodd" className="trc-scrim-fill" />
        {(geometry?.cutouts ?? []).map((c, i) => (
          <rect
            key={`lit-${i}`}
            x={c.left} y={c.top} width={c.width} height={c.height}
            rx={14} className="trc-lit"
          />
        ))}
      </svg>

      {drew && geometry && (
        <svg className="trc-lines" width={viewport.width} height={viewport.height} aria-hidden>
          {geometry.drops.map((d, i) => (
            <path
              key={`drop-${i}`}
              d={`M${d.x} ${d.from} V${d.to}`}
              className="trc-line trc-draw"
              style={{ animationDelay: `${i * 0.06}s` }}
            />
          ))}
          {geometry.rail && (
            <path
              d={`M${geometry.rail.from} ${geometry.rail.y} H${geometry.rail.to}`}
              className="trc-line trc-draw"
              style={{ animationDelay: '0.24s' }}
            />
          )}
          {geometry.dots.map((dot, i) => (
            <g key={`dot-${i}`} className="trc-pop" style={{ animationDelay: `${0.3 + i * 0.04}s` }}>
              <circle cx={dot.x} cy={dot.y} r={4} className="trc-dot" />
              <text x={dot.x} y={geometry.labelY} textAnchor="middle" className="trc-label">
                {dot.label}
              </text>
              {receipt && <circle cx={dot.x} cy={dot.y} r={9} className="trc-stamp" />}
            </g>
          ))}
          {geometry.stem && (
            <path
              d={`M${geometry.stem.x} ${geometry.stem.from} V${geometry.stem.to}`}
              className="trc-stem trc-pop"
              style={{ animationDelay: '0.34s' }}
            />
          )}
        </svg>
      )}

      <div
        className="trc-card"
        role="dialog"
        aria-label="Staxis found a pattern"
        style={{
          left: `${cardBox.left}px`,
          width: `${cardBox.width}px`,
          ...(cardBox.top !== null ? { top: `${cardBox.top}px` } : {}),
          ...(cardBox.bottom !== null ? { bottom: `${cardBox.bottom}px` } : {}),
        }}
      >
        {receipt ? (
          <>
            <div className="trc-head">
              <span className="trc-tick" aria-hidden>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                  <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="trc-kick">Done</span>
            </div>
            <p className="trc-body">{receipt.label}</p>
            <p className="trc-basis">
              {`It is on the board now${receipt.where ? ` at ${receipt.where}` : ''}. `}
              {'Nothing was closed without you.'}
            </p>
            <div className="trc-acts">
              <button type="button" className="trc-btn-quiet" onClick={onClose}>Thanks</button>
            </div>
          </>
        ) : (
          <>
            <div className="trc-head">
              <span className="trc-star" aria-hidden>✦</span>
              <span className="trc-kick">{pattern.kicker}</span>
            </div>
            <p className="trc-body">{pattern.body}</p>

            {everythingGone && (
              <p className="trc-basis">
                {'The rows this was about are not on this screen right now, so there is nothing to draw to.'}
              </p>
            )}

            {pattern.facts.length > 0 && (
              <div className="trc-facts">
                {pattern.facts.map((f, i) => (
                  <div className="trc-fact" key={`fact-${i}`}>
                    <span className="trc-fact-k">{f.k}</span>
                    <span className="trc-fact-v">{f.v}</span>
                  </div>
                ))}
              </div>
            )}

            {absent.map((a, i) => (
              <p className="trc-basis" key={`absent-${i}`}>{a.note ?? a.label}</p>
            ))}

            {pattern.cost && (
              <div className="trc-cost">
                {pattern.cost.figure && <span className="trc-figure">{pattern.cost.figure}</span>}
                <span className="trc-cost-line">{pattern.cost.line}</span>
              </div>
            )}

            <p className="trc-basis">{pattern.cost ? pattern.cost.basis : pattern.basis}</p>
            {pattern.cost && <p className="trc-basis">{pattern.basis}</p>}
            {refusal && <p className="trc-refusal">{refusal}</p>}

            <div className="trc-acts">
              {pattern.actions.map((a, i) => (
                <button
                  key={a.label}
                  type="button"
                  className={i === 0 ? 'trc-btn trc-btn-go' : 'trc-btn'}
                  disabled={busy}
                  onClick={() => { void act(i); }}
                >
                  {a.label}
                </button>
              ))}
              <button type="button" className="trc-btn-quiet" onClick={onDismiss}>
                {'Not interested'}
              </button>
              <span className="trc-esc" aria-hidden>{'Esc clears the trace'}</span>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────
//
// Scoped under `.trc-*` and injected the same way AskStaxisBar injects its own,
// because App Router restricts plain global CSS imports to the root layout and
// this needs keyframes and a fill-rule that inline styles cannot express.
//
// The tokens are the companion's tokens. The ink, the sage and the spring are
// the same values the panel and the peek already use, because this IS the
// panel and the peek reaching onto the page, and a second dark surface half a
// shade off the first one would read as a second product.

const TRACE_CSS = `
.trc-root{position:fixed;inset:0;z-index:52;pointer-events:none;
  --trc-ink:#1F231C;--trc-sage:#5C7A60;--trc-sage-l:#9EB7A6;
  --trc-scrim:rgba(248,250,246,.72);--trc-white:#FCFDFB;
  --trc-mute:#6E786F;--trc-soft:#B9C0B8;
  --trc-spring:cubic-bezier(.22,1,.36,1);
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.trc-root *{box-sizing:border-box;}
.trc-scrim,.trc-lines{position:fixed;left:0;top:0;pointer-events:none;}
.trc-scrim-fill{fill:var(--trc-scrim);animation:trcFade .32s ease both;}
.trc-lit{fill:none;stroke:rgba(92,122,96,.5);stroke-width:1.5;animation:trcFade .32s ease .06s both;}
.trc-line{fill:none;stroke:var(--trc-sage);stroke-width:1.4;stroke-linecap:round;}
.trc-stem{fill:none;stroke:var(--trc-sage);stroke-width:1;stroke-dasharray:4 4;}
.trc-dot{fill:var(--trc-sage);}
.trc-stamp{fill:none;stroke:var(--trc-sage);stroke-width:1.5;animation:trcPop .42s var(--trc-spring) both;}
.trc-label{fill:#8A9187;font-family:var(--font-geist-mono),ui-monospace,monospace;
  font-size:9.5px;font-weight:600;letter-spacing:1.2px;}
.trc-draw{stroke-dasharray:900;animation:trcDraw .42s var(--trc-spring) both;}
.trc-pop{animation:trcFade .24s ease both;}

.trc-card{position:fixed;pointer-events:auto;border-radius:18px;padding:17px 20px 16px;
  background:radial-gradient(ellipse 400px 200px at 50% 130%,rgba(92,122,96,.30) 0%,rgba(92,122,96,0) 62%),var(--trc-ink);
  box-shadow:inset 0 1px 0 rgba(158,183,166,.14),0 28px 60px -28px rgba(31,42,32,.7);
  animation:trcDrop .3s var(--trc-spring) .42s both;max-height:calc(100dvh - 48px);overflow:auto;}
.trc-head{display:flex;align-items:center;gap:9px;}
.trc-star{color:var(--trc-sage-l);font-size:11px;line-height:1;}
.trc-tick{display:grid;place-items:center;width:18px;height:18px;border-radius:50%;
  background:var(--trc-sage-l);color:var(--trc-ink);flex-shrink:0;
  animation:trcPop .42s var(--trc-spring) both;}
.trc-kick{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9px;font-weight:700;
  letter-spacing:.16em;text-transform:uppercase;color:var(--trc-sage-l);}
.trc-body{font-size:15px;line-height:1.55;color:var(--trc-white);margin:10px 0 0;text-wrap:pretty;}
.trc-facts{display:flex;flex-direction:column;gap:5px;margin-top:12px;}
.trc-fact{display:flex;align-items:baseline;gap:11px;background:rgba(255,255,255,.06);
  border-radius:9px;padding:9px 12px;}
.trc-fact-k{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:8.5px;font-weight:700;
  letter-spacing:.12em;text-transform:uppercase;color:var(--trc-sage-l);width:104px;flex-shrink:0;}
.trc-fact-v{font-size:12.5px;line-height:1.45;color:#EDF1EC;}
.trc-cost{display:flex;align-items:baseline;gap:14px;margin:12px 0 0;padding:10px 12px;
  border-radius:11px;background:rgba(158,183,166,.10);border:1px solid rgba(158,183,166,.24);
  flex-wrap:wrap;}
.trc-figure{font-family:var(--font-fraunces),Georgia,serif;font-style:italic;font-size:24px;
  line-height:1;color:var(--trc-white);}
.trc-cost-line{font-size:12px;color:var(--trc-soft);}
.trc-basis{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9.5px;line-height:1.6;
  color:var(--trc-mute);margin:8px 0 0;}
.trc-refusal{font-size:13px;line-height:1.5;color:var(--trc-sage-l);margin:10px 0 0;}
.trc-acts{display:flex;align-items:center;gap:9px;margin-top:15px;flex-wrap:wrap;}
.trc-btn{height:36px;padding:0 14px;border-radius:10px;border:none;cursor:pointer;font:inherit;
  font-size:13px;background:rgba(255,255,255,.09);color:var(--trc-white);}
.trc-btn:hover{background:rgba(255,255,255,.16);}
.trc-btn-go{background:var(--trc-sage-l);color:var(--trc-ink);font-weight:700;padding:0 16px;}
.trc-btn-go:hover{background:#B0C6B7;}
.trc-btn:disabled{opacity:.55;cursor:default;}
.trc-btn:focus-visible,.trc-btn-quiet:focus-visible{outline:2px solid var(--trc-sage-l);outline-offset:2px;}
.trc-btn-quiet{background:transparent;border:none;padding:0 4px;cursor:pointer;font:inherit;font-size:11.5px;
  color:var(--trc-sage-l);text-decoration:underline;text-underline-offset:2px;}
.trc-btn-quiet:hover{color:var(--trc-white);}
.trc-esc{margin-left:auto;font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9px;
  font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--trc-mute);}

@keyframes trcFade{from{opacity:0;}to{opacity:1;}}
@keyframes trcDraw{from{stroke-dashoffset:900;}to{stroke-dashoffset:0;}}
@keyframes trcDrop{from{opacity:0;transform:translateY(-12px);}to{opacity:1;transform:none;}}
@keyframes trcPop{from{transform:scale(0);}70%{transform:scale(1.18);}to{transform:scale(1);}}

/* Reduced motion: everything is simply there. Nothing draws, nothing drops,
   and the tick does not spring. The information is identical. */
.trc-still .trc-draw,.trc-still .trc-pop,.trc-still .trc-card,
.trc-still .trc-tick,.trc-still .trc-stamp,.trc-still .trc-lit,.trc-still .trc-scrim-fill{
  animation:trcFade .12s linear both;stroke-dashoffset:0;transform:none;}
@media (prefers-reduced-motion: reduce){
  .trc-draw,.trc-pop,.trc-card,.trc-tick,.trc-stamp,.trc-lit,.trc-scrim-fill{
    animation:trcFade .12s linear both;stroke-dashoffset:0;transform:none;}
}
/* The trace does not exist on a phone. See TRACE_MIN_VIEWPORT_WIDTH. */
@media (max-width:899px){.trc-root{display:none !important;}}
`;
