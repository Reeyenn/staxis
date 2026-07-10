'use client';

// "What Staxis learned" card for the owner Dashboard (self-learning Move #2).
// Shows the latest nightly consolidation recap + the facts Staxis auto-learned
// from the hotel's conversations, each with a one-tap Remove. Manager-gated
// (canManageTeam) and ADDITIVE-ONLY: renders nothing until there is something
// learned, so the dashboard is unchanged on a fresh hotel. Reads/writes go
// through /api/memory/recap (service-role behind a session + management gate).

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { canManageTeam } from '@/lib/roles';

interface LearnedItem {
  id: string;
  topic: string;
  content: string;
}
interface NoticedItem extends LearnedItem {
  severity: 'attention';
}
interface RecapData {
  recap: string | null;
  ranAt: string | null;
  learnedCount: number;
  updatedCount: number;
  operationalRecap: string | null;
  noticed: NoticedItem[];
  items: LearnedItem[];
}

const C = {
  ink: '#1F231C',
  ink2: '#5C625C',
  ink3: '#A6ABA6',
  rule: 'rgba(31,35,28,0.06)',
  attn: '#8C6A33', // amber warn-text for "noticed" attention insights
  attnRule: 'rgba(201,150,68,0.25)',
} as const;

const FONT_SANS = 'var(--font-geist), system-ui, -apple-system, sans-serif';
const FONT_MONO = 'var(--font-geist-mono), ui-monospace, monospace';

const LABEL: React.CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: 9.5,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: C.ink3,
  fontWeight: 600,
};

export function MemoryRecapCard() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const [data, setData] = useState<RecapData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const es = lang === 'es';
  const canSee = !!user && canManageTeam(user.role);

  useEffect(() => {
    if (!canSee || !activePropertyId) return;
    let alive = true;
    setLoaded(false);
    fetch(`/api/memory/recap?propertyId=${activePropertyId}`)
      .then((r) => r.json())
      .then((j) => {
        if (alive) {
          setData(j?.ok ? (j.data as RecapData) : null);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [canSee, activePropertyId]);

  const remove = useCallback(
    async (id: string) => {
      if (!activePropertyId) return;
      setRemoving(id);
      try {
        const r = await fetch('/api/memory/recap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ propertyId: activePropertyId, id }),
        });
        const j = await r.json();
        if (j?.ok)
          setData((d) =>
            d
              ? {
                  ...d,
                  items: d.items.filter((i) => i.id !== id),
                  noticed: d.noticed.filter((i) => i.id !== id),
                }
              : d,
          );
      } finally {
        setRemoving(null);
      }
    },
    [activePropertyId],
  );

  if (!canSee || !activePropertyId) return null;
  const noticed = data?.noticed ?? [];
  const items = data?.items ?? [];
  // Additive-only: nothing to show until Staxis has actually learned/noticed something.
  if (!loaded || !data || (noticed.length === 0 && items.length === 0)) return null;

  const removeBtn = (id: string) => (
    <button
      onClick={() => remove(id)}
      disabled={removing === id}
      style={{
        flexShrink: 0,
        fontFamily: FONT_MONO,
        fontSize: 11,
        color: C.ink3,
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
      }}
    >
      {removing === id ? '…' : es ? 'Quitar' : 'Remove'}
    </button>
  );

  return (
    <div
      style={{
        background: '#FFFFFF',
        border: '1px solid rgba(31,35,28,0.08)',
        borderRadius: 16,
        boxShadow: '0 6px 16px -14px rgba(31,42,32,0.35)',
        padding: '18px 20px',
      }}
    >
      {/* What Staxis noticed — proactive operational insights (attention) */}
      {noticed.length > 0 && (
        <>
          <div style={{ ...LABEL, color: C.attn }}>
            {es ? '⚠ Lo que Staxis notó' : '⚠ What Staxis noticed'}
          </div>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column' }}>
            {noticed.map((it) => (
              <div
                key={it.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '8px 0',
                  borderTop: `1px solid ${C.attnRule}`,
                }}
              >
                <span style={{ fontSize: 13.5, color: C.ink, lineHeight: 1.4, fontWeight: 500 }}>
                  {it.content}
                </span>
                {removeBtn(it.id)}
              </div>
            ))}
          </div>
        </>
      )}

      {/* What Staxis learned — facts from conversations + lower-signal patterns */}
      {items.length > 0 && (
        <>
          <div style={{ ...LABEL, marginTop: noticed.length > 0 ? 20 : 0 }}>
            {es ? 'Lo que Staxis aprendió' : 'What Staxis learned'}
          </div>

          {data.recap && data.recap !== 'Nothing new to remember today.' && (
            <div
              style={{
                marginTop: 10,
                fontFamily: FONT_SANS,
                fontWeight: 500,
                fontSize: 15,
                color: C.ink,
                lineHeight: 1.5,
              }}
            >
              {data.recap}
            </div>
          )}

          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column' }}>
            {items.map((it) => (
              <div
                key={it.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '8px 0',
                  borderTop: `1px solid ${C.rule}`,
                }}
              >
                <span style={{ fontSize: 13.5, color: C.ink2, lineHeight: 1.4 }}>{it.content}</span>
                {removeBtn(it.id)}
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{ marginTop: 12, fontSize: 11, color: C.ink3, fontFamily: FONT_MONO, lineHeight: 1.5 }}>
        {es
          ? 'Staxis observa tus operaciones y conversaciones y aprende cada noche. Quita cualquier nota incorrecta.'
          : 'Staxis watches your operations and conversations and learns each night — remove anything that’s off.'}
      </div>
    </div>
  );
}
