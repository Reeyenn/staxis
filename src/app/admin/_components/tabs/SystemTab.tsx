'use client';

/**
 * System tab — Snow design (May 2026), revised E2E (2026-05-22).
 *
 * Top (full-width): Marvel timeline — commits, deploys, worktrees,
 *   active Claude sessions. Compact (~30% shorter via zoom) so the
 *   live System Status panel below fits in viewport without scrolling.
 *
 * Below: live System Status panel. Polls /api/admin/system-status
 *   every 30s with admin session credentials (fetchWithAuth) and
 *   renders a green/yellow/red row per downstream service:
 *     - ML brain (every shard)
 *     - CUA onboarding worker (via queue freshness)
 *     - Scraper heartbeat
 *     - Scraper on-demand HTTP
 *     - Supabase (catches PostgREST schema-cache-stale)
 *     - Web app (this server)
 *
 * Removed in E2E: roadmap CRUD + admin audit log sections. The
 * /api/admin/roadmap and /api/admin/audit-log endpoints stay (other
 * callers may exist), only the UI sections were retired in favor of
 * the live status panel.
 */

import React, { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { MarvelTimeline } from '@/app/admin/_components/MarvelTimeline';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Card, Pill, StatusDot,
} from '@/app/admin/_components/_snow';
import type { SystemStatusResponse, ServiceColor } from '@/app/api/admin/system-status/route';

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

const CURSOR_MS = 2_000;
const REFRESH_MS = 60_000;
const STATUS_REFRESH_MS = 30_000;

export function SystemTab() {
  const [build, setBuild] = useState<{
    commits: Commit[]; deploys: Deploy[]; worktrees: Worktree[];
    branches?: Branch[]; merged?: MergedBranch[];
    pushes?: Push[]; openPRs?: OpenPR[];
    mainLatestTs?: string | null;
  } | null>(null);
  const [activeSessions, setActiveSessions] = useState<ActiveSessionsResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const [buildRes, sessionsRes] = await Promise.all([
        fetchWithAuth('/api/admin/build-status'),
        fetchWithAuth('/api/admin/active-sessions'),
      ]);
      const [buildJson, sessionsJson] = await Promise.all([
        buildRes.json(), sessionsRes.json(),
      ]);
      if (buildJson.ok) setBuild(buildJson.data);
      if (sessionsJson.ok) setActiveSessions(sessionsJson.data);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
  };

  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeenCursorTs = useRef<string | null>(null);

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

        if (sessionsJson.ok) {
          setActiveSessions(sessionsJson.data);
        }

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

  if (error) {
    return (
      <div style={{
        padding: '14px 16px',
        background: T.warmDim,
        border: `1px solid rgba(184,92,61,0.25)`,
        borderRadius: 14,
        color: T.warm, fontSize: 13,
        fontFamily: FONT_SANS,
      }}>{error}</div>
    );
  }

  if (!build) {
    return (
      <div style={{ padding: '60px 0', textAlign: 'center' }}>
        <div className="spinner" style={{ width: 24, height: 24, margin: '0 auto' }} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, fontFamily: FONT_SANS }}>

      <section>
        {/* Compact wrapper: zoom 0.7 shrinks the SVG-based timeline ~30%
            vertically AND horizontally while preserving text legibility
            (CSS zoom scales children proportionally and the parent's
            layout flow shrinks accordingly). Reeyen asked for this so
            the System Status panel below fits without scrolling. */}
        <div style={{ zoom: 0.7 as unknown as string }}>
          <MarvelTimeline
            commits={build.commits}
            deploys={build.deploys}
            worktrees={build.worktrees}
            branches={build.branches ?? []}
            merged={build.merged ?? []}
            pushes={build.pushes ?? []}
            openPRs={build.openPRs ?? []}
            mainLatestTs={build.mainLatestTs ?? null}
            activeSessions={activeSessions?.sessions ?? []}
          />
        </div>
        {activeSessions && activeSessions.totalActive > 0 && (
          <ActiveSessionsPanel resp={activeSessions} />
        )}
      </section>

      <SystemStatusPanel />
    </div>
  );
}

function SectionTitle({ caps, title, italic, right }: {
  caps: string; title: string; italic?: string; right?: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
      gap: 12, marginBottom: 4,
    }}>
      <div>
        <Caps>{caps}</Caps>
        <h2 style={{
          fontFamily: FONT_SERIF, fontSize: 24, fontWeight: 400,
          letterSpacing: '-0.02em', color: T.ink, margin: '2px 0 0',
          lineHeight: 1.15,
        }}>
          {title}
          {italic && <> <span style={{ fontStyle: 'italic' }}>{italic}</span></>}
        </h2>
      </div>
      {right}
    </div>
  );
}

function ActiveSessionsPanel({ resp }: { resp: ActiveSessionsResp }) {
  return (
    <Card padding="14px 18px" style={{
      marginTop: 12,
      background: 'linear-gradient(180deg, rgba(215,176,126,0.10), rgba(215,176,126,0.02))',
      border: `1px solid rgba(140,106,51,0.20)`,
      borderRadius: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: T.sageDeep,
          animation: 'pulseDot 1.4s ease-in-out infinite',
        }} />
        <Caps c={T.ink}>
          {resp.totalActive} Claude {resp.totalActive === 1 ? 'session' : 'sessions'} active
        </Caps>
        <span style={{ color: T.ink3, fontSize: 11, fontStyle: 'italic', fontFamily: FONT_SERIF }}>
          last heartbeat &lt; 2 min ago
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {resp.grouped.map((g) => (
          <div key={g.branch} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ fontFamily: FONT_MONO, fontWeight: 600, color: T.sageDeep }}>
              {g.branch}
            </span>
            <span style={{ color: T.ink3 }}>·</span>
            <span style={{ color: T.ink2 }}>
              {g.sessionCount} {g.sessionCount === 1 ? 'session' : 'sessions'}
            </span>
            <span style={{ color: T.ink3 }}>·</span>
            <span style={{ color: T.ink2, fontFamily: FONT_MONO, fontSize: 11 }}>
              {g.sessions.map((s) => fmtToolName(s.current_tool ?? '?')).slice(0, 3).join(', ')}
            </span>
            <span style={{ color: T.ink3, marginLeft: 'auto', fontFamily: FONT_MONO, fontSize: 10.5, letterSpacing: '0.04em' }}>
              {timeAgo(g.sessions[0].last_heartbeat)}
            </span>
          </div>
        ))}
      </div>
      <style>{`@keyframes pulseDot { 0%,100% { opacity: 1; transform: scale(1) } 50% { opacity: 0.4; transform: scale(1.3) } }`}</style>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SystemStatusPanel — live monitoring grid (Phase E2E, 2026-05-22).
// Polls /api/admin/system-status every 30s; renders one row per
// downstream service with a colored pill, latency, and last-checked
// time. Click a row to expand for the message.
// ---------------------------------------------------------------------------

interface ServiceRow {
  key: keyof SystemStatusResponse['services'];
  label: string;
  caption: string;
}

const SERVICE_ROWS: ServiceRow[] = [
  { key: 'web',               label: 'Web app',          caption: 'Vercel (this server)' },
  { key: 'ml',                label: 'ML brain',         caption: 'Railway — forecast service' },
  { key: 'cua',               label: 'Onboarding robot', caption: 'Fly.io — queue freshness' },
  { key: 'supabase',          label: 'Database',         caption: 'Supabase — PostgREST + cache' },
];

const COLOR_TONE: Record<ServiceColor, 'sage' | 'caramel' | 'warm'> = {
  green: 'sage',
  yellow: 'caramel',
  red: 'warm',
};
const DOT_TONE: Record<ServiceColor, 'sage' | 'caramel' | 'warm'> = {
  green: 'sage',
  yellow: 'caramel',
  red: 'warm',
};
const COLOR_LABEL: Record<ServiceColor, string> = {
  green: 'OK',
  yellow: 'DEGRADED',
  red: 'DOWN',
};

function SystemStatusPanel() {
  const [snapshot, setSnapshot] = useState<SystemStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const generatedAt = snapshot ? new Date(snapshot.generated_at) : null;

  return (
    <section>
      <SectionTitle
        caps="Status"
        title="System"
        italic="status"
        right={
          generatedAt && (
            <span style={{
              fontSize: 11, fontStyle: 'italic',
              fontFamily: FONT_SERIF, color: T.ink3,
            }}>
              Updated {timeAgo(generatedAt.toISOString())}
            </span>
          )
        }
      />

      {error && (
        <div style={{
          marginTop: 8, padding: '10px 14px',
          background: T.warmDim,
          border: `1px solid rgba(184,92,61,0.25)`,
          borderRadius: 12,
          fontSize: 12, color: T.warm,
        }}>{error}</div>
      )}

      {!snapshot && !error && (
        <div style={{ padding: '40px 0', textAlign: 'center' }}>
          <div className="spinner" style={{ width: 20, height: 20, margin: '0 auto' }} />
        </div>
      )}

      {snapshot && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {SERVICE_ROWS.map((row) => {
            const svc = snapshot.services[row.key];
            const isOpen = expanded.has(row.key);
            return (
              <div key={row.key}>
                <button
                  type="button"
                  onClick={() => toggleExpand(row.key)}
                  style={{
                    width: '100%',
                    padding: '12px 16px',
                    background: T.paper,
                    border: `1px solid ${T.rule}`,
                    borderRadius: 12,
                    display: 'flex', alignItems: 'center', gap: 12,
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: FONT_SANS,
                  }}
                  aria-expanded={isOpen}
                >
                  <StatusDot tone={DOT_TONE[svc.status]} size={9} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: T.ink, fontWeight: 500, letterSpacing: '-0.005em' }}>
                      {row.label}
                    </div>
                    <div style={{ fontSize: 11, color: T.ink3, fontFamily: FONT_SERIF, fontStyle: 'italic', marginTop: 1 }}>
                      {row.caption}
                    </div>
                  </div>
                  {svc.latency_ms !== undefined && (
                    <span style={{
                      fontFamily: FONT_MONO, fontSize: 11, color: T.ink2,
                      letterSpacing: '0.04em', flexShrink: 0,
                    }}>
                      {svc.latency_ms}ms
                    </span>
                  )}
                  <Pill tone={COLOR_TONE[svc.status]}>{COLOR_LABEL[svc.status]}</Pill>
                </button>
                {isOpen && svc.message && (
                  <div style={{
                    margin: '4px 12px 0 36px',
                    padding: '10px 14px',
                    background: T.ruleSoft,
                    border: `1px solid ${T.rule}`,
                    borderRadius: 10,
                    fontSize: 12, color: T.ink2,
                    fontFamily: FONT_MONO,
                    lineHeight: 1.5,
                  }}>{svc.message}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function fmtToolName(tool: string): string {
  if (!tool) return tool;
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__');
    return parts[parts.length - 1] || tool;
  }
  return tool;
}
