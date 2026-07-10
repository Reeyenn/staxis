'use client';

// /demo/feed — public, login-free design preview of the Staxis decision
// feed, running entirely on in-memory sample data.
//
// No auth, no AppLayout, no Supabase: renders the exact _FeedExperience
// component the real /feed page uses, plus a time-of-day switcher so the
// morning / afternoon / evening skies can be previewed on demand.
// Refreshing resets everything; nothing ever persists.
// Covered by the '/demo/' prefix in src/middleware.ts PUBLIC_PREFIXES.

export const dynamic = 'force-dynamic';

import React, { useState } from 'react';
import { FeedExperience, type Phase } from '../../feed/_FeedExperience';

const PHASES: { key: Phase; label: string }[] = [
  { key: 'morning',   label: 'Morning' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'night',     label: 'Evening' },
];

export default function DemoFeedPage() {
  const [phase, setPhase] = useState<Phase | undefined>(undefined);

  return (
    <div style={{ minHeight: '100vh', background: '#FFFFFF', color: '#20251F' }}>
      {/* slim demo top bar (the real page lives under the app's own nav) */}
      <div style={{
        height: 52, borderBottom: '1px solid rgba(32,37,31,0.10)', background: '#FFFFFF',
        display: 'flex', alignItems: 'center', gap: 14, padding: '0 24px',
        position: 'relative', zIndex: 2, flexWrap: 'wrap',
      }}>
        <span style={{ fontFamily: 'var(--font-fraunces), Georgia, serif', fontSize: 19, fontStyle: 'italic' }}>Staxis</span>
        <span style={{
          fontFamily: 'var(--font-geist-mono), ui-monospace, monospace', fontSize: 9.5, fontWeight: 700,
          letterSpacing: '0.12em', textTransform: 'uppercase', color: '#8C6A33',
          background: 'rgba(201,150,68,0.14)', border: '1px solid rgba(140,106,51,0.25)',
          padding: '3px 9px', borderRadius: 999,
        }}>Design preview</span>
        <span className="stx-demo-note" style={{
          fontFamily: 'var(--font-geist-mono), ui-monospace, monospace', fontSize: 10.5,
          color: '#8A9187', letterSpacing: '0.04em',
        }}>
          Sample hotel data — tap everything, nothing saves.
        </span>

        {/* time-of-day preview switcher */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {PHASES.map(p => {
            const active = phase === p.key;
            return (
              <button key={p.key} onClick={() => setPhase(active ? undefined : p.key)}
                style={{
                  fontFamily: 'var(--font-geist), system-ui, sans-serif', fontSize: 12, fontWeight: 600,
                  color: active ? '#FFFFFF' : '#4A5249',
                  background: active ? '#20251F' : 'transparent',
                  border: '1px solid ' + (active ? '#20251F' : 'rgba(32,37,31,0.16)'),
                  borderRadius: 999, padding: '5px 12px', cursor: 'pointer',
                  transition: 'background .2s ease, color .2s ease, border-color .2s ease',
                }}>
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      <style>{`@media (max-width: 640px) { .stx-demo-note { display: none; } }`}</style>

      {/* `demo` forces the full sample content: this login-free preview has no
          PropertyContext, so without it the gate would fall back to a real
          hotel's honest quiet state. */}
      <FeedExperience phaseOverride={phase} demo />
    </div>
  );
}
