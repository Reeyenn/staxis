'use client';

// ════════════════════════════════════════════════════════════════════
// Staxis — the section the pill-bar badge points at. Two views behind
// one toggle:
//
//   Queue  what Staxis has NOTICED at this hotel — findings, each with
//          the numbers behind it, and where Staxis has a fix it can
//          perform, an offer the manager approves. (It was once an "AI
//          approval queue" and only that; calling it one now describes
//          a minority of what is on the screen, and reads as though
//          nothing appears here unless a robot wants permission.)
//   Knows  everything the copilot believes about this hotel, where it
//          learned each thing, and Confirm / Edit / Remove for each.
//
// Deliberately NOT a new top-level nav tab — Knows belongs beside the
// queue because they are two halves of the same relationship with the
// copilot: what it has seen, and what it thinks it knows.
//
// (The pre-Concourse editorial feed and its /demo/feed showcase were
// deleted 2026-07-13 as retired design.)
// ════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic';

import React, { useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { QueueView } from '@/components/concourse/QueueView';
import { KnowsView } from '@/components/concourse/KnowsView';
import { CxStyle } from '@/components/concourse/concourse-css';
import { useLang } from '@/contexts/LanguageContext';

type FeedTab = 'queue' | 'knows';

function FeedInner() {
  const { lang } = useLang();
  const es = false;
  const [tab, setTab] = useState<FeedTab>('queue');

  // ?tab=knows opens straight on Knows. Added because the old Communications
  // Knowledge and Contacts screens now redirect here — landing a redirect on
  // the Queue tab would be a link that visibly goes to the wrong place.
  //
  // Read in an effect rather than during render: useSearchParams would force a
  // Suspense boundary, and reading window during render is a hydration
  // mismatch (React #418). Same mount-gated pattern CommsApp uses for ?view=.
  React.useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get('tab') === 'knows') setTab('knows');
    } catch { /* no search params available — keep the default */ }
  }, []);

  const tabs: Array<{ key: FeedTab; label: string }> = [
    { key: 'queue', label: 'Queue' },
    { key: 'knows', label: 'Knows' },
  ];

  return (
    <>
      <CxStyle />
      {/* Same max-width as the page bodies below so the toggle lines up with
          their titles instead of floating against the viewport edge. */}
      <div className="cx-page" style={{ paddingTop: 22, paddingBottom: 0 }}>
        <div className="cx-seg" style={{ width: 'fit-content' }} role="tablist">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={tab === t.key ? 'cx-on' : ''}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {tab === 'queue' ? <QueueView lang={lang} /> : <KnowsView lang={lang} />}
    </>
  );
}

export default function FeedPage() {
  return (
    <AppLayout>
      <FeedInner />
    </AppLayout>
  );
}
