'use client';

// ═══════════════════════════════════════════════════════════════════════════
// ConcourseBar — the connected pill bar (replaces Header in AppLayout).
//
// Wires ConcourseBarView to the real app: section pills from the section
// registry (filtered by the per-hotel toggles + the financials capability
// gate, exactly like the old Header), logo → /home hub, gear → /settings,
// and an avatar dropdown that keeps who you are, hotel switching, and sign out.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { useCan } from '@/lib/capabilities/useCan';
import { useEnabledSections } from '@/lib/sections/useSectionEnabled';
import { SECTION_LIST } from '@/lib/sections/registry';
import {
  ConcourseBarView,
  type AdminDestinationAction,
  type BarItem,
} from './ConcourseBarView';
import { QUEUE_COUNT_EVENT, shouldReadDecisionBadge, staxisPillBadge } from './queue-count';
import { fetchWithAuth } from '@/lib/api-fetch';
import { PhoneHandoffDialog } from '@/components/phone-handoff/PhoneHandoffDialog';
import { InstallStaxisDialog } from '@/components/pwa/InstallStaxisDialog';
import { useInstallStaxis } from '@/contexts/InstallStaxisContext';
import { shouldShowMobileInstallReminder } from '@/lib/pwa-install';
import { Download, Smartphone } from 'lucide-react';
import { roleLabel } from '@/lib/roles';
import { MobileConcourseNav } from './MobileConcourseNav';
import { useReliableNavigation } from '@/lib/hooks/use-reliable-navigation';
import { useOptionalPortfolio } from '@/contexts/PortfolioContext';
import { useOptionalHotelActingContext } from '@/contexts/HotelActingContext';
import { mapPortfolioUiRoute } from '@/lib/portfolio-ui/context';
import type { AppSection } from '@/lib/sections/registry';
import { useTheme } from '@/contexts/ThemeContext';

// ── The decisions badge, across remounts ────────────────────────────────────
// Same remount problem, same shape of fix. The bar is torn down and rebuilt on
// every navigation, so a plain mount fetch would hit the count endpoint on
// every single page change. These two module-level values survive the remount:
//
//   SESSION_BADGE  the last count we actually read, and which hotel it is for.
//                  Rehydrates the pill instantly on the next mount — no flash
//                  of a missing badge between pages — and tells the mount
//                  effect whether it needs to read at all.
//   LAST_SHELL_PATH  where the manager just came FROM. Leaving /feed is the
//                  one navigation that must always re-read: they were looking
//                  at the cards, they may have just cleared them, and a badge
//                  still claiming "3" over an empty queue is exactly the kind
//                  of lie that teaches people to stop trusting the number.
//
// There is deliberately no polling loop and no realtime subscription. The
// triggers are: first sight of a hotel, coming back to the tab, and walking
// away from the feed.
let SESSION_BADGE: { pid: string; count: number } | null = null;
let LAST_SHELL_PATH: string | null = null;

function markHotelSelectedThisTab(): void {
  try { window.sessionStorage.setItem('hotelops-session-selected', '1'); } catch {
    // Selection itself is held by PropertyContext. This optional funnel hint
    // must never break hotel switching in privacy-mode browsers.
  }
}

export function ConcourseBar() {
  const {
    user,
    signOut,
    authorizationChecked,
    platformAdmin,
    propertyStandings,
  } = useAuth();
  const { properties, activeProperty, loading: propertyLoading, setActivePropertyId } = useProperty();
  const can = useCan();
  const { lang } = useLang();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const portfolio = useOptionalPortfolio();
  const acting = useOptionalHotelActingContext();
  const { resolvedTheme, toggleTheme } = useTheme();
  const navigation = useReliableNavigation();
  const enabled = useEnabledSections();
  const { platform, installed } = useInstallStaxis();
  const purePortfolioContext = pathname === '/portfolio'
    || pathname.startsWith('/portfolio/')
    || acting?.request.kind === 'portfolio_scope';
  const portfolioHotelContext = acting?.context?.source === 'portfolio'
    ? acting.context
    : null;
  const portfolioScoped = purePortfolioContext || Boolean(portfolioHotelContext);
  const selectedCompany = portfolio?.data?.selectedCompany ?? null;
  const portfolioOrganizationId = selectedCompany?.organizationId
    ?? portfolioHotelContext?.organization?.id
    ?? null;
  const portfolioOrganizationName = selectedCompany?.organizationName
    ?? portfolioHotelContext?.organization?.name
    ?? null;
  const portfolioQueueAvailable = purePortfolioContext
    ? selectedCompany?.queueAvailable === true
    : portfolioHotelContext?.portfolioFeatures.queueAvailable === true;
  const portfolioFinancialsAvailable = purePortfolioContext
    ? selectedCompany?.capabilities.canViewFinancials === true
    : portfolioHotelContext?.standing.seesFinancials === true;
  const companyOnly = !portfolioScoped
    && !propertyLoading
    && !!user
    && properties.length === 0
    && user.role !== 'admin';
  const portfolioHomeHref = portfolioOrganizationId
    ? `/portfolio?organizationId=${encodeURIComponent(portfolioOrganizationId)}`
    : '/portfolio/choose';
  const companyHref = portfolioOrganizationId
    ? `/company?scope=portfolio&organizationId=${encodeURIComponent(portfolioOrganizationId)}`
    : '/company';
  const homeHref = portfolioScoped
    ? portfolioHomeHref
    : companyOnly
      ? '/company'
      : '/home';
  const homeLabel = portfolioScoped
    ? ('Portfolio Home')
    : companyOnly
      ? ('Company Hub')
      : ('Home');
  const showCompanyInMobileNavigation = Boolean(user && (!companyOnly || portfolioScoped));
  const adminWorkspaceActive = pathname === '/admin' || pathname.startsWith('/admin/');
  const verifiedPlatformAdmin = Boolean(
    authorizationChecked && platformAdmin && user?.role === 'admin',
  );
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [phoneHandoffOpen, setPhoneHandoffOpen] = React.useState(false);
  const [installStaxisOpen, setInstallStaxisOpen] = React.useState(false);
  // The bar wrap is a horizontal scroll container (mobile), which clips
  // anything hanging below it — so the menu is portaled to <body> at a
  // fixed position measured from the avatar button. The bar is sticky, so
  // the measured rect stays put while the menu is open.
  const avatarWrapRef = React.useRef<HTMLDivElement | null>(null);
  const avatarButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const installReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const [menuPos, setMenuPos] = React.useState<{ top: number; right: number } | null>(null);
  const toggleMenu = () => {
    const r = avatarWrapRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ top: r.bottom + 10, right: Math.max(8, window.innerWidth - r.right) });
    setMenuOpen((v) => !v);
  };

  // Navigation feel: prefetch only on real pointer/focus intent. The previous
  // delayed all-route batch launched every section's server render together and
  // competed with the page the user was actually opening. The clicked pill
  // still lights immediately while Next commits the destination.
  const pendingHref = navigation.pendingHref;
  const prefetch = navigation.prefetch;
  const go = navigation.push;
  const replace = navigation.replace;
  const adminLabel = 'Admin';
  const adminDestination: AdminDestinationAction | undefined = verifiedPlatformAdmin
    ? {
        label: adminLabel,
        ariaLabel: 'Open Staxis Admin',
        active: adminWorkspaceActive,
        onIntent: () => prefetch('/admin/properties#live'),
        onClick: () => go('/admin/properties#live'),
      }
    : undefined;
  const companyNavigationLabel = portfolioScoped
    ? ('My Portfolio')
    : user?.role === 'admin'
    ? ('Management')
    : ('Company Hub');

  // The server-rendered admin surface and every admin API already re-check the
  // database role. This client redirect only retires an already-open shell as
  // soon as the fresh session-authorization read confirms demotion. An initial
  // check or transient failure never redirects a still-verified administrator.
  React.useEffect(() => {
    if (!authorizationChecked || verifiedPlatformAdmin || !adminWorkspaceActive) return;
    replace('/home');
  }, [adminWorkspaceActive, authorizationChecked, replace, verifiedPlatformAdmin]);

  // ── Decisions badge on the Staxis pill ────────────────────────────────────
  // Counts "do this now" cards only — never FYIs, questions or recommendations.
  // Starts with no badge at all and stays that way at zero.
  const propertyId = activeProperty?.id ?? null;
  const activePropertyStanding = propertyId
    ? (propertyStandings ?? []).find((standing) => standing.propertyId === propertyId) ?? null
    : null;
  const signedIn = !!user;
  const canSeeBadge = !portfolioScoped && shouldReadDecisionBadge(user, propertyId);
  const [badge, setBadge] = React.useState<{ pid: string; count: number } | null>(SESSION_BADGE);

  const readBadge = React.useCallback(async (pid: string) => {
    try {
      const res = await fetchWithAuth(
        `/api/findings/badge?propertyId=${encodeURIComponent(pid)}`,
      );
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: { count?: unknown } }
        | null;
      const n = body?.ok ? body.data?.count : undefined;
      if (typeof n !== 'number' || !Number.isFinite(n)) return;
      // Stamped with the hotel it was read for. A response that lands after the
      // manager switched hotels is simply not the active hotel's number, and
      // the render below ignores it rather than showing hotel A's count on
      // hotel B's pill.
      SESSION_BADGE = { pid, count: n };
      setBadge(SESSION_BADGE);
    } catch {
      // A failed read is NOT an all-clear. Keep the last known count.
    }
  }, []);

  // First sight of this hotel in this browser session. Signing out drops the
  // remembered count on the floor: the next person at this browser must not
  // inherit a number read against someone else's hotel access.
  React.useEffect(() => {
    if (!canSeeBadge || !propertyId) {
      if (!signedIn) SESSION_BADGE = null;
      setBadge(null);
      return;
    }
    if (SESSION_BADGE?.pid === propertyId) { setBadge(SESSION_BADGE); return; }
    void readBadge(propertyId);
  }, [canSeeBadge, signedIn, propertyId, readBadge]);

  // Back to the tab. A manager who left Staxis open on a second monitor all
  // morning should not come back to last night's number.
  React.useEffect(() => {
    if (!canSeeBadge || !propertyId) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void readBadge(propertyId);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [canSeeBadge, propertyId, readBadge]);

  // Walking away from the feed — the one navigation that always re-reads.
  // Written against `pathname` rather than mount order so it holds whether or
  // not React reuses the bar across a route change.
  React.useEffect(() => {
    const cameFrom = LAST_SHELL_PATH;
    LAST_SHELL_PATH = pathname;
    if (!canSeeBadge || !propertyId) return;
    if (!cameFrom || cameFrom === pathname) return;
    if (cameFrom === '/feed' || cameFrom.startsWith('/feed/')) void readBadge(propertyId);
  }, [pathname, canSeeBadge, propertyId, readBadge]);

  // A live queue source saying "something changed". Treated as a nudge to
  // re-read, never as the number itself — see queue-count.ts.
  React.useEffect(() => {
    if (!canSeeBadge || !propertyId) return;
    const onQueueCount = () => { void readBadge(propertyId); };
    window.addEventListener(QUEUE_COUNT_EVENT, onQueueCount);
    return () => window.removeEventListener(QUEUE_COUNT_EVENT, onQueueCount);
  }, [canSeeBadge, propertyId, readBadge]);

  const decisionBadge = staxisPillBadge(
    badge && badge.pid === propertyId ? badge.count : 0,
    lang,
  );

  // Same visibility rules as the old Header: per-hotel section toggles hide
  // pills entirely; Financials additionally needs the view_financials
  // capability (server routes enforce the same gate independently).
  const portfolioRouteFor = (key: AppSection): string => {
    if (purePortfolioContext) {
      if (!portfolioOrganizationId) return '/portfolio/choose';
      return key === 'staxis'
        ? `/portfolio/staxis?organizationId=${encodeURIComponent(portfolioOrganizationId)}`
        : `/portfolio/${key}?organizationId=${encodeURIComponent(portfolioOrganizationId)}`;
    }
    if (portfolioHotelContext && acting?.request.kind === 'hotel') {
      return mapPortfolioUiRoute(key === 'staxis' ? 'feed' : key, acting.request.context, {
        existing: searchParams,
        returnTo: acting.request.returnTo,
      });
    }
    return SECTION_LIST.find((section) => section.key === key)?.navHref ?? '/home';
  };
  const items: BarItem[] = (
    portfolioScoped
      ? SECTION_LIST
      : propertyLoading || !activeProperty
        ? []
        : SECTION_LIST
  )
    .filter((m) => {
      if (portfolioScoped) {
        if (m.key === 'staxis') return portfolioQueueAvailable;
        if (m.key === 'financials') return portfolioFinancialsAvailable;
        return purePortfolioContext
          || portfolioHotelContext?.sectionAvailability[m.key] === true;
      }
      if (!enabled[m.key]) return false;
      if (m.key === 'financials') {
        return !!user && (activePropertyStanding
          ? activePropertyStanding.seesFinancials
          : can('view_financials'));
      }
      return true;
    })
    .map((m) => {
      const href = portfolioRouteFor(m.key);
      const portfolioPath = purePortfolioContext
        ? m.key === 'staxis' ? '/portfolio/staxis' : `/portfolio/${m.key}`
        : null;
      return {
        key: m.key,
        label: m.label_en,
        active: pendingHref
          ? pendingHref === href
          : portfolioPath
            ? pathname === portfolioPath || pathname.startsWith(`${portfolioPath}/`)
            : pathname === m.navHref || pathname.startsWith(m.navHref + '/'),
        badge: !portfolioScoped && m.key === 'staxis' ? decisionBadge?.count : undefined,
        badgeLabel: !portfolioScoped && m.key === 'staxis' ? decisionBadge?.label : undefined,
        onIntent: () => prefetch(href),
        onClick: () => go(href),
      };
    });

  const initial = (user?.displayName?.[0] ?? user?.username?.[0] ?? 'U').toUpperCase();
  const roleName = user?.role
    ? (roleLabel(user.role))
    : '';
  const userName = user?.displayName ?? user?.username ?? ('User');
  const userMeta = [
    roleName,
    portfolioScoped ? portfolioOrganizationName ?? 'Portfolio' : activeProperty?.name,
  ].filter(Boolean).join(' · ');
  const showInstallReminder = shouldShowMobileInstallReminder(
    platform,
    installed,
  );
  const closeInstallDialog = React.useCallback(
    () => setInstallStaxisOpen(false),
    [],
  );

  const avatar = user ? (
    <div ref={avatarWrapRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        ref={avatarButtonRef}
        type="button"
        className="cx-avatarbtn"
        onClick={toggleMenu}
        aria-label={'User menu'}
        aria-expanded={menuOpen}
      >
        {initial}
      </button>
      {menuOpen && menuPos && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 48 }} onClick={() => setMenuOpen(false)} />
          <div className="cx-menu" style={{ position: 'fixed', top: menuPos.top, right: menuPos.right, zIndex: 50 }}>
            <div className="cx-menu-head">
              <div className="cx-menu-name">{user.displayName ?? 'User'}</div>
              <div className="cx-menu-role">
                {user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : ''}
                {activeProperty ? ` · ${activeProperty.name}` : ''}
              </div>
            </div>

            {!portfolioScoped && properties.length > 1 && (
              <>
                <div className="cx-menu-eyebrow">{'Hotels'}</div>
                {properties.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`cx-menu-item${p.id === activeProperty?.id ? ' cx-on' : ''}`}
                    onClick={() => {
                      setActivePropertyId(p.id);
                      markHotelSelectedThisTab();
                      setMenuOpen(false);
                    }}
                  >
                    {p.name}
                  </button>
                ))}
              </>
            )}

            <button
              type="button"
              className="cx-menu-item"
              onClick={() => {
                toggleTheme();
                setMenuOpen(false);
              }}
            >
              {resolvedTheme === 'dark'
                ? ('Use light theme')
                : ('Use dark theme')}
            </button>

            {platform === 'desktop' ? (
              <button
                type="button"
                className="cx-menu-item cx-phone-item"
                onClick={() => {
                  setMenuOpen(false);
                  setPhoneHandoffOpen(true);
                }}
              >
                <Smartphone size={16} aria-hidden="true" />
                Open on my phone
              </button>
            ) : null}

            {showInstallReminder ? (
              <button
                type="button"
                className="cx-menu-item cx-phone-item cx-install-item"
                onClick={() => {
                  setMenuOpen(false);
                  installReturnFocusRef.current = avatarButtonRef.current;
                  setInstallStaxisOpen(true);
                }}
              >
                <Download size={16} aria-hidden="true" />
                Add Staxis to Home Screen
              </button>
            ) : null}

            <button
              type="button"
              className="cx-menu-item cx-danger"
              onClick={() => { void signOut(); setMenuOpen(false); }}
            >
              {t('signOut', lang)}
            </button>
          </div>
        </>,
        document.body,
      )}
    </div>
  ) : undefined;

  return (
    <>
      <MobileConcourseNav
        items={items}
        propertyOptions={(portfolioScoped ? [] : properties)
          .map((property) => ({ value: property.id, label: property.name }))}
        activePropertyId={activeProperty?.id ?? null}
        userName={userName}
        userMeta={userMeta}
        userInitial={initial}
        homeLabel={homeLabel}
        mobileTitle={pathname === '/inventory' || pathname.startsWith('/inventory/')
          ? ('Inventory')
          : adminWorkspaceActive
            ? adminLabel
            : pathname === '/company' || pathname.startsWith('/company/')
              ? companyNavigationLabel
              : undefined}
        menuLabel={'Open navigation'}
        closeLabel={'Close navigation'}
        navigationLabel={'Main navigation'}
        sectionsLabel={'Sections'}
        accountLabel={'Account'}
        propertyLabel={'Hotel'}
        accountMenuLabel={`Open user menu for ${userName}`}
        companyLabel={companyNavigationLabel}
        adminDestination={adminDestination}
        settingsLabel={'Settings'}
        signOutLabel={t('signOut', lang)}
        installLabel={'Add Staxis to Home Screen'}
        showInstallAction={showInstallReminder}
        showCompany={showCompanyInMobileNavigation}
        settingsActive={pathname.startsWith('/settings')}
        companyActive={pathname === '/company' || pathname.startsWith('/company/')}
        onHome={() => go(homeHref)}
        onCompany={() => go(companyHref)}
        onSettings={() => go(portfolioScoped ? companyHref : '/settings')}
        onHomeIntent={() => prefetch(homeHref)}
        onCompanyIntent={() => prefetch(companyHref)}
        onSettingsIntent={() => prefetch(portfolioScoped ? companyHref : '/settings')}
        onSignOut={() => { void signOut(); }}
        onPropertyChange={(propertyId) => {
          setActivePropertyId(propertyId);
          markHotelSelectedThisTab();
        }}
        onInstall={(returnFocusElement) => {
          installReturnFocusRef.current = returnFocusElement;
          setInstallStaxisOpen(true);
        }}
      />
      <ConcourseBarView
        items={items}
        adminDestination={adminDestination}
        gearActive={portfolioScoped ? pathname.startsWith('/company') : pathname.startsWith('/settings')}
        onGear={() => go(portfolioScoped ? companyHref : '/settings')}
        onLogo={() => go(homeHref)}
        onGearIntent={() => prefetch(portfolioScoped ? companyHref : '/settings')}
        onLogoIntent={() => prefetch(homeHref)}
        homeLabel={homeLabel}
        settingsLabel={'Settings'}
        avatar={avatar}
        // Away from the hub, the leftmost Staxis pill becomes a back-to-Home
        // control without changing the bar's visual language.
        showHome={pathname !== homeHref}
        desktopOnly
      />
      <PhoneHandoffDialog
        open={phoneHandoffOpen}
        onClose={() => setPhoneHandoffOpen(false)}
        returnFocusRef={avatarButtonRef}
      />
      <InstallStaxisDialog
        open={installStaxisOpen}
        onClose={closeInstallDialog}
        returnFocusRef={installReturnFocusRef}
      />
    </>
  );
}
