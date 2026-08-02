'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The log book, as a popup over the Staxis page.
//
// The pane inside is the EXISTING LogbookMode, not a copy: it already owns
// list ⇄ detail, the poll, replies and the create form, and a second
// implementation would be a second set of bugs. It reads and writes
// /api/comms/logbook, which does not die when the Communications section is
// off (ONE_LIST_CTX).
//
// The switch at the bottom is the merge control: turn it on and the shift
// notes also appear as rows on the timeline, under everything that is actual
// work. Per person, per hotel, off by default.
//
// ─── restyled for the 2026-08-01 page ──────────────────────────────────────
// This popup predates the /feed redesign and still wore the old list's skin.
// Two things came out of that:
//
//   1. IT WAS BROKEN. The redesign moved the row geometry out of LIST_CSS into
//      FEED_CSS and dropped `.sl-sw` / `.sl-swl` on the way. This file still
//      asked for both, so the merge switch lost its layout entirely and
//      rendered as a bare checkbox trailing a label at the foot of a long
//      scrolling pane. It still worked; almost nobody would have found it.
//      It now uses `.fx-sw`, the same switch the rail panel shows, so there is
//      one control in two places rather than two controls.
//   2. IT SAID TOO MUCH. A subtitle explaining what a log book is, and a
//      paragraph explaining what the switch does, above a switch whose label
//      already says it. Both gone.
//
// The pane's own serif title and count are suppressed here (`embedded`): the
// popup has a header, and two titles in one box is one title too many.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';

import { CommsOverlay } from '@/app/communications/_components/comms-ui';
import { LogbookMode } from '@/app/communications/_components/LogbookPane';
import { commsFontVars } from '@/app/communications/_components/comms-fonts';
import { CxIcon } from './icons';

const IDENTITY = (english: string) => english;

export interface LogbookPopupProps {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  meName: string;
  /** Whether log book entries are merged into the main list. */
  merged: boolean;
  /** False while the preference read is in flight; the switch waits rather than
   *  guessing, because a switch that flips itself a second after you look at it
   *  reads as the app fighting you. */
  mergeReady: boolean;
  onToggleMerge: (next: boolean) => void;
  mergeBusy?: boolean;
  mergeError?: string | null;
}

export function LogbookPopup({
  open, onClose, propertyId, meName,
  merged, mergeReady, onToggleMerge, mergeBusy = false, mergeError = null,
}: LogbookPopupProps) {
  const [count, setCount] = React.useState<number | null>(null);

  if (!open) return null;

  return (
    <CommsOverlay
      onClose={onClose}
      scrim="rgba(20,26,20,0.34)"
      zIndex={1000}
      align="center"
      padding={20}
      escToClose
      cardStyle={{
        width: 'min(760px, 100%)',
        maxHeight: '86vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: '#fff',
        borderRadius: 18,
        border: '1px solid rgba(31,35,28,.10)',
        boxShadow: '0 30px 60px -30px rgba(31,42,32,.55)',
      }}
    >
      <div className="fx-lbhead">
        <span className="fx-lbt">Log book</span>
        {/* Says nothing at all until the pane has actually read. A count is a
            claim, and "0" before the answer arrives is the wrong one. */}
        {count !== null && (
          <span className="fx-tally-r">{count === 1 ? '1 entry' : `${count} entries`}</span>
        )}
        <button type="button" className="fx-drawerx" aria-label="Close" onClick={onClose}>
          <CxIcon name="close" size={14} />
        </button>
      </div>

      {/* The pane reads its typography from the Communications font variables,
          which are set by a className rather than inline styles. Carried in on
          this wrapper so the pane looks the same here as on its old tab,
          without the Staxis page adopting those fonts everywhere. */}
      <div className={commsFontVars} style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex' }}>
        <LogbookMode key={propertyId} pid={propertyId} meName={meName} L={IDENTITY} embedded onCount={setCount} />
      </div>

      <div className="fx-lbfoot">
        {mergeError && <div className="sl-err">{mergeError}</div>}
        <div className="fx-foot">
          <span className="fx-footl" id="fx-lbsw-label">Show notes on the timeline</span>
          <button
            type="button"
            className="fx-sw"
            role="switch"
            aria-checked={merged}
            aria-labelledby="fx-lbsw-label"
            disabled={!mergeReady || mergeBusy}
            onClick={() => onToggleMerge(!merged)}
          />
        </div>
      </div>
    </CommsOverlay>
  );
}
