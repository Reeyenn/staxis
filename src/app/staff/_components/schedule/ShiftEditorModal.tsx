// ShiftEditorModal — tap (don't drag) a shift block to type exact times
// and a note. Complements the board's drag/resize for precision and for
// touch devices; also the only place to put a note on a shift
// ("deep clean floor 3").

'use client';

import React, { useEffect, useState } from 'react';
import { toMin, toHHMM, fmtMinRange, type BoardShift } from '@/lib/schedule-board';
import { T, fonts, deptMeta, asDeptKey, Caps, Btn } from '../_tokens';
import { Avatar } from '../_people';
import { modalInputStyle as inputStyle } from '../_fields';

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

export function ShiftEditorModal({
  shift, staffName, dayLabel, lang, onSave, onRemove, onClose,
}: {
  shift: BoardShift;
  staffName: string;
  dayLabel: string;
  lang: 'en' | 'es';
  onSave: (patch: { startMin: number; endMin: number; note: string | null }) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const es = lang === 'es';
  const m = deptMeta[asDeptKey(shift.dept)];
  const [start, setStart] = useState(toHHMM(shift.startMin));
  const [end, setEnd] = useState(toHHMM(Math.min(shift.endMin, 24 * 60 - 1)));
  const [note, setNote] = useState(shift.note ?? '');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const save = () => {
    if (!TIME_RE.test(start.trim()) || !TIME_RE.test(end.trim())) {
      setErrorMsg(es ? 'Usa HH:MM — ej. 08:00' : 'Use HH:MM — e.g. 08:00');
      return;
    }
    const s = toMin(start.trim()), e = toMin(end.trim());
    if (e <= s) {
      setErrorMsg(es ? 'El fin debe ser después del inicio' : 'End must be after start');
      return;
    }
    onSave({ startMin: s, endMin: e, note: note.trim() ? note.trim().slice(0, 300) : null });
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
        background: T.paper, borderRadius: 22, width: '100%', maxWidth: 400,
        padding: '22px 24px',
        boxShadow: '0 24px 70px -10px rgba(31,35,28,0.34), 0 0 0 1px rgba(31,35,28,0.04)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <Avatar staffId={shift.staffId} name={staffName} size={32}/>
            <div style={{ minWidth: 0 }}>
              <h2 style={{
                margin: 0, fontFamily: fonts.serif, fontSize: 22, fontStyle: 'italic',
                fontWeight: 400, letterSpacing: '-0.02em', color: T.ink,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{staffName}</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 2 }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: m.tone }}/>
                <Caps size={9}>{dayLabel} · {m.label}</Caps>
              </div>
            </div>
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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 18 }}>
          <div>
            <Caps size={9}>{es ? 'Inicio' : 'Start'}</Caps>
            <input
              value={start}
              onChange={e => { setStart(e.target.value); setErrorMsg(null); }}
              onKeyDown={e => { if (e.key === 'Enter') save(); }}
              placeholder="08:00"
              autoFocus
              style={{ ...inputStyle, fontFamily: fonts.mono, marginTop: 6 }}
            />
          </div>
          <div>
            <Caps size={9}>{es ? 'Fin' : 'End'}</Caps>
            <input
              value={end}
              onChange={e => { setEnd(e.target.value); setErrorMsg(null); }}
              onKeyDown={e => { if (e.key === 'Enter') save(); }}
              placeholder="16:00"
              style={{ ...inputStyle, fontFamily: fonts.mono, marginTop: 6 }}
            />
          </div>
        </div>
        <div style={{
          marginTop: 6, fontFamily: fonts.mono, fontSize: 10, color: T.ink3, letterSpacing: '0.04em',
        }}>
          {es ? 'Reloj de 24h' : '24h clock'} · {es ? 'ahora' : 'currently'} {fmtMinRange(shift.startMin, shift.endMin)}
        </div>

        <div style={{ marginTop: 14 }}>
          <Caps size={9}>{es ? 'Nota (opcional)' : 'Note (optional)'}</Caps>
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); }}
            placeholder={es ? 'ej. limpieza profunda piso 3' : 'e.g. deep clean floor 3'}
            maxLength={300}
            style={{ ...inputStyle, marginTop: 6 }}
          />
        </div>

        {errorMsg && (
          <div role="alert" style={{
            marginTop: 12, padding: '9px 13px', background: 'rgba(160,74,44,0.08)',
            border: '1px solid rgba(160,74,44,0.25)', borderRadius: 10,
            color: T.red, fontSize: 12.5,
          }}>{errorMsg}</div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 18, alignItems: 'center' }}>
          <Btn
            variant="ghost" size="md" onClick={onRemove}
            style={{ color: T.red, borderColor: 'rgba(160,74,44,0.25)' }}
          >{es ? 'Quitar' : 'Remove'}</Btn>
          <span style={{ flex: 1 }}/>
          <Btn variant="ghost" size="md" onClick={onClose}>{es ? 'Cancelar' : 'Cancel'}</Btn>
          <Btn variant="primary" size="md" onClick={save}>{es ? 'Guardar' : 'Save'}</Btn>
        </div>
      </div>
    </div>
  );
}
