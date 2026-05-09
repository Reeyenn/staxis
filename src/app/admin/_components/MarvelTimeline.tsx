'use client';

/**
 * Marvel/Loki-style horizontal time tree for the System tab.
 *
 * The main branch is a thick glowing orange trunk with commit nodes
 * along it. The latest commit pulses. Active local Claude worktrees
 * appear as side-streams below the trunk in a different palette.
 * Production deploy markers (Vercel website + Fly CUA worker) are
 * vertical pins crossing the trunk.
 *
 * Pure SVG + CSS — no chart library. Hover any commit for the message;
 * click jumps to GitHub.
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

export function MarvelTimeline({
  commits, deploys, worktrees,
}: { commits: Commit[]; deploys: Deploy[]; worktrees: Worktree[] }) {
  const [hover, setHover] = useState<Commit | null>(null);

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

  // Geometry
  const padding = 40;
  const width = 1100;                                 // viewBox width (responsive via SVG scaling)
  const trunkY = 100;                                 // y of the main branch trunk
  const innerW = width - padding * 2;
  const step = commits.length > 1 ? innerW / (commits.length - 1) : 0;

  // Newest commit on the left visually is too "modern app"-feeling. We
  // place oldest on the LEFT, newest on the RIGHT, so time flows left
  // to right like every other timeline humans read.
  const ordered = [...commits].reverse();
  const positionFor = (i: number) => padding + i * step;
  const latestX = positionFor(ordered.length - 1);

  // Map deploys onto the closest commit X position
  const deployMarkers = deploys
    .filter((d) => d.commitSha)
    .map((d) => {
      const idx = ordered.findIndex((c) => c.sha === d.commitSha);
      return idx >= 0 ? { ...d, x: positionFor(idx) } : null;
    })
    .filter((v): v is Deploy & { x: number } => v !== null);

  return (
    <div style={{ position: 'relative', background: 'linear-gradient(180deg, #181a2c 0%, #232a48 100%)', borderRadius: '14px', padding: '16px', overflow: 'hidden' }}>
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: 'radial-gradient(ellipse at top, rgba(255,165,68,0.12), transparent 60%)',
      }} />

      <svg viewBox={`0 0 ${width} 220`} style={{ width: '100%', height: 'auto', display: 'block', position: 'relative' }}>
        <defs>
          <linearGradient id="trunkGradient" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#7d4a13" />
            <stop offset="50%" stopColor="#ffb347" />
            <stop offset="100%" stopColor="#ffd687" />
          </linearGradient>
          <radialGradient id="commitGlow">
            <stop offset="0%" stopColor="#ffd687" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffd687" stopOpacity="0" />
          </radialGradient>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3.5" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Main trunk */}
        <line x1={padding} y1={trunkY} x2={width - padding} y2={trunkY}
          stroke="url(#trunkGradient)" strokeWidth="6" strokeLinecap="round" filter="url(#glow)" />

        {/* Commit nodes */}
        {ordered.map((c, i) => {
          const x = positionFor(i);
          const isLatest = i === ordered.length - 1;
          return (
            <g
              key={c.sha}
              onMouseEnter={() => setHover(c)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
              onClick={() => window.open(c.url, '_blank', 'noopener')}
            >
              <circle cx={x} cy={trunkY} r="14" fill="url(#commitGlow)" opacity="0.6" />
              <circle cx={x} cy={trunkY} r={isLatest ? 7 : 5}
                fill={isLatest ? '#ffd687' : '#ffb347'}
                stroke="#fff8e7" strokeWidth="1.5"
                filter="url(#glow)">
                {isLatest && (
                  <animate attributeName="r" values="7;10;7" dur="2.5s" repeatCount="indefinite" />
                )}
              </circle>
              <text x={x} y={trunkY + 28} textAnchor="middle" fontSize="9" fill="rgba(255,214,135,0.7)" fontFamily="monospace">
                {c.shortSha}
              </text>
            </g>
          );
        })}

        {/* Deploy markers */}
        {deployMarkers.map((d) => (
          <g key={d.target}>
            <line x1={d.x} y1={trunkY - 25} x2={d.x} y2={trunkY + 25}
              stroke={d.target === 'vercel-website' ? '#7dd3fc' : '#c4b5fd'}
              strokeWidth="2" strokeDasharray="4,3" />
            <circle cx={d.x} cy={trunkY - 30} r="4" fill={d.target === 'vercel-website' ? '#7dd3fc' : '#c4b5fd'} />
            <text x={d.x} y={trunkY - 38} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.7)">
              {d.target === 'vercel-website' ? 'web' : 'cua'}
            </text>
          </g>
        ))}

        {/* Worktree side-streams (drawn below the trunk) */}
        {worktrees.slice(0, 4).map((w, i) => {
          const yOffset = trunkY + 50 + i * 20;
          const colors = ['#fb7185', '#a78bfa', '#34d399', '#60a5fa'];
          const c = colors[i % colors.length];
          return (
            <g key={w.name}>
              <path
                d={`M ${latestX} ${trunkY} Q ${latestX - 20} ${yOffset - 10} ${latestX - 60} ${yOffset}`}
                stroke={c} strokeWidth="2" fill="none" opacity="0.7"
              />
              <line x1={latestX - 60} y1={yOffset} x2={padding + 30} y2={yOffset}
                stroke={c} strokeWidth="2" strokeDasharray="2,3" opacity="0.7" />
              <circle cx={padding + 30} cy={yOffset} r="4" fill={c}>
                <animate attributeName="opacity" values="0.4;1;0.4" dur="2s" repeatCount="indefinite" />
              </circle>
              <text x={padding + 40} y={yOffset + 3} fontSize="10" fill="rgba(255,255,255,0.7)" fontFamily="monospace">
                {w.branch ?? w.name}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Floating tooltip */}
      {hover && (
        <div style={{
          position: 'absolute',
          top: '12px',
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '8px 12px',
          background: 'rgba(0,0,0,0.85)',
          color: 'white',
          borderRadius: '8px',
          fontSize: '12px',
          maxWidth: '480px',
          pointerEvents: 'none',
          backdropFilter: 'blur(8px)',
        }}>
          <div style={{ fontFamily: 'monospace', opacity: 0.6, fontSize: '10px', marginBottom: '2px' }}>
            {hover.shortSha} · {hover.authorName} · {timeAgo(hover.ts)}
          </div>
          <div>{hover.message}</div>
        </div>
      )}

      {/* Legend */}
      <div style={{
        marginTop: '12px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '14px',
        fontSize: '11px',
        color: 'rgba(255,255,255,0.7)',
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ffb347' }} />
          main branch
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#7dd3fc' }} />
          web deploy
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#c4b5fd' }} />
          cua deploy
        </span>
        {worktrees.length > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#fb7185' }} />
            active worktrees ({worktrees.length})
          </span>
        )}
        <a
          href={`https://github.com/Reeyenn/staxis/commits/main`}
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
