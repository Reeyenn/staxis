'use client';

// ════════════════════════════════════════════════════════════════════
// Staxis — the section the pill-bar badge points at. Two views behind
// one toggle:
//
//   Queue  the AI approval queue (decision cards). Unchanged.
//   Knows  everything the copilot believes about this hotel, where it
//          learned each thing, and Confirm / Edit / Remove for each.
//
// Deliberately NOT a new top-level nav tab — Knows belongs beside the
// queue because they are two halves of the same relationship with the
// copilot: what it wants to do, and what it thinks it knows.
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
  const es = lang === 'es';
  const [tab, setTab] = useState<FeedTab>('queue');

  const tabs: Array<{ key: FeedTab; label: string }> = [
    { key: 'queue', label: es ? 'Cola' : 'Queue' },
    { key: 'knows', label: es ? 'Sabe' : 'Knows' },
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
