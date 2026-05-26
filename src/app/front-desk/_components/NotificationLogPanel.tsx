'use client';

/**
 * NotificationLogPanel — latest coordination dispatches for the
 * property. Manager-tier only (the API returns 403 otherwise; the
 * panel is conditionally rendered by the page based on the same
 * gate so non-managers don't see an unfillable surface).
 *
 * Refresh: 10s polling, matched to the API's rate-limit headroom.
 * Pure poll — we do NOT realtime-subscribe because notification_events
 * is service-role-only by design.
 *
 * Also feeds the SmsDryRunIndicator: every fetch returns the property's
 * current mode, so the badge stays accurate without a separate request.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth } from '@/lib/api-fetch';

export interface NotificationEvent {
  id: string;
  eventType: string;
  recipientStaffId: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  body: string;
  payload: Record<string, unknown>;
  mode: 'dry_run' | 'live';
  wouldHaveSentAt: string;
  providerStatus: string | null;
  errorText: string | null;
}

interface ApiPayload {
  ok: boolean;
  data?: {
    mode: 'dry_run' | 'live';
    events: NotificationEvent[];
  };
  error?: string;
  code?: string;
}

function eventTypeLabel(t: string, lang: 'en' | 'es'): string {
  if (lang === 'es') {
    switch (t) {
      case 'room_ready':   return 'Habitación lista';
      case 'vip_arrival':  return 'Llegada VIP';
      case 'room_move':    return 'Movimiento de habitación';
      case 'walk_in':      return 'Llegada sin reserva';
      case 'rush':         return 'Urgente';
      default:             return t;
    }
  }
  switch (t) {
    case 'room_ready':   return 'Room ready';
    case 'vip_arrival':  return 'VIP arrival';
    case 'room_move':    return 'Room move';
    case 'walk_in':      return 'Walk-in';
    case 'rush':         return 'Rush';
    default:             return t;
  }
}

function formatRelative(iso: string, lang: 'en' | 'es', now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diffMs = now - t;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 30) return lang === 'es' ? 'ahora' : 'just now';
  if (sec < 60) return lang === 'es' ? `hace ${sec}s` : `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return lang === 'es' ? `hace ${min} min` : `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return lang === 'es' ? `hace ${hr} h` : `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return lang === 'es' ? `hace ${d}d` : `${d}d ago`;
}

export interface NotificationLogPanelProps {
  propertyId: string;
  /** Bubbles the resolved mode up to the page so the badge can render. */
  onModeChange?: (mode: 'dry_run' | 'live') => void;
}

export function NotificationLogPanel({
  propertyId, onModeChange,
}: NotificationLogPanelProps) {
  const { lang } = useLang();
  const [events, setEvents] = useState<NotificationEvent[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetchWithAuth(
        `/api/front-desk/notification-log?pid=${encodeURIComponent(propertyId)}&limit=10`,
      );
      if (res.status === 403) {
        setForbidden(true);
        setLoading(false);
        return;
      }
      const body: ApiPayload = await res.json().catch(() => ({ ok: false } as ApiPayload));
      if (!res.ok || !body.ok || !body.data) {
        setError(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
        return;
      }
      setEvents(body.data.events);
      setError(null);
      if (onModeChange) onModeChange(body.data.mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [propertyId, onModeChange]);

  useEffect(() => {
    void refetch();
    const id = window.setInterval(() => { void refetch(); }, 10_000);
    return () => window.clearInterval(id);
  }, [refetch]);

  if (forbidden) {
    // Don't render anything if the viewer isn't manager-tier — the
    // panel is part of the manager UX, not the front-desk operator UX.
    return null;
  }

  return (
    <section style={{
      padding: '18px 22px', borderRadius: '20px',
      background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
      border: '1px solid #d5d2ca',
      marginTop: '8px', marginBottom: '24px',
      fontFamily: 'Inter, sans-serif',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span className="material-symbols-outlined" style={{ fontSize: '20px', color: '#364262' }}>
            forum
          </span>
          <span style={{ fontSize: '14px', fontWeight: 700, color: '#1b1c19' }}>
            {lang === 'es' ? 'Registro de notificaciones' : 'Notification log'}
          </span>
        </div>
        <span style={{ fontSize: '11px', color: '#757684' }}>
          {lang === 'es' ? 'Actualizado cada 10s' : 'Updates every 10s'}
        </span>
      </div>

      {loading && events.length === 0 && (
        <p style={{ margin: 0, fontSize: '13px', color: '#757684' }}>
          {lang === 'es' ? 'Cargando…' : 'Loading…'}
        </p>
      )}

      {!loading && error && (
        <p style={{ margin: 0, fontSize: '13px', color: '#ba1a1a' }}>
          {error}
        </p>
      )}

      {!loading && !error && events.length === 0 && (
        <p style={{ margin: 0, fontSize: '13px', color: '#757684' }}>
          {lang === 'es'
            ? 'Aún no se ha enviado ninguna notificación hoy.'
            : 'No coordination notifications have fired yet today.'}
        </p>
      )}

      {events.length > 0 && (
        <ul style={{
          listStyle: 'none', padding: 0, margin: 0,
          display: 'flex', flexDirection: 'column', gap: '8px',
        }}>
          {events.map((e) => (
            <li key={e.id} style={{
              padding: '10px 14px', borderRadius: '14px',
              background: e.mode === 'live' ? 'rgba(0,101,101,0.05)' : 'rgba(54,66,98,0.05)',
              border: `1px solid ${e.mode === 'live' ? 'rgba(0,101,101,0.18)' : 'rgba(54,66,98,0.18)'}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <span style={{
                  fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: e.mode === 'live' ? '#006565' : '#364262',
                }}>
                  {eventTypeLabel(e.eventType, lang === 'es' ? 'es' : 'en')}
                </span>
                <span style={{ fontSize: '10px', fontWeight: 700, color: '#fff',
                               background: e.mode === 'live' ? '#006565' : '#364262',
                               borderRadius: '9999px', padding: '1px 8px' }}>
                  {e.mode === 'live'
                    ? (lang === 'es' ? 'EN VIVO' : 'LIVE')
                    : (lang === 'es' ? 'PRUEBA' : 'TEST')}
                </span>
                <span style={{ fontSize: '11px', color: '#757684', marginLeft: 'auto' }}>
                  {formatRelative(e.wouldHaveSentAt, lang === 'es' ? 'es' : 'en')}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: '13px', color: '#1b1c19' }}>
                {e.body}
              </p>
              <div style={{ fontSize: '11px', color: '#454652', marginTop: '4px' }}>
                {e.recipientName
                  ? (lang === 'es' ? `Destinatario: ${e.recipientName}` : `To: ${e.recipientName}`)
                  : (lang === 'es' ? 'Sin destinatarios en turno' : 'No recipients on shift')}
                {e.providerStatus && ` · ${e.providerStatus}`}
                {e.errorText && ` · ${e.errorText}`}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
