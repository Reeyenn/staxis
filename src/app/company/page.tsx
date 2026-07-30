'use client';

export const dynamic = 'force-dynamic';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  Hotel,
  Inbox,
  KeyRound,
  Layers3,
  MapPinned,
  RefreshCw,
  Search,
  ShieldCheck,
  UserPlus,
  Users,
  X,
} from 'lucide-react';

import { AppLayout } from '@/components/layout/AppLayout';
import { CompanyRulebookPanel } from '@/components/concourse/CompanyRulebookPanel';
import { useAuth, type AppUser } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { usePortfolio } from '@/contexts/PortfolioContext';
import { useProperty } from '@/contexts/PropertyContext';
import { RouteErrorState } from '@/components/layout/RouteResourceState';
import { fetchWithAuth } from '@/lib/api-fetch';
import { can as canForStanding } from '@/lib/capabilities/can';
import {
  EMPTY_COMPANY_ACCESS,
  legacyAccessProfile,
  titleCaseAccessValue,
  type CompanyAccessData,
  type CompanyAccessRequest,
  type CompanyAccessPermissions,
  type CompanyInvitation,
  type CompanyMembership,
  type CompanyOrganization,
  type CompanyPortfolio,
  type CompanyProperty,
  type EffectiveAccessReceipt,
} from '@/lib/company-access/dto';
import type {
  CompanyAccessEditorMembership,
  CompanyAccessEditorOrganization,
  CompanyAccessEditorProjection,
} from '@/lib/company-access/access-editor';
import type { CompanyStructureProjection } from '@/lib/company-access/structure';
import { buildCompanyAccessViewerKey } from '@/lib/company-access/viewer-key';
import { selectCompanyAccessContext } from '@/lib/company-access/select-company-context';
import { notifyAuthorizationChanged } from '@/lib/hooks/use-authorization-refresh-key';
import { useReliableNavigation } from '@/lib/hooks/use-reliable-navigation';
import type { StaffMember, Property } from '@/types';

import styles from './CompanyAccess.module.css';
import {
  CompanyLifecycleDialog,
  RequestAccessDialog,
  ReviewAccessRequestDialog,
  type CompanyLifecycleAction,
} from './_components/AccessWorkflowDialogs';
import { AccessEditorDialog } from './_components/AccessEditorDialog';
import { AdminHotelRelationshipManager } from './_components/AdminHotelRelationshipManager';
import { HotelTeamPanel } from './_components/HotelTeamPanel';
import { HotelSwitcher } from './_components/HotelSwitcher';
import { LegacyOwnershipTransferPanel } from './_components/LegacyOwnershipTransferPanel';
import {
  CompanyStructureManager,
  CompanyStructureOverview,
} from './_components/CompanyStructureManager';

type TabId = 'overview' | 'hotels' | 'people' | 'access';
type HotelStatusFilter = 'all' | 'active' | 'not_active';

interface TabDefinition {
  id: TabId;
  label: string;
  icon: typeof Building2;
}

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: string;
}

function isTabId(value: string | null): value is TabId {
  return value === 'overview'
    || value === 'hotels'
    || value === 'people'
    || value === 'access';
}

function formatDate(value: string | null | undefined, lang: string): string {
  if (!value) return 'No expiration';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(parsed);
}

function statusLabel(status: string, lang: string): string {
  const labels: Record<string, [string, string]> = {
    active: ['Active', 'Activo'],
    pending: ['Pending', 'Pendiente'],
    expiring: ['Expiring', 'Por vencer'],
    expired: ['Expired', 'Vencido'],
    revoked: ['Revoked', 'Revocado'],
    inactive: ['Inactive', 'Inactivo'],
    suspended: ['Suspended', 'Suspendido'],
    approved: ['Approved', 'Aprobado'],
    denied: ['Denied', 'Rechazado'],
  };
  const pair = labels[status] ?? [titleCaseAccessValue(status), titleCaseAccessValue(status)];
  return pair[0];
}

function statusClass(status: string): string {
  if (status === 'active' || status === 'approved') return styles.statusActive;
  if (status === 'pending' || status === 'expiring') return styles.statusPending;
  if (status === 'expired' || status === 'revoked' || status === 'denied') return styles.statusDanger;
  return styles.statusMuted;
}

function buildLegacyProjection(user: AppUser, properties: Property[]): CompanyAccessData {
  const manager = user.role === 'admin' || user.role === 'owner' || user.role === 'general_manager';
  const propertyRows: CompanyProperty[] = properties.map((property) => ({
    nodeId: `legacy-${property.id}:${property.id}`,
    id: property.id,
    name: property.name,
    organizationId: `legacy-${property.id}`,
    portfolioIds: [],
    relationshipType: 'property access',
    status: 'active',
  }));
  const organizations: CompanyOrganization[] = properties.map((property) => ({
    id: `legacy-${property.id}`,
    name: property.name,
    type: 'single_hotel',
    status: 'active',
    relationshipType: 'independent hotel',
    legacyPropertyId: property.id,
  }));

  return {
    ...EMPTY_COMPANY_ACCESS,
    organizations,
    properties: propertyRows,
    memberships: properties.map((property) => ({
      id: `legacy-membership-${property.id}`,
      organizationId: `legacy-${property.id}`,
      accountId: user.accountId,
      displayName: user.displayName,
      accessProfile: legacyAccessProfile(user.role),
      status: 'active',
      propertyIds: [property.id],
      isCurrentUser: true,
      grants: [],
      canSuspend: false,
      canResume: false,
      canRemove: false,
    })),
    effectiveAccess: [{
      id: 'legacy-effective-access',
      organizationId: properties.length === 1 ? `legacy-${properties[0].id}` : null,
      accessProfile: legacyAccessProfile(user.role),
      scopeType: 'property',
      scopeLabel: properties.length === 1
        ? properties[0].name
        : `${properties.length} assigned hotels`,
      propertyIds: properties.map((property) => property.id),
      source: 'Existing hotel access',
      grantedBy: null,
      expiresAt: null,
      jobTitle: user.role === 'general_manager' ? 'General Manager' : null,
      status: 'active',
    }],
    permissions: {
      viewHotels: true,
      viewPeople: manager,
      managePeople: manager,
      manageInvitations: manager,
      viewAccess: true,
      manageAccess: user.role === 'admin' || user.role === 'owner',
      viewActivity: manager,
      requestAccess: false,
      availableProfiles: user.role === 'admin'
        ? ['organization_owner', 'organization_admin', 'portfolio_manager', 'property_manager', 'department_lead', 'contributor', 'viewer', 'external_collaborator']
        : user.role === 'owner'
          ? ['property_manager', 'department_lead', 'contributor', 'viewer', 'external_collaborator']
          : user.role === 'general_manager'
            ? ['department_lead', 'contributor', 'viewer', 'external_collaborator']
            : [],
      delegationPolicies: [],
    },
    legacyFallback: true,
  };
}

function normalizeCompanyData(value: CompanyAccessData | null | undefined): CompanyAccessData {
  if (!value) return EMPTY_COMPANY_ACCESS;
  const viewerContext = value.viewerContext?.kind === 'staxis_admin_preview'
    && value.viewerContext.readOnly === true
    && typeof value.viewerContext.requestedPropertyId === 'string'
    && (value.viewerContext.scope === 'organization' || value.viewerContext.scope === 'property')
    && typeof value.viewerContext.targetId === 'string'
    && typeof value.viewerContext.targetName === 'string'
    ? value.viewerContext
    : undefined;
  const memberships = Array.isArray(value.memberships) ? value.memberships : [];
  const invitations = Array.isArray(value.invitations) ? value.invitations : [];
  const requests = Array.isArray(value.requests) ? value.requests : [];
  return {
    organizations: Array.isArray(value.organizations) ? value.organizations : [],
    portfolios: Array.isArray(value.portfolios) ? value.portfolios : [],
    properties: Array.isArray(value.properties) ? value.properties : [],
    memberships: viewerContext ? memberships.map((membership) => ({
      ...membership,
      isCurrentUser: false,
      canSuspend: false,
      canResume: false,
      canRemove: false,
      grants: Array.isArray(membership.grants)
        ? membership.grants.map((grant) => ({ ...grant, canRevoke: false }))
        : [],
    })) : memberships,
    effectiveAccess: viewerContext ? [] : (Array.isArray(value.effectiveAccess) ? value.effectiveAccess : []),
    invitations: viewerContext
      ? invitations.map((invitation) => ({ ...invitation, canCancel: false }))
      : invitations,
    requests: viewerContext
      ? requests.map((request) => ({ ...request, canReview: false }))
      : requests,
    activity: Array.isArray(value.activity) ? value.activity : [],
    permissions: viewerContext ? {
      ...EMPTY_COMPANY_ACCESS.permissions,
      viewHotels: true,
      viewPeople: true,
      viewAccess: true,
      viewActivity: true,
    } : { ...EMPTY_COMPANY_ACCESS.permissions, ...(value.permissions ?? {}) },
    legacyFallback: Boolean(value.legacyFallback),
    viewerContext,
  };
}

export default function CompanyAccessPage() {
  return (
    <React.Suspense fallback={<CompanyPageFallback />}>
      <CompanyAccessContent />
    </React.Suspense>
  );
}

function CompanyPageFallback() {
  return (
    <AppLayout>
      <div className={styles.page} aria-busy="true" aria-label="Loading My Hotel">
        <div className={styles.skeletonStack} aria-hidden="true">
          <div className={styles.skeletonPanel}><span /><strong /><small /><div /></div>
        </div>
      </div>
    </AppLayout>
  );
}

function CompanyAccessContent() {
  const router = useRouter();
  const { push: pushReliable } = useReliableNavigation();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const {
    user,
    loading: authLoading,
    authorizationChecked,
    platformAdmin,
    propertyStandings,
    authorizationFingerprint,
  } = useAuth();
  const {
    properties: contextProperties,
    activeProperty,
    activePropertyViewerKey,
    staff,
    staffLoaded,
    staffLoadFailed,
    staffViewerKey,
    capabilityOverrides,
    capabilityOverridesViewerKey,
    capabilityOverridesPropertyId,
    capabilityOverridesStatus,
    capabilityOverridesError,
    refreshCapabilities,
    loading: propertyLoading,
    setActivePropertyId,
    refreshStaff,
  } = useProperty();
  const { lang } = useLang();
  const portfolio = usePortfolio();
  const portfolioMode = searchParams.get('scope') === 'portfolio';

  const [data, setData] = React.useState<CompanyAccessData | null>(null);
  const [dataViewerKey, setDataViewerKey] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loadErrorViewerKey, setLoadErrorViewerKey] = React.useState<string | null>(null);
  const [adminTargetPropertyId, setAdminTargetPropertyId] = React.useState<string | null>(null);
  const [retryKey, setRetryKey] = React.useState(0);
  const [tab, setTab] = React.useState<TabId>(() => {
    const requested = searchParams.get('tab');
    return isTabId(requested) ? requested : 'overview';
  });
  const [query, setQuery] = React.useState('');
  const [hotelStatusFilter, setHotelStatusFilter] = React.useState<HotelStatusFilter>('all');
  const [selectedReceipt, setSelectedReceipt] = React.useState<EffectiveAccessReceipt | null>(null);
  const [teamInviteHotelId, setTeamInviteHotelId] = React.useState<string | null>(null);
  const [requestOpen, setRequestOpen] = React.useState(false);
  const [reviewRequest, setReviewRequest] = React.useState<CompanyAccessRequest | null>(null);
  const [lifecycleAction, setLifecycleAction] = React.useState<CompanyLifecycleAction | null>(null);
  const [adminToolsEnabled, setAdminToolsEnabled] = React.useState(false);
  const [structure, setStructure] = React.useState<CompanyStructureProjection | null>(null);
  const [structureViewerKey, setStructureViewerKey] = React.useState<string | null>(null);
  const [structureLoading, setStructureLoading] = React.useState(false);
  const [structureError, setStructureError] = React.useState<string | null>(null);
  const previewHeadingRef = React.useRef<HTMLHeadingElement | null>(null);
  const focusPreviewAfterRetryRef = React.useRef(false);
  const completeAccessMutation = React.useCallback(() => {
    notifyAuthorizationChanged();
    setRetryKey((value) => value + 1);
  }, []);

  const propertyKey = contextProperties.map((property) => property.id).sort().join(',');
  const accountId = user?.accountId ?? null;
  const userRole = user?.role ?? null;
  const activePropertyId = activeProperty?.id ?? null;
  // The local Admin view is privilege-bearing discovery just like the global
  // Admin destination. Never derive it from the initial browser account row;
  // wait for the fresh no-store session authorization verdict.
  const adminPreview = Boolean(
    authorizationChecked && platformAdmin && userRole === 'admin',
  );
  const currentViewerKey = user && authorizationChecked
    ? `${buildCompanyAccessViewerKey({
        uid: user.uid,
        accountId: user.accountId,
        role: user.role,
        propertyAccess: user.propertyAccess,
        resolvedPropertyKey: propertyKey,
        adminTargetPropertyId: adminPreview ? activePropertyId : null,
      })}:${authorizationFingerprint ?? 'unverified'}`
    : null;
  const capabilityViewerKey = activePropertyViewerKey;
  const hotelCapabilitiesReady = Boolean(
    activePropertyId
    && capabilityViewerKey
    && capabilityOverridesPropertyId === activePropertyId
    && capabilityOverridesViewerKey === capabilityViewerKey,
  );
  const hotelCapabilitiesLoading = Boolean(
    user && activePropertyId && (!authorizationChecked || !hotelCapabilitiesReady),
  );
  const matchingPropertyStandings = activePropertyId
    ? propertyStandings.filter((standing) => standing.propertyId === activePropertyId)
    : [];
  // Private hotel-team data is an operational surface, not a side effect of a
  // company title. Require the one fresh standing for this exact hotel, its
  // explicit mutation bit, and the capability evaluated with the standing's
  // hotel role. A stale accounts.role=owner must never turn a company-only
  // owner/VP/finance grant into hotel roster authority.
  const activePropertyStanding = matchingPropertyStandings.length === 1
    ? matchingPropertyStandings[0]
    : null;
  const hotelPresentationRole = platformAdmin
    ? 'admin'
    : activePropertyStanding?.operationalRole ?? null;
  const hotelMutationAuthorized = authorizationChecked && Boolean(
    platformAdmin || activePropertyStanding?.hotelMutationAllowed === true,
  );
  // A hotel switch clears readiness synchronously. Never reuse the previous
  // hotel's optimistic capability result while the next snapshot is loading.
  const canManageTeam = hotelCapabilitiesReady
    && hotelMutationAuthorized
    && canForStanding(
      hotelPresentationRole ? { role: hotelPresentationRole } : null,
      'manage_team',
      capabilityOverrides,
    );
  const canManageUsers = hotelCapabilitiesReady
    && hotelMutationAuthorized
    && canForStanding(
      hotelPresentationRole ? { role: hotelPresentationRole } : null,
      'manage_users',
      capabilityOverrides,
    );
  // Pay is payroll-private. `view_wages` sits on MANAGER_FLOOR_CAPABILITIES, so
  // it can never be granted down to line staff no matter what an admin sets,
  // and PUT/GET /api/staff/wages enforce it again server-side. Resolved here,
  // where the exact-hotel capability snapshot is already known to be current.
  const canViewWages = hotelCapabilitiesReady
    && authorizationChecked
    && Boolean(platformAdmin || activePropertyStanding?.seesFinancials === true)
    && canForStanding(
      hotelPresentationRole ? { role: hotelPresentationRole } : null,
      'view_wages',
      capabilityOverrides,
    );
  const staffBelongsToCurrentViewer = Boolean(activePropertyViewerKey
    && staffViewerKey === activePropertyViewerKey);
  const currentStaff = canManageTeam && staffBelongsToCurrentViewer
    ? staff
    : [];
  const currentStaffSettled = canManageTeam && staffBelongsToCurrentViewer
    && (staffLoaded || staffLoadFailed);
  const currentStaffUnavailable = canManageTeam && staffBelongsToCurrentViewer && staffLoadFailed;

  // Admin tools are an explicit, hotel-scoped choice. Never carry an enabled
  // mutation surface into a different hotel or a different signed-in role.
  React.useEffect(() => {
    setAdminToolsEnabled(false);
  }, [activePropertyId, userRole]);

  // Read language via a ref so the company-access load effect below does not
  // depend on `lang` — otherwise toggling EN/ES tears down the request, flashes
  // the loading state and refetches /api/company-access (or the admin preview),
  // clobbering the already-loaded workspace. `lang` is used only for error copy
  // inside this effect; every render-time localized(lang, …) still uses the
  // reactive `lang`.
  const langRef = React.useRef(lang);
  langRef.current = lang;

  React.useEffect(() => {
    if (!user || authLoading || propertyLoading || !authorizationChecked) return;
    if (!currentViewerKey) return;
    const requestedPropertyId = adminPreview ? activePropertyId : null;
    const requestedViewerKey = currentViewerKey;
    if (adminPreview && !requestedPropertyId) {
      setAdminTargetPropertyId(null);
      setData(null);
      setDataViewerKey(null);
      setLoadError('Select a hotel before opening Hotel View.');
      setLoadErrorViewerKey(requestedViewerKey);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setData(null);
    setDataViewerKey(null);
    setSelectedReceipt(null);
    setTeamInviteHotelId(null);
    setRequestOpen(false);
    setReviewRequest(null);
    setLifecycleAction(null);
    if (adminPreview) {
      setAdminTargetPropertyId(requestedPropertyId);
      // Never leave another hotel's preview visible while the new target loads.
      setQuery('');
      setHotelStatusFilter('all');
    }
    setLoading(true);
    setLoadError(null);
    setLoadErrorViewerKey(null);

    void (async () => {
      try {
        const endpoint = adminPreview
          ? `/api/admin/company-access-preview?pid=${encodeURIComponent(requestedPropertyId!)}`
          : '/api/company-access';
        const response = await fetchWithAuth(endpoint);
        const body = await response.json().catch(() => ({})) as Envelope<CompanyAccessData>;
        if (!response.ok || !body.ok || !body.data) {
          throw new Error(adminPreview
            ? 'Hotel View is unavailable for the selected hotel. Try again or return to Admin.'
            : body.error || 'Company access could not be loaded.');
        }
        const normalized = normalizeCompanyData(body.data);
        if (adminPreview && (
          normalized.viewerContext?.kind !== 'staxis_admin_preview'
          || normalized.viewerContext.readOnly !== true
          || normalized.viewerContext.requestedPropertyId !== requestedPropertyId
        )) {
          throw new Error('The admin preview response did not match the selected hotel.');
        }
        if (!cancelled) {
          setData(normalized);
          setDataViewerKey(requestedViewerKey);
          setLoadError(null);
          setLoadErrorViewerKey(null);
        }
      } catch (error) {
        if (cancelled) return;
        if (adminPreview) {
          // Admin preview must fail closed. The customer legacy fallback would
          // incorrectly expand an admin to every property in PropertyContext.
          setData(null);
          setDataViewerKey(null);
        } else {
          // Keep customers operational if the normalized schema is still
          // rolling out. The visible warning makes the partial state explicit.
          setData(buildLegacyProjection(user, contextProperties));
          setDataViewerKey(requestedViewerKey);
        }
        setLoadError(error instanceof Error
          ? error.message
          : 'Company access could not be loaded.');
        setLoadErrorViewerKey(requestedViewerKey);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [authLoading, currentViewerKey, propertyLoading, retryKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const adminTargetIsCurrent = !adminPreview || adminTargetPropertyId === activePropertyId;
  const dataBelongsToCurrentViewer = Boolean(currentViewerKey && dataViewerKey === currentViewerKey);
  const adminDataMatchesSelection = !adminPreview || Boolean(
    data?.viewerContext
    && data.viewerContext.requestedPropertyId === activePropertyId,
  );
  const unscopedCurrentData = adminTargetIsCurrent
    && dataBelongsToCurrentViewer
    && adminDataMatchesSelection
    ? data
    : null;
  const selectedPortfolioCompany = portfolioMode
    && portfolio.data?.selection.state === 'selected'
    && portfolio.data.selection.selectedOrganizationId === portfolio.requestedOrganizationId
    ? portfolio.data.selectedCompany
    : null;
  const portfolioNeedsSelection = portfolioMode
    && portfolio.data?.selection.state === 'needs_selection';

  React.useEffect(() => {
    if (!portfolioNeedsSelection) return;
    router.replace('/portfolio/choose');
  }, [portfolioNeedsSelection, router]);
  const currentData = portfolioMode
    ? unscopedCurrentData && selectedPortfolioCompany
      ? selectCompanyAccessContext(
          unscopedCurrentData,
          selectedPortfolioCompany.organizationId,
        )
      : null
    : unscopedCurrentData;
  const currentLoadError =
    adminTargetIsCurrent && loadErrorViewerKey === currentViewerKey ? loadError : null;
  const resolved = currentData ?? EMPTY_COMPANY_ACCESS;
  const customerStructureViewerKey = accountId && userRole && userRole !== 'admin'
    ? `${accountId}:${userRole}:company-structure:${authorizationFingerprint ?? 'unverified'}`
    : null;
  const currentStructure = !portfolioMode && customerStructureViewerKey
    && structureViewerKey === customerStructureViewerKey
    ? structure
    : null;

  React.useEffect(() => {
    if (!user || authLoading || propertyLoading) return;
    const viewerKey = user.role === 'admin'
      ? null
      : `${user.accountId}:${user.role}:company-structure:${authorizationFingerprint ?? 'unverified'}`;
    if (portfolioMode || !viewerKey || !currentData || currentData.legacyFallback) {
      setStructure(null);
      setStructureViewerKey(null);
      setStructureLoading(false);
      setStructureError(null);
      return;
    }

    let cancelled = false;
    setStructure(null);
    setStructureViewerKey(null);
    setStructureLoading(true);
    setStructureError(null);
    void (async () => {
      try {
        const response = await fetchWithAuth('/api/company-access/structure');
        const body = await response.json().catch(() => ({})) as Envelope<CompanyStructureProjection>;
        if (!response.ok || !body.ok || !body.data) {
          throw new Error(body.error || 'Live company structure could not be loaded.');
        }
        if (!cancelled) {
          setStructure(body.data);
          setStructureViewerKey(viewerKey);
        }
      } catch (caught) {
        if (!cancelled) {
          setStructure(null);
          setStructureViewerKey(viewerKey);
          setStructureError(caught instanceof Error
            ? caught.message
            : 'Live company structure could not be loaded.');
        }
      } finally {
        if (!cancelled) setStructureLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accountId, authLoading, authorizationFingerprint, currentData, portfolioMode, propertyLoading, retryKey, user, userRole]);
  // Tab NAMES, not tab keys. The `?tab=` values and the `company-tab-*` ids
  // below never change — old links and bookmarks keep working.
  //
  // Until 2026-07-27 a single-hotel manager saw a tab literally called
  // "My Hotel" *inside* the screen already called My Hotel, and it listed
  // hotels; their colleagues were filed under "My Team". People went looking
  // for employees under the tab that shared the page's name and found a hotel
  // list, which is a large part of why the hotel felt like it had two staff
  // directories. Every viewer now gets the same two plain nouns: "Hotels" is
  // buildings, "People" is humans.
  const tabs = React.useMemo<TabDefinition[]>(() => {
    return [
      { id: 'overview', label: 'Overview', icon: Building2 },
      { id: 'hotels', label: 'Hotels', icon: Hotel },
      { id: 'people', label: 'People', icon: Users },
      { id: 'access', label: 'Access', icon: KeyRound },
    ];
  }, []);

  React.useEffect(() => {
    const requested = searchParams.get('tab');
    const next = isTabId(requested) ? requested : 'overview';
    setTab(next);
    setQuery('');
    setHotelStatusFilter('all');
    if (next !== 'people') setTeamInviteHotelId(null);
    if (requested !== null && !isTabId(requested)) {
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', 'overview');
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }
  }, [pathname, router, searchParams]);

  React.useEffect(() => {
    if (loading || (user && !currentData && !currentLoadError)) return;
    if (tabs.some((item) => item.id === tab)) return;
    setTab('overview');
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', 'overview');
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [currentData, currentLoadError, loading, pathname, router, searchParams, tab, tabs, user]);

  const switchTab = (next: TabId) => {
    setTab(next);
    setQuery('');
    setHotelStatusFilter('all');
    if (next !== 'people') setTeamInviteHotelId(null);
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    let nextIndex = index;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    const next = tabs[nextIndex];
    switchTab(next.id);
    document.getElementById(`company-tab-${next.id}`)?.focus();
  };

  const viewerTransitionLoading = Boolean(
    user && currentViewerKey && !dataBelongsToCurrentViewer && !currentLoadError,
  );
  const propertyRosterLoading = currentData?.viewerContext?.scope === 'property'
    && !currentStaffSettled;
  const showLoading = authLoading
    || !authorizationChecked
    || propertyLoading
    || (portfolioMode && portfolio.loading)
    || (portfolioMode
      && !selectedPortfolioCompany
      && !portfolio.error
      && !portfolioNeedsSelection)
    || (adminPreview && !adminTargetIsCurrent)
    || (loading && !currentData)
    || viewerTransitionLoading
    || propertyRosterLoading
    || (tab === 'people' && hotelCapabilitiesLoading);
  const adminPreviewFailed = adminPreview && !showLoading && Boolean(currentLoadError) && !currentData;
  const adminViewerContext = adminPreview ? resolved.viewerContext : undefined;
  const adminToolsActive = Boolean(
    adminPreview
    && adminToolsEnabled
    && adminViewerContext
    && adminDataMatchesSelection,
  );
  const hotelTeamLocked = Boolean(
    showLoading
    || !currentData
    || ((adminPreview || resolved.viewerContext?.readOnly === true) && !adminToolsActive),
  );
  const workspaceTitle = adminPreview
    ? (adminViewerContext?.scope === 'organization'
        ? 'Company Hub'
        : adminViewerContext?.scope === 'property'
          ? 'My Hotel'
          : 'Hotel View')
    : portfolioMode
      ? 'My Portfolio'
      : 'Company & Access';
  const customerContextLabel = selectedPortfolioCompany?.organizationName
    ?? (resolved.organizations.length === 1
    ? resolved.organizations[0].name
    : resolved.organizations.length > 1
      ? `${resolved.organizations.length} company contexts`
      : null);
  const contextLabel = adminPreview
    ? adminViewerContext?.targetName ?? activeProperty?.name ?? null
    : customerContextLabel;
  const hotelRosterCount = resolved.viewerContext?.scope === 'property'
    ? currentStaff.filter((member) => member.isActive !== false).length
    : null;

  React.useEffect(() => {
    if (tab !== 'people' || !canManageTeam || hotelTeamLocked) {
      setTeamInviteHotelId(null);
    }
  }, [canManageTeam, hotelTeamLocked, tab]);

  React.useEffect(() => {
    if (!focusPreviewAfterRetryRef.current || showLoading) return;
    focusPreviewAfterRetryRef.current = false;
    if (adminViewerContext) {
      previewHeadingRef.current?.focus({ preventScroll: true });
      return;
    }
    document.getElementById('admin-preview-error-title')?.focus({ preventScroll: true });
  }, [adminViewerContext, adminPreviewFailed, showLoading]);

  return (
    <AppLayout>
      <div className={styles.page}>
        <header className={styles.hero}>
          <div className={styles.heroIdentity}>
            <div className={styles.heroMark} aria-hidden="true">
              <Building2 size={23} strokeWidth={1.8} />
            </div>
            <div className={styles.heroCopy}>
              <div className={styles.eyebrow}>
                {adminPreview
                  ? adminToolsActive
                    ? 'Staxis admin view'
                    : 'Staxis hotel view'
                  : portfolioMode
                    ? 'Portfolio workspace'
                    : 'Company workspace'}
              </div>
              <h1 ref={previewHeadingRef} tabIndex={adminPreview ? -1 : undefined}>{workspaceTitle}</h1>
              <p>
                {adminPreview
                  ? adminToolsActive
                    ? 'Manage this hotel without leaving My Hotel.'
                    : 'Review this hotel in read-only mode.'
                  : portfolioMode
                    ? 'Manage company knowledge, hotels, people, and access in one place.'
                    : 'See your hotels, team, and exactly why you have access.'}
              </p>
            </div>
          </div>

          <div className={styles.heroHotelSlot}>
            {!portfolioMode && contextProperties.length > 0 ? (
              <HotelSwitcher
                className={styles.heroHotelSwitcher}
                hotels={contextProperties}
                activeHotelId={activeProperty?.id ?? null}
                label={'Choose hotel to manage'}
                placeholder={'Choose hotel'}
                onSelect={(hotelId) => {
                  setTeamInviteHotelId(null);
                  setActivePropertyId(hotelId);
                }}
              />
            ) : !showLoading && contextLabel ? (
              <div className={styles.contextBadge}>
                <MapPinned size={15} aria-hidden="true" />
                <span>{contextLabel}</span>
              </div>
            ) : null}
          </div>

          <div className={styles.heroActions}>
            {adminPreview ? (
              <label className={styles.adminViewSwitch}>
                <span className={styles.adminViewSwitchLabel}>
                  {'Admin view'}
                  <small>{adminToolsActive
                    ? 'On'
                    : 'Off'}</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={adminToolsActive}
                  aria-checked={adminToolsActive}
                  disabled={showLoading || !adminViewerContext}
                  onChange={(event) => setAdminToolsEnabled(event.target.checked)}
                />
                <span className={styles.adminViewSwitchTrack} aria-hidden="true">
                  <span className={styles.adminViewSwitchHandle} />
                </span>
              </label>
            ) : null}
          </div>
        </header>

        {currentLoadError && currentData ? (
          <div className={styles.partialNotice} role="status">
            <AlertTriangle size={17} aria-hidden="true" />
            <div>
              <strong>{'Showing your current hotel access'}</strong>
              <span>{'Company details are temporarily unavailable.'}</span>
            </div>
            <button type="button" onClick={() => setRetryKey((value) => value + 1)} disabled={loading}>
              <RefreshCw size={14} aria-hidden="true" />
              {'Retry'}
            </button>
          </div>
        ) : null}

        {adminPreviewFailed ? (
          <section className={styles.adminPreviewError} role="alert" aria-labelledby="admin-preview-error-title">
            <span className={styles.adminPreviewErrorIcon} aria-hidden="true">
              <AlertTriangle size={20} />
            </span>
            <div>
              <h2 id="admin-preview-error-title" tabIndex={-1}>{'Hotel View could not be opened'}</h2>
              <p>{currentLoadError}</p>
            </div>
            <div className={styles.adminPreviewErrorActions}>
              <button
                type="button"
                onClick={() => {
                  focusPreviewAfterRetryRef.current = true;
                  setRetryKey((value) => value + 1);
                }}
                disabled={loading}
              >
                <RefreshCw size={14} aria-hidden="true" />
                {'Retry'}
              </button>
              <button type="button" onClick={() => pushReliable('/admin/properties#live')}>
                {'Back to Admin'}
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            </div>
          </section>
        ) : (
          <>
            <div className={styles.tabs}>
              <nav className={styles.tabList} role="tablist" aria-label={'Company sections'}>
                {tabs.map((item, index) => {
                  const Icon = item.icon;
                  const active = tab === item.id;
                  return (
                    <button
                      key={item.id}
                      id={`company-tab-${item.id}`}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      aria-controls={`company-panel-${item.id}`}
                      tabIndex={active ? 0 : -1}
                      className={active ? styles.tabActive : undefined}
                      onClick={() => switchTab(item.id)}
                      onKeyDown={(event) => handleTabKeyDown(event, index)}
                    >
                      <Icon size={16} strokeWidth={1.9} aria-hidden="true" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </nav>
            </div>

            <section
              id={`company-panel-${tab}`}
              role="tabpanel"
              aria-labelledby={`company-tab-${tab}`}
              className={styles.panel}
            >
              {portfolioNeedsSelection ? (
                <EmptyState
                  icon={Building2}
                  title={'Choose a management company'}
                  description={'Each company remains separate. Choose one before opening My Portfolio.'}
                  actionLabel={'Choose company'}
                  onAction={() => router.push('/portfolio/choose')}
                />
              ) : portfolioMode && portfolio.error ? (
                <RouteErrorState
                  title={'Portfolio context could not be confirmed'}
                  message={portfolio.error}
                  retryLabel={'Try again'}
                  onRetry={() => void portfolio.reload()}
                />
              ) : tab === 'people' && capabilityOverridesStatus === 'error' ? (
                <RouteErrorState
                  title={'People access could not be confirmed'}
                  message={capabilityOverridesError ?? undefined}
                  retryLabel={'Try again'}
                  onRetry={() => void refreshCapabilities()}
                />
              ) : showLoading ? (
                <CompanyHubSkeleton lang={lang} />
              ) : !user ? (
                <EmptyState
                  icon={ShieldCheck}
                  title={'Sign in to view access'}
                  description={'Your company access is tied to your Staxis account.'}
                />
              ) : tab === 'overview' ? (
                <>
                  {selectedPortfolioCompany ? (
                    <CompanyRulebookPanel
                      lang={lang}
                      organizationId={selectedPortfolioCompany.organizationId}
                    />
                  ) : !portfolioMode && activePropertyId ? (
                    <CompanyRulebookPanel
                      lang={lang}
                      propertyId={activePropertyId}
                    />
                  ) : null}
                  <OverviewPanel
                    data={resolved}
                    structure={currentStructure}
                    structureLoading={structureLoading}
                    structureUnavailable={Boolean(structureError)}
                    lang={lang}
                    activePropertyName={activeProperty?.name ?? null}
                    hotelRosterCount={hotelRosterCount}
                    hotelRosterUnavailable={currentStaffUnavailable}
                    onViewReceipt={setSelectedReceipt}
                  />
                </>
              ) : tab === 'hotels' ? (
                <HotelsPanel
                  data={resolved}
                  structure={currentStructure}
                  lang={lang}
                  activeProperty={activeProperty}
                  adminToolsEnabled={adminToolsActive}
                  query={query}
                  onQueryChange={setQuery}
                  statusFilter={hotelStatusFilter}
                  onStatusFilterChange={setHotelStatusFilter}
                  onStructureChanged={completeAccessMutation}
                />
              ) : tab === 'people' ? (
                <PeoplePanel
                  key={activeProperty?.id ?? 'no-hotel'}
                  data={resolved}
                  staff={currentStaff}
                  hotelRosterUnavailable={currentStaffUnavailable}
                  lang={lang}
                  currentUser={user}
                  currentAccountId={user.accountId}
                  activeProperty={activeProperty}
                  adminToolsEnabled={adminToolsActive}
                  canManageTeam={canManageTeam}
                  canInviteAccounts={Boolean(
                    (adminToolsActive && platformAdmin)
                    || (activeProperty
                      && resolved.permissions.accountInvitePropertyIds?.includes(activeProperty.id))
                  )}
                  canViewWages={canViewWages}
                  canAddOperationalStaff={!hotelTeamLocked && canManageTeam}
                  inviteDialogOpen={teamInviteHotelId === activeProperty?.id}
                  onInviteDialogOpenChange={(open) => setTeamInviteHotelId(open ? activeProperty?.id ?? null : null)}
                  onChanged={refreshStaff}
                  onLifecycleAction={setLifecycleAction}
                />
              ) : (
                <AccessPanel
                  data={resolved}
                  lang={lang}
                  currentUser={user}
                  currentAccountId={user.accountId}
                  activeProperty={activeProperty}
                  canManageUsers={canManageUsers}
                  onViewReceipt={setSelectedReceipt}
                  onRequestAccess={() => setRequestOpen(true)}
                  onReviewRequest={setReviewRequest}
                  onLifecycleAction={setLifecycleAction}
                  onAccessChanged={completeAccessMutation}
                />
              )}
            </section>
          </>
        )}
      </div>

      {currentData && selectedReceipt ? (
        <AccessPreviewDialog
          receipt={selectedReceipt}
          organizations={resolved.organizations}
          properties={resolved.properties}
          lang={lang}
          onClose={() => setSelectedReceipt(null)}
        />
      ) : null}
      {currentData && requestOpen && !resolved.viewerContext ? (
        <RequestAccessDialog
          data={resolved}
          lang={lang}
          onClose={() => setRequestOpen(false)}
          onCompleted={completeAccessMutation}
        />
      ) : null}
      {currentData && reviewRequest && !resolved.viewerContext ? (
        <ReviewAccessRequestDialog
          request={reviewRequest}
          lang={lang}
          onClose={() => setReviewRequest(null)}
          onCompleted={completeAccessMutation}
        />
      ) : null}
      {currentData && lifecycleAction && !resolved.viewerContext ? (
        <CompanyLifecycleDialog
          action={lifecycleAction}
          lang={lang}
          onClose={() => setLifecycleAction(null)}
          onCompleted={completeAccessMutation}
        />
      ) : null}
    </AppLayout>
  );
}

function OverviewPanel({ data, structure, structureLoading, structureUnavailable, lang, activePropertyName, hotelRosterCount, hotelRosterUnavailable, onViewReceipt }: {
  data: CompanyAccessData;
  structure: CompanyStructureProjection | null;
  structureLoading: boolean;
  structureUnavailable: boolean;
  lang: string;
  activePropertyName: string | null;
  hotelRosterCount: number | null;
  hotelRosterUnavailable: boolean;
  onViewReceipt: (receipt: EffectiveAccessReceipt) => void;
}) {
  const primaryReceipt = data.effectiveAccess[0] ?? null;
  const membershipPeopleCount = data.memberships.filter((membership) => membership.status === 'active').length;
  const propertyPreview = data.viewerContext?.scope === 'property';
  const peopleCount = propertyPreview ? hotelRosterCount ?? 0 : membershipPeopleCount;
  const pendingCount = data.invitations.filter((invitation) => invitation.status === 'pending').length
    + data.requests.filter((request) => request.status === 'pending').length;

  return (
    <div className={styles.stack}>
      {!data.viewerContext ? (
        <CompanyStructureOverview
          structure={structure}
          lang={lang}
          loading={structureLoading}
          unavailable={structureUnavailable}
          legacyFallback={data.legacyFallback}
        />
      ) : null}
      <div className={styles.summaryGrid}>
        <SummaryCard
          icon={Hotel}
          label={'Hotels in scope'}
          value={String(data.properties.length)}
          detail={activePropertyName ?? 'No active hotel'}
        />
        <SummaryCard
          icon={Users}
          label={propertyPreview
            ? 'Active hotel staff'
            : 'Active people'}
          value={propertyPreview && hotelRosterUnavailable ? '—' : String(peopleCount)}
          detail={propertyPreview
            ? hotelRosterUnavailable
              ? 'Roster temporarily unavailable'
              : 'From the hotel roster'
            : data.permissions.viewPeople
              ? 'Based on your scope'
              : 'Only your access is shown'}
        />
        <SummaryCard
          icon={Clock3}
          label={'Open access work'}
          value={String(pendingCount)}
          detail={'Invites and requests'}
        />
      </div>

      {!data.viewerContext ? (
        <section className={styles.sectionBlock}>
          <SectionHeading
            eyebrow={'Your access receipt'}
            title={'Why you can see this workspace'}
            description={'Your title describes your work. Your access profile and scope control what you can actually open.'}
          />
          {primaryReceipt ? (
            <AccessReceiptCard receipt={primaryReceipt} properties={data.properties} lang={lang} onView={() => onViewReceipt(primaryReceipt)} featured />
          ) : (
            <EmptyState
              icon={KeyRound}
              compact
              title={'No active access grant'}
              description={'Ask your manager or Staxis support to review your account.'}
            />
          )}
        </section>
      ) : null}

      <section className={styles.sectionBlock}>
        <SectionHeading
          eyebrow={'Your structure'}
          title={'Companies, regions, and hotels'}
            description={'Each company relationship shows the hotels in that exact scope.'}
        />
        <OrganizationHierarchy data={data} lang={lang} limit={5} />
      </section>
    </div>
  );
}

function HotelsPanel({ data, structure, lang, activeProperty, adminToolsEnabled, query, onQueryChange, statusFilter, onStatusFilterChange, onStructureChanged }: {
  data: CompanyAccessData;
  structure: CompanyStructureProjection | null;
  lang: string;
  activeProperty: Property | null;
  adminToolsEnabled: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  statusFilter: HotelStatusFilter;
  onStatusFilterChange: (value: HotelStatusFilter) => void;
  onStructureChanged: () => void;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const propertyMatches = data.properties.filter((property) => {
    const organization = data.organizations.find((item) => item.id === property.organizationId);
    const textMatch = !normalizedQuery || `${property.name} ${organization?.name ?? ''}`.toLowerCase().includes(normalizedQuery);
    const statusMatch = statusFilter === 'all'
      || (statusFilter === 'active' ? property.status === 'active' : property.status !== 'active');
    return textMatch && statusMatch;
  });
  const visibleIds = new Set(propertyMatches.map((property) => property.nodeId));

  return (
    <div className={styles.stack}>
      <SectionHeading
        eyebrow={'Property scope'}
        title={'Hotels you can access'}
        description={'Grouped by organization, portfolio, or region.'}
      />
      {data.viewerContext?.kind === 'staxis_admin_preview' && activeProperty ? (
        <AdminHotelRelationshipManager
          key={activeProperty.id}
          propertyId={activeProperty.id}
          propertyName={activeProperty.name}
          adminToolsEnabled={adminToolsEnabled}
          lang={lang}
          onChanged={onStructureChanged}
        />
      ) : null}
      <FilterBar
        lang={lang}
        query={query}
        onQueryChange={onQueryChange}
        statusFilter={statusFilter}
        onStatusFilterChange={onStatusFilterChange}
        statusOptions={[
          { value: 'all', label: 'All' },
          { value: 'active', label: 'Active' },
          { value: 'not_active', label: 'Not active' },
        ]}
        searchLabel={'Search hotels or companies'}
      />
      {propertyMatches.length > 0 ? (
        <OrganizationHierarchy data={{ ...data, properties: propertyMatches }} lang={lang} visiblePropertyIds={visibleIds} />
      ) : (
        <EmptyState
          icon={Search}
          title={'No hotels match'}
          description={'Try another search or clear the status filter.'}
          actionLabel={'Clear filters'}
          onAction={() => { onQueryChange(''); onStatusFilterChange('all'); }}
        />
      )}
      {!data.viewerContext && structure && structure.organizations.length > 0 ? (
        <CompanyStructureManager
          structure={structure}
          lang={lang}
          onChanged={onStructureChanged}
        />
      ) : null}
    </div>
  );
}

/**
 * One list of everyone at this hotel. Until 2026-07-27 this panel stacked two
 * lists — logins, then the staff records with no login — and the same person
 * could appear in both with nothing on screen explaining why. HotelTeamPanel
 * now merges them.
 */
function PeoplePanel({ data, staff, hotelRosterUnavailable, lang, currentUser, currentAccountId, activeProperty, adminToolsEnabled, canManageTeam, canInviteAccounts, canViewWages, canAddOperationalStaff, inviteDialogOpen, onInviteDialogOpenChange, onChanged, onLifecycleAction }: {
  data: CompanyAccessData;
  staff: StaffMember[];
  hotelRosterUnavailable: boolean;
  lang: string;
  currentUser: AppUser;
  currentAccountId: string;
  activeProperty: Property | null;
  adminToolsEnabled: boolean;
  canManageTeam: boolean;
  canInviteAccounts: boolean;
  canViewWages: boolean;
  canAddOperationalStaff: boolean;
  inviteDialogOpen: boolean;
  onInviteDialogOpenChange: (open: boolean) => void;
  onChanged: () => void | Promise<void>;
  onLifecycleAction: (action: CompanyLifecycleAction) => void;
}) {
  const adminPreview = data.viewerContext?.kind === 'staxis_admin_preview';
  const visibleMemberships = data.permissions.viewPeople
    ? data.memberships
    : data.memberships.filter((membership) => (
      membership.accountId === currentAccountId || membership.isCurrentUser
    ));
  return (
    <div className={styles.stack}>
      {(visibleMemberships.length > 0 || data.invitations.length > 0 || data.permissions.manageInvitations) ? (
        <section className={styles.sectionBlock}>
          <div className={styles.headingWithAction}>
            <SectionHeading
              eyebrow={'Company people'}
              title={'Memberships and invitations'}
              description={'Company membership says who belongs to this company. The hotel roster below is the operational team for the selected hotel.'}
            />
            {!adminPreview && !canManageTeam && canInviteAccounts ? (
              <button type="button" className={styles.primaryButton} onClick={() => onInviteDialogOpenChange(true)}>
                <UserPlus size={16} aria-hidden="true" />
                {'Invite company member'}
              </button>
            ) : null}
          </div>
          {visibleMemberships.length > 0 ? (
            <div className={styles.listCard} role="list">
              {visibleMemberships.map((membership) => (
                <MembershipRow
                  key={membership.id}
                  membership={membership}
                  organization={data.organizations.find((item) => item.id === membership.organizationId) ?? null}
                  isCurrentUser={membership.accountId === currentAccountId || Boolean(membership.isCurrentUser)}
                  lang={lang}
                  onLifecycleAction={onLifecycleAction}
                  showGrantActions={false}
                  showMembershipActions={!adminPreview}
                />
              ))}
            </div>
          ) : null}
          {data.invitations.length > 0 ? (
            <div className={styles.peopleInvitations}>
              <h3>{'Pending invitations'}</h3>
              <div className={styles.listCard} role="list">
                {data.invitations.map((invitation) => (
                  <InvitationRow
                    key={invitation.id}
                    invitation={invitation}
                    lang={lang}
                    onLifecycleAction={onLifecycleAction}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
      {activeProperty ? (
        <HotelTeamPanel
          key={`${activeProperty.id}:${adminToolsEnabled ? 'admin' : 'preview'}:${canManageTeam ? 'hotel-authorized' : 'invite-only'}`}
          hotelId={activeProperty.id}
          hotelName={activeProperty.name}
          currentUser={currentUser}
          currentAccountId={currentAccountId}
          lang={'en'}
          canManageTeam={canManageTeam}
          canInviteAccounts={canInviteAccounts}
          canViewWages={canViewWages}
          readOnly={Boolean(data.viewerContext?.readOnly) && !adminToolsEnabled}
          adminPreview={data.viewerContext?.kind === 'staxis_admin_preview'}
          allowAdminActions={adminToolsEnabled}
          inviteDialogOpen={inviteDialogOpen}
          onInviteDialogOpenChange={onInviteDialogOpenChange}
          staffProfiles={staff}
          rosterUnavailable={hotelRosterUnavailable}
          canAddStaff={canAddOperationalStaff}
          onChanged={onChanged}
        />
      ) : (
        <EmptyState
          icon={Hotel}
          title={'Choose a hotel first'}
          description={'Team accounts are always managed for one exact hotel.'}
        />
      )}
    </div>
  );
}

function AccessPanel({ data, lang, currentUser, currentAccountId, activeProperty, canManageUsers, onViewReceipt, onRequestAccess, onReviewRequest, onLifecycleAction, onAccessChanged }: {
  data: CompanyAccessData;
  lang: string;
  currentUser: AppUser;
  currentAccountId: string;
  activeProperty: Property | null;
  canManageUsers: boolean;
  onViewReceipt: (receipt: EffectiveAccessReceipt) => void;
  onRequestAccess: () => void;
  onReviewRequest: (request: CompanyAccessRequest) => void;
  onLifecycleAction: (action: CompanyLifecycleAction) => void;
  onAccessChanged: () => void;
}) {
  const adminPreview = data.viewerContext?.kind === 'staxis_admin_preview';
  const [editorProjection, setEditorProjection] = React.useState<CompanyAccessEditorProjection | null>(null);
  const [editorError, setEditorError] = React.useState('');
  const [editorReloadKey, setEditorReloadKey] = React.useState(0);
  const [editingMembershipId, setEditingMembershipId] = React.useState<string | null>(null);
  const editorDataKey = [
    ...data.organizations.map((organization) => organization.id),
    ...data.memberships.map((membership) => membership.id),
  ].sort().join(':');

  React.useEffect(() => {
    if (adminPreview || data.legacyFallback || !data.permissions.viewAccess) {
      setEditorProjection(null);
      setEditorError('');
      setEditingMembershipId(null);
      return;
    }
    let cancelled = false;
    setEditorProjection(null);
    setEditorError('');
    void (async () => {
      try {
        const response = await fetchWithAuth('/api/company-access/access-editor');
        const body = await response.json().catch(() => ({})) as Envelope<CompanyAccessEditorProjection>;
        if (!response.ok || !body.ok || !body.data) {
          throw new Error(body.error || 'Access editing could not be loaded.');
        }
        if (!cancelled) setEditorProjection(body.data);
      } catch (caught) {
        if (!cancelled) setEditorError(caught instanceof Error
          ? caught.message
          : 'Access editing could not be loaded.');
      }
    })();
    return () => { cancelled = true; };
  }, [adminPreview, data.legacyFallback, data.permissions.viewAccess, editorDataKey, editorReloadKey, lang]);

  const visibleMemberships = data.permissions.viewPeople
    ? data.memberships
    : data.memberships.filter((membership) => (
      membership.accountId === currentAccountId || membership.isCurrentUser
    ));
  const customerAccessGrants = adminPreview
    ? data.memberships.flatMap((membership) => membership.grants.map((grant) => ({ membership, grant })))
    : [];
  let editorTarget: {
    membership: CompanyMembership;
    editorMembership: CompanyAccessEditorMembership;
    organization: CompanyAccessEditorOrganization;
  } | null = null;
  if (editingMembershipId && editorProjection) {
    const membership = data.memberships.find((candidate) => candidate.id === editingMembershipId);
    const organization = editorProjection.organizations.find((candidate) => (
      candidate.id === membership?.organizationId
    ));
    const editorMembership = organization?.memberships.find((candidate) => (
      candidate.id === editingMembershipId
    ));
    if (membership && organization && editorMembership) {
      editorTarget = { membership, organization, editorMembership };
    }
  }
  return (
    <>
      <div className={styles.stack}>
      <div className={styles.headingWithAction}>
        <SectionHeading
          eyebrow={adminPreview
            ? 'Access records'
            : 'Effective access'}
          title={adminPreview
            ? 'Customer access records'
            : 'What you can reach and why'}
          description={adminPreview
            ? 'Review this scope without changing customer access.'
            : 'Manage each person’s role and exact scope: whole company, portfolio or region, or selected hotels. Revocation is immediate and audited.'}
        />
        {!adminPreview ? <div className={styles.headingActions}>
          {data.permissions.requestAccess ? (
            <button type="button" className={styles.secondaryButton} onClick={onRequestAccess}>
              <KeyRound size={16} aria-hidden="true" />
              {'Request access'}
            </button>
          ) : null}
          {!data.permissions.manageAccess ? (
            <button type="button" className={styles.secondaryButton} disabled title={'A company administrator manages access.'}>
              <ShieldCheck size={16} aria-hidden="true" />
              {'Access is managed'}
            </button>
          ) : null}
        </div> : null}
      </div>

      {!adminPreview && editorError && data.permissions.manageAccess ? (
        <div className={styles.partialNotice} role="status">
          <AlertTriangle size={17} aria-hidden="true" />
          <span>{editorError}</span>
        </div>
      ) : null}

      <LegacyOwnershipTransferPanel
        enabled={!adminPreview && data.legacyFallback && canManageUsers && Boolean(activeProperty)}
        propertyId={activeProperty?.id ?? null}
        propertyName={activeProperty?.name ?? null}
        currentAccountId={currentAccountId}
        currentRole={currentUser.role}
        lang={lang}
      />

      {visibleMemberships.length > 0 ? (
        <section className={styles.sectionBlock}>
          <SectionHeading
            eyebrow={'Organization access'}
            title={'Roles and scopes by person'}
            description={'Company-wide, portfolio/region, and selected-hotel grants are shown separately from membership and the operational hotel roster.'}
          />
          <div className={styles.listCard} role="list">
            {visibleMemberships.map((membership) => {
              const editorOrganization = editorProjection?.organizations.find((candidate) => (
                candidate.id === membership.organizationId
              ));
              const editorMembership = editorOrganization?.memberships.find((candidate) => (
                candidate.id === membership.id
              ));
              const canEditAccess = Boolean(editorMembership?.canAdd || editorMembership?.canReplace);
              return (
                <MembershipRow
                  key={membership.id}
                  membership={membership}
                  organization={data.organizations.find((item) => item.id === membership.organizationId) ?? null}
                  isCurrentUser={membership.accountId === currentAccountId || Boolean(membership.isCurrentUser)}
                  lang={lang}
                  onLifecycleAction={onLifecycleAction}
                  onEditAccess={canEditAccess ? () => setEditingMembershipId(membership.id) : undefined}
                  accessEditLabel={(editorMembership?.currentGrants.length ?? 0) > 0
                    ? 'Edit role and scope'
                    : 'Add role and scope'}
                  showGrantActions={!adminPreview}
                  showMembershipActions={false}
                />
              );
            })}
          </div>
        </section>
      ) : null}

      {adminPreview && customerAccessGrants.length > 0 ? (
        <div className={styles.listCard} role="list">
          {customerAccessGrants.map(({ membership, grant }) => (
            <div key={`${membership.id}:${grant.id}`} className={styles.accessWorkRow} role="listitem">
              <span className={styles.workIcon}><KeyRound size={17} aria-hidden="true" /></span>
              <div className={styles.rowBody}>
                <strong>{membership.displayName}</strong>
                <span>
                  {titleCaseAccessValue(grant.accessProfile)} · {grant.scopeLabel}
                  {grant.expiresAt
                    ? ` · ${'Expires'} ${formatDate(grant.expiresAt, lang)}`
                    : ''}
                </span>
              </div>
              <span className={`${styles.status} ${statusClass(membership.status)}`}>
                {statusLabel(membership.status, lang)}
              </span>
            </div>
          ))}
        </div>
      ) : !adminPreview && data.effectiveAccess.length > 0 ? (
        <div className={styles.receiptGrid}>
          {data.effectiveAccess.map((receipt) => (
            <AccessReceiptCard
              key={receipt.id}
              receipt={receipt}
              properties={data.properties}
              lang={lang}
              onView={() => onViewReceipt(receipt)}
            />
          ))}
        </div>
      ) : (
          <EmptyState
            icon={KeyRound}
            title={adminPreview
              ? 'No customer access records found'
              : 'No access grants found'}
            description={adminPreview
              ? 'There are no customer grant records in this preview scope.'
              : 'Your administrator can review the account and hotel assignment.'}
          />
      )}

      {data.permissions.viewAccess && data.requests.length > 0 ? (
        <section className={styles.sectionBlock}>
          <SectionHeading
            eyebrow={'Open work'}
            title={'Requests and invitations'}
            description={'Pending access never counts as active access.'}
          />
          <div className={styles.listCard} role="list">
            {data.requests.map((request) => (
              <div key={request.id} className={styles.accessWorkRow} role="listitem">
                <span className={styles.workIcon}><CircleHelp size={17} aria-hidden="true" /></span>
                <div className={styles.rowBody}>
                  <strong>{request.requesterName}</strong>
                  <span>{titleCaseAccessValue(request.requestedProfile)} · {request.scopeLabel}</span>
                </div>
                <div className={styles.requestRowActions}>
                  <span className={`${styles.status} ${statusClass(request.status)}`}>{statusLabel(request.status, lang)}</span>
                  {request.canReview && request.status === 'pending' ? (
                    <button type="button" className={styles.reviewButton} onClick={() => onReviewRequest(request)}>
                      {'Review'}
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      </div>

      {editorTarget ? (
        <AccessEditorDialog
          membership={editorTarget.membership}
          editorMembership={editorTarget.editorMembership}
          organization={editorTarget.organization}
          lang={lang}
          onClose={() => setEditingMembershipId(null)}
          onCompleted={() => {
            setEditorReloadKey((value) => value + 1);
            onAccessChanged();
          }}
        />
      ) : null}
    </>
  );
}

function OrganizationHierarchy({ data, lang, limit, visiblePropertyIds }: {
  data: CompanyAccessData;
  lang: string;
  limit?: number;
  visiblePropertyIds?: Set<string>;
}) {
  const realOrganizations = data.organizations.filter((organization) => organization.type !== 'single_hotel');
  const groupedOrganizationIds = new Set(realOrganizations.map((organization) => organization.id));
  const ungroupedProperties = data.properties.filter((property) => (
    !property.organizationId || !groupedOrganizationIds.has(property.organizationId)
  ));
  // A hotel the caller only reaches through the hidden single-hotel anchor is
  // NOT an independent hotel just because the caller has no company job. The
  // server now names the operator when there is one, and these two buckets are
  // the two different true sentences: "your hotel is run by Gulf Coast Hotels,
  // and this page shows you your hotel" vs "your hotel is run by nobody else".
  // They used to be one bucket, and it told the first group the second thing.
  const operated = ungroupedProperties.filter((property) => !!property.operatingCompanyName);
  const independent = ungroupedProperties.filter((property) => !property.operatingCompanyName);
  const operatedByCompany = [...new Map(operated.map((property) => (
    [property.operatingCompanyName as string, [] as CompanyProperty[]]
  ))).entries()].map(([name]) => ({
    name,
    properties: operated.filter((property) => property.operatingCompanyName === name),
  }));
  const organizationRows = typeof limit === 'number' ? realOrganizations.slice(0, limit) : realOrganizations;

  if (data.properties.length === 0) {
    return (
      <EmptyState
        icon={Hotel}
        compact
        title={'No hotels assigned'}
        description={'Hotels will appear after an access grant becomes active.'}
      />
    );
  }

  return (
    <div className={styles.hierarchy}>
      {organizationRows.map((organization, index) => {
        const properties = data.properties.filter((property) => property.organizationId === organization.id);
        if (visiblePropertyIds && properties.every((property) => !visiblePropertyIds.has(property.nodeId))) return null;
        const portfolios = data.portfolios.filter((portfolio) => portfolio.organizationId === organization.id);
        return (
          <OrganizationGroup
            key={organization.id}
            organization={organization}
            portfolios={portfolios}
            properties={properties}
            lang={lang}
            defaultOpen={organizationRows.length === 1 || index === 0}
          />
        );
      })}

      {operatedByCompany.map((group) => (
        <section key={group.name} className={styles.independentGroup}>
          <div className={styles.groupHeader}>
            <span className={styles.groupIcon}><Building2 size={18} aria-hidden="true" /></span>
            <div>
              <strong>{group.name}</strong>
              <span>
                {'Runs your hotel. You see your own hotel here.'}
              </span>
            </div>
            <span className={styles.countBadge}>{group.properties.length}</span>
          </div>
          <div className={styles.propertyList}>
            {group.properties.map((property) => (
              <PropertyRow key={property.nodeId} property={property} lang={lang} />
            ))}
          </div>
        </section>
      ))}

      {independent.length > 0 ? (
        <section className={styles.independentGroup}>
          <div className={styles.groupHeader}>
            <span className={styles.groupIcon}><Hotel size={18} aria-hidden="true" /></span>
            <div>
              <strong>{'Independent hotel access'}</strong>
              <span>{'Hotels not grouped under a management company'}</span>
            </div>
            <span className={styles.countBadge}>{independent.length}</span>
          </div>
          <div className={styles.propertyList}>
            {independent.map((property) => <PropertyRow key={property.nodeId} property={property} lang={lang} />)}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function OrganizationGroup({ organization, portfolios, properties, lang, defaultOpen }: {
  organization: CompanyOrganization;
  portfolios: CompanyPortfolio[];
  properties: CompanyProperty[];
  lang: string;
  defaultOpen: boolean;
}) {
  const portfolioPropertyIds = new Set(portfolios.flatMap((portfolio) => portfolio.propertyIds));
  const ungrouped = properties.filter((property) => !portfolioPropertyIds.has(property.id));

  return (
    <details className={styles.organizationGroup} open={defaultOpen}>
      <summary>
        <span className={styles.groupIcon}><Building2 size={18} aria-hidden="true" /></span>
        <span className={styles.summaryCopy}>
          <strong>{organization.name}</strong>
          <span>{titleCaseAccessValue(organization.type)} · {properties.length} {properties.length === 1 ? 'hotel' : 'hotels'}</span>
        </span>
        <span className={`${styles.status} ${statusClass(organization.status)}`}>{statusLabel(organization.status, lang)}</span>
        <ChevronDown className={styles.disclosureIcon} size={17} aria-hidden="true" />
      </summary>
      <div className={styles.organizationBody}>
        {portfolios.map((portfolio) => {
          const portfolioProperties = properties.filter((property) => portfolio.propertyIds.includes(property.id));
          if (portfolioProperties.length === 0) return null;
          return (
            <section key={portfolio.id} className={styles.portfolioGroup}>
              <div className={styles.portfolioHeading}>
                <Layers3 size={16} aria-hidden="true" />
                <span>{portfolio.name}</span>
                <small>{portfolioProperties.length}</small>
              </div>
              <div className={styles.propertyList}>
                {portfolioProperties.map((property) => <PropertyRow key={property.nodeId} property={property} lang={lang} />)}
              </div>
            </section>
          );
        })}
        {ungrouped.length > 0 ? (
          <section className={styles.portfolioGroup}>
            {portfolios.length > 0 ? (
              <div className={styles.portfolioHeading}>
                <MapPinned size={16} aria-hidden="true" />
                <span>{'Other hotels'}</span>
                <small>{ungrouped.length}</small>
              </div>
            ) : null}
            <div className={styles.propertyList}>
              {ungrouped.map((property) => <PropertyRow key={property.nodeId} property={property} lang={lang} />)}
            </div>
          </section>
        ) : null}
      </div>
    </details>
  );
}

function PropertyRow({ property, lang }: { property: CompanyProperty; lang: string }) {
  return (
    <div className={styles.propertyRow}>
      <span className={styles.hotelIcon}><Hotel size={16} aria-hidden="true" /></span>
      <div className={styles.rowBody}>
        <strong>{property.name}</strong>
        <span>{titleCaseAccessValue(property.relationshipType ?? 'hotel access')}</span>
      </div>
      <span className={`${styles.status} ${statusClass(property.status)}`}>{statusLabel(property.status, lang)}</span>
    </div>
  );
}

function AccessReceiptCard({ receipt, properties, lang, onView, featured = false }: {
  receipt: EffectiveAccessReceipt;
  properties: CompanyProperty[];
  lang: string;
  onView: () => void;
  featured?: boolean;
}) {
  const hotelNames = receipt.propertyIds
    .map((propertyId) => properties.find((property) => property.id === propertyId)?.name)
    .filter((name): name is string => Boolean(name));
  return (
    <article className={`${styles.receiptCard}${featured ? ` ${styles.receiptFeatured}` : ''}`}>
      <div className={styles.receiptHeader}>
        <span className={styles.receiptSeal}><ShieldCheck size={20} aria-hidden="true" /></span>
        <div>
          <span className={styles.receiptEyebrow}>{'Access profile'}</span>
          <h3>{titleCaseAccessValue(receipt.accessProfile)}</h3>
        </div>
        <span className={`${styles.status} ${statusClass(receipt.status)}`}>{statusLabel(receipt.status, lang)}</span>
      </div>
      {receipt.jobTitle ? (
        <div className={styles.jobLine}>
          <BriefcaseBusiness size={15} aria-hidden="true" />
          <span>{receipt.jobTitle}</span>
          <small>{'Job title'}</small>
        </div>
      ) : null}
      <dl className={styles.receiptFacts}>
        <div>
          <dt>{'Scope'}</dt>
          <dd>{receipt.scopeLabel}</dd>
        </div>
        <div>
          <dt>{'Hotels'}</dt>
          <dd>{hotelNames.length || receipt.propertyIds.length}</dd>
        </div>
        <div>
          <dt>{'Expires'}</dt>
          <dd>{formatDate(receipt.expiresAt, lang)}</dd>
        </div>
      </dl>
      {hotelNames.length > 0 ? (
        <div className={styles.hotelChips} aria-label={'Hotels in this scope'}>
          {hotelNames.slice(0, 3).map((name) => <span key={name}>{name}</span>)}
          {hotelNames.length > 3 ? <span>+{hotelNames.length - 3}</span> : null}
        </div>
      ) : null}
      <button type="button" className={styles.receiptAction} onClick={onView}>
        <CircleHelp size={15} aria-hidden="true" />
        {'Why I have access'}
        <ArrowRight size={14} aria-hidden="true" />
      </button>
    </article>
  );
}

function AccessPreviewDialog({ receipt, organizations, properties, lang, onClose }: {
  receipt: EffectiveAccessReceipt;
  organizations: CompanyOrganization[];
  properties: CompanyProperty[];
  lang: string;
  onClose: () => void;
}) {
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const organization = organizations.find((item) => item.id === receipt.organizationId);
  const scopedProperties = receipt.propertyIds
    .map((propertyId) => properties.find((property) => property.id === propertyId))
    .filter((property): property is CompanyProperty => Boolean(property));

  React.useEffect(() => {
    const returnFocusElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      if (returnFocusElement?.isConnected) {
        returnFocusElement.focus({ preventScroll: true });
      }
    };
  }, [onClose]);

  return (
    <div className={styles.dialogLayer}>
      <button type="button" className={styles.dialogScrim} aria-label={'Close access preview'} onClick={onClose} />
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="access-preview-title"
        aria-describedby="access-preview-description"
      >
        <div className={styles.dialogHeader}>
          <span className={styles.dialogIcon}><ShieldCheck size={21} aria-hidden="true" /></span>
          <div>
            <span>{'Access preview'}</span>
            <h2 id="access-preview-title">{titleCaseAccessValue(receipt.accessProfile)}</h2>
          </div>
          <button ref={closeRef} type="button" className={styles.iconButton} onClick={onClose} aria-label={'Close'}>
            <X size={17} aria-hidden="true" />
          </button>
        </div>
        <p id="access-preview-description" className={styles.dialogIntro}>
          {'This receipt explains the effective access Staxis calculated for your account. Viewing it does not change anything.'}
        </p>
        <dl className={styles.dialogFacts}>
          <div><dt>{'Company'}</dt><dd>{organization?.name ?? 'Hotel-level access'}</dd></div>
          <div><dt>{'Access profile'}</dt><dd>{titleCaseAccessValue(receipt.accessProfile)}</dd></div>
          <div><dt>{'Scope'}</dt><dd>{receipt.scopeLabel}</dd></div>
          <div><dt>{'Source'}</dt><dd>{titleCaseAccessValue(receipt.source)}</dd></div>
          <div><dt>{'Granted by'}</dt><dd>{receipt.grantedBy || 'System record'}</dd></div>
          <div><dt>{'Expiration'}</dt><dd>{formatDate(receipt.expiresAt, lang)}</dd></div>
        </dl>
        {receipt.reason ? (
          <div className={styles.reasonBox}>
            <strong>{'Reason'}</strong>
            <span>{receipt.reason}</span>
          </div>
        ) : null}
        <div className={styles.dialogPropertyBlock}>
          <div className={styles.dialogPropertyHeading}>
            <span>{'Hotels included'}</span>
            <small>{scopedProperties.length || receipt.propertyIds.length}</small>
          </div>
          {scopedProperties.length > 0 ? (
            <ul>
              {scopedProperties.map((property) => (
                <li key={property.id}><Hotel size={15} aria-hidden="true" /><span>{property.name}</span><CheckCircle2 size={15} aria-hidden="true" /></li>
              ))}
            </ul>
          ) : (
            <p>{'No current hotels are attached to this scope.'}</p>
          )}
        </div>
        <div className={styles.dialogFooter}>
          <span><ShieldCheck size={14} aria-hidden="true" />{'Read-only preview'}</span>
          <button type="button" className={styles.primaryButton} onClick={onClose}>{'Done'}</button>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, detail }: { icon: typeof Hotel; label: string; value: string; detail: string }) {
  return (
    <article className={styles.summaryCard}>
      <span className={styles.summaryIcon}><Icon size={18} aria-hidden="true" /></span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

function SectionHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <div className={styles.sectionHeading}>
      <span>{eyebrow}</span>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}

function FilterBar<T extends string>({ lang, query, onQueryChange, statusFilter, onStatusFilterChange, statusOptions, searchLabel }: {
  lang: string;
  query: string;
  onQueryChange: (value: string) => void;
  statusFilter: T;
  onStatusFilterChange: (value: T) => void;
  statusOptions: ReadonlyArray<{ value: T; label: string }>;
  searchLabel: string;
}) {
  return (
    <div className={styles.filterBar}>
      <label className={styles.searchField}>
        <span className={styles.visuallyHidden}>{searchLabel}</span>
        <Search size={17} aria-hidden="true" />
        <input type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={searchLabel} />
        {query ? (
          <button type="button" onClick={() => onQueryChange('')} aria-label={'Clear search'}>
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </label>
      <div className={styles.filterChips} role="group" aria-label={'Filter by status'}>
        {statusOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={statusFilter === option.value}
            className={statusFilter === option.value ? styles.filterChipActive : undefined}
            onClick={() => onStatusFilterChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function MembershipRow({ membership, organization, isCurrentUser, lang, onLifecycleAction, onEditAccess, accessEditLabel, showGrantActions = true, showMembershipActions = true }: {
  membership: CompanyMembership;
  organization: CompanyOrganization | null;
  isCurrentUser: boolean;
  lang: string;
  onLifecycleAction: (action: CompanyLifecycleAction) => void;
  onEditAccess?: () => void;
  accessEditLabel?: string;
  showGrantActions?: boolean;
  showMembershipActions?: boolean;
}) {
  const revocableGrants = showGrantActions
    ? (membership.grants ?? []).filter((grant) => grant.canRevoke)
    : [];
  const hasMembershipActions = showMembershipActions
    && (membership.canSuspend || membership.canResume || membership.canRemove);
  const hasActions = Boolean(onEditAccess) || revocableGrants.length > 0 || hasMembershipActions;
  return (
    <div className={styles.personRow} role="listitem">
      <Avatar name={membership.displayName} />
      <div className={styles.rowBody}>
        <strong>
          {membership.displayName}
          {isCurrentUser ? <small>{'You'}</small> : null}
        </strong>
        <span>
          {membership.jobTitle || titleCaseAccessValue(membership.accessProfile ?? 'team member')}
          {organization ? ` · ${organization.name}` : ''}
        </span>
        {showGrantActions ? (
          <div className={styles.membershipGrantSummary}>
            {(membership.grants ?? []).length > 0
              ? membership.grants.map((grant) => (
                  <small key={grant.id}>
                    {titleCaseAccessValue(grant.accessProfile)} · {grant.scopeLabel}
                  </small>
                ))
              : membership.accessProfile ? (
                  <small>
                    {titleCaseAccessValue(membership.accessProfile)} · {membership.propertyIds.length} {membership.propertyIds.length === 1 ? 'hotel' : 'hotels'}
                  </small>
                ) : null}
          </div>
        ) : null}
      </div>
      <div className={styles.personRowActions}>
        <span className={`${styles.status} ${statusClass(membership.status)}`}>{statusLabel(membership.status, lang)}</span>
        {hasActions ? (
          <details className={styles.actionMenu}>
            <summary>{'Manage'}</summary>
            <div>
              {onEditAccess ? (
                <button type="button" onClick={onEditAccess}>
                  {accessEditLabel ?? 'Edit role and scope'}
                </button>
              ) : null}
              {onEditAccess && revocableGrants.length > 0 ? <hr /> : null}
              {revocableGrants.length > 0 ? <small>{'Access grants'}</small> : null}
              {revocableGrants.map((grant) => (
                <button
                  key={grant.id}
                  type="button"
                  onClick={() => onLifecycleAction({
                    kind: 'revoke_grant',
                    id: grant.id,
                    targetLabel: membership.displayName,
                    detailLabel: `${titleCaseAccessValue(grant.accessProfile)} · ${grant.scopeLabel}`,
                  })}
                >
                  {'Revoke'} {titleCaseAccessValue(grant.accessProfile)}
                </button>
              ))}
              {hasMembershipActions && revocableGrants.length > 0 ? <hr /> : null}
              {showMembershipActions && membership.canSuspend ? (
                <button type="button" onClick={() => onLifecycleAction({
                  kind: 'suspend_membership',
                  id: membership.id,
                  targetLabel: membership.displayName,
                  detailLabel: organization?.name ?? 'Company membership',
                })}>{'Suspend member'}</button>
              ) : null}
              {showMembershipActions && membership.canResume ? (
                <button type="button" onClick={() => onLifecycleAction({
                  kind: 'resume_membership',
                  id: membership.id,
                  targetLabel: membership.displayName,
                  detailLabel: organization?.name ?? 'Company membership',
                })}>{'Resume member'}</button>
              ) : null}
              {showMembershipActions && membership.canRemove ? (
                <button type="button" className={styles.menuDanger} onClick={() => onLifecycleAction({
                  kind: 'remove_membership',
                  id: membership.id,
                  targetLabel: membership.displayName,
                  detailLabel: organization?.name ?? 'Company membership',
                })}>{'Remove member'}</button>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function InvitationRow({ invitation, lang, onLifecycleAction }: {
  invitation: CompanyInvitation;
  lang: string;
  onLifecycleAction: (action: CompanyLifecycleAction) => void;
}) {
  return (
    <div className={styles.accessWorkRow} role="listitem">
      <span className={styles.workIcon}><Inbox size={17} aria-hidden="true" /></span>
      <div className={styles.rowBody}>
        <strong>{invitation.email}</strong>
        <span>{titleCaseAccessValue(invitation.accessProfile)} · {invitation.scopeLabel} · {formatDate(invitation.expiresAt, lang)}</span>
      </div>
      <div className={styles.requestRowActions}>
        <span className={`${styles.status} ${statusClass(invitation.status)}`}>{statusLabel(invitation.status, lang)}</span>
        {invitation.canCancel ? (
          <button type="button" className={styles.reviewButton} onClick={() => onLifecycleAction({
            kind: 'cancel_invitation',
            id: invitation.id,
            targetLabel: invitation.email,
            detailLabel: `${titleCaseAccessValue(invitation.accessProfile)} · ${invitation.scopeLabel}`,
          })}>{'Cancel'}</button>
        ) : null}
      </div>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'U';
  return <span className={styles.avatar} role="img" aria-label={name}>{initials}</span>;
}

function EmptyState({ icon: Icon, title, description, actionLabel, onAction, compact = false }: {
  icon: typeof Hotel;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}) {
  return (
    <div className={`${styles.emptyState}${compact ? ` ${styles.emptyCompact}` : ''}`} role="status">
      <span><Icon size={compact ? 24 : 30} aria-hidden="true" /></span>
      <h3>{title}</h3>
      <p>{description}</p>
      {actionLabel && onAction ? <button type="button" className={styles.secondaryButton} onClick={onAction}>{actionLabel}</button> : null}
    </div>
  );
}

function CompanyHubSkeleton({ lang }: { lang: string }) {
  return (
    <div
      className={styles.skeletonStack}
      role="status"
      aria-label={'Loading company access'}
    >
      <div className={styles.skeletonGrid} aria-hidden="true">
        {[0, 1, 2].map((key) => <div key={key} className={styles.skeletonCard}><span /><strong /><small /></div>)}
      </div>
      <div className={styles.skeletonPanel} aria-hidden="true"><span /><strong /><small /><div /></div>
    </div>
  );
}
