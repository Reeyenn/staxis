'use client';

/* ───────────────────────────────────────────────────────────────────────
   SURFACE — Mission Control (dark).

   Replaces the old System & Agent tab. One glance answers "is anything on
   fire, and does anything need me?" for a non-technical owner. Everything
   below is real data — nothing mocked.

   Three blocks, top → bottom:
     1. Two health lights — App · AI spend today. Big status dot +
        plain-English one-liner, click to expand the detail.
     2. AI employees roster — the copilot, the NAMED AI staff (the roster the
        /admin/ai-staff page owns), and the background
        workers grouped by job family.
     3. Shared-knowledge approvals + the 72h grouped-errors panel (the same card UI
        LiveSurface uses for its errors column).

   Data sources:
     • GET /api/admin/system-status        → web/db/ml service colours
     • GET /api/agent/metrics              → copilot spend / requests / errors
     • GET /api/admin/mission/workers      → background cron heartbeats  (NEW)
     • GET /api/admin/mission/ai-staff     → the named AI employees
     • GET /api/admin/recent-errors?since= → 72h grouped app errors

   WHY THE NAMED STAFF COME FROM THE SAME ENDPOINT THE AI STAFF PAGE USES.
   Their status is derived, never stored — from whether they are built, whether
   the founder switched them off, and whether the jobs they depend on are
   actually scheduled. Deriving it a second time here would give two screens
   two chances to disagree about whether an employee is running, so this
   surface reads the answer rather than working it out. The consequence worth
   knowing: hiring employee #2 is a flag in the roster registry and nothing on
   this page changes.

   The mission endpoints are landing in parallel. This surface tolerates them
   404-ing or returning partial shapes: the errors panel and every light/roster
   row still render.

   Dark surface: <SurfaceShell glow="forestTop"> + DarkCard / dimWhite, the
   same chrome LiveSurface and MoneySurface use.
   ─────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { fetchWithAuth } from '@/lib/api-fetch';
import { ROBOT_WALK_ERROR_SOURCE } from '@/lib/automation/robot-walk';
import { EMPLOYEE_STATUS_LABEL, EMPLOYEE_STATUS_TONE } from '@/lib/ai/employee-registry';
import type { AiEmployeeStatus, Bilingual } from '@/lib/ai/employee-registry';
import {
  FONT_SERIF, Pill, Dot, Btn, SerifNum, countUp, age,
  type DotTone, type PillTone,
} from '../kit';
import {
  SurfaceShell, DarkCard, DarkSpinner, DarkEmpty, dimWhite,
} from '../surface-kit';
import { PromotionQueue } from './PromotionQueue';
// Poll cadence — system-status is designed for light client polling.
const POLL_MS = 30_000;

// ── Consumed shapes (kept loose — endpoints may add fields / land partial) ──
type ServiceColor = 'green' | 'yellow' | 'red';
interface ServiceStatus { status: ServiceColor; latency_ms?: number; message?: string }
interface SystemServices { web: ServiceStatus; ml: ServiceStatus; supabase: ServiceStatus }

interface AgentMetrics {
  caps?: { user: number; property: number; global: number };
  today?: {
    totalCostUsd?: number;
    backgroundCostUsd?: number;
    visionCostUsd?: number;
    audioCostUsd?: number;
    evalCostUsd?: number;
    /** Every finalized row today, whatever kind. See spendTodayUsd below. */
    allKindsCostUsd?: number;
    requestCount?: number;
  };
  toolErrorsToday?: number;
  toolIncompleteToday?: number;
  topTools?: Array<{ tool: string; calls: number; errors: number; incomplete: number; errorRatePct: number }>;
}

/**
 * WHAT THE "AI SPEND TODAY" LIGHT IS ALLOWED TO CALL THE TOTAL.
 *
 * It used to be `totalCostUsd + backgroundCostUsd`, two of the three buckets the
 * metrics endpoint happened to publish when this surface was written. The ledger
 * grew two more kinds after that (voice notes, and every photo/PDF/scanned-page
 * read) and this line did not, so the one number on the founder's dashboard that
 * says what the product costs him was missing its most expensive part. A day of
 * invoice scanning read as green and near zero.
 *
 * Now it takes the endpoint's own all-rows figure. The addition is kept only as
 * the fallback for a response cached from a build that predates that field, and
 * it is deliberately a floor rather than a guess: an old payload under-reports,
 * which is exactly the failure above, so `asOfDate` on the card says how fresh
 * the read is and the breakdown below shows which parts are known.
 *
 * Exported because a number a founder acts on should be checkable without
 * mounting a dashboard.
 */
export function spendTodayUsd(metrics: AgentMetrics | null): number {
  const today = metrics?.today;
  if (!today) return 0;
  if (typeof today.allKindsCostUsd === 'number') return today.allKindsCostUsd;
  return (today.totalCostUsd ?? 0)
    + (today.backgroundCostUsd ?? 0)
    + (today.visionCostUsd ?? 0)
    + (today.audioCostUsd ?? 0)
    + (today.evalCostUsd ?? 0);
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

// mission/ai-staff row. Kept as loose as its neighbours: the endpoint owns the
// derivation, this surface only draws it. `spend` is optional and its `known`
// flag is what decides whether a figure is drawn at all — see AiEmployeeRow.
export interface StaffSpend {
  known?: boolean;
  usd?: number | null;
  todayUsd?: number | null;
}
export interface StaffMember {
  id: string;
  name: Bilingual;
  job: Bilingual;
  hired: boolean;
  status: AiEmployeeStatus;
  spend?: StaffSpend | null;
}

export interface ErrorGroup {
  source: string | null;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  affectedPropertyIds: string[];
  sampleStack: string | null;
}

/**
 * Sources that are LIVE and must never be swallowed by the retired-robot
 * filter below.
 *
 * The filter was written to hide the decommissioned PMS robot's leftover
 * noise, and it does that by pattern — anything whose source reads like a
 * robot. The nightly walkthrough IS a robot, is very much running, and is the
 * one signal in the product that fails when the app itself has stopped working
 * for a manager. Without this exemption its failures would be dropped on the
 * floor of the exact box they were written for, silently, forever.
 *
 * Anything added here has to be a source somebody is actively writing today.
 */
const LIVE_ERROR_SOURCES: ReadonlySet<string> = new Set([ROBOT_WALK_ERROR_SOURCE]);

function isRetiredRobotError(group: ErrorGroup): boolean {
  const source = (group.source ?? '').toLowerCase();
  if (LIVE_ERROR_SOURCES.has(source)) return false;
  return source === 'generic-table-writer'
    || /(^|[-_.\s])(cua|mapper|robot|session[-_ ]?driver)([-_.\s]|$)/.test(source);
}

/**
 * What the "Recent errors" box actually shows, out of everything the endpoint
 * returned. Exported because it is a decision about what the founder is and is
 * not told, and a decision that lives inline in a `useCallback` is one nothing
 * can check.
 */
export function visibleErrorGroups(groups: readonly ErrorGroup[]): ErrorGroup[] {
  return groups.filter((group) => !isRetiredRobotError(group));
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
async function jsonOf(r: PromiseSettledResult<Response | null>) {
  if (r.status !== 'fulfilled' || !r.value) return null;
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
  const [metrics, setMetrics] = useState<AgentMetrics | null>(null);
  const [workers, setWorkers] = useState<WorkerRow[] | null>(null); // null = not loaded / unavailable
  const [staff, setStaff] = useState<StaffMember[] | null>(null); // null = roster not read yet
  const [errors, setErrors] = useState<ErrorGroup[]>([]);

  const [loaded, setLoaded] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const load = useCallback(async () => {
    const since72h = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const settled = await Promise.allSettled([
      fetchWithAuth('/api/admin/system-status'),
      fetchWithAuth('/api/agent/metrics'),
      fetchWithAuth('/api/admin/mission/workers'),
      fetchWithAuth(`/api/admin/recent-errors?since=${encodeURIComponent(since72h)}`),
      fetchWithAuth('/api/admin/mission/ai-staff'),
    ]);
    if (settled.every((result) => result.status === 'rejected')) {
      setFatalError('Could not reach the server. Check your connection and try again.');
      setLoaded(true);
      return;
    }
    setFatalError(null);

    const [sysJson, metricsJson, workersJson, errorsJson, staffJson] =
      await Promise.all(settled.map(jsonOf));

    if (sysJson?.services) setSystem(sysJson.services as SystemServices);
    if (metricsJson?.data) setMetrics(metricsJson.data as AgentMetrics);
    if (workersJson?.ok) {
      const arr = asArray(workersJson.data?.workers ?? workersJson.data) as WorkerRow[];
      setWorkers(arr);
    }
    if (staffJson?.ok) {
      setStaff(asArray(staffJson.data?.employees) as StaffMember[]);
    }
    if (errorsJson?.data?.groups) {
      setErrors(visibleErrorGroups(errorsJson.data.groups as ErrorGroup[]));
    }

    setLoadedAt(new Date().toISOString());
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

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
  // Split the worker roster by the owner's three-way mental model. A missing
  // tier (old cached response) falls back to 'timer' inside tierOf().
  const aiWorkers = (workers ?? []).filter((w) => tierOf(w) === 'ai');
  const predictionWorkers = (workers ?? []).filter((w) => tierOf(w) === 'prediction');
  const timerWorkers = (workers ?? []).filter((w) => tierOf(w) === 'timer');
  const hiredStaff = (staff ?? []).filter((e) => e.hired === true);
  const aiStaffCount = 1 /* copilot */ + hiredStaff.length + aiWorkers.length;

  const appLight = (() => {
    if (!system) return { tone: 'muted' as DotTone, detail: 'Checking the website and database…' };
    const worst = worstColor([system.web?.status, system.supabase?.status]);
    const tone = SERVICE_TONE[worst];
    const detail = worst === 'green'
      ? 'Website and database are both healthy.'
      : worst === 'yellow'
      ? 'Something is a little slow. The app is still up.'
      : 'A core service is down. The app may be affected.';
    return { tone, detail };
  })();

  const spendToday = spendTodayUsd(metrics);
  const globalCap = metrics?.caps?.global ?? 0;
  const spendPct = globalCap > 0 ? spendToday / globalCap : 0;
  const spendLight = (() => {
    if (!metrics) return { tone: 'muted' as DotTone, detail: 'No AI spend yet today.' };
    const tone: DotTone = spendPct >= 1 ? 'terracotta' : spendPct >= 0.7 ? 'gold' : 'forest';
    // The cap is deliberately NOT quoted on this line any more. $500 governs
    // chat turns only, so printing it beside a figure that now includes scans,
    // voice notes and background work read as a ceiling on all of it, which it
    // has never been. The expanded card says which is which.
    const detail = money(spendToday) + ' today, everything included';
    return { tone, detail };
  })();

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
          {/* The named roster — who works here, and the switch that stops one of
              them. Deliberately a link and not a fourteenth block on this page:
              Mission Control is the glance, AI Staff is where you go when the
              glance says one of them is misbehaving. */}
          <Btn size="sm" variant="ghost" href="/admin/ai-staff" style={{ color: 'var(--gold)', borderColor: 'rgba(201,154,46,.4)' }}>AI Staff →</Btn>
          <Btn size="sm" variant="ghost" onClick={() => { void load(); }} style={{ color: '#fff', borderColor: dimWhite(.25) }}>Refresh</Btn>
        </div>
      </header>

      {/* ── Block 1 — two health lights. alignItems start so an expanded
          card doesn't stretch its two siblings into hollow boxes. ──────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginBottom: 26, alignItems: 'start' }}>
        <HealthLight tone={appLight.tone} label="App" detail={appLight.detail} expanded={<AppDetail system={system} />} />
        <HealthLight tone={spendLight.tone} label="AI spend today" detail={spendLight.detail} expanded={<SpendDetail metrics={metrics} total={spendToday} cap={globalCap} />} />
      </div>

      {/* ── Block 2 — the roster in three side-by-side columns (owner's
          layout, 2026-07-17): left = Copilot + named staff, middle =
          automatic AI jobs, right = prediction engine over scheduled
          chores. Fills the width instead of one long scroll; columns wrap
          on narrow windows. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 20, alignItems: 'start', marginBottom: 26 }}>
        {/* LEFT — the thinking-model workforce doing the real work. */}
        <AiStaffColumn
          metrics={metrics}
          employees={hiredStaff}
        />

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
          subtitle="Classic forecasting math. Learns from numbers, doesn't think."
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

      {/* ── Block 3 — second row (owner's layout): chores ·
          shared-knowledge approvals · errors. The approvals column is the
          Staxis-side promotion queue: the only place a fact learned at one
          hotel becomes advice given to another. It sits here, next to the
          other things that need a human, because Mission Control is where
          Reeyen watches and decides — the AI Control Center is configuration.
          ─────────────────────────────────────────────────────────────── */}
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

        {/* Shared-knowledge approvals — Reeyen only; hotels never see it */}
        <PromotionQueue />

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
      {/* Always mounted so BOTH open and close animate — the 0fr↔1fr grid-row
          transition slides the panel; opacity fades it in step. */}
      {expanded && (
        <div style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', transition: 'grid-template-rows .26s ease', opacity: open ? 1 : 0 }} aria-hidden={!open}>
          <div style={{ overflow: 'hidden', transition: 'opacity .22s ease', opacity: open ? 1 : 0 }}>
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${dimWhite(.1)}` }}>{expanded}</div>
          </div>
        </div>
      )}
    </DarkCard>
  );
}

const SERVICE_LABEL: Record<keyof SystemServices, string> = {
  web: 'Website', supabase: 'Database', ml: 'Prediction service',
};
function AppDetail({ system }: { system: SystemServices | null }) {
  if (!system) return <span style={{ fontSize: 12, color: dimWhite(.5) }}>Still checking…</span>;
  const order: Array<keyof SystemServices> = ['web', 'supabase', 'ml'];
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

// ── Spend light click-through — a compact live summary; the full
//    tech-stack spend board lives on the Money tab (owner ask 2026-07-18).
//
// The breakdown is here so the headline number can be checked against its own
// parts. Every line is a kind the ledger actually records, and the lines add up
// to the total by construction: a kind this build does not name still sits
// inside `total`, and shows as "Something else" rather than going missing.
function SpendDetail({ metrics, total, cap }: {
  metrics: AgentMetrics | null;
  total: number;
  cap: number;
}) {
  const today = metrics?.today;
  const named: Array<[string, number]> = [
    ['Questions people asked', today?.totalCostUsd ?? 0],
    ['Work that runs on its own', today?.backgroundCostUsd ?? 0],
    ['Photos and documents read', today?.visionCostUsd ?? 0],
    ['Voice notes written out', today?.audioCostUsd ?? 0],
    ['Testing', today?.evalCostUsd ?? 0],
  ];
  const namedTotal = named.reduce((sum, [, usd]) => sum + usd, 0);
  const other = Math.max(0, Math.round((total - namedTotal) * 10000) / 10000);
  const lines = other > 0 ? [...named, ['Something else', other] as [string, number]] : named;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, color: dimWhite(.7) }}>
      {lines.map(([label, usd]) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
          <span>{label}</span>
          <span className="mono" style={{ color: '#fff' }}>{money(usd)}</span>
        </div>
      ))}
      {cap > 0 && (
        <div style={{ fontSize: 11, color: dimWhite(.45), marginTop: 2, lineHeight: 1.45 }}>
          The ${cap} a day limit covers the questions line only. The rest has its own smaller limits.
        </div>
      )}
      <div style={{ marginTop: 4 }}>
        <Btn size="sm" variant="ghost" href="/admin/properties#money" style={{ color: 'var(--gold)', borderColor: 'rgba(201,154,46,.4)' }}>
          Full bill &amp; tech-stack costs → Money tab
        </Btn>
      </div>
    </div>
  );
}

// ══ The AI staff column ════════════════════════════════════════════════════
//
// The copilot, then the named employees. The copilot is always here, and an
// employee is a job Staxis has hired for.
//
// HOOK-FREE ON PURPOSE. Every row below owns its own open/closed state, so
// this component holds none, and the standing test can call it as a plain
// function and read the tree it returns. That is what makes the header count
// checkable — a roster that grew a new hire while the count stayed at one is
// exactly the regression this column is here to prevent, and it is invisible
// to any test that only looks at the rows.

const AI_STAFF_COPY = {
  spentToday: { en: 'Spent today', },
  openRoster: { en: 'Open the AI Staff page', },
} as const;

export function AiStaffColumn({ metrics, employees }: {
  metrics: AgentMetrics | null;
  employees: StaffMember[];
}) {
  return (
    <RosterSection
      eyebrow="AI staff"
      count={1 /* copilot */ + employees.length}
      eyebrowColor={dimWhite(.62)}
      subtitle="Thinks with a language model. Couldn't exist before AI."
      last
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <CopilotRow metrics={metrics} />
        {/* The named roster, straight from the registry by way of the
            endpoint. Hiring employee #2 is a flag in that registry; nothing
            here needs editing for their row to appear. */}
        {employees.map((e) => <AiEmployeeRow key={e.id} e={e} />)}
      </div>
    </RosterSection>
  );
}

/**
 * One named AI employee, drawn to match the copilot's row above it: a dot,
 * who they are, what they do in one line, and what they cost today.
 *
 * WHAT IT WILL NOT SAY. The status is the endpoint's derived answer, rendered
 * with the registry's own sentence — this row never works out for itself
 * whether an employee is running. And a spend figure is drawn only when the
 * ledger can back it: "$0.00" beside an employee whose spend nothing separates
 * out reads as "it ran today and cost nothing", which is a claim, and the
 * wrong one. An absent number is the honest version of not knowing.
 *
 * The whole card is a link to /admin/ai-staff, where the controls are. There
 * is nothing to click here — Mission Control is the glance.
 */
export function AiEmployeeRow({ e }: { e: StaffMember }) {
  const tone: DotTone = EMPLOYEE_STATUS_TONE[e.status] ?? 'muted';
  const label = (EMPLOYEE_STATUS_LABEL[e.status] ?? EMPLOYEE_STATUS_LABEL.not_hired).en;
  const spentToday = e.spend?.known === true && typeof e.spend.todayUsd === 'number'
    ? e.spend.todayUsd
    : null;

  return (
    <Link
      href="/admin/ai-staff"
      aria-label={`${e.name.en}. ${AI_STAFF_COPY.openRoster.en}`}
      style={{ textDecoration: 'none', display: 'block' }}
    >
      <DarkCard style={{ padding: '13px 15px', cursor: 'pointer' }}>
        {/* Two rows rather than the copilot's one. A job description is a
            whole sentence and a status is a whole sentence, and side by side
            in a third of the page width they push the dot onto a line of its
            own. Name up top, the claims underneath, indented to sit under the
            name. */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
          <Dot tone={tone} size={9} style={{ marginTop: 4 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{e.name.en}</div>
            <div style={{ fontSize: 11, color: dimWhite(.45), marginTop: 2, lineHeight: 1.45 }}>{e.job.en}</div>
          </div>
          <span className="mono" style={{ fontSize: 12, color: dimWhite(.4), flexShrink: 0 }}>→</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', marginTop: 11, paddingLeft: 20 }}>
          <Pill tone={pillOf(tone)} style={{ fontSize: 9, padding: '2px 7px' }}>{label}</Pill>
          {spentToday !== null && (
            <div style={{ marginLeft: 'auto' }}>
              <Metric label={AI_STAFF_COPY.spentToday.en} value={money(spentToday)} />
            </div>
          )}
        </div>
      </DarkCard>
    </Link>
  );
}

// ── Copilot row (expandable to tool-call mix) ─────────────────────────────
function CopilotRow({ metrics }: { metrics: AgentMetrics | null }) {
  const [open, setOpen] = useState(false);
  const requests = metrics?.today?.requestCount ?? 0;
  // The COPILOT'S OWN turns, and nothing else. This used to add background work
  // in, which put the Morning Briefer's nightly wording pass on the copilot's
  // line AND on the Briefer's card three rows below it: the same dollar, twice,
  // on one screen. The rest of the day's spend is on the light at the top.
  const spend = metrics?.today?.totalCostUsd ?? 0;
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
      <Reveal open={open}>
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
      </Reveal>
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
        {/* One-line row, so a long description ellipsises. `title` keeps the
            full sentence reachable on hover — some chores (the PMS retention
            janitor) do several jobs and the tail of the sentence is the part
            that matters most. */}
        <div
          title={w.description || humanize(w.name)}
          style={{ fontSize: 12, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
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

// Animated disclosure — 0fr↔1fr grid-row transition so both opening AND
// closing slide + fade. Content stays mounted (cheap, all-local data).
function Reveal({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', transition: 'grid-template-rows .26s ease' }} aria-hidden={!open}>
      <div style={{ overflow: 'hidden', opacity: open ? 1 : 0, transition: 'opacity .22s ease' }}>
        {children}
      </div>
    </div>
  );
}

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
      <Reveal open={open}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11, padding: '12px 13px', borderTop: `1px solid ${dimWhite(.08)}` }}>
          {rows.map((w) => <SimpleWorkerRow key={w.name} w={w} />)}
        </div>
      </Reveal>
    </div>
  );
}

// ── Recent error group — click to expand the stack (reused from LiveSurface) ─
// Exported so the standing test can render a real failure row and read what a
// founder would actually see on it: the sentence, and which system said it.
export function ErrorRow({ g }: { g: ErrorGroup }) {
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
