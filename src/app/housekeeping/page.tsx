'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { Modal } from '@/components/ui/Modal';
import { useSyncContext } from '@/contexts/SyncContext';
import {
  subscribeToRooms, updateRoom,
  subscribeToShiftConfirmations, subscribeToManagerNotifications,
  markNotificationRead, markAllNotificationsRead,
  addStaffMember, updateStaffMember, deleteStaffMember,
  getRoomsForDate,
} from '@/lib/firestore';
import { todayStr } from '@/lib/utils';
import type { Room, RoomStatus, StaffMember, ShiftConfirmation, ManagerNotification, ConfirmationStatus } from '@/types';
import { format, subDays } from 'date-fns';
import {
  Calendar, ChevronLeft, ChevronRight, Bell, CheckCircle2, XCircle, Clock,
  AlertTriangle, Users, Send, Zap, BedDouble, Plus, Pencil, Trash2, Star,
  Trophy, TrendingUp, TrendingDown, Minus, Upload,
} from 'lucide-react';

// ─── Tab config ──────────────────────────────────────────────────────────────

type TabKey = 'schedule' | 'rooms' | 'performance' | 'import';

const TABS: { key: TabKey; label: string; labelEs: string }[] = [
  { key: 'schedule',    label: 'Schedule',    labelEs: 'Horario'       },
  { key: 'rooms',       label: 'Rooms',       labelEs: 'Habitaciones'  },
  { key: 'performance', label: 'Performance', labelEs: 'Rendimiento'   },
  { key: 'import',      label: 'Import',      labelEs: 'Importar'      },
];

// ─── Schedule helpers ─────────────────────────────────────────────────────────

function schedTodayStr(): string {
  return new Date().toLocaleDateString('en-CA');
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return dt.toLocaleDateString('en-CA');
}

function formatDisplayDate(dateStr: string, lang: 'en' | 'es'): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', {
    weekday: 'long', month: 'short', day: 'numeric',
  });
}

function isEligible(s: StaffMember, date: string): boolean {
  if (s.isActive === false) return false;
  if (!s.phone) return false;
  if (s.vacationDates?.includes(date)) return false;
  const maxDays = s.maxDaysPerWeek ?? 5;
  const maxHrs  = s.maxWeeklyHours ?? 40;
  if ((s.daysWorkedThisWeek ?? 0) >= maxDays) return false;
  if ((s.weeklyHours ?? 0) >= maxHrs) return false;
  return true;
}

function autoSelectEligible(staff: StaffMember[], date: string, alreadyInPool: Set<string>): StaffMember[] {
  return staff
    .filter(s => isEligible(s, date) && !alreadyInPool.has(s.id))
    .sort((a, b) => {
      const aDays = a.daysWorkedThisWeek ?? 0;
      const bDays = b.daysWorkedThisWeek ?? 0;
      if (aDays !== bDays) return aDays - bDays;
      if (a.isSenior !== b.isSenior) return a.isSenior ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

const STATUS_COLOR: Record<ConfirmationStatus, string> = {
  pending:     'var(--amber)',
  confirmed:   'var(--green)',
  declined:    'var(--red)',
  no_response: 'var(--text-muted)',
};

const STATUS_ICON: Record<ConfirmationStatus, React.ReactNode> = {
  pending:     <Clock size={13} />,
  confirmed:   <CheckCircle2 size={13} />,
  declined:    <XCircle size={13} />,
  no_response: <AlertTriangle size={13} />,
};

// ─── Performance helpers ──────────────────────────────────────────────────────

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

function HKInitials({ name }: { name: string }) {
  const parts = name.trim().split(/\s+/);
  const ini = parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
  return (
    <div style={{
      width: '40px', height: '40px', borderRadius: '11px', flexShrink: 0,
      background: 'var(--amber-dim)', border: '1px solid var(--amber-border)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '13px',
      color: 'var(--amber)', letterSpacing: '0.02em',
    }}>
      {ini}
    </div>
  );
}

interface HKLive {
  staffId: string; name: string; totalAssigned: number; done: number;
  checkoutsDone: number; stayoversDone: number;
  checkoutsAssigned: number; stayoversAssigned: number;
  avgCleanMins: number | null; roomsPerHr: number | null;
  shiftStart: Date | null; shiftEnd: Date | null;
  pace: 'ahead' | 'on_pace' | 'behind' | 'not_started';
}

function buildLive(rooms: Room[], coMins: number, soMins: number, nowMs: number): HKLive[] {
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
    const done = hkRooms.filter(r => r.status === 'clean' || r.status === 'inspected');
    const checkoutsDone = done.filter(r => r.type === 'checkout').length;
    const stayoversDone = done.filter(r => r.type === 'stayover').length;
    const checkoutsAssigned = hkRooms.filter(r => r.type === 'checkout').length;
    const stayoversAssigned = hkRooms.filter(r => r.type === 'stayover').length;
    const timed = done.map(r => {
      const s = toDate(r.startedAt); const e = toDate(r.completedAt);
      if (!s || !e) return null;
      return (e.getTime() - s.getTime()) / 60_000;
    }).filter((m): m is number => m !== null && m > 0);
    const avgCleanMins = timed.length > 0 ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null;
    const starts = hkRooms.map(r => toDate(r.startedAt)).filter((d): d is Date => d !== null);
    const ends = done.map(r => toDate(r.completedAt)).filter((d): d is Date => d !== null);
    const shiftStart = starts.length > 0 ? new Date(Math.min(...starts.map(d => d.getTime()))) : null;
    const shiftEnd = ends.length > 0 ? new Date(Math.max(...ends.map(d => d.getTime()))) : null;
    let roomsPerHr: number | null = null;
    if (shiftStart && done.length > 0) {
      const hrs = (nowMs - shiftStart.getTime()) / 3_600_000;
      if (hrs > 0) roomsPerHr = Math.round((done.length / hrs) * 10) / 10;
    }
    let pace: HKLive['pace'] = 'not_started';
    if (shiftStart && hkRooms.length > 0) {
      const totalAssignedMins = checkoutsAssigned * coMins + stayoversAssigned * soMins;
      if (totalAssignedMins > 0) {
        const elapsedMins = (nowMs - shiftStart.getTime()) / 60_000;
        const expectedDone = (elapsedMins / totalAssignedMins) * hkRooms.length;
        if (done.length >= expectedDone + 1.5) pace = 'ahead';
        else if (done.length < expectedDone - 1.5) pace = 'behind';
        else pace = 'on_pace';
      }
    }
    results.push({ staffId, name, totalAssigned: hkRooms.length, done: done.length, checkoutsDone, stayoversDone, checkoutsAssigned, stayoversAssigned, avgCleanMins, roomsPerHr, shiftStart, shiftEnd, pace });
  }
  return results.sort((a, b) => b.done - a.done);
}

interface HKHistory {
  staffId: string; name: string; totalDone: number; checkoutsDone: number;
  stayoversDone: number; avgCleanMins: number | null; daysActive: number; avgPerDay: number;
}

function buildHistory(roomsByDate: Room[][]): HKHistory[] {
  const byStaff = new Map<string, { name: string; done: number; checkouts: number; stayovers: number; timed: number[]; days: Set<string> }>();
  for (const dayRooms of roomsByDate) {
    for (const r of dayRooms) {
      if (!r.assignedTo) continue;
      if (r.status !== 'clean' && r.status !== 'inspected') continue;
      if (!byStaff.has(r.assignedTo)) byStaff.set(r.assignedTo, { name: r.assignedName ?? r.assignedTo, done: 0, checkouts: 0, stayovers: 0, timed: [], days: new Set() });
      const entry = byStaff.get(r.assignedTo)!;
      entry.done += 1; entry.days.add(r.date);
      if (r.type === 'checkout') entry.checkouts += 1;
      if (r.type === 'stayover') entry.stayovers += 1;
      const s = toDate(r.startedAt); const e = toDate(r.completedAt);
      if (s && e) { const mins = (e.getTime() - s.getTime()) / 60_000; if (mins > 0) entry.timed.push(mins); }
    }
  }
  const results: HKHistory[] = [];
  for (const [staffId, entry] of byStaff) {
    const avgCleanMins = entry.timed.length > 0 ? Math.round(entry.timed.reduce((a, b) => a + b, 0) / entry.timed.length) : null;
    const daysActive = entry.days.size;
    const avgPerDay = daysActive > 0 ? Math.round((entry.done / daysActive) * 10) / 10 : 0;
    results.push({ staffId, name: entry.name, totalDone: entry.done, checkoutsDone: entry.checkouts, stayoversDone: entry.stayovers, avgCleanMins, daysActive, avgPerDay });
  }
  return results.sort((a, b) => b.totalDone - a.totalDone);
}

function PaceBadge({ pace, lang }: { pace: HKLive['pace']; lang: 'en' | 'es' }) {
  if (pace === 'not_started') return null;
  const config = {
    ahead:    { bg: 'rgba(34,197,94,0.12)',  border: 'rgba(34,197,94,0.35)',  color: '#16A34A', icon: <TrendingUp size={11} />,   label: t('ahead', lang) },
    on_pace:  { bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.35)', color: '#D97706', icon: <Minus size={11} />,        label: t('onPace', lang) },
    behind:   { bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.35)',  color: '#DC2626', icon: <TrendingDown size={11} />, label: t('behindPace', lang) },
  }[pace];
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 8px', borderRadius: '100px', background: config.bg, border: `1px solid ${config.border}`, color: config.color, fontSize: '11px', fontWeight: 700 }}>
      {config.icon}{config.label}
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const s = ({ 1: { bg: 'rgba(251,191,36,0.18)', color: '#D97706' }, 2: { bg: 'rgba(156,163,175,0.18)', color: '#9CA3AF' }, 3: { bg: 'rgba(180,120,60,0.18)', color: '#B4783C' } } as Record<number, { bg: string; color: string }>)[rank] ?? { bg: 'rgba(0,0,0,0.05)', color: 'var(--text-muted)' };
  return (
    <div style={{ width: '26px', height: '26px', borderRadius: '8px', background: s.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: '12px', color: s.color, flexShrink: 0 }}>
      {rank === 1 ? '🏆' : `#${rank}`}
    </div>
  );
}

function StatPill({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 10px', borderRadius: '100px', background: highlight ? 'var(--amber-dim)' : 'rgba(0,0,0,0.04)', border: `1px solid ${highlight ? 'var(--amber-border)' : 'var(--border)'}` }}>
      <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', fontWeight: 700, color: highlight ? 'var(--amber)' : 'var(--text-secondary)' }}>{value}</span>
    </div>
  );
}

// ─── Staff helpers ────────────────────────────────────────────────────────────

interface StaffFormData {
  name: string; phone?: string; language: 'en' | 'es'; isSenior: boolean;
  hourlyWage?: number; maxWeeklyHours: number; maxDaysPerWeek: number;
  vacationDates: string; isActive: boolean;
}

const EMPTY_FORM: StaffFormData = { name: '', language: 'en', isSenior: false, maxWeeklyHours: 40, maxDaysPerWeek: 5, vacationDates: '', isActive: true };

function staffInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].substring(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ══════════════════════════════════════════════════════════════════════════════
// SCHEDULE SECTION
// ══════════════════════════════════════════════════════════════════════════════

function ScheduleSection() {
  const { user } = useAuth();
  const { activePropertyId, staff, staffLoaded, refreshStaff } = useProperty();
  const { lang } = useLang();

  const tomorrow = addDays(schedTodayStr(), 1);
  const [shiftDate, setShiftDate] = useState(tomorrow);
  const [selected, setSelected] = useState<StaffMember[]>([]);
  const [confirmations, setConfirmations] = useState<ShiftConfirmation[]>([]);
  const [notifications, setNotifications] = useState<ManagerNotification[]>([]);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [showNotifPanel, setShowNotifPanel] = useState(false);

  const uid = user?.uid ?? '';
  const pid = activePropertyId ?? '';

  useEffect(() => {
    if (uid && pid && staff.length === 0) refreshStaff();
  }, [uid, pid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!uid || !pid) return;
    setSent(false);
    return subscribeToShiftConfirmations(uid, pid, shiftDate, setConfirmations);
  }, [uid, pid, shiftDate]);

  useEffect(() => {
    if (!uid || !pid) return;
    return subscribeToManagerNotifications(uid, pid, setNotifications);
  }, [uid, pid]);

  const unreadCount = notifications.filter(n => !n.read).length;

  const alreadyInPool = useMemo(() => new Set(confirmations.filter(c => c.status !== 'declined').map(c => c.staffId)), [confirmations]);
  const eligiblePool  = useMemo(() => autoSelectEligible(staff, shiftDate, alreadyInPool), [staff, shiftDate, alreadyInPool]);

  const handleAutoSelect = useCallback(() => setSelected(eligiblePool), [eligiblePool]);

  const toggleSelected = (member: StaffMember) => {
    setSelected(prev => prev.some(s => s.id === member.id) ? prev.filter(s => s.id !== member.id) : [...prev, member]);
  };

  const handleSend = async () => {
    if (!uid || !pid || selected.length === 0 || sending) return;
    setSending(true);
    try {
      const baseUrl = window.location.origin;
      const staffPayload = selected.filter(s => s.phone).map(s => ({ staffId: s.id, name: s.name, phone: s.phone!, language: s.language }));
      await fetch('/api/send-shift-confirmations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, pid, shiftDate, baseUrl, staff: staffPayload }),
      });
      setSent(true); setSelected([]);
    } finally { setSending(false); }
  };

  const activeStaff = useMemo(() => staff.filter(s => s.isActive !== false).sort((a, b) => (b.weeklyHours ?? 0) - (a.weeklyHours ?? 0)), [staff]);

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
        <button
          onClick={() => setShowNotifPanel(v => !v)}
          style={{ position: 'relative', background: 'none', border: 'none', cursor: 'pointer', padding: '6px', color: unreadCount > 0 ? 'var(--amber)' : 'var(--text-muted)' }}
        >
          <Bell size={20} strokeWidth={unreadCount > 0 ? 2.2 : 1.6} />
          {unreadCount > 0 && (
            <span style={{ position: 'absolute', top: '2px', right: '2px', width: '16px', height: '16px', background: 'var(--red)', color: '#fff', borderRadius: '50%', fontSize: '9px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>
      </div>

      {/* Notification panel */}
      {showNotifPanel && (
        <div className="card animate-in" style={{ padding: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{t('notificationsTitle', lang)}</span>
            {unreadCount > 0 && (
              <button onClick={() => markAllNotificationsRead(uid, pid)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', color: 'var(--amber)', fontWeight: 600, padding: 0 }}>
                {t('markAllRead', lang)}
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>{t('noNotifications', lang)}</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {notifications.slice(0, 10).map(n => (
                <div key={n.id} onClick={() => { if (!n.read && uid && pid) markNotificationRead(uid, pid, n.id); }}
                  style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 12px', background: n.read ? 'transparent' : 'rgba(251,191,36,0.05)', border: `1px solid ${n.read ? 'var(--border)' : 'rgba(251,191,36,0.2)'}`, borderRadius: 'var(--radius-md)', cursor: n.read ? 'default' : 'pointer' }}>
                  <span style={{ marginTop: '1px', flexShrink: 0, color: n.type === 'decline' || n.type === 'no_replacement' ? 'var(--red)' : n.type === 'all_confirmed' ? 'var(--green)' : 'var(--amber)' }}>
                    {n.type === 'all_confirmed' ? <CheckCircle2 size={14} /> : n.type === 'decline' ? <XCircle size={14} /> : n.type === 'no_replacement' ? <AlertTriangle size={14} /> : <Users size={14} />}
                  </span>
                  <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>{n.message}</p>
                  {!n.read && <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--amber)', flexShrink: 0, marginTop: '4px' }} />}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Date selector */}
      <div className="card" style={{ padding: '16px' }}>
        <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '10px' }}>
          {t('selectShiftDate', lang)}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button onClick={() => { setShiftDate(d => addDays(d, -1)); setSent(false); setSelected([]); }} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '6px 10px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <ChevronLeft size={16} />
          </button>
          <span style={{ flex: 1, textAlign: 'center', fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)' }}>
            {formatDisplayDate(shiftDate, lang)}
          </span>
          <button onClick={() => { setShiftDate(d => addDays(d, 1)); setSent(false); setSelected([]); }} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '6px 10px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Sent banner */}
      {sent && (
        <div className="animate-in" style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', borderRadius: 'var(--radius-md)' }}>
          <CheckCircle2 size={16} color="var(--green)" />
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--green)' }}>{t('confirmationsSent', lang)}</span>
        </div>
      )}

      {/* Existing confirmations */}
      {confirmations.length > 0 && (
        <div className="card" style={{ padding: '16px' }}>
          <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '12px' }}>
            {t('crewForDate', lang)} {formatDisplayDate(shiftDate, lang)}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {confirmations.map(conf => (
              <div key={conf.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)' }}>{conf.staffName}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', fontWeight: 600, color: STATUS_COLOR[conf.status] }}>
                  {STATUS_ICON[conf.status]}
                  {t(conf.status === 'pending' ? 'statusPending' : conf.status === 'confirmed' ? 'statusConfirmed' : conf.status === 'declined' ? 'statusDeclined' : 'statusNoResponse', lang)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Auto-select crew */}
      <div className="card" style={{ padding: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
          <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', margin: 0 }}>
            {t('autoSelectCrew', lang)}
            {selected.length > 0 && <span style={{ marginLeft: '8px', color: 'var(--amber)' }}>— {selected.length} {t('crewSelectedCount', lang)}</span>}
          </p>
          <button onClick={handleAutoSelect} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 'var(--radius-md)', color: 'var(--amber)', fontSize: '12px', fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
            <Zap size={12} />{t('autoSelectCrew', lang)}
          </button>
        </div>

        {!staffLoaded ? (
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>{lang === 'es' ? 'Cargando…' : 'Loading…'}</p>
        ) : staff.filter(s => s.isActive !== false).length === 0 ? (
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>{t('noEligibleStaff', lang)}</p>
        ) : (
          <>
            {eligiblePool.length === 0 && alreadyInPool.size === 0 && (
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 12px', lineHeight: 1.5 }}>{t('noEligibleStaff', lang)}</p>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '8px' }}>
              {staff.filter(s => s.isActive !== false)
                .sort((a, b) => {
                  const aIn = alreadyInPool.has(a.id); const bIn = alreadyInPool.has(b.id);
                  if (aIn !== bIn) return aIn ? -1 : 1;
                  const aSel = selected.some(x => x.id === a.id); const bSel = selected.some(x => x.id === b.id);
                  if (aSel !== bSel) return aSel ? -1 : 1;
                  return a.name.localeCompare(b.name);
                })
                .map(member => {
                  const inPool = alreadyInPool.has(member.id);
                  const isSelected = selected.some(s => s.id === member.id);
                  const eligible = isEligible(member, shiftDate) && !inPool;
                  const onVacation = member.vacationDates?.includes(shiftDate);
                  const isAtLimit = !eligible && !inPool && !onVacation && member.isActive !== false && !!member.phone &&
                    ((member.daysWorkedThisWeek ?? 0) >= (member.maxDaysPerWeek ?? 5) || (member.weeklyHours ?? 0) >= (member.maxWeeklyHours ?? 40));
                  return (
                    <div key={member.id} onClick={() => eligible && toggleSelected(member)}
                      style={{ padding: '10px 12px', border: `1px solid ${inPool ? 'rgba(34,197,94,0.3)' : isSelected ? 'rgba(251,191,36,0.5)' : eligible ? 'var(--border)' : 'rgba(0,0,0,0.04)'}`, background: inPool ? 'rgba(34,197,94,0.05)' : isSelected ? 'rgba(251,191,36,0.07)' : 'rgba(0,0,0,0.02)', borderRadius: 'var(--radius-md)', cursor: eligible ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: '10px', opacity: (!eligible && !inPool) ? 0.45 : 1, transition: 'all 0.15s' }}>
                      <div style={{ width: '18px', height: '18px', borderRadius: '5px', border: `2px solid ${inPool ? 'var(--green)' : isSelected ? 'var(--amber)' : 'var(--border)'}`, background: inPool ? 'rgba(34,197,94,0.2)' : isSelected ? 'rgba(251,191,36,0.2)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        {(inPool || isSelected) && <CheckCircle2 size={11} color={inPool ? 'var(--green)' : 'var(--amber)'} strokeWidth={2.5} />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{member.name}</p>
                        <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>
                          {inPool ? t('crewForDate', lang) : onVacation ? t('onVacation', lang) : !member.phone ? t('noPhoneLabel', lang) : isAtLimit ? t('atLimitLabel', lang) : eligible ? `${member.daysWorkedThisWeek ?? 0} ${t('daysWorkedLabel', lang)}` : t('inactiveLabel', lang)}
                        </p>
                      </div>
                      {member.isSenior && <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--amber)', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: '4px', padding: '1px 5px' }}>SR</span>}
                    </div>
                  );
                })}
            </div>
          </>
        )}

        {selected.length > 0 && (
          <button onClick={handleSend} disabled={sending} className="animate-in"
            style={{ marginTop: '16px', width: '100%', padding: '14px', background: sending ? 'rgba(37,99,235,0.4)' : 'var(--navy-light)', color: sending ? 'rgba(255,255,255,0.5)' : '#FFFFFF', border: 'none', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '14px', cursor: sending ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-sans)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
            <Send size={14} />
            {sending ? t('sendingLabel', lang) : `${t('sendConfirmations', lang)} (${selected.length})`}
          </button>
        )}
      </div>

      {/* Weekly hours tracker */}
      <div className="card" style={{ padding: '16px' }}>
        <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '14px' }}>
          {t('weeklyHoursTracker', lang)}
        </p>
        {!staffLoaded ? (
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>{lang === 'es' ? 'Cargando…' : 'Loading…'}</p>
        ) : activeStaff.length === 0 ? (
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>{t('noStaffYet', lang)}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {activeStaff.map(member => {
              const maxHrs = member.maxWeeklyHours ?? 40;
              const hrs = member.weeklyHours ?? 0;
              const pct = Math.min((hrs / maxHrs) * 100, 100);
              const atLimit = hrs >= maxHrs;
              const nearLimit = hrs >= maxHrs - 4;
              return (
                <div key={member.id}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)' }}>
                      {member.name}
                      {member.vacationDates?.includes(shiftDate) && <span style={{ marginLeft: '6px', fontSize: '10px', color: 'var(--blue)', fontWeight: 600 }}>{t('onVacation', lang)}</span>}
                    </span>
                    <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: atLimit ? 'var(--red)' : nearLimit ? 'var(--amber)' : 'var(--text-muted)' }}>{hrs}h / {maxHrs}h</span>
                  </div>
                  <div style={{ height: '3px', background: 'rgba(0,0,0,0.05)', borderRadius: '2px', overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: atLimit ? 'var(--red)' : nearLimit ? 'var(--amber)' : 'var(--green)', borderRadius: '2px', transition: 'width 0.3s' }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ROOMS SECTION (live room status)
// ══════════════════════════════════════════════════════════════════════════════

function getFloor(roomNumber: string): string {
  const cleaned = roomNumber.replace(/\D/g, '');
  const num = parseInt(cleaned);
  if (isNaN(num)) return '?';
  if (num < 100) return 'G';
  return String(Math.floor(num / 100));
}

const ROOM_ACTION_COLOR: Record<RoomStatus, { bg: string; border: string; color: string }> = {
  dirty:       { bg: 'rgba(251,191,36,0.15)',  border: 'rgba(251,191,36,0.5)',  color: '#D97706' },
  in_progress: { bg: 'rgba(34,197,94,0.15)',   border: 'rgba(34,197,94,0.5)',   color: '#16A34A' },
  clean:       { bg: 'rgba(239,68,68,0.10)',   border: 'rgba(239,68,68,0.35)',  color: '#DC2626' },
  inspected:   { bg: 'rgba(139,92,246,0.10)',  border: 'rgba(139,92,246,0.3)',  color: '#7C3AED' },
};

function RoomsSection() {
  const { user }                               = useAuth();
  const { activePropertyId, activeProperty }   = useProperty();
  const { lang }                               = useLang();
  const { recordOfflineAction }                = useSyncContext();

  const [rooms,   setRooms]   = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    const unsub = subscribeToRooms(user.uid, activePropertyId, todayStr(), (r) => { setRooms(r); setLoading(false); });
    return unsub;
  }, [user, activePropertyId]);

  const floors = [...new Set(rooms.map(r => getFloor(r.number)))].sort((a, b) => {
    if (a === 'G') return -1; if (b === 'G') return 1;
    return parseInt(a) - parseInt(b);
  });

  const sorted = [...rooms].sort((a, b) => (parseInt(a.number.replace(/\D/g, '')) || 0) - (parseInt(b.number.replace(/\D/g, '')) || 0));

  const doneCount  = rooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
  const totalCount = rooms.length;
  const pct        = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const STATUS_INFO: Record<RoomStatus, { label: string; color: string; bgColor: string; borderColor: string }> = {
    dirty:       { label: t('dirty', lang),          color: '#EF4444', bgColor: 'rgba(239,68,68,0.08)',   borderColor: 'rgba(239,68,68,0.25)'   },
    in_progress: { label: t('cleaning', lang),       color: '#FBBF24', bgColor: 'rgba(251,191,36,0.08)',  borderColor: 'rgba(251,191,36,0.25)'  },
    clean:       { label: t('clean', lang) + ' ✓',  color: '#22C55E', bgColor: 'rgba(34,197,94,0.08)',   borderColor: 'rgba(34,197,94,0.25)'   },
    inspected:   { label: t('approved', lang),       color: '#8B5CF6', bgColor: 'rgba(139,92,246,0.08)',  borderColor: 'rgba(139,92,246,0.25)'  },
  };

  const ACTION_LABEL: Record<RoomStatus, string> = {
    dirty: t('start', lang), in_progress: t('done', lang) + ' ✓', clean: t('reset', lang), inspected: t('locked', lang),
  };

  const handleToggle = async (room: Room) => {
    if (!user || !activePropertyId || room.status === 'inspected') return;
    let newStatus: RoomStatus;
    if (room.status === 'dirty') newStatus = 'in_progress';
    else if (room.status === 'in_progress') newStatus = 'clean';
    else newStatus = 'dirty';
    const updates: Partial<Room> = { status: newStatus };
    if (newStatus === 'in_progress') updates.startedAt  = new Date();
    if (newStatus === 'clean')       updates.completedAt = new Date();
    if (!navigator.onLine) recordOfflineAction();
    await updateRoom(user.uid, activePropertyId, room.id, updates);
  };

  return (
    <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {totalCount > 0 && (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '14px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{t('todaysProgress', lang)}</span>
            <span style={{ fontSize: '14px', fontWeight: 800, color: '#22C55E', fontFamily: 'var(--font-mono)' }}>
              {pct}% &nbsp;<span style={{ fontWeight: 500, color: 'var(--text-muted)', fontSize: '12px' }}>({doneCount}/{totalCount})</span>
            </span>
          </div>
          <div style={{ height: '10px', borderRadius: '5px', background: 'var(--border)' }}>
            <div style={{ height: '100%', borderRadius: '5px', background: pct === 100 ? '#8B5CF6' : '#22C55E', width: `${pct}%`, transition: 'width 400ms ease' }} />
          </div>
          <div style={{ display: 'flex', gap: '12px', marginTop: '10px', flexWrap: 'wrap' }}>
            {(['dirty', 'in_progress', 'clean', 'inspected'] as RoomStatus[]).map(s => {
              const cnt = rooms.filter(r => r.status === s).length;
              if (cnt === 0) return null;
              return <span key={s} style={{ fontSize: '11px', fontWeight: 600, color: STATUS_INFO[s].color }}>{cnt} {STATUS_INFO[s].label}</span>;
            })}
          </div>
        </div>
      )}


      {loading ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '14px', textAlign: 'center', padding: '48px 0' }}>{t('loading', lang)}</p>
      ) : sorted.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '52px 20px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
          <p style={{ fontSize: '32px', marginBottom: '12px' }}>🛏️</p>
          <p style={{ color: 'var(--text-secondary)', fontSize: '15px', fontWeight: 500 }}>{rooms.length === 0 ? t('noRoomsTodayHkp', lang) : t('noRoomsFloor', lang)}</p>
        </div>
      ) : (
        <>

          {/* Rooms grouped by floor */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {floors.map(floor => {
              const floorRooms = sorted.filter(r => getFloor(r.number) === floor);
              const floorDone  = floorRooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
              if (floorRooms.length === 0) return null;
              return (
                <div key={floor}>
                  {/* Floor label */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
                      Floor {floor}
                    </span>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.04em' }}>
                      {floorDone}/{floorRooms.length}
                    </span>
                    <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
                  </div>
                  {/* Tiles */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {floorRooms.map(room => {
                      const info = STATUS_INFO[room.status];
                      const completedTime = room.completedAt
                        ? format(
                            typeof (room.completedAt as unknown as { toDate?: () => Date })?.toDate === 'function'
                              ? (room.completedAt as unknown as { toDate: () => Date }).toDate()
                              : new Date(room.completedAt as unknown as string | number),
                            'h:mm a'
                          )
                        : null;
                      return (
                        <button
                          key={room.id}
                          onClick={() => handleToggle(room)}
                          disabled={room.status === 'inspected'}
                          title={`Room ${room.number} · ${room.type ?? ''} · ${info.label}${completedTime ? ` done at ${completedTime}` : ''}`}
                          style={{
                            width: '72px', height: '72px', flexShrink: 0,
                            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                            gap: '4px',
                            background: info.bgColor, border: `1.5px solid ${info.borderColor}`,
                            borderRadius: '10px',
                            cursor: room.status === 'inspected' ? 'default' : 'pointer',
                            opacity: room.status === 'inspected' ? 0.55 : 1,
                            transition: 'opacity 0.1s',
                            fontFamily: 'var(--font-sans)',
                            position: 'relative', overflow: 'hidden',
                          }}
                        >
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: '14px', color: info.color, lineHeight: 1 }}>
                            {room.number}
                          </span>
                          <span style={{ fontSize: '9px', fontWeight: 600, color: info.color, opacity: 0.85, textAlign: 'center', lineHeight: 1 }}>
                            {info.label.replace(' ✓', '')}
                          </span>
                          {(room.priority === 'vip' || room.isDnd || room.type === 'checkout') && (
                            <div style={{ position: 'absolute', top: '3px', right: '4px', fontSize: '9px', lineHeight: 1 }}>
                              {room.priority === 'vip' ? '⭐' : room.isDnd ? '🚫' : '🚪'}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// STAFF SECTION
// ══════════════════════════════════════════════════════════════════════════════

function StaffSection() {
  const { user } = useAuth();
  const { activePropertyId, staff } = useProperty();
  const { lang } = useLang();

  const [showModal, setShowModal] = useState(false);
  const [editMember, setEditMember] = useState<StaffMember | null>(null);
  const [form, setForm] = useState<StaffFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const openAdd = () => { setEditMember(null); setForm(EMPTY_FORM); setShowModal(true); };
  const openEdit = (member: StaffMember) => {
    setEditMember(member);
    setForm({ name: member.name, phone: member.phone, language: member.language, isSenior: member.isSenior, hourlyWage: member.hourlyWage, maxWeeklyHours: member.maxWeeklyHours, maxDaysPerWeek: member.maxDaysPerWeek ?? 5, vacationDates: (member.vacationDates ?? []).join('\n'), isActive: member.isActive ?? true });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!user || !activePropertyId || !form.name.trim()) return;
    setSaving(true);
    try {
      const vacationDates = form.vacationDates.split('\n').map(s => s.trim()).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));
      const data = { name: form.name.trim(), ...(form.phone && { phone: form.phone }), language: form.language, isSenior: form.isSenior, ...(form.hourlyWage !== undefined && { hourlyWage: form.hourlyWage }), maxWeeklyHours: form.maxWeeklyHours, maxDaysPerWeek: form.maxDaysPerWeek, vacationDates, isActive: form.isActive };
      if (editMember) {
        await updateStaffMember(user.uid, activePropertyId, editMember.id, data);
      } else {
        await addStaffMember(user.uid, activePropertyId, { ...data, scheduledToday: false, weeklyHours: 0 });
      }
      setShowModal(false);
    } finally { setSaving(false); }
  };

  const handleDelete = (member: StaffMember) => {
    if (window.confirm(lang === 'es' ? `¿Eliminar a ${member.name}?` : `Delete ${member.name}?`)) {
      if (!user || !activePropertyId) return;
      deleteStaffMember(user.uid, activePropertyId, member.id);
    }
  };

  const toggleScheduledToday = async (member: StaffMember) => {
    if (!user || !activePropertyId) return;
    await updateStaffMember(user.uid, activePropertyId, member.id, { scheduledToday: !member.scheduledToday });
  };

  const totalStaff      = staff.length;
  const scheduledToday  = staff.filter(s => s.scheduledToday).length;
  const nearOvertime    = staff.filter(s => s.weeklyHours >= s.maxWeeklyHours - 8).length;
  const hasOvertimeWarning = staff.some(s => s.weeklyHours >= s.maxWeeklyHours - 4);

  const sortedStaff = useMemo(() => [...staff].sort((a, b) => {
    if (a.scheduledToday !== b.scheduledToday) return a.scheduledToday ? -1 : 1;
    return a.name.localeCompare(b.name);
  }), [staff]);

  return (
    <div style={{ padding: '16px', maxWidth: '900px', margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '20px', letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: '10px', margin: 0 }}>
          <Users size={18} color="var(--navy)" />{t('staffRosterTitle', lang)}
        </h2>
        <button onClick={openAdd} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px', background: 'var(--navy-light)', color: '#FFFFFF', border: 'none', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '13px', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
          <Plus size={14} />{t('addStaff', lang)}
        </button>
      </div>

      {totalStaff > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '20px' }}>
          {[
            { label: t('totalStaffLabel', lang),      value: totalStaff,     color: 'var(--navy)' },
            { label: t('scheduledTodayCount', lang),  value: scheduledToday, color: 'var(--green)' },
            { label: t('nearOvertime', lang),          value: nearOvertime,   color: nearOvertime > 0 ? 'var(--amber)' : 'var(--text-muted)' },
          ].map(({ label, value, color }) => (
            <div key={label} className="card" style={{ padding: '14px 12px', textAlign: 'center' }}>
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '6px' }}>{label}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '28px', fontWeight: 700, color }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {hasOvertimeWarning && (
        <div className="animate-in" style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '14px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 'var(--radius-md)', marginBottom: '16px' }}>
          <AlertTriangle size={16} color="var(--amber)" style={{ flexShrink: 0, marginTop: '2px' }} />
          <div>
            <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--amber)', margin: 0 }}>{t('overtimeAlert', lang)}</p>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '4px 0 0' }}>{t('overtimeAlertDesc', lang)}</p>
          </div>
        </div>
      )}

      {staff.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 16px' }}>
          <Users size={40} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', margin: 0 }}>{t('noStaffYet', lang)}</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
          {sortedStaff.map((member, idx) => {
            const utilizationPct = Math.round((member.weeklyHours / member.maxWeeklyHours) * 100);
            const atOrOverMax = member.weeklyHours >= member.maxWeeklyHours;
            const nearMax = member.weeklyHours >= member.maxWeeklyHours - 4;
            return (
              <div key={member.id} className="animate-in" style={{ animationDelay: `${idx * 50}ms` }}>
                <div className="card" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', height: '100%', borderColor: nearMax ? 'rgba(251,191,36,0.3)' : 'var(--border)', background: nearMax ? 'rgba(251,191,36,0.04)' : 'var(--bg-card)' }}>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                    <div style={{ width: '38px', height: '38px', borderRadius: 'var(--radius-md)', background: 'var(--navy)', color: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '14px', flexShrink: 0 }}>{staffInitials(member.name)}</div>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)', margin: '0 0 4px' }}>{member.name}</p>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <span className="chip" style={{ fontSize: '10px', padding: '2px 7px', background: member.language === 'es' ? 'rgba(34,197,94,0.15)' : 'rgba(59,130,246,0.15)', color: member.language === 'es' ? 'var(--green)' : 'var(--blue)' }}>{member.language === 'es' ? 'ES' : 'EN'}</span>
                        {member.isSenior && <span className="chip" style={{ fontSize: '10px', padding: '2px 7px', background: 'rgba(251,191,36,0.15)', color: 'var(--amber)', display: 'flex', alignItems: 'center', gap: '3px' }}><Star size={9} />Senior</span>}
                      </div>
                    </div>
                  </div>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                      <span>{member.weeklyHours}h / {member.maxWeeklyHours}h</span>
                      <span style={{ color: atOrOverMax ? 'var(--red)' : nearMax ? 'var(--amber)' : 'var(--text-muted)' }}>{Math.max(0, member.maxWeeklyHours - member.weeklyHours)}{t('hoursLeftLabel', lang)}</span>
                    </div>
                    <div className="progress-track" style={{ height: '4px', background: 'rgba(0,0,0,0.05)', borderRadius: '2px', overflow: 'hidden' }}>
                      <div style={{ width: `${Math.min(utilizationPct, 100)}%`, height: '100%', background: utilizationPct > 100 ? 'var(--red)' : utilizationPct > 90 ? 'var(--amber)' : 'var(--green)', borderRadius: '2px' }} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px', background: member.scheduledToday ? 'rgba(34,197,94,0.08)' : 'rgba(0,0,0,0.03)', border: '1px solid ' + (member.scheduledToday ? 'rgba(34,197,94,0.2)' : 'var(--border)'), borderRadius: 'var(--radius-md)', cursor: 'pointer' }} onClick={() => toggleScheduledToday(member)}>
                    <Clock size={14} color={member.scheduledToday ? 'var(--green)' : 'var(--text-muted)'} />
                    <span style={{ flex: 1, fontSize: '13px', fontWeight: 500, color: member.scheduledToday ? 'var(--green)' : 'var(--text-secondary)' }}>{member.scheduledToday ? t('scheduledTodayStatus', lang) : t('notScheduled', lang)}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => openEdit(member)} style={{ flex: 1, padding: '8px 12px', background: 'rgba(0,0,0,0.05)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', fontWeight: 500, fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontFamily: 'var(--font-sans)' }}>
                      <Pencil size={12} />{t('edit', lang)}
                    </button>
                    <button onClick={() => handleDelete(member)} style={{ padding: '8px 12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 'var(--radius-md)', color: 'var(--red)', fontWeight: 500, fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-sans)' }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add/Edit Modal */}
      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editMember ? `${t('edit', lang)} ${editMember.name}` : t('addStaffMember', lang)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label className="label">{t('nameRequired', lang)}</label>
            <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="input" placeholder="Maria Garcia" autoFocus />
          </div>
          <div>
            <label className="label">{t('phoneOptional', lang)}</label>
            <input type="tel" value={form.phone ?? ''} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="input" placeholder="(409) 555-1234" />
          </div>
          <div>
            <label className="label">{t('language', lang)}</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              {(['en', 'es'] as const).map(l => (
                <button key={l} onClick={() => setForm(f => ({ ...f, language: l }))} style={{ flex: 1, padding: '10px', border: `1px solid ${form.language === l ? 'var(--amber)' : 'var(--border)'}`, background: form.language === l ? 'rgba(251,191,36,0.1)' : 'transparent', color: form.language === l ? 'var(--amber)' : 'var(--text-secondary)', borderRadius: 'var(--radius-md)', fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: '13px' }}>
                  {l === 'en' ? 'English' : 'Español'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">{t('hourlyWageOptional', lang)}</label>
            <input type="number" value={form.hourlyWage ?? ''} onChange={e => setForm(f => ({ ...f, hourlyWage: e.target.value ? parseFloat(e.target.value) : undefined }))} className="input" placeholder="15.00" step="0.50" min="0" />
          </div>
          <div>
            <label className="label">{t('maxWeeklyHoursLabel', lang)}</label>
            <input type="number" value={form.maxWeeklyHours} onChange={e => setForm(f => ({ ...f, maxWeeklyHours: parseInt(e.target.value) || 40 }))} className="input" placeholder="40" min="1" />
          </div>
          <div>
            <label className="label">{t('maxDaysPerWeekLabel', lang)}</label>
            <input type="number" value={form.maxDaysPerWeek} onChange={e => setForm(f => ({ ...f, maxDaysPerWeek: parseInt(e.target.value) || 5 }))} className="input" placeholder="5" min="1" max="7" />
          </div>
          <div>
            <label className="label">{t('vacationDatesLabel', lang)}</label>
            <textarea value={form.vacationDates} onChange={e => setForm(f => ({ ...f, vacationDates: e.target.value }))} className="input" placeholder={'2026-03-28\n2026-03-29'} rows={3} style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: '12px' }} />
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0 0' }}>{t('vacationDatesHelp', lang)}</p>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'rgba(0,0,0,0.03)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{t('isActiveLabel', lang)}</span>
            <label className="toggle" style={{ margin: 0 }}><input type="checkbox" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} /><span className="toggle-track" /><span className="toggle-thumb" /></label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'rgba(0,0,0,0.03)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{t('seniorStaff', lang)}</span>
            <label className="toggle" style={{ margin: 0 }}><input type="checkbox" checked={form.isSenior} onChange={e => setForm(f => ({ ...f, isSenior: e.target.checked }))} /><span className="toggle-track" /><span className="toggle-thumb" /></label>
          </div>
          <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
            <button onClick={() => setShowModal(false)} style={{ flex: 1, padding: '10px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', borderRadius: 'var(--radius-md)', fontWeight: 500, fontSize: '13px', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>{t('cancel', lang)}</button>
            <button onClick={handleSave} disabled={saving || !form.name.trim()} style={{ flex: 1, padding: '10px', background: saving || !form.name.trim() ? 'rgba(37,99,235,0.4)' : 'var(--navy-light)', color: saving || !form.name.trim() ? 'rgba(255,255,255,0.5)' : '#FFFFFF', border: 'none', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '13px', cursor: saving || !form.name.trim() ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-sans)' }}>
              {saving ? t('savingDots', lang) : editMember ? t('update', lang) : t('addStaff', lang)}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PERFORMANCE SECTION
// ══════════════════════════════════════════════════════════════════════════════

type ViewMode = 'live' | '7d' | '14d';

function PerformanceSection() {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, staff } = useProperty();
  const { lang } = useLang();

  const [view, setView] = useState<ViewMode>('live');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [historyRooms, setHistoryRooms] = useState<Room[][]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());

  const coMins = activeProperty?.checkoutMinutes ?? 30;
  const soMins = activeProperty?.stayoverMinutes ?? 20;

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToRooms(user.uid, activePropertyId, todayStr(), setRooms);
  }, [user, activePropertyId]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const loadHistory = useCallback(async (days: number) => {
    if (!user || !activePropertyId) return;
    setHistoryLoading(true);
    const dates = Array.from({ length: days }, (_, i) => format(subDays(new Date(), i + 1), 'yyyy-MM-dd'));
    const results = await Promise.all(dates.map(d => getRoomsForDate(user.uid, activePropertyId, d)));
    setHistoryRooms(results);
    setHistoryLoading(false);
  }, [user, activePropertyId]);

  useEffect(() => {
    if (view === '7d') loadHistory(7);
    else if (view === '14d') loadHistory(14);
  }, [view, loadHistory]);

  const livePerfs    = buildLive(rooms, coMins, soMins, nowMs);
  const historyPerfs = buildHistory(historyRooms);

  const todayDone = rooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
  const todayTurnaround = (() => {
    const timed = rooms.filter(r => r.startedAt && r.completedAt).map(r => {
      const s = toDate(r.startedAt); const e = toDate(r.completedAt);
      if (!s || !e) return null;
      return (e.getTime() - s.getTime()) / 60_000;
    }).filter((m): m is number => m !== null && m > 0);
    return timed.length > 0 ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null;
  })();

  const scheduledToday  = staff.filter(s => s.scheduledToday);
  const unassignedToday = scheduledToday.filter(s => !livePerfs.find(p => p.staffId === s.id));
  const viewDays        = view === '7d' ? 7 : 14;
  const topHistoryPerf  = historyPerfs[0];

  return (
    <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

      {/* View toggle */}
      <div style={{ display: 'flex', gap: '8px' }}>
        {([
          { key: 'live' as ViewMode, label: t('liveToday', lang) },
          { key: '7d'  as ViewMode, label: t('last7Days', lang) },
          { key: '14d' as ViewMode, label: t('last14Days', lang) },
        ]).map(({ key, label }) => (
          <button key={key} onClick={() => setView(key)} className={`chip${view === key ? ' chip-active' : ''}`} style={{ height: '30px', paddingLeft: '14px', paddingRight: '14px', cursor: 'pointer' }}>
            {label}
          </button>
        ))}
      </div>

      {/* LIVE VIEW */}
      {view === 'live' && (
        <>
          {(livePerfs.length > 0 || todayDone > 0) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '10px' }}>
              {[
                { label: t('roomsDone', lang),    value: `${todayDone}/${rooms.length}`, color: 'var(--green)' },
                { label: t('housekeepers', lang), value: String(livePerfs.filter(p => p.done > 0).length), color: 'var(--amber)' },
                { label: t('avgCleanTime', lang), value: todayTurnaround !== null ? `${todayTurnaround}m` : '—', color: 'var(--text-secondary)' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '16px 10px', textAlign: 'center' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.35rem', color, lineHeight: 1, letterSpacing: '-0.03em' }}>{value}</div>
                  <div className="label" style={{ marginTop: '7px', marginBottom: 0, fontSize: '10px' }}>{label}</div>
                </div>
              ))}
            </div>
          )}

          {livePerfs.length === 0 && unassignedToday.length === 0 && (
            <div style={{ textAlign: 'center', padding: '52px 20px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ width: '60px', height: '60px', borderRadius: '16px', margin: '0 auto 14px', background: 'rgba(0,0,0,0.04)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Users size={28} color="var(--text-muted)" />
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '15px', fontWeight: 500 }}>{t('noActivityToday', lang)}</p>
            </div>
          )}

          {livePerfs.length > 0 && (
            <>
              <p style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '-6px' }}>{t('leaderboard', lang)}</p>
              {livePerfs.map((p, i) => (
                <div key={p.staffId} className={`card animate-in stagger-${Math.min(i + 2, 4)}`} style={{ padding: '16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                    <RankBadge rank={i + 1} />
                    <HKInitials name={p.name} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</p>
                      {p.shiftStart ? (
                        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                          {p.shiftEnd ? `${format(p.shiftStart, 'h:mm a')} → ${format(p.shiftEnd, 'h:mm a')} · ${fmtMins(Math.round((p.shiftEnd.getTime() - p.shiftStart.getTime()) / 60_000))}` : `${lang === 'es' ? 'Iniciado' : 'Started'} ${format(p.shiftStart, 'h:mm a')} · ${lang === 'es' ? 'en progreso' : 'in progress'}`}
                        </p>
                      ) : null}
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '26px', color: 'var(--green)', lineHeight: 1, letterSpacing: '-0.03em' }}>{p.done}</div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase' }}>/ {p.totalAssigned}</div>
                    </div>
                  </div>
                  {p.totalAssigned > 0 && (
                    <div style={{ marginBottom: '10px' }}>
                      <div style={{ height: '6px', borderRadius: '3px', background: 'var(--border)', overflow: 'hidden', display: 'flex' }}>
                        <div style={{ width: `${(p.checkoutsDone / p.totalAssigned) * 100}%`, background: '#22C55E', transition: 'width 400ms ease' }} />
                        <div style={{ width: `${(p.stayoversDone / p.totalAssigned) * 100}%`, background: '#34D399', transition: 'width 400ms ease' }} />
                      </div>
                      <div style={{ display: 'flex', gap: '10px', marginTop: '5px' }}>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}><span style={{ color: '#22C55E', fontWeight: 600 }}>{t('checkoutsShort', lang)}</span> {p.checkoutsDone}/{p.checkoutsAssigned}</span>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}><span style={{ color: '#34D399', fontWeight: 600 }}>{t('stayoversShort', lang)}</span> {p.stayoversDone}/{p.stayoversAssigned}</span>
                      </div>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                    <StatPill label={t('avgCleanTime', lang)} value={p.avgCleanMins !== null ? `${p.avgCleanMins}m` : '—'} />
                    <StatPill label={t('roomsPerHr', lang)} value={p.roomsPerHr !== null ? String(p.roomsPerHr) : '—'} highlight={p.roomsPerHr !== null} />
                    <PaceBadge pace={p.pace} lang={lang} />
                  </div>
                </div>
              ))}
            </>
          )}

          {unassignedToday.length > 0 && (
            <div className="card" style={{ padding: '16px' }}>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: '10px' }}>{t('noActivityToday', lang)}</p>
              {unassignedToday.map((s, i) => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 0', borderBottom: i < unassignedToday.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <HKInitials name={s.name} />
                  <p style={{ fontSize: '14px', color: 'var(--text-secondary)', fontWeight: 500 }}>{s.name}</p>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* HISTORY VIEW */}
      {(view === '7d' || view === '14d') && (
        <>
          {historyLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
              <div className="spinner" style={{ width: '30px', height: '30px' }} />
            </div>
          ) : historyPerfs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '52px 20px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ width: '60px', height: '60px', borderRadius: '16px', margin: '0 auto 14px', background: 'rgba(0,0,0,0.04)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Clock size={28} color="var(--text-muted)" />
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '15px', fontWeight: 500 }}>{t('noHistoryYet', lang)}</p>
              <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '6px' }}>
                {lang === 'es' ? `Los datos aparecerán aquí después de que el equipo complete habitaciones en los últimos ${viewDays} días.` : `Data will appear here after the team completes rooms over the past ${viewDays} days.`}
              </p>
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '10px' }}>
                {[
                  { label: t('roomsDone', lang),    value: String(historyPerfs.reduce((s, p) => s + p.totalDone, 0)), color: 'var(--green)' },
                  { label: t('topPerformer', lang),  value: topHistoryPerf ? topHistoryPerf.name.split(' ')[0] : '—', color: 'var(--amber)' },
                  { label: t('avgPerDay', lang),     value: historyPerfs.length > 0 ? String(Math.round(historyPerfs.reduce((s, p) => s + p.avgPerDay, 0) / historyPerfs.length * 10) / 10) : '—', color: 'var(--text-secondary)' },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '16px 10px', textAlign: 'center' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.25rem', color, lineHeight: 1, letterSpacing: '-0.03em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
                    <div className="label" style={{ marginTop: '7px', marginBottom: 0, fontSize: '10px' }}>{label}</div>
                  </div>
                ))}
              </div>

              {(() => {
                const maxDone = Math.max(...historyPerfs.map(p => p.totalDone), 1);
                return historyPerfs.map((p, i) => (
                  <div key={p.staffId} className={`card animate-in stagger-${Math.min(i + 2, 4)}`} style={{ padding: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                      <RankBadge rank={i + 1} />
                      <HKInitials name={p.name} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</p>
                        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{p.daysActive} {lang === 'es' ? (p.daysActive === 1 ? 'día activo' : 'días activos') : (p.daysActive === 1 ? 'day active' : 'days active')}</p>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '24px', color: 'var(--green)', lineHeight: 1, letterSpacing: '-0.03em' }}>{p.totalDone}</div>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{lang === 'es' ? 'hab.' : 'rooms'}</div>
                      </div>
                    </div>
                    <div style={{ height: '5px', borderRadius: '3px', background: 'var(--border)', marginBottom: '10px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: '3px', background: i === 0 ? 'var(--amber)' : 'var(--green)', width: `${(p.totalDone / maxDone) * 100}%`, transition: 'width 500ms ease' }} />
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      <StatPill label={t('avgPerDay', lang)} value={`${p.avgPerDay}`} highlight={i === 0} />
                      <StatPill label={t('avgCleanTime', lang)} value={p.avgCleanMins !== null ? `${p.avgCleanMins}m` : '—'} />
                      <StatPill label={t('checkoutsShort', lang)} value={String(p.checkoutsDone)} />
                      <StatPill label={t('stayoversShort', lang)} value={String(p.stayoversDone)} />
                    </div>
                  </div>
                ));
              })()}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// IMPORT SECTION
// ══════════════════════════════════════════════════════════════════════════════

function ImportSection() {
  const { lang } = useLang();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[]>([]);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const lines = text.split('\n').filter(l => l.trim()).slice(0, 6);
      setPreview(lines);
    };
    reader.readAsText(file);
  };

  return (
    <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div>
        <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '20px', letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: '10px', margin: '0 0 6px', color: 'var(--text-primary)' }}>
          <Upload size={18} color="var(--navy)" />{t('csvImportTitle', lang)}
        </h2>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>{t('csvHelpText', lang)}</p>
      </div>

      <div
        onClick={() => fileRef.current?.click()}
        style={{ border: '2px dashed var(--border)', borderRadius: 'var(--radius-lg)', padding: '40px 20px', textAlign: 'center', cursor: 'pointer', background: 'rgba(0,0,0,0.02)', transition: 'all 150ms' }}
      >
        <Upload size={32} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
        <p style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>{fileName ?? t('csvDropHint', lang)}</p>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{t('uploadCsv', lang)}</p>
        <input ref={fileRef} type="file" accept=".csv,.txt" onChange={handleFile} style={{ display: 'none' }} />
      </div>

      {preview.length > 0 && (
        <div className="card" style={{ padding: '16px' }}>
          <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '10px' }}>{t('csvPreviewLabel', lang)}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {preview.map((line, i) => (
              <p key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-secondary)', margin: 0, padding: '4px 8px', background: 'rgba(0,0,0,0.03)', borderRadius: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{line}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════════════════

export default function HousekeepingPage() {
  const [activeTab, setActiveTabState] = useState<TabKey>('schedule');
  const { lang } = useLang();
  const { activeProperty } = useProperty();

  // Restore tab from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('hk-tab') as TabKey | null;
    const valid: TabKey[] = ['schedule', 'rooms', 'performance', 'import'];
    if (saved && valid.includes(saved)) setActiveTabState(saved);
  }, []);

  const setActiveTab = (tab: TabKey) => {
    setActiveTabState(tab);
    localStorage.setItem('hk-tab', tab);
  };

  return (
    <AppLayout>
      {/* ── Page header ── */}
      <div style={{ padding: '20px 16px 0' }}>
        <div style={{ padding: '0 0 4px' }}>
          {activeProperty && (
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', fontWeight: 500, marginBottom: '4px' }}>
              {activeProperty.name}
            </p>
          )}
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '24px', color: 'var(--text-primary)', letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
            {t('housekeeping', lang)}
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '2px' }}>
            {lang === 'es' ? 'Gestiona las operaciones diarias de limpieza' : 'Manage daily housekeeping operations'}
          </p>
        </div>
      </div>

      {/* ── Sub-tab bar ── */}
      <div style={{ padding: '16px 16px 0', position: 'sticky', top: 52, zIndex: 10, background: 'var(--bg)' }}>
        <div style={{ display: 'flex', gap: '0', borderBottom: '2px solid var(--border)' }}>
          {TABS.map(tab => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                style={{
                  padding: '10px 20px',
                  flexShrink: 0,
                  border: 'none',
                  borderBottom: `2px solid ${isActive ? 'var(--navy-light)' : 'transparent'}`,
                  marginBottom: '-2px',
                  background: 'transparent',
                  color: isActive ? 'var(--navy-light)' : 'var(--text-muted)',
                  fontWeight: isActive ? 600 : 500,
                  fontSize: '14px',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  fontFamily: 'var(--font-sans)',
                  transition: 'all 120ms',
                }}
              >
                {lang === 'es' ? tab.labelEs : tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Section content ── */}
      {activeTab === 'schedule'    && <ScheduleSection />}
      {activeTab === 'rooms'       && <RoomsSection />}
      {activeTab === 'performance' && <PerformanceSection />}
      {activeTab === 'import'      && <ImportSection />}
    </AppLayout>
  );
}
