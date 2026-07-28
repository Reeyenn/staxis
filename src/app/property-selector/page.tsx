'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The screen everybody lands on after signing in.
//
// It draws itself from /api/property-selector/bootstrap and NOT from
// PropertyContext, and that is the point of the rewrite rather than a detail of
// it. PropertyContext filters the hotel list by `accounts.property_access` —
// the array stamped on an account when its invitation was accepted. It is a
// SNAPSHOT: a hotel the company bought last week is covered by every company
// hat the moment the relationship row exists, and it was still missing here, so
// the only way to see it was to re-invite the person. The route resolves
// coverage through the spine (`accessibleProperties`: one exclusive authority
// mode, with normalized entitlements expanded over current topology) and the
// new hotel simply appears without reviving stale legacy ids.
//
// PropertyContext is still used for ONE thing — `setActivePropertyId`, which is
// what the rest of the app reads. It is a localStorage write, not a lookup, so
// it takes whichever hotel the person actually chose here.
//
// See CommandCenter.tsx for the two audiences this one screen serves.
// ═══════════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic';

import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { shouldResumeOnboarding, RESUME_GUARD_KEY } from '@/lib/onboarding/state';
import { safeRedirect } from '@/lib/url-redirect';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { OnboardingState } from '@/lib/onboarding/state';
import { useNavigationReady, useReliableNavigation } from '@/lib/hooks/use-reliable-navigation';
import { useAuthorizationRefreshKey } from '@/lib/hooks/use-authorization-refresh-key';

import JoinStatusGate from './JoinStatusGate';
import {
  CommandCenterFailed,
  CommandCenterView,
  type CommandCenterPayload,
  type PickerHotel,
} from './CommandCenter';
import { authorizedCompanySelection, companyBootstrapPath } from './company-selection';

function Spinner() {
  return (
    <div style={{
      minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'radial-gradient(ellipse 900px 460px at 50% 0%,#FFFFFF 0%,#F5F7F4 100%)',
    }}>
      <div style={{
        width: 34, height: 34,
        border: '2.5px solid rgba(62,92,72,.14)',
        borderTopColor: '#3E5C48',
        borderRadius: '50%',
        animation: 'cc-spin .8s linear infinite',
      }} />
      <style>{'@keyframes cc-spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );
}

export default function PropertySelectorPage() {
  useNavigationReady();
  const { user, loading: authLoading, signOut } = useAuth();
  const { setActivePropertyId } = useProperty();
  const { lang } = useLang();
  const navigation = useReliableNavigation();
  const replaceNavigation = navigation.replace;
  const [companyRouteChecked, setCompanyRouteChecked] = useState(false);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string | null>(null);
  const authorizationIdentityKey = user
    ? `${user.uid}:${user.accountId}:${user.role}:${[...user.propertyAccess].sort().join(',')}`
    : null;
  const authorizationViewerKey = useAuthorizationRefreshKey(
    authorizationIdentityKey,
    !authLoading && Boolean(user),
  );

  // Redirect unauthenticated users to sign-in.
  useEffect(() => {
    if (!authLoading && !user) replaceNavigation('/signin');
  }, [user, authLoading, replaceNavigation]);

  const { data, error, reload } = useApiResource<CommandCenterPayload>(
    companyBootstrapPath(selectedOrganizationId),
    {
      enabled: !authLoading && !!user,
      // Same-UID role/grant updates are authorization changes even though the
      // endpoint URL is stable. Drop the old picker payload immediately and
      // re-resolve server coverage so revoked hotels never remain selectable.
      identityKey: authorizationViewerKey ?? 'signed-out',
    },
  );

  const hotels = data?.hotels ?? [];
  const requiresCompanySelection = Boolean(
    data && !data.company && (data.requiresCompanySelection || data.companies.length > 1),
  );
  const companySelectionMismatch = Boolean(
    data
      && selectedOrganizationId
      && data.company?.organizationId !== selectedOrganizationId,
  );

  const selectCompany = useCallback((organizationId: string) => {
    const authorized = authorizedCompanySelection(data?.companies ?? [], organizationId);
    if (!authorized || authorized === selectedOrganizationId) return;
    // Switching the URL is a resource-identity change. useApiResource discards
    // the old payload before fetching, so neither hotels nor chat from company
    // A can render under company B while the new authorization is checked.
    setCompanyRouteChecked(false);
    setSelectedOrganizationId(authorized);
  }, [data?.companies, selectedOrganizationId]);

  // Route into the app — UNLESS this property's onboarding isn't finished, in
  // which case keep the owner in the wizard (a half-onboarded hotel has no PMS
  // and an empty dashboard). The server resolves the resume code. Full
  // navigation (not router.replace) so the API route's 302 is followed.
  const enter = useCallback((hotel: PickerHotel) => {
    // Mid-onboarding owner/manager → resume the wizard, but only the FIRST time
    // it's ever opened for this hotel. RESUME_GUARD_KEY is the same-session
    // loop breaker: a failed resume bounces back here and falls through to Home.
    const onboardingNeedsResume = shouldResumeOnboarding(
      user?.role,
      hotel.onboardingCompletedAt,
      hotel.onboardingState as OnboardingState | null,
      hotel.onboardingPromptShownAt,
    );
    if (onboardingNeedsResume && typeof window !== 'undefined') {
      // A blocked sessionStorage must not crash hotel selection or create an
      // unguarded resume loop. In that environment, continue to the terminal
      // Home surface just as Home's own resume guard does.
      try {
        if (sessionStorage.getItem(RESUME_GUARD_KEY) !== hotel.propertyId) {
          sessionStorage.setItem(RESUME_GUARD_KEY, hotel.propertyId);
          window.location.assign(`/api/onboard/resume?propertyId=${encodeURIComponent(hotel.propertyId)}`);
          return;
        }
      } catch { /* storage unavailable — continue into the selected hotel */ }
    }
    setActivePropertyId(hotel.propertyId);
    try { sessionStorage.setItem('hotelops-session-selected', '1'); } catch { /* optional funnel hint */ }
    // Ordinary login lands on Home. A protected deep link is honored only after
    // the user has explicitly selected which hotel it belongs to.
    const requestedTarget = typeof window === 'undefined'
      ? '/home'
      : safeRedirect(new URLSearchParams(window.location.search).get('redirect'), '/home');
    replaceNavigation(requestedTarget);
  }, [replaceNavigation, setActivePropertyId, user?.role]);

  // Exactly one hotel and nothing company-scope to show → skip the screen
  // entirely. A company person with one hotel keeps the command centre: their
  // queue and their ask line are the reason they opened Staxis, not the door.
  useEffect(() => {
    if (!data || data.company || requiresCompanySelection) return;
    if (data.hotels.length === 1) enter(data.hotels[0]);
  }, [data, enter, requiresCompanySelection]);

  // Organization-only leaders intentionally have no inferred legacy hotel
  // access. On later ordinary sign-ins, distinguish them from pending hotel
  // staff before showing the zero-property approval gate. With the spine
  // resolving coverage above this is now rare — a company that operates no
  // hotels yet — but it is still the right destination for that person.
  useEffect(() => {
    if (authLoading || !data || !user) return;
    if (requiresCompanySelection) {
      setCompanyRouteChecked(true);
      return;
    }
    if (hotels.length > 0 || user.role === 'admin') {
      setCompanyRouteChecked(true);
      return;
    }

    setCompanyRouteChecked(false);
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithAuth('/api/company-access');
        const body = await response.json().catch(() => ({})) as {
          ok?: boolean;
          data?: { organizations?: Array<{ id: string; type?: string }> };
        };
        const hasCustomerOrganization = body.data?.organizations?.some(
          (organization) => organization.type !== 'single_hotel',
        ) === true;
        if (!cancelled && response.ok && body.ok && hasCustomerOrganization) {
          replaceNavigation('/company');
          return;
        }
      } catch {
        // The existing join-status screen remains the safe fallback when the
        // additive organization projection is unavailable.
      }
      if (!cancelled) setCompanyRouteChecked(true);
    })();

    return () => { cancelled = true; };
  }, [authLoading, data, hotels.length, replaceNavigation, requiresCompanySelection, user]);

  const handleSignOut = useCallback(async () => {
    try {
      sessionStorage.removeItem('hotelops-session-selected');
      sessionStorage.removeItem(RESUME_GUARD_KEY);
    } catch { /* sign-out must continue when storage is blocked */ }
    await signOut();
  }, [signOut]);

  // A failed read is NOT "you have no hotels". It says so and offers a retry —
  // never a silent empty picker.
  if (error && !data) {
    return (
      <CommandCenterFailed
        lang={lang}
        onRetry={() => void reload()}
        onChooseAnotherCompany={selectedOrganizationId
          ? () => {
              setCompanyRouteChecked(false);
              setSelectedOrganizationId(null);
            }
          : undefined}
        onSignOut={handleSignOut}
      />
    );
  }

  // A cached/proxied response for a different organization is never rendered.
  // The server binds private responses and re-authorizes the id; this client
  // check closes the visual boundary if either of those invariants regresses.
  if (companySelectionMismatch) {
    return (
      <CommandCenterFailed
        lang={lang}
        onRetry={() => {
          setCompanyRouteChecked(false);
          setSelectedOrganizationId(null);
        }}
        onSignOut={handleSignOut}
      />
    );
  }

  const settling = authLoading
    || !user
    || !data
    // A single-hotel person is mid-redirect; showing them the door they are
    // already walking through would be a flash of a screen they never chose.
    || (!requiresCompanySelection && !data.company && data.hotels.length === 1)
    || (!requiresCompanySelection
      && hotels.length === 0
      && user.role !== 'admin'
      && !companyRouteChecked);

  if (settling) return <Spinner />;

  // Account with ZERO hotel access → hand off to the join-status gate. For a
  // pending staff signup it shows the "waiting for approval" screen; for a
  // genuinely property-less account it falls back to "No properties found".
  if (hotels.length === 0 && !requiresCompanySelection) {
    return <JoinStatusGate lang={lang} onSignOut={handleSignOut} />;
  }

  return (
    <CommandCenterView
      key={data.company?.organizationId ?? 'company-choice'}
      payload={data}
      lang={lang}
      onOpenHotel={enter}
      onSelectCompany={selectCompany}
      onSignOut={handleSignOut}
    />
  );
}
