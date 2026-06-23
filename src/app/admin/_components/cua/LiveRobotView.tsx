'use client';

/**
 * SHARED — "Robot's screen" live view.
 *
 * Extracted from /admin/properties/mapper/[jobId] so the same continuous live
 * robot-screen card can be embedded anywhere (the live board, and future
 * surfaces). It is FULLY self-contained: it self-fetches frames, runs its own
 * broadcast subscription, BOTH heartbeats, and the poll fallbacks, hydrates its
 * own job status, and computes its own freshness. The host only passes the
 * jobId and (optionally) the Take-over affordance.
 *
 * CRITICAL — the per-job heartbeat lives HERE. The worker (cua-service
 * live-frame.ts) only tees frames to storage while BOTH the global admin
 * heartbeat (accounts.last_seen_at) AND the per-job heartbeat
 * (POST /api/admin/mapper/live/[jobId]) are fresh. Without the per-job ping the
 * embedded view would stay blank forever — so this component owns it.
 *
 * Realtime: broadcast channel `mapping:{jobId}` — only the `live_frame` event
 * matters here (it nudges a frame refetch). All other events are ignored (the
 * host board owns the full-state refetch). Poll fallbacks cover a dropped
 * channel / RLS-silent realtime.
 *
 * feature/cua-live-view + feature/cua-admin-mapper-visibility.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { supabase } from '@/lib/supabase';
import { FONT_MONO, Pill, Caps, Btn } from '@/app/admin/_components/studio/kit';
import { DarkCard, dimWhite } from '@/app/admin/_components/studio/surface-kit';
import {
  parseCurrentActivity, phaseLabel, isInProgressPhase, prettifyTargetKey,
  isTerminalJobStatus,
} from '@/lib/pms/learning-board';
import { CheckCircle2, CircleSlash, Loader2, MousePointerClick } from 'lucide-react';

/** feature/cua-live-view — latest live frame, served by
 *  /api/admin/mapper/live/[jobId]/frame (short-lived signed URL into the
 *  private bucket; the robot only uploads while an admin heartbeat is
 *  fresh, so this exists only while someone is watching). */
interface LiveFrameState {
  url: string;
  /** Storage object timestamp — drives the "Xs ago" label. */
  updatedAt: string | null;
}

interface LiveRobotViewProps {
  jobId: string;
  canStartTakeover?: boolean;
  onStartTakeover?: () => void;
}

/**
 * The robot's screen, continuously. Self-fetches frames and hydrates its own
 * job status (for the running-gate + live phase line). Renders nothing unless
 * the job is running and nothing else owns the screen.
 */
export function LiveRobotView({ jobId, canStartTakeover, onStartTakeover }: LiveRobotViewProps) {
  const { user } = useAuth();

  // Job status + result, hydrated locally so this component can self-gate on
  // running + draw the live phase line without prop-drilling the whole job.
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [jobResult, setJobResult] = useState<Record<string, unknown> | null>(null);
  // feature/cua-live-view — the robot's latest screen (continuous live view).
  const [liveFrame, setLiveFrame] = useState<LiveFrameState | null>(null);
  // Re-render tick so the "Xs ago" freshness label stays honest.
  const [frameTick, setFrameTick] = useState(0);

  const frameFetchBusyRef = useRef(false);
  // A live_frame event landing while a fetch is in flight must not be
  // dropped (it may be the LAST frame before a long pause) — coalesce it
  // into one follow-up fetch.
  const frameFetchQueuedRef = useRef(false);
  // Generation token: bumped when the job changes (or the component unmounts)
  // so a slow in-flight frame fetch can never commit another job's screen
  // — or set state after unmount.
  const frameGenRef = useRef(0);

  // Hydrate job status/result for the running-gate + the live phase line. This
  // ALSO drives the per-job heartbeat's companion — load() runs on mount and
  // on every broadcast/poll so the phase + status survive a reload.
  const load = async () => {
    try {
      const res = await fetchWithAuth(`/api/admin/mapper/live/${jobId}`);
      const json = await res.json();
      if (json.ok && json.data?.job) {
        setJobStatus((json.data.job.status as string | null) ?? null);
        setJobResult((json.data.job.result as Record<string, unknown> | null) ?? null);
      }
    } catch {
      // Network hiccup — the next broadcast/poll retries.
    }
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

  // One initial hydrate + frame fetch when the job changes; tear down in-flight
  // frame fetches on unmount / job switch.
  useEffect(() => {
    if (!jobId) return;
    setLiveFrame(null); // never show a previous job's screen on this one
    void load();
    void fetchFrame();
    return () => {
      // Invalidate in-flight frame fetches (job switch or unmount).
      frameGenRef.current += 1;
      frameFetchQueuedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Heartbeat ping while this tab is open AND VISIBLE. Two signals, both
  // visibility-gated so a backgrounded tab can't impersonate a watching founder:
  //   - global /api/admin/heartbeat (accounts.last_seen_at) → gates
  //     cua-service/src/live-frame.ts's "robot's screen" tee.
  //   - per-job POST /api/admin/mapper/live/[jobId] (feature/cua-polish) →
  //     gates human-assist.ts's PER-JOB help hold AND the frame tee. Without
  //     this ping the worker never tees a frame, so the view stays blank.
  useEffect(() => {
    if (!user || user.role !== 'admin') return;
    const ping = () => {
      if (document.visibilityState !== 'visible') return;
      void fetchWithAuth('/api/admin/heartbeat', { method: 'POST' });
      if (jobId) void fetchWithAuth(`/api/admin/mapper/live/${jobId}`, { method: 'POST' });
    };
    ping();
    const t = setInterval(ping, 30_000);
    document.addEventListener('visibilitychange', ping);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', ping);
    };
  }, [user, jobId]);

  // Subscribe to the broadcast activity channel — but only act on live_frame
  // here (a metadata-only nudge that fires every few seconds while the robot
  // works). The host board owns the full-state refetch on other events; this
  // component only refreshes the frame (and hydrates its own status via the
  // poll below). Refresh job status too on a live_frame so the running-gate +
  // phase line keep up cheaply.
  useEffect(() => {
    if (!jobId) return;
    const ch = supabase
      .channel(`mapping-liveview:${jobId}`)
      .on('broadcast' as any, { event: '*' }, (msg: { event: string; payload?: { type?: string } }) => {
        if (msg.event === 'live_frame' || msg.payload?.type === 'live_frame') {
          void fetchFrame();
        }
      })
      .subscribe();
    return () => { void ch.unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Slow safety poll while the job is live. Catches a dropped broadcast or an
  // RLS-silent realtime channel. 30s is cheap; it stops once the job is
  // terminal. Refreshes BOTH the frame and the status/phase.
  useEffect(() => {
    if (!jobId) return;
    if (isTerminalJobStatus(jobStatus)) return;
    const t = setInterval(() => { void load(); void fetchFrame(); }, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, jobStatus]);

  // Keep the live PHASE line moving during long think-gaps that emit no
  // broadcast. Visibility-gated (a forgotten background tab adds no DB load),
  // stopped the instant the job is terminal. The 30s poll above is the floor.
  useEffect(() => {
    if (!jobId || jobStatus !== 'running') return;
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const t = setInterval(tick, 5_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, jobStatus]);

  // feature/cua-live-view — keep the "Xs ago" freshness label honest while
  // a frame is showing. Re-render only; no fetching.
  useEffect(() => {
    if (!liveFrame) return;
    if (isTerminalJobStatus(jobStatus)) return;
    const t = setInterval(() => setFrameTick((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, [liveFrame, jobStatus]);

  // feature/cua-admin-mapper-visibility — the single live phase line: what the
  // robot is doing RIGHT NOW, from the durable result.currentActivity. Older
  // jobs never wrote it → livePhase is null and the indicator is simply absent.
  const currentActivity = useMemo(() => parseCurrentActivity(jobResult), [jobResult]);
  const livePhase = useMemo(() => {
    if (!currentActivity?.phase) return null;
    const noun = currentActivity.feedKey ? prettifyTargetKey(currentActivity.feedKey) : '';
    const text = phaseLabel(currentActivity.phase, noun);
    return text ? { text, phase: currentActivity.phase, pct: currentActivity.pct } : null;
  }, [currentActivity]);

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

  // Only paint the card while the run is actively working. The host decides
  // WHEN to mount this (no help panel / takeover owning the screen), but we
  // also self-gate on running so a terminal job doesn't show a stale screen.
  if (jobStatus !== 'running') return null;

  return (
    <DarkCard style={{ padding: '16px 20px', marginBottom: 16 }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
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
        {/* feature/cua-admin-mapper-visibility — the live phase line.
            No auto-margin of its own: it flows at the end of the left
            cluster, and the Take over button's marginLeft:auto pushes
            itself to the far right, leaving this to its LEFT. Absent
            for older jobs that never wrote currentActivity. */}
        {livePhase && (
          <span
            title="What the robot is doing right now"
            style={{
              display: 'inline-flex', alignItems: 'center',
              gap: 6, minWidth: 0, maxWidth: 380,
              fontFamily: FONT_MONO, fontSize: 11,
              color: isInProgressPhase(livePhase.phase) ? 'var(--gold)' : dimWhite(.66),
              background: isInProgressPhase(livePhase.phase) ? 'rgba(201,154,46,.12)' : 'rgba(255,255,255,.05)',
              border: `1px solid ${isInProgressPhase(livePhase.phase) ? 'rgba(201,154,46,.4)' : dimWhite(.16)}`,
              borderRadius: 999, padding: '3px 11px',
            }}
          >
            {isInProgressPhase(livePhase.phase)
              ? <Loader2 size={11} style={{ animation: 'spin 1.5s linear infinite', flexShrink: 0 }} />
              : livePhase.phase === 'found'
                ? <CheckCircle2 size={11} color="var(--forest)" style={{ flexShrink: 0 }} />
                : <CircleSlash size={11} style={{ flexShrink: 0 }} />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {livePhase.text}{typeof livePhase.pct === 'number' ? ` · ${livePhase.pct}%` : ''}
            </span>
          </span>
        )}
        {/* feature/cua-live-assist — pause the robot and drive it yourself
            (only while a feed is actively searching). The host owns the
            eligibility logic + the actual takeover call. */}
        {canStartTakeover && onStartTakeover && (
          <Btn variant="forest" size="sm" onClick={() => onStartTakeover()} style={{ marginLeft: 'auto' }}>
            <MousePointerClick size={13} /> Take over
          </Btn>
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
  );
}
