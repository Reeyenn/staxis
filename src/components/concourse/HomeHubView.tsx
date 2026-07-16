'use client';

// ═══════════════════════════════════════════════════════════════════════════
// HomeHubView — the "Concourse" landing hub, presentational.
//
// Serif greeting → dateline → the glowing Ask Staxis hero bar (passed in as a
// slot so the real app wires it to the live agent while the demo stays inert)
// → the board of live department tiles. Shared by /home and /demo/concourse.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import { CxStyle } from './concourse-css';
import { CxIcon } from './icons';

export type TileTone = 'ok' | 'warn' | 'bad' | 'muted';

export interface HubTile {
  key: string;
  label: string;
  status: string;
  tone: TileTone;
  /** The Staxis tile gets the sage "hot" wash. */
  hot?: boolean;
  onClick: () => void;
}

export interface HomeHubViewProps {
  greeting: string;
  dateline: string;
  tiles: HubTile[];
  /** The Ask Staxis hero bar (AskHero in the app, an inert lookalike in the demo). */
  ask?: React.ReactNode;
}

export function HomeHubView({ greeting, dateline, tiles, ask }: HomeHubViewProps) {
  return (
    <div className="cx-hub cx-swap">
      <CxStyle />
      <h1 className="cx-greet" style={{ margin: 0 }}>{greeting}</h1>
      <div className="cx-dateline">{dateline}</div>
      {ask}
      <div className={`cx-board${tiles.length === 1 ? ' cx-board-single' : ''}`}>
        {tiles.map((tile) => {
          const toneCls = tile.tone === 'warn' ? ' cx-warn' : tile.tone === 'bad' ? ' cx-bad' : '';
          return (
            <button
              key={tile.key}
              type="button"
              className={`cx-tile${tile.hot ? ' cx-hot' : ''}`}
              onClick={tile.onClick}
              style={{ appearance: 'none' }}
            >
              <div className="cx-tile-top">
                <span className="cx-chip"><CxIcon name={tile.key as never} size={17} /></span>
                <span className={`cx-dot${toneCls}${tile.tone === 'muted' ? ' cx-mut' : ''}`} aria-hidden />
              </div>
              <div className="cx-tile-lab">{tile.label}</div>
              <div className={`cx-tile-status${toneCls}${tile.tone === 'ok' ? ' cx-ok' : ''}`}>
                {tile.status}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
