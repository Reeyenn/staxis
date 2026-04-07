'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  addStaffMember, updateStaffMember, deleteStaffMember,
  subscribeToShiftConfirmations, subscribeToManagerNotifications,
  markNotificationRead, markAllNotificationsRead,
} from '@/lib/firestore';
import { Modal } from '@/components/ui/Modal';
import type { StaffMember, StaffDepartment, ShiftConfirmation, ManagerNotification, ConfirmationStatus } from '@/types';
import {
  Users, Plus, Pencil, Trash2, Star, AlertTriangle, Clock,
  Calendar, ChevronLeft, ChevronRight, Bell, CheckCircle2, XCircle,
  Send, Zap, Bot, Sparkles,
} from 'lucide-react';

/* ════════════════════════════════════════════════════════════════════════════
   SHARED HELPERS
   ════════════════════════════════════════════════════════════════════════════ */

const DEPARTMENTS: { key: StaffDepartment; label: string; color: string; bg: string; border: string }[] = [
  { key: 'housekeeping', label: 'Housekeeping', color: 'var(--amber)',       bg: 'var(--amber-dim)',          border: 'var(--amber-border)' },
  { key: 'front_desk',   label: 'Front Desk',   color: 'var(--purple, #818cf8)', bg: 'rgba(99,102,241,0.12)',     border: 'rgba(99,102,241,0.25)' },
  { key: 'maintenance',  label: 'Maintenance',  color: 'var(--red)',         bg: 'var(--red-dim)',            border: 'var(--red-border, rgba(239,68,68,0.20))' },
  { key: 'other',        label: 'Other',        color: 'var(--text-muted)',  bg: 'rgba(100,116,139,0.10)',    border: 'var(--border)' },
];

function deptConfig(dept?: StaffDepartment) {
  return DEPARTMENTS.find(d => d.key === (dept ?? 'housekeeping')) ?? DEPARTMENTS[0];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function todayStr(): string {
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
  if ((s.daysWorkedThisWeek ?? 0) >= (s.maxDaysPerWeek ?? 5)) return false;
  if ((s.weeklyHours ?? 0) >= (s.maxWeeklyHours ?? 40)) return false;
  return true;
}

const STATUS_COLOR: Record<ConfirmationStatus, string> = {
  pending: 'var(--amber)', confirmed: 'var(--green)', declined: 'var(--red)', no_response: 'var(--text-muted)',
};
const STATUS_ICON: Record<ConfirmationStatus, React.ReactNode> = {
  pending: <Clock size={13} />, confirmed: <CheckCircle2 size={13} />, declined: <XCircle size={13} />, no_response: <AlertTriangle size={13} />,
};

/* ════════════════════════════════════════════════════════════════════════════
   AI GM RECOMMENDATION ENGINE
   ════════════════════════════════════════════════════════════════════════════ */

interface GMRecommendation {
  picks: { member: StaffMember; reason: string }[];
  summary: string;
  neededCount: number;
}

function generateGMRecommendation(
  staff: StaffMember[],
  date: string,
  totalRooms: number,
  occupancyPct: number,
  alreadyInPool: Set<string>,
): GMRecommendation {
  // Estimate rooms that will need cleaning
  const estimatedOccupied = Math.round(totalRooms * (occupancyPct / 100));
  // Housekeepers can handle ~15 rooms per shift
  const neededHK = Math.max(1, Math.ceil(estimatedOccupied / 15));

  // Get eligible housekeeping staff only
  const eligible = staff
    .filter(s => (s.department ?? 'housekeeping') === 'housekeeping')
    .filter(s => isEligible(s, date) && !alreadyInPool.has(s.id));

  // Score each person (lower = better pick)
  const scored = eligible.map(s => {
    let score = 0;
    const daysWorked = s.daysWorkedThisWeek ?? 0;
    const hoursWorked = s.weeklyHours ?? 0;
    const maxHours = s.maxWeeklyHours ?? 40;

    // Fairness: fewer days worked = better
    score += daysWorked * 10;
    // Hours utilization: lower = more available
    score += (hoursWorked / maxHours) * 20;
    // Seniors get slight priority (they're faster, more reliable)
    if (s.isSenior) score -= 5;
    // If near overtime, deprioritize
    if (hoursWorked >= maxHours - 8) score += 15;

    return { member: s, score };
  }).sort((a, b) => a.score - b.score);

  const picks = scored.slice(0, neededHK).map(({ member }) => {
    const daysWorked = member.daysWorkedThisWeek ?? 0;
    const hoursLeft = Math.max(0, (member.maxWeeklyHours ?? 40) - (member.weeklyHours ?? 0));
    let reason = '';
    if (daysWorked === 0) reason = 'Fresh this week — 0 days worked';
    else if (daysWorked <= 2) reason = `Light week — only ${daysWorked} day${daysWorked > 1 ? 's' : ''} so far`;
    else reason = `${hoursLeft}h left before max`;
    if (member.isSenior) reason += ' · Senior';
    return { member, reason };
  });

  const alreadyConfirmed = alreadyInPool.size;
  const stillNeeded = Math.max(0, neededHK - alreadyConfirmed);

  let summary = '';
  if (alreadyConfirmed >= neededHK) {
    summary = `You're fully staffed for ~${estimatedOccupied} rooms. ${alreadyConfirmed} already confirmed.`;
  } else if (picks.length === 0) {
    summary = `Need ${neededHK} housekeepers for ~${estimatedOccupied} rooms but no eligible staff available.`;
  } else if (picks.length < stillNeeded) {
    summary = `Need ${stillNeeded} more housekeeper${stillNeeded > 1 ? 's' : ''} for ~${estimatedOccupied} rooms. Only ${picks.length} available — you may be short-staffed.`;
  } else {
    summary = `${estimatedOccupied} rooms to clean → need ${neededHK} housekeeper${neededHK > 1 ? 's' : ''}${alreadyConfirmed > 0 ? ` (${alreadyConfirmed} already in)` : ''}. Here's who I'd call in:`;
  }

  return { picks, summary, neededCount: neededHK };
}

/* ════════════════════════════════════════════════════════════════════════════
   FORM TYPES
   ════════════════════════════════════════════════════════════════════════════ */

interface StaffFormData {
  name: string;
  phone?: string;
  language: 'en' | 'es';
  department: StaffDepartment;
  isSenior: boolean;
  hourlyWage?: number;
  maxWeeklyHours: number;
  maxDaysPerWeek: number;
  vacationDates: string;
  isActive: boolean;
}

const EMPTY_FORM: StaffFormData = {
  name: '', language: 'es', department: 'housekeeping',
  isSenior: false, maxWeeklyHours: 40, maxDaysPerWeek: 5,
  vacationDates: '', isActive: true,
};

/* ════════════════════════════════════════════════════════════════════════════
   MAIN PAGE
   ════════════════════════════════════════════════════════════════════════════ */

export default function StaffPage() {
  const { user } = useAuth();
  const { activePropertyId, activeProperty, staff, staffLoaded, refreshStaff } = useProperty();
  const { lang } = useLang();

  const uid = user?.uid ?? '';
  const pid = activePropertyId ?? '';

  /* ── Tab state ── */
  const [activeTab, setActiveTab] = useState<'directory' | 'schedule'>('directory');

  /* ── Directory state ── */
  const [deptFilter, setDeptFilter] = useState<StaffDepartment | 'all'>('all');
  const [showModal, setShowModal] = useState(false);
  const [editMember, setEditMember] = useState<StaffMember | null>(null);
  const [form, setForm] = useState<StaffFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  /* ── Schedule state ── */
  const tomorrow = addDays(todayStr(), 1);
  const [shiftDate, setShiftDate] = useState(tomorrow);
  const [selected, setSelected] = useState<StaffMember[]>([]);
  const [confirmations, setConfirmations] = useState<ShiftConfirmation[]>([]);
  const [notifications, setNotifications] = useState<ManagerNotification[]>([]);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [showNotifPanel, setShowNotifPanel] = useState(false);
  const [gmAccepted, setGmAccepted] = useState(false);

  /* ── Data subscriptions ── */
  useEffect(() => {
    if (uid && pid && staff.length === 0) refreshStaff();
  }, [uid, pid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!uid || !pid) return;
    setSent(false);
    setGmAccepted(false);
    return subscribeToShiftConfirmations(uid, pid, shiftDate, setConfirmations);
  }, [uid, pid, shiftDate]);

  useEffect(() => {
    if (!uid || !pid) return;
    return subscribeToManagerNotifications(uid, pid, setNotifications);
  }, [uid, pid]);

  /* ── Derived: Directory ── */
  const counts = useMemo(() => {
    const map: Record<string, number> = { all: staff.length };
    for (const s of staff) {
      const d = s.department ?? 'housekeeping';
      map[d] = (map[d] ?? 0) + 1;
    }
    return map;
  }, [staff]);

  const displayStaff = useMemo(() => {
    const filtered = deptFilter === 'all' ? staff : staff.filter(s => (s.department ?? 'housekeeping') === deptFilter);
    return [...filtered].sort((a, b) => {
      if (a.scheduledToday !== b.scheduledToday) return a.scheduledToday ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [staff, deptFilter]);

  const totalStaff = staff.length;
  const scheduledToday = staff.filter(s => s.scheduledToday).length;
  const nearOvertime = staff.filter(s => s.weeklyHours >= s.maxWeeklyHours - 8).length;

  /* ── Derived: Schedule ── */
  const unreadCount = notifications.filter(n => !n.read).length;

  const alreadyInPool = useMemo(() => {
    return new Set(confirmations.filter(c => c.status !== 'declined').map(c => c.staffId));
  }, [confirmations]);

  const totalRooms = activeProperty?.totalRooms || 0;
  // Use a rough occupancy estimate — in real life this would come from PMS
  const occupancyPct = totalRooms > 0 ? Math.round(((staff.filter(s => s.scheduledToday).length * 15) / totalRooms) * 100) : 65;

  const gmRec = useMemo(
    () => generateGMRecommendation(staff, shiftDate, totalRooms, 65, alreadyInPool),
    [staff, shiftDate, totalRooms, alreadyInPool],
  );

  /* ── Directory handlers ── */
  const openAdd = () => {
    setEditMember(null);
    setForm({ ...EMPTY_FORM, department: deptFilter !== 'all' ? deptFilter : 'housekeeping' });
    setShowModal(true);
  };

  const openEdit = (member: StaffMember) => {
    setEditMember(member);
    setForm({
      name: member.name, phone: member.phone, language: member.language,
      department: member.department ?? 'housekeeping', isSenior: member.isSenior,
      hourlyWage: member.hourlyWage, maxWeeklyHours: member.maxWeeklyHours,
      maxDaysPerWeek: member.maxDaysPerWeek ?? 5,
      vacationDates: (member.vacationDates ?? []).join('\n'),
      isActive: member.isActive ?? true,
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!uid || !pid || !form.name.trim()) return;
    setSaving(true);
    try {
      const vacationDates = form.vacationDates.split('\n').map(s => s.trim()).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));
      const data = {
        name: form.name.trim(),
        ...(form.phone && { phone: form.phone }),
        language: form.language, department: form.department, isSenior: form.isSenior,
        ...(form.hourlyWage !== undefined && { hourlyWage: form.hourlyWage }),
        maxWeeklyHours: form.maxWeeklyHours, maxDaysPerWeek: form.maxDaysPerWeek,
        vacationDates, isActive: form.isActive,
      };
      if (editMember) await updateStaffMember(uid, pid, editMember.id, data);
      else await addStaffMember(uid, pid, { ...data, scheduledToday: false, weeklyHours: 0 });
      setShowModal(false);
    } finally { setSaving(false); }
  };

  const handleDelete = (member: StaffMember) => {
    if (window.confirm(lang === 'es' ? `¿Eliminar a ${member.name}?` : `Delete ${member.name}?`)) {
      if (uid && pid) deleteStaffMember(uid, pid, member.id)
        .catch(err => console.error('[staff] delete failed:', err));
    }
  };

  const toggleScheduledToday = async (member: StaffMember) => {
    try {
      if (uid && pid) await updateStaffMember(uid, pid, member.id, { scheduledToday: !member.scheduledToday });
    } catch (err) {
      console.error('[staff] toggle schedule failed:', err);
    }
  };

  /* ── Schedule handlers ── */
  const toggleSelected = (member: StaffMember) => {
    setSelected(prev => prev.some(s => s.id === member.id) ? prev.filter(s => s.id !== member.id) : [...prev, member]);
  };

  const acceptGMPicks = () => {
    setSelected(gmRec.picks.map(p => p.member));
    setGmAccepted(true);
  };

  const handleSend = async () => {
    if (!uid || !pid || selected.length === 0 || sending) return;
    setSending(true);
    try {
      const baseUrl = window.location.origin;
      const staffPayload = selected.filter(s => s.phone).map(s => ({
        staffId: s.id, name: s.name, phone: s.phone!, language: s.language,
      }));
      await fetch('/api/send-shift-confirmations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, pid, shiftDate, baseUrl, staff: staffPayload }),
      });
      setSent(true);
      setSelected([]);
    } catch (err) {
      console.error('[staff] send confirmations failed:', err);
    } finally { setSending(false); }
  };

  /* ── Filter tabs for directory ── */
  const filterTabs: { key: StaffDepartment | 'all'; label: string }[] = [
    { key: 'all', label: 'All' }, ...DEPARTMENTS,
  ];

  /* ════════════════════════════════════════════════════════════════════════
     RENDER
     ════════════════════════════════════════════════════════════════════════ */

  return (
    <AppLayout>
      <div style={{ padding: '16px 20px 20px', maxWidth: '900px', margin: '0 auto' }}>

        {/* ── Page header ── */}
        <div className="animate-in" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '22px', letterSpacing: '-0.02em', margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Users size={20} color="var(--navy)" />
            {t('staff', lang)}
          </h1>

          {/* Notification bell (schedule tab) */}
          {activeTab === 'schedule' && (
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
          )}

          {/* Add staff (directory tab) */}
          {activeTab === 'directory' && (
            <button onClick={openAdd} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px', background: 'var(--navy-light)', color: '#FFFFFF', border: 'none', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '13px', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
              <Plus size={14} />
              {t('addStaff', lang)}
            </button>
          )}
        </div>

        {/* ── Tab bar ── */}
        <div style={{ display: 'flex', gap: '4px', marginBottom: '20px', background: 'rgba(0,0,0,0.04)', borderRadius: 'var(--radius-md)', padding: '3px' }}>
          {(['directory', 'schedule'] as const).map(tab => {
            const isActive = activeTab === tab;
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  flex: 1, padding: '10px 16px',
                  background: isActive ? 'var(--bg-card)' : 'transparent',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  boxShadow: isActive ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  fontFamily: 'var(--font-sans)',
                  fontSize: '14px',
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                  cursor: 'pointer',
                  transition: 'all 150ms',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                }}
              >
                {tab === 'directory' ? <Users size={15} /> : <Calendar size={15} />}
                {tab === 'directory'
                  ? (lang === 'es' ? 'Directorio' : 'Directory')
                  : (lang === 'es' ? 'Horario' : 'Schedule')
                }
              </button>
            );
          })}
        </div>

        {/* ════════════════════════════════════════════════════════════════
            DIRECTORY TAB
            ════════════════════════════════════════════════════════════════ */}
        {activeTab === 'directory' && (
          <div className="animate-in">

            {/* Stats */}
            {totalStaff > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '16px' }}>
                {[
                  { label: t('totalStaffLabel', lang), value: totalStaff, color: 'var(--amber)' },
                  { label: t('scheduledTodayCount', lang), value: scheduledToday, color: 'var(--green)' },
                  { label: t('nearOvertime', lang), value: nearOvertime, color: nearOvertime > 0 ? 'var(--amber)' : 'var(--text-muted)' },
                ].map(({ label, value, color }) => (
                  <div key={label} className="card" style={{ padding: '14px 12px', textAlign: 'center' }}>
                    <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '6px' }}>{label}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '28px', fontWeight: 700, color }}>{value}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Department filter */}
            <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '4px', marginBottom: '16px' }}>
              {filterTabs.map(tab => {
                const isActive = deptFilter === tab.key;
                const count = counts[tab.key] ?? 0;
                if (tab.key !== 'all' && count === 0) return null;
                return (
                  <button key={tab.key} onClick={() => setDeptFilter(tab.key)} style={{
                    display: 'flex', alignItems: 'center', gap: '5px', padding: '7px 13px', borderRadius: '20px', whiteSpace: 'nowrap',
                    border: isActive ? '1px solid var(--amber-border)' : '1px solid var(--border)',
                    background: isActive ? 'var(--amber-dim)' : 'var(--bg-card)',
                    color: isActive ? 'var(--amber)' : 'var(--text-muted)',
                    fontSize: '13px', fontWeight: isActive ? 600 : 400, cursor: 'pointer', fontFamily: 'var(--font-sans)', flexShrink: 0,
                  }}>
                    {tab.label}
                    <span style={{ fontSize: '11px', fontWeight: 700, background: isActive ? 'rgba(212,144,64,0.2)' : 'rgba(0,0,0,0.05)', borderRadius: '10px', padding: '1px 6px' }}>{count}</span>
                  </button>
                );
              })}
            </div>

            {/* Staff list */}
            {displayStaff.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '48px 16px' }}>
                <Users size={40} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
                <p style={{ color: 'var(--text-muted)', fontSize: '14px', margin: 0 }}>
                  No {deptFilter === 'all' ? '' : (DEPARTMENTS.find(d => d.key === deptFilter)?.label ?? '') + ' '}staff yet
                </p>
              </div>
            ) : (
              <div className="card" style={{ overflow: 'hidden' }}>
                {displayStaff.map((member, idx) => {
                  const dept = deptConfig(member.department);
                  const nearMax = member.weeklyHours >= member.maxWeeklyHours - 4;
                  return (
                    <div
                      key={member.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '12px',
                        padding: '12px 16px',
                        borderBottom: idx < displayStaff.length - 1 ? '1px solid var(--border)' : 'none',
                        opacity: member.isActive === false ? 0.5 : 1,
                        background: nearMax ? 'rgba(251,191,36,0.04)' : 'transparent',
                      }}
                    >
                      {/* Avatar */}
                      <div style={{ width: '34px', height: '34px', borderRadius: '8px', background: 'var(--navy)', color: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '12px', flexShrink: 0 }}>
                        {initials(member.name)}
                      </div>

                      {/* Name + department */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{member.name}</span>
                          {member.isSenior && <Star size={11} color="var(--amber)" fill="var(--amber)" />}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                          <span style={{ fontSize: '11px', fontWeight: 600, color: dept.color }}>{dept.label}</span>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>·</span>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{member.language === 'es' ? 'ES' : 'EN'}</span>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>·</span>
                          <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: nearMax ? 'var(--amber)' : 'var(--text-muted)' }}>{member.weeklyHours}h/{member.maxWeeklyHours}h</span>
                        </div>
                      </div>

                      {/* Scheduled indicator */}
                      <div
                        onClick={(e) => { e.stopPropagation(); toggleScheduledToday(member); }}
                        style={{
                          padding: '6px 14px', borderRadius: '8px',
                          background: member.scheduledToday ? 'rgba(34,197,94,0.12)' : 'rgba(0,0,0,0.04)',
                          border: `1px solid ${member.scheduledToday ? 'rgba(34,197,94,0.3)' : 'var(--border)'}`,
                          cursor: 'pointer', flexShrink: 0,
                          fontSize: '13px', fontWeight: 600,
                          color: member.scheduledToday ? 'var(--green)' : 'var(--text-muted)',
                          display: 'flex', alignItems: 'center', gap: '4px',
                        }}
                      >
                        {member.scheduledToday ? 'Scheduled ✓' : 'Schedule ›'}
                      </div>

                      {/* Edit */}
                      <button
                        onClick={(e) => { e.stopPropagation(); openEdit(member); }}
                        style={{
                          padding: '6px 14px', borderRadius: '8px',
                          background: 'rgba(0,0,0,0.04)', border: '1px solid var(--border)',
                          cursor: 'pointer', flexShrink: 0,
                          fontSize: '13px', fontWeight: 600, color: 'var(--text-muted)',
                        }}
                      >
                        Edit ›
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════
            SCHEDULE TAB
            ════════════════════════════════════════════════════════════════ */}
        {activeTab === 'schedule' && (
          <div className="animate-in">

            {/* Notification panel */}
            {showNotifPanel && (
              <div className="card animate-in" style={{ padding: '16px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{t('notificationsTitle', lang)}</span>
                  {unreadCount > 0 && (
                    <button onClick={() => { if (uid && pid) markAllNotificationsRead(uid, pid).catch(err => console.error('[staff] mark all read failed:', err)); }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', color: 'var(--amber)', fontWeight: 600, padding: 0 }}>
                      {t('markAllRead', lang)}
                    </button>
                  )}
                </div>
                {notifications.length === 0 ? (
                  <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>{t('noNotifications', lang)}</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {notifications.slice(0, 10).map(n => (
                      <div key={n.id} onClick={() => { if (!n.read && uid && pid) markNotificationRead(uid, pid, n.id).catch(err => console.error('[staff] mark read failed:', err)); }} style={{
                        display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 12px',
                        background: n.read ? 'transparent' : 'rgba(251,191,36,0.05)',
                        border: `1px solid ${n.read ? 'var(--border)' : 'rgba(251,191,36,0.2)'}`,
                        borderRadius: 'var(--radius-md)', cursor: n.read ? 'default' : 'pointer',
                      }}>
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
            <div className="card" style={{ padding: '16px', marginBottom: '16px' }}>
              <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '10px' }}>
                {t('selectShiftDate', lang)}
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <button onClick={() => { setShiftDate(d => addDays(d, -1)); setSent(false); setSelected([]); setGmAccepted(false); }} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '6px 10px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                  <ChevronLeft size={16} />
                </button>
                <span style={{ flex: 1, textAlign: 'center', fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {formatDisplayDate(shiftDate, lang)}
                </span>
                <button onClick={() => { setShiftDate(d => addDays(d, 1)); setSent(false); setSelected([]); setGmAccepted(false); }} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '6px 10px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>

            {/* Sent banner */}
            {sent && (
              <div className="animate-in" style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', borderRadius: 'var(--radius-md)', marginBottom: '16px' }}>
                <CheckCircle2 size={16} color="var(--green)" />
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--green)' }}>{t('confirmationsSent', lang)}</span>
              </div>
            )}

            {/* Existing confirmations */}
            {confirmations.length > 0 && (
              <div className="card" style={{ padding: '16px', marginBottom: '16px' }}>
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

            {/* ── AI GM RECOMMENDATION ── */}
            {!sent && gmRec.picks.length > 0 && !gmAccepted && (
              <div className="card animate-in" style={{
                padding: '18px',
                marginBottom: '16px',
                background: 'linear-gradient(135deg, rgba(27,58,92,0.04) 0%, rgba(37,99,235,0.04) 100%)',
                border: '1px solid rgba(37,99,235,0.15)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                  <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: 'rgba(37,99,235,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Bot size={16} color="var(--navy-light)" />
                  </div>
                  <div>
                    <p style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                      GM Recommendation
                    </p>
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
                      {gmRec.summary}
                    </p>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
                  {gmRec.picks.map(({ member, reason }) => (
                    <div key={member.id} style={{
                      display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px',
                      background: 'rgba(255,255,255,0.7)', border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)',
                    }}>
                      <div style={{ width: '28px', height: '28px', borderRadius: '6px', background: 'var(--navy)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 700, flexShrink: 0 }}>
                        {initials(member.name)}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>{member.name}</p>
                        <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>{reason}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={acceptGMPicks} style={{
                    flex: 1, padding: '10px', background: 'var(--navy-light)', color: '#fff',
                    border: 'none', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '13px',
                    cursor: 'pointer', fontFamily: 'var(--font-sans)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                  }}>
                    <Sparkles size={14} />
                    Accept & Select
                  </button>
                  <button onClick={() => setGmAccepted(true)} style={{
                    padding: '10px 16px', background: 'transparent', color: 'var(--text-muted)',
                    border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 500, fontSize: '13px',
                    cursor: 'pointer', fontFamily: 'var(--font-sans)',
                  }}>
                    Skip
                  </button>
                </div>
              </div>
            )}

            {/* Manual crew selection */}
            <div className="card" style={{ padding: '16px', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', margin: 0 }}>
                  {lang === 'es' ? 'Seleccionar equipo' : 'Select Crew'}
                  {selected.length > 0 && <span style={{ marginLeft: '8px', color: 'var(--amber)' }}>· {selected.length} selected</span>}
                </p>
              </div>

              {!staffLoaded ? (
                <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>{lang === 'es' ? 'Cargando…' : 'Loading…'}</p>
              ) : staff.filter(s => s.isActive !== false).length === 0 ? (
                <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>{t('noEligibleStaff', lang)}</p>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '8px' }}>
                  {staff
                    .filter(s => s.isActive !== false)
                    .sort((a, b) => {
                      const aIn = alreadyInPool.has(a.id);
                      const bIn = alreadyInPool.has(b.id);
                      if (aIn !== bIn) return aIn ? -1 : 1;
                      const aSel = selected.some(x => x.id === a.id);
                      const bSel = selected.some(x => x.id === b.id);
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
                        <div key={member.id} onClick={() => eligible && toggleSelected(member)} style={{
                          padding: '10px 12px',
                          border: `1px solid ${inPool ? 'rgba(34,197,94,0.3)' : isSelected ? 'rgba(251,191,36,0.5)' : eligible ? 'var(--border)' : 'rgba(0,0,0,0.04)'}`,
                          background: inPool ? 'rgba(34,197,94,0.05)' : isSelected ? 'rgba(251,191,36,0.07)' : 'rgba(0,0,0,0.02)',
                          borderRadius: 'var(--radius-md)', cursor: eligible ? 'pointer' : 'default',
                          display: 'flex', alignItems: 'center', gap: '10px',
                          opacity: (!eligible && !inPool) ? 0.45 : 1, transition: 'all 0.15s',
                        }}>
                          <div style={{
                            width: '18px', height: '18px', borderRadius: '5px',
                            border: `2px solid ${inPool ? 'var(--green)' : isSelected ? 'var(--amber)' : 'var(--border)'}`,
                            background: inPool ? 'rgba(34,197,94,0.2)' : isSelected ? 'rgba(251,191,36,0.2)' : 'transparent',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                          }}>
                            {(inPool || isSelected) && <CheckCircle2 size={11} color={inPool ? 'var(--green)' : 'var(--amber)'} strokeWidth={2.5} />}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{member.name}</p>
                            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>
                              {inPool ? t('crewForDate', lang) : onVacation ? t('onVacation', lang) : !member.phone ? t('noPhoneLabel', lang) : isAtLimit ? t('atLimitLabel', lang) : eligible ? `${member.daysWorkedThisWeek ?? 0} ${t('daysWorkedLabel', lang)}` : t('inactiveLabel', lang)}
                            </p>
                          </div>
                          {member.isSenior && (
                            <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--amber)', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: '4px', padding: '1px 5px' }}>SR</span>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}

              {/* Send button */}
              {selected.length > 0 && (
                <button onClick={handleSend} disabled={sending} className="animate-in" style={{
                  marginTop: '16px', width: '100%', padding: '14px',
                  background: sending ? 'rgba(37,99,235,0.4)' : 'var(--navy-light)',
                  color: sending ? 'rgba(255,255,255,0.5)' : '#FFFFFF',
                  border: 'none', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '14px',
                  cursor: sending ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-sans)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                }}>
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
              ) : staff.filter(s => s.isActive !== false).length === 0 ? (
                <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>{t('noStaffYet', lang)}</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {staff.filter(s => s.isActive !== false).sort((a, b) => (b.weeklyHours ?? 0) - (a.weeklyHours ?? 0)).map(member => {
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
                            {member.vacationDates?.includes(shiftDate) && (
                              <span style={{ marginLeft: '6px', fontSize: '10px', color: 'var(--blue)', fontWeight: 600 }}>{t('onVacation', lang)}</span>
                            )}
                          </span>
                          <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: atLimit ? 'var(--red)' : nearLimit ? 'var(--amber)' : 'var(--text-muted)' }}>
                            {hrs}h / {maxHrs}h
                          </span>
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
        )}

        {/* ════════════════════════════════════════════════════════════════
            ADD/EDIT STAFF MODAL
            ════════════════════════════════════════════════════════════════ */}
        <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editMember ? `${t('editStaff', lang)} ${editMember.name}` : t('addStaffMember', lang)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label className="label">{t('nameRequired', lang)}</label>
              <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="input" placeholder="Maria Garcia" autoFocus />
            </div>
            <div>
              <label className="label">{t('department', lang)}</label>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {DEPARTMENTS.map(d => (
                  <button key={d.key} onClick={() => setForm(f => ({ ...f, department: d.key }))} style={{
                    padding: '7px 12px', borderRadius: 'var(--radius-sm)',
                    border: `1px solid ${form.department === d.key ? d.border : 'var(--border)'}`,
                    background: form.department === d.key ? d.bg : 'transparent',
                    color: form.department === d.key ? d.color : 'var(--text-muted)',
                    fontSize: '13px', fontWeight: form.department === d.key ? 600 : 400, cursor: 'pointer', fontFamily: 'var(--font-sans)',
                  }}>
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">{t('phoneOptional', lang)}</label>
              <input type="tel" value={form.phone ?? ''} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="input" placeholder="(409) 555-1234" />
            </div>
            <div>
              <label className="label">{t('language', lang)}</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                {(['en', 'es'] as const).map(l => (
                  <button key={l} onClick={() => setForm(f => ({ ...f, language: l }))} style={{
                    flex: 1, padding: '10px',
                    border: `1px solid ${form.language === l ? 'var(--amber)' : 'var(--border)'}`,
                    background: form.language === l ? 'rgba(251,191,36,0.1)' : 'transparent',
                    color: form.language === l ? 'var(--amber)' : 'var(--text-secondary)',
                    borderRadius: 'var(--radius-md)', fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: '13px',
                  }}>
                    {l === 'en' ? 'English' : 'Español'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">{t('hourlyWageOptional', lang)}</label>
              <input type="number" value={form.hourlyWage ?? ''} step="0.50" min="0" onChange={e => setForm(f => ({ ...f, hourlyWage: e.target.value ? parseFloat(e.target.value) : undefined }))} className="input" placeholder="15.00" />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div>
                <label className="label">{t('maxWeeklyHoursLabel', lang)}</label>
                <input type="number" value={form.maxWeeklyHours} min="1" onChange={e => setForm(f => ({ ...f, maxWeeklyHours: parseInt(e.target.value) || 40 }))} className="input" />
              </div>
              <div>
                <label className="label">{t('maxDaysPerWeekLabel', lang)}</label>
                <input type="number" value={form.maxDaysPerWeek} min="1" max="7" onChange={e => setForm(f => ({ ...f, maxDaysPerWeek: parseInt(e.target.value) || 5 }))} className="input" />
              </div>
            </div>
            <div>
              <label className="label">{t('vacationDatesLabel', lang)}</label>
              <textarea value={form.vacationDates} onChange={e => setForm(f => ({ ...f, vacationDates: e.target.value }))} className="input" placeholder={'2026-07-04\n2026-12-25'} rows={3} style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: '12px' }} />
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0 0' }}>{t('vacationDatesHelp', lang)}</p>
            </div>
            {[
              { label: t('isActiveLabel', lang), field: 'isActive' as const },
              { label: t('seniorStaff', lang), field: 'isSenior' as const },
            ].map(({ label, field }) => (
              <div key={field} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'rgba(0,0,0,0.03)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{label}</span>
                <label className="toggle" style={{ margin: 0 }}>
                  <input type="checkbox" checked={form[field] as boolean} onChange={e => setForm(f => ({ ...f, [field]: e.target.checked }))} />
                  <span className="toggle-track" />
                  <span className="toggle-thumb" />
                </label>
              </div>
            ))}
            <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
              <button onClick={() => setShowModal(false)} style={{ flex: 1, padding: '10px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', borderRadius: 'var(--radius-md)', fontWeight: 500, fontSize: '13px', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
                {t('cancel', lang)}
              </button>
              <button onClick={handleSave} disabled={saving || !form.name.trim()} style={{
                flex: 1, padding: '10px',
                background: saving || !form.name.trim() ? 'rgba(37,99,235,0.4)' : 'var(--navy-light)',
                color: saving || !form.name.trim() ? 'rgba(255,255,255,0.5)' : '#FFFFFF',
                border: 'none', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '13px',
                cursor: saving || !form.name.trim() ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-sans)',
              }}>
                {saving ? t('savingDots', lang) : editMember ? t('update', lang) : t('addStaff', lang)}
              </button>
            </div>
          </div>
        </Modal>

      </div>
    </AppLayout>
  );
}
