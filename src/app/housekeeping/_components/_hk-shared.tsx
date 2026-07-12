'use client';

// Area-local helpers shared across the housekeeping manager tabs.
//
// PMS connection strips: RoomsTab and ScheduleTab both render the same two
// leading FeedLearningBanner strips — "Connecting to your PMS." (pending) and
// "PMS connection paused." (paused) — with identical structure. The paused
// strip's copy is byte-identical between the two tabs; the pending strip's
// title is shared but its body text differs per tab (rooms vs schedule), so
// that text stays a prop. Each tab's own third "still learning" banner is
// tab-specific and stays inline. Rendering is a verbatim move — same wrapper
// div + same FeedLearningBanner props — so behavior is unchanged.

import React from 'react';
import { FeedLearningBanner } from '@/components/FeedLearningBanner';

export function PmsConnPendingStrip({
  show, marginBottom, lang, text,
}: {
  show: boolean;
  marginBottom: number;
  lang: 'en' | 'es';
  text: string;
}) {
  if (!show) return null;
  return (
    <div style={{ marginBottom }}>
      <FeedLearningBanner
        variant="strip"
        title={lang === 'es' ? 'Conectando con tu PMS.' : 'Connecting to your PMS.'}
        text={text}
      />
    </div>
  );
}

export function PmsConnPausedStrip({
  show, marginBottom, lang,
}: {
  show: boolean;
  marginBottom: number;
  lang: 'en' | 'es';
}) {
  if (!show) return null;
  return (
    <div style={{ marginBottom }}>
      <FeedLearningBanner
        variant="strip"
        title={lang === 'es' ? 'Conexión con el PMS en pausa.' : 'PMS connection paused.'}
        text={lang === 'es'
          ? 'Los datos pueden estar desactualizados hasta que se reanude.'
          : 'Data may be out of date until it resumes.'}
      />
    </div>
  );
}
