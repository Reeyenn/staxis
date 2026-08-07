'use client';

// Deep Clean — "Command" layout from the Claude Design housekeeping
// handoff (June 2026, design_handoff_deepclean). Replaces the prior Snow
// list view. Structure (top → bottom):
//   • Header: "Deep clean" title (serif, "Deep" italic) + mono sub-label
//     "{n}-DAY CADENCE · ROTATION & SCHEDULING" + ⚙ Cadence settings button.
//   • Freshness chips: Overdue · Scheduled? · Due soon · Fresh · Cadence.
//   • Two-column board (1.35fr / 1fr, collapses < 880px): overdue worklist
//     on the left (table + due-soon pills), recent deep-clean log on the
//     right. Newly scheduled rooms surface in the log as "today · Queued · ⏵".
//
// Intentionally dropped per the handoff: the old "Today's suggestion / Fit
// N deep cleans today" green banner and its bulk-schedule button (plus the
// DND-freed-minutes math that fed it). Per-room Schedule + cadence settings
// are the live write actions.
//
// Data layer unchanged: getDeepCleanConfig / setDeepCleanConfig /
// getDeepCleanRecords / assignRoomDeepClean. There's still no realtime
// channel on deep_clean_records, so a 60s timer + visibility refresh stands
// in — without it a completed deep clean wouldn't surface until remount.

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import {
  getDeepCleanConfig, setDeepCleanConfig, getDeepCleanRecords,
  assignRoomDeepClean,
} from '@/lib/db';
import { useTodayStr } from '@/lib/use-today-str';
import type { DeepCleanConfig, DeepCleanRecord } from '@/types';
import {
  T, FONT_SANS, FONT_MONO,
  Caps, Pill, Btn,
} from './_snow';

type RowStatus = 'fresh' | 'due-soon' | 'overdue' | 'never';

interface RoomInfo {
  number: string;
  daysSince: number;
  parDays: number;
  status: RowStatus;
  inProgress: boolean;
}

interface LogEntry {
  key: string;
  roomNumber: string;
  agoDays: number;
  team: string;
  status: 'completed' | 'in_progress';
  sortTs: number;
}

// ── Freshness chip — caps label over a big Geist stat value ────────────────
function StatChip({
  label, value, color,
}: {
  label: string; value: React.ReactNode; color?: string;
}) {
  return (
    <div style={{
      border: `1px solid ${T.rule}`, borderRadius: 13, padding: '11px 16px',
      display: 'flex', flexDirection: 'column', gap: 3, minWidth: 104,
    }}>
      <Caps size={10}>{label}</Caps>
      <span style={{
        fontFamily: FONT_SANS, fontSize: 23, letterSpacing: '-0.02em',
        lineHeight: 0.95, fontWeight: 600, color: color ?? T.ink,
      }}>{value}</span>
    </div>
  );
}

export function DeepCleanTab() {
  const { user } = useAuth();
  const { activePropertyId, activeProperty } = useProperty();
  const todayStrReactive = useTodayStr();

  const [config, setConfigState] = useState<DeepCleanConfig | null>(null);
  // True when the config fetch itself failed (distinct from a genuine
  // no-config-yet null). Saving cadence does a full-row upsert that would
  // reset minutesPerRoom/targetPerWeek to defaults, so a failed load must
  // block the save rather than overwrite real settings with guesses.
  const [configError, setConfigError] = useState(false);
  const [records, setRecords] = useState<Record<string, DeepCleanRecord>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [toastKind, setToastKind] = useState<'success' | 'error'>('success');
  const [showCadence, setShowCadence] = useState(false);
  // Default cadence 90 days — matches the historical production default for
  // properties that haven't explicitly configured one.
  const [cadenceDraft, setCadenceDraft] = useState<number>(90);
  const [savingCadence, setSavingCadence] = useState(false);
  // `loaded` flips true after the first records-fetch resolves so the empty
  // list doesn't flash "Nothing overdue" while the request is still in flight.
  const [loaded, setLoaded] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const uid = user?.uid ?? '';
  const pid = activePropertyId ?? '';

  // `today` reactively rebuilds when todayStrReactive flips at midnight, so a
  // tab left open overnight doesn't compute days-since off yesterday's date.
  // Keying off the string means it only changes once per day (stable identity
  // for downstream useMemos).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: midnight rollover trigger
  const today = useMemo(() => new Date(), [todayStrReactive]);

  // Parse a YYYY-MM-DD string as a *local* date (midnight in the user's zone)
  // instead of UTC midnight, so "May 12" labels and days-since math agree for
  // a manager in CDT (new Date('2026-05-12') would parse as UTC → May 11 19:00).
  const parseLocalDate = (ymd: string | null | undefined): Date | null => {
    if (!ymd) return null;
    const parts = ymd.split('-').map(Number);
    if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  };

  // The hotel's OWN room list, and nothing else.
  //
  // This used to fall back to a hardcoded 101-422 layout (one real hotel's
  // floor plan) whenever roomInventory was empty. Every invented room has no
  // deep-clean record, so it classified as 'never' and the tab printed a
  // 76-room "Overdue" worklist for a hotel that may have 40 rooms with
  // different numbers. Worse, Schedule wrote a real deep_clean_records row
  // against a room number the hotel does not have.
  //
  // Empty means empty, exactly the posture /dashboard takes with the same
  // absence (buildRoomRingTicks(rooms, roomInventory ?? [])): show nothing
  // rather than something invented.
  const allRoomNumbers = useMemo(
    () => activeProperty?.roomInventory ?? [],
    [activeProperty?.roomInventory],
  );
  const roomListMissing = allRoomNumbers.length === 0;

  // Refresh records from DB. Called on mount, on tab-visibility change, and on
  // a 60s timer (no realtime channel on deep_clean_records yet).
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
        setToast('Could not load deep clean data');
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 3500);
      }
    } finally {
      setLoaded(true);
    }
  }, [uid, pid]);

  // Load config + records on mount / property-change. Resets local state
  // immediately when uid/pid changes so a slow response from the previous
  // property can't paint its data over the new one.
  useEffect(() => {
    if (!uid || !pid) return;
    setLoaded(false);
    setRecords({});
    setConfigState(null);
    setConfigError(false);
    let cancelled = false;
    getDeepCleanConfig(uid, pid).then(c => {
      if (cancelled) return;
      setConfigState(c);
      setConfigError(false);
      if (c?.frequencyDays) setCadenceDraft(c.frequencyDays);
    }).catch(err => {
      // Config failed to load. Don't toast — the records-fetch toast already
      // signals if the DB is down — but flag it so a cadence save can't
      // upsert defaults over the property's real (unloaded) settings.
      if (cancelled) return;
      console.error('[DeepCleanTab] config fetch failed:', err);
      setConfigError(true);
    });
    void refreshRecords();
    return () => { cancelled = true; };
  }, [uid, pid, refreshRecords]);

  // Refresh on tab-visibility change + every 60s while visible.
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
  const visibleToast = toast;

  // ── Derived per-room info ──────────────────────────────────────────────
  const allInfo: RoomInfo[] = useMemo(() => allRoomNumbers.map(num => {
    const rec = records[num];
    const last = rec ? parseLocalDate(rec.lastDeepClean) : null;
    if (!rec || !last) {
      return {
        number: num, daysSince: Infinity, parDays,
        status: 'never' as const,
        inProgress: rec?.status === 'in_progress',
      };
    }
    const daysSince = Math.floor((today.getTime() - last.getTime()) / 86_400_000);
    const ratio = daysSince / parDays;
    let status: RowStatus = 'fresh';
    if (ratio >= 1.0) status = 'overdue';
    else if (ratio >= 0.85) status = 'due-soon';
    return {
      number: num, daysSince, parDays, status,
      inProgress: rec.status === 'in_progress',
    };
  }), [allRoomNumbers, records, parDays, today]);

  // Overdue list excludes rooms already scheduled (in_progress) this session —
  // they shouldn't keep yelling "OVERDUE!".
  const overdue = useMemo(() => allInfo
    .filter(r => (r.status === 'overdue' || r.status === 'never') && !r.inProgress)
    .sort((a, b) =>
      (b.daysSince === Infinity ? 99999 : b.daysSince) -
      (a.daysSince === Infinity ? 99999 : a.daysSince),
    ), [allInfo]);

  const scheduled = useMemo(() => allInfo.filter(r => r.inProgress), [allInfo]);

  const dueSoon = useMemo(() => allInfo
    .filter(r => r.status === 'due-soon')
    .sort((a, b) => b.daysSince - a.daysSince), [allInfo]);

  const freshCount = useMemo(() => allInfo.filter(r => r.status === 'fresh').length, [allInfo]);

  // Recent log = currently-queued rooms (status in_progress → "today · Queued ·
  // ⏵") on top, then completed cleans by recency. A re-scheduled room
  // (in_progress with an old lastDeepClean) shows as its queued entry, not the
  // prior completed date.
  const recentLog: LogEntry[] = useMemo(() => {
    const list: LogEntry[] = [];
    for (const rec of Object.values(records)) {
      if (rec.status === 'in_progress') {
        list.push({
          key: rec.roomNumber + ':ip',
          roomNumber: rec.roomNumber,
          agoDays: 0,
          team: (rec.cleanedByTeam ?? []).join(', ') || ('Queued'),
          status: 'in_progress',
          sortTs: Number.POSITIVE_INFINITY,
        });
      } else {
        const last = parseLocalDate(rec.lastDeepClean);
        if (!last) continue;
        const ago = Math.max(0, Math.floor((today.getTime() - last.getTime()) / 86_400_000));
        list.push({
          key: rec.roomNumber + ':' + rec.lastDeepClean,
          roomNumber: rec.roomNumber,
          agoDays: ago,
          team: (rec.cleanedByTeam ?? []).join(', ') || ('Unassigned'),
          status: 'completed',
          sortTs: last.getTime(),
        });
      }
    }
    return list.sort((a, b) => b.sortTs - a.sortTs).slice(0, 12);
  }, [records, today]);

  const agoLabel = (n: number) =>
    n === 0 ? ('today') : (`${n}d ago`);

  // Schedule a deep clean for one room — sets status='in_progress' via
  // assignRoomDeepClean (NOT markRoomDeepCleaned, which would mark it
  // already-completed and silently advance the cycle date for a clean that
  // hasn't happened yet). Empty team = "queued, no specific staff yet".
  const handleSchedule = async (roomNumber: string) => {
    if (!uid || !pid) return;
    // Belt and braces for the invented-rooms bug: never write a
    // deep_clean_records row for a room number that is not on the hotel's own
    // list. With the fallback gone nothing can render such a row, but this
    // write is permanent and the guard costs nothing.
    if (!allRoomNumbers.includes(roomNumber)) return;
    try {
      await assignRoomDeepClean(uid, pid, roomNumber, []);
      // Optimistic local update — flip status to in_progress so the row
      // re-classifies. lastDeepClean is preserved server-side.
      setRecords(prev => ({
        ...prev,
        [roomNumber]: {
          ...(prev[roomNumber] ?? { id: roomNumber, roomNumber, lastDeepClean: '' }),
          status: 'in_progress',
          cleanedByTeam: prev[roomNumber]?.cleanedByTeam ?? [],
        } as DeepCleanRecord,
      }));
      flashToast(`Deep clean scheduled · ${roomNumber}`);
    } catch (err) {
      console.error('[DeepCleanTab] schedule failed:', err);
      flashToast('Could not schedule', 'error');
    }
  };

  const handleSaveCadence = async () => {
    if (!uid || !pid) return;
    // Block the save when the current config never loaded — setDeepCleanConfig
    // upserts every column, so saving here would overwrite minutesPerRoom /
    // targetPerWeek with defaults the manager never saw.
    if (configError) {
      flashToast(
        'Couldn’t load current settings. Reload before saving',
        'error',
      );
      return;
    }
    setSavingCadence(true);
    try {
      const next: DeepCleanConfig = {
        ...(config ?? { minutesPerRoom: 60, targetPerWeek: 5, frequencyDays: 90 }),
        frequencyDays: Math.max(7, Math.min(365, cadenceDraft)),
      };
      await setDeepCleanConfig(uid, pid, next);
      setConfigState(next);
      setShowCadence(false);
      flashToast('Cadence saved');
    } catch (err) {
      console.error('[DeepCleanTab] save cadence failed:', err);
      flashToast('Could not save cadence', 'error');
    } finally {
      setSavingCadence(false);
    }
  };

  // Skeleton until the first records-fetch resolves — without this the chips
  // would briefly read "0 / 0 / 0" and the worklist would say "Nothing
  // overdue. Nice work." for the half-second the request is in flight.
  if (!loaded) {
    return (
      <div style={{
        padding: '24px 48px 130px', background: 'transparent', color: T.ink,
        fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 12,
      }}>
        <div className="animate-spin" style={{
          width: 28, height: 28,
          border: `2px solid ${T.rule}`, borderTopColor: T.ink, borderRadius: '50%',
        }} />
        <p style={{ color: T.ink2, fontSize: 13 }}>
          {'Loading deep clean…'}
        </p>
      </div>
    );
  }

  return (
    <div style={{
      padding: '24px 48px 130px', background: 'transparent', color: T.ink,
      fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)',
    }}>
      {/* Two-column board collapses to one column on narrow windows. Scoped
          to .dc-twocol so the media query can't leak into sibling tabs. */}
      <style>{`
        .dc-twocol { display: grid; grid-template-columns: 1.35fr 1fr; gap: 18px; align-items: start; }
        @media (max-width: 880px) { .dc-twocol { grid-template-columns: 1fr; } }
      `}</style>

      {/* HEADER */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
        gap: 20, flexWrap: 'wrap', margin: '4px 0 18px',
      }}>
        <div>
          <h1 style={{
            fontFamily: FONT_SANS, fontSize: 26, fontWeight: 600, lineHeight: 1.1,
            color: T.ink, margin: 0, letterSpacing: '-0.02em',
          }}>
            <span>{'Deep'}</span>{' '}
            {'clean'}
          </h1>
          <div style={{
            fontFamily: FONT_MONO, fontSize: 11, letterSpacing: '0.04em',
            color: T.ink2, marginTop: 7, textTransform: 'uppercase',
          }}>
            {`${parDays}-day cadence · Rotation & scheduling`}
          </div>
        </div>
        <Btn variant="ghost" size="sm" onClick={() => setShowCadence(true)}>
          ⚙ {'Cadence settings'}
        </Btn>
      </div>

      {/* NO ROOM LIST YET — the honest empty state. Nothing here is
          schedulable, because there is no room to schedule. */}
      {roomListMissing && (
        <div style={{
          background: T.paper, border: `1px dashed ${T.rule}`, borderRadius: 16,
          padding: '30px 24px', maxWidth: 560,
        }}>
          <h2 style={{
            fontFamily: FONT_SANS, fontSize: 17, fontWeight: 600, color: T.ink,
            margin: 0, letterSpacing: '-0.01em',
          }}>
            {'This hotel’s room list isn’t set up yet'}
          </h2>
          <p style={{
            fontFamily: FONT_SANS, fontSize: 13.5, lineHeight: 1.55, color: T.ink2,
            margin: '10px 0 0',
          }}>
            {'Deep clean tracks each room against the cadence, so it needs to know which rooms this hotel has. The room list fills in from the PMS report feed once it is connected, and an admin can also enter it in hotel setup.'}
          </p>
          <p style={{
            fontFamily: FONT_SANS, fontSize: 13.5, lineHeight: 1.55, color: T.ink2,
            margin: '10px 0 0',
          }}>
            {'Nothing can be scheduled until then.'}
          </p>
        </div>
      )}

      {!roomListMissing && (
      <>
      {/* FRESHNESS CHIPS */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
        <StatChip label={'Overdue'} value={overdue.length} color={T.warm} />
        {scheduled.length > 0 && (
          <StatChip label={'Scheduled'} value={scheduled.length} />
        )}
        <StatChip label={'Due soon'} value={dueSoon.length} color={T.caramelDeep} />
        <StatChip label={'Fresh'} value={freshCount} color={T.sageDeep} />
        <StatChip
          label={'Cadence'}
          value={<>{parDays}<span style={{ fontSize: 14, color: T.ink3 }}>d</span></>}
        />
      </div>

      {/* TWO-COLUMN: OVERDUE WORKLIST + RECENT LOG */}
      <div className="dc-twocol">

        {/* OVERDUE WORKLIST */}
        <div style={{
          background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 16,
          padding: '6px 20px 14px',
        }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '60px 1fr 64px 96px', gap: 12,
            padding: '10px 6px', borderBottom: `1px solid ${T.rule}`, alignItems: 'center',
          }}>
            <Caps size={9} tracking="0.14em">{'Room'}</Caps>
            <Caps size={9} tracking="0.14em">{'Status'}</Caps>
            <Caps size={9} tracking="0.14em">{'Days'}</Caps>
            <span />
          </div>

          {overdue.length === 0 && (
            <p style={{
              fontFamily: FONT_SANS, fontSize: 13, color: T.ink2,
              padding: '22px 6px', margin: 0,
            }}>
              {'Nothing overdue. Nice work.'}
            </p>
          )}

          {overdue.map(r => {
            const over = r.daysSince === Infinity ? null : r.daysSince - r.parDays;
            return (
              <div key={r.number} style={{
                display: 'grid', gridTemplateColumns: '60px 1fr 64px 96px', gap: 12,
                padding: '11px 6px', borderBottom: `1px solid ${T.ruleSoft}`, alignItems: 'center',
              }}>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: 17, color: T.ink,
                  letterSpacing: '-0.02em', lineHeight: 1, fontWeight: 600,
                }}>{r.number}</span>
                <span>
                  {r.daysSince === Infinity
                    ? <Pill tone="warm">{'Never cleaned'}</Pill>
                    : <Pill tone="warm">{over}d {'over par'}</Pill>}
                </span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.ink, fontWeight: 600 }}>
                  {r.daysSince === Infinity ? '—' : `${r.daysSince}d`}
                </span>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Btn variant="ghost" size="sm" onClick={() => handleSchedule(r.number)}>
                    {'Schedule'}
                  </Btn>
                </div>
              </div>
            );
          })}

          {/* DUE SOON — inline pills */}
          {dueSoon.length > 0 && (
            <div style={{ paddingTop: 14, marginTop: 6 }}>
              <Caps>{'Due soon'}</Caps>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 8 }}>
                {dueSoon.map(r => (
                  <div key={r.number} style={{
                    display: 'flex', alignItems: 'center', gap: 7,
                    padding: '5px 11px', border: `1px solid ${T.rule}`, borderRadius: 999,
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
          background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 16,
          padding: '18px 20px',
        }}>
          <Caps>{'Recent deep cleans'}</Caps>
          <div style={{ marginTop: 6 }}>
            {recentLog.length === 0 && (
              <p style={{
                fontFamily: FONT_SANS, fontSize: 13, color: T.ink2,
                padding: '16px 0', margin: 0,
              }}>
                {'No recent records yet.'}
              </p>
            )}
            {recentLog.map(e => (
              <div key={e.key} style={{
                display: 'grid', gridTemplateColumns: '64px 50px 1fr 44px', gap: 11,
                alignItems: 'center', padding: '10px 0', borderTop: `1px solid ${T.ruleSoft}`,
              }}>
                <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: T.ink2 }}>
                  {agoLabel(e.agoDays)}
                </span>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: 15, color: T.ink,
                  letterSpacing: '-0.02em', lineHeight: 1, fontWeight: 600,
                }}>{e.roomNumber}</span>
                <span style={{
                  fontFamily: FONT_SANS, fontSize: 12.5, color: T.ink,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{e.team}</span>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: 13, fontWeight: 700, textAlign: 'right',
                  color: e.status === 'completed' ? T.sageDeep : T.caramelDeep,
                }}>
                  {e.status === 'completed' ? '✓' : '⏵'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      </>
      )}

      {/* CADENCE MODAL — portaled to <body> so the page's animate-in
          transform wrapper (which creates a containing block) can't capture
          the position:fixed overlay and shove it off-screen. Mirrors the
          createPortal pattern in ScheduleTab. */}
      {showCadence && typeof document !== 'undefined' && createPortal(
        <div
          onClick={() => setShowCadence(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9998, background: 'rgba(31,35,28,0.32)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
              padding: '22px 24px', minWidth: 360, maxWidth: 440, width: '100%',
              boxShadow: '0 24px 48px rgba(31,35,28,0.18)',
              display: 'flex', flexDirection: 'column', gap: 16,
            }}
          >
            <div>
              <Caps>{'Settings'}</Caps>
              <h3 style={{
                fontFamily: FONT_SANS, fontSize: 18, color: T.ink, margin: '4px 0 0',
                letterSpacing: '-0.02em', lineHeight: 1.2, fontWeight: 600,
              }}>
                {'Deep clean cadence'}
              </h3>
              <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, margin: '8px 0 0' }}>
                {'Days between deep cleans for each room. Rooms past this are overdue.'}
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="number"
                min={7}
                max={365}
                value={cadenceDraft}
                onChange={e => setCadenceDraft(parseInt(e.target.value) || 90)}
                style={{
                  width: 100, fontFamily: FONT_MONO, fontSize: 22, fontWeight: 500,
                  border: `1px solid ${T.rule}`, borderRadius: 10, padding: '8px 12px',
                  background: T.bg, color: T.ink, outline: 'none', textAlign: 'right',
                }}
              />
              <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2 }}>
                {'days'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Btn variant="ghost" size="sm" onClick={() => setShowCadence(false)}>
                {'Cancel'}
              </Btn>
              <Btn variant="primary" size="sm" onClick={handleSaveCadence} disabled={savingCadence}>
                {savingCadence ? ('Saving…') : ('Save')}
              </Btn>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* TOAST — portaled to <body> for the same reason as the modal; color
          flips by toastKind so an init failure surfaces in the warm tone
          instead of looking like a successful action. */}
      {toast && typeof document !== 'undefined' && createPortal(
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          zIndex: 9999, padding: '12px 18px',
          background: toastKind === 'error' ? T.warmDim : T.sageDim,
          color:      toastKind === 'error' ? T.warm     : T.sageDeep,
          border: `1px solid ${toastKind === 'error' ? 'rgba(184,92,61,0.3)' : 'rgba(92,122,96,0.3)'}`,
          borderRadius: 999, fontFamily: FONT_SANS, fontSize: 13, fontWeight: 500,
        }}>{visibleToast}</div>,
        document.body,
      )}
    </div>
  );
}
