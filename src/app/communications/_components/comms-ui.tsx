'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Communications · Slack-Classic redesign — shared design layer.
// Brand tokens, department colours, atoms (Avatar / DeptDot / Presence / …) and
// the Web-Animations-API motion helpers (pop / slide). Mirrors
// the Claude-Design handoff; fonts come in via CSS vars set on the comms root.
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import type { CommsDept } from '@/lib/comms/types';

// ── Brand tokens ────────────────────────────────────────────────────────────
export const T = {
  bg: '#FFFFFF',
  paper: '#FBFAF7',
  ink: '#1F231C',
  dim: '#8A9187',
  hair: 'rgba(31,35,28,.11)',
  hairSoft: 'rgba(31,35,28,.05)',
  hairer: 'rgba(31,35,28,.20)',
  forest: '#5C7A60',
  forestDeep: '#356B4C',
  forestTint: 'rgba(158,183,166,.16)',
  forestTint2: 'rgba(158,183,166,.25)',
  terracotta: '#B85C3D',
  gold: '#C99644',
  teal: '#4B8C9E',
  tealDeep: '#366F82',
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

// ── Motion (Web Animations API — plays under prefers-reduced-motion) ─────────
function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
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
        <span style={{ position: 'absolute', left: 0, top: '100%', marginTop: 7, zIndex: 60, width, background: T.ink, color: '#fff', fontFamily: SANS, fontSize: 11.5, fontWeight: 500, lineHeight: 1.5, padding: '9px 11px', borderRadius: 9, boxShadow: '0 10px 28px rgba(31,35,28,.24)', pointerEvents: 'none' }}>
          {text}
        </span>
      )}
    </span>
  );
}

// ── Shared button styles ────────────────────────────────────────────────────
export const paneIcon: React.CSSProperties = { width: 32, height: 32, borderRadius: 7, border: 'none', background: 'transparent', color: T.dim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 };

// ── Overlay scaffold ─────────────────────────────────────────────────────────
// The five comms popups share this exact skeleton: fixed inset scrim that
// closes on click, centered (or top-aligned) card that stops propagation, no
// entrance/exit animation, no body-scroll lock, Escape only where a modal had
// it. Deliberately NOT the shared Modal (F6): its center variant hard-codes
// scrim alignment/padding ('32px 24px', alignItems center), closes on
// mousedown instead of click, and its card has no knobs for the comms cards'
// flex-column / overflow-hidden / %-of-scrim heights — none of which survive
// byte-identical there.
export function CommsOverlay({ onClose, scrim, zIndex = 70, align = 'center', paddingTop, padding, escToClose = false, cardStyle, children }: {
  onClose: () => void; scrim: string; zIndex?: number; align?: 'center' | 'top'; paddingTop?: number; padding?: number;
  escToClose?: boolean; cardStyle: React.CSSProperties; children: React.ReactNode;
}) {
  React.useEffect(() => {
    if (!escToClose) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [escToClose, onClose]);
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: scrim, zIndex, display: 'flex',
      alignItems: align === 'top' ? 'flex-start' : 'center', justifyContent: 'center',
      ...(paddingTop !== undefined ? { paddingTop } : {}), ...(padding !== undefined ? { padding } : {}),
    }}>
      <div onClick={(e) => e.stopPropagation()} style={cardStyle}>{children}</div>
    </div>
  );
}
