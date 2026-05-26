// ScheduleAlertsBanner — open schedule_alerts for a property, surfaced as
// a stack of dismissible banners on the Manager Schedule page.
//
// Behavior:
//   - Polls /api/staff-schedule/alerts every 30s while mounted.
//   - One banner per alert; severity drives color (yellow vs red).
//   - "Apply" → POST .../alerts/:id/apply → toast + refetch
//   - "Dismiss" → POST .../alerts/:id/dismiss → toast + refetch
//   - Empty state: nothing rendered.

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { T, fonts, Btn, Caps, deptMeta, asDeptKey } from './_tokens';

interface ScheduleAlert {
  id: string;
  propertyId: string;
  alertDate: string;
  department: string;
  severity: 'yellow' | 'red';
  gapMinutes: number;
  demandMinutes: number;
  scheduledMinutes: number;
  suggestedAction: 'add_shift' | 'release_shift';
  suggestedSavingsCents: number | null;
  triggerKind: string;
  context: Record<string, unknown>;
  createdAt: string;
}

interface ScheduleAlertsBannerProps {
  hotelId: string | null;
}

const POLL_INTERVAL_MS = 30_000;

export function ScheduleAlertsBanner({ hotelId }: ScheduleAlertsBannerProps) {
  const [alerts, setAlerts] = useState<ScheduleAlert[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refetch = useCallback(async () => {
    if (!hotelId) return;
    try {
      const res = await fetchWithAuth(`/api/staff-schedule/alerts?hotelId=${encodeURIComponent(hotelId)}`);
      if (!res.ok) {
        setLoadError('Could not load schedule alerts.');
        return;
      }
      const body = await res.json();
      const list = (body?.data?.alerts ?? []) as ScheduleAlert[];
      setAlerts(list);
      setLoadError(null);
    } catch {
      setLoadError('Could not load schedule alerts.');
    }
  }, [hotelId]);

  useEffect(() => {
    void refetch();
    if (!hotelId) return;
    const id = window.setInterval(() => { void refetch(); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refetch, hotelId]);

  // Auto-clear toast.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4_500);
    return () => window.clearTimeout(id);
  }, [toast]);

  const onDismiss = useCallback(async (alertId: string) => {
    setBusyId(alertId);
    try {
      const res = await fetchWithAuth(
        `/api/staff-schedule/alerts/${encodeURIComponent(alertId)}/dismiss`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setToast({ kind: 'err', text: body?.error ?? 'Dismiss failed.' });
      } else {
        // Optimistic local hide before the next refetch lands.
        setAlerts((prev) => prev.filter((a) => a.id !== alertId));
      }
    } finally {
      setBusyId(null);
      void refetch();
    }
  }, [refetch]);

  const onApply = useCallback(async (alert: ScheduleAlert) => {
    // Release-shift is destructive (removes a draft shift from the week
    // grid). Even though the apply route refuses to delete a published
    // shift, a draft shift may still belong to a critical-skill staff
    // member the manager doesn't want to drop. Always confirm before
    // firing release. Add-shift is non-destructive (creates an open slot)
    // — no confirmation needed.
    if (alert.suggestedAction === 'release_shift') {
      const ok = window.confirm(
        'Release the latest draft shift for this day + department?\n\n' +
        'The shift is removed from the week grid. This affects DRAFT shifts only — published shifts the staff already saw are protected.',
      );
      if (!ok) return;
    }
    setBusyId(alert.id);
    try {
      const res = await fetchWithAuth(
        `/api/staff-schedule/alerts/${encodeURIComponent(alert.id)}/apply`,
        { method: 'POST' },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setToast({ kind: 'err', text: body?.error ?? 'Apply failed.' });
      } else {
        const outcome = body?.data?.outcome ?? '';
        const msg =
          outcome === 'created_open_shift' ? 'Open shift created — staff can pick it up.' :
          outcome === 'deleted_shift'      ? 'Shift released — labor cost will fall.' :
          'Alert applied.';
        setToast({ kind: 'ok', text: msg });
        setAlerts((prev) => prev.filter((a) => a.id !== alert.id));
      }
    } finally {
      setBusyId(null);
      void refetch();
    }
  }, [refetch]);

  if (loadError) {
    return (
      <div style={{
        margin: '0 0 12px', padding: '10px 14px',
        background: T.redDim, border: `1px solid rgba(160,74,44,0.25)`,
        borderRadius: 12, color: T.red, fontFamily: fonts.sans, fontSize: 12,
      }}>{loadError}</div>
    );
  }
  if (alerts.length === 0 && !toast) return null;

  return (
    <div style={{ margin: '0 0 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {toast && (
        <div
          role="status"
          style={{
            padding: '10px 14px',
            background: toast.kind === 'ok' ? T.sageDim : T.redDim,
            border: `1px solid ${toast.kind === 'ok' ? 'rgba(92,122,96,0.30)' : 'rgba(160,74,44,0.30)'}`,
            borderRadius: 12,
            color: toast.kind === 'ok' ? T.sageDeep : T.red,
            fontFamily: fonts.sans, fontSize: 13,
          }}
        >{toast.text}</div>
      )}
      {alerts.map((a) => (
        <AlertCard
          key={a.id}
          alert={a}
          busy={busyId === a.id}
          onApply={() => onApply(a)}
          onDismiss={() => onDismiss(a.id)}
        />
      ))}
    </div>
  );
}

function AlertCard({
  alert, busy, onApply, onDismiss,
}: {
  alert: ScheduleAlert;
  busy: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const dept = asDeptKey(alert.department);
  const m = deptMeta[dept];
  const date = alert.alertDate;
  const isRed = alert.severity === 'red';
  const pct = (alert.context as { pctOfDemand?: number }).pctOfDemand;
  const wageDataPending = (alert.context as { wageDataPending?: boolean }).wageDataPending === true;

  const bg = isRed ? 'rgba(160,74,44,0.08)' : 'rgba(201,150,68,0.10)';
  const br = isRed ? 'rgba(160,74,44,0.35)' : 'rgba(140,106,51,0.35)';
  const accent = isRed ? T.red : '#8C6A33';

  const headline = useMemo(() => {
    const action = alert.suggestedAction === 'add_shift' ? 'short staffed' : 'over staffed';
    const pctLabel = typeof pct === 'number' ? ` (${pct}% of demand)` : '';
    return `${niceDate(date)} · ${m.label}: ${action}${pctLabel}`;
  }, [alert.suggestedAction, date, m.label, pct]);

  const detail = useMemo(() => {
    if (alert.suggestedAction === 'add_shift') {
      return `Demand ${minutesToHours(alert.demandMinutes)} vs. ${minutesToHours(alert.scheduledMinutes)} scheduled.`;
    }
    const savings = alert.suggestedSavingsCents;
    if (typeof savings === 'number' && savings > 0) {
      return `Releasing 1 shift saves ~$${(savings / 100).toFixed(2)}.${wageDataPending ? ' (wage data pending — set wages in Staff directory.)' : ''}`;
    }
    if (wageDataPending) {
      return 'Releasing 1 shift saves an estimated amount. (wage data pending — set wages in Staff directory.)';
    }
    return 'Demand dropped — consider releasing a shift.';
  }, [alert, wageDataPending]);

  const applyLabel = alert.suggestedAction === 'add_shift' ? 'Add shift' : 'Release shift';

  return (
    <div
      style={{
        padding: '12px 16px', display: 'flex', gap: 12, alignItems: 'center',
        background: bg, border: `1px solid ${br}`, borderRadius: 12, flexWrap: 'wrap',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8, height: 8, borderRadius: '50%', background: accent, flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{
          fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: T.ink,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <Caps c={accent} size={9} tracking="0.10em">
            {isRed ? 'URGENT' : 'HEADS-UP'}
          </Caps>
          <span>{headline}</span>
        </div>
        <div style={{
          marginTop: 3, fontFamily: fonts.sans, fontSize: 12, color: T.ink2,
        }}>{detail}</div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Btn variant="ghost" size="sm" onClick={onDismiss} disabled={busy}>Dismiss</Btn>
        <Btn variant="primary" size="sm" onClick={onApply} disabled={busy}>
          {busy ? '…' : applyLabel}
        </Btn>
      </div>
    </div>
  );
}

function minutesToHours(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return '0h';
  const h = Math.round((m / 60) * 10) / 10;
  return `${h}h`;
}

function niceDate(yyyymmdd: string): string {
  // YYYY-MM-DD → "Fri Oct 30"
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd);
  if (!m) return yyyymmdd;
  const d = new Date(`${yyyymmdd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return yyyymmdd;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
