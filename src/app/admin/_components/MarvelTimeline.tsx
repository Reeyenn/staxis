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

import React, { useState } from 'react';
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

const ACTIVE_PALETTE = ['#fb7185', '#a78bfa', '#34d399', '#60a5fa', '#facc15', '#f472b6'];
const MERGED_PALETTE = ['#7dd3fc', '#fcd34d', '#86efac', '#f9a8d4', '#c4b5fd', '#fdba74'];

export function MarvelTimeline({
  commits, deploys, worktrees, branches, merged,
}: {
  commits: Commit[];
  deploys: Deploy[];
  worktrees: Worktree[];
  branches?: Branch[];
  merged?: MergedBranch[];
}) {
  const [hoverBranch, setHoverBranch] = useState<Branch | null>(null);
  const [hoverMerged, setHoverMerged] = useState<MergedBranch | null>(null);

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

  const branchList = branches ?? [];
  const mergedList = merged ?? [];

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

  const svgHeight = 320;

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

        {/* === MERGED BRANCH ARCS (drawn first, behind everything) ============= */}
        {/* Each one arcs out and back into the line — "branch came home". Drawn
            with low-opacity stroke so they fade into the cosmic background. */}
        {visibleMerged.slice(0, 8).map((m) => {
          // Alternate above/below so consecutive merges don't overlap visually.
          const side = m.idx % 2 === 0 ? -1 : 1;
          const arcHeight = 32 + (m.idx % 3) * 8;
          const cy = trunkY + side * arcHeight;
          const isHover = hoverMerged?.branchName === m.branchName;
          return (
            <g
              key={`m-${m.idx}`}
              onMouseEnter={() => setHoverMerged(m)}
              onMouseLeave={() => setHoverMerged(null)}
              style={{ cursor: 'pointer' }}
              onClick={() => window.open(m.url, '_blank', 'noopener')}
            >
              <path
                d={`M ${m.startX} ${trunkY} C ${m.startX + 30} ${cy} ${m.mergeX - 30} ${cy} ${m.mergeX} ${trunkY}`}
                stroke={m.color}
                strokeWidth={isHover ? 2.4 : 1.6}
                fill="none"
                opacity={isHover ? 0.95 : 0.55}
              />
            </g>
          );
        })}

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
        {/* Bright pulse at "now" */}
        <circle cx={latestX} cy={trunkY} r="9" fill="#fff5d6" filter="url(#softGlow)">
          <animate attributeName="r" values="9;14;9" dur="2.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="1;0.6;1" dur="2.6s" repeatCount="indefinite" />
        </circle>
        <circle cx={latestX} cy={trunkY} r="4" fill="#fff" />

        {/* === DEPLOY MARKERS (subtle glow dots ON the line) =================== */}
        {deployMarkers.map((d, i) => {
          const c = d.target === 'vercel-website' ? '#7dd3fc' : '#c4b5fd';
          return (
            <g key={d.target}>
              <circle cx={d.x} cy={trunkY} r="11" fill={c} opacity="0.18" filter="url(#bigGlow)" />
              <circle cx={d.x} cy={trunkY} r="5" fill={c} stroke="#fff" strokeWidth="1.5" opacity="0.9" />
              <text
                x={d.x} y={trunkY - 18 - i * 12}
                textAnchor="middle" fontSize="9.5"
                fill="rgba(255,255,255,0.85)"
                fontFamily="-apple-system, system-ui, sans-serif"
                style={{ userSelect: 'none' }}
              >
                {d.target === 'vercel-website' ? 'web deployed' : 'cua deployed'}
              </text>
            </g>
          );
        })}

        {/* === ACTIVE BRANCH TENDRILS ========================================== */}
        {/* Arc out from divergence, end at a pulsing dot. Alternate above/below.
            The further the branch is ahead of main, the further the tip extends. */}
        {branchList.slice(0, 6).map((b, i) => {
          const c = ACTIVE_PALETTE[i % ACTIVE_PALETTE.length];
          const divergeIdx = Math.max(0, ordered.length - 1 - b.behindMain);
          const startX = positionFor(divergeIdx);
          const side = i % 2 === 0 ? -1 : 1;            // alternate up/down
          const lane = Math.floor(i / 2);                // 0, 0, 1, 1, 2, 2…
          const yOffset = trunkY + side * (60 + lane * 30);
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
          return (
            <g
              key={b.name}
              onMouseEnter={() => setHoverBranch(b)}
              onMouseLeave={() => setHoverBranch(null)}
              style={{ cursor: 'pointer' }}
              onClick={() => window.open(b.url, '_blank', 'noopener')}
            >
              {/* Wide soft glow under the tendril */}
              <path
                d={`M ${startX} ${trunkY} C ${cx1} ${cy1} ${cx2} ${cy2} ${tipX} ${yOffset}`}
                stroke={c} strokeWidth="6" fill="none"
                opacity={isHover ? 0.4 : 0.18} filter="url(#bigGlow)"
              />
              {/* Sharp tendril */}
              <path
                d={`M ${startX} ${trunkY} C ${cx1} ${cy1} ${cx2} ${cy2} ${tipX} ${yOffset}`}
                stroke={c} strokeWidth={isHover ? 2.6 : 1.8}
                fill="none" opacity={isHover ? 1 : 0.85}
                filter="url(#softGlow)"
              />
              {/* Pulsing tip dot */}
              <circle cx={tipX} cy={yOffset} r="7" fill={c} opacity="0.35" filter="url(#bigGlow)" />
              <circle cx={tipX} cy={yOffset} r="4" fill={c} stroke="rgba(255,255,255,0.7)" strokeWidth="1">
                <animate attributeName="opacity" values="0.6;1;0.6" dur="2s" repeatCount="indefinite" />
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
              </text>
            </g>
          );
        })}

        {/* "PAST" / "NOW" labels at line ends (ultra-subtle) */}
        <text x={padding} y={trunkY + 4} textAnchor="start" fontSize="9"
          fill="rgba(255,255,255,0.3)" fontFamily="-apple-system, system-ui, sans-serif"
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
        {visibleMerged.length > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '14px', height: '8px', border: '1.5px solid #7dd3fc', borderRadius: '50%', borderBottom: 'none', borderLeft: 'none', borderRight: 'none' }} />
            merged ({visibleMerged.length})
          </span>
        )}
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
