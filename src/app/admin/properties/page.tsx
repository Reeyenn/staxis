'use client';

/**
 * /admin/properties — Owner cockpit.
 *
 * Single tabbed admin home. The sticky header on top shows always-visible
 * stats (live hotels, onboarding, errors, jobs, MRR) plus the four tab
 * buttons. Each tab is a self-contained component fetching its own data.
 *
 * Tabs:
 *   - Onboarding (Phase 1): pipeline, PMS coverage, live mapping, sign-ups
 *   - Live hotels (Phase 1 baseline + Phase 2/5/6 layered on top)
 *   - System (Phase 7): Marvel-style timeline, scheduled jobs, roadmap, audit
 *   - Money (Phase 8): revenue, expenses, per-hotel economics
 *
 * Auth: admin role only — non-admins get a 403 message. /admin redirects
 * here via Header.tsx so the URL stays stable.
 *
 * The legacy fleet view that used to live on this page now lives inside
 * the Live hotels tab.
 */

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { ShieldAlert } from 'lucide-react';

import { StickyHeader, type AdminTab } from '@/app/admin/_components/StickyHeader';
import { OnboardingTab } from '@/app/admin/_components/tabs/OnboardingTab';
import { LiveHotelsTab } from '@/app/admin/_components/tabs/LiveHotelsTab';
import { SystemTab } from '@/app/admin/_components/tabs/SystemTab';
import { MoneyTab } from '@/app/admin/_components/tabs/MoneyTab';

const VALID_TABS: AdminTab[] = ['onboarding', 'live', 'system', 'money'];

function readHashTab(): AdminTab {
  if (typeof window === 'undefined') return 'onboarding';
  const h = window.location.hash.replace('#', '');
  return (VALID_TABS as string[]).includes(h) ? (h as AdminTab) : 'onboarding';
}

export default function AdminPropertiesPage() {
  const { user, loading: authLoading } = useAuth();
  // Initialize to 'onboarding' so SSR markup matches; the useEffect below
  // syncs to the URL hash on mount. This means a refresh on /admin/properties#system
  // lands you back on the System tab instead of bouncing to Onboarding.
  const [activeTab, setActiveTab] = useState<AdminTab>('onboarding');

  useEffect(() => {
    setActiveTab(readHashTab());
    const onHashChange = () => setActiveTab(readHashTab());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const handleTabChange = (t: AdminTab) => {
    setActiveTab(t);
    if (typeof window !== 'undefined') {
      // Use replaceState (not assignment) so we don't push a history entry
      // for every tab click — Reeyen flips between tabs constantly and
      // doesn't want to hit Back 12 times to leave the admin page.
      const url = `${window.location.pathname}${window.location.search}#${t}`;
      window.history.replaceState(null, '', url);
    }
  };

  if (authLoading || (user && user.role !== 'admin')) {
    return (
      <AppLayout>
        <div style={{ padding: '40px 24px', textAlign: 'center' }}>
          {authLoading
            ? <div className="spinner" style={{ width: '24px', height: '24px', margin: '0 auto' }} />
            : (
              <>
                <ShieldAlert size={32} color="var(--red)" style={{ marginBottom: '12px' }} />
                <p style={{ fontSize: '15px' }}>Admin access only.</p>
              </>
            )}
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
        <StickyHeader activeTab={activeTab} onTabChange={handleTabChange} />

        {activeTab === 'onboarding' && <OnboardingTab />}
        {activeTab === 'live' && <LiveHotelsTab />}
        {activeTab === 'system' && <SystemTab />}
        {activeTab === 'money' && <MoneyTab />}

        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    </AppLayout>
  );
}
