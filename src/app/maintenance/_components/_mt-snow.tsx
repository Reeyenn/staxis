// Maintenance-specific Snow primitives. Ports maintenance-shared.jsx +
// the modal / form pieces shared by the WorkOrders and Preventive tabs.
//
// Reuses the housekeeping `_snow.tsx` tokens (palette + fonts + Btn / Pill /
// Caps / Card) so the Maintenance tab stays visually locked to the rest of
// the app. The extras here are: priority dot/pill, person avatar, modal
// shell, form fields, chip chooser, photo placeholder, relative-time helper.

'use client';

import React, { useEffect, useRef } from 'react';
import { T, FONT_SANS, FONT_MONO, FONT_SERIF } from '@/app/housekeeping/_components/_snow';

export { T, FONT_SANS, FONT_MONO, FONT_SERIF };
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
export const prioOrder: Priority[] = ['urgent', 'normal', 'low'];

export function PrioDot({ p, size = 10, ring = false, style = {} }: {
  p: Priority; size?: number; ring?: boolean; style?: React.CSSProperties;
}) {
  const c = prioColor[p];
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, borderRadius: '50%',
      background: c, boxShadow: ring ? `0 0 0 3px ${c}22` : 'none',
      flexShrink: 0, ...style,
    }}/>
  );
}

export function PrioPill({ p, style = {} }: { p: Priority; style?: React.CSSProperties }) {
  const c = prioColor[p];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '3px 10px 3px 8px', borderRadius: 999, height: 22,
      background: `${c}14`, color: c, border: `1px solid ${c}33`,
      fontFamily: FONT_SANS, fontSize: 11, fontWeight: 600,
      whiteSpace: 'nowrap', ...style,
    }}>
      <PrioDot p={p} size={6}/>
      {prioLabel[p]}
    </span>
  );
}

// ── Avatar — initials in a tinted circle ──────────────────────────────────
export function Avatar({
  name, tone = T.ink2, size = 28, style = {},
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
      background: tone, color: '#fff',
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
    <div onClick={onClose} style={{
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

// ── Photo slot — file-picker masquerading as the design's striped tile ────
// Mirrors hk-shared.jsx PhotoSlot: tap to open a hidden <input type="file">.
// Caller stores the File and a preview URL; passes them back on submit.
export function PhotoSlot({
  file, onFileChange, label = 'Photo (optional)', height = 140,
}: {
  file: File | null;
  onFileChange: (f: File | null) => void;
  label?: string;
  height?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const attached = !!file;
  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (attached) onFileChange(null);
          else inputRef.current?.click();
        }}
        style={{
          width: '100%', height, borderRadius: 12, cursor: 'pointer',
          background: attached
            ? 'repeating-linear-gradient(135deg, rgba(104,131,114,0.10) 0 10px, rgba(104,131,114,0.04) 10px 20px)'
            : 'repeating-linear-gradient(135deg, rgba(31,35,28,0.04) 0 10px, transparent 10px 20px)',
          border: `1px dashed ${attached ? 'rgba(92,122,96,0.4)' : T.rule}`,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 6, fontFamily: FONT_MONO, fontSize: 11,
          color: attached ? T.sageDeep : T.ink3,
          letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 500,
        }}
      >
        <span style={{ fontSize: 20, color: attached ? T.sageDeep : T.ink2, letterSpacing: 0 }}>
          {attached ? '✓' : '+'}
        </span>
        {attached
          ? `Photo attached · ${file.name.length > 24 ? file.name.slice(0, 22) + '…' : file.name} · tap to remove`
          : label}
        {!attached && (
          <span style={{ fontFamily: FONT_SANS, fontSize: 11, color: T.ink3, textTransform: 'none', letterSpacing: 0 }}>
            Tap to take or upload
          </span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={e => {
          const f = e.target.files?.[0] ?? null;
          onFileChange(f);
          // Reset input so picking the same file twice still fires onChange.
          if (e.target) e.target.value = '';
        }}
      />
    </>
  );
}

// ── Date helpers ──────────────────────────────────────────────────────────
// Relative-time string from "days from today" (negative = overdue).
export function relTime(days: number): string {
  if (days === 0)  return 'today';
  if (days < 0)    return `${-days}d overdue`;
  if (days === 1)  return 'tomorrow';
  if (days <= 7)   return `in ${days}d`;
  if (days <= 60)  return `in ${Math.round(days / 7)}w`;
  return `in ${Math.round(days / 30)}mo`;
}

export function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateShort(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// "May 12 · 7:51 AM" / "May 11 · 1d ago" — used in the open-card byline.
export function fmtSubmittedAt(d: Date | null, now: Date = new Date()): string {
  if (!d) return '';
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) + ' · today';
  }
  const daysAgo = Math.floor((now.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
  if (daysAgo === 1) return `${fmtDateShort(d)} · 1d ago`;
  if (daysAgo < 7)   return `${fmtDateShort(d)} · ${daysAgo}d ago`;
  return fmtDate(d);
}

// Days between two dates ignoring time-of-day. Positive = b is later.
export function daysBetween(a: Date, b: Date): number {
  const aa = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const bb = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bb.getTime() - aa.getTime()) / (24 * 60 * 60 * 1000));
}

// ── Maintenance sub-tab bar — two tabs only ────────────────────────────────
export type MaintenanceTabKey = 'work' | 'preventive';

export function MTSubTabBar({
  tab, onTab,
}: {
  tab: MaintenanceTabKey;
  onTab: (t: MaintenanceTabKey) => void;
}) {
  const tabs: { key: MaintenanceTabKey; label: string }[] = [
    { key: 'work',       label: 'Work orders' },
    { key: 'preventive', label: 'Preventive'  },
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
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    (async () => {
      const { supabase } = await import('@/lib/supabase');
      const { data, error } = await supabase.storage
        .from('maintenance-photos')
        .createSignedUrl(path, 60 * 5);
      if (!alive) return;
      if (error || !data?.signedUrl) setUrl(null);
      else setUrl(data.signedUrl);
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
        Loading photo…
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
