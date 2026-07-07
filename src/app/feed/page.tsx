'use client';

// ════════════════════════════════════════════════════════════════════
// Staxis · Feed — the decision-feed home ("your hotel's inbox").
// Thin shell: the whole experience lives in _FeedExperience.tsx so the
// login-free /demo/feed design preview renders the identical page.
// ════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic';

import React from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { FeedExperience } from './_FeedExperience';

export default function FeedPage() {
  return (
    <AppLayout>
      <FeedExperience />
    </AppLayout>
  );
}
