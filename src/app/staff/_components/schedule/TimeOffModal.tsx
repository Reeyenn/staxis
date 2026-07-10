// Time off — inline section at the bottom of Day view (pending requests
// with one-tap Approve / Deny) + a History popup for past decisions.
//
// Staff submit from My Shifts; decisions go through PUT
// /api/staff-schedule/time-off, and the realtime subscription refreshes
// the list (approval also auto-removes any shift on that date).

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import type { StaffMember, TimeOffRequest } from '@/types';
import { dayInfo } from '@/lib/schedule-board';
import { T, fonts, Caps, Btn } from '../_tokens';
import { Avatar } from '../_people';

function useNameById(staff: StaffMember[]) {
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const s of staff) m.set(s.id, s.name);
    return m;
  }, [staff]);
}

function useFmtDate(today: string, lang: 'en' | 'es') {
  const es = lang === 'es';
  return (ymd: string) => {
    const d = dayInfo(ymd, today, lang);
    return es ? `${d.dowFull} ${d.dayNum} ${d.mon}` : `${d.dowFull}, ${d.mon} ${d.dayNum}`;
  };
}

// ── inline pending-requests section (bottom-left of Day view) ──────────────
export function TimeOffSection({
  pending, decidedCount, staff, today, lang, onDecide, onOpenHistory,
}: {
  pending: TimeOffRequest[];
  decidedCount: number;
  staff: StaffMember[];
  today: string;
  lang: 'en' | 'es';
  onDecide: (id: string, decision: 'approve' | 'deny', denyReason?: string) => Promise<void>;
  onOpenHistory: () => void;
}) {
  const es = lang === 'es';
  const [busyId, setBusyId] = useState<string | null>(null);
  const [denyFor, setDenyFor] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const nameById = useNameById(staff);
  const fmtDate = useFmtDate(today, lang);

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
    <div style={{
      border: `1px solid ${T.rule}`, borderRadius: 16, background: T.paper, overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px',
        background: 'rgba(31,35,28,0.03)', borderBottom: `1px solid ${T.rule}`,
      }}>
        <Caps size={9}>{es ? 'Tiempo libre' : 'Time off'}</Caps>
        <span style={{
          fontFamily: fonts.mono, fontSize: 9.5, fontWeight: 700,
          color: pending.length > 0 ? T.caramelDeep : T.ink3,
          background: pending.length > 0 ? 'rgba(201,150,68,0.16)' : 'rgba(31,35,28,0.04)',
          border: `1px solid ${pending.length > 0 ? 'rgba(140,106,51,0.32)' : T.rule}`,
          padding: '1px 8px', borderRadius: 999,
        }}>{pending.length} {es ? `pendiente${pending.length === 1 ? '' : 's'}` : 'pending'}</span>
        <span style={{ flex: 1 }}/>
        {decidedCount > 0 && (
          <Btn variant="ghost" size="sm" onClick={onOpenHistory}>{es ? 'Historial' : 'History'}</Btn>
        )}
      </div>

      {pending.length === 0 ? (
        <div style={{ padding: '12px 16px', fontSize: 12.5, color: T.ink3 }}>
          {es ? 'No hay solicitudes pendientes.' : 'No pending requests.'}
        </div>
      ) : pending.map(r => {
        const name = nameById.get(r.staffId) ?? (es ? 'Personal' : 'Staff');
        const isDenying = denyFor === r.id;
        const busy = busyId === r.id;
        return (
          <div key={r.id} style={{
            padding: '11px 16px', borderBottom: `1px solid ${T.ruleSoft}`,
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Avatar staffId={r.staffId} name={name} size={24}/>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: T.ink }}>{name}</span>
                <span style={{ display: 'block', fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, letterSpacing: '-0.02em', color: T.ink2 }}>
                  {fmtDate(r.requestDate)}
                  {r.reason && <span style={{ fontFamily: fonts.sans, fontWeight: 400, letterSpacing: 0, fontSize: 11.5, color: T.ink3 }}> — “{r.reason}”</span>}
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
                    flex: 1, minWidth: 140, boxSizing: 'border-box',
                    padding: '8px 12px', borderRadius: 10, border: `1px solid ${T.rule}`,
                    background: T.paper, fontFamily: fonts.sans, fontSize: 12.5, color: T.ink, outline: 'none',
                  }}
                />
                <Btn variant="ghost" size="sm" onClick={() => { setDenyFor(null); setDenyReason(''); }} disabled={busy}>
                  {es ? 'Cancelar' : 'Cancel'}
                </Btn>
                <Btn
                  variant="ghost" size="sm"
                  onClick={() => decide(r, 'deny', denyReason.trim() || undefined)}
                  disabled={busy}
                  style={{ color: T.red, borderColor: 'rgba(184,92,61,0.30)' }}
                >
                  {busy ? '…' : es ? 'Confirmar' : 'Confirm deny'}
                </Btn>
              </div>
            )}
          </div>
        );
      })}

      {errorMsg && (
        <div role="alert" style={{
          padding: '9px 16px', fontSize: 12, color: T.red,
          background: 'rgba(184,92,61,0.08)', borderTop: `1px solid ${T.rule}`,
        }}>{errorMsg}</div>
      )}
    </div>
  );
}

// ── history popup (past requests) ───────────────────────────────────────────
export function TimeOffHistoryModal({
  decided, staff, today, lang, onClose,
}: {
  decided: TimeOffRequest[];
  staff: StaffMember[];
  today: string;
  lang: 'en' | 'es';
  onClose: () => void;
}) {
  const es = lang === 'es';
  const nameById = useNameById(staff);
  const fmtDate = useFmtDate(today, lang);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

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
        background: T.paper, borderRadius: 22, width: '100%', maxWidth: 460,
        maxHeight: '78vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 24px 70px -10px rgba(31,35,28,0.34), 0 0 0 1px rgba(31,35,28,0.04)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
          padding: '20px 24px 13px', borderBottom: `1px solid ${T.rule}`,
        }}>
          <div>
            <Caps>{es ? 'Tiempo libre' : 'Time off'}</Caps>
            <h2 style={{
              margin: '3px 0 0', fontFamily: fonts.sans, fontSize: 22,
              fontWeight: 600, letterSpacing: '-0.02em', color: T.ink,
            }}>{es ? 'Historial' : 'History'}</h2>
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
          {decided.length === 0 && (
            <div style={{ padding: '20px 24px', fontSize: 13, color: T.ink3 }}>
              {es ? 'Aún no hay decisiones.' : 'No past requests yet.'}
            </div>
          )}
          {decided.map(r => {
            const name = nameById.get(r.staffId) ?? (es ? 'Personal' : 'Staff');
            const approved = r.status === 'approved';
            return (
              <div key={r.id} style={{
                padding: '10px 24px', display: 'flex', alignItems: 'center', gap: 10,
                fontSize: 12.5, color: T.ink2, borderBottom: `1px solid ${T.ruleSoft}`,
              }}>
                <Avatar staffId={r.staffId} name={name} size={22}/>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 600, color: T.ink, fontSize: 12.5 }}>{name}</span>
                  <span style={{ display: 'block', fontSize: 11.5, color: T.ink3 }}>
                    {fmtDate(r.requestDate)}
                    {r.reason && <> — “{r.reason}”</>}
                    {r.status === 'denied' && r.denyReason && <> · {es ? 'motivo' : 'reason'}: “{r.denyReason}”</>}
                  </span>
                </span>
                <span style={{ flex: 1 }}/>
                <span style={{
                  fontFamily: fonts.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
                  color: approved ? T.sageDeep : T.red,
                  background: approved ? 'rgba(92,122,96,0.12)' : 'rgba(184,92,61,0.10)',
                  border: `1px solid ${approved ? 'rgba(92,122,96,0.30)' : 'rgba(184,92,61,0.30)'}`,
                  padding: '1px 7px', borderRadius: 999, flexShrink: 0,
                }}>{approved ? (es ? 'APROBADO' : 'APPROVED') : (es ? 'RECHAZADO' : 'DENIED')}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
