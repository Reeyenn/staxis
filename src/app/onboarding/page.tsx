'use client';

/**
 * Onboarding wizard.
 *
 * Reached after /signup creates a property in 'trial' status. The GM
 * fills in:
 *   - Which services they want enabled (housekeeping, laundry, etc.)
 *   - Their housekeepers (name + phone + language)
 *
 * On submit, POSTs to /api/onboarding/complete which saves to
 * properties.services_enabled and inserts staff rows. After that,
 * we redirect to /property-selector and the GM lands on the dashboard
 * with a 14-day trial running.
 *
 * PMS connection is intentionally NOT in this wizard — it lives in
 * /settings/pms. Lots of GMs don't have their PMS creds handy at
 * signup; gating onboarding on having them stops the conversion.
 */

import React, { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { Plus, Trash2, ChevronRight, AlertCircle, CheckCircle2 } from 'lucide-react';

type StaffRole = 'housekeeping' | 'front_desk' | 'maintenance' | 'other';

interface StaffRow {
  id: string;     // local UUID, not persisted
  name: string;
  phone: string;
  language: 'en' | 'es';
  role: StaffRole;
}

const ROLE_OPTIONS: Array<{ value: StaffRole; label: string }> = [
  { value: 'housekeeping', label: 'Housekeeper' },
  { value: 'front_desk',   label: 'Front desk' },
  { value: 'maintenance',  label: 'Maintenance' },
  { value: 'other',        label: 'Other' },
];

const SERVICE_DEFS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'housekeeping',  label: 'Housekeeping',     hint: 'Daily room cleaning + assignments to housekeepers' },
  { key: 'laundry',       label: 'Laundry',          hint: 'Track sheets/towels par levels and wash cycles' },
  { key: 'maintenance',   label: 'Maintenance',      hint: 'Work orders + preventive recurring tasks' },
  { key: 'deep_cleaning', label: 'Deep cleaning',    hint: 'Schedule periodic deep cleans (carpets, mattresses, etc.)' },
  { key: 'public_areas',  label: 'Public areas',     hint: 'Lobby, pool, breakfast room, hallway tasks' },
  { key: 'inventory',     label: 'Inventory',        hint: 'Cleaning supplies, amenities, restocking alerts' },
];

function localId(): string {
  return Math.random().toString(36).slice(2);
}

/**
 * Default export wraps the actual form in Suspense — Next.js 16's static
 * renderer rejects pages that call useSearchParams() at the top level
 * because they can't be pre-rendered without query params. Wrapping in
 * Suspense tells Next.js this part is dynamic; static generation skips
 * past it cleanly.
 */
export default function OnboardingPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
      </div>
    }>
      <OnboardingForm />
    </Suspense>
  );
}

function OnboardingForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, loading } = useAuth();

  const propertyId = params.get('propertyId') ?? '';

  const [services, setServices] = useState<Record<string, boolean>>({
    housekeeping: true, laundry: true, maintenance: true,
    deep_cleaning: true, public_areas: true, inventory: true,
  });
  const [staff, setStaff] = useState<StaffRow[]>([
    { id: localId(), name: '', phone: '', language: 'en', role: 'housekeeping' },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // If they're not signed in, bounce to /signup. The session was set
  // automatically after /signup so this only fires for stale links.
  useEffect(() => {
    if (loading) return;
    if (!user) router.replace('/signup');
    else if (!propertyId) router.replace('/property-selector');
  }, [user, loading, propertyId, router]);

  const addStaff = () =>
    setStaff((s) => [...s, { id: localId(), name: '', phone: '', language: 'en', role: 'housekeeping' }]);

  const removeStaff = (id: string) =>
    setStaff((s) => (s.length === 1 ? s : s.filter((r) => r.id !== id)));

  const updateStaff = (id: string, patch: Partial<StaffRow>) =>
    setStaff((s) => s.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    // Filter empty rows — the GM might've added a row and not filled it in.
    const cleanStaff = staff
      .map((r) => ({ ...r, name: r.name.trim(), phone: r.phone.trim() }))
      .filter((r) => r.name.length > 0);

    try {
      const res = await fetchWithAuth('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          propertyId,
          servicesEnabled: services,
          staff: cleanStaff.map(({ name, phone, language, role }) => ({
            name, phone: phone || undefined, language, role,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'Could not save your settings. Please try again.');
        setSubmitting(false);
        return;
      }
      router.replace('/property-selector?onboarded=1');
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
      setSubmitting(false);
    }
  };

  if (loading || !user) {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100dvh',
      background: 'var(--bg)',
      padding: '32px 24px 64px',
    }}>
      <div style={{ maxWidth: '640px', margin: '0 auto' }}>

        <div style={{ marginBottom: '32px', textAlign: 'center' }}>
          <CheckCircle2 size={36} color="var(--green)" style={{ marginBottom: '12px' }} />
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '24px', letterSpacing: '-0.01em', marginBottom: '6px' }}>
            Welcome — let's set up your property
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
            Two quick questions, then you're in. PMS connection is on the next page.
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* Services */}
          <div className="card" style={{ padding: '20px' }}>
            <p style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '6px' }}>
              Step 1 — Which services do you want?
            </p>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px', lineHeight: 1.5 }}>
              Toggle off anything that doesn't apply to your property. Extended-stay hotels usually leave housekeeping off.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {SERVICE_DEFS.map((s) => (
                <label key={s.key} style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '12px',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  background: services[s.key] ? 'rgba(212,144,64,0.06)' : 'transparent',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                }}>
                  <input
                    type="checkbox"
                    checked={!!services[s.key]}
                    onChange={(e) => setServices((sv) => ({ ...sv, [s.key]: e.target.checked }))}
                    style={{ marginTop: '3px' }}
                  />
                  <div>
                    <p style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>{s.label}</p>
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', lineHeight: 1.4 }}>{s.hint}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Staff */}
          <div className="card" style={{ padding: '20px' }}>
            <p style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '6px' }}>
              Step 2 — Add your staff
            </p>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px', lineHeight: 1.5 }}>
              Add everyone who works at the property — housekeepers, front desk, maintenance.
              Just names work for now; phone + language unlock SMS assignments. You can always edit later.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {staff.map((row, idx) => (
                <div key={row.id} style={{ display: 'grid', gridTemplateColumns: '2fr 1.5fr 2fr 1fr auto', gap: '8px', alignItems: 'center' }}>
                  <input
                    type="text" value={row.name} required={idx === 0}
                    onChange={(e) => updateStaff(row.id, { name: e.target.value })}
                    placeholder="Name" className="input"
                  />
                  <select
                    value={row.role}
                    onChange={(e) => updateStaff(row.id, { role: e.target.value as StaffRole })}
                    className="input"
                  >
                    {ROLE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <input
                    type="tel" value={row.phone}
                    onChange={(e) => updateStaff(row.id, { phone: e.target.value })}
                    placeholder="+1 555 555 5555" className="input"
                  />
                  <select
                    value={row.language}
                    onChange={(e) => updateStaff(row.id, { language: e.target.value as 'en' | 'es' })}
                    className="input"
                  >
                    <option value="en">English</option>
                    <option value="es">Español</option>
                  </select>
                  <button
                    type="button" onClick={() => removeStaff(row.id)}
                    disabled={staff.length === 1}
                    title="Remove this row"
                    style={{
                      width: '36px', height: '36px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: '1px solid var(--border)', borderRadius: '8px',
                      background: 'transparent', cursor: staff.length === 1 ? 'not-allowed' : 'pointer',
                      opacity: staff.length === 1 ? 0.4 : 1,
                    }}
                  >
                    <Trash2 size={14} color="var(--text-muted)" />
                  </button>
                </div>
              ))}
            </div>

            <button
              type="button" onClick={addStaff}
              className="btn btn-secondary"
              style={{ marginTop: '14px', justifyContent: 'center', fontSize: '13px' }}
            >
              <Plus size={14}/> Add another person
            </button>
          </div>

          {error && (
            <div style={{
              padding: '12px 14px',
              background: 'var(--red-dim)',
              border: '1px solid var(--red-border, rgba(239,68,68,0.25))',
              borderRadius: '10px',
              display: 'flex', gap: '10px', alignItems: 'flex-start',
            }}>
              <AlertCircle size={16} color="var(--red)" style={{ flexShrink: 0, marginTop: '1px' }} />
              <p style={{ fontSize: '13px', color: 'var(--red)' }}>{error}</p>
            </div>
          )}

          <button
            type="submit" disabled={submitting}
            className="btn btn-primary"
            style={{ justifyContent: 'center', padding: '14px 0' }}
          >
            {submitting ? 'Saving…' : (<>Finish setup <ChevronRight size={16} /></>)}
          </button>
        </form>
      </div>
    </div>
  );
}
