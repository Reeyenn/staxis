'use client';

import React, { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { addStaffMember, updateStaffMember, deleteStaffMember } from '@/lib/firestore';
import { generateId } from '@/lib/utils';
import type { StaffMember } from '@/types';
import { Modal } from '@/components/ui/Modal';
import { Users, Plus, Trash2, Star, AlertTriangle, Clock } from 'lucide-react';
import Link from 'next/link';

const EMPTY_STAFF: Omit<StaffMember, 'id'> = {
  name: '',
  phone: '',
  language: 'en',
  isSenior: false,
  scheduledToday: true,
  weeklyHours: 0,
  maxWeeklyHours: 40,
};

export default function StaffPage() {
  const { user } = useAuth();
  const { activePropertyId, staff, refreshStaff } = useProperty();
  const { lang } = useLang();

  const [showModal, setShowModal] = useState(false);
  const [editMember, setEditMember] = useState<StaffMember | null>(null);
  const [form, setForm] = useState<Omit<StaffMember, 'id'>>(EMPTY_STAFF);
  const [saving, setSaving] = useState(false);

  const openAdd = () => {
    setEditMember(null);
    setForm(EMPTY_STAFF);
    setShowModal(true);
  };

  const openEdit = (member: StaffMember) => {
    setEditMember(member);
    setForm({ ...member });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!user || !activePropertyId || !form.name.trim()) return;
    setSaving(true);
    try {
      if (editMember) {
        await updateStaffMember(user.uid, activePropertyId, editMember.id, form);
      } else {
        await addStaffMember(user.uid, activePropertyId, form);
      }
      await refreshStaff();
      setShowModal(false);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!user || !activePropertyId) return;
    await deleteStaffMember(user.uid, activePropertyId, id);
    await refreshStaff();
  };

  const handleToggle = async (member: StaffMember, field: 'scheduledToday' | 'isSenior') => {
    if (!user || !activePropertyId) return;
    await updateStaffMember(user.uid, activePropertyId, member.id, { [field]: !member[field] });
    await refreshStaff();
  };

  const handleHoursUpdate = async (member: StaffMember, hours: number) => {
    if (!user || !activePropertyId) return;
    await updateStaffMember(user.uid, activePropertyId, member.id, { weeklyHours: hours });
    await refreshStaff();
  };

  const shiftHours = 8; // default shift

  return (
    <AppLayout>
      <div style={{ padding: '16px', maxWidth: '600px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <Link href="/settings" style={{ color: 'var(--text-muted)', textDecoration: 'none', fontSize: '14px' }}>← Settings</Link>
            <span style={{ color: 'var(--text-muted)' }}>/</span>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '20px', letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Users size={18} color="var(--amber)" /> {t('staff', lang)}
            </h1>
          </div>
          <button onClick={openAdd} className="btn btn-primary btn-sm">
            <Plus size={14} /> {t('addStaff', lang)}
          </button>
        </div>

        {staff.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 16px' }}>
            <Users size={40} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
            <p style={{ color: 'var(--text-muted)', fontSize: '15px' }}>No staff added yet. Add your first housekeeper.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {staff.map(member => {
              const wouldOvertime = member.weeklyHours + shiftHours > member.maxWeeklyHours;
              const utilizationPct = Math.round((member.weeklyHours / member.maxWeeklyHours) * 100);
              const remaining = Math.max(0, member.maxWeeklyHours - member.weeklyHours);

              return (
                <div
                  key={member.id}
                  className="card"
                  style={{
                    padding: '16px',
                    borderColor: wouldOvertime ? 'rgba(251,191,36,0.3)' : 'var(--border)',
                    background: wouldOvertime ? 'rgba(251,191,36,0.04)' : undefined,
                    opacity: member.scheduledToday ? 1 : 0.6,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
                    {/* Name & badges */}
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                        <span style={{ fontWeight: 600, fontSize: '15px', color: 'var(--text-primary)' }}>{member.name}</span>
                        {member.isSenior && <span className="badge badge-vip"><Star size={10} /> Senior</span>}
                        <span className="badge badge-stayover">{member.language === 'es' ? 'ES' : 'EN'}</span>
                        {wouldOvertime && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(251,191,36,0.15)', color: '#fbbf24', fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '100px' }}>
                            <AlertTriangle size={10} /> Overtime
                          </span>
                        )}
                      </div>
                      {member.phone && (
                        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>{member.phone}</p>
                      )}

                      {/* Hours tracker */}
                      <div style={{ marginBottom: '8px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                          <span>{member.weeklyHours}h / {member.maxWeeklyHours}h this week</span>
                          <span style={{ color: remaining < 8 ? '#fbbf24' : 'var(--text-muted)' }}>{remaining}h remaining</span>
                        </div>
                        <div className="progress-track" style={{ height: '4px' }}>
                          <div
                            className="progress-fill"
                            style={{
                              width: `${Math.min(utilizationPct, 100)}%`,
                              background: utilizationPct > 90 ? '#ef4444' : utilizationPct > 75 ? '#fbbf24' : 'var(--amber)',
                            }}
                          />
                        </div>
                      </div>

                      {/* Weekly hours input */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Hours worked this week:</span>
                        <input
                          type="number"
                          value={member.weeklyHours}
                          min={0}
                          max={60}
                          onChange={e => handleHoursUpdate(member, Number(e.target.value))}
                          style={{
                            width: '60px',
                            padding: '4px 8px',
                            background: 'rgba(0,0,0,0.05)',
                            border: '1px solid var(--border)',
                            borderRadius: '6px',
                            color: 'var(--text-primary)',
                            fontSize: '13px',
                            fontFamily: 'var(--font-mono)',
                            textAlign: 'center',
                          }}
                        />
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>hrs</span>
                      </div>
                    </div>

                    {/* Toggles & actions */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' }}>
                      <button onClick={() => openEdit(member)} className="btn btn-secondary btn-sm">Edit</button>
                      <button onClick={() => handleDelete(member.id)} className="btn btn-danger btn-sm" style={{ padding: '6px 10px' }}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  {/* Toggle row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
                      <label className="toggle" style={{ margin: 0 }}>
                        <input type="checkbox" checked={member.scheduledToday} onChange={() => handleToggle(member, 'scheduledToday')} />
                        <span className="toggle-track" />
                        <span className="toggle-thumb" />
                      </label>
                      <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{t('scheduledToday', lang)}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <label className="toggle" style={{ margin: 0 }}>
                        <input type="checkbox" checked={member.isSenior} onChange={() => handleToggle(member, 'isSenior')} />
                        <span className="toggle-track" />
                        <span className="toggle-thumb" />
                      </label>
                      <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{t('senior', lang)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Add/Edit modal */}
        <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editMember ? 'Edit Staff Member' : t('addStaff', lang)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label className="label">{t('name', lang)}</label>
              <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="input" placeholder="Maria Garcia" autoFocus />
            </div>
            <div>
              <label className="label">{t('phone', lang)}</label>
              <input type="tel" value={form.phone ?? ''} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="input" placeholder="(409) 555-1234" />
            </div>
            <div>
              <label className="label">{t('language', lang)}</label>
              <select value={form.language} onChange={e => setForm(f => ({ ...f, language: e.target.value as 'en' | 'es' }))} className="input">
                <option value="en">English</option>
                <option value="es">Español</option>
              </select>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'rgba(0,0,0,0.03)', border: '1px solid var(--border)', borderRadius: '8px' }}>
              <span style={{ fontSize: '14px' }}>{t('senior', lang)} (gets VIP rooms)</span>
              <label className="toggle" style={{ margin: 0 }}>
                <input type="checkbox" checked={form.isSenior} onChange={e => setForm(f => ({ ...f, isSenior: e.target.checked }))} />
                <span className="toggle-track" />
                <span className="toggle-thumb" />
              </label>
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
              <button onClick={() => setShowModal(false)} className="btn btn-secondary" style={{ flex: 1, justifyContent: 'center' }}>{t('cancel', lang)}</button>
              <button onClick={handleSave} disabled={saving || !form.name.trim()} className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }}>
                {saving ? 'Saving...' : t('save', lang)}
              </button>
            </div>
          </div>
        </Modal>
      </div>
    </AppLayout>
  );
}
