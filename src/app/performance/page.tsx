'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { subscribeToRooms, getRoomsForDate } from '@/lib/firestore';
import { todayStr } from '@/lib/utils';
import type { Room } from '@/types';
import { format, subDays } from 'date-fns';
import { Users, Trophy, TrendingUp, TrendingDown, Minus, Clock } from 'lucide-react';

// ─── Helpers ────────────────────────────────────────────────────────────────

function toDate(ts: unknown): Date | null {
  if (!ts) return null;
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate();
  }
  const d = new Date(ts as string | number | Date);
  return isNaN(d.getTime()) ? null : d;
}

function fmtMins(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function Initials({ name }: { name: string }) {
  const parts = name.trim().split(/\s+/);
  const ini =
    parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : name.slice(0, 2).toUpperCase();
  return (
    <div
      style={{
        width: '40px',
        height: '40px',
        borderRadius: '11px',
        flexShrink: 0,
        background: 'var(--amber-dim)',
        border: '1px solid var(--amber-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--font-mono)',
        fontWeight: 700,
        fontSize: '13px',
        color: 'var(--amber)',
        letterSpacing: '0.02em',
      }}
    >
      {ini}
    </div>
  );
}

// ─── Per-housekeeper live stats ──────────────────────────────────────────────

interface HKLive {
  staffId: string;
  name: string;
  totalAssigned: number;
  done: number;
  checkoutsDone: number;
  stayoversDone: number;
  checkoutsAssigned: number;
  stayoversAssigned: number;
  avgCleanMins: number | null;
  roomsPerHr: number | null;
  shiftStart: Date | null;
  shiftEnd: Date | null;
  pace: 'ahead' | 'on_pace' | 'behind' | 'not_started';
}

function buildLive(
  rooms: Room[],
  coMins: number,
  soMins: number,
  nowMs: number
): HKLive[] {
  const byStaff = new Map<string, { name: string; rooms: Room[] }>();
  for (const r of rooms) {
    if (!r.assignedTo) continue;
    if (!byStaff.has(r.assignedTo)) {
      byStaff.set(r.assignedTo, { name: r.assignedName ?? r.assignedTo, rooms: [] });
    }
    byStaff.get(r.assignedTo)!.rooms.push(r);
  }

  const results: HKLive[] = [];

  for (const [staffId, { name, rooms: hkRooms }] of byStaff) {
    const done = hkRooms.filter(
      (r) => r.status === 'clean' || r.status === 'inspected'
    );
    const checkoutsDone = done.filter((r) => r.type === 'checkout').length;
    const stayoversDone = done.filter((r) => r.type === 'stayover').length;
    const checkoutsAssigned = hkRooms.filter((r) => r.type === 'checkout').length;
    const stayoversAssigned = hkRooms.filter((r) => r.type === 'stayover').length;

    // Avg clean time
    const timed = done
      .map((r) => {
        const s = toDate(r.startedAt);
        const e = toDate(r.completedAt);
        if (!s || !e) return null;
        return (e.getTime() - s.getTime()) / 60_000;
      })
      .filter((m): m is number => m !== null && m > 0);
    const avgCleanMins =
      timed.length > 0
        ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length)
        : null;

    // Shift window
    const starts = hkRooms
      .map((r) => toDate(r.startedAt))
      .filter((d): d is Date => d !== null);
    const ends = done
      .map((r) => toDate(r.completedAt))
      .filter((d): d is Date => d !== null);
    const shiftStart =
      starts.length > 0
        ? new Date(Math.min(...starts.map((d) => d.getTime())))
        : null;
    const shiftEnd =
      ends.length > 0
        ? new Date(Math.max(...ends.map((d) => d.getTime())))
        : null;

    // Efficiency: rooms/hr using elapsed time
    let roomsPerHr: number | null = null;
    if (shiftStart && done.length > 0) {
      const hrs = (nowMs - shiftStart.getTime()) / 3_600_000;
      if (hrs > 0) roomsPerHr = Math.round((done.length / hrs) * 10) / 10;
    }

    // Pace indicator
    let pace: HKLive['pace'] = 'not_started';
    if (shiftStart && hkRooms.length > 0) {
      const totalAssignedMins =
        checkoutsAssigned * coMins + stayoversAssigned * soMins;
      if (totalAssignedMins > 0) {
        const elapsedMins = (nowMs - shiftStart.getTime()) / 60_000;
        const expectedDone = (elapsedMins / totalAssignedMins) * hkRooms.length;
        if (done.length >= expectedDone + 1.5) pace = 'ahead';
        else if (done.length < expectedDone - 1.5) pace = 'behind';
        else pace = 'on_pace';
      }
    }

    results.push({
      staffId,
      name,
      totalAssigned: hkRooms.length,
      done: done.length,
      checkoutsDone,
      stayoversDone,
      checkoutsAssigned,
      stayoversAssigned,
      avgCleanMins,
      roomsPerHr,
      shiftStart,
      shiftEnd,
      pace,
    });
  }

  return results.sort((a, b) => b.done - a.done);
}

// ─── Per-housekeeper historical stats ───────────────────────────────────────

interface HKHistory {
  staffId: string;
  name: string;
  totalDone: number;
  checkoutsDone: number;
  stayoversDone: number;
  avgCleanMins: number | null;
  daysActive: number;
  avgPerDay: number;
}

function buildHistory(roomsByDate: Room[][]): HKHistory[] {
  const byStaff = new Map<
    string,
    {
      name: string;
      done: number;
      checkouts: number;
      stayovers: number;
      timed: number[];
      days: Set<string>;
    }
  >();

  for (const dayRooms of roomsByDate) {
    for (const r of dayRooms) {
      if (!r.assignedTo) continue;
      if (r.status !== 'clean' && r.status !== 'inspected') continue;

      if (!byStaff.has(r.assignedTo)) {
        byStaff.set(r.assignedTo, {
          name: r.assignedName ?? r.assignedTo,
          done: 0,
          checkouts: 0,
          stayovers: 0,
          timed: [],
          days: new Set(),
        });
      }
      const entry = byStaff.get(r.assignedTo)!;
      entry.done += 1;
      entry.days.add(r.date);
      if (r.type === 'checkout') entry.checkouts += 1;
      if (r.type === 'stayover') entry.stayovers += 1;

      const s = toDate(r.startedAt);
      const e = toDate(r.completedAt);
      if (s && e) {
        const mins = (e.getTime() - s.getTime()) / 60_000;
        if (mins > 0) entry.timed.push(mins);
      }
    }
  }

  const results: HKHistory[] = [];
  for (const [staffId, entry] of byStaff) {
    const avgCleanMins =
      entry.timed.length > 0
        ? Math.round(entry.timed.reduce((a, b) => a + b, 0) / entry.timed.length)
        : null;
    const daysActive = entry.days.size;
    const avgPerDay =
      daysActive > 0 ? Math.round((entry.done / daysActive) * 10) / 10 : 0;

    results.push({
      staffId,
      name: entry.name,
      totalDone: entry.done,
      checkoutsDone: entry.checkouts,
      stayoversDone: entry.stayovers,
      avgCleanMins,
      daysActive,
      avgPerDay,
    });
  }

  return results.sort((a, b) => b.totalDone - a.totalDone);
}

// ─── Pace badge ──────────────────────────────────────────────────────────────

function PaceBadge({
  pace,
  lang,
}: {
  pace: HKLive['pace'];
  lang: 'en' | 'es';
}) {
  if (pace === 'not_started') return null;

  const config = {
    ahead: {
      bg: 'rgba(34,197,94,0.12)',
      border: 'rgba(34,197,94,0.35)',
      color: '#16A34A',
      icon: <TrendingUp size={11} />,
      label: t('ahead', lang),
    },
    on_pace: {
      bg: 'rgba(251,191,36,0.12)',
      border: 'rgba(251,191,36,0.35)',
      color: '#D97706',
      icon: <Minus size={11} />,
      label: t('onPace', lang),
    },
    behind: {
      bg: 'rgba(239,68,68,0.12)',
      border: 'rgba(239,68,68,0.35)',
      color: '#DC2626',
      icon: <TrendingDown size={11} />,
      label: t('behindPace', lang),
    },
  }[pace];

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '3px 8px',
        borderRadius: '100px',
        background: config.bg,
        border: `1px solid ${config.border}`,
        color: config.color,
        fontSize: '11px',
        fontWeight: 700,
      }}
    >
      {config.icon}
      {config.label}
    </div>
  );
}

// ─── Rank badge ──────────────────────────────────────────────────────────────

function RankBadge({ rank }: { rank: number }) {
  const styles: Record<number, { bg: string; color: string }> = {
    1: { bg: 'rgba(251,191,36,0.18)', color: '#D97706' },
    2: { bg: 'rgba(156,163,175,0.18)', color: '#9CA3AF' },
    3: { bg: 'rgba(180,120,60,0.18)', color: '#B4783C' },
  };
  const s = styles[rank] ?? { bg: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' };
  return (
    <div
      style={{
        width: '26px',
        height: '26px',
        borderRadius: '8px',
        background: s.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--font-mono)',
        fontWeight: 800,
        fontSize: '12px',
        color: s.color,
        flexShrink: 0,
      }}
    >
      {rank === 1 ? '🏆' : `#${rank}`}
    </div>
  );
}

// ─── Stat pill ───────────────────────────────────────────────────────────────

function StatPill({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        padding: '5px 10px',
        borderRadius: '100px',
        background: highlight ? 'var(--amber-dim)' : 'rgba(255,255,255,0.04)',
        border: `1px solid ${highlight ? 'var(--amber-border)' : 'var(--border)'}`,
      }}
    >
      <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>
        {label}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '12px',
          fontWeight: 700,
          color: highlight ? 'var(--amber)' : 'var(--text-secondary)',
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

type ViewMode = 'live' | '7d' | '14d';

export default function PerformancePage() {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, staff } = useProperty();
  const { lang } = useLang();

  const [view, setView] = useState<ViewMode>('live');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [historyRooms, setHistoryRooms] = useState<Room[][]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());

  // Property config
  const coMins = activeProperty?.checkoutMinutes ?? 30;
  const soMins = activeProperty?.stayoverMinutes ?? 20;

  // Live room subscription
  useEffect(() => {
    if (!user || !activePropertyId) return;
    const unsub = subscribeToRooms(user.uid, activePropertyId, todayStr(), setRooms);
    return unsub;
  }, [user, activePropertyId]);

  // Tick timer for live pace calculations
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Load historical rooms when switching to history views
  const loadHistory = useCallback(
    async (days: number) => {
      if (!user || !activePropertyId) return;
      setHistoryLoading(true);
      const dates = Array.from({ length: days }, (_, i) =>
        format(subDays(new Date(), i + 1), 'yyyy-MM-dd')
      );
      const results = await Promise.all(
        dates.map((d) => getRoomsForDate(user.uid, activePropertyId, d))
      );
      setHistoryRooms(results);
      setHistoryLoading(false);
    },
    [user, activePropertyId]
  );

  useEffect(() => {
    if (view === '7d') loadHistory(7);
    else if (view === '14d') loadHistory(14);
  }, [view, loadHistory]);

  // Derived data
  const livePerfs = buildLive(rooms, coMins, soMins, nowMs);
  const historyPerfs = buildHistory(historyRooms);

  const todayDone = rooms.filter(
    (r) => r.status === 'clean' || r.status === 'inspected'
  ).length;

  const todayTurnaround = (() => {
    const timed = rooms
      .filter((r) => r.startedAt && r.completedAt)
      .map((r) => {
        const s = toDate(r.startedAt);
        const e = toDate(r.completedAt);
        if (!s || !e) return null;
        return (e.getTime() - s.getTime()) / 60_000;
      })
      .filter((m): m is number => m !== null && m > 0);
    return timed.length > 0
      ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length)
      : null;
  })();

  const scheduledToday = staff.filter((s) => s.scheduledToday);
  const unassignedToday = scheduledToday.filter(
    (s) => !livePerfs.find((p) => p.staffId === s.id)
  );

  const tipStyle = {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-bright)',
    borderRadius: '10px',
    fontSize: '13px',
    fontFamily: 'var(--font-sans)',
  };
  void tipStyle;

  const viewDays = view === '7d' ? 7 : 14;
  const topHistoryPerf = historyPerfs[0];

  return (
    <AppLayout>
      <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

        {/* ── Header ── */}
        <div className="animate-in">
          {activeProperty && (
            <p style={{
              color: 'var(--text-muted)', fontSize: '11px', fontWeight: 500,
              letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '4px',
            }}>
              {activeProperty.name}
            </p>
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h1 style={{
              fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '26px',
              color: 'var(--text-primary)', letterSpacing: '-0.02em',
              display: 'flex', alignItems: 'center', gap: '8px',
            }}>
              <Trophy size={18} color="var(--amber)" />
              {t('teamPerformance', lang)}
            </h1>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>
              {format(new Date(), 'MMM d')}
            </p>
          </div>
        </div>

        {/* ── View toggle ── */}
        <div className="animate-in stagger-1" style={{ display: 'flex', gap: '8px' }}>
          {([
            { key: 'live' as ViewMode, label: t('liveToday', lang) },
            { key: '7d' as ViewMode,  label: t('last7Days', lang) },
            { key: '14d' as ViewMode, label: t('last14Days', lang) },
          ]).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setView(key)}
              className={`chip${view === key ? ' chip-active' : ''}`}
              style={{
                height: '30px', paddingLeft: '14px', paddingRight: '14px',
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ══════════════════════════════════════════════
            LIVE TODAY VIEW
        ══════════════════════════════════════════════ */}
        {view === 'live' && (
          <>
            {/* Summary chips */}
            {(livePerfs.length > 0 || todayDone > 0) && (
              <div
                className="animate-in stagger-1"
                style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '10px' }}
              >
                {[
                  {
                    label: t('roomsDone', lang),
                    value: `${todayDone}/${rooms.length}`,
                    color: 'var(--green)',
                  },
                  {
                    label: t('housekeepers', lang),
                    value: String(livePerfs.filter((p) => p.done > 0).length),
                    color: 'var(--amber)',
                  },
                  {
                    label: t('avgCleanTime', lang),
                    value: todayTurnaround !== null ? `${todayTurnaround}m` : '—',
                    color: 'var(--text-secondary)',
                  },
                ].map(({ label, value, color }) => (
                  <div
                    key={label}
                    style={{
                      background: 'var(--bg-card)', border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)', padding: '16px 10px',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{
                      fontFamily: 'var(--font-mono)', fontWeight: 700,
                      fontSize: '1.35rem', color, lineHeight: 1, letterSpacing: '-0.03em',
                    }}>
                      {value}
                    </div>
                    <div className="label" style={{ marginTop: '7px', marginBottom: 0, fontSize: '10px' }}>
                      {label}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Empty state */}
            {livePerfs.length === 0 && unassignedToday.length === 0 && (
              <div className="animate-in stagger-2" style={{
                textAlign: 'center', padding: '52px 20px',
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
              }}>
                <div style={{
                  width: '60px', height: '60px', borderRadius: '16px', margin: '0 auto 14px',
                  background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Users size={28} color="var(--text-muted)" />
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '15px', fontWeight: 500, lineHeight: 1.5 }}>
                  {t('noActivityToday', lang)}
                </p>
                <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '6px' }}>
                  {lang === 'es'
                    ? 'Asigna habitaciones en la página de Habitaciones para comenzar.'
                    : 'Assign rooms on the Rooms page to start tracking.'}
                </p>
              </div>
            )}

            {/* Per-HK leaderboard cards */}
            {livePerfs.length > 0 && (
              <>
                <p style={{
                  fontSize: '11px', fontWeight: 600, letterSpacing: '0.07em',
                  textTransform: 'uppercase', color: 'var(--text-muted)',
                  marginBottom: '-6px',
                }}>
                  {t('leaderboard', lang)}
                </p>

                {livePerfs.map((p, i) => (
                  <div
                    key={p.staffId}
                    className={`card animate-in stagger-${Math.min(i + 2, 4)}`}
                    style={{ padding: '16px' }}
                  >
                    {/* Row 1: rank + avatar + name + done count */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                      <RankBadge rank={i + 1} />
                      <Initials name={p.name} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{
                          fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {p.name}
                        </p>
                        {p.shiftStart ? (
                          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                            {p.shiftEnd
                              ? `${format(p.shiftStart, 'h:mm a')} → ${format(p.shiftEnd, 'h:mm a')} · ${fmtMins(Math.round((p.shiftEnd.getTime() - p.shiftStart.getTime()) / 60_000))}`
                              : `${lang === 'es' ? 'Iniciado' : 'Started'} ${format(p.shiftStart, 'h:mm a')} · ${lang === 'es' ? 'en progreso' : 'in progress'}`
                            }
                          </p>
                        ) : null}
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{
                          fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '26px',
                          color: 'var(--green)', lineHeight: 1, letterSpacing: '-0.03em',
                        }}>
                          {p.done}
                        </div>
                        <div style={{
                          fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px',
                          fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase',
                        }}>
                          / {p.totalAssigned}
                        </div>
                      </div>
                    </div>

                    {/* Row 2: room type breakdown bar */}
                    {p.totalAssigned > 0 && (
                      <div style={{ marginBottom: '10px' }}>
                        <div style={{
                          height: '6px', borderRadius: '3px',
                          background: 'var(--border)', overflow: 'hidden',
                          display: 'flex',
                        }}>
                          {/* completed checkouts */}
                          <div style={{
                            width: `${(p.checkoutsDone / p.totalAssigned) * 100}%`,
                            background: '#22C55E', transition: 'width 400ms ease',
                          }} />
                          {/* completed stayovers */}
                          <div style={{
                            width: `${(p.stayoversDone / p.totalAssigned) * 100}%`,
                            background: '#34D399', transition: 'width 400ms ease',
                          }} />
                        </div>
                        <div style={{ display: 'flex', gap: '10px', marginTop: '5px' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                            <span style={{ color: '#22C55E', fontWeight: 600 }}>{t('checkoutsShort', lang)}</span>
                            {' '}{p.checkoutsDone}/{p.checkoutsAssigned}
                          </span>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                            <span style={{ color: '#34D399', fontWeight: 600 }}>{t('stayoversShort', lang)}</span>
                            {' '}{p.stayoversDone}/{p.stayoversAssigned}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Row 3: stat pills + pace badge */}
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                      <StatPill
                        label={t('avgCleanTime', lang)}
                        value={p.avgCleanMins !== null ? `${p.avgCleanMins}m` : '—'}
                      />
                      <StatPill
                        label={t('roomsPerHr', lang)}
                        value={p.roomsPerHr !== null ? String(p.roomsPerHr) : '—'}
                        highlight={p.roomsPerHr !== null}
                      />
                      <PaceBadge pace={p.pace} lang={lang} />
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* Scheduled staff with no activity */}
            {unassignedToday.length > 0 && (
              <div className="card" style={{ padding: '16px' }}>
                <p style={{
                  fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600,
                  letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: '10px',
                }}>
                  {t('noActivityToday', lang)}
                </p>
                {unassignedToday.map((s, i) => (
                  <div
                    key={s.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '10px',
                      padding: '9px 0',
                      borderBottom: i < unassignedToday.length - 1 ? '1px solid var(--border)' : 'none',
                    }}
                  >
                    <Initials name={s.name} />
                    <p style={{ fontSize: '14px', color: 'var(--text-secondary)', fontWeight: 500 }}>
                      {s.name}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ══════════════════════════════════════════════
            HISTORY VIEW (7d / 14d)
        ══════════════════════════════════════════════ */}
        {(view === '7d' || view === '14d') && (
          <>
            {historyLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
                <div className="spinner" style={{ width: '30px', height: '30px' }} />
              </div>
            ) : historyPerfs.length === 0 ? (
              <div style={{
                textAlign: 'center', padding: '52px 20px',
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
              }}>
                <div style={{
                  width: '60px', height: '60px', borderRadius: '16px', margin: '0 auto 14px',
                  background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Clock size={28} color="var(--text-muted)" />
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '15px', fontWeight: 500 }}>
                  {t('noHistoryYet', lang)}
                </p>
                <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '6px' }}>
                  {lang === 'es'
                    ? `Los datos aparecerán aquí después de que el equipo complete habitaciones en los últimos ${viewDays} días.`
                    : `Data will appear here after the team completes rooms over the past ${viewDays} days.`}
                </p>
              </div>
            ) : (
              <>
                {/* History summary chips */}
                <div
                  className="animate-in stagger-1"
                  style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '10px' }}
                >
                  {[
                    {
                      label: t('roomsDone', lang),
                      value: String(historyPerfs.reduce((s, p) => s + p.totalDone, 0)),
                      color: 'var(--green)',
                    },
                    {
                      label: t('topPerformer', lang),
                      value: topHistoryPerf
                        ? topHistoryPerf.name.split(' ')[0]
                        : '—',
                      color: 'var(--amber)',
                    },
                    {
                      label: t('avgPerDay', lang),
                      value: historyPerfs.length > 0
                        ? String(
                            Math.round(
                              historyPerfs.reduce((s, p) => s + p.avgPerDay, 0) /
                                historyPerfs.length *
                                10
                            ) / 10
                          )
                        : '—',
                      color: 'var(--text-secondary)',
                    },
                  ].map(({ label, value, color }) => (
                    <div
                      key={label}
                      style={{
                        background: 'var(--bg-card)', border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-md)', padding: '16px 10px',
                        textAlign: 'center',
                      }}
                    >
                      <div style={{
                        fontFamily: 'var(--font-mono)', fontWeight: 700,
                        fontSize: '1.25rem', color, lineHeight: 1, letterSpacing: '-0.03em',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {value}
                      </div>
                      <div className="label" style={{ marginTop: '7px', marginBottom: 0, fontSize: '10px' }}>
                        {label}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Max rooms for progress bars */}
                {(() => {
                  const maxDone = Math.max(...historyPerfs.map((p) => p.totalDone), 1);
                  return historyPerfs.map((p, i) => (
                    <div
                      key={p.staffId}
                      className={`card animate-in stagger-${Math.min(i + 2, 4)}`}
                      style={{ padding: '16px' }}
                    >
                      {/* Row 1: rank + avatar + name + total */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                        <RankBadge rank={i + 1} />
                        <Initials name={p.name} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{
                            fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {p.name}
                          </p>
                          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                            {p.daysActive} {lang === 'es' ? (p.daysActive === 1 ? 'día activo' : 'días activos') : (p.daysActive === 1 ? 'day active' : 'days active')}
                          </p>
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{
                            fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '24px',
                            color: 'var(--green)', lineHeight: 1, letterSpacing: '-0.03em',
                          }}>
                            {p.totalDone}
                          </div>
                          <div style={{
                            fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px',
                            fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase',
                          }}>
                            {lang === 'es' ? 'hab.' : 'rooms'}
                          </div>
                        </div>
                      </div>

                      {/* Progress bar (relative to top performer) */}
                      <div style={{
                        height: '5px', borderRadius: '3px',
                        background: 'var(--border)', marginBottom: '10px', overflow: 'hidden',
                      }}>
                        <div style={{
                          height: '100%', borderRadius: '3px',
                          background: i === 0 ? 'var(--amber)' : 'var(--green)',
                          width: `${(p.totalDone / maxDone) * 100}%`,
                          transition: 'width 500ms ease',
                        }} />
                      </div>

                      {/* Stat pills */}
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <StatPill
                          label={t('avgPerDay', lang)}
                          value={`${p.avgPerDay}`}
                          highlight={i === 0}
                        />
                        <StatPill
                          label={t('avgCleanTime', lang)}
                          value={p.avgCleanMins !== null ? `${p.avgCleanMins}m` : '—'}
                        />
                        <StatPill
                          label={t('checkoutsShort', lang)}
                          value={String(p.checkoutsDone)}
                        />
                        <StatPill
                          label={t('stayoversShort', lang)}
                          value={String(p.stayoversDone)}
                        />
                      </div>
                    </div>
                  ));
                })()}
              </>
            )}
          </>
        )}

      </div>
    </AppLayout>
  );
}
