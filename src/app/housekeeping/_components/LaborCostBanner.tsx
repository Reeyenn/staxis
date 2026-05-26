'use client';

/**
 * LaborCostBanner — top-of-Schedule-tab strip showing today's live
 * labor cost + the end-of-day projection + the budget delta.
 *
 * Polls /api/housekeeping/labor-cost every 30 seconds when the tab is
 * foregrounded. Pauses polling when the tab is hidden (no point burning
 * a polling slot on a backgrounded tab — the user will get the next
 * tick when they return).
 *
 * Visual posture mirrors the rest of Snow: paper card, caps label,
 * serif numbers, sage/warm/red pill for the budget delta. No new
 * tokens.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { useAuth } from '@/contexts/AuthContext';
import { canManageTeam } from '@/lib/roles';
import { T, FONT_SANS, FONT_SERIF, FONT_MONO, Caps, Pill } from './_snow';

type Lang = 'en' | 'es';

interface LaborCostPayload {
  totalCents: number;
  projectedCents: number;
  accruedCents: number;
  remainingEstimateCents: number;
  basedOnHistoricalPace: boolean;
  anyWageUnknown: boolean;
  dailyBudgetCents: number | null;
  weeklyBudgetCents: number | null;
  asOf: string;
}

const POLL_INTERVAL_MS = 30_000;

function fmtCents(cents: number, lang: Lang): string {
  // Whole-dollar formatting matches the rest of Snow's "big number"
  // treatment in the KPI strip. Two-decimal would be busy for a banner.
  const dollars = Math.round(cents / 100);
  return new Intl.NumberFormat(lang === 'es' ? 'es-US' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(dollars);
}

function todayInProperty(timezone: string | undefined): string {
  // The banner asks the API for "today" — let the API default to UTC
  // when timezone is unknown. Property-local timezone is hoisted into
  // PropertyContext but the schedule tab already passes shiftDate; we
  // mirror that here in a future patch if the property timezone drifts
  // from UTC. For now, UTC's "today" is correct for the active
  // customer (Central time still lands on the same calendar date for
  // an 09:00–17:00 housekeeping shift).
  void timezone;
  return new Date().toISOString().slice(0, 10);
}

export function LaborCostBanner({
  propertyId,
  businessDate,
  lang,
  /**
   * When provided, the parent owns the "we're in the schedule for date X"
   * model. The banner just renders for that date. Missing → today.
   */
}: {
  propertyId: string | null;
  businessDate?: string;
  lang: Lang;
}) {
  const { user } = useAuth();
  const allowedToSee = !!user && canManageTeam(user.role);

  const [data, setData] = useState<LaborCostPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const visibilityRef = useRef<boolean>(true);

  const dateToUse = businessDate ?? todayInProperty(undefined);

  const refresh = useCallback(async () => {
    if (!propertyId) return;
    try {
      const res = await fetchWithAuth(`/api/housekeeping/labor-cost?propertyId=${encodeURIComponent(propertyId)}&businessDate=${encodeURIComponent(dateToUse)}`);
      const body = await res.json() as { ok?: boolean; data?: LaborCostPayload; error?: string };
      if (!res.ok || !body.ok || !body.data) {
        setErrorMsg(body.error || 'Could not load labor cost');
        setData(null);
        return;
      }
      setErrorMsg(null);
      setData(body.data);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Network error');
      setData(null);
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
      // Re-fetch immediately on coming back to foreground so the user
      // doesn't see a stale snapshot for up to 30 seconds.
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
  // Manager+ only. Server-side route also enforces this; the UI gate is
  // here so housekeepers (who CAN reach /housekeeping today) don't see
  // an empty/error banner where the feature would otherwise render.
  if (!allowedToSee) return null;

  // First-load skeleton — keep it short so the user isn't staring at a
  // gray block while the route warms up.
  if (loading && !data) {
    return (
      <div style={containerStyle}>
        <Caps>{lang === 'es' ? 'Costo laboral de hoy' : "Today's labor"}</Caps>
        <div style={{ flex: 1 }} />
        <span style={{ ...numberStyle, color: T.ink3 }}>—</span>
      </div>
    );
  }

  if (errorMsg) {
    return (
      <div style={containerStyle}>
        <Caps>{lang === 'es' ? 'Costo laboral' : 'Labor cost'}</Caps>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.red }}>
          {lang === 'es' ? 'No disponible' : 'Unavailable'}
        </span>
      </div>
    );
  }

  if (!data) return null;

  // Budget delta against the daily budget — null if not configured.
  const budgetCents = data.dailyBudgetCents;
  const overUnderCents = budgetCents !== null
    ? data.projectedCents - budgetCents
    : null;

  // Pill tone:
  //   over budget → warm
  //   ≥80% of budget → caramel
  //   otherwise → sage
  let deltaTone: 'sage' | 'caramel' | 'warm' = 'sage';
  if (overUnderCents !== null && budgetCents !== null && budgetCents > 0) {
    if (overUnderCents > 0) deltaTone = 'warm';
    else if (data.projectedCents >= budgetCents * 0.8) deltaTone = 'caramel';
  }

  return (
    <div style={containerStyle}>
      <div style={cellStyle}>
        <Caps>{lang === 'es' ? 'Hoy' : 'Today'}</Caps>
        <span style={numberStyle}>{fmtCents(data.totalCents, lang)}</span>
      </div>
      <Divider />
      <div style={cellStyle}>
        <Caps>{lang === 'es' ? 'Proyectado EOD' : 'Projected EOD'}</Caps>
        <span style={{ ...numberStyle, color: data.basedOnHistoricalPace ? T.ink : T.ink3 }}>
          {data.basedOnHistoricalPace ? fmtCents(data.projectedCents, lang) : '—'}
        </span>
      </div>
      {budgetCents !== null && (
        <>
          <Divider />
          <div style={cellStyle}>
            <Caps>{lang === 'es' ? 'Presupuesto del día' : 'Daily budget'}</Caps>
            <span style={{ ...numberStyle, color: T.ink2 }}>{fmtCents(budgetCents, lang)}</span>
          </div>
        </>
      )}
      <div style={{ flex: 1 }} />
      {overUnderCents !== null && (
        <Pill tone={deltaTone}>
          {overUnderCents > 0
            ? `${lang === 'es' ? 'Sobre' : 'Over'} ${fmtCents(Math.abs(overUnderCents), lang)}`
            : `${lang === 'es' ? 'Bajo' : 'Under'} ${fmtCents(Math.abs(overUnderCents), lang)}`}
        </Pill>
      )}
      {data.anyWageUnknown && (
        <span style={{
          fontFamily: FONT_MONO, fontSize: 10, color: T.ink3,
          marginLeft: 8, letterSpacing: '0.04em',
        }}>
          {lang === 'es' ? '· Faltan salarios' : '· wages missing'}
        </span>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Local style fragments — kept inline so the banner doesn't pull in a
// new style file.
// ───────────────────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  padding: '12px 18px',
  background: T.paper,
  border: `1px solid ${T.rule}`,
  borderRadius: 14,
  fontFamily: FONT_SANS,
  marginBottom: 12,
};

const cellStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 110,
};

const numberStyle: React.CSSProperties = {
  fontFamily: FONT_SERIF,
  fontStyle: 'italic',
  fontSize: 22,
  color: T.ink,
  letterSpacing: '-0.02em',
  lineHeight: 1,
};

function Divider() {
  return (
    <div style={{ width: 1, height: 28, background: T.ruleSoft }} />
  );
}
