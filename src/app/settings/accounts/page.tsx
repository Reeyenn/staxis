'use client';

export const dynamic = 'force-dynamic';

// Compatibility route for old bookmarks. Hotel-facing account and team work
// now lives in My Hotel -> People. Staxis administrators keep using the
// internal property account console so the customer preview remains read-only.

import React from 'react';
import { useRouter } from 'next/navigation';

import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { useProperty } from '@/contexts/PropertyContext';

export default function AccountsCompatibilityPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propertyLoading } = useProperty();
  const { lang } = useLang();

  React.useEffect(() => {
    if (authLoading || propertyLoading || !user) return;
    if (user.role === 'admin') {
      router.replace(activePropertyId
        ? `/admin/properties/${encodeURIComponent(activePropertyId)}`
        : '/admin/properties#live');
      return;
    }
    router.replace('/company?tab=people');
  }, [activePropertyId, authLoading, propertyLoading, router, user]);

  return (
    <AppLayout>
      <div
        role="status"
        aria-live="polite"
        style={{ padding: '64px 24px', textAlign: 'center', color: 'var(--text-muted)' }}
      >
        {lang === 'es' ? 'Abriendo Mi hotel\u2026' : 'Opening My Hotel\u2026'}
      </div>
    </AppLayout>
  );
}
