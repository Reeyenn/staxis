'use client';

/**
 * "Walk-in" button + modal.
 *
 *   - Pinned at the top of the room grid, beside the rush controls.
 *   - Modal flow: room-type picker (from pms_rooms_inventory) → optional
 *     guest name + nights → "Find a room" → server picks next ready room.
 *   - Confirm screen shows the picked room number + the dispatch outcome
 *     so the operator sees the housekeeping ping that just went out.
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth } from '@/lib/api-fetch';

interface WalkInResultData {
  roomNumber: string;
  roomType: string;
  reservationId: string | null;
  readySince: string | null;
  source: 'pms' | 'rooms_fallback';
  dispatch: { mode: 'dry_run' | 'live'; outcomeCount: number };
}

export interface WalkInButtonProps {
  propertyId: string;
  today: string;
  /** Distinct room types from pms_rooms_inventory (page-derived). */
  availableRoomTypes: string[];
  onAssigned?: (roomNumber: string) => void;
}

export function WalkInButton({
  propertyId, today, availableRoomTypes, onAssigned,
}: WalkInButtonProps) {
  const { lang } = useLang();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'form' | 'result' | 'error'>('form');
  const [submitting, setSubmitting] = useState(false);
  const [roomType, setRoomType] = useState('');
  const [guestName, setGuestName] = useState('');
  const [nights, setNights] = useState(1);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [resultData, setResultData] = useState<WalkInResultData | null>(null);

  const types = useMemo(() => {
    const cleaned = Array.from(new Set(availableRoomTypes.filter(Boolean)));
    return cleaned.length > 0 ? cleaned : ['King', 'Queen', 'Suite', 'Accessible'];
  }, [availableRoomTypes]);

  useEffect(() => {
    // Pre-select the first type once the modal opens so "Find a room"
    // works without an explicit click on the picker — common short-circuit
    // when the lobby has one guest and one room type available.
    if (open && !roomType && types.length > 0) {
      setRoomType(types[0]);
    }
  }, [open, roomType, types]);

  const reset = useCallback(() => {
    setStep('form');
    setRoomType(types[0] ?? '');
    setGuestName('');
    setNights(1);
    setErrorMsg(null);
    setResultData(null);
    setSubmitting(false);
  }, [types]);

  const close = useCallback(() => {
    setOpen(false);
    reset();
  }, [reset]);

  const onFind = useCallback(async () => {
    if (!roomType || submitting) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetchWithAuth('/api/front-desk/walk-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pid: propertyId,
          today,
          roomType,
          guestName: guestName.trim() ? guestName.trim() : null,
          nights,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.ok) {
        const msg = body?.error ?? `HTTP ${res.status}`;
        setErrorMsg(typeof msg === 'string' ? msg : 'unknown_error');
        setStep('error');
        return;
      }
      setResultData(body.data as WalkInResultData);
      setStep('result');
      if (onAssigned) onAssigned((body.data as WalkInResultData).roomNumber);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStep('error');
    } finally {
      setSubmitting(false);
    }
  }, [roomType, guestName, nights, propertyId, today, submitting, onAssigned]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '8px',
          padding: '10px 18px', borderRadius: '9999px',
          background: '#006565', color: '#fff', border: 'none',
          cursor: 'pointer', fontWeight: 600, fontSize: '13px',
          fontFamily: 'Inter, sans-serif',
        }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
          person_add
        </span>
        {lang === 'es' ? 'Llegada sin reserva' : 'Walk-in'}
      </button>

      {open && (
        <>
          <div
            onClick={close}
            style={{
              position: 'fixed', inset: 0, zIndex: 1100,
              background: 'rgba(27,28,25,0.4)', backdropFilter: 'blur(8px)',
            }}
          />
          <div style={{
            position: 'fixed', zIndex: 1101,
            top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            width: 'min(420px, 92vw)', borderRadius: '24px',
            background: '#fbf9f4', padding: '20px 22px', boxShadow: '0 16px 48px rgba(0,0,0,0.16)',
            fontFamily: 'Inter, sans-serif',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#1b1c19' }}>
                {lang === 'es' ? 'Llegada sin reserva' : 'Walk-in arrival'}
              </h2>
              <button onClick={close} aria-label="close" style={{
                background: '#eae8e3', border: 'none', borderRadius: '50%',
                width: '30px', height: '30px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span className="material-symbols-outlined" style={{ fontSize: '18px', color: '#454652' }}>close</span>
              </button>
            </div>

            {step === 'form' && (
              <>
                <label style={{ display: 'block', marginBottom: '12px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
                    {lang === 'es' ? 'Tipo de habitación' : 'Room type'}
                  </span>
                  <select
                    value={roomType}
                    onChange={(e) => setRoomType(e.target.value)}
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: '12px',
                      border: '1px solid #d5d2ca', background: '#fff',
                      fontSize: '14px', fontFamily: 'inherit',
                    }}
                  >
                    {types.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>

                <label style={{ display: 'block', marginBottom: '12px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
                    {lang === 'es' ? 'Nombre del huésped (opcional)' : 'Guest name (optional)'}
                  </span>
                  <input
                    value={guestName}
                    onChange={(e) => setGuestName(e.target.value)}
                    maxLength={200}
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: '12px',
                      border: '1px solid #d5d2ca', background: '#fff',
                      fontSize: '14px', fontFamily: 'inherit',
                    }}
                  />
                </label>

                <label style={{ display: 'block', marginBottom: '20px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
                    {lang === 'es' ? 'Noches' : 'Nights'}
                  </span>
                  <input
                    type="number" min={1} max={30}
                    value={nights}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (Number.isFinite(v)) setNights(Math.max(1, Math.min(30, v)));
                    }}
                    style={{
                      width: '120px', padding: '10px 12px', borderRadius: '12px',
                      border: '1px solid #d5d2ca', background: '#fff',
                      fontSize: '14px', fontFamily: 'inherit',
                    }}
                  />
                </label>

                <button
                  onClick={() => { void onFind(); }}
                  disabled={!roomType || submitting}
                  style={{
                    width: '100%', padding: '14px',
                    background: submitting ? 'rgba(0,101,101,0.4)' : '#006565',
                    color: '#fff', border: 'none', borderRadius: '14px',
                    fontWeight: 600, fontSize: '14px', cursor: submitting ? 'not-allowed' : 'pointer',
                  }}
                >
                  {submitting
                    ? (lang === 'es' ? 'Buscando…' : 'Finding a room…')
                    : (lang === 'es' ? 'Buscar una habitación' : 'Find a room')}
                </button>
              </>
            )}

            {step === 'result' && resultData && (
              <div style={{ textAlign: 'center', padding: '12px 0' }}>
                <div style={{
                  display: 'inline-flex', padding: '14px 22px',
                  borderRadius: '20px', background: 'rgba(0,101,101,0.08)',
                  alignItems: 'center', gap: '10px', marginBottom: '14px',
                }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '22px', color: '#006565' }}>check_circle</span>
                  <span style={{ fontSize: '28px', fontWeight: 800, color: '#006565', letterSpacing: '-0.02em', fontFamily: "'JetBrains Mono', monospace" }}>
                    {resultData.roomNumber}
                  </span>
                </div>
                <p style={{ margin: '0 0 8px', fontSize: '14px', color: '#1b1c19' }}>
                  {lang === 'es'
                    ? `Habitación ${resultData.roomNumber} asignada (${resultData.roomType}).`
                    : `Room ${resultData.roomNumber} assigned (${resultData.roomType}).`}
                </p>
                <p style={{ margin: '0 0 16px', fontSize: '12px', color: '#757684' }}>
                  {resultData.dispatch.mode === 'dry_run'
                    ? (lang === 'es'
                        ? 'Notificación a limpieza registrada en el registro (modo prueba — sin SMS real).'
                        : 'Housekeeping ping logged (test mode — no real SMS).')
                    : (lang === 'es'
                        ? `SMS enviado a ${resultData.dispatch.outcomeCount} contacto(s) de limpieza.`
                        : `SMS sent to ${resultData.dispatch.outcomeCount} housekeeping contact(s).`)}
                </p>
                <button
                  onClick={close}
                  style={{
                    width: '100%', padding: '12px',
                    background: '#1b1c19', color: '#fff', border: 'none',
                    borderRadius: '12px', fontWeight: 600, fontSize: '14px', cursor: 'pointer',
                  }}
                >
                  {lang === 'es' ? 'Listo' : 'Done'}
                </button>
              </div>
            )}

            {step === 'error' && (
              <div>
                <div style={{
                  padding: '14px', borderRadius: '14px', marginBottom: '16px',
                  background: 'rgba(186,26,26,0.06)', border: '1px solid rgba(186,26,26,0.18)',
                  color: '#ba1a1a', fontSize: '13px',
                }}>
                  {errorMsg ?? (lang === 'es' ? 'Algo salió mal.' : 'Something went wrong.')}
                </div>
                <button onClick={reset} style={{
                  width: '100%', padding: '12px',
                  background: '#364262', color: '#fff', border: 'none',
                  borderRadius: '12px', fontWeight: 600, fontSize: '14px', cursor: 'pointer',
                }}>
                  {lang === 'es' ? 'Intentar de nuevo' : 'Try again'}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
