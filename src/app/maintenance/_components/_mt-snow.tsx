// Maintenance-specific Snow primitives. Ports maintenance-shared.jsx +
// the modal / form pieces shared by the WorkOrders and Preventive tabs.
//
// Reuses the housekeeping `_snow.tsx` tokens (palette + fonts + Btn / Pill /
// Caps) so the Maintenance tab stays visually locked to the rest of
// the app. The extras here are: priority colors/labels, person avatar, modal
// shell, form fields, chip chooser, date helpers.
//
// Why Modal below is NOT the shared F6 primitive (@/app/_components/ui/Modal):
// this shell is top-aligned (alignItems flex-start, 48px scrim padding), lets
// tall modals grow past the viewport with the SCRIM scrolling (no card
// max-height / inner scroll), and closes on scrim *click* (mouseup) rather
// than mousedown (guarded: the interaction must both start AND end on the
// scrim, so a text-selection drag out of the card can't close it) — none of
// which F6's fixed 'center' geometry can reproduce today. It is also imported by financials + front-desk + the parked
// ComplianceTab, so its behavior must not move. If F6 ever grows scrim
// align/padding + card max-height overrides, this shell can become a themed
// wrapper. (Wave-1 precedent: keep the hand-roll when the foundation can't
// hit byte-identical.)

'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useLang } from '@/contexts/LanguageContext';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF, Caps, Pill, Btn,
} from '@/app/housekeeping/_components/_snow';
import { EmptyState } from '@/app/_components/ui/EmptyState';

// Re-export the shared Snow primitives so the maintenance tabs have a single
// import source (tokens + Caps/Pill/Btn live in housekeeping/_snow).
export { T, FONT_SANS, FONT_MONO, FONT_SERIF, Caps, Pill, Btn };
// Pure date/cadence helpers live in mt-dates.ts (plain .ts, unit-testable);
// re-exported here so the tabs keep a single import source.
export {
  fmtDate, fmtDateShort, fmtSubmittedAt, fmtSubmittedAtCompact,
  daysBetween, addDaysLocal, relDue, displayLoc, cadenceLabel,
} from './mt-dates';
export type Priority = 'urgent' | 'normal' | 'low';

// ── Priority colors ────────────────────────────────────────────────────────
export const prioColor: Record<Priority, string> = {
  urgent: '#B85C3D',
  normal: '#C99644',
  low:    '#5C7A60',
};
export const prioLabel: Record<Priority, string> = {
  urgent: 'Urgent',
  normal: 'Normal',
  low:    'Low',
};

// ── Avatar — initials in a tinted circle ──────────────────────────────────
// Deterministic color from a name: the same person always lands on the same
// tone (mirrors staffTone in housekeeping/_snow). Callers can still override
// with an explicit `tone`.
const AVATAR_TONES = ['#B8775E', '#688372', '#7B6A97', '#8C6A33', '#5E7A8C', '#6A8C70'];
export function toneFor(name: string): string {
  let h = 0;
  for (const ch of (name || '')) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_TONES[Math.abs(h) % AVATAR_TONES.length];
}

export function Avatar({
  name, tone, size = 28, style = {},
}: {
  name: string; tone?: string; size?: number; style?: React.CSSProperties;
}) {
  const initials = (() => {
    const parts = (name || '').trim().split(/\s+/);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  })();
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%',
      background: tone ?? toneFor(name), color: '#fff',
      fontFamily: FONT_SANS, fontSize: Math.round(size * 0.36), fontWeight: 600,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, ...style,
    }}>{initials}</span>
  );
}

// ── Modal shell ────────────────────────────────────────────────────────────
export function Modal({
  open, onClose, title, subtitle, children, footer, width = 580,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // True only while the current pointer interaction STARTED on the scrim.
  // A text-selection drag that starts inside the card and releases over the
  // scrim fires a browser-synthesized click on the scrim (the common
  // ancestor of mousedown/mouseup targets) — without this guard that click
  // closed the modal and ate the half-typed form.
  const downOnScrim = useRef(false);
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      onMouseDown={(e) => { downOnScrim.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        const wasDownOnScrim = downOnScrim.current;
        downOnScrim.current = false;
        if (e.target === e.currentTarget && wasDownOnScrim) onClose();
      }}
      style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(31,35,28,0.32)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '48px 24px', overflow: 'auto',
    }}>
      <div ref={ref} onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: width, background: T.paper, borderRadius: 20,
        border: `1px solid ${T.rule}`,
        boxShadow: '0 24px 60px rgba(31,35,28,0.18)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '22px 26px 18px', borderBottom: `1px solid ${T.rule}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18,
        }}>
          <div style={{ minWidth: 0 }}>
            {title && (
              <h2 style={{ fontFamily: FONT_SERIF, fontSize: 26, color: T.ink, margin: 0, letterSpacing: '-0.02em', fontWeight: 400, lineHeight: 1.2 }}>
                {title}
              </h2>
            )}
            {subtitle && (
              <p style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, margin: '4px 0 0' }}>
                {subtitle}
              </p>
            )}
          </div>
          <button onClick={onClose} aria-label="Close" style={{
            width: 32, height: 32, borderRadius: '50%', cursor: 'pointer',
            background: 'transparent', border: `1px solid ${T.rule}`,
            color: T.ink2, fontSize: 14, lineHeight: 1, flexShrink: 0,
          }}>✕</button>
        </div>
        <div style={{ padding: '22px 26px', flex: 1, minHeight: 0 }}>{children}</div>
        {footer && (
          <div style={{
            padding: '18px 26px', borderTop: `1px solid ${T.rule}`,
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
            flexWrap: 'wrap', background: T.bg, borderBottomLeftRadius: 20, borderBottomRightRadius: 20,
          }}>{footer}</div>
        )}
      </div>
    </div>
  );
}

// ── Form primitives ───────────────────────────────────────────────────────
export function Field({
  label, hint, required, children, style = {},
}: {
  label: string; hint?: string; required?: boolean;
  children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...style }}>
      <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink2, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 500 }}>
          {label}{required && <span style={{ color: T.warm, marginLeft: 4 }}>*</span>}
        </span>
        {hint && <span style={{ fontFamily: FONT_SANS, fontSize: 11, color: T.ink3, fontStyle: 'italic' }}>{hint}</span>}
      </span>
      {children}
    </div>
  );
}

export function TextInput({
  value, onChange, placeholder, type = 'text', ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        height: 40, padding: '0 14px', borderRadius: 10,
        background: T.bg, border: `1px solid ${T.rule}`,
        fontFamily: FONT_SANS, fontSize: 14, color: T.ink, width: '100%',
        boxSizing: 'border-box', outline: 'none',
      }}
      {...rest}
    />
  );
}

export function TextArea({
  value, onChange, placeholder, rows = 3,
}: {
  value: string; onChange: (v: string) => void;
  placeholder?: string; rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      style={{
        padding: '10px 14px', borderRadius: 10,
        background: T.bg, border: `1px solid ${T.rule}`,
        fontFamily: FONT_SANS, fontSize: 14, color: T.ink, width: '100%',
        boxSizing: 'border-box', outline: 'none', resize: 'vertical',
        lineHeight: 1.5,
      }}
    />
  );
}

// Segmented chooser for fixed-option fields (priority chips).
export function ChipChoose<V extends string>({
  options, value, onChange, render,
}: {
  options: { value: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
  render?: (opt: { value: V; label: string }, active: boolean) => React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {options.map(opt => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              padding: '8px 14px', borderRadius: 10, cursor: 'pointer',
              background: active ? T.ink : 'transparent',
              color: active ? T.bg : T.ink,
              border: `1px solid ${active ? T.ink : T.rule}`,
              fontFamily: FONT_SANS, fontSize: 13, fontWeight: 500,
              display: 'inline-flex', alignItems: 'center', gap: 8,
              whiteSpace: 'nowrap',
            }}
          >
            {render ? render(opt, active) : opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Board primitives (shared by the three maintenance tabs) ────────────────

// Page header: mono eyebrow + serif headline (italic lead · faint rest) +
// right-aligned actions. Mirrors the prototype's PageHead.
export function PageHead({
  eyebrow, lead, rest, actions,
}: {
  eyebrow: string; lead: string; rest?: string; actions?: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
      marginBottom: 20, gap: 24, flexWrap: 'wrap',
    }}>
      <div>
        <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink2, letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 500 }}>
          {eyebrow}
        </span>
        <h1 style={{ fontFamily: FONT_SERIF, fontSize: 36, color: T.ink, margin: '4px 0 0', letterSpacing: '-0.03em', lineHeight: 1.25, fontWeight: 400 }}>
          <span style={{ fontStyle: 'italic' }}>{lead}</span>
          {rest && <span style={{ color: T.ink3 }}> · {rest}</span>}
        </h1>
      </div>
      {actions && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}

// Board column: lane dot + mono CAPS label in the lane color + right-aligned
// serif-italic count, over a 2px lane-color underline. Empty lanes show a
// faint serif-italic note.
export function BoardColumn({
  color, label, count, empty, children,
}: {
  color: string; label: string; count: number;
  empty?: string; children: React.ReactNode;
}) {
  const hasItems = React.Children.count(children) > 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 2px 11px', borderBottom: `2px solid ${color}`, marginBottom: 12 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontFamily: FONT_MONO, fontSize: 11, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color }}>
          {label}
        </span>
        <span style={{ marginLeft: 'auto', fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 22, color, lineHeight: 1 }}>{count}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {hasItems
          ? children
          : <span style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 16, color: T.ink3, padding: '6px 2px' }}>{empty || 'Nothing here.'}</span>}
      </div>
    </div>
  );
}

// Board card: white, hairline border, 14px radius, 4px left accent bar. Hover
// darkens the border and lifts 1px. Clickable when onClick is provided.
export function BoardCard({
  accent, onClick, children, dataId,
}: {
  accent: string;
  onClick?: () => void;
  children: React.ReactNode;
  /** Stamped as data-wo-id — used by the Work Orders FLIP animation. */
  dataId?: string;
}) {
  return (
    <div
      onClick={onClick}
      data-wo-id={dataId}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      onMouseEnter={onClick ? (e) => { e.currentTarget.style.borderColor = 'rgba(31,35,28,0.18)'; e.currentTarget.style.transform = 'translateY(-1px)'; } : undefined}
      onMouseLeave={onClick ? (e) => { e.currentTarget.style.borderColor = T.rule; e.currentTarget.style.transform = 'translateY(0)'; } : undefined}
      style={{
        textAlign: 'left', cursor: onClick ? 'pointer' : 'default',
        background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14,
        padding: '14px 16px 13px 19px', display: 'flex', flexDirection: 'column', gap: 9,
        width: '100%', position: 'relative', overflow: 'hidden',
        transition: 'border-color 0.14s, transform 0.14s',
      }}
    >
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: accent }} />
      {children}
    </div>
  );
}

// Centered board: lays out non-empty bands in a row that centers whatever
// remains (each column 280–392px). Used by Preventive + Equipment.
export function CenteredBoard({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 22, alignItems: 'flex-start', justifyContent: 'center', flexWrap: 'wrap' }}>
      {React.Children.map(children, (c) => (
        // Grow each band to fill wide screens (up to 520px) while staying
        // centered when there are only one or two bands.
        <div style={{ flex: '1 1 0', minWidth: 280, maxWidth: 520 }}>{c}</div>
      ))}
    </div>
  );
}

// Empty-board card (shared by the three boards + the asset registry): paper
// card, serif-italic headline, sans body line, action button(s) under it.
// Thin exact-theme wrapper over the shared EmptyState primitive.
export function MtEmptyCard({
  title, body, action, titleSize = 26, bodySize = 14,
}: {
  title: React.ReactNode;
  body: React.ReactNode;
  action?: React.ReactNode;
  titleSize?: number;
  bodySize?: number;
}) {
  return (
    <EmptyState
      style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18 }}
      padding="48px 24px"
      title={<span style={{ fontFamily: FONT_SERIF, fontSize: titleSize, color: T.ink, fontStyle: 'italic', fontWeight: 400 }}>{title}</span>}
      body={<>
        <p style={{ fontFamily: FONT_SANS, fontSize: bodySize, color: T.ink2, margin: '8px 0 18px' }}>{body}</p>
        {action}
      </>}
    />
  );
}

// ── Board load gate ────────────────────────────────────────────────────────
// subscribeTable's initial fetch failure is only logged — the callback never
// fires — so a board that got NO data was indistinguishable from a board that
// loaded an EMPTY list, and the tabs rendered their happy "all caught up"
// empty state during a network blip (the silent-empty-state bug class, here
// for signed-in users). This hook runs a 1-row probe against the same table
// so the tab can tell "loaded empty" apart from "failed to load", plus a
// stall timer so a probe-passed-but-subscription-failed race still surfaces
// as an error instead of an infinite spinner. `loaded` = the subscription
// callback has fired at least once (data always wins).
export type BoardLoadStatus = 'loading' | 'error' | 'ready';

export function useBoardGate(
  pid: string | null | undefined,
  table: string,
  loaded: boolean,
): { status: BoardLoadStatus; retryKey: number; retry: () => void } {
  const [probe, setProbe] = useState<'pending' | 'ok' | 'error'>('pending');
  const [stalled, setStalled] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!pid || loaded) return;
    let alive = true;
    setProbe('pending');
    setStalled(false);
    void (async () => {
      try {
        const { supabase } = await import('@/lib/supabase');
        const { error } = await supabase.from(table).select('id').eq('property_id', pid).limit(1);
        if (alive) setProbe(error ? 'error' : 'ok');
      } catch {
        if (alive) setProbe('error');
      }
    })();
    return () => { alive = false; };
  }, [pid, table, retryKey, loaded]);

  // Probe passed but the subscription's own initial fetch never delivered —
  // don't spin forever, offer the retry instead.
  useEffect(() => {
    if (loaded || probe !== 'ok') { setStalled(false); return; }
    const t = window.setTimeout(() => setStalled(true), 15000);
    return () => window.clearTimeout(t);
  }, [probe, loaded, retryKey]);

  const status: BoardLoadStatus = loaded ? 'ready' : (probe === 'error' || stalled) ? 'error' : 'loading';
  return { status, retryKey, retry: () => setRetryKey((k) => k + 1) };
}

// Neutral first-load placeholder (matches the registry's "Loading…" line).
export function BoardLoading({ es }: { es: boolean }) {
  return (
    <div style={{ padding: '48px 0', textAlign: 'center', fontFamily: FONT_SANS, fontSize: 13, color: T.ink2 }}>
      {es ? 'Cargando…' : 'Loading…'}
    </div>
  );
}

// Load-error card with a retry (same recover idiom as MaintenanceErrorBoundary).
export function BoardLoadError({ es, onRetry }: { es: boolean; onRetry: () => void }) {
  return (
    <MtEmptyCard
      title={es ? 'No se pudo cargar.' : "Couldn't load this."}
      body={es ? 'Tus datos están a salvo — revisa la conexión e inténtalo de nuevo.' : 'Your data is safe — check your connection and try again.'}
      action={<Btn variant="primary" onClick={onRetry}>↻ {es ? 'Reintentar' : 'Retry'}</Btn>}
    />
  );
}

// Error boundary: catches a render error in the maintenance subtree and shows
// a recover card instead of a blank screen (the white-screen-on-tab bug class).
export class MaintenanceErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { err: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div style={{ minHeight: '60dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: T.bg, fontFamily: FONT_SANS, padding: 24 }}>
          <div style={{ maxWidth: 420, textAlign: 'center', border: `1px solid ${T.rule}`, borderRadius: 18, padding: '32px 28px' }}>
            <div style={{ fontFamily: FONT_SERIF, fontSize: 28, color: T.ink, fontStyle: 'italic' }}>Something hiccuped.</div>
            <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink2, lineHeight: 1.5, margin: '10px 0 18px' }}>
              The page hit a snag — your data is safe. Reload to pick back up.
            </p>
            <Btn variant="primary" onClick={() => location.reload()}>↻ Reload</Btn>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Maintenance sub-tab bar ────────────────────────────────────────────────
export type MaintenanceTabKey = 'work' | 'preventive' | 'equipment';

export function MTSubTabBar({
  tab, onTab,
}: {
  tab: MaintenanceTabKey;
  onTab: (t: MaintenanceTabKey) => void;
}) {
  const { lang } = useLang();
  const es = lang === 'es';
  const tabs: { key: MaintenanceTabKey; label: string }[] = [
    { key: 'work',       label: es ? 'Órdenes de trabajo' : 'Work orders' },
    { key: 'preventive', label: es ? 'Preventivo'         : 'Preventive'  },
    { key: 'equipment',  label: es ? 'Equipo'             : 'Equipment'   },
  ];
  return (
    <div style={{
      padding: '18px 48px 0',
      background: T.bg,
      borderBottom: `1px solid ${T.rule}`,
      position: 'sticky', top: 64, zIndex: 10,
    }}>
      <nav style={{ display: 'flex', gap: 28 }}>
        {tabs.map(t => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => onTab(t.key)}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                padding: '8px 0 14px', position: 'relative',
                fontFamily: FONT_SANS, fontSize: 14,
                fontWeight: active ? 600 : 500,
                color: active ? T.ink : T.ink2,
                borderBottom: active ? `1.5px solid ${T.ink}` : '1.5px solid transparent',
                marginBottom: -1,
                whiteSpace: 'nowrap',
              }}
            >{t.label}</button>
          );
        })}
      </nav>
    </div>
  );
}

// ── Image preview from Storage path. Used in the Detail modals. ──────────
// Lazy import of supabase to keep this primitives file out of the data
// layer's dependency graph.
export function StorageImage({
  path, alt = 'photo', height = 180,
}: {
  path: string;
  alt?: string;
  height?: number;
}) {
  const { lang } = useLang();
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { supabase } = await import('@/lib/supabase');
        const { data, error } = await supabase.storage
          .from('maintenance-photos')
          .createSignedUrl(path, 60 * 5);
        if (!alive) return;
        if (error || !data?.signedUrl) setUrl(null);
        else setUrl(data.signedUrl);
      } catch {
        // Thumbnail render is best-effort — dynamic import or auth failure
        // just hides the image.
        if (alive) setUrl(null);
      }
    })();
    return () => { alive = false; };
  }, [path]);

  if (!url) {
    return (
      <div style={{
        height, borderRadius: 12,
        background: `repeating-linear-gradient(135deg, ${T.rule} 0 10px, transparent 10px 20px), ${T.bg}`,
        border: `1px solid ${T.rule}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: FONT_MONO, fontSize: 11, color: T.ink3,
        letterSpacing: '0.08em', textTransform: 'uppercase',
      }}>
        {lang === 'es' ? 'Cargando foto…' : 'Loading photo…'}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      style={{
        height, width: '100%', objectFit: 'cover',
        borderRadius: 12, border: `1px solid ${T.rule}`, display: 'block',
      }}
    />
  );
}
