'use client';

export const dynamic = 'force-dynamic';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CalendarClock,
  ChevronDown,
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

import { useAuth, type AppUser } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { usePortfolio } from '@/contexts/PortfolioContext';
import { useProperty } from '@/contexts/PropertyContext';
import { RouteErrorState } from '@/components/layout/RouteResourceState';
import { fetchWithAuth } from '@/lib/api-fetch';
import { resolveViewerHotelStanding } from '@/lib/authorization/domain';
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
import {
  accessProfileLabel,
  accessSourceLabel,
  buildAccessPeople,
  resolveCompanyAccessContext,
  type AccessPerson,
  type AccessPersonRecord,
  type CompanyAccessContext,
} from '@/lib/company-access/access-people';

import styles from './CompanyAccess.module.css';
import {
  CompanyLifecycleDialog,
  RequestAccessDialog,
  ReviewAccessRequestDialog,
  type CompanyLifecycleAction,
} from './_components/AccessWorkflowDialogs';
import { AccessEditorDialog } from './_components/AccessEditorDialog';
import { HotelTeamPanel } from './_components/HotelTeamPanel';
import { HotelSwitcher } from './_components/HotelSwitcher';
import { LegacyOwnershipTransferPanel } from './_components/LegacyOwnershipTransferPanel';
import { CompanyStructureManager } from './_components/CompanyStructureManager';
import {
  usePeopleController,
  type PeopleControllerState,
} from './_components/usePeopleController';

type TabId = 'hotels' | 'people' | 'access';
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
  return value === 'hotels'
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
    cancelled: ['Cancelled', 'Cancelled'],
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

/**
 * Shape-normalize a company-access payload.
 *
 * This used to ALSO strip every action flag whenever the payload carried an
 * admin viewer context, which is what turned an administrator into a look-but-
 * don't-touch visitor. It no longer does: a platform admin holds full power at
 * every hotel, and the route that produced the payload is the single authority
 * on which actions are offered. `viewerContext` survives purely as the honest
 * "you are viewing this hotel as Staxis" label.
 */
function normalizeCompanyData(value: CompanyAccessData | null | undefined): CompanyAccessData {
  if (!value) return EMPTY_COMPANY_ACCESS;
  const viewerContext = value.viewerContext?.kind === 'staxis_admin_preview'
    && typeof value.viewerContext.readOnly === 'boolean'
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
    memberships,
    effectiveAccess: Array.isArray(value.effectiveAccess) ? value.effectiveAccess : [],
    accessHistory: Array.isArray(value.accessHistory)
      ? value.accessHistory.map((entry) => ({
          ...entry,
          record: { ...entry.record, canRevoke: false },
        }))
      : [],
    invitations,
    requests,
    activity: Array.isArray(value.activity) ? value.activity : [],
    permissions: { ...EMPTY_COMPANY_ACCESS.permissions, ...(value.permissions ?? {}) },
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
    <div className={styles.page} aria-busy="true" aria-label="Loading My Hotel">
      <CompanyHubSkeleton />
    </div>
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
    return isTabId(requested) ? requested : 'hotels';
  });
  const [query, setQuery] = React.useState('');
  const [hotelStatusFilter, setHotelStatusFilter] = React.useState<HotelStatusFilter>('all');
  const [teamInviteHotelId, setTeamInviteHotelId] = React.useState<string | null>(null);
  const [requestOpen, setRequestOpen] = React.useState(false);
  const [reviewRequest, setReviewRequest] = React.useState<CompanyAccessRequest | null>(null);
  const [lifecycleAction, setLifecycleAction] = React.useState<CompanyLifecycleAction | null>(null);
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
  // The in-place admin destination is privilege-bearing discovery just like the
  // global Admin destination. Never derive it from the initial browser account
  // row; wait for the fresh no-store session authorization verdict.
  const adminPreview = Boolean(
    authorizationChecked && platformAdmin && userRole === 'admin',
  );
  const requestedAdminHotelId = searchParams.get('pid');

  // Admin > Hotels links People to one exact hotel. Resolve that URL target
  // through PropertyContext before loading the preview so a stale localStorage
  // selection can never open another hotel's roster.
  React.useEffect(() => {
    if (!adminPreview || propertyLoading || !requestedAdminHotelId) return;
    const requestedHotelExists = contextProperties.some(
      (property) => property.id === requestedAdminHotelId,
    );
    if (requestedHotelExists && activePropertyId !== requestedAdminHotelId) {
      setActivePropertyId(requestedAdminHotelId);
    }
  }, [
    activePropertyId,
    adminPreview,
    contextProperties,
    propertyLoading,
    requestedAdminHotelId,
    setActivePropertyId,
  ]);

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
  // owner/VP/finance grant into hotel roster authority. A duplicated standing
  // is a corrupt snapshot and is not treated as authority.
  const issuedPropertyStanding = matchingPropertyStandings.length === 1
    ? matchingPropertyStandings[0]
    : null;
  // The shared viewer-standing rule. A platform admin holds the full-power
  // standing at every hotel (see @/lib/authorization/domain); a customer gets
  // exactly the standing the server issued for this exact hotel, unchanged.
  const activePropertyStanding = resolveViewerHotelStanding({
    platformAdmin: platformAdmin && userRole === 'admin',
    standings: issuedPropertyStanding ? [issuedPropertyStanding] : [],
    propertyId: activePropertyId,
  });
  const hotelPresentationRole = activePropertyStanding?.operationalRole ?? null;
  const hotelMutationAuthorized = authorizationChecked && Boolean(
    activePropertyStanding?.hotelMutationAllowed === true,
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
  // Deliberately `canManageTeam`, not the bare mutation standing: GET
  // /api/auth/team still requires `manage_team`, so widening the client gate to
  // the mutation bit alone would only show a customer a failed fetch, and would
  // let the roster read escape the capability that governs it. An admin now
  // satisfies `canManageTeam` through the shared standing above, so the old
  // separate `adminPreview` read gate is no longer a different answer.
  const canViewHotelTeam = hotelCapabilitiesReady
    && authorizationChecked
    && canManageTeam;
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
    && activePropertyStanding?.seesFinancials === true
    && canForStanding(
      hotelPresentationRole ? { role: hotelPresentationRole } : null,
      'view_wages',
      capabilityOverrides,
    );
  const staffBelongsToCurrentViewer = Boolean(activePropertyViewerKey
    && staffViewerKey === activePropertyViewerKey);
  const currentStaff = canViewHotelTeam && staffBelongsToCurrentViewer
    ? staff
    : [];
  const currentStaffSettled = canViewHotelTeam && staffBelongsToCurrentViewer
    && (staffLoaded || staffLoadFailed);
  const currentStaffUnavailable = canViewHotelTeam && staffBelongsToCurrentViewer && staffLoadFailed;

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

  // A hotel-card People deep link may arrive while PropertyContext still holds
  // the prior localStorage selection. Do not paint that prior hotel's roster
  // during the one render before the exact `pid` selection effect commits.
  const adminLinkTargetIsCurrent = !adminPreview
    || !requestedAdminHotelId
    || requestedAdminHotelId === activePropertyId;
  const adminTargetIsCurrent = adminLinkTargetIsCurrent
    && (!adminPreview || adminTargetPropertyId === activePropertyId);
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
  const peopleControllerViewerKey = activePropertyViewerKey
    ? `${activePropertyViewerKey}:people:${authorizationFingerprint ?? 'unverified'}`
    : null;
  const peopleController = usePeopleController({
    hotelId: activePropertyId,
    viewerKey: peopleControllerViewerKey,
    enabled: Boolean(
      tab === 'people'
      && !portfolioMode
      && currentData
      && activePropertyId
      && canViewHotelTeam
      && staffBelongsToCurrentViewer
      && hotelCapabilitiesReady
      && authorizationChecked,
    ),
    adminPreview,
    readOnly: Boolean(resolved.viewerContext?.readOnly),
    staff: currentStaff,
    staffViewerKey,
    staffExpectedViewerKey: activePropertyViewerKey,
    staffLoaded,
    staffLoadFailed,
    refreshStaff,
  });
  const customerStructureViewerKey = accountId && userRole && userRole !== 'admin'
    ? `${accountId}:${userRole}:company-structure:${authorizationFingerprint ?? 'unverified'}`
    : null;
  const currentStructure = !portfolioMode && customerStructureViewerKey
    && structureViewerKey === customerStructureViewerKey
    ? structure
    : null;

  React.useEffect(() => {
    if (!user || authLoading || propertyLoading) {
      setStructureLoading(false);
      setStructureError(null);
      return;
    }
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
          setStructureError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setStructure(null);
          setStructureViewerKey(viewerKey);
          setStructureError(caught instanceof Error ? caught.message : 'Live company structure could not be loaded.');
        }
      } finally {
        if (!cancelled) setStructureLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accountId, authLoading, authorizationFingerprint, currentData, portfolioMode, propertyLoading, retryKey, user, userRole]);
  // The tab values are URL-facing. Overview is a legacy value and is
  // normalized to Hotels below so old bookmarks still land on useful content.
  const tabs = React.useMemo<TabDefinition[]>(() => {
    return [
      { id: 'hotels', label: 'Hotels', icon: Hotel },
      { id: 'people', label: 'People', icon: Users },
      { id: 'access', label: 'Access', icon: KeyRound },
    ];
  }, []);

  React.useEffect(() => {
    const requested = searchParams.get('tab');
    const next = isTabId(requested) ? requested : 'hotels';
    setTab(next);
    setQuery('');
    setHotelStatusFilter('all');
    if (next !== 'people') setTeamInviteHotelId(null);
    if (requested === 'overview' || (requested !== null && !isTabId(requested))) {
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', 'hotels');
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }
  }, [pathname, router, searchParams]);

  React.useEffect(() => {
    if (loading || (user && !currentData && !currentLoadError)) return;
    if (tabs.some((item) => item.id === tab)) return;
    setTab('hotels');
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', 'hotels');
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
  const peopleRosterLoading = tab === 'people'
    && currentData?.viewerContext?.scope === 'property'
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
    || peopleRosterLoading
    || (tab === 'people' && hotelCapabilitiesLoading);
  const adminPreviewFailed = adminPreview && !showLoading && Boolean(currentLoadError) && !currentData;
  const companyAccessFailed = !adminPreview && !showLoading && Boolean(currentLoadError) && !currentData;
  const adminViewerContext = adminPreview ? resolved.viewerContext : undefined;
  const adminActionsAvailable = Boolean(
    adminPreview
    && adminViewerContext
    && adminDataMatchesSelection,
  );
  // Readiness lock only. Viewing a hotel as a platform admin is NOT a lock:
  // an admin gets every action the hotel's own owner would get, and only waits
  // for the same data this panel makes every other viewer wait for.
  const hotelTeamLocked = Boolean(
    showLoading
    || !currentData
    || (resolved.viewerContext?.readOnly === true && !adminActionsAvailable),
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
  React.useEffect(() => {
    if (portfolioMode || tab !== 'people' || !canManageTeam || hotelTeamLocked) {
      setTeamInviteHotelId(null);
    }
  }, [canManageTeam, hotelTeamLocked, portfolioMode, tab]);

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
    <>
      <div className={styles.page}>
        <header className={styles.hero}>
          <div className={styles.heroIdentity}>
            <div className={styles.heroMark} aria-hidden="true">
              <Building2 size={23} strokeWidth={1.8} />
            </div>
            <div className={styles.heroCopy}>
              <h1 ref={previewHeadingRef} tabIndex={adminPreview ? -1 : undefined}>{workspaceTitle}</h1>
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

        {adminPreviewFailed || companyAccessFailed ? (
          <section className={styles.adminPreviewError} role="alert" aria-labelledby="admin-preview-error-title">
            <span className={styles.adminPreviewErrorIcon} aria-hidden="true">
              <AlertTriangle size={20} />
            </span>
            <div>
              <h2 id="admin-preview-error-title" tabIndex={-1}>{adminPreviewFailed ? 'Hotel View could not be opened' : 'Company access could not be loaded'}</h2>
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
              {adminPreviewFailed ? (
                <button type="button" onClick={() => pushReliable('/admin/properties#live')}>
                  {'Back to Admin'}
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
              ) : null}
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
                <CompanyHubSkeleton />
              ) : !user ? (
                <EmptyState
                  icon={ShieldCheck}
                  title={'Sign in to view access'}
                  description={'Your company access is tied to your Staxis account.'}
                />
              ) : tab === 'hotels' ? (
                <HotelsPanel
                  data={resolved}
                  structure={currentStructure}
                  structureError={structureError}
                  structureLoading={structureLoading}
                  lang={lang}
                  query={query}
                  onQueryChange={setQuery}
                  statusFilter={hotelStatusFilter}
                  onStatusFilterChange={setHotelStatusFilter}
                  onStructureRetry={() => setRetryKey((value) => value + 1)}
                  onStructureChanged={completeAccessMutation}
                />
              ) : tab === 'people' ? (
                <PeoplePanel
                  key={activeProperty?.id ?? 'no-hotel'}
                  data={resolved}
                  staff={currentStaff}
                  hotelRosterUnavailable={currentStaffUnavailable}
                  rosterSettled={currentStaffSettled}
                  lang={lang}
                  currentUser={user}
                  currentAccountId={user.accountId}
                  activeProperty={activeProperty}
                  portfolioMode={portfolioMode}
                  canManageTeam={canManageTeam}
                  canViewTeam={canViewHotelTeam}
                  canInviteAccounts={Boolean(
                    adminActionsAvailable
                    || (activeProperty
                      && resolved.permissions.accountInvitePropertyIds?.includes(activeProperty.id))
                  )}
                  canViewWages={canViewWages}
                  canAddOperationalStaff={!hotelTeamLocked && canManageTeam}
                  peopleController={peopleController}
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
                  onRequestAccess={() => setRequestOpen(true)}
                  onReviewRequest={setReviewRequest}
                  onLifecycleAction={setLifecycleAction}
                  onAccessChanged={completeAccessMutation}
                  onOpenPeople={() => switchTab('people')}
                />
              )}
            </section>
          </>
        )}
      </div>

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
    </>
  );
}

export function HotelsPanel({ data, structure, structureError, structureLoading, lang, query, onQueryChange, statusFilter, onStatusFilterChange, onStructureRetry, onStructureChanged }: {
  data: CompanyAccessData;
  structure: CompanyStructureProjection | null;
  structureError: string | null;
  structureLoading: boolean;
  lang: string;
  query: string;
  onQueryChange: (value: string) => void;
  statusFilter: HotelStatusFilter;
  onStatusFilterChange: (value: HotelStatusFilter) => void;
  onStructureRetry: () => void;
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
      {!data.viewerContext && structureError ? (
        <div className={styles.partialNotice} role="status">
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <strong>{'Company structure could not be loaded'}</strong>
            <span>{structureError}</span>
          </div>
          <button type="button" onClick={onStructureRetry} disabled={structureLoading}>
            <RefreshCw size={14} aria-hidden="true" />
            {'Retry'}
          </button>
        </div>
      ) : null}
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
export function PeoplePanel({ data, staff, hotelRosterUnavailable, rosterSettled = true, lang, currentUser, currentAccountId, activeProperty, portfolioMode = false, canManageTeam, canViewTeam, canInviteAccounts, canViewWages, canAddOperationalStaff, peopleController, inviteDialogOpen, onInviteDialogOpenChange, onChanged, onLifecycleAction }: {
  data: CompanyAccessData;
  staff: StaffMember[];
  hotelRosterUnavailable: boolean;
  rosterSettled?: boolean;
  lang: string;
  currentUser: AppUser;
  currentAccountId: string;
  activeProperty: Property | null;
  portfolioMode?: boolean;
  canManageTeam: boolean;
  canViewTeam?: boolean;
  canInviteAccounts: boolean;
  canViewWages: boolean;
  canAddOperationalStaff: boolean;
  peopleController?: PeopleControllerState;
  inviteDialogOpen: boolean;
  onInviteDialogOpenChange: (open: boolean) => void;
  onChanged: () => void | Promise<void>;
  onLifecycleAction: (action: CompanyLifecycleAction) => void;
}) {
  const adminPreview = data.viewerContext?.kind === 'staxis_admin_preview';
  const hotelTeamVisible = canViewTeam ?? canManageTeam;
  const inviteCapabilityKey = [
    canManageTeam ? 'hotel-manager' : 'invite-only',
    canInviteAccounts ? 'account-invite' : 'no-account-invite',
    adminPreview ? 'admin-preview' : 'customer',
    data.viewerContext?.readOnly ? 'read-only' : 'interactive',
  ].join(':');
  const inviteCapabilityRef = React.useRef(inviteCapabilityKey);
  const [, setInviteCapabilityRevision] = React.useState(0);
  const inviteCapabilitiesStable = inviteCapabilityRef.current === inviteCapabilityKey;
  const peopleHeadingRef = React.useRef<HTMLHeadingElement | null>(null);
  const restorePeopleHeadingFocusRef = React.useRef(false);
  React.useEffect(() => {
    if (inviteCapabilityRef.current === inviteCapabilityKey) return;
    inviteCapabilityRef.current = inviteCapabilityKey;
    setInviteCapabilityRevision((current) => current + 1);
    if (inviteDialogOpen) {
      restorePeopleHeadingFocusRef.current = true;
      onInviteDialogOpenChange(false);
    }
  }, [inviteCapabilityKey, inviteDialogOpen, onInviteDialogOpenChange]);
  React.useEffect(() => {
    if (!restorePeopleHeadingFocusRef.current || inviteDialogOpen) return;
    restorePeopleHeadingFocusRef.current = false;
    const focusHeading = () => {
      peopleHeadingRef.current?.focus({ preventScroll: true });
    };
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      focusHeading();
      return;
    }
    const frame = window.requestAnimationFrame(focusHeading);
    return () => window.cancelAnimationFrame(frame);
  }, [inviteCapabilitiesStable, inviteDialogOpen]);
  const showHotelPeople = Boolean(activeProperty && !portfolioMode);
  const visibleMemberships = data.permissions.viewPeople
    ? data.memberships
    : data.memberships.filter((membership) => (
      membership.accountId === currentAccountId || membership.isCurrentUser
    ));
  return (
    <div className={styles.stack}>
      {!showHotelPeople && (visibleMemberships.length > 0 || data.invitations.length > 0 || data.permissions.manageInvitations) ? (
        <section className={styles.sectionBlock}>
          <div className={styles.headingWithAction}>
            <SectionHeading
              title={'Memberships and invitations'}
            />
            {!activeProperty && !canManageTeam && canInviteAccounts ? (
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
      {showHotelPeople && activeProperty ? (
        <HotelTeamPanel
          key={`${activeProperty.id}:${adminPreview ? 'admin' : 'customer'}:${canManageTeam ? 'hotel-authorized' : 'invite-only'}:${hotelTeamVisible ? 'team-visible' : 'team-hidden'}`}
          hotelId={activeProperty.id}
          hotelName={activeProperty.name}
          currentUser={currentUser}
          currentAccountId={currentAccountId}
          lang={'en'}
          canManageTeam={canManageTeam}
          canViewTeam={hotelTeamVisible}
          canInviteAccounts={canInviteAccounts}
          canViewWages={canViewWages}
          readOnly={Boolean(data.viewerContext?.readOnly)}
          adminPreview={adminPreview}
          peopleHeadingRef={peopleHeadingRef}
          inviteDialogOpen={inviteDialogOpen && inviteCapabilitiesStable}
          onInviteDialogOpenChange={onInviteDialogOpenChange}
          staffProfiles={staff}
          rosterUnavailable={hotelRosterUnavailable}
          rosterSettled={rosterSettled}
          canAddStaff={canAddOperationalStaff}
          peopleController={peopleController}
          onChanged={onChanged}
        />
      ) : !portfolioMode ? (
        <EmptyState
          icon={Hotel}
          title={'Choose a hotel first'}
          description={'Team accounts are always managed for one exact hotel.'}
        />
      ) : null}
    </div>
  );
}

function AccessPanel({ data, lang, currentUser, currentAccountId, activeProperty, canManageUsers, onRequestAccess, onReviewRequest, onLifecycleAction, onAccessChanged, onOpenPeople }: {
  data: CompanyAccessData;
  lang: string;
  currentUser: AppUser;
  currentAccountId: string;
  activeProperty: Property | null;
  canManageUsers: boolean;
  onRequestAccess: () => void;
  onReviewRequest: (request: CompanyAccessRequest) => void;
  onLifecycleAction: (action: CompanyLifecycleAction) => void;
  onAccessChanged: () => void;
  onOpenPeople: () => void;
}) {
  const adminPreview = data.viewerContext?.kind === 'staxis_admin_preview';
  // The projection route already scopes memberships and access history to what
  // this caller may see. Keep the client belt anyway: without `view_people`,
  // Access answers for this viewer only. Removing it would be the one way this
  // rebuild could show a colleague's roles to someone who may not see people.
  const visibleAccessData = React.useMemo<CompanyAccessData>(() => {
    if (data.permissions.viewPeople) return data;
    return {
      ...data,
      memberships: data.memberships.filter((membership) => (
        membership.accountId === currentAccountId || membership.isCurrentUser
      )),
      accessHistory: (data.accessHistory ?? []).filter((entry) => (
        entry.accountId === currentAccountId
      )),
    };
  }, [currentAccountId, data]);
  const accessContext = React.useMemo(
    () => resolveCompanyAccessContext(data, activeProperty?.id ?? null, data.viewerContext),
    [activeProperty?.id, data],
  );
  const accessPeople = React.useMemo(
    () => buildAccessPeople(visibleAccessData, accessContext, currentAccountId),
    [accessContext, currentAccountId, visibleAccessData],
  );
  const inheritedOnly = accessPeople.effectivePeople.length > 0
    && accessPeople.effectivePeople.every((person) => (
      person.currentRecords.length > 0
      && person.currentRecords.every((record) => record.source === 'company')
    ));
  const [editorProjection, setEditorProjection] = React.useState<CompanyAccessEditorProjection | null>(null);
  const [editorError, setEditorError] = React.useState('');
  const [editorReloadKey, setEditorReloadKey] = React.useState(0);
  const [editingMembershipId, setEditingMembershipId] = React.useState<string | null>(null);
  const editorDataKey = [
    ...data.organizations.map((organization) => organization.id),
    ...data.memberships.map((membership) => membership.id),
    accessContext.organizationId ?? 'no-company',
    accessContext.selectedPropertyId ?? 'no-hotel',
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
        <AccessContextCard context={accessContext} adminPreview={adminPreview} />

        {data.legacyFallback ? (
          <EmptyState
            icon={AlertTriangle}
            title={'Hotel access is unavailable'}
            description={'The authoritative access view is temporarily unavailable. Retry the page before changing access.'}
          />
        ) : accessContext.state !== 'ready' ? (
          <EmptyState
            icon={AlertTriangle}
            title={'Hotel access is unavailable'}
            description={accessContext.state === 'ambiguous'
              ? 'This hotel is connected to more than one current company context. Access is hidden until the relationship can be confirmed.'
              : 'The selected hotel and company relationship could not be confirmed. Try again or choose another hotel.'}
          />
        ) : !data.permissions.viewAccess ? (
          <EmptyState
            icon={ShieldCheck}
            title={'Hotel access is unavailable'}
            description={'Your current account does not have permission to view access for this hotel.'}
          />
        ) : (
          <>
            <div className={styles.headingWithAction}>
              <SectionHeading
                title={'People with hotel access'}
                description={'Each person appears once. Their role, hotel scope, source, and status are shown together.'}
              />
              {!adminPreview && data.permissions.requestAccess ? (
                <div className={styles.headingActions}>
                  <button type="button" className={styles.secondaryButton} onClick={onRequestAccess}>
                    <KeyRound size={16} aria-hidden="true" />
                    {'Request access'}
                  </button>
                </div>
              ) : null}
            </div>

            {inheritedOnly ? (
              <div className={styles.accessInheritedNotice} role="note">
                <Building2 size={17} aria-hidden="true" />
                <span>{`Everyone shown here inherits access through ${accessContext.organizationName ?? 'the company'}.`}</span>
              </div>
            ) : null}

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

            {accessPeople.effectivePeople.length > 0 ? (
              <div className={styles.accessPeopleList} role="list" aria-label={'People with hotel access'}>
                {accessPeople.effectivePeople.map((person) => (
                  <AccessPersonRow
                    key={person.accountId ?? person.displayName}
                    person={person}
                    data={visibleAccessData}
                    context={accessContext}
                    editorProjection={editorProjection}
                    adminPreview={adminPreview}
                    lang={lang}
                    onEdit={(membershipId) => setEditingMembershipId(membershipId)}
                    onLifecycleAction={onLifecycleAction}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                icon={KeyRound}
                title={'No hotel access yet'}
                description={'Choose an existing person in People to add a role and hotel scope.'}
                actionLabel={'Open People'}
                onAction={onOpenPeople}
              />
            )}

            {accessPeople.pendingPeople.length > 0 ? (
              <section className={styles.sectionBlock}>
                <SectionHeading
                  title={'Pending access'}
                  description={'Pending access is not active. An authorized manager can review requests here.'}
                />
                <div className={styles.accessPeopleList} role="list" aria-label={'Pending access requests'}>
                  {accessPeople.pendingPeople.flatMap((person) => person.pendingRecords.map((record) => {
                    const request = data.requests.find((candidate) => `request:${candidate.id}` === record.id);
                    return (
                      <AccessRequestRow
                        key={record.id}
                        person={person}
                        record={record}
                        request={request}
                        lang={lang}
                        onReview={request?.canReview ? () => onReviewRequest(request) : undefined}
                      />
                    );
                  }))}
                </div>
              </section>
            ) : null}

            {accessPeople.peopleWithoutHotelAccess.length > 0 ? (
              <section className={styles.sectionBlock}>
                <div className={styles.headingWithAction}>
                  <SectionHeading
                    title={'People without access at this hotel'}
                    description={'These identities already exist in People. Adding access does not create another person.'}
                  />
                  <button type="button" className={styles.secondaryButton} onClick={onOpenPeople}>
                    <Users size={16} aria-hidden="true" />
                    {'Open People'}
                  </button>
                </div>
                <div className={styles.accessPeopleList} role="list" aria-label={'People without hotel access'}>
                  {accessPeople.peopleWithoutHotelAccess.map((person) => (
                    <AccessPersonRow
                      key={person.accountId ?? person.displayName}
                      person={person}
                      data={visibleAccessData}
                      context={accessContext}
                      editorProjection={editorProjection}
                      adminPreview={adminPreview}
                      lang={lang}
                      onEdit={(membershipId) => setEditingMembershipId(membershipId)}
                      onLifecycleAction={onLifecycleAction}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {accessPeople.historyPeople.length > 0 || data.activity.length > 0 ? (
              <section className={styles.sectionBlock}>
                <details className={styles.accessHistoryDisclosure}>
                  <summary>
                    <span>
                      <CalendarClock size={17} aria-hidden="true" />
                      <strong>{'Access history'}</strong>
                    </span>
                    <ChevronDown size={17} aria-hidden="true" />
                  </summary>
                  <div className={styles.accessHistoryBody}>
                    {accessPeople.historyPeople.map((person) => (
                      <AccessHistoryPersonRow key={person.accountId ?? person.displayName} person={person} lang={lang} />
                    ))}
                    {data.permissions.viewActivity && data.activity.length > 0 ? (
                      <div className={styles.activityList} role="list" aria-label={'Access activity'}>
                        {data.activity
                          .filter((event) => (
                            (!accessContext.organizationId || event.organizationId === accessContext.organizationId)
                            && (!event.propertyId || event.propertyId === accessContext.selectedPropertyId)
                          ))
                          .slice(0, 20)
                          .map((event) => (
                            <div key={event.id} className={styles.activityRow} role="listitem">
                              <span>{event.summary}</span>
                              <small>{event.actorName} · {formatDate(event.createdAt, lang)}</small>
                            </div>
                          ))}
                      </div>
                    ) : null}
                  </div>
                </details>
              </section>
            ) : null}
          </>
        )}
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

function AccessContextCard({ context, adminPreview }: { context: CompanyAccessContext; adminPreview: boolean }): React.ReactElement {
  return (
    <section className={styles.accessContextCard} aria-label={'Selected access context'}>
      <div className={styles.accessContextIdentity}>
        <span className={styles.accessContextIcon}><Hotel size={18} aria-hidden="true" /></span>
        <div>
          <span>{'Hotel'}</span>
          <strong>{context.selectedPropertyName ?? 'Selected hotel'}</strong>
        </div>
      </div>
      <div className={styles.accessContextIdentity}>
        <span className={styles.accessContextIcon}><Building2 size={18} aria-hidden="true" /></span>
        <div>
          <span>{'Company context'}</span>
          <strong>{context.organizationName ?? 'Hotel-only access'}</strong>
        </div>
      </div>
      {adminPreview ? <span className={styles.readOnlyBadge}><ShieldCheck size={14} aria-hidden="true" />{'Viewing as Staxis admin'}</span> : null}
    </section>
  );
}

function AccessPersonRow({ person, data, context, editorProjection, adminPreview, lang, onEdit, onLifecycleAction }: {
  person: AccessPerson;
  data: CompanyAccessData;
  context: CompanyAccessContext;
  editorProjection: CompanyAccessEditorProjection | null;
  adminPreview: boolean;
  lang: string;
  onEdit: (membershipId: string) => void;
  onLifecycleAction: (action: CompanyLifecycleAction) => void;
}) {
  const editorOrganization = context.organizationId
    ? editorProjection?.organizations.find((organization) => organization.id === context.organizationId)
    : null;
  const editorMembership = person.membershipIds
    .map((membershipId) => editorOrganization?.memberships.find((candidate) => candidate.id === membershipId) ?? null)
    .find((membership): membership is CompanyAccessEditorMembership => Boolean(
      membership && (membership.canAdd || membership.canReplace),
    )) ?? null;
  const membership = person.membership;
  const editableMembershipId = editorMembership?.id ?? null;
  const canEdit = !adminPreview && editableMembershipId !== null;
  const revocableRecords = person.currentRecords.filter((record) => (
    record.scopeType === 'property'
      && !record.isMembershipAccess
      && record.sourceIds.length === 1
      && data.memberships.some((candidate) => (
        candidate.accountId === person.accountId
        && candidate.organizationId === context.organizationId
        && candidate.grants.some((grant) => grant.id === record.sourceIds[0] && grant.canRevoke)
      ))
  ));
  const isOwner = person.currentRecords.some((record) => record.accessProfile === 'organization_owner')
    || membership?.accessProfile === 'organization_owner';
  const canChangeMembership = !adminPreview && !isOwner && Boolean(membership)
    && Boolean(membership?.canSuspend || membership?.canResume || membership?.canRemove);
  const hasActions = canEdit || revocableRecords.length > 0 || canChangeMembership;
  return (
    <article className={styles.accessPersonRow} role="listitem">
      <Avatar name={person.displayName} />
      <div className={styles.accessPersonBody}>
        <div className={styles.accessPersonHeading}>
          <strong>{person.displayName}{person.isCurrentUser ? <small>{'You'}</small> : null}</strong>
          {person.jobTitle ? <span>{person.jobTitle}</span> : null}
        </div>
        {person.records.length > 0 ? (
          <div className={styles.accessRecordList} role="list" aria-label={`${person.displayName} access details`}>
            {person.records.map((record) => (
              <AccessRecordRow
                key={record.id}
                record={record}
                lang={lang}
              />
            ))}
          </div>
        ) : (
          <p className={styles.noHotelAccessCopy}>{'No access at this hotel yet.'}</p>
        )}
      </div>
      <div className={styles.accessPersonActions}>
        {person.records.length > 0 ? (
          <div className={styles.accessStatusStack}>
            {person.records.map((record) => (
              <span key={record.id} className={`${styles.status} ${statusClass(record.status)}`}>{statusLabel(record.status, lang)}</span>
            ))}
          </div>
        ) : null}
        {hasActions ? (
          <details className={styles.actionMenu}>
            <summary>{'Actions'}</summary>
            <div>
              {canEdit && editableMembershipId ? (
                <button type="button" onClick={() => onEdit(editableMembershipId)}>
                  {person.hasCurrentAccess ? 'Edit role and hotel scope' : 'Give hotel access'}
                </button>
              ) : null}
              {revocableRecords.length > 0 ? <hr /> : null}
              {revocableRecords.map((record) => (
                <button
                  key={record.id}
                  type="button"
                  onClick={() => onLifecycleAction({
                    kind: 'revoke_grant',
                    id: record.sourceIds[0],
                    targetLabel: person.displayName,
                    detailLabel: `${record.roleLabel} · ${record.scopeLabel}`,
                  })}
                >
                  {'Remove hotel access'}
                </button>
              ))}
              {canChangeMembership && membership?.canSuspend ? (
                <button type="button" onClick={() => onLifecycleAction({
                  kind: 'suspend_membership',
                  id: membership.id,
                  targetLabel: person.displayName,
                  detailLabel: context.organizationName ?? 'Company access',
                })}>{'Suspend access'}</button>
              ) : null}
              {canChangeMembership && membership?.canResume ? (
                <button type="button" onClick={() => onLifecycleAction({
                  kind: 'resume_membership',
                  id: membership.id,
                  targetLabel: person.displayName,
                  detailLabel: context.organizationName ?? 'Company access',
                })}>{'Reactivate access'}</button>
              ) : null}
              {canChangeMembership && membership?.canRemove ? (
                <button type="button" className={styles.menuDanger} onClick={() => onLifecycleAction({
                  kind: 'remove_membership',
                  id: membership.id,
                  targetLabel: person.displayName,
                  detailLabel: context.organizationName ?? 'Company access',
                })}>{'Remove company access'}</button>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
    </article>
  );
}

function AccessRequestRow({ person, record, request, lang, onReview }: {
  person: AccessPerson;
  record: AccessPersonRecord;
  request?: CompanyAccessRequest;
  lang: string;
  onReview?: () => void;
}) {
  return (
    <article className={styles.accessPersonRow} role="listitem">
      <Avatar name={person.displayName} />
      <div className={styles.accessPersonBody}>
        <div className={styles.accessPersonHeading}>
          <strong>{person.displayName}</strong>
          {person.jobTitle ? <span>{person.jobTitle}</span> : null}
        </div>
        <AccessRecordRow record={record} lang={lang} />
      </div>
      <div className={styles.accessPersonActions}>
        <div className={styles.accessStatusStack}>
          <span className={`${styles.status} ${styles.statusPending}`}>{statusLabel(record.status, lang)}</span>
        </div>
        {request?.canReview && onReview ? (
          <button type="button" className={styles.reviewButton} onClick={onReview}>{'Review request'}</button>
        ) : null}
      </div>
    </article>
  );
}

function AccessRecordRow({ record, lang }: { record: AccessPersonRecord; lang: string }) {
  return (
    <div className={styles.accessRecord} role="listitem">
      <div className={styles.accessRecordMain}>
        <strong>{record.roleLabel || accessProfileLabel(record.accessProfile)}</strong>
        <span>{record.scopeLabel}</span>
      </div>
      <div className={styles.accessRecordMeta}>
        <span>{record.sourceLabel || accessSourceLabel(record.source)}</span>
        {record.expiresAt ? <span>{'Expires'} {formatDate(record.expiresAt, lang)}</span> : null}
        {record.reason ? <small>{record.reason}</small> : null}
      </div>
    </div>
  );
}

function AccessHistoryPersonRow({ person, lang }: { person: AccessPerson; lang: string }) {
  return (
    <div className={styles.accessHistoryPerson}>
      <div className={styles.accessHistoryPersonHeader}>
        <strong>{person.displayName}</strong>
        <span>{person.jobTitle ?? 'Access history'}</span>
      </div>
      <div className={styles.accessRecordList} role="list" aria-label={`${person.displayName} access history`}>
        {person.history.map((record) => (
          <AccessRecordRow key={record.id} record={record} lang={lang} />
        ))}
      </div>
    </div>
  );
}

function OrganizationHierarchy({ data, lang, visiblePropertyIds }: {
  data: CompanyAccessData;
  lang: string;
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
  if (data.properties.length === 0) {
    return (
      <EmptyState
        icon={Hotel}
        compact
        title={'No hotels assigned'}
        description={'Hotels will appear after hotel access becomes active.'}
      />
    );
  }

  return (
    <div className={styles.hierarchy}>
      {realOrganizations.map((organization, index) => {
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
            defaultOpen={realOrganizations.length === 1 || index === 0}
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

function SectionHeading({ eyebrow, title, description }: { eyebrow?: string; title: string; description?: string }) {
  return (
    <div className={styles.sectionHeading}>
      {eyebrow ? <span>{eyebrow}</span> : null}
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
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
                    {accessProfileLabel(grant.accessProfile)} · {grant.scopeLabel}
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
              {revocableGrants.length > 0 ? <small>{'Hotel access'}</small> : null}
              {revocableGrants.map((grant) => (
                <button
                  key={grant.id}
                  type="button"
                  onClick={() => onLifecycleAction({
                    kind: 'revoke_grant',
                    id: grant.id,
                    targetLabel: membership.displayName,
                    detailLabel: `${accessProfileLabel(grant.accessProfile)} · ${grant.scopeLabel}`,
                  })}
                >
                  {'Remove'} {accessProfileLabel(grant.accessProfile)}
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
        <span>{accessProfileLabel(invitation.accessProfile)} · {invitation.scopeLabel} · {formatDate(invitation.expiresAt, lang)}</span>
      </div>
      <div className={styles.requestRowActions}>
        <span className={`${styles.status} ${statusClass(invitation.status)}`}>{statusLabel(invitation.status, lang)}</span>
        {invitation.canCancel ? (
          <button type="button" className={styles.reviewButton} onClick={() => onLifecycleAction({
            kind: 'cancel_invitation',
            id: invitation.id,
            targetLabel: invitation.email,
            detailLabel: `${accessProfileLabel(invitation.accessProfile)} · ${invitation.scopeLabel}`,
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

function CompanyHubSkeleton() {
  return (
    <div className={styles.skeletonSurface} role="status" aria-label={'Loading company access'}>
      <div className={styles.skeletonToolbar} aria-hidden="true">
        <span />
        <span />
      </div>
      <div className={styles.skeletonRows} aria-hidden="true">
        {[0, 1, 2].map((key) => (
          <div key={key} className={styles.skeletonRow}>
            <span />
            <div>
              <strong />
              <small />
            </div>
            <span />
          </div>
        ))}
      </div>
    </div>
  );
}
