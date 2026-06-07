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
  ink: '#15191A',
  ink2: '#586056',
  ink3: '#9CA29C',
  rule: 'rgba(15,20,17,0.07)',
  attn: '#9A5B0B', // amber-ink for "noticed" attention insights
  attnRule: 'rgba(154,91,11,0.16)',
} as const;

const FONT_SERIF = 'var(--font-fraunces), Georgia, serif';
const FONT_MONO = 'var(--font-geist-mono), ui-monospace, monospace';

const LABEL: React.CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: 10,
  letterSpacing: '0.18em',
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
        background: 'rgba(255,255,255,0.78)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.75)',
        borderRadius: 16,
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
                fontFamily: FONT_SERIF,
                fontStyle: 'italic',
                fontSize: 18,
                color: C.ink,
                lineHeight: 1.35,
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
