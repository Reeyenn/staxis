'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Communications · Slack-Classic redesign — shared design layer.
// Brand tokens, department colours, atoms (Avatar / DeptDot / Presence / …) and
// the Web-Animations-API motion helpers (flip / enter / pop / slide). Mirrors
// the Claude-Design handoff; fonts come in via CSS vars set on the comms root.
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import type { CommsDept } from '@/lib/comms/types';

// ── Brand tokens ────────────────────────────────────────────────────────────
export const T = {
  bg: '#FFFFFF',
  paper: '#FBFAF7',
  ink: '#181611',
  dim: '#928C7F',
  hair: 'rgba(24,22,17,.12)',
  hairSoft: 'rgba(24,22,17,.06)',
  hairer: 'rgba(24,22,17,.20)',
  forest: '#3C9C68',
  forestDeep: '#2F7A51',
  forestTint: 'rgba(60,156,104,.12)',
  forestTint2: 'rgba(60,156,104,.20)',
  terracotta: '#C2562E',
  gold: '#C99A2E',
  teal: '#3389A0',
  tealDeep: '#2A6E84',
} as const;

export const SANS = 'var(--font-hanken), system-ui, -apple-system, sans-serif';
export const SERIF = 'var(--font-newsreader), Georgia, serif';
export const MONO = 'var(--font-jbmono), ui-monospace, monospace';

const DEPT_COLOR: Record<CommsDept, string> = {
  management: T.ink,
  front_desk: T.teal,
  housekeeping: T.forest,
  maintenance: T.terracotta,
  laundry: T.gold,
};
const DEPT_LABEL: Record<CommsDept, string> = {
  management: 'Management',
  front_desk: 'Front Desk',
  housekeeping: 'Housekeeping',
  maintenance: 'Maintenance',
  laundry: 'Laundry',
};
export function deptColor(d: CommsDept | null | undefined): string {
  return DEPT_COLOR[(d ?? 'management') as CommsDept] ?? T.ink;
}
export function deptLabel(d: CommsDept | null | undefined): string {
  return DEPT_LABEL[(d ?? 'management') as CommsDept] ?? 'Staff';
}
/** Darken forest for legible text on light tints (matches the handoff). */
export function deptColorDark(c: string): string {
  return c === T.forest ? T.forestDeep : c === T.teal ? T.tealDeep : c;
}
export function tint(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ── Time helpers ────────────────────────────────────────────────────────────
/** "9:14a" style clock for message timestamps. */
export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h < 12 ? 'a' : 'p';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')}${ap}`;
}
/** Day divider label: Today / Yesterday / weekday / date. */
export function fmtDayLabel(iso: string, todayLabel: string, yesterdayLabel: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return todayLabel;
  if (days === 1) return yesterdayLabel;
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// ── Atoms ───────────────────────────────────────────────────────────────────
export function initialsOf(name: string): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({ name, dept, size = 32, ring = false, me = false }: {
  name: string; dept?: CommsDept | null; size?: number; ring?: boolean; me?: boolean;
}) {
  const col = deptColor(dept);
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: me ? T.bg : tint(col, 0.14),
      border: me ? `1.5px solid ${T.hairer}` : (ring ? `1.5px solid ${tint(col, 0.5)}` : 'none'),
      color: me ? T.ink : col,
      fontFamily: SANS, fontWeight: 600, fontSize: size * 0.4, letterSpacing: '.01em',
      lineHeight: 1, userSelect: 'none',
    }}>
      {initialsOf(name)}
    </div>
  );
}

export function DeptDot({ dept, size = 7 }: { dept?: CommsDept | null; size?: number }) {
  return <span style={{ width: size, height: size, borderRadius: '50%', background: deptColor(dept), flexShrink: 0, display: 'inline-block' }} />;
}

export function MonoLabel({ children, color = T.dim, style }: { children: React.ReactNode; color?: string; style?: React.CSSProperties }) {
  return <span style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '.13em', textTransform: 'uppercase', color, whiteSpace: 'nowrap', ...style }}>{children}</span>;
}

export function Presence({ on, size = 8 }: { on: boolean; size?: number }) {
  return <span style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, background: on ? T.forest : 'transparent', border: on ? 'none' : `1.5px solid ${T.dim}`, display: 'inline-block' }} />;
}

export function Unread({ n, color = T.terracotta }: { n: number; color?: string }) {
  if (!n) return null;
  return (
    <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, background: color, color: '#fff', fontFamily: SANS, fontWeight: 700, fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>{n}</span>
  );
}

// ── Motion (Web Animations API — plays under prefers-reduced-motion) ─────────
function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

/** Physical flip: rotate to edge, swap faces at mid via onMid(), rotate back. */
export function flipNode(el: HTMLElement | null, onMid?: () => void, dir: 'x' | 'y' = 'y') {
  if (!el) { onMid?.(); return; }
  const D = dir === 'x' ? 'X' : 'Y';
  const a = el.animate(
    [{ transform: `perspective(900px) rotate${D}(0deg)` }, { transform: `perspective(900px) rotate${D}(90deg)` }],
    { duration: 150, easing: 'cubic-bezier(.45,0,.9,.6)', fill: 'forwards' },
  );
  a.onfinish = () => {
    onMid?.();
    requestAnimationFrame(() => {
      el.animate(
        [{ transform: `perspective(900px) rotate${D}(-90deg)` }, { transform: `perspective(900px) rotate${D}(0deg)` }],
        { duration: 230, easing: 'cubic-bezier(.18,.9,.32,1.1)', fill: 'forwards' },
      );
    });
  };
}

export function useFlip(dir: 'x' | 'y' = 'y'): [React.RefObject<HTMLDivElement | null>, (cb?: () => void) => void] {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const flip = React.useCallback((cb?: () => void) => flipNode(ref.current, cb, dir), [dir]);
  return [ref, flip];
}

/** Staggered entrance (fade + rise). Guarded on tab visibility so a backwards
 * fill never pins content at opacity 0 while hidden. */
export function enterNode(el: HTMLElement | null, i = 0, opts: { dy?: number; dur?: number; stagger?: number } = {}) {
  if (!el || !visible()) return;
  const dur = opts.dur ?? 360, stagger = opts.stagger ?? 34, dy = opts.dy ?? 10;
  const a = el.animate(
    [{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: 'translateY(0)' }],
    { duration: dur, delay: i * stagger, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' },
  );
  const safety = setTimeout(() => { try { if (a.playState !== 'finished') a.cancel(); } catch { /* */ } }, dur + i * stagger + 800);
  a.onfinish = () => { clearTimeout(safety); try { a.cancel(); } catch { /* */ } };
}

/** Run the entrance on a container's direct children. */
export function useEnter(deps: React.DependencyList): React.RefObject<HTMLDivElement | null> {
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    Array.from(el.children).forEach((c, i) => enterNode(c as HTMLElement, i));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

/** Press/pop feedback on a button. */
export function popNode(el: HTMLElement | null) {
  if (!el) return;
  el.animate([{ transform: 'scale(1)' }, { transform: 'scale(.94)' }, { transform: 'scale(1)' }], { duration: 200, easing: 'ease-out' });
}

/** Slide a panel in from the right (thread / pinned / members). */
export function slideInNode(el: HTMLElement | null) {
  if (!el || !visible()) return;
  el.animate([{ transform: 'translateX(28px)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }],
    { duration: 240, easing: 'cubic-bezier(.2,.9,.3,1)', fill: 'backwards' });
}

// ── Inline markdown (the composer's B / i / S) ──────────────────────────────
/** Render **bold**, *italic*, ~~strike~~ as safe React nodes (no HTML injection). */
export function renderInline(text: string): React.ReactNode {
  if (!text) return text;
  const re = /(\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*)/g;
  const out: React.ReactNode[] = [];
  let last = 0; let key = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] != null) out.push(<strong key={key++}>{m[2]}</strong>);
    else if (m[3] != null) out.push(<del key={key++} style={{ opacity: 0.75 }}>{m[3]}</del>);
    else if (m[4] != null) out.push(<em key={key++}>{m[4]}</em>);
    last = m.index + m[0].length;
  }
  if (out.length === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ── Hover tooltip (plain-language explainer) ────────────────────────────────
export function Tip({ text, children, width = 240 }: { text: string; children: React.ReactNode; width?: number }) {
  const [show, setShow] = React.useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <span style={{ position: 'absolute', left: 0, top: '100%', marginTop: 7, zIndex: 60, width, background: T.ink, color: '#fff', fontFamily: SANS, fontSize: 11.5, fontWeight: 500, lineHeight: 1.5, padding: '9px 11px', borderRadius: 9, boxShadow: '0 10px 28px rgba(24,22,17,.24)', pointerEvents: 'none' }}>
          {text}
        </span>
      )}
    </span>
  );
}

// ── Shared button styles ────────────────────────────────────────────────────
export const paneIcon: React.CSSProperties = { width: 32, height: 32, borderRadius: 7, border: 'none', background: 'transparent', color: T.dim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 };
export const iconBtn: React.CSSProperties = { width: 30, height: 30, borderRadius: 8, border: 'none', background: 'transparent', color: T.dim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 };
