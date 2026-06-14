'use client';

// Scrollable Month · Day · Year wheel date picker. Drop-in replacement for
// <input type="date">: `value` / `onChange` speak the same YYYY-MM-DD string,
// and an empty string means "not set" — exactly like the native control, so the
// optional/backfill semantics are preserved (empty stays empty until touched).
//
// Half-peek layout: one full-height selected row with the neighbours above and
// below clipped to a thin sliver, so the whole control stays compact (default
// ~48px tall for a 32px row at 25% peek). Snow design tokens + EN/ES month
// labels keep it on-brand and bilingual everywhere it's dropped in.

import React, { useEffect, useMemo, useRef, useState } from 'react';

const FONT_SANS = 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif';
const FONT_MONO = 'var(--font-geist-mono), ui-monospace, monospace';

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

const pad2 = (n: number) => String(n).padStart(2, '0');
const clampN = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const daysInMonth = (year: number, month0: number) => new Date(year, month0 + 1, 0).getDate();

function parseISO(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

// Hide the wheel scrollbars on WebKit (scrollbarWidth:none covers Firefox).
// Injected once for the whole app.
let scrollbarStyleInjected = false;
function useHideScrollbar() {
  useEffect(() => {
    if (scrollbarStyleInjected || typeof document === 'undefined') return;
    scrollbarStyleInjected = true;
    const s = document.createElement('style');
    s.textContent = '.wdp-wheel::-webkit-scrollbar{display:none}';
    document.head.appendChild(s);
  }, []);
}

type WheelProps = {
  items: string[];
  index: number;
  rowHeight: number;
  peek: number;
  committed: boolean;
  ariaLabel: string;
  elRef: React.MutableRefObject<HTMLDivElement | null>;
  onTouch: () => void;
  onSettle: () => void;
};

function Wheel({ items, index, rowHeight, peek, committed, ariaLabel, elRef, onTouch, onSettle }: WheelProps) {
  const ROW = rowHeight;
  const [active, setActive] = useState(index);
  const scrolling = useRef(false);
  const settleTimer = useRef<number | null>(null);
  const rafId = useRef<number | null>(null);

  // Position to the controlled index on mount / when it changes — but never
  // mid-scroll, which would yank the wheel out from under the user's finger.
  useEffect(() => {
    const el = elRef.current;
    if (!el || scrolling.current) return;
    el.scrollTop = index * ROW;
    setActive(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, ROW, items.length]);

  useEffect(() => () => {
    if (settleTimer.current != null) clearTimeout(settleTimer.current);
    if (rafId.current != null) cancelAnimationFrame(rafId.current);
  }, []);

  const handleScroll = () => {
    const el = elRef.current;
    if (!el) return;
    if (rafId.current == null) {
      rafId.current = requestAnimationFrame(() => {
        rafId.current = null;
        setActive(clampN(Math.round(el.scrollTop / ROW), 0, items.length - 1));
      });
    }
    if (settleTimer.current != null) clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      scrolling.current = false;
      onSettle();
    }, 110);
  };

  const beginUserScroll = () => { scrolling.current = true; onTouch(); };

  return (
    <div
      ref={elRef}
      className="wdp-wheel"
      role="listbox"
      aria-label={ariaLabel}
      tabIndex={0}
      onScroll={handleScroll}
      onWheel={beginUserScroll}
      onPointerDown={beginUserScroll}
      onTouchStart={beginUserScroll}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const el = elRef.current;
        if (!el) return;
        const next = clampN(active + (e.key === 'ArrowDown' ? 1 : -1), 0, items.length - 1);
        if (next === active) return;
        beginUserScroll();
        el.scrollTo({ top: next * ROW, behavior: 'smooth' });
      }}
      style={{
        flex: 1, minWidth: 0, height: ROW + peek * 2, overflowY: 'scroll',
        scrollSnapType: 'y mandatory', scrollbarWidth: 'none', textAlign: 'center',
        position: 'relative', zIndex: 1, WebkitOverflowScrolling: 'touch', outline: 'none',
      }}
    >
      <div aria-hidden style={{ height: peek }} />
      {items.map((it, i) => {
        const on = i === active;
        return (
          <div
            key={it}
            role="option"
            aria-selected={on}
            onClick={() => {
              onTouch();
              const el = elRef.current;
              if (!el) return;
              const target = i * ROW;
              if (Math.abs(el.scrollTop - target) < 1) {
                onSettle();
              } else {
                scrolling.current = true;
                el.scrollTo({ top: target, behavior: 'smooth' });
              }
            }}
            style={{
              height: ROW, lineHeight: `${ROW}px`, scrollSnapAlign: 'center',
              cursor: 'pointer', userSelect: 'none', fontFamily: FONT_SANS,
              fontSize: ROW < 30 ? 14 : 15, fontWeight: on ? 500 : 400,
              color: on ? (committed ? 'var(--snow-ink)' : 'var(--snow-ink3)') : 'rgba(31,35,28,0.32)',
              transition: 'color 0.12s',
            }}
          >
            {it}
          </div>
        );
      })}
      <div aria-hidden style={{ height: peek }} />
    </div>
  );
}

export type WheelDatePickerProps = {
  /** 'YYYY-MM-DD' or '' for unset — same contract as <input type="date">. */
  value: string;
  onChange: (value: string) => void;
  lang?: 'en' | 'es';
  /** Selected-row height in px (default 32). */
  rowHeight?: number;
  /** Fraction of a row each neighbour peeks in (default 0.25 → ~48px total). */
  peekFraction?: number;
  minYear?: number;
  maxYear?: number;
  /** Show the Month/Day/Year column headers above the wheels (default true). */
  showHeaders?: boolean;
};

export function WheelDatePicker({
  value, onChange, lang = 'en', rowHeight = 32, peekFraction = 0.25, minYear, maxYear, showHeaders = true,
}: WheelDatePickerProps) {
  useHideScrollbar();
  const ROW = rowHeight;
  const peek = Math.max(1, Math.round(ROW * peekFraction));
  const es = lang === 'es';
  const MONTHS = es ? MONTHS_ES : MONTHS_EN;

  const today = new Date();
  const thisYear = today.getFullYear();
  const yMin = minYear ?? thisYear - 5;
  const yMax = maxYear ?? thisYear + 5;
  const YEARS = useMemo(
    () => Array.from({ length: Math.max(1, yMax - yMin + 1) }, (_, i) => yMin + i),
    [yMin, yMax],
  );

  const committed = !!parseISO(value);
  const parsed = parseISO(value);
  const baseY = parsed ? parsed.y : thisYear;
  const baseM = parsed ? parsed.m : today.getMonth();
  const baseD = parsed ? parsed.d : today.getDate();

  const monthIndex = clampN(baseM, 0, 11);
  const yearIndex = clampN(YEARS.indexOf(clampN(baseY, yMin, yMax)), 0, YEARS.length - 1);
  const dim = daysInMonth(YEARS[yearIndex], monthIndex);
  const dayItems = useMemo(() => Array.from({ length: dim }, (_, i) => String(i + 1)), [dim]);
  const dayIndex = clampN(baseD - 1, 0, dim - 1);

  const monthEl = useRef<HTMLDivElement | null>(null);
  const dayEl = useRef<HTMLDivElement | null>(null);
  const yearEl = useRef<HTMLDivElement | null>(null);
  const touched = useRef(false);

  const readIdx = (el: HTMLDivElement | null, count: number) =>
    el ? clampN(Math.round(el.scrollTop / ROW), 0, count - 1) : 0;

  const commit = () => {
    if (!touched.current) return;
    const m = readIdx(monthEl.current, 12);
    const yi = readIdx(yearEl.current, YEARS.length);
    const year = YEARS[yi];
    const maxDay = daysInMonth(year, m);
    let d = readIdx(dayEl.current, 31) + 1;
    if (d > maxDay) {
      d = maxDay;
      dayEl.current?.scrollTo({ top: (d - 1) * ROW, behavior: 'smooth' });
    }
    const iso = `${year}-${pad2(m + 1)}-${pad2(d)}`;
    if (committed && iso === value) return;
    onChange(iso);
  };

  const onTouch = () => { touched.current = true; };
  const headers = es ? ['Mes', 'Día', 'Año'] : ['Month', 'Day', 'Year'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      {showHeaders && (
        <div aria-hidden style={{ display: 'flex', gap: 4, padding: '0 8px' }}>
          {headers.map((h) => (
            <span key={h} style={{
              flex: 1, textAlign: 'center', fontFamily: FONT_MONO, fontSize: 10,
              letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--snow-ink3)',
            }}>{h}</span>
          ))}
        </div>
      )}
      <div style={{
        position: 'relative', display: 'flex', gap: 4,
        background: 'var(--snow-bg)', border: '1px solid var(--snow-rule)',
        borderRadius: 12, padding: '0 8px', overflow: 'hidden',
      }}>
        <Wheel items={MONTHS} index={monthIndex} rowHeight={ROW} peek={peek} committed={committed}
          ariaLabel={headers[0]} elRef={monthEl} onTouch={onTouch} onSettle={commit} />
        <Wheel items={dayItems} index={dayIndex} rowHeight={ROW} peek={peek} committed={committed}
          ariaLabel={headers[1]} elRef={dayEl} onTouch={onTouch} onSettle={commit} />
        <Wheel items={YEARS.map(String)} index={yearIndex} rowHeight={ROW} peek={peek} committed={committed}
          ariaLabel={headers[2]} elRef={yearEl} onTouch={onTouch} onSettle={commit} />
        <div aria-hidden style={{
          position: 'absolute', left: 8, right: 8, top: peek, height: ROW,
          pointerEvents: 'none', borderRadius: 8,
          background: committed ? 'rgba(92,122,96,0.10)' : 'transparent',
          borderTop: '1px solid var(--snow-rule)', borderBottom: '1px solid var(--snow-rule)',
        }} />
      </div>
    </div>
  );
}
