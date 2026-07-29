'use client';

export const dynamic = 'force-dynamic';

// Compatibility route for old bookmarks. Hotel-facing account and team work
// now lives in My Hotel -> People. Staxis administrators keep using the
// internal property account console so the customer preview remains read-only.

import React from 'react';

import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useReliableNavigation } from '@/lib/hooks/use-reliable-navigation';

export default function AccountsCompatibilityPage() {
  const { replace } = useReliableNavigation();
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propertyLoading } = useProperty();
  const { lang } = useLang();

  React.useEffect(() => {
    if (authLoading || propertyLoading || !user) return;
    if (user.role === 'admin') {
      replace(activePropertyId
        ? `/admin/properties/${encodeURIComponent(activePropertyId)}`
        : '/admin/properties#live');
      return;
    }
    replace('/company?tab=people');
  }, [activePropertyId, authLoading, propertyLoading, replace, user]);

  return (
    <AppLayout>
      <div
        role="status"
        aria-live="polite"
        style={{ padding: '64px 24px', textAlign: 'center', color: 'var(--text-muted)' }}
      >
        {'Opening My Hotel\u2026'}
      </div>
    </AppLayout>
  );
}
