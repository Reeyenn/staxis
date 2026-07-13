'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Communications · Snow design-system layer — the SECOND design system inside
// this tab (deliberate: the Knowledge / Calendar / Contacts content moved in
// from the Snow-styled Knowledge hub and keeps its exact look; the chat shell
// stays on the comms brand tokens in comms-ui.tsx — do not unify).
//
// This is the previously-triplicated style block from KnowledgePane /
// CalendarPane / ContactsPane, hoisted verbatim, plus the shared Loading /
// Empty atoms.
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import { Loader2 } from 'lucide-react';
import type { L } from './comms-types-fe';

export const SANS = 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif';

export const card: React.CSSProperties = { border: '1px solid var(--snow-rule)', borderRadius: 12, background: 'var(--snow-bg)' };
export const primaryBtn: React.CSSProperties = { background: 'var(--snow-sage-deep)', color: '#fff', border: 'none', borderRadius: 9, padding: '8px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: SANS, display: 'inline-flex', alignItems: 'center', gap: 6 };
export const ghostBtn: React.CSSProperties = { background: 'transparent', color: 'var(--snow-ink2)', border: '1px solid var(--snow-rule)', borderRadius: 9, padding: '7px 12px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, fontFamily: SANS, display: 'inline-flex', alignItems: 'center', gap: 5 };
export const iconBtn: React.CSSProperties = { background: 'transparent', border: 'none', cursor: 'pointer', padding: 6, borderRadius: 7, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--snow-ink2)' };
export const inputStyle: React.CSSProperties = { width: '100%', border: '1px solid var(--snow-rule)', borderRadius: 9, padding: '9px 11px', fontFamily: SANS, fontSize: 14, outline: 'none', background: 'var(--snow-bg)', color: 'var(--snow-ink)', boxSizing: 'border-box' };
export const labelStyle: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--snow-ink3)', marginBottom: 4, display: 'block' };

export function Loading({ L }: { L: L }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--snow-ink3)', fontSize: 13, padding: 20 }}><Loader2 size={15} className="spin" /> {L('Loading…', 'Cargando…')}</div>;
}
export function Empty({ text }: { text: string }) {
  return <div style={{ color: 'var(--snow-ink3)', fontSize: 13.5, padding: '28px 8px', textAlign: 'center' }}>{text}</div>;
}
