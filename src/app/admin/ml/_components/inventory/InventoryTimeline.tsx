'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { supabase } from '@/lib/supabase';

/**
 * Horizontal timeline showing where the inventory AI is in its lifecycle for
 * THIS hotel. Replaces the dense table-heavy panels — Reeyen wanted a
 * "where am I, what's next?" view in plain English.
 *
 * Phases (per-hotel; based on days since first count event):
 *   • Day 0          — Started learning
 *   • Day 7-14       — First predictions appear (reorder list starts using AI)
 *   • Day 30         — Items start graduating to auto-fill in Count Mode
 *   • Day 60         — Most common items graduated; reorder list very accurate
 *   • Day 90+        — Mature; accuracy ~±10%; anomaly alerts well-calibrated
 *
 * Shows a position dot at "today" so the user can see how close the next
 * milestone is. Each phase highlights as it activates.
 */
export function InventoryTimeline() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();

  const [daysSinceFirstCount, setDaysSinceFirstCount] = useState<number | null>(null);
  const [itemsTotal, setItemsTotal] = useState(0);
  const [itemsGraduated, setItemsGraduated] = useState(0);
  const [aiMode, setAiMode] = useState<'off' | 'auto' | 'always-on'>('auto');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    (async () => {
      try {
        const [countRes, propRes, itemsRes, runsRes] = await Promise.all([
          supabase.from('inventory_counts')
            .select('counted_at').eq('property_id', activePropertyId)
            .order('counted_at', { ascending: true }).limit(1).maybeSingle(),
          supabase.from('properties')
            .select('inventory_ai_mode').eq('id', activePropertyId).maybeSingle(),
          supabase.from('inventory')
            .select('id', { count: 'exact', head: true }).eq('property_id', activePropertyId),
          supabase.from('model_runs')
            .select('id', { count: 'exact', head: true })
            .eq('property_id', activePropertyId)
            .eq('layer', 'inventory_rate')
            .eq('is_active', true)
            .eq('auto_fill_enabled', true),
        ]);
        const firstAt = countRes.data?.counted_at ? new Date(countRes.data.counted_at).getTime() : null;
        setDaysSinceFirstCount(firstAt
          ? Math.max(0, Math.floor((Date.now() - firstAt) / 86400000))
          : 0,
        );
        setAiMode((propRes.data?.inventory_ai_mode ?? 'auto') as 'off' | 'auto' | 'always-on');
        setItemsTotal(itemsRes.count ?? 0);
        setItemsGraduated(runsRes.count ?? 0);
      } catch (err) {
        console.error('InventoryTimeline: fetch error', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, activePropertyId]);

  const day = daysSinceFirstCount ?? 0;

  // Phase definitions with day thresholds. Order matters — left to right.
  const phases = [
    { id: 'started',    label: 'Started learning',        day: 0,
      blurb: 'AI watches every count and starts learning your hotel’s usage.' },
    { id: 'predicting', label: 'First predictions',       day: 14,
      blurb: 'Reorder list switches to AI-predicted rates instead of manual rates.' },
    { id: 'first-grad', label: 'First items auto-fill',   day: 30,
      blurb: 'Common items start pre-filling counts. Counting time drops.' },
    { id: 'mostly',     label: 'Most items graduated',    day: 60,
      blurb: 'Reorder list very accurate. Most counts auto-filled.' },
    { id: 'mature',     label: 'Mature',                  day: 90,
      blurb: 'Accuracy ~±10%. Anomaly alerts well-calibrated.' },
  ];

  // Find current phase
  const currentPhaseIdx = phases.reduce((latest, p, idx) => (day >= p.day ? idx : latest), 0);

  // Determine where the "today dot" sits (0-100% across the timeline)
  const totalDays = phases[phases.length - 1].day;
  const positionPct = Math.min(100, Math.max(0, (day / totalDays) * 100));

  // Find next milestone
  const nextPhase = phases.find((p) => p.day > day);
  const daysToNext = nextPhase ? nextPhase.day - day : null;

  if (loading) {
    return (
      <div style={cardStyle}>
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading…</div>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: '12px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          Where the AI is
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          {aiMode === 'off'
            ? 'AI is OFF for this hotel. Turn it back on from the AI Helper page on /inventory.'
            : `Day ${day} — ${phases[currentPhaseIdx].blurb}`}
        </p>
      </div>

      {/* Timeline bar */}
      <div style={{ position: 'relative', padding: '40px 12px 56px 12px' }}>
        {/* Track */}
        <div style={{
          position: 'absolute', left: '12px', right: '12px', top: '60px',
          height: '4px', background: '#eef1f4', borderRadius: '2px',
        }} />
        {/* Filled track up to the current position */}
        <div style={{
          position: 'absolute', left: '12px', top: '60px',
          width: `calc((100% - 24px) * ${positionPct} / 100)`,
          height: '4px', background: '#004b4b', borderRadius: '2px',
          transition: 'width 0.4s',
        }} />
        {/* "Today" dot */}
        <div style={{
          position: 'absolute', left: `calc(12px + (100% - 24px) * ${positionPct} / 100)`,
          top: '52px', width: '20px', height: '20px',
          background: '#004b4b', borderRadius: '50%',
          border: '3px solid #ffffff',
          boxShadow: '0 0 0 1px rgba(0,75,75,0.3)',
          transform: 'translateX(-10px)',
          zIndex: 2,
        }} title={`Day ${day} (today)`} />
        {/* Phase markers */}
        {phases.map((p, idx) => {
          const left = `calc(12px + (100% - 24px) * ${(p.day / totalDays) * 100} / 100)`;
          const reached = idx <= currentPhaseIdx;
          return (
            <React.Fragment key={p.id}>
              {/* Dot */}
              <div style={{
                position: 'absolute',
                left,
                top: '54px',
                width: '12px', height: '12px',
                borderRadius: '50%',
                background: reached ? '#004b4b' : '#cdd5dd',
                transform: 'translateX(-6px)',
                zIndex: 1,
              }} />
              {/* Label above */}
              <div style={{
                position: 'absolute', left, top: '8px',
                transform: 'translateX(-50%)',
                fontSize: '11px', fontWeight: 600,
                color: reached ? '#004b4b' : '#7a8a9e',
                whiteSpace: 'nowrap',
                textAlign: 'center',
              }}>
                {p.label}
              </div>
              {/* Day number below */}
              <div style={{
                position: 'absolute', left, top: '78px',
                transform: 'translateX(-50%)',
                fontSize: '10px', color: '#7a8a9e',
                whiteSpace: 'nowrap',
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                {p.day === 0 ? 'Day 0' : `Day ${p.day}`}
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* Status strip */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '12px',
        marginTop: '12px',
      }}>
        <Stat label="Items learning" value={`${itemsTotal - itemsGraduated} / ${itemsTotal}`} />
        <Stat label="Items auto-filling" value={String(itemsGraduated)} color="#00a050" />
        <Stat
          label={daysToNext === null ? 'Next milestone' : `Days to "${nextPhase?.label}"`}
          value={daysToNext === null ? 'Mature' : String(daysToNext)}
        />
      </div>

      {/* Cross-hotel network unlocks */}
      <div style={{
        marginTop: '20px',
        padding: '12px 14px',
        background: '#f7fafb',
        border: '1px solid rgba(78,90,122,0.08)',
        borderRadius: '10px',
        fontSize: '12px',
        color: '#454652',
        lineHeight: 1.5,
      }}>
        <div style={{ fontWeight: 600, color: '#1b1c19', marginBottom: '4px' }}>
          Network unlocks (across all hotels you sign up)
        </div>
        <div>
          <strong>5 hotels</strong> → cohort priors activate (new hotels get faster cold-start) ·{' '}
          <strong>50 hotels</strong> → stronger cohort priors ·{' '}
          <strong>300 hotels</strong> → XGBoost network model trains on cross-hotel features (the "boost" model).
        </div>
      </div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid rgba(78,90,122,0.12)',
  borderRadius: '12px',
  padding: '24px',
};

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: '11px', color: '#7a8a9e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: '20px', fontWeight: 600, color: color ?? '#1b1c19', marginTop: '2px' }}>
        {value}
      </div>
    </div>
  );
}
