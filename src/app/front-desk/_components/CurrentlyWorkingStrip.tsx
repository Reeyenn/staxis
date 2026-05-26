'use client';

/**
 * Pinned strip showing the front-desk staff currently on shift.
 *
 *   - Reads from GET /api/front-desk/currently-working (mediates the
 *     RLS-restricted scheduled_shifts + staff tables via supabaseAdmin).
 *   - Polls every 60s — shift rollover is the only event that changes
 *     the list, and a fresh fetch in <1min after that is fine.
 *   - Phone numbers render only if the API said `viewerCanSeePhones`
 *     (manager / GM / owner / admin). Front-desk staff see colleague
 *     names + shift windows but not the actual phone string.
 *   - Empty state is visible to manager-tier — "No one is currently
 *     scheduled" calls attention to a scheduling gap.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth } from '@/lib/api-fetch';

interface CurrentlyWorkingStaffRow {
  staffId: string;
  name: string;
  phone: string | null;
  shiftStartTime: string;
  shiftEndTime: string;
  shiftId: string;
  secondsUntilShiftEnd: number;
}

interface ApiPayload {
  ok: boolean;
  data?: {
    staff: CurrentlyWorkingStaffRow[];
    viewerCanSeePhones: boolean;
    generatedAt: string;
  };
}

function formatShiftEndDuration(seconds: number, lang: 'en' | 'es'): string {
  if (seconds <= 0) return lang === 'es' ? 'termina ahora' : 'ending now';
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) {
    return lang === 'es' ? `termina en ${m}m` : `ends in ${m}m`;
  }
  if (m === 0) {
    return lang === 'es' ? `termina en ${h}h` : `ends in ${h}h`;
  }
  return lang === 'es' ? `termina en ${h}h ${m}m` : `ends in ${h}h ${m}m`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

export interface CurrentlyWorkingStripProps {
  propertyId: string;
  /** If true, render the manager-only "no one scheduled" empty banner. */
  viewerIsManager: boolean;
}

export function CurrentlyWorkingStrip({
  propertyId, viewerIsManager,
}: CurrentlyWorkingStripProps) {
  const { lang } = useLang();
  const [rows, setRows] = useState<CurrentlyWorkingStaffRow[]>([]);
  const [canSeePhones, setCanSeePhones] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetchWithAuth(
        `/api/front-desk/currently-working?pid=${encodeURIComponent(propertyId)}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: ApiPayload = await res.json();
      if (!body.ok || !body.data) throw new Error('bad envelope');
      setRows(body.data.staff);
      setCanSeePhones(body.data.viewerCanSeePhones);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    void refetch();
    const id = window.setInterval(() => { void refetch(); }, 60_000);
    return () => window.clearInterval(id);
  }, [refetch]);

  // Loading shimmer — keep small to not push the room grid down.
  if (loading) {
    return (
      <div style={{
        padding: '14px 20px', borderRadius: '20px',
        background: 'rgba(255,255,255,0.6)', border: '1px solid #d5d2ca',
        marginBottom: '20px',
        fontFamily: 'Inter, sans-serif', color: '#757684', fontSize: '13px',
      }}>
        {lang === 'es' ? 'Cargando recepcionistas en turno…' : 'Loading front-desk staff on shift…'}
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        padding: '12px 20px', borderRadius: '20px',
        background: 'rgba(186,26,26,0.06)', border: '1px solid rgba(186,26,26,0.18)',
        marginBottom: '20px',
        fontFamily: 'Inter, sans-serif', color: '#ba1a1a', fontSize: '13px',
      }}>
        {lang === 'es'
          ? `No se pudo cargar el equipo de recepción (${error})`
          : `Couldn't load the front-desk roster (${error})`}
      </div>
    );
  }

  if (rows.length === 0) {
    if (!viewerIsManager) {
      // Front-desk-only viewer: hide the empty strip so the page doesn't
      // surface scheduling gaps to non-managers.
      return null;
    }
    return (
      <div style={{
        padding: '14px 20px', borderRadius: '20px',
        background: 'rgba(54,66,98,0.06)', border: '1px dashed #d5d2ca',
        marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px',
        fontFamily: 'Inter, sans-serif', color: '#454652', fontSize: '13px',
      }}>
        <span className="material-symbols-outlined" style={{ fontSize: '18px', color: '#757684' }}>
          person_off
        </span>
        <span>
          {lang === 'es'
            ? 'Nadie está programado en recepción ahora mismo.'
            : 'No one is scheduled at the front desk right now.'}
        </span>
      </div>
    );
  }

  return (
    <div style={{
      padding: '14px 20px', borderRadius: '20px',
      background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
      border: '1px solid #d5d2ca', marginBottom: '20px',
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px 16px',
      fontFamily: 'Inter, sans-serif',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#006565' }}>
        <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>
          contact_emergency
        </span>
        <span style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
          {lang === 'es' ? 'En recepción ahora' : 'At front desk now'}
        </span>
      </div>
      {rows.map((s) => (
        <div key={s.staffId} style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '6px 12px 6px 6px', borderRadius: '9999px',
          background: 'rgba(0,101,101,0.06)',
        }}>
          <div style={{
            width: '32px', height: '32px', borderRadius: '50%',
            background: '#006565', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '12px', fontWeight: 700, letterSpacing: '0.04em',
          }}>
            {initials(s.name)}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#1b1c19' }}>
              {s.name}
            </span>
            <span style={{ fontSize: '11px', color: '#454652' }}>
              {s.shiftStartTime.slice(0, 5)}–{s.shiftEndTime.slice(0, 5)}
              {' · '}
              {formatShiftEndDuration(s.secondsUntilShiftEnd, lang === 'es' ? 'es' : 'en')}
            </span>
            {canSeePhones && s.phone && (
              <span style={{ fontSize: '11px', color: '#757684', fontFamily: "'JetBrains Mono', monospace" }}>
                {s.phone}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
