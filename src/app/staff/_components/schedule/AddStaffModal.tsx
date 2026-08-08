// AddStaffModal — roster picker for "＋ Add staff" on the day board.
//
// Lists everyone on the property's roster who isn't already on the selected
// day, grouped by department, each with their department's default shift.
// Above the roster sits the one thing that isn't a person: "Post an open
// shift", a slot anyone in the chosen department can claim from My Shifts.
// Deliberately has NO in-modal "create staff" action — the footer links to
// My Hotel → People instead (new hires are added there and show up here
// automatically).

'use client';

import React, { useId, useState } from 'react';
import type { ShiftPreset, StaffDepartment, StaffMember, TimeOffRequest } from '@/types';
import {
  deptDefaultTimes, fmtHours, fmtMinRange, normalizeShiftEnd, toHHMM, toMin,
} from '@/lib/schedule-board';
import { T, fonts, deptMeta, asDeptKey, Caps, Btn, type DeptKey } from '../_tokens';
import { Avatar } from '../_people';
import { useStaffDialog } from '../useStaffDialog';
import dialogStyles from '../StaffDialog.module.css';

const DEFAULT_WEEKLY_CAP = 40;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const OPEN_LANES: DeptKey[] = ['housekeeping', 'front_desk', 'maintenance', 'other'];

export function AddStaffModal({
  staff, takenIds, presets, dayTitle, dayPhrase, lang,
  weekMinutes, approvedTorByStaff,
  onPick, onCreateOpen, onOpenPeople, onClose,
}: {
  staff: StaffMember[];
  takenIds: Set<string>;
  presets: ShiftPreset[];
  /** 'Add someone to today' / a specific day phrase for other dates. */
  dayTitle: string;
  /** 'Friday, Jun 12' — used in the time-off warning. */
  dayPhrase: string;
  lang: 'en' | 'es';
  /** Projected minutes already scheduled this week, per staff. */
  weekMinutes: Map<string, number>;
  /** Approved time-off requests landing on this exact day, per staff. */
  approvedTorByStaff: Map<string, TimeOffRequest>;
  onPick: (s: StaffMember, opts?: { overrideTimeOff?: boolean }) => void;
  /** Post a slot with nobody on it. Absent → the option is not offered. */
  onCreateOpen?: (input: {
    department: StaffDepartment;
    startMin: number;
    endMin: number;
    note: string | null;
  }) => Promise<void> | void;
  onOpenPeople?: () => void;
  onClose: () => void;
}) {
  // Picking someone with approved time off that day asks first.
  const [confirmFor, setConfirmFor] = useState<StaffMember | null>(null);
  const [openFormShown, setOpenFormShown] = useState(false);
  const titleId = useId();
  const dialogRef = useStaffDialog(() => {
    if (confirmFor) setConfirmFor(null);
    else if (openFormShown) setOpenFormShown(false);
    else onClose();
  });

  const es = false;
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
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(31,35,28,0.42)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20, fontFamily: fonts.sans,
      }}
    >
      <div
        ref={dialogRef}
        className={dialogStyles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={e => e.stopPropagation()}
        style={{
        background: T.paper, borderRadius: 22, width: '100%', maxWidth: 440,
        maxHeight: '82vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 24px 70px -10px rgba(31,35,28,0.34), 0 0 0 1px rgba(31,35,28,0.04)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
          padding: '22px 24px 14px', borderBottom: `1px solid ${T.rule}`,
        }}>
          <div>
            <Caps>{'Hotel roster'}</Caps>
            <h2 id={titleId} style={{
              margin: '3px 0 0', fontFamily: fonts.sans, fontSize: 22,
              fontWeight: 600, letterSpacing: '-0.02em', whiteSpace: 'nowrap', color: T.ink,
            }}>{dayTitle}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={'Close'}
            style={{
              background: 'transparent', border: `1px solid ${T.rule}`, borderRadius: '50%',
              width: 30, height: 30, cursor: 'pointer', color: T.ink2, fontSize: 16, flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}
          >×</button>
        </div>

        <div style={{ overflowY: 'auto', padding: '10px 14px 6px' }}>
          {onCreateOpen && (
            <OpenShiftComposer
              presets={presets}
              dayPhrase={dayPhrase}
              shown={openFormShown}
              onShow={() => setOpenFormShown(true)}
              onHide={() => setOpenFormShown(false)}
              onCreate={onCreateOpen}
            />
          )}
          {groups.length === 0 && (
            <div style={{ padding: '24px 12px', textAlign: 'center', color: T.ink3, fontSize: 13 }}>
              {'Everyone on the roster is already on this day.'}
            </div>
          )}
          {groups.length > 0 && onCreateOpen && (
            <div style={{ padding: '10px 10px 2px' }}>
              <Caps size={9} c={T.ink3}>{'Or put someone on it now'}</Caps>
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
                  const tor = approvedTorByStaff.get(s.id);
                  const curMin = weekMinutes.get(s.id) ?? 0;
                  const projMin = curMin + (def.e - def.s);
                  const capMin = (s.maxWeeklyHours || DEFAULT_WEEKLY_CAP) * 60;
                  const wouldOT = projMin > capMin;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => (tor ? setConfirmFor(s) : onPick(s))}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', gap: 11,
                        padding: '9px 10px', borderRadius: 12,
                        border: '1px solid transparent', background: 'transparent',
                        cursor: 'pointer', textAlign: 'left',
                        opacity: tor ? 0.75 : 1,
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.background = 'rgba(31,35,28,0.03)';
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
                          display: 'flex', alignItems: 'center', gap: 6,
                          fontSize: 13.5, fontWeight: 600, color: T.ink,
                          whiteSpace: 'nowrap', overflow: 'hidden',
                        }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                          {tor && (
                            <span style={{
                              fontFamily: fonts.mono, fontSize: 8, fontWeight: 700, letterSpacing: '0.06em',
                              color: T.caramelDeep, background: 'rgba(201,150,68,0.16)',
                              border: '1px solid rgba(140,106,51,0.32)',
                              padding: '1px 5px', borderRadius: 999, flexShrink: 0,
                            }}>{'TIME OFF'}</span>
                          )}
                        </span>
                        <span style={{ display: 'block', fontFamily: fonts.mono, fontSize: 10, color: T.ink3 }}>
                          {fmtMinRange(def.s, def.e)} · {'default'}
                          {curMin > 0 && <> · {fmtHours(curMin)} {'this wk'}</>}
                          {wouldOT && (
                            <span style={{ color: T.red, fontWeight: 700 }}>
                              {' '}→ {fmtHours(projMin)} OT
                            </span>
                          )}
                        </span>
                      </span>
                      <span style={{
                        fontFamily: fonts.sans, fontSize: 12, fontWeight: 600,
                        color: m.tone, whiteSpace: 'nowrap', flexShrink: 0,
                      }}>{'Add →'}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        {confirmFor && (
          <div role="alert" aria-live="assertive" style={{
            borderTop: '1px solid rgba(140,106,51,0.32)', padding: '12px 16px',
            background: 'rgba(201,150,68,0.10)',
            display: 'flex', flexDirection: 'column', gap: 9,
          }}>
            <span style={{ fontSize: 12.5, color: T.ink, lineHeight: 1.5 }}>
              {<>You approved time off for <strong>{confirmFor.name}</strong> on <strong>{dayPhrase}</strong>{approvedTorByStaff.get(confirmFor.id)?.reason ? <>, “{approvedTorByStaff.get(confirmFor.id)!.reason}”</> : null}. Schedule them anyway?</>}
            </span>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn variant="ghost" size="sm" onClick={() => setConfirmFor(null)}>{'Cancel'}</Btn>
              <Btn variant="primary" size="sm" onClick={() => { onPick(confirmFor, { overrideTimeOff: true }); setConfirmFor(null); }}>
                {'Schedule anyway'}
              </Btn>
            </div>
          </div>
        )}

        <div style={{
          borderTop: `1px solid ${T.rule}`, padding: '12px 16px',
          display: 'flex', alignItems: 'flex-start', gap: 9, background: 'rgba(31,35,28,0.03)',
        }}>
          <span style={{
            width: 18, height: 18, borderRadius: '50%', background: T.paper,
            border: `1px solid ${T.rule}`, flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: T.ink2, marginTop: 1,
          }}>i</span>
          <span style={{ fontSize: 11.5, color: T.ink2, lineHeight: 1.5 }}>
            {onOpenPeople ? (
              <>
                {'Don’t see someone? New hires are added in '}
                <button
                  type="button"
                  onClick={onOpenPeople}
                  style={{
                    background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                    fontFamily: fonts.sans, fontSize: 11.5, fontWeight: 700, color: T.ink,
                    textDecoration: 'underline', textUnderlineOffset: 2,
                  }}
                >{'My Hotel → People'}</button>
                {'. Once they’re added there, they’ll show up here automatically.'}
              </>
            ) : (
              'Don’t see someone? A manager can add them in My Hotel → People.'
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Open-shift composer ───────────────────────────────────────────────────
// Collapsed to one line until asked for, so the roster stays the fast path.
// Department + times + optional note, mirroring what adding a person asks:
// picking a department is what decides who can claim it.
function OpenShiftComposer({
  presets, dayPhrase, shown, onShow, onHide, onCreate,
}: {
  presets: ShiftPreset[];
  dayPhrase: string;
  shown: boolean;
  onShow: () => void;
  onHide: () => void;
  onCreate: (input: {
    department: StaffDepartment;
    startMin: number;
    endMin: number;
    note: string | null;
  }) => Promise<void> | void;
}) {
  const [dept, setDept] = useState<DeptKey>('housekeeping');
  const [start, setStart] = useState(() => toHHMM(deptDefaultTimes('housekeeping', presets).s));
  const [end, setEnd] = useState(() => toHHMM(deptDefaultTimes('housekeeping', presets).e));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const deptId = useId();
  const startId = useId();
  const endId = useId();
  const noteId = useId();
  const errorId = useId();

  const pickDept = (next: DeptKey) => {
    setDept(next);
    const def = deptDefaultTimes(next, presets);
    setStart(toHHMM(def.s));
    setEnd(toHHMM(def.e));
    setErrorMsg(null);
  };

  const submit = async () => {
    if (!TIME_RE.test(start.trim()) || !TIME_RE.test(end.trim())) {
      setErrorMsg('Use HH:MM, e.g. 08:00');
      return;
    }
    const s = toMin(start.trim());
    const endClock = toMin(end.trim());
    if (endClock === s) {
      setErrorMsg('Start and end cannot be the same');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    try {
      await onCreate({
        department: dept,
        startMin: s,
        endMin: normalizeShiftEnd(s, endClock),
        note: note.trim() ? note.trim().slice(0, 300) : null,
      });
    } catch (e) {
      setBusy(false);
      setErrorMsg(e instanceof Error ? e.message : 'Could not post the open shift');
    }
  };

  if (!shown) {
    return (
      <button
        type="button"
        onClick={onShow}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 11,
          padding: '11px 10px', borderRadius: 12, marginBottom: 4,
          border: `1px dashed ${T.caramelDeep}`, background: 'rgba(201,150,68,0.06)',
          cursor: 'pointer', textAlign: 'left', minHeight: 44,
        }}
      >
        <span aria-hidden="true" style={{
          width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
          border: `1px dashed ${T.caramelDeep}`, color: T.caramelDeep,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: fonts.sans, fontSize: 15, fontWeight: 700,
        }}>?</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: T.ink }}>
            {'Post an open shift'}
          </span>
          <span style={{ display: 'block', fontFamily: fonts.mono, fontSize: 10, color: T.ink3 }}>
            {'Anyone in the department can pick it up'}
          </span>
        </span>
        <span style={{
          fontFamily: fonts.sans, fontSize: 12, fontWeight: 600,
          color: T.caramelDeep, whiteSpace: 'nowrap', flexShrink: 0,
        }}>{'Post →'}</span>
      </button>
    );
  }

  return (
    <div style={{
      padding: '12px 12px 14px', borderRadius: 12, marginBottom: 8,
      border: `1px dashed ${T.caramelDeep}`, background: 'rgba(201,150,68,0.06)',
    }}>
      <Caps size={9} c={T.caramelDeep}>{'Open shift'}</Caps>
      <div style={{ fontSize: 11.5, color: T.ink2, lineHeight: 1.5, margin: '4px 0 10px' }}>
        {`Nobody is on it. Anyone in the department sees it on ${dayPhrase} and can claim it.`}
      </div>

      <label htmlFor={deptId}><Caps size={9}>{'Department'}</Caps></label>
      <select
        id={deptId}
        value={dept}
        onChange={e => pickDept(e.target.value as DeptKey)}
        style={{ ...openInputStyle, marginTop: 6 }}
      >
        {OPEN_LANES.map(d => (
          <option key={d} value={d}>{deptMeta[d].label}</option>
        ))}
      </select>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
        <div>
          <label htmlFor={startId}><Caps size={9}>{'Start'}</Caps></label>
          <input
            id={startId}
            value={start}
            onChange={e => { setStart(e.target.value); setErrorMsg(null); }}
            placeholder="08:00"
            aria-invalid={errorMsg ? true : undefined}
            aria-describedby={errorMsg ? errorId : undefined}
            style={{ ...openInputStyle, fontFamily: fonts.mono, marginTop: 6 }}
          />
        </div>
        <div>
          <label htmlFor={endId}><Caps size={9}>{'End'}</Caps></label>
          <input
            id={endId}
            value={end}
            onChange={e => { setEnd(e.target.value); setErrorMsg(null); }}
            placeholder="16:00"
            aria-invalid={errorMsg ? true : undefined}
            aria-describedby={errorMsg ? errorId : undefined}
            style={{ ...openInputStyle, fontFamily: fonts.mono, marginTop: 6 }}
          />
        </div>
      </div>
      <div style={{ marginTop: 5, fontFamily: fonts.mono, fontSize: 10, color: T.ink3, letterSpacing: '0.04em' }}>
        {'24h clock'}
      </div>

      <div style={{ marginTop: 10 }}>
        <label htmlFor={noteId}><Caps size={9}>{'Note (optional)'}</Caps></label>
        <input
          id={noteId}
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder={'e.g. extra coverage for the tour group'}
          maxLength={300}
          style={{ ...openInputStyle, marginTop: 6 }}
        />
      </div>

      {errorMsg && (
        <div id={errorId} role="alert" style={{
          marginTop: 10, padding: '9px 13px', background: 'rgba(184,92,61,0.08)',
          border: '1px solid rgba(184,92,61,0.25)', borderRadius: 10,
          color: T.red, fontSize: 12.5,
        }}>{errorMsg}</div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <Btn variant="ghost" size="sm" onClick={onHide} disabled={busy}>{'Cancel'}</Btn>
        <Btn variant="primary" size="sm" onClick={() => { void submit(); }} disabled={busy}>
          {busy ? ('Posting…') : ('Post open shift')}
        </Btn>
      </div>
    </div>
  );
}

const openInputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '9px 12px', borderRadius: 10, border: `1px solid ${T.rule}`,
  background: T.paper, fontFamily: fonts.sans, fontSize: 13, color: T.ink, outline: 'none',
};
