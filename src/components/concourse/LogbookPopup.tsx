'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The log book, as a button on the Staxis page.
//
// It used to be a nav item inside Communications. Communications is Messages
// now, so the log book needed a home, and the founder's is a BUTTON on the
// Staxis page (right side, under the Queue/Knows row, down by profile and
// settings) that opens a popup. Same shape as Maintenance's "Patterns spotted".
//
// The pane inside is the EXISTING LogbookMode, unchanged and not copied: it
// already owns list ⇄ detail, the 8-second poll, replies, and the create form,
// and a second implementation would be a second set of bugs. It reads and
// writes /api/comms/logbook, which no longer dies when the Communications
// section is off (ONE_LIST_CTX).
//
// The switch inside is the merge control: turn it on and the shift notes also
// appear as rows in the list itself, ranked under everything that is actual
// work. Per person, per hotel, off by default.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';

import { CommsOverlay } from '@/app/communications/_components/comms-ui';
import { LogbookMode } from '@/app/communications/_components/LogbookPane';
import { commsFontVars } from '@/app/communications/_components/comms-fonts';

const IDENTITY = (english: string) => english;

export interface LogbookPopupProps {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  meName: string;
  /** Whether log book entries are merged into the main list. */
  merged: boolean;
  /** Null while the preference read is in flight; the switch waits rather than
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
  if (!open) return null;

  return (
    <CommsOverlay
      onClose={onClose}
      scrim="rgba(31,35,28,0.32)"
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
        boxShadow: '0 24px 60px rgba(31,35,28,.18)',
      }}
    >
      <div style={{ padding: '16px 18px 10px', borderBottom: '1px solid rgba(31,35,28,.07)' }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: '#1F231C' }}>Log book</div>
        <div style={{ fontSize: 12.5, color: '#5C625C', marginTop: 3, lineHeight: 1.5 }}>
          What happened on shift, in the crew&apos;s own words.
        </div>
      </div>

      {/* The pane reads its typography from the Communications font variables,
          which are defined by a className rather than inline styles. Carried in
          on this wrapper so the pane looks the same here as it did on its old
          tab, without the Staxis page adopting those fonts everywhere. */}
      <div className={commsFontVars} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <LogbookMode key={propertyId} pid={propertyId} meName={meName} L={IDENTITY} />
      </div>

      <div style={{ padding: '10px 18px 14px', borderTop: '1px solid rgba(31,35,28,.07)' }}>
        <div className="sl-sw">
          <label className="sl-swl" htmlFor="logbook-in-list">Include log book in Staxis</label>
          <input
            id="logbook-in-list"
            type="checkbox"
            checked={merged}
            disabled={!mergeReady || mergeBusy}
            onChange={(e) => onToggleMerge(e.target.checked)}
            style={{ width: 20, height: 20, accentColor: '#5C7A60', cursor: mergeReady ? 'pointer' : 'default' }}
          />
        </div>
        <div style={{ fontSize: 11.5, color: '#8A9187', lineHeight: 1.5 }}>
          When this is on, log book entries also show up in your list, under anything that needs doing.
        </div>
        {mergeError && <div className="sl-err">{mergeError}</div>}
        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="fd-act" onClick={onClose}>Close</button>
        </div>
      </div>
    </CommsOverlay>
  );
}
