// AddStaffModal — directory picker for "＋ Add staff" on the day board.
//
// Lists everyone from the property's staff directory who isn't already on
// the selected day, grouped by department, each with their department's
// default shift. Deliberately has NO in-modal "create staff" action — the
// footer links to Staff → Directory instead (new hires are added there and
// show up here automatically).

'use client';

import React, { useEffect } from 'react';
import type { ShiftPreset, StaffMember } from '@/types';
import { deptDefaultTimes, fmtMinRange } from '@/lib/schedule-board';
import { T, fonts, deptMeta, asDeptKey, Caps, type DeptKey } from '../_tokens';
import { Avatar } from '../_people';

export function AddStaffModal({
  staff, takenIds, presets, dayTitle, lang, onPick, onOpenDirectory, onClose,
}: {
  staff: StaffMember[];
  takenIds: Set<string>;
  presets: ShiftPreset[];
  /** 'Add someone to today' / a specific day phrase for other dates. */
  dayTitle: string;
  lang: 'en' | 'es';
  onPick: (s: StaffMember) => void;
  onOpenDirectory: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const es = lang === 'es';
  const avail = staff.filter(s => s.isActive !== false && !takenIds.has(s.id));
  const lanes: DeptKey[] = ['housekeeping', 'front_desk', 'maintenance', 'other'];
  const groups = lanes
    .map(d => ({
      dept: d,
      list: avail.filter(s => asDeptKey(s.department) === d)
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter(g => g.list.length);

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
        background: T.paper, borderRadius: 22, width: '100%', maxWidth: 440,
        maxHeight: '82vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 24px 70px -10px rgba(31,35,28,0.34), 0 0 0 1px rgba(31,35,28,0.04)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
          padding: '22px 24px 14px', borderBottom: `1px solid ${T.rule}`,
        }}>
          <div>
            <Caps>{es ? 'Directorio de personal' : 'Staff directory'}</Caps>
            <h2 style={{
              margin: '3px 0 0', fontFamily: fonts.serif, fontSize: 24, fontStyle: 'italic',
              fontWeight: 400, letterSpacing: '-0.02em', whiteSpace: 'nowrap', color: T.ink,
            }}>{dayTitle}</h2>
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

        <div style={{ overflowY: 'auto', padding: '10px 14px 6px' }}>
          {groups.length === 0 && (
            <div style={{ padding: '24px 12px', textAlign: 'center', color: T.ink3, fontSize: 13 }}>
              {es
                ? 'Todo el directorio ya está en este día.'
                : 'Everyone in the directory is already on this day.'}
            </div>
          )}
          {groups.map(g => {
            const m = deptMeta[g.dept];
            return (
              <div key={g.dept} style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px 4px' }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: m.tone }}/>
                  <Caps size={9} c={T.ink2}>{m.label}</Caps>
                </div>
                {g.list.map(s => {
                  const def = deptDefaultTimes(asDeptKey(s.department), presets);
                  return (
                    <button
                      key={s.id}
                      onClick={() => onPick(s)}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', gap: 11,
                        padding: '9px 10px', borderRadius: 12,
                        border: '1px solid transparent', background: 'transparent',
                        cursor: 'pointer', textAlign: 'left',
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.background = '#FBFAF6';
                        e.currentTarget.style.borderColor = T.rule;
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.borderColor = 'transparent';
                      }}
                    >
                      <Avatar staffId={s.id} name={s.name} size={30}/>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{
                          display: 'block', fontSize: 13.5, fontWeight: 600, color: T.ink,
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>{s.name}</span>
                        <span style={{ display: 'block', fontFamily: fonts.mono, fontSize: 10, color: T.ink3 }}>
                          {fmtMinRange(def.s, def.e)} · {es ? 'por defecto' : 'default'}
                        </span>
                      </span>
                      <span style={{
                        fontFamily: fonts.sans, fontSize: 12, fontWeight: 600,
                        color: m.tone, whiteSpace: 'nowrap', flexShrink: 0,
                      }}>{es ? 'Agregar →' : 'Add →'}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div style={{
          borderTop: `1px solid ${T.rule}`, padding: '12px 16px',
          display: 'flex', alignItems: 'flex-start', gap: 9, background: '#FBFAF6',
        }}>
          <span style={{
            width: 18, height: 18, borderRadius: '50%', background: T.paper,
            border: `1px solid ${T.rule}`, flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: fonts.serif, fontSize: 12, fontStyle: 'italic', color: T.ink2, marginTop: 1,
          }}>i</span>
          <span style={{ fontSize: 11.5, color: T.ink2, lineHeight: 1.5 }}>
            {es ? '¿No ves a alguien? Las personas nuevas se agregan en ' : 'Don’t see someone? New hires are added in '}
            <button
              onClick={onOpenDirectory}
              style={{
                background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                fontFamily: fonts.sans, fontSize: 11.5, fontWeight: 700, color: T.ink,
                textDecoration: 'underline', textUnderlineOffset: 2,
              }}
            >{es ? 'Personal → Directorio' : 'Staff → Directory'}</button>
            {es
              ? '. Cuando estén en el directorio, aparecerán aquí automáticamente.'
              : '. Once they’re in the directory, they’ll show up here automatically.'}
          </span>
        </div>
      </div>
    </div>
  );
}
