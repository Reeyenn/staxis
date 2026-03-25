'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { createProperty } from '@/lib/firestore';
import { DEFAULT_PROPERTY } from '@/lib/defaults';
import { Building2, ChevronRight, ChevronLeft, Check } from 'lucide-react';

const STEPS = ['Property', 'Rooms & Staff', 'Financials', 'Done'];

const Field = ({ label, value, onChange, type = 'text', placeholder = '', suffix = '' }: any) => {
  const [raw, setRaw] = React.useState(String(value));
  React.useEffect(() => { setRaw(String(value)); }, [value]);
  return (
    <div style={{ marginBottom: '20px' }}>
      <label className="label">{label}</label>
      <div style={{ position: 'relative' }}>
        <input
          type={type}
          value={type === 'number' ? raw : value}
          onFocus={() => { if (type === 'number' && Number(raw) === 0) setRaw(''); }}
          onChange={e => {
            if (type === 'number') {
              setRaw(e.target.value);
              const n = Number(e.target.value);
              if (!isNaN(n) && e.target.value !== '') onChange(n);
            } else {
              onChange(e.target.value);
            }
          }}
          onBlur={() => {
            if (type === 'number') {
              const n = Number(raw);
              const final = isNaN(n) ? 0 : n;
              setRaw(String(final));
              onChange(final);
            }
          }}
          placeholder={placeholder}
          className="input"
          style={suffix ? { paddingRight: '48px' } : {}}
        />
        {suffix && (
          <span style={{ position: 'absolute', right: '14px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '14px' }}>
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
};

export default function OnboardingPage() {
  const { user } = useAuth();
  const { properties, setActivePropertyId } = useProperty();
  const router = useRouter();

  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: '',
    totalRooms: DEFAULT_PROPERTY.totalRooms,
    avgOccupancy: DEFAULT_PROPERTY.avgOccupancy,
    totalStaffOnRoster: DEFAULT_PROPERTY.totalStaffOnRoster,
    hourlyWage: DEFAULT_PROPERTY.hourlyWage,
    checkoutMinutes: DEFAULT_PROPERTY.checkoutMinutes,
    stayoverMinutes: DEFAULT_PROPERTY.stayoverMinutes,
    shiftMinutes: DEFAULT_PROPERTY.shiftMinutes,
    weeklyBudget: DEFAULT_PROPERTY.weeklyBudget,
  });

  useEffect(() => {
    if (!user) router.replace('/signin');
  }, [user, router]);

  const upd = (k: string, v: string | number) => setForm(f => ({ ...f, [k]: v }));

  const handleFinish = async () => {
    if (!user || !form.name.trim()) return;
    setSaving(true);
    try {
      const pid = await createProperty(user.uid, {
        ...form,
        pmsConnected: false,
        lastSyncedAt: null,
        createdAt: new Date(),
      } as any);
      setActivePropertyId(pid);
      router.replace('/dashboard');
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
      <div style={{ width: '100%', maxWidth: '480px' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', marginBottom: '8px' }}>
            <Building2 size={24} color="var(--amber)" />
            <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 800, fontSize: '1.4rem', letterSpacing: '0.02em' }}>
              HotelOps <span style={{ color: 'var(--amber)' }}>AI</span>
            </span>
          </div>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '2rem', color: 'var(--text-primary)' }}>
            Set up your property
          </h2>
          <p style={{ color: 'var(--text-secondary)', marginTop: '6px', fontSize: '14px' }}>Takes about 2 minutes</p>
        </div>

        {/* Step indicators */}
        <div style={{ display: 'flex', gap: '6px', marginBottom: '32px' }}>
          {STEPS.map((s, i) => (
            <div
              key={s}
              style={{
                flex: 1,
                height: '4px',
                borderRadius: '2px',
                background: i <= step ? 'var(--amber)' : 'rgba(255,255,255,0.1)',
                transition: 'background 0.3s',
              }}
            />
          ))}
        </div>

        {/* Step label */}
        <p style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--amber)', marginBottom: '24px' }}>
          Step {step + 1} of {STEPS.length} — {STEPS[step]}
        </p>

        {/* Step 0: Property name */}
        {step === 0 && (
          <div className="animate-slide-in-up">
            <Field
              label="Property Name"
              value={form.name}
              onChange={(v: string) => upd('name', v)}
              placeholder="e.g. Comfort Suites Beaumont"
            />
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '-12px' }}>
              This will appear in all your reports and schedules
            </p>
          </div>
        )}

        {/* Step 1: Rooms & Staff */}
        {step === 1 && (
          <div className="animate-slide-in-up">
            <Field label="Total Rooms" value={form.totalRooms} onChange={(v: number) => upd('totalRooms', v)} type="number" />
            <Field label="Average Rooms Occupied Per Night" value={form.avgOccupancy} onChange={(v: number) => upd('avgOccupancy', v)} type="number" suffix="rooms" />
            <Field label="Housekeeping Staff on Roster" value={form.totalStaffOnRoster} onChange={(v: number) => upd('totalStaffOnRoster', v)} type="number" suffix="people" />
          </div>
        )}

        {/* Step 2: Financials */}
        {step === 2 && (
          <div className="animate-slide-in-up">
            <Field label="Housekeeper Hourly Wage" value={form.hourlyWage} onChange={(v: number) => upd('hourlyWage', v)} type="number" suffix="$/hr" />
            <Field label="Minutes to Clean a Checkout Room" value={form.checkoutMinutes} onChange={(v: number) => upd('checkoutMinutes', v)} type="number" suffix="min" />
            <Field label="Minutes to Clean a Stayover Room" value={form.stayoverMinutes} onChange={(v: number) => upd('stayoverMinutes', v)} type="number" suffix="min" />
            <Field label="Shift Length" value={form.shiftMinutes} onChange={(v: number) => upd('shiftMinutes', v)} type="number" suffix="min" />
            <Field label="Weekly Labor Budget (optional)" value={form.weeklyBudget} onChange={(v: number) => upd('weeklyBudget', v)} type="number" suffix="$" />
          </div>
        )}

        {/* Step 3: Done */}
        {step === 3 && (
          <div className="animate-slide-in-up" style={{ textAlign: 'center' }}>
            <div
              style={{
                width: '80px',
                height: '80px',
                borderRadius: '50%',
                background: 'rgba(34,197,94,0.15)',
                border: '2px solid rgba(34,197,94,0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 24px',
                boxShadow: '0 0 30px rgba(34,197,94,0.2)',
              }}
            >
              <Check size={40} color="#22c55e" />
            </div>
            <h3 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '1.8rem', marginBottom: '12px' }}>
              You're all set, {user?.displayName?.split(' ')[0]}!
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '15px', lineHeight: 1.6, maxWidth: '320px', margin: '0 auto' }}>
              <strong style={{ color: 'var(--text-primary)' }}>{form.name}</strong> is ready. Your public areas and laundry settings are pre-loaded with standard Comfort Suites defaults — customize them in Settings any time.
            </p>

            <div
              style={{
                margin: '24px 0',
                padding: '16px',
                background: 'rgba(212,144,64,0.08)',
                border: '1px solid rgba(212,144,64,0.2)',
                borderRadius: '12px',
                textAlign: 'left',
              }}
            >
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                <strong style={{ color: 'var(--amber)' }}>Next step:</strong> Open Morning Setup every day and hit Calculate. You'll see exactly how many housekeepers you need — and how much you're saving.
              </p>
            </div>
          </div>
        )}

        {/* Navigation */}
        <div style={{ display: 'flex', gap: '12px', marginTop: '32px' }}>
          {step > 0 && step < 3 && (
            <button onClick={() => setStep(s => s - 1)} className="btn btn-secondary" style={{ flex: 1 }}>
              <ChevronLeft size={18} />
              Back
            </button>
          )}
          {step < 2 && (
            <button
              onClick={() => setStep(s => s + 1)}
              disabled={step === 0 && !form.name.trim()}
              className="btn btn-primary"
              style={{ flex: 1 }}
            >
              Continue
              <ChevronRight size={18} />
            </button>
          )}
          {step === 2 && (
            <button onClick={() => setStep(3)} className="btn btn-primary" style={{ flex: 1 }}>
              Review
              <ChevronRight size={18} />
            </button>
          )}
          {step === 3 && (
            <button
              onClick={handleFinish}
              disabled={saving}
              className="btn btn-primary btn-lg"
              style={{ flex: 1 }}
            >
              {saving ? 'Saving...' : 'Open HotelOps AI →'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
