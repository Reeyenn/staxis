'use client';

// ═══════════════════════════════════════════════════════════════════════════
// /home — the Concourse hub, the landing screen after login.
//
// Serif time-of-day greeting, the glowing Ask Staxis hero bar, and a board of
// live department tiles (one status line each, from /api/home/summary). Tiles
// respect the same per-hotel section toggles and financials gate as the pill
// bar. Not a "section" itself (sectionForPath → null) so it can never be
// gated off.
// ═══════════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic';

import React from 'react';
import { useRouter } from 'next/navigation';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useCan } from '@/lib/capabilities/useCan';
import { useEnabledSections } from '@/lib/sections/useSectionEnabled';
import { SECTION_LIST } from '@/lib/sections/registry';
import { isOnboardingInProgress, RESUME_GUARD_KEY } from '@/lib/onboarding/state';
import { HomeHubView, type HubTile, type TileTone } from '@/components/concourse/HomeHubView';
import { AskHero } from '@/components/concourse/AskHero';
import { fetchWithAuth } from '@/lib/api-fetch';

interface TileLine { en: string; es: string; tone: TileTone }
type Summary = Partial<Record<string, TileLine>>;

function greetingFor(lang: 'en' | 'es', name: string | undefined, hour: number): string {
  const who = name ? `, ${name}` : '';
  if (hour < 12) return lang === 'es' ? `Buenos días${who}` : `Good morning${who}`;
  if (hour < 18) return lang === 'es' ? `Buenas tardes${who}` : `Good afternoon${who}`;
  return lang === 'es' ? `Buenas noches${who}` : `Good evening${who}`;
}

function HomeHub() {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, loading: propertyLoading } = useProperty();
  const { lang } = useLang();
  const can = useCan();
  const enabled = useEnabledSections();
  const router = useRouter();
  const [summaryState, setSummaryState] = React.useState<{
    propertyId: string | null;
    tiles: Summary;
  }>({ propertyId: null, tiles: {} });
  const summary = summaryState.propertyId === activePropertyId
    ? summaryState.tiles
    : {};

  // Home is the universal post-login destination. Preserve the onboarding
  // safety net from the old property-selector/dashboard funnel so a returning
  // owner with a half-finished hotel resumes setup instead of seeing an empty
  // Home hub. Admins are never routed into a hotel's owner wizard.
  React.useEffect(() => {
    if (propertyLoading || !user || !activeProperty) return;
    if (
      user.role !== 'admin' &&
      isOnboardingInProgress(activeProperty.onboardingCompletedAt, activeProperty.onboardingState) &&
      typeof window !== 'undefined' &&
      sessionStorage.getItem(RESUME_GUARD_KEY) !== activeProperty.id
    ) {
      sessionStorage.setItem(RESUME_GUARD_KEY, activeProperty.id);
      window.location.href = `/api/onboard/resume?propertyId=${encodeURIComponent(activeProperty.id)}`;
    }
  }, [user, propertyLoading, activeProperty]);

  React.useEffect(() => {
    setSummaryState({ propertyId: activePropertyId, tiles: {} });
    if (!user || !activePropertyId || propertyLoading) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/api/home/summary?pid=${encodeURIComponent(activePropertyId)}`);
        const body = await res.json().catch(() => null);
        if (!cancelled && body?.ok && body.data?.tiles) {
          setSummaryState({ propertyId: activePropertyId, tiles: body.data.tiles as Summary });
        }
      } catch {
        // Tiles keep their quiet placeholder line — never block the hub on data.
      }
    })();
    return () => { cancelled = true; };
  }, [user, activePropertyId, propertyLoading]);

  const firstName = user?.displayName?.trim().split(/\s+/)[0];
  const now = new Date();
  const dateStr = now.toLocaleDateString(lang === 'es' ? 'es' : 'en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  const dateline = activeProperty ? `${dateStr} · ${activeProperty.name}` : dateStr;

  const tiles: HubTile[] = (propertyLoading ? [] : SECTION_LIST)
    .filter((m) => {
      if (!enabled[m.key]) return false;
      if (m.key === 'financials') return !!user && can('view_financials');
      return true;
    })
    .map((m) => {
      const line = summary[m.key];
      return {
        key: m.key,
        label: lang === 'es' ? m.label_es : m.label_en,
        status: line ? (lang === 'es' ? line.es : line.en) : '· · ·',
        tone: line?.tone ?? 'muted',
        hot: m.key === 'staxis',
        onClick: () => router.push(m.navHref),
      };
    });

  return (
    <HomeHubView
      greeting={greetingFor(lang, firstName, now.getHours())}
      dateline={dateline}
      tiles={tiles}
      ask={<AskHero />}
    />
  );
}

export default function HomePage() {
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, loading: propertyLoading } = useProperty();
  const router = useRouter();

  // Middleware protects full-page requests, but sign-out happens client-side.
  // Unmount the entire app shell immediately so cached hotel details are never
  // left visible, then navigate to Sign In. Zero-access accounts return to the
  // selector's explicit empty state instead of an inert Home shell.
  React.useEffect(() => {
    if (authLoading || propertyLoading) return;
    if (!user) router.replace('/signin');
    else if (!activeProperty) router.replace('/property-selector');
  }, [user, authLoading, activeProperty, propertyLoading, router]);

  if (authLoading || propertyLoading || !user || !activeProperty) return null;

  return (
    <AppLayout>
      <HomeHub />
    </AppLayout>
  );
}
