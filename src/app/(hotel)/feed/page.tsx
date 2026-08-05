'use client';

// ════════════════════════════════════════════════════════════════════
// Staxis — the section the pill-bar badge points at, and the page a GM
// lands on to run the hotel.
//
// ONE PAGE, NO TABS.
//
// It used to be two views behind a `Queue` / `Knows` toggle sitting at
// the top of the screen. The 2026-08-01 redesign deleted that pair
// outright, and the reason is worth keeping: the toggle put "what
// Staxis has NOTICED" and "what Staxis BELIEVES" at identical weight,
// so half the time a manager arrived on the one they had not come for,
// and both halves read as dev buttons rather than product.
//
// What replaced it:
//   • the page IS the queue. There is no queue affordance, because
//     there is nothing else it could be.
//   • Knows is one button in the right rail that opens a slide-over
//     panel over this page. The page stays mounted behind it, so it is
//     never somewhere you have to navigate back from. Every capability
//     it had is untouched; only the way in changed.
//
// `?tab=knows` still works — the old Communications Knowledge and
// Contacts screens redirect here — and now opens that panel. It is read
// in StaxisList, which owns the panel's open state.
//
// (The pre-Concourse editorial feed and its /demo/feed showcase were
// deleted 2026-07-13 as retired design.)
// ════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic';

import React from 'react';
import { QueueView } from '@/components/concourse/QueueView';
import { useLang } from '@/contexts/LanguageContext';

function FeedInner() {
  const { lang } = useLang();
  return <QueueView lang={lang} />;
}

export default function FeedPage() {
  return (

      <FeedInner />

  );
}
