// People primitives — Avatar, DeptChip, tags, hours bar, status dot.
// Pulled from the design's staff-shared.jsx. Pure presentation; no data
// fetching here.

import React from 'react';
import { T, fonts, deptMeta, asDeptKey, Caps } from './_tokens';
import type { StaffMember } from '@/types';

// ── Avatar tones ───────────────────────────────────────────────────────────
// Each staff member gets a stable accent color derived from their id. We
// avoid storing this on the row (current schema doesn't have a column for
// it); deterministic hashing keeps the UI consistent across reloads.
const AVATAR_TONES = [
  '#B85C3D', '#5C7A60', '#5C625C', '#8C6A33', '#8A9187',
  '#3E5C48', '#356B4C', '#1F231C', '#C99644', '#B85C3D', '#5C7A60',
] as const;

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function staffTone(staffId: string): string {
  return AVATAR_TONES[hashStr(staffId) % AVATAR_TONES.length];
}

export function staffInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ── Avatar — circular initials puck with optional ring ─────────────────────
export function Avatar({
  staffId, name, size = 32, ring, style = {},
}: {
  staffId: string;
  name: string;
  size?: number;
  ring?: string | null;
  style?: React.CSSProperties;
}) {
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%',
      background: staffTone(staffId), color: '#fff',
      fontFamily: fonts.sans, fontSize: Math.round(size * 0.36), fontWeight: 600,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, letterSpacing: '-0.01em',
      boxShadow: ring
        ? `0 0 0 2px ${T.paper}, 0 0 0 ${size > 36 ? 3.5 : 3}px ${ring}`
        : 'none',
      ...style,
    }}>{staffInitials(name)}</span>
  );
}

// ── DeptChip — small tinted pill with dot + label ──────────────────────────
export function DeptChip({
  dept, size = 'sm',
}: {
  dept?: string | null;
  size?: 'sm' | 'lg';
}) {
  const m = deptMeta[asDeptKey(dept)];
  const f = size === 'lg' ? 12 : 10.5;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: size === 'lg' ? '3px 9px' : '2px 7px',
      borderRadius: 999,
      background: m.dim, color: m.tone,
      border: `1px solid ${m.tone}33`,
      fontFamily: fonts.sans, fontSize: f, fontWeight: 600,
      letterSpacing: '0.01em', whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: m.tone }}/>
      {m.label}
    </span>
  );
}

// ── Senior tag — caramel "SR" pill ────────────────────────────────────────
export function SeniorTag({ size = 10 }: { size?: number }) {
  return (
    <span style={{
      fontFamily: fonts.mono, fontSize: size, fontWeight: 600,
      color: '#8C6A33', background: 'rgba(201,150,68,0.14)',
      border: '1px solid rgba(140,106,51,0.25)',
      padding: '1px 6px', borderRadius: 999, letterSpacing: '0.06em',
    }}>SR</span>
  );
}

// ── HoursBar — slim utilization meter ─────────────────────────────────────
export function HoursBar({
  hrs, max, height = 4, width = 72,
}: {
  hrs: number;
  max: number;
  height?: number;
  width?: number;
}) {
  const pct = Math.min(1, max > 0 ? hrs / max : 0);
  const near = max > 0 && hrs >= max - 4;
  const color = near ? '#B85C3D' : '#5C7A60';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{
        width, height, borderRadius: height, background: T.rule,
        overflow: 'hidden', display: 'inline-block', flexShrink: 0,
      }}>
        <span style={{
          display: 'block', height: '100%',
          width: `${pct * 100}%`, background: color, borderRadius: height,
        }}/>
      </span>
      <span style={{
        fontFamily: fonts.mono, fontSize: 11, fontWeight: 600,
        color: near ? '#B85C3D' : T.ink2, whiteSpace: 'nowrap',
      }}>{hrs}<span style={{ color: T.ink3 }}>/{max}h</span></span>
    </span>
  );
}

// ── PageHeader — page title + meta row (manager pages) ────────────────────
export function PageHeader({
  title, eyebrow, sub, right,
}: {
  title: string;
  eyebrow?: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
      marginBottom: 22, gap: 24,
    }}>
      <div>
        {eyebrow && <Caps>{eyebrow}</Caps>}
        <h1 style={{
          fontFamily: fonts.sans, fontSize: 26, color: T.ink,
          margin: '4px 0 0', letterSpacing: '-0.02em', lineHeight: 1.1, fontWeight: 600,
        }}>
          <span>{title}</span>
        </h1>
        {sub && (
          <div style={{
            fontFamily: fonts.sans, fontSize: 13, color: T.ink2,
            marginTop: 6, maxWidth: 560, lineHeight: 1.5,
          }}>{sub}</div>
        )}
      </div>
      {right && <div style={{ textAlign: 'right' }}>{right}</div>}
    </div>
  );
}

// Re-export StaffMember-aware avatar to reduce repetition at call sites.
export function StaffAvatar({
  staff, size = 32, ring, style,
}: {
  staff: Pick<StaffMember, 'id' | 'name'>;
  size?: number;
  ring?: string | null;
  style?: React.CSSProperties;
}) {
  return <Avatar staffId={staff.id} name={staff.name} size={size} ring={ring} style={style}/>;
}
