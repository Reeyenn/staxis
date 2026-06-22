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

   Layout: one live 9-step timeline row per onboarding hotel (journeyOf maps
   wizard onboarding_state + property_sessions.status → a 1-of-9 position).
   Clicking a row expands a mission-control panel (JourneyPanel) fed by
   /api/admin/onboarding-detail — robot status + 5-feed freshness + blocker
   actions for the PMS phase, person/details for the wizard phase. Blocker
   CTAs deep-link to /admin/mfa-resume/[id], /admin/property-sessions, and
   the live mapper console.
   ─────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { CreateHotelModal } from '@/app/admin/_components/CreateHotelModal';
import { MapsManagerModal } from '@/app/admin/_components/MapsManager';
import {
  FONT_SERIF, FONT_MONO, Caps, Pill, Dot, Btn, SerifNum,
  countUp, sweepWidth, riseIn, age, type DotTone,
} from '../kit';

// ── Real API shapes (mirror the prior OnboardingTab interfaces) ─────────
interface OnbState {
  step?: number;
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
// One feed's live status on a learned PMS map. 'live' = captured & flowing,
// 'learning' = mapped but still proving, 'unavailable' = this PMS doesn't
// expose it. Drives the per-feed chips that replace the misleading single %.
type FeedState = 'live' | 'learning' | 'unavailable';
interface PerFeed { key: string; label: string; state: FeedState }
interface PMSCoverage {
  pmsType: string; label: string; hint: string; tier: 1 | 2 | 3;
  recipe: { coveragePct: number; version: number; createdAt: string; actionKeys?: string[] } | null;
  propertyCount: number;
  representativePropertyId?: string | null;
  latestJob: { status: string; error: string | null; createdAt: string } | null;
  /** Plan v9 coverage-mgmt — editable label (COALESCE(display_name, registry label)). */
  displayName?: string;
  /** Fixed coverage %: live feeds / available feeds (excludes 'unavailable'). */
  coveragePct?: number;
  /** Per-feed live status — replaces the single "% of actions captured". */
  perFeed?: PerFeed[];
  /** A newly-learned map parked as a DRAFT awaiting review. When present, the
   *  row shows a "needs review" badge alongside the active-map status. */
  pendingReview?: { version: number; score?: number; threshold?: number; reason?: string };
  /** Hotels with no PMS detected (properties.pms_type IS NULL). */
  unassignedHotelCount?: number;
}
type ProspectStatus = 'talking' | 'negotiating' | 'committed' | 'onboarded' | 'dropped';
interface Prospect {
  id: string; hotel_name: string; contact_name: string | null; contact_email: string | null;
  contact_phone: string | null; pms_type: string | null; expected_launch_date: string | null;
  status: ProspectStatus; notes: string | null; checklist: Record<string, boolean>;
  created_at: string; updated_at: string;
}

// ── Blocker kinds → accent tones (used by the timeline rows + panel) ─────
type HelpKind = 'mfa' | 'mapper' | 'cost' | 'login' | 'stopped';
const HELP_DOT: Record<HelpKind, DotTone> = { mfa: 'gold', mapper: 'teal', cost: 'gold', login: 'terracotta', stopped: 'terracotta' };

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
  if (!s || !s.accountCreatedAt) {
    if (s?.step === 2) return { step: 2, label: 'Creating account', sub: 'Clicked Begin — making their login now.', href: propHref, needsYou: false };
    return { step: 1, label: 'Just landed', sub: 'Opened the invite — not started yet.', href: propHref, needsYou: false };
  }
  if (!s.emailVerifiedAt)   return { step: 3, label: 'Verifying email', sub: 'Account made — confirming their email.', href: propHref, needsYou: false };
  if (!s.hotelDetailsAt)    return { step: 4, label: 'Hotel details', sub: 'Entering rooms, brand, timezone.', href: propHref, needsYou: false };
  if (!s.servicesAt)        return { step: 5, label: 'Choosing services', sub: 'Picking housekeeping, laundry, etc.', href: propHref, needsYou: false };
  if (!s.pmsCredentialsAt)  return { step: 6, label: 'Connecting PMS', sub: 'About to enter their PMS login.', href: propHref, needsYou: false };
  if (!s.mappingCompletedAt) return { step: 7, label: 'Robot connecting…', sub: 'Robot is logging into the PMS.', href: propHref, needsYou: false };
  if (!s.staffAt)           return { step: 8, label: 'Adding team', sub: 'Connected — owner is adding staff.', href: propHref, needsYou: false };
  return { step: 9, label: 'Wrapping up', sub: 'Final step — almost live.', href: propHref, needsYou: false };
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
  const [mapsOpen, setMapsOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
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

  // Hover-✕ delete for a junk/test hotel. Confirmed client-side, and the
  // server refuses to delete a hotel that has finished onboarding.
  const deleteHotel = async (p: PropertyRow) => {
    if (!window.confirm(`Delete “${p.name ?? 'this hotel'}”? This permanently removes the hotel, all of its data, and the owner's login (frees the email to re-use).`)) return;
    setDeletingId(p.id);
    try {
      const res = await fetchWithAuth('/api/admin/properties/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: p.id }),
      });
      const json = await res.json();
      if (json.ok) { if (expandedId === p.id) setExpandedId(null); await load(); }
      else window.alert(json.error ?? 'Delete failed');
    } catch (e) {
      window.alert(`Delete failed: ${(e as Error).message}`);
    } finally {
      setDeletingId(null);
    }
  };

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
  // Show every learned PMS, PLUS any family with a freshly-learned map parked
  // for review (even before it has an active map) so the "needs review" signal
  // never hides behind an empty active list.
  const learnedPms = pms.filter((p) => p.recipe !== null || p.pendingReview);
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
          : journeyRows.map(({ p, j }) => (
            <div
              key={p.id}
              style={{ position: 'relative' }}
              onMouseEnter={() => setHoverId(p.id)}
              onMouseLeave={() => setHoverId((h) => (h === p.id ? null : h))}
            >
              <JourneyRow p={p} j={j} expanded={expandedId === p.id} onClick={() => setExpandedId(expandedId === p.id ? null : p.id)} />
              {(hoverId === p.id || deletingId === p.id) && (
                <button
                  title="Delete this hotel"
                  aria-label={`Delete ${p.name ?? 'hotel'}`}
                  onClick={(e) => { e.stopPropagation(); void deleteHotel(p); }}
                  disabled={deletingId === p.id}
                  style={{
                    position: 'absolute', top: 7, right: 7, zIndex: 4,
                    width: 22, height: 22, borderRadius: 6, padding: 0, lineHeight: 1, fontSize: 14,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(24,12,9,.92)', color: 'var(--terracotta)',
                    border: '1px solid rgba(194,86,46,.5)',
                    cursor: deletingId === p.id ? 'wait' : 'pointer',
                  }}
                >{deletingId === p.id ? '·' : '×'}</button>
              )}
              {expandedId === p.id && <JourneyPanel propertyId={p.id} j={j} />}
            </div>
          ))}
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span className="caps" style={{ color: dim(.5) }}>PMS coverage</span>
            <button
              onClick={() => setMapsOpen(true)}
              className="mono"
              title="See every learned map and pick / roll back / delete which one is live"
              style={{ fontSize: 9, letterSpacing: '.06em', color: dim(.62), background: dim(.05), border: `1px solid ${dim(.16)}`, borderRadius: 7, padding: '4px 10px', cursor: 'pointer' }}
            >Manage maps →</button>
          </div>
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

      {selPms && <PmsDetail pms={selPms} onClose={() => setSelPms(null)} onRepaired={load} />}
      <MapsManagerModal open={mapsOpen} onClose={() => setMapsOpen(false)} />
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
function JourneyRow({ p, j, expanded, onClick }: { p: PropertyRow; j: Journey; expanded: boolean; onClick: () => void }) {
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
    <button ref={rowRef} onClick={onClick} aria-expanded={expanded} style={{
      display: 'flex', alignItems: 'center', gap: ROW_GAP, width: '100%', textAlign: 'left',
      background: j.needsYou ? 'rgba(194,86,46,.07)' : expanded ? dim(.07) : dim(.04),
      border: `1px solid ${j.needsYou ? 'rgba(194,86,46,.4)' : expanded ? dim(.22) : dim(.12)}`,
      borderRadius: expanded ? '12px 12px 0 0' : 12, padding: '12px 14px', cursor: 'pointer', color: '#fff',
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
        <div className="mono" style={{ fontSize: 9.5, color: dim(.45), marginTop: 2 }}>{j.step} / {TOTAL_STEPS} · {expanded ? 'close ▴' : 'detail ▾'}</div>
      </div>
    </button>
  );
}

// ── Mission-control panel — expands under a clicked row. Shows what
//    matters for the step the hotel is on; refreshes every 5s while open. ─
interface PanelDetail {
  property: {
    id: string; name: string | null; totalRooms: number | null; brand: string | null;
    timezone: string | null; pmsType: string | null;
    servicesEnabled: Record<string, boolean> | null; createdAt: string;
    onboardingState: OnbState | null; onboardingCompletedAt: string | null;
  };
  owner: { name: string | null; email: string | null; phone: string | null } | null;
  staff: { name: string; department: string | null }[];
  session: {
    pmsFamily: string; status: string; pausedReason: string | null;
    lastAliveAt: string | null; lastSuccessfulReadAt: string | null;
    currentBrowserUrl: string | null; dailySpendMicros: number; capMicros: number;
    restartCount: number; readFailureStreak: number;
  } | null;
  knowledge: { version: number; learnedAt: string | null } | null;
  feeds: { key: string; label: string; lastSyncedAt: string | null; hasError: boolean }[];
  mapperJob: {
    id: string; kind: string; status: string; attempts: number; maxAttempts: number;
    costMicros: number; createdAt: string;
    /** Robot parked on a 2FA screen — render the code box. */
    awaiting2fa: boolean; awaiting2faSince: string | null;
  } | null;
  lastHiccup: string | null;
}

const SESSION_DOT: Record<string, DotTone> = {
  alive: 'forest', starting: 'gold', paused_mfa: 'gold', paused_no_knowledge_file: 'teal',
  paused_cost_cap: 'gold', paused_circuit_breaker: 'terracotta', failed_restart: 'terracotta', stopped: 'muted',
};
const SESSION_LABEL: Record<string, string> = {
  alive: 'Alive — polling', starting: 'Connecting…', paused_mfa: 'Waiting on 2FA code',
  paused_no_knowledge_file: 'Learning this PMS', paused_cost_cap: 'Paused — daily AI cap',
  paused_circuit_breaker: 'Paused — repeated failures', failed_restart: 'Login failing', stopped: 'Stopped',
};
const usdFromMicros = (m: number) => `$${(m / 1_000_000).toFixed(2)}`;

function PanelCaps({ children }: { children: React.ReactNode }) {
  return <div className="mono" style={{ fontSize: 9, letterSpacing: '.14em', textTransform: 'uppercase', color: dim(.45), marginBottom: 8 }}>{children}</div>;
}
function KV({ k, v, tone }: { k: string; v: React.ReactNode; tone?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '3px 0', minWidth: 0 }}>
      <span style={{ fontSize: 11, color: dim(.5), flexShrink: 0 }}>{k}</span>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: tone ?? '#fff', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
    </div>
  );
}
function NoteBox({ tone, children }: { tone: 'gold' | 'terracotta' | 'teal' | 'forest'; children: React.ReactNode }) {
  const bg: Record<string, string> = { gold: 'rgba(201,154,46,.1)', terracotta: 'rgba(194,86,46,.1)', teal: 'rgba(51,137,160,.1)', forest: 'rgba(60,156,104,.1)' };
  const br: Record<string, string> = { gold: 'rgba(201,154,46,.35)', terracotta: 'rgba(194,86,46,.4)', teal: 'rgba(51,137,160,.35)', forest: 'rgba(60,156,104,.35)' };
  return <div style={{ background: bg[tone], border: `1px solid ${br[tone]}`, borderRadius: 10, padding: '9px 11px', fontSize: 11.5, lineHeight: 1.45, color: dim(.85), marginBottom: 8 }}>{children}</div>;
}

// Freshness tone for a feed: green ≤2 min (healthy at ~30s polls), amber
// ≤15 min (lagging), red beyond (stalled), muted when no data yet.
function feedTone(iso: string | null): { tone: DotTone; text: string } {
  if (!iso) return { tone: 'muted', text: 'no data yet' };
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(sec)) return { tone: 'muted', text: 'no data yet' };
  if (sec <= 120) return { tone: 'forest', text: `${age(iso)} ago` };
  if (sec <= 900) return { tone: 'gold', text: `${age(iso)} ago` };
  return { tone: 'terracotta', text: `${age(iso)} ago` };
}

/**
 * 2FA code box — shown while a learning run is parked on the PMS's
 * verification screen (mapperJob.awaiting2fa). The PMS texted a code to
 * Reeyen's phone; he types it here and the robot picks it up within ~3s
 * and keeps going. Emailed codes never need this — the robot reads the
 * hotel's @getstaxis.com inbox itself.
 */
function MfaCodeBox({ propertyId, onDelivered }: { propertyId: string; onDelivered: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const send = async () => {
    const trimmed = code.replace(/[\s-]/g, '');
    if (!/^\d{4,8}$/.test(trimmed)) {
      setNote({ tone: 'err', text: 'Codes are 4-8 digits.' });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const res = await fetchWithAuth('/api/admin/pms-auth-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId, code: trimmed }),
      });
      const json = await res.json();
      if (json.ok) {
        setCode('');
        setNote({ tone: 'ok', text: 'Handed to the robot — it types it in within a few seconds.' });
        onDelivered();
      } else {
        setNote({ tone: 'err', text: json.error ?? 'Could not send the code.' });
      }
    } catch (e) {
      setNote({ tone: 'err', text: `Network error: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void send(); }}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="Code from your phone"
          maxLength={10}
          className="mono"
          style={{
            flex: 1, minWidth: 0, fontSize: 13, letterSpacing: '.18em', padding: '7px 10px',
            background: 'rgba(0,0,0,.3)', color: '#fff', border: `1px solid ${dim(.3)}`,
            borderRadius: 8, outline: 'none',
          }}
        />
        <Btn
          size="sm"
          variant="ghost"
          onClick={() => void send()}
          disabled={busy || code.trim() === ''}
          style={{ color: 'var(--gold)', borderColor: 'rgba(201,154,46,.5)', background: 'rgba(201,154,46,.12)' }}
        >
          {busy ? '…' : 'Send to robot'}
        </Btn>
      </div>
      {note && (
        <div style={{ fontSize: 10.5, marginTop: 5, color: note.tone === 'ok' ? 'var(--forest)' : 'var(--terracotta)' }}>
          {note.text}
        </div>
      )}
    </div>
  );
}

function JourneyPanel({ propertyId, j }: { propertyId: string; j: Journey }) {
  const [d, setD] = useState<PanelDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const fetchDetail = React.useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/admin/onboarding-detail?propertyId=${propertyId}`);
      const json = await res.json();
      if (json.ok) { setD(json.data); setErr(null); }
      else setErr(json.error ?? 'Could not load detail');
    } catch (e) { setErr(`Network error: ${(e as Error).message}`); }
  }, [propertyId]);

  useEffect(() => { riseIn(panelRef.current, { dy: 6, dur: 360 }); }, []);
  useEffect(() => {
    void fetchDetail();
    const t = setInterval(() => { void fetchDetail(); }, 5000);
    return () => clearInterval(t);
  }, [fetchDetail]);

  // Robot actions — same API the robot console uses.
  const act = async (action: 'resume_mfa' | 'reset_cost_cap' | 'stop' | 'restart') => {
    setBusy(action);
    try {
      await fetchWithAuth('/api/admin/cua-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ propertyId, action }) });
      await fetchDetail();
    } finally { setBusy(null); }
  };

  const shell: React.CSSProperties = {
    border: `1px solid ${dim(.22)}`, borderTop: 'none', borderRadius: '0 0 12px 12px',
    background: dim(.03), padding: '14px 16px 16px',
  };
  if (err) return <div ref={panelRef} style={shell}><span style={{ fontSize: 12, color: 'var(--terracotta)' }}>{err}</span></div>;
  if (!d) return <div ref={panelRef} style={shell}><span className="spinner" style={{ width: 14, height: 14, display: 'inline-block', borderTopColor: '#fff' }} /></div>;

  const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 18 };
  const s = d.session;
  const pmsPhase = j.step === 6 || j.step === 7;

  // ── Column: the robot (PMS phase) ──
  const robotCol = (
    <div>
      <PanelCaps>Robot</PanelCaps>
      {s ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
            <Dot tone={SESSION_DOT[s.status] ?? 'muted'} size={7} />
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>{SESSION_LABEL[s.status] ?? s.status}</span>
          </div>
          <KV k="Heartbeat" v={s.lastAliveAt ? `${age(s.lastAliveAt)} ago` : 'never'} tone={s.lastAliveAt && (Date.now() - new Date(s.lastAliveAt).getTime()) < 300_000 ? undefined : 'var(--terracotta)'} />
          <KV k="Last good read" v={s.lastSuccessfulReadAt ? `${age(s.lastSuccessfulReadAt)} ago` : 'none yet'} />
          <KV k="AI spend today" v={`${usdFromMicros(s.dailySpendMicros)} / ${usdFromMicros(s.capMicros)}`} tone={s.dailySpendMicros > s.capMicros * 0.8 ? 'var(--gold)' : undefined} />
          <KV k="PMS playbook" v={d.knowledge ? `v${d.knowledge.version} active` : 'not learned yet'} tone={d.knowledge ? undefined : 'var(--teal)'} />
          <KV k="Restarts · fails" v={`${s.restartCount} · ${s.readFailureStreak}`} tone={s.readFailureStreak > 0 ? 'var(--gold)' : undefined} />
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {s.status === 'paused_mfa' && <Btn size="sm" variant="terracotta" href={`/admin/mfa-resume/${propertyId}`}>Enter 2FA code</Btn>}
            {s.status === 'paused_cost_cap' && <Btn size="sm" variant="forest" onClick={() => void act('reset_cost_cap')} disabled={busy !== null}>{busy === 'reset_cost_cap' ? '…' : 'Reset cap'}</Btn>}
            {(s.status === 'stopped' || s.status === 'failed_restart' || s.status === 'paused_circuit_breaker') && <Btn size="sm" variant="forest" onClick={() => void act('restart')} disabled={busy !== null}>{busy === 'restart' ? '…' : 'Restart'}</Btn>}
            {(s.status === 'alive' || s.status === 'starting') && <Btn size="sm" variant="ghost" onClick={() => void act('stop')} disabled={busy !== null} style={{ color: '#fff', borderColor: dim(.25) }}>{busy === 'stop' ? '…' : 'Stop'}</Btn>}
            <Btn size="sm" variant="ghost" href="/admin/property-sessions" style={{ color: dim(.7), borderColor: dim(.2) }}>Robot console</Btn>
          </div>
        </>
      ) : (
        <div style={{ fontSize: 11.5, color: dim(.5), fontFamily: FONT_SERIF, fontStyle: 'italic' }}>
          No robot yet — it spawns the moment they save their PMS login.
        </div>
      )}
    </div>
  );

  // ── Column: the 5 feeds (PMS phase) ──
  const feedsCol = (
    <div>
      <PanelCaps>Feeds · live every ~30s</PanelCaps>
      {d.feeds.map((f) => {
        const t = feedTone(f.lastSyncedAt);
        return (
          <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
            <Dot tone={t.tone} size={6} />
            <span style={{ fontSize: 11.5, color: dim(.85), flex: 1, minWidth: 0 }}>{f.label}{f.hasError ? ' ⚠' : ''}</span>
            <span className="mono" style={{ fontSize: 9.5, color: t.tone === 'muted' ? dim(.35) : `var(--${t.tone})` }}>{t.text}</span>
          </div>
        );
      })}
      {d.feeds.some((f) => f.hasError) && <div style={{ fontSize: 10, color: 'var(--gold)', marginTop: 6 }}>⚠ bad read — kept the last good numbers</div>}
    </div>
  );

  // ── Column: needs-you + last hiccup (PMS phase) ──
  const attentionCol = (
    <div>
      <PanelCaps>Attention</PanelCaps>
      {d.mapperJob?.awaiting2fa && (
        <NoteBox tone="gold">
          <span style={{ fontWeight: 700, color: 'var(--gold)' }}>Waiting on a 2FA code.</span>{' '}
          The PMS just sent a verification code{d.mapperJob.awaiting2faSince ? ` (${age(d.mapperJob.awaiting2faSince)} ago)` : ''}.
          If it was texted to your phone, type it below — emailed codes are read automatically.
          <MfaCodeBox propertyId={propertyId} onDelivered={() => void fetchDetail()} />
        </NoteBox>
      )}
      {d.mapperJob && (
        <NoteBox tone="teal">
          Learning this PMS — attempt {d.mapperJob.attempts || 1}/{d.mapperJob.maxAttempts} · {usdFromMicros(d.mapperJob.costMicros)} so far
          <div style={{ marginTop: 7 }}><Btn size="sm" variant="ghost" href={`/admin/properties/mapper/${d.mapperJob.id}`} style={{ color: 'var(--teal)', borderColor: 'rgba(51,137,160,.4)' }}>Watch it learn →</Btn></div>
        </NoteBox>
      )}
      {j.needsYou && (
        <NoteBox tone="terracotta">
          {j.sub}
          <div style={{ marginTop: 7 }}><Btn size="sm" variant="terracotta" href={j.href}>Fix it →</Btn></div>
        </NoteBox>
      )}
      {d.lastHiccup
        ? <NoteBox tone="gold"><span className="mono" style={{ fontSize: 9, letterSpacing: '.1em', color: 'var(--gold)' }}>LAST HICCUP · </span>{d.lastHiccup}</NoteBox>
        : (!j.needsYou && !d.mapperJob && <NoteBox tone="forest">Running clean — no hiccups.</NoteBox>)}
    </div>
  );

  // ── Column: who is onboarding (wizard phase) ──
  const personCol = (
    <div>
      <PanelCaps>Who</PanelCaps>
      {d.owner ? (
        <>
          <KV k="Name" v={d.owner.name ?? '—'} />
          <KV k="Email" v={d.owner.email ?? '—'} />
          <KV k="Phone" v={d.owner.phone ?? '—'} />
        </>
      ) : (
        <div style={{ fontSize: 11.5, color: dim(.5), fontFamily: FONT_SERIF, fontStyle: 'italic' }}>No account yet — they haven’t finished step 2.</div>
      )}
      <KV k="Invited" v={`${age(d.property.createdAt)} ago`} />
    </div>
  );

  // ── Column: what they've entered so far (wizard phase) ──
  const services = d.property.servicesEnabled
    ? Object.entries(d.property.servicesEnabled).filter(([, on]) => on).map(([k]) => k.replace(/_/g, ' '))
    : [];
  const enteredCol = (
    <div>
      <PanelCaps>Entered so far</PanelCaps>
      <KV k="Hotel" v={d.property.name ?? '—'} />
      <KV k="Rooms" v={d.property.totalRooms ?? '—'} />
      <KV k="Brand" v={d.property.brand ?? '—'} />
      <KV k="Timezone" v={d.property.timezone ?? '—'} />
      <KV k="PMS" v={d.property.pmsType ?? 'not picked yet'} />
      <KV k="Services" v={services.length ? services.join(', ') : '—'} />
    </div>
  );

  // ── Column: team (steps 8-9) ──
  const teamCol = (
    <div>
      <PanelCaps>Team · {d.staff.length}</PanelCaps>
      {d.staff.length === 0
        ? <div style={{ fontSize: 11.5, color: dim(.5), fontFamily: FONT_SERIF, fontStyle: 'italic' }}>No staff added yet.</div>
        : d.staff.slice(0, 8).map((m, i) => <KV key={i} k={m.name} v={m.department ?? '—'} />)}
      {d.staff.length > 8 && <div className="mono" style={{ fontSize: 9.5, color: dim(.4), marginTop: 4 }}>+{d.staff.length - 8} more</div>}
    </div>
  );

  return (
    <div ref={panelRef} style={shell}>
      <div style={grid}>
        {pmsPhase
          ? <>{robotCol}{feedsCol}{attentionCol}</>
          : j.step >= 8
            ? <>{teamCol}{robotCol}{feedsCol}</>
            : <>{personCol}{enteredCol}{attentionCol}</>}
      </div>
    </div>
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
  const pr = pms.pendingReview;
  // The detail card now does more than repair (rename · view · use-for-all ·
  // detach), so any learned PMS row is clickable.
  return (
    <button onClick={onClick} style={{ textAlign: 'left', display: 'flex', alignItems: 'center', gap: 9, background: dim(.05), border: `1px solid ${dim(.12)}`, borderRadius: 10, padding: '9px 12px', cursor: 'pointer', color: '#fff', width: '100%' }}>
      <Dot tone={st.tone} />
      <span style={{ fontSize: 12, fontWeight: 600, color: '#fff', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pms.displayName ?? pms.label}</span>
      {/* A freshly-learned map is parked for the founder to review — surface it
          right on the list (NOT a button; BayPms is already a <button>). The
          active-map status (dot + label) stays beside it. */}
      {pr && (
        <span
          className="mono"
          title={`A new map (v${pr.version}) is waiting for you to review${pr.reason ? ` — ${pr.reason}` : ''}. Open “Manage maps” to make it live.`}
          style={{
            flexShrink: 0, fontSize: 9, letterSpacing: '.04em', whiteSpace: 'nowrap',
            color: 'var(--gold)', background: 'rgba(201,154,46,.12)',
            border: '1px solid rgba(201,154,46,.4)', borderRadius: 7, padding: '2px 7px',
          }}
        >⚠ New map v{pr.version} · review</span>
      )}
      <span style={{ fontSize: 11, color: st.tone === 'muted' ? dim(.5) : `var(--${st.tone})` }}>{st.label}</span>
      <span className="mono" style={{ fontSize: 9, color: dim(.35) }}>manage ›</span>
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

// Per-feed chip tone: live = green, learning = teal, unavailable = muted.
const FEED_STATE_TONE: Record<FeedState, DotTone> = { live: 'forest', learning: 'teal', unavailable: 'muted' };
const FEED_STATE_WORD: Record<FeedState, string> = { live: 'live', learning: 'learning', unavailable: 'not provided' };

// One hotel as returned by /api/admin/coverage/hotels — attached = currently
// reading through this map; otherwise it's an "Attach" candidate on the family.
interface CoverageHotel { id: string; name: string | null; attached: boolean; pmsType: string | null; sessionStatus: string | null }

// ── PMS detail · per-feed status · rename · view captures · hotels · bulk · detach · delete ─
function PmsDetail({ pms, onClose, onRepaired }: { pms: PMSCoverage; onClose: () => void; onRepaired: () => Promise<void> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Inline rename state.
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(pms.displayName ?? pms.label);
  const [title, setTitle] = useState(pms.displayName ?? pms.label);
  const [nameBusy, setNameBusy] = useState(false);
  // Bulk / detach / delete state — separate so a long-running action doesn't lock the others.
  const [actionBusy, setActionBusy] = useState<'bulk' | 'detach' | 'delete' | null>(null);
  // "Hotels on this coverage" list — fetched on mount.
  const [hotels, setHotels] = useState<CoverageHotel[] | null>(null);
  const [hotelsErr, setHotelsErr] = useState<string | null>(null);
  // Per-row in-flight attach/detach — keyed by hotel id.
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  useEffect(() => { riseIn(ref.current, { dy: 30, dur: 440 }); }, []);

  // Load the hotels on this coverage family (attached + attach-candidates).
  const loadHotels = React.useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/admin/coverage/hotels?pmsFamily=${encodeURIComponent(pms.pmsType)}`);
      const json = await res.json();
      if (json.ok) { setHotels(json.data?.hotels ?? []); setHotelsErr(null); }
      else setHotelsErr(json.error ?? 'Could not load hotels.');
    } catch (err) { setHotelsErr(`Network error: ${(err as Error).message}`); }
  }, [pms.pmsType]);
  useEffect(() => { void loadHotels(); }, [loadHotels]);

  const st = pmsState(pms);
  const keys = pms.recipe?.actionKeys ?? [];
  const propertyId = pms.representativePropertyId;
  // Prefer the backend's fixed coveragePct (live / available feeds) over the
  // recipe's raw captured/5 — only show it if the backend actually sent it.
  const pct = typeof pms.coveragePct === 'number' ? pms.coveragePct : pms.recipe?.coveragePct;
  const feeds = pms.perFeed ?? [];

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

  // Rename → POST /api/admin/coverage/rename. Optimistically updates the title.
  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === title) { setEditingName(false); return; }
    setNameBusy(true); setMsg(null);
    try {
      const res = await fetchWithAuth('/api/admin/coverage/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pmsFamily: pms.pmsType, displayName: trimmed }) });
      const json = await res.json();
      if (json.ok) { setTitle(json.data?.displayName ?? trimmed); setEditingName(false); void onRepaired(); }
      else setMsg(`Rename failed: ${json.error ?? 'unknown'}`);
    } catch (err) { setMsg(`Network error: ${(err as Error).message}`); }
    finally { setNameBusy(false); }
  };

  // Use for all hotels on this PMS → POST /api/admin/coverage/bulk-assign.
  const bulkAssign = async () => {
    if (!confirm(`Use this map for every hotel on ${title}? Each one's robot reconnects with the saved map.`)) return;
    setActionBusy('bulk'); setMsg(null);
    try {
      const res = await fetchWithAuth('/api/admin/coverage/bulk-assign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pmsFamily: pms.pmsType }) });
      const json = await res.json();
      if (json.ok) { const n = json.data?.appliedCount ?? 0; setMsg(`Applied to ${n} ${n === 1 ? 'hotel' : 'hotels'}.`); await loadHotels(); void onRepaired(); }
      else setMsg(`Failed: ${json.error ?? 'unknown'}`);
    } catch (err) { setMsg(`Network error: ${(err as Error).message}`); }
    finally { setActionBusy(null); }
  };

  // Detach → POST /api/admin/coverage/detach. Frees the hotels; keeps the map.
  const detach = async () => {
    if (!confirm("These hotels will show as 'No system detected' on Live Hotels. The map is kept and can be re-matched.")) return;
    setActionBusy('detach'); setMsg(null);
    try {
      const res = await fetchWithAuth('/api/admin/coverage/detach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pmsFamily: pms.pmsType }) });
      const json = await res.json();
      if (json.ok) { const n = json.data?.detachedCount ?? 0; setMsg(`Detached ${n} ${n === 1 ? 'hotel' : 'hotels'} — map kept.`); await loadHotels(); void onRepaired(); }
      else setMsg(`Failed: ${json.error ?? 'unknown'}`);
    } catch (err) { setMsg(`Network error: ${(err as Error).message}`); }
    finally { setActionBusy(null); }
  };

  // Detach one hotel → POST /api/admin/coverage/detach with its propertyId.
  // The map stays; that hotel drops to "No system detected" until re-attached.
  const detachOne = async (h: CoverageHotel) => {
    setRowBusy(h.id); setMsg(null);
    try {
      const res = await fetchWithAuth('/api/admin/coverage/detach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pmsFamily: pms.pmsType, propertyId: h.id }) });
      const json = await res.json();
      if (json.ok) { await loadHotels(); void onRepaired(); }
      else setMsg(`Failed: ${json.error ?? 'unknown'}`);
    } catch (err) { setMsg(`Network error: ${(err as Error).message}`); }
    finally { setRowBusy(null); }
  };

  // Attach one hotel → POST /api/admin/coverage/assign. 409 'no_active_map'
  // means this coverage has no live map yet to point the hotel at.
  const attachOne = async (h: CoverageHotel) => {
    setRowBusy(h.id); setMsg(null);
    try {
      const res = await fetchWithAuth('/api/admin/coverage/assign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ propertyId: h.id, pmsFamily: pms.pmsType }) });
      const json = await res.json();
      if (json.ok) { await loadHotels(); void onRepaired(); }
      else if (json.code === 'no_active_map') setMsg('This coverage has no active map yet — learn or finish mapping first.');
      else setMsg(`Failed: ${json.error ?? 'unknown'}`);
    } catch (err) { setMsg(`Network error: ${(err as Error).message}`); }
    finally { setRowBusy(null); }
  };

  // Delete the whole coverage → POST /api/admin/coverage/delete. Soft-deletes
  // the map and detaches every hotel. A backup is kept and can be restored.
  const deleteCoverage = async () => {
    if (!confirm(`Delete this PMS coverage?\n\nThe robot will forget how to read "${title}", and every hotel on it drops to "No system detected".\n\nA backup is kept — this can be restored.`)) return;
    setActionBusy('delete'); setMsg(null);
    try {
      const res = await fetchWithAuth('/api/admin/coverage/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pmsFamily: pms.pmsType }) });
      const json = await res.json();
      if (json.ok) {
        // Success unmounts this modal — refetch the board, then close LAST so
        // no state is written after unmount.
        void onRepaired();
        onClose();
        return;
      }
      setMsg(`Failed: ${json.error ?? 'unknown'}`);
      setActionBusy(null);
    } catch (err) {
      setMsg(`Network error: ${(err as Error).message}`);
      setActionBusy(null);
    }
  };

  const anyBusy = busy || nameBusy || actionBusy !== null;

  return (
    <Backdrop onClose={onClose}>
      <div ref={ref} onClick={(e) => e.stopPropagation()} style={{ ...modalCard, width: 480 }}>
        <Caps>PMS coverage · {pms.tier ? `Tier ${pms.tier}` : ''}</Caps>

        {/* Editable display name — pencil to edit, Save to commit. */}
        {editingName ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '6px 0 4px' }}>
            <input
              autoFocus value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !nameBusy) void saveName(); if (e.key === 'Escape') { setName(title); setEditingName(false); } }}
              maxLength={60}
              style={{ flex: 1, minWidth: 0, fontFamily: 'var(--serif)', fontSize: 22, fontStyle: 'italic', padding: '4px 8px', border: '1px solid var(--rule)', borderRadius: 8, background: '#fff', color: 'var(--ink)', outline: 'none' }}
            />
            <Btn size="sm" variant="primary" onClick={() => void saveName()} disabled={nameBusy || !name.trim()}>{nameBusy ? '…' : 'Save'}</Btn>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '6px 0 4px' }}>
            <h3 style={{ fontFamily: FONT_SERIF, fontSize: 24, fontWeight: 400, letterSpacing: '-0.02em', margin: 0, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span style={{ fontStyle: 'italic' }}>{title}</span></h3>
            <button onClick={() => { setName(title); setEditingName(true); }} title="Rename this PMS"
              style={{ flexShrink: 0, background: 'none', border: 'none', padding: 4, cursor: 'pointer', color: 'var(--dim)', fontSize: 13, lineHeight: 1 }}>✎</button>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0 14px', flexWrap: 'wrap' }}>
          {typeof pct === 'number' && <Pill tone={pct === 100 ? 'forest' : pct > 0 ? 'gold' : 'neutral'}>{pct}% live</Pill>}
          <span className="mono" style={{ fontSize: 11, color: 'var(--dim2)' }}>{pms.propertyCount} {pms.propertyCount === 1 ? 'hotel' : 'hotels'} · v{pms.recipe?.version ?? 0}</span>
        </div>

        {/* ── Per-feed status — replaces the single "0% captured". ── */}
        {feeds.length > 0 ? (
          <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 14 }}>
            <Caps size={9}>What the robot captures</Caps>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, margin: '8px 0 4px' }}>
              {feeds.map((f) => {
                const tone = FEED_STATE_TONE[f.state];
                return (
                  <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                    <Dot tone={tone} size={6} />
                    <span style={{ fontSize: 12.5, color: 'var(--ink)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.label}</span>
                    <span className="mono" style={{ fontSize: 10, color: f.state === 'unavailable' ? 'var(--dim2)' : `var(--${tone})`, letterSpacing: '.04em' }}>{FEED_STATE_WORD[f.state]}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--dim)', lineHeight: 1.5, marginBottom: 6 }}>{st.note}</p>
        )}

        {/* ── View the rich coverage editor (reuses the existing page). ── */}
        {propertyId && (
          <div style={{ marginTop: 12 }}>
            <Btn size="sm" variant="ghost" href={`/admin/properties/coverage/${propertyId}`} style={{ color: 'var(--teal)', borderColor: 'rgba(51,137,160,.4)' }}>View what the robot captures →</Btn>
          </div>
        )}

        {/* ── Hotels on this coverage — per-hotel attach / detach. ── */}
        <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 14, marginTop: 14 }}>
          <Caps size={9}>Hotels on this coverage</Caps>
          {hotelsErr ? (
            <p style={{ fontSize: 12, color: 'var(--terracotta)', margin: '8px 0 0' }}>{hotelsErr}</p>
          ) : hotels === null ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 2px' }}>
              <span className="spinner" style={{ width: 13, height: 13, display: 'inline-block' }} />
              <span style={{ fontSize: 12, color: 'var(--dim)' }}>Loading hotels…</span>
            </div>
          ) : hotels.length === 0 ? (
            <p style={{ fontSize: 12.5, color: 'var(--dim)', fontFamily: FONT_SERIF, fontStyle: 'italic', margin: '8px 0 2px' }}>No hotels yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '8px 0 2px' }}>
              {hotels.map((h) => {
                const rb = rowBusy === h.id;
                return (
                  <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
                    <Dot tone={h.attached ? 'forest' : 'muted'} size={6} />
                    <span style={{ fontSize: 12.5, color: 'var(--ink)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name ?? '(unnamed)'}</span>
                    {h.attached ? (
                      <Btn size="sm" variant="terracotta" onClick={() => void detachOne(h)} disabled={rb || anyBusy}>{rb ? '…' : 'Detach'}</Btn>
                    ) : (
                      <Btn size="sm" variant="forest" onClick={() => void attachOne(h)} disabled={rb || anyBusy}>{rb ? '…' : 'Attach'}</Btn>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Repair a feed (kept) — re-learn one drifted action (~$2). ── */}
        {keys.length > 0 && propertyId ? (
          <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 14, marginTop: 14 }}>
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
          </div>
        ) : null}

        {msg && <p className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', marginTop: 10, wordBreak: 'break-all' }}>{msg}</p>}

        {/* ── Footer — detach-all · bulk-assign · close. ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 18, borderTop: '1px solid var(--rule)', paddingTop: 14, flexWrap: 'wrap' }}>
          <button onClick={() => void detach()} disabled={anyBusy} title="Free every hotel on this PMS — the map is kept and can be re-matched"
            style={{ background: 'var(--terracotta-dim)', color: 'var(--terracotta-deep)', border: '1px solid rgba(194,86,46,.32)', borderRadius: 999, height: 28, padding: '0 12px', fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 600, cursor: anyBusy ? 'not-allowed' : 'pointer', opacity: anyBusy ? 0.5 : 1 }}>
            {actionBusy === 'detach' ? '…' : 'Detach all'}
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            {pms.recipe && <Btn size="sm" variant="forest" onClick={() => void bulkAssign()} disabled={anyBusy}>{actionBusy === 'bulk' ? '…' : 'Use for all hotels'}</Btn>}
            <Btn size="sm" variant="ghost" onClick={onClose} disabled={anyBusy}>Close</Btn>
          </div>
        </div>

        {/* ── Danger zone — soft-delete the whole coverage (backup kept). ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 12, borderTop: '1px solid var(--rule)', paddingTop: 12, flexWrap: 'wrap' }}>
          <Caps size={9} c="var(--terracotta-deep)">Danger zone</Caps>
          <Btn size="sm" variant="terracotta" onClick={() => void deleteCoverage()} disabled={anyBusy} title="Forget this map and free every hotel — a backup is kept and can be restored">
            {actionBusy === 'delete' ? '…' : 'Delete coverage'}
          </Btn>
        </div>
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
