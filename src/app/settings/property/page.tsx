'use client';

import React, { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { updateProperty, createProperty } from '@/lib/firestore';
import { t } from '@/lib/translations';
import { Building2, Plus, Check } from 'lucide-react';
import Link from 'next/link';

const Field = ({ label, field, type = 'text', suffix = '', form, setForm }: { label: string; field: string; type?: string; suffix?: string; form: Record<string, any>; setForm: React.Dispatch<React.SetStateAction<any>> }) => (
  <div style={{ marginBottom: '16px' }}>
    <label className="label">{label}</label>
    <div style={{ position: 'relative' }}>
      <input
        type={type}
        value={form[field]}
        onChange={e => setForm((f: any) => ({ ...f, [field]: type === 'number' ? Number(e.target.value) : e.target.value }))}
        className="input"
        style={suffix ? { paddingRight: '48px' } : {}}
      />
      {suffix && <span style={{ position: 'absolute', right: '14px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '13px' }}>{suffix}</span>}
    </div>
  </div>
);

export default function PropertySettingsPage() {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, properties, setActivePropertyId, refreshProperty } = useProperty();
  const { lang } = useLang();

  const [form, setForm] = useState({
    name: '',
    totalRooms: 0,
    avgOccupancy: 65,
    totalStaffOnRoster: 8,
    hourlyWage: 12,
    checkoutMinutes: 30,
    stayoverMinutes: 20,
    stayoverDay1Minutes: 15,
    stayoverDay2Minutes: 20,
    prepMinutesPerActivity: 5,
    shiftMinutes: 480,
    weeklyBudget: 2500,
  });
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showAddProperty, setShowAddProperty] = useState(false);
  const [newPropertyName, setNewPropertyName] = useState('');

  useEffect(() => {
    if (activeProperty) {
      const legacySo = activeProperty.stayoverMinutes ?? 20;
      setForm({
        name: activeProperty.name ?? '',
        totalRooms: activeProperty.totalRooms ?? 0,
        avgOccupancy: activeProperty.avgOccupancy ?? 65,
        totalStaffOnRoster: activeProperty.totalStaffOnRoster ?? 8,
        hourlyWage: activeProperty.hourlyWage ?? 12,
        checkoutMinutes: activeProperty.checkoutMinutes ?? 30,
        stayoverMinutes: legacySo,
        stayoverDay1Minutes: activeProperty.stayoverDay1Minutes ?? 15,
        stayoverDay2Minutes: activeProperty.stayoverDay2Minutes ?? legacySo,
        prepMinutesPerActivity: activeProperty.prepMinutesPerActivity ?? 5,
        shiftMinutes: activeProperty.shiftMinutes ?? 480,
        weeklyBudget: activeProperty.weeklyBudget ?? 2500,
      });
    }
  }, [activeProperty]);

  const handleSave = async () => {
    if (!user || !activePropertyId) return;
    setSaving(true);
    try {
      // Keep legacy `stayoverMinutes` aligned with Day 2 (the fuller clean) so any
      // legacy consumers read the safer estimate.
      const payload = { ...form, stayoverMinutes: form.stayoverDay2Minutes };
      await updateProperty(user.uid, activePropertyId, payload);
      await refreshProperty();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  };

  const handleAddProperty = async () => {
    if (!user || !newPropertyName.trim()) return;
    const pid = await createProperty(user.uid, {
      name: newPropertyName.trim(),
      totalRooms: 0,
      avgOccupancy: 65,
      hourlyWage: 12,
      checkoutMinutes: 30,
      stayoverMinutes: 20,
      prepMinutesPerActivity: 5,
      shiftMinutes: 480,
      totalStaffOnRoster: 8,
      weeklyBudget: 2500,
      pmsConnected: false,
      lastSyncedAt: null,
      createdAt: new Date(),
    } as any);
    setActivePropertyId(pid);
    setShowAddProperty(false);
    setNewPropertyName('');
  };

  return (
    <AppLayout>
      <div style={{ padding: '16px', maxWidth: '600px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
          <Link href="/settings" style={{ color: 'var(--text-muted)', textDecoration: 'none', fontSize: '14px' }}>← {t('settings', lang)}</Link>
          <span style={{ color: 'var(--text-muted)' }}>/</span>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '16px', letterSpacing: '-0.01em', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Building2 size={15} color="var(--amber)" /> {t('property', lang)}
          </h1>
        </div>

        {/* Property switcher */}
        {properties.length > 1 && (
          <div className="card" style={{ padding: '16px', marginBottom: '20px' }}>
            <p className="label" style={{ marginBottom: '10px' }}>{t('property', lang)}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {properties.map(p => (
                <button
                  key={p.id}
                  onClick={() => setActivePropertyId(p.id)}
                  style={{
                    padding: '10px 14px',
                    borderRadius: '8px',
                    border: `1px solid ${p.id === activePropertyId ? 'var(--amber-border, rgba(212,144,64,0.4))' : 'var(--border)'}`,
                    background: p.id === activePropertyId ? 'var(--amber-dim, rgba(212,144,64,0.08))' : 'transparent',
                    color: p.id === activePropertyId ? 'var(--amber)' : 'var(--text-primary)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontWeight: 500,
                    fontSize: '14px',
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Add property */}
        {showAddProperty ? (
          <div className="card" style={{ padding: '16px', marginBottom: '20px' }}>
            <label className="label">{t('createProperty', lang)}</label>
            <input type="text" value={newPropertyName} onChange={e => setNewPropertyName(e.target.value)} className="input" placeholder={lang === 'es' ? 'ej. Hampton Inn Austin' : 'e.g. Hampton Inn Austin'} style={{ marginBottom: '12px' }} />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => setShowAddProperty(false)} className="btn btn-secondary" style={{ flex: 1, justifyContent: 'center' }}>{t('cancel', lang)}</button>
              <button onClick={handleAddProperty} disabled={!newPropertyName.trim()} className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }}>{t('createProperty', lang)}</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowAddProperty(true)} className="btn btn-secondary" style={{ width: '100%', justifyContent: 'center', marginBottom: '20px' }}>
            <Plus size={16} /> {t('createProperty', lang)}
          </button>
        )}

        {/* Property form */}
        <div className="card" style={{ padding: '20px' }}>
          <Field label={t('propertyNameLabel', lang)} field="name" form={form} setForm={setForm} />
          <Field label={t('totalRoomsField', lang)} field="totalRooms" type="number" form={form} setForm={setForm} />
          <Field label={lang === 'es' ? 'Promedio de Ocupación por Noche' : 'Average Occupied Per Night'} field="avgOccupancy" type="number" suffix={lang === 'es' ? 'hab.' : 'rooms'} form={form} setForm={setForm} />
          <Field label={t('staffOnRosterField', lang)} field="totalStaffOnRoster" type="number" suffix={lang === 'es' ? 'personas' : 'people'} form={form} setForm={setForm} />

          <div className="divider" style={{ margin: '20px 0' }} />
          <p className="label" style={{ marginBottom: '14px' }}>{lang === 'es' ? 'Configuración Laboral' : 'Labor Settings'}</p>

          <Field label={lang === 'es' ? 'Salario por Hora' : 'Housekeeper Hourly Wage'} field="hourlyWage" type="number" suffix="$/hr" form={form} setForm={setForm} />
          <Field label={lang === 'es' ? 'Min. Checkout' : 'Checkout Minutes'} field="checkoutMinutes" type="number" suffix="min" form={form} setForm={setForm} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <Field label={lang === 'es' ? 'Continuación Día 1 (ligero)' : 'Stayover Day 1 (light)'} field="stayoverDay1Minutes" type="number" suffix="min" form={form} setForm={setForm} />
            <Field label={lang === 'es' ? 'Continuación Día 2 (completo)' : 'Stayover Day 2 (full)'} field="stayoverDay2Minutes" type="number" suffix="min" form={form} setForm={setForm} />
          </div>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '-8px 0 14px' }}>
            {lang === 'es'
              ? 'Se alterna cada 2 días: Día 1 (ligero, sin cambio de sábanas), Día 2 (completo, cambio de sábanas).'
              : 'Alternates every 2 days: Day 1 (light, no bed change), Day 2 (full, bed change).'}
          </p>
          <Field label={lang === 'es' ? 'Tiempo de Preparación' : 'Prep Time Per Activity'} field="prepMinutesPerActivity" type="number" suffix="min" form={form} setForm={setForm} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <Field label={lang === 'es' ? 'Duración del Turno' : 'Shift Length'} field="shiftMinutes" type="number" suffix="min" form={form} setForm={setForm} />
            <Field label={lang === 'es' ? 'Presupuesto Semanal' : 'Weekly Budget'} field="weeklyBudget" type="number" suffix="$" form={form} setForm={setForm} />
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={saving || saved}
          className={`btn btn-xl ${saved ? 'btn-green' : 'btn-primary'}`}
          style={{ width: '100%', justifyContent: 'center', marginTop: '20px' }}
        >
          {saved ? <><Check size={20} /> {t('saved', lang)}</> : saving ? t('saving', lang) : t('saveChanges', lang)}
        </button>
      </div>
    </AppLayout>
  );
}
