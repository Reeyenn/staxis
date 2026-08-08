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
import { RouteErrorState, RouteLoadingState } from '@/components/layout/RouteResourceState';
import { useReliableNavigation } from '@/lib/hooks/use-reliable-navigation';
import { usePortfolio } from '@/contexts/PortfolioContext';
import { useOptionalHotelActingContext } from '@/contexts/HotelActingContext';
import { shouldWaitForPortfolioEntry } from '@/lib/portfolio-ui/entry-routing';
import {
  companyDefaultEntryDestination,
  companyScopeHref,
  localAppHref,
  resolveHomeEntry,
} from '@/lib/portfolio-ui/acting-scope';
import { buildScopeSwitcherRows, type ScopeSwitcherRow } from '@/lib/portfolio-ui/scope-switcher';

interface TileLine { en: string; tone: TileTone }
type Summary = Partial<Record<string, TileLine>>;
type ManagementHubContext = 'company' | 'hotel';

function sessionHotelWasChosen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem('hotelops-session-selected') === '1';
  } catch {
    // A blocked sessionStorage must fail toward the company picker.
    return false;
  }
}

function markSessionHotelChosen(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem('hotelops-session-selected', '1');
  } catch {
    // A blocked marker keeps the next default entry on the safe selector.
  }
}

function greetingFor(lang: 'en' | 'es', name: string | undefined, hour: number): string {
  const who = name ? `, ${name}` : '';
  if (hour < 12) return `Good morning${who}`;
  if (hour < 18) return `Good afternoon${who}`;
  return `Good evening${who}`;
}

function HomeHub() {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, loading: propertyLoading } = useProperty();
  const { lang } = useLang();
  const can = useCan();
  const enabled = useEnabledSections();
  const navigation = useReliableNavigation();
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
    if (!shouldResumeOnboarding(user.accountId, user.role, activeProperty.onboardingCompletedAt, activeProperty.onboardingState, activeProperty.onboardingPromptShownAt)) return;
    // Automatic resume needs a durable one-shot guard. If storage is blocked,
    // stay on the terminal Home surface instead of risking a redirect loop.
    try {
      if (window.sessionStorage.getItem(RESUME_GUARD_KEY) === activeProperty.id) return;
      window.sessionStorage.setItem(RESUME_GUARD_KEY, activeProperty.id);
    } catch { return; }
    window.location.assign(`/api/onboard/resume?propertyId=${encodeURIComponent(activeProperty.id)}`);
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
  const dateStr = now.toLocaleDateString('en-US', {
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
        label: m.label_en,
        status: line ? (line.en) : '· · ·',
        tone: line?.tone ?? 'muted',
        hot: m.key === 'staxis',
        onIntent: () => navigation.prefetch(m.navHref),
        onClick: () => navigation.push(m.navHref),
      };
    });

  return (
    <>
      <HomeHubView
        greeting={greetingFor(lang, firstName, now.getHours())}
        dateline={dateline}
        tiles={tiles}
        ask={<AskHero />}
        management={user && managementContext ? {
          label: managementContext === 'company'
            ? ('Company Hub')
            : ('My Hotel'),
          href: '/company',
          onIntent: () => navigation.prefetch('/company'),
          onClick: () => navigation.push('/company'),
        } : undefined}
      />
    </>
  );
}

/**
 * Where to work, as a list. Company rows and hotel rows, exactly the rows the
 * avatar switcher shows, because this screen and that menu answer the same
 * question. This is what replaced the /portfolio/choose redirect: a person with
 * two management companies picks one here instead of being sent to a separate
 * world to do it.
 */
function ScopePicker({
  title,
  message,
  rows,
  onChoose,
}: {
  title: string;
  message: string;
  rows: readonly ScopeSwitcherRow[];
  onChoose: (row: ScopeSwitcherRow) => void;
}) {
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 20px 64px' }}>
      <h1 style={{
        fontFamily: 'var(--font-instrument-serif), serif',
        fontSize: 34,
        fontWeight: 400,
        letterSpacing: '-0.01em',
        margin: '0 0 8px',
      }}>
        {title}
      </h1>
      <p style={{ color: 'var(--text-secondary)', margin: '0 0 24px', lineHeight: 1.5 }}>
        {message}
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map((row) => (
          <button
            key={row.key}
            type="button"
            onClick={() => onChoose(row)}
            aria-current={row.active ? 'true' : undefined}
            style={{
              textAlign: 'left',
              padding: '14px 16px',
              borderRadius: 12,
              border: row.active
                ? '1.5px solid var(--accent, #3E5C48)'
                : '1px solid rgba(62,92,72,.18)',
              background: '#FFFFFF',
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            {row.label}
          </button>
        ))}
      </div>
    </main>
  );
}

export default function HomePage() {
  const { user, loading: authLoading, authorizationChecked } = useAuth();
  const {
    properties,
    activeProperty,
    activeScope,
    activeCompany,
    loading: propertyLoading,
    setActiveScope,
  } = useProperty();
  const portfolio = usePortfolio();
  const acting = useOptionalHotelActingContext();
  const navigation = useReliableNavigation();
  const replaceNavigation = navigation.replace;
  const pushNavigation = navigation.push;
  const hotelDrilldown = acting?.request.kind === 'hotel';
  const explicitActingScope = acting?.scope.kind === 'company'
    || acting?.request.kind === 'portfolio_scope';
  const portfolioEntryPending = shouldWaitForPortfolioEntry({
    hotelDrilldown,
    portfolioLoading: portfolio.loading,
  });
  // THE /portfolio REDIRECT IS GONE. Company view is a mode of this app, so a
  // company leader stays here and Home renders the company scope. The decision
  // is a pure function whose vocabulary contains no other world to send them to.
  const companyOptions = portfolio.data?.contexts ?? [];
  const companyHatUser = portfolio.data?.hasCompanyHat === true;
  const companyLandingDestination = hotelDrilldown || explicitActingScope
    ? null
    : companyDefaultEntryDestination({
        companyHat: companyHatUser,
        sessionSelected: sessionHotelWasChosen(),
        explicitScope: explicitActingScope,
        bootstrapError: portfolio.enabled && portfolio.error !== null,
      });
  const entry = resolveHomeEntry({
    authLoading,
    propertyLoading,
    portfolioEntryPending,
    signedIn: Boolean(user),
    scope: activeScope,
    companyOptionCount: companyOptions.length,
  });

  const switcherRows = buildScopeSwitcherRows({
    companies: companyOptions,
    hotels: properties.map((property) => ({ id: property.id, name: property.name })),
    activeScope,
  });
  const chooseScope = React.useCallback((row: ScopeSwitcherRow) => {
    if (row.kind === 'company') {
      if (!setActiveScope({ kind: 'company', organizationId: row.organizationId }).ok) return;
      pushNavigation(companyScopeHref('/home', row.organizationId));
      return;
    }
    if (!setActiveScope({ kind: 'hotel', propertyId: row.propertyId }).ok) return;
    markSessionHotelChosen();
    pushNavigation(localAppHref('/home'));
  }, [pushNavigation, setActiveScope]);

  // Middleware protects full-page requests, but sign-out happens client-side.
  // Unmount the entire app shell immediately so cached hotel details are never
  // left visible, then navigate to Sign In. Accounts with no company option and
  // no selected hotel keep the picker's explicit pending/empty state.
  React.useEffect(() => {
    if (companyLandingDestination === '/property-selector') {
      replaceNavigation('/property-selector');
      return;
    }
    if (entry.kind === 'signin') {
      replaceNavigation('/signin');
      return;
    }
    if (entry.kind === 'property_selector') replaceNavigation('/property-selector');
  }, [companyLandingDestination, entry.kind, replaceNavigation]);

  if (companyLandingDestination === '/property-selector') {
    return <RouteLoadingState title="Opening hotel selector…" />;
  }
  if (authLoading || (user && !authorizationChecked)) {
    return <RouteLoadingState title="Opening Home…" />;
  }
  if (entry.kind === 'wait') return <RouteLoadingState title="Opening Home…" />;
  if (entry.kind === 'signin') return <RouteLoadingState title="Returning to Sign In…" />;

  if (entry.kind === 'company') {
    const companyName = activeCompany?.organizationName
      ?? (activeScope.kind === 'company' ? activeScope.scope.name : 'your company');
    const companyHotelIds = activeScope.kind === 'company'
      ? new Set(activeScope.scope.propertyIds)
      : new Set<string>();
    const companyHotelRows = switcherRows.filter(
      (row) => row.kind === 'hotel' && companyHotelIds.has(row.propertyId.toLowerCase()),
    );
    return (
      <ScopePicker
        title={`${companyName} · All hotels`}
        message={companyHotelRows.length > 0
          ? 'The company view is on its way. For now, open one of these hotels to work in it.'
          : 'The company view is on its way. Your hotels will appear here once they load.'}
        rows={companyHotelRows}
        onChoose={chooseScope}
      />
    );
  }

  if (entry.kind === 'choose_scope') {
    return (
      <ScopePicker
        title="Where do you want to work?"
        message="Pick a company to see all of its hotels together, or open one hotel."
        rows={switcherRows}
        onChoose={chooseScope}
      />
    );
  }

  if (entry.kind === 'property_selector') {
    if (properties.length === 0) {
      return <RouteLoadingState title="Opening your workspace…" message="Checking company and hotel access." />;
    }
    return (
      <RouteErrorState
        title="No hotel is selected"
        message="Choose a hotel before opening Home."
        retryLabel="Choose a hotel"
        onRetry={() => pushNavigation('/property-selector')}
      />
    );
  }

  if (!activeProperty) return <RouteLoadingState title="Opening Home…" />;

  return <HomeHub />;
}
