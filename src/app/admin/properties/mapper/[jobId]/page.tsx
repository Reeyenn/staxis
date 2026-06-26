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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  deriveFeedRows, summarizeFeedRows, isTerminalJobStatus, prettifyTargetKey,
  parseCurrentActivity, phaseLabel, isInProgressPhase, parseThoughts,
  type FeedRow, type AgentThought,
} from '@/lib/pms/learning-board';
import { REQUIRED_ACTION_KEYS } from '@/lib/pms/recipe-coverage';
import { LiveRobotView } from '@/app/admin/_components/cua/LiveRobotView';
import { FeedCaptureView, type CaptureState } from '@/app/admin/_components/cua/FeedCaptureView';
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

/** feature/cua-live-assist — the open founder-takeover session for this job
 *  (from GET /api/admin/mapper/live/[jobId]). */
interface TakeoverState {
  id: string;
  status: 'requested' | 'active' | 'ended';
  target_key: string | null;
  frame_seq: number;
  viewport_w: number;
  viewport_h: number;
  command_seq: number;
  applied_command_seq: number;
  started_at: string | null;
  /** Signed URL for the click-target frame ({jobId}/takeover.png); null until
   *  the robot has published one. */
  frameUrl: string | null;
}

/** The takeover click-target frame currently PAINTED, stamped with the
 *  frame_seq it was loaded at — the "Send click" gate compares this against
 *  the live row's frame_seq so a click can't be sent against a stale image. */
interface TakeoverFrame { url: string; frameSeq: number; }

/** feature/cua-live-assist — draft-map summary for Save & Finish / Discard. */
interface DraftMap {
  id: string;
  version: number;
  status: string;
  pmsFamily: string;
  actionsFound: number;
  missingRequired: string[];
  missingBusinessCritical: string[];
  /** Per-feed review summary (additive; older runs/routes omit it → undefined,
   *  and the Review panel simply doesn't render). NO selectors — counts only. */
  actionDetails?: Array<{
    key: string;
    label: string;
    status: 'found' | 'missing';
    rowCount?: number | null;
    columnCount: number;
    /** How the robot reads this feed: 'csv' (downloaded report) | 'table'
     *  (scraped HTML) | 'api' | 'inline_text'. Drives the CSV/Table pill.
     *  Additive — undefined on older runs (pill simply absent). */
    parseMode?: string | null;
  }>;
}

/** feature/cua-report-handling — best-class verification telemetry for the
 *  completion card. Additive: older runs/maps omit it → the card falls back to
 *  the plain feed count with no confidence score. NO selectors — telemetry only. */
interface Verification {
  score: number | null;
  threshold: number | null;
  consistentPasses: number | null;
  requiredPasses: number | null;
  enforced: boolean | null;
  signals: Record<string, string> | null;
}

/** Per-feed "Learned columns" fetch state (lazy — populated on first expand). */
interface FeedDetailState {
  loading: boolean;
  columns: Record<string, string>;
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

/**
 * The LEARNED COLUMNS the mapper recorded for one feed (field → selector),
 * fetched from GET /api/admin/mapper/feed-detail and shown UNDER the source
 * screenshot in an expanded feed. Read-only review: lets the founder confirm
 * the robot is reading the right fields before going live. Degrades to a calm
 * empty state when the run learned no columns for this feed (e.g. an api/csv
 * feed, or one not yet captured).
 */
function LearnedColumnsView({ state }: { state?: FeedDetailState }) {
  const cols = state ? Object.entries(state.columns) : [];
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{
        fontFamily: FONT_MONO, fontSize: 10, color: dimWhite(.5),
        letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 6,
      }}>
        Learned columns
      </div>
      {!state || state.loading ? (
        <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.4), display: 'flex', alignItems: 'center', gap: 6 }}>
          <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> Loading the columns…
        </div>
      ) : cols.length === 0 ? (
        <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.4) }}>
          No named columns learned for this feed.
        </div>
      ) : (
        <table style={{ borderCollapse: 'collapse', fontFamily: FONT_MONO, fontSize: 11 }}>
          <tbody>
            {cols.map(([field, selector]) => (
              <tr key={field}>
                <td style={{
                  padding: '3px 16px 3px 0', color: '#fff', whiteSpace: 'nowrap',
                  borderBottom: `1px solid ${dimWhite(.08)}`, verticalAlign: 'top',
                }}>{field}</td>
                <td style={{
                  padding: '3px 0', color: dimWhite(.55), borderBottom: `1px solid ${dimWhite(.08)}`,
                  maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }} title={selector}>{selector}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * 2FA code box on the live watch page (feature/cua-polish).
 *
 * Surfaces the SAME manual-2FA path the Launch Bay already uses — it posts to
 * the existing POST /api/admin/pms-auth-code (which drops the code into the
 * pms_auth_codes table the robot's fetchLatestAuthCode() poller claims). No
 * new route, table, or status: this is purely a second surface for the one
 * 2FA mechanism. Shown only while the worker flags the job awaiting_2fa.
 */
function LiveMfaBox({ propertyId, sinceIso }: { propertyId: string; sinceIso: string | null }) {
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
    <DarkCard style={{ padding: '20px 24px', marginBottom: 16, border: '2px solid var(--gold)' }}>
      <Caps c="var(--gold)">Waiting on a 2FA code</Caps>
      <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: '#fff', margin: '6px 0 12px' }}>
        The PMS sent a verification code{sinceIso ? ` (sent ${new Date(sinceIso).toLocaleTimeString()})` : ''}.
        If it went to your phone, type it here and the robot enters it within a few seconds.
        Emailed codes are read automatically — you can ignore this if one lands.
      </p>
      <div style={{ display: 'flex', gap: 8, maxWidth: 440 }}>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void send(); }}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="Code from your phone"
          maxLength={10}
          style={{
            flex: 1, minWidth: 0, fontFamily: FONT_MONO, fontSize: 14, letterSpacing: '.18em',
            padding: '9px 12px', background: 'rgba(0,0,0,.3)', color: '#fff',
            border: `1px solid ${dimWhite(.3)}`, borderRadius: 8, outline: 'none',
          }}
        />
        <Btn
          variant="ghost"
          onClick={() => void send()}
          disabled={busy || code.trim() === ''}
          style={{ color: 'var(--gold)', borderColor: 'rgba(201,154,46,.5)', background: 'rgba(201,154,46,.12)' }}
        >
          {busy ? '…' : 'Send to robot'}
        </Btn>
      </div>
      {note && (
        <div style={{ fontFamily: FONT_MONO, fontSize: 11.5, marginTop: 7, color: note.tone === 'ok' ? 'var(--forest)' : 'var(--terracotta)' }}>
          {note.text}
        </div>
      )}
    </DarkCard>
  );
}

export default function LiveMappingPage() {
  const { user, loading: authLoading } = useAuth();
  const params = useParams();
  const jobId = (Array.isArray(params?.jobId) ? params?.jobId[0] : params?.jobId) ?? '';

  const [job, setJob] = useState<WorkflowJobRow | null>(null);
  const [property, setProperty] = useState<PropertyInfo | null>(null);
  // feature/cua-polish — worker-set awaiting-2FA signal (workflow_jobs.result),
  // surfaced by GET /api/admin/mapper/live/[jobId]. Drives the 2FA code box.
  const [awaiting2fa, setAwaiting2fa] = useState(false);
  const [awaiting2faSince, setAwaiting2faSince] = useState<string | null>(null);
  const [pendingHelp, setPendingHelp] = useState<HelpRequestRow | null>(null);
  const [recentHelp, setRecentHelp] = useState<HelpRequestRow[]>([]);
  const [activity, setActivity] = useState<MappingEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [guidanceText, setGuidanceText] = useState('');
  // feature/cua-operator-notes — leave the running robot a nudge.
  const [noteText, setNoteText] = useState('');
  const [noteSending, setNoteSending] = useState(false);
  const [sentNotes, setSentNotes] = useState<Array<{ at: string; text: string }>>([]);
  const [marker, setMarker] = useState<ClickMarker | null>(null);
  const [expandedFeeds, setExpandedFeeds] = useState<Set<string>>(new Set());
  // feature/cua-live-assist — founder takeover + save/discard.
  const [takeover, setTakeover] = useState<TakeoverState | null>(null);
  const [takeoverFrame, setTakeoverFrame] = useState<TakeoverFrame | null>(null);
  const [takeoverMarker, setTakeoverMarker] = useState<ClickMarker | null>(null);
  const [takeoverBusy, setTakeoverBusy] = useState(false);
  const [draftMap, setDraftMap] = useState<DraftMap | null>(null);
  // feature/cua-report-handling — best-class verification telemetry for the
  // completion card. Additive (null on older runs).
  const [verification, setVerification] = useState<Verification | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'discarding' | 'discarded'>('idle');
  // Guards the takeover-frame preload (latest-wins; never commit an older seq).
  const takeoverFrameSeqRef = useRef(0);
  const takeoverFrameBusyRef = useRef(false);

  // feature/cua-admin-mapper-visibility — per-feed SOURCE screenshots on the
  // live board, lazily fetched when a found feed is expanded (mirrors the
  // Coverage Editor). Job-scoped: the capture from THIS run.
  const [captures, setCaptures] = useState<Record<string, CaptureState>>({});
  const captureReqRef = useRef<Set<string>>(new Set());

  // Per-feed LEARNED COLUMNS (field → selector), lazily fetched when a found
  // feed is expanded (GET /api/admin/mapper/feed-detail). Shown under the
  // source screenshot for at-a-glance review before going live.
  const [feedDetails, setFeedDetails] = useState<Record<string, FeedDetailState>>({});
  const feedDetailReqRef = useRef<Set<string>>(new Set());
  // Per-feed REMOVE-from-draft in flight (B4). Confirmation modal for Save (B5).
  const [removingFeed, setRemovingFeed] = useState<string | null>(null);
  const [confirmSave, setConfirmSave] = useState(false);

  const activityRef = useRef<HTMLDivElement>(null);
  const thoughtsRef = useRef<HTMLDivElement>(null);
  const loadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // feature/cua-live-assist — preload the takeover click-target frame, then
  // commit it only when its frame_seq advances (latest-wins). The "Send click"
  // gate compares the PAINTED frame's seq to the live row's, so committing on
  // load (not on every signed-URL rotation) keeps the founder clicking a frame
  // the robot still considers current. Clears the marker on a new frame.
  const preloadTakeoverFrame = async (t: TakeoverState) => {
    if (!t.frameUrl || t.frame_seq <= takeoverFrameSeqRef.current) return;
    if (takeoverFrameBusyRef.current) return;
    takeoverFrameBusyRef.current = true;
    const seq = t.frame_seq;
    const url = t.frameUrl;
    try {
      await new Promise<void>((resolve) => {
        const img = new window.Image();
        img.onload = () => {
          if (seq > takeoverFrameSeqRef.current) {
            takeoverFrameSeqRef.current = seq;
            setTakeoverFrame({ url, frameSeq: seq });
            setTakeoverMarker(null);
          }
          resolve();
        };
        img.onerror = () => resolve();
        img.src = url;
      });
    } finally {
      takeoverFrameBusyRef.current = false;
    }
  };

  // Initial fetch of state.
  const load = async () => {
    try {
      const res = await fetchWithAuth(`/api/admin/mapper/live/${jobId}`);
      const json = await res.json();
      if (json.ok) {
        setJob(json.data.job);
        setProperty(json.data.property ?? null);
        setAwaiting2fa(Boolean(json.data.awaiting2fa));
        setAwaiting2faSince((json.data.awaiting2faSince as string | null) ?? null);
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
        // feature/cua-live-assist — takeover session + draft-map summary.
        const t = (json.data.takeover ?? null) as TakeoverState | null;
        setTakeover(t);
        setDraftMap((json.data.draftMap ?? null) as DraftMap | null);
        setVerification((json.data.verification ?? null) as Verification | null);
        if (!t || t.status === 'ended') {
          takeoverFrameSeqRef.current = 0;
          setTakeoverFrame(null);
        } else {
          void preloadTakeoverFrame(t);
        }
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
  //
  // The robot's live SCREEN (frame fetch + both heartbeats + the live_frame
  // broadcast) now lives entirely in <LiveRobotView>, which is mounted below
  // and self-drives. The board keeps the feed-board / help / takeover state.
  useEffect(() => {
    if (!jobId) return;
    void load();
    return () => {
      if (loadDebounceRef.current) clearTimeout(loadDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

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
        // (that's 4 DB queries per event). <LiveRobotView> owns the frame on
        // its own channel; here we just swallow it.
        if (msg.event === 'live_frame' || msg.payload?.type === 'live_frame') {
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
    const t = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, job?.status]);

  // feature/cua-admin-mapper-visibility — keep the live PHASE line moving.
  // currentActivity is durable (workflow_jobs.result), so load() on mount
  // already makes it survive a reload; broadcasts refresh it on every robot
  // step. This adds a gentle 5s poll WHILE the run is live so the phase + pct
  // also advance during long think-gaps that emit no broadcast. Strictly
  // bounded: paused when the tab is hidden (so a forgotten background tab adds
  // no DB load), skipped during a takeover (its own 2.5s poll owns the page),
  // and stopped the instant the job is terminal. The coarse 30s safety poll
  // above remains the floor for the hidden-tab / RLS-silent-channel cases.
  useEffect(() => {
    if (!jobId || job?.status !== 'running') return;
    if (takeover && takeover.status !== 'ended') return;
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const t = setInterval(tick, 5_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, job?.status, takeover?.status]);

  // feature/cua-live-assist — fast poll WHILE a takeover is open. Takeover is
  // turn-based (the founder clicks, the robot acts ~2-3s, publishes a fresh
  // frame); a 2.5s poll keeps the click-target frame + ack state snappy even if
  // a `takeover` broadcast drops. Only runs during the (rare) open takeover.
  useEffect(() => {
    if (!jobId || !takeover || takeover.status === 'ended') return;
    if (isTerminalJobStatus(job?.status)) return; // dead job → don't poll a dangling row
    const t = setInterval(() => { void load(); }, 2_500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, takeover?.status, takeover?.id, job?.status]);

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

  // feature/cua-operator-notes — POST a note; the worker folds it into the
  // robot's next step. Optimistically echo it so the founder sees it landed.
  const sendNote = async () => {
    const text = noteText.trim();
    if (!text || noteSending) return;
    setNoteSending(true);
    try {
      const res = await fetchWithAuth('/api/admin/mapper/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, note: text }),
      });
      const json = await res.json();
      if (json.ok) {
        setSentNotes((prev) => [...prev, { at: new Date().toISOString(), text }].slice(-20));
        setNoteText('');
      } else {
        alert(`Couldn’t send the note: ${json.error ?? 'unknown'}`);
      }
    } catch (e) {
      alert(`Couldn’t send the note: ${(e as Error).message}`);
    } finally {
      setNoteSending(false);
    }
  };

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

  // feature/cua-live-assist — founder takeover handlers.
  const onTakeoverFrameClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!takeover) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const vw = takeover.viewport_w ?? 1280;
    const vh = takeover.viewport_h ?? 800;
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    const x = Math.min(vw - 1, Math.max(0, Math.round(relX * vw)));
    const y = Math.min(vh - 1, Math.max(0, Math.round(relY * vh)));
    setTakeoverMarker({ x, y, leftPct: relX * 100, topPct: relY * 100 });
  };

  // intent='start' → pause the robot and drive; intent='skip' → abandon a feed
  // without taking over (targetKey scopes it so a stale skip can't eat the next).
  const startTakeover = async (intent: 'start' | 'skip', targetKey?: string) => {
    setTakeoverBusy(true);
    try {
      const res = await fetchWithAuth('/api/admin/mapper/takeover', {
        method: 'POST',
        body: JSON.stringify({ jobId, intent, ...(targetKey ? { targetKey } : {}) }),
      });
      const json = await res.json();
      if (!json.ok) alert(`Failed: ${json.error ?? 'unknown'}`);
      else if (json.data?.accepted === false && json.data?.reason === 'run_finished') {
        alert('This run already finished.');
      }
      void load();
    } catch (err) {
      alert(`Failed: ${(err as Error).message}`);
    } finally {
      setTakeoverBusy(false);
    }
  };

  const sendTakeoverCommand = async (
    command: 'click' | 'finish' | 'cancel',
    coordinate?: { x: number; y: number },
    frameSeq?: number,
  ) => {
    setTakeoverBusy(true);
    try {
      const res = await fetchWithAuth('/api/admin/mapper/takeover-command', {
        method: 'POST',
        body: JSON.stringify({
          jobId, command,
          ...(coordinate ? { coordinate } : {}),
          ...(typeof frameSeq === 'number' ? { frameSeq } : {}),
        }),
      });
      const json = await res.json();
      if (!json.ok) alert(`Failed: ${json.error ?? 'unknown'}`);
      // Clear the marker on ANY click attempt (accepted or not): a rejected
      // click's marker sits on a now-stale frame and must not be re-sendable.
      if (command === 'click') setTakeoverMarker(null);
      void load();
    } catch (err) {
      alert(`Failed: ${(err as Error).message}`);
    } finally {
      setTakeoverBusy(false);
    }
  };

  const saveMap = async () => {
    setSaveState('saving');
    try {
      const res = await fetchWithAuth('/api/admin/mapper/save-map', { method: 'POST', body: JSON.stringify({ jobId }) });
      const json = await res.json();
      if (!json.ok) { alert(`Couldn’t make it live: ${json.error ?? 'unknown'}`); setSaveState('idle'); return; }
      setSaveState('saved');
      void load();
    } catch (err) {
      alert(`Couldn’t make it live: ${(err as Error).message}`); setSaveState('idle');
    }
  };

  const discardMap = async () => {
    if (!confirm('Throw this learned map away? It will NOT go live, and a future run starts learning from scratch.')) return;
    setSaveState('discarding');
    try {
      const res = await fetchWithAuth('/api/admin/mapper/discard-map', { method: 'POST', body: JSON.stringify({ jobId }) });
      const json = await res.json();
      if (!json.ok) { alert(`Couldn’t discard: ${json.error ?? 'unknown'}`); setSaveState('idle'); return; }
      setSaveState('discarded');
      void load();
    } catch (err) {
      alert(`Couldn’t discard: ${(err as Error).message}`); setSaveState('idle');
    }
  };

  const toggleFeed = (key: string) => {
    setExpandedFeeds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Lazy-fetch the source screenshot for one feed (called when it's expanded).
  // Job-scoped → the capture from THIS run. Failures land as url:null (the empty
  // state) and stay retryable.
  const ensureCapture = useCallback(async (capKey: string) => {
    if (captureReqRef.current.has(capKey)) return;
    captureReqRef.current.add(capKey);
    setCaptures((prev) => ({ ...prev, [capKey]: { loading: true, url: null } }));
    let url: string | null = null;
    try {
      const res = await fetchWithAuth(
        `/api/admin/mapper/feed-capture?jobId=${encodeURIComponent(jobId)}&feedKey=${encodeURIComponent(capKey)}`,
      );
      const json = await res.json();
      if (res.ok && json.ok && typeof json.data?.url === 'string') url = json.data.url;
    } catch {
      url = null;
    }
    setCaptures((prev) => ({ ...prev, [capKey]: { loading: false, url } }));
    if (!url) captureReqRef.current.delete(capKey); // no capture (yet) → let it retry
  }, [jobId]);

  // A stale/broken signed URL falls back to the empty state and frees the key
  // so a re-expand refetches a fresh URL.
  const handleCaptureError = useCallback((capKey: string) => {
    captureReqRef.current.delete(capKey);
    setCaptures((prev) => ({ ...prev, [capKey]: { loading: false, url: null } }));
  }, []);

  // Lazy-fetch the LEARNED COLUMNS for one feed (called when it's expanded).
  // The route is graceful (always ok), so an empty map is the empty state.
  const ensureFeedDetail = useCallback(async (feedKey: string) => {
    if (feedDetailReqRef.current.has(feedKey)) return;
    feedDetailReqRef.current.add(feedKey);
    setFeedDetails((prev) => ({ ...prev, [feedKey]: { loading: true, columns: {} } }));
    let columns: Record<string, string> = {};
    try {
      const res = await fetchWithAuth(
        `/api/admin/mapper/feed-detail?jobId=${encodeURIComponent(jobId)}&feedKey=${encodeURIComponent(feedKey)}`,
      );
      const json = await res.json();
      if (res.ok && json.ok && json.data?.columns && typeof json.data.columns === 'object') {
        columns = json.data.columns as Record<string, string>;
      }
    } catch {
      columns = {};
    }
    setFeedDetails((prev) => ({ ...prev, [feedKey]: { loading: false, columns } }));
    // No columns (yet) → let a re-expand retry (mirrors ensureCapture).
    if (Object.keys(columns).length === 0) feedDetailReqRef.current.delete(feedKey);
  }, [jobId]);

  // B4 — remove a non-required FOUND feed from the DRAFT before it goes live.
  // On success, refetch the whole board so the row drops + the review counts
  // update. The route owns the safety refusals (required / would-empty / live).
  const removeFeed = useCallback(async (feedKey: string, label: string) => {
    if (!confirm(`Remove “${label}” from this map? It won’t be carried into the live recipe. You can re-run it later.`)) return;
    setRemovingFeed(feedKey);
    try {
      const res = await fetchWithAuth('/api/admin/mapper/draft/delete-feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, feedKey }),
      });
      const json = await res.json();
      if (!json.ok) { alert(json.error ?? 'Could not remove this feed.'); return; }
      // Clear any cached column/capture state for the removed feed.
      feedDetailReqRef.current.delete(feedKey);
      captureReqRef.current.delete(feedKey);
      await load();
    } catch (err) {
      alert(`Could not remove this feed: ${(err as Error).message}`);
    } finally {
      setRemovingFeed(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const feedRows = useMemo(() => deriveFeedRows({
    catalog: job?.result?.targetCatalog,
    boardTargets: job?.result?.boardTargets,
    actionsSoFar: job?.result?.actionsSoFar,
    pendingHelpTargetKey: pendingHelp?.target_key ?? null,
    jobStatus: job?.status,
  }), [job, pendingHelp]);
  const summary = useMemo(() => summarizeFeedRows(feedRows), [feedRows]);
  const searchingRow = feedRows.find((r) => r.glyph === 'searching');
  // feature/cua-report-handling — per-feed read-mode (csv/table/…) keyed by
  // feed key, from the draft's actionDetails. Drives the "CSV"/"Table" pill so
  // the report-handling CSV path is visible on the board. Empty until the run
  // finishes (actionDetails is a completed-run summary).
  const parseModeByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of draftMap?.actionDetails ?? []) {
      if (d.parseMode) m.set(d.key, d.parseMode);
    }
    return m;
  }, [draftMap]);

  // feature/cua-mapper-cost — the durable result.currentActivity, still read
  // here for the live spend total (the live PHASE line moved to <LiveRobotView>).
  const currentActivity = useMemo(() => parseCurrentActivity(job?.result), [job]);
  // feature/cua-operator-notes — the robot's live reasoning log.
  const thoughts = useMemo<AgentThought[]>(() => parseThoughts(job?.result), [job]);
  // Auto-scroll the thinking log to the newest line (declared here so `thoughts`
  // is in scope before the effect references it — runs before the early returns).
  useEffect(() => {
    if (thoughtsRef.current) {
      thoughtsRef.current.scrollTop = thoughtsRef.current.scrollHeight;
    }
  }, [thoughts.length]);
  // INVARIANT guard for the panel too: a pending row whose target is
  // already found (stale after a worker restart) must not show a live
  // clickable panel — the robot is not listening on it.
  const pendingIsStale = Boolean(
    pendingHelp && feedRows.some((r) => r.key === pendingHelp.target_key && r.glyph === 'found'),
  );
  const jobTerminal = isTerminalJobStatus(job?.status);

  // feature/cua-live-assist — takeover derived state.
  const takeoverActive = takeover?.status === 'active';
  const takeoverPending = takeover?.status === 'requested';
  // Robot has acked the last command (idle, ready for the next click).
  const robotIdle = !!takeover && takeover.applied_command_seq === takeover.command_seq;
  // The painted click-target frame matches the row the robot is on now.
  const takeoverFrameFresh = !!takeover && !!takeoverFrame && takeoverFrame.frameSeq === takeover.frame_seq;
  // "Send this click" is allowed only mid-turn-gap, against a current frame.
  const canSendClick = takeoverActive && robotIdle && takeoverFrameFresh && !takeoverBusy && !!takeoverMarker;
  // Drill-down feeds (getGuests etc.) run through mapDrillDownAction, which has
  // no takeover gate in v1 — so Take over / Skip are not offered for them (the
  // robot would never pick the request up, leaving the board stuck "Pausing…").
  const drilldownKeys = useMemo(() => {
    const catalog = (job?.result?.targetCatalog ?? []) as Array<{ key?: string; classification?: string }>;
    return new Set(catalog.filter((d) => d.classification === 'drilldown_sample').map((d) => d.key));
  }, [job]);
  const searchingTakeoverable = !!searchingRow && !drilldownKeys.has(searchingRow.key);
  // Offer "Take over" only when a takeover-able feed is actively searching
  // (never a dead button during login / between feeds) and nothing else owns
  // the screen.
  const canStartTakeover = job?.status === 'running' && searchingTakeoverable && !takeover &&
    (!pendingHelp || pendingIsStale);

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

  // feature/cua-mapper-cost — live spend: currentActivity.totalCostMicros ticks
  // during the run (job.claude_cost_micros is only written at completion); fall
  // back to the job's final total once the run ends and currentActivity clears.
  const liveCostMicros = currentActivity?.totalCostMicros ?? (job ? job.claude_cost_micros : null);
  const costDollars = liveCostMicros != null ? (liveCostMicros / 1_000_000).toFixed(2) : '0.00';
  const feedsCostMicros = feedRows.reduce((acc, r) => acc + (r.costMicros ?? 0), 0);
  const overheadCostMicros = liveCostMicros != null ? Math.max(0, liveCostMicros - feedsCostMicros) : null;
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
                    {/* fix/cua-discovery-budget — split FAILED by cause: budget (raise
                        the limit) vs findability (needs navigation help, not money). */}
                    {summary.budgetFailed > 0 && <Pill tone="terracotta">{summary.budgetFailed} ran out of budget</Pill>}
                    {summary.findabilityFailed > 0 && <Pill tone="terracotta">{summary.findabilityFailed} couldn’t be found</Pill>}
                    {(summary.partialFailed + summary.otherFailed) > 0 && <Pill tone="terracotta">{summary.partialFailed + summary.otherFailed} not finished</Pill>}
                    {summary.waiting > 0 && !jobTerminal && <Pill tone="neutral">{summary.waiting} waiting</Pill>}
                  </div>
                </div>
                {/* feature/cua-mapper-cost — spend breakdown (live during the run) */}
                {liveCostMicros != null && (
                  <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.55), marginTop: 12 }}>
                    Spent <span style={{ color: '#fff' }}>${(liveCostMicros / 1_000_000).toFixed(2)}</span> total
                    {' · '}${(feedsCostMicros / 1_000_000).toFixed(2)} on feeds
                    {overheadCostMicros != null && <>{' · '}${(overheadCostMicros / 1_000_000).toFixed(2)} setup &amp; navigation</>}
                  </div>
                )}
              </DarkCard>
            )}

            {/* feature/cua-polish — 2FA code box. Surfaces the existing manual-
                2FA path (POST /api/admin/pms-auth-code) right here on the watch
                page when the worker parks the robot on a verification screen.
                Hidden unless the job is flagged awaiting_2fa and still live. */}
            {awaiting2fa && !jobTerminal && job?.property_id && (
              <LiveMfaBox propertyId={job.property_id} sinceIso={awaiting2faSince} />
            )}

            {/* feature/cua-live-assist — Save & Finish / Discard & Cancel when
                the run is done. No nag gate: the founder sees exactly what was
                learned (count + what's missing) and decides. */}
            {jobTerminal && draftMap && (
              <DarkCard style={{
                padding: '20px 24px', marginBottom: 16,
                border: `2px solid ${draftMap.status === 'active' || saveState === 'saved' ? 'var(--forest)' : dimWhite(.18)}`,
              }}>
                <Caps c={dimWhite(.5)}>This run is done — your call</Caps>
                {/* feature/cua-report-handling — completion verdict, built from
                    the best-class verification telemetry. The decision is
                    derived board-side from the draft's status (active/saved =
                    auto-promoted & live; anything else = parked for review),
                    annotated with the confidence score when the map carries it.
                    Degrades gracefully: no verification ⟹ a plain live / parked
                    line with no score. */}
                {(() => {
                  const live = draftMap.status === 'active' || saveState === 'saved';
                  const score = verification?.score;
                  const scoreStr = typeof score === 'number' ? score.toFixed(2) : null;
                  return (
                    <div style={{
                      margin: '8px 0 12px', padding: '10px 14px', borderRadius: 8,
                      background: live ? 'rgba(74,124,89,.14)' : 'rgba(255,255,255,.05)',
                      border: `1px solid ${live ? 'rgba(74,124,89,.4)' : dimWhite(.14)}`,
                      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                    }}>
                      {live
                        ? <CheckCircle2 size={16} color="var(--forest)" style={{ flexShrink: 0 }} />
                        : <AlertTriangle size={16} color="var(--gold)" style={{ flexShrink: 0 }} />}
                      <span style={{ fontFamily: FONT_SANS, fontSize: 14, color: '#fff' }}>
                        {live ? (
                          <>Auto-promoted{scoreStr ? <> <span style={{ fontFamily: FONT_MONO, color: 'var(--forest)' }}>({scoreStr})</span></> : ''} — <strong>live</strong></>
                        ) : (
                          <>Parked{scoreStr ? <> — confidence <span style={{ fontFamily: FONT_MONO, color: 'var(--gold)' }}>{scoreStr}</span></> : ''}, review in <strong>Manage maps</strong></>
                        )}
                      </span>
                      {typeof verification?.threshold === 'number' && scoreStr && (
                        <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.5) }}>
                          bar {verification.threshold.toFixed(2)}
                        </span>
                      )}
                      {typeof verification?.consistentPasses === 'number' && typeof verification?.requiredPasses === 'number' && (
                        <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.5) }}>
                          · {verification.consistentPasses}/{verification.requiredPasses} consistent passes
                        </span>
                      )}
                    </div>
                  );
                })()}
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', margin: '6px 0 10px' }}>
                  <span style={{ fontFamily: FONT_SERIF, fontSize: 20, fontStyle: 'italic', color: '#fff' }}>
                    {draftMap.actionsFound} {draftMap.actionsFound === 1 ? 'feed' : 'feeds'} learned
                  </span>
                  {draftMap.status === 'active' || saveState === 'saved'
                    ? <Pill tone="forest"><CheckCircle2 size={11} /> Live now</Pill>
                    : <Pill tone="neutral">version {draftMap.version} · {draftMap.status}</Pill>}
                </div>
                {(draftMap.missingRequired.length > 0 || draftMap.missingBusinessCritical.length > 0) && (
                  <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.6), marginBottom: 12 }}>
                    Not captured: {[...draftMap.missingRequired, ...draftMap.missingBusinessCritical].map((t) => prettifyTargetKey(t)).join(', ')}
                  </div>
                )}
                {draftMap.status === 'active' || saveState === 'saved' ? (
                  <div>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: 'var(--forest)' }}>
                      <CheckCircle2 size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                      It&rsquo;s live — this hotel&rsquo;s robot is starting to use it. It shows in the PMS coverage list.
                    </div>
                    {/* B5 — jump to the Coverage Editor for this hotel to tweak
                        the now-live map feed-by-feed. job.property_id is the
                        representative property the editor is keyed on. */}
                    {job?.property_id && (
                      <div style={{ marginTop: 12 }}>
                        <Btn
                          variant="ghost" size="sm"
                          href={`/admin/properties/coverage/${job.property_id}`}
                          style={{ color: 'var(--forest)', borderColor: 'rgba(74,124,89,.45)' }}
                        >
                          Open the Coverage Editor →
                        </Btn>
                      </div>
                    )}
                  </div>
                ) : saveState === 'discarded' ? (
                  <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: dimWhite(.6) }}>
                    Thrown away. A future run starts learning from scratch.
                  </div>
                ) : (
                  <>
                    {/* B2 — Review before going live: each feed + its row /
                        column counts, and which required feeds are still
                        missing. From draftMap.actionDetails (additive; older
                        runs omit it → the panel is simply skipped). */}
                    {draftMap.actionDetails && draftMap.actionDetails.length > 0 && (
                      <div style={{
                        border: `1px solid ${dimWhite(.12)}`, borderRadius: 8,
                        padding: '10px 14px', marginBottom: 14,
                      }}>
                        <Caps c={dimWhite(.5)}>Review before going live</Caps>
                        <div style={{ marginTop: 8 }}>
                          {draftMap.actionDetails.map((d) => (
                            <div key={d.key} style={{
                              display: 'flex', alignItems: 'center', gap: 10,
                              padding: '5px 0', borderTop: `1px solid ${dimWhite(.06)}`,
                            }}>
                              {d.status === 'missing'
                                ? <AlertTriangle size={13} color="var(--terracotta)" />
                                : <CheckCircle2 size={13} color="var(--forest)" />}
                              <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: d.status === 'missing' ? dimWhite(.6) : '#fff' }}>
                                {d.label}
                                {REQUIRED_ACTION_KEYS.has(d.key) && (
                                  <span style={{ fontFamily: FONT_MONO, fontSize: 9.5, color: dimWhite(.45), marginLeft: 8, letterSpacing: '0.08em' }}>REQUIRED</span>
                                )}
                              </span>
                              {d.status === 'missing' ? (
                                <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: 'var(--terracotta)' }}>missing</span>
                              ) : (
                                <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.55) }}>
                                  {typeof d.rowCount === 'number' ? `${d.rowCount} ${d.rowCount === 1 ? 'row' : 'rows'} · ` : ''}
                                  {d.columnCount} {d.columnCount === 1 ? 'column' : 'columns'}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Btn variant="forest" onClick={() => setConfirmSave(true)} disabled={saveState === 'saving' || saveState === 'discarding'}>
                        <CheckCircle2 size={13} /> {saveState === 'saving' ? 'Making it live…' : 'Save & Finish — make this live'}
                      </Btn>
                      <Btn variant="terracotta" onClick={() => void discardMap()} disabled={saveState === 'saving' || saveState === 'discarding'}>
                        {saveState === 'discarding' ? 'Discarding…' : 'Discard & Cancel'}
                      </Btn>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.5) }}>
                        Save makes this the hotel&rsquo;s live PMS recipe. Discard throws it away.
                      </span>
                    </div>
                  </>
                )}

                {/* B5 — Save confirmation modal. Reuses saveMap() / POST
                    save-map (no route change). The founder confirms going live
                    after the review above. */}
                {confirmSave && (
                  <div style={{
                    position: 'fixed', inset: 0, zIndex: 1000,
                    background: 'rgba(0,0,0,.62)', display: 'flex',
                    alignItems: 'center', justifyContent: 'center', padding: 20,
                  }}>
                    <DarkCard style={{ padding: '22px 26px', maxWidth: 440, width: '100%', border: '2px solid var(--forest)' }}>
                      <Caps c="var(--forest)">Make this live?</Caps>
                      <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: '#fff', margin: '8px 0 6px' }}>
                        This makes the {draftMap.actionsFound}-feed map this hotel&rsquo;s live PMS recipe — the robot starts using it right away.
                      </p>
                      {draftMap.missingRequired.length > 0 && (
                        <p style={{ fontFamily: FONT_MONO, fontSize: 11, color: 'var(--terracotta)', margin: '0 0 8px' }}>
                          Heads up: {draftMap.missingRequired.map((t) => prettifyTargetKey(t)).join(', ')} {draftMap.missingRequired.length === 1 ? 'is' : 'are'} still missing.
                        </p>
                      )}
                      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                        <Btn
                          variant="forest"
                          onClick={() => { setConfirmSave(false); void saveMap(); }}
                          disabled={saveState === 'saving'}
                        >
                          <CheckCircle2 size={13} /> Yes, make it live
                        </Btn>
                        <Btn variant="ghost" onClick={() => setConfirmSave(false)} style={{ color: dimWhite(.7), borderColor: dimWhite(.2) }}>
                          Cancel
                        </Btn>
                      </div>
                    </DarkCard>
                  </div>
                )}
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
                  // Any found feed is expandable so the founder can open it to
                  // see the SOURCE screenshot under it — even when the row sample
                  // is empty (an empty departures page is still worth proving).
                  const hasSample = Array.isArray(row.sample) && row.sample.length > 0;
                  const expandable = row.glyph === 'found';
                  const expanded = expandedFeeds.has(row.key);
                  const sampleCols = hasSample ? Object.keys(row.sample![0] ?? {}) : [];
                  // feature/cua-mapper-cost — per-feed spend: final once done, or
                  // the active feed's running cost (live total − its start).
                  const rowCostMicros = row.costMicros != null
                    ? row.costMicros
                    : (row.glyph === 'searching' && row.startCostMicros != null && liveCostMicros != null
                        ? Math.max(0, liveCostMicros - row.startCostMicros)
                        : null);
                  return (
                    <div key={row.key} style={{
                      borderTop: `1px solid ${dimWhite(.08)}`,
                      background: row.glyph === 'stuck' ? 'var(--terracotta-dim)' : 'transparent',
                      margin: row.glyph === 'stuck' ? '0 -24px' : 0,
                      padding: row.glyph === 'stuck' ? '0 24px' : 0,
                    }}>
                      <div
                        onClick={expandable ? () => {
                          if (!expandedFeeds.has(row.key)) {
                            void ensureCapture(row.key);
                            void ensureFeedDetail(row.key);
                          }
                          toggleFeed(row.key);
                        } : undefined}
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
                          {/* feature/cua-admin-mapper-visibility — finer live
                              phase on the feed the robot is on now (the glyph
                              stays the coarse "Searching…"; this is the detail).
                              In-progress phases only — never contradict the
                              "Searching…" pill with a terminal-ish label. */}
                          {row.glyph === 'searching' && isInProgressPhase(row.phase) && (
                            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: 'var(--gold)', marginLeft: 8 }}>
                              · {phaseLabel(row.phase!)}
                            </span>
                          )}
                        </div>
                        {row.glyph === 'found' && typeof row.rowCount === 'number' && (
                          <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--forest-deep)' }}>
                            {row.rowCount} {row.rowCount === 1 ? 'row' : 'rows'} seen
                          </span>
                        )}
                        {/* feature/cua-mapper-cost — per-feed spend, on the side */}
                        {rowCostMicros != null && (
                          <span
                            style={{ fontFamily: FONT_MONO, fontSize: 11, color: row.glyph === 'searching' ? 'var(--gold)' : dimWhite(.55) }}
                            title={row.glyph === 'searching' ? 'Spent on this feed so far' : 'Spent learning this feed'}
                          >
                            ${(rowCostMicros / 1_000_000).toFixed(2)}{row.glyph === 'searching' ? '…' : ''}
                          </span>
                        )}
                        {row.glyph === 'found' && row.carried && (
                          <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: dimWhite(.45) }} title="Carried over from an earlier attempt or from the existing recipe (repair run)">carried</span>
                        )}
                        {/* feature/cua-report-handling — how the robot READS this
                            feed: a downloaded CSV report vs scraped HTML rows.
                            Makes the report-handling CSV path visible. Absent
                            until the run finishes (parseModeByKey is empty mid-run)
                            and for feeds the draft has no mode for. */}
                        {row.glyph === 'found' && parseModeByKey.has(row.key) && (() => {
                          const mode = parseModeByKey.get(row.key)!;
                          const isCsv = mode === 'csv';
                          const isTable = mode === 'table';
                          const label = isCsv ? 'CSV' : isTable ? 'Table' : mode.toUpperCase();
                          return (
                            <Pill tone={isCsv ? 'gold' : 'neutral'}>
                              <span title={isCsv ? 'The robot reads this feed from a downloaded CSV report' : isTable ? 'The robot reads this feed from on-screen table rows' : `Read mode: ${mode}`}>
                                {label}
                              </span>
                            </Pill>
                          );
                        })()}
                        <Pill tone={meta.tone}>{meta.label}</Pill>
                        {/* feature/cua-live-assist — skip this feed without
                            taking over (usable while it's searching; not for
                            drill-down feeds, which have no takeover gate). */}
                        {row.glyph === 'searching' && !jobTerminal && !takeover && !drilldownKeys.has(row.key) && (
                          <Btn
                            variant="ghost" size="sm"
                            onClick={() => void startTakeover('skip', row.key)}
                            disabled={takeoverBusy}
                            title="Stop working this feed and move to the next one"
                            style={{ color: dimWhite(.7), borderColor: dimWhite(.18) }}
                          >
                            Skip
                          </Btn>
                        )}
                        {/* B4 — Remove a non-required FOUND feed from the draft
                            before it goes live. Only on a finished run whose
                            draft isn't active yet; never on required feeds (the
                            route also refuses them). stopPropagation so it
                            doesn't also toggle the row expand. */}
                        {row.glyph === 'found' && jobTerminal && draftMap
                          && draftMap.status !== 'active' && saveState !== 'saved'
                          && !REQUIRED_ACTION_KEYS.has(row.key) && (
                          <Btn
                            variant="ghost" size="sm"
                            onClick={(e) => { e.stopPropagation(); void removeFeed(row.key, row.label); }}
                            disabled={removingFeed === row.key}
                            title="Remove this feed from the map before it goes live"
                            style={{ color: 'var(--terracotta)', borderColor: 'rgba(192,108,84,.45)' }}
                          >
                            {removingFeed === row.key ? 'Removing…' : 'Remove'}
                          </Btn>
                        )}
                        {expandable && (expanded
                          ? <ChevronDown size={14} color={dimWhite(.45)} />
                          : <ChevronRight size={14} color={dimWhite(.45)} />)}
                      </div>
                      {expandable && expanded && (
                        <div style={{ padding: '2px 0 12px 26px', overflowX: 'auto' }}>
                          {hasSample && (
                            <>
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
                            </>
                          )}
                          {/* feature/cua-admin-mapper-visibility — the SOURCE
                              screen the robot read this feed from, UNDER the row
                              sample so the founder can verify WHERE on the PMS
                              the data came from. */}
                          <FeedCaptureView state={captures[row.key]} onError={() => handleCaptureError(row.key)} />
                          {/* B1 — the learned columns (field → selector) the
                              robot recorded for this feed, for review. */}
                          <LearnedColumnsView state={feedDetails[row.key]} />
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

            {/* feature/cua-live-assist — founder takeover panel: the robot is
                paused and you drive it click-by-click. Owns the screen while a
                takeover is open (the ambient live card is hidden below). Hidden
                once the job is terminal — a hard worker crash can leave a
                dangling 'active' row, and a finished run has no robot to drive. */}
            {takeover && takeover.status !== 'ended' && !jobTerminal && (
              <DarkCard style={{ padding: '20px 24px', marginBottom: 16, border: '2px solid var(--forest)' }}>
                <Caps c="var(--forest)">You&rsquo;re driving — point and click</Caps>
                <h2 style={{ fontFamily: FONT_SERIF, fontSize: 20, fontWeight: 400, fontStyle: 'italic', margin: '4px 0 10px', color: '#fff' }}>
                  {feedRows.find((r) => r.key === takeover.target_key)?.label ??
                    (takeover.target_key ? prettifyTargetKey(takeover.target_key) : 'this feed')}
                </h2>
                {takeoverPending ? (
                  <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: dimWhite(.7), display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Loader2 size={14} style={{ animation: 'spin 1.2s linear infinite' }} />
                    Pausing the robot — it finishes its current step, then hands you the wheel…
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <MousePointerClick size={14} color="var(--forest)" />
                      <span style={{ fontSize: 13, color: '#fff', fontWeight: 600 }}>
                        Click where the robot should click. It does it, then shows you the new screen.
                      </span>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.5) }}>
                        (passwords and payment details are blacked out automatically)
                      </span>
                    </div>
                    {takeoverFrame ? (
                      <div style={{
                        position: 'relative', display: 'inline-block', width: '100%', maxWidth: 980,
                        border: `1px solid ${dimWhite(.14)}`, borderRadius: 8, overflow: 'hidden', lineHeight: 0,
                      }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={takeoverFrame.url}
                          alt="The robot's current screen — click where it should click (sensitive fields redacted)"
                          onClick={onTakeoverFrameClick}
                          style={{ width: '100%', height: 'auto', display: 'block', cursor: (robotIdle && takeoverFrameFresh) ? 'crosshair' : 'wait' }}
                        />
                        {takeoverMarker && (
                          <div style={{
                            position: 'absolute', left: `${takeoverMarker.leftPct}%`, top: `${takeoverMarker.topPct}%`,
                            transform: 'translate(-50%, -50%)', pointerEvents: 'none', width: 22, height: 22, borderRadius: '50%',
                            border: '3px solid var(--forest)', background: 'rgba(60,156,104,0.3)', boxShadow: '0 0 0 3px rgba(255,255,255,0.85)',
                          }} />
                        )}
                      </div>
                    ) : (
                      <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: dimWhite(.5), padding: '10px 0' }}>
                        Waiting for the robot&rsquo;s screen…
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
                      <Btn
                        variant="forest"
                        onClick={() => takeoverMarker && void sendTakeoverCommand('click', { x: takeoverMarker.x, y: takeoverMarker.y }, takeoverFrame?.frameSeq)}
                        disabled={!canSendClick}
                      >
                        <MousePointerClick size={13} /> Send this click
                      </Btn>
                      {!robotIdle
                        ? <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: 'var(--gold)' }}><Loader2 size={11} style={{ animation: 'spin 1.2s linear infinite', verticalAlign: 'middle', marginRight: 4 }} />robot is clicking…</span>
                        : !takeoverFrameFresh
                          ? <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.5) }}>loading the latest screen…</span>
                          : takeoverMarker
                            ? <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.66) }}>will click at ({takeoverMarker.x}, {takeoverMarker.y})</span>
                            : <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.5) }}>click the screen first</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                      {/* Finish/Cancel only when the painted frame is current
                          (robotIdle + fresh) — never decide against a stale view. */}
                      <Btn variant="forest" onClick={() => void sendTakeoverCommand('finish')} disabled={takeoverBusy || !robotIdle || !takeoverFrameFresh}>
                        <CheckCircle2 size={13} /> Finish — this is the page
                      </Btn>
                      <Btn variant="terracotta" onClick={() => void sendTakeoverCommand('cancel')} disabled={takeoverBusy || !robotIdle || !takeoverFrameFresh}>
                        <XCircle size={13} /> Couldn&rsquo;t find it
                      </Btn>
                    </div>
                    <p style={{ fontFamily: FONT_MONO, fontSize: 10, color: dimWhite(.5), marginTop: 8, lineHeight: 1.5 }}>
                      <strong>Finish</strong> tells the robot this is the right page — it reads the columns and saves this feed.
                      <strong> Couldn&rsquo;t find it</strong> marks the feed not-found and moves on.
                    </p>
                  </>
                )}
              </DarkCard>
            )}

            {/* feature/cua-live-view — the robot's screen, continuously.
                Now a SHARED self-driving component (it self-fetches frames,
                runs BOTH heartbeats, owns the live_frame broadcast + freshness).
                It stays MOUNTED whenever the page is open so the per-job
                heartbeat keeps firing (load-bearing: the worker only tees frames
                while that heartbeat is fresh, AND the help-request hold depends
                on it too) — so we HIDE it (display:none) rather than unmount it
                while an actionable help request or a takeover owns the screen.
                The Take-over affordance is only offered when nothing else owns
                the screen; the host owns the eligibility + the takeover call. */}
            {(() => {
              const screenOwnedElsewhere = (!!pendingHelp && !pendingIsStale) || !!takeover;
              return (
                <div style={screenOwnedElsewhere ? { display: 'none' } : undefined}>
                  <LiveRobotView
                    jobId={jobId}
                    canStartTakeover={!screenOwnedElsewhere && canStartTakeover}
                    onStartTakeover={() => void startTakeover('start', searchingRow?.key)}
                  />
                </div>
              );
            })()}

            {/* feature/cua-operator-notes — the robot's live reasoning */}
            <DarkCard style={{ padding: '16px 20px', marginBottom: 16 }}>
              <Caps c={dimWhite(.5)}>What it&rsquo;s thinking</Caps>
              <div
                ref={thoughtsRef}
                style={{
                  fontFamily: FONT_SANS, fontSize: 12.5, color: dimWhite(.8),
                  lineHeight: 1.55, marginTop: 8, maxHeight: 340,
                  overflowY: 'auto', background: 'rgba(0,0,0,.3)',
                  padding: 12, borderRadius: 4,
                }}
              >
                {thoughts.length === 0
                  ? <div style={{ color: dimWhite(.45), fontFamily: FONT_MONO, fontSize: 11 }}>Its reasoning streams here as it works…</div>
                  : thoughts.map((th, i) => (
                      <div key={i} style={{ padding: '6px 0', borderTop: i === 0 ? 'none' : `1px solid ${dimWhite(.08)}` }}>
                        <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: dimWhite(.4) }}>
                          {th.at ? new Date(th.at).toLocaleTimeString() : ''}{th.feedKey ? ` · ${prettifyTargetKey(th.feedKey)}` : ''}
                        </span>
                        <div style={{ marginTop: 2 }}>{th.text}</div>
                      </div>
                    ))}
              </div>
              {/* feature/cua-operator-notes — leave the robot a note (live runs only) */}
              {!jobTerminal && (
                <div style={{ marginTop: 14 }}>
                  <Caps c={dimWhite(.5)}>Leave it a note</Caps>
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <input
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !noteSending) void sendNote(); }}
                      placeholder="e.g. “try the Reports menu” or “wrong page, go back”"
                      maxLength={500}
                      style={{
                        flex: 1, minWidth: 0, fontFamily: FONT_SANS, fontSize: 13,
                        padding: '9px 12px', background: dimWhite(.06), color: '#fff',
                        border: `1px solid ${dimWhite(.18)}`, borderRadius: 8, outline: 'none',
                      }}
                    />
                    <Btn variant="forest" onClick={() => void sendNote()} disabled={noteSending || noteText.trim() === ''}>
                      <Send size={12} /> {noteSending ? 'Sending…' : 'Send note'}
                    </Btn>
                  </div>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.45), marginTop: 6 }}>
                    It reads your note on its next step (a few seconds) and adjusts.
                  </div>
                  {sentNotes.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      {sentNotes.map((n, i) => (
                        <div key={i} style={{ fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.62), padding: '2px 0' }}>
                          <span style={{ color: dimWhite(.4) }}>{new Date(n.at).toLocaleTimeString()}</span> · sent: {n.text}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </DarkCard>

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
