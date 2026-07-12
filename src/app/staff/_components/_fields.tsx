// Shared form scaffolding for the staff pages.
//
// The staff pages repeat the same two text-input treatments and a labelled
// Field wrapper across the Directory, Recognition, My Shifts and the schedule
// modals. These are the byte-identical extractions of those repeats — nothing
// here changes a pixel; it just gives the pages one import instead of five
// copy-pasted style objects.

import React from 'react';
import { T, fonts } from './_tokens';

/** Directory / Recognition / My Shifts inputs (radius 12, roomy padding). */
export const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '10px 14px', borderRadius: 12, border: `1px solid ${T.rule}`,
  background: T.paper, fontFamily: fonts.sans, fontSize: 13, color: T.ink,
  outline: 'none',
};

/** Schedule-modal inputs (tighter — radius 10, 9×12 padding). */
export const modalInputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '9px 12px', borderRadius: 10, border: `1px solid ${T.rule}`,
  background: T.paper, fontFamily: fonts.sans, fontSize: 13, color: T.ink,
  outline: 'none',
};

/** Uppercase mono field label + optional hint line (Directory form). */
export function Field({
  label, hint, children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label style={{
        display: 'block', fontFamily: fonts.mono, fontSize: 10, fontWeight: 600,
        color: T.ink2, letterSpacing: '0.06em', textTransform: 'uppercase',
        marginBottom: 6,
      }}>{label}</label>
      {children}
      {hint && (
        <p style={{
          margin: '6px 0 0', fontFamily: fonts.sans, fontSize: 11.5,
          color: T.ink3, lineHeight: 1.4,
        }}>{hint}</p>
      )}
    </div>
  );
}
