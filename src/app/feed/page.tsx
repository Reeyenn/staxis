'use client';

// ════════════════════════════════════════════════════════════════════
// Staxis · the AI approval queue (Concourse shell).
// Decision cards with Approve / Adjust / Deny / Snooze — the section
// the pill-bar badge points at. The previous editorial feed experience
// lives on in _FeedExperience.tsx (still rendered by /demo/feed).
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
