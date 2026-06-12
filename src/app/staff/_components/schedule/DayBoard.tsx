// DayBoard — the editable "who's working today" timeline (Day view).
//
// One lane per department, one 34px row per working staff member. The shift
// block drags horizontally to move (snapping to the department's saved
// shift-preset times within 22min, else a 15-minute grid), drags vertically
// onto another lane to change department, and its right edge drags to
// resize (min 60min). Every gesture pushes one undo snapshot at
// pointer-down and persists once at pointer-up.
//
// Entrance/exit animations run imperatively via the Web Animations API so
// React re-renders can't disturb them; both respect prefers-reduced-motion.

'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { ShiftPreset, StaffDepartment } from '@/types';
import {
  boardRange, boardTicks, fmtMin, fmtMinRange, presetBoundaries, snapMin, shortName,
  type BoardShift,
} from '@/lib/schedule-board';
import { T, fonts, deptMeta, Caps, type DeptKey } from '../_tokens';
import { Avatar } from '../_people';

const GUT = 124;
const ROW_H = 34;
const EASE = 'cubic-bezier(.2,.85,.3,1)';
const OPEN_MS = 300;
const BLOCK_DELAY = 230;

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

export function DayBoard({
  shifts, presets, isToday, lang, nameOf, otTitles,
  onUpdate, onGestureStart, onGestureEnd, onRemove, onTapShift,
}: {
  shifts: BoardShift[];
  presets: ShiftPreset[];
  isToday: boolean;
  lang: 'en' | 'es';
  nameOf: (staffId: string) => string;
  /** staffId → tooltip for staff projected over their weekly-hours cap. */
  otTitles: Map<string, string>;
  /** Local-only patch during a drag (no save). */
  onUpdate: (id: string, patch: Partial<BoardShift>) => void;
  /** Called once at first real movement: push an undo snapshot + mark gesture. */
  onGestureStart: () => void;
  /** Called at pointer-up after a real drag: persist the day. */
  onGestureEnd: () => void;
  onRemove: (id: string) => void;
  /** Tap (pointer down+up without movement) → open the exact-times editor. */
  onTapShift: (id: string) => void;
}) {
  const [hoverLane, setHoverLane] = useState<DeptKey | null>(null);
  const reducedMotion = useReducedMotion();

  const { start: rangeStart, end: rangeEnd } = boardRange(shifts);
  const span = rangeEnd - rangeStart;
  const ticks = boardTicks(rangeStart, rangeEnd);

  const [nowMin, setNowMin] = useState(nowMinutes);
  useEffect(() => {
    if (!isToday) return;
    const t = setInterval(() => setNowMin(nowMinutes()), 60_000);
    return () => clearInterval(t);
  }, [isToday]);

  const lanes: DeptKey[] = ['housekeeping', 'front_desk', 'maintenance'];
  if (shifts.some(s => s.dept === 'other')) lanes.push('other');

  return (
    <div style={{ padding: '14px 22px 18px' }}>
      {/* hour axis */}
      <div style={{ position: 'relative', height: 14, marginLeft: GUT, marginBottom: 4 }}>
        {ticks.map(m => {
          const left = ((m - rangeStart) / span) * 100;
          return (
            <span key={m} style={{
              position: 'absolute', left: `${left}%`, transform: 'translateX(-50%)',
              fontFamily: fonts.mono, fontSize: 9.5, color: T.ink3,
            }}>{fmtMin(m)}</span>
          );
        })}
      </div>

      {lanes.map((dep, di) => {
        const m = deptMeta[dep];
        const list = shifts.filter(s => s.dept === dep);
        const hot = hoverLane === dep;
        return (
          <div key={dep} data-lane={dep} style={{
            borderTop: di ? `1px solid ${T.ruleSoft}` : 'none',
            padding: '8px 10px', margin: '0 -10px', borderRadius: 12,
            background: hot ? `${m.tone}0E` : 'transparent',
            boxShadow: hot ? `inset 0 0 0 1px ${m.tone}55` : 'none',
            transition: 'background .12s',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, marginLeft: 2 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: m.tone }}/>
              <Caps size={9} c={T.ink2}>{m.label} · {list.length}</Caps>
              {hot && (
                <span style={{
                  fontFamily: fonts.mono, fontSize: 8.5, fontWeight: 700,
                  color: m.tone, letterSpacing: '0.06em',
                }}>{lang === 'es' ? '← SUELTA AQUÍ' : '← DROP HERE'}</span>
              )}
            </div>

            {list.map(sh => (
              <ShiftRow
                key={`${sh.id}-${sh.nonce ?? 0}`}
                sh={sh} tone={m.tone} dim={m.dim}
                rangeStart={rangeStart} rangeEnd={rangeEnd} span={span}
                ticks={ticks} nowMin={isToday ? nowMin : null}
                presets={presets} nameOf={nameOf}
                reducedMotion={reducedMotion}
                otTitle={otTitles.get(sh.staffId)}
                onUpdate={onUpdate}
                onGestureStart={onGestureStart}
                onGestureEnd={onGestureEnd}
                onHoverLane={setHoverLane}
                onRemove={onRemove}
                onTapShift={onTapShift}
              />
            ))}

            {list.length === 0 && (
              <div style={{ display: 'flex', alignItems: 'center', height: 30 }}>
                <div style={{ width: GUT, flexShrink: 0 }}/>
                <span style={{ fontFamily: fonts.mono, fontSize: 10, color: T.ink3, letterSpacing: '0.03em' }}>
                  {lang === 'es'
                    ? `Nadie en ${m.short} todavía — usa ＋ Agregar personal arriba.`
                    : `No one on ${m.short} yet — use ＋ Add staff above.`}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── One staff row with a draggable / resizable shift block ────────────────
function ShiftRow({
  sh, tone, dim, rangeStart, rangeEnd, span, ticks, nowMin,
  presets, nameOf, reducedMotion, otTitle,
  onUpdate, onGestureStart, onGestureEnd, onHoverLane, onRemove, onTapShift,
}: {
  sh: BoardShift;
  tone: string;
  dim: string;
  rangeStart: number;
  rangeEnd: number;
  span: number;
  ticks: number[];
  nowMin: number | null;
  presets: ShiftPreset[];
  nameOf: (staffId: string) => string;
  reducedMotion: boolean;
  otTitle?: string;
  onUpdate: (id: string, patch: Partial<BoardShift>) => void;
  onGestureStart: () => void;
  onGestureEnd: () => void;
  onHoverLane: (lane: DeptKey | null) => void;
  onRemove: (id: string) => void;
  onTapShift: (id: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const blockRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  // Live gesture state — refs so pointermove never fights React's render cycle.
  const shRef = useRef(sh);
  shRef.current = sh;

  const left = ((sh.startMin - rangeStart) / span) * 100;
  const width = ((sh.endMin - sh.startMin) / span) * 100;
  const name = shortName(nameOf(sh.staffId));

  // Entrance: the row's space opens, then the block slides in and the
  // gutter fades. Runs once per add/replay (rows are keyed by nonce).
  useEffect(() => {
    if (!sh.anim || reducedMotion) return;
    const row = rowRef.current, blk = blockRef.current, gut = gutterRef.current;
    row?.animate?.(
      [{ height: '0px', opacity: 0.35 }, { height: `${ROW_H}px`, opacity: 1 }],
      { duration: OPEN_MS, easing: EASE, fill: 'backwards' });
    if (blk?.animate) {
      blk.animate(
        [{ opacity: 0, transform: 'translateX(-34px)' }, { opacity: 1, transform: 'translateX(0)' }],
        { duration: 460, delay: BLOCK_DELAY, easing: EASE, fill: 'backwards' });
    }
    gut?.animate?.(
      [{ opacity: 0, transform: 'translateX(-6px)' }, { opacity: 1, transform: 'translateX(0)' }],
      { duration: 370, delay: BLOCK_DELAY, easing: 'ease', fill: 'backwards' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sh.nonce]);

  // Exit mirrors the entrance, then actually removes from state.
  const animateOut = () => {
    if (leaving) return;
    if (reducedMotion) { onRemove(sh.id); return; }
    setLeaving(true);
    const blk = blockRef.current, row = rowRef.current, gut = gutterRef.current;
    const ease = 'cubic-bezier(.4,0,.7,.2)', dur = 400, gap = 120;
    blk?.animate?.(
      [{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(-40px)' }],
      { duration: dur, easing: ease, fill: 'forwards' });
    gut?.animate?.(
      [{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(-6px)' }],
      { duration: Math.round(dur * 0.7), easing: 'ease', fill: 'forwards' });
    row?.animate?.(
      [{ height: `${ROW_H}px`, opacity: 1 }, { height: '0px', opacity: 0 }],
      { duration: dur, delay: gap, easing: ease, fill: 'forwards' });
    setTimeout(() => onRemove(sh.id), dur + gap + 40);
  };

  const startDrag = (e: React.PointerEvent, mode: 'move' | 'resize') => {
    e.preventDefault();
    e.stopPropagation();
    const track = (e.currentTarget as HTMLElement).closest('[data-track]');
    if (!track) return;
    const w = (track as HTMLElement).getBoundingClientRect().width;
    const perMin = w / span;
    const x0 = e.clientX, y0 = e.clientY;
    const s0 = shRef.current.startMin, e0 = shRef.current.endMin, dur = e0 - s0;
    // Tap vs drag: the gesture (undo snapshot + save-on-release) only starts
    // once the pointer actually travels; a clean tap opens the time editor.
    let started = false;

    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.abs(ev.clientX - x0) < 4 && Math.abs(ev.clientY - y0) < 4) return;
        started = true;
        onGestureStart();
      }
      const dMin = (ev.clientX - x0) / perMin;
      if (mode === 'move') {
        let tgt: DeptKey = shRef.current.dept as DeptKey;
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const lane = el?.closest?.('[data-lane]') as HTMLElement | null;
        if (lane?.dataset.lane && lane.dataset.lane in deptMeta) {
          tgt = lane.dataset.lane as DeptKey;
        }
        onHoverLane(tgt !== sh.dept ? tgt : null);
        let ns = snapMin(s0 + dMin, presetBoundaries(tgt as StaffDepartment, presets, 'start'));
        ns = Math.min(rangeEnd - dur, Math.max(rangeStart, ns));
        onUpdate(sh.id, { startMin: ns, endMin: ns + dur, dept: tgt as StaffDepartment });
      } else {
        let ne = snapMin(Math.max(s0 + 60, e0 + dMin),
          presetBoundaries(shRef.current.dept as StaffDepartment, presets, 'end'));
        ne = Math.min(rangeEnd, Math.max(s0 + 60, ne));
        onUpdate(sh.id, { endMin: ne });
      }
    };
    const up = () => {
      onHoverLane(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (started) onGestureEnd();
      else if (mode === 'move') onTapShift(sh.id);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      ref={rowRef}
      style={{ display: 'flex', alignItems: 'center', height: ROW_H }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* gutter */}
      <div ref={gutterRef} style={{
        width: GUT, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, paddingRight: 10,
      }}>
        <Avatar staffId={sh.staffId} name={nameOf(sh.staffId)} size={20}/>
        <span style={{
          fontSize: 12, fontWeight: 600, color: T.ink, minWidth: 0,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{name}</span>
        {otTitle && (
          <span title={otTitle} style={{
            fontFamily: fonts.mono, fontSize: 8, fontWeight: 700, letterSpacing: '0.04em',
            color: T.red, background: 'rgba(160,74,44,0.12)',
            border: '1px solid rgba(160,74,44,0.35)',
            padding: '0px 4px', borderRadius: 999, flexShrink: 0,
          }}>OT</span>
        )}
      </div>
      {/* track */}
      <div data-track style={{ position: 'relative', flex: 1, height: '100%' }}>
        {ticks.map(m => {
          const l = ((m - rangeStart) / span) * 100;
          return <span key={m} style={{ position: 'absolute', left: `${l}%`, top: 0, bottom: 0, width: 1, background: T.ruleSoft }}/>;
        })}
        {nowMin != null && nowMin >= rangeStart && nowMin <= rangeEnd && (
          <span style={{
            position: 'absolute', left: `${((nowMin - rangeStart) / span) * 100}%`,
            top: 0, bottom: 0, width: 2, background: T.warm, opacity: 0.5, borderRadius: 2,
          }}/>
        )}
        {/* block */}
        <div
          ref={blockRef}
          onPointerDown={e => startDrag(e, 'move')}
          title={`${nameOf(sh.staffId)}${sh.note ? ` — ${sh.note}` : ''}`}
          style={{
            position: 'absolute', top: 4, height: 26, left: `${left}%`, width: `${width}%`,
            borderRadius: 8, background: dim, border: `1px solid ${tone}66`, cursor: 'grab',
            display: 'flex', alignItems: 'center', gap: 7, padding: '0 8px',
            overflow: 'hidden', userSelect: 'none', touchAction: 'none', boxSizing: 'border-box',
          }}
        >
          <span style={{
            fontSize: 11.5, fontWeight: 600, color: T.ink,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{name.split(' ')[0]}</span>
          {sh.note && (
            <span style={{
              width: 5, height: 5, borderRadius: '50%', background: T.caramel, flexShrink: 0,
            }}/>
          )}
          <span style={{
            marginLeft: 'auto', fontFamily: fonts.mono, fontSize: 9.5,
            color: tone, whiteSpace: 'nowrap',
          }}>{fmtMinRange(sh.startMin, sh.endMin)}</span>
          {/* resize handle */}
          <span
            onPointerDown={e => startDrag(e, 'resize')}
            style={{
              position: 'absolute', right: 0, top: 0, bottom: 0, width: 9, cursor: 'ew-resize',
              borderRight: `3px solid ${tone}`,
              borderTopRightRadius: 8, borderBottomRightRadius: 8,
              opacity: hover ? 0.9 : 0.35, touchAction: 'none',
            }}
          />
        </div>
        {/* remove */}
        {hover && !leaving && (
          <button
            onClick={animateOut}
            title="Remove"
            style={{
              position: 'absolute', top: 0, left: `calc(${left}% - 7px)`,
              width: 16, height: 16, borderRadius: '50%',
              border: `1px solid ${T.rule}`, background: T.paper, color: T.ink2,
              cursor: 'pointer', fontSize: 10, lineHeight: 1, zIndex: 3,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0,
            }}
          >×</button>
        )}
      </div>
    </div>
  );
}
