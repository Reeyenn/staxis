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
 *   - Live view (feature/cua-live-view): "Robot's screen" card shows the
 *     latest privacy-hardened frame the robot tee'd to storage — refreshed
 *     per live_frame broadcast via /api/admin/mapper/live/[jobId]/frame
 *     (short-lived signed URL). The robot only uploads while the admin
 *     heartbeat above is fresh, so watching the page is what turns the
 *     stream on. Frames pause while the robot waits on a help request.
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
  FONT_SANS, FONT_MONO, FONT_SERIF, Btn, Pill, Caps, SerifNum, type PillTone,
} from '@/app/admin/_components/studio/kit';
import {
  SurfaceShell, DarkCard, dimWhite,
} from '@/app/admin/_components/studio/surface-kit';
import '@/app/admin/_components/studio/studio.css';
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

/** feature/cua-live-view — latest live frame, served by
 *  /api/admin/mapper/live/[jobId]/frame (short-lived signed URL into the
 *  private bucket; the robot only uploads while an admin heartbeat is
 *  fresh, so this exists only while someone is watching). */
interface LiveFrameState {
  url: string;
  /** Storage object timestamp — drives the "Xs ago" label. */
  updatedAt: string | null;
}

const GLYPH_META: Record<FeedRow['glyph'], { tone: PillTone; label: string }> = {
  found:        { tone: 'forest',     label: 'Found' },
  searching:    { tone: 'gold',       label: 'Searching…' },
  stuck:        { tone: 'terracotta', label: 'Needs your help' },
  unavailable:  { tone: 'neutral',    label: 'Not in this PMS' },
  failed:       { tone: 'terracotta', label: "Couldn't find it" },
  queued:       { tone: 'neutral',    label: 'Waiting in line' },
  didnt_finish: { tone: 'terracotta', label: "Didn't finish" },
  not_reached:  { tone: 'neutral',    label: 'Not learned (run ended)' },
};

function GlyphIcon({ glyph }: { glyph: FeedRow['glyph'] }) {
  switch (glyph) {
    case 'found':        return <CheckCircle2 size={16} color="var(--forest)" />;
    case 'searching':    return <Loader2 size={16} color="var(--gold)" style={{ animation: 'spin 1.5s linear infinite' }} />;
    case 'stuck':        return <AlertTriangle size={16} color="var(--terracotta)" />;
    case 'unavailable':  return <CircleSlash size={16} color={dimWhite(.45)} />;
    case 'failed':       return <XCircle size={16} color="var(--terracotta)" />;
    case 'didnt_finish': return <XCircle size={16} color="var(--terracotta)" />;
    default:             return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', border: `1.5px solid ${dimWhite(.35)}`, margin: 4 }} />;
  }
}

// Full-bleed dark admin canvas — mirrors StudioShell's `.admin-studio`
// wrapper (same inline overrides) so this standalone page sits on the same
// continuous dark ink as the studio surfaces.
function DarkScope({ children }: { children: React.ReactNode }) {
  return (
    <div className="admin-studio" style={{
      background: 'var(--ink)', color: '#fff',
      marginLeft: 'calc(50% - 50vw)', marginRight: 'calc(50% - 50vw)',
      minHeight: 'calc(100vh - 64px)',
    }}>
      {children}
    </div>
  );
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
  // feature/cua-live-view — the robot's latest screen (continuous live view).
  const [liveFrame, setLiveFrame] = useState<LiveFrameState | null>(null);
  // Re-render tick so the "Xs ago" freshness label stays honest.
  const [frameTick, setFrameTick] = useState(0);

  const activityRef = useRef<HTMLDivElement>(null);
  const loadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameFetchBusyRef = useRef(false);
  // A live_frame event landing while a fetch is in flight must not be
  // dropped (it may be the LAST frame before a long pause) — coalesce it
  // into one follow-up fetch.
  const frameFetchQueuedRef = useRef(false);
  // Generation token: bumped when the job changes (or the page unmounts)
  // so a slow in-flight frame fetch can never commit another job's screen
  // — or set state after unmount.
  const frameGenRef = useRef(0);

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

  // feature/cua-live-view — refresh the robot's live screen. Cheap route
  // (no DB work beyond the admin gate) so it's safe to call once per
  // live_frame broadcast. Single-flight with a 1-deep coalesced re-run:
  // frames land every few seconds; overlapping fetches would just race
  // each other, but a refresh requested mid-fetch must still happen (it
  // may announce the final frame before a pause). Preload-then-commit
  // keeps the previous frame on screen while the next downloads.
  const fetchFrame = async () => {
    if (frameFetchBusyRef.current) {
      frameFetchQueuedRef.current = true;
      return;
    }
    frameFetchBusyRef.current = true;
    const gen = frameGenRef.current;
    try {
      const res = await fetchWithAuth(`/api/admin/mapper/live/${jobId}/frame`);
      const json = await res.json();
      if (!json.ok) return;
      const frame = (json.data?.frame ?? null) as LiveFrameState | null;
      if (gen !== frameGenRef.current) return; // job changed / unmounted
      if (!frame) {
        // Normal idle state: nothing uploaded yet, or the job ended and
        // cleanup removed the object.
        setLiveFrame(null);
        return;
      }
      await new Promise<void>((resolve) => {
        const img = new window.Image();
        img.onload = () => {
          if (gen === frameGenRef.current) setLiveFrame(frame);
          resolve();
        };
        // Signed-URL hiccup / object swapped mid-download: keep the old
        // frame, the next broadcast or poll retries.
        img.onerror = () => resolve();
        img.src = frame.url;
      });
    } catch {
      // Network hiccup — next event/poll retries.
    } finally {
      frameFetchBusyRef.current = false;
      if (frameFetchQueuedRef.current) {
        frameFetchQueuedRef.current = false;
        void fetchFrame();
      }
    }
  };

  // Plan v8 hardening (Codex P1 #3) — one initial GET for hydration,
  // then rely on realtime for updates. Polling only re-enables when the
  // realtime subscription enters CHANNEL_ERROR / CLOSED state. At 300
  // concurrent mapping jobs × multiple admins watching each, the old
  // 10s poll was 1000+ DB reads per minute on top of realtime.
  useEffect(() => {
    if (!jobId) return;
    setLiveFrame(null); // never show a previous job's screen on this one
    void load();
    void fetchFrame();
    return () => {
      if (loadDebounceRef.current) clearTimeout(loadDebounceRef.current);
      // Invalidate in-flight frame fetches (job switch or unmount).
      frameGenRef.current += 1;
      frameFetchQueuedRef.current = false;
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
        // feature/cua-live-view — live_frame is a metadata-only nudge that
        // fires every few seconds while the robot works. It must NOT enter
        // the activity feed and must NOT trigger the full-state refetch
        // (that's 4 DB queries per event) — it only refreshes the frame.
        if (msg.event === 'live_frame' || msg.payload?.type === 'live_frame') {
          void fetchFrame();
          return;
        }
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
    const t = setInterval(() => { void load(); void fetchFrame(); }, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, job?.status]);

  // feature/cua-live-view — keep the "Xs ago" freshness label honest while
  // a frame is showing. Re-render only; no fetching. Deps deliberately use
  // job?.status (not the job object, whose identity changes every load()).
  useEffect(() => {
    if (!liveFrame) return;
    if (isTerminalJobStatus(job?.status)) return;
    const t = setInterval(() => setFrameTick((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, [liveFrame, job?.status]);

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

  // feature/cua-live-view — frame age in seconds (clamped at 0 to absorb
  // small client/storage clock skew); null when unknown. frameTick keeps
  // it honest between frames.
  const frameAgeSec = useMemo(() => {
    if (!liveFrame?.updatedAt) return null;
    const ts = Date.parse(liveFrame.updatedAt);
    if (Number.isNaN(ts)) return null;
    return Math.max(0, Math.round((Date.now() - ts) / 1000));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveFrame, frameTick]);
  const frameIsFresh = frameAgeSec !== null && frameAgeSec <= 45;
  const frameAgeLabel = frameAgeSec === null
    ? ''
    : frameAgeSec < 8
      ? 'just now'
      : frameAgeSec < 60
        ? `${frameAgeSec}s ago`
        : `${Math.floor(frameAgeSec / 60)}m ago`;

  if (authLoading || !user) {
    return (
      <AppLayout>
        <DarkScope>
          <div style={{ padding: 60, textAlign: 'center' }}>
            <Loader2 size={24} className="spin" />
          </div>
        </DarkScope>
      </AppLayout>
    );
  }
  if (user.role !== 'admin') {
    return (
      <AppLayout>
        <DarkScope>
          <div style={{ padding: 80, textAlign: 'center' }}>
            <ShieldAlert size={32} color="var(--terracotta)" />
            <p style={{ fontFamily: FONT_SERIF, fontSize: 22, fontStyle: 'italic', marginTop: 12 }}>
              Admin access only.
            </p>
          </div>
        </DarkScope>
      </AppLayout>
    );
  }

  const costDollars = job ? (job.claude_cost_micros / 1_000_000).toFixed(2) : '0.00';
  const hotelName = property?.display_name ?? null;

  return (
    <AppLayout>
      <DarkScope>
        <SurfaceShell glow="forestTR" style={{ padding: '24px 48px 48px' }}>
          <div style={{ maxWidth: 1200, margin: '0 auto', fontFamily: FONT_SANS }}>
            {/* Back link */}
            <Link href="/admin/property-sessions" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.55),
              textDecoration: 'none', letterSpacing: '0.16em',
              textTransform: 'uppercase', marginBottom: 16,
            }}>
              <ArrowLeft size={12} /> Sessions
            </Link>

            <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap', marginBottom: 4 }}>
              <h1 style={{
                fontFamily: FONT_SERIF, fontSize: 32, fontWeight: 400,
                letterSpacing: '-0.02em', color: '#fff', margin: 0,
              }}>
                Learning {hotelName ? <span style={{ fontStyle: 'italic' }}>{hotelName}</span> : 'the hotel'}&rsquo;s PMS
              </h1>
              {property?.pms_family && <Pill tone="neutral">{property.pms_family}</Pill>}
              {job && (
                <Pill tone={
                  job.status === 'completed' ? 'forest' :
                  job.status === 'failed' ? 'terracotta' :
                  job.status === 'running' ? 'gold' : 'neutral'
                }>{job.status}</Pill>
              )}
            </div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.45), marginBottom: 20 }}>
              job {jobId.slice(0, 8)}… · ${costDollars} spent{job ? ` · attempt ${job.attempts}/${job.max_attempts}` : ''}
            </div>

            {error && (
              <div style={{
                marginBottom: 16, padding: '16px 20px', borderRadius: 14,
                background: 'var(--terracotta-dim)', border: '1px solid rgba(194,86,46,.4)',
              }}>
                <div style={{ color: 'var(--terracotta)', fontFamily: FONT_MONO, fontSize: 12 }}>
                  <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                  {error}
                </div>
              </div>
            )}

            {job?.error && (
              <DarkCard style={{ padding: '14px 20px', marginBottom: 16, border: '1px solid rgba(194,86,46,.4)' }}>
                <Caps c="var(--terracotta)">Run error</Caps>
                <div style={{
                  marginTop: 6, color: 'var(--terracotta)', fontFamily: FONT_MONO, fontSize: 11,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>{job.error.slice(0, 600)}</div>
              </DarkCard>
            )}

            {/* Summary strip */}
            {job && (
              <DarkCard style={{ padding: '18px 24px', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 24, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <SerifNum size={44} c="#fff">{summary.found}</SerifNum>
                    <span style={{ fontFamily: FONT_SERIF, fontSize: 20, fontStyle: 'italic', color: dimWhite(.66) }}>
                      of {summary.total} feeds found
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    {summary.stuck > 0 && <Pill tone="terracotta"><AlertTriangle size={11} /> {summary.stuck} needs your help</Pill>}
                    {searchingRow && <Pill tone="gold"><Loader2 size={11} style={{ animation: 'spin 1.5s linear infinite' }} /> searching: {searchingRow.label}</Pill>}
                    {summary.unavailable > 0 && <Pill tone="neutral">{summary.unavailable} not in this PMS</Pill>}
                    {summary.failed > 0 && <Pill tone="terracotta">{summary.failed} not found</Pill>}
                    {summary.waiting > 0 && !jobTerminal && <Pill tone="neutral">{summary.waiting} waiting</Pill>}
                  </div>
                </div>
              </DarkCard>
            )}

            {/* Per-feed board */}
            {job && feedRows.length > 0 && (
              <DarkCard style={{ padding: '10px 24px 14px', marginBottom: 16 }}>
                <div style={{ padding: '10px 0 4px' }}>
                  <Caps c={dimWhite(.5)}>Every feed, live</Caps>
                </div>
                {feedRows.map((row) => {
                  const meta = GLYPH_META[row.glyph];
                  const expandable = row.glyph === 'found' && Array.isArray(row.sample) && row.sample.length > 0;
                  const expanded = expandedFeeds.has(row.key);
                  const sampleCols = expandable ? Object.keys(row.sample![0] ?? {}) : [];
                  return (
                    <div key={row.key} style={{
                      borderTop: `1px solid ${dimWhite(.08)}`,
                      background: row.glyph === 'stuck' ? 'var(--terracotta-dim)' : 'transparent',
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
                          <span style={{ fontSize: 13.5, color: '#fff', fontWeight: row.glyph === 'stuck' ? 600 : 400 }}>
                            {row.label}
                          </span>
                          {row.optional && (
                            <span style={{ fontFamily: FONT_MONO, fontSize: 9.5, color: dimWhite(.45), marginLeft: 8, letterSpacing: '0.08em' }}>OPTIONAL</span>
                          )}
                          {row.glyph === 'failed' && row.reason && (
                            <span style={{ fontSize: 11.5, color: dimWhite(.5), marginLeft: 8 }} title={row.reason}>
                              — {row.reason.length > 90 ? `${row.reason.slice(0, 89)}…` : row.reason}
                            </span>
                          )}
                        </div>
                        {row.glyph === 'found' && typeof row.rowCount === 'number' && (
                          <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--forest-deep)' }}>
                            {row.rowCount} {row.rowCount === 1 ? 'row' : 'rows'} seen
                          </span>
                        )}
                        {row.glyph === 'found' && row.carried && (
                          <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: dimWhite(.45) }} title="Carried over from an earlier attempt or from the existing recipe (repair run)">carried</span>
                        )}
                        <Pill tone={meta.tone}>{meta.label}</Pill>
                        {expandable && (expanded
                          ? <ChevronDown size={14} color={dimWhite(.45)} />
                          : <ChevronRight size={14} color={dimWhite(.45)} />)}
                      </div>
                      {expandable && expanded && (
                        <div style={{ padding: '2px 0 12px 26px', overflowX: 'auto' }}>
                          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: dimWhite(.5), marginBottom: 6, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                            {row.sampleKind === 'records' ? 'Sample records it captured' : 'First rows it captured'}
                          </div>
                          <table style={{ borderCollapse: 'collapse', fontFamily: FONT_MONO, fontSize: 11 }}>
                            <thead>
                              <tr>
                                {sampleCols.map((c) => (
                                  <th key={c} style={{
                                    textAlign: 'left', padding: '3px 14px 3px 0', color: dimWhite(.5),
                                    fontWeight: 500, borderBottom: `1px solid ${dimWhite(.14)}`,
                                  }}>{c}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {row.sample!.map((r, i) => (
                                <tr key={i}>
                                  {sampleCols.map((c) => (
                                    <td key={c} style={{
                                      padding: '3px 14px 3px 0', color: dimWhite(.66),
                                      borderBottom: `1px solid ${dimWhite(.08)}`,
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
              </DarkCard>
            )}

            {/* Pending help-request panel — the point-and-click moment. */}
            {pendingHelp && pendingIsStale && (
              <DarkCard style={{ padding: '14px 20px', marginBottom: 16 }}>
                <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: dimWhite(.5) }}>
                  <CheckCircle2 size={14} style={{ verticalAlign: 'middle', marginRight: 6, color: 'var(--forest)' }} />
                  The robot already found “{pendingHelp.target_key}” — this old help request will clear itself. No action needed.
                </div>
              </DarkCard>
            )}
            {pendingHelp && !pendingIsStale && !jobTerminal && (
              <DarkCard style={{
                padding: '20px 24px', marginBottom: 16, border: '2px solid var(--terracotta)',
              }}>
                <Caps c="var(--terracotta)">It&rsquo;s stuck — show it where to go</Caps>
                <h2 style={{
                  fontFamily: FONT_SERIF, fontSize: 20, fontWeight: 400,
                  fontStyle: 'italic', margin: '4px 0 10px', color: '#fff',
                }}>{feedRows.find((r) => r.key === pendingHelp.target_key)?.label ?? pendingHelp.target_key}</h2>
                <p style={{ fontSize: 14, color: '#fff', marginBottom: 12 }}>
                  {pendingHelp.question}
                </p>
                {Array.isArray(pendingHelp.what_ive_tried) && pendingHelp.what_ive_tried.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <Caps c={dimWhite(.5)}>What it tried</Caps>
                    <ul style={{ fontSize: 13, color: dimWhite(.66), paddingLeft: 20, marginTop: 4 }}>
                      {pendingHelp.what_ive_tried.map((t, i) => <li key={i}>{t}</li>)}
                    </ul>
                  </div>
                )}
                {Array.isArray(pendingHelp.suggested_paths) && pendingHelp.suggested_paths.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <Caps c={dimWhite(.5)}>Its guesses</Caps>
                    <ul style={{ fontSize: 13, color: dimWhite(.66), paddingLeft: 20, marginTop: 4 }}>
                      {pendingHelp.suggested_paths.map((t, i) => <li key={i}>{t}</li>)}
                    </ul>
                  </div>
                )}

                {/* The robot's screen — click to teach. */}
                {pendingHelp.screenshotUrl ? (
                  <div style={{ margin: '14px 0 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <MousePointerClick size={14} color="var(--terracotta)" />
                      <span style={{ fontSize: 13, color: '#fff', fontWeight: 600 }}>
                        This is the robot&rsquo;s screen. Click exactly where it should click
                      </span>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.5) }}>
                        (passwords and payment details are blacked out automatically)
                      </span>
                    </div>
                    <div style={{
                      position: 'relative', display: 'inline-block', width: '100%',
                      maxWidth: 980, border: `1px solid ${dimWhite(.14)}`, borderRadius: 8,
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
                          border: '3px solid var(--terracotta)', background: 'rgba(194,86,46,0.3)',
                          boxShadow: '0 0 0 3px rgba(255,255,255,0.85)',
                        }} />
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                      <Btn
                        variant="forest"
                        onClick={() => marker && void submitAssist('takeover', guidanceText, marker ? { x: marker.x, y: marker.y } : undefined)}
                        disabled={submitting || !marker}
                      >
                        <MousePointerClick size={13} /> Send this click
                      </Btn>
                      {marker
                        ? <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.66) }}>will click at ({marker.x}, {marker.y})</span>
                        : <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.5) }}>click the screenshot first</span>}
                    </div>
                  </div>
                ) : (
                  <div style={{
                    margin: '12px 0', padding: 10, borderRadius: 6,
                    background: 'var(--terracotta-dim)', fontFamily: FONT_MONO, fontSize: 11, color: 'var(--terracotta)',
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
                    fontFamily: FONT_SANS, fontSize: 13, color: '#fff',
                    border: `1px solid ${dimWhite(.18)}`, borderRadius: 4,
                    marginBottom: 12, background: dimWhite(.06),
                  }}
                />

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Btn
                    variant="forest"
                    onClick={() => void submitAssist('guidance', guidanceText)}
                    disabled={submitting || !guidanceText.trim()}
                  >
                    <Send size={12} /> Send hint only
                  </Btn>
                  <Btn
                    variant="terracotta"
                    onClick={() => void submitAssist('unavailable', 'Skipping — admin marked unavailable.')}
                    disabled={submitting}
                  >
                    My PMS doesn&rsquo;t have this
                  </Btn>
                  <Btn
                    variant="ghost"
                    onClick={() => { if (confirm('Stop the whole learning run? You will still see what it found on this page, but a future run starts learning from scratch.')) void submitAssist('abort', 'Aborted by admin.'); }}
                    disabled={submitting}
                    style={{ color: '#fff', borderColor: dimWhite(.25) }}
                  >
                    Stop the whole run
                  </Btn>
                </div>
                <p style={{
                  fontFamily: FONT_MONO, fontSize: 10, color: dimWhite(.5),
                  marginTop: 8, lineHeight: 1.5,
                }}>
                  <strong>Send this click</strong> makes the robot click that exact spot, learn the page, and keep going.
                  <strong> Send hint only</strong> tells it what to try in words. <strong>My PMS doesn&rsquo;t have this</strong> skips just this feed.
                </p>
              </DarkCard>
            )}

            {/* feature/cua-live-view — the robot's screen, continuously.
                Subsumes the old "working on its own" placeholder card.
                Hidden while an ACTIONABLE help request is open: the help
                panel above already shows the robot's (frozen) screen, and
                stacking two near-identical screenshots would be confusing.
                NOT clickable — click-to-teach stays on the help panel. */}
            {(!pendingHelp || pendingIsStale) && job?.status === 'running' && (
              <DarkCard style={{ padding: '16px 20px', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <Caps c={dimWhite(.5)}>Robot&rsquo;s screen</Caps>
                  {liveFrame && (
                    frameIsFresh
                      ? <Pill tone="forest"><span style={{
                          display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                          background: 'currentColor', marginRight: 2,
                        }} /> LIVE</Pill>
                      : <Pill tone="neutral">{frameAgeLabel ? `as of ${frameAgeLabel}` : 'paused'}</Pill>
                  )}
                  {liveFrame && frameIsFresh && frameAgeLabel && (
                    <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.45) }}>
                      updated {frameAgeLabel}
                    </span>
                  )}
                </div>
                {liveFrame ? (
                  <>
                    <div style={{
                      marginTop: 10, width: '100%', maxWidth: 980,
                      border: `1px solid ${dimWhite(.14)}`, borderRadius: 8,
                      overflow: 'hidden', lineHeight: 0,
                    }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={liveFrame.url}
                        alt="The robot's current screen, updating live (sensitive fields redacted)"
                        style={{ width: '100%', height: 'auto', display: 'block' }}
                      />
                    </div>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.5), marginTop: 8 }}>
                      {frameIsFresh
                        ? 'This is what the robot sees right now — it updates with every step. (Passwords and payment details are blacked out automatically.)'
                        : 'Paused — the robot is thinking. The picture updates with its next step. (Passwords and payment details are blacked out automatically.)'}
                    </div>
                  </>
                ) : (
                  <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: dimWhite(.5), marginTop: 8 }}>
                    The robot&rsquo;s screen appears here as it works — the first picture can take a
                    minute while it thinks.
                  </div>
                )}
                <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: dimWhite(.5), marginTop: 10 }}>
                  <CheckCircle2 size={14} style={{ verticalAlign: 'middle', marginRight: 6, color: 'var(--forest)' }} />
                  The robot is working on its own. If it gets stuck, the feed turns red here and it waits for your click.
                </div>
              </DarkCard>
            )}

            {/* Activity feed */}
            <DarkCard style={{ padding: '16px 20px' }}>
              <Caps c={dimWhite(.5)}>Activity</Caps>
              <div
                ref={activityRef}
                style={{
                  fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.66),
                  lineHeight: 1.7, marginTop: 8, maxHeight: 300,
                  overflowY: 'auto', background: 'rgba(0,0,0,.3)',
                  padding: 12, borderRadius: 4,
                }}
              >
                {activity.length === 0
                  ? <div style={{ color: dimWhite(.45) }}>Waiting for events…</div>
                  : activity.map((evt, i) => (
                      <div key={i}>
                        <span style={{ color: dimWhite(.45) }}>{new Date(evt.at).toLocaleTimeString()}</span>
                        {' '}
                        <span style={{ color: 'var(--gold)' }}>[{evt.type}]</span>
                        {' '}
                        {evt.label ?? ''}
                        {typeof evt.pct === 'number' ? ` (${evt.pct}%)` : ''}
                      </div>
                    ))}
              </div>
            </DarkCard>

            {/* Recent help-request history */}
            {recentHelp.length > 0 && (
              <DarkCard style={{ padding: '16px 20px', marginTop: 16 }}>
                <Caps c={dimWhite(.5)}>Recent help requests</Caps>
                <div style={{ marginTop: 8 }}>
                  {recentHelp.map((h) => (
                    <div key={h.id} style={{
                      display: 'flex', gap: 12, alignItems: 'baseline',
                      padding: '6px 0', borderTop: `1px solid ${dimWhite(.14)}`,
                    }}>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: dimWhite(.45), width: 80 }}>
                        {new Date(h.created_at).toLocaleTimeString()}
                      </span>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.66), flex: 1 }}>
                        {h.target_key}
                      </span>
                      <Pill tone={
                        h.status === 'answered' && h.action_type === 'takeover' ? 'forest' :
                        h.status === 'answered' && h.action_type === 'guidance' ? 'forest' :
                        h.status === 'answered' ? 'gold' :
                        h.status === 'pending' ? 'gold' :
                        'neutral'
                      }>{h.action_type ?? h.status}</Pill>
                    </div>
                  ))}
                </div>
              </DarkCard>
            )}

            <style>{`@keyframes spin { to { transform: rotate(360deg) } } .spin { animation: spin 1s linear infinite }`}</style>
          </div>
        </SurfaceShell>
      </DarkScope>
    </AppLayout>
  );
}
