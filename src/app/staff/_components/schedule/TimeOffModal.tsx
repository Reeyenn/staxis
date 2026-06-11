// TimeOffModal — pending time-off requests with one-tap Approve / Deny.
//
// Opened from the "N TIME-OFF REQUESTS PENDING" label in Day view. Carries
// forward the old schedule grid's approve/deny workflow (staff submit from
// My Shifts; decisions go through PUT /api/staff-schedule/time-off, and the
// realtime subscription refreshes the list + removes any auto-deleted
// shift). Shows the last few decided requests underneath for context.

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import type { StaffMember, TimeOffRequest } from '@/types';
import { dayInfo } from '@/lib/schedule-board';
import { T, fonts, Caps, Btn } from '../_tokens';
import { Avatar } from '../_people';

export function TimeOffModal({
  pending, decided, staff, today, lang, onDecide, onClose,
}: {
  pending: TimeOffRequest[];
  decided: TimeOffRequest[];
  staff: StaffMember[];
  today: string;
  lang: 'en' | 'es';
  onDecide: (id: string, decision: 'approve' | 'deny', denyReason?: string) => Promise<void>;
  onClose: () => void;
}) {
  const es = lang === 'es';
  const [busyId, setBusyId] = useState<string | null>(null);
  const [denyFor, setDenyFor] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of staff) m.set(s.id, s.name);
    return m;
  }, [staff]);

  const fmtDate = (ymd: string) => {
    const d = dayInfo(ymd, today, lang);
    return es ? `${d.dowFull} ${d.dayNum} ${d.mon}` : `${d.dowFull}, ${d.mon} ${d.dayNum}`;
  };

  const decide = async (r: TimeOffRequest, decision: 'approve' | 'deny', reason?: string) => {
    setBusyId(r.id);
    setErrorMsg(null);
    try {
      await onDecide(r.id, decision, reason);
      setDenyFor(null);
      setDenyReason('');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : (es ? 'No se pudo actualizar' : 'Update failed'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(31,35,28,0.42)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20, fontFamily: fonts.sans,
      }}
    >
      <div onClick={e => e.stopPropagation()} style={{
        background: T.paper, borderRadius: 22, width: '100%', maxWidth: 480,
        maxHeight: '82vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 24px 70px -10px rgba(31,35,28,0.34), 0 0 0 1px rgba(31,35,28,0.04)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
          padding: '22px 24px 14px', borderBottom: `1px solid ${T.rule}`,
        }}>
          <div>
            <Caps>{es ? 'Tiempo libre' : 'Time off'}</Caps>
            <h2 style={{
              margin: '3px 0 0', fontFamily: fonts.serif, fontSize: 24, fontStyle: 'italic',
              fontWeight: 400, letterSpacing: '-0.02em', color: T.ink,
            }}>{es ? 'Solicitudes pendientes' : 'Pending requests'}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent', border: `1px solid ${T.rule}`, borderRadius: '50%',
              width: 30, height: 30, cursor: 'pointer', color: T.ink2, fontSize: 16, flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}
          >×</button>
        </div>

        <div style={{ overflowY: 'auto' }}>
          {pending.length === 0 ? (
            <div style={{ padding: '22px 24px', fontSize: 13, color: T.ink3 }}>
              {es ? 'No hay solicitudes pendientes.' : 'No pending requests.'}
            </div>
          ) : pending.map(r => {
            const name = nameById.get(r.staffId) ?? (es ? 'Personal' : 'Staff');
            const isDenying = denyFor === r.id;
            const busy = busyId === r.id;
            return (
              <div key={r.id} style={{
                padding: '13px 24px', borderBottom: `1px solid ${T.ruleSoft}`,
                display: 'flex', flexDirection: 'column', gap: 8,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}>
                  <Avatar staffId={r.staffId} name={name} size={26}/>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: T.ink }}>{name}</span>
                    <span style={{ display: 'block', fontFamily: fonts.serif, fontSize: 14, fontStyle: 'italic', color: T.ink2 }}>
                      {fmtDate(r.requestDate)}
                      {r.reason && <span style={{ fontFamily: fonts.sans, fontStyle: 'normal', fontSize: 12, color: T.ink3 }}> — “{r.reason}”</span>}
                    </span>
                  </span>
                  <span style={{ flex: 1 }}/>
                  {!isDenying && (
                    <>
                      <Btn variant="ghost" size="sm" onClick={() => { setDenyFor(r.id); setDenyReason(''); }} disabled={busy}>
                        {es ? 'Rechazar' : 'Deny'}
                      </Btn>
                      <Btn variant="sage" size="sm" onClick={() => decide(r, 'approve')} disabled={busy}>
                        {busy ? '…' : es ? '✓ Aprobar' : '✓ Approve'}
                      </Btn>
                    </>
                  )}
                </div>
                {isDenying && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      autoFocus
                      value={denyReason}
                      onChange={e => setDenyReason(e.target.value)}
                      placeholder={es ? 'Motivo (opcional)' : 'Reason (optional)'}
                      style={{
                        flex: 1, minWidth: 160, boxSizing: 'border-box',
                        padding: '8px 12px', borderRadius: 10, border: `1px solid ${T.rule}`,
                        background: T.paper, fontFamily: fonts.sans, fontSize: 12.5, color: T.ink, outline: 'none',
                      }}
                    />
                    <Btn variant="ghost" size="sm" onClick={() => { setDenyFor(null); setDenyReason(''); }} disabled={busyId === r.id}>
                      {es ? 'Cancelar' : 'Cancel'}
                    </Btn>
                    <Btn
                      variant="ghost" size="sm"
                      onClick={() => decide(r, 'deny', denyReason.trim() || undefined)}
                      disabled={busyId === r.id}
                      style={{ color: T.red, borderColor: 'rgba(160,74,44,0.30)' }}
                    >
                      {busyId === r.id ? '…' : es ? 'Confirmar rechazo' : 'Confirm deny'}
                    </Btn>
                  </div>
                )}
              </div>
            );
          })}

          {decided.length > 0 && (
            <div style={{ background: '#FCFBF8', borderTop: `1px solid ${T.rule}` }}>
              <div style={{ padding: '10px 24px 4px' }}>
                <Caps size={9}>{es ? 'Decididas hace poco' : 'Recently decided'}</Caps>
              </div>
              {decided.map(r => {
                const name = nameById.get(r.staffId) ?? (es ? 'Personal' : 'Staff');
                const approved = r.status === 'approved';
                return (
                  <div key={r.id} style={{
                    padding: '8px 24px', display: 'flex', alignItems: 'center', gap: 10,
                    fontSize: 12, color: T.ink2, borderBottom: `1px solid ${T.ruleSoft}`,
                  }}>
                    <span style={{ fontWeight: 600, color: T.ink }}>{name}</span>
                    <span>{fmtDate(r.requestDate)}</span>
                    <span style={{ flex: 1 }}/>
                    <span style={{
                      fontFamily: fonts.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
                      color: approved ? '#3F5A43' : T.red,
                      background: approved ? 'rgba(92,122,96,0.12)' : 'rgba(160,74,44,0.10)',
                      border: `1px solid ${approved ? 'rgba(92,122,96,0.30)' : 'rgba(160,74,44,0.30)'}`,
                      padding: '1px 7px', borderRadius: 999,
                    }}>{approved ? (es ? 'APROBADO' : 'APPROVED') : (es ? 'RECHAZADO' : 'DENIED')}</span>
                  </div>
                );
              })}
            </div>
          )}

          {errorMsg && (
            <div role="alert" style={{
              padding: '10px 24px', fontSize: 12.5, color: T.red,
              background: 'rgba(160,74,44,0.08)', borderTop: `1px solid ${T.rule}`,
            }}>{errorMsg}</div>
          )}
        </div>
      </div>
    </div>
  );
}
