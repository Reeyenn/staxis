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

// "Building" = sustained activity. If the repo has racked up 3+ commits
// on main in the last 15 minutes, we're clearly mid-build (not a one-off
// push from an hour ago). The badge stays lit the whole time work is
// happening and only fades when commits stop landing — captures the
// "we've been building for 45 minutes" case correctly.
const BUILDING_WINDOW_MS = 15 * 60 * 1000;
const BUILDING_THRESHOLD = 3;

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

  // "Building" mode: 3+ commits on main in the last 15 minutes. Lit the
  // whole time activity is sustained, fades when commits stop landing.
  const recentMainCommitsCount = commits.filter(
    (c) => now - new Date(c.ts).getTime() < BUILDING_WINDOW_MS
  ).length;
  const isBuilding = recentMainCommitsCount >= BUILDING_THRESHOLD;

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
  const branchList = branches ?? [];
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
        // Auto-cleanup after the 3s merge animation + 0.5s buffer.
        setTimeout(() => {
          setMergingTendrils((cur) => cur.filter((m) => Date.now() - m.triggeredAt < 3400));
        }, 3500);
      }
    }
    prevBranchListRef.current = branchList;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchList]);

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
  const anythingLive = mainIsLive || mainHasSession || liveBranchCount > 0 || isBuilding || totalActiveSessions > 0;

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

      {/* Live-activity badge (only shows when something is happening).
          Priority: BUILDING (sustained, amber) > just-pushed (brief, red)
                    > branch activity (red). */}
      {anythingLive && (() => {
        // Pick the most informative label given the state. Heartbeats
        // (active Claude sessions) outrank commit-based signals because
        // they tell us "someone is working RIGHT NOW" with sub-3s lag.
        let label: string;
        let bg: string;
        if (totalActiveSessions > 0) {
          const branchCount = sessionCountByBranch.size;
          label = branchCount === 1
            ? `🤖 ${totalActiveSessions} CLAUDE ${totalActiveSessions === 1 ? 'SESSION' : 'SESSIONS'} BUILDING`
            : `🤖 ${totalActiveSessions} SESSIONS · ${branchCount} BRANCHES`;
          bg = 'rgba(34, 197, 94, 0.92)'; // green — Claude actively working
        } else if (isBuilding) {
          label = `BUILDING · ${recentMainCommitsCount} commits in 15 min`;
          bg = 'rgba(212, 144, 64, 0.92)'; // amber — sustained activity
        } else if (mainIsLive && liveBranchCount === 0) {
          label = 'MAIN: JUST PUSHED';
          bg = 'rgba(239, 68, 68, 0.85)'; // red — momentary
        } else if (!mainIsLive && liveBranchCount > 0) {
          label = `${liveBranchCount} ${liveBranchCount === 1 ? 'BRANCH' : 'BRANCHES'} JUST UPDATED`;
          bg = 'rgba(239, 68, 68, 0.85)';
        } else {
          label = `MAIN + ${liveBranchCount} ${liveBranchCount === 1 ? 'BRANCH' : 'BRANCHES'} UPDATED`;
          bg = 'rgba(239, 68, 68, 0.85)';
        }
        return (
          <div style={{
            position: 'absolute',
            top: '14px',
            left: '16px',
            padding: '4px 10px',
            fontSize: '10.5px',
            fontWeight: 700,
            letterSpacing: '0.1em',
            color: '#fff',
            background: bg,
            borderRadius: '999px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            backdropFilter: 'blur(4px)',
            zIndex: 1,
          }}>
            <span style={{
              width: '6px', height: '6px', borderRadius: '50%', background: '#fff',
              animation: 'mtBlink 1s ease-in-out infinite',
            }} />
            {label}
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
            Always animating (the timeline is "alive" even at idle) but
            faster + brighter when main has a recent commit. */}
        {[0, 1, 2].map((i) => (
          <circle key={`particle-${i}`} cy={trunkY} r={(mainIsLive || mainHasSession) ? 3 : 2} fill="#fff8e1" opacity="0.85" filter="url(#softGlow)">
            <animate
              attributeName="cx"
              values={`${padding};${width - padding}`}
              dur={(mainIsLive || mainHasSession) ? '4.5s' : '8s'}
              begin={`${i * ((mainIsLive || mainHasSession) ? 1.5 : 2.7)}s`}
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0;0.95;0.95;0"
              keyTimes="0;0.15;0.85;1"
              dur={(mainIsLive || mainHasSession) ? '4.5s' : '8s'}
              begin={`${i * ((mainIsLive || mainHasSession) ? 1.5 : 2.7)}s`}
              repeatCount="indefinite"
            />
          </circle>
        ))}

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
                <tspan fill={c} dx="6">+{b.aheadOfMain}</tspan>
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

        {/* === MERGE-IN ANIMATION ============================================
            When a branch disappears (got merged), the tendril shouldn't
            just pop out. It should physically slide toward the main
            timeline and DISSOLVE into the beam. 3 seconds end-to-end so
            it's actually visible:

              Phase 1 (0 → 2.0s): the path morphs from its arc toward
                the trunk. The tip dot rides along the curve. As it
                approaches the trunk it BRIGHTENS — the line getting
                pulled into the main timeline's energy.
              Phase 2 (2.0 → 3.0s): once the tendril is hugging the
                trunk, opacity fades out softly so it dissolves rather
                than snaps. */}
        {mergingTendrils.map((m) => {
          const fromPath = `M ${m.startX} ${trunkY} C ${m.cx1} ${m.cy1} ${m.cx2} ${m.cy2} ${m.tipX} ${m.yOffset}`;
          // End state: the curve flattens onto the trunk between divergence and NOW.
          const toPath = `M ${m.startX} ${trunkY} C ${m.startX + 30} ${trunkY} ${latestX - 30} ${trunkY} ${latestX} ${trunkY}`;
          return (
            <g key={`merging-${m.name}-${m.triggeredAt}`}>
              {/* Wide soft glow under the tendril — INTENSIFIES as the
                  tendril approaches the trunk (the "energy reunion"). */}
              <path
                d={fromPath}
                stroke={m.color} strokeWidth="10" fill="none"
                opacity="0.18" filter="url(#bigGlow)"
              >
                <animate attributeName="d" from={fromPath} to={toPath}
                  dur="2.0s" fill="freeze" calcMode="spline"
                  keySplines="0.4 0 0.2 1" />
                <animate attributeName="opacity"
                  values="0.18;0.55;0.55;0"
                  keyTimes="0;0.65;0.85;1"
                  dur="3.0s" fill="freeze" />
              </path>
              {/* Sharp tendril — same morph, brightens slightly mid-merge. */}
              <path
                d={fromPath}
                stroke={m.color} strokeWidth="2.4" fill="none"
                opacity="0.95" filter="url(#softGlow)"
              >
                <animate attributeName="d" from={fromPath} to={toPath}
                  dur="2.0s" fill="freeze" calcMode="spline"
                  keySplines="0.4 0 0.2 1" />
                <animate attributeName="stroke-width"
                  values="2.4;3.2;3.2;1.5"
                  keyTimes="0;0.65;0.85;1"
                  dur="3.0s" fill="freeze" />
                <animate attributeName="opacity"
                  values="0.95;1;1;0"
                  keyTimes="0;0.65;0.85;1"
                  dur="3.0s" fill="freeze" />
              </path>
              {/* Tip dot rides along the curve, slows as it approaches NOW,
                  brightens momentarily, then dissolves. */}
              <circle cx={m.tipX} cy={m.yOffset} r="4"
                fill={m.color} stroke="rgba(255,255,255,0.85)" strokeWidth="1">
                <animate attributeName="cx" from={String(m.tipX)} to={String(latestX)}
                  dur="2.0s" fill="freeze" calcMode="spline"
                  keySplines="0.3 0 0.1 1" />
                <animate attributeName="cy" from={String(m.yOffset)} to={String(trunkY)}
                  dur="2.0s" fill="freeze" calcMode="spline"
                  keySplines="0.3 0 0.1 1" />
                <animate attributeName="r"
                  values="4;6;7;0"
                  keyTimes="0;0.65;0.85;1"
                  dur="3.0s" fill="freeze" />
                <animate attributeName="opacity"
                  values="1;1;1;0"
                  keyTimes="0;0.85;0.95;1"
                  dur="3.0s" fill="freeze" />
              </circle>
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
