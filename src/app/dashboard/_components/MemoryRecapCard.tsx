'use client';

// "What Staxis learned" card for the owner Dashboard (self-learning Move #2).
// Shows the latest nightly consolidation recap + the facts Staxis auto-learned
// from the hotel's conversations, each with a one-tap Remove. Manager-gated
// (canManageTeam) and ADDITIVE-ONLY: renders nothing until there is something
// learned, so the dashboard is unchanged on a fresh hotel. Reads/writes go
// through /api/memory/recap (service-role behind a session + management gate).

import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { canManageTeam } from '@/lib/roles';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import { GlassCard } from './GlassCard';
import { CARD, CARD_MONO, CARD_LABEL, SANS } from './palette';

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

export function MemoryRecapCard() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const [removing, setRemoving] = useState<string | null>(null);
  // A removal that came back failed (HTTP error / offline / non-JSON body) —
  // the fact stays on screen AND we say so, instead of the old silent no-op.
  const [removeFailed, setRemoveFailed] = useState(false);
  // Facts removed in this session — filtered out locally after a successful
  // POST, exactly like the previous in-place setData filter.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());

  const es = lang === 'es';
  const canSee = !!user && canManageTeam(user.role);

  // Nightly-consolidation data: a slow 5-min poll keeps a long-lived (wall-TV)
  // dashboard from going permanently stale; keepDataOnError holds last-good
  // through a failed poll so the card never blinks out on a blip.
  const { data, loading } = useApiResource<RecapData>(
    `/api/memory/recap?propertyId=${activePropertyId}`,
    { enabled: canSee && !!activePropertyId, pollMs: 300_000, keepDataOnError: true },
  );

  useEffect(() => {
    setRemoved(new Set());
    setRemoveFailed(false);
  }, [activePropertyId]);

  const remove = useCallback(
    async (id: string) => {
      if (!activePropertyId) return;
      setRemoving(id);
      setRemoveFailed(false);
      try {
        // fetchWithAuth (not bare fetch): the write path rides the same
        // token/401-recovery as the card's GET.
        const r = await fetchWithAuth('/api/memory/recap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ propertyId: activePropertyId, id }),
        });
        const j = (await r.json().catch(() => null)) as { ok?: boolean } | null;
        if (j?.ok) setRemoved((prev) => new Set(prev).add(id));
        else setRemoveFailed(true);
      } catch (e) {
        // Signed out mid-request → redirect already firing, show nothing.
        if (!(e instanceof SessionEndedError)) setRemoveFailed(true);
      } finally {
        setRemoving(null);
      }
    },
    [activePropertyId],
  );

  if (!canSee || !activePropertyId) return null;
  const noticed = (data?.noticed ?? []).filter((i) => !removed.has(i.id));
  const items = (data?.items ?? []).filter((i) => !removed.has(i.id));
  // Additive-only: nothing to show until Staxis has actually learned/noticed something.
  if (loading || !data || (noticed.length === 0 && items.length === 0)) return null;

  const removeBtn = (id: string) => (
    <button
      onClick={() => remove(id)}
      disabled={removing === id}
      style={{
        flexShrink: 0,
        fontFamily: CARD_MONO,
        fontSize: 11,
        color: CARD.ink3,
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
    <GlassCard>
      {/* What Staxis noticed — proactive operational insights (attention) */}
      {noticed.length > 0 && (
        <>
          <div style={{ ...CARD_LABEL, color: CARD.attn }}>
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
                  borderTop: `1px solid ${CARD.attnRule}`,
                }}
              >
                <span style={{ fontSize: 13.5, color: CARD.ink, lineHeight: 1.4, fontWeight: 500 }}>
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
          <div style={{ ...CARD_LABEL, marginTop: noticed.length > 0 ? 20 : 0 }}>
            {es ? 'Lo que Staxis aprendió' : 'What Staxis learned'}
          </div>

          {data.recap && data.recap !== 'Nothing new to remember today.' && (
            <div
              style={{
                marginTop: 10,
                fontFamily: SANS,
                fontWeight: 500,
                fontSize: 15,
                color: CARD.ink,
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
                  borderTop: `1px solid ${CARD.rule}`,
                }}
              >
                <span style={{ fontSize: 13.5, color: CARD.ink2, lineHeight: 1.4 }}>{it.content}</span>
                {removeBtn(it.id)}
              </div>
            ))}
          </div>
        </>
      )}

      {removeFailed && (
        <div style={{ marginTop: 10, fontSize: 12, color: CARD.attn }}>
          {es
            ? 'No se pudo quitar la nota. Revisa tu conexión e inténtalo de nuevo.'
            : 'Couldn’t remove that note — check your connection and try again.'}
        </div>
      )}

      <div style={{ marginTop: 12, fontSize: 11, color: CARD.ink3, fontFamily: CARD_MONO, lineHeight: 1.5 }}>
        {es
          ? 'Staxis observa tus operaciones y conversaciones y aprende cada noche. Quita cualquier nota incorrecta.'
          : 'Staxis watches your operations and conversations and learns each night — remove anything that’s off.'}
      </div>
    </GlassCard>
  );
}
