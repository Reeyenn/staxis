'use client';

// ═══════════════════════════════════════════════════════════════════════════
// ConcourseBarView — the floating pill bar, presentational.
//
// Pure props in, clicks out: the connected app bar (ConcourseBar.tsx) renders
// THIS, so the shell can never drift from the real thing. Layout per the handoff: logo · divider · section
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
  /** Spoken form of the badge ("3 decisions waiting"). Required whenever
   *  `badge` is set: the pill carries an aria-label, which HIDES the badge's
   *  own text from a screen reader, so without this the number is visible to
   *  sighted users only. */
  badgeLabel?: string;
  onIntent?: () => void;
  onClick: () => void;
}

/** A Staxis-platform destination, separate from both hotel department tabs
 * and the hotel-level Admin tools switch inside `/company`. */
export interface AdminDestinationAction {
  label: string;
  ariaLabel: string;
  active: boolean;
  onIntent?: () => void;
  onClick: () => void;
}

export interface ConcourseBarViewProps {
  items: BarItem[];
  adminDestination?: AdminDestinationAction;
  gearActive: boolean;
  onGear: () => void;
  onLogo: () => void;
  onLogoIntent?: () => void;
  onGearIntent?: () => void;
  homeLabel: string;
  settingsLabel: string;
  /** Avatar slot — the connected bar passes its dropdown, the demo a plain circle. */
  avatar?: React.ReactNode;
  /** Replace the Staxis mark with a labelled back-to-Home control while away
   *  from the Home hub. The control stays in the same leftmost bar pill. */
  showHome?: boolean;
  /** The connected app supplies a dedicated phone header/drawer, so its
   *  desktop pill bar is hidden at the mobile breakpoint. Demo callers that
   *  do not supply the replacement keep the legacy scrollable preview. */
  desktopOnly?: boolean;
}

export function ConcourseBarView({
  items, adminDestination, gearActive, onGear, onLogo, onLogoIntent, onGearIntent,
  homeLabel, settingsLabel, avatar,
  showHome = false, desktopOnly = false,
}: ConcourseBarViewProps) {
  return (
    <div className={`cx-barwrap${desktopOnly ? ' cx-desktop-bar' : ''}`}>
      <CxStyle />
      <div className="cx-barcluster">
        <div className="cx-bar">
        {/* The same leftmost pill is the Staxis mark on Home and a persistent
            back-to-Home label everywhere else. */}
        <button
          type="button"
          className={`cx-pill${showHome ? ' cx-context-home' : ''}`}
          onClick={onLogo}
          onPointerEnter={onLogoIntent}
          onFocus={onLogoIntent}
          aria-label={homeLabel}
          title={homeLabel}
        >
          {showHome
            ? <CxIcon name="back" size={13} />
            : <CxLogo size={19} color="currentColor" />}
          <span className="cx-labw" aria-hidden>
            <span className="cx-lab">{homeLabel}</span>
          </span>
        </button>
        {items.length > 0 || adminDestination ? <span className="cx-divider" aria-hidden /> : null}
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            className={`cx-pill${it.active ? ' cx-active' : ''}`}
            onClick={it.onClick}
            onPointerEnter={it.onIntent}
            onFocus={it.onIntent}
            title={it.badgeLabel ? `${it.label} — ${it.badgeLabel}` : it.label}
            aria-label={it.badgeLabel ? `${it.label}, ${it.badgeLabel}` : it.label}
            aria-current={it.active ? 'page' : undefined}
          >
            <CxIcon name={it.key as never} size={16} />
            {/* Grid wrapper: 0fr→1fr animates open to the label's natural
                width — smoother than a max-width guess (no end-of-track snap). */}
            <span className="cx-labw"><span className="cx-lab">{it.label}</span></span>
            {typeof it.badge === 'number' && it.badge > 0 && (
              <span className="cx-badge" aria-hidden>{it.badge}</span>
            )}
          </button>
        ))}
        {items.length > 0 && adminDestination ? <span className="cx-divider" aria-hidden /> : null}
        {adminDestination ? (
          <button
            type="button"
            className={`cx-pill cx-utility-pill cx-admin-destination${adminDestination.active ? ' cx-active' : ''}`}
            onClick={adminDestination.onClick}
            onPointerEnter={adminDestination.onIntent}
            onFocus={adminDestination.onIntent}
            title={adminDestination.ariaLabel}
            aria-label={adminDestination.ariaLabel}
            aria-current={adminDestination.active ? 'page' : undefined}
          >
            <CxIcon name="admin" size={16} />
            <span className="cx-labw"><span className="cx-lab">{adminDestination.label}</span></span>
          </button>
        ) : null}
        <span className="cx-divider" aria-hidden />
        <button
          type="button"
          className={`cx-gear${gearActive ? ' cx-on' : ''}`}
          onClick={onGear}
          onPointerEnter={onGearIntent}
          onFocus={onGearIntent}
          aria-label={settingsLabel}
          aria-current={gearActive ? 'page' : undefined}
        >
          <CxIcon name="gear" size={16} />
        </button>
        {avatar}
        </div>
      </div>
    </div>
  );
}
