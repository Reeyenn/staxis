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
  isSchedulingManager: boolean;
}

const EMPTY_FORM: StaffFormData = {
  name: '', language: 'es', department: 'housekeeping',
  isSenior: false, maxWeeklyHours: 40, maxDaysPerWeek: 5,
  vacationDates: '', isActive: true, isSchedulingManager: false,
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
  // In-app confirmation popup for Scheduling Manager swaps. When set, the
  // swap-confirm modal is rendered over everything else. null = no swap pending.
  const [swapConfirm, setSwapConfirm] = useState<
    { currentManagerId: string; currentManagerName: string; newName: string } | null
  >(null);

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

  // Material Symbols font is loaded globally via globals.css

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
      isSchedulingManager: member.isSchedulingManager === true,
    });
    setShowModal(true);
  };

  // Core save routine. Assumes any required scheduling-manager swap has already
  // been performed by the caller (handleSave or the swap-confirm modal Confirm
  // button). Kept as its own function so both entry points share one code path.
  const performSave = async () => {
    if (!uid || !pid || !form.name.trim()) return;
    setSaving(true);
    try {
      const vacationDates = form.vacationDates.split('\n').map(s => s.trim()).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));
      // NOTE: `phone` is included unconditionally (even when empty). With the
      // previous `...(form.phone && { phone })` spread, clearing the field did
      // NOT clear the phone in Firestore — the old value survived the partial
      // update. Writing '' explicitly fixes that.
      const data = {
        name: form.name.trim(),
        phone: form.phone?.trim() ?? '',
        language: form.language, department: form.department, isSenior: form.isSenior,
        ...(form.hourlyWage !== undefined && { hourlyWage: form.hourlyWage }),
        maxWeeklyHours: form.maxWeeklyHours, maxDaysPerWeek: form.maxDaysPerWeek,
        vacationDates, isActive: form.isActive,
        isSchedulingManager: form.isSchedulingManager,
      };
      if (editMember) await updateStaffMember(uid, pid, editMember.id, data);
      else await addStaffMember(uid, pid, { ...data, scheduledToday: false, weeklyHours: 0 });
      setShowModal(false);
    } finally { setSaving(false); }
  };

  const handleSave = async () => {
    if (!uid || !pid || !form.name.trim()) return;

    // ── Scheduling Manager swap guard ──────────────────────────────────────
    // Only one staff member can be the scheduling manager at a time. If the
    // user is turning the toggle ON for this person and someone else already
    // holds the role, we show an in-app swap-confirm modal. The actual save
    // (and the swap write on the previous manager) happens when the user
    // confirms in that modal — see the modal JSX at the bottom of this file.
    if (form.isSchedulingManager) {
      const currentManager = staff.find(
        s => s.isSchedulingManager === true && s.id !== editMember?.id,
      );
      if (currentManager) {
        setSwapConfirm({
          currentManagerId: currentManager.id,
          currentManagerName: currentManager.name,
          newName: form.name.trim(),
        });
        return;
      }
    }

    await performSave();
  };

  // Called by the swap-confirm modal's "Confirm" button. Clears the previous
  // scheduling manager's flag, then runs the normal save.
  const confirmSchedulingManagerSwap = async () => {
    if (!uid || !pid || !swapConfirm) return;
    setSaving(true);
    try {
      await updateStaffMember(uid, pid, swapConfirm.currentManagerId, { isSchedulingManager: false });
    } catch (err) {
      console.error('[staff] failed to clear previous scheduling manager:', err);
      setSaving(false);
      setSwapConfirm(null);
      return;
    }
    setSwapConfirm(null);
    // performSave sets saving=true again itself; release first so it can manage
    // the flag cleanly. (setSaving is synchronous in React 18 batched updates.)
    setSaving(false);
    await performSave();
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
      <div style={{ padding: '16px 28px 28px', maxWidth: '1200px', margin: '0 auto' }}>

        {/* ── Tab bar + actions row ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '8px' }}>
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

          {/* Right-side actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
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
          <div className="animate-in" style={{ maxWidth: '800px', margin: '0 auto' }}>

            {/* ── Notification panel ── */}
            {showNotifPanel && (
              <div style={{ marginBottom: '16px', padding: '18px 20px', background: '#ffffff', borderRadius: '2rem', boxShadow: '0 4px 24px -2px rgba(27,28,25,0.04)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: '#1b1c19', fontFamily: 'Inter, sans-serif' }}>{t('notificationsTitle', lang)}</span>
                  {unreadCount > 0 && (
                    <button onClick={() => { if (uid && pid) markAllNotificationsRead(uid, pid).catch(err => console.error('[staff] mark all read failed:', err)); }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', color: '#006565', fontWeight: 600, padding: 0 }}>
                      {t('markAllRead', lang)}
                    </button>
                  )}
                </div>
                {notifications.length === 0 ? (
                  <p style={{ fontSize: '13px', color: '#757684', margin: 0 }}>{t('noNotifications', lang)}</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {notifications.slice(0, 10).map(n => (
                      <div key={n.id} onClick={() => { if (!n.read && uid && pid) markNotificationRead(uid, pid, n.id).catch(err => console.error('[staff] mark read failed:', err)); }} style={{
                        display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 14px',
                        background: n.read ? 'transparent' : 'rgba(0,101,101,0.04)',
                        border: `1px solid ${n.read ? '#eae8e3' : 'rgba(0,101,101,0.15)'}`,
                        borderRadius: '1rem', cursor: n.read ? 'default' : 'pointer',
                      }}>
                        <span className="material-symbols-outlined" style={{ fontSize: '16px', flexShrink: 0, marginTop: '1px', color: n.type === 'decline' || n.type === 'no_replacement' ? '#ba1a1a' : n.type === 'all_confirmed' ? '#006565' : '#364262' }}>
                          {n.type === 'all_confirmed' ? 'check_circle' : n.type === 'decline' ? 'cancel' : n.type === 'no_replacement' ? 'warning' : 'groups'}
                        </span>
                        <p style={{ margin: 0, fontSize: '13px', color: '#454652', lineHeight: 1.4, flex: 1 }}>{n.message}</p>
                        {!n.read && <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#006565', flexShrink: 0, marginTop: '5px' }} />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ════════════════════════════════════════════════════════════
                HERO — Exact Stitch "Concierge Operations" layout
                Big conversational headline + two action buttons
               ════════════════════════════════════════════════════════════ */}
            <section style={{ marginBottom: '48px' }}>
              <h2 style={{
                fontFamily: 'Inter, sans-serif', fontWeight: 600,
                fontSize: '3rem', lineHeight: 1.15, letterSpacing: '-0.02em',
                color: '#1b1c19', margin: 0,
              }}>
                {(() => {
                  const confirmedCount = confirmations.filter(c => c.status === 'confirmed').length;
                  if (sent && confirmedCount > 0) {
                    return lang === 'es'
                      ? `${confirmedCount} miembro${confirmedCount > 1 ? 's' : ''} confirmado${confirmedCount > 1 ? 's' : ''} para ${formatDisplayDate(shiftDate, lang)}.`
                      : `${confirmedCount} crew member${confirmedCount > 1 ? 's' : ''} confirmed for ${formatDisplayDate(shiftDate, lang)}.`;
                  }
                  if (gmRec.picks.length > 0 && !gmAccepted) {
                    return lang === 'es'
                      ? `He preparado el horario de ${formatDisplayDate(shiftDate, lang)} para ti.`
                      : `I've drafted ${formatDisplayDate(shiftDate, lang)}'s schedule for you.`;
                  }
                  return lang === 'es'
                    ? `Planifica el equipo para ${formatDisplayDate(shiftDate, lang)}.`
                    : `Build your crew for ${formatDisplayDate(shiftDate, lang)}.`;
                })()}
              </h2>

              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '24px', flexWrap: 'wrap' }}>
                {/* Review & Publish — accept GM picks */}
                {!sent && gmRec.picks.length > 0 && !gmAccepted && (
                  <button onClick={acceptGMPicks} style={{
                    padding: '16px 32px', background: '#364262', color: '#ffffff',
                    border: 'none', borderRadius: '1rem', fontWeight: 500, fontSize: '18px',
                    cursor: 'pointer', fontFamily: 'Inter, sans-serif',
                    transition: 'transform 0.15s',
                  }}>
                    {lang === 'es' ? 'Revisar y Publicar' : 'Review & Publish'}
                  </button>
                )}
                {/* Ask AI to Optimize — skip to manual */}
                {!sent && gmRec.picks.length > 0 && !gmAccepted && (
                  <button onClick={() => setGmAccepted(true)} style={{
                    padding: '16px 24px', background: '#006565', color: '#ffffff',
                    border: 'none', borderRadius: '1rem', fontWeight: 500, fontSize: '18px',
                    cursor: 'pointer', fontFamily: 'Inter, sans-serif',
                    display: 'flex', alignItems: 'center', gap: '8px',
                    transition: 'transform 0.15s',
                  }}>
                    <span className="material-symbols-outlined" style={{ fontSize: '20px', fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                    {lang === 'es' ? 'Personalizar Equipo' : 'Ask AI to Optimize'}
                  </button>
                )}
                {/* Send confirmations when crew selected */}
                {selected.length > 0 && (
                  <button onClick={handleSend} disabled={sending} style={{
                    padding: '16px 32px',
                    background: sending ? 'rgba(54,66,98,0.4)' : '#364262',
                    color: '#ffffff', border: 'none', borderRadius: '1rem',
                    fontWeight: 500, fontSize: '18px',
                    cursor: sending ? 'not-allowed' : 'pointer', fontFamily: 'Inter, sans-serif',
                    display: 'flex', alignItems: 'center', gap: '10px',
                  }}>
                    <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>send</span>
                    {sending ? t('sendingLabel', lang) : `${t('sendConfirmations', lang)} (${selected.length})`}
                  </button>
                )}
              </div>
            </section>

            {/* ── Date navigation ── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
              <button onClick={() => { setShiftDate(d => addDays(d, -1)); setSent(false); setSelected([]); setGmAccepted(false); }} style={{
                background: 'none', border: '1px solid #c5c5d4', borderRadius: '50%',
                width: '36px', height: '36px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span className="material-symbols-outlined" style={{ fontSize: '18px', color: '#454652' }}>chevron_left</span>
              </button>
              <button onClick={() => { setShiftDate(d => addDays(d, 1)); setSent(false); setSelected([]); setGmAccepted(false); }} style={{
                background: 'none', border: '1px solid #c5c5d4', borderRadius: '50%',
                width: '36px', height: '36px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span className="material-symbols-outlined" style={{ fontSize: '18px', color: '#454652' }}>chevron_right</span>
              </button>
            </div>

            {/* ── Sent banner ── */}
            {sent && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 20px',
                background: 'rgba(0,101,101,0.06)', border: '1px solid rgba(0,101,101,0.2)',
                borderRadius: '1rem', marginBottom: '20px',
              }}>
                <span className="material-symbols-outlined" style={{ fontSize: '20px', color: '#006565' }}>check_circle</span>
                <span style={{ fontSize: '14px', fontWeight: 600, color: '#006565', fontFamily: 'Inter, sans-serif' }}>{t('confirmationsSent', lang)}</span>
              </div>
            )}

            {/* ════════════════════════════════════════════════════════════
                WHO'S WORKING TODAY — Exact Stitch layout
                Section header + date | 2-col grid of staff cards
               ════════════════════════════════════════════════════════════ */}
            <section style={{ marginBottom: '32px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '16px' }}>
                <h3 style={{ margin: 0, fontFamily: 'Inter, sans-serif', fontWeight: 500, fontSize: '1.5rem', color: '#1b1c19' }}>
                  {lang === 'es' ? 'Quién Trabaja Hoy' : "Who's Working Today"}
                </h3>
                <span style={{ fontSize: '14px', color: '#454652', fontWeight: 500, fontFamily: 'Inter, sans-serif' }}>
                  {formatDisplayDate(shiftDate, lang)}
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
                {/* Confirmed / pending crew cards */}
                {confirmations.map(conf => {
                  const confMember = staff.find(s => s.id === conf.staffId);
                  const dept = confMember ? (DEPT_LABELS[confMember.department ?? 'housekeeping']?.[lang] ?? confMember.department) : '';
                  return (
                    <div key={conf.id} style={{
                      background: '#ffffff', padding: '24px',
                      borderRadius: '2rem',
                      boxShadow: '0 4px 24px -2px rgba(27,28,25,0.04)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      transition: 'background 0.2s',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                        <div style={{
                          width: '48px', height: '48px', borderRadius: '50%',
                          background: '#364262', color: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontWeight: 700, fontSize: '16px', fontFamily: 'Inter, sans-serif',
                          flexShrink: 0,
                        }}>
                          {initials(conf.staffName)}
                        </div>
                        <div>
                          <p style={{ margin: 0, fontWeight: 600, fontSize: '15px', color: '#1b1c19', fontFamily: 'Inter, sans-serif' }}>
                            {conf.staffName}
                          </p>
                          <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#454652', fontFamily: 'Inter, sans-serif' }}>
                            {dept}{dept ? ' • ' : ''}
                            <span style={{ color: conf.status === 'confirmed' ? '#006565' : conf.status === 'declined' ? '#ba1a1a' : '#454652' }}>
                              {t(conf.status === 'pending' ? 'statusPending' : conf.status === 'confirmed' ? 'statusConfirmed' : conf.status === 'declined' ? 'statusDeclined' : 'statusNoResponse', lang)}
                            </span>
                          </p>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <button style={{
                          width: '40px', height: '40px', borderRadius: '50%',
                          border: '1px solid #c5c5d4', background: 'none',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', transition: 'all 0.2s',
                        }}>
                          <span className="material-symbols-outlined" style={{ fontSize: '18px', color: '#454652' }}>remove</span>
                        </button>
                        <button style={{
                          width: '40px', height: '40px', borderRadius: '50%',
                          border: '1px solid #c5c5d4', background: 'none',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', transition: 'all 0.2s',
                        }}>
                          <span className="material-symbols-outlined" style={{ fontSize: '18px', color: '#454652' }}>add</span>
                        </button>
                      </div>
                    </div>
                  );
                })}

                {/* Staff scheduled today (if no confirmations sent yet) */}
                {confirmations.length === 0 && staff.filter(s => s.scheduledToday).map(member => {
                  const dept = DEPT_LABELS[member.department ?? 'housekeeping']?.[lang] ?? member.department;
                  return (
                    <div key={member.id} style={{
                      background: '#ffffff', padding: '24px',
                      borderRadius: '2rem',
                      boxShadow: '0 4px 24px -2px rgba(27,28,25,0.04)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      transition: 'background 0.2s',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                        <div style={{
                          width: '48px', height: '48px', borderRadius: '50%',
                          background: '#364262', color: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontWeight: 700, fontSize: '16px', fontFamily: 'Inter, sans-serif',
                          flexShrink: 0,
                        }}>
                          {initials(member.name)}
                        </div>
                        <div>
                          <p style={{ margin: 0, fontWeight: 600, fontSize: '15px', color: '#1b1c19', fontFamily: 'Inter, sans-serif' }}>
                            {member.name}
                          </p>
                          <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#454652', fontFamily: 'Inter, sans-serif' }}>
                            {dept} • {member.weeklyHours ?? 0}h/{member.maxWeeklyHours ?? 40}h
                          </p>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <button onClick={() => toggleScheduledToday(member)} style={{
                          width: '40px', height: '40px', borderRadius: '50%',
                          border: '1px solid #c5c5d4', background: 'none',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', transition: 'all 0.2s',
                        }}>
                          <span className="material-symbols-outlined" style={{ fontSize: '18px', color: '#454652' }}>remove</span>
                        </button>
                        <button onClick={() => openEdit(member)} style={{
                          width: '40px', height: '40px', borderRadius: '50%',
                          border: '1px solid #c5c5d4', background: 'none',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', transition: 'all 0.2s',
                        }}>
                          <span className="material-symbols-outlined" style={{ fontSize: '18px', color: '#454652' }}>add</span>
                        </button>
                      </div>
                    </div>
                  );
                })}

                {/* GM recommendation picks (when not yet accepted) */}
                {confirmations.length === 0 && staff.filter(s => s.scheduledToday).length === 0 && !gmAccepted && gmRec.picks.map(({ member, reason }) => {
                  const dept = DEPT_LABELS[member.department ?? 'housekeeping']?.[lang] ?? member.department;
                  return (
                    <div key={member.id} style={{
                      background: '#ffffff', padding: '24px',
                      borderRadius: '2rem',
                      boxShadow: '0 4px 24px -2px rgba(27,28,25,0.04)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      transition: 'background 0.2s',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                        <div style={{
                          width: '48px', height: '48px', borderRadius: '50%',
                          background: '#364262', color: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontWeight: 700, fontSize: '16px', fontFamily: 'Inter, sans-serif',
                          flexShrink: 0,
                        }}>
                          {initials(member.name)}
                        </div>
                        <div>
                          <p style={{ margin: 0, fontWeight: 600, fontSize: '15px', color: '#1b1c19', fontFamily: 'Inter, sans-serif' }}>
                            {member.name}
                          </p>
                          <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#454652', fontFamily: 'Inter, sans-serif' }}>
                            {dept} • {reason}
                          </p>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <button style={{
                          width: '40px', height: '40px', borderRadius: '50%',
                          border: '1px solid #c5c5d4', background: 'none',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', transition: 'all 0.2s',
                        }}>
                          <span className="material-symbols-outlined" style={{ fontSize: '18px', color: '#454652' }}>remove</span>
                        </button>
                        <button style={{
                          width: '40px', height: '40px', borderRadius: '50%',
                          border: '1px solid #c5c5d4', background: 'none',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', transition: 'all 0.2s',
                        }}>
                          <span className="material-symbols-outlined" style={{ fontSize: '18px', color: '#454652' }}>add</span>
                        </button>
                      </div>
                    </div>
                  );
                })}

                {/* Selected crew (manual mode) */}
                {gmAccepted && selected.map(member => {
                  const dept = DEPT_LABELS[member.department ?? 'housekeeping']?.[lang] ?? member.department;
                  return (
                    <div key={member.id} style={{
                      background: '#ffffff', padding: '24px',
                      borderRadius: '2rem',
                      boxShadow: '0 4px 24px -2px rgba(27,28,25,0.04)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      transition: 'background 0.2s',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                        <div style={{
                          width: '48px', height: '48px', borderRadius: '50%',
                          background: '#006565', color: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontWeight: 700, fontSize: '16px', fontFamily: 'Inter, sans-serif',
                          flexShrink: 0,
                        }}>
                          {initials(member.name)}
                        </div>
                        <div>
                          <p style={{ margin: 0, fontWeight: 600, fontSize: '15px', color: '#1b1c19', fontFamily: 'Inter, sans-serif' }}>
                            {member.name}
                          </p>
                          <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#454652', fontFamily: 'Inter, sans-serif' }}>
                            {dept} • {member.weeklyHours ?? 0}h/{member.maxWeeklyHours ?? 40}h
                          </p>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <button onClick={() => toggleSelected(member)} style={{
                          width: '40px', height: '40px', borderRadius: '50%',
                          border: '1px solid #c5c5d4', background: 'none',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', transition: 'all 0.2s',
                        }}>
                          <span className="material-symbols-outlined" style={{ fontSize: '18px', color: '#454652' }}>remove</span>
                        </button>
                        <button onClick={() => openEdit(member)} style={{
                          width: '40px', height: '40px', borderRadius: '50%',
                          border: '1px solid #c5c5d4', background: 'none',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', transition: 'all 0.2s',
                        }}>
                          <span className="material-symbols-outlined" style={{ fontSize: '18px', color: '#454652' }}>add</span>
                        </button>
                      </div>
                    </div>
                  );
                })}

                {/* Add Team Member — dashed card (exact Stitch match) */}
                <div
                  onClick={openAdd}
                  style={{
                    background: '#ffffff', padding: '24px',
                    borderRadius: '2rem',
                    border: '2px dashed #c5c5d4',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px',
                    cursor: 'pointer', transition: 'background 0.2s',
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '22px', color: '#454652' }}>person_add</span>
                  <span style={{ fontWeight: 500, fontSize: '15px', color: '#454652', fontFamily: 'Inter, sans-serif' }}>
                    {lang === 'es' ? 'Agregar Miembro del Equipo' : 'Add Team Member'}
                  </span>
                </div>
              </div>
            </section>

            {/* ── Crew picker (manual mode, shown after skipping GM rec) ── */}
            {gmAccepted && !sent && (
              <section style={{ marginBottom: '32px' }}>
                <h3 style={{ margin: '0 0 16px', fontFamily: 'Inter, sans-serif', fontWeight: 500, fontSize: '1.25rem', color: '#1b1c19' }}>
                  {lang === 'es' ? 'Agregar al Equipo' : 'Add to Crew'}
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px' }}>
                  {staff
                    .filter(s => s.isActive !== false && !selected.some(x => x.id === s.id))
                    .sort((a, b) => {
                      const aE = isEligible(a, shiftDate);
                      const bE = isEligible(b, shiftDate);
                      if (aE !== bE) return aE ? -1 : 1;
                      return a.name.localeCompare(b.name);
                    })
                    .map(member => {
                      const eligible = isEligible(member, shiftDate) && !alreadyInPool.has(member.id);
                      const dept = DEPT_LABELS[member.department ?? 'housekeeping']?.[lang] ?? member.department;
                      const onVacation = member.vacationDates?.includes(shiftDate);
                      return (
                        <div key={member.id} onClick={() => eligible && toggleSelected(member)} style={{
                          background: '#ffffff', padding: '20px 24px',
                          borderRadius: '2rem',
                          boxShadow: '0 4px 24px -2px rgba(27,28,25,0.04)',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          opacity: eligible ? 1 : 0.4,
                          cursor: eligible ? 'pointer' : 'default',
                          transition: 'all 0.2s',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                            <div style={{
                              width: '48px', height: '48px', borderRadius: '50%',
                              background: '#eae8e3', color: '#454652',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontWeight: 700, fontSize: '16px', fontFamily: 'Inter, sans-serif',
                              flexShrink: 0,
                            }}>
                              {initials(member.name)}
                            </div>
                            <div>
                              <p style={{ margin: 0, fontWeight: 600, fontSize: '15px', color: '#1b1c19', fontFamily: 'Inter, sans-serif' }}>
                                {member.name}
                              </p>
                              <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#454652', fontFamily: 'Inter, sans-serif' }}>
                                {dept} • {onVacation ? t('onVacation', lang) : !member.phone ? t('noPhoneLabel', lang) : `${member.daysWorkedThisWeek ?? 0} ${t('daysWorkedLabel', lang)}`}
                              </p>
                            </div>
                          </div>
                          {eligible && (
                            <button style={{
                              width: '40px', height: '40px', borderRadius: '50%',
                              border: '1px solid #c5c5d4', background: 'none',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              cursor: 'pointer',
                            }}>
                              <span className="material-symbols-outlined" style={{ fontSize: '18px', color: '#454652' }}>add</span>
                            </button>
                          )}
                        </div>
                      );
                    })}
                </div>
              </section>
            )}

            {/* ════════════════════════════════════════════════════════════
                FOOTER STATS BAR — Exact Stitch match
                Fixed bottom bar with: coverage, labor cost, hours, alerts
               ════════════════════════════════════════════════════════════ */}
            <div style={{
              position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 40,
              background: 'rgba(255,255,255,0.8)', backdropFilter: 'blur(24px)',
              borderRadius: '2rem 2rem 0 0',
              boxShadow: '0 -12px 48px -8px rgba(27,28,25,0.08)',
              display: 'flex', justifyContent: 'space-around', alignItems: 'center',
              padding: '12px 24px', height: '80px',
              fontFamily: "'JetBrains Mono', monospace", fontSize: '11px',
              textTransform: 'uppercase', letterSpacing: '0.1em', color: '#454652',
            }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', cursor: 'default' }}>
                <span className="material-symbols-outlined" style={{ fontSize: '20px', color: '#454652' }}>groups</span>
                <span>{lang === 'es' ? 'Cobertura' : 'Coverage'} {(() => {
                  const scheduled = confirmations.filter(c => c.status !== 'declined').length || staff.filter(s => s.scheduledToday).length;
                  return scheduled >= gmRec.neededCount ? (lang === 'es' ? 'Completa' : 'Full') : `${scheduled}/${gmRec.neededCount}`;
                })()}</span>
              </div>
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
                background: 'rgba(0,101,101,0.1)', color: '#004b4b',
                borderRadius: '9999px', padding: '8px 20px',
              }}>
                <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>payments</span>
                <span>{lang === 'es' ? 'Costo' : 'Labor Cost'} ${(() => {
                  const activeStaff = confirmations.length > 0
                    ? confirmations.filter(c => c.status !== 'declined').length
                    : staff.filter(s => s.scheduledToday).length;
                  const avgWage = staff.length > 0
                    ? staff.reduce((sum, s) => sum + (s.hourlyWage ?? 12), 0) / staff.length
                    : 12;
                  return (activeStaff * avgWage * 8 / 1000).toFixed(1);
                })()}k</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', cursor: 'default' }}>
                <span className="material-symbols-outlined" style={{ fontSize: '20px', color: '#454652' }}>schedule</span>
                <span>{staff.filter(s => s.weeklyHours >= s.maxWeeklyHours - 4).length} {lang === 'es' ? 'Horas Extra' : 'Near OT'}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', cursor: 'default' }}>
                <span className="material-symbols-outlined" style={{ fontSize: '20px', color: '#454652' }}>warning</span>
                <span>{lang === 'es' ? 'Alertas' : 'Alerts'} {unreadCount}</span>
              </div>
            </div>

            {/* Spacer for fixed footer */}
            <div style={{ height: '100px' }} />
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

                {[
                  { label: t('isActiveLabel', lang), field: 'isActive' as const },
                  { label: t('seniorStaff', lang), field: 'isSenior' as const },
                  {
                    label: lang === 'es' ? 'Responsable de horarios' : 'Scheduling Manager',
                    field: 'isSchedulingManager' as const,
                    hint: lang === 'es'
                      ? 'Única persona que recibe los mensajes cuando un empleado no responde después de 75 minutos. Solo una persona a la vez.'
                      : 'The only person who gets the alert text when a housekeeper does not reply after 75 minutes. Only one person at a time.',
                  },
                ].map(({ label, field, hint }) => (
                  <div key={field} style={{ padding: '12px 16px', background: '#eae8e3', borderRadius: '16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '14px', color: '#1b1c19', fontFamily: 'Inter, sans-serif' }}>{label}</span>
                      <label className="toggle" style={{ margin: 0 }}>
                        <input type="checkbox" checked={form[field] as boolean} onChange={e => setForm(f => ({ ...f, [field]: e.target.checked }))} />
                        <span className="toggle-track" />
                        <span className="toggle-thumb" />
                      </label>
                    </div>
                    {hint && (
                      <p style={{ fontSize: '11px', color: '#757684', margin: '6px 0 0', fontFamily: 'Inter, sans-serif', lineHeight: 1.4 }}>
                        {hint}
                      </p>
                    )}
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

        {/* ════════════════════════════════════════════════════════════════
            SCHEDULING MANAGER SWAP CONFIRMATION
            In-app modal (not window.confirm). Fires when the user tries to
            turn on Scheduling Manager for someone while another person already
            has it. Cancel → close modal, toggle stays on so user can try again
            or untoggle manually. Confirm → flip the old manager's flag off,
            then run the normal save.
            ════════════════════════════════════════════════════════════════ */}
        {swapConfirm && (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 1100,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(27,28,25,0.5)', backdropFilter: 'blur(8px)',
          }} onClick={() => { if (!saving) setSwapConfirm(null); }}>
            <div onClick={e => e.stopPropagation()} style={{
              background: '#fbf9f4', borderRadius: '24px',
              width: '90%', maxWidth: '440px',
              padding: '28px', boxShadow: '0 24px 48px rgba(0,0,0,0.2)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                <div style={{
                  width: '40px', height: '40px', borderRadius: '50%',
                  background: 'rgba(245,158,11,0.15)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '22px', color: '#b45309' }}>
                    swap_horiz
                  </span>
                </div>
                <h2 style={{ margin: 0, fontFamily: 'Inter, sans-serif', fontWeight: 700, fontSize: '18px', color: '#1b1c19' }}>
                  {lang === 'es' ? '¿Cambiar responsable de horarios?' : 'Switch Scheduling Manager?'}
                </h2>
              </div>

              <p style={{
                margin: '0 0 20px', fontFamily: 'Inter, sans-serif', fontSize: '14px',
                color: '#454652', lineHeight: 1.5,
              }}>
                {lang === 'es'
                  ? <>
                      <strong>{swapConfirm.currentManagerName}</strong> es actualmente el responsable de horarios y recibe los mensajes de confirmación.
                      Si continúas, <strong>{swapConfirm.newName}</strong> tomará ese rol y <strong>{swapConfirm.currentManagerName}</strong> dejará de recibirlos.
                    </>
                  : <>
                      <strong>{swapConfirm.currentManagerName}</strong> is currently the Scheduling Manager and receives the confirmation alerts.
                      If you continue, <strong>{swapConfirm.newName}</strong> will take that role and <strong>{swapConfirm.currentManagerName}</strong> will stop receiving them.
                    </>}
              </p>

              <div style={{ display: 'flex', gap: '12px' }}>
                <button
                  onClick={() => setSwapConfirm(null)}
                  disabled={saving}
                  style={{
                    flex: 1, padding: '14px', border: '1px solid #d5d2ca', background: 'transparent',
                    color: '#454652', borderRadius: '9999px', fontWeight: 600, fontSize: '14px',
                    cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'Inter, sans-serif',
                  }}
                >
                  {t('cancel', lang)}
                </button>
                <button
                  onClick={confirmSchedulingManagerSwap}
                  disabled={saving}
                  style={{
                    flex: 1, padding: '14px',
                    background: saving ? 'rgba(54,66,98,0.4)' : '#364262',
                    color: saving ? 'rgba(255,255,255,0.5)' : '#FFFFFF',
                    border: 'none', borderRadius: '9999px', fontWeight: 600, fontSize: '14px',
                    cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'Inter, sans-serif',
                  }}
                >
                  {saving
                    ? t('savingDots', lang)
                    : lang === 'es' ? 'Sí, cambiar' : 'Yes, switch'}
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </AppLayout>
  );
}
