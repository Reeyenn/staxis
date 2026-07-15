'use client';

import React, { useEffect, useState } from 'react';
import { T, fonts } from './tokens';
import { Serif } from './Serif';
import { EASE, useCountUp } from './motion';

// Visual-effects layer for the Triage inventory tab: the page-scoped
// stylesheet (hover physics, decorative loops, responsive collapse) plus the
// animated readouts — count-up numbers, the stock-health ink ring, the
// "all clear" check, and the pinging status dot.
//
// Split of responsibilities with motion.ts: functional motion (entrances,
// FLIP, flips, pops) is WAAPI there so it survives prefers-reduced-motion;
// everything here that is purely decorative (sheen, shimmer, ping loops) is
// CSS gated behind `prefers-reduced-motion: no-preference` so crews who ask
// for calm get calm — without losing the functional animations.

// ── Page stylesheet ───────────────────────────────────────────────────────
const CSS = `
/* Layout: rail + board, collapsing to a single column on narrow screens. */
.inv-layout { display: grid; grid-template-columns: 224px 1fr; gap: 18px; align-items: start; }
.inv-board  { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 13px; align-items: start; }
@media (max-width: 980px) {
  .inv-layout { grid-template-columns: 1fr; }
  .inv-rail   { position: static !important; }
}
@media (max-width: 840px) {
  .inv-board { grid-template-columns: 1fr; }
}

/* Board cards: paper lift on hover, and the flip hint only shows when the
   pointer is over the card (keeps the resting board quiet). Concourse card
   physics: sage-tinted lift on the .22,1,.36,1 spring. */
.inv-card {
  box-shadow: 0 6px 16px -14px rgba(31,42,32,0.35);
  transition: transform .55s cubic-bezier(.22,1,.36,1), box-shadow .55s cubic-bezier(.22,1,.36,1), border-color .55s cubic-bezier(.22,1,.36,1);
}
.inv-card:hover {
  transform: translateY(-5px);
  box-shadow: 0 18px 36px -20px rgba(62,92,72,0.5);
  border-color: rgba(92,122,96,0.45) !important;
}
.inv-flip-hint { opacity: 0; transition: opacity .3s cubic-bezier(.22,1,.36,1), transform .3s cubic-bezier(.22,1,.36,1); }
.inv-card:hover .inv-flip-hint { opacity: 1; transform: rotate(90deg); }

/* Rail buttons: sage accent bar slides in on hover; the arrow nudges. */
.inv-rail-btn { transition: background .18s ease, border-color .18s ease; position: relative; }
.inv-rail-btn::before {
  content: ''; position: absolute; left: 0; top: 22%; bottom: 22%; width: 2.5px;
  border-radius: 3px; background: ${T.brand}; opacity: 0;
  transform: scaleY(0.3); transition: opacity .2s ease, transform .25s ${EASE.glide};
}
.inv-rail-plain:hover { background: ${T.inkWash}; }
.inv-rail-plain:hover::before { opacity: 1; transform: scaleY(1); }
.inv-arrow { display: inline-block; transition: transform .25s ${EASE.glide}; }
.inv-rail-btn:hover .inv-arrow { transform: translateX(3px); }

/* Search field: soft sage focus ring. */
.inv-search { transition: border-color .2s ease, box-shadow .2s ease; }
.inv-search:focus { border-color: rgba(92,122,96,0.45) !important; box-shadow: 0 0 0 3px rgba(158,183,166,0.25); }

/* Segmented control text swap. */
.inv-seg-btn { transition: color .22s ease; }

/* Staxis dropdown (menu-kit) option hover. */
.inv-menu-opt { transition: background .12s ease; }
.inv-menu-opt:hover { background: rgba(31,35,28,0.06); }

/* Count tick — a value change gives the number a tiny settle-pop. */
@keyframes inv-tick { 0% { transform: translateY(-6px) scale(1.12); opacity: .2; } 100% { transform: none; opacity: 1; } }
.inv-tick { display: inline-block; animation: inv-tick .34s ${EASE.settle}; }

/* Decorative loops — skipped entirely under reduced motion. */
@media (prefers-reduced-motion: no-preference) {
  @keyframes inv-ping {
    0%   { transform: scale(1);   opacity: .55; }
    70%  { transform: scale(2.6); opacity: 0; }
    100% { transform: scale(2.6); opacity: 0; }
  }
  .inv-ping { animation: inv-ping 2.4s cubic-bezier(.2,.6,.35,1) infinite; }

  @keyframes inv-sheen {
    0%, 76% { transform: translateX(-130%); }
    100%    { transform: translateX(130%); }
  }
  .inv-sheen { position: relative; overflow: hidden; }
  .inv-sheen::after {
    content: ''; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(105deg, transparent 42%, rgba(255,255,255,.16) 50%, transparent 58%);
    animation: inv-sheen 7s ease-in-out infinite;
  }

  @keyframes inv-shimmer {
    0%, 55% { transform: translateX(-110%); }
    100%    { transform: translateX(110%); }
  }
  .inv-shimmer {
    position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(100deg, transparent 38%, rgba(255,255,255,.5) 50%, transparent 62%);
    animation: inv-shimmer 3.2s ease-in-out infinite;
  }
}

/* Masthead hairline: load-time draw retired with the rest of the entrance
   choreography — it renders complete. (Keyframes kept for future reuse.) */
@keyframes inv-rule-draw { from { transform: scaleX(0); } }
.inv-rule-draw { transform-origin: left center; }

/* All-clear check draw. */
@keyframes inv-check-draw { from { stroke-dashoffset: 1; } }
.inv-check-circle { stroke-dasharray: 1; animation: inv-check-draw .6s ${EASE.settle} backwards; }
.inv-check-mark   { stroke-dasharray: 1; animation: inv-check-draw .45s ${EASE.settle} .45s backwards; }
`;

export function InvFx() {
  return <style dangerouslySetInnerHTML={{ __html: CSS }} />;
}

// ── Animated number ───────────────────────────────────────────────────────
export function CountUp({
  value,
  format,
  duration = 850,
}: {
  value: number;
  format?: (n: number) => string;
  duration?: number;
}) {
  const v = useCountUp(value, duration);
  return <>{format ? format(v) : Math.round(v).toLocaleString('en-US')}</>;
}

// A number that gives a tiny settle-pop whenever it changes (column counts,
// rail badges). Remount-by-key drives the CSS animation.
export function TickNum({ children }: { children: React.ReactNode }) {
  return (
    <span key={String(children)} className="inv-tick">
      {children}
    </span>
  );
}

// ── Stock-health ink ring ─────────────────────────────────────────────────
// SVG arc that inks itself in on load and re-draws to the new sweep whenever
// the percentage changes. Color follows the app-wide 70/30 thresholds.
export function HealthRing({
  pct,
  size = 78,
  stroke = 5,
}: {
  /** 0–100, or null before the first count exists ("—"). */
  pct: number | null;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const target = pct == null ? 0 : Math.max(0, Math.min(100, pct)) / 100;
  // Start fully un-inked, then transition to the target sweep after mount.
  const [sweep, setSweep] = useState(0);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setSweep(target));
    return () => cancelAnimationFrame(raf);
  }, [target]);

  const color = pct == null ? T.dim : pct >= 70 ? T.forest : pct >= 30 ? T.gold : T.terra;
  const shown = useCountUp(pct ?? 0, 1000);

  return (
    <span style={{ position: 'relative', width: size, height: size, display: 'inline-flex', flex: 'none' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={T.ruleSoft} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - sweep)}
          style={{ transition: `stroke-dashoffset 1s ${EASE.settle}, stroke .4s ease` }}
        />
      </svg>
      <span
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Serif size={size * 0.28} color={pct == null ? T.dim : T.ink}>
          {pct == null ? '—' : `${Math.round(shown)}%`}
        </Serif>
      </span>
    </span>
  );
}

// ── All clear ─────────────────────────────────────────────────────────────
// The empty state for the "Order now" column — the one empty state that is
// good news, so it gets a moment: a forest check that draws itself in.
export function AllClear({ label, sub }: { label: string; sub: string }) {
  return (
    <div
      style={{
        padding: '26px 0 22px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 9,
        textAlign: 'center',
      }}
    >
      <svg width={44} height={44} viewBox="0 0 44 44" aria-hidden>
        <circle
          className="inv-check-circle"
          cx={22} cy={22} r={19}
          fill="none" stroke={T.forest} strokeWidth={2}
          pathLength={1}
        />
        <path
          className="inv-check-mark"
          d="M14 22.5 L19.5 28 L30 16.5"
          fill="none" stroke={T.forest} strokeWidth={2.5}
          strokeLinecap="round" strokeLinejoin="round"
          pathLength={1}
        />
      </svg>
      <Serif size={18} color={T.forestText}>{label}</Serif>
      <span style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.dim, marginTop: -4 }}>{sub}</span>
    </div>
  );
}

// ── Pinging status dot ────────────────────────────────────────────────────
// A StatusDot with a radar ring — used where "needs attention right now"
// deserves a heartbeat (the Order-now column header while it has items).
export function PingDot({ color, size = 10 }: { color: string; size?: number }) {
  return (
    <span style={{ position: 'relative', width: size, height: size, display: 'inline-flex', flex: 'none' }}>
      <span
        className="inv-ping"
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          border: `1.5px solid ${color}`,
        }}
      />
      <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: color }} />
    </span>
  );
}
