// ComingSoonModal — friendly empty-state for the staff-side actions that
// aren't wired up yet (time-off requests, open-shift pickup, swap offers)
// and the manager-side "Publish week" / "Copy last week" buttons.
//
// The design ships these as live affordances, but the underlying tables and
// workflows are out of scope for this pass (Path A — visual first). Rather
// than hide the buttons, we surface them and tell the user what to do
// instead. This sets expectations and lets us measure interest before
// building the backend.

import React from 'react';
import { T, fonts, Btn } from './_tokens';

export type ComingSoonKind =
  | 'request-time-off'
  | 'pickup-shift'
  | 'swap-shift'
  | 'publish-week'
  | 'copy-last-week'
  | 'cell-edit';

const COPY: Record<ComingSoonKind, { title: string; body: string }> = {
  'request-time-off': {
    title: 'Time-off requests are coming soon',
    body:  "We're building this. For now, text your manager directly.",
  },
  'pickup-shift': {
    title: 'Open-shift pickup is coming soon',
    body:  "We're building this. For now, your manager will SMS you when shifts open up.",
  },
  'swap-shift': {
    title: 'Shift swaps are coming soon',
    body:  "We're building this. For now, ask your manager to swap on your behalf.",
  },
  'publish-week': {
    title: 'Week publishing is coming soon',
    body:  'For now, send tomorrow’s texts from Housekeeping → Schedule.',
  },
  'copy-last-week': {
    title: 'Copy-last-week is coming soon',
    body:  'For now, send tomorrow’s texts from Housekeeping → Schedule.',
  },
  'cell-edit': {
    title: 'Cell editing is coming soon',
    body:  'For now, edit tomorrow’s crew from Housekeeping → Schedule. The week grid is read-only.',
  },
};

export function ComingSoonModal({
  kind, onClose,
}: {
  kind: ComingSoonKind | null;
  onClose: () => void;
}) {
  if (!kind) return null;
  const { title, body } = COPY[kind];
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(31,35,28,0.42)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: T.paper, borderRadius: 22,
          padding: '28px 30px 24px',
          maxWidth: 420, width: '100%',
          boxShadow: '0 24px 60px -8px rgba(31,35,28,0.20), 0 0 0 1px rgba(31,35,28,0.04)',
        }}
      >
        <h2 style={{
          margin: 0,
          fontFamily: fonts.serif, fontSize: 26, fontStyle: 'italic',
          color: T.ink, letterSpacing: '-0.02em', lineHeight: 1.15, fontWeight: 400,
        }}>{title}</h2>
        <p style={{
          margin: '14px 0 22px',
          fontFamily: fonts.sans, fontSize: 14, color: T.ink2, lineHeight: 1.55,
        }}>{body}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Btn variant="primary" size="md" onClick={onClose}>Got it</Btn>
        </div>
      </div>
    </div>
  );
}
