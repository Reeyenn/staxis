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
import { shouldResumeOnboarding, RESUME_GUARD_KEY } from '@/lib/onboarding/state';
import { HomeHubView, type HubTile, type TileTone } from '@/components/concourse/HomeHubView';
import { AskHero } from '@/components/concourse/AskHero';
import { fetchWithAuth } from '@/lib/api-fetch';

interface TileLine { en: string; es: string; tone: TileTone }
type Summary = Partial<Record<string, TileLine>>;
type ManagementHubContext = 'company' | 'hotel';

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
    managementContext: ManagementHubContext | null;
  }>({ propertyId: null, tiles: {}, managementContext: null });
  const summary = summaryState.propertyId === activePropertyId
    ? summaryState.tiles
    : {};
  const managementContext = summaryState.propertyId === activePropertyId
    ? summaryState.managementContext
    : null;

  // Home is the universal post-login destination. Preserve the onboarding
  // safety net from the old property-selector/dashboard funnel so a returning
  // owner with a half-finished hotel resumes setup instead of seeing an empty
  // Home hub. Admins are never routed into a hotel's owner wizard.
  React.useEffect(() => {
    if (propertyLoading || !user || !activeProperty) return;
    if (
      shouldResumeOnboarding(user.role, activeProperty.onboardingCompletedAt, activeProperty.onboardingState, activeProperty.onboardingPromptShownAt) &&
      typeof window !== 'undefined' &&
      sessionStorage.getItem(RESUME_GUARD_KEY) !== activeProperty.id
    ) {
      sessionStorage.setItem(RESUME_GUARD_KEY, activeProperty.id);
      window.location.href = `/api/onboard/resume?propertyId=${encodeURIComponent(activeProperty.id)}`;
    }
  }, [user, propertyLoading, activeProperty]);

  React.useEffect(() => {
    setSummaryState({ propertyId: activePropertyId, tiles: {}, managementContext: null });
    if (!user || !activePropertyId || propertyLoading) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/api/home/summary?pid=${encodeURIComponent(activePropertyId)}`);
        const body = await res.json().catch(() => null);
        if (!cancelled && body?.ok && body.data?.tiles) {
          setSummaryState({
            propertyId: activePropertyId,
            tiles: body.data.tiles as Summary,
            managementContext: body.data.managementContext === 'company'
              ? 'company'
              : body.data.managementContext === 'hotel'
                ? 'hotel'
                : null,
          });
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
      management={user && user.role !== 'admin' && managementContext ? {
        sectionLabel: lang === 'es' ? 'Gestión' : 'Management',
        label: managementContext === 'company'
          ? (lang === 'es' ? 'Centro de empresa' : 'Company Hub')
          : (lang === 'es' ? 'Mi hotel' : 'My Hotel'),
        description: managementContext === 'company'
          ? (lang === 'es' ? 'Gestiona hoteles, personas y acceso' : 'Manage hotels, people, and access')
          : (lang === 'es' ? 'Gestiona tu equipo y acceso' : 'Manage your team and access'),
        href: '/company',
      } : undefined}
    />
  );
}

export default function HomePage() {
  const { user, loading: authLoading } = useAuth();
  const { properties, activeProperty, loading: propertyLoading } = useProperty();
  const router = useRouter();

  // Middleware protects full-page requests, but sign-out happens client-side.
  // Unmount the entire app shell immediately so cached hotel details are never
  // left visible, then navigate to Sign In. Property-less company leaders go
  // directly to Company Hub; other zero-access accounts keep the selector's
  // explicit pending/empty state.
  React.useEffect(() => {
    if (authLoading || propertyLoading) return;
    if (!user) {
      router.replace('/signin');
      return;
    }
    if (activeProperty) return;
    if (user.role === 'admin' || properties.length > 0) {
      router.replace('/property-selector');
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithAuth('/api/company-access');
        const body = await response.json().catch(() => ({})) as {
          ok?: boolean;
          data?: { organizations?: Array<{ type?: string }> };
        };
        const hasCustomerOrganization = response.ok
          && body.ok === true
          && body.data?.organizations?.some((organization) => organization.type !== 'single_hotel') === true;
        if (!cancelled) router.replace(hasCustomerOrganization ? '/company' : '/property-selector');
      } catch {
        if (!cancelled) router.replace('/property-selector');
      }
    })();

    return () => { cancelled = true; };
  }, [user, authLoading, properties.length, activeProperty, propertyLoading, router]);

  if (authLoading || propertyLoading || !user || !activeProperty) return null;

  return (
    <AppLayout>
      <HomeHub />
    </AppLayout>
  );
}
