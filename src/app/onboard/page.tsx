'use client';


export const dynamic = 'force-dynamic';
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

import React, { useEffect, useRef, useState, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import { Loader2, Check, CheckCircle2, AlertCircle, Building2, Mail, KeyRound, Settings as SettingsIcon, Users, Sparkles, ChevronLeft } from 'lucide-react';
import { PLACEHOLDER_HOTEL_NAME, RESUME_GUARD_KEY } from '@/lib/onboarding/state';
import { useLang } from '@/contexts/LanguageContext';
import { mt, MILESTONES, milestoneIndexForLabel, milestoneLabel, type MappingStrings } from './_mapping-i18n';

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
    servicesEnabled: Record<string, boolean> | null;
  } | null;
  inviteRole: 'owner' | 'general_manager' | null;
}

const REGION_OPTIONS = ['US-East', 'US-Central', 'US-Mountain', 'US-West', 'Hawaii', 'Other'];
const PROPERTY_KINDS = [
  { value: 'limited_service', label: 'Limited service' },
  { value: 'select_service', label: 'Select service' },
  { value: 'full_service', label: 'Full service' },
];

// US timezones only (no international hotels yet) — a dropdown beats
// free-typing an IANA string the owner has to get exactly right.
const US_TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern (New York)' },
  { value: 'America/Chicago', label: 'Central (Chicago)' },
  { value: 'America/Denver', label: 'Mountain (Denver)' },
  { value: 'America/Phoenix', label: 'Mountain — no DST (Phoenix)' },
  { value: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { value: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
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
  // Suspense wrap is required by Next.js 14+ when using useSearchParams
  // in a client component that gets statically prerendered. Without
  // this the build fails: "useSearchParams should be wrapped in a
  // suspense boundary".
  return (
    <Suspense fallback={<FullPage><Loader2 size={28} className="spin" color="var(--text-muted)" /></FullPage>}>
      <OnboardWizard />
    </Suspense>
  );
}

function OnboardWizard() {
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
      // We made it into the wizard — clear the login-funnel's one-shot resume
      // guard so (a) a future resume can fire again and (b) navigating to the
      // dashboard mid-wizard correctly re-gates back here instead of escaping.
      if (typeof window !== 'undefined') sessionStorage.removeItem(RESUME_GUARD_KEY);
      if (data.completed) {
        // Already done — bounce them to dashboard.
        router.push('/dashboard');
        return;
      }
      // The lean admin flow creates hotels with a placeholder name the
      // owner hasn't replaced yet (they do it in Step 4). Show a friendly
      // fallback in the welcome/header/celebration instead of the raw
      // placeholder; Step 4's own prefill stays empty so they type theirs.
      setWizard({
        ...data,
        propertyName:
          data.propertyName && data.propertyName !== PLACEHOLDER_HOTEL_NAME
            ? data.propertyName
            : 'your hotel',
      });
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
      {wizard.currentStep === 1 && <Step1Welcome code={code} wizard={wizard} onNext={advance} />}
      {wizard.currentStep === 2 && <Step2CreateAccount code={code} wizard={wizard} onNext={advance} />}
      {wizard.currentStep === 3 && <Step3VerifyEmail code={code} wizard={wizard} onNext={advance} />}
      {wizard.currentStep === 4 && <Step4HotelDetails code={code} wizard={wizard} onNext={advance} />}
      {wizard.currentStep === 5 && <Step5Services code={code} wizard={wizard} onNext={advance} />}
      {wizard.currentStep === 6 && <Step6ConnectPms code={code} wizard={wizard} onNext={advance} />}
      {wizard.currentStep === 7 && <Step7Mapping code={code} onNext={advance} />}
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

/**
 * Reusable "← Back" control for the wizard's editable form steps. Sends the
 * onboarding_state keys to clear (server allow-list = CLEARABLE_STATE_KEYS),
 * which makes the next refetch land on the previous form so the operator can
 * fix what they entered. Best-effort: a failed PATCH just leaves them on the
 * current step. Only rendered on steps with a SAFE previous form — never on
 * the account/email-verification steps (those are auth-locked) or the Welcome/
 * Done endpoints.
 */
function WizardBackButton({ code, clearKeys, onNext }: {
  code: string; clearKeys: string[]; onNext: () => Promise<void>;
}) {
  const [backing, setBacking] = useState(false);
  const [failed, setFailed] = useState(false);
  const goBack = async () => {
    if (backing) return;
    setBacking(true);
    setFailed(false);
    try {
      const res = await fetch('/api/onboard/wizard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, clearStateKeys: clearKeys }),
      });
      if (res.ok) { await onNext(); return; }
      setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBacking(false);
    }
  };
  return (
    <div style={{ marginBottom: '16px' }}>
      <button
        type="button"
        onClick={goBack}
        disabled={backing}
        style={{
          background: 'none', border: 'none', padding: 0,
          cursor: backing ? 'default' : 'pointer',
          color: 'var(--text-muted)', fontSize: '13px',
          display: 'inline-flex', alignItems: 'center', gap: '4px',
          opacity: backing ? 0.5 : 1,
        }}
      >
        {backing ? <Loader2 size={14} className="spin" /> : <ChevronLeft size={15} />} Back
      </button>
      {failed && (
        <span style={{ marginLeft: '8px', fontSize: '12px', color: 'var(--red, #ef4444)' }}>
          Couldn&apos;t go back — try again.
        </span>
      )}
    </div>
  );
}

// ─── Step 1: Welcome ────────────────────────────────────────────────────

function Step1Welcome({ code, wizard, onNext }: { code: string; wizard: WizardStateResponse; onNext: () => Promise<void>; }) {
  const role = wizard.inviteRole === 'general_manager' ? 'General Manager' : 'Owner';
  const [starting, setStarting] = useState(false);
  // The welcome→account hop has no completion timestamp, so "Begin"
  // persists `step: 2` explicitly — deriveCurrentStep honors exactly that
  // value pre-account. Without this PATCH the refetch re-derives step 1
  // forever and the button appears dead.
  const begin = async () => {
    setStarting(true);
    try {
      await fetch('/api/onboard/wizard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, partialState: { step: 2 } }),
      });
      await onNext();
    } finally {
      setStarting(false);
    }
  };
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
      <button className="btn btn-primary" onClick={begin} disabled={starting} style={{ width: '100%', justifyContent: 'center' }}>
        {starting ? 'Starting…' : 'Begin →'}
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
      const { data, error } = await supabase.auth.verifyOtp({ email: pendingEmail, token: otp, type: 'email' });
      if (error || !data.session) { setErr(error?.message ?? 'Verification failed — try the code again.'); return; }

      // CRITICAL: trust this device, exactly like /signin/verify does.
      // The OTP gives a valid session, but the server's 2FA layer
      // (requireSession) ALSO requires a `staxis_device` cookie on the
      // first authenticated save (step 4's propertyUpdates PATCH). Without
      // this call the cookie is never issued, requireSession returns
      // requires_2fa → fetchWithAuth signs the user out ("Your session
      // ended") mid-wizard. The onboarding flow skipped this step entirely.
      try {
        await fetch('/api/auth/trust-device', {
          method: 'POST',
          headers: { Authorization: `Bearer ${data.session.access_token}` },
          credentials: 'include',
        });
        // Refresh so the JWT carries the mfa_verified claim the auth hook
        // mints (needed for the dashboard's RLS/realtime reads later).
        await supabase.auth.refreshSession();
      } catch (trustErr) {
        // Surface, don't swallow — a failed trust here is exactly what
        // caused the silent "session ended" before.
        setErr('Could not finish securing your session — refresh and re-enter the code.');
        console.warn('onboard trust-device failed', trustErr);
        return;
      }

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
  const [name, setName] = useState(d?.name && d.name !== PLACEHOLDER_HOTEL_NAME ? d.name : '');
  const [totalRooms, setTotalRooms] = useState<number>(d?.totalRooms ?? 0);
  const [timezone, setTimezone] = useState(d?.timezone ?? 'America/Chicago');
  const [brand, setBrand] = useState(d?.brand ?? '');
  const [propertyKind, setPropertyKind] = useState(d?.propertyKind ?? 'limited_service');
  const [region, setRegion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (name.trim().length < 3) { setErr('Hotel name required.'); return; }
    if (totalRooms < 1) { setErr('Total rooms must be at least 1.'); return; }
    setSubmitting(true);
    try {
      const res = await fetchWithAuth('/api/onboard/wizard', {
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
            size_tier: deriveSizeTier(totalRooms),
          },
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) { setErr(json.error || 'Save failed'); return; }
      await onNext();
    } catch (e) {
      if (e instanceof SessionEndedError) return;  // redirect in progress; suppress error
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
        <select className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {US_TIMEZONES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
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
];

function Step5Services({ code, wizard, onNext }: { code: string; wizard: WizardStateResponse; onNext: () => Promise<void>; }) {
  // Hydrate from saved selections so navigating BACK to this step doesn't reset
  // every toggle to ON and silently overwrite the operator's prior choices on
  // the next Continue. Cold start (nothing saved) → all on. A service key
  // absent from the saved map also defaults on (forward-compat with new
  // services added after the hotel first saved).
  const savedServices = wizard.hotelDefaults?.servicesEnabled ?? null;
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(SERVICES.map((s) => [s.key, savedServices ? savedServices[s.key] !== false : true])),
  );
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    setSubmitting(true);
    try {
      const res = await fetchWithAuth('/api/onboard/wizard', {
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
      if (e instanceof SessionEndedError) return;  // redirect in progress; suppress error
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <WizardBackButton code={code} clearKeys={['hotelDetailsAt']} onNext={onNext} />
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
      const credRes = await fetchWithAuth('/api/pms/save-credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ propertyId: wizard.propertyId, pmsType, loginUrl, username, password }),
      });
      const credJson = await credRes.json();
      if (!credRes.ok || !credJson.ok) { setErr(credJson.error || 'Credentials save failed'); return; }

      // 2. Queue onboarding job
      const jobRes = await fetchWithAuth('/api/pms/onboard', {
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
      if (e instanceof SessionEndedError) return;  // redirect in progress; suppress error
      setErr(e instanceof Error ? e.message : 'Connection failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <WizardBackButton code={code} clearKeys={['servicesAt']} onNext={onNext} />
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

// ─── Step 7: Mapping (live CUA progress) ────────────────────────────────
//
// Rebuilt 2026-06-10. The old version polled /api/pms/job-status which only
// reads the coarse property_sessions.status — that sits at
// paused_no_knowledge_file (=50%) the whole time the mapper runs and NEVER
// advances on the common park_draft outcome, so the bar froze forever.
//
// Now we poll /api/onboard/mapping-status (code-gated, supabaseAdmin) which
// bridges propertyId → the mapper workflow_jobs row → { phase, outcome,
// channel, feedsFound, live numbers }, and ADDITIONALLY subscribe to the
// mapper's realtime broadcast channel for live per-feed milestones. The
// polled route is the source of truth; the broadcast is an additive live
// layer (pub/sub only — not a table read, so the silent-empty RLS bug
// can't apply).

type StatusMetric = { value: number | null; available: boolean };
interface MappingNumbers {
  anyAvailable: boolean;
  capturedAt: string | null;
  totalRooms: number | null;
  occupancyPct: StatusMetric;
  occupiedRooms: StatusMetric;
  guestsInHouse: StatusMetric;
  arrivalsToday: StatusMetric;
  departuresToday: StatusMetric;
}
interface FeedStatus { key: string; label: string; captured: boolean; count: number | null }
interface MappingStatus {
  phase: 'preparing' | 'learning' | 'mfa' | 'done' | 'failed';
  outcome: 'auto_promote' | 'park_partial' | 'park_draft' | 'quarantine' | null;
  workflowJobId: string | null;
  channel: string | null;
  pmsLabel: string;
  feedsFound: number | null;
  pct: number | null;
  failReason: 'login' | 'login_url' | 'stopped' | 'generic' | null;
  numbers: MappingNumbers | null;
  feeds: FeedStatus[] | null;
}

function Step7Mapping({ code, onNext }: { code: string; onNext: () => Promise<void>; }) {
  const { lang } = useLang();
  const t = mt(lang);

  const [resp, setResp] = useState<MappingStatus | null>(null);
  const [barPct, setBarPct] = useState(0);
  const [maxMilestone, setMaxMilestone] = useState(-1);
  const [pollNonce, setPollNonce] = useState(0);
  const [advancing, setAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [reentering, setReentering] = useState(false);
  const [reenterError, setReenterError] = useState<string | null>(null);
  const advancingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Poll the bridge endpoint BY CODE (not the legacy pmsJobId — the route
  // resolves the property + mapper job from the code itself, so the step is
  // never stuck waiting on a pmsJobId the wizard may not have persisted).
  // Plain fetch (NOT fetchWithAuth) — the join code is the trust anchor and
  // fetchWithAuth can sign the user out on a transient 2FA refresh mid-poll.
  // Self-scheduling so the cadence can flex (3s in flight; 5s × a few after
  // done to catch late live numbers).
  useEffect(() => {
    if (!code) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let slowRefreshes = 0;
    const tick = async () => {
      try {
        const res = await fetch(`/api/onboard/mapping-status?code=${encodeURIComponent(code)}`);
        const json = await res.json();
        if (!active) return;
        if (json.ok) {
          const d = json.data as MappingStatus;
          setResp(d);
          if (typeof d.pct === 'number') setBarPct((p) => Math.max(p, d.pct as number));
          if (d.phase === 'done') {
            setMaxMilestone(MILESTONES.length - 1);
            setBarPct(100);
            // Refresh a few more times so live numbers that land a beat after
            // completion (the mapper's data-write) fill in, then stop.
            if (slowRefreshes < 6) { slowRefreshes += 1; timer = setTimeout(tick, 5000); }
            return;
          }
          if (d.phase === 'failed') return; // terminal — stop polling
        }
        timer = setTimeout(tick, 3000);
      } catch {
        if (active) timer = setTimeout(tick, 3000);
      }
    };
    void tick();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [code, pollNonce]);

  // Live milestone layer: subscribe to the mapper's broadcast channel once
  // the endpoint hands us its name. Mirrors the admin Live Mapping console.
  // Cleaned up on unmount / channel change.
  const channel = resp?.channel ?? null;
  useEffect(() => {
    if (!channel) return;
    const ch = supabase
      .channel(channel)
      .on('broadcast' as any, { event: '*' }, (msg: { payload?: { label?: string; pct?: number } }) => {
        const p = msg?.payload;
        if (p && typeof p.pct === 'number') setBarPct((prev) => Math.max(prev, p.pct as number));
        if (p && typeof p.label === 'string') {
          const idx = milestoneIndexForLabel(p.label);
          if (idx >= 0) setMaxMilestone((prev) => Math.max(prev, idx));
        }
      })
      .subscribe();
    return () => { void ch.unsubscribe(); };
  }, [channel]);

  const phase = resp?.phase ?? 'preparing';

  const advance = async () => {
    if (advancingRef.current) return; // guard double-tap before `disabled` applies
    advancingRef.current = true;
    setAdvancing(true);
    setAdvanceError(null);
    try {
      // Mark mapping complete so deriveCurrentStep moves to step 8. All three
      // done-outcomes advance — onboarding must not block on an admin review
      // (park_draft / quarantine finish wiring up in the background). Verify
      // the save landed before advancing, else the click would look dead.
      const res = await fetch('/api/onboard/wizard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, partialState: { mappingCompletedAt: new Date().toISOString() } }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        setAdvanceError(t.continueError);
        return;
      }
      await onNext();
    } catch {
      setAdvanceError(t.continueError);
    } finally {
      advancingRef.current = false;
      if (mountedRef.current) setAdvancing(false);
    }
  };

  // "Re-enter login" on a failed mapping → walk back to Step 6 (Connect PMS)
  // so the operator can fix the credentials and retry. clearStateKeys removes
  // the PMS completion markers server-side (deriveCurrentStep → 6) and onNext()
  // refetches, which re-renders Step6ConnectPms. The corrected-creds save then
  // clears the stale failed mapper job (see /api/pms/save-credentials), so the
  // driver enqueues a fresh learn against the new login.
  const reenterPms = async () => {
    if (reentering) return;
    setReentering(true);
    setReenterError(null);
    try {
      const res = await fetch('/api/onboard/wizard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, clearStateKeys: ['pmsCredentialsAt', 'pmsJobId', 'mappingCompletedAt'] }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) { setReenterError(t.reenterError); return; }
      await onNext();
    } catch {
      setReenterError(t.reenterError);
    } finally {
      if (mountedRef.current) setReentering(false);
    }
  };

  if (phase === 'done') {
    return <Step7Done t={t} lang={lang} resp={resp as MappingStatus} advancing={advancing} error={advanceError} onContinue={advance} />;
  }

  if (phase === 'failed') {
    const r = resp?.failReason;
    const msg = r === 'login' ? t.failLogin
      : r === 'login_url' ? t.failLoginUrl
        : r === 'stopped' ? t.failStopped
          : t.failGeneric;
    return (
      <div>
        <AlertCircle size={28} color="var(--red, #ef4444)" style={{ marginBottom: '12px' }} />
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>{t.failTitle}</h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: '20px', fontSize: '14px', lineHeight: 1.5 }}>{msg}</p>
        {reenterError && <ErrorBox msg={reenterError} />}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary"
            onClick={reenterPms}
            disabled={reentering}
            style={{ justifyContent: 'center' }}
          >
            {reentering ? <Loader2 size={14} className="spin" /> : null}
            {reentering ? '…' : t.reenterLoginBtn}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => { setResp(null); setBarPct(0); setMaxMilestone(-1); setPollNonce((n) => n + 1); }}
            disabled={reentering}
            style={{ justifyContent: 'center' }}
          >
            {t.checkAgainBtn}
          </button>
        </div>
      </div>
    );
  }

  // preparing / learning / mfa
  const title = phase === 'mfa' ? t.mfaTitle
    : phase === 'preparing' ? t.preparingTitle
      : t.learningTitle.replace('{pms}', resp?.pmsLabel ?? 'PMS');
  const body = phase === 'mfa' ? t.mfaBody
    : phase === 'preparing' ? t.preparingBody
      : t.learningBody;
  const showChecklist = phase === 'learning' && maxMilestone >= 0;
  const indeterminate = !showChecklist; // no real milestone yet → animated bar

  return (
    <div>
      <Loader2 size={28} className="spin" color="var(--amber, #d49040)" style={{ marginBottom: '12px' }} />
      <h2 style={{ fontSize: '20px', marginBottom: '4px' }}>{title}</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '20px', fontSize: '13px', lineHeight: 1.5 }}>{body}</p>

      <div style={{ height: '6px', background: 'var(--border)', borderRadius: '3px', overflow: 'hidden', marginBottom: '16px' }}>
        {indeterminate ? (
          <div className="onboard-indeterminate" style={{ height: '100%', background: 'var(--amber, #d49040)' }} />
        ) : (
          <div style={{ width: `${barPct}%`, height: '100%', background: 'var(--amber, #d49040)', transition: 'width 0.4s' }} />
        )}
      </div>

      {showChecklist && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {MILESTONES.slice(0, maxMilestone + 1).map((m, i) => (
            <MilestoneRow key={m.key} label={milestoneLabel(m, lang)} done={i !== maxMilestone} active={i === maxMilestone} />
          ))}
        </div>
      )}

      <style>{`
        .onboard-indeterminate { width: 40%; animation: onboardSlide 1.3s ease-in-out infinite; }
        @keyframes onboardSlide { 0% { margin-left: -40% } 100% { margin-left: 100% } }
      `}</style>
    </div>
  );
}

function MilestoneRow({ label, done, active }: { label: string; done: boolean; active: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: active ? 'var(--text-primary, #111)' : 'var(--text-muted)' }}>
      {done
        ? <Check size={14} color="var(--green, #22c55e)" />
        : <Loader2 size={14} className="spin" color="var(--amber, #d49040)" />}
      <span>{label}</span>
    </div>
  );
}

function Step7Done({ t, lang, resp, advancing, error, onContinue }: {
  t: MappingStrings; lang: 'en' | 'es'; resp: MappingStatus; advancing: boolean; error: string | null; onContinue: () => Promise<void>;
}) {
  const outcome = resp.outcome ?? 'park_draft';
  const pms = resp.pmsLabel || 'PMS';
  const title = outcome === 'auto_promote' ? t.doneTitleAuto
    : outcome === 'park_partial' ? t.doneTitlePartial
      : outcome === 'quarantine' ? t.doneTitleQuarantine
        : t.doneTitlePark;
  const body = outcome === 'auto_promote' ? t.doneBodyAuto
    : outcome === 'park_partial' ? t.doneBodyPartial
      : outcome === 'quarantine' ? t.doneBodyQuarantine
        : t.doneBodyPark;

  // Honest per-feed breakdown — exactly which feeds the learned map captured
  // (✓ + live row count) vs didn't (✗), so the operator can judge whether the
  // map is usable. Shown for EVERY outcome (especially quarantine, where seeing
  // the missing required feeds is the whole point).
  const feeds = resp.feeds ?? [];
  const gotCount = feeds.filter((f) => f.captured).length;

  return (
    <div>
      <CheckCircle2 size={30} color="var(--green, #22c55e)" style={{ marginBottom: '12px' }} />
      <h2 style={{ fontSize: '21px', marginBottom: '6px', fontWeight: 700 }}>{title}</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '20px', fontSize: '14px', lineHeight: 1.5 }}>{body}</p>

      {feeds.length > 0 && (
        <div style={{ background: 'var(--bg, #f6f7f9)', borderRadius: '10px', padding: '16px', marginBottom: '16px' }}>
          <p style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px 0' }}>
            {`Captured ${gotCount} of ${feeds.length} feeds from ${pms}`}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
            {feeds.map((f) => (
              <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                {f.captured
                  ? <Check size={14} color="var(--green, #22c55e)" style={{ flexShrink: 0 }} />
                  : <span style={{ color: '#c2562e', width: 14, textAlign: 'center', flexShrink: 0, fontWeight: 700 }}>✕</span>}
                <span style={{ color: f.captured ? 'inherit' : 'var(--text-muted)' }}>{f.label}</span>
                <span style={{ marginLeft: 'auto', fontSize: '12px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                  {f.captured
                    ? (f.count != null && f.count > 0 ? String(f.count) : 'captured')
                    : 'not found'}
                </span>
              </div>
            ))}
          </div>
          <p style={{ fontSize: '11.5px', color: 'var(--text-muted)', margin: '10px 0 0', lineHeight: 1.45 }}>
            Numbers fill in once the map goes live. “captured” means the robot learned where the data is.
          </p>
        </div>
      )}

      <LiveNumbersBlock t={t} lang={lang} numbers={resp.numbers} />

      {error && <ErrorBox msg={error} />}

      <button className="btn btn-primary" onClick={onContinue} disabled={advancing} style={{ width: '100%', justifyContent: 'center', marginTop: '4px' }}>
        {advancing ? <Loader2 size={14} className="spin" /> : null}
        {advancing ? '…' : (outcome === 'auto_promote' ? t.continuePlain : t.continueBtn)}
      </button>
    </div>
  );
}

function LiveNumbersBlock({ t, lang, numbers }: { t: MappingStrings; lang: 'en' | 'es'; numbers: MappingNumbers | null }) {
  if (!numbers || !numbers.anyAvailable) {
    return (
      <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: 1.5 }}>
        {t.numbersNone}
      </p>
    );
  }

  const cards: { label: string; main: string; sub?: string }[] = [];
  if (numbers.occupancyPct.available && numbers.occupancyPct.value != null) {
    cards.push({
      label: t.statOccupancy,
      main: `${numbers.occupancyPct.value}%`,
      sub: numbers.occupiedRooms.available && numbers.occupiedRooms.value != null && numbers.totalRooms != null
        ? t.roomsOfTotal.replace('{occ}', String(numbers.occupiedRooms.value)).replace('{total}', String(numbers.totalRooms))
        : undefined,
    });
  } else if (numbers.occupiedRooms.available && numbers.occupiedRooms.value != null) {
    cards.push({ label: t.statOccupancy, main: String(numbers.occupiedRooms.value) });
  }
  if (numbers.arrivalsToday.available && numbers.arrivalsToday.value != null) cards.push({ label: t.statArrivals, main: String(numbers.arrivalsToday.value) });
  if (numbers.departuresToday.available && numbers.departuresToday.value != null) cards.push({ label: t.statDepartures, main: String(numbers.departuresToday.value) });
  if (numbers.guestsInHouse.available && numbers.guestsInHouse.value != null) cards.push({ label: t.statGuests, main: String(numbers.guestsInHouse.value) });

  if (cards.length === 0) {
    return (
      <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: 1.5 }}>
        {t.numbersNone}
      </p>
    );
  }

  const when = numbers.capturedAt ? formatWhen(numbers.capturedAt, lang) : '';
  return (
    <div style={{ marginBottom: '16px' }}>
      <p style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 4px 0' }}>{t.numbersHeading}</p>
      <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '0 0 10px 0' }}>{t.numbersCaption.replace('{when}', when)}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: '8px' }}>
        {cards.map((c) => (
          <div key={c.label} style={{ background: 'var(--bg, #f6f7f9)', border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 12px', textAlign: 'center' }}>
            <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text-primary, #111)' }}>{c.main}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{c.label}</div>
            {c.sub ? <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{c.sub}</div> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatWhen(iso: string, lang: 'en' | 'es'): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  try {
    return ' · ' + d.toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
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
        const res = await fetchWithAuth('/api/onboarding/complete', {
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
      if (e instanceof SessionEndedError) return;  // redirect in progress; suppress error
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      {/* No "← Back" here: the only earlier step is the (completed) mapping
          progress screen — not an editable form — so a back button would land
          on a result screen the operator can't act on. Team is the last
          optional form; "Skip" covers opting out. */}
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
  const [going, setGoing] = useState(false);
  const finalize = async () => {
    setGoing(true);
    try {
      await fetchWithAuth('/api/onboard/wizard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, finalize: true }),
      });
      // Full navigation (not router.push) so PropertyContext re-fetches the
      // property FRESH — now with onboarding_completed_at set. A client-side
      // push would leave the cached (pre-completion) property in context, and
      // the dashboard's onboarding gate would bounce the owner back through
      // the wizard once before settling. A reload lands them cleanly.
      window.location.href = '/dashboard';
    } catch (e) {
      if (e instanceof SessionEndedError) return;  // redirect in progress
      setGoing(false);
    }
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
