'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Building2,
  Check,
  CircleMinus,
  Hotel,
  Info,
  KeyRound,
  Lock,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react';

import { fetchWithAuth } from '@/lib/api-fetch';
import {
  ACCESS_PROFILES,
  ACCESS_PROFILE_CAPABILITIES,
  ORGANIZATION_CAPABILITIES,
  type AccessProfile,
  type OrganizationCapability,
} from '@/lib/organization-access/domain';
import { COMPANY_SCOPE_ROLES } from '@/lib/company/roles';

import styles from '../../AccessModal.module.css';

type AccessMode = 'organization' | 'hotel';
type Requester = typeof fetchWithAuth;

interface HotelLite {
  id: string;
  name: string | null;
}

interface CapMeta {
  key: string;
  adminOnly: boolean;
  live: boolean;
  managerFloor?: boolean;
  group: string;
  label_en: string;
  desc_en: string;
}

interface GroupMeta {
  key: string;
  label_en: string;
}

type OverrideMap = Record<string, Record<string, boolean>>;

interface Matrix {
  hotelRoles: string[];
  groups: GroupMeta[];
  capabilities: CapMeta[];
  overrides: OverrideMap;
}

interface AdminOrganization {
  id: string;
  name: string;
  type: string;
  status: string;
  hotelCount: number;
  warnings: string[];
}

interface OrganizationDirectory {
  organizations: AdminOrganization[];
  schemaReady: boolean;
}

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: string | { message?: string; error?: string };
}

const MODE_TABS: ReadonlyArray<{ id: AccessMode; label: string }> = [
  { id: 'organization', label: 'Organization' },
  { id: 'hotel', label: 'Hotel' },
];

const MANAGER_FLOOR_ROLES = new Set(['owner', 'general_manager']);

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  general_manager: 'GM',
  front_desk: 'Front desk',
  housekeeping: 'Housekeeping',
  maintenance: 'Maintenance',
};

const COMPANY_ROLE_LABELS: Record<(typeof COMPANY_SCOPE_ROLES)[number], string> = {
  owner: 'Owner',
  regional_manager: 'Regional Manager',
};

const PROFILE_LABELS: Record<AccessProfile, string> = {
  organization_owner: 'Organization owner',
  organization_admin: 'Organization administrator',
  portfolio_manager: 'Portfolio manager',
  property_manager: 'Property manager',
  department_lead: 'Department lead',
  contributor: 'Contributor',
  viewer: 'Viewer',
  external_collaborator: 'External collaborator',
};

const ORGANIZATION_CAPABILITY_GROUPS: ReadonlyArray<{
  label: string;
  capabilities: readonly OrganizationCapability[];
}> = [
  {
    label: 'Visibility',
    capabilities: [
      'view_company',
      'view_properties',
      'portfolio_intelligence_read',
      'view_people',
      'view_access',
      'view_activity',
    ],
  },
  {
    label: 'Management',
    capabilities: [
      'manage_people',
      'manage_access',
      'manage_portfolios',
      'manage_properties',
      'manage_company',
    ],
  },
  {
    label: 'Ownership',
    capabilities: ['manage_billing', 'transfer_ownership'],
  },
];

const ORGANIZATION_CAPABILITY_COPY: Record<OrganizationCapability, { label: string; description: string }> = {
  view_company: { label: 'View company', description: 'Company identity and structure' },
  view_properties: { label: 'View hotels', description: 'Hotels inside the authorized scope' },
  portfolio_intelligence_read: { label: 'Portfolio intelligence', description: 'Portfolio and regional operational insights' },
  view_people: { label: 'View people', description: 'Company people directory' },
  view_access: { label: 'View access', description: 'Existing access grants and receipts' },
  view_activity: { label: 'View activity', description: 'Company access activity and audit context' },
  manage_people: { label: 'Manage people', description: 'Company membership lifecycle' },
  manage_access: { label: 'Manage access', description: 'Delegate authorized profiles and exact scopes' },
  manage_portfolios: { label: 'Manage portfolios', description: 'Portfolio, region, and division structure' },
  manage_properties: { label: 'Manage hotels', description: 'Company hotel relationships' },
  manage_company: { label: 'Manage company', description: 'Company-level settings' },
  manage_billing: { label: 'Manage billing', description: 'Company billing authority' },
  transfer_ownership: { label: 'Transfer ownership', description: 'Protected organization ownership transfer' },
};

function responseError<T>(payload: Envelope<T>, fallback: string): string {
  if (typeof payload.error === 'string') return payload.error;
  if (payload.error && typeof payload.error.message === 'string') return payload.error.message;
  if (payload.error && typeof payload.error.error === 'string') return payload.error.error;
  return fallback;
}

function profileScopeLabel(profile: AccessProfile): string {
  if (profile === 'organization_owner' || profile === 'organization_admin') return 'Company';
  if (profile === 'portfolio_manager') return 'Portfolio / region';
  if (profile === 'property_manager') return 'Property';
  return 'Authorized scope';
}

function countRestrictions(overrides: OverrideMap): number {
  return Object.values(overrides).reduce(
    (total, roles) => total + Object.values(roles).filter((allowed) => allowed === false).length,
    0,
  );
}

export function AccessSurface({
  onClose,
  closeButtonRef,
  request = fetchWithAuth,
}: {
  onClose: () => void;
  closeButtonRef: React.RefObject<HTMLButtonElement | null>;
  request?: Requester;
}) {
  const [mode, setMode] = useState<AccessMode>('hotel');
  const bodyRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const [hotels, setHotels] = useState<HotelLite[] | null>(null);
  const [hotelId, setHotelId] = useState<string | null>(null);
  const [hotelDirectoryError, setHotelDirectoryError] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixError, setMatrixError] = useState<string | null>(null);

  const [organizationDirectory, setOrganizationDirectory] = useState<OrganizationDirectory | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [organizationError, setOrganizationError] = useState<string | null>(null);

  const changeMode = useCallback((next: AccessMode) => {
    setMode(next);
    bodyRef.current?.scrollTo({ top: 0, left: 0 });
  }, []);

  const loadHotels = useCallback(async () => {
    setHotels(null);
    setHotelDirectoryError(null);
    try {
      const response = await request('/api/admin/list-properties?pageSize=200&status=all');
      const payload = await response.json().catch(() => ({})) as Envelope<{ properties?: HotelLite[] }>;
      if (!response.ok || payload.ok !== true || !payload.data) {
        throw new Error(responseError(payload, 'Hotels could not be loaded.'));
      }
      const list = (payload.data.properties ?? []).map((hotel) => ({ id: hotel.id, name: hotel.name }));
      setHotels(list);
      setHotelId((current) => (
        current && list.some((hotel) => hotel.id === current) ? current : list[0]?.id ?? null
      ));
    } catch (caught) {
      setHotelDirectoryError(caught instanceof Error ? caught.message : 'Hotels could not be loaded.');
      setHotels([]);
      setHotelId(null);
    }
  }, [request]);

  const loadMatrix = useCallback(async (propertyId: string) => {
    setMatrixLoading(true);
    setMatrixError(null);
    setMatrix(null);
    try {
      const response = await request(`/api/admin/access/matrix?propertyId=${encodeURIComponent(propertyId)}`);
      const payload = await response.json().catch(() => ({})) as Envelope<Matrix>;
      if (!response.ok || payload.ok !== true || !payload.data) {
        throw new Error(responseError(payload, 'Access settings could not be loaded.'));
      }
      setMatrix(payload.data);
    } catch (caught) {
      setMatrixError(caught instanceof Error ? caught.message : 'Access settings could not be loaded.');
    } finally {
      setMatrixLoading(false);
    }
  }, [request]);

  const loadOrganizations = useCallback(async () => {
    setOrganizationDirectory(null);
    setOrganizationError(null);
    try {
      const response = await request('/api/admin/organizations');
      const payload = await response.json().catch(() => ({})) as Envelope<OrganizationDirectory>;
      if (!response.ok || payload.ok !== true || !payload.data) {
        throw new Error(responseError(payload, 'Organizations could not be loaded.'));
      }
      setOrganizationDirectory(payload.data);
      setOrganizationId((current) => (
        current && payload.data?.organizations.some((organization) => organization.id === current)
          ? current
          : payload.data?.organizations[0]?.id ?? null
      ));
    } catch (caught) {
      setOrganizationError(caught instanceof Error ? caught.message : 'Organizations could not be loaded.');
      setOrganizationDirectory({ organizations: [], schemaReady: true });
      setOrganizationId(null);
    }
  }, [request]);

  useEffect(() => { void loadHotels(); }, [loadHotels]);
  useEffect(() => { if (hotelId) void loadMatrix(hotelId); else setMatrix(null); }, [hotelId, loadMatrix]);
  useEffect(() => {
    if (mode === 'organization' && organizationDirectory === null && organizationError === null) {
      void loadOrganizations();
    }
  }, [loadOrganizations, mode, organizationDirectory, organizationError]);

  const organizations = organizationDirectory?.organizations ?? [];
  const selectedOrganization = organizations.find((organization) => organization.id === organizationId) ?? null;

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? MODE_TABS.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + MODE_TABS.length) % MODE_TABS.length;
    changeMode(MODE_TABS[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <>
      <header className={styles.header} data-access-modal-header>
        <div className={styles.titleRow}>
          <span className={styles.titleIcon}><KeyRound size={21} aria-hidden="true" /></span>
          <div>
            <span className={styles.eyebrow}>Admin · Access control</span>
            <h2 id="access-modal-title" className={styles.title}>Access</h2>
            <p id="access-modal-description" className={styles.description}>
              Review organization policy and configure each hotel’s existing role capabilities from one contained workspace.
            </p>
          </div>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          className={styles.closeButton}
          onClick={onClose}
          aria-label="Close access settings"
        >
          <X size={17} aria-hidden="true" />
          <span>Close</span>
        </button>

        <div className={styles.controls}>
          <div className={styles.tabs} role="tablist" aria-label="Access scope mode">
            {MODE_TABS.map((tab, index) => {
              const selected = mode === tab.id;
              return (
                <button
                  key={tab.id}
                  ref={(element) => { tabRefs.current[index] = element; }}
                  id={`access-mode-${tab.id}`}
                  type="button"
                  className={styles.tab}
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`access-panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => changeMode(tab.id)}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                >
                  {tab.id === 'organization'
                    ? <Building2 size={16} aria-hidden="true" />
                    : <Hotel size={16} aria-hidden="true" />}
                  {tab.label}
                </button>
              );
            })}
          </div>

          {mode === 'hotel' ? (
            <label className={styles.scopeField}>
              <span>Hotel</span>
              <select
                className={styles.select}
                value={hotelId ?? ''}
                onChange={(event) => {
                  setHotelId(event.target.value || null);
                  bodyRef.current?.scrollTo({ top: 0, left: 0 });
                }}
                disabled={hotels === null || hotels.length === 0}
                aria-label="Hotel access scope"
              >
                {hotels === null ? <option value="">Loading hotels…</option> : null}
                {hotels?.length === 0 ? <option value="">No hotels available</option> : null}
                {(hotels ?? []).map((hotel) => (
                  <option key={hotel.id} value={hotel.id}>{hotel.name || `Hotel ${hotel.id.slice(0, 8)}`}</option>
                ))}
              </select>
            </label>
          ) : (
            <label className={styles.scopeField}>
              <span>Management organization</span>
              <select
                className={styles.select}
                value={organizationId ?? ''}
                onChange={(event) => {
                  setOrganizationId(event.target.value || null);
                  bodyRef.current?.scrollTo({ top: 0, left: 0 });
                }}
                disabled={organizationDirectory === null || organizations.length === 0}
                aria-label="Organization access scope"
              >
                {organizationDirectory === null ? <option value="">Loading organizations…</option> : null}
                {organizationDirectory && organizations.length === 0 ? <option value="">No organizations available</option> : null}
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>{organization.name}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      </header>

      <div ref={bodyRef} className={styles.body} data-access-modal-scroll>
        {mode === 'hotel' ? (
          <section
            id="access-panel-hotel"
            className={styles.panel}
            role="tabpanel"
            aria-labelledby="access-mode-hotel"
            tabIndex={0}
          >
            <HotelAccessPanel
              hotelId={hotelId}
              hotels={hotels}
              directoryError={hotelDirectoryError}
              matrix={matrix}
              loading={matrixLoading}
              matrixError={matrixError}
              request={request}
              onRetryHotels={() => void loadHotels()}
              onRetryMatrix={() => { if (hotelId) void loadMatrix(hotelId); }}
              onReloadMatrix={loadMatrix}
            />
          </section>
        ) : (
          <section
            id="access-panel-organization"
            className={styles.panel}
            role="tabpanel"
            aria-labelledby="access-mode-organization"
            tabIndex={0}
          >
            <OrganizationAccessPanel
              organization={selectedOrganization}
              directory={organizationDirectory}
              error={organizationError}
              onRetry={() => void loadOrganizations()}
            />
          </section>
        )}
      </div>
    </>
  );
}

function OrganizationAccessPanel({
  organization,
  directory,
  error,
  onRetry,
}: {
  organization: AdminOrganization | null;
  directory: OrganizationDirectory | null;
  error: string | null;
  onRetry: () => void;
}) {
  if (directory === null && !error) {
    return <LoadingState label="Loading organization access policy…" />;
  }
  if (error) {
    return <ErrorState message={error} onRetry={onRetry} />;
  }
  if (!directory?.schemaReady) {
    return (
      <div className={styles.notice} role="status">
        <Info size={17} aria-hidden="true" />
        Organization access is still being prepared. Hotel access remains available in Hotel mode.
      </div>
    );
  }
  if (!organization) {
    return (
      <div className={styles.message} role="status">
        No management organizations are available.
      </div>
    );
  }

  return (
    <>
      <div className={styles.panelHeading}>
        <div>
          <span className={styles.sectionLabel}>Organization policy · {organization.name}</span>
          <h3>Roles, scopes, and capabilities</h3>
          <p>
            These are the current authoritative organization access profiles. The policy is fixed by the existing permission system; it is not a configurable template.
          </p>
        </div>
        <span className={styles.count} aria-label={`${ORGANIZATION_CAPABILITIES.length} fixed organization capabilities across ${ACCESS_PROFILES.length} access profiles`}>
          {ORGANIZATION_CAPABILITIES.length} fixed capabilities · {ACCESS_PROFILES.length} profiles
        </span>
      </div>

      {organization.status !== 'active' ? (
        <div className={styles.notice} role="status">
          <Info size={17} aria-hidden="true" />
          {organization.name} is {organization.status.replaceAll('_', ' ')}. Its policy remains visible, but access operations stay disabled.
        </div>
      ) : null}

      <div className={styles.roleSummary} aria-label="Existing company roles and scopes">
        {COMPANY_SCOPE_ROLES.map((role) => (
          <span key={role} className={styles.companyRoleChip}>
            {COMPANY_ROLE_LABELS[role]} <small>· Company scope</small>
          </span>
        ))}
        <span className={styles.companyRoleChip}>Portfolio manager <small>· Portfolio / region</small></span>
        <span className={styles.companyRoleChip}>Property manager <small>· Selected hotels</small></span>
      </div>

      <div className={styles.notice} role="note">
        <Lock size={17} aria-hidden="true" />
        <span>
          Platform Admin can inspect this policy but cannot rewrite company access templates or act as a company member. Authorized company leaders assign existing profiles and exact scopes through the current Company Hub preview-and-confirm flow, where authorization is rechecked at commit.
        </span>
      </div>

      <div className={styles.matrixKey} aria-label="Organization matrix legend">
        <span><i className={styles.allowedMark}><Check size={14} aria-hidden="true" /></i> Included</span>
        <span><i className={styles.deniedMark}><CircleMinus size={13} aria-hidden="true" /></i> Not included</span>
        <span><i className={styles.fixedMark}><Lock size={14} aria-hidden="true" /></i> Fixed authoritative policy</span>
      </div>

      <div
        className={styles.matrixScroller}
        role="region"
        aria-label="Organization role and capability matrix"
        tabIndex={0}
      >
        <table className={`${styles.matrix} ${styles.organizationMatrix}`}>
          <thead>
            <tr>
              <th scope="col">Organization capability</th>
              {ACCESS_PROFILES.map((profile) => (
                <th key={profile} scope="col">
                  {PROFILE_LABELS[profile]}
                  <span className={styles.profileScope}>{profileScopeLabel(profile)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ORGANIZATION_CAPABILITY_GROUPS.flatMap((group) => [
              <tr key={`${group.label}-heading`} className={styles.groupRow}>
                <th colSpan={ACCESS_PROFILES.length + 1} scope="colgroup">{group.label}</th>
              </tr>,
              ...group.capabilities.map((capability) => {
                const copy = ORGANIZATION_CAPABILITY_COPY[capability];
                return (
                  <tr key={capability}>
                    <th className={styles.capabilityCell} scope="row">
                      {copy.label}
                      <small>{copy.description}</small>
                    </th>
                    {ACCESS_PROFILES.map((profile) => {
                      const included = ACCESS_PROFILE_CAPABILITIES[profile].includes(capability);
                      return (
                        <td key={profile} className={styles.cell}>
                          <span
                            className={included ? styles.allowedMark : styles.deniedMark}
                            aria-label={included ? 'Included' : 'Not included'}
                          >
                            {included
                              ? <Check size={15} aria-hidden="true" />
                              : <CircleMinus size={13} aria-hidden="true" />}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              }),
            ])}
          </tbody>
        </table>
      </div>
      <p className={styles.statusText}>
        Scope availability is narrowed further per authorized leader, organization, portfolio or region, and hotel by the server projection.
      </p>
    </>
  );
}

function HotelAccessPanel({
  hotelId,
  hotels,
  directoryError,
  matrix,
  loading,
  matrixError,
  request,
  onRetryHotels,
  onRetryMatrix,
  onReloadMatrix,
}: {
  hotelId: string | null;
  hotels: HotelLite[] | null;
  directoryError: string | null;
  matrix: Matrix | null;
  loading: boolean;
  matrixError: string | null;
  request: Requester;
  onRetryHotels: () => void;
  onRetryMatrix: () => void;
  onReloadMatrix: (hotelId: string) => Promise<void>;
}) {
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyConfirmation, setApplyConfirmation] = useState(false);
  const [applyNote, setApplyNote] = useState<string | null>(null);
  const [optimisticMatrix, setOptimisticMatrix] = useState<Matrix | null>(matrix);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setOptimisticMatrix(matrix); }, [matrix]);
  useEffect(() => {
    setMutationError(null);
    setApplyConfirmation(false);
    setApplyNote(null);
  }, [hotelId]);
  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
  }, []);

  const activeMatrix = optimisticMatrix;
  const selectedHotel = hotels?.find((hotel) => hotel.id === hotelId) ?? null;
  const restrictionCount = activeMatrix ? countRestrictions(activeMatrix.overrides) : 0;
  const configurableCount = activeMatrix?.capabilities.filter((capability) => !capability.adminOnly && capability.live).length ?? 0;
  const adminOnlyCount = activeMatrix?.capabilities.filter((capability) => capability.adminOnly).length ?? 0;

  const setCell = async (capability: string, role: string, nextAllowed: boolean) => {
    if (!hotelId || !activeMatrix || savingKey) return;
    const key = `${capability}:${role}`;
    const serverSnapshot = activeMatrix;
    setOptimisticMatrix((current) => {
      if (!current) return current;
      const overrides: OverrideMap = Object.fromEntries(
        Object.entries(current.overrides ?? {}).map(([capabilityKey, roles]) => [capabilityKey, { ...roles }]),
      );
      if (nextAllowed) {
        if (overrides[capability]) {
          delete overrides[capability][role];
          if (Object.keys(overrides[capability]).length === 0) delete overrides[capability];
        }
      } else {
        overrides[capability] = overrides[capability] ?? {};
        overrides[capability][role] = false;
      }
      return { ...current, overrides };
    });
    setSavingKey(key);
    setSavedKey(null);
    setMutationError(null);
    setApplyNote(null);
    try {
      const response = await request('/api/admin/access/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: hotelId, capability, role, allowed: nextAllowed }),
      });
      const payload = await response.json().catch(() => ({})) as Envelope<unknown>;
      if (!response.ok || payload.ok !== true) {
        throw new Error(responseError(payload, 'The access change could not be saved.'));
      }
      setSavedKey(key);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSavedKey((current) => current === key ? null : current), 1600);
    } catch (caught) {
      setOptimisticMatrix(serverSnapshot);
      setMutationError(caught instanceof Error ? caught.message : 'The access change could not be saved.');
      await onReloadMatrix(hotelId);
    } finally {
      setSavingKey((current) => current === key ? null : current);
    }
  };

  const applyToAll = async (confirmClearAll: boolean) => {
    if (!hotelId || applying) return;
    setApplying(true);
    setMutationError(null);
    setApplyNote(null);
    try {
      const response = await request('/api/admin/access/apply-to-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: hotelId, ...(confirmClearAll ? { confirmClearAll: true } : {}) }),
      });
      const payload = await response.json().catch(() => ({})) as Envelope<{ hotelsUpdated?: number }>;
      if (!response.ok || payload.ok !== true || !payload.data) {
        throw new Error(responseError(payload, 'The hotel setup could not be applied.'));
      }
      const updated = payload.data.hotelsUpdated ?? 0;
      setApplyNote(`Applied this setup to ${updated} other ${updated === 1 ? 'hotel' : 'hotels'}.`);
      setApplyConfirmation(false);
    } catch (caught) {
      setMutationError(caught instanceof Error ? caught.message : 'The hotel setup could not be applied.');
    } finally {
      setApplying(false);
    }
  };

  if (hotels === null && !directoryError) return <LoadingState label="Loading hotels…" />;
  if (directoryError) return <ErrorState message={directoryError} onRetry={onRetryHotels} />;
  if (hotels?.length === 0 || !hotelId) {
    return <div className={styles.message} role="status">No hotels are available for access configuration.</div>;
  }
  if (loading || (!activeMatrix && !matrixError)) return <LoadingState label="Loading hotel access settings…" />;
  if (matrixError || !activeMatrix) {
    return <ErrorState message={matrixError ?? 'Access settings could not be loaded.'} onRetry={onRetryMatrix} />;
  }

  const isRestricted = (capability: string, role: string): boolean => (
    activeMatrix.overrides?.[capability]?.[role] === false
  );

  return (
    <>
      <div className={styles.panelHeading}>
        <div>
          <span className={styles.sectionLabel}>Hotel policy · {selectedHotel?.name || 'Selected hotel'}</span>
          <h3>Role capability overrides</h3>
          <p>
            Allowed means the role receives the authoritative default. Restricted is a hotel-specific override. Locked cells are enforced by server policy and cannot be changed here.
          </p>
        </div>
        <span className={styles.count} aria-label={`${configurableCount} configurable capabilities across ${activeMatrix.hotelRoles.length} hotel roles`}>
          {configurableCount} configurable capabilities · {activeMatrix.hotelRoles.length} roles
        </span>
      </div>

      {mutationError ? (
        <div className={styles.error} role="alert">
          <Info size={17} aria-hidden="true" />
          <span>{mutationError}</span>
        </div>
      ) : null}
      {applyNote ? (
        <div className={styles.success} role="status">
          <ShieldCheck size={17} aria-hidden="true" />
          <span>{applyNote}</span>
        </div>
      ) : null}

      <div className={styles.matrixKey} aria-label="Hotel override legend">
        <span><i className={styles.allowedMark}><Check size={14} aria-hidden="true" /></i> Allowed by default</span>
        <span><i className={styles.deniedMark}><CircleMinus size={13} aria-hidden="true" /></i> Restricted here</span>
        <span><i className={styles.fixedMark}><Lock size={14} aria-hidden="true" /></i> Fixed server policy</span>
        {adminOnlyCount > 0 ? <span>{adminOnlyCount} admin-only {adminOnlyCount === 1 ? 'control' : 'controls'}</span> : null}
      </div>

      <div
        className={styles.matrixScroller}
        role="region"
        aria-label="Hotel role and capability matrix"
        tabIndex={0}
      >
        <table className={styles.matrix}>
          <thead>
            <tr>
              <th scope="col">Capability</th>
              {activeMatrix.hotelRoles.map((role) => <th key={role} scope="col">{ROLE_LABELS[role] ?? role}</th>)}
            </tr>
          </thead>
          <tbody>
            {activeMatrix.groups.flatMap((group) => {
              const capabilities = activeMatrix.capabilities.filter((capability) => capability.group === group.key);
              if (capabilities.length === 0) return [];
              return [
                <tr key={`${group.key}-heading`} className={styles.groupRow}>
                  <th colSpan={activeMatrix.hotelRoles.length + 1} scope="colgroup">{group.label_en}</th>
                </tr>,
                ...capabilities.map((capability) => (
                  <HotelCapabilityRow
                    key={capability.key}
                    capability={capability}
                    roles={activeMatrix.hotelRoles}
                    isRestricted={isRestricted}
                    savingKey={savingKey}
                    savedKey={savedKey}
                    onToggle={(role, nextAllowed) => { void setCell(capability.key, role, nextAllowed); }}
                  />
                )),
              ];
            })}
          </tbody>
        </table>
      </div>

      <div className={styles.footerActions}>
        {restrictionCount === 0 && applyConfirmation ? (
          <>
            <div className={styles.notice} role="alert">
              <Info size={17} aria-hidden="true" />
              This hotel has no overrides. Confirming will clear hotel-specific restrictions on every other hotel.
            </div>
            <button
              type="button"
              className={styles.confirmButton}
              disabled={applying || savingKey !== null}
              onClick={() => void applyToAll(true)}
            >
              {applying ? <span className={styles.spinner} aria-hidden="true" /> : <RotateCcw size={16} aria-hidden="true" />}
              {applying ? 'Clearing restrictions…' : 'Confirm clear on other hotels'}
            </button>
            <button type="button" className={styles.actionButton} disabled={applying} onClick={() => setApplyConfirmation(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className={styles.actionButton}
            disabled={applying || savingKey !== null}
            onClick={() => {
              if (restrictionCount === 0) setApplyConfirmation(true);
              else void applyToAll(false);
            }}
          >
            {applying ? <span className={styles.spinner} aria-hidden="true" /> : <RotateCcw size={16} aria-hidden="true" />}
            {applying ? 'Applying…' : "Apply this hotel's setup to all hotels"}
          </button>
        )}
        <span className={styles.statusText} role="status" aria-live="polite">
          {savingKey ? 'Saving hotel access change…' : savedKey ? 'Hotel access change saved.' : ''}
        </span>
      </div>
    </>
  );
}

function HotelCapabilityRow({
  capability,
  roles,
  isRestricted,
  savingKey,
  savedKey,
  onToggle,
}: {
  capability: CapMeta;
  roles: string[];
  isRestricted: (capability: string, role: string) => boolean;
  savingKey: string | null;
  savedKey: string | null;
  onToggle: (role: string, nextAllowed: boolean) => void;
}) {
  if (capability.adminOnly) {
    return (
      <tr>
        <th className={styles.capabilityCell} scope="row">
          {capability.label_en}
          <small>{capability.desc_en}</small>
        </th>
        <td className={styles.fixedCell} colSpan={roles.length}>
          <Lock size={13} aria-hidden="true" />{' '}
          Staxis admin only. This control is fixed and never delegated to a hotel role.
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <th className={styles.capabilityCell} scope="row">
        {capability.label_en}
        <small>{capability.desc_en}</small>
      </th>
      {roles.map((role) => {
        const key = `${capability.key}:${role}`;
        const floorLocked = Boolean(capability.managerFloor) && !MANAGER_FLOOR_ROLES.has(role);
        const restricted = isRestricted(capability.key, role);
        const allowed = floorLocked ? false : !restricted;
        const saving = savingKey === key;
        const disabled = floorLocked || !capability.live || savingKey !== null;
        const label = floorLocked
          ? `${capability.label_en} is managers only and cannot be granted to ${ROLE_LABELS[role] ?? role}`
          : !capability.live
            ? `${capability.label_en} uses fixed manager defaults because runtime enforcement is not available`
            : `${capability.label_en} for ${ROLE_LABELS[role] ?? role}: ${allowed ? 'allowed by default' : 'restricted at this hotel'}`;
        return (
          <td key={role} className={styles.cell}>
            <button
              type="button"
              role="switch"
              aria-checked={allowed}
              aria-label={label}
              className={styles.switchButton}
              disabled={disabled}
              onClick={() => onToggle(role, restricted)}
              title={label}
            >
              <span className={styles.switchTrack} aria-hidden="true">
                <span className={styles.switchKnob}>
                  {savedKey === key && allowed ? <Check size={10} aria-hidden="true" /> : null}
                  {saving ? <span className={styles.srOnly}>Saving</span> : null}
                </span>
              </span>
            </button>
          </td>
        );
      })}
    </tr>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className={styles.message} role="status" aria-live="polite">
      <span className={styles.spinner} aria-hidden="true" />
      {label}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={styles.stateStack}>
      <div className={styles.error} role="alert">
        <Info size={17} aria-hidden="true" />
        <span>{message}</span>
      </div>
      <button type="button" className={styles.retryButton} onClick={onRetry}>Try again</button>
    </div>
  );
}
