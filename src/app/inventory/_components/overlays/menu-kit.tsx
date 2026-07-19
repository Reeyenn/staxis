'use client';

// StaxisMenu — the custom dropdown for the scan-review sheet (replaces native
// <select>s, which look like the browser's, not ours). A trigger button plus a
// fixed-position popover card: white, rounded, soft shadow, hover-highlighted
// options, optional group headers, ✓ on the current pick.
//
// Positioning is `fixed`, measured from the trigger, so the popover escapes
// the Overlay card's overflow clipping. (The Overlay scrim's backdrop-filter
// makes it the containing block for fixed descendants — it spans the full
// viewport, so the coordinates are viewport coordinates in practice.) Flips
// above the trigger when there's no room below. Closes on pick, outside
// press, ESC (captured before the Overlay's own ESC-close so the sheet stays
// open), or scrolling anything outside the menu.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { T, fonts } from '../tokens';

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface MenuOption {
  value: string;
  label: string;
}

export interface MenuGroup {
  label?: string;
  options: MenuOption[];
}

export function StaxisMenu({
  groups,
  selected,
  onPick,
  triggerStyle,
  triggerLabel,
  title,
  menuWidth = 260,
}: {
  groups: MenuGroup[];
  selected?: string | null;
  onPick: (value: string) => void;
  triggerStyle: React.CSSProperties;
  triggerLabel: React.ReactNode;
  /** aria-label + tooltip — required for icon-only triggers. */
  title?: string;
  menuWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Measure + place before paint (the popover mounts at -9999 until then),
  // then a short settle-in.
  useIsoLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const t = trigRef.current;
    const m = menuRef.current;
    if (!t || !m) return;
    const r = t.getBoundingClientRect();
    const mh = m.offsetHeight;
    const mw = m.offsetWidth;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    setPos({ top, left });
    m.animate(
      [
        { opacity: 0, transform: 'translateY(-4px) scale(.99)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 150, easing: 'ease-out', fill: 'none' },
    );
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || trigRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Capture phase: swallow it so the Overlay's window-level ESC-close
        // doesn't also fire — ESC dismisses the menu, not the whole sheet.
        e.stopPropagation();
        close();
      }
    };
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('touchstart', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('touchstart', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={title}
        title={title}
        style={triggerStyle}
      >
        {triggerLabel}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="listbox"
          style={{
            position: 'fixed',
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            zIndex: 2100,
            width: menuWidth,
            maxHeight: 300,
            overflowY: 'auto',
            background: T.paper,
            border: `1px solid ${T.rule}`,
            borderRadius: 12,
            boxShadow: '0 18px 44px -12px rgba(31,42,32,0.28)',
            padding: 5,
            boxSizing: 'border-box',
          }}
        >
          {groups.map((g, gi) => (
            <div
              key={gi}
              style={{
                borderTop: gi > 0 ? `1px solid ${T.ruleFaint}` : 'none',
                marginTop: gi > 0 ? 4 : 0,
                paddingTop: gi > 0 ? 4 : 0,
              }}
            >
              {g.label && <div style={groupHdr}>{g.label}</div>}
              {g.options.map((o) => {
                const sel = o.value === selected;
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={sel}
                    className="inv-menu-opt"
                    onClick={() => {
                      setOpen(false);
                      onPick(o.value);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      minHeight: 44,
                      gap: 7,
                      width: '100%',
                      padding: '8px 10px',
                      border: 'none',
                      background: 'transparent',
                      borderRadius: 8,
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: fonts.sans,
                      fontSize: 13.5,
                      fontWeight: sel ? 600 : 450,
                      color: T.ink,
                    }}
                  >
                    <span style={{ width: 14, flex: 'none', color: T.forestText, fontSize: 12 }}>{sel ? '✓' : ''}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {o.label}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const groupHdr: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 9.5,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: T.ink2,
  fontWeight: 600,
  padding: '7px 10px 3px',
};
