// /demo/schedule — public, login-free interactive preview of the new
// Staff → Schedule design, running entirely on in-memory sample data.
//
// No auth, no AppLayout, no Supabase: useDemoScheduleData implements the
// same ScheduleData interface the real tab uses, so this is the genuine
// component tree (day board, week roster, Fill, undo, time-off) with a
// sample roster. Refreshing resets everything; nothing ever persists.
// Listed in src/middleware.ts PUBLIC_PREFIXES.

'use client';

export const dynamic = 'force-dynamic';

import React, { useEffect, useRef, useState } from 'react';
import { ScheduleView } from '../../staff/_components/schedule';
import { useDemoScheduleData, DEMO_STAFF } from '../../staff/_components/schedule/useDemoScheduleData';
import { T, fonts } from '../../staff/_components/_tokens';

export default function DemoSchedulePage() {
  const data = useDemoScheduleData();
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashNote = (msg: string) => {
    if (noteTimer.current) clearTimeout(noteTimer.current);
    setNote(msg);
    noteTimer.current = setTimeout(() => setNote(null), 4200);
  };
  useEffect(() => () => { if (noteTimer.current) clearTimeout(noteTimer.current); }, []);

  return (
    <div style={{ minHeight: '100vh', background: T.bg, color: T.ink, fontFamily: fonts.sans }}>
      {/* slim demo top bar (the real page lives under the app's own nav) */}
      <div style={{
        height: 52, borderBottom: `1px solid ${T.rule}`, background: T.paper,
        display: 'flex', alignItems: 'center', gap: 14, padding: '0 24px',
      }}>
        <span style={{ fontFamily: fonts.serif, fontSize: 19, fontStyle: 'italic' }}>Staxis</span>
        <span style={{
          fontFamily: fonts.mono, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: T.caramelDeep,
          background: 'rgba(201,150,68,0.14)', border: '1px solid rgba(140,106,51,0.25)',
          padding: '3px 9px', borderRadius: 999,
        }}>Design preview</span>
        <span style={{ fontFamily: fonts.mono, fontSize: 10.5, color: T.ink3, letterSpacing: '0.04em' }}>
          Sample hotel data — play with everything, nothing saves.
        </span>
      </div>

      <ScheduleView
        staff={DEMO_STAFF}
        lang="en"
        data={data}
        onOpenDirectory={() => flashNote('In the real app this opens Staff → Directory.')}
      />

      {note && (
        <div style={{
          position: 'fixed', bottom: 64, left: '50%', transform: 'translateX(-50%)', zIndex: 1300,
          padding: '10px 16px', background: T.ink, color: T.bg,
          borderRadius: 999, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
          boxShadow: '0 10px 30px rgba(31,35,28,0.25)',
        }}>{note}</div>
      )}
    </div>
  );
}
