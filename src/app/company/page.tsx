'use client';

export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import React from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  Check,
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
import { useAuth, type AppUser } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  EMPTY_COMPANY_ACCESS,
  legacyAccessProfile,
  titleCaseAccessValue,
  type CompanyAccessData,
  type CompanyAccessRequest,
  type CompanyAccessPermissions,
  type CompanyActivityEvent,
  type CompanyInvitation,
  type CompanyMembership,
  type CompanyOrganization,
  type CompanyPortfolio,
  type CompanyProperty,
  type EffectiveAccessReceipt,
} from '@/lib/company-access/dto';
import type { StaffMember, Property } from '@/types';

import styles from './CompanyAccess.module.css';
import {
  CompanyLifecycleDialog,
  InvitePersonDialog,
  RequestAccessDialog,
  ReviewAccessRequestDialog,
  type CompanyLifecycleAction,
} from './_components/AccessWorkflowDialogs';

type TabId = 'overview' | 'hotels' | 'people' | 'access' | 'activity';
type HotelStatusFilter = 'all' | 'active' | 'not_active';
type PeopleStatusFilter = 'all' | 'active' | 'invited' | 'not_active';

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

const MANAGER_PROFILES = new Set([
  'organization_owner',
  'organization_admin',
  'portfolio_manager',
  'property_manager',
  'organization owner',
  'organization administrator',
  'portfolio manager',
  'property manager',
  'property owner',
  'staxis administrator',
]);

function localized(lang: string, en: string, es: string): string {
  return lang === 'es' ? es : en;
}

function formatDate(value: string | null | undefined, lang: string): string {
  if (!value) return localized(lang, 'No expiration', 'Sin vencimiento');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', {
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
  return localized(lang, pair[0], pair[1]);
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
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const {
    properties: contextProperties,
    activeProperty,
    staff,
    staffLoaded,
    staffLoadFailed,
    staffViewerKey,
    loading: propertyLoading,
  } = useProperty();
  const { lang } = useLang();

  const [data, setData] = React.useState<CompanyAccessData | null>(null);
  const [dataViewerKey, setDataViewerKey] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loadErrorViewerKey, setLoadErrorViewerKey] = React.useState<string | null>(null);
  const [adminTargetPropertyId, setAdminTargetPropertyId] = React.useState<string | null>(null);
  const [retryKey, setRetryKey] = React.useState(0);
  const [tab, setTab] = React.useState<TabId>('overview');
  const [query, setQuery] = React.useState('');
  const [hotelStatusFilter, setHotelStatusFilter] = React.useState<HotelStatusFilter>('all');
  const [peopleStatusFilter, setPeopleStatusFilter] = React.useState<PeopleStatusFilter>('all');
  const [selectedReceipt, setSelectedReceipt] = React.useState<EffectiveAccessReceipt | null>(null);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [requestOpen, setRequestOpen] = React.useState(false);
  const [reviewRequest, setReviewRequest] = React.useState<CompanyAccessRequest | null>(null);
  const [lifecycleAction, setLifecycleAction] = React.useState<CompanyLifecycleAction | null>(null);
  const previewHeadingRef = React.useRef<HTMLHeadingElement | null>(null);
  const focusPreviewAfterRetryRef = React.useRef(false);

  const propertyKey = contextProperties.map((property) => property.id).sort().join(',');
  const accountId = user?.accountId ?? null;
  const userRole = user?.role ?? null;
  const activePropertyId = activeProperty?.id ?? null;
  const adminPreview = userRole === 'admin';
  const staffBelongsToCurrentViewer = Boolean(user?.uid && activePropertyId
    && staffViewerKey === `${user.uid}:${activePropertyId}`);
  const currentStaff = staffBelongsToCurrentViewer
    ? staff
    : [];
  const currentStaffSettled = staffBelongsToCurrentViewer
    && (staffLoaded || staffLoadFailed);
  const currentStaffUnavailable = staffBelongsToCurrentViewer && staffLoadFailed;

  React.useEffect(() => {
    if (!user || authLoading || propertyLoading) return;
    const requestedPropertyId = user.role === 'admin' ? activePropertyId : null;
    const requestedViewerKey = `${user.accountId}:${user.role}:${requestedPropertyId ?? 'customer'}`;
    if (user.role === 'admin' && !requestedPropertyId) {
      setAdminTargetPropertyId(null);
      setData(null);
      setDataViewerKey(null);
      setLoadError(localized(lang, 'Select a hotel before opening Hotel View.', 'Selecciona un hotel antes de abrir la vista del hotel.'));
      setLoadErrorViewerKey(requestedViewerKey);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setData(null);
    setDataViewerKey(null);
    setSelectedReceipt(null);
    setInviteOpen(false);
    setRequestOpen(false);
    setReviewRequest(null);
    setLifecycleAction(null);
    if (user.role === 'admin') {
      setAdminTargetPropertyId(requestedPropertyId);
      // Never leave another hotel's preview visible while the new target loads.
      setQuery('');
      setHotelStatusFilter('all');
      setPeopleStatusFilter('all');
    }
    setLoading(true);
    setLoadError(null);
    setLoadErrorViewerKey(null);

    void (async () => {
      try {
        const endpoint = user.role === 'admin'
          ? `/api/admin/company-access-preview?pid=${encodeURIComponent(requestedPropertyId!)}`
          : '/api/company-access';
        const response = await fetchWithAuth(endpoint);
        const body = await response.json().catch(() => ({})) as Envelope<CompanyAccessData>;
        if (!response.ok || !body.ok || !body.data) {
          throw new Error(user.role === 'admin'
            ? localized(
                lang,
                'Hotel View is unavailable for the selected hotel. Try again or return to Admin.',
                'La vista del hotel no está disponible para el hotel seleccionado. Inténtalo de nuevo o vuelve a Admin.',
              )
            : body.error || localized(lang, 'Company access could not be loaded.', 'No se pudo cargar el acceso de la empresa.'));
        }
        const normalized = normalizeCompanyData(body.data);
        if (user.role === 'admin' && (
          normalized.viewerContext?.kind !== 'staxis_admin_preview'
          || normalized.viewerContext.readOnly !== true
          || normalized.viewerContext.requestedPropertyId !== requestedPropertyId
        )) {
          throw new Error(localized(lang, 'The admin preview response did not match the selected hotel.', 'La vista previa de administrador no coincidió con el hotel seleccionado.'));
        }
        if (!cancelled) {
          setData(normalized);
          setDataViewerKey(requestedViewerKey);
          setLoadError(null);
          setLoadErrorViewerKey(null);
        }
      } catch (error) {
        if (cancelled) return;
        if (user.role === 'admin') {
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
          : localized(lang, 'Company access could not be loaded.', 'No se pudo cargar el acceso de la empresa.'));
        setLoadErrorViewerKey(requestedViewerKey);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [accountId, activePropertyId, authLoading, lang, propertyKey, propertyLoading, retryKey, userRole]); // eslint-disable-line react-hooks/exhaustive-deps

  const adminTargetIsCurrent = !adminPreview || adminTargetPropertyId === activePropertyId;
  const currentViewerKey = accountId && userRole
    ? `${accountId}:${userRole}:${adminPreview ? activePropertyId ?? 'customer' : 'customer'}`
    : null;
  const dataBelongsToCurrentViewer = Boolean(currentViewerKey && dataViewerKey === currentViewerKey);
  const adminDataMatchesSelection = !adminPreview || Boolean(
    data?.viewerContext
    && data.viewerContext.requestedPropertyId === activePropertyId,
  );
  const currentData = adminTargetIsCurrent && dataBelongsToCurrentViewer && adminDataMatchesSelection ? data : null;
  const currentLoadError = adminTargetIsCurrent && loadErrorViewerKey === currentViewerKey ? loadError : null;
  const resolved = currentData ?? EMPTY_COMPANY_ACCESS;
  const hasCompanyScope = resolved.effectiveAccess.some((receipt) => {
    const profile = receipt.accessProfile.toLowerCase();
    return receipt.scopeType !== 'property' || MANAGER_PROFILES.has(profile);
  });
  const isHotelManager = user?.role === 'admin' || user?.role === 'owner' || user?.role === 'general_manager';
  const leaderView = resolved.viewerContext?.scope === 'property'
    ? false
    : hasCompanyScope || isHotelManager;

  const tabs = React.useMemo<TabDefinition[]>(() => {
    const rows: TabDefinition[] = [
      { id: 'overview', label: localized(lang, 'Overview', 'Resumen'), icon: Building2 },
      {
        id: 'hotels',
        label: leaderView ? localized(lang, 'Hotels', 'Hoteles') : localized(lang, 'My Hotel', 'Mi hotel'),
        icon: Hotel,
      },
      {
        id: 'people',
        label: leaderView ? localized(lang, 'People', 'Personas') : localized(lang, 'My Team', 'Mi equipo'),
        icon: Users,
      },
      { id: 'access', label: localized(lang, 'Access', 'Acceso'), icon: KeyRound },
    ];
    if (resolved.permissions.viewActivity) {
      rows.push({ id: 'activity', label: localized(lang, 'Activity', 'Actividad'), icon: Activity });
    }
    return rows;
  }, [lang, leaderView, resolved.permissions.viewActivity]);

  React.useEffect(() => {
    if (!tabs.some((item) => item.id === tab)) setTab('overview');
  }, [tab, tabs]);

  const switchTab = (next: TabId) => {
    setTab(next);
    setQuery('');
    setHotelStatusFilter('all');
    setPeopleStatusFilter('all');
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
    || propertyLoading
    || (adminPreview && !adminTargetIsCurrent)
    || (loading && !currentData)
    || viewerTransitionLoading
    || propertyRosterLoading;
  const adminPreviewFailed = adminPreview && !showLoading && Boolean(currentLoadError) && !currentData;
  const adminViewerContext = adminPreview ? resolved.viewerContext : undefined;
  const workspaceTitle = adminPreview
    ? (adminViewerContext?.scope === 'organization'
        ? localized(lang, 'Company Hub', 'Centro de empresa')
        : adminViewerContext?.scope === 'property'
          ? localized(lang, 'My Hotel', 'Mi hotel')
          : localized(lang, 'Hotel View', 'Vista del hotel'))
    : localized(lang, 'Company & Access', 'Empresa y acceso');
  const customerContextLabel = resolved.organizations.length === 1
    ? resolved.organizations[0].name
    : resolved.organizations.length > 1
      ? localized(lang, `${resolved.organizations.length} company contexts`, `${resolved.organizations.length} contextos de empresa`)
      : null;
  const contextLabel = adminPreview
    ? adminViewerContext?.targetName ?? activeProperty?.name ?? null
    : customerContextLabel;
  const hotelRosterCount = resolved.viewerContext?.scope === 'property'
    ? currentStaff.filter((member) => member.isActive !== false).length
    : null;

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
          <div className={styles.heroMark} aria-hidden="true">
            <Building2 size={23} strokeWidth={1.8} />
          </div>
          <div className={styles.heroCopy}>
            <div className={styles.eyebrow}>
              {adminPreview
                ? localized(lang, 'Staxis admin preview', 'Vista previa de administrador de Staxis')
                : localized(lang, 'Company workspace', 'Espacio de empresa')}
            </div>
            <h1 ref={previewHeadingRef} tabIndex={adminPreview ? -1 : undefined}>{workspaceTitle}</h1>
            <p>
              {adminPreview
                ? localized(
                    lang,
                    'Review the customer workspace for the selected hotel. Changes are disabled.',
                    'Revisa el espacio del cliente para el hotel seleccionado. Los cambios están desactivados.',
                  )
                : localized(
                    lang,
                    'See your hotels, team, and exactly why you have access.',
                    'Consulta tus hoteles, tu equipo y exactamente por qué tienes acceso.',
                  )}
            </p>
          </div>
          {!showLoading && contextLabel ? (
            <div className={styles.contextBadge}>
              <MapPinned size={15} aria-hidden="true" />
              <span>{contextLabel}</span>
            </div>
          ) : null}
        </header>

        {adminViewerContext ? (
          <div className={styles.adminPreviewNotice} role="status">
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <strong>{localized(lang, 'Admin preview · Read-only', 'Vista de administrador · Solo lectura')}</strong>
              <span>
                {localized(
                  lang,
                  `Reviewing the customer workspace for ${adminViewerContext.targetName}.`,
                  `Revisando el espacio del cliente para ${adminViewerContext.targetName}.`,
                )}
              </span>
            </div>
            <button type="button" onClick={() => router.push('/admin/properties#live')}>
              {localized(lang, 'Back to Admin', 'Volver a Admin')}
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {currentLoadError && currentData ? (
          <div className={styles.partialNotice} role="status">
            <AlertTriangle size={17} aria-hidden="true" />
            <div>
              <strong>{localized(lang, 'Showing your current hotel access', 'Mostrando tu acceso actual al hotel')}</strong>
              <span>{localized(lang, 'Company details are temporarily unavailable.', 'Los detalles de la empresa no están disponibles temporalmente.')}</span>
            </div>
            <button type="button" onClick={() => setRetryKey((value) => value + 1)} disabled={loading}>
              <RefreshCw size={14} aria-hidden="true" />
              {localized(lang, 'Retry', 'Reintentar')}
            </button>
          </div>
        ) : null}

        {adminPreviewFailed ? (
          <section className={styles.adminPreviewError} role="alert" aria-labelledby="admin-preview-error-title">
            <span className={styles.adminPreviewErrorIcon} aria-hidden="true">
              <AlertTriangle size={20} />
            </span>
            <div>
              <h2 id="admin-preview-error-title" tabIndex={-1}>{localized(lang, 'Hotel View could not be opened', 'No se pudo abrir la vista del hotel')}</h2>
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
                {localized(lang, 'Retry', 'Reintentar')}
              </button>
              <button type="button" onClick={() => router.push('/admin/properties#live')}>
                {localized(lang, 'Back to Admin', 'Volver a Admin')}
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            </div>
          </section>
        ) : (
          <>
            <nav className={styles.tabs} role="tablist" aria-label={localized(lang, 'Company sections', 'Secciones de empresa')}>
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

            <section
              id={`company-panel-${tab}`}
              role="tabpanel"
              aria-labelledby={`company-tab-${tab}`}
              className={styles.panel}
            >
              {showLoading ? (
                <CompanyHubSkeleton lang={lang} />
              ) : !user ? (
                <EmptyState
                  icon={ShieldCheck}
                  title={localized(lang, 'Sign in to view access', 'Inicia sesión para ver el acceso')}
                  description={localized(lang, 'Your company access is tied to your Staxis account.', 'Tu acceso de empresa está vinculado a tu cuenta de Staxis.')}
                />
              ) : tab === 'overview' ? (
                <OverviewPanel
                  data={resolved}
                  lang={lang}
                  activePropertyName={activeProperty?.name ?? null}
                  hotelRosterCount={hotelRosterCount}
                  hotelRosterUnavailable={currentStaffUnavailable}
                  onViewReceipt={setSelectedReceipt}
                />
              ) : tab === 'hotels' ? (
                <HotelsPanel
                  data={resolved}
                  lang={lang}
                  query={query}
                  onQueryChange={setQuery}
                  statusFilter={hotelStatusFilter}
                  onStatusFilterChange={setHotelStatusFilter}
                />
              ) : tab === 'people' ? (
                <PeoplePanel
                  data={resolved}
                  staff={currentStaff}
                  hotelRosterUnavailable={currentStaffUnavailable}
                  lang={lang}
                  currentAccountId={user.accountId}
                  query={query}
                  onQueryChange={setQuery}
                  statusFilter={peopleStatusFilter}
                  onStatusFilterChange={setPeopleStatusFilter}
                  onInvite={() => setInviteOpen(true)}
                  onLifecycleAction={setLifecycleAction}
                />
              ) : tab === 'access' ? (
                <AccessPanel
                  data={resolved}
                  lang={lang}
                  onViewReceipt={setSelectedReceipt}
                  onRequestAccess={() => setRequestOpen(true)}
                  onReviewRequest={setReviewRequest}
                  onLifecycleAction={setLifecycleAction}
                  canOpenLegacyRoleSettings={Boolean(
                    activeProperty
                    && resolved.properties.some((property) => property.id === activeProperty.id)
                    && user.role === 'owner'
                  )}
                />
              ) : (
                <ActivityPanel events={resolved.activity} properties={resolved.properties} lang={lang} />
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
      {currentData && inviteOpen && !resolved.viewerContext ? (
        <InvitePersonDialog
          data={resolved}
          lang={lang}
          onClose={() => setInviteOpen(false)}
          onCompleted={() => setRetryKey((value) => value + 1)}
        />
      ) : null}
      {currentData && requestOpen && !resolved.viewerContext ? (
        <RequestAccessDialog
          data={resolved}
          lang={lang}
          onClose={() => setRequestOpen(false)}
          onCompleted={() => setRetryKey((value) => value + 1)}
        />
      ) : null}
      {currentData && reviewRequest && !resolved.viewerContext ? (
        <ReviewAccessRequestDialog
          request={reviewRequest}
          lang={lang}
          onClose={() => setReviewRequest(null)}
          onCompleted={() => setRetryKey((value) => value + 1)}
        />
      ) : null}
      {currentData && lifecycleAction && !resolved.viewerContext ? (
        <CompanyLifecycleDialog
          action={lifecycleAction}
          lang={lang}
          onClose={() => setLifecycleAction(null)}
          onCompleted={() => setRetryKey((value) => value + 1)}
        />
      ) : null}
    </AppLayout>
  );
}

function OverviewPanel({ data, lang, activePropertyName, hotelRosterCount, hotelRosterUnavailable, onViewReceipt }: {
  data: CompanyAccessData;
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
      <div className={styles.summaryGrid}>
        <SummaryCard
          icon={Hotel}
          label={localized(lang, 'Hotels in scope', 'Hoteles dentro del alcance')}
          value={String(data.properties.length)}
          detail={activePropertyName ?? localized(lang, 'No active hotel', 'Ningún hotel activo')}
        />
        <SummaryCard
          icon={Users}
          label={propertyPreview
            ? localized(lang, 'Active hotel staff', 'Personal activo del hotel')
            : localized(lang, 'Active people', 'Personas activas')}
          value={propertyPreview && hotelRosterUnavailable ? '—' : String(peopleCount)}
          detail={propertyPreview
            ? hotelRosterUnavailable
              ? localized(lang, 'Roster temporarily unavailable', 'Registro no disponible temporalmente')
              : localized(lang, 'From the hotel roster', 'Del registro del hotel')
            : data.permissions.viewPeople
              ? localized(lang, 'Based on your scope', 'Según tu alcance')
              : localized(lang, 'Only your access is shown', 'Solo se muestra tu acceso')}
        />
        <SummaryCard
          icon={Clock3}
          label={localized(lang, 'Needs attention', 'Requiere atención')}
          value={String(pendingCount)}
          detail={localized(lang, 'Invites and requests', 'Invitaciones y solicitudes')}
        />
      </div>

      {!data.viewerContext ? (
        <section className={styles.sectionBlock}>
          <SectionHeading
            eyebrow={localized(lang, 'Your access receipt', 'Tu recibo de acceso')}
            title={localized(lang, 'Why you can see this workspace', 'Por qué puedes ver este espacio')}
            description={localized(
              lang,
              'Your title describes your work. Your access profile and scope control what you can actually open.',
              'Tu cargo describe tu trabajo. Tu perfil y alcance de acceso controlan lo que puedes abrir.',
            )}
          />
          {primaryReceipt ? (
            <AccessReceiptCard receipt={primaryReceipt} properties={data.properties} lang={lang} onView={() => onViewReceipt(primaryReceipt)} featured />
          ) : (
            <EmptyState
              icon={KeyRound}
              compact
              title={localized(lang, 'No active access grant', 'No hay una concesión de acceso activa')}
              description={localized(lang, 'Ask your manager or Staxis support to review your account.', 'Pide a tu gerente o al soporte de Staxis que revise tu cuenta.')}
            />
          )}
        </section>
      ) : null}

      <section className={styles.sectionBlock}>
        <SectionHeading
          eyebrow={localized(lang, 'Your structure', 'Tu estructura')}
          title={localized(lang, 'Companies, regions, and hotels', 'Empresas, regiones y hoteles')}
            description={localized(lang, 'Each company relationship shows the hotels in that exact scope.', 'Cada relación empresarial muestra los hoteles dentro de ese alcance exacto.')}
        />
        <OrganizationHierarchy data={data} lang={lang} limit={5} />
      </section>
    </div>
  );
}

function HotelsPanel({ data, lang, query, onQueryChange, statusFilter, onStatusFilterChange }: {
  data: CompanyAccessData;
  lang: string;
  query: string;
  onQueryChange: (value: string) => void;
  statusFilter: HotelStatusFilter;
  onStatusFilterChange: (value: HotelStatusFilter) => void;
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
        eyebrow={localized(lang, 'Property scope', 'Alcance de propiedades')}
        title={localized(lang, 'Hotels you can access', 'Hoteles a los que tienes acceso')}
        description={localized(lang, 'Grouped by organization, portfolio, or region.', 'Agrupados por organización, cartera o región.')}
      />
      <FilterBar
        lang={lang}
        query={query}
        onQueryChange={onQueryChange}
        statusFilter={statusFilter}
        onStatusFilterChange={onStatusFilterChange}
        statusOptions={[
          { value: 'all', label: localized(lang, 'All', 'Todos') },
          { value: 'active', label: localized(lang, 'Active', 'Activos') },
          { value: 'not_active', label: localized(lang, 'Not active', 'No activos') },
        ]}
        searchLabel={localized(lang, 'Search hotels or companies', 'Buscar hoteles o empresas')}
      />
      {propertyMatches.length > 0 ? (
        <OrganizationHierarchy data={{ ...data, properties: propertyMatches }} lang={lang} visiblePropertyIds={visibleIds} />
      ) : (
        <EmptyState
          icon={Search}
          title={localized(lang, 'No hotels match', 'Ningún hotel coincide')}
          description={localized(lang, 'Try another search or clear the status filter.', 'Prueba otra búsqueda o borra el filtro de estado.')}
          actionLabel={localized(lang, 'Clear filters', 'Borrar filtros')}
          onAction={() => { onQueryChange(''); onStatusFilterChange('all'); }}
        />
      )}
    </div>
  );
}

function PeoplePanel({ data, staff, hotelRosterUnavailable, lang, currentAccountId, query, onQueryChange, statusFilter, onStatusFilterChange, onInvite, onLifecycleAction }: {
  data: CompanyAccessData;
  staff: StaffMember[];
  hotelRosterUnavailable: boolean;
  lang: string;
  currentAccountId: string;
  query: string;
  onQueryChange: (value: string) => void;
  statusFilter: PeopleStatusFilter;
  onStatusFilterChange: (value: PeopleStatusFilter) => void;
  onInvite: () => void;
  onLifecycleAction: (action: CompanyLifecycleAction) => void;
}) {
  const canInvite = data.permissions.manageInvitations
    && data.permissions.delegationPolicies.some((policy) => policy.profiles.length > 0);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleMemberships = data.memberships.filter((membership) => {
    if (!data.permissions.viewPeople && membership.accountId !== currentAccountId && !membership.isCurrentUser) return false;
    const organization = data.organizations.find((item) => item.id === membership.organizationId);
    const text = `${membership.displayName} ${membership.jobTitle ?? ''} ${membership.accessProfile ?? ''} ${organization?.name ?? ''}`.toLowerCase();
    const textMatch = !normalizedQuery || text.includes(normalizedQuery);
    const statusMatch = statusFilter === 'all'
      || (statusFilter === 'active' && membership.status === 'active')
      || (statusFilter === 'invited' && membership.status === 'pending')
      || (statusFilter === 'not_active' && membership.status !== 'active' && membership.status !== 'pending');
    return textMatch && statusMatch;
  });
  const useAdminHotelRoster = data.viewerContext?.scope === 'property';
  const rosterFallback = (useAdminHotelRoster || (visibleMemberships.length <= 1 && !data.permissions.viewPeople)) && statusFilter !== 'invited'
    ? staff.filter((member) => {
      const textMatch = !normalizedQuery || `${member.name} ${member.department ?? ''}`.toLowerCase().includes(normalizedQuery);
      const statusMatch = statusFilter === 'all'
        || (statusFilter === 'active' && member.isActive !== false)
        || (statusFilter === 'not_active' && member.isActive === false);
      return textMatch && statusMatch;
    })
    : [];
  const canViewInvitations = data.permissions.manageInvitations
    || data.viewerContext?.kind === 'staxis_admin_preview';
  const visibleInvitations = canViewInvitations
    ? data.invitations.filter((invitation) => {
      const organization = data.organizations.find((item) => item.id === invitation.organizationId);
      const text = `${invitation.email} ${invitation.accessProfile} ${invitation.scopeLabel} ${organization?.name ?? ''}`.toLowerCase();
      const textMatch = !normalizedQuery || text.includes(normalizedQuery);
      const statusMatch = statusFilter === 'all'
        || (statusFilter === 'invited' && invitation.status === 'pending')
        || (statusFilter === 'not_active' && invitation.status !== 'pending');
      return textMatch && statusMatch;
    })
    : [];

  return (
    <div className={styles.stack}>
      <div className={styles.headingWithAction}>
        <SectionHeading
          eyebrow={localized(lang, 'People', 'Personas')}
          title={data.permissions.viewPeople
            ? localized(lang, 'People in your scope', 'Personas dentro de tu alcance')
            : localized(lang, 'My hotel team', 'El equipo de mi hotel')}
          description={data.permissions.viewPeople
            ? localized(lang, 'Only people you are allowed to view appear here.', 'Solo aparecen las personas que tienes permiso para ver.')
            : localized(lang, 'Team directory details only—access settings stay private.', 'Solo detalles del directorio del equipo; la configuración de acceso permanece privada.')}
        />
        {canInvite ? (
          <button type="button" className={styles.primaryButton} onClick={onInvite}>
            <UserPlus size={16} aria-hidden="true" />
            {localized(lang, 'Invite person', 'Invitar persona')}
          </button>
        ) : null}
      </div>

      <FilterBar
        lang={lang}
        query={query}
        onQueryChange={onQueryChange}
        statusFilter={statusFilter}
        onStatusFilterChange={onStatusFilterChange}
        statusOptions={[
          { value: 'all', label: localized(lang, 'All', 'Todos') },
          { value: 'active', label: localized(lang, 'Active', 'Activos') },
          { value: 'invited', label: localized(lang, 'Invited', 'Invitados') },
          { value: 'not_active', label: localized(lang, 'Not active', 'No activos') },
        ]}
        searchLabel={localized(lang, 'Search people, roles, or companies', 'Buscar personas, cargos o empresas')}
      />

      {useAdminHotelRoster ? (
        <>
          {visibleMemberships.length > 0 ? (
            <section className={styles.sectionBlock}>
              <SectionHeading
                eyebrow={localized(lang, 'Access directory', 'Directorio de acceso')}
                title={localized(lang, 'Customer access members', 'Miembros con acceso del cliente')}
                description={localized(lang, 'These records come from customer access—not the hotel staff roster.', 'Estos registros provienen del acceso del cliente, no del registro de personal del hotel.')}
              />
              <div className={styles.listCard} role="list">
                {visibleMemberships.map((membership) => (
                  <MembershipRow
                    key={membership.id}
                    membership={membership}
                    organization={data.organizations.find((item) => item.id === membership.organizationId) ?? null}
                    isCurrentUser={false}
                    lang={lang}
                    onLifecycleAction={onLifecycleAction}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {statusFilter !== 'invited' ? (
            <section className={styles.sectionBlock}>
              <SectionHeading
                eyebrow={localized(lang, 'Hotel roster', 'Registro del hotel')}
                title={localized(lang, 'Operational staff', 'Personal operativo')}
                description={localized(lang, 'The current staff roster for this hotel is shown separately from access accounts.', 'El registro actual del hotel se muestra por separado de las cuentas de acceso.')}
              />
              {hotelRosterUnavailable ? (
                <EmptyState
                  icon={AlertTriangle}
                  compact
                  title={localized(lang, 'Hotel roster unavailable', 'Registro del hotel no disponible')}
                  description={localized(lang, 'Access records are still available. The roster will reconnect automatically.', 'Los registros de acceso siguen disponibles. El registro se volverá a conectar automáticamente.')}
                />
              ) : rosterFallback.length > 0 ? (
                <div className={styles.listCard} role="list">
                  {rosterFallback.map((member) => (
                    <div key={member.id} className={styles.personRow} role="listitem">
                      <Avatar name={member.name} />
                      <div className={styles.rowBody}>
                        <strong>{member.name}</strong>
                        <span>{titleCaseAccessValue(member.department ?? 'team member')}</span>
                      </div>
                      <span className={`${styles.status} ${member.isActive === false ? styles.statusMuted : styles.statusActive}`}>
                        {member.isActive === false ? localized(lang, 'Inactive', 'Inactivo') : localized(lang, 'Team', 'Equipo')}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={Users}
                  compact
                  title={localized(lang, 'No hotel staff match', 'Ningún empleado del hotel coincide')}
                  description={localized(lang, 'Try another search or clear the status filter.', 'Prueba otra búsqueda o borra el filtro de estado.')}
                />
              )}
            </section>
          ) : visibleMemberships.length === 0 && visibleInvitations.length === 0 ? (
            <EmptyState
              icon={Users}
              title={localized(lang, 'No pending invitations', 'No hay invitaciones pendientes')}
              description={localized(lang, 'Try another search or clear the invited filter.', 'Prueba otra búsqueda o borra el filtro de invitados.')}
            />
          ) : null}
        </>
      ) : visibleMemberships.length > 0 ? (
        <div className={styles.listCard} role="list">
          {visibleMemberships.map((membership) => (
            <MembershipRow
              key={membership.id}
              membership={membership}
              organization={data.organizations.find((item) => item.id === membership.organizationId) ?? null}
              isCurrentUser={membership.accountId === currentAccountId || Boolean(membership.isCurrentUser)}
              lang={lang}
              onLifecycleAction={onLifecycleAction}
            />
          ))}
        </div>
      ) : rosterFallback.length > 0 ? (
        <div className={styles.listCard} role="list">
          {rosterFallback.map((member) => (
            <div key={member.id} className={styles.personRow} role="listitem">
              <Avatar name={member.name} />
              <div className={styles.rowBody}>
                <strong>{member.name}</strong>
                <span>{titleCaseAccessValue(member.department ?? 'team member')}</span>
              </div>
              <span className={`${styles.status} ${member.isActive === false ? styles.statusMuted : styles.statusActive}`}>
                {member.isActive === false ? localized(lang, 'Inactive', 'Inactivo') : localized(lang, 'Team', 'Equipo')}
              </span>
            </div>
          ))}
        </div>
      ) : visibleInvitations.length === 0 ? (
        <EmptyState
          icon={Users}
          title={statusFilter === 'invited'
            ? localized(lang, 'No pending invitations', 'No hay invitaciones pendientes')
            : localized(lang, 'No people to show', 'No hay personas para mostrar')}
          description={statusFilter === 'invited'
            ? localized(lang, 'Try another search or clear the invited filter.', 'Prueba otra búsqueda o borra el filtro de invitados.')
            : localized(lang, 'Try another search or ask a manager about team visibility.', 'Prueba otra búsqueda o consulta con un gerente sobre la visibilidad del equipo.')}
        />
      ) : null}

      {visibleInvitations.length > 0 ? (
        <section className={styles.sectionBlock}>
          <SectionHeading
            eyebrow={localized(lang, 'Invitations', 'Invitaciones')}
            title={localized(lang, 'Invitations', 'Invitaciones')}
            description={localized(lang, 'Invitations stay email-specific and expire automatically.', 'Las invitaciones son específicas para cada correo y vencen automáticamente.')}
          />
          <div className={styles.listCard} role="list">
            {visibleInvitations.map((invitation) => <InvitationRow key={invitation.id} invitation={invitation} lang={lang} onLifecycleAction={onLifecycleAction} />)}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function AccessPanel({ data, lang, onViewReceipt, onRequestAccess, onReviewRequest, onLifecycleAction, canOpenLegacyRoleSettings }: {
  data: CompanyAccessData;
  lang: string;
  onViewReceipt: (receipt: EffectiveAccessReceipt) => void;
  onRequestAccess: () => void;
  onReviewRequest: (request: CompanyAccessRequest) => void;
  onLifecycleAction: (action: CompanyLifecycleAction) => void;
  canOpenLegacyRoleSettings: boolean;
}) {
  const adminPreview = data.viewerContext?.kind === 'staxis_admin_preview';
  const customerAccessGrants = adminPreview
    ? data.memberships.flatMap((membership) => membership.grants.map((grant) => ({ membership, grant })))
    : [];
  return (
    <div className={styles.stack}>
      <div className={styles.headingWithAction}>
        <SectionHeading
          eyebrow={adminPreview
            ? localized(lang, 'Access records', 'Registros de acceso')
            : localized(lang, 'Effective access', 'Acceso efectivo')}
          title={adminPreview
            ? localized(lang, 'Customer access records', 'Registros de acceso del cliente')
            : localized(lang, 'What you can reach—and why', 'A qué puedes acceder y por qué')}
          description={adminPreview
            ? localized(lang, 'Review this scope without changing customer access.', 'Revisa este alcance sin cambiar el acceso del cliente.')
            : localized(
                lang,
                'Job titles are descriptive. Access profiles and scope are what authorize your account.',
                'Los cargos son descriptivos. Los perfiles y el alcance de acceso son los que autorizan tu cuenta.',
              )}
        />
        {!adminPreview ? <div className={styles.headingActions}>
          {data.permissions.requestAccess ? (
            <button type="button" className={styles.primaryButton} onClick={onRequestAccess}>
              <KeyRound size={16} aria-hidden="true" />
              {localized(lang, 'Request access', 'Solicitar acceso')}
            </button>
          ) : null}
          {data.permissions.manageAccess && canOpenLegacyRoleSettings ? (
            <Link href="/settings/users" className={styles.secondaryButton}>
              <ShieldCheck size={16} aria-hidden="true" />
              {localized(lang, 'Manage hotel roles', 'Gestionar roles del hotel')}
            </Link>
          ) : !data.permissions.manageAccess ? (
            <button type="button" className={styles.secondaryButton} disabled title={localized(lang, 'A company administrator manages access.', 'Un administrador de empresa gestiona el acceso.')}>
              <ShieldCheck size={16} aria-hidden="true" />
              {localized(lang, 'Access is managed', 'El acceso es administrado')}
            </button>
          ) : null}
        </div> : null}
      </div>

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
                    ? ` · ${localized(lang, 'Expires', 'Vence')} ${formatDate(grant.expiresAt, lang)}`
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
              ? localized(lang, 'No customer access records found', 'No se encontraron registros de acceso del cliente')
              : localized(lang, 'No access grants found', 'No se encontraron concesiones de acceso')}
            description={adminPreview
              ? localized(lang, 'There are no customer grant records in this preview scope.', 'No hay registros de concesiones del cliente dentro de este alcance de vista previa.')
              : localized(lang, 'Your administrator can review the account and hotel assignment.', 'Tu administrador puede revisar la cuenta y la asignación del hotel.')}
          />
      )}

      {data.permissions.viewAccess && (data.requests.length > 0 || data.invitations.length > 0) ? (
        <section className={styles.sectionBlock}>
          <SectionHeading
            eyebrow={localized(lang, 'Open work', 'Trabajo pendiente')}
            title={localized(lang, 'Requests and invitations', 'Solicitudes e invitaciones')}
            description={localized(lang, 'Pending access never counts as active access.', 'El acceso pendiente nunca cuenta como acceso activo.')}
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
                      {localized(lang, 'Review', 'Revisar')}
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {data.invitations.map((invitation) => <InvitationRow key={invitation.id} invitation={invitation} lang={lang} onLifecycleAction={onLifecycleAction} />)}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ActivityPanel({ events, properties, lang }: {
  events: CompanyActivityEvent[];
  properties: CompanyProperty[];
  lang: string;
}) {
  return (
    <div className={styles.stack}>
      <SectionHeading
        eyebrow={localized(lang, 'Access history', 'Historial de acceso')}
        title={localized(lang, 'Recent company activity', 'Actividad reciente de la empresa')}
        description={localized(lang, 'Security-relevant access changes appear in chronological order.', 'Los cambios de acceso relacionados con la seguridad aparecen en orden cronológico.')}
      />
      {events.length > 0 ? (
        <ol className={styles.timeline}>
          {events.map((event) => {
            const property = properties.find((item) => item.id === event.propertyId);
            return (
              <li key={event.id}>
                <span className={styles.timelineDot} aria-hidden="true"><Check size={12} /></span>
                <div>
                  <strong>{event.summary}</strong>
                  <p>{event.actorName}{property ? ` · ${property.name}` : ''}</p>
                  <time dateTime={event.createdAt}>{formatDate(event.createdAt, lang)}</time>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <EmptyState
          icon={Activity}
          title={localized(lang, 'No access activity yet', 'Aún no hay actividad de acceso')}
          description={localized(lang, 'New invitations, grants, and scope changes will appear here.', 'Las nuevas invitaciones, concesiones y cambios de alcance aparecerán aquí.')}
        />
      )}
    </div>
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
  const independent = data.properties.filter((property) => !property.organizationId || !groupedOrganizationIds.has(property.organizationId));
  const organizationRows = typeof limit === 'number' ? realOrganizations.slice(0, limit) : realOrganizations;

  if (data.properties.length === 0) {
    return (
      <EmptyState
        icon={Hotel}
        compact
        title={localized(lang, 'No hotels assigned', 'No hay hoteles asignados')}
        description={localized(lang, 'Hotels will appear after an access grant becomes active.', 'Los hoteles aparecerán cuando una concesión de acceso se active.')}
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

      {independent.length > 0 ? (
        <section className={styles.independentGroup}>
          <div className={styles.groupHeader}>
            <span className={styles.groupIcon}><Hotel size={18} aria-hidden="true" /></span>
            <div>
              <strong>{localized(lang, 'Independent hotel access', 'Acceso a hoteles independientes')}</strong>
              <span>{localized(lang, 'Hotels not grouped under a management company', 'Hoteles no agrupados bajo una empresa de gestión')}</span>
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
          <span>{titleCaseAccessValue(organization.type)} · {properties.length} {properties.length === 1 ? localized(lang, 'hotel', 'hotel') : localized(lang, 'hotels', 'hoteles')}</span>
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
                <span>{localized(lang, 'Other hotels', 'Otros hoteles')}</span>
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
          <span className={styles.receiptEyebrow}>{localized(lang, 'Access profile', 'Perfil de acceso')}</span>
          <h3>{titleCaseAccessValue(receipt.accessProfile)}</h3>
        </div>
        <span className={`${styles.status} ${statusClass(receipt.status)}`}>{statusLabel(receipt.status, lang)}</span>
      </div>
      {receipt.jobTitle ? (
        <div className={styles.jobLine}>
          <BriefcaseBusiness size={15} aria-hidden="true" />
          <span>{receipt.jobTitle}</span>
          <small>{localized(lang, 'Job title', 'Cargo')}</small>
        </div>
      ) : null}
      <dl className={styles.receiptFacts}>
        <div>
          <dt>{localized(lang, 'Scope', 'Alcance')}</dt>
          <dd>{receipt.scopeLabel}</dd>
        </div>
        <div>
          <dt>{localized(lang, 'Hotels', 'Hoteles')}</dt>
          <dd>{hotelNames.length || receipt.propertyIds.length}</dd>
        </div>
        <div>
          <dt>{localized(lang, 'Expires', 'Vence')}</dt>
          <dd>{formatDate(receipt.expiresAt, lang)}</dd>
        </div>
      </dl>
      {hotelNames.length > 0 ? (
        <div className={styles.hotelChips} aria-label={localized(lang, 'Hotels in this scope', 'Hoteles dentro de este alcance')}>
          {hotelNames.slice(0, 3).map((name) => <span key={name}>{name}</span>)}
          {hotelNames.length > 3 ? <span>+{hotelNames.length - 3}</span> : null}
        </div>
      ) : null}
      <button type="button" className={styles.receiptAction} onClick={onView}>
        <CircleHelp size={15} aria-hidden="true" />
        {localized(lang, 'Why I have access', 'Por qué tengo acceso')}
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
      <button type="button" className={styles.dialogScrim} aria-label={localized(lang, 'Close access preview', 'Cerrar vista previa de acceso')} onClick={onClose} />
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
            <span>{localized(lang, 'Access preview', 'Vista previa de acceso')}</span>
            <h2 id="access-preview-title">{titleCaseAccessValue(receipt.accessProfile)}</h2>
          </div>
          <button ref={closeRef} type="button" className={styles.iconButton} onClick={onClose} aria-label={localized(lang, 'Close', 'Cerrar')}>
            <X size={17} aria-hidden="true" />
          </button>
        </div>
        <p id="access-preview-description" className={styles.dialogIntro}>
          {localized(
            lang,
            'This receipt explains the effective access Staxis calculated for your account. Viewing it does not change anything.',
            'Este recibo explica el acceso efectivo que Staxis calculó para tu cuenta. Verlo no cambia nada.',
          )}
        </p>
        <dl className={styles.dialogFacts}>
          <div><dt>{localized(lang, 'Company', 'Empresa')}</dt><dd>{organization?.name ?? localized(lang, 'Hotel-level access', 'Acceso a nivel de hotel')}</dd></div>
          <div><dt>{localized(lang, 'Access profile', 'Perfil de acceso')}</dt><dd>{titleCaseAccessValue(receipt.accessProfile)}</dd></div>
          <div><dt>{localized(lang, 'Scope', 'Alcance')}</dt><dd>{receipt.scopeLabel}</dd></div>
          <div><dt>{localized(lang, 'Source', 'Origen')}</dt><dd>{titleCaseAccessValue(receipt.source)}</dd></div>
          <div><dt>{localized(lang, 'Granted by', 'Concedido por')}</dt><dd>{receipt.grantedBy || localized(lang, 'System record', 'Registro del sistema')}</dd></div>
          <div><dt>{localized(lang, 'Expiration', 'Vencimiento')}</dt><dd>{formatDate(receipt.expiresAt, lang)}</dd></div>
        </dl>
        {receipt.reason ? (
          <div className={styles.reasonBox}>
            <strong>{localized(lang, 'Reason', 'Motivo')}</strong>
            <span>{receipt.reason}</span>
          </div>
        ) : null}
        <div className={styles.dialogPropertyBlock}>
          <div className={styles.dialogPropertyHeading}>
            <span>{localized(lang, 'Hotels included', 'Hoteles incluidos')}</span>
            <small>{scopedProperties.length || receipt.propertyIds.length}</small>
          </div>
          {scopedProperties.length > 0 ? (
            <ul>
              {scopedProperties.map((property) => (
                <li key={property.id}><Hotel size={15} aria-hidden="true" /><span>{property.name}</span><CheckCircle2 size={15} aria-hidden="true" /></li>
              ))}
            </ul>
          ) : (
            <p>{localized(lang, 'No current hotels are attached to this scope.', 'No hay hoteles actuales vinculados a este alcance.')}</p>
          )}
        </div>
        <div className={styles.dialogFooter}>
          <span><ShieldCheck size={14} aria-hidden="true" />{localized(lang, 'Read-only preview', 'Vista previa de solo lectura')}</span>
          <button type="button" className={styles.primaryButton} onClick={onClose}>{localized(lang, 'Done', 'Listo')}</button>
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
          <button type="button" onClick={() => onQueryChange('')} aria-label={localized(lang, 'Clear search', 'Borrar búsqueda')}>
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </label>
      <div className={styles.filterChips} role="group" aria-label={localized(lang, 'Filter by status', 'Filtrar por estado')}>
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

function MembershipRow({ membership, organization, isCurrentUser, lang, onLifecycleAction }: {
  membership: CompanyMembership;
  organization: CompanyOrganization | null;
  isCurrentUser: boolean;
  lang: string;
  onLifecycleAction: (action: CompanyLifecycleAction) => void;
}) {
  const revocableGrants = (membership.grants ?? []).filter((grant) => grant.canRevoke);
  const hasActions = revocableGrants.length > 0 || membership.canSuspend || membership.canResume || membership.canRemove;
  return (
    <div className={styles.personRow} role="listitem">
      <Avatar name={membership.displayName} />
      <div className={styles.rowBody}>
        <strong>
          {membership.displayName}
          {isCurrentUser ? <small>{localized(lang, 'You', 'Tú')}</small> : null}
        </strong>
        <span>
          {membership.jobTitle || titleCaseAccessValue(membership.accessProfile ?? 'team member')}
          {organization ? ` · ${organization.name}` : ''}
        </span>
      </div>
      <div className={styles.personRowActions}>
        <span className={`${styles.status} ${statusClass(membership.status)}`}>{statusLabel(membership.status, lang)}</span>
        {hasActions ? (
          <details className={styles.actionMenu}>
            <summary>{localized(lang, 'Manage', 'Gestionar')}</summary>
            <div>
              {revocableGrants.length > 0 ? <small>{localized(lang, 'Access grants', 'Concesiones de acceso')}</small> : null}
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
                  {localized(lang, 'Revoke', 'Revocar')} {titleCaseAccessValue(grant.accessProfile)}
                </button>
              ))}
              {(membership.canSuspend || membership.canResume || membership.canRemove) && revocableGrants.length > 0 ? <hr /> : null}
              {membership.canSuspend ? (
                <button type="button" onClick={() => onLifecycleAction({
                  kind: 'suspend_membership',
                  id: membership.id,
                  targetLabel: membership.displayName,
                  detailLabel: organization?.name ?? localized(lang, 'Company membership', 'Membresía de empresa'),
                })}>{localized(lang, 'Suspend member', 'Suspender miembro')}</button>
              ) : null}
              {membership.canResume ? (
                <button type="button" onClick={() => onLifecycleAction({
                  kind: 'resume_membership',
                  id: membership.id,
                  targetLabel: membership.displayName,
                  detailLabel: organization?.name ?? localized(lang, 'Company membership', 'Membresía de empresa'),
                })}>{localized(lang, 'Resume member', 'Reactivar miembro')}</button>
              ) : null}
              {membership.canRemove ? (
                <button type="button" className={styles.menuDanger} onClick={() => onLifecycleAction({
                  kind: 'remove_membership',
                  id: membership.id,
                  targetLabel: membership.displayName,
                  detailLabel: organization?.name ?? localized(lang, 'Company membership', 'Membresía de empresa'),
                })}>{localized(lang, 'Remove member', 'Eliminar miembro')}</button>
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
          })}>{localized(lang, 'Cancel', 'Cancelar')}</button>
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
      aria-label={localized(lang, 'Loading company access', 'Cargando el acceso de la empresa')}
    >
      <div className={styles.skeletonGrid} aria-hidden="true">
        {[0, 1, 2].map((key) => <div key={key} className={styles.skeletonCard}><span /><strong /><small /></div>)}
      </div>
      <div className={styles.skeletonPanel} aria-hidden="true"><span /><strong /><small /><div /></div>
    </div>
  );
}
