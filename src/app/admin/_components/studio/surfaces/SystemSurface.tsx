'use client';

/* ───────────────────────────────────────────────────────────────────────
   SURFACE — System & Agent · "Health Rings" (dark).

   The design-handoff finalized System screen (surfaces/system.jsx →
   SysRings, the `final: 3` iteration), wired to the real telemetry the
   prior SystemTab + AgentTab fetched. Agent is intentionally FOLDED into
   System — both are "the machinery behind Staxis".

   Data (same endpoints the prior tabs used — none invented):
     • /api/admin/system-status   → live service health (poll 30s). Returns
        the SystemStatusResponse SHAPE DIRECTLY (not the ok() envelope):
        res.json() as SystemStatusResponse. services keyed web/ml/cua/supabase.
     • /api/admin/active-sessions → ok() envelope → data:{sessions,grouped,totalActive}
     • /api/admin/build-status    → ok() envelope → data:{commits,deploys,worktrees,
        branches,merged,pushes,openPRs,mainLatestTs}
     • /api/admin/last-github-event → cursor poll that triggers a build refetch
     • /api/agent/metrics         → ok() envelope (body.data ?? body): today spend,
        recentConversations, toolErrorsToday, toolIncompleteToday, topTools (the
        real tool-call mix — the prototype's a.toolCalls).
     • /api/admin/agent/prompts   → ok() envelope → data:{prompts:[{role,version,
        is_active,created_at,...}]} — versioned rulebooks (the prototype's a.prompts).
   Links kept: /admin/agent (dashboard) · /admin/agent/prompts (prompt editor).

   The prototype's demo "cycle" button (fake green→yellow→red state machine)
   is intentionally NOT ported — status reflects real polling. The ring flip
   reveals the real status message + last-checked instead.
   ─────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { SystemStatusResponse, ServiceColor } from '@/app/api/admin/system-status/route';
import {
  FONT_SERIF, FONT_MONO, Pill, SerifNum, Btn,
  flip, countUp, sweepWidth, age,
  EASE_OUT, prefersReducedMotion, type PillTone,
} from '../kit';
import { SurfaceShell, SurfaceHead, DarkCard, DarkSpinner, DarkEmpty, dimWhite } from '../surface-kit';

// ── Real API shapes (copied verbatim from SystemTab.tsx) ────────────────
interface Commit {
  sha: string; shortSha: string; message: string; authorName: string; authorEmail: string; ts: string; url: string;
  checkStatus?: 'passed' | 'failed' | 'pending' | 'neutral' | null;
}
interface Deploy {
  target: 'vercel-website' | 'fly-cua';
  commitSha: string | null; shortSha: string | null; deployedAt: string | null; url: string;
  status?: 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED' | 'QUEUED' | null;
  inProgress?: boolean;
  failed?: boolean;
  startedAt?: string | null;
  finishedAt?: string | null;
}
interface Worktree {
  name: string; branch: string | null; lastActivity: string | null;
}
interface Branch {
  name: string; shortSha: string; latestMessage: string;
  latestTs: string | null; aheadOfMain: number; behindMain: number; url: string;
}
interface MergedBranch {
  branchName: string; mergeCommitSha: string; mergedAt: string;
  title: string; url: string; commitCount: number;
}
interface Push {
  branch: string; ts: string; sha: string | null; commitMessage: string | null;
}
interface OpenPR {
  number: number; title: string; branch: string; url: string; draft: boolean;
  createdAt: string; updatedAt: string;
}
interface BuildData {
  commits: Commit[]; deploys: Deploy[]; worktrees: Worktree[];
  branches?: Branch[]; merged?: MergedBranch[];
  pushes?: Push[]; openPRs?: OpenPR[];
  mainLatestTs?: string | null;
}

interface ActiveSession {
  session_id: string;
  branch: string | null;
  current_tool: string | null;
  started_at: string;
  last_heartbeat: string;
  cwd: string | null;
}
interface ActiveSessionsResp {
  sessions: ActiveSession[];
  grouped: { branch: string; sessionCount: number; sessions: ActiveSession[] }[];
  totalActive: number;
}

// ── Real agent shapes (from AgentTab MetricsPayload + /api/agent/metrics) ─
interface AgentMetrics {
  today: {
    totalCostUsd: number;
    backgroundCostUsd: number;
    requestCount: number;
    uniqueUsers: number;
  };
  recentConversations: Array<{ id: string }>;
  toolErrorsToday: number;
  toolIncompleteToday: number;
  // Real tool-call mix (the prototype's a.toolCalls): per tool, count + error%.
  topTools: Array<{ tool: string; calls: number; errors: number; incomplete: number; errorRatePct: number }>;
}

// ── Real prompt shape (from /api/admin/agent/prompts) ───────────────────
type PromptRole = 'base' | 'housekeeping' | 'general_manager' | 'owner' | 'admin' | 'summarizer';
interface PromptRow {
  id: string; role: PromptRole; version: string; content: string;
  is_active: boolean; parent_version: string | null; notes: string | null;
  created_at: string; created_by: string | null;
}
// The four rulebooks the design surfaces, in order, with their display labels.
const RULEBOOK_ROLES: Array<{ role: PromptRole; label: string }> = [
  { role: 'housekeeping', label: 'Housekeeper' },
  { role: 'general_manager', label: 'Manager' },
  { role: 'summarizer', label: 'Summarizer' },
  { role: 'admin', label: 'Admin' },
];

const CURSOR_MS = 2_000;
const REFRESH_MS = 60_000;
const STATUS_REFRESH_MS = 30_000;

// Service → display row (mirrors SystemTab.SERVICE_ROWS).
interface ServiceRow {
  key: keyof SystemStatusResponse['services'];
  label: string;
  caption: string;
}
const SERVICE_ROWS: ServiceRow[] = [
  { key: 'web',      label: 'Web app',          caption: 'Vercel (this server)' },
  { key: 'ml',       label: 'ML brain',         caption: 'Railway — forecast service' },
  { key: 'cua',      label: 'Onboarding robot', caption: 'Fly.io — queue freshness' },
  { key: 'supabase', label: 'Database',         caption: 'Supabase — PostgREST + cache' },
];

const SVC_TONE: Record<ServiceColor, PillTone> = { green: 'forest', yellow: 'gold', red: 'terracotta' };
const SVC_HEX: Record<ServiceColor, string> = { green: '#3C9C68', yellow: '#C99A2E', red: '#C2562E' };
const SVC_LABEL: Record<ServiceColor, string> = { green: 'OK', yellow: 'DEGRADED', red: 'DOWN' };

// ── Unified build-event stream (= prototype buildEvents(), real fields) ──
type EventKind = 'commit' | 'deploy' | 'pr' | 'branch';
interface BuildEvent {
  t: EventKind;
  ts: string | null;
  title: string;
  sub: string;
  check?: Commit['checkStatus'];
  inProgress?: boolean;
  status?: Deploy['status'];
}
const EV_GLYPH: Record<EventKind, string> = { commit: '◐', deploy: '▲', pr: '⎇', branch: '⌥' };
const CHECK_TONE: Record<NonNullable<Commit['checkStatus']>, PillTone> = {
  passed: 'forest', failed: 'terracotta', pending: 'gold', neutral: 'neutral',
};

function buildEvents(b: BuildData): BuildEvent[] {
  const ev: BuildEvent[] = [];
  (b.commits ?? []).forEach((c) => ev.push({
    t: 'commit', ts: c.ts, title: c.message, sub: `${c.shortSha} · ${c.authorName}`, check: c.checkStatus,
  }));
  (b.deploys ?? []).forEach((d) => ev.push({
    t: 'deploy', ts: d.deployedAt, title: `${d.target} → ${d.status ?? '—'}`, sub: d.shortSha ?? '—',
    inProgress: d.inProgress, status: d.status,
  }));
  (b.openPRs ?? []).forEach((p) => ev.push({
    t: 'pr', ts: p.updatedAt, title: `PR #${p.number} · ${p.title}`, sub: `${p.branch}${p.draft ? ' · draft' : ''}`,
  }));
  (b.branches ?? []).forEach((br) => ev.push({
    t: 'branch', ts: br.latestTs, title: br.name, sub: `${br.latestMessage} · +${br.aheadOfMain}/-${br.behindMain}`,
  }));
  return ev.sort((a, c) => (c.ts ? Date.parse(c.ts) : 0) - (a.ts ? Date.parse(a.ts) : 0));
}

function fmtToolName(tool: string): string {
  if (!tool) return tool;
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__');
    return parts[parts.length - 1] || tool;
  }
  return tool;
}

// ═══════════════════════════════════════════════════════════════════════
// SURFACE
// ═══════════════════════════════════════════════════════════════════════
export function SystemSurface() {
  const [build, setBuild] = useState<BuildData | null>(null);
  const [activeSessions, setActiveSessions] = useState<ActiveSessionsResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeenCursorTs = useRef<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const [buildRes, sessionsRes] = await Promise.all([
        fetchWithAuth('/api/admin/build-status'),
        fetchWithAuth('/api/admin/active-sessions'),
      ]);
      const [buildJson, sessionsJson] = await Promise.all([buildRes.json(), sessionsRes.json()]);
      if (buildJson.ok) setBuild(buildJson.data);
      if (sessionsJson.ok) setActiveSessions(sessionsJson.data);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
  };

  useEffect(() => {
    void load();

    const cursorTick = async () => {
      try {
        const [cursorRes, sessionsRes] = await Promise.all([
          fetchWithAuth('/api/admin/last-github-event'),
          fetchWithAuth('/api/admin/active-sessions'),
        ]);
        const cursorJson = await cursorRes.json();
        const sessionsJson = await sessionsRes.json();
        if (sessionsJson.ok) setActiveSessions(sessionsJson.data);
        if (cursorJson.ok) {
          const ts: string | null = cursorJson.data.latestTs ?? null;
          if (ts && ts !== lastSeenCursorTs.current) {
            const isFirstSeen = lastSeenCursorTs.current === null;
            lastSeenCursorTs.current = ts;
            if (!isFirstSeen) await load();
          }
        }
      } catch {
        /* swallow */
      }
      cursorTimer.current = setTimeout(cursorTick, CURSOR_MS);
    };
    cursorTimer.current = setTimeout(cursorTick, CURSOR_MS);

    const refreshTick = () => {
      refreshTimer.current = setTimeout(async () => {
        await load();
        refreshTick();
      }, REFRESH_MS);
    };
    refreshTick();

    return () => {
      if (cursorTimer.current) clearTimeout(cursorTimer.current);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  return (
    <SurfaceShell glow="forestTop">
      <SurfaceHead caps="System & Agent · Health rings">
        The machinery, <span style={{ fontStyle: 'italic' }}>at a glance</span>
      </SurfaceHead>

      {error && (
        <div style={{ marginBottom: 18, color: 'var(--terracotta)', fontSize: 13 }}>{error}</div>
      )}

      {/* Global 2FA master switch — always visible, independent of build load. */}
      <div style={{ marginBottom: 24 }}>
        <span className="caps" style={{ color: dimWhite(.5) }}>Security</span>
        <div style={{ marginTop: 10 }}>
          <SecuritySwitch />
        </div>
      </div>

      {!build && !error ? (
        <div style={{ padding: '80px 0', textAlign: 'center' }}><DarkSpinner /></div>
      ) : (
        <>
          {/* Service rings — live health, real polling (no demo cycle) */}
          <ServiceRings />

          {/* Active sessions · Build activity */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px,1fr))', gap: 18, marginTop: 26 }}>
            <div>
              <span className="caps" style={{ color: dimWhite(.5) }}>Active sessions</span>
              <div style={{ marginTop: 10 }}>
                <SessionsPanel resp={activeSessions} />
              </div>
            </div>
            <div>
              <span className="caps" style={{ color: dimWhite(.5) }}>Build activity</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 10 }}>
                {build && buildEvents(build).length === 0
                  ? <DarkEmpty text="No recent build activity." />
                  : build && buildEvents(build).slice(0, 6).map((e, i) => <BuildEventRow key={i} e={e} />)}
              </div>
            </div>
          </div>

          {/* Agent block — folded in, dark */}
          <div style={{ marginTop: 22 }}>
            <AgentBlock />
          </div>
        </>
      )}
    </SurfaceShell>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SECURITY — global 2FA master switch. Reads/writes /api/admin/settings.
// OFF disables ALL human Staxis 2FA fleet-wide (signup, new-device login,
// admin panel, phone handoff). Does NOT touch the PMS/CUA robot MFA.
// ═══════════════════════════════════════════════════════════════════════
function SecuritySwitch() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetchWithAuth('/api/admin/settings');
        const json = await res.json();
        if (alive && json?.data && typeof json.data.twoFactorEnabled === 'boolean') {
          setEnabled(json.data.twoFactorEnabled);
        } else if (alive) {
          setErr('Could not load the 2FA setting.');
        }
      } catch {
        if (alive) setErr('Could not load the 2FA setting.');
      }
    })();
    return () => { alive = false; };
  }, []);

  const apply = async (next: boolean) => {
    if (next === false) {
      const okConfirm = window.confirm(
        'Turn OFF two-factor for EVERY human login?\n\n'
        + 'Signup, password login on a new device, the admin panel, and phone handoff '
        + 'will all skip the security code until you turn this back on.\n\n'
        + 'The hotel PMS robot is unaffected.',
      );
      if (!okConfirm) return;
    }
    setSaving(true);
    setErr(null);
    try {
      const res = await fetchWithAuth('/api/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ twoFactorEnabled: next }),
      });
      const json = await res.json();
      if (!res.ok || !json?.ok || !json?.data) {
        throw new Error(json?.error ?? `save failed (${res.status})`);
      }
      setEnabled(json.data.twoFactorEnabled);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const on = enabled === true;
  const off = enabled === false;

  return (
    <DarkCard>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 650, color: off ? 'var(--terracotta)' : dimWhite(.92) }}>
            {enabled === null ? 'Two-factor (2FA)' : off ? 'Two-factor is OFF' : 'Require two-factor (2FA)'}
          </div>
          <div style={{ fontSize: 12.5, color: dimWhite(.5), marginTop: 4, lineHeight: 1.45, maxWidth: 520 }}>
            {off
              ? 'Every human login currently skips the security code. The hotel PMS robot is unaffected. Turn back on to restore 2FA everywhere.'
              : 'On = signup, new-device login, the admin panel and phone handoff all ask for a security code. Turning it off skips the code for every human login (not the PMS robot).'}
          </div>
          {err && <div style={{ fontSize: 12, color: 'var(--terracotta)', marginTop: 8 }}>{err}</div>}
        </div>
        <ToggleSwitch on={on} disabled={enabled === null || saving} onClick={() => void apply(!on)} />
      </div>
    </DarkCard>
  );
}

function ToggleSwitch({ on, disabled, onClick }: { on: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      title={on ? '2FA is on' : '2FA is off'}
      style={{
        flexShrink: 0, width: 52, height: 30, borderRadius: 999, border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer', position: 'relative',
        background: on ? 'var(--forest, #2E6E4E)' : 'rgba(255,255,255,0.18)',
        opacity: disabled ? 0.55 : 1, transition: 'background .18s ease',
      }}
    >
      <span style={{
        position: 'absolute', top: 3, left: on ? 25 : 3, width: 24, height: 24, borderRadius: '50%',
        background: '#fff', transition: 'left .18s ease', boxShadow: '0 1px 3px rgba(0,0,0,.3)',
      }} />
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SERVICE RINGS — live status from /api/admin/system-status (poll 30s).
// Click a ring → flips to reveal the real status message + last-checked.
// ═══════════════════════════════════════════════════════════════════════
function ServiceRings() {
  const [snapshot, setSnapshot] = useState<SystemStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchStatus = async () => {
    try {
      const res = await fetchWithAuth('/api/admin/system-status');
      const json = (await res.json()) as SystemStatusResponse;
      if (typeof json !== 'object' || json === null) {
        setError('Malformed status response.');
        return;
      }
      setSnapshot(json);
      setError(null);
    } catch (err) {
      setError(`Status fetch failed: ${(err as Error).message}`);
    }
  };

  useEffect(() => {
    void fetchStatus();
    const tick = () => {
      pollTimer.current = setTimeout(async () => {
        await fetchStatus();
        tick();
      }, STATUS_REFRESH_MS);
    };
    tick();
    return () => { if (pollTimer.current) clearTimeout(pollTimer.current); };
  }, []);

  const checkedIso = snapshot?.generated_at ?? null;

  return (
    <div>
      {error && (
        <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--terracotta)' }}>{error}</div>
      )}
      {!snapshot && !error ? (
        <div style={{ padding: '40px 0', textAlign: 'center' }}><DarkSpinner size={20} /></div>
      ) : snapshot ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: 16 }}>
          {SERVICE_ROWS.map((row, i) => (
            <RingNode
              key={row.key}
              row={row}
              svc={snapshot.services[row.key]}
              checkedIso={checkedIso}
              index={i}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RingNode({
  row, svc, checkedIso, index,
}: {
  row: ServiceRow;
  svc: SystemStatusResponse['services'][keyof SystemStatusResponse['services']];
  checkedIso: string | null;
  index: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [showMsg, setShowMsg] = useState(false);
  const col = SVC_HEX[svc.status];
  const tone = SVC_TONE[svc.status];
  const latency = svc.latency_ms;

  // Entrance: subtle scale-in (gated on reduced motion via WAAPI guard).
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== 'function') return;
    el.animate(
      [{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'scale(1)' }],
      { duration: 460, delay: index * 60, easing: EASE_OUT, fill: 'both' },
    );
  }, [index]);

  const onFlip = () => flip(ref.current, () => setShowMsg((m) => !m), { axis: 'X', dur: 520 });

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      onClick={onFlip}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void onFlip(); } }}
      aria-pressed={showMsg}
      style={{
        background: dimWhite(.05), border: `1px solid ${col}55`, borderRadius: 16,
        padding: '18px 16px', cursor: 'pointer', textAlign: 'center',
      }}
    >
      <div style={{ position: 'relative', width: 64, height: 64, margin: '0 auto 12px' }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${col}`, boxShadow: `0 0 18px ${col}66` }} />
        <RingPulse col={col} active={svc.status !== 'green'} />
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
          <span className="serif-num" style={{ fontSize: 20, color: '#fff' }}>{latency != null ? latency : '—'}</span>
          <span className="mono" style={{ fontSize: 8, color: dimWhite(.5) }}>{latency != null ? 'ms' : 'down'}</span>
        </div>
      </div>
      {!showMsg ? (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{row.label}</div>
          <div style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 11, color: dimWhite(.5), marginTop: 2 }}>{row.caption}</div>
          <div style={{ marginTop: 6 }}>
            <Pill tone={tone} style={{ fontSize: 9, padding: '2px 8px' }}>{SVC_LABEL[svc.status]}</Pill>
          </div>
        </div>
      ) : (
        <div className="mono" style={{ fontSize: 10.5, color: dimWhite(.8), lineHeight: 1.5 }}>
          {svc.message ?? 'No status message.'}
          {checkedIso && (
            <div style={{ marginTop: 8, color: dimWhite(.45), fontSize: 9.5 }}>
              checked {age(checkedIso)} ago
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Pulse halo for non-green rings. WAAPI loop, gated on reduced motion.
// data-studio-pulse lets studio.css force the resting (invisible) state
// under prefers-reduced-motion.
function RingPulse({ col, active }: { col: string; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el || prefersReducedMotion() || typeof el.animate !== 'function') return;
    const a = el.animate(
      [{ transform: 'scale(1)', opacity: .6 }, { transform: 'scale(1.5)', opacity: 0 }],
      { duration: 1800, iterations: Infinity },
    );
    return () => a.cancel();
  }, [active]);
  if (!active) return null;
  return (
    <div
      ref={ref}
      data-studio-pulse
      style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${col}`, opacity: 0 }}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════
// ACTIVE SESSIONS — grouped by branch, current tool, heartbeat age.
// ═══════════════════════════════════════════════════════════════════════
function SessionsPanel({ resp }: { resp: ActiveSessionsResp | null }) {
  const total = resp?.totalActive ?? 0;
  return (
    <DarkCard>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <PulseDot />
        <span className="caps" style={{ color: dimWhite(.7) }}>
          {total} Claude {total === 1 ? 'session' : 'sessions'} active
        </span>
        <span style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 11.5, color: dimWhite(.5) }}>
          heartbeat &lt; 2m
        </span>
      </div>
      {total === 0 || !resp ? (
        <div style={{ fontSize: 12, color: dimWhite(.45), fontFamily: FONT_SERIF, fontStyle: 'italic' }}>
          No active build sessions right now.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {resp.grouped.map((g) => (
            <div key={g.branch} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span className="mono" style={{ fontWeight: 700, color: 'var(--forest)' }}>{g.branch}</span>
              <span style={{ color: dimWhite(.5) }}>·</span>
              <span style={{ color: dimWhite(.7) }}>
                {g.sessionCount} {g.sessionCount === 1 ? 'session' : 'sessions'}
              </span>
              <span className="mono" style={{ fontSize: 10.5, color: dimWhite(.5), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                · {g.sessions.map((s) => fmtToolName(s.current_tool ?? '?')).slice(0, 3).join(', ')}
              </span>
              <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: dimWhite(.4) }}>
                {age(g.sessions[0].last_heartbeat)} ago
              </span>
            </div>
          ))}
        </div>
      )}
    </DarkCard>
  );
}

function PulseDot() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== 'function') return;
    const a = el.animate(
      [{ opacity: 1, transform: 'scale(1)' }, { opacity: .35, transform: 'scale(1.4)' }, { opacity: 1, transform: 'scale(1)' }],
      { duration: 1500, iterations: Infinity },
    );
    return () => a.cancel();
  }, []);
  return <span ref={ref} data-studio-pulse style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--forest)', display: 'inline-block', flexShrink: 0 }} />;
}

// ═══════════════════════════════════════════════════════════════════════
// BUILD EVENT ROW — glyph + message + age; check pill / deploy status.
// ═══════════════════════════════════════════════════════════════════════
function BuildEventRow({ e }: { e: BuildEvent }) {
  const glyphCol = e.t === 'deploy' ? 'var(--teal)' : e.t === 'pr' ? 'var(--gold)' : 'var(--forest)';
  return (
    <div style={{ display: 'flex', gap: 9, alignItems: 'baseline', fontSize: 12 }}>
      <span className="mono" style={{ color: glyphCol, flexShrink: 0 }}>{EV_GLYPH[e.t]}</span>
      <span style={{ color: dimWhite(.85), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{e.title}</span>
      {e.check && (
        <Pill tone={CHECK_TONE[e.check]} style={{ fontSize: 8.5, padding: '1px 6px' }}>{e.check.toUpperCase()}</Pill>
      )}
      {e.inProgress && (
        <span className="spinner" style={{ width: 11, height: 11, display: 'inline-block', borderColor: dimWhite(.2), borderTopColor: 'var(--teal)', flexShrink: 0 }} />
      )}
      {e.status === 'READY' && (
        <Pill tone="forest" style={{ fontSize: 8.5, padding: '1px 6px' }}>READY</Pill>
      )}
      <span className="mono" style={{ fontSize: 10, color: dimWhite(.4), flexShrink: 0 }}>{age(e.ts)}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// AGENT BLOCK (folded in, dark) — stat strip + two action cards + tool mix.
// Stats from /api/agent/metrics; rulebooks from /api/admin/agent/prompts.
// ═══════════════════════════════════════════════════════════════════════
function AgentBlock() {
  const [data, setData] = useState<AgentMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth('/api/agent/metrics');
        if (!res.ok) {
          if (!cancelled) setError(`Failed to load (${res.status})`);
          return;
        }
        const body = await res.json();
        if (!cancelled) setData((body.data ?? body) as AgentMetrics);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const issues = data ? data.toolErrorsToday + data.toolIncompleteToday : 0;
  const bd = dimWhite(.14);
  const cardBg = dimWhite(.05);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <span className="caps" style={{ color: dimWhite(.5) }}>AI agent · today</span>
          <h2 style={{ fontFamily: FONT_SERIF, fontSize: 23, fontWeight: 400, letterSpacing: '-0.02em', margin: '2px 0 0', color: '#fff' }}>
            The <span style={{ fontStyle: 'italic' }}>AI</span> inside Staxis
          </h2>
        </div>
      </div>

      {error ? (
        <div style={{ padding: '14px 16px', background: 'var(--terracotta-dim)', border: '1px solid rgba(194,86,46,.3)', borderRadius: 14, color: 'var(--terracotta)', fontSize: 13 }}>
          {error}
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', background: cardBg, border: `1px solid ${bd}`, borderRadius: 14, overflow: 'hidden' }}>
          <AgentStat label="User spend" value={data ? `$${data.today.totalCostUsd.toFixed(2)}` : '—'} sub={data ? `${data.today.requestCount} req · ${data.today.uniqueUsers} users` : ''} c="#fff" bd={bd} />
          <AgentStat label="Background" value={data ? `$${data.today.backgroundCostUsd.toFixed(2)}` : '—'} sub="summarizer + autopilot" c="var(--gold)" bd={bd} />
          <AgentStat label="Conversations" value={data ? String(data.recentConversations.length) : '—'} sub="recent · last 50" c="#fff" bd={bd} />
          <AgentStat label="Tool issues" value={data ? String(issues) : '—'} sub={data ? `${data.toolErrorsToday} err · ${data.toolIncompleteToday} incomplete` : ''} c={issues > 0 ? 'var(--terracotta)' : 'var(--forest)'} bd={bd} last />
        </div>
      )}

      {/* Two action cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px,1fr))', gap: 10, marginTop: 12 }}>
        <AgentActionCard
          href="/admin/agent"
          caps="Dashboard"
          title="Open agent"
          italic="dashboard"
          desc="Every conversation, cost, tool-error rates, model usage, cron health."
        />
        <AgentActionCard
          href="/admin/agent/prompts"
          caps="Prompts"
          title="Edit AI"
          italic="prompts"
          desc="Change behavior without a deploy. Versioned, 30s propagation."
          expandable
        />
      </div>

      {/* Tool-call mix */}
      <div style={{ marginTop: 12, background: cardBg, border: `1px solid ${bd}`, borderRadius: 14, padding: '12px 16px' }}>
        <span className="caps" style={{ color: dimWhite(.5) }}>Tool calls · today</span>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
          {!data ? (
            <div style={{ fontSize: 12, color: dimWhite(.45), fontFamily: FONT_SERIF, fontStyle: 'italic' }}>Loading…</div>
          ) : data.topTools.length === 0 ? (
            <div style={{ fontSize: 12, color: dimWhite(.45), fontFamily: FONT_SERIF, fontStyle: 'italic' }}>No tool calls yet today.</div>
          ) : (
            data.topTools.map((tc) => (
              <ToolBar key={tc.tool} tc={tc} max={Math.max(...data.topTools.map((x) => x.calls))} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function AgentStat({ label, value, sub, c, bd, last }: {
  label: string; value: string; sub?: string; c: string; bd: string; last?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  // Count up only when the value is a pure number / $-prefixed number.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const dollar = value.startsWith('$');
    const numStr = dollar ? value.slice(1) : value;
    const num = Number(numStr);
    if (value === '—' || !isFinite(num)) { el.textContent = value; return; }
    countUp(el, 0, num, {
      dur: 900,
      fmt: (v) => (dollar ? `$${v.toFixed(2)}` : String(Math.round(v))),
    });
  }, [value]);
  return (
    <div style={{ flex: '1 1 160px', minWidth: 150, padding: '14px 18px', borderRight: last ? 'none' : `1px solid ${bd}` }}>
      <span className="caps" style={{ color: dimWhite(.5) }}>{label}</span>
      <div style={{ marginTop: 4 }}>
        <SerifNum size={28} c={c}><span ref={ref}>{value}</span></SerifNum>
      </div>
      {sub && (
        <div className="mono" style={{ fontSize: 10, color: dimWhite(.45), marginTop: 4 }}>{sub}</div>
      )}
    </div>
  );
}

function AgentActionCard({ href, caps, title, italic, desc, expandable }: {
  href: string; caps: string; title: string; italic: string; desc: string; expandable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<PromptRow[] | null>(null);
  const [promptErr, setPromptErr] = useState<string | null>(null);
  const fetched = useRef(false);

  const loadPrompts = async () => {
    if (fetched.current) return;
    fetched.current = true;
    try {
      const res = await fetchWithAuth('/api/admin/agent/prompts');
      const json = await res.json();
      if (json.ok) setPrompts((json.data?.prompts ?? []) as PromptRow[]);
      else setPromptErr('Failed to load rulebooks.');
    } catch (e) {
      setPromptErr(e instanceof Error ? e.message : String(e));
    }
  };

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      if (next) void loadPrompts();
      return next;
    });
  };

  // For each rulebook role, pick the active version (fallback: newest).
  const rulebooks = RULEBOOK_ROLES.map(({ role, label }) => {
    const rows = (prompts ?? []).filter((p) => p.role === role);
    const active = rows.find((p) => p.is_active) ?? rows[0] ?? null;
    return { role, label, row: active };
  });

  return (
    <div style={{ background: dimWhite(.05), border: `1px solid ${dimWhite(.14)}`, borderRadius: 14, padding: '16px 18px' }}>
      <span className="caps" style={{ color: dimWhite(.5) }}>{caps}</span>
      <h3 style={{ fontFamily: FONT_SERIF, fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', margin: '3px 0 6px', color: '#fff' }}>
        {title} <span style={{ fontStyle: 'italic' }}>{italic}</span>
      </h3>
      <p style={{ fontSize: 12, color: dimWhite(.6), lineHeight: 1.5, marginBottom: expandable ? 10 : 12 }}>{desc}</p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Link
          href={href}
          style={{
            height: 28, padding: '0 12px', borderRadius: 999, background: dimWhite(.06), color: '#fff',
            border: `1px solid ${dimWhite(.25)}`, fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 600,
            display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none', whiteSpace: 'nowrap',
          }}
        >
          Open →
        </Link>
        {expandable && (
          <Btn size="sm" variant="ghost" onClick={toggle} style={{ color: '#fff', borderColor: dimWhite(.25) }}>
            {open ? 'Hide rulebooks' : 'Show rulebooks'}
          </Btn>
        )}
      </div>

      {expandable && open && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {promptErr ? (
            <span style={{ fontSize: 11, color: 'var(--terracotta)' }}>{promptErr}</span>
          ) : prompts === null ? (
            <span style={{ fontSize: 11, color: dimWhite(.5), fontFamily: FONT_MONO }}>Loading…</span>
          ) : (
            rulebooks.map(({ role, label, row }) => (
              <div key={role} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: dimWhite(.8) }}>
                <span style={{ flex: 1 }}>{label}</span>
                <span className="mono" style={{ fontSize: 10, color: dimWhite(.5) }}>
                  {row ? `v${row.version} · ${age(row.created_at)} ago` : 'none yet'}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ToolBar({ tc, max }: {
  tc: AgentMetrics['topTools'][number];
  max: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pct = max > 0 ? (tc.calls / max) * 100 : 0;
  useEffect(() => { sweepWidth(ref.current, pct, { dur: 760 }); }, [pct]);
  const barCol = tc.errorRatePct > 2 ? 'var(--terracotta)' : tc.errorRatePct > 0 ? 'var(--gold)' : 'var(--forest)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span className="mono" style={{ fontSize: 11, color: dimWhite(.8), width: 130, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {fmtToolName(tc.tool)}
      </span>
      <div style={{ flex: 1, height: 6, background: dimWhite(.1), borderRadius: 3, overflow: 'hidden' }}>
        <div ref={ref} style={{ height: '100%', width: 0, background: barCol }} />
      </div>
      <span className="mono" style={{ fontSize: 10.5, color: dimWhite(.6), width: 78, textAlign: 'right', flexShrink: 0 }}>
        {tc.calls} · {tc.errorRatePct}%
      </span>
    </div>
  );
}
