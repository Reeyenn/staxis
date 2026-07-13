'use client';

// ════════════════════════════════════════════════════════════════════
// Staxis · the AI approval queue (Concourse shell).
// Decision cards with Approve / Adjust / Deny / Snooze — the section
// the pill-bar badge points at. (The pre-Concourse editorial feed and
// its /demo/feed showcase were deleted 2026-07-13 as retired design.)
// ════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic';

import React from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { QueueView } from '@/components/concourse/QueueView';
import { useLang } from '@/contexts/LanguageContext';

function FeedInner() {
  const { lang } = useLang();
  return <QueueView lang={lang} />;
}

export default function FeedPage() {
  return (
    <AppLayout>
      <FeedInner />
    </AppLayout>
  );
}
