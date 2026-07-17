'use client';

export const dynamic = 'force-dynamic';

/**
 * /admin/properties/coverage/[propertyId] — feature/cua-coverage-editor.
 *
 * Opens a SAVED PMS map (the active knowledge file for this hotel's PMS family)
 * and shows every data point (feed) it captures: learned columns, the live row
 * count + sample for THIS hotel, and trust state. From here the founder can:
 *   - Edit a feed  → re-point it via the same point-and-click takeover on the
 *                    live board (drive to the right page, press Finish).
 *   - Add a feed   → learn a feed the map doesn't have yet (same takeover).
 *   - Delete a feed→ remove where the robot grabs a piece entirely (re-signs a
 *                    new map version on the worker, never-zero-active safe).
 *
 * The map is PER-FAMILY (shared by every hotel on it) — edits change all of
 * them, surfaced prominently. Admin-only, English-only (matches the studio).
 *
 * All reads/writes go through /api/admin/mapper/coverage* (supabaseAdmin) — the
 * pms_* and pms_knowledge_files tables are deny-all-browser RLS.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  FONT_SANS, FONT_MONO, FONT_SERIF, Btn, Pill, Caps, type PillTone,
} from '@/app/admin/_components/studio/kit';
import {
  SurfaceShell, DarkCard, DarkScope, DarkEmpty, dimWhite, Backdrop, MODAL_CARD,
} from '@/app/admin/_components/studio/surface-kit';
import '@/app/admin/_components/studio/studio.css';
import { FeedCaptureView, type CaptureState } from '@/app/admin/_components/cua/FeedCaptureView';
import { DragToCaptureView } from '@/app/admin/_components/cua/DragToCaptureView';
import { LiveRobotView } from '@/app/admin/_components/cua/LiveRobotView';
import type { ColumnGeometry, FreeformResolution } from '@/lib/pms/column-geometry';
import { slugifyHeader as slugifyValue } from '@/lib/pms/column-geometry';
import {
  ChevronLeft, RefreshCw, Pencil, Trash2, Plus, AlertTriangle, Eye, Loader2, Layers, Lock, Wand2, Check, MousePointerClick, X,
} from 'lucide-react';

/** Coarse "time ago" for the self-repair pill. Tolerant of null/garbage. */
function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!isFinite(min)) return '';
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

interface FeedDetail {
  key: string;
  actionKey: string | null;
  label: string;
  table: string | null;
  columns: Record<string, string>;
  // feature/cua-column-editor — founder-added custom columns (name → selector),
  // captured into the table's `raw` bucket; the page columns the founder could
  // still add (detected, not yet captured); and the columns that can't be
  // removed (core contract — the delete control is hidden for these).
  customColumns: Record<string, string>;
  availablePageColumns: Array<{ index: number; header: string }>;
  undeletableColumns: string[];
  required: boolean;
  canTakeover: boolean;
  source: 'actions' | 'legacy';
  state: 'live' | 'learning';
  rowCount: number | null;
  sample: Array<Record<string, unknown>>;
}

interface CoverageResponse {
  propertyId: string;
  propertyName: string;
  pmsFamily: string;
  familyLabel: string;
  hotelsOnFamily: number;
  connection: 'healthy' | 'pending' | 'paused';
  activeMap: {
    id: string; version: number; status: string; signed: boolean;
    shape: 'actions' | 'legacy' | 'empty'; editable: boolean;
    // verify-before-live / self-repair — OPTIONAL, best-effort. When the active
    // map version was produced by the robot's free self-repair (reanchor) — as
    // opposed to a fresh learn or a founder edit — the route may flag it here so
    // the page can show a "Repaired (auto)" pill. Tolerate absence: older
    // responses simply omit it and no pill renders.
    repaired?: boolean;
    repairedAt?: string | null;
    // feature/coverage-show-draft — when there is NO live (active) map, the route
    // falls back to the latest PARKED DRAFT and returns it here with isDraft:true.
    // The page renders the same feeds/columns but with a "review before it goes
    // live" banner + a Make-live button. `review` is a small WHY-park subset
    // (verification score/threshold + a short reason) — never selectors. Absent
    // on a live map (behaves exactly as before).
    isDraft?: boolean;
    draftId?: string;
    review?: { score?: number; threshold?: number; reason?: string };
    // feature/coverage-gated-feeds — action keys the robot is NOT collecting
    // (pms_knowledge_files.disabled_feeds). On a LIVE map, a key here means the
    // feed is off until a successful Re-read turns it on. On a DRAFT it's
    // usually [] (the gate is computed at Make-live). Always present (route
    // defaults to []); older responses without it degrade to "no feeds gated".
    disabledFeeds?: string[];
  } | null;
  feeds: FeedDetail[];
  addableFeeds: Array<{ actionKey: string; label: string }>;
}

// fix/cua-freeform-capture — the "Captured" panel's per-feed live sample.
// `ok` (feature/coverage-gated-feeds): extraction success. The worker writes a
// sample even for a partially-failed read (a "see what went wrong" preview) and
// stamps ok:false on it; absent (older cached response) → treat as true.
interface FeedSampleData { ok?: boolean; capturedAt: string; rowCount: number; fields: Array<{ name: string; value: string }>; pageValues?: Array<{ name: string; value: string }> }

const STATE_PILL: Record<FeedDetail['state'], { tone: PillTone; label: string }> = {
  live: { tone: 'forest', label: 'Live' },
  learning: { tone: 'gold', label: 'Still learning' },
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// "read 5 min ago" for the Captured panel. Tolerates a bad/empty timestamp.
const timeAgo = (iso: string): string => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} d ago`;
};

// fix/cua-freeform-capture-live — map a worker capture reason (or 'no_table' /
// 'timeout' tokens) to a plain-English founder message. Keeps the failure
// HONEST + fast instead of every failure collapsing to a misleading "timeout"
// (review MEDIUMs). Returns the special tokens unchanged for the message block.
const captureReason = (reason: string): string => {
  if (reason === 'no_table' || reason === 'timeout') return reason;
  if (reason.startsWith('unsafe_url')) return "Couldn't safely open this feed's page.";
  switch (reason) {
    case 'no_stored_session': return "The robot hasn't finished logging into this hotel yet — Re-map this feed first.";
    case 'relogin_needed': return "The robot's login expired and it couldn't get back in (it may need a 2FA code) — Re-map this feed to refresh it.";
    case 'no_credentials': return 'This hotel has no saved PMS login yet.';
    case 'no_recipe': return "There's no map for this hotel yet — Re-map first.";
    case 'no_pms_family': return "This hotel's PMS isn't set up yet.";
    case 'feed_incomplete':
    case 'feed_not_in_recipe': return "The robot doesn't fully know this feed yet — Re-map it.";
    case 'multi_source_unsupported': return "This feed has several sources, so drag-capture isn't supported — use Re-map.";
    case 'daily_cap': return "The robot's hit its daily limit for reading pages — try again tomorrow, or Re-map.";
    case 'aborted': return 'The capture was cancelled — try again.';
    // Route-level errors arrive as full human sentences (cooldown, no PMS set up,
    // etc.) — show them as-is. An unknown single-token code → the generic line.
    default: return /\s/.test(reason) ? reason : "Couldn't capture this page — try Re-map above.";
  }
};

export default function CoveragePage() {
  const params = useParams<{ propertyId: string }>();
  const propertyId = params?.propertyId ?? '';
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [data, setData] = useState<CoverageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);     // `${verb}:${key}`
  const [expanded, setExpanded] = useState<string | null>(null);
  // feature/cua-admin-mapper-visibility — per-feed source screenshots, keyed by
  // the capture feed key (actionKey ?? row key). Lazily filled on first expand.
  const [captures, setCaptures] = useState<Record<string, CaptureState>>({});
  // "Captured" panel — per-feed live sample of what the robot read.
  const [samples, setSamples] = useState<Record<string, FeedSampleData | null>>({});
  const [recapturing, setRecapturing] = useState<Record<string, boolean>>({});
  const [addKey, setAddKey] = useState<string>('');
  const [pendingDelete, setPendingDelete] = useState<FeedDetail | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'good' | 'warn' | 'bad'; text: string } | null>(null);
  // cockpit — when a per-feed Re-map run is enqueued we stay IN-PAGE and embed
  // the shared LiveRobotView for this job instead of navigating to the board.
  // The board URL is kept so "Take over" can open the full driving surface in a
  // new tab; on a terminal job we clear this + reload coverage.
  const [liveJobId, setLiveJobId] = useState<string | null>(null);
  const [liveBoardUrl, setLiveBoardUrl] = useState<string | null>(null);
  // feature/coverage-show-draft — Make-live (promote) flow for a parked draft.
  const [pendingPromote, setPendingPromote] = useState(false);
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  // feature/cua-column-editor — per-column delete / add-custom. `colBusy` keys a
  // single in-flight op (`del:${feedKey}:${col}` | `add:${feedKey}`) to disable
  // the right control; the add-form is open for at most one feed at a time.
  const [colBusy, setColBusy] = useState<string | null>(null);
  const [addColFeed, setAddColFeed] = useState<string | null>(null);
  const [addColIndex, setAddColIndex] = useState<string>('');   // selected page-header index (as string)
  const [addColName, setAddColName] = useState<string>('');     // editable custom name
  // feature/cua-click-to-map — drag-on-screenshot flow: which feed has it open,
  // and the body-cell selector the founder drag-selected (overrides addColIndex).
  const [dragColFeed, setDragColFeed] = useState<string | null>(null);
  const [addColSelector, setAddColSelector] = useState<string>('');
  // fix/cua-freeform-capture — 'page' when the drag picked a one-off VALUE (read
  // once + stamped on every row), 'row' for a per-row column.
  const [addColScope, setAddColScope] = useState<'row' | 'page'>('row');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/admin/mapper/coverage?propertyId=${encodeURIComponent(propertyId)}`);
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? `Failed to load coverage (${res.status})`);
        return;
      }
      setData(json.data as CoverageResponse);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    if (!user || !propertyId) return;
    void load();
  }, [user, propertyId, load]);

  // "Captured" panel — fetch one feed's live sample.
  const loadOneSample = useCallback(async (feedKey: string): Promise<FeedSampleData | null> => {
    try {
      const res = await fetchWithAuth(`/api/admin/mapper/feed-sample?propertyId=${encodeURIComponent(propertyId)}&feedKeys=${encodeURIComponent(feedKey)}`);
      const json = await res.json();
      if (res.ok && json.ok && json.data?.samples) return (json.data.samples[feedKey] as FeedSampleData | null) ?? null;
    } catch { /* leave as-is */ }
    return null;
  }, [propertyId]);

  // Fetch all feeds' samples in one call (called when the map loads).
  const loadSamples = useCallback(async () => {
    const keys = (data?.feeds ?? []).map((f) => f.actionKey ?? f.key).filter(Boolean);
    if (keys.length === 0) return;
    try {
      const res = await fetchWithAuth(`/api/admin/mapper/feed-sample?propertyId=${encodeURIComponent(propertyId)}&feedKeys=${encodeURIComponent(keys.join(','))}`);
      const json = await res.json();
      if (res.ok && json.ok && json.data?.samples) setSamples(json.data.samples as Record<string, FeedSampleData | null>);
    } catch { /* leave as-is */ }
  }, [propertyId, data]);

  // Trigger a fresh robot read of one feed, then refresh its sample.
  const recaptureFeed = useCallback(async (feedKey: string) => {
    if (recapturing[feedKey]) return;
    setRecapturing((prev) => ({ ...prev, [feedKey]: true }));
    const before = samples[feedKey]?.capturedAt;
    try {
      const res = await fetchWithAuth('/api/admin/mapper/coverage/capture-feed', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ propertyId, feedKey }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) { setToast({ tone: 'bad', text: captureReason(typeof json?.error === 'string' ? json.error : 'capture_failed') }); return; }
      for (let i = 0; i < 30; i++) {
        await sleep(3000);
        const s = await loadOneSample(feedKey);
        if (s && s.capturedAt && s.capturedAt !== before) {
          setSamples((prev) => ({ ...prev, [feedKey]: s }));
          setToast({ tone: 'good', text: 'Re-read from the robot.' });
          // feature/coverage-gated-feeds — a successful Re-read of a feed that was
          // gated OFF makes the worker clear its key from disabled_feeds. Reload
          // coverage so the feed's chip flips from "Off — hit Re-read" to
          // "Collecting". Cheap + only after a confirmed fresh capture. Guarded to
          // the live-map case (a draft has no server-side gate to flip yet).
          if (data?.activeMap && !data.activeMap.isDraft) void load();
          return;
        }
      }
      setToast({ tone: 'warn', text: "Still reading — check back in a moment." });
    } catch { setToast({ tone: 'bad', text: "Couldn't re-read this feed." }); }
    finally { setRecapturing((prev) => ({ ...prev, [feedKey]: false })); }
  }, [propertyId, recapturing, samples, loadOneSample, data, load]);

  useEffect(() => {
    if (data?.feeds?.length) void loadSamples();
  }, [data, loadSamples]);

  // De-dupe guard: keys with a fetch in flight or a SUCCESSFUL result. We keep
  // successes cached (re-expanding is free) but deliberately drop empties +
  // failures so they retry on a later expand — the robot may capture a feed
  // between two views of this page.
  const captureReqRef = useRef<Set<string>>(new Set());

  // Lazy-fetch the source screenshot for one feed (called when it's expanded).
  // Resolved per-property + feed key — the latest capture the robot took for
  // this hotel's feed. Failures land as url:null → the empty state, and stay
  // retryable.
  // Raw fetch of the latest capture for one feed — no state, no de-dupe. The
  // building block both ensureCapture and the live-capture poll loop use.
  const fetchCapture = useCallback(async (capKey: string): Promise<{ url: string | null; geometry: ColumnGeometry | null }> => {
    let url: string | null = null;
    let geometry: ColumnGeometry | null = null;
    try {
      const res = await fetchWithAuth(
        `/api/admin/mapper/feed-capture?propertyId=${encodeURIComponent(propertyId)}&feedKey=${encodeURIComponent(capKey)}`,
      );
      const json = await res.json();
      if (res.ok && json.ok && typeof json.data?.url === 'string') url = json.data.url;
      // feature/cua-click-to-map — the column geometry for drag-to-capture.
      if (res.ok && json.ok && json.data?.geometry && Array.isArray(json.data.geometry.columns)) {
        geometry = json.data.geometry as ColumnGeometry;
      }
    } catch {
      url = null;
    }
    return { url, geometry };
  }, [propertyId]);

  const hasGeometry = (g: ColumnGeometry | null | undefined): boolean =>
    !!(g && (g.columns.length > 0 || (g.values?.length ?? 0) > 0));

  const ensureCapture = useCallback(async (capKey: string) => {
    if (captureReqRef.current.has(capKey)) return;
    captureReqRef.current.add(capKey);
    setCaptures((prev) => ({ ...prev, [capKey]: { ...(prev[capKey] ?? {}), loading: true, url: null } }));
    const { url, geometry } = await fetchCapture(capKey);
    setCaptures((prev) => ({ ...prev, [capKey]: { loading: false, url, geometry } }));
    if (!url) captureReqRef.current.delete(capKey); // no capture (yet) → let it retry
  }, [fetchCapture]);

  // fix/cua-freeform-capture-live — trigger an ON-DEMAND capture for one feed,
  // then poll until the drag-map (geometry) lands. This is what lets the founder
  // drag on a hotel whose map is still a PARKED DRAFT (no live session, never
  // polls) — the robot logs in cheaply, reads the page, and writes the geometry.
  const liveCapReqRef = useRef<Set<string>>(new Set());
  const requestLiveCapture = useCallback(async (capKey: string) => {
    if (liveCapReqRef.current.has(capKey)) return;
    liveCapReqRef.current.add(capKey);
    setCaptures((prev) => ({ ...prev, [capKey]: { ...(prev[capKey] ?? { url: null }), loading: false, capturing: true, captureError: null } }));
    const fail = (msg: string) => {
      setCaptures((prev) => ({ ...prev, [capKey]: { ...(prev[capKey] ?? { url: null }), loading: false, capturing: false, captureError: msg } }));
      liveCapReqRef.current.delete(capKey);
    };
    const succeed = (url: string | null, geometry: ColumnGeometry | null) => {
      captureReqRef.current.add(capKey); // mark cached so a re-expand doesn't refetch
      setCaptures((prev) => ({ ...prev, [capKey]: { loading: false, url, geometry, capturing: false, captureError: null } }));
      liveCapReqRef.current.delete(capKey);
    };
    let jobId: string | null = null;
    try {
      const res = await fetchWithAuth('/api/admin/mapper/coverage/capture-feed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ propertyId, feedKey: capKey }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) { fail(captureReason(typeof json?.error === 'string' ? json.error : 'capture_failed')); return; }
      if (typeof json.data?.jobId === 'string') jobId = json.data.jobId;
    } catch { fail(captureReason('capture_failed')); return; }
    // Poll the geometry AND the job's real outcome (~3s × 30 ≈ 90s ceiling). The
    // worker writes geometry BEFORE it finishes, so any honest failure
    // (no stored login, nav failed, non-table feed) surfaces in seconds with a
    // real message instead of a misleading full-length "timeout" (review MEDIUMs).
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const { url, geometry } = await fetchCapture(capKey);
      if (hasGeometry(geometry)) { succeed(url, geometry); return; }
      if (jobId) {
        try {
          const jres = await fetchWithAuth(`/api/admin/mapper/live/${jobId}`);
          const job = (await jres.json())?.data?.job as { status?: string; error?: string } | undefined;
          if (job?.status === 'failed' || job?.status === 'cancelled') { fail(captureReason(job.error ?? 'capture_failed')); return; }
          if (job?.status === 'completed') {
            // Job done but geometry never landed → not an on-screen table, or the
            // robot's stored login went stale and it never reached the table.
            const fin = await fetchCapture(capKey);
            if (hasGeometry(fin.geometry)) { succeed(fin.url, fin.geometry); return; }
            fail('no_table'); return;
          }
        } catch { /* keep polling */ }
      }
    }
    fail('timeout');
  }, [propertyId, fetchCapture]);

  // Open the add-column flow for a feed: fetch any existing drag-map; if there
  // is none, kick off an on-demand capture so the founder can drag right away.
  const openAddColumn = useCallback(async (capKey: string) => {
    captureReqRef.current.add(capKey);
    setCaptures((prev) => ({ ...prev, [capKey]: { ...(prev[capKey] ?? {}), loading: true, url: prev[capKey]?.url ?? null } }));
    const { url, geometry } = await fetchCapture(capKey);
    setCaptures((prev) => ({ ...prev, [capKey]: { loading: false, url, geometry } }));
    if (!hasGeometry(geometry)) void requestLiveCapture(capKey);
  }, [fetchCapture, requestLiveCapture]);

  // A stale/broken signed URL (1h signature lapsed, or the object was swept)
  // falls back to the empty state and frees the key so a re-expand refetches.
  const handleCaptureError = useCallback((capKey: string) => {
    captureReqRef.current.delete(capKey);
    setCaptures((prev) => ({ ...prev, [capKey]: { loading: false, url: null } }));
  }, []);

  // Re-map / Add → enqueue a single-target run and stay IN-PAGE: the embedded
  // LiveRobotView (mounted at the top of the feed list when liveJobId is set)
  // shows the robot working; "Take over" opens the full board in a new tab to
  // drive it. For a PARKED DRAFT (no live map) the re-map targets the draft by
  // draftId; for a LIVE map it targets the family by pmsFamily. When the job
  // reaches a terminal status we clear the live card and reload coverage so the
  // re-mapped feed's new columns (or the updated draft) show.
  const startEditOrAdd = async (targetKey: string, mode: 'edit' | 'add') => {
    if (!data) return;
    setBusy(`${mode}:${targetKey}`);
    setToast(null);
    const draft = data.activeMap?.isDraft ? data.activeMap : null;
    try {
      const res = await fetchWithAuth('/api/admin/mapper/coverage/edit-feed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          draft
            ? { draftId: draft.draftId, propertyId, targetKey, mode }
            : { pmsFamily: data.pmsFamily, propertyId, targetKey, mode },
        ),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setToast({ tone: 'bad', text: json.error ?? 'Could not start the re-map run.' });
        return;
      }
      // Stay in-page — embed the live view for this job.
      const jobId = json.data.jobId as string;
      setLiveBoardUrl((json.data.boardUrl as string | undefined) ?? null);
      setLiveJobId(jobId);
      // Watch the run in the background. A re-map is takeover-driven — the robot
      // pauses for you to guide it, which can take many minutes — so poll long
      // (~40min) and only tear down the embedded live card on a REAL terminal
      // status. On the rare timeout, LEAVE the card up (keep watching / Take over).
      void (async () => {
        const r = await pollJob(jobId, 1200);
        if (!r.ok && r.timedOut) {
          setToast({ tone: 'warn', text: 'Re-map still running — keep watching here, or open it in Manage maps.' });
          return;
        }
        setLiveJobId(null);
        setLiveBoardUrl(null);
        if (!r.ok) setToast({ tone: 'bad', text: r.error });
        await load();
      })();
    } catch (err) {
      setToast({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  // Delete → enqueue a worker recipe edit, then poll the job to completion.
  // BOTH a LIVE map and a PARKED DRAFT now go through a re-signing worker job
  // (fix/cua-draft-resign): a draft is signed at learn time, so the old in-place
  // jsonb write silently broke its seal and made a later Make-live trigger a
  // ~$25 re-learn. The draft removal hits the draft delete-feed route, which
  // enqueues the SAME job kind and returns a jobId we poll — so the founder sees
  // the same "removing…" progress (it now takes a few seconds, not instant).
  const confirmDelete = async () => {
    if (!pendingDelete?.actionKey || !data) return;
    setDeleteBusy(true);
    setDeleteError(null);

    if (data.activeMap?.isDraft) {
      try {
        const res = await fetchWithAuth('/api/admin/mapper/draft/delete-feed', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ draftId: data.activeMap.draftId, propertyId, feedKey: pendingDelete.actionKey }),
        });
        const json = await res.json();
        if (!res.ok || !json.ok) {
          setDeleteError(json.error ?? 'Could not remove the feed.');
          return;
        }
        // Already gone (idempotent, no job) → warn + reload. Otherwise poll the
        // re-signing worker job to completion before reloading.
        if (typeof json.data?.jobId === 'string') {
          const outcome = await pollJob(json.data.jobId);
          setPendingDelete(null);
          if (outcome.ok) {
            setToast({ tone: 'good', text: `Removed “${pendingDelete.label}” from the draft.` });
          } else {
            setToast({ tone: 'bad', text: outcome.error });
          }
        } else {
          setPendingDelete(null);
          setToast({ tone: 'warn', text: 'That feed was already gone from the draft.' });
        }
        await load();
      } catch (err) {
        setDeleteError((err as Error).message);
      } finally {
        setDeleteBusy(false);
      }
      return;
    }

    try {
      const res = await fetchWithAuth('/api/admin/mapper/coverage/delete-feed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pmsFamily: data.pmsFamily, propertyId, targetKey: pendingDelete.actionKey }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setDeleteError(json.error ?? 'Could not remove the feed.');
        return;
      }
      const jobId = json.data.jobId as string;
      const outcome = await pollJob(jobId);
      setPendingDelete(null);
      if (outcome.ok) {
        const decision = (outcome.result?.promotion_decision as string | undefined) ?? '';
        if (decision === 'auto_promote') {
          setToast({ tone: 'good', text: `Removed “${pendingDelete.label}” — the map is live without it.` });
        } else {
          setToast({ tone: 'warn', text: (outcome.result?.promotion_reason as string | undefined) ?? 'Saved as a draft to review in Manage maps.' });
        }
      } else {
        setToast({ tone: 'bad', text: outcome.error });
      }
      await load();
    } catch (err) {
      setDeleteError((err as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  };

  // Make live → promote the parked draft to active for the whole family. Echoes
  // the version + status we saw so a stale UI can't promote the wrong row.
  const confirmPromote = async () => {
    const map = data?.activeMap;
    if (!map?.isDraft || !map.draftId) return;
    setPromoteBusy(true);
    setPromoteError(null);
    try {
      const res = await fetchWithAuth('/api/admin/live-mapper/promote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // feature/coverage-gated-feeds — send the property we're viewing so
        // promote only lights up feeds proven by a preview for THIS hotel.
        body: JSON.stringify({ id: map.draftId, expectedVersion: map.version, expectedStatus: 'draft', propertyId }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setPromoteError(json.error ?? 'Could not make this map live.');
        return;
      }
      setPendingPromote(false);
      // If some feeds were gated off, say how many are actually collecting so the
      // founder isn't surprised the map is live but a feed shows no data yet.
      const disabled = Array.isArray(json.data?.disabledFeeds) ? (json.data.disabledFeeds as string[]) : [];
      const totalMapped = data?.feeds?.length ?? 0;
      const collecting = Math.max(0, totalMapped - disabled.length);
      setToast({
        tone: 'good',
        text: disabled.length > 0
          ? `Map v${map.version} is live for every ${data?.familyLabel} hotel — collecting ${collecting} of ${totalMapped} feeds (Re-read a feed to turn on the rest).`
          : `Map v${map.version} is now live for every ${data?.familyLabel} hotel.`,
      });
      await load();
    } catch (err) {
      setPromoteError((err as Error).message);
    } finally {
      setPromoteBusy(false);
    }
  };

  // Poll GET /live/[jobId] until the (headless) edit job finishes.
  const pollJob = async (jobId: string, maxIters = 45): Promise<{ ok: true; result: Record<string, unknown> | null } | { ok: false; error: string; timedOut?: boolean }> => {
    for (let i = 0; i < maxIters; i++) {
      await sleep(2000);
      try {
        const res = await fetchWithAuth(`/api/admin/mapper/live/${jobId}`);
        const json = await res.json();
        const job = json?.data?.job as { status?: string; result?: Record<string, unknown> | null; error?: string } | undefined;
        if (job?.status === 'completed') return { ok: true, result: job.result ?? null };
        if (job?.status === 'failed' || job?.status === 'cancelled') return { ok: false, error: job.error ?? 'The edit run failed.' };
      } catch { /* keep polling */ }
    }
    return { ok: false, error: 'Timed out waiting for the edit to finish — check Manage maps.', timedOut: true };
  };

  // feature/cua-column-editor — "Rate Plan" → "rate_plan" default custom name.
  const slugifyHeader = (header: string): string =>
    header.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^([0-9])/, 'c_$1').slice(0, 49) || 'field';

  // Shared edit-column caller. BOTH a parked DRAFT and a LIVE map now enqueue a
  // re-signing worker job we poll to completion (fix/cua-draft-resign): a draft
  // is signed at learn time, so the old in-place jsonb write silently broke its
  // seal and made a later Make-live trigger a ~$25 re-learn. On success we reload
  // coverage so the new/removed column shows + the sample (which reads the live
  // warehouse incl. the `raw` bucket) reflects it.
  // Returns true on success (column actually edited), false on any failure — so
  // callers can keep a form open + populated for the user to retry on error.
  const runColumnEdit = async (busyKey: string, payload: Record<string, unknown>, okText: string): Promise<boolean> => {
    if (!data) return false;
    setColBusy(busyKey);
    setToast(null);
    const draft = data.activeMap?.isDraft ? data.activeMap : null;
    try {
      const res = await fetchWithAuth('/api/admin/mapper/coverage/edit-column', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          propertyId,
          ...(draft ? { draftId: draft.draftId } : { pmsFamily: data.pmsFamily }),
          ...payload,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setToast({ tone: 'bad', text: json.error ?? 'Could not edit the column.' });
        return false;
      }
      // Both paths return a jobId to poll. A DRAFT edit keeps the map parked (it
      // stays a draft the founder reviews right here), so its success is simply
      // the caller's draft-aware okText — no auto-promote / Manage-maps framing.
      // A LIVE edit re-publishes: auto-promote → okText, otherwise it parked as a
      // new draft to review in Manage maps.
      if (typeof json.data?.jobId === 'string') {
        const outcome = await pollJob(json.data.jobId);
        if (!outcome.ok) { setToast({ tone: 'bad', text: outcome.error }); return false; }
        if (draft) {
          setToast({ tone: 'good', text: okText });
        } else {
          const decision = (outcome.result?.promotion_decision as string | undefined) ?? '';
          setToast(decision === 'auto_promote'
            ? { tone: 'good', text: okText }
            : { tone: 'warn', text: (outcome.result?.promotion_reason as string | undefined) ?? 'Saved as a draft to review in Manage maps.' });
        }
      } else {
        setToast({ tone: 'good', text: okText });
      }
      await load();
      return true;
    } catch (err) {
      setToast({ tone: 'bad', text: (err as Error).message });
      return false;
    } finally {
      setColBusy(null);
    }
  };

  const deleteColumn = (feed: FeedDetail, columnName: string) =>
    void runColumnEdit(`del:${feed.key}:${columnName}`,
      { feedKey: feed.actionKey ?? feed.key, op: 'delete', columnName },
      `Stopped capturing “${columnName}”.`);

  // fix/cua-repoint-column — point a built-in field at the correct page column
  // (fixes a mis-mapped column, e.g. Guest Name reading the wrong/no cell). The
  // geometry index IS the body cell index, so td:nth-child(index) is the selector.
  const repointColumn = (feed: FeedDetail, columnName: string, geometryIndex: number) =>
    void runColumnEdit(`set:${feed.key}:${columnName}`,
      { feedKey: feed.actionKey ?? feed.key, op: 'set-selector', columnName, selector: `td:nth-child(${geometryIndex})` },
      data?.activeMap?.isDraft
        ? `Pointed “${columnName}” at the right column — saved to your draft (re-read to preview).`
        : `Pointed “${columnName}” at the right column.`)
      .then((okFlag) => { if (okFlag) void loadSamples(); });

  const addCustomColumn = (feed: FeedDetail) => {
    const columnKey = slugifyHeader(addColName);
    // Three ways to choose the column: a drag-selected per-row COLUMN selector, a
    // drag-selected one-off VALUE (scope:page), or the dropdown's header index.
    const payload: Record<string, unknown> = addColSelector
      ? { feedKey: feed.actionKey ?? feed.key, op: 'add-custom', columnKey, selector: addColSelector, ...(addColScope === 'page' ? { scope: 'page' } : {}) }
      : { feedKey: feed.actionKey ?? feed.key, op: 'add-custom', columnKey, headerIndex: Number(addColIndex) };
    if (!addColSelector && (!Number.isInteger(Number(addColIndex)) || Number(addColIndex) < 1)) {
      setToast({ tone: 'bad', text: 'Pick or drag a column from the page to capture.' });
      return;
    }
    // Honest confirmation: on a PARKED DRAFT nothing collects until the map is
    // made live, so don't claim "now capturing" — say it's saved to the draft.
    const okText = data?.activeMap?.isDraft
      ? `Saved “${columnKey}” to your draft map — it'll start collecting once you make this map live.`
      : `Now capturing “${columnKey}” into this feed.`;
    void runColumnEdit(`add:${feed.key}`, payload, okText)
      .then((okFlag) => {
        if (okFlag) { setAddColFeed(null); setAddColIndex(''); setAddColName(''); setAddColSelector(''); setAddColScope('row'); setDragColFeed(null); void loadSamples(); }
      });
  };

  const relearn = async () => {
    setBusy('relearn');
    try {
      const res = await fetchWithAuth('/api/admin/regenerate-recipe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ propertyId, reason: 'coverage-editor: modernize legacy map' }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setToast({ tone: 'bad', text: json.error ?? 'Could not start re-learning.' });
        return;
      }
      router.push(`/admin/properties/mapper/${json.data.jobId}`);
    } catch (err) {
      setToast({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  if (authLoading) return <AppLayout><DarkScope><div style={{ padding: 32, fontFamily: FONT_SANS, color: dimWhite(.66) }}>Loading…</div></DarkScope></AppLayout>;
  if (!user) return <AppLayout><DarkScope><div style={{ padding: 32, fontFamily: FONT_SANS, color: dimWhite(.66) }}>Not signed in</div></DarkScope></AppLayout>;
  if (user.role !== 'admin') return <AppLayout><DarkScope><div style={{ padding: 32, fontFamily: FONT_SANS, color: dimWhite(.66) }}>Admin access only</div></DarkScope></AppLayout>;

  const map = data?.activeMap;
  const legacy = map && !map.editable;
  const isDraft = !!map?.isDraft;

  // ── feature/coverage-gated-feeds — per-feed collection state. ──────────────
  // The founder's rule: Make-live only turns on feeds that have a proven preview;
  // the rest stay off until a later Re-read proves them. This block computes, for
  // display AND for the Make-live summary, EXACTLY what promote will decide — off
  // the SAME `samples` artifacts promote lists — so the page's prediction can
  // never drift from what actually collects.
  const capKeyOf = (f: FeedDetail): string => f.actionKey ?? f.key;
  // A feed is PROVEN iff its live/{propertyId}/{key}.sample.json artifact loaded
  // AND its extraction succeeded (ok !== false). Mere artifact existence is not
  // proof — the worker writes a sample even for a partially-failed read (its
  // data still shows below so the founder can fix the feed, but it won't
  // collect). Absent ok (legacy artifact) → proven, exactly matching promote's
  // shared sampleIndicatesSuccess rule, so prediction can't drift.
  const feedHasPreview = (f: FeedDetail): boolean => {
    const s = samples[capKeyOf(f)];
    return !!s && s.ok !== false;
  };
  // On a LIVE map, the source of truth is the server's disabled_feeds list.
  const disabledSet = new Set(map?.disabledFeeds ?? []);
  const feedIsDisabledLive = (f: FeedDetail): boolean => disabledSet.has(capKeyOf(f));

  // Collection chip per feed — DRAFT predicts from previews; LIVE reflects the
  // server's disabled_feeds. Returns null when we can't classify (e.g. legacy).
  const collectionChip = (f: FeedDetail): { tone: PillTone; label: string } | null => {
    if (!map) return null;
    if (isDraft) {
      return feedHasPreview(f)
        ? { tone: 'forest', label: '✓ Will collect when live' }
        : { tone: 'neutral', label: 'Off until previewed' };
    }
    // Live map.
    return feedIsDisabledLive(f)
      ? { tone: 'gold', label: 'Off — hit Re-read to turn on' }
      : { tone: 'forest', label: '● Collecting' };
  };

  // Plain-English Make-live summary — "Goes live collecting N of M feeds: …. The
  // other K stay off until you preview them working." Computed from the SAME
  // previews the chips use, so the dialog and the chips agree.
  const draftFeeds = isDraft ? (data?.feeds ?? []) : [];
  const willCollect = draftFeeds.filter(feedHasPreview);
  const willStayOff = draftFeeds.filter((f) => !feedHasPreview(f));
  const totalFeeds = draftFeeds.length;

  return (
    <AppLayout>
      <DarkScope>
        <SurfaceShell glow="tealTL" style={{ padding: '24px 48px 56px' }}>
          <div style={{ maxWidth: 1000, margin: '0 auto', fontFamily: FONT_SANS }}>
            <Link href="/admin/properties#system" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.55),
              textDecoration: 'none', letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: 16,
            }}>
              <ChevronLeft size={12} /> CUA Sessions
            </Link>

            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 6 }}>
              <h1 style={{ fontFamily: FONT_SERIF, fontSize: 30, fontWeight: 400, letterSpacing: '-0.02em', color: '#fff', margin: 0 }}>
                What the robot <span style={{ fontStyle: 'italic' }}>captures</span>
              </h1>
              <Btn variant="ghost" size="sm" onClick={() => void load()} style={{ color: '#fff', borderColor: dimWhite(.25) }}>
                <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} /> Refresh
              </Btn>
            </div>

            {data && (
              <p style={{ fontSize: 13, color: dimWhite(.66), margin: '0 0 18px' }}>
                {data.propertyName} · <span style={{ fontFamily: FONT_MONO, fontSize: 11.5 }}>{data.familyLabel}</span>
                {map && <> · {isDraft ? 'parked draft' : 'map'} <span style={{ fontFamily: FONT_MONO }}>v{map.version}</span></>}
              </p>
            )}

            {error && (
              <DarkCard style={{ marginBottom: 16, background: 'var(--terracotta-dim)', border: '1px solid rgba(194,86,46,.4)' }}>
                <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: 'var(--terracotta)' }}>{error}</span>
              </DarkCard>
            )}

            {toast && (
              <DarkCard style={{
                marginBottom: 16,
                background: toast.tone === 'good' ? 'var(--forest-dim)' : toast.tone === 'warn' ? 'var(--gold-dim)' : 'var(--terracotta-dim)',
                border: `1px solid ${toast.tone === 'good' ? 'rgba(60,156,104,.4)' : toast.tone === 'warn' ? 'rgba(201,154,46,.4)' : 'rgba(194,86,46,.4)'}`,
              }}>
                <span style={{ fontSize: 12.5, color: toast.tone === 'good' ? 'var(--forest)' : toast.tone === 'warn' ? 'var(--gold)' : 'var(--terracotta)' }}>{toast.text}</span>
              </DarkCard>
            )}

            {loading && !data && <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: dimWhite(.5) }}>Loading coverage…</div>}

            {data && !map && (
              <DarkEmpty text="No live map for this PMS yet. It appears here once the robot has learned this hotel's PMS." />
            )}

            {data && map && (
              <>
                {/* Family-scope warning + map meta */}
                <DarkCard style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <Layers size={18} color="var(--teal)" style={{ flexShrink: 0, marginTop: 2 }} />
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: '#fff' }}>
                      {isDraft
                        ? `Making this live affects every ${data.familyLabel} hotel`
                        : `Editing changes the map for every ${data.familyLabel} hotel`}
                    </div>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.6), marginTop: 3 }}>
                      one map · {data.hotelsOnFamily} hotel{data.hotelsOnFamily === 1 ? '' : 's'} on this PMS · the counts below are for {data.propertyName}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Pill tone={map.signed ? 'forest' : 'gold'}>{map.signed ? 'Signed' : 'Unsigned'}</Pill>
                    {data.connection !== 'healthy' && <Pill tone="gold">{data.connection === 'pending' ? 'No reads yet' : 'Paused'}</Pill>}
                  </div>
                </DarkCard>

                {/* feature/coverage-show-draft — parked-draft review banner. The
                    family has NO live map; this is the latest learned-but-not-yet-
                    live draft. The founder reviews the feeds below, then "Make
                    live" promotes it for every hotel on the PMS. */}
                {isDraft && map && (
                  <DarkCard style={{ marginBottom: 16, background: 'var(--gold-dim)', border: '1px solid rgba(201,154,46,.4)' }}>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                      <AlertTriangle size={18} color="var(--gold)" style={{ flexShrink: 0, marginTop: 2 }} />
                      <div style={{ flex: 1, minWidth: 240 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--gold)' }}>
                          Parked draft v{map.version} — review before it goes live
                        </div>
                        <div style={{ fontSize: 12.5, color: dimWhite(.72), marginTop: 4, lineHeight: 1.55 }}>
                          The robot learned this map but parked it for you to check. Nothing is live for {data.familyLabel} yet — review every feed below, then make it live.
                          {(typeof map.review?.score === 'number' && typeof map.review?.threshold === 'number') && (
                            <span style={{ display: 'block', fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.6), marginTop: 5 }}>
                              confidence {map.review!.score}/{map.review!.threshold}
                            </span>
                          )}
                          {map.review?.reason && (
                            <span style={{ display: 'block', fontSize: 12, color: dimWhite(.6), marginTop: 4 }}>
                              {map.review.reason}
                            </span>
                          )}
                        </div>
                      </div>
                      <Btn variant="forest" size="sm" onClick={() => { setPromoteError(null); setPendingPromote(true); }} disabled={promoteBusy}>
                        {promoteBusy ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={12} />} Make live
                      </Btn>
                    </div>
                  </DarkCard>
                )}

                {/* Legacy read-only banner */}
                {legacy && (
                  <DarkCard style={{ marginBottom: 16, background: 'var(--gold-dim)', border: '1px solid rgba(201,154,46,.4)' }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                      <Lock size={16} color="var(--gold)" style={{ flexShrink: 0, marginTop: 2 }} />
                      <div style={{ flex: 1, minWidth: 240 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--gold)' }}>This map predates per-feed editing</div>
                        <div style={{ fontSize: 12, color: dimWhite(.7), marginTop: 3 }}>
                          It’s shown read-only. Re-learn this PMS once to modernize it, then you can edit, add, and remove individual feeds.
                        </div>
                      </div>
                      <Btn variant="forest" size="sm" onClick={() => void relearn()} disabled={busy === 'relearn'}>
                        {busy === 'relearn' ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={12} />} Re-learn this PMS
                      </Btn>
                    </div>
                  </DarkCard>
                )}

                {/* cockpit — embedded live view of an in-flight per-feed Re-map.
                    Stays in-page (no nav to the board); "Take over" opens the
                    full driving surface in a new tab. Clears itself + reloads
                    coverage when the run finishes (handled in startEditOrAdd). */}
                {liveJobId && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{
                      fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.6),
                      display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
                    }}>
                      <MousePointerClick size={12} color="var(--teal)" />
                      Re-map pauses for you to guide it — watch here, or Take over to drive it.
                    </div>
                    <LiveRobotView
                      jobId={liveJobId}
                      canStartTakeover
                      onStartTakeover={() => {
                        if (liveBoardUrl) window.open(liveBoardUrl, '_blank', 'noopener,noreferrer');
                      }}
                    />
                  </div>
                )}

                {/* Feed list */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {data.feeds.length === 0 && <DarkEmpty text="This map captures no feeds." />}
                  {data.feeds.map((f) => {
                    const colNames = Object.keys(f.columns);
                    const isOpen = expanded === f.key;
                    // The robot captures keyed by the canonical action key; fall
                    // back to the row key for legacy/unmapped feeds.
                    const capKey = f.actionKey ?? f.key;
                    return (
                      <DarkCard key={f.key} style={{ padding: '14px 18px' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                              <span style={{ fontFamily: FONT_SERIF, fontSize: 17, color: '#fff' }}>{f.label}</span>
                              <Pill tone={STATE_PILL[f.state].tone}>{STATE_PILL[f.state].label}</Pill>
                              {/* verify-before-live / self-repair — when the
                                  active map version came from the robot's free
                                  self-repair, flag the live feeds it re-anchored.
                                  Best-effort: only renders when the route sent
                                  the repaired signal. */}
                              {map.repaired && f.state === 'live' && (
                                <Pill tone="teal">
                                  <Wand2 size={10} style={{ marginRight: 4 }} />
                                  Repaired (auto){map.repairedAt ? ` · ${ago(map.repairedAt)}` : ''}
                                </Pill>
                              )}
                              {f.required && <Caps size={9} c="var(--teal)" style={{ letterSpacing: '.12em' }}>core</Caps>}
                            </div>
                            <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.45), marginTop: 4 }}>
                              {f.table ?? '—'} · {colNames.length} column{colNames.length === 1 ? '' : 's'}
                              {f.rowCount != null && <> · {f.rowCount} row{f.rowCount === 1 ? '' : 's'} seen here</>}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {/* Re-map re-points the feed via takeover — works on
                                a LIVE map (family-wide) AND a parked DRAFT (this
                                draft only). It stays IN-PAGE: the embedded live
                                view at the top shows the robot working. The
                                family-wide warning is confirmed before firing. */}
                            {f.source === 'actions' && f.canTakeover && (
                              <Btn variant="ghost" size="sm" onClick={() => {
                                if (!window.confirm(isDraft
                                  ? `Re-mapping re-runs this feed on the parked draft — it won't go live until you publish it.\n\nThe robot will pause for you to guide it to the right page. Continue?`
                                  : `Re-mapping this feed affects every ${data.familyLabel} hotel.\n\nThe robot will pause for you to guide it to the right page. Continue?`)) return;
                                void startEditOrAdd(f.actionKey!, 'edit');
                              }} disabled={!!busy || !!liveJobId} style={{ color: '#fff', borderColor: dimWhite(.25) }}>
                                {busy === `edit:${f.actionKey}` ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <MousePointerClick size={12} />} Re-map
                              </Btn>
                            )}
                            {f.source === 'actions' && !f.required && map.editable && (
                              <Btn variant="ghost" size="sm" onClick={() => { setDeleteError(null); setPendingDelete(f); }} disabled={!!busy} style={{ color: 'var(--terracotta)', borderColor: 'rgba(194,86,46,.3)' }}>
                                <Trash2 size={12} /> {isDraft ? 'Remove' : 'Delete'}
                              </Btn>
                            )}
                          </div>
                        </div>

                        {(colNames.length > 0 || Object.keys(f.customColumns).length > 0) && (
                          <button
                            onClick={() => {
                              const next = isOpen ? null : f.key;
                              setExpanded(next);
                              if (next) void ensureCapture(capKey);
                            }}
                            style={{ marginTop: 10, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
                              fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.5), letterSpacing: '.08em', textTransform: 'uppercase' }}
                          >
                            {isOpen ? '▾ hide columns' : '▸ show columns'}
                          </button>
                        )}
                        {isOpen && (() => {
                          // feature/cua-column-editor — known + custom columns get a
                          // delete control (hidden for core contract columns); the
                          // founder can add an extra page column from a dropdown.
                          const editable = !!map?.editable && f.source === 'actions';
                          const customNames = Object.keys(f.customColumns);
                          const ColRow = (c: string, selector: string, custom: boolean) => {
                            const locked = !custom && f.undeletableColumns.includes(c);
                            const delKey = `del:${f.key}:${c}`;
                            const busyThis = colBusy === delKey;
                            // The remove control sits at the FAR LEFT of every row (an
                            // X, on every column). Core/anchor columns are LOCKED — the
                            // X is muted and clicking explains why it can't be removed
                            // (removing it would stop the feed saving any data).
                            return (
                              <div key={`${custom ? 'x' : ''}${c}`} style={{ display: 'flex', gap: 9, alignItems: 'baseline' }}>
                                <button
                                  onClick={() => {
                                    if (busyThis || liveJobId || !editable) return;
                                    if (locked) {
                                      setToast({ tone: 'warn', text: `“${c}” is a required column — the robot needs it to save this feed, so it can’t be removed.` });
                                      return;
                                    }
                                    void deleteColumn(f, c);
                                  }}
                                  disabled={!editable || busyThis || !!liveJobId}
                                  title={locked ? 'Required — can’t be removed' : 'Remove this column'}
                                  aria-label={locked ? `${c} is required` : `Remove ${c}`}
                                  style={{
                                    flexShrink: 0, marginTop: 1, width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                    background: 'transparent', border: 'none', padding: 0,
                                    cursor: editable && !busyThis && !liveJobId ? 'pointer' : 'default',
                                    color: locked ? dimWhite(.32) : 'var(--terracotta)',
                                  }}
                                >
                                  {busyThis ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : locked ? <Lock size={10} /> : <X size={13} />}
                                </button>
                                <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: '#fff', minWidth: 150, display: 'flex', alignItems: 'center', gap: 6 }}>
                                  {c}
                                  {custom && <Caps size={8} c="var(--gold)" style={{ letterSpacing: '.1em' }}>custom</Caps>}
                                </span>
                                <span style={{ flex: 1, fontFamily: FONT_MONO, fontSize: 10.5, color: (selector && selector.trim()) ? dimWhite(.5) : 'var(--gold)', wordBreak: 'break-all' }}>{(selector && selector.trim()) ? selector : '— unassigned'}</span>
                                {/* fix/cua-repoint-column — point a BUILT-IN field at the right
                                    page column. Options = ALL captured page columns (the geometry),
                                    not just unassigned ones. */}
                                {!custom && editable && (() => {
                                  const setBusy = colBusy === `set:${f.key}:${c}`;
                                  if (setBusy) return <Loader2 size={11} style={{ animation: 'spin 1s linear infinite', color: dimWhite(.5), flexShrink: 0 }} />;
                                  const geoCols = (captures[capKey]?.geometry?.columns ?? []).filter((g) => g.header && g.header.trim().length > 0);
                                  if (geoCols.length === 0) {
                                    return (
                                      <button onClick={() => { captureReqRef.current.delete(capKey); void requestLiveCapture(capKey); }} disabled={!!liveJobId}
                                        title="Read the page so you can re-point this field"
                                        style={{ flexShrink: 0, background: 'transparent', border: 'none', color: 'var(--gold)', textDecoration: 'underline', cursor: liveJobId ? 'default' : 'pointer', fontFamily: FONT_MONO, fontSize: 10, padding: 0, opacity: liveJobId ? .5 : 1 }}>re-read to fix</button>
                                    );
                                  }
                                  return (
                                    <select value="" disabled={!!liveJobId}
                                      onChange={(e) => { const idx = Number(e.target.value); if (Number.isInteger(idx) && idx >= 1) repointColumn(f, c, idx); }}
                                      title="Point this field at the correct page column"
                                      style={{ flexShrink: 0, background: dimWhite(.06), color: '#fff', border: `1px solid ${dimWhite(.2)}`, borderRadius: 6, padding: '2px 6px', fontFamily: FONT_SANS, fontSize: 10.5, cursor: 'pointer' }}>
                                      <option value="" style={{ color: '#000' }}>fix → point at…</option>
                                      {geoCols.map((g) => <option key={g.index} value={g.index} style={{ color: '#000' }}>{g.header}</option>)}
                                    </select>
                                  );
                                })()}
                              </div>
                            );
                          };
                          return (
                            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {colNames.map((c) => ColRow(c, f.columns[c], false))}
                              {customNames.map((c) => ColRow(c, f.customColumns[c], true))}

                              {/* Add an extra page column (custom → stored in the
                                  feed's "extras" bucket). Editable table feeds only. */}
                              {editable && f.canTakeover && (() => {
                                const cap = captures[capKey];
                                const hasDrag = !!(cap && cap.url && cap.geometry && (cap.geometry.columns.length > 0 || (cap.geometry.values?.length ?? 0) > 0));
                                const hasDropdown = f.availablePageColumns.length > 0;
                                const cancel = () => { setAddColFeed(null); setAddColIndex(''); setAddColName(''); setAddColSelector(''); setAddColScope('row'); setDragColFeed(null); };
                                if (addColFeed !== f.key) {
                                  return (
                                    <button
                                      onClick={() => { setAddColFeed(f.key); setAddColIndex(''); setAddColName(''); setAddColSelector(''); setAddColScope('row'); setDragColFeed(null); if (!hasDrag) void openAddColumn(capKey); }}
                                      disabled={!!liveJobId}
                                      style={{ marginTop: 6, alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: `1px dashed ${dimWhite(.25)}`, borderRadius: 7, cursor: 'pointer', padding: '5px 9px', fontFamily: FONT_SANS, fontSize: 11.5, color: dimWhite(.7) }}
                                    >
                                      <Plus size={11} /> Add a column from this page
                                    </button>
                                  );
                                }
                                // Drag-on-screenshot mode.
                                if (dragColFeed === f.key && hasDrag) {
                                  return (
                                    <div style={{ marginTop: 8, padding: '8px 10px', background: dimWhite(.04), borderRadius: 8 }}>
                                      <DragToCaptureView url={cap!.url!} geometry={cap!.geometry!} onPick={(r: FreeformResolution) => {
                                        if (r.kind === 'column') {
                                          setAddColScope('row');
                                          setAddColSelector(`td:nth-child(${r.column.index})`);
                                          setAddColIndex('');
                                          if (r.column.header) setAddColName(slugifyHeader(r.column.header));
                                          setDragColFeed(null);
                                        } else if (r.kind === 'value') {
                                          setAddColScope('page');
                                          setAddColSelector(r.value.selector);
                                          setAddColIndex('');
                                          // Name from the label beside the datum when present ("Guest
                                          // Count:" → guest_count), else the value text. (Editable.)
                                          setAddColName(slugifyValue(r.labelText ?? r.value.text));
                                          setDragColFeed(null);
                                        }
                                        // unknown → DragToCaptureView shows "couldn't tell…"; stay in drag mode so the founder can re-drag (the human-loop).
                                      }} />
                                      <Btn variant="ghost" size="sm" onClick={() => setDragColFeed(null)} style={{ marginTop: 6, color: dimWhite(.6), borderColor: dimWhite(.2) }}>Cancel drag</Btn>
                                    </div>
                                  );
                                }
                                // Picker row: dropdown (if detected) + drag button (if geometry) + name + Add.
                                if (!hasDropdown && !hasDrag) {
                                  const capturing = !!cap?.capturing;
                                  const capErr = cap?.captureError;
                                  const linkStyle: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--gold)', textDecoration: 'underline', cursor: 'pointer', fontFamily: FONT_MONO, fontSize: 10.5, padding: 0 };
                                  const remap = f.actionKey ? (
                                    <button onClick={() => { cancel(); void startEditOrAdd(f.actionKey!, 'edit'); }} disabled={!!liveJobId} style={{ ...linkStyle, opacity: liveJobId ? .5 : 1 }}>Re-map this feed</button>
                                  ) : null;
                                  return (
                                    <div style={{ marginTop: 6, fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.5), display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                      {capturing ? (
                                        <>
                                          <Loader2 size={11} style={{ animation: 'spin 1s linear infinite', color: 'var(--gold)' }} />
                                          The robot is reading this page so you can drag on it — a few seconds…
                                        </>
                                      ) : capErr === 'no_table' ? (
                                        <>Couldn&apos;t find a table to drag on this page — it may not be an on-screen table, or the robot&apos;s login expired.{remap && <>{' '}{remap}.</>}</>
                                      ) : capErr === 'timeout' ? (
                                        <>This took too long.{' '}<button onClick={() => { captureReqRef.current.delete(capKey); void requestLiveCapture(capKey); }} style={linkStyle}>try again</button>{remap && <>, or {remap}</>}.</>
                                      ) : capErr ? (
                                        <>{capErr}{remap && <>{' '}{remap}.</>}</>
                                      ) : (
                                        <>No drag-map yet —{' '}<button onClick={() => { captureReqRef.current.delete(capKey); void requestLiveCapture(capKey); }} style={linkStyle}>capture this page</button> so you can drag on it.</>
                                      )}
                                      {' '}<button onClick={cancel} style={{ ...linkStyle, color: dimWhite(.5) }}>cancel</button>
                                    </div>
                                  );
                                }
                                return (
                                  <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px', background: dimWhite(.04), borderRadius: 8 }}>
                                    {hasDropdown && (
                                      <select
                                        value={addColIndex}
                                        onChange={(e) => {
                                          setAddColIndex(e.target.value); setAddColSelector(''); setAddColScope('row');
                                          const hdr = f.availablePageColumns.find((p) => String(p.index) === e.target.value);
                                          if (hdr) setAddColName(slugifyHeader(hdr.header));
                                        }}
                                        style={{ background: dimWhite(.06), color: '#fff', border: `1px solid ${dimWhite(.2)}`, borderRadius: 6, padding: '6px 8px', fontFamily: FONT_SANS, fontSize: 12 }}
                                      >
                                        <option value="" style={{ color: '#000' }}>Column on the page…</option>
                                        {f.availablePageColumns.map((p) => (
                                          <option key={p.index} value={p.index} style={{ color: '#000' }}>{p.header}</option>
                                        ))}
                                      </select>
                                    )}
                                    {hasDrag && (
                                      <Btn variant="ghost" size="sm" onClick={() => setDragColFeed(f.key)} style={{ color: '#fff', borderColor: dimWhite(.25) }}>
                                        <MousePointerClick size={11} /> {hasDropdown ? 'Other — pick on the screenshot' : 'Pick anywhere on the screenshot'}
                                      </Btn>
                                    )}
                                    {addColSelector && <Caps size={8} c="var(--forest)" style={{ letterSpacing: '.08em' }}>{addColScope === 'page' ? 'value' : 'column'}</Caps>}
                                    <input
                                      value={addColName}
                                      onChange={(e) => setAddColName(e.target.value)}
                                      placeholder="name (e.g. rate_plan)"
                                      style={{ background: dimWhite(.06), color: '#fff', border: `1px solid ${dimWhite(.2)}`, borderRadius: 6, padding: '6px 8px', fontFamily: FONT_MONO, fontSize: 11.5, width: 150 }}
                                    />
                                    <Btn variant="forest" size="sm" disabled={(!addColIndex && !addColSelector) || !addColName.trim() || colBusy === `add:${f.key}`} onClick={() => addCustomColumn(f)}>
                                      {colBusy === `add:${f.key}` ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={11} />} Add
                                    </Btn>
                                    <Btn variant="ghost" size="sm" onClick={cancel} style={{ color: dimWhite(.6), borderColor: dimWhite(.2) }}>Cancel</Btn>
                                  </div>
                                );
                              })()}

                              {/* feature/cua-admin-mapper-visibility — the source
                                  screen the robot read, ABOVE the row sample. */}
                              <FeedCaptureView state={captures[capKey]} onError={() => handleCaptureError(capKey)} />
                              {f.sample.length > 0 && (() => {
                                // Surface the custom (raw bucket) values FIRST so a
                                // founder sees the column they added is actually being
                                // captured (the full row is truncated below it).
                                const row0 = f.sample[0];
                                const raw = row0 && typeof row0.raw === 'object' && row0.raw
                                  ? (row0.raw as Record<string, unknown>) : null;
                                return (
                                  <div style={{ marginTop: 8 }}>
                                    {raw && Object.keys(raw).length > 0 && (
                                      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: 'var(--gold)', marginBottom: 4, wordBreak: 'break-all' }}>
                                        extras: {Object.entries(raw).map(([k, v]) => `${k}=${String(v)}`).join('  ·  ').slice(0, 300)}
                                      </div>
                                    )}
                                    <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: dimWhite(.4), wordBreak: 'break-all' }}>
                                      sample: {JSON.stringify(row0).slice(0, 240)}
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          );
                        })()}
                      </DarkCard>
                    );
                  })}
                </div>

                {/* Add a feed — pick from the robot's full catalog of feed types not
                    yet captured. Works on a live map AND a parked draft (the draft path
                    seeds from the draft via draftId and stays parked until you publish). */}
                {map.editable && data.addableFeeds.length > 0 && (
                  <DarkCard style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Plus size={16} color="var(--forest)" />
                    <span style={{ fontSize: 13, color: '#fff' }}>Add a data point</span>
                    <select
                      value={addKey}
                      onChange={(e) => setAddKey(e.target.value)}
                      style={{ flex: 1, minWidth: 200, background: dimWhite(.06), color: '#fff', border: `1px solid ${dimWhite(.2)}`,
                        borderRadius: 8, padding: '7px 10px', fontFamily: FONT_SANS, fontSize: 12.5 }}
                    >
                      <option value="" style={{ color: '#000' }}>Choose a feed to add…</option>
                      {data.addableFeeds.map((a) => (
                        <option key={a.actionKey} value={a.actionKey} style={{ color: '#000' }}>{a.label}</option>
                      ))}
                    </select>
                    <Btn variant="forest" size="sm" disabled={!addKey || !!busy} onClick={() => void startEditOrAdd(addKey, 'add')}>
                      {busy === `add:${addKey}` ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={12} />} Add via takeover
                    </Btn>
                  </DarkCard>
                )}

                <div style={{ marginTop: 16, fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.4), display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Eye size={11} /> {isDraft
                    ? 'Review every feed, remove anything wrong, then “Make live” to publish this map for the family.'
                    : 'Edit / Add open the live board so you can drive the robot to the right page and press Finish.'}
                </div>
              </>
            )}

            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
        </SurfaceShell>

        {/* fix/cua-freeform-capture — "Captured": what the robot last read off each
            feed (field name → current value), so the founder can SEE what's being
            captured (incl. blanks + dragged custom columns) before the map is live. */}
        {data && data.feeds.length > 0 && (
          <div style={{ marginTop: 18, padding: '18px 20px', background: dimWhite(.03), border: `1px solid ${dimWhite(.08)}`, borderRadius: 14 }}>
            <Caps size={11} c="var(--gold)" style={{ letterSpacing: '.14em' }}>Captured</Caps>
            <div style={{ fontFamily: FONT_SANS, fontSize: 12, color: dimWhite(.5), margin: '5px 0 16px' }}>
              What the robot last read off each feed — field name and its current value.{' '}
              {data.activeMap?.isDraft && <span style={{ color: dimWhite(.62) }}>This map isn’t live yet, so these are one-time previews — make it live to keep collecting.</span>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {data.feeds.map((f) => {
                const key = f.actionKey ?? f.key;
                const s = samples[key];
                const busy = !!recapturing[key];
                return (
                  <div key={key} style={{ padding: '12px 14px', background: dimWhite(.04), borderRadius: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: s && (s.fields.length || (s.pageValues?.length ?? 0)) ? 10 : 0, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: FONT_SERIF, fontSize: 15, color: '#fff' }}>{f.label}</span>
                      {/* feature/coverage-gated-feeds — collection state chip. On a
                          DRAFT it PREDICTS from the preview (has a sample → will
                          collect once live); on a LIVE map it reflects the server's
                          disabled_feeds (off until a Re-read turns it on). Both read
                          the same artifacts promote uses, so it can't drift. */}
                      {(() => { const c = collectionChip(f); return c ? <Pill tone={c.tone}>{c.label}</Pill> : null; })()}
                      {s && <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dimWhite(.45) }}>{s.rowCount} row{s.rowCount === 1 ? '' : 's'}{s.capturedAt && timeAgo(s.capturedAt) ? ` · ${timeAgo(s.capturedAt)}` : ''}</span>}
                      <button
                        onClick={() => void recaptureFeed(key)}
                        disabled={busy || !!liveJobId}
                        style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: 'var(--gold)', cursor: busy ? 'default' : 'pointer', fontFamily: FONT_MONO, fontSize: 10.5, textDecoration: 'underline', padding: 0, opacity: busy || liveJobId ? .6 : 1 }}
                      >
                        {busy ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={11} />} {busy ? 'Reading…' : 'Re-read'}
                      </button>
                    </div>
                    {/* Feed-level PAGE totals (e.g. "Guest Count: 23") — one per feed, shown
                        distinctly above the per-row columns. */}
                    {s && s.pageValues && s.pageValues.length > 0 && (
                      <div style={{ marginBottom: s.fields.length > 0 ? 10 : 0, padding: '7px 10px', background: 'rgba(212,175,55,0.07)', border: '1px solid rgba(212,175,55,0.22)', borderRadius: 8 }}>
                        <div style={{ fontFamily: FONT_MONO, fontSize: 9.5, letterSpacing: .5, textTransform: 'uppercase', color: 'var(--gold)', marginBottom: 5 }}>Page totals · one per feed</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '4px 16px' }}>
                          {s.pageValues.map((pv, i) => (
                            <div key={i} style={{ display: 'flex', gap: 8, fontFamily: FONT_MONO, fontSize: 11.5, minWidth: 0 }}>
                              <span style={{ color: dimWhite(.55), whiteSpace: 'nowrap' }}>{pv.name}</span>
                              <span title={pv.value} style={{ color: pv.value ? '#fff' : 'var(--gold)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pv.value || '— blank'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {s && s.fields.length > 0 ? (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '5px 16px' }}>
                        {s.fields.map((fld, i) => (
                          <div key={i} style={{ display: 'flex', gap: 8, fontFamily: FONT_MONO, fontSize: 11.5, minWidth: 0 }}>
                            <span style={{ color: dimWhite(.5), whiteSpace: 'nowrap' }}>{fld.name}</span>
                            <span title={fld.value} style={{ color: fld.value ? '#fff' : 'var(--gold)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fld.value || '— blank'}</span>
                          </div>
                        ))}
                      </div>
                    ) : (!s || !s.pageValues || s.pageValues.length === 0) ? (
                      <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.4) }}>
                        {busy ? 'Reading the page…' : 'Not read yet — hit Re-read to pull the live values.'}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Delete confirm */}
        {pendingDelete && (
          <Backdrop onClose={deleteBusy ? () => {} : () => { setPendingDelete(null); setDeleteError(null); }}>
            <div onClick={(e) => e.stopPropagation()} style={{ ...MODAL_CARD, width: 460 }}>
              <h3 style={{ fontFamily: FONT_SERIF, fontSize: 21, fontWeight: 500, margin: '0 0 10px', color: 'var(--ink)' }}>
                Remove “{pendingDelete.label}”?
              </h3>
              <div style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.6 }}>
                {isDraft ? (
                  <>Drop <b>{pendingDelete.label}</b> from this draft so it isn’t carried in when you make the map live. Nothing is live yet — you can re-learn it later.</>
                ) : (
                  <>The robot will stop capturing <b>{pendingDelete.label}</b> for every {data?.familyLabel} hotel. The map is re-published without it — you can re-add it later.
                    <span style={{ display: 'flex', gap: 7, alignItems: 'flex-start', marginTop: 12, padding: '9px 11px', borderRadius: 10, background: 'rgba(194,86,46,.08)', border: '1px solid rgba(194,86,46,.3)', color: 'var(--terracotta-deep)', fontSize: 12.5 }}>
                      <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                      <span>This affects all {data?.hotelsOnFamily} hotel{data?.hotelsOnFamily === 1 ? '' : 's'} on this PMS.</span>
                    </span>
                  </>
                )}
              </div>
              {deleteError && (
                <div style={{ marginTop: 14, borderRadius: 10, border: '1px solid rgba(194,86,46,.4)', background: 'rgba(194,86,46,.08)', padding: '9px 12px', fontSize: 12.5, color: 'var(--terracotta-deep)' }}>
                  {deleteError}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 22 }}>
                <Btn size="md" variant="ghost" onClick={() => { setPendingDelete(null); setDeleteError(null); }} disabled={deleteBusy}>Cancel</Btn>
                <Btn size="md" variant="terracotta" onClick={() => void confirmDelete()} disabled={deleteBusy}>{deleteBusy ? 'Removing…' : (isDraft ? 'Remove from draft' : 'Remove feed')}</Btn>
              </div>
            </div>
          </Backdrop>
        )}

        {/* Make live (promote draft) confirm */}
        {pendingPromote && map?.isDraft && (
          <Backdrop onClose={promoteBusy ? () => {} : () => { setPendingPromote(false); setPromoteError(null); }}>
            <div onClick={(e) => e.stopPropagation()} style={{ ...MODAL_CARD, width: 460 }}>
              <h3 style={{ fontFamily: FONT_SERIF, fontSize: 21, fontWeight: 500, margin: '0 0 10px', color: 'var(--ink)' }}>
                Make this map live for every {data?.familyLabel} hotel?
              </h3>
              <div style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.6 }}>
                The robot will start using map <b>v{map.version}</b> to read every {data?.familyLabel} hotel right away. You can edit or remove individual feeds afterward.
                {/* feature/coverage-gated-feeds — plain-English preview of what
                    WILL and WON'T collect, computed from the same previews the
                    chips use. "Goes live collecting N of M feeds: …. The other K
                    stay off until you preview them working." */}
                <span style={{ display: 'block', marginTop: 12, padding: '10px 12px', borderRadius: 10, background: 'rgba(60,156,104,.08)', border: '1px solid rgba(60,156,104,.3)', fontSize: 12.5, color: 'var(--forest-deep)' }}>
                  Goes live collecting <b>{willCollect.length}</b> of <b>{totalFeeds}</b> feed{totalFeeds === 1 ? '' : 's'}
                  {willCollect.length > 0 && <>: {willCollect.map((f) => f.label).join(', ')}</>}.
                  {willStayOff.length > 0 && (
                    <span style={{ display: 'block', marginTop: 6, color: 'var(--ink-soft)' }}>
                      The other <b>{willStayOff.length}</b> ({willStayOff.map((f) => f.label).join(', ')}) stay off until you preview them working — Re-read any feed to turn it on later.
                    </span>
                  )}
                </span>
                <span style={{ display: 'flex', gap: 7, alignItems: 'flex-start', marginTop: 12, padding: '9px 11px', borderRadius: 10, background: 'rgba(60,156,104,.08)', border: '1px solid rgba(60,156,104,.3)', color: 'var(--forest)', fontSize: 12.5 }}>
                  <Check size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>This goes live for all {data?.hotelsOnFamily} hotel{data?.hotelsOnFamily === 1 ? '' : 's'} on this PMS.</span>
                </span>
              </div>
              {promoteError && (
                <div style={{ marginTop: 14, borderRadius: 10, border: '1px solid rgba(194,86,46,.4)', background: 'rgba(194,86,46,.08)', padding: '9px 12px', fontSize: 12.5, color: 'var(--terracotta-deep)' }}>
                  {promoteError}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 22 }}>
                <Btn size="md" variant="ghost" onClick={() => { setPendingPromote(false); setPromoteError(null); }} disabled={promoteBusy}>Cancel</Btn>
                <Btn size="md" variant="forest" onClick={() => void confirmPromote()} disabled={promoteBusy}>{promoteBusy ? 'Making live…' : 'Make live'}</Btn>
              </div>
            </div>
          </Backdrop>
        )}
      </DarkScope>
    </AppLayout>
  );
}
