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
  ink: '#1F231C',
  ink2: '#5C625C',
  ink3: '#A6ABA6',
  rule: 'rgba(31,35,28,0.06)',
  terracotta: '#B85C3D',
} as const;

const FONT_SANS = 'var(--font-geist), system-ui, -apple-system, sans-serif';
const FONT_MONO = 'var(--font-geist-mono), ui-monospace, monospace';

const LABEL: React.CSSProperties = {
  fontFamily: FONT_MONO, fontSize: 9.5, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: C.ink3, fontWeight: 600,
};

const SRC: Record<WorklistSourceType, { en: string; es: string; color: string }> = {
  task:       { en: 'To-do', es: 'Tarea', color: '#5C625C' },
  complaint:  { en: 'Complaint', es: 'Queja', color: '#B85C3D' },
  workorder:  { en: 'Work order', es: 'Orden', color: '#C99644' },
  inspection: { en: 'Inspection', es: 'Inspección', color: '#5C7A60' },
  pm:         { en: 'Preventive', es: 'Preventivo', color: '#3E5C48' },
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
    // Communications-owned embed: don't even fetch when the section is off.
    if (!canSee || !activePropertyId || !commsEnabled) return;
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
  }, [canSee, activePropertyId, commsEnabled]);

  if (!canSee || !activePropertyId || !commsEnabled) return null;
  const list = items ?? [];
  // Additive-only: nothing to show until there is open work.
  if (!loaded || list.length === 0) return null;

  const overdue = list.filter((i) => i.overdue).length;
  const top = list.slice(0, 4);

  return (
    <div style={{
      background: '#FFFFFF', border: '1px solid rgba(31,35,28,0.08)', borderRadius: 16,
      boxShadow: '0 6px 16px -14px rgba(31,42,32,0.35)', padding: '18px 20px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={LABEL}>{es ? 'Pendientes' : 'Open items'}</div>
        <Link href="/communications" style={{ fontFamily: FONT_MONO, fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.ink3, textDecoration: 'none' }}>
          {es ? 'Ver todo →' : 'View all →'}
        </Link>
      </div>

      <div style={{ marginTop: 8, fontFamily: FONT_SANS, fontWeight: 600, fontSize: 22, letterSpacing: '-0.02em', color: C.ink, lineHeight: 1.2 }}>
        {list.length} {es ? (list.length === 1 ? 'pendiente' : 'pendientes') : (list.length === 1 ? 'open item' : 'open items')}
        {overdue > 0 && <span style={{ fontSize: 14, fontWeight: 600, color: C.terracotta, fontFamily: FONT_MONO, marginLeft: 10, letterSpacing: 0 }}>{overdue} {es ? 'vencidas' : 'overdue'}</span>}
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
