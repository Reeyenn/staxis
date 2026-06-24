'use client';

/**
 * SHARED — the SOURCE screen the robot read a feed from.
 *
 * Extracted byte-for-byte from the two identical copies that used to live in
 * the live mapper board (/admin/properties/mapper/[jobId]) and the Coverage
 * Editor (/admin/properties/coverage/[propertyId]). Both surfaces render the
 * SAME card: lets an admin verify the robot pulled each feed off the RIGHT PMS
 * page. Lazily fetched by the host page (only when a feed is expanded) and
 * lazily decoded; degrades to a calm empty state until the worker has captured
 * one. feature/cua-admin-mapper-visibility.
 */

import { Camera, Loader2 } from 'lucide-react';
import { FONT_MONO } from '@/app/admin/_components/studio/kit';
import { dimWhite } from '@/app/admin/_components/studio/surface-kit';
import type { ColumnGeometry } from '@/lib/pms/column-geometry';

/** Per-feed source-screenshot fetch state (lazy — populated on first expand).
 *  `geometry` (feature/cua-click-to-map) carries each column's on-screen box so
 *  the editor can drag-select a column on the screenshot; null when the capture
 *  predates geometry or the feed isn't a table. */
export interface CaptureState { loading: boolean; url: string | null; geometry?: ColumnGeometry | null }

export function FeedCaptureView({ state, onError }: { state?: CaptureState; onError?: () => void }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{
        fontFamily: FONT_MONO, fontSize: 10, color: dimWhite(.5),
        letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 6,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <Camera size={11} /> Source screen the robot read
      </div>
      {!state || state.loading ? (
        <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.4), display: 'flex', alignItems: 'center', gap: 6 }}>
          <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> Loading the screenshot…
        </div>
      ) : state.url ? (
        <div style={{
          width: '100%', maxWidth: 760, border: `1px solid ${dimWhite(.14)}`,
          borderRadius: 8, overflow: 'hidden', lineHeight: 0,
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={state.url}
            alt="The PMS screen the robot captured this feed from (sensitive fields redacted)"
            loading="lazy"
            // A signed URL that's gone stale (the 1h signature lapsed, or the
            // object was swept) degrades to the empty state and clears the
            // cache so re-expanding refetches a fresh URL.
            onError={onError}
            style={{ width: '100%', height: 'auto', display: 'block' }}
          />
        </div>
      ) : (
        <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: dimWhite(.4) }}>
          No screenshot captured for this feed yet.
        </div>
      )}
    </div>
  );
}
