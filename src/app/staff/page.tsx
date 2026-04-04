'use client';

import React, { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { addStaffMember, updateStaffMember, deleteStaffMember } from '@/lib/firestore';
import { Modal } from '@/components/ui/Modal';
import type { StaffMember, StaffDepartment } from '@/types';
import { Users, Plus, Pencil, Trash2, Star, AlertTriangle, Clock, ChevronLeft } from 'lucide-react';

// ─── Department config ────────────────────────────────────────────────────────

const DEPARTMENTS: { key: StaffDepartment; label: string; color: string; bg: string; border: string }[] = [
  { key: 'housekeeping', label: 'Housekeeping', color: 'var(--amber)',  bg: 'var(--amber-dim)',              border: 'var(--amber-border)'           },
  { key: 'front_desk',   label: 'Front Desk',   color: '#818cf8',       bg: 'rgba(99,102,241,0.12)',         border: 'rgba(99,102,241,0.25)'         },
  { key: 'maintenance',  label: 'Maintenance',  color: '#ef4444',       bg: 'rgba(239,68,68,0.10)',          border: 'rgba(239,68,68,0.20)'          },
  { key: 'other',        label: 'Other',        color: 'var(--text-muted)', bg: 'rgba(100,116,139,0.10)', border: 'var(--border)'                  },
];

function deptConfig(dept?: StaffDepartment) {
  return DEPARTMENTS.find(d => d.key === (dept ?? 'housekeeping')) ?? DEPARTMENTS[0];
}

// ─── Form types ───────────────────────────────────────────────────────────────

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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function StaffPage() {
  const { user } = useAuth();
  const { activePropertyId, activeProperty, staff } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  const [deptFilter, setDeptFilter]   = useState<StaffDepartment | 'all'>('all');
  const [showModal, setShowModal]     = useState(false);
  const [editMember, setEditMember]   = useState<StaffMember | null>(null);
  const [form, setForm]               = useState<StaffFormData>(EMPTY_FORM);
  const [saving, setSaving]           = useState(false);

  // ── Derived data ────────────────────────────────────────────────────────────

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: staff.length };
    for (const s of staff) {
      const d = s.department ?? 'housekeeping';
      map[d] = (map[d] ?? 0) + 1;
    }
    return map;
  }, [staff]);

  const displayStaff = useMemo(() => {
    const filtered = deptFilter === 'all'
      ? staff
      : staff.filter(s => (s.department ?? 'housekeeping') === deptFilter);
    return [...filtered].sort((a, b) => {
      if (a.scheduledToday !== b.scheduledToday) return a.scheduledToday ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [staff, deptFilter]);

  const totalStaff     = staff.length;
  const scheduledToday = staff.filter(s => s.scheduledToday).length;
  const nearOvertime   = staff.filter(s => s.weeklyHours >= s.maxWeeklyHours - 8).length;
  const hasOvertimeWarning = staff.some(s => s.weeklyHours >= s.maxWeeklyHours - 4);

  // ── Modal helpers ───────────────────────────────────────────────────────────

  const openAdd = () => {
    setEditMember(null);
    setForm({ ...EMPTY_FORM, department: deptFilter !== 'all' ? deptFilter : 'housekeeping' });
    setShowModal(true);
  };

  const openEdit = (member: StaffMember) => {
    setEditMember(member);
    setForm({
      name: member.name,
      phone: member.phone,
      language: member.language,
      department: member.department ?? 'housekeeping',
      isSenior: member.isSenior,
      hourlyWage: member.hourlyWage,
      maxWeeklyHours: member.maxWeeklyHours,
      maxDaysPerWeek: member.maxDaysPerWeek ?? 5,
      vacationDates: (member.vacationDates ?? []).join('\n'),
      isActive: member.isActive ?? true,
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!user || !activePropertyId || !form.name.trim()) return;
    setSaving(true);
    try {
      const vacationDates = form.vacationDates
        .split('\n').map(s => s.trim())
        .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));
      const data = {
        name: form.name.trim(),
        ...(form.phone && { phone: form.phone }),
        language: form.language,
        department: form.department,
        isSenior: form.isSenior,
        ...(form.hourlyWage !== undefined && { hourlyWage: form.hourlyWage }),
        maxWeeklyHours: form.maxWeeklyHours,
        maxDaysPerWeek: form.maxDaysPerWeek,
        vacationDates,
        isActive: form.isActive,
      };
      if (editMember) {
        await updateStaffMember(user.uid, activePropertyId, editMember.id, data);
      } else {
        await addStaffMember(user.uid, activePropertyId, { ...data, scheduledToday: false, weeklyHours: 0 });
      }
      setShowModal(false);
    } finally {
      setSaving(false);
    }
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

  // ── Filter tabs ─────────────────────────────────────────────────────────────

  const filterTabs: { key: StaffDepartment | 'all'; label: string }[] = [
    { key: 'all', label: 'All' },
    ...DEPARTMENTS,
  ];

  return (
    <AppLayout>
      <div style={{ padding: '16px', maxWidth: '900px', margin: '0 auto' }}>

        {/* Back + Header */}
        <div style={{ marginBottom: '20px' }}>
          <button
            onClick={() => router.back()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              background: 'transparent', border: 'none',
              color: 'var(--text-muted)', fontSize: '13px',
              cursor: 'pointer', padding: '0 0 10px',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <ChevronLeft size={14} />
            {t('settings', lang)}
          </button>

          {activeProperty && (
            <p style={{ color: 'var(--text-muted)', fontSize: '11px', fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '4px' }}>
              {activeProperty.name}
            </p>
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h1 style={{
              fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '24px',
              letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: '10px', margin: 0,
            }}>
              <Users size={20} color="var(--navy)" />
              {t('staffDirectory', lang)}
            </h1>
            <button
              onClick={openAdd}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '8px 14px', background: 'var(--navy-light)', color: '#FFFFFF',
                border: 'none', borderRadius: 'var(--radius-md)',
                fontWeight: 600, fontSize: '13px', cursor: 'pointer', fontFamily: 'var(--font-sans)',
              }}
            >
              <Plus size={14} />
              {t('addStaff', lang)}
            </button>
          </div>
        </div>

        {/* Stats */}
        {totalStaff > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '16px' }}>
            {[
              { label: t('totalStaffLabel', lang), value: totalStaff,     color: 'var(--amber)' },
              { label: t('scheduledTodayCount', lang), value: scheduledToday, color: 'var(--green)' },
              { label: t('nearOvertime', lang),   value: nearOvertime,   color: nearOvertime > 0 ? 'var(--amber)' : 'var(--text-muted)' },
            ].map(({ label, value, color }) => (
              <div key={label} className="card" style={{ padding: '14px 12px', textAlign: 'center' }}>
                <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '6px' }}>{label}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '28px', fontWeight: 700, color }}>{value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Department filter tabs */}
        <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '4px', marginBottom: '16px' }}>
          {filterTabs.map(tab => {
            const isActive = deptFilter === tab.key;
            const count    = counts[tab.key] ?? 0;
            if (tab.key !== 'all' && count === 0) return null;
            return (
              <button
                key={tab.key}
                onClick={() => setDeptFilter(tab.key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '5px',
                  padding: '7px 13px', borderRadius: '20px', whiteSpace: 'nowrap',
                  border: isActive ? '1px solid var(--amber-border)' : '1px solid var(--border)',
                  background: isActive ? 'var(--amber-dim)' : 'var(--bg-card)',
                  color: isActive ? 'var(--amber)' : 'var(--text-muted)',
                  fontSize: '13px', fontWeight: isActive ? 600 : 400,
                  cursor: 'pointer', fontFamily: 'var(--font-sans)', flexShrink: 0,
                }}
              >
                {tab.label}
                <span style={{
                  fontSize: '11px', fontWeight: 700,
                  background: isActive ? 'rgba(212,144,64,0.2)' : 'rgba(0,0,0,0.05)',
                  borderRadius: '10px', padding: '1px 6px',
                }}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Overtime warning */}
        {hasOvertimeWarning && (
          <div className="animate-in" style={{
            display: 'flex', alignItems: 'flex-start', gap: '12px',
            padding: '14px',
            background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)',
            borderRadius: 'var(--radius-md)', marginBottom: '16px',
          }}>
            <AlertTriangle size={16} color="var(--amber)" style={{ flexShrink: 0, marginTop: '2px' }} />
            <div>
              <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--amber)', margin: 0 }}>{t('overtimeAlert', lang)}</p>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '4px 0 0' }}>{t('overtimeAlertDesc', lang)}</p>
            </div>
          </div>
        )}

        {/* Staff cards */}
        {displayStaff.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 16px' }}>
            <Users size={40} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
            <p style={{ color: 'var(--text-muted)', fontSize: '14px', margin: 0 }}>
              No {deptFilter === 'all' ? '' : (DEPARTMENTS.find(d => d.key === deptFilter)?.label ?? '') + ' '}staff yet
            </p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
            {displayStaff.map((member, idx) => {
              const dept           = deptConfig(member.department);
              const utilizationPct = Math.round((member.weeklyHours / member.maxWeeklyHours) * 100);
              const atOrOverMax    = member.weeklyHours >= member.maxWeeklyHours;
              const nearMax        = member.weeklyHours >= member.maxWeeklyHours - 4;

              return (
                <div key={member.id} className="animate-in" style={{ animationDelay: `${idx * 50}ms` }}>
                  <div className="card" style={{
                    padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', height: '100%',
                    borderColor: nearMax ? 'rgba(251,191,36,0.3)' : 'var(--border)',
                    background: nearMax ? 'rgba(251,191,36,0.04)' : 'var(--bg-card)',
                    opacity: member.isActive === false ? 0.5 : 1,
                  }}>
                    {/* Avatar + name + badges */}
                    <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                      <div style={{
                        width: '38px', height: '38px', borderRadius: 'var(--radius-md)',
                        background: 'var(--navy)', color: '#FFFFFF',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontWeight: 700, fontSize: '14px', flexShrink: 0,
                      }}>
                        {initials(member.name)}
                      </div>
                      <div style={{ flex: 1 }}>
                        <p style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)', margin: '0 0 4px' }}>
                          {member.name}
                        </p>
                        <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                          {/* Department badge */}
                          <span style={{
                            fontSize: '10px', fontWeight: 600, letterSpacing: '0.03em',
                            padding: '2px 7px', borderRadius: '10px', textTransform: 'uppercase',
                            background: dept.bg, color: dept.color, border: `1px solid ${dept.border}`,
                          }}>
                            {dept.label}
                          </span>
                          {/* Language badge */}
                          <span className="chip" style={{
                            fontSize: '10px', padding: '2px 7px',
                            background: member.language === 'es' ? 'rgba(34,197,94,0.15)' : 'rgba(59,130,246,0.15)',
                            color: member.language === 'es' ? 'var(--green)' : 'var(--blue)',
                          }}>
                            {member.language === 'es' ? 'ES' : 'EN'}
                          </span>
                          {member.isSenior && (
                            <span className="chip" style={{
                              fontSize: '10px', padding: '2px 7px',
                              background: 'rgba(251,191,36,0.15)', color: 'var(--amber)',
                              display: 'flex', alignItems: 'center', gap: '3px',
                            }}>
                              <Star size={9} /> {t('senior', lang)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Hours & progress bar */}
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                        <span>{member.weeklyHours}h / {member.maxWeeklyHours}h</span>
                        <span style={{ color: atOrOverMax ? 'var(--red)' : nearMax ? 'var(--amber)' : 'var(--text-muted)' }}>
                          {Math.max(0, member.maxWeeklyHours - member.weeklyHours)}{t('hoursLeftLabel', lang)}
                        </span>
                      </div>
                      <div style={{ height: '4px', background: 'rgba(0,0,0,0.05)', borderRadius: '2px', overflow: 'hidden' }}>
                        <div style={{
                          width: `${Math.min(utilizationPct, 100)}%`, height: '100%', borderRadius: '2px',
                          background: utilizationPct > 100 ? 'var(--red)' : utilizationPct > 90 ? 'var(--amber)' : 'var(--green)',
                        }} />
                      </div>
                    </div>

                    {/* Scheduled today toggle */}
                    <div
                      onClick={() => toggleScheduledToday(member)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        padding: '10px',
                        background: member.scheduledToday ? 'rgba(34,197,94,0.08)' : 'rgba(0,0,0,0.03)',
                        border: '1px solid ' + (member.scheduledToday ? 'rgba(34,197,94,0.2)' : 'var(--border)'),
                        borderRadius: 'var(--radius-md)', cursor: 'pointer',
                      }}
                    >
                      <Clock size={14} color={member.scheduledToday ? 'var(--green)' : 'var(--text-muted)'} />
                      <span style={{ flex: 1, fontSize: '13px', fontWeight: 500, color: member.scheduledToday ? 'var(--green)' : 'var(--text-secondary)' }}>
                        {member.scheduledToday ? t('scheduledTodayStatus', lang) : t('notScheduled', lang)}
                      </span>
                    </div>

                    {/* Edit / Delete */}
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        onClick={() => openEdit(member)}
                        style={{
                          flex: 1, padding: '8px 12px',
                          background: 'rgba(0,0,0,0.05)', border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-md)', color: 'var(--text-primary)',
                          fontWeight: 500, fontSize: '13px', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                          fontFamily: 'var(--font-sans)',
                        }}
                      >
                        <Pencil size={12} /> {t('edit', lang)}
                      </button>
                      <button
                        onClick={() => handleDelete(member)}
                        style={{
                          padding: '8px 12px',
                          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                          borderRadius: 'var(--radius-md)', color: 'var(--red)',
                          fontWeight: 500, fontSize: '13px', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontFamily: 'var(--font-sans)',
                        }}
                      >
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
        <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editMember ? `${t('editStaff', lang)} ${editMember.name}` : t('addStaffMember', lang)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

            {/* Name */}
            <div>
              <label className="label">{t('nameRequired', lang)}</label>
              <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="input" placeholder="Maria Garcia" autoFocus />
            </div>

            {/* Department */}
            <div>
              <label className="label">{t('department', lang)}</label>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {DEPARTMENTS.map(d => (
                  <button key={d.key} onClick={() => setForm(f => ({ ...f, department: d.key }))} style={{
                    padding: '7px 12px', borderRadius: 'var(--radius-sm)',
                    border: `1px solid ${form.department === d.key ? d.border : 'var(--border)'}`,
                    background: form.department === d.key ? d.bg : 'transparent',
                    color: form.department === d.key ? d.color : 'var(--text-muted)',
                    fontSize: '13px', fontWeight: form.department === d.key ? 600 : 400,
                    cursor: 'pointer', fontFamily: 'var(--font-sans)',
                  }}>
                    {d.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Phone */}
            <div>
              <label className="label">{t('phoneOptional', lang)}</label>
              <input type="tel" value={form.phone ?? ''} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                className="input" placeholder="(409) 555-1234" />
            </div>

            {/* Language */}
            <div>
              <label className="label">{t('language', lang)}</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                {(['en', 'es'] as const).map(l => (
                  <button key={l} onClick={() => setForm(f => ({ ...f, language: l }))} style={{
                    flex: 1, padding: '10px',
                    border: `1px solid ${form.language === l ? 'var(--amber)' : 'var(--border)'}`,
                    background: form.language === l ? 'rgba(251,191,36,0.1)' : 'transparent',
                    color: form.language === l ? 'var(--amber)' : 'var(--text-secondary)',
                    borderRadius: 'var(--radius-md)', fontWeight: 500, cursor: 'pointer',
                    fontFamily: 'var(--font-sans)', fontSize: '13px',
                  }}>
                    {l === 'en' ? 'English' : 'Español'}
                  </button>
                ))}
              </div>
            </div>

            {/* Hourly wage */}
            <div>
              <label className="label">{t('hourlyWageOptional', lang)}</label>
              <input type="number" value={form.hourlyWage ?? ''} step="0.50" min="0"
                onChange={e => setForm(f => ({ ...f, hourlyWage: e.target.value ? parseFloat(e.target.value) : undefined }))}
                className="input" placeholder="15.00" />
            </div>

            {/* Max hours / days */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div>
                <label className="label">{t('maxWeeklyHoursLabel', lang)}</label>
                <input type="number" value={form.maxWeeklyHours} min="1"
                  onChange={e => setForm(f => ({ ...f, maxWeeklyHours: parseInt(e.target.value) || 40 }))}
                  className="input" />
              </div>
              <div>
                <label className="label">{t('maxDaysPerWeekLabel', lang)}</label>
                <input type="number" value={form.maxDaysPerWeek} min="1" max="7"
                  onChange={e => setForm(f => ({ ...f, maxDaysPerWeek: parseInt(e.target.value) || 5 }))}
                  className="input" />
              </div>
            </div>

            {/* Vacation dates */}
            <div>
              <label className="label">{t('vacationDatesLabel', lang)}</label>
              <textarea value={form.vacationDates}
                onChange={e => setForm(f => ({ ...f, vacationDates: e.target.value }))}
                className="input" placeholder={'2026-07-04\n2026-12-25'} rows={3}
                style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: '12px' }} />
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0 0' }}>{t('vacationDatesHelp', lang)}</p>
            </div>

            {/* Active + Senior toggles */}
            {[
              { label: t('isActiveLabel', lang), field: 'isActive' as const },
              { label: t('seniorStaff', lang),  field: 'isSenior' as const },
            ].map(({ label, field }) => (
              <div key={field} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 14px',
                background: 'rgba(0,0,0,0.03)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
              }}>
                <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{label}</span>
                <label className="toggle" style={{ margin: 0 }}>
                  <input type="checkbox" checked={form[field] as boolean}
                    onChange={e => setForm(f => ({ ...f, [field]: e.target.checked }))} />
                  <span className="toggle-track" />
                  <span className="toggle-thumb" />
                </label>
              </div>
            ))}

            {/* Save / Cancel */}
            <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
              <button onClick={() => setShowModal(false)} style={{
                flex: 1, padding: '10px', border: '1px solid var(--border)',
                background: 'transparent', color: 'var(--text-secondary)',
                borderRadius: 'var(--radius-md)', fontWeight: 500, fontSize: '13px',
                cursor: 'pointer', fontFamily: 'var(--font-sans)',
              }}>
                {t('cancel', lang)}
              </button>
              <button onClick={handleSave} disabled={saving || !form.name.trim()} style={{
                flex: 1, padding: '10px',
                background: saving || !form.name.trim() ? 'rgba(37,99,235,0.4)' : 'var(--navy-light)',
                color: saving || !form.name.trim() ? 'rgba(255,255,255,0.5)' : '#FFFFFF',
                border: 'none', borderRadius: 'var(--radius-md)',
                fontWeight: 600, fontSize: '13px',
                cursor: saving || !form.name.trim() ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-sans)',
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
