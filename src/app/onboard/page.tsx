'use client';


export const dynamic = 'force-dynamic';
/**
 * Phase M1.5 (2026-05-14) — unified onboarding wizard.
 *
 * URL: /onboard?code=XXXX
 *
 * Single page, 8 steps. Replaces the scattered /signup → /signin/verify
 * → /onboarding → /settings/pms flow with one resumable wizard. Each
 * step's "Next" handler PATCHes /api/onboard/wizard so the user can
 * close the tab and resume later from the same link.
 *
 * What each step does:
 *   1. Welcome — "You're invited to onboard <Hotel>"
 *   2. Create account — email/name/password (POSTs /api/auth/use-join-code)
 *   3. Verify email — 6-digit OTP (Supabase verifyOtp)
 *   4. Hotel details — confirm/edit name, rooms, timezone, brand, etc.
 *   5. Connect PMS — credentials + test (POSTs /api/pms/save-credentials
 *      + /api/pms/onboard)
 *   6. Mapping — live progress bar of CUA job (polls /api/pms/job-status)
 *   7. Add team — optional 0-5 staff rows
 *   8. All set — celebration screen + "Go to home" finalize
 *
 * (The former Step 5 "Which services?" toggle screen was removed — every
 * app now always appears in the nav and auto-lights based on real usage,
 * so there's nothing to pick up front.)
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
import { Loader2, Check, CheckCircle2, AlertCircle, Building2, Mail, KeyRound, Users, Sparkles, ChevronLeft } from 'lucide-react';
import {
  PLACEHOLDER_HOTEL_NAME,
  RESUME_GUARD_KEY,
  resolveOnboardingDisplayStep,
  type OnboardingReviewStep,
  type OnboardingStep,
} from '@/lib/onboarding/state';
import { useLang } from '@/contexts/LanguageContext';
import { ChevronMark } from '@/components/AuthShell';
import { mt, MILESTONES, milestoneIndexForLabel, milestoneLabel, type MappingStrings } from './_mapping-i18n';
import { ot } from './_onboard-i18n';
import { PMS_DROPDOWN_OPTIONS } from '@/lib/pms';
import { SECTION_LIST, resolveSections, type AppSection, type EnabledSections } from '@/lib/sections/registry';

// PMS dropdown options come from the registry (src/lib/pms/registry.ts) — the
// same single source of truth /settings/pms uses, so the wizard, the type
// system, and the DB constraint stay in sync. Includes "Other / Not Listed".
const PMS_PICKER_OPTIONS = PMS_DROPDOWN_OPTIONS.map((d) => ({
  value: d.id,
  label: `${d.label}${d.hint ? ` (${d.hint})` : ''}`,
  defaultLoginUrl: d.defaultLoginUrl,
}));

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
    pmsType: string | null;
    servicesEnabled: Record<string, boolean> | null;
    enabledSections: EnabledSections;
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
    <Suspense fallback={<FullPage><Loader2 size={28} className="spin" color="#C99644" /></FullPage>}>
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
        router.push('/home');
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
      {displayStep === 5 && <Step6ConnectPms code={code} wizard={wizard} onNext={advance} />}
      {displayStep === 6 && <Step7Mapping code={code} onNext={advance} />}
      {displayStep === 7 && <Step8AddTeam code={code} wizard={wizard} onNext={advance} />}
      {displayStep === 8 && <Step9AllSet code={code} wizard={wizard} />}
    </WizardLayout>
  );
}

// ─── Layout (progress bar + container) ──────────────────────────────────

const STEP_LABELS = [
  'Welcome', 'Account', 'Verify email', 'Hotel',
  'PMS', 'Mapping', 'Team', 'Done',
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
        className="wizard-back"
        onClick={goBack}
        disabled={backing}
        style={{
          cursor: backing ? 'default' : 'pointer',
          opacity: backing ? 0.5 : 1,
        }}
      >
        {backing ? <Loader2 size={14} className="spin" /> : <ChevronLeft size={15} />} Back
      </button>
      {failed && (
        <span style={{ marginLeft: '8px', fontSize: '12px', color: '#B85C3D' }}>
          Couldn&apos;t go back — try again.
        </span>
      )}
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
        You&apos;ve been added as the <strong>{role}</strong> for {wizard.propertyName} on Staxis — the AI-powered operations platform that runs your housekeeping, inventory, and labor planning in the background.
      </p>
      <p style={{ color: '#5C625C', marginBottom: '32px', lineHeight: 1.5, fontSize: '13px' }}>
        {o.welcomeSteps}
      </p>
      <button className="btn btn-primary" onClick={begin} disabled={starting} style={{ width: '100%', justifyContent: 'center' }}>
        {starting ? (reviewing ? 'Continuing…' : 'Starting…') : (reviewing ? 'Continue →' : 'Begin →')}
      </button>
    </div>
  );
}

// ─── Step 2: Create account ─────────────────────────────────────────────

function Step2CreateAccount({ code, wizard, onNext }: { code: string; wizard: WizardStateResponse; onNext: () => Promise<void>; }) {
  const { lang } = useLang();
  const o = ot(lang);
  const [email, setEmail] = useState('');
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
      // Per Phase M1.5 commit 5: if the join code has role=owner baked
      // in (which all admin-created codes do), use-join-code transfers
      // properties.owner_id to the new owner.
      const res = await fetch('/api/auth/use-join-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, email, displayName, password, phone, role: 'front_desk' /* ignored, baked-in role wins */ }),
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
          await fetch('/api/onboard/wizard', {
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
          sessionStorage.removeItem('onboard:pendingEmail');
          await onNext();
          return;
        }
        console.warn('onboard: post-signup signInWithPassword failed — falling back to OTP', signInErr);
      }

      // Trigger the OTP email send. (2FA on, or the fast path above failed.)
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

function Step3VerifyEmail({ code, onNext, onBack }: {
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
  const pendingEmail = typeof window !== 'undefined' ? sessionStorage.getItem('onboard:pendingEmail') ?? '' : '';
  // Tab closed + reopened → sessionStorage email is gone and there's no active
  // session. We can't re-issue the OTP (the password proof minted at account
  // creation expires in 60 min, so a stale OTP would 403 at trust-device).
  // Route them to sign in instead: password sign-in writes a fresh proof, and
  // the wizard GET's emailVerified backfill auto-advances a signed-in owner
  // past this step. (accountCreatedAt is now persisted server-side at signup,
  // so the login funnel routes them right back here.)
  const recovered = !pendingEmail;

  const submit = async () => {
    setErr(null);
    setShowSignIn(false);
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
        // caused the silent "session ended" before. The most common real
        // cause is an expired sign-up password proof (>60 min after account
        // creation), which OTP can't refresh — point them at sign-in, which
        // mints a fresh proof and resumes the wizard via the login funnel.
        setErr(o.sessionExpiredError);
        setShowSignIn(true);
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

  // Recovered tab: no email + no session to verify against. Offer sign-in,
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
        We sent a 6-digit code to <strong>{pendingEmail || 'your email'}</strong>.
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
  const { lang } = useLang();
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
          <option value="">— Select —</option>
          {REGION_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </Field>

      <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid rgba(0,0,0,0.08)' }}>
        <label className="label">
          {lang === 'es' ? '¿Qué aplicaciones quieres en la app de tu hotel?' : 'Which apps do you want in your hotel app?'}
        </label>
        <p style={{ color: '#5C625C', fontSize: '12px', margin: '2px 0 12px' }}>
          {lang === 'es'
            ? 'Todas están activas por defecto. Desactiva las que no necesites — puedes cambiarlo después.'
            : 'All are on by default. Turn off any you don’t need — you can change this anytime later.'}
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
                    {lang === 'es' ? m.label_es : m.label_en}
                  </span>
                  <span style={{ display: 'block', fontSize: '12px', color: '#5C625C' }}>
                    {lang === 'es' ? m.desc_es : m.desc_en}
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

// ─── Step 5: Connect PMS ────────────────────────────────────────────────

function Step6ConnectPms({ code, wizard, onNext }: { code: string; wizard: WizardStateResponse; onNext: () => Promise<void>; }) {
  const { lang } = useLang();
  const o = ot(lang);
  // Default to the saved choice (back-nav) or the empty placeholder so the
  // operator must consciously pick — the picker now lists every supported PMS
  // plus "Other / Not Listed", not just Choice Advantage.
  const [pmsType, setPmsType] = useState(wizard.hotelDefaults?.pmsType ?? '');
  // Free-text name when "Other" is chosen — re-hydrated on back-nav from the
  // persisted onboarding_state (owner sessions get the full state on GET).
  const [otherName, setOtherName] = useState(
    typeof wizard.state?.pmsOtherName === 'string' ? wizard.state.pmsOtherName : '',
  );
  const [loginUrl, setLoginUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // True once /api/pms/save-credentials has run for this property (this wizard
  // session OR a prior one whose pms_type is already persisted). When set we
  // HIDE the Skip button: skipping would only write pmsSkippedAt and orphan the
  // already-provisioned scraper_session + property_sessions row + credentials —
  // finalizing a "no PMS" hotel that still has a live robot. Skip is only for a
  // clean slate; to abandon an entered PMS, correct it or detach from Settings.
  const [pmsProvisioned, setPmsProvisioned] = useState(false);
  const pmsAlreadyEntered = pmsProvisioned || !!wizard.hotelDefaults?.pmsType;

  // Picking a PMS prefills its standard login URL (mirrors /settings/pms) when
  // the field is still empty — saves typing for the common case; editable after.
  const handlePmsTypeChange = (value: string) => {
    setPmsType(value);
    const def = PMS_PICKER_OPTIONS.find((p) => p.value === value);
    if (def?.defaultLoginUrl && !loginUrl) setLoginUrl(def.defaultLoginUrl);
  };

  const submit = async () => {
    setErr(null);
    if (!pmsType) { setErr(o.pmsRequired); return; }
    const customName = otherName.trim();
    if (pmsType === 'other' && !customName) { setErr(o.pmsOtherRequired); return; }
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
      // Credentials + a scraper_session/property_sessions row now exist for this
      // property — hide Skip so it can't orphan them (see pmsProvisioned above).
      setPmsProvisioned(true);

      // 2. Queue onboarding job
      const jobRes = await fetchWithAuth('/api/pms/onboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ propertyId: wizard.propertyId }),
      });
      const jobJson = await jobRes.json();
      if (!jobRes.ok || !jobJson.ok) { setErr(jobJson.error || 'Onboarding queue failed'); return; }

      // 3. PATCH wizard state with the job ID (+ the typed name when "Other",
      //    so it's persisted — the registry only knows the generic `other` id).
      //    Server clamps pmsOtherName length defensively.
      await fetch('/api/onboard/wizard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          partialState: {
            pmsCredentialsAt: new Date().toISOString(),
            pmsJobId: jobJson.data.jobId,
            ...(pmsType === 'other' ? { pmsOtherName: customName } : {}),
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

  // Skip PMS entirely — no credentials, no CUA robot. The hotel goes live with
  // no PMS ("No system detected"); pmsSkippedAt satisfies the connect + mapping
  // gates so the wizard jumps straight to Team. For inventory-only properties.
  const skipPms = async () => {
    setErr(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/onboard/wizard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          partialState: { pmsSkippedAt: new Date().toISOString() },
        }),
      });
      // A failed PATCH (expired code, validation, server hiccup) would otherwise
      // be a silent dead-click — surface it and stay on the step, like submit().
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setErr(j?.error || 'Could not skip — please try again.');
        return;
      }
      await onNext();
    } catch (e) {
      if (e instanceof SessionEndedError) return;  // redirect in progress; suppress error
      setErr(e instanceof Error ? e.message : 'Skip failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <WizardBackButton code={code} clearKeys={['hotelDetailsAt']} onNext={onNext} />
      <KeyRound size={28} color="#C99644" style={{ marginBottom: '12px' }} />
      <h2 style={{ fontSize: '20px', marginBottom: '4px' }}>Connect your PMS</h2>
      <p style={{ color: '#5C625C', marginBottom: '20px', fontSize: '13px' }}>
        We&apos;ll log into your PMS in a remote browser to learn your room layout. Read-only — we never make changes there.
      </p>
      {err && <ErrorBox msg={err} />}
      <Field label={o.pmsLabel}>
        <select className="input" value={pmsType} onChange={(e) => handlePmsTypeChange(e.target.value)}>
          <option value="">{o.pmsSelectPlaceholder}</option>
          {PMS_PICKER_OPTIONS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </Field>
      {pmsType === 'other' && (
        <Field label={o.pmsOtherLabel}>
          <input
            className="input"
            value={otherName}
            onChange={(e) => setOtherName(e.target.value)}
            placeholder={o.pmsOtherPlaceholder}
            maxLength={120}
          />
          <p style={{ fontSize: '12px', color: '#5C625C', marginTop: '4px' }}>{o.pmsOtherHint}</p>
        </Field>
      )}
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
      {!pmsAlreadyEntered && (
        <>
          <button className="btn btn-secondary" onClick={skipPms} disabled={submitting} style={{ width: '100%', justifyContent: 'center', marginTop: '8px' }}>
            {lang === 'es' ? 'Omitir — este hotel no usa un PMS' : "Skip — this hotel doesn't use a PMS"}
          </button>
          <p style={{ fontSize: '12px', color: '#5C625C', marginTop: '8px', textAlign: 'center', lineHeight: 1.5 }}>
            {lang === 'es'
              ? 'Se activa sin PMS ni robot. Puedes conectarlo después en Configuración.'
              : 'Goes live with no PMS or robot — you can connect one later in Settings.'}
          </p>
        </>
      )}
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
  // Additive (2026-06-26): the hotel hit its daily safe-usage cap mid-learn
  // and auto-paused (resumes overnight). Optional so an older server response
  // (no field) degrades to a plain spinner. Only honored while non-terminal.
  paused?: 'cost_cap' | null;
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

  // Stuck-screen watchdog (audit P1 2026-06-26): the learning screen used to
  // be an endless spinner with no escape if the robot was slow / down / cost-
  // capped. Flip a "taking longer than expected" card after TIMEOUT_MS of NO
  // forward progress (bar / milestone / phase all frozen). Polling continues
  // underneath, so a robot that recovers still auto-advances to done/failed.
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 min of no progress → offer buttons
  const [timedOut, setTimedOut] = useState(false);
  const lastProgressAtRef = useRef<number>(Date.now());
  const respPhase = resp?.phase ?? 'preparing';
  // Any forward movement (bar %, milestone, or phase change) restarts the
  // clock and clears the warning — a slow-but-progressing learn never trips it.
  useEffect(() => {
    lastProgressAtRef.current = Date.now();
    setTimedOut(false);
  }, [barPct, maxMilestone, respPhase]);
  // Watchdog ticker — while preparing/learning, flip `timedOut` once we've gone
  // TIMEOUT_MS with no progress. Re-created on phase change (which also resets
  // the clock above). Cleared on unmount. MFA is excluded: a genuine PMS 2FA
  // wait legitimately sits with no progress and has its own calm "nothing
  // needed from you" copy — we must not nudge the operator to needlessly
  // re-enter login during a healthy security check. (done/failed are terminal.)
  useEffect(() => {
    if (respPhase === 'done' || respPhase === 'failed' || respPhase === 'mfa') return;
    const id = setInterval(() => {
      if (Date.now() - lastProgressAtRef.current > TIMEOUT_MS) setTimedOut(true);
    }, 10_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [respPhase]);

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
      // Mark mapping complete so deriveCurrentStep moves to step 7. All three
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

  // "Re-enter login" on a failed mapping → walk back to Step 5 (Connect PMS)
  // so the operator can fix the credentials and retry. clearStateKeys removes
  // the PMS completion markers server-side (deriveCurrentStep → 5) and onNext()
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

  // Reset the view + the watchdog clock and force a fresh poll. Used by the
  // failed-branch + the new "taking longer" / "paused" cards.
  const checkAgain = () => {
    setResp(null);
    setBarPct(0);
    setMaxMilestone(-1);
    setTimedOut(false);
    lastProgressAtRef.current = Date.now();
    setPollNonce((n) => n + 1);
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
        <AlertCircle size={28} color="#B85C3D" style={{ marginBottom: '12px' }} />
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>{t.failTitle}</h2>
        <p style={{ color: '#5C625C', marginBottom: '20px', fontSize: '14px', lineHeight: 1.5 }}>{msg}</p>
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

  // Cost-cap pause — honest "paused, resumes overnight" card. Checked before
  // the timeout card (it's the more specific, more reassuring signal). We're
  // already past the done/failed early-returns, so this never hides a result.
  if (resp?.paused === 'cost_cap') {
    return (
      <div>
        <AlertCircle size={28} color="#C99644" style={{ marginBottom: '12px' }} />
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>{t.pausedTitle}</h2>
        <p style={{ color: '#5C625C', marginBottom: '20px', fontSize: '14px', lineHeight: 1.5 }}>{t.pausedBody}</p>
        <button className="btn btn-primary" onClick={checkAgain} style={{ justifyContent: 'center' }}>
          {t.checkAgainBtn}
        </button>
      </div>
    );
  }

  // Stuck-screen escape — robot quiet for TIMEOUT_MS. "Check again" is the
  // primary (least destructive) action; "Re-enter login" is secondary because
  // it abandons a possibly-still-healthy in-flight learn. Polling continues
  // underneath, so a recovered run auto-replaces this with the done screen.
  if (timedOut) {
    return (
      <div>
        <AlertCircle size={28} color="#C99644" style={{ marginBottom: '12px' }} />
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>{t.slowTitle}</h2>
        <p style={{ color: '#5C625C', marginBottom: '20px', fontSize: '14px', lineHeight: 1.5 }}>{t.slowBody}</p>
        {reenterError && <ErrorBox msg={reenterError} />}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={checkAgain} disabled={reentering} style={{ justifyContent: 'center' }}>
            {t.checkAgainBtn}
          </button>
          <button className="btn btn-secondary" onClick={reenterPms} disabled={reentering} style={{ justifyContent: 'center' }}>
            {reentering ? <Loader2 size={14} className="spin" /> : null}
            {reentering ? '…' : t.reenterLoginBtn}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Loader2 size={28} className="spin" color="#C99644" style={{ marginBottom: '12px' }} />
      <h2 style={{ fontSize: '20px', marginBottom: '4px' }}>{title}</h2>
      <p style={{ color: '#5C625C', marginBottom: '20px', fontSize: '13px', lineHeight: 1.5 }}>{body}</p>

      <div style={{ height: '6px', background: 'rgba(31,35,28,0.12)', borderRadius: '3px', overflow: 'hidden', marginBottom: '16px' }}>
        {indeterminate ? (
          <div className="onboard-indeterminate" style={{ height: '100%', background: '#C99644' }} />
        ) : (
          <div style={{ width: `${barPct}%`, height: '100%', background: '#C99644', transition: 'width 0.4s' }} />
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
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: active ? '#1F231C' : '#5C625C' }}>
      {done
        ? <Check size={14} color="#3F8F5F" />
        : <Loader2 size={14} className="spin" color="#C99644" />}
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
      <CheckCircle2 size={30} color="#3F8F5F" style={{ marginBottom: '12px' }} />
      <h2 style={{ fontSize: '21px', marginBottom: '6px', fontWeight: 700 }}>{title}</h2>
      <p style={{ color: '#5C625C', marginBottom: '20px', fontSize: '14px', lineHeight: 1.5 }}>{body}</p>

      {feeds.length > 0 && (
        <div style={{ background: 'rgba(201,150,68,0.10)', borderRadius: '10px', padding: '16px', marginBottom: '16px' }}>
          <p style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px 0' }}>
            {`Captured ${gotCount} of ${feeds.length} feeds from ${pms}`}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
            {feeds.map((f) => (
              <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                {f.captured
                  ? <Check size={14} color="#3F8F5F" style={{ flexShrink: 0 }} />
                  : <span style={{ color: '#c2562e', width: 14, textAlign: 'center', flexShrink: 0, fontWeight: 700 }}>✕</span>}
                <span style={{ color: f.captured ? 'inherit' : '#5C625C' }}>{f.label}</span>
                <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#5C625C', fontVariantNumeric: 'tabular-nums' }}>
                  {f.captured
                    ? (f.count != null && f.count > 0 ? String(f.count) : 'captured')
                    : 'not found'}
                </span>
              </div>
            ))}
          </div>
          <p style={{ fontSize: '11.5px', color: '#5C625C', margin: '10px 0 0', lineHeight: 1.45 }}>
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
      <p style={{ fontSize: '13px', color: '#5C625C', marginBottom: '16px', lineHeight: 1.5 }}>
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
      <p style={{ fontSize: '13px', color: '#5C625C', marginBottom: '16px', lineHeight: 1.5 }}>
        {t.numbersNone}
      </p>
    );
  }

  const when = numbers.capturedAt ? formatWhen(numbers.capturedAt, lang) : '';
  return (
    <div style={{ marginBottom: '16px' }}>
      <p style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 4px 0' }}>{t.numbersHeading}</p>
      <p style={{ fontSize: '11px', color: '#5C625C', margin: '0 0 10px 0' }}>{t.numbersCaption.replace('{when}', when)}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: '8px' }}>
        {cards.map((c) => (
          <div key={c.label} style={{ background: 'rgba(201,150,68,0.10)', border: '1px solid rgba(31,35,28,0.12)', borderRadius: '8px', padding: '10px 12px', textAlign: 'center' }}>
            <div style={{ fontSize: '22px', fontWeight: 700, color: '#1F231C' }}>{c.main}</div>
            <div style={{ fontSize: '11px', color: '#5C625C', marginTop: '2px' }}>{c.label}</div>
            {c.sub ? <div style={{ fontSize: '10px', color: '#5C625C', marginTop: '2px' }}>{c.sub}</div> : null}
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
      <Users size={28} color="#C99644" style={{ marginBottom: '12px' }} />
      <h2 style={{ fontSize: '20px', marginBottom: '4px' }}>Add your team (optional)</h2>
      <p style={{ color: '#5C625C', marginBottom: '20px', fontSize: '13px' }}>
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
  const { lang } = useLang();
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
      // a cached onboarding gate could bounce the owner back through the wizard
      // once before settling. A reload lands them cleanly on the Home hub.
      window.location.href = '/home';
    } catch (e) {
      if (e instanceof SessionEndedError) return;  // redirect in progress
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
      <div style={{ background: 'rgba(201,150,68,0.10)', borderRadius: '8px', padding: '14px', marginBottom: '16px' }}>
        <p style={{ fontSize: '13px', margin: 0, lineHeight: 1.5 }}>
          {lang === 'es'
            ? '✓ Tu inventario empieza vacío. Agrega tus propios artículos cuando quieras en la pestaña de Inventario.'
            : '✓ Your inventory starts empty. Add your own items anytime in the Inventory tab.'}
        </p>
        <p style={{ fontSize: '13px', margin: '8px 0 0 0', lineHeight: 1.5 }}>
          ✓ Once your housekeepers start cleaning rooms, the AI will start predicting your needs. Usually within 7 days.
        </p>
      </div>
      <button className="btn btn-primary" onClick={finalize} disabled={going} style={{ width: '100%', justifyContent: 'center' }}>
        {going ? 'Going…' : 'Go to home →'}
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
