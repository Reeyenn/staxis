'use client';

/* ───────────────────────────────────────────────────────────────────────
   SURFACE — Onboarding · "Launch Bay" (dark).

   The design-handoff finalized Onboarding screen, wired to the real v4
   onboarding pipeline. Watch every hotel move signup → live and unblock the
   stuck ones.

   Data (same endpoints the prior OnboardingTab used):
     • /api/admin/list-properties        → properties + sessionStatus (funnel)
     • /api/admin/onboarding-jobs?live=1  → in-flight CUA sessions
     • /api/admin/pms-coverage            → PMS readiness + repair feeds
     • /api/admin/prospects               → sales pipeline (full CRUD kept)
   Mutations kept: create hotel + signup link (CreateHotelModal), repair PMS
   feed (~$2 re-learn), prospect add/edit/delete, blocker-resolve deep-links.

   Funnel bucketing mirrors the prior tab's bucketByStage (property_sessions
   .status is the source of truth). Blocker CTAs deep-link to the real
   resolve pages (/admin/mfa-resume/[id], /admin/property-sessions).
   ─────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { CreateHotelModal } from '@/app/admin/_components/CreateHotelModal';
import {
  FONT_SERIF, FONT_MONO, Caps, Pill, Dot, Btn, SerifNum,
  countUp, sweepWidth, riseIn, age, type DotTone,
} from '../kit';

// ── Real API shapes (mirror the prior OnboardingTab interfaces) ─────────
interface OnbState {
  accountCreatedAt?: string | null;
  emailVerifiedAt?: string | null;
  hotelDetailsAt?: string | null;
  servicesAt?: string | null;
  pmsCredentialsAt?: string | null;
  mappingCompletedAt?: string | null;
  staffAt?: string | null;
}
interface PropertyRow {
  id: string;
  name: string | null;
  pmsType: string | null;
  pmsConnected: boolean;
  lastSyncedAt: string | null;
  staffCount: number;
  createdAt: string;
  sessionStatus: string | null;
  sessionPausedReason: string | null;
  onboardingState: OnbState | null;
  onboardingCompletedAt: string | null;
}
interface JobRow {
  id: string; propertyId: string; propertyName: string | null;
  pmsType: string; status: string; step: string | null;
  progressPct: number | null; error: string | null; createdAt: string;
  kind?: 'session' | 'mapper';
}
interface PMSCoverage {
  pmsType: string; label: string; hint: string; tier: 1 | 2 | 3;
  recipe: { coveragePct: number; version: number; createdAt: string; actionKeys?: string[] } | null;
  propertyCount: number;
  representativePropertyId?: string | null;
  latestJob: { status: string; error: string | null; createdAt: string } | null;
}
type ProspectStatus = 'talking' | 'negotiating' | 'committed' | 'onboarded' | 'dropped';
interface Prospect {
  id: string; hotel_name: string; contact_name: string | null; contact_email: string | null;
  contact_phone: string | null; pms_type: string | null; expected_launch_date: string | null;
  status: ProspectStatus; notes: string | null; checklist: Record<string, boolean>;
  created_at: string; updated_at: string;
}

// ── Lane bucketing (= prior bucketByStage, with kind/cta for the dark UI) ─
type HelpKind = 'mfa' | 'mapper' | 'cost' | 'login' | 'stopped';
interface LaneRow { id: string; name: string; pms: string | null; kind?: HelpKind; sub?: string; href: string; }
const HELP_DOT: Record<HelpKind, DotTone> = { mfa: 'gold', mapper: 'teal', cost: 'gold', login: 'terracotta', stopped: 'terracotta' };
const CTA_LABEL: Record<HelpKind, string> = { mfa: 'Enter MFA code', mapper: 'View mapper', cost: 'Resume now', login: 'Edit credentials', stopped: 'Restart' };

// ── The 9-step onboarding journey (mirrors the /onboard customer wizard) ─
const STEP_LABELS = ['Welcome', 'Account', 'Email', 'Details', 'Services', 'PMS', 'Connect', 'Team', 'Live'] as const;
const TOTAL_STEPS = STEP_LABELS.length; // 9

interface Journey { step: number; label: string; sub: string; href: string; needsYou: boolean; kind?: HelpKind; }

// Latest activity timestamp across a customer's saved step timestamps —
// used to sort the most-active onboarding to the top + gate live polling.
function latestStateTs(s: OnbState | null): number {
  if (!s) return 0;
  let m = 0;
  for (const v of Object.values(s)) { if (v) { const t = Date.parse(v); if (Number.isFinite(t) && t > m) m = t; } }
  return m;
}

// "Live" = off the timeline, in the green core. True once the wizard is
// finalized OR the CUA session is alive and polling.
function isLive(p: PropertyRow): boolean {
  return !!p.onboardingCompletedAt || p.sessionStatus === 'alive';
}

// Map a hotel to its 1-of-9 journey position. Back half (steps 6-9) is
// driven by the live CUA session state; front half (1-5) by the wizard's
// saved per-step timestamps. `needsYou` flags steps a chip-click unblocks.
function journeyOf(p: PropertyRow): Journey {
  const propHref = `/admin/properties/${p.id}`;
  switch (p.sessionStatus) {
    case 'paused_mfa':  return { step: 7, label: 'Needs your code', sub: 'Robot hit 2-factor — click to enter the code.', href: `/admin/mfa-resume/${p.id}`, needsYou: true, kind: 'mfa' };
    case 'paused_no_knowledge_file': return { step: 7, label: 'Learning the PMS', sub: 'Robot is learning this PMS for the first time.', href: '/admin/property-sessions', needsYou: false, kind: 'mapper' };
    case 'paused_cost_cap': return { step: 7, label: 'Paused · cost cap', sub: 'Daily AI budget hit — auto-resumes at midnight.', href: '/admin/property-sessions', needsYou: false, kind: 'cost' };
    case 'paused_circuit_breaker':
    case 'failed_restart': return { step: 7, label: 'Login failing', sub: p.sessionPausedReason ?? 'Sign-in keeps failing — check the credentials.', href: '/admin/property-sessions', needsYou: true, kind: 'login' };
    case 'stopped': return { step: 7, label: 'Stopped', sub: 'Session stopped — click to restart.', href: '/admin/property-sessions', needsYou: true, kind: 'stopped' };
    case 'starting': return { step: 7, label: 'Robot connecting…', sub: 'Robot is logging into the PMS.', href: propHref, needsYou: false };
  }
  const s = p.onboardingState;
  if (!s || !s.accountCreatedAt) return { step: 1, label: 'Just landed', sub: 'Opened the invite — not started yet.', href: propHref, needsYou: false };
  if (!s.emailVerifiedAt)   return { step: 3, label: 'Verifying email', sub: 'Account made — confirming their email.', href: propHref, needsYou: false };
  if (!s.hotelDetailsAt)    return { step: 4, label: 'Hotel details', sub: 'Entering rooms, brand, timezone.', href: propHref, needsYou: false };
  if (!s.servicesAt)        return { step: 5, label: 'Choosing services', sub: 'Picking housekeeping, laundry, etc.', href: propHref, needsYou: false };
  if (!s.pmsCredentialsAt)  return { step: 6, label: 'Connecting PMS', sub: 'About to enter their PMS login.', href: propHref, needsYou: false };
  if (!s.mappingCompletedAt) return { step: 7, label: 'Robot connecting…', sub: 'Robot is logging into the PMS.', href: propHref, needsYou: false };
  if (!s.staffAt)           return { step: 8, label: 'Adding team', sub: 'Connected — owner is adding staff.', href: propHref, needsYou: false };
  return { step: 9, label: 'Wrapping up', sub: 'Final step — almost live.', href: propHref, needsYou: false };
}

// Journey → the LaneRow shape the existing chip-detail modal already renders.
function toLane(p: PropertyRow, j: Journey): LaneRow {
  return { id: p.id, name: p.name ?? '(unnamed)', pms: p.pmsType, kind: j.needsYou ? j.kind : undefined, sub: j.sub, href: j.href };
}

function pmsState(p: PMSCoverage): { tone: DotTone; label: string; note: string } {
  if (p.recipe && p.recipe.coveragePct === 100) return { tone: 'forest', label: 'Ready', note: 'Ready. Future hotels onboard free.' };
  if (p.recipe && p.recipe.coveragePct < 100) return { tone: 'gold', label: `${p.recipe.coveragePct}%`, note: `Partial — ${p.recipe.coveragePct}% of actions captured.` };
  if (!p.recipe && p.latestJob?.status === 'failed') return { tone: 'terracotta', label: 'Failed', note: 'Last mapping failed. First hotel retries.' };
  return { tone: 'muted', label: 'New', note: 'Not learned. First hotel triggers ~$0.50, ~7 min mapping.' };
}

const card = { bg: 'rgba(255,255,255,.06)', br: 'rgba(255,255,255,.14)' };
const dim = (a: number) => `rgba(255,255,255,${a})`;
// Timeline row layout — header labels + each hotel row share these so the
// step labels line up exactly above the node dots.
const NAME_W = 150;   // left "hotel name" column (px)
const STATUS_W = 140; // right "current step" column (px)
const ROW_GAP = 12;   // gap between name · rail · status

export function OnboardingSurface() {
  const [props, setProps] = useState<PropertyRow[] | null>(null);
  const [liveJobs, setLiveJobs] = useState<JobRow[] | null>(null);
  const [pms, setPms] = useState<PMSCoverage[] | null>(null);
  const [prospects, setProspects] = useState<Prospect[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selChip, setSelChip] = useState<LaneRow | null>(null);
  const [selPms, setSelPms] = useState<PMSCoverage | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async () => {
    try {
      const [a, b, c, d] = await Promise.all([
        fetchWithAuth('/api/admin/list-properties'),
        fetchWithAuth('/api/admin/onboarding-jobs?live=1'),
        fetchWithAuth('/api/admin/pms-coverage'),
        fetchWithAuth('/api/admin/prospects'),
      ]);
      const [aj, bj, cj, dj] = await Promise.all([a.json(), b.json(), c.json(), d.json()]);
      if (aj.ok) setProps(aj.data.properties);
      if (bj.ok) setLiveJobs(bj.data.jobs);
      if (cj.ok) setPms(cj.data.pmsTypes);
      if (dj.ok) setProspects(dj.data.prospects);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
  };
  useEffect(() => { void load(); }, []);
  // Auto-refresh while anything is moving: a CUA session in flight OR any
  // hotel still mid-wizard. This keeps the timeline advancing in real time
  // as a customer walks the 9 steps (the early steps have no CUA session).
  useEffect(() => {
    const inFlight = (liveJobs?.length ?? 0) > 0;
    const inWizard = (props ?? []).some((p) => !isLive(p));
    if (!inFlight && !inWizard) return;
    refreshTimer.current = setTimeout(() => { void load(); }, 5000);
    return () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); };
  }, [props, liveJobs]);

  if (error) return <DarkShell><div style={{ color: 'var(--terracotta)', fontSize: 13 }}>{error}</div></DarkShell>;
  if (!props || !liveJobs || !pms) {
    return <DarkShell><div style={{ padding: '80px 0', textAlign: 'center' }}><span className="spinner" style={{ width: 22, height: 22, display: 'inline-block', borderTopColor: '#fff' }} /></div></DarkShell>;
  }

  // Hotels still on the timeline (not yet live), most-recently-active first
  // so the one a customer is actively walking sits at the top.
  const journeyRows = props
    .filter((p) => !isLive(p))
    .map((p) => ({ p, j: journeyOf(p), ts: latestStateTs(p.onboardingState) }))
    .sort((a, c) => (c.ts - a.ts) || (Date.parse(c.p.createdAt) - Date.parse(a.p.createdAt)));
  const liveCount = props.filter(isLive).length;
  const learnedPms = pms.filter((p) => p.recipe !== null);
  const activeProspects = (prospects ?? []).filter((p) => p.status !== 'onboarded' && p.status !== 'dropped');

  return (
    <DarkShell>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 22, position: 'relative' }}>
        <div>
          <span className="caps" style={{ color: dim(.55) }}>Onboarding · Launch bay</span>
          <h1 style={{ fontFamily: FONT_SERIF, fontSize: 32, fontWeight: 400, letterSpacing: '-0.02em', margin: '4px 0 0', color: '#fff' }}>
            Everything <span style={{ fontStyle: 'italic' }}>inbound to live</span>
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Btn variant="ghost" size="lg" href="/admin/pms-inbox" style={{ color: '#fff', borderColor: dim(.3), background: dim(.06) }}>PMS inbox</Btn>
          <Btn variant="ghost" size="lg" onClick={() => setCreateOpen(true)} style={{ color: '#fff', borderColor: dim(.3), background: dim(.06) }}>+ New hotel</Btn>
        </div>
      </header>

      {/* ── Live onboarding journey — one rail per hotel, fills as they move ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span className="caps" style={{ color: dim(.55) }}>Onboarding · live journey</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 12px 4px 11px', borderRadius: 999, background: 'rgba(60,156,104,.15)', border: '1px solid rgba(60,156,104,.4)' }}>
          <Dot tone="forest" size={7} />
          <BayLiveCount n={liveCount} />
          <span className="mono" style={{ fontSize: 9, color: dim(.6), letterSpacing: '.08em' }}>LIVE · POLLING</span>
        </span>
      </div>

      {/* step-label header — lines up exactly above the node dots below */}
      <div style={{ display: 'flex', alignItems: 'center', gap: ROW_GAP, padding: '0 14px 7px' }}>
        <div style={{ width: NAME_W, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'space-between' }}>
          {STEP_LABELS.map((l, i) => (
            <span key={i} className="mono" style={{ fontSize: 8.5, color: i === STEP_LABELS.length - 1 ? 'rgba(60,156,104,.85)' : dim(.42), letterSpacing: '.02em', whiteSpace: 'nowrap' }}>{l}</span>
          ))}
        </div>
        <div style={{ width: STATUS_W, flexShrink: 0 }} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {journeyRows.length === 0
          ? <Empty text="No hotels onboarding right now — “+ New hotel” to start one." />
          : journeyRows.map(({ p, j }) => <JourneyRow key={p.id} p={p} j={j} onClick={() => setSelChip(toLane(p, j))} />)}
      </div>

      {/* Sessions · PMS · Prospects */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 16, marginTop: 26, position: 'relative' }}>
        <div>
          <span className="caps" style={{ color: dim(.5) }}>In-flight sessions</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            {liveJobs.length === 0
              ? <Empty text="Every hotel is alive and polling ✓" />
              : liveJobs.map((j) => <BaySession key={j.id} job={j} />)}
          </div>
        </div>
        <div>
          <span className="caps" style={{ color: dim(.5) }}>PMS coverage</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
            {learnedPms.length === 0
              ? <Empty text="No PMSes learned yet." />
              : learnedPms.map((p) => <BayPms key={p.pmsType} pms={p} onClick={() => setSelPms(p)} />)}
          </div>
        </div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="caps" style={{ color: dim(.5) }}>Prospects</span>
            <AddProspect onAdded={load} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 10 }}>
            {activeProspects.length === 0
              ? <Empty text="No prospects yet." />
              : activeProspects.map((p) => <BayProspect key={p.id} p={p} onSaved={load} />)}
          </div>
        </div>
      </div>

      {selChip && <BayDetail r={selChip} onClose={() => setSelChip(null)} />}
      {selPms && <PmsDetail pms={selPms} onClose={() => setSelPms(null)} onRepaired={load} />}
      <CreateHotelModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => { void load(); }} />
    </DarkShell>
  );
}

// ── Dark surface section with radial glow — seamless with the full-bleed
//    dark admin canvas (no card chrome, just padding + glow). ────────────
function DarkShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: 'transparent', padding: '24px 32px 8px', color: '#fff', position: 'relative' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(120% 80% at 100% 0%, rgba(60,156,104,.14), transparent 60%)', pointerEvents: 'none' }} />
      <div style={{ position: 'relative' }}>{children}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={{ padding: '16px 14px', textAlign: 'center', border: `1px dashed ${dim(.18)}`, borderRadius: 12, color: dim(.45), fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 13 }}>{text}</div>;
}

// One hotel = one row: name · a 9-node rail that fills to the live step · the
// current step label. The fill bar + current node animate when the step
// advances (every poll), so you watch a hotel travel the whole journey.
function JourneyRow({ p, j, onClick }: { p: PropertyRow; j: Journey; onClick: () => void }) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const current = j.step - 1; // 0-based index of the in-progress node
  const fillPct = TOTAL_STEPS > 1 ? (current / (TOTAL_STEPS - 1)) * 100 : 0;
  useEffect(() => { riseIn(rowRef.current, { dy: 10, dur: 420 }); }, []);
  useEffect(() => { sweepWidth(fillRef.current, fillPct, { dur: 700 }); }, [fillPct]);
  const accentTone: DotTone = j.needsYou && j.kind ? HELP_DOT[j.kind] : 'gold';
  const accent = `var(--${accentTone})`;
  const ring = accentTone === 'terracotta' ? 'rgba(194,86,46,.22)' : accentTone === 'teal' ? 'rgba(51,137,160,.22)' : 'rgba(201,154,46,.22)';
  return (
    <button ref={rowRef} onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: ROW_GAP, width: '100%', textAlign: 'left',
      background: j.needsYou ? 'rgba(194,86,46,.07)' : dim(.04),
      border: `1px solid ${j.needsYou ? 'rgba(194,86,46,.4)' : dim(.12)}`,
      borderRadius: 12, padding: '12px 14px', cursor: 'pointer', color: '#fff',
    }}>
      {/* hotel */}
      <div style={{ width: NAME_W, flexShrink: 0, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name ?? '(unnamed)'}</div>
        {p.pmsType && <div className="mono" style={{ fontSize: 9, color: dim(.4), marginTop: 2, letterSpacing: '.03em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.pmsType}</div>}
      </div>
      {/* rail */}
      <div style={{ flex: 1, minWidth: 0, position: 'relative', height: 16, display: 'flex', alignItems: 'center' }}>
        <div style={{ position: 'absolute', left: 5, right: 5, top: '50%', height: 2, transform: 'translateY(-50%)', background: dim(.13), borderRadius: 2 }} />
        <div ref={fillRef} style={{ position: 'absolute', left: 5, top: '50%', height: 2, transform: 'translateY(-50%)', width: 0, maxWidth: 'calc(100% - 10px)', background: j.needsYou ? 'var(--terracotta)' : 'linear-gradient(90deg, var(--forest), var(--gold))', borderRadius: 2 }} />
        <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', width: '100%', zIndex: 1 }}>
          {STEP_LABELS.map((_, i) => {
            const done = i < current, cur = i === current;
            const sz = cur ? 11 : done ? 8 : 7;
            return <span key={i} style={{
              width: sz, height: sz, borderRadius: '50%', flexShrink: 0,
              background: done ? 'var(--forest)' : cur ? accent : dim(.16),
              boxShadow: cur ? `0 0 0 4px ${ring}` : 'none',
              border: (!done && !cur) ? `1px solid ${dim(.26)}` : 'none',
              transition: 'background .3s ease, box-shadow .3s ease, width .2s ease',
            }} />;
          })}
        </div>
      </div>
      {/* current step */}
      <div style={{ width: STATUS_W, flexShrink: 0, textAlign: 'right', minWidth: 0 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: j.needsYou ? 'var(--terracotta)' : '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.label}{j.needsYou ? ' ›' : ''}</div>
        <div className="mono" style={{ fontSize: 9.5, color: dim(.45), marginTop: 2 }}>{j.step} / {TOTAL_STEPS}</div>
      </div>
    </button>
  );
}

function BayLiveCount({ n }: { n: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => { countUp(ref.current, 0, n, { dur: 1100, fmt: (v) => String(Math.round(v)) }); }, [n]);
  return <span ref={ref} className="serif-num" style={{ fontSize: 44, color: '#fff', margin: '4px 0' }}>0</span>;
}

function BaySession({ job }: { job: JobRow }) {
  const barRef = useRef<HTMLDivElement>(null);
  const pct = Math.max(0, Math.min(100, job.progressPct ?? 0));
  useEffect(() => { sweepWidth(barRef.current, pct, { dur: 900 }); }, [pct]);
  const href = job.kind === 'mapper' ? `/admin/properties/mapper/${job.id}` : `/admin/properties/${job.propertyId}`;
  return (
    <a href={href} style={{ textDecoration: 'none', background: dim(.06), border: `1px solid ${dim(.14)}`, borderRadius: 11, padding: '11px 13px', display: 'block' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
        <span className="spinner" style={{ width: 12, height: 12, display: 'inline-block', borderColor: dim(.2), borderTopColor: 'var(--gold)' }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>{job.propertyName ?? '(deleted)'}</span>
        <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--gold)' }}>{pct}%</span>
      </div>
      <div style={{ fontSize: 11, color: dim(.6), marginBottom: 6 }}>{job.step ?? 'Working…'}</div>
      <div style={{ height: 3, background: dim(.12), borderRadius: 2, overflow: 'hidden' }}><div ref={barRef} style={{ height: '100%', width: 0, background: 'var(--gold)' }} /></div>
    </a>
  );
}

function BayPms({ pms, onClick }: { pms: PMSCoverage; onClick: () => void }) {
  const st = pmsState(pms);
  const repairable = pms.recipe?.actionKeys?.length && pms.representativePropertyId;
  return (
    <button onClick={onClick} style={{ textAlign: 'left', display: 'flex', alignItems: 'center', gap: 9, background: dim(.05), border: `1px solid ${dim(.12)}`, borderRadius: 10, padding: '9px 12px', cursor: repairable ? 'pointer' : 'default', color: '#fff', width: '100%' }}>
      <Dot tone={st.tone} />
      <span style={{ fontSize: 12, fontWeight: 600, color: '#fff', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pms.label}</span>
      <span style={{ fontSize: 11, color: st.tone === 'muted' ? dim(.5) : `var(--${st.tone})` }}>{st.label}</span>
      {repairable ? <span className="mono" style={{ fontSize: 9, color: dim(.35) }}>repair ›</span> : null}
    </button>
  );
}

function BayProspect({ p, onSaved }: { p: Prospect; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const tone: DotTone = p.status === 'committed' ? 'forest' : p.status === 'negotiating' ? 'gold' : 'teal';
  return (
    <>
      <button onClick={() => setOpen(true)} style={{ textAlign: 'left', display: 'flex', alignItems: 'center', gap: 9, background: dim(.05), border: `1px solid ${dim(.12)}`, borderRadius: 10, padding: '9px 12px', cursor: 'pointer', color: '#fff', width: '100%' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#fff', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.hotel_name}</span>
        <span style={{ fontSize: 10, color: `var(--${tone === 'teal' ? 'teal' : tone})`, textTransform: 'capitalize' }}>{p.status}</span>
        <span className="mono" style={{ fontSize: 9.5, color: dim(.4) }}>{age(p.created_at)}</span>
      </button>
      {open && <ProspectModal p={p} onClose={() => setOpen(false)} onSaved={onSaved} />}
    </>
  );
}

// ── Chip detail modal (light card, dark backdrop) ───────────────────────
function BayDetail({ r, onClose }: { r: LaneRow; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { riseIn(ref.current, { dy: 30, dur: 460 }); }, []);
  const help = !!r.kind;
  return (
    <Backdrop onClose={onClose}>
      <div ref={ref} onClick={(e) => e.stopPropagation()} style={modalCard}>
        <Caps>{r.pms ?? 'No PMS yet'}</Caps>
        <h3 style={{ fontFamily: FONT_SERIF, fontSize: 26, fontWeight: 400, letterSpacing: '-0.02em', margin: '6px 0 6px' }}><span style={{ fontStyle: 'italic' }}>{r.name}</span></h3>
        <p style={{ fontSize: 13, color: 'var(--dim)', lineHeight: 1.5, marginBottom: 18 }}>{r.sub ?? 'In onboarding.'}</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn variant={help ? 'terracotta' : 'primary'} href={r.href}>{help ? CTA_LABEL[r.kind!] : 'Property page →'}</Btn>
          <Btn variant="ghost" onClick={onClose}>Close</Btn>
        </div>
      </div>
    </Backdrop>
  );
}

// ── PMS detail + repair-feed (~$2 re-learn) ─────────────────────────────
function PmsDetail({ pms, onClose, onRepaired }: { pms: PMSCoverage; onClose: () => void; onRepaired: () => Promise<void> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { riseIn(ref.current, { dy: 30, dur: 440 }); }, []);
  const st = pmsState(pms);
  const keys = pms.recipe?.actionKeys ?? [];
  const propertyId = pms.representativePropertyId;

  const fire = async () => {
    if (!key) { setMsg('Pick a feed first.'); return; }
    if (!propertyId) { setMsg('No representative hotel.'); return; }
    if (!confirm(`Re-learn the "${key}" feed for ${pms.pmsType}? Costs about $2 in Claude API spend.`)) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetchWithAuth('/api/admin/mapper/repair-feed', { method: 'POST', body: JSON.stringify({ pmsFamily: pms.pmsType, propertyId, targetKey: key }) });
      const json = await res.json();
      if (json.ok) { setMsg(json.data.enqueued ? `Enqueued — watch at /admin/properties/mapper/${json.data.jobId}` : 'Already running.'); setKey(''); void onRepaired(); }
      else setMsg(`Failed: ${json.error ?? 'unknown'}`);
    } catch (err) { setMsg(`Network error: ${(err as Error).message}`); }
    finally { setBusy(false); }
  };

  return (
    <Backdrop onClose={onClose}>
      <div ref={ref} onClick={(e) => e.stopPropagation()} style={modalCard}>
        <Caps>PMS coverage · {pms.tier ? `Tier ${pms.tier}` : ''}</Caps>
        <h3 style={{ fontFamily: FONT_SERIF, fontSize: 24, fontWeight: 400, letterSpacing: '-0.02em', margin: '6px 0 4px' }}><span style={{ fontStyle: 'italic' }}>{pms.label}</span></h3>
        <p style={{ fontSize: 13, color: 'var(--dim)', lineHeight: 1.5, marginBottom: 6 }}>{st.note}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <Pill tone={st.tone === 'muted' ? 'neutral' : st.tone}>{st.label}</Pill>
          <span className="mono" style={{ fontSize: 11, color: 'var(--dim2)' }}>{pms.propertyCount} {pms.propertyCount === 1 ? 'hotel' : 'hotels'} · v{pms.recipe?.version ?? 0}</span>
        </div>
        {keys.length > 0 && propertyId ? (
          <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 14 }}>
            <Caps size={9}>Repair a feed</Caps>
            <p style={{ fontSize: 12, color: 'var(--dim)', margin: '4px 0 8px', lineHeight: 1.4 }}>Re-learn one action if its extraction drifted. ~$2, ~few min.</p>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select value={key} onChange={(e) => setKey(e.target.value)} disabled={busy} className="mono"
                style={{ flex: 1, fontSize: 11.5, padding: '7px 9px', border: '1px solid var(--rule)', borderRadius: 9, background: '#fff', color: 'var(--ink)' }}>
                <option value="">— pick a feed —</option>
                {keys.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <Btn size="sm" variant="terracotta" onClick={fire} disabled={busy || !key}>{busy ? '…' : 'Fix'}</Btn>
            </div>
            {msg && <p className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', marginTop: 8, wordBreak: 'break-all' }}>{msg}</p>}
          </div>
        ) : null}
        <div style={{ marginTop: 18 }}><Btn variant="ghost" onClick={onClose}>Close</Btn></div>
      </div>
    </Backdrop>
  );
}

// ── Prospect quick-add + edit modal (preserves full CRUD) ───────────────
const PROSPECT_STATUSES: ProspectStatus[] = ['talking', 'negotiating', 'committed', 'onboarded', 'dropped'];
const CHECKLIST = [
  { key: 'pmsCredsCollected', label: 'PMS creds collected' },
  { key: 'staffListReady', label: 'Staff list ready' },
  { key: 'gmTrained', label: 'GM trained' },
  { key: 'launchDateConfirmed', label: 'Launch date confirmed' },
];

function AddProspect({ onAdded }: { onAdded: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await fetchWithAuth('/api/admin/prospects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hotelName: name.trim() }) });
      const json = await res.json();
      if (json.ok) { setName(''); setOpen(false); await onAdded(); }
    } finally { setBusy(false); }
  };
  if (!open) return <button onClick={() => setOpen(true)} className="mono" style={{ background: 'none', border: 'none', color: dim(.5), fontSize: 10, cursor: 'pointer', letterSpacing: '.08em' }}>+ ADD</button>;
  return (
    <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setOpen(false); }} placeholder="Hotel name"
        style={{ width: 130, fontSize: 11, padding: '4px 8px', borderRadius: 8, border: `1px solid ${dim(.2)}`, background: dim(.08), color: '#fff', outline: 'none' }} />
      <button onClick={create} disabled={busy} className="mono" style={{ background: 'none', border: 'none', color: 'var(--forest)', fontSize: 10, cursor: 'pointer' }}>{busy ? '…' : 'SAVE'}</button>
    </span>
  );
}

function ProspectModal({ p, onClose, onSaved }: { p: Prospect; onClose: () => void; onSaved: () => Promise<void> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [d, setD] = useState<Prospect>(p);
  const [saving, setSaving] = useState(false);
  useEffect(() => { riseIn(ref.current, { dy: 30, dur: 440 }); }, []);
  const dirty = JSON.stringify(d) !== JSON.stringify(p);

  const save = async () => {
    setSaving(true);
    try {
      await fetchWithAuth(`/api/admin/prospects/${p.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelName: d.hotel_name, contactName: d.contact_name, contactEmail: d.contact_email, contactPhone: d.contact_phone, pmsType: d.pms_type, expectedLaunchDate: d.expected_launch_date, status: d.status, notes: d.notes, checklist: d.checklist }) });
      await onSaved(); onClose();
    } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!confirm(`Delete "${p.hotel_name}"? Use status 'Dropped' to keep history.`)) return;
    await fetchWithAuth(`/api/admin/prospects/${p.id}`, { method: 'DELETE' });
    await onSaved(); onClose();
  };
  const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', marginTop: 4, padding: '8px 11px', fontSize: 13, fontFamily: 'var(--sans)', border: '1px solid var(--rule)', borderRadius: 10, outline: 'none', background: '#fff', color: 'var(--ink)' };

  return (
    <Backdrop onClose={onClose}>
      <div ref={ref} onClick={(e) => e.stopPropagation()} style={{ ...modalCard, width: 460 }}>
        <Caps>Prospect</Caps>
        <input value={d.hotel_name} onChange={(e) => setD({ ...d, hotel_name: e.target.value })} style={{ ...inp, fontFamily: 'var(--serif)', fontSize: 22, fontStyle: 'italic', border: 'none', padding: '4px 0', marginTop: 2 }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          <label><Caps size={9}>Status</Caps>
            <select value={d.status} onChange={(e) => setD({ ...d, status: e.target.value as ProspectStatus })} style={inp}>
              {PROSPECT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label><Caps size={9}>PMS</Caps><input value={d.pms_type ?? ''} onChange={(e) => setD({ ...d, pms_type: e.target.value || null })} style={inp} /></label>
          <label><Caps size={9}>Contact</Caps><input value={d.contact_name ?? ''} onChange={(e) => setD({ ...d, contact_name: e.target.value || null })} style={inp} /></label>
          <label><Caps size={9}>Phone</Caps><input value={d.contact_phone ?? ''} onChange={(e) => setD({ ...d, contact_phone: e.target.value || null })} style={inp} /></label>
          <label><Caps size={9}>Email</Caps><input value={d.contact_email ?? ''} onChange={(e) => setD({ ...d, contact_email: e.target.value || null })} style={inp} /></label>
          <label><Caps size={9}>Launch</Caps><input type="date" value={d.expected_launch_date ?? ''} onChange={(e) => setD({ ...d, expected_launch_date: e.target.value || null })} style={inp} /></label>
        </div>
        <label style={{ display: 'block', marginTop: 10 }}><Caps size={9}>Notes</Caps>
          <textarea value={d.notes ?? ''} onChange={(e) => setD({ ...d, notes: e.target.value || null })} rows={2} style={{ ...inp, resize: 'vertical' }} />
        </label>
        <div style={{ marginTop: 12 }}><Caps size={9}>Launch checklist</Caps>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
            {CHECKLIST.map((c) => {
              const on = !!d.checklist?.[c.key];
              return (
                <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer', background: on ? 'var(--forest-dim)' : 'var(--rule-soft)', border: `1px solid ${on ? 'rgba(60,156,104,.3)' : 'var(--rule)'}`, color: on ? 'var(--forest-deep)' : 'var(--dim)' }}>
                  <input type="checkbox" checked={on} onChange={() => setD({ ...d, checklist: { ...d.checklist, [c.key]: !on } })} />{c.label}
                </label>
              );
            })}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 18 }}>
          <Btn variant="ghost" size="sm" onClick={remove} style={{ color: 'var(--terracotta)', borderColor: 'rgba(194,86,46,.3)' }}>Delete</Btn>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="ghost" size="sm" onClick={onClose}>Cancel</Btn>
            <Btn variant="primary" size="sm" onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save'}</Btn>
          </div>
        </div>
      </div>
    </Backdrop>
  );
}

// ── Shared modal bits ───────────────────────────────────────────────────
const modalCard: React.CSSProperties = { background: '#fff', borderRadius: 18, padding: 26, width: 420, maxWidth: '100%', boxShadow: 'var(--shadow-lg)', color: 'var(--ink)' };
function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(24,22,17,.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      {children}
    </div>
  );
}
