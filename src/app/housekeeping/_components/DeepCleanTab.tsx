'use client';

// Snow / simplified Deep Clean from the Claude Design housekeeping
// handoff (May 2026). The user said the previous version was "way too
// complicated for just something like you just list who rooms are deep
// clean," so the design is essentially a list:
//   • Header: "{n} overdue · {n} due soon · {n} fresh"
//   • Today's suggestion banner (sage gradient): how many cleans fit today
//   • Two columns: Overdue list + Recent log
//   • Cadence settings tucked into a button → modal
//
// Hooks preserved: getDeepCleanConfig, setDeepCleanConfig,
// getDeepCleanRecords, markRoomDeepCleaned, subscribeToRooms.
// Dropped from the JSX (data layer untouched): assign-team modal,
// complete-room modal with date picker, add-rooms modal, collapsible
// floors. Schedule button on each overdue room flips it to in-progress
// via markRoomDeepCleaned.

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import {
  subscribeToRooms,
  getDeepCleanConfig, setDeepCleanConfig, getDeepCleanRecords,
  assignRoomDeepClean,
} from '@/lib/db';
import { useTodayStr } from '@/lib/use-today-str';
import type { Room, DeepCleanConfig, DeepCleanRecord } from '@/types';
import { calcDndFreedMinutes, suggestDeepCleans } from '@/lib/calculations';
import { format } from 'date-fns';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Pill, Btn,
} from './_snow';

type RowStatus = 'fresh' | 'due-soon' | 'overdue' | 'never';

interface RoomInfo {
  number: string;
  daysSince: number;
  parDays: number;
  lastCleaned: string | null;
  cleanedBy: string | null;
  status: RowStatus;
  inProgress: boolean;
}

export function DeepCleanTab() {
  const { user } = useAuth();
  const { activePropertyId, activeProperty } = useProperty();
  const { lang } = useLang();
  const todayStrReactive = useTodayStr();

  const [config, setConfigState] = useState<DeepCleanConfig | null>(null);
  const [records, setRecords] = useState<Record<string, DeepCleanRecord>>({});
  const [todayRooms, setTodayRooms] = useState<Room[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [toastKind, setToastKind] = useState<'success' | 'error'>('success');
  const [showCadence, setShowCadence] = useState(false);
  // Default cadence is 90 days — matches the historical behavior on
  // properties that haven't explicitly configured one. The Claude Design
  // mock used 28 (which is fine for housekeeper-rotation) but the prior
  // production default was 90, and a quieter cycle is the conservative
  // choice for a hotel that hasn't actively opted in.
  const [cadenceDraft, setCadenceDraft] = useState<number>(90);
  const [savingCadence, setSavingCadence] = useState(false);
  // Tracks the bulk-schedule promise so rapid clicks on "Schedule N deep
  // cleans" can't fire the same writes 3× before optimistic state updates.
  const [bulkScheduling, setBulkScheduling] = useState(false);
  // `loaded` flips true after the first records-fetch resolves so the
  // empty list doesn't flash "Nothing overdue" while still loading.
  const [loaded, setLoaded] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const uid = user?.uid ?? '';
  const pid = activePropertyId ?? '';

  // `today` reactively rebuilds when todayStrReactive flips at midnight,
  // so a tab left open overnight doesn't quietly compute days-since-clean
  // off yesterday's date. Identity stability still matters for downstream
  // useMemos — keying off the string means it only changes once per day.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: midnight rollover trigger
  const today = useMemo(() => new Date(), [todayStrReactive]);

  // Parse a YYYY-MM-DD string as a *local* date (midnight in the user's
  // timezone) instead of UTC midnight. `new Date('2026-05-12')` parses
  // as UTC, so the manager in CDT sees it as 2026-05-11 19:00 — and the
  // recent-log row displays "May 11" for a clean that actually happened
  // May 12. This helper anchors the date in the local zone so labels and
  // days-since math agree.
  const parseLocalDate = (ymd: string | null | undefined): Date | null => {
    if (!ymd) return null;
    const parts = ymd.split('-').map(Number);
    if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  };

  const allRoomNumbers = useMemo(() => {
    const inv = activeProperty?.roomInventory ?? [];
    if (inv.length > 0) return inv;
    // Comfort Suites Beaumont fallback layout — matches the previous tab
    // for properties that haven't been onboarded yet.
    const out: string[] = [];
    [101,102,103,104,105,106,108,110,112].forEach(n => out.push(String(n)));
    for (let r = 201; r <= 222; r++) if (r !== 213) out.push(String(r));
    for (let r = 300; r <= 322; r++) if (r !== 313) out.push(String(r));
    for (let r = 400; r <= 422; r++) if (r !== 413) out.push(String(r));
    return out;
  }, [activeProperty?.roomInventory]);

  // Refresh records from DB. Extracted because we call it on mount, on
  // tab-visibility change, and on a 60s timer — there's no realtime
  // channel on deep_clean_records yet (see audit fix #2). Without this,
  // a completed deep clean wouldn't surface until tab remount.
  const refreshRecords = useCallback(async (opts?: { silent?: boolean }) => {
    if (!uid || !pid) return;
    try {
      const r = await getDeepCleanRecords(uid, pid);
      const map: Record<string, DeepCleanRecord> = {};
      for (const rec of r) map[rec.roomNumber] = rec;
      setRecords(map);
    } catch (err) {
      console.error('[DeepCleanTab] records fetch failed:', err);
      if (!opts?.silent) {
        setToastKind('error');
        setToast(lang === 'es' ? 'No se pudo cargar limpieza profunda' : 'Could not load deep clean data');
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 3500);
      }
    } finally {
      setLoaded(true);
    }
  }, [uid, pid, lang]);

  // Load config + records on mount/property-change + subscribe to today's
  // rooms for DND math. Resets local state immediately when uid/pid
  // changes so a slow response from the previous property can't paint
  // its data over the new one (and the loading skeleton shows again
  // during the gap).
  useEffect(() => {
    if (!uid || !pid) return;
    setLoaded(false);
    setRecords({});
    setConfigState(null);
    let cancelled = false;
    getDeepCleanConfig(uid, pid).then(c => {
      if (cancelled) return;
      setConfigState(c);
      if (c?.frequencyDays) setCadenceDraft(c.frequencyDays);
    }).catch(err => {
      console.error('[DeepCleanTab] config fetch failed:', err);
      // Config failure is recoverable (we fall back to defaults). Don't
      // toast — the records-fetch toast already signals if the DB is down.
    });
    void refreshRecords();
    const unsub = subscribeToRooms(uid, pid, todayStrReactive, setTodayRooms);
    return () => { cancelled = true; unsub(); };
  }, [uid, pid, todayStrReactive, refreshRecords]);

  // Refresh on tab-visibility change (manager comes back from another tab)
  // and every 60s while visible. Cheap stand-in for a realtime channel.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshRecords({ silent: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshRecords({ silent: true });
    }, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(id);
    };
  }, [refreshRecords]);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const flashToast = (msg: string, kind: 'success' | 'error' = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToastKind(kind);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };

  const parDays = config?.frequencyDays ?? 90;

  // ── Derived per-room info ──────────────────────────────────────────────
  const allInfo: RoomInfo[] = useMemo(() => allRoomNumbers.map(num => {
    const rec = records[num];
    if (!rec || !rec.lastDeepClean) {
      return {
        number: num, daysSince: Infinity, parDays,
        lastCleaned: null, cleanedBy: null,
        status: 'never' as const,
        inProgress: rec?.status === 'in_progress',
      };
    }
    const last = parseLocalDate(rec.lastDeepClean);
    if (!last) {
      return {
        number: num, daysSince: Infinity, parDays,
        lastCleaned: null, cleanedBy: null, status: 'never' as const,
        inProgress: rec.status === 'in_progress',
      };
    }
    const daysSince = Math.floor((today.getTime() - last.getTime()) / 86_400_000);
    const ratio = daysSince / parDays;
    let status: RowStatus = 'fresh';
    if (ratio >= 1.0) status = 'overdue';
    else if (ratio >= 0.85) status = 'due-soon';
    return {
      number: num, daysSince, parDays,
      lastCleaned: rec.lastDeepClean,
      cleanedBy: rec.cleanedByTeam?.join(', ') ?? null,
      status,
      inProgress: rec.status === 'in_progress',
    };
  }), [allRoomNumbers, records, parDays, today]);

  // Overdue list excludes rooms already in_progress (Maria scheduled
  // them in this session — they shouldn't keep yelling "OVERDUE!").
  const overdue  = useMemo(() => allInfo
    .filter(r => (r.status === 'overdue' || r.status === 'never') && !r.inProgress)
    .sort((a, b) =>
      (b.daysSince === Infinity ? 99999 : b.daysSince) -
      (a.daysSince === Infinity ? 99999 : a.daysSince),
    ), [allInfo]);

  const scheduled = useMemo(() => allInfo.filter(r => r.inProgress), [allInfo]);

  const dueSoon = useMemo(() => allInfo
    .filter(r => r.status === 'due-soon')
    .sort((a, b) => b.daysSince - a.daysSince), [allInfo]);

  const freshCount = allInfo.filter(r => r.status === 'fresh').length;

  const recentLog = useMemo(() => Object.values(records)
    .filter(r => Boolean(r.lastDeepClean))
    .sort((a, b) => (b.lastDeepClean! > a.lastDeepClean! ? 1 : -1))
    .slice(0, 10), [records]);

  // Today's suggestion — uses the same DND/freed-minutes math as the
  // dashboard's deep-clean alert.
  const dndFreedMins = activeProperty
    ? calcDndFreedMinutes(todayRooms, activeProperty)
    : 0;
  const suggestion = config && overdue.length > 0
    ? suggestDeepCleans(dndFreedMins, 0, config, overdue.length)
    : null;
  const fits = suggestion?.count ?? 0;

  // Schedule a deep clean for one room — sets status='in_progress' via
  // assignRoomDeepClean (NOT markRoomDeepCleaned, which would mark it
  // already-completed and silently advance the cycle date for a clean
  // that hasn't actually happened yet). Empty team = "queued, no
  // specific staff yet" — Maria can assign someone later via a future
  // team-picker modal.
  const handleSchedule = async (roomNumber: string) => {
    if (!uid || !pid) return;
    try {
      await assignRoomDeepClean(uid, pid, roomNumber, []);
      // Optimistic local update — flip status to in_progress so the row
      // re-classifies. lastDeepClean is preserved server-side.
      setRecords(prev => ({
        ...prev,
        [roomNumber]: {
          ...(prev[roomNumber] ?? { roomNumber, lastDeepClean: null }),
          status: 'in_progress',
          cleanedByTeam: prev[roomNumber]?.cleanedByTeam ?? [],
        } as DeepCleanRecord,
      }));
      flashToast(lang === 'es' ? `Limpieza profunda programada · ${roomNumber}` : `Deep clean scheduled · ${roomNumber}`);
    } catch (err) {
      console.error('[DeepCleanTab] schedule failed:', err);
      flashToast(lang === 'es' ? 'No se pudo programar' : 'Could not schedule', 'error');
    }
  };

  const handleSaveCadence = async () => {
    if (!uid || !pid) return;
    setSavingCadence(true);
    try {
      const next: DeepCleanConfig = {
        ...(config ?? { minutesPerRoom: 45, targetPerWeek: 5 }),
        frequencyDays: Math.max(7, cadenceDraft),
      };
      await setDeepCleanConfig(uid, pid, next);
      setConfigState(next);
      setShowCadence(false);
      flashToast(lang === 'es' ? 'Cadencia guardada' : 'Cadence saved');
    } catch (err) {
      console.error('[DeepCleanTab] save cadence failed:', err);
      flashToast(
        lang === 'es' ? 'No se pudo guardar la cadencia' : 'Could not save cadence',
        'error',
      );
    } finally {
      setSavingCadence(false);
    }
  };

  // Skeleton until first records-fetch resolves — without this the
  // header would briefly say "0 overdue · 0 due soon · 0 fresh" and
  // the body would say "Nothing overdue. Nice work." for the half-
  // second the request is in flight, both of which are lies.
  if (!loaded) {
    return (
      <div style={{
        padding: '24px 48px 48px', background: T.bg, color: T.ink,
        fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 12,
      }}>
        <div className="animate-spin" style={{
          width: 28, height: 28,
          border: `2px solid ${T.rule}`, borderTopColor: T.ink, borderRadius: '50%',
        }} />
        <p style={{ color: T.ink2, fontSize: 13 }}>
          {lang === 'es' ? 'Cargando limpieza profunda…' : 'Loading deep clean…'}
        </p>
      </div>
    );
  }

  return (
    <div style={{
      padding: '24px 48px 48px', background: T.bg, color: T.ink,
      fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)',
    }}>

      {/* HEADER */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        marginBottom: 18, gap: 24, flexWrap: 'wrap',
      }}>
        <div>
          <Caps>{lang === 'es' ? 'Limpieza profunda' : 'Deep clean'}</Caps>
          <h1 style={{
            fontFamily: FONT_SERIF, fontSize: 36, color: T.ink, margin: '4px 0 0',
            letterSpacing: '-0.03em', lineHeight: 1.25, fontWeight: 400,
          }}>
            <span style={{ fontStyle: 'italic' }}>
              {overdue.length} {lang === 'es' ? 'atrasadas' : 'overdue'}
            </span>
            <span style={{ color: T.ink3 }}>
              {scheduled.length > 0 && ` · ${scheduled.length} ${lang === 'es' ? 'programadas' : 'scheduled'}`}
              {' · '}{dueSoon.length} {lang === 'es' ? 'próximas' : 'due soon'}
              {' · '}{freshCount} {lang === 'es' ? 'frescas' : 'fresh'}
            </span>
          </h1>
        </div>
        <Btn variant="ghost" size="sm" onClick={() => setShowCadence(true)}>
          ⚙ {lang === 'es' ? 'Cadencia' : 'Cadence settings'}
        </Btn>
      </div>

      {/* TODAY'S SUGGESTION — only renders if there's at least one overdue */}
      {overdue.length > 0 && (
        <div style={{
          background: `linear-gradient(135deg, ${T.sageDim}, rgba(215,176,126,0.06))`,
          border: '1px solid rgba(104,131,114,0.18)', borderRadius: 18,
          padding: '18px 22px', marginBottom: 18,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 18, flexWrap: 'wrap',
        }}>
          <div>
            <Caps c={T.sageDeep}>{lang === 'es' ? 'Sugerencia de hoy' : "Today's suggestion"}</Caps>
            <p style={{
              fontFamily: FONT_SERIF, fontSize: 22, color: T.ink,
              margin: '4px 0 0', lineHeight: 1.3, fontWeight: 400,
            }}>
              {fits > 0 ? (
                <>
                  {lang === 'es' ? 'Cabe(n) ' : 'Fit '}
                  <span style={{ fontStyle: 'italic', color: T.sageDeep }}>
                    {fits} {lang === 'es' ? 'limpieza(s) profunda(s)' : 'deep clean' + (fits === 1 ? '' : 's')}
                  </span>
                  {lang === 'es'
                    ? ` hoy — ${dndFreedMins}m de tiempo DND son recuperables.`
                    : ` today — ${dndFreedMins}m of DND time is reclaimable.`}
                </>
              ) : (
                lang === 'es'
                  ? 'Sin tiempo DND recuperable hoy — programa manualmente abajo.'
                  : 'No DND time reclaimable today — schedule individual rooms below.'
              )}
            </p>
          </div>
          {/* Bulk-schedule button only renders when there's actually
              capacity to schedule. A disabled button next to a "Today's
              suggestion" headline is a misleading affordance. */}
          {fits > 0 && (
            <Btn
              variant="primary"
              size="md"
              disabled={bulkScheduling}
              onClick={async () => {
                if (bulkScheduling) return;
                setBulkScheduling(true);
                try {
                  const queue = overdue.slice(0, fits);
                  await Promise.all(queue.map(r => handleSchedule(r.number)));
                } finally {
                  setBulkScheduling(false);
                }
              }}
            >
              {bulkScheduling
                ? (lang === 'es' ? 'Programando…' : 'Scheduling…')
                : <>{lang === 'es' ? 'Programar' : 'Schedule'} {fits} {lang === 'es' ? 'profunda(s)' : 'deep clean' + (fits === 1 ? '' : 's')} →</>}
            </Btn>
          )}
        </div>
      )}

      {/* TWO-COLUMN: OVERDUE + RECENT */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>

        {/* OVERDUE */}
        <div style={{
          background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
          padding: '8px 22px 16px',
        }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '58px 1fr 78px 90px',
            gap: 10, padding: '14px 0', borderBottom: `1px solid ${T.rule}`, alignItems: 'center',
          }}>
            <Caps size={9}>{lang === 'es' ? 'Cuarto' : 'Room'}</Caps>
            <Caps size={9}>{lang === 'es' ? 'Estado' : 'Status'}</Caps>
            <Caps size={9}>{lang === 'es' ? 'Días' : 'Days'}</Caps>
            <Caps size={9} style={{ textAlign: 'right' }}>{lang === 'es' ? 'Acción' : 'Action'}</Caps>
          </div>

          {overdue.length === 0 && (
            <p style={{
              fontFamily: FONT_SANS, fontSize: 13, color: T.ink2,
              padding: '20px 0', fontStyle: 'italic',
            }}>
              {lang === 'es' ? 'Nada vencido. Buen trabajo.' : 'Nothing overdue. Nice work.'}
            </p>
          )}

          {overdue.map(r => {
            const over = r.daysSince === Infinity ? null : r.daysSince - r.parDays;
            return (
              <div key={r.number} style={{
                display: 'grid', gridTemplateColumns: '58px 1fr 78px 90px',
                gap: 10, padding: '14px 0', borderBottom: `1px solid ${T.ruleSoft}`, alignItems: 'center',
              }}>
                <span style={{
                  fontFamily: FONT_SERIF, fontSize: 22, color: T.ink, fontStyle: 'italic',
                  letterSpacing: '-0.02em', lineHeight: 1, fontWeight: 400,
                }}>{r.number}</span>
                <span>
                  {r.daysSince === Infinity
                    ? <Pill tone="warm">{lang === 'es' ? 'Nunca limpiada' : 'Never cleaned'}</Pill>
                    : <Pill tone="warm">{over}d {lang === 'es' ? 'sobre par' : 'over par'}</Pill>}
                </span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.ink, fontWeight: 500 }}>
                  {r.daysSince === Infinity ? '—' : `${r.daysSince}d`}
                </span>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Btn variant="ghost" size="sm" onClick={() => handleSchedule(r.number)}>
                    {lang === 'es' ? 'Programar' : 'Schedule'}
                  </Btn>
                </div>
              </div>
            );
          })}

          {/* DUE SOON — inline pills */}
          {dueSoon.length > 0 && (
            <div style={{ paddingTop: 14, marginTop: 6 }}>
              <Caps>{lang === 'es' ? 'Próximas' : 'Due soon'}</Caps>
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                {dueSoon.map(r => (
                  <div key={r.number} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '5px 12px', background: T.bg, border: `1px solid ${T.rule}`, borderRadius: 999,
                  }}>
                    <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.ink, fontWeight: 600 }}>
                      {r.number}
                    </span>
                    <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.caramelDeep }}>
                      {r.daysSince}d
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* RECENT LOG */}
        <div style={{
          background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
          padding: '8px 22px 16px',
        }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '70px 60px 1fr 60px',
            gap: 10, padding: '14px 0', borderBottom: `1px solid ${T.rule}`, alignItems: 'center',
          }}>
            <Caps size={9}>{lang === 'es' ? 'Fecha' : 'Date'}</Caps>
            <Caps size={9}>{lang === 'es' ? 'Cuarto' : 'Room'}</Caps>
            <Caps size={9}>{lang === 'es' ? 'Personal' : 'Staff'}</Caps>
            <Caps size={9} style={{ textAlign: 'right' }}>{lang === 'es' ? 'Estado' : 'Status'}</Caps>
          </div>

          {recentLog.length === 0 && (
            <p style={{
              fontFamily: FONT_SANS, fontSize: 13, color: T.ink2,
              padding: '20px 0', fontStyle: 'italic',
            }}>
              {lang === 'es' ? 'Sin registro reciente.' : 'No recent records yet.'}
            </p>
          )}

          {recentLog.map(rc => (
            <div key={rc.roomNumber + rc.lastDeepClean} style={{
              display: 'grid', gridTemplateColumns: '70px 60px 1fr 60px',
              gap: 10, padding: '14px 0', borderBottom: `1px solid ${T.ruleSoft}`, alignItems: 'center',
            }}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.ink2 }}>
                {(() => {
                  const d = parseLocalDate(rc.lastDeepClean);
                  return d ? format(d, 'MMM d') : '—';
                })()}
              </span>
              <span style={{
                fontFamily: FONT_SERIF, fontSize: 20, color: T.ink, fontStyle: 'italic',
                letterSpacing: '-0.02em', lineHeight: 1, fontWeight: 400,
              }}>{rc.roomNumber}</span>
              <span style={{
                fontFamily: FONT_SANS, fontSize: 13, color: T.ink,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {(rc.cleanedByTeam ?? []).join(', ') || (lang === 'es' ? 'Sin asignar' : 'Unassigned')}
              </span>
              <span style={{
                fontFamily: FONT_MONO, fontSize: 12, color: T.sageDeep, fontWeight: 600, textAlign: 'right',
              }}>
                {rc.status === 'completed' ? '✓' : (rc.status === 'in_progress' ? '⏵' : '·')}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* CADENCE MODAL */}
      {showCadence && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(31,35,28,0.32)' }}
            onClick={() => setShowCadence(false)}
          />
          <div style={{
            position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
            zIndex: 61, background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
            padding: '22px 24px', minWidth: 360, maxWidth: 440,
            boxShadow: '0 24px 48px rgba(31,35,28,0.18)',
            display: 'flex', flexDirection: 'column', gap: 16,
          }}>
            <div>
              <Caps>{lang === 'es' ? 'Configuración' : 'Settings'}</Caps>
              <h3 style={{
                fontFamily: FONT_SERIF, fontSize: 28, color: T.ink, margin: '4px 0 0',
                fontStyle: 'italic', letterSpacing: '-0.02em', lineHeight: 1.1,
              }}>
                {lang === 'es' ? 'Cadencia de limpieza profunda' : 'Deep clean cadence'}
              </h3>
              <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, margin: '8px 0 0' }}>
                {lang === 'es'
                  ? 'Cada cuántos días debe limpiarse profundamente cada cuarto.'
                  : 'How many days between deep cleans for each room.'}
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="number"
                min={7}
                max={365}
                value={cadenceDraft}
                onChange={e => setCadenceDraft(parseInt(e.target.value) || 28)}
                style={{
                  width: 100, fontFamily: FONT_MONO, fontSize: 22, fontWeight: 500,
                  border: `1px solid ${T.rule}`, borderRadius: 10, padding: '8px 12px',
                  background: T.bg, color: T.ink, outline: 'none', textAlign: 'right',
                }}
              />
              <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2 }}>
                {lang === 'es' ? 'días' : 'days'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Btn variant="ghost" size="sm" onClick={() => setShowCadence(false)}>
                {lang === 'es' ? 'Cancelar' : 'Cancel'}
              </Btn>
              <Btn variant="primary" size="sm" onClick={handleSaveCadence} disabled={savingCadence}>
                {savingCadence ? (lang === 'es' ? 'Guardando…' : 'Saving…') : (lang === 'es' ? 'Guardar' : 'Save')}
              </Btn>
            </div>
          </div>
        </>
      )}

      {/* TOAST — color flips by toastKind so init-failure surfaces in
          warm tone instead of looking like a successful action. */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          zIndex: 70, padding: '12px 18px',
          background: toastKind === 'error' ? T.warmDim : T.sageDim,
          color:      toastKind === 'error' ? T.warm     : T.sageDeep,
          border: `1px solid ${toastKind === 'error' ? 'rgba(184,92,61,0.3)' : 'rgba(104,131,114,0.3)'}`,
          borderRadius: 999, fontFamily: FONT_SANS, fontSize: 13, fontWeight: 500,
        }}>{toast}</div>
      )}
    </div>
  );
}
