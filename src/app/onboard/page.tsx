'use client';


export const dynamic = 'force-dynamic';
/**
 * Phase M1.5 (2026-05-14) — unified onboarding wizard.
 *
 * URL: /onboard?code=XXXX
 *
 * Single page, 6 steps. Replaces the scattered legacy signup and onboarding
 * flow with one resumable wizard. Each
 * step's "Next" handler PATCHes /api/onboard/wizard so the user can
 * close the tab and resume later from the same link.
 *
 * What each step does:
 *   1. Welcome — "You're invited to onboard <Hotel>"
 *   2. Create account — email/name/password (POSTs /api/auth/use-join-code)
 *   3. Verify email — 6-digit OTP (Supabase verifyOtp)
 *   4. Hotel details — confirm/edit name, rooms, timezone, brand, etc.
 *   5. Your hotel — optional free-text context for Staxis
 *   6. All set — celebration screen + "Enter Staxis" finalize
 *
 * Multi-tenancy: the page itself doesn't read property data directly.
 * All reads/writes go through the wizard API which validates the join
 * code on every call. After signup, the user's session is the new
 * first person's session — RLS isolates them from other hotels automatically.
 */

import React, { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import { useReliableNavigation } from '@/lib/hooks/use-reliable-navigation';
import { Loader2, Check, CheckCircle2, AlertCircle, Building2, Mail, Sparkles, ChevronLeft } from 'lucide-react';
import {
  PLACEHOLDER_HOTEL_NAME,
  RESUME_GUARD_KEY,
  resolveOnboardingDisplayStep,
  type OnboardingReviewStep,
  type OnboardingStep,
} from '@/lib/onboarding/state';
import { useLang } from '@/contexts/LanguageContext';
import { ChevronMark } from '@/components/AuthShell';
import { ot } from './_onboard-i18n';
import { SECTION_LIST, resolveSections, type AppSection, type EnabledSections } from '@/lib/sections/registry';

// ─── Types mirroring the wizard API response ───────────────────────────

interface WizardStateResponse {
  propertyId: string;
  propertyName: string;
  currentStep: OnboardingStep;
  completed: boolean;
  state: Record<string, string | number | undefined>;
  hotelDefaults: {
    name: string;
    totalRooms: number | null;
    timezone: string;
    brand: string | null;
    propertyKind: string | null;
    enabledSections: EnabledSections;
  } | null;
  inviteRole: 'owner' | 'general_manager' | null;
  invitedEmail: string | null;
}

interface ApiEnvelope {
  ok?: boolean;
  error?: unknown;
}

/** Require the standard API envelope before advancing a wizard step. */
async function requireApiSuccess<T extends ApiEnvelope = ApiEnvelope>(
  response: Response,
  fallbackMessage: string,
): Promise<T> {
  const body = await response.json().catch(() => null) as T | null;
  if (!response.ok || body?.ok !== true) {
    const errorMessage = typeof body?.error === 'string'
      ? body.error
      : body?.error && typeof body.error === 'object'
        && 'message' in body.error && typeof body.error.message === 'string'
        ? body.error.message
        : fallbackMessage;
    throw new Error(errorMessage);
  }
  return body;
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
  { value: 'America/Phoenix', label: 'Mountain, no DST (Phoenix)' },
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
    <Suspense fallback={<FullPage><Loader2 size={28} className="spin" color="#C99644" /></FullPage>}>
      <OnboardWizard />
    </Suspense>
  );
}

function OnboardWizard() {
  const { push } = useReliableNavigation();
  const sp = useSearchParams();
  const code = sp.get('code')?.toUpperCase().trim() ?? '';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wizard, setWizard] = useState<WizardStateResponse | null>(null);
  const [reviewStep, setReviewStep] = useState<OnboardingReviewStep | null>(null);

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
        // Already done — Home is always available even when Dashboard is off.
        push('/home');
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
  }, [code, push]);

  useEffect(() => { void loadState(); }, [loadState]);

  if (loading) {
    return (
      <FullPage>
        <Loader2 size={28} className="spin" color="#C99644" />
        <p style={{ marginTop: '12px', color: '#5C625C' }}>Loading your invite…</p>
      </FullPage>
    );
  }
  if (error) {
    return (
      <FullPage>
        <AlertCircle size={32} color="#B85C3D" />
        <h1 style={{ fontSize: '20px', marginTop: '16px' }}>Can&apos;t open this invite</h1>
        <p style={{ marginTop: '8px', color: '#5C625C', maxWidth: '400px', textAlign: 'center' }}>{error}</p>
      </FullPage>
    );
  }
  if (!wizard) return null;

  const advance = async () => {
    setReviewStep(null);
    await loadState();
  };
  const displayStep = resolveOnboardingDisplayStep(wizard.currentStep, reviewStep);
  const review = (step: OnboardingReviewStep) => setReviewStep(step);

  return (
    <WizardLayout
      currentStep={wizard.currentStep}
      displayStep={displayStep}
      hotelName={wizard.propertyName}
      onReviewStep={review}
    >
      {displayStep === 1 && (
        <Step1Welcome
          code={code}
          wizard={wizard}
          reviewing={wizard.currentStep > 1}
          onNext={wizard.currentStep > 1 ? async () => review(2) : advance}
        />
      )}
      {displayStep === 2 && wizard.currentStep === 2 && (
        <Step2CreateAccount code={code} wizard={wizard} onNext={advance} />
      )}
      {displayStep === 2 && wizard.currentStep > 2 && (
        <Step2AccountReview
          currentStep={wizard.currentStep}
          onBack={() => review(1)}
          onContinue={() => setReviewStep(null)}
        />
      )}
      {displayStep === 3 && (
        <Step3VerifyEmail code={code} wizard={wizard} onNext={advance} onBack={() => review(2)} />
      )}
      {displayStep === 4 && <Step4HotelDetails code={code} wizard={wizard} onNext={advance} />}
      {displayStep === 5 && <Step5TellUs code={code} wizard={wizard} onNext={advance} />}
      {displayStep === 6 && <Step6AllSet code={code} wizard={wizard} />}
    </WizardLayout>
  );
}

// ─── Layout (progress bar + container) ──────────────────────────────────

const STEP_LABELS = [
  'Welcome', 'Account', 'Verify email', 'About hotel', 'Your hotel', 'Done',
];

// Warm animated mesh + paper grain — the same backdrop the /signin flow uses,
// so the onboarding wizard feels like one continuous branded experience.
function WizardBackdrop() {
  return (
    <>
      <div className="si-blob" style={{ position: 'absolute', top: '-10%', left: '-5%', width: 680, height: 680, background: 'radial-gradient(circle, rgba(201,150,68,0.5) 0%, transparent 60%)', filter: 'blur(60px)', animation: 'si-d1 26s ease-in-out infinite', pointerEvents: 'none' }} />
      <div className="si-blob" style={{ position: 'absolute', bottom: '-15%', left: '10%', width: 720, height: 720, background: 'radial-gradient(circle, rgba(158,183,166,0.55) 0%, transparent 60%)', filter: 'blur(60px)', animation: 'si-d2 30s ease-in-out infinite', pointerEvents: 'none' }} />
      <div className="si-blob" style={{ position: 'absolute', top: '5%', right: '-8%', width: 640, height: 640, background: 'radial-gradient(circle, rgba(184,92,61,0.45) 0%, transparent 60%)', filter: 'blur(60px)', animation: 'si-d3 28s ease-in-out infinite', pointerEvents: 'none' }} />
      <div className="si-blob" style={{ position: 'absolute', bottom: '0%', right: '5%', width: 560, height: 560, background: 'radial-gradient(circle, rgba(123,106,151,0.35) 0%, transparent 62%)', filter: 'blur(60px)', animation: 'si-d4 32s ease-in-out infinite', pointerEvents: 'none' }} />
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.05, mixBlendMode: 'multiply', pointerEvents: 'none' }} aria-hidden="true">
        <filter id="wz-noise"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" /></filter>
        <rect width="100%" height="100%" filter="url(#wz-noise)" />
      </svg>
    </>
  );
}

// Shared style for the wizard: mesh keyframes + rise-in + the caramel input /
// button / label classes every step renders through.
const WIZARD_STYLE = `
  .spin { animation: spin 1.5s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg) } }
  @keyframes si-d1{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(120px,80px) scale(1.1)}}
  @keyframes si-d2{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(-100px,60px) scale(1.15)}}
  @keyframes si-d3{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(80px,-90px) scale(1.05)}}
  @keyframes si-d4{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(-90px,-70px) scale(1.12)}}
  @keyframes si-rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
  .si-rise{animation:si-rise .8s cubic-bezier(0.05,0.7,0.1,1) both}
  .si-d-1{animation-delay:.05s}.si-d-2{animation-delay:.15s}
  .onboard-indeterminate { width: 40%; animation: onboardSlide 1.3s ease-in-out infinite; }
  @keyframes onboardSlide { 0% { margin-left: -40% } 100% { margin-left: 100% } }
  .input { width:100%; height:46px; padding:0 14px; border:1px solid rgba(31,35,28,0.1); border-radius:12px; font-size:15px; box-sizing:border-box; background:rgba(255,255,255,0.7); color:#1F231C; font-family:inherit; outline:none; transition:border-color .18s, box-shadow .18s, background .18s; }
  .input::placeholder { color:#9A9E96; }
  .input:focus { border-color:#C99644; box-shadow:0 0 0 4px rgba(201,150,68,0.16); background:#fff; }
  .btn { padding:0 20px; height:48px; border-radius:12px; border:none; cursor:pointer; font-size:15px; font-weight:600; display:inline-flex; align-items:center; justify-content:center; gap:6px; font-family:inherit; transition:transform .12s, filter .18s; }
  .btn-primary { background:#C99644; color:#fff; box-shadow:0 10px 24px -8px rgba(201,150,68,0.55); }
  .btn-primary:hover { filter:brightness(1.05); }
  .btn-primary:active { transform:scale(.98); }
  .btn-primary:disabled { opacity:0.5; cursor:not-allowed; box-shadow:none; }
  .btn-secondary { background:rgba(255,255,255,0.7); color:#1F231C; border:1px solid rgba(31,35,28,0.12); }
  .btn-secondary:hover { background:#fff; }
  .wizard-back { min-width:44px; min-height:44px; margin-left:-8px; padding:0 12px 0 8px; border:0; border-radius:10px; background:transparent; color:#5C625C; cursor:pointer; display:inline-flex; align-items:center; gap:5px; font:500 13px/1 var(--font-geist),sans-serif; transition:background .15s cubic-bezier(0.2,0,0,1),color .15s cubic-bezier(0.2,0,0,1),transform .1s cubic-bezier(0.2,0,0,1); }
  .wizard-back:hover { background:rgba(31,35,28,0.06); color:#1F231C; }
  .wizard-back:active { background:rgba(31,35,28,0.1); transform:scale(.98); }
  .wizard-back:focus-visible,.wizard-progress-step:focus-visible { outline:2px solid #C99644; outline-offset:2px; }
  .wizard-back:disabled { cursor:default; opacity:.5; transform:none; }
  .wizard-progress-step { appearance:none; border:0; border-radius:12px; background:transparent; padding:4px 2px; margin:-4px -2px; color:inherit; font:inherit; cursor:pointer; transition:background .15s cubic-bezier(0.2,0,0,1),transform .1s cubic-bezier(0.2,0,0,1); }
  .wizard-progress-step:hover { background:rgba(31,35,28,0.06); }
  .wizard-progress-step:active { transform:scale(.98); }
  .label { display:block; font-size:11px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:#5C625C; margin-bottom:6px; }
  @media (prefers-reduced-motion: reduce){ .si-blob{animation:none!important} .si-rise{animation:none!important} .wizard-back,.wizard-progress-step{transition:none!important} }
`;

function WizardLayout({ currentStep, displayStep, hotelName, onReviewStep, children }: {
  currentStep: OnboardingStep;
  displayStep: OnboardingStep;
  hotelName: string;
  onReviewStep: (step: OnboardingReviewStep) => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      position: 'relative', minHeight: '100dvh', overflow: 'hidden',
      background: '#F2EFE8', fontFamily: 'var(--font-geist), sans-serif',
      padding: '48px 20px',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
    }}>
      <WizardBackdrop />

      <div style={{ position: 'relative', width: '100%', maxWidth: 620 }}>
        {/* Brand + hotel header */}
        <div className="si-rise si-d-1" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 24, textAlign: 'center' }}>
          <ChevronMark size={30} color="#1A1F1B" />
          <h1 style={{ fontFamily: 'var(--font-instrument-serif), Georgia, serif', fontSize: 38, lineHeight: 1, fontWeight: 400, color: '#1F231C', margin: '8px 0 0', letterSpacing: '-0.01em' }}>
            Staxis
          </h1>
          <p style={{ fontSize: 13.5, color: '#5C625C', marginTop: 6 }}>Setting up {hotelName}</p>
        </div>

        {/* Progress steps */}
        <div className="si-rise si-d-2" style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          marginBottom: 20, overflow: 'auto', gap: 4,
        }}>
          {STEP_LABELS.map((label, i) => {
            const stepNum = i + 1;
            const isPast = stepNum < currentStep;
            const isDisplayed = stepNum === displayStep;
            const isCurrent = stepNum === currentStep;
            const canReview = isPast && (stepNum === 1 || stepNum === 2);
            const content = (
              <>
                <div style={{
                  width: 26, height: 26, borderRadius: '50%',
                  background: isPast ? '#C99644' : isCurrent ? '#1F231C' : 'rgba(31,35,28,0.06)',
                  border: (isPast || isCurrent) ? 'none' : '1px solid rgba(31,35,28,0.15)',
                  color: (isPast || isCurrent) ? '#fff' : '#9A9E96',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: 600,
                  boxShadow: isPast ? '0 4px 10px -4px rgba(201,150,68,0.6)' : 'none',
                  outline: isDisplayed && isPast ? '2px solid #1F231C' : 'none',
                  outlineOffset: 2,
                }}>
                  {isPast ? <Check size={14} /> : stepNum}
                </div>
                <span style={{
                  fontSize: 10, marginTop: 5,
                  color: isDisplayed ? '#1F231C' : '#8A8F88',
                  fontWeight: isDisplayed ? 600 : 400, textAlign: 'center',
                }}>{label}</span>
              </>
            );
            const stepStyle: React.CSSProperties = {
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              flex: 1, minWidth: 44, position: 'relative',
            };
            return canReview ? (
              <button
                key={label}
                type="button"
                className="wizard-progress-step"
                style={stepStyle}
                aria-label={`Review ${label} step`}
                aria-current={isDisplayed ? 'step' : undefined}
                onClick={() => onReviewStep(stepNum as OnboardingReviewStep)}
              >
                {content}
              </button>
            ) : (
              <div key={label} style={stepStyle} aria-current={isDisplayed ? 'step' : undefined}>
                {content}
              </div>
            );
          })}
        </div>

        {/* Step content — frosted glass card. color:#1F231C anchors all
            descendant text dark so the warm light card is theme-independent. */}
        <div className="si-rise si-d-2" style={{
          position: 'relative', color: '#1F231C',
          background: 'rgba(255,255,255,0.55)',
          backdropFilter: 'blur(28px) saturate(150%)', WebkitBackdropFilter: 'blur(28px) saturate(150%)',
          border: '1px solid rgba(255,255,255,0.7)', borderRadius: 24,
          padding: 32,
          boxShadow: '0 30px 70px -30px rgba(31,35,28,0.35), 0 1px 0 rgba(255,255,255,0.8) inset',
        }}>
          {children}
        </div>
      </div>

      <style>{WIZARD_STYLE}</style>
    </div>
  );
}

function FullPage({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: 'relative', minHeight: '100dvh', overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', padding: '20px',
      background: '#F2EFE8', fontFamily: 'var(--font-geist), sans-serif',
      color: '#1F231C', textAlign: 'center',
    }}>
      <WizardBackdrop />
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {children}
      </div>
      <style>{`
        .spin { animation: spin 1.5s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes si-d1{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(120px,80px) scale(1.1)}}
        @keyframes si-d2{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(-100px,60px) scale(1.15)}}
        @keyframes si-d3{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(80px,-90px) scale(1.05)}}
        @keyframes si-d4{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(-90px,-70px) scale(1.12)}}
        @media (prefers-reduced-motion: reduce){ .si-blob{animation:none!important} }
      `}</style>
    </div>
  );
}

function WizardReviewBackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="wizard-back" onClick={onClick} style={{ marginBottom: '12px' }}>
      <ChevronLeft size={15} aria-hidden="true" />
      {label}
    </button>
  );
}

// ─── Step 1: Welcome ────────────────────────────────────────────────────

function Step1Welcome({ code, wizard, reviewing = false, onNext }: {
  code: string;
  wizard: WizardStateResponse;
  reviewing?: boolean;
  onNext: () => Promise<void>;
}) {
  const { lang } = useLang();
  const o = ot(lang);
  const role = wizard.inviteRole === 'general_manager' ? 'General Manager' : 'Owner';
  const [starting, setStarting] = useState(false);
  // The welcome→account hop has no completion timestamp, so "Begin"
  // persists `step: 2` explicitly — deriveCurrentStep honors exactly that
  // value pre-account. Without this PATCH the refetch re-derives step 1
  // forever and the button appears dead.
  const begin = async () => {
    setStarting(true);
    try {
      if (!reviewing) {
        await fetch('/api/onboard/wizard', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, partialState: { step: 2 } }),
        });
      }
      await onNext();
    } finally {
      setStarting(false);
    }
  };
  return (
    <div>
      <Building2 size={32} color="#C99644" style={{ marginBottom: '16px' }} />
      <h2 style={{ fontSize: '22px', margin: '0 0 8px 0', fontWeight: 700 }}>
        You&apos;re invited to set up {wizard.propertyName}
      </h2>
      <p style={{ color: '#5C625C', marginBottom: '24px', lineHeight: 1.5 }}>
        You&apos;ve been added as the <strong>{role}</strong> for {wizard.propertyName} on Staxis, the AI-powered operations platform that runs your housekeeping, inventory, and labor planning in the background.
      </p>
      <p style={{ color: '#5C625C', marginBottom: '32px', lineHeight: 1.5, fontSize: '13px' }}>
        {o.welcomeSteps}
      </p>
      <button className="btn btn-primary" onClick={begin} disabled={starting} style={{ width: '100%', justifyContent: 'center' }}>
        {starting ? (reviewing ? o.continuingEllipsis : o.startingEllipsis) : (reviewing ? o.continueArrow : o.beginArrow)}
      </button>
    </div>
  );
}

// ─── Step 2: Create account ─────────────────────────────────────────────

function Step2CreateAccount({ code, wizard, onNext }: { code: string; wizard: WizardStateResponse; onNext: () => Promise<void>; }) {
  const { lang } = useLang();
  const o = ot(lang);
  const email = wizard.invitedEmail?.trim().toLowerCase() ?? '';
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // When the account already exists (e.g. the operator dropped the tab right
  // after creating it, then reopened the link), the redeem returns "already
  // exists / code used up". Instead of a dead-end error, offer to sign in —
  // signing in routes them back into the wizard at the right step via the
  // login funnel (/api/onboard/resume), now that account creation persists
  // accountCreatedAt server-side.
  const [showSignIn, setShowSignIn] = useState(false);

  const submit = async () => {
    setErr(null);
    setShowSignIn(false);
    if (!email.includes('@')) { setErr('Valid email required.'); return; }
    if (displayName.trim().length < 2) { setErr('Name required.'); return; }
    if (password.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    setSubmitting(true);
    try {
      // Create the account via the existing use-join-code endpoint.
      // The hotel's People invitation has the Owner/GM role baked in. The
      // invitee cannot send or choose a different role here.
      const res = await fetch('/api/auth/use-join-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, email, displayName, password, phone }),
      });
      const json = await res.json() as {
        ok?: boolean;
        error?: string;
        data?: { twoFactorEnabled?: boolean };
      };
      if (!res.ok || !json.ok) {
        const msg: string = json.error || `Sign-up failed (${res.status})`;
        // "already exists" / "used up" → the account is already created; route
        // to sign-in (a resumable recovery). A CAS-race "being used by another
        // signup" is NOT this case — keep that as a plain retry error.
        const lower = msg.toLowerCase();
        if ((lower.includes('already exists') || lower.includes('used up')) &&
            !lower.includes('another signup')) {
          setShowSignIn(true);
        }
        setErr(msg);
        return;
      }

      // Global human-2FA switch OFF: the account was created ready to sign in
      // (email already confirmed), so sign in with the password the user just
      // typed and mark the email step done — the wizard derives its step from
      // server state, so it skips straight to hotel details, no code screen.
      // Fail-safe: ONLY an explicit `false` takes this path; a missing/odd
      // value or a failed password sign-in falls through to the OTP flow.
      if (json.data?.twoFactorEnabled === false) {
        const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password,
        });
        if (!signInErr && signInData.session) {
          const verifiedProgress = await fetchWithAuth('/api/onboard/wizard', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              code,
              partialState: {
                accountCreatedAt: new Date().toISOString(),
                emailVerifiedAt: new Date().toISOString(),
              },
            }),
          });
          await requireApiSuccess(verifiedProgress, 'Could not save account progress. Please try again.');
          sessionStorage.removeItem('onboard:pendingEmail');
          await onNext();
          return;
        }
        console.warn('onboard: post-signup signInWithPassword failed — falling back to OTP', signInErr);
      }

      // Trigger the OTP email send. (2FA on, or the fast path above failed.)
      // Supabase resolves auth errors in the returned object, so awaiting
      // alone is not a success check.
      const { error: otpErr } = await supabase.auth.signInWithOtp({ email });
      if (otpErr) throw otpErr;
      // PATCH wizard state
      const wizardRes = await fetch('/api/onboard/wizard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          partialState: { accountCreatedAt: new Date().toISOString() },
        }),
      });
      await requireApiSuccess(wizardRes, 'Could not save account progress. Please try again.');
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
      <p style={{ color: '#5C625C', marginBottom: '20px', fontSize: '13px' }}>
        This is the login you&apos;ll use to manage {wizard.propertyName}.
      </p>
      {err && <ErrorBox msg={err} />}
      {showSignIn && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => { window.location.href = '/signin'; }}
          style={{ width: '100%', justifyContent: 'center', marginBottom: '14px' }}
        >
          {o.resumeSignInBtn}
        </button>
      )}
      <Field label="Assigned role">
        <div style={{
          minHeight: 46, padding: '0 14px', display: 'flex', alignItems: 'center',
          border: '1px solid rgba(31,35,28,0.1)', borderRadius: 12,
          background: 'rgba(255,255,255,0.45)', fontSize: 15, fontWeight: 600,
        }}>
          {wizard.inviteRole === 'general_manager' ? 'General Manager' : 'Owner'}
        </div>
      </Field>
      <Field label="Email *">
        <input className="input" type="email" value={email} readOnly aria-readonly="true" />
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

function Step2AccountReview({ currentStep, onBack, onContinue }: {
  currentStep: OnboardingStep;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { lang } = useLang();
  const o = ot(lang);
  const pendingEmail = typeof window !== 'undefined'
    ? sessionStorage.getItem('onboard:pendingEmail') ?? ''
    : '';

  return (
    <div>
      <WizardReviewBackButton label={o.backToWelcome} onClick={onBack} />
      <CheckCircle2 size={32} color="#C99644" style={{ marginBottom: '16px' }} />
      <h2 style={{ fontSize: '20px', marginBottom: '4px' }}>{o.accountReadyTitle}</h2>
      <p style={{ color: '#5C625C', marginBottom: pendingEmail ? '16px' : '24px', fontSize: '13px', lineHeight: 1.5 }}>
        {o.accountReadyBody}
      </p>
      {pendingEmail && (
        <div style={{
          padding: '12px 14px', marginBottom: '24px', borderRadius: '12px',
          border: '1px solid rgba(31,35,28,0.1)', background: 'rgba(255,255,255,0.58)',
        }}>
          <span className="label" style={{ marginBottom: '4px' }}>{o.accountEmailLabel}</span>
          <strong style={{ fontSize: '14px', overflowWrap: 'anywhere' }}>{pendingEmail}</strong>
        </div>
      )}
      <button className="btn btn-primary" type="button" onClick={onContinue} style={{ width: '100%', justifyContent: 'center' }}>
        {currentStep === 3 ? o.continueToVerify : o.continueSetup}
      </button>
    </div>
  );
}

// ─── Step 3: Verify email ───────────────────────────────────────────────

function Step3VerifyEmail({ code, wizard, onNext, onBack }: {
  code: string;
  wizard: WizardStateResponse;
  onNext: () => Promise<void>;
  onBack: () => void;
}) {
  const { lang } = useLang();
  const o = ot(lang);
  const [otp, setOtp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
  const invitedEmail = wizard.invitedEmail?.trim().toLowerCase() ?? '';
  const pendingEmail = typeof window !== 'undefined'
    ? sessionStorage.getItem('onboard:pendingEmail')?.trim().toLowerCase() ?? ''
    : '';
  // Tab closed + reopened → the tab-scoped OTP marker is gone even though the
  // durable invited email remains available for display. We can't re-issue the
  // OTP (the password proof minted at account creation expires in 60 min, so a
  // stale OTP would 403 at trust-device).
  // Route them to sign in instead: password sign-in writes a fresh proof, and
  // the wizard GET's emailVerified backfill auto-advances a signed-in owner
  // past this step. (accountCreatedAt is now persisted server-side at signup,
  // so the login funnel routes them right back here.)
  const recovered = !pendingEmail;

  const submit = async () => {
    setErr(null);
    setShowSignIn(false);
    if (otp.length < 6) { setErr('Enter the 6-digit code from your email.'); return; }
    if (!pendingEmail) { setErr('Missing email. Refresh and try again.'); return; }
    setSubmitting(true);
    try {
      const { data, error } = await supabase.auth.verifyOtp({ email: pendingEmail, token: otp, type: 'email' });
      if (error || !data.session) { setErr(error?.message ?? 'Verification failed. Try the code again.'); return; }

      // CRITICAL: trust this device, exactly like /signin/verify does.
      // The OTP gives a valid session, but the server's 2FA layer
      // (requireSession) ALSO requires a `staxis_device` cookie on the
      // first authenticated save (step 4's propertyUpdates PATCH). Without
      // this call the cookie is never issued, requireSession returns
      // requires_2fa → fetchWithAuth signs the user out ("Your session
      // ended") mid-wizard. The onboarding flow skipped this step entirely.
      try {
        const trustRes = await fetch('/api/auth/trust-device', {
          method: 'POST',
          headers: { Authorization: `Bearer ${data.session.access_token}` },
          credentials: 'include',
        });
        await requireApiSuccess(trustRes, 'Could not secure this device.');
        // Refresh so the JWT carries the mfa_verified claim the auth hook
        // mints (needed for the dashboard's RLS/realtime reads later).
        const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
        if (refreshErr || !refreshed.session) {
          throw refreshErr ?? new Error('No refreshed session returned');
        }
      } catch (trustErr) {
        // Surface, don't swallow — a failed trust here is exactly what
        // caused the silent "session ended" before. The most common real
        // cause is an expired sign-up password proof (>60 min after account
        // creation), which OTP can't refresh — point them at sign-in, which
        // mints a fresh proof and resumes the wizard via the login funnel.
        setErr(o.sessionExpiredError);
        setShowSignIn(true);
        console.warn('onboard trust-device failed', trustErr);
        return;
      }

      const verifiedRes = await fetchWithAuth('/api/onboard/wizard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          partialState: { emailVerifiedAt: new Date().toISOString() },
        }),
      });
      await requireApiSuccess(verifiedRes, 'Could not save email verification. Please try again.');
      sessionStorage.removeItem('onboard:pendingEmail');
      await onNext();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Verify failed');
    } finally {
      setSubmitting(false);
    }
  };

  // Recovered tab: no fresh OTP context to verify against. Offer sign-in,
  // which resumes the wizard cleanly (see `recovered` note above).
  if (recovered) {
    return (
      <div>
        <WizardReviewBackButton label={o.backToAccount} onClick={onBack} />
        <Mail size={32} color="#C99644" style={{ marginBottom: '16px' }} />
        <h2 style={{ fontSize: '20px', marginBottom: '4px' }}>{o.resumeTitle}</h2>
        <p style={{ color: '#5C625C', marginBottom: '20px', fontSize: '13px', lineHeight: 1.5 }}>
          {o.resumeBody}
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => { window.location.href = '/signin'; }}
          style={{ width: '100%', justifyContent: 'center' }}
        >
          {o.resumeSignInBtn}
        </button>
      </div>
    );
  }

  return (
    <div>
      <WizardReviewBackButton label={o.backToAccount} onClick={onBack} />
      <Mail size={32} color="#C99644" style={{ marginBottom: '16px' }} />
      <h2 style={{ fontSize: '20px', marginBottom: '4px' }}>Check your email</h2>
      <p style={{ color: '#5C625C', marginBottom: '20px', fontSize: '13px' }}>
        We sent a 6-digit code to <strong>{invitedEmail || pendingEmail || 'your email'}</strong>.
      </p>
      {err && <ErrorBox msg={err} />}
      {showSignIn && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => { window.location.href = '/signin'; }}
          style={{ width: '100%', justifyContent: 'center', marginBottom: '14px' }}
        >
          {o.resumeSignInBtn}
        </button>
      )}
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
  // Per-hotel app on/off (WP4). Full 8-key map, default ALL ON. Re-hydrated on
  // back-nav from hotelDefaults.enabledSections (resolveSections fills every
  // missing key with its default-ON value, so a hotel with no stored map here
  // shows all 8 apps checked).
  const [enabledSections, setEnabledSections] = useState<Record<AppSection, boolean>>(
    () => resolveSections(d?.enabledSections ?? null),
  );
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
            enabled_sections: enabledSections,
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
      <Building2 size={28} color="#C99644" style={{ marginBottom: '12px' }} />
      <h2 style={{ fontSize: '20px', marginBottom: '4px' }}>About your hotel</h2>
      <p style={{ color: '#5C625C', marginBottom: '20px', fontSize: '13px' }}>
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
          <option value="">Select…</option>
          {REGION_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </Field>

      <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid rgba(0,0,0,0.08)' }}>
        <label className="label">
          {'Which apps do you want in your hotel app?'}
        </label>
        <p style={{ color: '#5C625C', fontSize: '12px', margin: '2px 0 12px' }}>
          {'All are on by default. Turn off any you don’t need. You can change this anytime later.'}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {SECTION_LIST.map((m) => {
            const on = enabledSections[m.key];
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => setEnabledSections((prev) => ({ ...prev, [m.key]: !prev[m.key] }))}
                aria-pressed={on}
                style={{
                  display: 'flex', alignItems: 'center', gap: '12px',
                  width: '100%', textAlign: 'left', cursor: 'pointer',
                  padding: '10px 12px', borderRadius: '10px',
                  background: on ? 'rgba(201,150,68,0.08)' : 'transparent',
                  border: `1px solid ${on ? 'rgba(201,150,68,0.35)' : 'rgba(0,0,0,0.10)'}`,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0, width: '38px', height: '22px', borderRadius: '999px',
                    background: on ? '#C99644' : '#C9CEC9',
                    position: 'relative', transition: 'background 0.15s',
                  }}
                >
                  <span style={{
                    position: 'absolute', top: '2px', left: on ? '18px' : '2px',
                    width: '18px', height: '18px', borderRadius: '999px', background: '#fff',
                    transition: 'left 0.15s',
                  }} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: '14px', fontWeight: 600, color: '#1B1F1B' }}>
                    {m.label_en}
                  </span>
                  <span style={{ display: 'block', fontSize: '12px', color: '#5C625C' }}>
                    {m.desc_en}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <button className="btn btn-primary" onClick={submit} disabled={submitting} style={{ width: '100%', justifyContent: 'center', marginTop: '12px' }}>
        {submitting ? 'Saving…' : 'Save & continue →'}
      </button>
    </div>
  );
}

// ─── Step 5: Tell Staxis about your hotel (optional, skippable) ─────────
//
// The same open box that lives on the Knows screen (/feed → Knows), offered
// once during setup while the first person is already thinking about the hotel.
//
// Rules this step obeys, deliberately:
//   • It never blocks. Skip always advances, and it advances even if the
//     extraction call fails — an outage in an optional nicety must not strand
//     someone in a signup wizard.
//   • It never silently swallows what they typed. A failure keeps the text on
//     screen with an honest message and Skip still available.
//   • Whatever it extracts lands UNCONFIRMED (source='inferred'), exactly like
//     a paste on the Knows screen. Typing it during setup does not make it
//     established truth.

function Step5TellUs({ code, wizard, onNext }: {
  code: string;
  wizard: WizardStateResponse;
  onNext: () => Promise<void>;
}) {
  const { lang } = useLang();
  const o = ot(lang);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const markDone = async () => {
    const res = await fetchWithAuth('/api/onboard/wizard', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        partialState: { hotelContextAt: new Date().toISOString() },
      }),
    });
    await requireApiSuccess(res, 'Could not save progress. Please try again.');
    await onNext();
  };

  const skip = async () => {
    setErr(null);
    setSubmitting(true);
    try {
      await markDone();
    } catch (e) {
      if (e instanceof SessionEndedError) return;
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  const submit = async () => {
    const text = note.trim();
    if (!text) { await skip(); return; }
    setErr(null);
    setSubmitting(true);
    try {
      const res = await fetchWithAuth('/api/memory/knows/intake', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ propertyId: wizard.propertyId, note: text }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        // Keep their words on screen; Skip is still right there.
        setErr(o.contextFailed);
        return;
      }
      await markDone();
    } catch (e) {
      if (e instanceof SessionEndedError) return;
      setErr(o.contextFailed);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <Sparkles size={28} color="#C99644" style={{ marginBottom: '12px' }} />
      <h2 style={{ fontSize: '20px', marginBottom: '4px' }}>{o.contextTitle}</h2>
      <p style={{ color: '#5C625C', marginBottom: '16px', fontSize: '13px' }}>{o.contextBody}</p>
      {err && <ErrorBox msg={err} />}
      <textarea
        className="input"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={o.contextPlaceholder}
        aria-label={o.contextTitle}
        maxLength={8000}
        rows={5}
        style={{ width: '100%', minHeight: '110px', resize: 'vertical', lineHeight: 1.5 }}
      />
      <p style={{ color: '#8A8F88', fontSize: '11.5px', marginTop: '8px', lineHeight: 1.45 }}>
        {o.contextNote}
      </p>
      <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
        <button className="btn btn-secondary" onClick={skip} disabled={submitting} style={{ flex: 1, justifyContent: 'center' }}>
          {o.contextSkip}
        </button>
        <button className="btn btn-primary" onClick={submit} disabled={submitting} style={{ flex: 1, justifyContent: 'center' }}>
          {submitting ? o.contextSubmitting : o.contextSubmit}
        </button>
      </div>
    </div>
  );
}

// ─── Step 6: All set ───────────────────────────────────────────────────

function Step6AllSet({ code, wizard }: { code: string; wizard: WizardStateResponse; }) {
  const [going, setGoing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const finalize = async () => {
    setGoing(true);
    setErr(null);
    try {
      const finalizeRes = await fetchWithAuth('/api/onboard/wizard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, finalize: true }),
      });
      await requireApiSuccess(finalizeRes, 'Could not finish setup. Please try again.');
      // Full navigation (not router.push) so PropertyContext re-fetches the
      // property FRESH — now with onboarding_completed_at set. A client-side
      // push would leave the cached (pre-completion) property in context, and
      // a cached onboarding gate could bounce the owner back through the wizard
      // once before settling. A reload lands them cleanly on the Home hub.
      window.location.href = '/home';
    } catch (e) {
      if (e instanceof SessionEndedError) return;  // redirect in progress
      setErr(e instanceof Error ? e.message : 'Could not finish setup. Please try again.');
      setGoing(false);
    }
  };

  return (
    <div>
      <Sparkles size={32} color="#C99644" style={{ marginBottom: '16px' }} />
      <h2 style={{ fontSize: '22px', margin: '0 0 8px 0', fontWeight: 700 }}>You&apos;re all set!</h2>
      <p style={{ color: '#5C625C', marginBottom: '16px', lineHeight: 1.5 }}>
        Welcome to Staxis. {wizard.propertyName} is ready.
      </p>
      {err && <ErrorBox msg={err} />}
      <div style={{ background: 'rgba(201,150,68,0.10)', borderRadius: '8px', padding: '14px', marginBottom: '16px' }}>
        <p style={{ fontSize: '13px', margin: 0, lineHeight: 1.5 }}>
          {'✓ Your inventory starts empty. Add your own items anytime in the Inventory tab.'}
        </p>
        <p style={{ fontSize: '13px', margin: '8px 0 0 0', lineHeight: 1.5 }}>
          ✓ Once your housekeepers start cleaning rooms, the AI will start predicting your needs. Usually within 7 days.
        </p>
      </div>
      <button className="btn btn-primary" onClick={finalize} disabled={going} style={{ width: '100%', justifyContent: 'center' }}>
        {going ? 'Entering…' : 'Enter Staxis →'}
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
      background: 'rgba(184,92,61,0.10)', border: '1px solid rgba(184,92,61,0.25)',
      borderRadius: '10px',
      color: '#B85C3D', fontSize: '13px',
    }}>
      <AlertCircle size={14} />
      {msg}
    </div>
  );
}
