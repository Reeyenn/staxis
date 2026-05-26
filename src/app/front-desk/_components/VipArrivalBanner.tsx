'use client';

/**
 * VipArrivalBanner — pinned banner above the room grid when at least
 * one VIP arrival is expected today.
 *
 * Renders nothing when there are no VIP arrivals. Phone numbers and
 * guest names are redacted for non-manager viewers (initials only).
 *
 * Refresh: 60s polling. The arrival_time and room readiness can both
 * change throughout the day; 60s is responsive enough without being
 * chatty.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth } from '@/lib/api-fetch';

interface VipRow {
  reservationId: string;
  guestName: string | null;
  eta: string | null;
  roomNumber: string | null;
  amenityReady: boolean;
  source: string;
}

interface ApiPayload {
  ok: boolean;
  data?: {
    vips: VipRow[];
    viewerIsManager: boolean;
    generatedAt: string;
  };
}

export interface VipArrivalBannerProps {
  propertyId: string;
  today: string;
}

export function VipArrivalBanner({ propertyId, today }: VipArrivalBannerProps) {
  const { lang } = useLang();
  const [rows, setRows] = useState<VipRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const res = await fetchWithAuth(
        `/api/front-desk/vip-arrivals?pid=${encodeURIComponent(propertyId)}&today=${encodeURIComponent(today)}`,
      );
      if (!res.ok) {
        setRows([]);
        return;
      }
      const body: ApiPayload = await res.json();
      if (body.ok && body.data) {
        setRows(body.data.vips);
      } else {
        setRows([]);
      }
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [propertyId, today]);

  useEffect(() => {
    void refetch();
    const id = window.setInterval(() => { void refetch(); }, 60_000);
    return () => window.clearInterval(id);
  }, [refetch]);

  if (loading || rows.length === 0) return null;

  return (
    <div style={{
      padding: '16px 22px', borderRadius: '20px',
      marginBottom: '20px',
      background: 'linear-gradient(135deg, rgba(0,101,101,0.08), rgba(0,101,101,0.03))',
      border: '1px solid rgba(0,101,101,0.25)',
      fontFamily: 'Inter, sans-serif',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
        <span className="material-symbols-outlined" style={{ fontSize: '20px', color: '#006565' }}>
          star
        </span>
        <span style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#006565' }}>
          {rows.length === 1
            ? (lang === 'es' ? 'Llegada VIP hoy' : 'VIP arriving today')
            : (lang === 'es' ? `${rows.length} llegadas VIP hoy` : `${rows.length} VIP arrivals today`)}
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 18px' }}>
        {rows.map((v) => (
          <div key={v.reservationId} style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '8px 14px', borderRadius: '14px',
            background: 'rgba(255,255,255,0.6)',
            border: '1px solid rgba(0,101,101,0.18)',
          }}>
            {v.roomNumber && (
              <span style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: '15px',
                fontWeight: 700, color: '#1b1c19', letterSpacing: '-0.02em',
              }}>
                {v.roomNumber}
              </span>
            )}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {v.guestName && (
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#1b1c19' }}>
                  {v.guestName}
                </span>
              )}
              <span style={{ fontSize: '11px', color: '#454652' }}>
                {v.eta ? (lang === 'es' ? `Llega ${v.eta.slice(0, 5)}` : `ETA ${v.eta.slice(0, 5)}`) : (lang === 'es' ? 'Llegada hoy' : 'Today')}
                {' · '}
                {v.amenityReady
                  ? (lang === 'es' ? '✓ Listo' : '✓ Ready')
                  : (lang === 'es' ? 'Pendiente' : 'Pending')}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
