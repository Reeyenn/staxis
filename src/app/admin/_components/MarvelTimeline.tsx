'use client';

/**
 * Loki / Marvel TVA "sacred timeline" view of the build pipeline.
 *
 * One thick glowing line runs left → right (past → present). NO commit
 * dots, no SHA labels — that detail belongs in `git log`, not in the
 * vibe. Branches show up as colored tendrils that arc OUT from the
 * line at the point they diverged. Two flavors:
 *
 *   - Active branches: arc out and END at a pulsing dot — work that
 *     hasn't merged into main yet.
 *   - Merged branches: arc out from divergence and BACK INTO the line
 *     at the merge commit — branches that "came home."
 *
 * Hovering an arc reveals the branch name + last commit message; click
 * jumps to GitHub. Deploy markers are subtle glowing dots ON the line
 * (no vertical pins). The right-most point of the line is the brightest
 * — that's "now."
 */

import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';

interface Commit {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  ts: string;
  url: string;
}

interface Deploy {
  target: 'vercel-website' | 'fly-cua';
  commitSha: string | null;
  shortSha: string | null;
  deployedAt: string | null;
  url: string;
}

interface Worktree {
  name: string;
  branch: string | null;
  lastActivity: string | null;
}

interface Branch {
  name: string;
  shortSha: string;
  latestMessage: string;
  latestTs: string | null;
  aheadOfMain: number;
  behindMain: number;
  url: string;
}

interface MergedBranch {
  branchName: string;
  mergeCommitSha: string;
  mergedAt: string;
  title: string;
  url: string;
  commitCount: number;
}

interface ActiveSession {
  session_id: string;
  branch: string | null;
  current_tool: string | null;
  last_heartbeat: string;
}

const ACTIVE_PALETTE = ['#fb7185', '#a78bfa', '#34d399', '#60a5fa', '#facc15', '#f472b6'];
const MERGED_PALETTE = ['#7dd3fc', '#fcd34d', '#86efac', '#f9a8d4', '#c4b5fd', '#fdba74'];

// "Live" = a single commit in the last 60s. Brief flash, like "just
// pushed!", then quiets down.
const LIVE_WINDOW_MS = 60 * 1000;

export function MarvelTimeline({
  commits, deploys, worktrees, branches, merged, mainLatestTs, activeSessions,
}: {
  commits: Commit[];
  deploys: Deploy[];
  worktrees: Worktree[];
  branches?: Branch[];
  merged?: MergedBranch[];
  mainLatestTs?: string | null;
  activeSessions?: ActiveSession[];
}) {
  const [hoverBranch, setHoverBranch] = useState<Branch | null>(null);
  const [hoverMerged, setHoverMerged] = useState<MergedBranch | null>(null);

  // Live-state derivation. Recomputed every render — combined with the
  // 2s cursor + 60s background refresh in SystemTab, this gives sub-3s
  // "is X being worked on right now" detection.
  const now = Date.now();
  const isLiveTs = (ts: string | null | undefined): boolean =>
    !!ts && (now - new Date(ts).getTime()) < LIVE_WINDOW_MS;
  const mainIsLive = isLiveTs(mainLatestTs ?? commits[0]?.ts ?? null);

  // Commit count for "today" — local-time start-of-day. The build-status
  // API fetches the last 100 commits, so this is exact for any normal
  // day. On the rare day we exceed 100, we surface "100+" so the cap
  // is visible rather than silently wrong.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTodayMs = startOfToday.getTime();
  const commitsTodayCount = commits.filter(
    (c) => new Date(c.ts).getTime() >= startOfTodayMs,
  ).length;
  const commitsTodayCapped = commitsTodayCount >= commits.length && commits.length >= 100;
  const commitsTodayLabel = commitsTodayCapped
    ? `${commits.length}+ commits today`
    : `${commitsTodayCount} commit${commitsTodayCount === 1 ? '' : 's'} today`;

  // Geometry — wide & airy so the line breathes.
  const width = 1100;
  const padding = 50;
  const trunkY = 170;
  const innerW = width - padding * 2;
  const ordered = [...commits].reverse();          // oldest left → newest right
  const step = ordered.length > 1 ? innerW / (ordered.length - 1) : 0;
  const positionFor = (i: number) => padding + i * step;
  const latestX = positionFor(ordered.length - 1);

  // Render EVERY active branch — Reeyen's rule is "I need to see
  // everything on the timeline, nothing hidden." We don't slice the
  // list; instead we adapt the lane spacing + SVG height to fit.
  //
  // Two sources, deduped by name:
  //   1. branches[] from GitHub — pushed branches with diverged commits.
  //   2. activeSessions[] — branches where a Claude session is heart-
  //      beating right now. Includes brand-new branches that haven't
  //      been pushed yet (so the visual shows the work immediately,
  //      not after the first commit lands on GitHub).
  const githubBranches = branches ?? [];
  const githubBranchNames = new Set(githubBranches.map((b) => b.name));
  const sessionOnlyBranches: Branch[] = [];
  for (const s of activeSessions ?? []) {
    const name = s.branch;
    if (!name || name === 'main' || name === 'master') continue;
    if (githubBranchNames.has(name)) continue;
    if (sessionOnlyBranches.some((b) => b.name === name)) continue;
    sessionOnlyBranches.push({
      name,
      shortSha: '',
      latestMessage: '(active session — no commits yet)',
      latestTs: s.last_heartbeat ?? null,
      aheadOfMain: 0,
      behindMain: 0,
      url: `https://github.com/Reeyenn/staxis/tree/${encodeURIComponent(name)}`,
    });
  }
  const branchList: Branch[] = [...githubBranches, ...sessionOnlyBranches];
  const mergedList = merged ?? [];

  // Per-side lane geometry. With few branches we use roomy spacing;
  // with many we tighten so they all fit without making the SVG huge.
  const lanesPerSide = Math.ceil(branchList.length / 2);
  const baseLaneOffset = lanesPerSide <= 3 ? 60 : lanesPerSide <= 6 ? 50 : 40;
  const laneStep = lanesPerSide <= 3 ? 30 : lanesPerSide <= 6 ? 22 : 16;
  const maxLaneY = baseLaneOffset + Math.max(0, lanesPerSide - 1) * laneStep;

  // ── Merge animation: when a branch disappears between data refreshes,
  // play it as a tendril sliding inward into the main timeline at NOW
  // instead of just popping out. Tracks the LAST observed geometry of
  // each branch so we can replay it during the exit animation. ──────
  type MergingTendril = {
    name: string;
    color: string;
    startX: number;
    cx1: number; cy1: number;
    cx2: number; cy2: number;
    tipX: number;
    yOffset: number;
    triggeredAt: number;
  };
  const prevBranchListRef = useRef<Branch[]>([]);
  const [mergingTendrils, setMergingTendrils] = useState<MergingTendril[]>([]);
  // Per-frame animation state, keyed by tendril name. progress 0 → 1 over
  // MERGE_DURATION_MS. Driven by requestAnimationFrame, NOT SVG SMIL —
  // SMIL animations on path d are unreliable in some Chrome versions
  // and silently no-op'd the previous two attempts.
  const [mergeProgress, setMergeProgress] = useState<Map<string, number>>(new Map());

  // Helper: same lane / curve math used in the live render loop, factored
  // out so the merge animation can reproduce the exact path the tendril
  // had on its last frame before disappearing.
  const computeBranchGeo = (b: Branch, i: number, total: number) => {
    const lanesPerSideLocal = Math.ceil(total / 2);
    const baseLaneOffsetLocal = lanesPerSideLocal <= 3 ? 60 : lanesPerSideLocal <= 6 ? 50 : 40;
    const laneStepLocal = lanesPerSideLocal <= 3 ? 30 : lanesPerSideLocal <= 6 ? 22 : 16;
    const color = ACTIVE_PALETTE[i % ACTIVE_PALETTE.length];
    const divergeIdx = Math.max(0, ordered.length - 1 - b.behindMain);
    const startX = positionFor(divergeIdx);
    const side = i % 2 === 0 ? -1 : 1;
    const lane = Math.floor(i / 2);
    const yOffset = trunkY + side * (baseLaneOffsetLocal + lane * laneStepLocal);
    const extra = Math.min(30 + b.aheadOfMain * 12, 130);
    const tipMax = width - padding - 200;
    const tipX = Math.min(tipMax, latestX + extra);
    const cx1 = startX + 40;
    const cy1 = trunkY + side * 30;
    const cx2 = tipX - 60;
    const cy2 = yOffset;
    return { color, startX, cx1, cy1, cx2, cy2, tipX, yOffset };
  };

  // Total merge animation duration. ~3 seconds is long enough for the
  // human eye to register a path travelling across the screen.
  const MERGE_DURATION_MS = 3000;

  useEffect(() => {
    const currNames = new Set(branchList.map((b) => b.name));
    const prev = prevBranchListRef.current;
    if (prev.length > 0) {
      const justGone = prev.filter((b) => !currNames.has(b.name));
      if (justGone.length > 0) {
        const triggeredAt = Date.now();
        const newMerging: MergingTendril[] = justGone.map((b) => {
          const i = prev.findIndex((x) => x.name === b.name);
          const geo = computeBranchGeo(b, i, prev.length);
          return { name: b.name, ...geo, triggeredAt };
        });
        setMergingTendrils((cur) => [...cur, ...newMerging]);
        // Auto-cleanup after the animation finishes.
        setTimeout(() => {
          setMergingTendrils((cur) => cur.filter((m) => Date.now() - m.triggeredAt < MERGE_DURATION_MS + 200));
        }, MERGE_DURATION_MS + 300);
      }
    }
    prevBranchListRef.current = branchList;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchList]);

  // RAF loop: drives the per-frame `mergeProgress` for each in-flight
  // tendril. Runs only while there's at least one tendril to animate.
  useEffect(() => {
    if (mergingTendrils.length === 0) return;
    let frameId = 0;
    const tick = () => {
      const now = Date.now();
      const next = new Map<string, number>();
      let anyActive = false;
      for (const m of mergingTendrils) {
        const p = Math.min(1, (now - m.triggeredAt) / MERGE_DURATION_MS);
        next.set(m.name, p);
        if (p < 1) anyActive = true;
      }
      setMergeProgress(next);
      if (anyActive) {
        frameId = requestAnimationFrame(tick);
      }
    };
    frameId = requestAnimationFrame(tick);
    return () => { if (frameId) cancelAnimationFrame(frameId); };
  }, [mergingTendrils]);

  // Active Claude sessions per branch — heartbeat data wins over any
  // commit-timestamp heuristic. If a session is currently working on a
  // branch, that branch is "live" no matter when the last commit was.
  const sessionCountByBranch = new Map<string, number>();
  for (const s of activeSessions ?? []) {
    if (!s.branch) continue;
    sessionCountByBranch.set(s.branch, (sessionCountByBranch.get(s.branch) ?? 0) + 1);
  }
  const isBranchAlive = (name: string): boolean => (sessionCountByBranch.get(name) ?? 0) > 0;
  const mainHasSession = isBranchAlive('main');

  // A branch counts as "live" if it has a recent commit OR an active
  // Claude session pinging it.
  const liveBranchCount = branchList.filter(
    (b) => isLiveTs(b.latestTs) || isBranchAlive(b.name)
  ).length;
  const totalActiveSessions = (activeSessions ?? []).length;

  // Resolve the X position of any commit-sha-anchored marker.
  const xForSha = (sha: string | null): number | null => {
    if (!sha) return null;
    const idx = ordered.findIndex((c) => c.sha === sha);
    return idx >= 0 ? positionFor(idx) : null;
  };

  // Deploy positions on the line (no vertical pins anymore — just glowing dots).
  const deployMarkers = deploys
    .map((d) => {
      const x = xForSha(d.commitSha);
      return x !== null ? { ...d, x } : null;
    })
    .filter((v): v is Deploy & { x: number } => v !== null);

  // Merged-branch arcs that have a merge commit visible in our window.
  // We size the arc width by the PR's commit count (more commits = wider arc).
  const visibleMerged = mergedList
    .map((m, i) => {
      const mergeX = xForSha(m.mergeCommitSha);
      if (mergeX === null) return null;
      const span = Math.min(80 + m.commitCount * 18, 240);
      const startX = Math.max(padding, mergeX - span);
      return { ...m, mergeX, startX, color: MERGED_PALETTE[i % MERGED_PALETTE.length], idx: i };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  // Make the canvas tall enough that the highest tendril label doesn't
  // get clipped above and the lowest doesn't crash into the legend below.
  const svgHeight = Math.max(320, trunkY + maxLaneY + 70);

  // Early bail-out for empty data. Must come AFTER all hooks (rules-of-hooks):
  // the merge-animation effects above run unconditionally each render.
  if (commits.length === 0) {
    return (
      <div style={{
        padding: '40px 20px',
        textAlign: 'center',
        background: 'var(--surface-secondary)',
        border: '1px dashed var(--border)',
        borderRadius: '12px',
        color: 'var(--text-muted)',
        fontSize: '13px',
      }}>
        Couldn't load commits from GitHub. The timeline will show up when the API responds.
      </div>
    );
  }

  return (
    <div style={{
      position: 'relative',
      background: 'radial-gradient(ellipse at right, #2a1f3d 0%, #181028 50%, #0d0a1c 100%)',
      borderRadius: '14px',
      padding: '0',
      overflow: 'hidden',
    }}>
      {/* Ambient glow at "now" */}
      <div style={{
        position: 'absolute', right: 0, top: 0, bottom: 0, width: '40%',
        pointerEvents: 'none',
        background: 'radial-gradient(ellipse at right center, rgba(255,170,80,0.18), transparent 60%)',
      }} />

      {/* "MERGED" toast — unambiguous text signal that a merge was detected,
          shown for 3s alongside the SVG animation. So even on a quirky
          browser where the SVG renders weird, you still get a clear visual
          confirmation that the branch came home. */}
      {mergingTendrils.length > 0 && (
        <div style={{
          position: 'absolute',
          top: '14px',
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '6px 14px',
          fontSize: '11.5px',
          fontWeight: 700,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: '#fff',
          background: 'rgba(34,197,94,0.92)',
          borderRadius: '999px',
          backdropFilter: 'blur(4px)',
          zIndex: 2,
          display: 'flex', alignItems: 'center', gap: '8px',
          animation: 'mergeFlash 3s ease-out forwards',
        }}>
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#fff', animation: 'mtBlink 1s infinite' }} />
          {mergingTendrils.length === 1
            ? `${mergingTendrils[0].name} → main`
            : `${mergingTendrils.length} branches → main`}
        </div>
      )}
      <style>{`@keyframes mergeFlash { 0% { opacity: 0; transform: translate(-50%, -10px); } 10%,80% { opacity: 1; transform: translate(-50%, 0); } 100% { opacity: 0; transform: translate(-50%, -10px); } }`}</style>

      {/* Today's commit count, top-right corner. Plain white text, no
          background — just an unobtrusive indicator of how much work
          has landed today. */}
      {commits.length > 0 && (
        <div style={{
          position: 'absolute',
          top: '18px',
          right: '20px',
          fontSize: '11px',
          color: 'rgba(255,255,255,0.75)',
          letterSpacing: '0.05em',
          fontVariantNumeric: 'tabular-nums',
          zIndex: 1,
        }}>
          {commitsTodayLabel}
        </div>
      )}

      {/* Live-activity badges. Each signal renders its OWN badge so they
          can stack — e.g. you can see "MAIN: JUST PUSHED" and "WORKING
          ON MAIN" simultaneously when a Claude session lands a commit
          and keeps working. Order is most-actionable on top:
            1. WORKING ON MAIN  (green, session heartbeating now)
            2. MAIN: JUST PUSHED  (red, last 60s)
            3. N branches updated  (red, branch-level signal)
          A non-main session alone (no main signal) still renders a
          summary badge so you don't lose visibility on side work. */}
      {(() => {
        const mainSessionCount = sessionCountByBranch.get('main') ?? 0;
        const offMainSessionCount = totalActiveSessions - mainSessionCount;
        const badges: Array<{ key: string; label: string; bg: string }> = [];

        if (mainHasSession) {
          badges.push({
            key: 'working-main',
            label: mainSessionCount === 1
              ? '🤖 WORKING ON MAIN'
              : `🤖 ${mainSessionCount} SESSIONS ON MAIN`,
            bg: 'rgba(34, 197, 94, 0.92)', // green
          });
        }
        if (mainIsLive) {
          badges.push({
            key: 'just-pushed',
            label: 'MAIN: JUST PUSHED',
            bg: 'rgba(239, 68, 68, 0.85)', // red
          });
        }
        if (!mainHasSession && offMainSessionCount > 0) {
          // Mirror the "WORKING ON MAIN" / "N SESSIONS ON MAIN" wording
          // so the badge reads consistently across branches. When all
          // sessions are on ONE side branch, name it ("WORKING ON
          // tranquil-chasing-flurry") so Reeyen can tell tabs apart;
          // when sessions span multiple branches, fall back to the
          // generic "ON BRANCHES" plural.
          const offMainBranches = Array.from(sessionCountByBranch.keys())
            .filter((b) => b !== 'main' && b !== 'master');
          let branchSuffix: string;
          if (offMainBranches.length === 1) {
            const name = offMainBranches[0] ?? '';
            const truncated = name.length > 24 ? `${name.slice(0, 22)}…` : name;
            branchSuffix = `ON ${truncated.toUpperCase()}`;
          } else {
            branchSuffix = 'ON BRANCHES';
          }
          badges.push({
            key: 'side-sessions',
            label: offMainSessionCount === 1
              ? `🤖 WORKING ${branchSuffix}`
              : `🤖 ${offMainSessionCount} SESSIONS ${branchSuffix}`,
            bg: 'rgba(34, 197, 94, 0.85)',
          });
        }
        if (!mainHasSession && offMainSessionCount === 0 && liveBranchCount > 0 && !mainIsLive) {
          badges.push({
            key: 'branches-updated',
            label: `${liveBranchCount} ${liveBranchCount === 1 ? 'BRANCH' : 'BRANCHES'} JUST UPDATED`,
            bg: 'rgba(239, 68, 68, 0.85)',
          });
        }

        if (badges.length === 0) return null;
        return (
          <div style={{
            position: 'absolute',
            top: '14px',
            left: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            zIndex: 1,
          }}>
            {badges.map((b) => (
              <div key={b.key} style={{
                padding: '4px 10px',
                fontSize: '10.5px',
                fontWeight: 700,
                letterSpacing: '0.1em',
                color: '#fff',
                background: b.bg,
                borderRadius: '999px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                backdropFilter: 'blur(4px)',
                width: 'fit-content',
              }}>
                <span style={{
                  width: '6px', height: '6px', borderRadius: '50%', background: '#fff',
                  animation: 'mtBlink 1s ease-in-out infinite',
                }} />
                {b.label}
              </div>
            ))}
          </div>
        );
      })()}
      <style>{`@keyframes mtBlink { 0%,100% { opacity: 1 } 50% { opacity: 0.3 } }`}</style>

      <svg viewBox={`0 0 ${width} ${svgHeight}`} style={{ width: '100%', height: 'auto', display: 'block', position: 'relative' }}>
        <defs>
          {/* Dim → bright gradient on the main line: left = past (faded), right = now (glowing) */}
          <linearGradient id="trunk" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#c4781f" stopOpacity="0.95" />
            <stop offset="50%" stopColor="#ffb347" stopOpacity="1" />
            <stop offset="100%" stopColor="#fff1c5" stopOpacity="1" />
          </linearGradient>
          <filter id="softGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="bigGlow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="12" />
          </filter>
        </defs>

        {/* Merged-branch arcs intentionally removed — Reeyen called them
            visual clutter. Recent merges still show as commit dots on
            the trunk; the click-through is via "full history" → GitHub. */}

        {/* === MAIN SACRED TIMELINE ============================================ */}
        {/* Outer atmospheric halo */}
        <line
          x1={padding} y1={trunkY} x2={width - padding} y2={trunkY}
          stroke="#ffb347" strokeWidth="28" strokeLinecap="round"
          opacity="0.18" filter="url(#bigGlow)"
        />
        {/* Mid halo — gives the line its bloom */}
        <line
          x1={padding} y1={trunkY} x2={width - padding} y2={trunkY}
          stroke="#ffc870" strokeWidth="14" strokeLinecap="round"
          opacity="0.55" filter="url(#softGlow)"
        />
        {/* Bright body */}
        <line
          x1={padding} y1={trunkY} x2={width - padding} y2={trunkY}
          stroke="url(#trunk)" strokeWidth="7" strokeLinecap="round"
          opacity="1"
        />
        {/* Sharp white center thread for that "energy beam" feel */}
        <line
          x1={padding} y1={trunkY} x2={width - padding} y2={trunkY}
          stroke="#fff8e1" strokeWidth="1.5" strokeLinecap="round"
          opacity="0.9"
        />
        {/* Bright pulse at "now" — pulses faster + brighter when main is live */}
        <circle cx={latestX} cy={trunkY} r="9" fill="#fff5d6" filter="url(#softGlow)">
          <animate attributeName="r"
            values={(mainIsLive || mainHasSession) ? '10;18;10' : '9;14;9'}
            dur={(mainIsLive || mainHasSession) ? '1.2s' : '2.6s'}
            repeatCount="indefinite" />
          <animate attributeName="opacity"
            values={(mainIsLive || mainHasSession) ? '1;0.7;1' : '1;0.6;1'}
            dur={(mainIsLive || mainHasSession) ? '1.2s' : '2.6s'}
            repeatCount="indefinite" />
        </circle>
        <circle cx={latestX} cy={trunkY} r="4" fill="#fff" />

        {/* When a Claude session is actively heart-beating on main:
            outward shockwave ring at NOW so the trunk visibly says
            "someone is working RIGHT HERE, RIGHT NOW" even if they
            haven't committed yet. */}
        {mainHasSession && (
          <circle cx={latestX} cy={trunkY} r="9" fill="none" stroke="#34d399" strokeWidth="2" opacity="0">
            <animate attributeName="r" values="9;28;9" dur="1.6s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.95;0;0" keyTimes="0;0.7;1" dur="1.6s" repeatCount="indefinite" />
          </circle>
        )}

        {/* Energy particles travelling along the main line — left → right.
            Three visual states the user can read at a glance:

              IDLE      — no particles, calm trunk.
              BUILDING  — bare bright dots flowing. Fires whenever ANY
                          Claude session is heartbeating (main OR side
                          branch), because Reeyen wants to see "stuff is
                          happening in the system" without parsing which
                          branch.
              PUSHING   — dots flowing PLUS a glowing halo ("globe")
                          travelling alongside each. Fires within 60s of
                          a fresh main commit. The halo is the obvious
                          differentiator vs building.
        */}
        {(totalActiveSessions > 0 || mainIsLive) && [0, 1, 2].map((i) => {
          const dur = '3.8s';
          const stagger = 1.27;
          const showHalo = mainIsLive;
          return (
            <g key={`particle-${i}`}>
              {showHalo && (
                <circle
                  cy={trunkY}
                  r="11"
                  fill="#ffd180"
                  opacity="0"
                  filter="url(#bigGlow)"
                >
                  <animate
                    attributeName="cx"
                    values={`${padding};${width - padding}`}
                    dur={dur}
                    begin={`${i * stagger}s`}
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="opacity"
                    values="0;0.65;0.65;0"
                    keyTimes="0;0.15;0.85;1"
                    dur={dur}
                    begin={`${i * stagger}s`}
                    repeatCount="indefinite"
                  />
                </circle>
              )}
              <circle
                cy={trunkY}
                r="3.5"
                fill="#fff8e1"
                opacity="0"
                filter="url(#softGlow)"
              >
                <animate
                  attributeName="cx"
                  values={`${padding};${width - padding}`}
                  dur={dur}
                  begin={`${i * stagger}s`}
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values="0;1;1;0"
                  keyTimes="0;0.15;0.85;1"
                  dur={dur}
                  begin={`${i * stagger}s`}
                  repeatCount="indefinite"
                />
              </circle>
            </g>
          );
        })}

        {/* === DEPLOY MARKERS (subtle glow dots ON the line) ===================
            When a deploy lands on the very latest commit (same X as NOW), we
            skip the text label — it would just stack on top of the "NOW" tag
            and create visual noise. The colored ring still tells you it's a
            deploy point; clicking the legend reveals what color = what. */}
        {deployMarkers.map((d, i) => {
          const c = d.target === 'vercel-website' ? '#7dd3fc' : '#c4b5fd';
          const overlapsNow = Math.abs(d.x - latestX) < 60;
          return (
            <g key={d.target}>
              <circle cx={d.x} cy={trunkY} r="11" fill={c} opacity="0.18" filter="url(#bigGlow)" />
              <circle cx={d.x} cy={trunkY} r="5" fill={c} stroke="#fff" strokeWidth="1.5" opacity="0.9" />
              {!overlapsNow && (
                <text
                  x={d.x} y={trunkY - 18 - i * 12}
                  textAnchor="middle" fontSize="9.5"
                  fill="rgba(255,255,255,0.85)"
                  fontFamily="-apple-system, system-ui, sans-serif"
                  style={{ userSelect: 'none' }}
                >
                  {d.target === 'vercel-website' ? 'web deployed' : 'cua deployed'}
                </text>
              )}
            </g>
          );
        })}

        {/* === ACTIVE BRANCH TENDRILS ========================================== */}
        {/* Arc out from divergence, end at a pulsing dot. Alternate above/below.
            The further the branch is ahead of main, the further the tip extends. */}
        {branchList.map((b, i) => {
          const c = ACTIVE_PALETTE[i % ACTIVE_PALETTE.length];
          const divergeIdx = Math.max(0, ordered.length - 1 - b.behindMain);
          const startX = positionFor(divergeIdx);
          const side = i % 2 === 0 ? -1 : 1;            // alternate up/down
          const lane = Math.floor(i / 2);                // 0, 0, 1, 1, 2, 2…
          const yOffset = trunkY + side * (baseLaneOffset + lane * laneStep);
          // Tip extends to the right of "now" by an amount proportional to ahead.
          // Cap so labels stay inside the viewBox (need room for the longest
          // branch name + the "+N" suffix on the right side of the dot).
          const extra = Math.min(30 + b.aheadOfMain * 12, 130);
          const tipMax = width - padding - 200;     // 200px label headroom
          const tipX = Math.min(tipMax, latestX + extra);
          const isHover = hoverBranch?.name === b.name;
          // Cubic for an organic curve: control points pull off the line
          const cx1 = startX + 40;
          const cy1 = trunkY + side * 30;
          const cx2 = tipX - 60;
          const cy2 = yOffset;
          // A tendril is "live" if its tip commit is recent OR an active
          // Claude session is heart-beating on this branch right now.
          const isLive = isLiveTs(b.latestTs) || isBranchAlive(b.name);
          const sessionCount = sessionCountByBranch.get(b.name) ?? 0;
          return (
            <g
              key={b.name}
              onMouseEnter={() => setHoverBranch(b)}
              onMouseLeave={() => setHoverBranch(null)}
              style={{ cursor: 'pointer' }}
              onClick={() => window.open(b.url, '_blank', 'noopener')}
            >
              {/* Wide soft glow under the tendril — brighter on live */}
              <path
                d={`M ${startX} ${trunkY} C ${cx1} ${cy1} ${cx2} ${cy2} ${tipX} ${yOffset}`}
                stroke={c} strokeWidth={isLive ? 8 : 6} fill="none"
                opacity={isHover ? 0.5 : isLive ? 0.32 : 0.18} filter="url(#bigGlow)"
              />
              {/* Sharp tendril — thicker + brighter on live */}
              <path
                d={`M ${startX} ${trunkY} C ${cx1} ${cy1} ${cx2} ${cy2} ${tipX} ${yOffset}`}
                stroke={c} strokeWidth={isHover ? 2.8 : isLive ? 2.4 : 1.8}
                fill="none" opacity={isHover ? 1 : isLive ? 1 : 0.85}
                filter="url(#softGlow)"
              />
              {/* When live: an energy particle racing along the tendril */}
              {isLive && (
                <circle r="2.5" fill="#fff" opacity="0.9" filter="url(#softGlow)">
                  <animateMotion
                    dur="1.8s"
                    repeatCount="indefinite"
                    path={`M ${startX} ${trunkY} C ${cx1} ${cy1} ${cx2} ${cy2} ${tipX} ${yOffset}`}
                  />
                </circle>
              )}
              {/* Outer pulse ring — bigger + faster when live */}
              <circle cx={tipX} cy={yOffset} r="7" fill={c} opacity="0.35" filter="url(#bigGlow)">
                {isLive && (
                  <animate attributeName="r" values="7;14;7" dur="1.1s" repeatCount="indefinite" />
                )}
              </circle>
              {/* When live: extra outward shockwave ring */}
              {isLive && (
                <circle cx={tipX} cy={yOffset} r="4" fill="none" stroke={c} strokeWidth="1.5" opacity="0">
                  <animate attributeName="r" values="4;22;4" dur="1.6s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.9;0;0" keyTimes="0;0.7;1" dur="1.6s" repeatCount="indefinite" />
                </circle>
              )}
              {/* Tip dot — pulses faster when live */}
              <circle cx={tipX} cy={yOffset} r="4" fill={c} stroke="rgba(255,255,255,0.7)" strokeWidth="1">
                <animate attributeName="opacity"
                  values={isLive ? '0.7;1;0.7' : '0.6;1;0.6'}
                  dur={isLive ? '0.9s' : '2s'}
                  repeatCount="indefinite" />
              </circle>
              {/* Branch label — anchored to the RIGHT of the dot so it
                  stays inside the viewBox regardless of side. */}
              <text
                x={tipX + 12}
                y={yOffset + 4}
                textAnchor="start"
                fontSize="10.5"
                fill="rgba(255,255,255,0.92)"
                fontFamily="-apple-system, system-ui, sans-serif"
                style={{ userSelect: 'none' }}
              >
                <tspan>{b.name}</tspan>
                {b.aheadOfMain > 0 && (
                  <tspan fill={c} dx="6">+{b.aheadOfMain}</tspan>
                )}
                {sessionCount > 0 && (
                  <tspan fill="#fff" dx="8" fontSize="9" fontWeight="700" style={{ letterSpacing: '0.1em' }}>
                    🤖 {sessionCount > 1 ? `×${sessionCount}` : 'WORKING'}
                  </tspan>
                )}
                {sessionCount === 0 && isLive && (
                  <tspan fill="#fff" dx="8" fontSize="9" fontWeight="700" style={{ letterSpacing: '0.1em' }}>● LIVE</tspan>
                )}
              </text>
            </g>
          );
        })}

        {/* === MERGE-IN ANIMATION (rAF-driven) ===============================
            React state is updated every frame via requestAnimationFrame
            (see useEffect above). At each frame we re-render this group
            with interpolated positions. NO SVG SMIL — that turned out
            to be unreliable in production Chrome. */}
        {mergingTendrils.map((m) => {
          const p = mergeProgress.get(m.name) ?? 0;
          // Motion eases out — fast at start, slows as it nears the trunk.
          const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
          // Path/tip motion happens in the first 70% of the duration.
          // The last 30% is just the "dissolve" fade.
          const motionT = easeOut(Math.min(1, p / 0.7));
          const fadeT = Math.max(0, (p - 0.7) / 0.3);
          const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
          // Current tip position: rides from its original tip toward NOW.
          const tipXNow = lerp(m.tipX, latestX, motionT);
          const tipYNow = lerp(m.yOffset, trunkY, motionT);
          // Control points morph from the original arc into the trunk.
          const cy1Now = lerp(m.cy1, trunkY, motionT);
          const cy2Now = lerp(m.cy2, trunkY, motionT);
          const cx2Now = lerp(m.cx2, latestX - 30, motionT);
          const cx1Now = lerp(m.cx1, m.startX + 30, motionT);
          const dPath = `M ${m.startX} ${trunkY} C ${cx1Now} ${cy1Now} ${cx2Now} ${cy2Now} ${tipXNow} ${tipYNow}`;
          // Brightens at the moment of "homecoming" then dissolves.
          const opacity = 1 - fadeT;
          return (
            <g key={`merging-${m.name}-${m.triggeredAt}`}>
              {/* Wide glow under the tendril */}
              <path d={dPath} stroke={m.color} strokeWidth="10" fill="none"
                opacity={0.18 + 0.4 * motionT * (1 - fadeT)} filter="url(#bigGlow)" />
              {/* Sharp tendril */}
              <path d={dPath} stroke={m.color}
                strokeWidth={2.4 + 1.2 * motionT * (1 - fadeT)}
                fill="none" opacity={opacity} filter="url(#softGlow)" />
              {/* Tip dot rides along the curve */}
              <circle cx={tipXNow} cy={tipYNow}
                r={4 + 3 * motionT * (1 - fadeT)}
                fill={m.color} stroke="rgba(255,255,255,0.85)" strokeWidth="1"
                opacity={opacity} />
            </g>
          );
        })}

        {/* "PAST" / "NOW" labels at line ends (ultra-subtle).
            Both above the line so neither overlaps the beam itself. */}
        <text x={padding} y={trunkY - 22} textAnchor="start" fontSize="9"
          fill="rgba(255,255,255,0.35)" fontFamily="-apple-system, system-ui, sans-serif"
          style={{ letterSpacing: '0.2em' }}>
          ← past
        </text>
        <text x={width - padding} y={trunkY - 22} textAnchor="end" fontSize="11"
          fill="rgba(255,245,214,0.85)" fontFamily="-apple-system, system-ui, sans-serif"
          fontWeight="600" style={{ letterSpacing: '0.2em' }}>
          NOW
        </text>
      </svg>

      {/* Floating tooltip */}
      {(hoverBranch || hoverMerged) && (
        <div style={{
          position: 'absolute',
          top: '12px',
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '10px 14px',
          background: 'rgba(0,0,0,0.85)',
          color: 'white',
          borderRadius: '10px',
          fontSize: '12px',
          maxWidth: '560px',
          pointerEvents: 'none',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(255,255,255,0.1)',
        }}>
          {hoverBranch && (
            <>
              <div style={{ fontFamily: 'monospace', opacity: 0.7, fontSize: '10.5px', marginBottom: '4px' }}>
                {hoverBranch.name} · branched off {hoverBranch.behindMain > 0 ? `${hoverBranch.behindMain} commits ago` : 'just now'}{hoverBranch.latestTs ? ` · last update ${timeAgo(hoverBranch.latestTs)}` : ''}
              </div>
              <div style={{ fontWeight: 500 }}>{hoverBranch.latestMessage}</div>
            </>
          )}
          {hoverMerged && !hoverBranch && (
            <>
              <div style={{ fontFamily: 'monospace', opacity: 0.7, fontSize: '10.5px', marginBottom: '4px' }}>
                {hoverMerged.branchName} · merged {timeAgo(hoverMerged.mergedAt)} · {hoverMerged.commitCount} {hoverMerged.commitCount === 1 ? 'commit' : 'commits'}
              </div>
              <div style={{ fontWeight: 500 }}>{hoverMerged.title}</div>
            </>
          )}
        </div>
      )}

      {/* Legend & link */}
      <div style={{
        padding: '0 18px 14px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '14px',
        fontSize: '11px',
        color: 'rgba(255,255,255,0.7)',
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: '20px', height: '2px', borderRadius: '1px', background: 'linear-gradient(90deg, #5a3915, #fff1c5)' }} />
          main timeline
        </span>
        {branchList.length > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#fb7185' }} />
            active branches ({branchList.length})
          </span>
        )}
        {/* "merged" arc legend removed alongside the arcs themselves. */}
        {deployMarkers.length > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#7dd3fc', border: '1px solid white' }} />
            deploys
          </span>
        )}
        {worktrees.length > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#34d399' }} />
            local worktrees ({worktrees.length})
          </span>
        )}
        <a
          href="https://github.com/Reeyenn/staxis/commits/main"
          target="_blank"
          rel="noopener noreferrer"
          style={{ marginLeft: 'auto', color: 'rgba(255,214,135,0.9)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
        >
          full history <ExternalLink size={11} />
        </a>
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
