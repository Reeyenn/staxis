'use client';

/**
 * Phase M1.5 (2026-05-14) — unified onboarding wizard.
 *
 * URL: /onboard?code=XXXX
 *
 * Single page, 9 steps. Replaces the scattered /signup → /signin/verify
 * → /onboarding → /settings/pms flow with one resumable wizard. Each
 * step's "Next" handler PATCHes /api/onboard/wizard so the user can
 * close the tab and resume later from the same link.
 *
 * What each step does:
 *   1. Welcome — "You're invited to onboard <Hotel>"
 *   2. Create account — email/name/password (POSTs /api/auth/use-join-code)
 *   3. Verify email — 6-digit OTP (Supabase verifyOtp)
 *   4. Hotel details — confirm/edit name, rooms, timezone, brand, etc.
 *   5. Services — toggle inventory/housekeeping/etc.
 *   6. Connect PMS — credentials + test (POSTs /api/pms/save-credentials
 *      + /api/pms/onboard)
 *   7. Mapping — live progress bar of CUA job (polls /api/pms/job-status)
 *   8. Add team — optional 0-5 staff rows
 *   9. All set — celebration screen + "Go to Dashboard" finalize
 *
 * Multi-tenancy: the page itself doesn't read property data directly.
 * All reads/writes go through the wizard API which validates the join
 * code on every call. After signup, the user's session is the new
 * owner's session — RLS isolates them from Beaumont automatically.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Loader2, Check, AlertCircle, Building2, Mail, KeyRound, Settings as SettingsIcon, Users, Sparkles } from 'lucide-react';

// ─── Types mirroring the wizard API response ───────────────────────────

interface WizardStateResponse {
  propertyId: string;
  propertyName: string;
  currentStep: number;
  completed: boolean;
  state: Record<string, string | number | undefined>;
  hotelDefaults: {
    name: string;
    totalRooms: number | null;
    timezone: string;
    brand: string | null;
    propertyKind: string | null;
    pmsType: string | null;
  } | null;
  inviteRole: 'owner' | 'general_manager' | null;
}

const REGION_OPTIONS = ['US-East', 'US-Central', 'US-Mountain', 'US-West', 'Hawaii', 'Other'];
const CLIMATE_OPTIONS = ['Tropical', 'Subtropical', 'Temperate', 'Cold'];
const PROPERTY_KINDS = [
  { value: 'limited_service', label: 'Limited service' },
  { value: 'full_service', label: 'Full service' },
  { value: 'extended_stay', label: 'Extended stay' },
  { value: 'resort', label: 'Resort' },
];

function deriveSizeTier(totalRooms: number | null): string {
  if (!totalRooms) return 'unknown';
  if (totalRooms < 75) return 'small (<75)';
  if (totalRooms < 150) return 'mid (75-149)';
  if (totalRooms < 300) return 'large (150-299)';
  return 'enterprise (300+)';
}

// ─── Main wizard ────────────────────────────────────────────────────────

export default function OnboardPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const code = sp.get('code')?.toUpperCase().trim() ?? '';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wizard, setWizard] = useState<WizardStateResponse | null>(null);

  const loadState = useCallback(async () => {
    if (!code) {
      setError('Missing invite code in the URL. Use the link sent to you, or contact your admin for a new one.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/onboard/wizard?code=${encodeURIComponent(code)}`);
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error || `Server returned ${res.status}`);
        return;
      }
      const data = json.data as WizardStateResponse;
      if (data.completed) {
        // Already done — bounce them to dashboard.
        router.push('/dashboard');
        return;
      }
      setWizard(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error loading invite');
    } finally {
      setLoading(false);
    }
  }, [code, router]);

  useEffect(() => { void loadState(); }, [loadState]);

  if (loading) {
    return (
      <FullPage>
        <Loader2 size={28} className="spin" color="var(--text-muted)" />
        <p style={{ marginTop: '12px', color: 'var(--text-muted)' }}>Loading your invite…</p>
      </FullPage>
    );
  }
  if (error) {
    return (
      <FullPage>
        <AlertCircle size={32} color="var(--red, #ef4444)" />
        <h1 style={{ fontSize: '20px', marginTop: '16px' }}>Can&apos;t open this invite</h1>
        <p style={{ marginTop: '8px', color: 'var(--text-muted)', maxWidth: '400px', textAlign: 'center' }}>{error}</p>
      </FullPage>
    );
  }
  if (!wizard) return null;

  const advance = async () => { await loadState(); };

  return (
    <WizardLayout step={wizard.currentStep} hotelName={wizard.propertyName}>
      {wizard.currentStep === 1 && <Step1Welcome wizard={wizard} onNext={advance} />}
      {wizard.currentStep === 2 && <Step2CreateAccount code={code} wizard={wizard} onNext={advance} />}
      {wizard.currentStep === 3 && <Step3VerifyEmail code={code} wizard={wizard} onNext={advance} />}
      {wizard.currentStep === 4 && <Step4HotelDetails code={code} wizard={wizard} onNext={advance} />}
      {wizard.currentStep === 5 && <Step5Services code={code} wizard={wizard} onNext={advance} />}
      {wizard.currentStep === 6 && <Step6ConnectPms code={code} wizard={wizard} onNext={advance} />}
      {wizard.currentStep === 7 && <Step7Mapping code={code} wizard={wizard} onNext={advance} />}
      {wizard.currentStep === 8 && <Step8AddTeam code={code} wizard={wizard} onNext={advance} />}
      {wizard.currentStep === 9 && <Step9AllSet code={code} wizard={wizard} />}
    </WizardLayout>
  );
}

// ─── Layout (progress bar + container) ──────────────────────────────────

const STEP_LABELS = [
  'Welcome', 'Account', 'Verify email', 'Hotel', 'Services',
  'PMS', 'Mapping', 'Team', 'Done',
];

function WizardLayout({ step, hotelName, children }: {
  step: number; hotelName: string; children: React.ReactNode;
}) {
  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg, #f6f7f9)',
      padding: '40px 20px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      <div style={{ maxWidth: '600px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: '24px' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: '4px' }}>
            Onboarding
          </div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>
            {hotelName}
          </h1>
        </div>

        {/* Progress steps */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: '24px', overflow: 'auto', gap: '4px',
        }}>
          {STEP_LABELS.map((label, i) => {
            const stepNum = i + 1;
            const isPast = stepNum < step;
            const isCurrent = stepNum === step;
            return (
              <div key={label} style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                flex: 1, minWidth: '44px', position: 'relative',
              }}>
                <div style={{
                  width: '24px', height: '24px', borderRadius: '50%',
                  background: isPast ? 'var(--green, #22c55e)' : isCurrent ? 'var(--text-primary, #111)' : 'var(--border, #e5e5e5)',
                  color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '12px', fontWeight: 600,
                }}>
                  {isPast ? <Check size={14} /> : stepNum}
                </div>
                <span style={{
                  fontSize: '10px', marginTop: '4px',
                  color: isCurrent ? 'var(--text-primary)' : 'var(--text-muted)',
                  fontWeight: isCurrent ? 600 : 400,
                }}>{label}</span>
              </div>
            );
          })}
        </div>

        {/* Step content */}
        <div style={{
          background: '#fff',
          borderRadius: '12px',
          padding: '32px',
          border: '1px solid var(--border, #e5e5e5)',
        }}>
          {children}
        </div>
      </div>
      <style>{`
        .spin { animation: spin 1.5s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg) } }
        .input { width: 100%; padding: 10px 12px; border: 1px solid var(--border, #e5e5e5); border-radius: 8px; font-size: 14px; box-sizing: border-box; }
        .btn { padding: 10px 20px; border-radius: 8px; border: none; cursor: pointer; font-size: 14px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
        .btn-primary { background: var(--text-primary, #111); color: #fff; }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-secondary { background: #fff; color: var(--text-primary, #111); border: 1px solid var(--border, #e5e5e5); }
        .label { display: block; font-size: 12px; font-weight: 600; color: var(--text-secondary, #555); margin-bottom: 6px; }
      `}</style>
    </div>
  );
}

function FullPage({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', padding: '20px',
    }}>{children}</div>
  );
}

// ─── Step 1: Welcome ────────────────────────────────────────────────────

function Step1Welcome({ wizard, onNext }: { wizard: WizardStateResponse; onNext: () => Promise<void>; }) {
  const role = wizard.inviteRole === 'general_manager' ? 'General Manager' : 'Owner';
  return (
    <div>
      <Building2 size={32} color="var(--amber, #d49040)" style={{ marginBottom: '16px' }} />
      <h2 style={{ fontSize: '22px', margin: '0 0 8px 0', fontWeight: 700 }}>
        You&apos;re invited to set up {wizard.propertyName}
      </h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '24px', lineHeight: 1.5 }}>
        You&apos;ve been added as the <strong>{role}</strong> for {wizard.propertyName} on Staxis — the AI-powered operations platform that runs your housekeeping, inventory, and labor planning in the background.
      </p>
      <p style={{ color: 'var(--text-muted)', marginBottom: '32px', lineHeight: 1.5, fontSize: '13px' }}>
        We&apos;ll walk you through 9 quick steps (account, hotel info, services, PMS connection). Takes about 10 minutes.
      </p>
      <button className="btn btn-primary" onClick={onNext} style={{ width: '100%', justifyContent: 'center' }}>
        Begin →
      </button>
    </div>
  );
}

// ─── Step 2: Create account ─────────────────────────────────────────────

function Step2CreateAccount({ code, wizard, onNext }: { code: string; wizard: WizardStateResponse; onNext: () => Promise<void>; }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (!email.includes('@')) { setErr('Valid email required.'); return; }
    if (displayName.trim().length < 2) { setErr('Name required.'); return; }
    if (password.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    setSubmitting(true);
    try {
      // Create the account via the existing use-join-code endpoint.
      // Per Phase M1.5 commit 5: if the join code has role=owner baked
      // in (which all admin-created codes do), use-join-code transfers
      // properties.owner_id to the new owner.
      const res = await fetch('/api/auth/use-join-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, email, displayName, password, phone, role: 'front_desk' /* ignored, baked-in role wins */ }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setErr(json.error || `Sign-up failed (${res.status})`);
        return;
      }
      // Trigger the OTP email send.
      await supabase.auth.signInWithOtp({ email });
      // PATCH wizard state
      await fetch('/api/onboard/wizard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          partialState: { accountCreatedAt: new Date().toISOString() },
        }),
      });
      // Stash email so step 3 can verify it
      sessionStorage.setItem('onboard:pendingEmail', email);
      await onNext();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: '20px', marginBottom: '4px' }}>Create your account</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '20px', fontSize: '13px' }}>
        This is the login you&apos;ll use to manage {wizard.propertyName}.
      </p>
      {err && <ErrorBox msg={err} />}
      <Field label="Email *">
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@hotel.com" />
      </Field>
      <Field label="Full name *">
        <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Jane Doe" />
      </Field>
      <Field label="Phone (optional)">
        <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 555 555 5555" />
      </Field>
      <Field label="Password * (min 8 characters)">
        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <button className="btn btn-primary" onClick={submit} disabled={submitting} style={{ width: '100%', justifyContent: 'center', marginTop: '12px' }}>
        {submitting ? <Loader2 size={14} className="spin" /> : null}
        {submitting ? 'Creating…' : 'Create account →'}
      </button>
    </div>
  );
}

// ─── Step 3: Verify email ───────────────────────────────────────────────

function Step3VerifyEmail({ code, onNext }: { code: string; wizard: WizardStateResponse; onNext: () => Promise<void>; }) {
  const [otp, setOtp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pendingEmail = typeof window !== 'undefined' ? sessionStorage.getItem('onboard:pendingEmail') ?? '' : '';

  const submit = async () => {
    setErr(null);
    if (otp.length < 6) { setErr('Enter the 6-digit code from your email.'); return; }
    if (!pendingEmail) { setErr('Missing email — refresh and try again.'); return; }
    setSubmitting(true);
    try {
      const { error } = await supabase.auth.verifyOtp({ email: pendingEmail, token: otp, type: 'email' });
      if (error) { setErr(error.message); return; }
      await fetch('/api/onboard/wizard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          partialState: { emailVerifiedAt: new Date().toISOString() },
        }),
      });
      sessionStorage.removeItem('onboard:pendingEmail');
      await onNext();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Verify failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <Mail size={32} color="var(--amber, #d49040)" style={{ marginBottom: '16px' }} />
      <h2 style={{ fontSize: '20px', marginBottom: '4px' }}>Check your email</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '20px', fontSize: '13px' }}>
        We sent a 6-digit code to <strong>{pendingEmail || 'your email'}</strong>.
      </p>
      {err && <ErrorBox msg={err} />}
      <Field label="Code *">
        <input className="input" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="000000" inputMode="numeric" maxLength={6}
          style={{ fontFamily: 'monospace', fontSize: '20px', letterSpacing: '0.3em', textAlign: 'center' }} />
      </Field>
      <button className="btn btn-primary" onClick={submit} disabled={submitting || otp.length !== 6} style={{ width: '100%', justifyContent: 'center', marginTop: '12px' }}>
        {submitting ? 'Verifying…' : 'Verify →'}
      </button>
    </div>
  );
}

// ─── Step 4: Hotel details ──────────────────────────────────────────────

function Step4HotelDetails({ code, wizard, onNext }: { code: string; wizard: WizardStateResponse; onNext: () => Promise<void>; }) {
  const d = wizard.hotelDefaults;
  const [name, setName] = useState(d?.name ?? '');
  const [totalRooms, setTotalRooms] = useState<number>(d?.totalRooms ?? 0);
  const [timezone, setTimezone] = useState(d?.timezone ?? 'America/Chicago');
  const [brand, setBrand] = useState(d?.brand ?? '');
  const [propertyKind, setPropertyKind] = useState(d?.propertyKind ?? 'limited_service');
  const [region, setRegion] = useState('');
  const [climateZone, setClimateZone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (name.trim().length < 3) { setErr('Hotel name required.'); return; }
    if (totalRooms < 1) { setErr('Total rooms must be at least 1.'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/onboard/wizard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          partialState: { hotelDetailsAt: new Date().toISOString() },
          propertyUpdates: {
            name: name.trim(),
            total_rooms: totalRooms,
            timezone,
            brand: brand.trim() || null,
            property_kind: propertyKind,
            region: region || null,
            climate_zone: climateZone || null,
            size_tier: deriveSizeTier(totalRooms),
          },
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) { setErr(json.error || 'Save failed'); return; }
      await onNext();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <Building2 size={28} color="var(--amber, #d49040)" style={{ marginBottom: '12px' }} />
      <h2 style={{ fontSize: '20px', marginBottom: '4px' }}>About your hotel</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '20px', fontSize: '13px' }}>
        Confirm the details. The brand and region help us learn from similar hotels.
      </p>
      {err && <ErrorBox msg={err} />}
      <Field label="Hotel name *">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Total rooms *">
        <input className="input" type="number" value={totalRooms || ''} min={1} onChange={(e) => setTotalRooms(Number(e.target.value) || 0)} />
      </Field>
      <Field label="Timezone *">
        <input className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/Chicago" />
      </Field>
      <Field label="Brand (optional)">
        <input className="input" value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="e.g. Hilton, Marriott, IHG" />
      </Field>
      <Field label="Property kind">
        <select className="input" value={propertyKind} onChange={(e) => setPropertyKind(e.target.value)}>
          {PROPERTY_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </Field>
      <Field label="Region (helps the AI learn from similar hotels)">
        <select className="input" value={region} onChange={(e) => setRegion(e.target.value)}>
          <option value="">— Select —</option>
          {REGION_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </Field>
      <Field label="Climate zone (optional)">
        <select className="input" value={climateZone} onChange={(e) => setClimateZone(e.target.value)}>
          <option value="">— Select —</option>
          {CLIMATE_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>
      <button className="btn btn-primary" onClick={submit} disabled={submitting} style={{ width: '100%', justifyContent: 'center', marginTop: '12px' }}>
        {submitting ? 'Saving…' : 'Save & continue →'}
      </button>
    </div>
  );
}

// ─── Step 5: Services ───────────────────────────────────────────────────

const SERVICES = [
  { key: 'housekeeping', label: 'Housekeeping', hint: 'Daily room cleaning + assignments' },
  { key: 'laundry', label: 'Laundry', hint: 'Linens, towels, washroom rotation' },
  { key: 'maintenance', label: 'Maintenance', hint: 'Repairs + work orders' },
  { key: 'deep_cleaning', label: 'Deep cleaning', hint: 'Periodic room/area refresh' },
  { key: 'public_areas', label: 'Public areas', hint: 'Lobby, hallways, breakfast' },
  { key: 'inventory', label: 'Inventory', hint: 'Auto-reorder + counts' },
  { key: 'equipment', label: 'Equipment', hint: 'Tools + appliances tracking' },
];

function Step5Services({ code, onNext }: { code: string; wizard: WizardStateResponse; onNext: () => Promise<void>; }) {
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(SERVICES.map((s) => [s.key, true])),
  );
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/onboard/wizard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          partialState: { servicesAt: new Date().toISOString() },
          propertyUpdates: { services_enabled: selected },
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) { setErr(json.error || 'Save failed'); return; }
      await onNext();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <SettingsIcon size={28} color="var(--amber, #d49040)" style={{ marginBottom: '12px' }} />
      <h2 style={{ fontSize: '20px', marginBottom: '4px' }}>Which services do you want?</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '20px', fontSize: '13px' }}>
        Toggle off anything you don&apos;t need. You can change these later in settings.
      </p>
      {err && <ErrorBox msg={err} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
        {SERVICES.map((s) => (
          <label key={s.key} style={{
            display: 'flex', alignItems: 'flex-start', gap: '12px',
            padding: '12px', border: '1px solid var(--border)', borderRadius: '8px', cursor: 'pointer',
          }}>
            <input type="checkbox" checked={selected[s.key]} onChange={(e) => setSelected({ ...selected, [s.key]: e.target.checked })} style={{ marginTop: '2px' }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: '14px' }}>{s.label}</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{s.hint}</div>
            </div>
          </label>
        ))}
      </div>
      <button className="btn btn-primary" onClick={submit} disabled={submitting} style={{ width: '100%', justifyContent: 'center' }}>
        {submitting ? 'Saving…' : 'Continue →'}
      </button>
    </div>
  );
}

// ─── Step 6: Connect PMS ────────────────────────────────────────────────

function Step6ConnectPms({ code, wizard, onNext }: { code: string; wizard: WizardStateResponse; onNext: () => Promise<void>; }) {
  const [pmsType, setPmsType] = useState(wizard.hotelDefaults?.pmsType ?? 'choice_advantage');
  const [loginUrl, setLoginUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (!loginUrl || !username || !password) { setErr('All PMS fields required.'); return; }
    setSubmitting(true);
    try {
      // 1. Save credentials
      const credRes = await fetch('/api/pms/save-credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ propertyId: wizard.propertyId, pmsType, loginUrl, username, password }),
      });
      const credJson = await credRes.json();
      if (!credRes.ok || !credJson.ok) { setErr(credJson.error || 'Credentials save failed'); return; }

      // 2. Queue onboarding job
      const jobRes = await fetch('/api/pms/onboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ propertyId: wizard.propertyId }),
      });
      const jobJson = await jobRes.json();
      if (!jobRes.ok || !jobJson.ok) { setErr(jobJson.error || 'Onboarding queue failed'); return; }

      // 3. PATCH wizard state with the job ID
      await fetch('/api/onboard/wizard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          partialState: {
            pmsCredentialsAt: new Date().toISOString(),
            pmsJobId: jobJson.data.jobId,
          },
        }),
      });
      await onNext();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Connection failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <KeyRound size={28} color="var(--amber, #d49040)" style={{ marginBottom: '12px' }} />
      <h2 style={{ fontSize: '20px', marginBottom: '4px' }}>Connect your PMS</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '20px', fontSize: '13px' }}>
        We&apos;ll log into your PMS in a remote browser to learn your room layout. Read-only — we never make changes there.
      </p>
      {err && <ErrorBox msg={err} />}
      <Field label="PMS *">
        <select className="input" value={pmsType} onChange={(e) => setPmsType(e.target.value)}>
          <option value="choice_advantage">Choice Advantage</option>
        </select>
      </Field>
      <Field label="Login URL *">
        <input className="input" value={loginUrl} onChange={(e) => setLoginUrl(e.target.value)} placeholder="https://..." />
      </Field>
      <Field label="Username *">
        <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
      </Field>
      <Field label="Password *">
        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <button className="btn btn-primary" onClick={submit} disabled={submitting} style={{ width: '100%', justifyContent: 'center', marginTop: '12px' }}>
        {submitting ? 'Saving & starting…' : 'Save & start mapping →'}
      </button>
    </div>
  );
}

// ─── Step 7: Mapping (CUA progress) ─────────────────────────────────────

function Step7Mapping({ code, wizard, onNext }: { code: string; wizard: WizardStateResponse; onNext: () => Promise<void>; }) {
  const jobId = wizard.state.pmsJobId as string | undefined;
  const [status, setStatus] = useState<string>('queued');
  const [step, setStep] = useState<string>('Waiting for a worker…');
  const [pct, setPct] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let active = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/pms/job-status?id=${jobId}`);
        const json = await res.json();
        if (!active || !json.ok) return;
        const d = json.data;
        setStatus(d.status);
        setStep(d.step ?? 'Working…');
        setPct(d.progressPct ?? 0);
        if (d.status === 'complete') {
          await fetch('/api/onboard/wizard', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              code,
              partialState: { mappingCompletedAt: new Date().toISOString() },
            }),
          });
          await onNext();
        } else if (d.status === 'failed') {
          setError(d.error ?? 'Mapping failed. Reeyen has been notified.');
        }
      } catch {
        // ignore transient network errors; next tick will retry
      }
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => { active = false; clearInterval(t); };
  }, [jobId, code, onNext]);

  return (
    <div>
      <Loader2 size={28} className="spin" color="var(--amber, #d49040)" style={{ marginBottom: '12px' }} />
      <h2 style={{ fontSize: '20px', marginBottom: '4px' }}>Learning your PMS…</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '20px', fontSize: '13px' }}>
        This usually takes 2–5 minutes. Status updates live below.
      </p>
      {error ? (
        <ErrorBox msg={error} />
      ) : (
        <div>
          <p style={{ fontSize: '14px', marginBottom: '8px' }}>{step}</p>
          <div style={{ height: '6px', background: 'var(--border)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--amber, #d49040)', transition: 'width 0.3s' }} />
          </div>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>{status} · {pct}%</p>
        </div>
      )}
    </div>
  );
}

// ─── Step 8: Add team ───────────────────────────────────────────────────

function Step8AddTeam({ code, wizard, onNext }: { code: string; wizard: WizardStateResponse; onNext: () => Promise<void>; }) {
  const [staff, setStaff] = useState<{ name: string; phone: string; role: string; language: 'en' | 'es' }[]>([
    { name: '', phone: '', role: 'housekeeping', language: 'en' },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const skip = async () => {
    setSubmitting(true);
    await fetch('/api/onboard/wizard', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        partialState: { staffAt: new Date().toISOString() },
      }),
    });
    await onNext();
    setSubmitting(false);
  };

  const submit = async () => {
    setErr(null);
    setSubmitting(true);
    try {
      const filtered = staff.filter((s) => s.name.trim());
      if (filtered.length > 0) {
        const res = await fetch('/api/onboarding/complete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            propertyId: wizard.propertyId,
            servicesEnabled: {},  // already set in step 5
            staff: filtered,
          }),
        });
        const json = await res.json();
        if (!res.ok || !json.ok) { setErr(json.error || 'Save failed'); return; }
      }
      await fetch('/api/onboard/wizard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          partialState: { staffAt: new Date().toISOString() },
        }),
      });
      await onNext();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <Users size={28} color="var(--amber, #d49040)" style={{ marginBottom: '12px' }} />
      <h2 style={{ fontSize: '20px', marginBottom: '4px' }}>Add your team (optional)</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '20px', fontSize: '13px' }}>
        Add a few key staff now, or skip and invite them later from settings.
      </p>
      {err && <ErrorBox msg={err} />}
      {staff.map((s, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '8px' }}>
          <input className="input" placeholder="Name" value={s.name} onChange={(e) => { const c = [...staff]; c[i].name = e.target.value; setStaff(c); }} />
          <input className="input" placeholder="Phone" value={s.phone} onChange={(e) => { const c = [...staff]; c[i].phone = e.target.value; setStaff(c); }} />
          <select className="input" value={s.role} onChange={(e) => { const c = [...staff]; c[i].role = e.target.value; setStaff(c); }}>
            <option value="housekeeping">Housekeeping</option>
            <option value="front_desk">Front desk</option>
            <option value="maintenance">Maintenance</option>
          </select>
        </div>
      ))}
      {staff.length < 5 && (
        <button className="btn btn-secondary" onClick={() => setStaff([...staff, { name: '', phone: '', role: 'housekeeping', language: 'en' }])} style={{ marginBottom: '12px' }}>+ Another</button>
      )}
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button className="btn btn-secondary" onClick={skip} disabled={submitting} style={{ flex: 1, justifyContent: 'center' }}>Skip</button>
        <button className="btn btn-primary" onClick={submit} disabled={submitting} style={{ flex: 1, justifyContent: 'center' }}>{submitting ? 'Saving…' : 'Add team →'}</button>
      </div>
    </div>
  );
}

// ─── Step 9: All set ────────────────────────────────────────────────────

function Step9AllSet({ code, wizard }: { code: string; wizard: WizardStateResponse; }) {
  const router = useRouter();
  const [going, setGoing] = useState(false);
  const finalize = async () => {
    setGoing(true);
    await fetch('/api/onboard/wizard', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, finalize: true }),
    });
    router.push('/dashboard');
  };

  return (
    <div>
      <Sparkles size={32} color="var(--amber, #d49040)" style={{ marginBottom: '16px' }} />
      <h2 style={{ fontSize: '22px', margin: '0 0 8px 0', fontWeight: 700 }}>You&apos;re all set!</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '16px', lineHeight: 1.5 }}>
        Welcome to Staxis. {wizard.propertyName} is ready.
      </p>
      <div style={{ background: 'var(--bg, #f6f7f9)', borderRadius: '8px', padding: '14px', marginBottom: '16px' }}>
        <p style={{ fontSize: '13px', margin: 0, lineHeight: 1.5 }}>
          ✓ Your inventory has 16 default items (sheets, towels, soap, etc.). Customize anytime in the Inventory tab.
        </p>
        <p style={{ fontSize: '13px', margin: '8px 0 0 0', lineHeight: 1.5 }}>
          ✓ Once your housekeepers start cleaning rooms, the AI will start predicting your needs. Usually within 7 days.
        </p>
      </div>
      <button className="btn btn-primary" onClick={finalize} disabled={going} style={{ width: '100%', justifyContent: 'center' }}>
        {going ? 'Going…' : 'Go to dashboard →'}
      </button>
    </div>
  );
}

// ─── Shared UI helpers ──────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '12px' }}>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '10px 12px', marginBottom: '14px',
      background: 'rgba(239,68,68,0.1)', borderRadius: '8px',
      color: 'var(--red, #ef4444)', fontSize: '13px',
    }}>
      <AlertCircle size={14} />
      {msg}
    </div>
  );
}
