'use client';

export const dynamic = 'force-dynamic';

/**
 * /admin/property-sessions — per-hotel CUA session health, in the admin's
 * Snow design language (re-skinned from generic Tailwind on
 * feature/cua-assist-board to match the rest of the admin studio).
 *
 * One card per property_sessions row. Shows: status, heartbeat freshness,
 * Claude spend today, paused-reason, and admin actions (resume MFA,
 * reset cost cap, stop, restart).
 *
 * Learning Board entry point: when a mapper job is queued/running for the
 * hotel's PMS family, the card grows a "learning its PMS now" banner whose
 * button opens the live board (/admin/properties/mapper/[jobId]) — the
 * one-click path Reeyen expects when a hotel is being learned. A hotel
 * parked on paused_no_knowledge_file with a finished run links to that
 * run's board instead.
 *
 * Heartbeat: pings /api/admin/heartbeat every 30s while the tab is VISIBLE
 * so the robot knows the founder is watching and waits for his click on a
 * stuck feed (visibility-gated — a forgotten background tab must not make
 * the robot wait for an absent founder).
 *
 * Source: /api/admin/cua-sessions (property_sessions + pms_knowledge_files
 * + properties + recent mapper workflow_jobs).
 */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF, Card, Btn, Pill, Caps, type PillTone,
} from '@/app/admin/_components/_snow';
import {
  CheckCircle2,
  AlertCircle,
  Clock,
  ShieldAlert,
  RefreshCw,
  ChevronLeft,
  StopCircle,
  Play,
  ExternalLink,
  Loader2,
  Eye,
} from 'lucide-react';

interface MapperJobSummary {
  id: string;
  status: string;
  created_at: string;
  /** Active jobs only — the robot is stuck waiting for the founder's click. */
  needs_help?: boolean;
}

interface SessionRow {
  property_id: string;
  display_name: string;
  pms_family: string;
  status: string;
  last_alive_at: string | null;
  last_successful_read_at: string | null;
  current_browser_url: string | null;
  daily_claude_cost_micros: number;
  daily_claude_cost_resets_at: string | null;
  paused_reason: string | null;
  paused_until: string | null;
  worker_machine_id: string | null;
  restart_count: number;
  read_failure_streak: number;
  notes: string | null;
  knowledge_file: {
    active: number | null; latest: number; status: string;
    // feat/cua-partial-promotion — gaps on the ACTIVE version.
    missing_required?: string[];
    missing_business_critical?: string[];
    /** Newest status='draft' row (the founder's review queue). */
    newest_draft?: number | null;
  } | null;
  active_mapper_job: MapperJobSummary | null;
  last_mapper_job: MapperJobSummary | null;
  /** Latest missing-feed backfill attempt for this family (best-effort). */
  backfill: { last_at: string; last_outcome: string } | null;
}

const STATUS_STYLE: Record<string, { tone: PillTone; icon: React.ReactNode; label: string }> = {
  starting:                  { tone: 'neutral', icon: <Clock size={12} />,        label: 'Starting' },
  alive:                     { tone: 'sage',    icon: <CheckCircle2 size={12} />, label: 'Alive' },
  paused_cost_cap:           { tone: 'caramel', icon: <AlertCircle size={12} />,  label: 'Cost cap' },
  paused_mfa:                { tone: 'caramel', icon: <ShieldAlert size={12} />,  label: 'MFA needed' },
  paused_no_knowledge_file:  { tone: 'caramel', icon: <AlertCircle size={12} />,  label: 'Needs mapping' },
  paused_circuit_breaker:    { tone: 'red',     icon: <AlertCircle size={12} />,  label: 'Circuit broken' },
  failed_restart:            { tone: 'red',     icon: <AlertCircle size={12} />,  label: 'Failed' },
  stopped:                   { tone: 'neutral', icon: <StopCircle size={12} />,   label: 'Stopped' },
};

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Caps size={9.5}>{label}</Caps>
      <div style={{ fontFamily: FONT_MONO, fontSize: 12.5, color: T.ink, marginTop: 3 }}>
        {children}
      </div>
    </div>
  );
}

export default function PropertySessionsPage() {
  const { user, loading: authLoading } = useAuth();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/admin/cua-sessions');
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'Failed to load CUA sessions');
        setLoading(false);
        return;
      }
      setRows(json.data.sessions);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [user, load]);

  // Learning Board heartbeat — the robot only waits for a human click on a
  // stuck feed while an admin heartbeated in the last 5 minutes. Watching
  // THIS fleet page counts as watching; a hidden tab does not.
  useEffect(() => {
    if (!user || user.role !== 'admin') return;
    const ping = () => {
      if (document.visibilityState !== 'visible') return;
      void fetchWithAuth('/api/admin/heartbeat', { method: 'POST' });
    };
    ping();
    const t = setInterval(ping, 30_000);
    document.addEventListener('visibilitychange', ping);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', ping);
    };
  }, [user]);

  const handleAction = async (propertyId: string, action: string) => {
    if (!confirm(`Run "${action}" on ${propertyId}?`)) return;
    setActionLoading(`${propertyId}:${action}`);
    try {
      const res = await fetchWithAuth('/api/admin/cua-sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ propertyId, action }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert(`Action failed: ${json.error ?? 'unknown'}`);
      } else {
        await load();
      }
    } finally {
      setActionLoading(null);
    }
  };

  if (authLoading) return <AppLayout><div style={{ padding: 32, fontFamily: FONT_SANS, color: T.ink2 }}>Loading…</div></AppLayout>;
  if (!user) return <AppLayout><div style={{ padding: 32, fontFamily: FONT_SANS, color: T.ink2 }}>Not signed in</div></AppLayout>;

  return (
    <AppLayout>
      <div style={{
        padding: '24px 48px 48px', maxWidth: 1200, margin: '0 auto',
        background: T.bg, minHeight: 'calc(100vh - 64px)', fontFamily: FONT_SANS,
      }}>
        <Link href="/admin/properties#onboarding" style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontFamily: FONT_MONO, fontSize: 11, color: T.ink3,
          textDecoration: 'none', letterSpacing: '0.16em',
          textTransform: 'uppercase', marginBottom: 16,
        }}>
          <ChevronLeft size={12} /> Onboarding
        </Link>

        <div style={{
          display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
          gap: 16, flexWrap: 'wrap', marginBottom: 6,
        }}>
          <h1 style={{
            fontFamily: FONT_SERIF, fontSize: 32, fontWeight: 400,
            letterSpacing: '-0.02em', color: T.ink, margin: 0,
          }}>
            <span style={{ fontStyle: 'italic' }}>CUA</span> Sessions
          </h1>
          <Btn variant="ghost" size="sm" onClick={() => void load()}>
            <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} /> Refresh
          </Btn>
        </div>
        <p style={{ fontSize: 13, color: T.ink2, margin: '0 0 20px' }}>
          Per-hotel session-driver health, heartbeat, and cost. Hotels being learned for the
          first time show a live board link. New hotels are onboarded from the{' '}
          <Link href="/admin/properties#onboarding" style={{ color: T.ink, textDecorationColor: T.rule }}>Onboarding tab</Link>.
        </p>

        {error && (
          <Card padding="14px 18px" style={{ marginBottom: 16, borderColor: T.warm }}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.warm }}>{error}</span>
          </Card>
        )}

        {loading && !rows && (
          <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.ink3 }}>Loading sessions…</div>
        )}

        {rows && rows.length === 0 && (
          <Card padding="28px 24px" style={{ textAlign: 'center', borderStyle: 'dashed' }}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.ink3 }}>
              No CUA sessions yet. They appear here when a hotel enables CUA polling.
            </span>
          </Card>
        )}

        {rows && rows.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {rows.map((s) => {
              const style = STATUS_STYLE[s.status] ?? STATUS_STYLE.starting!;
              const heartbeatAge = s.last_alive_at ? Date.now() - new Date(s.last_alive_at).getTime() : null;
              const heartbeatStale = heartbeatAge !== null && heartbeatAge > 5 * 60_000;
              const dollarsToday = (s.daily_claude_cost_micros / 1_000_000).toFixed(2);
              const learning = s.active_mapper_job;
              return (
                <Card key={s.property_id} padding="18px 22px">
                  <div style={{
                    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                    gap: 12, flexWrap: 'wrap', marginBottom: 12,
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: FONT_SERIF, fontSize: 20, color: T.ink }}>{s.display_name}</span>
                        <Pill tone={style.tone}>{style.icon} {style.label}</Pill>
                      </div>
                      <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink3, marginTop: 4 }}>
                        {s.pms_family} · {s.property_id}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {s.status === 'paused_mfa' && (
                        <Btn variant="warm" size="sm" href={`/admin/mfa-resume/${s.property_id}`}>
                          <ShieldAlert size={12} /> Resolve MFA
                        </Btn>
                      )}
                      {s.status === 'paused_cost_cap' && (
                        <Btn
                          variant="sage" size="sm"
                          onClick={() => void handleAction(s.property_id, 'reset_cost_cap')}
                          disabled={actionLoading === `${s.property_id}:reset_cost_cap`}
                        >
                          <RefreshCw size={12} /> Reset cap
                        </Btn>
                      )}
                      {s.status !== 'stopped' && (
                        <Btn
                          variant="ghost" size="sm"
                          onClick={() => void handleAction(s.property_id, 'stop')}
                          disabled={actionLoading === `${s.property_id}:stop`}
                        >
                          <StopCircle size={12} /> Stop
                        </Btn>
                      )}
                      {(s.status === 'stopped' || s.status === 'failed_restart') && (
                        <Btn
                          variant="sage" size="sm"
                          onClick={() => void handleAction(s.property_id, 'restart')}
                          disabled={actionLoading === `${s.property_id}:restart`}
                        >
                          <Play size={12} /> Restart
                        </Btn>
                      )}
                    </div>
                  </div>

                  {/* Learning Board entry — the robot is learning this PMS right
                      now. RED when it's stuck waiting for the founder's click
                      (the heartbeat from this very page is what makes it wait,
                      so the request must be visible HERE, not just on the board). */}
                  {learning && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                      padding: '12px 14px', borderRadius: 10, marginBottom: 12,
                      background: learning.needs_help ? T.redDim : T.caramelDim,
                      border: `1px solid ${learning.needs_help ? 'rgba(160,74,44,0.35)' : 'rgba(140,106,51,0.25)'}`,
                    }}>
                      {learning.needs_help
                        ? <AlertCircle size={16} color={T.red} />
                        : <Loader2 size={16} color={T.caramelDeep} style={{ animation: 'spin 1.5s linear infinite' }} />}
                      <div style={{ flex: 1, minWidth: 220 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, color: learning.needs_help ? T.red : T.caramelDeep }}>
                          {learning.needs_help
                            ? 'It’s stuck — it needs you to show it where to click'
                            : 'Learning its PMS right now'}
                        </div>
                        <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink2, marginTop: 2 }}>
                          {learning.needs_help
                            ? 'open the board and click the right spot on its screen — it’s waiting for you'
                            : `feed-by-feed progress, captured data, and stuck alerts on the live board${learning.status === 'queued' ? ' · waking up…' : ''}`}
                        </div>
                      </div>
                      <Btn variant="primary" size="sm" href={`/admin/properties/mapper/${learning.id}`}>
                        <Eye size={12} /> {learning.needs_help ? 'Help it now' : 'Watch it learn — live'}
                      </Btn>
                    </div>
                  )}
                  {!learning && s.last_mapper_job && (
                    <div style={{ marginBottom: 12 }}>
                      <Btn variant="ghost" size="sm" href={`/admin/properties/mapper/${s.last_mapper_job.id}`}>
                        <Eye size={12} /> See the last learning run ({s.last_mapper_job.status})
                      </Btn>
                    </div>
                  )}

                  <div style={{
                    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                    gap: 12,
                  }}>
                    <Stat label="Heartbeat">
                      <span style={{ color: heartbeatStale ? T.red : T.ink }}>
                        {s.last_alive_at ? `${Math.floor((heartbeatAge ?? 0) / 1000)}s ago` : 'never'}
                      </span>
                    </Stat>
                    <Stat label="Spend today">${dollarsToday} / $5.00</Stat>
                    <Stat label="Knowledge file">
                      {s.knowledge_file?.active != null ? `v${s.knowledge_file.active} active` : 'none active'}
                    </Stat>
                    <Stat label="Restarts / failures">
                      {s.restart_count} restarts · {s.read_failure_streak} fail streak
                    </Stat>
                  </div>

                  {s.paused_reason && (
                    <div style={{
                      marginTop: 12, padding: '8px 12px', borderRadius: 8,
                      background: T.caramelDim, border: '1px solid rgba(140,106,51,0.2)',
                      fontSize: 12, color: T.caramelDeep,
                    }}>
                      {s.paused_reason}
                    </div>
                  )}

                  {/* feat/cua-partial-promotion (founder-gated) — a draft
                      newer than the active is PARKED awaiting the Promote
                      click; surface it so partial maps don't sit invisible.
                      NOT live — copy must never imply otherwise. Keyed on
                      newest_draft explicitly (a newer quarantined row must
                      not hide it). */}
                  {s.knowledge_file && (s.knowledge_file.newest_draft ?? 0) > (s.knowledge_file.active ?? 0) && (
                    <div className="mt-3 px-3 py-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-800">
                      <span className="font-semibold">Draft v{s.knowledge_file.newest_draft} awaiting review</span>
                      {' — not live. Review what the robot learned and promote it in Manage maps; daily auto-retries are paused until then.'}
                    </div>
                  )}

                  {/* feat/cua-partial-promotion — partial active recipe:
                      amber for missing REQUIRED feeds, quiet gray for
                      BC-only gaps. The retry line must not contradict the
                      blue chip: while a newer draft awaits review, retries
                      are PAUSED (the cron's draft-awaiting gate). */}
                  {(s.knowledge_file?.missing_required?.length ?? 0) > 0 && (
                    <div className="mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                      <span className="font-semibold">Partial live recipe</span>
                      {' — still learning: '}
                      {s.knowledge_file!.missing_required!.join(', ')}
                      {(s.knowledge_file!.newest_draft ?? 0) > (s.knowledge_file!.active ?? 0)
                        ? ' · auto-retries paused while the draft above awaits review'
                        : s.backfill
                          ? ` · last auto-retry ${new Date(s.backfill.last_at).toLocaleDateString()} (${s.backfill.last_outcome})`
                          : ' · auto-retrying daily'}
                    </div>
                  )}
                  {(s.knowledge_file?.missing_required?.length ?? 0) === 0 &&
                    (s.knowledge_file?.missing_business_critical?.length ?? 0) > 0 && (
                    <div className="mt-3 px-3 py-2 bg-gray-50 border border-gray-200 rounded text-xs text-gray-600">
                      Optional feeds not learned yet: {s.knowledge_file!.missing_business_critical!.join(', ')}
                      {s.backfill ? ` · last auto-retry ${new Date(s.backfill.last_at).toLocaleDateString()}` : ''}
                    </div>
                  )}

                  {s.current_browser_url && (
                    <div style={{
                      marginTop: 10, fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink3,
                      display: 'flex', alignItems: 'center', gap: 6,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      <ExternalLink size={11} style={{ flexShrink: 0 }} /> {s.current_browser_url}
                    </div>
                  )}

                  {s.notes && (
                    <div style={{ marginTop: 8, fontSize: 12, color: T.ink3 }}>
                      {s.notes}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    </AppLayout>
  );
}
