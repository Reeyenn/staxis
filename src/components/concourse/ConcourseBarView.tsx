'use client';

// ═══════════════════════════════════════════════════════════════════════════
// ConcourseBarView — the floating pill bar, presentational.
//
// Pure props in, clicks out: the connected app bar (ConcourseBar.tsx) and the
// login-free /demo/concourse preview both render THIS, so the demo can never
// drift from the real thing. Layout per the handoff: logo · divider · section
// pills (icon-only inactive, icon+label active) · divider · EN/ES segmented
// toggle · settings gear · avatar slot.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import { CxStyle } from './concourse-css';
import { CxIcon, CxLogo } from './icons';

export interface BarItem {
  key: string;
  label: string;
  active: boolean;
  badge?: number;
  onClick: () => void;
}

export interface ConcourseBarViewProps {
  items: BarItem[];
  gearActive: boolean;
  onGear: () => void;
  onLogo: () => void;
  homeLabel: string;
  settingsLabel: string;
  /** Avatar slot — the connected bar passes its dropdown, the demo a plain circle. */
  avatar?: React.ReactNode;
  /** Show a labelled Home button in the empty space left of the centered bar
   *  (every screen except the /home hub). Replaces the old full-width row that
   *  used to sit under the bar — reclaims that vertical line. */
  showHome?: boolean;
}

export function ConcourseBarView({
  items, gearActive, onGear, onLogo, homeLabel, settingsLabel, avatar, showHome = false,
}: ConcourseBarViewProps) {
  return (
    <div className="cx-barwrap">
      <CxStyle />
      <div className="cx-bar">
        {/* Home button lives right beside the logo, as the first item in the
            bar (every screen except the /home hub). */}
        {showHome && (
          <button type="button" className="cx-pill cx-homepill" onClick={onLogo} aria-label={homeLabel} title={homeLabel}>
            <CxIcon name="back" size={15} />
            <span className="cx-labw"><span className="cx-lab">{homeLabel}</span></span>
          </button>
        )}
        {/* Logo is a pill like the rest: same green hover pull-out, word = "Home". */}
        <button type="button" className="cx-pill" onClick={onLogo} aria-label={homeLabel} title={homeLabel}>
          <CxLogo size={19} color="currentColor" />
          <span className="cx-labw" aria-hidden>
            <span className="cx-lab">{homeLabel}</span>
          </span>
        </button>
        <span className="cx-divider" aria-hidden />
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            className={`cx-pill${it.active ? ' cx-active' : ''}`}
            onClick={it.onClick}
            title={it.label}
            aria-label={it.label}
            aria-current={it.active ? 'page' : undefined}
          >
            <CxIcon name={it.key as never} size={16} />
            {/* Grid wrapper: 0fr→1fr animates open to the label's natural
                width — smoother than a max-width guess (no end-of-track snap). */}
            <span className="cx-labw"><span className="cx-lab">{it.label}</span></span>
            {typeof it.badge === 'number' && it.badge > 0 && (
              <span className="cx-badge">{it.badge}</span>
            )}
          </button>
        ))}
        <span className="cx-divider" aria-hidden />
        <button
          type="button"
          className={`cx-gear${gearActive ? ' cx-on' : ''}`}
          onClick={onGear}
          aria-label={settingsLabel}
          aria-current={gearActive ? 'page' : undefined}
        >
          <CxIcon name="gear" size={16} />
        </button>
        {avatar}
      </div>
    </div>
  );
}
