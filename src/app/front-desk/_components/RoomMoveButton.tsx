'use client';

/**
 * RoomMoveButton — opens from an occupied room's detail menu.
 *
 * Renders as a menu item-style button so the parent room-detail modal
 * can show it inline with "Early Checkout" / "Mark Extension" / etc.
 *
 * Click → opens a small dedicated modal:
 *   - picker of OTHER rooms in the same type group with status=clean
 *   - reason radio (maintenance / guest_request / upgrade / other)
 *   - optional note (up to 500 chars)
 *   - confirm POSTs /api/front-desk/room-move
 *
 * Available target rooms are passed in by the parent (the page already
 * has the full room list — pushing the lookup down keeps the modal
 * cheap).
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { Room } from '@/types';

type Reason = 'maintenance' | 'guest_request' | 'upgrade' | 'other';

export interface RoomMoveButtonProps {
  propertyId: string;
  today: string;
  fromRoom: Room;
  /** All rooms on the page (same date). Caller passes the unfiltered list. */
  allRooms: Room[];
  /** Notify the parent that the room-detail modal should close. */
  onMoved?: (fromRoom: string, toRoom: string) => void;
}

export function RoomMoveButton({
  propertyId, today, fromRoom, allRooms, onMoved,
}: RoomMoveButtonProps) {
  const { lang } = useLang();
  const [open, setOpen] = useState(false);
  const [toRoom, setToRoom] = useState<string>('');
  const [reason, setReason] = useState<Reason>('guest_request');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Available targets = clean/inspected rooms with a different number.
  // We don't enforce a "same room type" rule here because the front-desk
  // operator sometimes upgrades the guest deliberately.
  const candidates = useMemo(() => {
    return allRooms
      .filter((r) => r.number !== fromRoom.number)
      .filter((r) => r.status === 'clean' || r.status === 'inspected')
      .sort((a, b) => a.number.localeCompare(b.number));
  }, [allRooms, fromRoom.number]);

  const close = useCallback(() => {
    setOpen(false);
    setToRoom('');
    setReason('guest_request');
    setNote('');
    setSubmitting(false);
    setErrorMsg(null);
  }, []);

  const onConfirm = useCallback(async () => {
    if (!toRoom || submitting) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetchWithAuth('/api/front-desk/room-move', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pid: propertyId,
          today,
          fromRoom: fromRoom.number,
          toRoom,
          reason,
          note: note.trim() ? note.trim() : null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.ok) {
        setErrorMsg(typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`);
        return;
      }
      if (onMoved) onMoved(fromRoom.number, toRoom);
      close();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [toRoom, reason, note, submitting, propertyId, today, fromRoom.number, onMoved, close]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{
          padding: '16px 18px',
          background: 'transparent',
          color: '#454652', border: '1px solid #d5d2ca',
          borderRadius: '9999px',
          fontWeight: 600, fontSize: '15px', cursor: 'pointer',
          fontFamily: 'Inter, sans-serif',
          display: 'inline-flex', alignItems: 'center', gap: '8px',
        }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>swap_horiz</span>
        {lang === 'es' ? 'Mover huésped' : 'Move guest'}
      </button>

      {open && (
        <>
          <div
            onClick={close}
            style={{
              position: 'fixed', inset: 0, zIndex: 1200,
              background: 'rgba(27,28,25,0.4)', backdropFilter: 'blur(8px)',
            }}
          />
          <div style={{
            position: 'fixed', zIndex: 1201,
            top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            width: 'min(440px, 92vw)', borderRadius: '24px',
            background: '#fbf9f4', padding: '20px 22px', boxShadow: '0 16px 48px rgba(0,0,0,0.16)',
            fontFamily: 'Inter, sans-serif', maxHeight: '85vh', overflowY: 'auto',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#1b1c19' }}>
                {lang === 'es'
                  ? `Mover huésped de la ${fromRoom.number}`
                  : `Move guest from ${fromRoom.number}`}
              </h2>
              <button onClick={close} aria-label="close" style={{
                background: '#eae8e3', border: 'none', borderRadius: '50%',
                width: '30px', height: '30px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span className="material-symbols-outlined" style={{ fontSize: '18px', color: '#454652' }}>close</span>
              </button>
            </div>

            <label style={{ display: 'block', marginBottom: '14px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
                {lang === 'es' ? 'Nueva habitación' : 'New room'}
              </span>
              <select
                value={toRoom}
                onChange={(e) => setToRoom(e.target.value)}
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: '12px',
                  border: '1px solid #d5d2ca', background: '#fff',
                  fontSize: '14px', fontFamily: 'inherit',
                }}
              >
                <option value="">{lang === 'es' ? '— Elegir —' : '— Pick a room —'}</option>
                {candidates.map((r) => (
                  <option key={r.id} value={r.number}>
                    {r.number}
                  </option>
                ))}
              </select>
              {candidates.length === 0 && (
                <span style={{ display: 'block', marginTop: '6px', fontSize: '11px', color: '#ba1a1a' }}>
                  {lang === 'es'
                    ? 'No hay habitaciones limpias disponibles ahora.'
                    : 'No clean rooms are available right now.'}
                </span>
              )}
            </label>

            <fieldset style={{ border: 'none', padding: 0, margin: '0 0 14px' }}>
              <legend style={{ fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px' }}>
                {lang === 'es' ? 'Motivo' : 'Reason'}
              </legend>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {(['maintenance', 'guest_request', 'upgrade', 'other'] as Reason[]).map((r) => (
                  <label key={r} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#1b1c19' }}>
                    <input
                      type="radio" name="rm-reason"
                      checked={reason === r} onChange={() => setReason(r)}
                    />
                    {labelForReason(r, lang)}
                  </label>
                ))}
              </div>
            </fieldset>

            <label style={{ display: 'block', marginBottom: '18px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
                {lang === 'es' ? 'Nota (opcional)' : 'Note (optional)'}
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                rows={3}
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: '12px',
                  border: '1px solid #d5d2ca', background: '#fff',
                  fontSize: '14px', fontFamily: 'inherit', resize: 'vertical',
                }}
              />
            </label>

            {errorMsg && (
              <div style={{
                padding: '10px 12px', borderRadius: '12px', marginBottom: '12px',
                background: 'rgba(186,26,26,0.06)', color: '#ba1a1a', fontSize: '12px',
                border: '1px solid rgba(186,26,26,0.18)',
              }}>
                {errorMsg}
              </div>
            )}

            <button
              onClick={() => { void onConfirm(); }}
              disabled={!toRoom || submitting}
              style={{
                width: '100%', padding: '14px',
                background: !toRoom || submitting ? 'rgba(54,66,98,0.4)' : '#364262',
                color: '#fff', border: 'none', borderRadius: '14px',
                fontWeight: 600, fontSize: '14px',
                cursor: !toRoom || submitting ? 'not-allowed' : 'pointer',
              }}
            >
              {submitting
                ? (lang === 'es' ? 'Moviendo…' : 'Moving…')
                : (lang === 'es'
                  ? `Confirmar movimiento a ${toRoom || '—'}`
                  : `Confirm move to ${toRoom || '—'}`)}
            </button>
          </div>
        </>
      )}
    </>
  );
}

function labelForReason(r: Reason, lang: string): string {
  if (lang === 'es') {
    switch (r) {
      case 'maintenance':  return 'Mantenimiento';
      case 'guest_request': return 'Pedido del huésped';
      case 'upgrade':      return 'Ascenso';
      case 'other':        return 'Otro';
    }
  }
  switch (r) {
    case 'maintenance':  return 'Maintenance issue';
    case 'guest_request': return 'Guest request';
    case 'upgrade':      return 'Upgrade';
    case 'other':        return 'Other';
  }
}
