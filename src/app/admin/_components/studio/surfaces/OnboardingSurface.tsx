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

function bucketByStage(props: PropertyRow[]) {
  const signedUp: LaneRow[] = [], wizardDone: LaneRow[] = [], connecting: LaneRow[] = [], needsHelp: LaneRow[] = [];
  for (const p of props) {
    const base = { id: p.id, name: p.name ?? '(unnamed)', pms: p.pmsType };
    switch (p.sessionStatus) {
      case 'paused_mfa': needsHelp.push({ ...base, kind: 'mfa', sub: 'Waiting for MFA — click to resolve.', href: `/admin/mfa-resume/${p.id}` }); continue;
      case 'paused_no_knowledge_file': needsHelp.push({ ...base, kind: 'mapper', sub: 'Awaiting mapper — PMS not learned.', href: '/admin/property-sessions' }); continue;
      case 'paused_cost_cap': needsHelp.push({ ...base, kind: 'cost', sub: 'Cost cap — auto-resumes at midnight.', href: '/admin/property-sessions' }); continue;
      case 'paused_circuit_breaker':
      case 'failed_restart': needsHelp.push({ ...base, kind: 'login', sub: p.sessionPausedReason ?? 'Login failing — edit credentials.', href: '/admin/property-sessions' }); continue;
      case 'starting': connecting.push({ ...base, sub: 'CUA logging in…', href: `/admin/properties/${p.id}` }); continue;
      case 'stopped': needsHelp.push({ ...base, kind: 'stopped', sub: 'Stopped — click to restart.', href: '/admin/property-sessions' }); continue;
    }
    if (p.pmsConnected) connecting.push({ ...base, sub: 'Creds saved, awaiting session.', href: `/admin/properties/${p.id}` });
    else if (p.staffCount > 0) wizardDone.push({ ...base, href: `/admin/properties/${p.id}` });
    else signedUp.push({ ...base, href: `/admin/properties/${p.id}` });
  }
  return { signedUp, wizardDone, connecting, needsHelp };
}

function pmsState(p: PMSCoverage): { tone: DotTone; label: string; note: string } {
  if (p.recipe && p.recipe.coveragePct === 100) return { tone: 'forest', label: 'Ready', note: 'Ready. Future hotels onboard free.' };
  if (p.recipe && p.recipe.coveragePct < 100) return { tone: 'gold', label: `${p.recipe.coveragePct}%`, note: `Partial — ${p.recipe.coveragePct}% of actions captured.` };
  if (!p.recipe && p.latestJob?.status === 'failed') return { tone: 'terracotta', label: 'Failed', note: 'Last mapping failed. First hotel retries.' };
  return { tone: 'muted', label: 'New', note: 'Not learned. First hotel triggers ~$0.50, ~7 min mapping.' };
}

const card = { bg: 'rgba(255,255,255,.06)', br: 'rgba(255,255,255,.14)' };
const dim = (a: number) => `rgba(255,255,255,${a})`;

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
  // Auto-refresh while CUA sessions are in flight.
  useEffect(() => {
    if (!liveJobs || liveJobs.length === 0) return;
    refreshTimer.current = setTimeout(() => { void load(); }, 5000);
    return () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); };
  }, [liveJobs]);

  if (error) return <DarkShell><div style={{ color: 'var(--terracotta)', fontSize: 13 }}>{error}</div></DarkShell>;
  if (!props || !liveJobs || !pms) {
    return <DarkShell><div style={{ padding: '80px 0', textAlign: 'center' }}><span className="spinner" style={{ width: 22, height: 22, display: 'inline-block', borderTopColor: '#fff' }} /></div></DarkShell>;
  }

  const inOnb = props.filter((p) => p.sessionStatus !== 'alive');
  const b = bucketByStage(inOnb);
  const liveCount = props.length - inOnb.length;
  const learnedPms = pms.filter((p) => p.recipe !== null);
  const activeProspects = (prospects ?? []).filter((p) => p.status !== 'onboarded' && p.status !== 'dropped');

  const lanes = [
    { key: 'signedUp', title: 'Signed up', rows: b.signedUp, accent: '' },
    { key: 'wizardDone', title: 'Wizard done', rows: b.wizardDone, accent: '' },
    { key: 'connecting', title: 'Connecting', rows: b.connecting, accent: 'var(--gold)' },
    { key: 'needsHelp', title: 'Needs help', rows: b.needsHelp, accent: 'var(--terracotta)' },
  ];

  return (
    <DarkShell>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 22, position: 'relative' }}>
        <div>
          <span className="caps" style={{ color: dim(.55) }}>Onboarding · Launch bay</span>
          <h1 style={{ fontFamily: FONT_SERIF, fontSize: 32, fontWeight: 400, letterSpacing: '-0.02em', margin: '4px 0 0', color: '#fff' }}>
            Everything <span style={{ fontStyle: 'italic' }}>inbound to live</span>
          </h1>
        </div>
        <Btn variant="ghost" size="lg" onClick={() => setCreateOpen(true)} style={{ color: '#fff', borderColor: dim(.3), background: dim(.06) }}>+ New hotel</Btn>
      </header>

      {/* Depth track */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr)) 150px', gap: 14, alignItems: 'stretch', position: 'relative', perspective: 1200 }}>
        {lanes.map((ln) => (
          <div key={ln.key} style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: ln.accent || dim(.85) }}>{ln.title}</span>
              <span className="mono" style={{ fontSize: 10, color: dim(.4) }}>{ln.rows.length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {ln.rows.length === 0
                ? <div style={{ padding: '14px 0', textAlign: 'center', color: dim(.25), fontFamily: FONT_SERIF, fontStyle: 'italic' }}>—</div>
                : ln.rows.map((r) => <BayChip key={r.id} r={r} onClick={() => setSelChip(r)} />)}
            </div>
          </div>
        ))}
        {/* Live core */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(180deg, rgba(60,156,104,.25), rgba(60,156,104,.08))', border: '1px solid rgba(60,156,104,.4)', borderRadius: 16, padding: '18px 10px' }}>
          <span className="caps" style={{ color: dim(.6) }}>Live</span>
          <BayLiveCount n={liveCount} />
          <span style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 12, color: dim(.7) }}>polling</span>
        </div>
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

function BayChip({ r, onClick }: { r: LaneRow; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && typeof el.animate === 'function') el.animate([{ opacity: 0, transform: 'translateZ(-40px)' }, { opacity: 1, transform: 'translateZ(0)' }], { duration: 480, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both' });
  }, []);
  const help = !!r.kind;
  return (
    <button ref={ref} onClick={onClick} style={{ textAlign: 'left', background: dim(.06), border: `1px solid ${help ? 'rgba(194,86,46,.45)' : dim(.14)}`, borderRadius: 11, padding: '10px 12px', cursor: 'pointer', color: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {help && <Dot tone={HELP_DOT[r.kind!]} size={6} />}
        <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
      </div>
      {r.pms && <div className="mono" style={{ fontSize: 9, color: dim(.45), marginTop: 3, letterSpacing: '.04em' }}>{r.pms}</div>}
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
