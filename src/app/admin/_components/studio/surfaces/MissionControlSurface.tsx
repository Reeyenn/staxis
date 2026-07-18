'use client';

/* ───────────────────────────────────────────────────────────────────────
   SURFACE — Mission Control (dark).

   Replaces the old System & Agent tab. One glance answers "is anything on
   fire, and does anything need me?" for a non-technical owner. Everything
   below is real data — nothing mocked.

   Three blocks, top → bottom:
     1. Three health lights — App · Robots · AI spend today. Big status dot +
        plain-English one-liner, click to expand the detail.
     2. AI employees roster — the copilot, the per-hotel robots (with inline
        Restart / Stop / Reset-cap / Enter-2FA controls), and the background
        workers grouped by job family.
     3. Needs-your-okay inbox + the 72h grouped-errors panel (the same card UI
        LiveSurface uses for its errors column).

   Data sources:
     • GET /api/admin/system-status        → web/db/ml/cua service colours
     • GET /api/admin/cua-sessions         → per-hotel robot sessions
     • GET /api/agent/metrics              → copilot spend / requests / errors
     • GET /api/admin/mission/workers      → background cron heartbeats  (NEW)
     • GET /api/admin/mission/inbox        → robot attention items       (NEW)
     • GET /api/admin/recent-errors?since= → 72h grouped app errors

   The two /api/admin/mission/* endpoints are landing in parallel. This
   surface tolerates them 404-ing or returning partial shapes: the errors
   panel and every light/roster row still render, and the inbox falls back to
   deriving robot-attention items straight from the (reliable) cua-sessions
   feed so it stays honest before mission/inbox is live.

   Dark surface: <SurfaceShell glow="forestTop"> + DarkCard / dimWhite, the
   same chrome LiveSurface and MoneySurface use.
   ─────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  FONT_SERIF, Pill, Dot, Btn, SerifNum, countUp, age,
  type DotTone, type PillTone,
} from '../kit';
import {
  SurfaceShell, DarkCard, DarkSpinner, DarkEmpty, dimWhite,
} from '../surface-kit';

// $5/hotel/day Claude cost cap (cua-service operational guardrail).
const ROBOT_CAP_USD = 5;
// Poll cadence — system-status is designed for light client polling.
const POLL_MS = 30_000;

// ── Consumed shapes (kept loose — endpoints may add fields / land partial) ──
type ServiceColor = 'green' | 'yellow' | 'red';
interface ServiceStatus { status: ServiceColor; latency_ms?: number; message?: string }
interface SystemServices { web: ServiceStatus; ml: ServiceStatus; cua: ServiceStatus; supabase: ServiceStatus }

interface CuaSession {
  property_id: string;
  display_name?: string | null;
  pms_family?: string | null;
  status: string;
  last_alive_at: string | null;
  last_successful_read_at?: string | null;
  daily_claude_cost_micros?: number;
  paused_reason?: string | null;
  restart_count?: number;
  read_failure_streak?: number;
  active_mapper_job?: { id: string; status: string; created_at: string; needs_help?: boolean } | null;
  last_mapper_job?: { id: string; status: string; created_at: string } | null;
}

interface AgentMetrics {
  caps?: { user: number; property: number; global: number };
  today?: { totalCostUsd?: number; backgroundCostUsd?: number; requestCount?: number };
  toolErrorsToday?: number;
  toolIncompleteToday?: number;
  pendingNudges?: number;
  topTools?: Array<{ tool: string; calls: number; errors: number; incomplete: number; errorRatePct: number }>;
}

// mission/workers row. The endpoint assigns `tier` server-side ('ai' |
// 'prediction' | 'timer') so the roster can split the workforce into AI staff,
// the prediction engine, and plain scheduled chores. A row from an older
// cached response may omit `tier`; tierOf() treats that as 'timer'.
interface WorkerRow {
  name: string;
  description?: string | null;
  tier?: string; // 'ai' | 'prediction' | 'timer' (defensive: anything)
  cadenceHours?: number | null;
  lastBeatAt?: string | null;
  ageHours?: number | null;
  state?: string; // 'ok' | 'late' | 'never' | (defensive: anything)
}

// mission/inbox row. `action` is a structured control descriptor from the
// endpoint ({type:'link'|'reset_cost_cap'|'restart', …}); tolerated loosely.
interface InboxAction {
  type?: string;
  href?: string | null;
  label?: string | null;
  propertyId?: string | null;
}
interface InboxRow {
  kind?: string;
  propertyId?: string | null;
  propertyName?: string | null;
  title?: string | null;
  detail?: string | null;
  action?: InboxAction | string | null;
  count?: number | null;
}

interface ErrorGroup {
  source: string | null;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  affectedPropertyIds: string[];
  sampleStack: string | null;
}

// ── Tone helpers ──────────────────────────────────────────────────────────
const TONE_VAR: Record<DotTone, string> = {
  forest: 'var(--forest)', gold: 'var(--gold)', terracotta: 'var(--terracotta)',
  teal: 'var(--teal)', ink: 'var(--ink)', muted: 'var(--dim2)',
};
const SERVICE_TONE: Record<ServiceColor, DotTone> = { green: 'forest', yellow: 'gold', red: 'terracotta' };
function pillOf(tone: DotTone): PillTone {
  return tone === 'muted' ? 'neutral' : (tone as PillTone);
}
function worstColor(cs: Array<ServiceColor | null | undefined>): ServiceColor {
  if (cs.some((c) => c === 'red')) return 'red';
  if (cs.some((c) => c === 'yellow')) return 'yellow';
  return 'green';
}
const money = (d: number): string => `$${d.toFixed(2)}`;
function humanize(raw: string): string {
  const s = (raw || '').replace(/[-_]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—';
}
function robotSpendUsd(s: CuaSession): number {
  const micros = typeof s.daily_claude_cost_micros === 'number' ? s.daily_claude_cost_micros : 0;
  return micros / 1_000_000;
}

// Robot status → plain-English label + tone (owner reads "Working", not "alive").
function robotView(status: string): { tone: DotTone; label: string } {
  const s = (status || '').toLowerCase();
  if (s === 'alive') return { tone: 'forest', label: 'Working' };
  if (s === 'starting') return { tone: 'gold', label: 'Starting up' };
  if (s === 'stopped') return { tone: 'muted', label: 'Stopped' };
  if (s.includes('cost_cap')) return { tone: 'gold', label: 'Hit its $5 cap' };
  // paused_mfa is amber for the health light + roster pill (spec groups it
  // with cost-cap as "attention", not "outage"). The inbox card still flags
  // the blocking 2FA action in red.
  if (s.includes('mfa')) return { tone: 'gold', label: 'Waiting for a 2FA code' };
  if (s.includes('circuit')) return { tone: 'terracotta', label: 'Paused after repeated errors' };
  if (s.includes('fail')) return { tone: 'terracotta', label: 'Crashed' };
  if (s.includes('no_knowledge')) return { tone: 'gold', label: 'Still learning' };
  if (s.includes('paused')) return { tone: 'gold', label: 'Paused' };
  return { tone: 'muted', label: humanize(status) };
}
function robotSeverity(tone: DotTone): number {
  return tone === 'terracotta' ? 3 : tone === 'gold' ? 2 : tone === 'muted' ? 1 : 0;
}

// Worker heartbeat state → label + tone. The workers feed only emits
// 'ok' | 'late' | 'never', so a worker row stays calm — green when on time,
// amber when running late, gray when it hasn't run yet. Never red.
function workerView(state: string | undefined): { tone: DotTone; label: string } {
  const s = (state || '').toLowerCase();
  if (s === 'ok') return { tone: 'forest', label: 'On time' };
  if (s === 'late') return { tone: 'gold', label: 'Running late' };
  if (s === 'never') return { tone: 'muted', label: "Hasn't run yet" };
  return { tone: 'muted', label: state ? humanize(state) : 'Unknown' };
}

// The owner's three-way mental model for a background worker: 'ai' thinks with
// a language model, 'prediction' is classic forecasting math, 'timer' is a
// plain scheduled chore. A row from an older cached response with no tier
// falls back to 'timer' (the quietest bucket).
type WorkerTier = 'ai' | 'prediction' | 'timer';
function tierOf(w: WorkerRow): WorkerTier {
  const t = (w.tier || '').toLowerCase();
  if (t === 'ai') return 'ai';
  if (t === 'prediction') return 'prediction';
  return 'timer';
}

// Read one settled fetch as JSON without ever throwing (404 → null).
async function jsonOf(r: PromiseSettledResult<Response>) {
  if (r.status !== 'fulfilled') return null;
  try { return await r.value.json(); } catch { return null; }
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ════════════════════════════════════════════════════════════════════════
//  SURFACE
// ════════════════════════════════════════════════════════════════════════
export function MissionControlSurface() {
  const [system, setSystem] = useState<SystemServices | null>(null);
  const [sessions, setSessions] = useState<CuaSession[]>([]);
  const [metrics, setMetrics] = useState<AgentMetrics | null>(null);
  const [workers, setWorkers] = useState<WorkerRow[] | null>(null); // null = not loaded / unavailable
  const [inboxRows, setInboxRows] = useState<InboxRow[] | null>(null); // null = endpoint not live yet
  const [errors, setErrors] = useState<ErrorGroup[]>([]);

  const [loaded, setLoaded] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  // Keyed busy flag so a single Restart/Stop/Reset button spins alone.
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    const since72h = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const settled = await Promise.allSettled([
      fetchWithAuth('/api/admin/system-status'),
      fetchWithAuth('/api/admin/cua-sessions'),
      fetchWithAuth('/api/agent/metrics'),
      fetchWithAuth('/api/admin/mission/workers'),
      fetchWithAuth('/api/admin/mission/inbox'),
      fetchWithAuth(`/api/admin/recent-errors?since=${encodeURIComponent(since72h)}`),
    ]);

    if (settled.every((r) => r.status === 'rejected')) {
      setFatalError('Could not reach the server. Check your connection and try again.');
      setLoaded(true);
      return;
    }
    setFatalError(null);

    const [sysJson, cuaJson, metricsJson, workersJson, inboxJson, errorsJson] = await Promise.all(
      settled.map(jsonOf),
    );

    // system-status returns services at the top level (no data envelope).
    if (sysJson?.services) setSystem(sysJson.services as SystemServices);

    if (cuaJson?.data?.sessions) setSessions(cuaJson.data.sessions as CuaSession[]);

    // agent/metrics uses the ok() envelope → payload under data.
    if (metricsJson?.data) setMetrics(metricsJson.data as AgentMetrics);

    // mission/workers — tolerate data:[...] OR data:{workers:[...]}.
    if (workersJson?.ok) {
      const arr = asArray(workersJson.data?.workers ?? workersJson.data) as WorkerRow[];
      setWorkers(arr);
    }

    // mission/inbox — tolerate data:[...] OR data:{items:[...]}.
    if (inboxJson?.ok) {
      const arr = asArray(inboxJson.data?.items ?? inboxJson.data) as InboxRow[];
      setInboxRows(arr);
    }

    if (errorsJson?.data?.groups) setErrors(errorsJson.data.groups as ErrorGroup[]);

    setLoadedAt(new Date().toISOString());
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const runAction = async (key: string, propertyId: string, action: string) => {
    if (busyKey) return;
    setBusyKey(key);
    try {
      await fetchWithAuth('/api/admin/cua-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId, action }),
      });
      await load();
    } finally {
      setBusyKey(null);
    }
  };

  // ── First-load states ────────────────────────────────────────────────
  if (!loaded) {
    return (
      <SurfaceShell glow="forestTop">
        <span className="caps" style={{ color: dimWhite(.55) }}>Mission Control</span>
        <div style={{ padding: '80px 0', textAlign: 'center' }}><DarkSpinner /></div>
      </SurfaceShell>
    );
  }
  if (fatalError) {
    return (
      <SurfaceShell glow="forestTop">
        <span className="caps" style={{ color: dimWhite(.55) }}>Mission Control</span>
        <div style={{ marginTop: 18, padding: '14px 16px', background: 'var(--terracotta-dim)', border: '1px solid rgba(194,86,46,.4)', borderRadius: 14, color: 'var(--terracotta)', fontSize: 13 }}>
          {fatalError}
        </div>
      </SurfaceShell>
    );
  }

  // ── Derivations ──────────────────────────────────────────────────────
  // Owner's rule (2026-07-17): robots still LEARNING their PMS belong to the
  // Onboarding tab — Mission Control only shows robots that graduated to
  // daily work. Learning = no knowledge file yet, or a learning run in flight.
  const isOnboardingPhase = (s: CuaSession): boolean =>
    (s.status || '').toLowerCase().includes('no_knowledge') || s.active_mapper_job != null;
  const learningCount = sessions.filter(isOnboardingPhase).length;
  const liveRobots = sessions.filter((s) => !isOnboardingPhase(s));
  const enabledSessions = liveRobots.filter((s) => (s.status || '').toLowerCase() !== 'stopped');

  // Split the worker roster by the owner's three-way mental model. A missing
  // tier (old cached response) falls back to 'timer' inside tierOf().
  const aiWorkers = (workers ?? []).filter((w) => tierOf(w) === 'ai');
  const predictionWorkers = (workers ?? []).filter((w) => tierOf(w) === 'prediction');
  const timerWorkers = (workers ?? []).filter((w) => tierOf(w) === 'timer');
  // Headline counts ONLY the AI staff — the copilot, the hotel robots, and the
  // thinking-model background jobs. Prediction + chores are not "AI staff".
  const aiStaffCount = 1 /* copilot */ + liveRobots.length + aiWorkers.length;

  // App light — website + database drive the colour; expanded shows all four.
  const appLight = (() => {
    if (!system) return { tone: 'muted' as DotTone, detail: 'Checking the website and database…' };
    const worst = worstColor([system.web?.status, system.supabase?.status]);
    const tone = SERVICE_TONE[worst];
    const detail = worst === 'green'
      ? 'Website and database are both healthy.'
      : worst === 'yellow'
      ? 'Something is a little slow — the app is still up.'
      : 'A core service is down — the app may be affected.';
    return { tone, detail };
  })();

  // Robot light.
  const robotLight = (() => {
    if (liveRobots.length === 0) {
      return { tone: 'muted' as DotTone, detail: learningCount > 0
        ? `${learningCount} robot${learningCount === 1 ? ' is' : 's are'} still in training — watch on Onboarding.`
        : 'No robots yet.' };
    }
    if (enabledSessions.length === 0) return { tone: 'muted' as DotTone, detail: 'All robots are stopped.' };
    const views = enabledSessions.map((s) => robotView(s.status));
    const worstSev = Math.max(...views.map((v) => robotSeverity(v.tone)));
    const tone: DotTone = worstSev === 3 ? 'terracotta' : worstSev === 2 ? 'gold' : worstSev === 1 ? 'muted' : 'forest';
    if (tone === 'forest') {
      const working = enabledSessions.filter((s) => (s.status || '').toLowerCase() === 'alive').length;
      return { tone, detail: `${working} of ${enabledSessions.length} robot${enabledSessions.length === 1 ? '' : 's'} working normally.` };
    }
    const trouble = enabledSessions
      .filter((s) => robotSeverity(robotView(s.status).tone) >= 2)
      .slice(0, 2)
      // Lowercase the label mid-sentence but keep acronyms like 2FA intact.
      .map((s) => `${s.display_name ?? 'A hotel'} — ${robotView(s.status).label.toLowerCase().replace('2fa', '2FA')}`);
    return { tone, detail: trouble.join('; ') || 'One or more robots need attention.' };
  })();

  // Spend light — worst of copilot-vs-global-cap and worst robot-vs-$5.
  const copilotSpend = (metrics?.today?.totalCostUsd ?? 0) + (metrics?.today?.backgroundCostUsd ?? 0);
  const globalCap = metrics?.caps?.global ?? 0;
  const copilotPct = globalCap > 0 ? copilotSpend / globalCap : 0;
  const robotWorst = sessions.reduce(
    (m, s) => { const u = robotSpendUsd(s); return u > m.usd ? { name: s.display_name ?? 'a hotel', usd: u } : m; },
    { name: '', usd: 0 },
  );
  const robotPct = robotWorst.usd / ROBOT_CAP_USD;
  const spendLight = (() => {
    if (!metrics && liveRobots.length === 0) return { tone: 'muted' as DotTone, detail: 'No AI spend yet today.' };
    const pct = Math.max(copilotPct, robotPct);
    const tone: DotTone = pct >= 1 ? 'terracotta' : pct >= 0.7 ? 'gold' : 'forest';
    const detail = `Copilot ${money(copilotSpend)}${globalCap > 0 ? ` of $${globalCap}` : ''} today` +
      (robotWorst.usd > 0 ? ` · busiest robot ${money(robotWorst.usd)} of $${ROBOT_CAP_USD}` : '');
    return { tone, detail };
  })();

  // Inbox — endpoint when live, else derived from reliable cua-sessions data.
  const pendingNudges = metrics?.pendingNudges ?? 0;
  const inboxCards: InboxCard[] = (inboxRows !== null)
    ? inboxRows.map((it, i) => endpointInboxCard(it, i, runAction, busyKey))
    : derivedInboxCards(liveRobots, pendingNudges, runAction, busyKey);

  const attentionCount = inboxCards.length;

  return (
    <SurfaceShell glow="forestTop">
      {/* Header */}
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
        <div style={{ minWidth: 0 }}>
          <span className="caps" style={{ color: dimWhite(.55) }}>Mission Control</span>
          <h1 style={{ fontFamily: FONT_SERIF, fontSize: 30, fontWeight: 400, letterSpacing: '-0.02em', margin: '4px 0 0', color: '#fff', whiteSpace: 'nowrap' }}>
            <HeroCount n={aiStaffCount} /> <span style={{ fontStyle: 'italic' }}>AI staff on watch</span>
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {loadedAt && (
            <span className="mono" style={{ fontSize: 10.5, color: dimWhite(.4) }}>Updated {age(loadedAt)} ago</span>
          )}
          <Btn size="sm" variant="ghost" onClick={() => { void load(); }} style={{ color: '#fff', borderColor: dimWhite(.25) }}>Refresh</Btn>
        </div>
      </header>

      {/* ── Block 1 — three health lights ─────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginBottom: 26 }}>
        <HealthLight tone={appLight.tone} label="App" detail={appLight.detail} expanded={<AppDetail system={system} />} />
        <HealthLight tone={robotLight.tone} label="Robots" detail={robotLight.detail} expanded={<RobotLightDetail sessions={enabledSessions} />} />
        <HealthLight tone={spendLight.tone} label="AI spend today" detail={spendLight.detail} expanded={<SpendDetail copilotSpend={copilotSpend} globalCap={globalCap} robotWorst={robotWorst} />} />
      </div>

      {/* ── Block 2 — the roster in three side-by-side columns (owner's
          layout, 2026-07-17): left = Copilot + hotel robots, middle =
          automatic AI jobs, right = prediction engine over scheduled
          chores. Fills the width instead of one long scroll; columns wrap
          on narrow windows. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 20, alignItems: 'start', marginBottom: 26 }}>
        {/* LEFT — the thinking-model workforce doing the real work. */}
        <RosterSection
          eyebrow="AI staff"
          count={1 + liveRobots.length}
          eyebrowColor={dimWhite(.62)}
          subtitle="Thinks with a language model — couldn't exist before AI."
          last
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <CopilotRow metrics={metrics} />
            <div>
              <span className="caps" style={{ color: dimWhite(.4), fontSize: 9.5 }}>Hotel robots · {liveRobots.length}</span>
              {liveRobots.length === 0 ? (
                <div style={{ marginTop: 9 }}>
                  <DarkEmpty text={learningCount > 0
                    ? `No graduated robots yet — ${learningCount === 1 ? 'one robot is' : `${learningCount} robots are`} still learning on the Onboarding tab.`
                    : "No hotel robots yet — they appear once a hotel's system is connected."} />
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 9 }}>
                  {liveRobots.map((s) => (
                    <RobotRow key={s.property_id} s={s} busyKey={busyKey} onAction={runAction} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </RosterSection>

        {/* MIDDLE — the AI-written background jobs. */}
        <RosterSection
          eyebrow="Automatic AI jobs"
          count={aiWorkers.length}
          eyebrowColor={dimWhite(.55)}
          subtitle="AI-written reports and tidy-ups that run on their own."
          last
        >
          {workers === null ? (
            <DarkEmpty text="AI jobs will appear here." />
          ) : aiWorkers.length === 0 ? (
            <DarkEmpty text="No automatic AI jobs yet." />
          ) : (
            <DarkCard style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
              {aiWorkers.map((w) => <SimpleWorkerRow key={w.name} w={w} />)}
            </DarkCard>
          )}
        </RosterSection>

        {/* RIGHT — the prediction engine (classic ML, no language model). */}
        <RosterSection
          eyebrow="Prediction engine"
          count={predictionWorkers.length}
          eyebrowColor={dimWhite(.46)}
          subtitle="Classic forecasting math — learns from numbers, doesn't think."
          last
        >
          {workers === null ? (
            <DarkEmpty text="Prediction jobs will appear here." />
          ) : predictionWorkers.length === 0 ? (
            <DarkEmpty text="No prediction jobs yet." />
          ) : (
            <div style={{ background: dimWhite(.04), border: `1px solid ${dimWhite(.1)}`, borderRadius: 12, padding: '13px 14px', display: 'flex', flexDirection: 'column', gap: 11 }}>
              {predictionWorkers.map((w) => <SimpleWorkerRow key={w.name} w={w} />)}
            </div>
          )}
        </RosterSection>
      </div>

      {/* ── Block 3 — second three-column row (owner's layout): chores ·
          needs-your-okay · errors. ─────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20, alignItems: 'start' }}>
        {/* Scheduled chores */}
        <RosterSection
          eyebrow="Scheduled chores"
          count={timerWorkers.length}
          eyebrowColor={dimWhite(.42)}
          subtitle="Plain timers doing janitor work."
          last
        >
          {workers === null ? (
            <DarkEmpty text="Scheduled chores will appear here." />
          ) : timerWorkers.length === 0 ? (
            <DarkEmpty text="No scheduled chores yet." />
          ) : (
            <ChoresRow rows={timerWorkers} />
          )}
        </RosterSection>

        {/* Needs your okay */}
        <section style={{ minWidth: 0 }}>
          <span className="caps" style={{ color: dimWhite(.5) }}>Needs your okay · {attentionCount}</span>
          {inboxCards.length === 0 ? (
            <div style={{ marginTop: 10 }}><DarkEmpty text="Nothing needs you." /></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              {inboxCards.map((c) => <InboxCardView key={c.key} card={c} />)}
            </div>
          )}
        </section>

        {/* Recent errors · 72h */}
        <section style={{ minWidth: 0 }}>
          <span className="caps" style={{ color: dimWhite(.5) }}>Recent errors · 72h · {errors.length}</span>
          {errors.length === 0 ? (
            <div style={{ marginTop: 10 }}><DarkEmpty text="No errors ✓" /></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              {errors.map((g, i) => <ErrorRow key={i} g={g} />)}
            </div>
          )}
        </section>
      </div>
    </SurfaceShell>
  );
}

// ── Header count ───────────────────────────────────────────────────────────
function HeroCount({ n }: { n: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => { countUp(ref.current, 0, n, { dur: 900, fmt: (v) => String(Math.round(v)) }); }, [n]);
  return <SerifNum size={30} c="#fff"><span ref={ref}>{n}</span></SerifNum>;
}

// ── Big status light element (dot + soft ring/glow) ────────────────────────
function StatusLight({ tone, size = 15 }: { tone: DotTone; size?: number }) {
  const c = TONE_VAR[tone];
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: size, height: size, flexShrink: 0 }}>
      <span style={{ position: 'absolute', inset: -5, borderRadius: '50%', background: c, opacity: .16 }} />
      <span style={{ width: size, height: size, borderRadius: '50%', background: c, boxShadow: `0 0 12px ${c}` }} />
    </span>
  );
}

// ── Health light card — collapsed one-liner, click to expand detail ───────
function HealthLight({ tone, label, detail, expanded }: {
  tone: DotTone; label: string; detail: string; expanded?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DarkCard
      onClick={expanded ? () => setOpen((o) => !o) : undefined}
      style={{ cursor: expanded ? 'pointer' : 'default' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ marginTop: 2 }}><StatusLight tone={tone} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{label}</span>
            {expanded && <span className="mono" style={{ marginLeft: 'auto', fontSize: 12, color: dimWhite(.4) }}>{open ? '▾' : '▸'}</span>}
          </div>
          <div style={{ fontSize: 12, color: dimWhite(.6), marginTop: 4, lineHeight: 1.45 }}>{detail}</div>
        </div>
      </div>
      {open && expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${dimWhite(.1)}` }}>{expanded}</div>
      )}
    </DarkCard>
  );
}

const SERVICE_LABEL: Record<keyof SystemServices, string> = {
  web: 'Website', supabase: 'Database', ml: 'Prediction service', cua: 'Robot worker',
};
function AppDetail({ system }: { system: SystemServices | null }) {
  if (!system) return <span style={{ fontSize: 12, color: dimWhite(.5) }}>Still checking…</span>;
  const order: Array<keyof SystemServices> = ['web', 'supabase', 'ml', 'cua'];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {order.map((k) => {
        const svc = system[k];
        const tone = SERVICE_TONE[svc?.status ?? 'green'];
        return (
          <div key={k} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <Dot tone={tone} size={7} style={{ marginTop: 5 }} />
            <div style={{ minWidth: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>{SERVICE_LABEL[k]}</span>
              {svc?.message && <div style={{ fontSize: 11, color: dimWhite(.5), marginTop: 1 }}>{svc.message}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RobotLightDetail({ sessions }: { sessions: CuaSession[] }) {
  if (sessions.length === 0) return <span style={{ fontSize: 12, color: dimWhite(.5) }}>No active robots.</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {sessions.map((s) => {
        const v = robotView(s.status);
        return (
          <div key={s.property_id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Dot tone={v.tone} size={7} />
            <span style={{ fontSize: 12, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.display_name ?? s.property_id}</span>
            <span className="mono" style={{ marginLeft: 'auto', fontSize: 10.5, color: dimWhite(.5), flexShrink: 0 }}>{v.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function SpendDetail({ copilotSpend, globalCap, robotWorst }: {
  copilotSpend: number; globalCap: number; robotWorst: { name: string; usd: number };
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, color: dimWhite(.7) }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <span>Copilot (all hotels)</span>
        <span className="mono" style={{ color: '#fff' }}>{money(copilotSpend)}{globalCap > 0 ? ` / $${globalCap}` : ''}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <span>Busiest robot{robotWorst.name ? ` (${robotWorst.name})` : ''}</span>
        <span className="mono" style={{ color: '#fff' }}>{money(robotWorst.usd)} / ${ROBOT_CAP_USD}</span>
      </div>
      <div style={{ fontSize: 11, color: dimWhite(.4), marginTop: 2 }}>
        Each robot pauses itself at its ${ROBOT_CAP_USD}/day cap; the copilot shares one fleet-wide daily budget.
      </div>
    </div>
  );
}

// ── Copilot row (expandable to tool-call mix) ─────────────────────────────
function CopilotRow({ metrics }: { metrics: AgentMetrics | null }) {
  const [open, setOpen] = useState(false);
  const requests = metrics?.today?.requestCount ?? 0;
  const spend = (metrics?.today?.totalCostUsd ?? 0) + (metrics?.today?.backgroundCostUsd ?? 0);
  const trouble = (metrics?.toolErrorsToday ?? 0) + (metrics?.toolIncompleteToday ?? 0);
  const tone: DotTone = !metrics ? 'muted' : trouble > 0 ? 'gold' : 'forest';
  const tools = metrics?.topTools ?? [];

  return (
    <DarkCard onClick={() => setOpen((o) => !o)} style={{ cursor: 'pointer', padding: '13px 15px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}>
        <Dot tone={tone} size={9} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>Copilot</div>
          <div style={{ fontSize: 11, color: dimWhite(.45), marginTop: 1 }}>Answers questions and runs tasks inside the app</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <Metric label="Handled today" value={String(requests)} />
          <Metric label="Spent today" value={money(spend)} />
          <Metric label="Had trouble" value={trouble > 0 ? String(trouble) : 'none'} tone={trouble > 0 ? 'gold' : undefined} />
          <span className="mono" style={{ fontSize: 12, color: dimWhite(.4) }}>{open ? '▾' : '▸'}</span>
        </div>
      </div>
      {open && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${dimWhite(.1)}` }}>
          <span className="caps" style={{ color: dimWhite(.4), fontSize: 9 }}>What it did today</span>
          {tools.length === 0 ? (
            <div style={{ fontSize: 12, color: dimWhite(.45), marginTop: 8, fontFamily: FONT_SERIF, fontStyle: 'italic' }}>No activity recorded yet today.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {tools.map((t) => (
                <div key={t.tool} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 12, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{humanize(t.tool)}</span>
                  <span className="mono" style={{ marginLeft: 'auto', fontSize: 10.5, color: dimWhite(.5), flexShrink: 0 }}>
                    {t.calls} run{t.calls === 1 ? '' : 's'}{t.errors > 0 ? ` · ${t.errors} failed` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </DarkCard>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: DotTone }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div className="mono" style={{ fontSize: 8.5, color: dimWhite(.4), letterSpacing: '.1em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: tone ? TONE_VAR[tone] : '#fff', marginTop: 1 }}>{value}</div>
    </div>
  );
}

// ── Hotel robot row ───────────────────────────────────────────────────────
function RobotRow({ s, busyKey, onAction }: {
  s: CuaSession;
  busyKey: string | null;
  onAction: (key: string, propertyId: string, action: string) => void;
}) {
  const v = robotView(s.status);
  const status = (s.status || '').toLowerCase();
  const spend = robotSpendUsd(s);
  const spendTone: DotTone = spend >= ROBOT_CAP_USD ? 'terracotta' : spend >= ROBOT_CAP_USD * 0.7 ? 'gold' : 'muted';
  const needsHelp = s.active_mapper_job?.needs_help === true;
  const learnJobId = s.active_mapper_job?.id ?? null;

  const canRestart = status.includes('fail') || status === 'stopped' || status.includes('circuit');
  const canReset = status.includes('cost_cap');
  const needsMfa = status.includes('mfa');
  const canStop = status === 'alive' || status === 'starting' || (!canRestart && !needsMfa);

  const btnStyle = { color: '#fff', borderColor: dimWhite(.25), fontSize: 9.5, padding: '3px 9px' } as const;
  const restartKey = `${s.property_id}:restart`;
  const stopKey = `${s.property_id}:stop`;
  const resetKey = `${s.property_id}:reset_cost_cap`;

  return (
    <div style={{
      background: dimWhite(.05),
      border: `1px solid ${v.tone === 'forest' || v.tone === 'muted' ? dimWhite(.12) : `var(--${v.tone})`}`,
      borderRadius: 12, padding: '11px 13px', color: '#fff',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
        <Dot tone={v.tone} size={8} />
        <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {s.display_name ?? s.property_id}
        </span>
        <Pill tone={pillOf(v.tone)} style={{ fontSize: 9, padding: '2px 7px' }}>{v.label}</Pill>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="mono" style={{ fontSize: 9.5, color: dimWhite(.5) }}>{s.last_alive_at ? `last seen ${age(s.last_alive_at)} ago` : 'not seen yet'}</span>
          <span className="mono" style={{ fontSize: 9.5, color: TONE_VAR[spendTone] }}>{money(spend)} of ${ROBOT_CAP_USD}</span>
        </div>
      </div>

      {(needsHelp || s.pms_family) && (
        <div className="mono" style={{ fontSize: 9.5, color: needsHelp ? 'var(--terracotta)' : dimWhite(.4), marginTop: 6 }}>
          {needsHelp ? 'Stuck — it needs your help to keep learning' : s.pms_family}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {canRestart && (
          <Btn size="sm" variant="ghost" disabled={busyKey === restartKey} onClick={() => onAction(restartKey, s.property_id, 'restart')} style={btnStyle}>
            {busyKey === restartKey ? 'Restarting…' : 'Restart'}
          </Btn>
        )}
        {canReset && (
          <Btn size="sm" variant="forest" disabled={busyKey === resetKey} onClick={() => onAction(resetKey, s.property_id, 'reset_cost_cap')} style={{ fontSize: 9.5, padding: '3px 9px' }}>
            {busyKey === resetKey ? 'Resetting…' : 'Reset cap'}
          </Btn>
        )}
        {needsMfa && (
          <Btn size="sm" variant="ghost" href={`/admin/mfa-resume/${s.property_id}`} style={btnStyle}>Enter 2FA code</Btn>
        )}
        {canStop && (
          <Btn size="sm" variant="ghost" disabled={busyKey === stopKey} onClick={() => onAction(stopKey, s.property_id, 'stop')} style={btnStyle}>
            {busyKey === stopKey ? 'Stopping…' : 'Stop'}
          </Btn>
        )}
        {learnJobId && (
          <Btn size="sm" variant="ghost" href={`/admin/properties/mapper/${learnJobId}`} style={btnStyle}>Watch it learn</Btn>
        )}
        <Btn size="sm" variant="ghost" href={`/admin/properties/coverage/${s.property_id}`} style={btnStyle}>What it captures</Btn>
      </div>
    </div>
  );
}

// ── Roster section header — caps eyebrow + serif count + one dim subtitle.
// The three roster sections share this so they read as a set; each dials its
// eyebrow brightness so the eye lands on AI staff first.
function RosterSection({ eyebrow, count, subtitle, eyebrowColor, last, children }: {
  eyebrow: string; count: number; subtitle: string; eyebrowColor: string;
  last?: boolean; children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: last ? 0 : 24 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
        <span className="caps" style={{ color: eyebrowColor }}>{eyebrow}</span>
        <SerifNum size={17} c="#fff">{count}</SerifNum>
      </div>
      <div style={{ fontSize: 12, color: dimWhite(.42), marginTop: 4, lineHeight: 1.45, maxWidth: 640 }}>{subtitle}</div>
      <div style={{ marginTop: 13 }}>{children}</div>
    </section>
  );
}

// ── One worker as a calm flat row: plain-English description, when it last
// ran, and a state pill. Reused by AI jobs, prediction, and chores. ────────
function SimpleWorkerRow({ w }: { w: WorkerRow }) {
  const v = workerView(w.state);
  const last = w.lastBeatAt ? `last ran ${age(w.lastBeatAt)} ago` : 'no runs yet';
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
      <Dot tone={v.tone} size={7} style={{ marginTop: 4 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {w.description || humanize(w.name)}
        </div>
        <div className="mono" style={{ fontSize: 9.5, color: dimWhite(.45), marginTop: 1 }}>{last}</div>
      </div>
      <Pill tone={pillOf(v.tone)} style={{ fontSize: 8.5, padding: '2px 6px', flexShrink: 0 }}>{v.label}</Pill>
    </div>
  );
}

// ── Scheduled chores — one collapsed summary row ("22 chores · all on time"),
// click to expand the full list. The quietest tier: flat panel, calm tones. ─
function ChoresRow({ rows }: { rows: WorkerRow[] }) {
  const [open, setOpen] = useState(false);
  const views = rows.map((w) => workerView(w.state));
  const okCount = views.filter((v) => v.tone === 'forest').length;
  const lateCount = views.filter((v) => v.tone === 'gold').length;
  const neverCount = views.filter((v) => v.tone === 'muted').length;

  let tone: DotTone = 'forest';
  let summary = 'all on time';
  if (lateCount > 0) { tone = 'gold'; summary = `${lateCount} running late`; }
  else if (okCount === 0 && neverCount > 0) { tone = 'muted'; summary = 'none have run yet'; }
  else if (neverCount > 0) { summary = `${okCount} on time · ${neverCount} waiting to start`; }

  const noun = rows.length === 1 ? 'chore' : 'chores';
  return (
    <div style={{ background: dimWhite(.04), border: `1px solid ${dimWhite(.1)}`, borderRadius: 12 }}>
      <div onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', cursor: 'pointer' }}>
        <Dot tone={tone} size={8} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: '#fff' }}>{rows.length} {noun}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: dimWhite(.55) }}>{summary}</span>
        <span className="mono" style={{ fontSize: 12, color: dimWhite(.4) }}>{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11, padding: '12px 13px', borderTop: `1px solid ${dimWhite(.08)}` }}>
          {rows.map((w) => <SimpleWorkerRow key={w.name} w={w} />)}
        </div>
      )}
    </div>
  );
}

// ── Inbox card model + views ──────────────────────────────────────────────
interface InboxCard {
  key: string;
  tone: DotTone;
  title: string;
  detail: string;
  action?:
    | { kind: 'link'; label: string; href: string }
    | { kind: 'button'; label: string; busyLabel: string; onClick: () => void; busy: boolean; variant?: 'ghost' | 'forest' };
}

type ActionRunner = (key: string, propertyId: string, action: string) => void;

// Build inbox cards straight from cua-sessions + pending nudges — always
// correct, used as the source of truth until mission/inbox lands.
function derivedInboxCards(sessions: CuaSession[], pendingNudges: number, run: ActionRunner, busyKey: string | null): InboxCard[] {
  const cards: InboxCard[] = [];
  for (const s of sessions) {
    const status = (s.status || '').toLowerCase();
    const name = s.display_name ?? 'A hotel';
    if (status.includes('mfa')) {
      cards.push({
        key: `mfa:${s.property_id}`, tone: 'terracotta',
        title: `${name} needs a 2FA code`,
        detail: 'The robot is locked out until someone enters the login code.',
        action: { kind: 'link', label: 'Enter 2FA code', href: `/admin/mfa-resume/${s.property_id}` },
      });
    } else if (status.includes('cost_cap')) {
      const resetKey = `${s.property_id}:reset_cost_cap`;
      cards.push({
        key: `cap:${s.property_id}`, tone: 'gold',
        title: `${name} hit its $${ROBOT_CAP_USD} cap`,
        detail: 'It paused to avoid overspending. Reset to let it keep working today.',
        action: { kind: 'button', label: 'Reset cap', busyLabel: 'Resetting…', busy: busyKey === resetKey, variant: 'forest', onClick: () => run(resetKey, s.property_id, 'reset_cost_cap') },
      });
    } else if (status.includes('fail') || status.includes('circuit')) {
      const restartKey = `${s.property_id}:restart`;
      cards.push({
        key: `fail:${s.property_id}`, tone: 'terracotta',
        title: `${name}'s robot stopped`,
        detail: s.paused_reason ? humanize(s.paused_reason) : 'It stopped unexpectedly and needs a restart.',
        action: { kind: 'button', label: 'Restart', busyLabel: 'Restarting…', busy: busyKey === restartKey, onClick: () => run(restartKey, s.property_id, 'restart') },
      });
    }
  }
  if (pendingNudges > 0) {
    cards.push({
      key: 'nudges', tone: 'gold',
      title: `${pendingNudges} suggestion${pendingNudges === 1 ? '' : 's'} waiting for approval`,
      detail: 'The copilot has changes it wants your okay on before acting.',
    });
  }
  return cards;
}

// Map a mission/inbox row to a card. Consumes the endpoint's own title/detail
// and structured `action`; tone is inferred from `kind`. Kinds are the real
// endpoint values (needs_2fa / cost_cap / failed / pending_decisions) plus
// loose fallbacks so an added kind still renders.
function endpointInboxCard(it: InboxRow, i: number, run: ActionRunner, busyKey: string | null): InboxCard {
  const kind = (it.kind || '').toLowerCase();
  const urgent = kind.includes('2fa') || kind.includes('mfa') || kind.includes('fail') || kind.includes('circuit');
  const attention = kind.includes('cap') || kind.includes('decision') || kind.includes('pending') || kind.includes('nudge');
  const tone: DotTone = urgent ? 'terracotta' : attention ? 'gold' : 'muted';
  return {
    key: `in:${i}`,
    tone,
    title: it.title || humanize(it.kind || 'Attention needed'),
    detail: it.detail || '',
    action: buildInboxAction(it.action, it.propertyId ?? null, run, busyKey),
  };
}

// Turn the endpoint's action descriptor into a rendered control. Unknown /
// null actions render as plain text (no button).
function buildInboxAction(
  action: InboxAction | string | null | undefined,
  fallbackPid: string | null,
  run: ActionRunner,
  busyKey: string | null,
): InboxCard['action'] {
  if (!action || typeof action !== 'object') return undefined;
  const type = (action.type || '').toLowerCase();
  const label = action.label || 'Open';
  if (type === 'link' && action.href) return { kind: 'link', label, href: action.href };
  const pid = action.propertyId ?? fallbackPid ?? '';
  if (!pid) return undefined;
  if (type === 'reset_cost_cap') {
    const key = `${pid}:reset_cost_cap`;
    return { kind: 'button', label, busyLabel: 'Resetting…', busy: busyKey === key, variant: 'forest', onClick: () => run(key, pid, 'reset_cost_cap') };
  }
  if (type === 'restart') {
    const key = `${pid}:restart`;
    return { kind: 'button', label, busyLabel: 'Working…', busy: busyKey === key, onClick: () => run(key, pid, 'restart') };
  }
  return undefined;
}

function InboxCardView({ card }: { card: InboxCard }) {
  return (
    <DarkCard style={{ padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <Dot tone={card.tone} size={8} style={{ marginTop: 4 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#fff', lineHeight: 1.4 }}>{card.title}</div>
          {card.detail && <div style={{ fontSize: 11.5, color: dimWhite(.6), marginTop: 3, lineHeight: 1.45 }}>{card.detail}</div>}
          {card.action && (
            <div style={{ marginTop: 9 }}>
              {card.action.kind === 'link' ? (
                <Btn size="sm" variant="ghost" href={card.action.href} style={{ color: '#fff', borderColor: dimWhite(.25) }}>{card.action.label}</Btn>
              ) : (
                <Btn
                  size="sm"
                  variant={card.action.variant ?? 'ghost'}
                  disabled={card.action.busy}
                  onClick={card.action.onClick}
                  style={card.action.variant === 'forest' ? undefined : { color: '#fff', borderColor: dimWhite(.25) }}
                >
                  {card.action.busy ? card.action.busyLabel : card.action.label}
                </Btn>
              )}
            </div>
          )}
        </div>
      </div>
    </DarkCard>
  );
}

// ── Recent error group — click to expand the stack (reused from LiveSurface) ─
function ErrorRow({ g }: { g: ErrorGroup }) {
  const [open, setOpen] = useState(false);
  const message = open ? g.message : (g.message.length > 96 ? g.message.slice(0, 96) + '…' : g.message);
  return (
    <DarkCard
      onClick={() => g.sampleStack && setOpen((o) => !o)}
      style={{ padding: '11px 13px', borderRadius: 12, background: dimWhite(.05), cursor: g.sampleStack ? 'pointer' : 'default' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <Dot tone="terracotta" size={7} style={{ marginTop: 5 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 11.5, color: '#fff', lineHeight: 1.45, wordBreak: 'break-word' }}>{message}</div>
          <div className="mono" style={{ fontSize: 10, color: dimWhite(.5), marginTop: 5, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <span>{g.source ?? 'unknown'}</span>
            <span>{g.count}× · {age(g.lastSeen)} ago</span>
            {g.affectedPropertyIds.length > 0 && <span>{g.affectedPropertyIds.length} {g.affectedPropertyIds.length === 1 ? 'hotel' : 'hotels'}</span>}
          </div>
        </div>
        <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--terracotta)' }}>×{g.count}</span>
      </div>
      {open && g.sampleStack && (
        <pre className="mono" style={{ margin: '10px 0 0', padding: 11, background: 'rgba(0,0,0,.3)', borderRadius: 9, fontSize: 10.5, color: dimWhite(.7), whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{g.sampleStack}</pre>
      )}
    </DarkCard>
  );
}
