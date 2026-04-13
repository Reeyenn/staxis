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
import type { StaffMember, StaffDepartment, ShiftConfirmation, ManagerNotification, ConfirmationStatus } from '@/types';
import {
  Users, Plus, Pencil, Trash2, Star, AlertTriangle, Clock,
  Calendar, ChevronLeft, ChevronRight, Bell, CheckCircle2, XCircle,
  Send, Zap, Bot, Sparkles,
} from 'lucide-react';

/* ════════════════════════════════════════════════════════════════════════════
   SHARED HELPERS
   ════════════════════════════════════════════════════════════════════════════ */

const DEPT_LABELS: Record<string, { en: string; es: string }> = {
  housekeeping: { en: 'Housekeeping', es: 'Limpieza' },
  front_desk:   { en: 'Front Desk',   es: 'Recepción' },
  maintenance:  { en: 'Maintenance',  es: 'Mantenimiento' },
  other:        { en: 'Other',        es: 'Otro' },
};

const DEPARTMENTS: { key: StaffDepartment; label: string; color: string; bg: string; border: string }[] = [
  { key: 'housekeeping', label: 'Housekeeping', color: 'var(--amber)',       bg: 'var(--amber-dim)',          border: 'var(--amber-border)' },
  { key: 'front_desk',   label: 'Front Desk',   color: 'var(--purple, #818cf8)', bg: 'rgba(99,102,241,0.12)',     border: 'rgba(99,102,241,0.25)' },
  { key: 'maintenance',  label: 'Maintenance',  color: 'var(--red)',         bg: 'var(--red-dim)',            border: 'var(--red-border, rgba(239,68,68,0.20))' },
  { key: 'other',        label: 'Other',        color: 'var(--text-muted)',  bg: 'rgba(100,116,139,0.10)',    border: 'var(--border)' },
];

function deptLabel(key: string, lang: 'en' | 'es'): string {
  return DEPT_LABELS[key]?.[lang] ?? key;
}

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
  const onDutyCount = staff.filter(s => s.scheduledToday).length;

  /* ── Derived: Department groups for Stitch layout ── */
  const deptGroups = useMemo(() => {
    const groups: { key: string; label: string; labelEs: string; icon: string; color: string; staff: StaffMember[] }[] = [
      { key: 'front_desk', label: 'Front Desk', labelEs: 'Recepción', icon: 'concierge', color: '#364262', staff: [] },
      { key: 'housekeeping', label: 'Housekeeping', labelEs: 'Limpieza', icon: 'cleaning_services', color: '#006565', staff: [] },
      { key: 'other', label: 'Other', labelEs: 'Otro', icon: 'engineering', color: '#454652', staff: [] },
    ];
    for (const s of staff) {
      const dept = s.department ?? 'housekeeping';
      if (dept === 'front_desk') groups[0].staff.push(s);
      else if (dept === 'housekeeping') groups[1].staff.push(s);
      else groups[2].staff.push(s);
    }
    for (const g of groups) {
      g.staff.sort((a, b) => {
        if (a.scheduledToday !== b.scheduledToday) return a.scheduledToday ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }
    return groups;
  }, [staff]);

  /* ── Load Material Symbols font ── */
  useEffect(() => {
    if (typeof document !== 'undefined' && !document.getElementById('material-symbols-staff')) {
      const link = document.createElement('link');
      link.id = 'material-symbols-staff';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap';
      document.head.appendChild(link);
    }
  }, []);

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
    { key: 'all', label: lang === 'es' ? 'Todos' : 'All' },
    ...DEPARTMENTS.map(d => ({ ...d, label: deptLabel(d.key, lang) })),
  ];

  /* ════════════════════════════════════════════════════════════════════════
     RENDER
     ════════════════════════════════════════════════════════════════════════ */

  return (
    <AppLayout>
      <style>{`
        .staff-dept-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
        @media (max-width: 900px) { .staff-dept-grid { grid-template-columns: 1fr; } }
        .staff-row-stitch { transition: background 0.15s; cursor: pointer; }
        .staff-row-stitch:hover { background: rgba(54,66,98,0.04) !important; }
        .staff-add-inline { transition: all 0.15s; }
        .staff-add-inline:hover { background: rgba(0,101,101,0.06) !important; border-color: #006565 !important; }
      `}</style>
      <div style={{ padding: '24px 28px 28px', maxWidth: '1200px', margin: '0 auto' }}>

        {/* ── Stitch Hero ── */}
        <div className="animate-in" style={{ marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
            <div>
              <h1 style={{ fontFamily: 'Inter, sans-serif', fontWeight: 700, fontSize: '26px', letterSpacing: '-0.02em', margin: 0, color: '#1b1c19' }}>
                {lang === 'es' ? 'Operaciones de Personal' : 'Staff Operations'}
              </h1>
              <p style={{ margin: '4px 0 0', fontSize: '14px', color: '#757684', fontFamily: 'Inter, sans-serif' }}>
                {totalStaff} {lang === 'es' ? 'miembros del equipo' : 'team members'} · {onDutyCount} {lang === 'es' ? 'en turno' : 'on duty'}
              </p>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {/* Notification bell (schedule tab) */}
              {activeTab === 'schedule' && (
                <button
                  onClick={() => setShowNotifPanel(v => !v)}
                  style={{ position: 'relative', background: 'none', border: 'none', cursor: 'pointer', padding: '6px', color: unreadCount > 0 ? '#006565' : '#757684' }}
                >
                  <Bell size={20} strokeWidth={unreadCount > 0 ? 2.2 : 1.6} />
                  {unreadCount > 0 && (
                    <span style={{ position: 'absolute', top: '2px', right: '2px', width: '16px', height: '16px', background: '#ba1a1a', color: '#fff', borderRadius: '50%', fontSize: '9px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                  )}
                </button>
              )}

              {/* Add staff button */}
              {activeTab === 'directory' && (
                <button onClick={openAdd} style={{
                  display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 20px',
                  background: '#364262', color: '#FFFFFF', border: 'none', borderRadius: '9999px',
                  fontWeight: 600, fontSize: '14px', cursor: 'pointer', fontFamily: 'Inter, sans-serif',
                }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>person_add</span>
                  {t('addStaff', lang)}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── Stitch Tab bar ── */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
          {(['directory', 'schedule'] as const).map(tab => {
            const isActive = activeTab === tab;
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '10px 24px',
                  background: isActive ? '#364262' : 'rgba(255,255,255,0.7)',
                  backdropFilter: isActive ? 'none' : 'blur(24px)',
                  border: isActive ? 'none' : '1px solid #d5d2ca',
                  borderRadius: '9999px',
                  fontFamily: 'Inter, sans-serif',
                  fontSize: '14px',
                  fontWeight: isActive ? 600 : 500,
                  color: isActive ? '#FFFFFF' : '#454652',
                  cursor: 'pointer',
                  transition: 'all 150ms',
                  display: 'flex', alignItems: 'center', gap: '8px',
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                  {tab === 'directory' ? 'groups' : 'calendar_month'}
                </span>
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

            {/* ── Key Stats Bar ── */}
            {totalStaff > 0 && (
              <div style={{
                display: 'flex', gap: '16px', marginBottom: '24px', flexWrap: 'wrap',
              }}>
                {[
                  { label: lang === 'es' ? 'Total' : 'Total Staff', value: totalStaff, icon: 'groups', color: '#364262' },
                  { label: lang === 'es' ? 'En Turno' : 'On Duty', value: onDutyCount, icon: 'check_circle', color: '#006565' },
                  { label: lang === 'es' ? 'Cerca de Horas Extra' : 'Near Overtime', value: nearOvertime, icon: 'warning', color: nearOvertime > 0 ? '#ba1a1a' : '#757684' },
                ].map(({ label, value, icon, color }) => (
                  <div key={label} style={{
                    flex: '1 1 140px', padding: '16px 20px',
                    background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
                    border: '1px solid #d5d2ca', borderRadius: '24px',
                    display: 'flex', alignItems: 'center', gap: '14px',
                  }}>
                    <span className="material-symbols-outlined" style={{ fontSize: '24px', color }}>{icon}</span>
                    <div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '22px', fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
                      <div style={{ fontSize: '12px', fontWeight: 500, color: '#757684', marginTop: '2px', fontFamily: 'Inter, sans-serif' }}>{label}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Department Sections (3-column grid) ── */}
            {totalStaff === 0 ? (
              <div style={{ textAlign: 'center', padding: '64px 16px' }}>
                <span className="material-symbols-outlined" style={{ fontSize: '48px', color: '#757684', marginBottom: '12px', display: 'block' }}>group_off</span>
                <p style={{ color: '#757684', fontSize: '15px', margin: 0, fontFamily: 'Inter, sans-serif' }}>
                  {lang === 'es' ? 'Aún no hay personal' : 'No staff members yet'}
                </p>
              </div>
            ) : (
              <div className="staff-dept-grid">
                {deptGroups.map(group => (
                  <div key={group.key} style={{
                    background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
                    border: '1px solid #d5d2ca', borderRadius: '24px',
                    overflow: 'hidden',
                  }}>
                    {/* Department header */}
                    <div style={{
                      padding: '18px 20px 14px',
                      borderBottom: '1px solid #eae8e3',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span className="material-symbols-outlined" style={{ fontSize: '22px', color: group.color }}>{group.icon}</span>
                        <span style={{ fontFamily: 'Inter, sans-serif', fontWeight: 700, fontSize: '16px', color: '#1b1c19' }}>
                          {lang === 'es' ? group.labelEs : group.label}
                        </span>
                      </div>
                      <span style={{
                        fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', fontWeight: 600,
                        background: '#eae8e3', color: '#454652', borderRadius: '9999px',
                        padding: '3px 10px',
                      }}>
                        {group.staff.length}
                      </span>
                    </div>

                    {/* Staff rows */}
                    <div style={{ padding: '8px 0' }}>
                      {group.staff.length === 0 ? (
                        <div style={{ padding: '24px 20px', textAlign: 'center' }}>
                          <p style={{ fontSize: '13px', color: '#757684', margin: 0, fontFamily: 'Inter, sans-serif' }}>
                            {lang === 'es' ? 'Sin personal' : 'No staff'}
                          </p>
                        </div>
                      ) : (
                        group.staff.map((member) => {
                          const nearMax = member.weeklyHours >= member.maxWeeklyHours - 4;
                          return (
                            <div
                              key={member.id}
                              className="staff-row-stitch"
                              onClick={() => openEdit(member)}
                              style={{
                                display: 'flex', alignItems: 'center', gap: '12px',
                                padding: '10px 20px',
                                opacity: member.isActive === false ? 0.45 : 1,
                              }}
                            >
                              {/* Avatar */}
                              <div style={{
                                width: '36px', height: '36px', borderRadius: '12px',
                                background: group.color, color: '#FFFFFF',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontWeight: 700, fontSize: '13px', fontFamily: 'Inter, sans-serif', flexShrink: 0,
                              }}>
                                {initials(member.name)}
                              </div>

                              {/* Name + info */}
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  <span style={{ fontWeight: 600, fontSize: '14px', color: '#1b1c19', fontFamily: 'Inter, sans-serif', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {member.name}
                                  </span>
                                  {member.isSenior && (
                                    <span style={{
                                      fontSize: '10px', fontWeight: 700, color: '#006565',
                                      background: 'rgba(0,101,101,0.08)', border: '1px solid rgba(0,101,101,0.15)',
                                      borderRadius: '9999px', padding: '1px 7px',
                                    }}>SR</span>
                                  )}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                                  <span style={{ fontSize: '12px', color: '#757684', fontFamily: 'Inter, sans-serif' }}>
                                    {member.language === 'es' ? 'ES' : 'EN'}
                                  </span>
                                  <span style={{ fontSize: '11px', color: '#d5d2ca' }}>·</span>
                                  <span style={{
                                    fontSize: '12px', fontFamily: "'JetBrains Mono', monospace",
                                    color: nearMax ? '#ba1a1a' : '#757684',
                                  }}>
                                    {member.weeklyHours}h/{member.maxWeeklyHours}h
                                  </span>
                                </div>
                              </div>

                              {/* Duty badge */}
                              <div
                                onClick={(e) => { e.stopPropagation(); toggleScheduledToday(member); }}
                                style={{
                                  padding: '5px 12px', borderRadius: '9999px',
                                  background: member.scheduledToday ? 'rgba(0,101,101,0.08)' : '#eae8e3',
                                  border: `1px solid ${member.scheduledToday ? 'rgba(0,101,101,0.2)' : '#d5d2ca'}`,
                                  cursor: 'pointer', flexShrink: 0,
                                  fontSize: '12px', fontWeight: 600, fontFamily: 'Inter, sans-serif',
                                  color: member.scheduledToday ? '#006565' : '#757684',
                                  display: 'flex', alignItems: 'center', gap: '5px',
                                }}
                              >
                                <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>
                                  {member.scheduledToday ? 'check_circle' : 'schedule'}
                                </span>
                                {member.scheduledToday
                                  ? (lang === 'es' ? 'En turno' : 'On Duty')
                                  : (lang === 'es' ? 'Libre' : 'Off')
                                }
                              </div>
                            </div>
                          );
                        })
                      )}

                      {/* Inline Add Staff card */}
                      <div
                        className="staff-add-inline"
                        onClick={() => {
                          setEditMember(null);
                          const dept = group.key === 'other' ? 'maintenance' : group.key as StaffDepartment;
                          setForm({ ...EMPTY_FORM, department: dept });
                          setShowModal(true);
                        }}
                        style={{
                          margin: '4px 12px 8px', padding: '12px 16px',
                          border: '2px dashed #d5d2ca', borderRadius: '16px',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                          cursor: 'pointer', color: '#757684',
                        }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>person_add</span>
                        <span style={{ fontSize: '13px', fontWeight: 600, fontFamily: 'Inter, sans-serif' }}>
                          {lang === 'es' ? 'Agregar' : 'Add Staff'}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════
            SCHEDULE TAB
            ════════════════════════════════════════════════════════════════ */}
        {activeTab === 'schedule' && (
          <div className="animate-in">

            {/* ── Notification panel (Stitch) ── */}
            {showNotifPanel && (
              <div style={{
                marginBottom: '16px', padding: '18px 20px',
                background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
                border: '1px solid #d5d2ca', borderRadius: '24px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <span style={{ fontSize: '14px', fontWeight: 700, color: '#1b1c19', fontFamily: 'Inter, sans-serif' }}>{t('notificationsTitle', lang)}</span>
                  {unreadCount > 0 && (
                    <button onClick={() => { if (uid && pid) markAllNotificationsRead(uid, pid).catch(err => console.error('[staff] mark all read failed:', err)); }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', color: '#006565', fontWeight: 600, padding: 0, fontFamily: 'Inter, sans-serif' }}>
                      {t('markAllRead', lang)}
                    </button>
                  )}
                </div>
                {notifications.length === 0 ? (
                  <p style={{ fontSize: '14px', color: '#757684', margin: 0, fontFamily: 'Inter, sans-serif' }}>{t('noNotifications', lang)}</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {notifications.slice(0, 10).map(n => (
                      <div key={n.id} onClick={() => { if (!n.read && uid && pid) markNotificationRead(uid, pid, n.id).catch(err => console.error('[staff] mark read failed:', err)); }} style={{
                        display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 14px',
                        background: n.read ? 'transparent' : 'rgba(0,101,101,0.04)',
                        border: `1px solid ${n.read ? '#eae8e3' : 'rgba(0,101,101,0.15)'}`,
                        borderRadius: '16px', cursor: n.read ? 'default' : 'pointer',
                      }}>
                        <span className="material-symbols-outlined" style={{ fontSize: '16px', flexShrink: 0, marginTop: '1px', color: n.type === 'decline' || n.type === 'no_replacement' ? '#ba1a1a' : n.type === 'all_confirmed' ? '#006565' : '#364262' }}>
                          {n.type === 'all_confirmed' ? 'check_circle' : n.type === 'decline' ? 'cancel' : n.type === 'no_replacement' ? 'warning' : 'groups'}
                        </span>
                        <p style={{ margin: 0, fontSize: '13px', color: '#454652', lineHeight: 1.4, fontFamily: 'Inter, sans-serif', flex: 1 }}>{n.message}</p>
                        {!n.read && <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#006565', flexShrink: 0, marginTop: '5px' }} />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Conversational Hero ── */}
            <div style={{ marginBottom: '28px' }}>
              <h2 style={{
                fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: '28px',
                letterSpacing: '-0.02em', color: '#1b1c19', margin: 0, lineHeight: 1.3,
              }}>
                {gmRec.summary || (lang === 'es' ? 'Planifica el turno del equipo.' : 'Plan your team\'s shift.')}
              </h2>

              {/* Action buttons row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '20px' }}>
                {!sent && gmRec.picks.length > 0 && !gmAccepted && (
                  <button onClick={acceptGMPicks} style={{
                    padding: '14px 28px', background: '#364262', color: '#FFFFFF',
                    border: 'none', borderRadius: '9999px', fontWeight: 600, fontSize: '15px',
                    cursor: 'pointer', fontFamily: 'Inter, sans-serif',
                    display: 'flex', alignItems: 'center', gap: '8px',
                    transition: 'all 0.15s',
                  }}>
                    {lang === 'es' ? 'Revisar y Publicar' : 'Review & Publish'}
                  </button>
                )}
                {!sent && gmRec.picks.length > 0 && !gmAccepted && (
                  <button onClick={() => setGmAccepted(true)} style={{
                    padding: '14px 24px', background: 'rgba(0,101,101,0.08)',
                    color: '#006565', border: 'none', borderRadius: '9999px',
                    fontWeight: 600, fontSize: '15px', cursor: 'pointer', fontFamily: 'Inter, sans-serif',
                    display: 'flex', alignItems: 'center', gap: '8px',
                    transition: 'all 0.15s',
                  }}>
                    <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>colors_spark</span>
                    {lang === 'es' ? 'Personalizar' : 'Customize Crew'}
                  </button>
                )}
              </div>
            </div>

            {/* ── Date Selector (Stitch) ── */}
            <div style={{
              marginBottom: '20px', padding: '16px 20px',
              background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
              border: '1px solid #d5d2ca', borderRadius: '20px',
              display: 'flex', alignItems: 'center', gap: '12px',
            }}>
              <button onClick={() => { setShiftDate(d => addDays(d, -1)); setSent(false); setSelected([]); setGmAccepted(false); }} style={{
                background: '#eae8e3', border: 'none', borderRadius: '50%',
                width: '36px', height: '36px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span className="material-symbols-outlined" style={{ fontSize: '20px', color: '#454652' }}>chevron_left</span>
              </button>
              <span style={{ flex: 1, textAlign: 'center', fontSize: '15px', fontWeight: 600, color: '#1b1c19', fontFamily: 'Inter, sans-serif' }}>
                {formatDisplayDate(shiftDate, lang)}
              </span>
              <button onClick={() => { setShiftDate(d => addDays(d, 1)); setSent(false); setSelected([]); setGmAccepted(false); }} style={{
                background: '#eae8e3', border: 'none', borderRadius: '50%',
                width: '36px', height: '36px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span className="material-symbols-outlined" style={{ fontSize: '20px', color: '#454652' }}>chevron_right</span>
              </button>
            </div>

            {/* ── Sent Banner (Stitch) ── */}
            {sent && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 20px',
                background: 'rgba(0,101,101,0.06)', border: '1px solid rgba(0,101,101,0.2)',
                borderRadius: '20px', marginBottom: '20px',
              }}>
                <span className="material-symbols-outlined" style={{ fontSize: '20px', color: '#006565' }}>check_circle</span>
                <span style={{ fontSize: '14px', fontWeight: 600, color: '#006565', fontFamily: 'Inter, sans-serif' }}>{t('confirmationsSent', lang)}</span>
              </div>
            )}

            {/* ── Who's Working Today / Confirmations ── */}
            {confirmations.length > 0 && (
              <div style={{ marginBottom: '24px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '14px' }}>
                  <h3 style={{ margin: 0, fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: '18px', color: '#1b1c19' }}>
                    {lang === 'es' ? 'Equipo del Día' : "Who's Working"}
                  </h3>
                  <span style={{ fontSize: '14px', color: '#757684', fontWeight: 500, fontFamily: 'Inter, sans-serif' }}>
                    {formatDisplayDate(shiftDate, lang)}
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
                  {confirmations.map(conf => {
                    const confColor = conf.status === 'confirmed' ? '#006565' : conf.status === 'declined' ? '#ba1a1a' : conf.status === 'pending' ? '#364262' : '#757684';
                    const confBg = conf.status === 'confirmed' ? 'rgba(0,101,101,0.06)' : conf.status === 'declined' ? 'rgba(186,26,26,0.06)' : 'transparent';
                    const confIcon = conf.status === 'confirmed' ? 'check_circle' : conf.status === 'declined' ? 'cancel' : conf.status === 'pending' ? 'schedule' : 'help';
                    return (
                      <div key={conf.id} style={{
                        padding: '16px 20px',
                        background: 'rgba(255,255,255,0.8)', backdropFilter: 'blur(24px)',
                        border: '1px solid #d5d2ca', borderRadius: '24px',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <div style={{
                            width: '40px', height: '40px', borderRadius: '50%',
                            background: '#364262', color: '#fff',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontWeight: 700, fontSize: '14px', fontFamily: 'Inter, sans-serif',
                          }}>
                            {initials(conf.staffName)}
                          </div>
                          <div>
                            <p style={{ margin: 0, fontWeight: 600, fontSize: '14px', color: '#1b1c19', fontFamily: 'Inter, sans-serif' }}>{conf.staffName}</p>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '2px' }}>
                              <span className="material-symbols-outlined" style={{ fontSize: '14px', color: confColor }}>{confIcon}</span>
                              <span style={{ fontSize: '12px', fontWeight: 600, color: confColor, fontFamily: 'Inter, sans-serif' }}>
                                {t(conf.status === 'pending' ? 'statusPending' : conf.status === 'confirmed' ? 'statusConfirmed' : conf.status === 'declined' ? 'statusDeclined' : 'statusNoResponse', lang)}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── AI GM Recommendation (Stitch card) ── */}
            {!sent && gmRec.picks.length > 0 && !gmAccepted && (
              <div style={{
                marginBottom: '20px', padding: '20px 24px',
                background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
                border: '1px solid rgba(0,101,101,0.2)', borderRadius: '24px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '22px', color: '#006565' }}>smart_toy</span>
                  <p style={{ margin: 0, fontFamily: 'Inter, sans-serif', fontWeight: 700, fontSize: '16px', color: '#1b1c19' }}>
                    {lang === 'es' ? 'Recomendación del GM' : 'GM Recommendation'}
                  </p>
                </div>
                <p style={{ margin: '0 0 14px', fontSize: '14px', color: '#454652', fontFamily: 'Inter, sans-serif', lineHeight: 1.5 }}>
                  {gmRec.summary}
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '10px', marginBottom: '16px' }}>
                  {gmRec.picks.map(({ member, reason }) => (
                    <div key={member.id} style={{
                      display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px',
                      background: 'rgba(255,255,255,0.8)', border: '1px solid #eae8e3',
                      borderRadius: '20px',
                    }}>
                      <div style={{
                        width: '36px', height: '36px', borderRadius: '50%',
                        background: '#364262', color: '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '12px', fontWeight: 700, fontFamily: 'Inter, sans-serif', flexShrink: 0,
                      }}>
                        {initials(member.name)}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ margin: 0, fontWeight: 600, fontSize: '14px', color: '#1b1c19', fontFamily: 'Inter, sans-serif' }}>{member.name}</p>
                        <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#757684', fontFamily: 'Inter, sans-serif', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{reason}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button onClick={acceptGMPicks} style={{
                    flex: 1, padding: '12px', background: '#364262', color: '#fff',
                    border: 'none', borderRadius: '9999px', fontWeight: 600, fontSize: '14px',
                    cursor: 'pointer', fontFamily: 'Inter, sans-serif',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                  }}>
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>check</span>
                    {lang === 'es' ? 'Aceptar y Seleccionar' : 'Accept & Select'}
                  </button>
                  <button onClick={() => setGmAccepted(true)} style={{
                    padding: '12px 20px', background: 'transparent', color: '#454652',
                    border: '1px solid #d5d2ca', borderRadius: '9999px', fontWeight: 600, fontSize: '14px',
                    cursor: 'pointer', fontFamily: 'Inter, sans-serif',
                  }}>
                    {lang === 'es' ? 'Saltar' : 'Skip'}
                  </button>
                </div>
              </div>
            )}

            {/* ── Manual Crew Selection (Stitch) ── */}
            <div style={{
              marginBottom: '20px', padding: '20px 24px',
              background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
              border: '1px solid #d5d2ca', borderRadius: '24px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                <h3 style={{ margin: 0, fontFamily: 'Inter, sans-serif', fontWeight: 700, fontSize: '16px', color: '#1b1c19' }}>
                  {lang === 'es' ? 'Seleccionar Equipo' : 'Select Crew'}
                </h3>
                {selected.length > 0 && (
                  <span style={{
                    fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', fontWeight: 600,
                    background: 'rgba(0,101,101,0.08)', color: '#006565', borderRadius: '9999px', padding: '4px 12px',
                  }}>
                    {selected.length} {lang === 'es' ? 'seleccionados' : 'selected'}
                  </span>
                )}
              </div>

              {!staffLoaded ? (
                <p style={{ fontSize: '14px', color: '#757684', margin: 0, fontFamily: 'Inter, sans-serif' }}>{lang === 'es' ? 'Cargando…' : 'Loading…'}</p>
              ) : staff.filter(s => s.isActive !== false).length === 0 ? (
                <p style={{ fontSize: '14px', color: '#757684', margin: 0, fontFamily: 'Inter, sans-serif' }}>{t('noEligibleStaff', lang)}</p>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '10px' }}>
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
                      const dept = DEPT_LABELS[member.department ?? 'housekeeping']?.[lang] ?? member.department;
                      return (
                        <div key={member.id} onClick={() => eligible && toggleSelected(member)} style={{
                          padding: '14px 16px',
                          background: inPool ? 'rgba(0,101,101,0.04)' : isSelected ? 'rgba(54,66,98,0.04)' : 'rgba(255,255,255,0.8)',
                          border: `1px solid ${inPool ? 'rgba(0,101,101,0.25)' : isSelected ? 'rgba(54,66,98,0.3)' : '#eae8e3'}`,
                          borderRadius: '20px', cursor: eligible ? 'pointer' : 'default',
                          display: 'flex', alignItems: 'center', gap: '12px',
                          opacity: (!eligible && !inPool) ? 0.4 : 1, transition: 'all 0.15s',
                        }}>
                          {/* Selection circle */}
                          <div style={{
                            width: '22px', height: '22px', borderRadius: '50%',
                            border: `2px solid ${inPool ? '#006565' : isSelected ? '#364262' : '#d5d2ca'}`,
                            background: inPool ? 'rgba(0,101,101,0.15)' : isSelected ? 'rgba(54,66,98,0.15)' : 'transparent',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                          }}>
                            {(inPool || isSelected) && (
                              <span className="material-symbols-outlined" style={{ fontSize: '14px', color: inPool ? '#006565' : '#364262' }}>check</span>
                            )}
                          </div>
                          {/* Avatar */}
                          <div style={{
                            width: '36px', height: '36px', borderRadius: '50%',
                            background: inPool ? '#006565' : '#364262', color: '#fff',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '12px', fontWeight: 700, fontFamily: 'Inter, sans-serif', flexShrink: 0,
                          }}>
                            {initials(member.name)}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ margin: 0, fontWeight: 600, fontSize: '14px', color: '#1b1c19', fontFamily: 'Inter, sans-serif', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{member.name}</p>
                            <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#757684', fontFamily: 'Inter, sans-serif' }}>
                              {dept} · {inPool ? t('crewForDate', lang) : onVacation ? t('onVacation', lang) : !member.phone ? t('noPhoneLabel', lang) : isAtLimit ? t('atLimitLabel', lang) : eligible ? `${member.daysWorkedThisWeek ?? 0} ${t('daysWorkedLabel', lang)}` : t('inactiveLabel', lang)}
                            </p>
                          </div>
                          {member.isSenior && (
                            <span style={{
                              fontSize: '10px', fontWeight: 700, color: '#006565',
                              background: 'rgba(0,101,101,0.08)', borderRadius: '9999px', padding: '2px 8px',
                              fontFamily: 'Inter, sans-serif',
                            }}>SR</span>
                          )}
                        </div>
                      );
                    })}

                  {/* Add Team Member card */}
                  <div
                    className="staff-add-inline"
                    onClick={openAdd}
                    style={{
                      padding: '14px 16px',
                      border: '2px dashed #d5d2ca', borderRadius: '20px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
                      cursor: 'pointer', color: '#757684',
                    }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>person_add</span>
                    <span style={{ fontSize: '14px', fontWeight: 600, fontFamily: 'Inter, sans-serif' }}>
                      {lang === 'es' ? 'Agregar Miembro' : 'Add Team Member'}
                    </span>
                  </div>
                </div>
              )}

              {/* Send button */}
              {selected.length > 0 && (
                <button onClick={handleSend} disabled={sending} style={{
                  marginTop: '20px', width: '100%', padding: '16px',
                  background: sending ? 'rgba(54,66,98,0.4)' : '#364262',
                  color: sending ? 'rgba(255,255,255,0.5)' : '#FFFFFF',
                  border: 'none', borderRadius: '9999px', fontWeight: 600, fontSize: '15px',
                  cursor: sending ? 'not-allowed' : 'pointer', fontFamily: 'Inter, sans-serif',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
                }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>send</span>
                  {sending ? t('sendingLabel', lang) : `${t('sendConfirmations', lang)} (${selected.length})`}
                </button>
              )}
            </div>

            {/* ── Weekly Hours Tracker (Stitch) ── */}
            <div style={{
              padding: '20px 24px',
              background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
              border: '1px solid #d5d2ca', borderRadius: '24px',
            }}>
              <h3 style={{ margin: '0 0 16px', fontFamily: 'Inter, sans-serif', fontWeight: 700, fontSize: '16px', color: '#1b1c19' }}>
                {t('weeklyHoursTracker', lang)}
              </h3>
              {!staffLoaded ? (
                <p style={{ fontSize: '14px', color: '#757684', margin: 0, fontFamily: 'Inter, sans-serif' }}>{lang === 'es' ? 'Cargando…' : 'Loading…'}</p>
              ) : staff.filter(s => s.isActive !== false).length === 0 ? (
                <p style={{ fontSize: '14px', color: '#757684', margin: 0, fontFamily: 'Inter, sans-serif' }}>{t('noStaffYet', lang)}</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {staff.filter(s => s.isActive !== false).sort((a, b) => (b.weeklyHours ?? 0) - (a.weeklyHours ?? 0)).map(member => {
                    const maxHrs = member.maxWeeklyHours ?? 40;
                    const hrs = member.weeklyHours ?? 0;
                    const pct = Math.min((hrs / maxHrs) * 100, 100);
                    const atLimit = hrs >= maxHrs;
                    const nearLimit = hrs >= maxHrs - 4;
                    return (
                      <div key={member.id}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                          <span style={{ fontSize: '13px', fontWeight: 600, color: '#1b1c19', fontFamily: 'Inter, sans-serif' }}>
                            {member.name}
                            {member.vacationDates?.includes(shiftDate) && (
                              <span style={{ marginLeft: '8px', fontSize: '11px', color: '#364262', fontWeight: 600, fontFamily: 'Inter, sans-serif' }}>{t('onVacation', lang)}</span>
                            )}
                          </span>
                          <span style={{ fontSize: '12px', fontFamily: "'JetBrains Mono', monospace", color: atLimit ? '#ba1a1a' : nearLimit ? '#364262' : '#757684' }}>
                            {hrs}h / {maxHrs}h
                          </span>
                        </div>
                        <div style={{ height: '6px', background: '#eae8e3', borderRadius: '9999px', overflow: 'hidden' }}>
                          <div style={{ width: `${pct}%`, height: '100%', background: atLimit ? '#ba1a1a' : nearLimit ? '#364262' : '#006565', borderRadius: '9999px', transition: 'width 0.3s' }} />
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
        {/* ── Stitch Add/Edit Staff Modal ── */}
        {showModal && (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(27,28,25,0.4)', backdropFilter: 'blur(8px)',
          }} onClick={() => setShowModal(false)}>
            <div onClick={e => e.stopPropagation()} style={{
              background: '#fbf9f4', borderRadius: '24px',
              width: '90%', maxWidth: '480px', maxHeight: '85vh', overflowY: 'auto',
              padding: '28px', boxShadow: '0 24px 48px rgba(0,0,0,0.15)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
                <h2 style={{ margin: 0, fontFamily: 'Inter, sans-serif', fontWeight: 700, fontSize: '20px', color: '#1b1c19' }}>
                  {editMember ? `${t('editStaff', lang)} ${editMember.name}` : t('addStaffMember', lang)}
                </h2>
                <button onClick={() => setShowModal(false)} style={{ background: '#eae8e3', border: 'none', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '18px', color: '#454652' }}>close</span>
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', fontFamily: 'Inter, sans-serif' }}>{t('nameRequired', lang)}</label>
                  <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus
                    style={{ width: '100%', padding: '12px 16px', border: '1px solid #d5d2ca', borderRadius: '16px', background: '#fff', fontSize: '14px', fontFamily: 'Inter, sans-serif', color: '#1b1c19', outline: 'none', boxSizing: 'border-box' }}
                    placeholder="Maria Garcia" />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', fontFamily: 'Inter, sans-serif' }}>{t('department', lang)}</label>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {DEPARTMENTS.map(d => {
                      const sel = form.department === d.key;
                      return (
                        <button key={d.key} onClick={() => setForm(f => ({ ...f, department: d.key }))} style={{
                          padding: '8px 16px', borderRadius: '9999px',
                          border: sel ? '1px solid #364262' : '1px solid #d5d2ca',
                          background: sel ? '#364262' : 'transparent',
                          color: sel ? '#fff' : '#454652',
                          fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter, sans-serif',
                        }}>
                          {deptLabel(d.key, lang)}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', fontFamily: 'Inter, sans-serif' }}>{t('phoneOptional', lang)}</label>
                  <input type="tel" value={form.phone ?? ''} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                    style={{ width: '100%', padding: '12px 16px', border: '1px solid #d5d2ca', borderRadius: '16px', background: '#fff', fontSize: '14px', fontFamily: 'Inter, sans-serif', color: '#1b1c19', outline: 'none', boxSizing: 'border-box' }}
                    placeholder="(409) 555-1234" />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', fontFamily: 'Inter, sans-serif' }}>{t('language', lang)}</label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {(['en', 'es'] as const).map(l => {
                      const sel = form.language === l;
                      return (
                        <button key={l} onClick={() => setForm(f => ({ ...f, language: l }))} style={{
                          flex: 1, padding: '12px',
                          border: sel ? '1px solid #006565' : '1px solid #d5d2ca',
                          background: sel ? 'rgba(0,101,101,0.08)' : 'transparent',
                          color: sel ? '#006565' : '#454652',
                          borderRadius: '16px', fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter, sans-serif', fontSize: '14px',
                        }}>
                          {l === 'en' ? 'English' : 'Español'}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', fontFamily: 'Inter, sans-serif' }}>{t('hourlyWageOptional', lang)}</label>
                  <input type="number" value={form.hourlyWage ?? ''} step="0.50" min="0" onChange={e => setForm(f => ({ ...f, hourlyWage: e.target.value ? parseFloat(e.target.value) : undefined }))}
                    style={{ width: '100%', padding: '12px 16px', border: '1px solid #d5d2ca', borderRadius: '16px', background: '#fff', fontSize: '14px', fontFamily: "'JetBrains Mono', monospace", color: '#1b1c19', outline: 'none', boxSizing: 'border-box' }}
                    placeholder="15.00" />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', fontFamily: 'Inter, sans-serif' }}>{t('maxWeeklyHoursLabel', lang)}</label>
                    <input type="number" value={form.maxWeeklyHours} min="1" onChange={e => setForm(f => ({ ...f, maxWeeklyHours: parseInt(e.target.value) || 40 }))}
                      style={{ width: '100%', padding: '12px 16px', border: '1px solid #d5d2ca', borderRadius: '16px', background: '#fff', fontSize: '14px', fontFamily: "'JetBrains Mono', monospace", color: '#1b1c19', outline: 'none', boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', fontFamily: 'Inter, sans-serif' }}>{t('maxDaysPerWeekLabel', lang)}</label>
                    <input type="number" value={form.maxDaysPerWeek} min="1" max="7" onChange={e => setForm(f => ({ ...f, maxDaysPerWeek: parseInt(e.target.value) || 5 }))}
                      style={{ width: '100%', padding: '12px 16px', border: '1px solid #d5d2ca', borderRadius: '16px', background: '#fff', fontSize: '14px', fontFamily: "'JetBrains Mono', monospace", color: '#1b1c19', outline: 'none', boxSizing: 'border-box' }} />
                  </div>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', fontFamily: 'Inter, sans-serif' }}>{t('vacationDatesLabel', lang)}</label>
                  <textarea value={form.vacationDates} onChange={e => setForm(f => ({ ...f, vacationDates: e.target.value }))}
                    style={{ width: '100%', padding: '12px 16px', border: '1px solid #d5d2ca', borderRadius: '16px', background: '#fff', fontSize: '13px', fontFamily: "'JetBrains Mono', monospace", color: '#1b1c19', outline: 'none', resize: 'vertical', boxSizing: 'border-box' }}
                    placeholder={'2026-07-04\n2026-12-25'} rows={3} />
                  <p style={{ fontSize: '11px', color: '#757684', margin: '4px 0 0', fontFamily: 'Inter, sans-serif' }}>{t('vacationDatesHelp', lang)}</p>
                </div>

                {[
                  { label: t('isActiveLabel', lang), field: 'isActive' as const },
                  { label: t('seniorStaff', lang), field: 'isSenior' as const },
                ].map(({ label, field }) => (
                  <div key={field} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: '#eae8e3', borderRadius: '16px' }}>
                    <span style={{ fontSize: '14px', color: '#1b1c19', fontFamily: 'Inter, sans-serif' }}>{label}</span>
                    <label className="toggle" style={{ margin: 0 }}>
                      <input type="checkbox" checked={form[field] as boolean} onChange={e => setForm(f => ({ ...f, [field]: e.target.checked }))} />
                      <span className="toggle-track" />
                      <span className="toggle-thumb" />
                    </label>
                  </div>
                ))}

                {/* Delete button (edit mode only) */}
                {editMember && (
                  <button onClick={() => { setShowModal(false); handleDelete(editMember); }} style={{
                    padding: '12px', border: '1px solid rgba(186,26,26,0.2)', background: 'rgba(186,26,26,0.05)',
                    color: '#ba1a1a', borderRadius: '9999px', fontWeight: 600, fontSize: '14px',
                    cursor: 'pointer', fontFamily: 'Inter, sans-serif',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                  }}>
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>delete</span>
                    {lang === 'es' ? 'Eliminar' : 'Delete'}
                  </button>
                )}

                <div style={{ display: 'flex', gap: '12px', marginTop: '4px' }}>
                  <button onClick={() => setShowModal(false)} style={{
                    flex: 1, padding: '14px', border: '1px solid #d5d2ca', background: 'transparent',
                    color: '#454652', borderRadius: '9999px', fontWeight: 600, fontSize: '14px',
                    cursor: 'pointer', fontFamily: 'Inter, sans-serif',
                  }}>
                    {t('cancel', lang)}
                  </button>
                  <button onClick={handleSave} disabled={saving || !form.name.trim()} style={{
                    flex: 1, padding: '14px',
                    background: saving || !form.name.trim() ? 'rgba(54,66,98,0.4)' : '#364262',
                    color: saving || !form.name.trim() ? 'rgba(255,255,255,0.5)' : '#FFFFFF',
                    border: 'none', borderRadius: '9999px', fontWeight: 600, fontSize: '14px',
                    cursor: saving || !form.name.trim() ? 'not-allowed' : 'pointer', fontFamily: 'Inter, sans-serif',
                  }}>
                    {saving ? t('savingDots', lang) : editMember ? t('update', lang) : t('addStaff', lang)}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </AppLayout>
  );
}
