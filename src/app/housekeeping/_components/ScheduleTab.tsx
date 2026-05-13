'use client';

// Snow / simplified Schedule from the Claude Design housekeeping handoff
// (May 2026). The previous version was a 1500-line monolith with public
// areas, drag-to-assign, swap modals, prediction settings, and a Staff
// Priority modal. The user explicitly asked to strip Schedule down to:
//   • PMS pull strip with morning/evening toggle and 5 numbers visible
//   • crew rows with capacity bars + auto-assigned room pills
//   • action band at the bottom: Reset / Auto-assign / Send links
//
// Everything that backs the simpler UI — PlanSnapshot, ShiftConfirmations,
// ScheduleAssignments persistence, work-order blocking, the actual
// /api/send-shift-confirmations POST flow — is preserved. The dropped
// features (public areas, drag-to-assign, swap modals, prediction
// settings, priority modal) are gone from the JSX but their underlying
// data layer is untouched, so we can wire them back into a settings
// modal later if the user misses them.

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  subscribeToPlanSnapshot,
  subscribeToShiftConfirmations,
  subscribeToScheduleAssignments,
  saveScheduleAssignments,
  subscribeToWorkOrders,
} from '@/lib/db';
import type { PlanSnapshot, ScheduleAssignments } from '@/lib/db';
import { autoAssignRooms } from '@/lib/calculations';
import type { ShiftConfirmation, WorkOrder, StaffMember } from '@/types';
import {
  defaultShiftDate, addDays, formatDisplayDate, snapshotToShiftRooms, formatPulledAt,
} from './_shared';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Pill, Btn, HousekeeperDot,
} from './_snow';

type SendResult = { status: 'sent' | 'skipped' | 'failed'; reason?: string };

export function ScheduleTab() {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, staff } = useProperty();
  const { lang } = useLang();

  const [shiftDate, setShiftDate] = useState(defaultShiftDate);
  const [planSnapshot, setPlanSnapshot] = useState<PlanSnapshot | null>(null);
  // Flips true after the first plan-snapshot callback fires (with data or
  // null), so the PMS strip can show a skeleton during the initial fetch
  // instead of zero-counts that read like real data.
  const [planLoaded, setPlanLoaded] = useState(false);
  const [confirmations, setConfirmations] = useState<ShiftConfirmation[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [crewIds, setCrewIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [sendResults, setSendResults] = useState<Map<string, SendResult>>(new Map());
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track which date our local state has been hydrated for. Without this,
  // the debounced persist effect can fire while we're mid-date-switch and
  // overwrite the new date's saved doc with the previous date's
  // assignments. Same class of bug as the 2026-05-07 "Maria's rooms
  // reshuffled" incident — re-introduced when the tab was rewritten, now
  // re-fixed.
  const hydratedDate = useRef<string | null>(null);

  const uid = user?.uid ?? '';
  const pid = activePropertyId ?? '';

  // Switching dates: clear local state immediately and mark un-hydrated
  // so the persist guard below skips the next debounced save until the
  // subscription callback re-fires for the new date.
  useEffect(() => {
    hydratedDate.current = null;
    setAssignments({});
    setCrewIds([]);
    setSendResults(new Map());
  }, [shiftDate]);

  // ── Subscriptions ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!uid || !pid) return;
    setPlanLoaded(false);
    return subscribeToPlanSnapshot(uid, pid, shiftDate, (snap) => {
      setPlanSnapshot(snap);
      setPlanLoaded(true);
    });
  }, [uid, pid, shiftDate]);

  // Hydrate from saved doc inside the subscription callback so we know
  // exactly when the doc for the current date has loaded — required by
  // the persist guard above.
  useEffect(() => {
    if (!uid || !pid) return;
    return subscribeToScheduleAssignments(uid, pid, shiftDate, (doc) => {
      if (doc) {
        setAssignments(doc.roomAssignments ?? {});
        setCrewIds(doc.crew ?? []);
      } else {
        setAssignments({});
        setCrewIds([]);
      }
      hydratedDate.current = shiftDate;
    });
  }, [uid, pid, shiftDate]);

  useEffect(() => {
    if (!uid || !pid) return;
    return subscribeToShiftConfirmations(uid, pid, shiftDate, setConfirmations);
  }, [uid, pid, shiftDate]);

  useEffect(() => {
    if (!uid || !pid) return;
    return subscribeToWorkOrders(uid, pid, setWorkOrders);
  }, [uid, pid]);

  // ── Derived: shift rooms from CSV pull ────────────────────────────────
  const shiftRooms = useMemo(() => snapshotToShiftRooms(planSnapshot, pid), [planSnapshot, pid]);

  const blockedRoomNumbers = useMemo(() => {
    const set = new Set<string>();
    for (const o of workOrders) if (o.status !== 'resolved' && o.blockedRoom) set.add(o.roomNumber);
    return set;
  }, [workOrders]);

  // Rooms eligible for cleaning (excludes blocked rooms)
  const assignableRooms = useMemo(
    () => shiftRooms.filter(r => !blockedRoomNumbers.has(r.number)),
    [shiftRooms, blockedRoomNumbers],
  );

  const checkouts = assignableRooms.filter(r => r.type === 'checkout').length;
  const stayoverDay1 = assignableRooms.filter(r => r.type === 'stayover' && r.stayoverDay === 1).length;
  const stayoverDay2 = assignableRooms.filter(r => r.type === 'stayover' && r.stayoverDay === 2).length;

  // Time math — checkout 30m + stayoverDay1 15m + stayoverDay2 20m by default,
  // or whatever Maria has set in Property settings.
  const ckMin   = activeProperty?.checkoutMinutes      ?? 30;
  const so1Min  = activeProperty?.stayoverDay1Minutes  ?? 15;
  const so2Min  = activeProperty?.stayoverDay2Minutes  ?? 20;
  const totalMinutes = checkouts * ckMin + stayoverDay1 * so1Min + stayoverDay2 * so2Min;
  // Per-housekeeper shift cap. Property setting (default 420 = 7h),
  // not a hardcoded 8h — the auto-assign algorithm and the capacity
  // bars MUST agree on the same number, or the bars will misrepresent
  // what auto-assign actually produced.
  const SHIFT_MINS = activeProperty?.shiftMinutes ?? 420;
  // Recommended housekeeping headcount = cleaning crew needed to cover
  // the total cleaning minutes within shift hours, plus 1 dedicated to
  // laundry. Matches the previous version's `recommendedStaff` formula.
  const LAUNDRY_STAFF = 1;
  const recommendedHKs = Math.max(1, Math.ceil(totalMinutes / SHIFT_MINS)) + LAUNDRY_STAFF;

  // Crew = the staff IDs we're scheduling today. Default to active
  // housekeeping staff if no override has been saved yet. Using
  // `s.isActive !== false` (rather than `=== true`) and a permissive
  // department check means seeded rows with undefined fields still
  // appear — matches the historical behavior on the staff page.
  const housekeepingStaff = useMemo(
    () => staff.filter(s => s.isActive !== false && (!s.department || s.department === 'housekeeping')),
    [staff],
  );

  const activeCrew: StaffMember[] = useMemo(() => {
    const ids = crewIds.length > 0 ? crewIds : housekeepingStaff.map(s => s.id);
    return ids.map(id => staff.find(s => s.id === id)).filter((s): s is StaffMember => Boolean(s));
  }, [crewIds, housekeepingStaff, staff]);

  const offCrew = useMemo(
    () => housekeepingStaff.filter(s => !activeCrew.some(c => c.id === s.id)),
    [housekeepingStaff, activeCrew],
  );

  const fmtTime = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`;
  };

  // ── Persist (debounced) ───────────────────────────────────────────────
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback(() => {
    if (!uid || !pid) return;
    // Only save once we've confirmed the saved doc for the current date
    // has loaded. Without this, the initial-mount empty state would
    // clobber an existing doc within 500ms of opening the tab.
    if (hydratedDate.current !== shiftDate) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const staffNames: Record<string, string> = {};
      activeCrew.forEach(s => { staffNames[s.id] = s.name; });
      saveScheduleAssignments(uid, pid, shiftDate, {
        roomAssignments: assignments,
        crew: activeCrew.map(s => s.id),
        staffNames,
        // Skip the optional csv snapshot fields — saving without them
        // is fine. PlanSnapshot.rooms has a `roomType` field while the
        // schedule_assignments table expects CsvRoomSnapshot's `type`,
        // and mapping isn't worth the noise here.
      }).catch(err => console.error('[Schedule] save failed:', err));
    }, 500);
    // planSnapshot intentionally not in deps — we no longer save the
    // CSV snapshot fields (see comment inside), so referencing it would
    // re-trigger debounced saves on every scraper tick for nothing.
  }, [uid, pid, shiftDate, assignments, activeCrew]);

  useEffect(() => {
    persist();
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [persist]);

  // ── Handlers ──────────────────────────────────────────────────────────
  const handleAutoAssign = () => {
    // Pass the SAME shift cap the UI uses for capacity bars / recommended-HK
    // math. Hardcoding 420 here while the UI reads activeProperty.shiftMinutes
    // would produce bars that disagree with what the algorithm actually
    // distributed (audit finding #1).
    const config = {
      checkoutMinutes:    ckMin,
      stayoverDay1Minutes: so1Min,
      stayoverDay2Minutes: so2Min,
      stayoverMinutes:     activeProperty?.stayoverMinutes      ?? 20,
      prepMinutesPerActivity: activeProperty?.prepMinutesPerActivity ?? 5,
      shiftMinutes:        SHIFT_MINS,
    };
    const next = autoAssignRooms(assignableRooms, activeCrew, config);
    setAssignments(next);
    flashToast(lang === 'es' ? 'Cuartos auto-asignados' : 'Rooms auto-assigned');
  };

  const handleReset = () => {
    setAssignments({});
    flashToast(lang === 'es' ? 'Asignaciones reseteadas' : 'Assignments reset');
  };

  const handleSend = async () => {
    if (sending || !uid || !pid) return;
    setSending(true);
    try {
      const baseUrl = window.location.origin;
      const staffPayload = activeCrew.map(s => ({
        staffId: s.id,
        name: s.name,
        phone: s.phone ?? '',
        language: s.language,
        assignedRooms: assignableRooms.filter(r => assignments[r.id] === s.id).map(r => r.number),
        assignedAreas: [] as string[],
      }));
      const idempotencyKey = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `send-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      const res = await fetchWithAuth('/api/send-shift-confirmations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ uid, pid, shiftDate, baseUrl, staff: staffPayload }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        data?: {
          sent?: number; failed?: number; skipped?: number; updated?: number; fresh?: number;
          perStaff?: Array<{ staffId: string; status: 'sent' | 'skipped' | 'failed'; reason?: string }>;
        };
      };
      const data = body?.data ?? {};
      if (data.perStaff) {
        const m = new Map<string, SendResult>();
        data.perStaff.forEach(r => m.set(r.staffId, { status: r.status, reason: r.reason }));
        setSendResults(m);
      }
      const parts: string[] = [];
      if ((data.fresh ?? 0)   > 0) parts.push(`${data.fresh} ${lang === 'es' ? 'enlaces' : 'links'}`);
      if ((data.updated ?? 0) > 0) parts.push(`${data.updated} ${lang === 'es' ? 'actualizados' : 'updates'}`);
      if ((data.skipped ?? 0) > 0) parts.push(`${data.skipped} ${lang === 'es' ? 'omitidos' : 'skipped'}`);
      if ((data.failed ?? 0)  > 0) parts.push(`${data.failed} ${lang === 'es' ? 'fallaron' : 'failed'}`);
      flashToast(parts.length
        ? `${lang === 'es' ? 'Enviado' : 'Sent'}: ${parts.join(' · ')}`
        : (lang === 'es' ? 'Enviado' : 'Sent'));
    } catch (err) {
      console.error('[Schedule] send failed:', err);
      flashToast(lang === 'es' ? 'Error al enviar' : 'Send failed');
    } finally {
      setSending(false);
    }
  };

  const flashToast = (msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };

  // Shift back/forward controls — date stepper
  const today = useMemo(() => new Date().toLocaleDateString('en-CA'), []);
  const isToday = shiftDate === today;
  const isYesterday = shiftDate === addDays(today, -1);
  const isTomorrow = shiftDate === addDays(today, 1);

  // formatPulledAt prefixes "Today" vs the weekday so a 2-day-old pull
  // and a 1-min-old pull don't both show the same time-of-day. Coerce
  // pulledAt to ISO string for the helper (it can come through as Date
  // from Supabase or string from a cached snapshot).
  const pulledAtIso = planSnapshot?.pulledAt
    ? (planSnapshot.pulledAt instanceof Date
        ? planSnapshot.pulledAt.toISOString()
        : String(planSnapshot.pulledAt))
    : null;
  const pulledAtLabel = pulledAtIso
    ? formatPulledAt(pulledAtIso, lang)
    : (lang === 'es' ? 'sin datos' : 'no data');

  // Confirmation status pill helper
  const confPill = (staffId: string) => {
    const conf = confirmations.find(c => c.staffId === staffId);
    if (!conf) return null;
    if (conf.status === 'confirmed') return <Pill tone="sage">✓ {lang === 'es' ? 'Confirmado' : 'Confirmed'}</Pill>;
    if (conf.status === 'declined')  return <Pill tone="warm">{lang === 'es' ? 'Rechazado' : 'Declined'}</Pill>;
    if (conf.status === 'pending')   return <Pill tone="neutral">{lang === 'es' ? 'Pendiente' : 'Pending'}</Pill>;
    return <Pill tone="caramel">{lang === 'es' ? 'Sin respuesta' : 'No reply'}</Pill>;
  };

  // Send result badge
  const sendBadge = (staffId: string) => {
    const r = sendResults.get(staffId);
    if (!r) return null;
    if (r.status === 'sent')    return <Pill tone="sage">→ {lang === 'es' ? 'Enviado' : 'Link sent'}</Pill>;
    if (r.status === 'skipped') return <Pill tone="caramel">{lang === 'es' ? 'Omitido' : 'Skipped'}{r.reason ? ` · ${r.reason}` : ''}</Pill>;
    if (r.status === 'failed')  return <Pill tone="warm">{lang === 'es' ? 'Falló' : 'Failed'}</Pill>;
    return null;
  };

  return (
    <div style={{
      padding: '24px 48px 48px', background: T.bg, color: T.ink,
      fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)',
    }}>

      {/* DATE STEPPER */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        marginBottom: 18, gap: 24, flexWrap: 'wrap',
      }}>
        <div>
          <Caps>{
            // Show "Schedule" alone for arbitrary past/future dates so we
            // don't render "Schedule · " with a dangling middle-dot.
            (() => {
              if (isToday)     return lang === 'es' ? 'Horario · hoy'     : 'Schedule · today';
              if (isYesterday) return lang === 'es' ? 'Horario · ayer'    : 'Schedule · yesterday';
              if (isTomorrow)  return lang === 'es' ? 'Horario · mañana'  : 'Schedule · tomorrow';
              return lang === 'es' ? 'Horario' : 'Schedule';
            })()
          }</Caps>
          <h1 style={{
            fontFamily: FONT_SERIF, fontSize: 36, color: T.ink, margin: '4px 0 0',
            letterSpacing: '-0.03em', lineHeight: 1.25, fontWeight: 400,
          }}>
            <span style={{ fontStyle: 'italic' }}>{formatDisplayDate(shiftDate, lang).split(',')[0]}</span>
            <span> · {formatDisplayDate(shiftDate, lang).split(',').slice(1).join(',').trim()}</span>
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Btn variant="ghost" size="sm" onClick={() => setShiftDate(addDays(shiftDate, -1))}>← {lang === 'es' ? 'Ayer' : 'Yesterday'}</Btn>
          <Btn variant={isToday ? 'paper' : 'ghost'} size="sm" onClick={() => setShiftDate(today)}>{lang === 'es' ? 'Hoy' : 'Today'}</Btn>
          <Btn variant="ghost" size="sm" onClick={() => setShiftDate(addDays(shiftDate, 1))}>{lang === 'es' ? 'Mañana' : 'Tomorrow'} →</Btn>
        </div>
      </div>

      {/* PMS PULL STRIP — current pull's numbers in plain sight.
          The design also showed ‹/› buttons toggling between morning and
          evening pulls, but the underlying subscription only gives us the
          most-recent pull for the date. Rather than render lying buttons
          we just show the current pull's freshness; we'll add real
          history navigation when the data layer supports it. */}
      <div style={{
        background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
        padding: '18px 22px', marginBottom: 18,
        display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 160 }}>
          <Caps size={9}>{lang === 'es' ? 'Última carga PMS' : 'Latest PMS pull'}</Caps>
          <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500, marginTop: 2 }}>
            {planLoaded ? pulledAtLabel : (lang === 'es' ? 'Cargando…' : 'Loading…')}
          </span>
        </div>
        <span style={{ width: 1, height: 42, background: T.rule }} />
        <div style={{ display: 'flex', gap: 32, flex: 1, flexWrap: 'wrap' }}>
          {/* Skeleton dashes until the first plan-snapshot callback fires
              — without this, the strip momentarily reads "Checkouts: 0
              · Stay·light: 0 · Recommended: 1 HKs" which looks like real
              data on a slow pull. */}
          {[
            { l: lang === 'es' ? 'Salidas'      : 'Checkouts',   v: checkouts },
            { l: lang === 'es' ? 'Estadía·1'    : 'Stay · light',v: stayoverDay1 },
            { l: lang === 'es' ? 'Estadía·2+'   : 'Stay · full', v: stayoverDay2 },
            { l: lang === 'es' ? 'Tiempo total' : 'Total time',  v: fmtTime(totalMinutes) },
            { l: lang === 'es' ? 'Recomendado'  : 'Recommended', v: `${recommendedHKs} HKs`, tone: T.sageDeep },
          ].map(n => (
            <div key={n.l} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 80 }}>
              <Caps size={9}>{n.l}</Caps>
              <span style={{
                fontFamily: FONT_SERIF, fontSize: 30, color: planLoaded ? (n.tone || T.ink) : T.ink3,
                lineHeight: 1, letterSpacing: '-0.02em', fontWeight: 400, whiteSpace: 'nowrap',
              }}>{planLoaded ? n.v : '—'}</span>
            </div>
          ))}
        </div>
      </div>

      {/* CREW ROWS */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {activeCrew.map(c => {
          const myRooms = assignableRooms.filter(r => assignments[r.id] === c.id);
          const minsLoaded = myRooms.reduce((sum, r) => {
            if (r.type === 'checkout') return sum + ckMin;
            if (r.type === 'stayover') return sum + (r.stayoverDay === 1 ? so1Min : so2Min);
            return sum;
          }, 0);
          const pct = Math.min(100, (minsLoaded / SHIFT_MINS) * 100);
          const isOver = minsLoaded > SHIFT_MINS;
          const isNear = !isOver && minsLoaded > SHIFT_MINS * 0.85;
          const status = myRooms.length === 0 ? 'available' : isOver ? 'over' : isNear ? 'near' : 'assigned';
          const dotColor = status === 'over' ? T.warm : status === 'near' ? T.caramelDeep : status === 'available' ? T.sageDeep : T.ink2;

          return (
            <div key={c.id} style={{
              background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 16,
              padding: '18px 22px', display: 'grid',
              gridTemplateColumns: 'auto 1fr auto', gap: 20, alignItems: 'center',
            }}>
              {/* Avatar + name + capacity */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <span style={{ position: 'relative' }}>
                  <HousekeeperDot staff={c} size={48} />
                  <span style={{
                    position: 'absolute', bottom: -2, right: -2,
                    width: 12, height: 12, borderRadius: '50%',
                    background: dotColor, border: `2px solid ${T.paper}`,
                  }} />
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 }}>
                  <span style={{ fontFamily: FONT_SANS, fontSize: 15, color: T.ink, fontWeight: 600 }}>{c.name}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, whiteSpace: 'nowrap' }}>
                      {myRooms.length} {lang === 'es' ? 'cuartos' : 'rooms'} · {fmtTime(minsLoaded)} / 8h
                    </span>
                    {status === 'over'      && <Pill tone="warm">{lang === 'es' ? 'Sobre cupo' : 'Over cap'}</Pill>}
                    {status === 'near'      && <Pill tone="caramel">{lang === 'es' ? 'Casi lleno' : 'Near full'}</Pill>}
                    {status === 'available' && <Pill tone="sage">{lang === 'es' ? 'Disponible' : 'Available'}</Pill>}
                  </div>
                  <div style={{ width: 200, height: 4, background: T.ruleSoft, borderRadius: 2, overflow: 'hidden' }}>
                    <span style={{
                      display: 'block', height: '100%', width: `${pct}%`,
                      background: status === 'over' ? T.warm : status === 'near' ? T.caramelDeep : T.sageDeep,
                    }} />
                  </div>
                </div>
              </div>

              {/* Room pills */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {myRooms.length === 0 ? (
                  <span style={{ fontFamily: FONT_SERIF, fontSize: 14, color: T.ink2, fontStyle: 'italic' }}>
                    {lang === 'es'
                      ? 'Sin asignar — toca Auto-asignar.'
                      : 'No rooms assigned yet — tap Auto-assign.'}
                  </span>
                ) : myRooms.map(r => (
                  <span key={r.id} style={{
                    padding: '5px 11px', borderRadius: 8,
                    background: T.bg, border: `1px solid ${T.rule}`, color: T.ink,
                    fontFamily: FONT_MONO, fontSize: 13, fontWeight: 600, letterSpacing: '-0.02em',
                    whiteSpace: 'nowrap',
                  }}>
                    {r.number}
                    {r.type === 'checkout' && <span style={{ color: T.ink3, fontWeight: 400 }}> ↗</span>}
                    {r.type === 'stayover' && <span style={{ color: T.ink3, fontWeight: 400 }}> ◐</span>}
                  </span>
                ))}
              </div>

              {/* Status pills + per-row actions */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                {sendBadge(c.id) ?? confPill(c.id)}
                <button
                  onClick={() => {
                    const baseline = crewIds.length > 0 ? crewIds : housekeepingStaff.map(s => s.id);
                    setCrewIds(baseline.filter(id => id !== c.id));
                    // Drop their assignments too — otherwise they'd persist
                    // pinned to a person no longer on today's roster.
                    setAssignments(prev => {
                      const next: Record<string, string> = {};
                      for (const [roomId, staffId] of Object.entries(prev)) {
                        if (staffId !== c.id) next[roomId] = staffId;
                      }
                      return next;
                    });
                  }}
                  title={lang === 'es' ? 'Quitar de hoy' : 'Remove from today'}
                  style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    padding: '2px 6px', borderRadius: 4,
                    fontFamily: FONT_SANS, fontSize: 11, color: T.ink3,
                  }}
                >
                  {lang === 'es' ? 'Quitar' : 'Remove'}
                </button>
              </div>
            </div>
          );
        })}

        {/* Off-today crew strip — keeps recently-removed staff one tap away */}
        {offCrew.length > 0 && (
          <div style={{
            marginTop: 4, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '10px 14px', background: T.bg,
          }}>
            <Caps>{lang === 'es' ? 'Disponibles hoy' : 'Available today'}</Caps>
            {offCrew.map(s => (
              <button
                key={s.id}
                onClick={() => {
                  // First add: seed crewIds from the implicit default
                  // (housekeepingStaff) so we don't lose the others.
                  const baseline = crewIds.length > 0 ? crewIds : housekeepingStaff.map(x => x.id);
                  setCrewIds([...baseline, s.id]);
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '4px 12px 4px 4px', borderRadius: 999,
                  background: 'transparent', border: `1px dashed ${T.rule}`, cursor: 'pointer',
                  fontFamily: FONT_SANS, fontSize: 12, color: T.ink2,
                }}
              >
                <HousekeeperDot staff={s} size={22} />
                <span>{s.name}</span>
                <span style={{ color: T.ink3 }}>+ {lang === 'es' ? 'añadir' : 'add'}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ACTION BAND — bottom */}
      <div style={{
        marginTop: 18,
        background: `linear-gradient(135deg, ${T.sageDim}, rgba(201,150,68,0.06))`,
        border: '1px solid rgba(92,122,96,0.18)', borderRadius: 18,
        padding: '14px 22px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 18, flexWrap: 'wrap',
      }}>
        <div>
          <Caps c={T.sageDeep}>{lang === 'es' ? 'Listo para asignar' : 'Ready to assign'}</Caps>
          <p style={{
            fontFamily: FONT_SERIF, fontSize: 22, color: T.ink,
            margin: '4px 0 0', lineHeight: 1.3, fontWeight: 400,
          }}>
            <span style={{ fontStyle: 'italic' }}>
              {assignableRooms.length} {lang === 'es' ? 'cuartos' : 'rooms'}
            </span>
            {' '}{lang === 'es' ? 'entre' : 'across'} {activeCrew.length} {lang === 'es' ? 'limpiadoras activas' : 'active housekeepers'}.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn variant="ghost" size="md" onClick={handleReset}>
            {lang === 'es' ? 'Resetear todo' : 'Reset all'}
          </Btn>
          <Btn variant="primary" size="md" onClick={handleAutoAssign} disabled={activeCrew.length === 0}>
            ↻ {lang === 'es' ? 'Auto-asignar' : 'Auto-assign'} {assignableRooms.length} {lang === 'es' ? 'cuartos' : 'rooms'}
          </Btn>
          <Btn variant="sage" size="md" onClick={handleSend} disabled={sending || activeCrew.length === 0}>
            → {sending ? (lang === 'es' ? 'Enviando…' : 'Sending…') : `${lang === 'es' ? 'Enviar' : 'Send'} ${activeCrew.length} ${lang === 'es' ? 'enlaces' : 'links'}`}
          </Btn>
        </div>
      </div>

      {/* TOAST */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          zIndex: 70, padding: '12px 18px',
          background: T.sageDim, color: T.sageDeep,
          border: '1px solid rgba(104,131,114,0.3)',
          borderRadius: 999, fontFamily: FONT_SANS, fontSize: 13, fontWeight: 500,
        }}>{toast}</div>
      )}

    </div>
  );
}
