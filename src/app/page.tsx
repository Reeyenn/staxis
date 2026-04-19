'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';

export default function RootPage() {
  const { user, loading: authLoading } = useAuth();
  const { properties, loading: propLoading } = useProperty();
  const router = useRouter();

  useEffect(() => {
    if (authLoading || propLoading) return;

    if (!user) {
      router.replace('/signin');
      return;
    }

    // Check if the user has already selected a property this session
    const sessionSelected = typeof window !== 'undefined'
      && sessionStorage.getItem('hotelops-session-selected') === '1';

    if (sessionSelected) {
      router.replace('/dashboard');
    } else {
      // Always route through property-selector on new sessions.
      // It will auto-select if there's only 1 property.
      router.replace('/property-selector');
    }
  }, [user, authLoading, propLoading, properties, router]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            width: '48px',
            height: '48px',
            border: '3px solid rgba(212,144,64,0.2)',
            borderTopColor: 'var(--amber)',
            borderRadius: '50%',
            margin: '0 auto 16px',
            animation: 'spin 0.8s linear infinite',
          }}
        />
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Loading Staxis…</p>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
