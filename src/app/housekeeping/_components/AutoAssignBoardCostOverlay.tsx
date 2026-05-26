'use client';

/**
 * Per-housekeeper cost strip rendered as a sibling to AutoAssignBoard.
 *
 * Why a sibling (not edits inside AutoAssignBoard.tsx): that file is
 * owned by another in-flight branch (hk-auto-assignment). Touching the
 * column body would conflict; the orchestrator's instruction was to
 * either find an existing footer slot in the column (there isn't one)
 * or render a sibling. This is the sibling.
 *
 * We don't try to absolute-position over the board because the board's
 * column grid is `repeat(auto-fill, minmax(220px, 1fr))` — column count
 * changes with viewport width, so a positioned overlay would drift.
 * Instead we render a separate horizontal strip below the board with
 * one card per housekeeper. Visually adjacent, no alignment fight.
 *
 * Data source: /api/housekeeping/labor-cost — the same endpoint the
 * LaborCostBanner uses, so when both render on the Schedule tab they
 * share a single backend pull per refresh tick (no extra DB round-trip).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { useAuth } from '@/contexts/AuthContext';
import { canManageTeam } from '@/lib/roles';
import { T, FONT_SANS, FONT_MONO, FONT_SERIF, Caps, Pill, HousekeeperDot } from './_snow';

type Lang = 'en' | 'es';

interface PerHousekeeperCost {
  staffId: string;
  name: string;
  cents: number;
  billableMinutes: number;
  wageUnknown: boolean;
}

interface LaborCostPayload {
  totalCents: number;
  perHousekeeper: PerHousekeeperCost[];
  anyWageUnknown: boolean;
  asOf: string;
}

type OvertimeLevel = 'none' | 'approaching' | 'over';

interface OvertimeStatus {
  staffId: string;
  name: string | null;
  netHours: number;
  level: OvertimeLevel;
}

interface OvertimeStatusPayload {
  thresholdHours: number;
  approachingHours: number;
  byStaff: OvertimeStatus[];
}

const POLL_INTERVAL_MS = 30_000;

function fmtCents(cents: number, lang: Lang): string {
  const dollars = Math.round(cents / 100);
  return new Intl.NumberFormat(lang === 'es' ? 'es-US' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(dollars);
}

function fmtMinutes(mins: number, lang: Lang): string {
  if (!Number.isFinite(mins) || mins <= 0) return lang === 'es' ? '0 h' : '0h';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function AutoAssignBoardCostOverlay({
  propertyId,
  businessDate,
  lang,
}: {
  propertyId: string | null;
  businessDate?: string;
  lang: Lang;
}) {
  const { user } = useAuth();
  const allowedToSee = !!user && canManageTeam(user.role);

  const [data, setData] = useState<LaborCostPayload | null>(null);
  const [ot, setOt] = useState<OvertimeStatusPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const visibilityRef = useRef<boolean>(true);

  const dateToUse = businessDate ?? new Date().toISOString().slice(0, 10);

  const refresh = useCallback(async () => {
    if (!propertyId) return;
    try {
      const [costRes, otRes] = await Promise.all([
        fetchWithAuth(`/api/housekeeping/labor-cost?propertyId=${encodeURIComponent(propertyId)}&businessDate=${encodeURIComponent(dateToUse)}`),
        fetchWithAuth(`/api/housekeeping/overtime-status?propertyId=${encodeURIComponent(propertyId)}`),
      ]);
      const costBody = await costRes.json() as { ok?: boolean; data?: LaborCostPayload };
      const otBody = await otRes.json() as { ok?: boolean; data?: OvertimeStatusPayload };
      if (!costRes.ok || !costBody.ok || !costBody.data) {
        setData(null);
      } else {
        setData(costBody.data);
      }
      // OT is best-effort — if the call fails, render without badges.
      if (otRes.ok && otBody.ok && otBody.data) {
        setOt(otBody.data);
      } else {
        setOt(null);
      }
    } catch {
      // Silent on network error — the banner above will surface the
      // user-visible error message; the strip just hides.
      setData(null);
      setOt(null);
    } finally {
      setLoading(false);
    }
  }, [propertyId, dateToUse]);

  useEffect(() => {
    if (!propertyId) return;
    if (!allowedToSee) return;
    let cancelled = false;
    void refresh();
    const interval = setInterval(() => {
      if (cancelled) return;
      if (!visibilityRef.current) return;
      void refresh();
    }, POLL_INTERVAL_MS);

    const onVisibility = () => {
      visibilityRef.current = !document.hidden;
      if (!document.hidden) void refresh();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      cancelled = true;
      clearInterval(interval);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [propertyId, refresh, allowedToSee]);

  if (!propertyId) return null;
  // Manager+ only. Mirrors LaborCostBanner — keeps the cost strip from
  // showing up empty/error for non-management roles. Adversarial M2.
  if (!allowedToSee) return null;
  if (loading && !data) return null;
  if (!data || data.perHousekeeper.length === 0) return null;

  return (
    <div style={containerStyle}>
      <div style={headerRowStyle}>
        <Caps>{lang === 'es' ? 'Costo por limpiador · hoy' : 'Cost per housekeeper · today'}</Caps>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, letterSpacing: '0.04em' }}>
          {lang === 'es' ? 'TOTAL ' : 'TOTAL '}{fmtCents(data.totalCents, lang)}
        </span>
      </div>
      <div style={stripStyle}>
        {data.perHousekeeper.map(hk => {
          const otForStaff = ot?.byStaff.find(s => s.staffId === hk.staffId);
          return (
            <div key={hk.staffId} style={cardStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <HousekeeperDot staff={{ id: hk.staffId, name: hk.name }} size={20} />
                <span style={{
                  flex: 1,
                  fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600, color: T.ink,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{hk.name}</span>
                {otForStaff && otForStaff.level !== 'none' && (
                  <OtPill level={otForStaff.level} netHours={otForStaff.netHours} lang={lang} />
                )}
              </div>
              <div style={{
                display: 'flex', alignItems: 'baseline', gap: 8,
                justifyContent: 'space-between',
              }}>
                <span style={{
                  fontFamily: FONT_SERIF, fontStyle: 'italic',
                  fontSize: 22, color: hk.wageUnknown ? T.ink3 : T.ink,
                  letterSpacing: '-0.02em', lineHeight: 1,
                }}>
                  {hk.wageUnknown ? '—' : fmtCents(hk.cents, lang)}
                </span>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: 10, color: T.ink2,
                  letterSpacing: '0.04em', whiteSpace: 'nowrap',
                }}>{fmtMinutes(hk.billableMinutes, lang)}</span>
              </div>
              {hk.wageUnknown && (
                <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: T.ink3, letterSpacing: '0.05em' }}>
                  {lang === 'es' ? 'SALARIO NO CONFIGURADO' : 'WAGE NOT SET'}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Styles
// ───────────────────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  marginTop: 8,
  padding: '12px 16px',
  background: T.paper,
  border: `1px solid ${T.rule}`,
  borderRadius: 14,
};

const headerRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', marginBottom: 10,
};

const stripStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
  gap: 10,
};

const cardStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6,
  padding: '10px 12px',
  background: T.bg,
  border: `1px solid ${T.ruleSoft}`,
  borderRadius: 10,
};

function OtPill({
  level, netHours, lang,
}: {
  level: 'approaching' | 'over';
  netHours: number;
  lang: Lang;
}) {
  const hoursLabel = `${netHours.toFixed(0)}h`;
  if (level === 'approaching') {
    return (
      <Pill tone="caramel">
        {lang === 'es' ? `Cerca de HE · ${hoursLabel}` : `Near OT · ${hoursLabel}`}
      </Pill>
    );
  }
  return (
    <Pill tone="warm">
      {lang === 'es' ? `HE · ${hoursLabel}` : `OT · ${hoursLabel}`}
    </Pill>
  );
}
