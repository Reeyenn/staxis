'use client';

// "Open items" card for the Dashboard — a compact read-only window onto the
// unified worklist (the Communications To-do view). Shows the open-item count +
// the top few items, each tagged by source, and links to the full list.
// Gated to management + front desk and ADDITIVE-ONLY: renders nothing until
// there is at least one open item, so the dashboard is unchanged on a quiet day.
// Reads GET /api/worklist (service-role behind a session + property-access gate).

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { canManageTeam } from '@/lib/roles';
import { useSectionEnabled } from '@/lib/sections/useSectionEnabled';
import type { WorklistItem, WorklistSourceType } from '@/lib/worklist/types';

const C = {
  ink: '#15191A',
  ink2: '#586056',
  ink3: '#9CA29C',
  rule: 'rgba(15,20,17,0.07)',
  terracotta: '#C2562E',
} as const;

const FONT_SERIF = 'var(--font-fraunces), Georgia, serif';
const FONT_MONO = 'var(--font-geist-mono), ui-monospace, monospace';

const LABEL: React.CSSProperties = {
  fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.18em',
  textTransform: 'uppercase', color: C.ink3, fontWeight: 600,
};

const SRC: Record<WorklistSourceType, { en: string; es: string; color: string }> = {
  task:       { en: 'To-do', es: 'Tarea', color: '#586056' },
  complaint:  { en: 'Complaint', es: 'Queja', color: '#C2562E' },
  workorder:  { en: 'Work order', es: 'Orden', color: '#C99A2E' },
  inspection: { en: 'Inspection', es: 'Inspección', color: '#3C9C68' },
  pm:         { en: 'Preventive', es: 'Preventivo', color: '#3389A0' },
};

export function WorklistCard() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const es = lang === 'es';
  // The unified worklist lives under Communications — hide this embed when
  // that section is off for the hotel (default-ON while loading).
  const commsEnabled = useSectionEnabled('communications');
  const [items, setItems] = useState<WorklistItem[] | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Management + front desk. Floor staff don't see the cross-department list.
  const canSee = !!user && (canManageTeam(user.role) || user.role === 'front_desk');

  useEffect(() => {
    if (!canSee || !activePropertyId) return;
    let alive = true;
    setLoaded(false);
    fetch(`/api/worklist?pid=${activePropertyId}`)
      .then((r) => r.json())
      .then((j) => {
        if (alive) {
          setItems(j?.ok && j.data ? (j.data.items as WorklistItem[]) : null);
          setLoaded(true);
        }
      })
      .catch(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [canSee, activePropertyId]);

  if (!canSee || !activePropertyId || !commsEnabled) return null;
  const list = items ?? [];
  // Additive-only: nothing to show until there is open work.
  if (!loaded || list.length === 0) return null;

  const overdue = list.filter((i) => i.overdue).length;
  const top = list.slice(0, 4);

  return (
    <div style={{
      background: 'rgba(255,255,255,0.78)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      border: '1px solid rgba(255,255,255,0.75)', borderRadius: 16, padding: '18px 20px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={LABEL}>{es ? 'Pendientes' : 'Open items'}</div>
        <Link href="/communications" style={{ fontFamily: FONT_MONO, fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.ink3, textDecoration: 'none' }}>
          {es ? 'Ver todo →' : 'View all →'}
        </Link>
      </div>

      <div style={{ marginTop: 8, fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 22, color: C.ink, lineHeight: 1.2 }}>
        {list.length} {es ? (list.length === 1 ? 'pendiente' : 'pendientes') : (list.length === 1 ? 'open item' : 'open items')}
        {overdue > 0 && <span style={{ fontSize: 14, fontStyle: 'normal', color: C.terracotta, fontFamily: FONT_MONO, marginLeft: 10 }}>{overdue} {es ? 'vencidas' : 'overdue'}</span>}
      </div>

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column' }}>
        {top.map((it) => {
          const meta = SRC[it.sourceType];
          return (
            <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: `1px solid ${C.rule}` }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: C.ink, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.title}
                {it.location && <span style={{ color: C.ink3 }}> · {it.location}</span>}
              </span>
              <span style={{ flexShrink: 0, fontFamily: FONT_MONO, fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: it.overdue ? C.terracotta : C.ink3 }}>
                {it.overdue ? (es ? 'Vencida' : 'Overdue') : (es ? meta.es : meta.en)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
