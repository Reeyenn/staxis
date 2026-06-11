'use client';

export const dynamic = 'force-dynamic';

/**
 * CUA Learning Board — Plan v8 Phase B chunk 2 + feature/cua-assist-board.
 *
 * Route: /admin/properties/mapper/[jobId]
 *
 * Reeyen opens this from a "learning now" card on /admin/property-sessions
 * or the in-flight column on the Onboarding tab. One page, per feed:
 *
 *   - Feed board: one row per mapper target — ✅ found (with the real row
 *     count + the actual captured rows, expandable) · ⏳ searching ·
 *     ❌ needs your help (ONLY the stuck feed; derived live from the
 *     pending mapping_help_requests row, never persisted) · ⊘ not in this
 *     PMS · ✕ couldn't find it · ◻ waiting in line. Terminal runs coerce
 *     leftovers ("didn't finish" / "not learned") — no immortal spinners.
 *     Sources: workflow_jobs.result.targetCatalog/boardTargets/actionsSoFar
 *     (written by cua-service/src/mapper.ts) via deriveFeedRows().
 *   - Point-and-click help: the stuck feed's privacy-redacted screenshot
 *     renders at natural aspect (width:100%/height:auto — the img rect IS
 *     the content rect, no letterboxing). A click maps to PMS-viewport
 *     coordinates by ratio (absorbs any DPR) and posts
 *     {actionType:'takeover', responseCoordinate} to /api/admin/mapper/
 *     assist; the robot executes the click as a recorded recipe step and
 *     continues. Text hint / unavailable / abort remain alongside.
 *   - Heartbeat: pings /api/admin/heartbeat every 30s while the tab is
 *     VISIBLE (visibility-gated — a forgotten background tab must not make
 *     the robot wait for an absent founder).
 *
 * Realtime: postgres_changes on mapping_help_requests (job-filtered) +
 * broadcast channel `mapping:{jobId}`; every broadcast event also schedules
 * a debounced refetch so the feed board updates per target without polling.
 * Poll fallback (10s) only while the realtime channel is down.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { fetchWithAuth } from '@/lib/api-fetch';
import { supabase } from '@/lib/supabase';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF, Card, Btn, Pill, Caps, SerifNum,
} from '@/app/admin/_components/_snow';
import {
  deriveFeedRows, summarizeFeedRows, isTerminalJobStatus, type FeedRow,
} from '@/lib/pms/learning-board';
import {
  ArrowLeft, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight,
  CircleSlash, Loader2, MousePointerClick, ShieldAlert, Send, XCircle,
} from 'lucide-react';
import Link from 'next/link';

interface WorkflowJobRow {
  id: string;
  property_id: string;
  kind: string;
  status: string;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  claude_cost_micros: number;
}

interface PropertyInfo {
  display_name: string;
  pms_family: string | null;
}

interface HelpRequestRow {
  id: string;
  target_key: string;
  question: string;
  what_ive_tried?: string[] | null;
  suggested_paths?: string[] | null;
  status: 'pending' | 'answered' | 'aborted' | 'expired';
  action_type?: 'guidance' | 'unavailable' | 'takeover' | 'abort' | null;
  response_text?: string | null;
  answered_at?: string | null;
  created_at: string;
  screenshot_storage_path?: string | null;
  /** Minted server-side by /api/admin/mapper/live (private bucket). */
  screenshotUrl?: string | null;
  viewport_w?: number | null;
  viewport_h?: number | null;
}

interface MappingEvent {
  type: string;
  jobId: string;
  label?: string;
  pct?: number;
  detail?: Record<string, unknown>;
  at: string;
}

/** The founder's pending click on the screenshot, in both PMS-viewport
 *  coordinates (sent to the robot) and percent (to draw the marker). */
interface ClickMarker {
  x: number;
  y: number;
  leftPct: number;
  topPct: number;
}

const GLYPH_META: Record<FeedRow['glyph'], { tone: 'sage' | 'caramel' | 'red' | 'warm' | 'neutral'; label: string }> = {
  found:        { tone: 'sage',    label: 'Found' },
  searching:    { tone: 'caramel', label: 'Searching…' },
  stuck:        { tone: 'red',     label: 'Needs your help' },
  unavailable:  { tone: 'neutral', label: 'Not in this PMS' },
  failed:       { tone: 'warm',    label: "Couldn't find it" },
  queued:       { tone: 'neutral', label: 'Waiting in line' },
  didnt_finish: { tone: 'warm',    label: "Didn't finish" },
  not_reached:  { tone: 'neutral', label: 'Not learned (run ended)' },
};

function GlyphIcon({ glyph }: { glyph: FeedRow['glyph'] }) {
  switch (glyph) {
    case 'found':        return <CheckCircle2 size={16} color={T.sageDeep} />;
    case 'searching':    return <Loader2 size={16} color={T.caramelDeep} style={{ animation: 'spin 1.5s linear infinite' }} />;
    case 'stuck':        return <AlertTriangle size={16} color={T.red} />;
    case 'unavailable':  return <CircleSlash size={16} color={T.ink3} />;
    case 'failed':       return <XCircle size={16} color={T.warm} />;
    case 'didnt_finish': return <XCircle size={16} color={T.warm} />;
    default:             return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', border: `1.5px solid ${T.ink3}`, margin: 4 }} />;
  }
}

export default function LiveMappingPage() {
  const { user, loading: authLoading } = useAuth();
  const params = useParams();
  const jobId = (Array.isArray(params?.jobId) ? params?.jobId[0] : params?.jobId) ?? '';

  const [job, setJob] = useState<WorkflowJobRow | null>(null);
  const [property, setProperty] = useState<PropertyInfo | null>(null);
  const [pendingHelp, setPendingHelp] = useState<HelpRequestRow | null>(null);
  const [recentHelp, setRecentHelp] = useState<HelpRequestRow[]>([]);
  const [activity, setActivity] = useState<MappingEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [guidanceText, setGuidanceText] = useState('');
  const [marker, setMarker] = useState<ClickMarker | null>(null);
  const [expandedFeeds, setExpandedFeeds] = useState<Set<string>>(new Set());

  const activityRef = useRef<HTMLDivElement>(null);
  const loadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial fetch of state.
  const load = async () => {
    try {
      const res = await fetchWithAuth(`/api/admin/mapper/live/${jobId}`);
      const json = await res.json();
      if (json.ok) {
        setJob(json.data.job);
        setProperty(json.data.property ?? null);
        // Keep the previous signed screenshot URL when the underlying
        // object hasn't changed — every load() mints a fresh signed URL
        // (new query string), which would re-download and flicker the
        // image the founder is about to click. Pending rows live ≤15min,
        // well inside the 1h signature.
        setPendingHelp((prev) => {
          const next = json.data.pendingHelpRequest as HelpRequestRow | null;
          if (
            prev && next && prev.id === next.id &&
            prev.screenshot_storage_path === next.screenshot_storage_path &&
            prev.screenshotUrl
          ) {
            return { ...next, screenshotUrl: prev.screenshotUrl };
          }
          return next;
        });
        setRecentHelp(json.data.recentHelpRequests);
        setError(null);
      } else {
        setError(json.error ?? 'Failed to load mapping job');
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Broadcast events arrive in bursts (a target start emits several) —
  // collapse them into one refetch.
  const scheduleLoad = () => {
    if (loadDebounceRef.current) clearTimeout(loadDebounceRef.current);
    loadDebounceRef.current = setTimeout(() => { void load(); }, 1_000);
  };

  // Plan v8 hardening (Codex P1 #3) — one initial GET for hydration,
  // then rely on realtime for updates. Polling only re-enables when the
  // realtime subscription enters CHANNEL_ERROR / CLOSED state. At 300
  // concurrent mapping jobs × multiple admins watching each, the old
  // 10s poll was 1000+ DB reads per minute on top of realtime.
  useEffect(() => {
    if (!jobId) return;
    void load();
    return () => {
      if (loadDebounceRef.current) clearTimeout(loadDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Heartbeat ping (P1-2 — keeps cua-service isAnyAdminOnline() true while
  // this tab is open AND VISIBLE). Visibility-gated: the robot waits up to
  // HELP_REQUEST_TIMEOUT_MS for a watching founder — a backgrounded tab
  // must not impersonate one.
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

  // Subscribe to mapping_help_requests postgres_changes for this job.
  // If the channel disconnects, fall back to 10s polling until it
  // reconnects (so admins still see help requests even if realtime drops).
  useEffect(() => {
    if (!jobId) return;
    let pollFallback: ReturnType<typeof setInterval> | null = null;
    const startPollFallback = () => {
      if (pollFallback) return;
      pollFallback = setInterval(() => { void load(); }, 10_000);
    };
    const stopPollFallback = () => {
      if (pollFallback) { clearInterval(pollFallback); pollFallback = null; }
    };
    const ch = supabase
      .channel(`mapping-help:${jobId}`)
      .on('postgres_changes' as any, {
        event: '*',
        schema: 'public',
        table: 'mapping_help_requests',
        filter: `job_id=eq.${jobId}`,
      }, () => { void load(); })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          stopPollFallback();
        } else if (status === 'CHANNEL_ERROR' || status === 'CLOSED' || status === 'TIMED_OUT') {
          startPollFallback();
        }
      });
    return () => {
      stopPollFallback();
      void ch.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Subscribe to the broadcast activity channel. Every event also schedules
  // a debounced refetch — that's what keeps the feed board live per target
  // (workflow_jobs is intentionally NOT in the realtime publication).
  useEffect(() => {
    if (!jobId) return;
    let confirmTimer: ReturnType<typeof setTimeout> | null = null;
    const ch = supabase
      .channel(`mapping:${jobId}`)
      .on('broadcast' as any, { event: '*' }, (msg: { event: string; payload: MappingEvent }) => {
        setActivity((prev) => [...prev, msg.payload].slice(-50));
        scheduleLoad();
        // Terminal broadcasts race the runtime's markCompleted UPDATE (the
        // broadcast fires first, then the runtime writes status+result). A
        // single 1s debounced load can land in between and freeze the board
        // on "running" — confirm with a second fetch after the dust settles.
        const t = msg.payload?.type ?? '';
        if (t === 'mapping_completed' || t === 'mapping_failed' || t === 'preflight_failed') {
          if (confirmTimer) clearTimeout(confirmTimer);
          confirmTimer = setTimeout(() => { void load(); }, 5_000);
        }
      })
      .subscribe();
    return () => {
      if (confirmTimer) clearTimeout(confirmTimer);
      void ch.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Slow safety poll while the job is live. Catches everything the event
  // channels can miss: the terminal-status race above, an RLS-silent
  // realtime channel (reports SUBSCRIBED but delivers nothing — the
  // realtime cousin of the silent-empty-state bug class), and any dropped
  // broadcast. 30s is cheap; it stops the moment the job is terminal.
  useEffect(() => {
    if (!jobId) return;
    if (job && isTerminalJobStatus(job.status)) return;
    const t = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, job?.status]);

  // Auto-scroll activity to bottom on new event.
  useEffect(() => {
    if (activityRef.current) {
      activityRef.current.scrollTop = activityRef.current.scrollHeight;
    }
  }, [activity.length]);

  // A new help request (or a resolved one) invalidates any pending click —
  // and so does a SCREENSHOT swap on the SAME request (worker restart
  // refreshes the row in place): a marker placed on the old frame must
  // never be sendable against the new one.
  useEffect(() => {
    setMarker(null);
  }, [pendingHelp?.id, pendingHelp?.screenshot_storage_path]);

  const submitAssist = async (
    actionType: 'guidance' | 'unavailable' | 'takeover' | 'abort',
    responseText?: string,
    responseCoordinate?: { x: number; y: number },
  ) => {
    if (!pendingHelp) return;
    if (actionType === 'guidance' && !responseText?.trim()) {
      alert('Please type a hint before sending.');
      return;
    }
    if (actionType === 'takeover' && !responseCoordinate) {
      alert('Click a spot on the screenshot first.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetchWithAuth('/api/admin/mapper/assist', {
        method: 'POST',
        body: JSON.stringify({
          requestId: pendingHelp.id,
          actionType,
          ...(responseText?.trim() ? { responseText: responseText.trim() } : (actionType !== 'takeover' ? { responseText: `Marked ${actionType}` } : {})),
          ...(responseCoordinate ? { responseCoordinate } : {}),
          // Takeover staleness arbiter: the server only commits the click if
          // the row STILL points at the screenshot this click was chosen on.
          ...(actionType === 'takeover' && pendingHelp.screenshot_storage_path
            ? { screenshotPath: pendingHelp.screenshot_storage_path }
            : {}),
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        alert(`Failed: ${json.error ?? 'unknown'}`);
      } else if (json.data?.accepted === false) {
        alert('This request was already answered (or expired) — refreshing.');
        void load();
      } else {
        setGuidanceText('');
        setMarker(null);
        // The realtime subscription will refresh state.
      }
    } catch (err) {
      alert(`Failed: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const onScreenshotClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!pendingHelp) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const vw = pendingHelp.viewport_w ?? 1280;
    const vh = pendingHelp.viewport_h ?? 800;
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    const x = Math.min(vw - 1, Math.max(0, Math.round(relX * vw)));
    const y = Math.min(vh - 1, Math.max(0, Math.round(relY * vh)));
    setMarker({ x, y, leftPct: relX * 100, topPct: relY * 100 });
  };

  const toggleFeed = (key: string) => {
    setExpandedFeeds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const feedRows = useMemo(() => deriveFeedRows({
    catalog: job?.result?.targetCatalog,
    boardTargets: job?.result?.boardTargets,
    actionsSoFar: job?.result?.actionsSoFar,
    pendingHelpTargetKey: pendingHelp?.target_key ?? null,
    jobStatus: job?.status,
  }), [job, pendingHelp]);
  const summary = useMemo(() => summarizeFeedRows(feedRows), [feedRows]);
  const searchingRow = feedRows.find((r) => r.glyph === 'searching');
  // INVARIANT guard for the panel too: a pending row whose target is
  // already found (stale after a worker restart) must not show a live
  // clickable panel — the robot is not listening on it.
  const pendingIsStale = Boolean(
    pendingHelp && feedRows.some((r) => r.key === pendingHelp.target_key && r.glyph === 'found'),
  );
  const jobTerminal = isTerminalJobStatus(job?.status);

  if (authLoading || !user) {
    return (
      <AppLayout>
        <div style={{ padding: 60, textAlign: 'center' }}>
          <Loader2 size={24} className="spin" />
        </div>
      </AppLayout>
    );
  }
  if (user.role !== 'admin') {
    return (
      <AppLayout>
        <div style={{ padding: 80, textAlign: 'center' }}>
          <ShieldAlert size={32} color={T.warm} />
          <p style={{ fontFamily: FONT_SERIF, fontSize: 22, fontStyle: 'italic', marginTop: 12 }}>
            Admin access only.
          </p>
        </div>
      </AppLayout>
    );
  }

  const costDollars = job ? (job.claude_cost_micros / 1_000_000).toFixed(2) : '0.00';
  const hotelName = property?.display_name ?? null;

  return (
    <AppLayout>
      <div style={{
        padding: '24px 48px 48px', maxWidth: 1200, margin: '0 auto',
        background: T.bg, minHeight: 'calc(100vh - 64px)',
        fontFamily: FONT_SANS,
      }}>
        {/* Back link */}
        <Link href="/admin/property-sessions" style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontFamily: FONT_MONO, fontSize: 11, color: T.ink3,
          textDecoration: 'none', letterSpacing: '0.16em',
          textTransform: 'uppercase', marginBottom: 16,
        }}>
          <ArrowLeft size={12} /> Sessions
        </Link>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap', marginBottom: 4 }}>
          <h1 style={{
            fontFamily: FONT_SERIF, fontSize: 32, fontWeight: 400,
            letterSpacing: '-0.02em', color: T.ink, margin: 0,
          }}>
            Learning {hotelName ? <span style={{ fontStyle: 'italic' }}>{hotelName}</span> : 'the hotel'}&rsquo;s PMS
          </h1>
          {property?.pms_family && <Pill tone="neutral">{property.pms_family}</Pill>}
          {job && (
            <Pill tone={
              job.status === 'completed' ? 'sage' :
              job.status === 'failed' ? 'warm' :
              job.status === 'running' ? 'caramel' : 'neutral'
            }>{job.status}</Pill>
          )}
        </div>
        <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3, marginBottom: 20 }}>
          job {jobId.slice(0, 8)}… · ${costDollars} spent{job ? ` · attempt ${job.attempts}/${job.max_attempts}` : ''}
        </div>

        {error && (
          <Card padding="16px 20px" style={{ borderColor: T.warm, marginBottom: 16 }}>
            <div style={{ color: T.warm, fontFamily: FONT_MONO, fontSize: 12 }}>
              <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
              {error}
            </div>
          </Card>
        )}

        {job?.error && (
          <Card padding="14px 20px" style={{ marginBottom: 16, borderColor: T.warm }}>
            <Caps c={T.warm}>Run error</Caps>
            <div style={{
              marginTop: 6, color: T.warm, fontFamily: FONT_MONO, fontSize: 11,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>{job.error.slice(0, 600)}</div>
          </Card>
        )}

        {/* Summary strip */}
        {job && (
          <Card padding="18px 24px" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 24, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <SerifNum size={44}>{summary.found}</SerifNum>
                <span style={{ fontFamily: FONT_SERIF, fontSize: 20, fontStyle: 'italic', color: T.ink2 }}>
                  of {summary.total} feeds found
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {summary.stuck > 0 && <Pill tone="red"><AlertTriangle size={11} /> {summary.stuck} needs your help</Pill>}
                {searchingRow && <Pill tone="caramel"><Loader2 size={11} style={{ animation: 'spin 1.5s linear infinite' }} /> searching: {searchingRow.label}</Pill>}
                {summary.unavailable > 0 && <Pill tone="neutral">{summary.unavailable} not in this PMS</Pill>}
                {summary.failed > 0 && <Pill tone="warm">{summary.failed} not found</Pill>}
                {summary.waiting > 0 && !jobTerminal && <Pill tone="neutral">{summary.waiting} waiting</Pill>}
              </div>
            </div>
          </Card>
        )}

        {/* Per-feed board */}
        {job && feedRows.length > 0 && (
          <Card padding="10px 24px 14px" style={{ marginBottom: 16 }}>
            <div style={{ padding: '10px 0 4px' }}>
              <Caps>Every feed, live</Caps>
            </div>
            {feedRows.map((row) => {
              const meta = GLYPH_META[row.glyph];
              const expandable = row.glyph === 'found' && Array.isArray(row.sample) && row.sample.length > 0;
              const expanded = expandedFeeds.has(row.key);
              const sampleCols = expandable ? Object.keys(row.sample![0] ?? {}) : [];
              return (
                <div key={row.key} style={{
                  borderTop: `1px solid ${T.ruleSoft}`,
                  background: row.glyph === 'stuck' ? T.redDim : 'transparent',
                  margin: row.glyph === 'stuck' ? '0 -24px' : 0,
                  padding: row.glyph === 'stuck' ? '0 24px' : 0,
                }}>
                  <div
                    onClick={expandable ? () => toggleFeed(row.key) : undefined}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '9px 0', cursor: expandable ? 'pointer' : 'default',
                    }}
                  >
                    <GlyphIcon glyph={row.glyph} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 13.5, color: T.ink, fontWeight: row.glyph === 'stuck' ? 600 : 400 }}>
                        {row.label}
                      </span>
                      {row.optional && (
                        <span style={{ fontFamily: FONT_MONO, fontSize: 9.5, color: T.ink3, marginLeft: 8, letterSpacing: '0.08em' }}>OPTIONAL</span>
                      )}
                      {row.glyph === 'failed' && row.reason && (
                        <span style={{ fontSize: 11.5, color: T.ink3, marginLeft: 8 }} title={row.reason}>
                          — {row.reason.length > 90 ? `${row.reason.slice(0, 89)}…` : row.reason}
                        </span>
                      )}
                    </div>
                    {row.glyph === 'found' && typeof row.rowCount === 'number' && (
                      <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: T.sageDeep }}>
                        {row.rowCount} {row.rowCount === 1 ? 'row' : 'rows'} seen
                      </span>
                    )}
                    {row.glyph === 'found' && row.carried && (
                      <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3 }} title="Carried over from an earlier attempt or from the existing recipe (repair run)">carried</span>
                    )}
                    <Pill tone={meta.tone}>{meta.label}</Pill>
                    {expandable && (expanded
                      ? <ChevronDown size={14} color={T.ink3} />
                      : <ChevronRight size={14} color={T.ink3} />)}
                  </div>
                  {expandable && expanded && (
                    <div style={{ padding: '2px 0 12px 26px', overflowX: 'auto' }}>
                      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, marginBottom: 6, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                        {row.sampleKind === 'records' ? 'Sample records it captured' : 'First rows it captured'}
                      </div>
                      <table style={{ borderCollapse: 'collapse', fontFamily: FONT_MONO, fontSize: 11 }}>
                        <thead>
                          <tr>
                            {sampleCols.map((c) => (
                              <th key={c} style={{
                                textAlign: 'left', padding: '3px 14px 3px 0', color: T.ink3,
                                fontWeight: 500, borderBottom: `1px solid ${T.rule}`,
                              }}>{c}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {row.sample!.map((r, i) => (
                            <tr key={i}>
                              {sampleCols.map((c) => (
                                <td key={c} style={{
                                  padding: '3px 14px 3px 0', color: T.ink2,
                                  borderBottom: `1px solid ${T.ruleSoft}`,
                                  maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                }}>{r[c] ?? ''}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        )}

        {/* Pending help-request panel — the point-and-click moment. */}
        {pendingHelp && pendingIsStale && (
          <Card padding="14px 20px" style={{ marginBottom: 16 }}>
            <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.ink3 }}>
              <CheckCircle2 size={14} style={{ verticalAlign: 'middle', marginRight: 6, color: T.sage }} />
              The robot already found “{pendingHelp.target_key}” — this old help request will clear itself. No action needed.
            </div>
          </Card>
        )}
        {pendingHelp && !pendingIsStale && !jobTerminal && (
          <Card padding="20px 24px" style={{
            marginBottom: 16, borderColor: T.red, borderWidth: 2,
          }}>
            <Caps style={{ color: T.red }}>It&rsquo;s stuck — show it where to go</Caps>
            <h2 style={{
              fontFamily: FONT_SERIF, fontSize: 20, fontWeight: 400,
              fontStyle: 'italic', margin: '4px 0 10px',
            }}>{feedRows.find((r) => r.key === pendingHelp.target_key)?.label ?? pendingHelp.target_key}</h2>
            <p style={{ fontSize: 14, color: T.ink, marginBottom: 12 }}>
              {pendingHelp.question}
            </p>
            {Array.isArray(pendingHelp.what_ive_tried) && pendingHelp.what_ive_tried.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <Caps>What it tried</Caps>
                <ul style={{ fontSize: 13, color: T.ink2, paddingLeft: 20, marginTop: 4 }}>
                  {pendingHelp.what_ive_tried.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>
            )}
            {Array.isArray(pendingHelp.suggested_paths) && pendingHelp.suggested_paths.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <Caps>Its guesses</Caps>
                <ul style={{ fontSize: 13, color: T.ink2, paddingLeft: 20, marginTop: 4 }}>
                  {pendingHelp.suggested_paths.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>
            )}

            {/* The robot's screen — click to teach. */}
            {pendingHelp.screenshotUrl ? (
              <div style={{ margin: '14px 0 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <MousePointerClick size={14} color={T.red} />
                  <span style={{ fontSize: 13, color: T.ink, fontWeight: 600 }}>
                    This is the robot&rsquo;s screen. Click exactly where it should click
                  </span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink3 }}>
                    (guest data is blacked out automatically)
                  </span>
                </div>
                <div style={{
                  position: 'relative', display: 'inline-block', width: '100%',
                  maxWidth: 980, border: `1px solid ${T.rule}`, borderRadius: 8,
                  overflow: 'hidden', lineHeight: 0,
                }}>
                  {/* width:100% + height:auto — the <img> rect IS the bitmap
                      rect, so the percent → viewport-pixel ratio math below
                      has no letterbox offset to correct for. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={pendingHelp.screenshotUrl}
                    alt="The robot's current screen (sensitive fields redacted)"
                    onClick={onScreenshotClick}
                    style={{ width: '100%', height: 'auto', display: 'block', cursor: 'crosshair' }}
                  />
                  {marker && (
                    <div style={{
                      position: 'absolute', left: `${marker.leftPct}%`, top: `${marker.topPct}%`,
                      transform: 'translate(-50%, -50%)', pointerEvents: 'none',
                      width: 22, height: 22, borderRadius: '50%',
                      border: `3px solid ${T.red}`, background: 'rgba(160,74,44,0.25)',
                      boxShadow: '0 0 0 3px rgba(255,255,255,0.85)',
                    }} />
                  )}
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                  <Btn
                    variant="primary"
                    onClick={() => marker && void submitAssist('takeover', guidanceText, marker ? { x: marker.x, y: marker.y } : undefined)}
                    disabled={submitting || !marker}
                  >
                    <MousePointerClick size={13} /> Send this click
                  </Btn>
                  {marker
                    ? <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2 }}>will click at ({marker.x}, {marker.y})</span>
                    : <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3 }}>click the screenshot first</span>}
                </div>
              </div>
            ) : (
              <div style={{
                margin: '12px 0', padding: 10, borderRadius: 6,
                background: T.warmDim, fontFamily: FONT_MONO, fontSize: 11, color: T.warm,
              }}>
                No screenshot available for this request — use a text hint below.
              </div>
            )}

            <textarea
              value={guidanceText}
              onChange={(e) => setGuidanceText(e.target.value)}
              placeholder="Optional note with your click, or a text hint on its own (e.g., 'Reports → Audit → Revenue Detail')…"
              style={{
                width: '100%', minHeight: 70, padding: 10,
                fontFamily: FONT_SANS, fontSize: 13, color: T.ink,
                border: `1px solid ${T.ink3}`, borderRadius: 4,
                marginBottom: 12, background: T.paper,
              }}
            />

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Btn
                variant="sage"
                onClick={() => void submitAssist('guidance', guidanceText)}
                disabled={submitting || !guidanceText.trim()}
              >
                <Send size={12} /> Send hint only
              </Btn>
              <Btn
                variant="warm"
                onClick={() => void submitAssist('unavailable', 'Skipping — admin marked unavailable.')}
                disabled={submitting}
              >
                My PMS doesn&rsquo;t have this
              </Btn>
              <Btn
                variant="ghost"
                onClick={() => { if (confirm('Stop the whole learning run? You will still see what it found on this page, but a future run starts learning from scratch.')) void submitAssist('abort', 'Aborted by admin.'); }}
                disabled={submitting}
              >
                Stop the whole run
              </Btn>
            </div>
            <p style={{
              fontFamily: FONT_MONO, fontSize: 10, color: T.ink3,
              marginTop: 8, lineHeight: 1.5,
            }}>
              <strong>Send this click</strong> makes the robot click that exact spot, learn the page, and keep going.
              <strong> Send hint only</strong> tells it what to try in words. <strong>My PMS doesn&rsquo;t have this</strong> skips just this feed.
            </p>
          </Card>
        )}

        {!pendingHelp && job?.status === 'running' && (
          <Card padding="16px 20px" style={{ marginBottom: 16 }}>
            <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.ink3 }}>
              <CheckCircle2 size={14} style={{ verticalAlign: 'middle', marginRight: 6, color: T.sage }} />
              The robot is working on its own. If it gets stuck, the feed turns red here and it waits for your click.
            </div>
          </Card>
        )}

        {/* Activity feed */}
        <Card padding="16px 20px">
          <Caps>Activity</Caps>
          <div
            ref={activityRef}
            style={{
              fontFamily: FONT_MONO, fontSize: 11, color: T.ink2,
              lineHeight: 1.7, marginTop: 8, maxHeight: 300,
              overflowY: 'auto', background: T.bg,
              padding: 12, borderRadius: 4,
            }}
          >
            {activity.length === 0
              ? <div style={{ color: T.ink3 }}>Waiting for events…</div>
              : activity.map((evt, i) => (
                  <div key={i}>
                    <span style={{ color: T.ink3 }}>{new Date(evt.at).toLocaleTimeString()}</span>
                    {' '}
                    <span style={{ color: T.caramelDeep }}>[{evt.type}]</span>
                    {' '}
                    {evt.label ?? ''}
                    {typeof evt.pct === 'number' ? ` (${evt.pct}%)` : ''}
                  </div>
                ))}
          </div>
        </Card>

        {/* Recent help-request history */}
        {recentHelp.length > 0 && (
          <Card padding="16px 20px" style={{ marginTop: 16 }}>
            <Caps>Recent help requests</Caps>
            <div style={{ marginTop: 8 }}>
              {recentHelp.map((h) => (
                <div key={h.id} style={{
                  display: 'flex', gap: 12, alignItems: 'baseline',
                  padding: '6px 0', borderTop: `1px solid ${T.rule}`,
                }}>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, width: 80 }}>
                    {new Date(h.created_at).toLocaleTimeString()}
                  </span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, flex: 1 }}>
                    {h.target_key}
                  </span>
                  <Pill tone={
                    h.status === 'answered' && h.action_type === 'takeover' ? 'sage' :
                    h.status === 'answered' && h.action_type === 'guidance' ? 'sage' :
                    h.status === 'answered' ? 'caramel' :
                    h.status === 'pending' ? 'caramel' :
                    'neutral'
                  }>{h.action_type ?? h.status}</Pill>
                </div>
              ))}
            </div>
          </Card>
        )}

        <style>{`@keyframes spin { to { transform: rotate(360deg) } } .spin { animation: spin 1s linear infinite }`}</style>
      </div>
    </AppLayout>
  );
}
