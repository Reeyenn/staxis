// UnifiedSchedule — the Staff → Schedule tab (manager).
//
// One scheduling surface for all departments, organized around two views
// and one verb:
//   • Day view  — an editable timeline of who's working a given day
//   • Week view — a read-only roster grid for any week, past or future
//   • Fill      — populate a day/week from history or saved templates
// Plus full history, Undo, a "Finish week" sign-off, and pending time-off
// approvals behind the strip label. Everything persists immediately — what
// you place IS the schedule staff see in My Shifts (no separate publish).

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import type { StaffMember } from '@/types';
import {
  addDaysYmd, sundayOf, dayInfo, buildWeeks, deptDefaultTimes,
  weekMinutesByStaff, fmtHours, fmtMinRange,
  type BoardShift, type DayInfo, type WeekInfo,
} from '@/lib/schedule-board';
import { T, fonts, deptMeta, asDeptKey, Caps, Btn, Card, type DeptKey } from '../_tokens';
import {
  useScheduleData,
  type ScheduleData, type ScheduleTemplate, type TemplateShift, type FillResult,
} from './useScheduleData';
import { DayBoard, useReducedMotion } from './DayBoard';
import { WeekRoster } from './WeekRoster';
import { FillModal } from './FillModal';
import { AddStaffModal } from './AddStaffModal';
import { TimeOffSection, TimeOffHistoryModal } from './TimeOffModal';
import { ShiftEditorModal } from './ShiftEditorModal';

const DEFAULT_WEEKLY_CAP = 40;

const HL_SHADOW = `inset 0 0 0 1px ${T.ink}`;

export function UnifiedSchedule({ onOpenDirectory }: { onOpenDirectory: () => void }) {
  const { activePropertyId, activeProperty, staff } = useProperty();
  const { lang } = useLang();
  const data = useScheduleData(activePropertyId, staff);
  // Key by property so a hotel switch remounts the view — selection, undo
  // visibility, and open modals all reset instead of leaking across hotels.
  return (
    <ScheduleView
      key={activePropertyId ?? 'none'}
      staff={staff}
      lang={lang}
      data={data}
      propertyName={activeProperty?.name}
      onOpenDirectory={onOpenDirectory}
    />
  );
}

// ScheduleView — the full schedule surface, decoupled from where its data
// comes from: the real tab feeds it useScheduleData (Supabase-backed), the
// public /demo/schedule page feeds it useDemoScheduleData (in-memory).
export function ScheduleView({ staff, lang, data, propertyName, onOpenDirectory }: {
  staff: StaffMember[];
  lang: 'en' | 'es';
  data: ScheduleData;
  propertyName?: string;
  onOpenDirectory: () => void;
}) {
  const es = lang === 'es';
  const reducedMotion = useReducedMotion();

  const [view, setView] = useState<'day' | 'week'>('day');
  const [selDate, setSelDate] = useState<string>(() => data.today);
  const [selWeekStart, setSelWeekStart] = useState<string>(() => sundayOf(data.today));
  const [expandedWeekStart, setExpandedWeekStart] = useState<string>(() => sundayOf(data.today));
  const [fillOpen, setFillOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [torHistoryOpen, setTorHistoryOpen] = useState(false);
  const [editorId, setEditorId] = useState<string | null>(null);
  const [weekAnim, setWeekAnim] = useState(0);

  // ── toast ──────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 3600);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // ── calendar ───────────────────────────────────────────────────────────
  const weeks = useMemo(
    () => buildWeeks(data.windowStart, data.windowEnd, data.today, lang),
    [data.windowStart, data.windowEnd, data.today, lang],
  );
  const weekByStart = useMemo(() => new Map(weeks.map(w => [w.start, w])), [weeks]);
  const day = useMemo(() => dayInfo(selDate, data.today, lang), [selDate, data.today, lang]);
  const selWeek: WeekInfo = weekByStart.get(selWeekStart) ?? weeks[0];
  const expandedWeek: WeekInfo = weekByStart.get(expandedWeekStart) ?? weeks[0];

  const dayShifts = data.getDay(selDate);

  // Active staff + name lookup shared with children.
  const activeStaff = useMemo(() => staff.filter(s => s.isActive !== false), [staff]);
  const activeIds = useMemo(() => new Set(activeStaff.map(s => s.id)), [activeStaff]);
  const capMinById = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of staff) m.set(s.id, (s.maxWeeklyHours || DEFAULT_WEEKLY_CAP) * 60);
    return m;
  }, [staff]);

  // Projected hours across the week containing the selected day — feeds the
  // board's OT badges and the Add-staff picker's "32h this wk" lines.
  const selDayWeek: WeekInfo = weekByStart.get(sundayOf(selDate)) ?? selWeek;
  const dayWeekMinutes = useMemo(
    () => weekMinutesByStaff(selDayWeek.days.map(d => data.getDay(d.date))),
    [selDayWeek, data],
  );
  const otTitles = useMemo(() => {
    const m = new Map<string, string>();
    for (const [staffId, min] of dayWeekMinutes) {
      const cap = capMinById.get(staffId) ?? DEFAULT_WEEKLY_CAP * 60;
      if (min > cap) {
        m.set(staffId, es
          ? `${fmtHours(min)} esta semana — supera el límite de ${fmtHours(cap)}`
          : `${fmtHours(min)} this week — over the ${fmtHours(cap)} cap`);
      }
    }
    return m;
  }, [dayWeekMinutes, capMinById, es]);

  // Approved time off landing on the selected day (per staff).
  const approvedList = data.approvedTor;
  const approvedTorByStaff = useMemo(() => {
    const m = new Map<string, (typeof approvedList)[number]>();
    for (const r of approvedList) {
      if (r.requestDate === selDate) m.set(r.staffId, r);
    }
    return m;
  }, [approvedList, selDate]);

  // ── shared fill plumbing ───────────────────────────────────────────────
  const tmpId = () => `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const cloneShifts = (src: BoardShift[]): BoardShift[] => {
    const seen = new Set<string>();
    const out: BoardShift[] = [];
    for (const s of src) {
      if (!activeIds.has(s.staffId) || seen.has(s.staffId)) continue;
      seen.add(s.staffId);
      out.push({ id: tmpId(), staffId: s.staffId, dept: s.dept, startMin: s.startMin, endMin: s.endMin });
    }
    return out;
  };
  const payloadToBoard = (payload: TemplateShift[]): BoardShift[] =>
    cloneShifts(payload.map(p => ({
      id: '', staffId: p.staffId, dept: asDeptKey(p.department), startMin: p.startMin, endMin: p.endMin,
    })));
  const toPayload = (list: BoardShift[]): TemplateShift[] =>
    list.map(s => ({ staffId: s.staffId, department: s.dept, startMin: s.startMin, endMin: s.endMin }));

  const reportSave = useCallback((p: Promise<FillResult>) => {
    p.then(r => {
      const skipped = (r.skippedTimeOff ?? 0) + (r.skippedUnknown ?? 0);
      if (skipped > 0) {
        flash(es
          ? `${skipped} ${skipped === 1 ? 'turno omitido' : 'turnos omitidos'} (tiempo libre aprobado / ya no está en el equipo)`
          : `${skipped} ${skipped === 1 ? 'shift' : 'shifts'} skipped (approved time off / no longer on staff)`);
      }
    }).catch(e => {
      flash(es
        ? `No se pudo guardar — ${e instanceof Error ? e.message : 'intenta de nuevo'}`
        : `Couldn’t save — ${e instanceof Error ? e.message : 'try again'}`);
    });
  }, [flash, es]);

  // ── day board callbacks ────────────────────────────────────────────────
  const onBoardUpdate = (id: string, patch: Partial<BoardShift>) => {
    data.setDayLocal(selDate, list => list.map(x => (x.id === id ? { ...x, ...patch } : x)));
  };

  const onGestureStart = () => {
    data.pushUndo([selDate]);
    data.beginGesture();
  };

  const onGestureEnd = () => {
    data.endGesture();
    reportSave(data.commitDay(selDate));
  };

  const onRemoveShift = (id: string) => {
    data.pushUndo([selDate]);
    data.setDayLocal(selDate, list => list.filter(x => x.id !== id));
    reportSave(data.commitDay(selDate));
  };

  const onPickStaff = (s: StaffMember, opts?: { overrideTimeOff?: boolean }) => {
    const dept = asDeptKey(s.department);
    const def = deptDefaultTimes(dept, data.presets);
    data.pushUndo([selDate]);
    data.setDayLocal(selDate, list => [
      ...list,
      {
        id: tmpId(), staffId: s.id, dept, startMin: def.s, endMin: def.e,
        ...(opts?.overrideTimeOff ? { overrideTimeOff: true } : {}),
        anim: true, nonce: Date.now(),
      },
    ]);
    reportSave(data.commitDay(selDate));
    setPickerOpen(false);
  };

  // ── tap-to-edit (exact times + note) ───────────────────────────────────
  const editorShift = editorId ? dayShifts.find(s => s.id === editorId) ?? null : null;
  const onEditorSave = (patch: { startMin: number; endMin: number; note: string | null }) => {
    if (!editorShift) return;
    data.pushUndo([selDate]);
    data.setDayLocal(selDate, list => list.map(x => (x.id === editorShift.id ? { ...x, ...patch } : x)));
    reportSave(data.commitDay(selDate));
    setEditorId(null);
  };
  const onEditorRemove = () => {
    if (!editorShift) return;
    data.pushUndo([selDate]);
    data.setDayLocal(selDate, list => list.filter(x => x.id !== editorShift.id));
    reportSave(data.commitDay(selDate));
    setEditorId(null);
  };

  // ── undo ───────────────────────────────────────────────────────────────
  const onUndo = () => {
    const p = data.undo();
    if (!p) return;
    flash(es ? 'Se deshizo tu último cambio' : 'Undid your last change');
    setWeekAnim(Date.now());
    reportSave(p);
  };

  // ── fill applies ───────────────────────────────────────────────────────
  const dayPhrase = (d: DayInfo) => es ? `${d.dowFull} ${d.dayNum} ${d.mon}` : `${d.dowFull}, ${d.mon} ${d.dayNum}`;

  /** Selected week, or — auto-repeat — the selected week plus every later one. */
  const targetWeeksFor = (repeatAll: boolean): WeekInfo[] =>
    repeatAll ? weeks.filter(w => w.start >= selWeekStart) : [selWeek];

  const applyTemplate = (t: ScheduleTemplate, repeatAll: boolean) => {
    if (t.scope === 'day') {
      const shifts = payloadToBoard(t.payload as TemplateShift[]);
      data.pushUndo([selDate]);
      reportSave(data.applyDays([{ date: selDate, shifts }], !reducedMotion));
      flash(es ? `Se aplicó “${t.name}” a ${day.dowFull}` : `Applied “${t.name}” to ${day.dowFull}`);
    } else {
      const daysPayload = t.payload as TemplateShift[][];
      const targets = targetWeeksFor(repeatAll);
      const entries = targets.flatMap(w =>
        w.days.map((d, k) => ({ date: d.date, shifts: payloadToBoard(daysPayload[k] ?? []) })));
      data.pushUndo(entries.map(e => e.date));
      reportSave(data.applyDays(entries, !reducedMotion));
      setWeekAnim(Date.now());
      flash(targets.length > 1
        ? (es
          ? `Se aplicó “${t.name}” a ${targets.length} semanas (hasta ${targets[targets.length - 1].label})`
          : `Applied “${t.name}” to ${targets.length} weeks (through ${targets[targets.length - 1].label})`)
        : (es ? `Se aplicó “${t.name}” a ${selWeek.label}` : `Applied “${t.name}” to ${selWeek.label}`));
    }
    setFillOpen(false);
  };

  const applyHistoryDay = (srcDate: string) => {
    const src = data.getDay(srcDate);
    const srcInfo = dayInfo(srcDate, data.today, lang);
    if (src.length === 0) {
      flash(es ? `No hay nada que copiar de ${dayPhrase(srcInfo)}` : `Nothing on ${dayPhrase(srcInfo)} to copy`);
      return;
    }
    const shifts = cloneShifts(src);
    data.pushUndo([selDate]);
    reportSave(data.applyDays([{ date: selDate, shifts }], !reducedMotion));
    flash(es
      ? `Se copió ${dayPhrase(srcInfo)} — ${shifts.length} turnos`
      : `Copied ${dayPhrase(srcInfo)} — ${shifts.length} ${shifts.length === 1 ? 'shift' : 'shifts'}`);
    setFillOpen(false);
  };

  const applyHistoryWeek = (srcWeekStart: string, repeatAll: boolean) => {
    const srcWeek = weekByStart.get(srcWeekStart);
    if (!srcWeek) return;
    const srcDays = srcWeek.days.map(d => data.getDay(d.date));
    const targets = targetWeeksFor(repeatAll);
    let total = 0;
    const entries = targets.flatMap(w =>
      w.days.map((d, k) => {
        const shifts = cloneShifts(srcDays[k]);
        total += shifts.length;
        return { date: d.date, shifts };
      }));
    data.pushUndo(entries.map(e => e.date));
    reportSave(data.applyDays(entries, !reducedMotion));
    setWeekAnim(Date.now());
    flash(targets.length > 1
      ? (es
        ? `Se llenaron ${targets.length} semanas desde ${srcWeek.label} — ${total} turnos`
        : `Filled ${targets.length} weeks from ${srcWeek.label} — ${total} ${total === 1 ? 'shift' : 'shifts'}`)
      : (es
        ? `Se llenó ${selWeek.label} desde ${srcWeek.label} — ${total} turnos`
        : `Filled ${selWeek.label} from ${srcWeek.label} — ${total} ${total === 1 ? 'shift' : 'shifts'}`));
    setFillOpen(false);
  };

  // ── print / PDF the week ───────────────────────────────────────────────
  const printWeek = () => {
    const week = view === 'day' ? selDayWeek : selWeek;
    const w = window.open('', '_blank', 'width=920,height=720');
    if (!w) {
      flash(es ? 'Permite ventanas emergentes para imprimir' : 'Allow pop-ups to print');
      return;
    }
    w.document.write(printableWeekHtml({
      week, staff: activeStaff, getDay: data.getDay, nameOf: data.nameOf,
      capMinById, propertyName, lang,
    }));
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch { /* user closed it */ } }, 300);
  };

  // ── templates ──────────────────────────────────────────────────────────
  const saveTemplateFrom = (name: string, target: { date: string } | { weekStart: string }) => {
    const run = async () => {
      if ('date' in target) {
        const payload = toPayload(data.getDay(target.date));
        await data.saveTemplate('day', name, payload);
        flash(es ? `Se guardó “${name}” — ${payload.length} turnos` : `Saved “${name}” — ${payload.length} ${payload.length === 1 ? 'shift' : 'shifts'}`);
      } else {
        const week = weekByStart.get(target.weekStart);
        if (!week) return;
        const payload = week.days.map(d => toPayload(data.getDay(d.date)));
        await data.saveTemplate('week', name, payload);
        flash(es ? `Se guardó “${name}” — semana completa` : `Saved “${name}” — whole week`);
      }
    };
    run().catch(e => flash(e instanceof Error ? e.message : (es ? 'No se pudo guardar la plantilla' : 'Couldn’t save the template')));
  };

  const removeTemplate = (t: ScheduleTemplate) => {
    if (!window.confirm(es ? `¿Eliminar la plantilla “${t.name}”?` : `Delete the “${t.name}” template?`)) return;
    data.deleteTemplate(t.id)
      .then(() => flash(es ? `Se eliminó “${t.name}”` : `Deleted “${t.name}”`))
      .catch(() => flash(es ? 'No se pudo eliminar' : 'Couldn’t delete'));
  };

  // ── finish week ────────────────────────────────────────────────────────
  const weekDone = data.doneWeeks.has(selWeekStart);
  const toggleWeekDone = () => {
    data.setWeekDone(selWeekStart, !weekDone)
      .then(() => flash(weekDone
        ? (es ? `${selWeek.label} está de nuevo en curso` : `${selWeek.label} is back in progress`)
        : (es ? `${selWeek.label} marcada como lista` : `${selWeek.label} marked done`)))
      .catch(e => flash(e instanceof Error ? e.message : 'Error'));
  };

  // ── navigation ─────────────────────────────────────────────────────────
  const stepDay = (dir: 1 | -1) => {
    const next = addDaysYmd(selDate, dir);
    if (next > data.windowEnd) return;
    if (next < data.windowStart) {
      if (!data.canExtendBack) return;
      data.extendBack();
    }
    setSelDate(next);
    setExpandedWeekStart(sundayOf(next));
  };
  const stepWeek = (dir: 1 | -1) => {
    const next = addDaysYmd(selWeekStart, dir * 7);
    if (next > data.windowEnd) return;
    if (next < data.windowStart) {
      if (!data.canExtendBack) return;
      data.extendBack();
    }
    setSelWeekStart(next);
  };
  const dayBackDisabled = selDate <= data.windowStart && !data.canExtendBack;
  const dayFwdDisabled = addDaysYmd(selDate, 1) > data.windowEnd;
  const weekBackDisabled = selWeekStart <= data.windowStart && !data.canExtendBack;
  const weekFwdDisabled = addDaysYmd(selWeekStart, 7) > data.windowEnd;

  const switchView = (v: 'day' | 'week') => {
    if (v === view) return;
    if (v === 'week') {
      setSelWeekStart(sundayOf(selDate));
    } else {
      if (sundayOf(selDate) !== selWeekStart) {
        setSelDate(selWeekStart === sundayOf(data.today) ? data.today : selWeekStart);
      }
      setExpandedWeekStart(selWeekStart);
    }
    setView(v);
  };

  // ── derived display bits ───────────────────────────────────────────────
  const lanes: DeptKey[] = useMemo(() => {
    const base: DeptKey[] = ['housekeeping', 'front_desk', 'maintenance'];
    if (dayShifts.some(s => s.dept === 'other') || activeStaff.some(s => asDeptKey(s.department) === 'other')) {
      base.push('other');
    }
    return base;
  }, [dayShifts, activeStaff]);
  const cover = lanes.map(dep => ({ dept: dep, have: dayShifts.filter(s => s.dept === dep).length }));

  const dayTag = day.today ? (es ? 'HOY' : 'TODAY')
    : day.tomorrow ? (es ? 'MAÑANA' : 'TOMORROW')
    : day.yesterday ? (es ? 'AYER' : 'YESTERDAY')
    : day.past ? (es ? 'HISTORIAL' : 'HISTORY') : null;
  const weekTag = selWeek.current ? (es ? 'ESTA SEMANA' : 'THIS WEEK')
    : selWeek.past ? (es ? 'HISTORIAL' : 'HISTORY') : null;

  const eyebrow = day.today
    ? (es ? 'En el piso hoy' : 'On the floor today')
    : day.past ? (es ? 'Quién trabajó' : 'Who worked') : (es ? 'Cobertura planeada' : 'Planned coverage');

  const fillCurrentCount = view === 'day'
    ? dayShifts.length
    : selWeek.days.reduce((n, d) => n + (data.countByDate[d.date] ?? 0), 0);

  // Auto-scroll the week-box rails so the selected box is visible (the
  // window holds months of history to the left).
  const dayRailRef = useRef<HTMLDivElement>(null);
  const weekRailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const rail = view === 'day' ? dayRailRef.current : weekRailRef.current;
    const target = view === 'day' ? expandedWeekStart : selWeekStart;
    const el = rail?.querySelector(`[data-week="${target}"]`) as HTMLElement | null;
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'auto' });
  }, [view, expandedWeekStart, selWeekStart, weeks.length]);

  // ── shared cards ───────────────────────────────────────────────────────
  const dayCard = (d: DayInfo) => {
    const isSel = d.date === selDate;
    return (
      <button key={d.date} onClick={() => setSelDate(d.date)} style={{
        flex: '0 0 auto', width: 118, textAlign: 'left', cursor: 'pointer',
        border: `1px solid ${isSel ? T.ink : (d.today ? T.ink : T.rule)}`,
        borderRadius: 14, padding: '12px 13px',
        background: isSel ? T.ink : T.paper,
        color: isSel ? T.bg : T.ink, transition: 'all .12s',
        boxShadow: isSel ? '0 6px 18px rgba(31,35,28,0.16)' : (d.today ? HL_SHADOW : 'none'),
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{
            fontFamily: fonts.mono, fontSize: 10, letterSpacing: '0.08em',
            fontWeight: d.today ? 800 : 600,
            color: isSel ? 'rgba(255,255,255,0.7)' : (d.today ? T.ink : T.ink3),
          }}>{d.dow.toUpperCase()}{d.today ? (es ? ' · HOY' : ' · NOW') : ''}</span>
        </div>
        <div style={{
          fontFamily: fonts.serif, fontSize: 26, fontStyle: 'italic', lineHeight: 1,
          margin: '3px 0 0', color: isSel ? T.bg : T.ink,
        }}>{d.dayNum}</div>
      </button>
    );
  };

  const weekBoxCard = (w: WeekInfo, isSel: boolean, onPick: () => void) => {
    const planned = w.days.reduce((n, d) => n + (data.countByDate[d.date] ?? 0), 0);
    const done = data.doneWeeks.has(w.start);
    return (
      <button key={w.start} data-week={w.start} onClick={onPick} style={{
        flex: '0 0 auto', width: 158, textAlign: 'left', cursor: 'pointer',
        border: `1px solid ${isSel ? T.ink : (w.current ? T.ink : T.rule)}`,
        borderRadius: 14, padding: '12px 14px',
        background: isSel ? T.ink : T.paper,
        color: isSel ? T.bg : T.ink, transition: 'all .12s',
        boxShadow: isSel ? '0 6px 18px rgba(31,35,28,0.16)' : (w.current ? HL_SHADOW : 'none'),
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{
            fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: '0.1em',
            fontWeight: w.current ? 800 : 600,
            color: isSel ? 'rgba(255,255,255,0.7)' : (w.current ? T.ink : T.ink3),
          }}>{w.current ? (es ? 'ESTA SEMANA' : 'THIS WEEK') : w.past ? (es ? 'HISTORIAL' : 'HISTORY') : (es ? 'SEMANA' : 'WEEK')}</span>
          {done && (
            <span style={{
              fontFamily: fonts.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
              color: isSel ? '#A8C4AE' : T.sageDeep,
            }}>✓</span>
          )}
        </div>
        <div style={{
          fontFamily: fonts.serif, fontSize: 20, fontStyle: 'italic', lineHeight: 1.05,
          margin: '4px 0 9px', whiteSpace: 'nowrap', color: isSel ? T.bg : T.ink,
        }}>{w.label}</div>
        <div style={{
          fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: '0.03em', fontWeight: 600,
          color: done ? (isSel ? '#A8C4AE' : T.sageDeep) : (isSel ? 'rgba(255,255,255,0.6)' : T.ink3),
        }}>
          {done
            ? (es ? '✓ LISTA' : '✓ DONE')
            : planned === 0 ? (es ? 'SIN PLANEAR' : 'NOT PLANNED')
            : `${planned} ${planned === 1 ? (es ? 'TURNO' : 'SHIFT') : (es ? 'TURNOS' : 'SHIFTS')}`}
        </div>
      </button>
    );
  };

  const ghostSq: React.CSSProperties = { width: 32, padding: 0, justifyContent: 'center' };

  // ── render ─────────────────────────────────────────────────────────────
  return (
    <div style={{ background: T.bg, color: T.ink, fontFamily: fonts.sans, minHeight: '100%', padding: '22px 48px 30px' }}>

      {/* header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 18, gap: 16, minHeight: 44, flexWrap: 'wrap',
      }}>
        <h1 style={{
          fontFamily: fonts.serif, fontSize: 34, margin: 0, letterSpacing: '-0.03em',
          lineHeight: 1.05, fontWeight: 400, whiteSpace: 'nowrap', color: T.ink,
        }}>
          {view === 'day' ? (
            <>
              <span style={{ fontStyle: 'italic' }}>{day.dowFull},</span>{' '}
              {es ? `${day.dayNum} ${day.mon}` : `${day.mon} ${day.dayNum}`}
              {dayTag && (
                <span style={{
                  fontFamily: fonts.mono, fontSize: 11, fontWeight: 600, letterSpacing: '0.14em',
                  textTransform: 'uppercase', verticalAlign: 'middle', marginLeft: 14,
                  color: day.today ? T.caramelDeep : T.ink3,
                }}>{dayTag}</span>
              )}
            </>
          ) : (
            <>
              <span style={{ fontStyle: 'italic' }}>{es ? 'Semana,' : 'Week,'}</span> {selWeek.label}
              {weekTag && (
                <span style={{
                  fontFamily: fonts.mono, fontSize: 11, fontWeight: 600, letterSpacing: '0.14em',
                  textTransform: 'uppercase', verticalAlign: 'middle', marginLeft: 16,
                  color: selWeek.current ? T.caramelDeep : T.ink3,
                }}>{weekTag}</span>
              )}
            </>
          )}
        </h1>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          {view === 'week' && (
            weekDone ? (
              <Btn variant="sage" size="md" onClick={toggleWeekDone}>✓ {es ? 'Lista' : 'Done'}</Btn>
            ) : (
              <Btn variant="ghost" size="md" onClick={toggleWeekDone}>{es ? 'Terminar semana' : 'Finish week'}</Btn>
            )
          )}
          <Btn variant="ghost" size="md" onClick={printWeek}
            title={es ? 'Imprimir o guardar la semana como PDF' : 'Print or save the week as a PDF'}>
            ⎙ {es ? 'Imprimir' : 'Print'}
          </Btn>
          <Btn variant="ghost" size="md" onClick={onUndo} disabled={!data.undoCount}
            title={es ? 'Deshacer tu último cambio' : 'Undo your last change'}>↩ {es ? 'Deshacer' : 'Undo'}</Btn>
          <Btn variant="ghost" size="md" onClick={() => setFillOpen(true)}>{es ? 'Llenar' : 'Fill'}</Btn>
          <span style={{ width: 1, height: 24, background: T.rule, margin: '0 4px' }}/>
          <Btn variant="ghost" size="md" style={ghostSq}
            disabled={view === 'day' ? dayBackDisabled : weekBackDisabled}
            onClick={() => (view === 'day' ? stepDay(-1) : stepWeek(-1))}>‹</Btn>
          <Btn variant="ghost" size="md" style={ghostSq}
            disabled={view === 'day' ? dayFwdDisabled : weekFwdDisabled}
            onClick={() => (view === 'day' ? stepDay(1) : stepWeek(1))}>›</Btn>
          <div style={{
            display: 'inline-flex', gap: 3, background: '#FBFAF6',
            border: `1px solid ${T.rule}`, borderRadius: 999, padding: 3,
          }}>
            {([['day', es ? 'Día' : 'Day'], ['week', es ? 'Semana' : 'Week']] as const).map(([k, lab]) => (
              <button key={k} onClick={() => switchView(k)} style={{
                border: 'none', borderRadius: 999, padding: '6px 12px', cursor: 'pointer',
                fontFamily: fonts.sans, fontSize: 12, fontWeight: 600,
                background: view === k ? T.ink : 'transparent',
                color: view === k ? T.bg : T.ink2, transition: 'all .12s',
              }}>{lab}</button>
            ))}
          </div>
        </div>
      </div>

      {view === 'day' && (
        <>
          {/* DAY HERO — coverage strip + editable board */}
          <Card style={{ overflow: 'hidden', marginBottom: 14, padding: 0 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 16,
              borderBottom: `1px solid ${T.rule}`, background: '#FBFAF6', padding: '13px 22px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexShrink: 0 }}>
                  <Caps size={9} style={{ whiteSpace: 'nowrap' }}>{eyebrow}</Caps>
                  <span style={{ fontFamily: fonts.serif, fontSize: 28, lineHeight: 1, whiteSpace: 'nowrap', color: T.ink }}>
                    {dayShifts.length}
                    <span style={{ fontSize: 14, color: T.ink3 }}> {es ? 'en turno' : 'on'}</span>
                  </span>
                </div>
                <span style={{ width: 1, height: 24, background: T.rule, flexShrink: 0 }}/>
                <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
                  {cover.map(c => {
                    const m = deptMeta[c.dept];
                    return (
                      <span key={c.dept} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: m.tone }}/>
                        <span style={{ fontSize: 13, fontWeight: 600, color: T.ink, whiteSpace: 'nowrap' }}>{m.label}</span>
                        <span style={{ fontFamily: fonts.serif, fontSize: 20, color: T.ink, lineHeight: 1, marginLeft: 2 }}>{c.have}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
              <Btn variant="ghost" size="sm" onClick={() => setPickerOpen(true)} style={{ flexShrink: 0 }}>
                ＋ {es ? 'Agregar personal' : 'Add staff'}
              </Btn>
            </div>
            <DayBoard
              shifts={dayShifts}
              presets={data.presets}
              isToday={day.today}
              lang={lang}
              nameOf={data.nameOf}
              otTitles={otTitles}
              onUpdate={onBoardUpdate}
              onGestureStart={onGestureStart}
              onGestureEnd={onGestureEnd}
              onRemove={onRemoveShift}
              onTapShift={setEditorId}
            />
          </Card>

          {/* WEEK-DAYS STRIP */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            margin: '2px 2px 10px', gap: 12, flexWrap: 'wrap',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <Caps>{expandedWeek.current ? (es ? 'Esta semana' : 'This week') : (es ? 'Semana del' : 'Week of')}</Caps>
              <Caps c={T.caramelDeep}>{expandedWeek.label}</Caps>
            </div>
            <span style={{
              fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: '0.06em',
              color: data.pendingTor.length > 0 ? T.caramelDeep : T.ink3,
              fontWeight: data.pendingTor.length > 0 ? 700 : 500, textTransform: 'uppercase',
            }}>
              {data.pendingTor.length} {es
                ? `solicitud${data.pendingTor.length === 1 ? '' : 'es'} de tiempo libre`
                : `time-off request${data.pendingTor.length === 1 ? '' : 's'} pending`}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 6 }}>
            {expandedWeek.days.map(dayCard)}
          </div>

          {/* PLAN BY WEEK */}
          <div style={{ margin: '22px 2px 10px' }}>
            <Caps>{es ? 'Planear por semana · dom–sáb' : 'Plan by week · Sun–Sat'}</Caps>
          </div>
          <div ref={dayRailRef} style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 6 }}>
            {weeks.map(w => weekBoxCard(w, expandedWeekStart === w.start, () => setExpandedWeekStart(w.start)))}
          </div>

          {/* TIME OFF — pending requests, bottom-left */}
          <TimeOffSection
            pending={data.pendingTor}
            decidedCount={data.decidedTor.length}
            staff={staff}
            today={data.today}
            lang={lang}
            onDecide={data.decideTor}
            onOpenHistory={() => setTorHistoryOpen(true)}
          />
        </>
      )}

      {view === 'week' && (
        <>
          <WeekRoster
            days={selWeek.days}
            getDay={data.getDay}
            staff={staff}
            lang={lang}
            animNonce={weekAnim}
            reducedMotion={reducedMotion}
            onPickDay={(date) => {
              setSelDate(date);
              setExpandedWeekStart(sundayOf(date));
              setView('day');
            }}
          />
          <div style={{ margin: '18px 2px 10px' }}>
            <Caps>{es ? 'Ir a una semana' : 'Jump to a week'}</Caps>
          </div>
          <div ref={weekRailRef} style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 6 }}>
            {weeks.map(w => weekBoxCard(w, selWeekStart === w.start, () => setSelWeekStart(w.start)))}
          </div>
        </>
      )}

      {/* toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 1200,
          padding: '11px 18px', background: 'rgba(244,247,244,0.97)',
          border: '1px solid rgba(104,131,114,0.3)', borderRadius: 999,
          fontSize: 13, fontWeight: 600, color: T.sageDeep,
          boxShadow: '0 10px 30px rgba(31,35,28,0.12)', whiteSpace: 'nowrap',
        }}>✓ {toast}</div>
      )}

      {/* loading hint */}
      {data.loading && (
        <div style={{
          position: 'fixed', bottom: 14, right: 14, zIndex: 1200,
          fontFamily: fonts.mono, fontSize: 10, color: T.ink3, letterSpacing: '0.08em',
        }}>{es ? 'CARGANDO…' : 'LOADING…'}</div>
      )}

      {/* modals */}
      {fillOpen && (
        <FillModal
          scope={view}
          subLabel={view === 'day' ? dayPhrase(day) : selWeek.label}
          templates={data.templates.filter(t => t.scope === view)}
          currentCount={fillCurrentCount}
          weeks={weeks}
          today={data.today}
          selDate={selDate}
          selWeekStart={selWeekStart}
          getDay={data.getDay}
          staff={staff}
          lang={lang}
          nameOf={data.nameOf}
          onApplyTemplate={applyTemplate}
          onSaveCurrent={(name) => saveTemplateFrom(name, view === 'day' ? { date: selDate } : { weekStart: selWeekStart })}
          onSaveAt={saveTemplateFrom}
          onDeleteTemplate={removeTemplate}
          onHistoryDay={applyHistoryDay}
          onHistoryWeek={applyHistoryWeek}
          onClose={() => setFillOpen(false)}
          reducedMotion={reducedMotion}
        />
      )}
      {pickerOpen && (
        <AddStaffModal
          staff={staff}
          takenIds={new Set(dayShifts.map(s => s.staffId))}
          presets={data.presets}
          dayTitle={day.today
            ? (es ? 'Agregar a alguien hoy' : 'Add someone to today')
            : (es ? `Agregar a alguien el ${day.dowFull} ${day.dayNum}` : `Add someone to ${day.dowFull} ${day.dayNum}`)}
          dayPhrase={dayPhrase(day)}
          lang={lang}
          weekMinutes={dayWeekMinutes}
          approvedTorByStaff={approvedTorByStaff}
          onPick={onPickStaff}
          onOpenDirectory={() => { setPickerOpen(false); onOpenDirectory(); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {torHistoryOpen && (
        <TimeOffHistoryModal
          decided={data.decidedTor}
          staff={staff}
          today={data.today}
          lang={lang}
          onClose={() => setTorHistoryOpen(false)}
        />
      )}
      {editorShift && (
        <ShiftEditorModal
          shift={editorShift}
          staffName={data.nameOf(editorShift.staffId)}
          dayLabel={dayPhrase(day)}
          lang={lang}
          onSave={onEditorSave}
          onRemove={onEditorRemove}
          onClose={() => setEditorId(null)}
        />
      )}
    </div>
  );
}

// ── printable week (one button → browser print dialog → paper or PDF) ──────
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function printableWeekHtml({
  week, staff, getDay, nameOf, capMinById, propertyName, lang,
}: {
  week: WeekInfo;
  staff: StaffMember[];
  getDay: (date: string) => BoardShift[];
  nameOf: (staffId: string) => string;
  capMinById: Map<string, number>;
  propertyName?: string;
  lang: 'en' | 'es';
}) {
  const es = lang === 'es';
  const dayLists = week.days.map(d => getDay(d.date));
  const weekMin = weekMinutesByStaff(dayLists);
  const shiftFor = new Map<string, BoardShift>();
  week.days.forEach((d, i) => {
    for (const s of dayLists[i]) shiftFor.set(`${s.staffId}:${d.date}`, s);
  });

  const lanes: DeptKey[] = ['housekeeping', 'front_desk', 'maintenance', 'other'];
  const active = staff.filter(s => s.isActive !== false);
  const rows: string[] = [];
  for (const dep of lanes) {
    const list = active
      .filter(s => asDeptKey(s.department) === dep)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (list.length === 0) continue;
    rows.push(`<tr class="dept"><td colspan="9">${esc(deptMeta[dep].label)}</td></tr>`);
    for (const s of list) {
      const min = weekMin.get(s.id) ?? 0;
      const over = min > (capMinById.get(s.id) ?? DEFAULT_WEEKLY_CAP * 60);
      const cells = week.days.map(d => {
        const sh = shiftFor.get(`${s.id}:${d.date}`);
        if (!sh) return '<td></td>';
        const note = sh.note ? `<div class="note">${esc(sh.note)}</div>` : '';
        return `<td><div class="chip">${fmtMinRange(sh.startMin, sh.endMin)}</div>${note}</td>`;
      }).join('');
      rows.push(`<tr><td class="name">${esc(nameOf(s.id))}</td>${cells}<td class="hours${over ? ' ot' : ''}">${min > 0 ? fmtHours(min) + (over ? ' OT' : '') : ''}</td></tr>`);
    }
  }
  const counts = week.days.map((d, i) => `<td>${dayLists[i].length}</td>`).join('');

  const title = `${propertyName ? esc(propertyName) + ' — ' : ''}${es ? 'Semana' : 'Week'} ${esc(week.label)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; color: #1F231C; margin: 28px; }
  h1 { font-size: 19px; margin: 0; font-weight: 600; }
  .sub { font-size: 11px; color: #5C625C; margin: 3px 0 16px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #C9CCC9; padding: 5px 6px; font-size: 10.5px; text-align: center; vertical-align: top; }
  th { background: #F2F1EC; font-weight: 700; }
  th .num { font-size: 13px; font-weight: 400; display: block; }
  td.name, th.name { text-align: left; white-space: nowrap; font-weight: 600; }
  tr.dept td { background: #F7F6F2; text-align: left; font-weight: 700; font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; }
  .chip { font-weight: 600; white-space: nowrap; }
  .note { font-size: 8.5px; color: #5C625C; margin-top: 2px; }
  td.hours { font-weight: 700; white-space: nowrap; }
  td.hours.ot { color: #A04A2C; }
  tr.count td { background: #F7F6F2; font-weight: 700; }
  @media print { body { margin: 10mm; } }
</style></head><body>
<h1>${title}</h1>
<div class="sub">${es ? 'Impreso desde Staxis' : 'Printed from Staxis'} · ${esc(new Date().toLocaleDateString())}</div>
<table>
  <tr>
    <th class="name">${es ? 'PERSONAL' : 'STAFF'}</th>
    ${week.days.map(d => `<th>${esc(d.dow.toUpperCase())}<span class="num">${d.mon} ${d.dayNum}</span></th>`).join('')}
    <th>${es ? 'HORAS' : 'HOURS'}</th>
  </tr>
  ${rows.join('\n')}
  <tr class="count"><td class="name">${es ? 'EN TURNO' : 'ON SHIFT'}</td>${counts}<td></td></tr>
</table>
</body></html>`;
}
