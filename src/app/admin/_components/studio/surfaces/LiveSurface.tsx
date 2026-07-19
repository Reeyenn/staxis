'use client';

/* ───────────────────────────────────────────────────────────────────────
   SURFACE — Hotels · organization directory + independent fleet + feedback.

   This keeps the existing Admin Studio visual language and hotel operations,
   while giving each property one clear home in the directory:
     Organizations · Independent Hotels · Feedback Inbox

   Data (same endpoints, params, response shapes, debounce, filters,
   sort and pagination as the prior tab):
     • /api/admin/list-properties?page&pageSize → full fleet + hotel health
     • /api/admin/organizations              → grouping + organization counts
     • /api/admin/feedback                   → feedback inbox
   Mutation kept: PATCH /api/admin/feedback { id, status } —
     new → in_progress → resolved / wontfix, then refetch.

   Organization rows expand in place and their child hotels open the same
   operational detail modal as independent-hotel cards. Feedback is a distinct
   filtered view, so the fleet list is no longer competing for horizontal room.

   Sync-freshness color (handoff): not connected = dim; stale(>12h) =
   terracotta; >60m = gold-deep; else forest-deep.

   This is a DARK surface: <SurfaceShell glow="tealTL"> + DarkCard / dimWhite
   for cards, Backdrop + MODAL_CARD for the light detail modal.
   ─────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  FONT_SERIF, FONT_MONO, Caps, Pill, Dot, Btn, SerifNum,
  countUp, riseIn, freshLabel, age,
  type PillTone, type DotTone,
} from '../kit';
import {
  SurfaceShell, DarkCard, DarkSpinner, DarkEmpty, dimWhite, Backdrop, MODAL_CARD,
} from '../surface-kit';
import { CoveragePickerModal } from '../CoveragePickerModal';
import { SectionsModal } from '../SectionsModal';
import { AddHotelModal } from '../AddHotelModal';
import { AIControlCenter } from '../../AIControlCenter';
import { AccessPopover } from '../../AccessPopover';
import { TwoFactorSwitch } from '../../TwoFactorSwitch';
import { OrganizationLeaderInviteModal } from '../OrganizationLeaderInviteModal';
import { APP_SECTIONS, type AppSection } from '@/lib/sections/registry';
import { FLEET_STALE_SYNC_MINUTES } from '@/lib/admin-property-health';

const API_PAGE_SIZE = 200;
const MAX_API_PAGES = 100;
const INDEPENDENT_PAGE_SIZE = 18;

// ── Real API shapes (mirror the prior LiveHotelsTab interfaces) ──────────
interface PropertyRow {
  id: string;
  name: string | null;
  totalRooms: number | null;
  subscriptionStatus: string | null;
  pmsType: string | null;
  pmsConnected: boolean;
  lastSyncedAt: string | null;
  syncFreshnessMin: number | null;
  staffCount: number;
  createdAt: string;
  // Full resolved 8-key section on/off map (default-ON coalesced server-side).
  enabledSections: Record<AppSection, boolean>;
}
interface OrganizationHotel {
  id: string;
  name: string | null;
  status: string;
  relationshipType: string;
  isPrimary: boolean;
}
interface OrganizationSummary {
  id: string;
  name: string;
  type: string;
  status: string;
  hotelCount: number;
  userCount: number;
  warnings: string[];
  hotels: OrganizationHotel[];
}
interface IndependentHotelSummary {
  id: string;
  name: string | null;
  status: string;
}
interface OrganizationDirectory {
  organizations: OrganizationSummary[];
  independentHotels: IndependentHotelSummary[];
  independentIdsAuthoritative: boolean;
  schemaReady: boolean;
}
interface FeedbackItem {
  id: string;
  property_id: string | null;
  property_name: string | null;
  user_email: string | null;
  user_display_name: string | null;
  message: string;
  category: string;
  status: string;
  admin_note: string | null;
  resolved_at: string | null;
  created_at: string;
}
type StatusFilter = 'all' | 'active' | 'trial' | 'past_due' | 'stale' | 'pms_disconnected' | 'no_pms';
type HotelsView = 'organizations' | 'independent' | 'feedback';
type OrganizationStatusFilter = 'all' | 'active' | 'suspended' | 'inactive';
type FeedbackStatusFilter = 'all' | 'new' | 'in_progress' | 'resolved' | 'wontfix';

// A property enriched with the staleness flag (= prior tab's isStale12h).
type EnrichedRow = PropertyRow & { isStale12h: boolean };

// ── Shared derivations (mirror the prototype + prior tab semantics) ──────
function subTone(s: string | null): PillTone {
  return s === 'active' ? 'forest' : s === 'past_due' ? 'terracotta' : s === 'trial' ? 'gold' : 'neutral';
}
// Sync-freshness color per the handoff.
function syncColor(p: { pmsConnected: boolean; isStale12h: boolean; syncFreshnessMin: number | null }): string {
  if (!p.pmsConnected) return 'var(--dim)';
  if (p.isStale12h) return 'var(--terracotta)';
  if (p.syncFreshnessMin !== null && p.syncFreshnessMin > 60) return 'var(--gold-deep)';
  return 'var(--forest-deep)';
}
// Health-strip tone for a single hotel (matches LiveMap's per-card toneOf).
function cardTone(p: EnrichedRow): DotTone {
  // No system detected (pms_type IS NULL) → needs action. Check first.
  if (p.pmsType === null) return 'terracotta';
  if (p.subscriptionStatus === 'past_due' || p.isStale12h || !p.pmsConnected) return 'terracotta';
  if (p.subscriptionStatus === 'trial' || (p.pmsConnected && p.syncFreshnessMin !== null && p.syncFreshnessMin > 60)) return 'gold';
  return 'forest';
}

const STATUS_OPTS: [StatusFilter, string][] = [
  ['all', 'All statuses'], ['active', 'Active'], ['trial', 'Trial'], ['past_due', 'Past due'],
  ['stale', 'Stale (no PMS sync >12h)'], ['pms_disconnected', 'PMS disconnected'],
  ['no_pms', 'No system detected'],
];

const HOTEL_VIEWS: { id: HotelsView; label: string }[] = [
  { id: 'organizations', label: 'Organizations' },
  { id: 'independent', label: 'Independent Hotels' },
  { id: 'feedback', label: 'Feedback Inbox' },
];

const ORGANIZATION_STATUS_OPTS: [OrganizationStatusFilter, string][] = [
  ['all', 'All statuses'],
  ['active', 'Active'],
  ['suspended', 'Suspended'],
  ['inactive', 'Inactive'],
];

const FEEDBACK_STATUS_OPTS: [FeedbackStatusFilter, string][] = [
  ['all', 'All statuses'],
  ['new', 'New'],
  ['in_progress', 'In progress'],
  ['resolved', 'Resolved'],
  ['wontfix', "Won't fix"],
];

const ORGANIZATION_TYPES = [
  ['management_company', 'Management company'],
  ['ownership_group', 'Ownership group'],
  ['brand', 'Brand'],
  ['vendor', 'Vendor'],
  ['other', 'Other'],
] as const;

const RELATIONSHIP_TYPES = [
  ['operator', 'Operator'],
  ['owner', 'Owner'],
] as const;

const CAT: Record<string, string> = {
  bug: '◆ bug', feature_request: '✦ idea', general: '○ note', complaint: '▲ issue', love: '♥ love',
};
function fbTone(s: string): PillTone {
  return s === 'new' ? 'gold' : s === 'resolved' ? 'forest' : s === 'in_progress' ? 'teal' : 'neutral';
}

function normalizeOrganizationDirectory(value: unknown): OrganizationDirectory | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.organizations)) return null;

  const organizations = data.organizations.flatMap((candidate): OrganizationSummary[] => {
    if (!candidate || typeof candidate !== 'object') return [];
    const row = candidate as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.name !== 'string') return [];
    const rawHotels = Array.isArray(row.hotels)
      ? row.hotels
      : Array.isArray(row.properties)
        ? row.properties
        : [];
    const hotels = rawHotels.flatMap((hotelCandidate): OrganizationHotel[] => {
      if (!hotelCandidate || typeof hotelCandidate !== 'object') return [];
      const hotel = hotelCandidate as Record<string, unknown>;
      if (typeof hotel.id !== 'string') return [];
      return [{
        id: hotel.id,
        name: typeof hotel.name === 'string' ? hotel.name : null,
        status: typeof hotel.status === 'string'
          ? hotel.status
          : typeof hotel.subscriptionStatus === 'string'
            ? hotel.subscriptionStatus
            : 'unknown',
        relationshipType: typeof hotel.relationshipType === 'string'
          ? hotel.relationshipType
          : 'operator',
        isPrimary: hotel.isPrimary !== false,
      }];
    });
    const warnings = Array.isArray(row.warnings)
      ? row.warnings.filter((warning): warning is string => typeof warning === 'string')
      : typeof row.warningCount === 'number' && row.warningCount > 0
        ? [`${row.warningCount} access warning${row.warningCount === 1 ? '' : 's'}`]
        : [];
    const rawUserCount = typeof row.userCount === 'number' ? row.userCount : row.memberCount;
    return [{
      id: row.id,
      name: row.name,
      type: typeof row.type === 'string' ? row.type : 'management_company',
      status: typeof row.status === 'string' ? row.status : 'active',
      hotelCount: typeof row.hotelCount === 'number' ? row.hotelCount : hotels.length,
      userCount: typeof rawUserCount === 'number' ? rawUserCount : 0,
      warnings,
      hotels,
    }];
  });

  const hasIndependentHotels = Array.isArray(data.independentHotels);
  const independentHotels = hasIndependentHotels
    ? (data.independentHotels as unknown[]).flatMap((candidate): IndependentHotelSummary[] => {
      if (!candidate || typeof candidate !== 'object') return [];
      const row = candidate as Record<string, unknown>;
      if (typeof row.id !== 'string') return [];
      return [{
        id: row.id,
        name: typeof row.name === 'string' ? row.name : null,
        status: typeof row.status === 'string' ? row.status : 'unknown',
      }];
    })
    : [];

  return {
    organizations,
    independentHotels,
    independentIdsAuthoritative: hasIndependentHotels,
    schemaReady: data.schemaReady !== false,
  };
}

function matchesHotelStatus(hotel: EnrichedRow, status: StatusFilter): boolean {
  if (status === 'all') return true;
  if (status === 'stale') return hotel.isStale12h;
  if (status === 'pms_disconnected') return !hotel.pmsConnected;
  if (status === 'no_pms') return hotel.pmsType === null;
  return hotel.subscriptionStatus === status;
}

export function LiveSurface() {
  const [props, setProps] = useState<PropertyRow[] | null>(null);
  const [feedback, setFeedback] = useState<FeedbackItem[] | null>(null);
  const [directory, setDirectory] = useState<OrganizationDirectory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [view, setView] = useState<HotelsView>('organizations');
  const [organizationSearch, setOrganizationSearch] = useState('');
  const [organizationStatus, setOrganizationStatus] = useState<OrganizationStatusFilter>('all');
  const [hotelSearch, setHotelSearch] = useState('');
  const [hotelStatus, setHotelStatus] = useState<StatusFilter>('all');
  const [feedbackOrganization, setFeedbackOrganization] = useState('all');
  const [feedbackHotel, setFeedbackHotel] = useState('all');
  const [feedbackStatus, setFeedbackStatus] = useState<FeedbackStatusFilter>('all');
  const [page, setPage] = useState(1);
  // Bumped after a create to force EXACTLY ONE refetch off the reset filter
  // state. Calling load() directly there would use the stale closure and can
  // resolve after the reset fetch, hiding the just-created hotel.
  const [reloadNonce, setReloadNonce] = useState(0);

  const [sel, setSel] = useState<EnrichedRow | null>(null);
  // Hotel currently being assigned a PMS coverage (null = picker closed).
  const [pickerHotel, setPickerHotel] = useState<EnrichedRow | null>(null);
  // Hotel whose section on/off toggles are open (null = modal closed).
  const [sectionsHotel, setSectionsHotel] = useState<EnrichedRow | null>(null);
  // "+ Add hotel" modal — create a new property directly from this tab.
  const [addOpen, setAddOpen] = useState(false);
  const [createOrganizationOpen, setCreateOrganizationOpen] = useState(false);
  const [leaderInviteOrganization, setLeaderInviteOrganization] = useState<OrganizationSummary | null>(null);
  const [assignmentIntent, setAssignmentIntent] = useState<{ organizationId?: string; propertyId?: string } | null>(null);
  const [makeIndependentIntent, setMakeIndependentIntent] = useState<{ hotel: EnrichedRow; organizationName: string } | null>(null);
  // Hotel pending permanent deletion (null = confirm closed).
  const [deleteHotel, setDeleteHotel] = useState<EnrichedRow | null>(null);

  useEffect(() => { setPage(1); }, [hotelSearch, hotelStatus]);
  useEffect(() => { setFeedbackHotel('all'); }, [feedbackOrganization]);

  // Feedback status changes should not make the admin wait for (or depend on)
  // a full fleet + organization-directory reload. Keep this read isolated so
  // an unrelated hotel health failure cannot hide a successful inbox update.
  const refreshFeedback = useCallback(async () => {
    const response = await fetchWithAuth('/api/admin/feedback');
    const payload = await response.json() as {
      ok?: boolean;
      data?: { feedback?: unknown };
      error?: unknown;
    };
    if (!response.ok || payload.ok !== true) {
      throw new Error(apiErrorMessage(payload, 'Could not refresh feedback.'));
    }
    if (!Array.isArray(payload.data?.feedback)) {
      throw new Error('Could not refresh feedback: the server returned an invalid payload.');
    }
    setFeedback(payload.data.feedback as FeedbackItem[]);
  }, []);

  const loadFeedback = useCallback(async () => {
    setFeedbackError(null);
    try {
      await refreshFeedback();
    } catch (feedbackLoadError) {
      setFeedback([]);
      setFeedbackError(feedbackLoadError instanceof Error
        ? feedbackLoadError.message
        : 'Could not load feedback.');
    }
  }, [refreshFeedback]);

  const load = useCallback(async () => {
    setError(null);
    setFeedback(null);
    void loadFeedback();
    try {
      const propsParams = new URLSearchParams({
        page: '1',
        pageSize: String(API_PAGE_SIZE),
        status: 'all',
      });
      const [propsRes, organizationsRes] = await Promise.all([
        fetchWithAuth(`/api/admin/list-properties?${propsParams.toString()}`),
        fetchWithAuth('/api/admin/organizations'),
      ]);
      const [propsJson, organizationsJson] = await Promise.all([
        propsRes.json(), organizationsRes.json(),
      ]);

      const loads = [
        { label: 'hotel list', response: propsRes, payload: propsJson },
        { label: 'organizations', response: organizationsRes, payload: organizationsJson },
      ];
      const failed = loads.find(({ response, payload }) => !response.ok || payload?.ok !== true);
      if (failed) {
        const apiMessage = typeof failed.payload?.error?.message === 'string'
          ? failed.payload.error.message
          : typeof failed.payload?.error === 'string'
            ? failed.payload.error
            : `HTTP ${failed.response.status}`;
        setError(`Could not load ${failed.label}: ${apiMessage}`);
        return;
      }

      if (!Array.isArray(propsJson?.data?.properties)) {
        setError('Could not load hotel list: the server returned an invalid property payload.');
        return;
      }
      const normalizedDirectory = normalizeOrganizationDirectory(organizationsJson?.data);
      if (!normalizedDirectory) {
        setError('Could not load organizations: the server returned an invalid directory payload.');
        return;
      }

      const allProperties = [...(propsJson.data.properties as PropertyRow[])];
      const totalPages = Math.max(1, Number(propsJson?.data?.pagination?.totalPages) || 1);
      if (totalPages > MAX_API_PAGES) {
        setError('Could not load hotel list: the reported fleet size exceeds the safe directory limit.');
        return;
      }
      if (totalPages > 1) {
        // Read sequentially so a malformed or unexpectedly large response
        // cannot create an unbounded burst of Admin API requests.
        for (let nextPage = 2; nextPage <= totalPages; nextPage += 1) {
          const params = new URLSearchParams({
            page: String(nextPage),
            pageSize: String(API_PAGE_SIZE),
            status: 'all',
          });
          const response = await fetchWithAuth(`/api/admin/list-properties?${params.toString()}`);
          const payload = await response.json();
          if (!response.ok || payload?.ok !== true || !Array.isArray(payload?.data?.properties)) {
            setError(`Could not load hotel list page ${nextPage}. Please retry.`);
            return;
          }
          allProperties.push(...(payload.data.properties as PropertyRow[]));
        }
      }

      // Defensive de-duplication keeps a property from appearing twice if a
      // concurrent create shifts a row between two paged reads.
      setProps(Array.from(new Map(allProperties.map((property) => [property.id, property])).values()));
      setDirectory(normalizedDirectory);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadFeedback, reloadNonce]);

  useEffect(() => { void load(); }, [load]);

  const enriched = useMemo<EnrichedRow[]>(() => {
    const hotels = (props ?? []).map((property) => ({
      ...property,
      isStale12h: property.pmsConnected
        && property.syncFreshnessMin !== null
        && property.syncFreshnessMin > FLEET_STALE_SYNC_MINUTES,
    }));
    hotels.sort((a, b) => {
      const score = (hotel: EnrichedRow) => {
        if (hotel.subscriptionStatus === 'past_due') return 0;
        if (hotel.isStale12h) return 1;
        return 2;
      };
      return score(a) - score(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
    return hotels;
  }, [props]);

  const propertyById = useMemo(() => new Map(enriched.map((hotel) => [hotel.id, hotel])), [enriched]);
  const groupedPropertyIds = useMemo(() => new Set(
    (directory?.organizations ?? []).flatMap((organization) => organization.hotels.map((hotel) => hotel.id)),
  ), [directory]);
  const independentPropertyIds = useMemo(() => (
    directory?.independentIdsAuthoritative
      ? new Set(directory.independentHotels.map((hotel) => hotel.id))
      : null
  ), [directory]);
  const independentHotels = useMemo(() => enriched.filter((hotel) => (
    independentPropertyIds
      ? independentPropertyIds.has(hotel.id)
      : !groupedPropertyIds.has(hotel.id)
  )), [enriched, groupedPropertyIds, independentPropertyIds]);

  const organizationByProperty = useMemo(() => {
    const map = new Map<string, OrganizationSummary>();
    for (const organization of directory?.organizations ?? []) {
      for (const hotel of organization.hotels) map.set(hotel.id, organization);
    }
    return map;
  }, [directory]);

  const organizationQuery = organizationSearch.trim().toLowerCase();
  const visibleOrganizations = useMemo(() => (directory?.organizations ?? []).filter((organization) => {
    if (organizationStatus !== 'all' && organization.status !== organizationStatus) return false;
    if (!organizationQuery) return true;
    return organization.name.toLowerCase().includes(organizationQuery)
      || organization.hotels.some((hotel) => (hotel.name ?? '').toLowerCase().includes(organizationQuery));
  }), [directory, organizationQuery, organizationStatus]);

  const hotelQuery = hotelSearch.trim().toLowerCase();
  const visibleIndependentHotels = useMemo(() => independentHotels.filter((hotel) => (
    matchesHotelStatus(hotel, hotelStatus)
      && (!hotelQuery || (hotel.name ?? '').toLowerCase().includes(hotelQuery))
  )), [hotelQuery, hotelStatus, independentHotels]);
  const independentTotalPages = Math.max(1, Math.ceil(visibleIndependentHotels.length / INDEPENDENT_PAGE_SIZE));
  const currentIndependentPage = Math.min(page, independentTotalPages);
  const pagedIndependentHotels = visibleIndependentHotels.slice(
    (currentIndependentPage - 1) * INDEPENDENT_PAGE_SIZE,
    currentIndependentPage * INDEPENDENT_PAGE_SIZE,
  );

  useEffect(() => {
    if (page > independentTotalPages) setPage(independentTotalPages);
  }, [independentTotalPages, page]);

  const feedbackHotelOptions = useMemo(() => enriched.filter((hotel) => {
    if (feedbackOrganization === 'all') return true;
    const organization = organizationByProperty.get(hotel.id);
    if (feedbackOrganization === 'independent') return !organization;
    return organization?.id === feedbackOrganization;
  }), [enriched, feedbackOrganization, organizationByProperty]);

  const visibleFeedback = useMemo(() => (feedback ?? []).filter((item) => {
    if (feedbackStatus !== 'all' && item.status !== feedbackStatus) return false;
    if (feedbackHotel !== 'all' && item.property_id !== feedbackHotel) return false;
    if (feedbackOrganization === 'all') return true;
    const organization = item.property_id ? organizationByProperty.get(item.property_id) : undefined;
    if (feedbackOrganization === 'independent') return !organization;
    return organization?.id === feedbackOrganization;
  }), [feedback, feedbackHotel, feedbackOrganization, feedbackStatus, organizationByProperty]);

  const health = {
    ok: independentHotels.filter((hotel) => hotel.pmsConnected && !hotel.isStale12h && hotel.subscriptionStatus !== 'past_due').length,
    watch: independentHotels.filter((hotel) => hotel.subscriptionStatus === 'trial' || (hotel.pmsConnected && hotel.syncFreshnessMin !== null && hotel.syncFreshnessMin > 60 && !hotel.isStale12h)).length,
    attn: independentHotels.filter((hotel) => hotel.subscriptionStatus === 'past_due' || hotel.isStale12h || !hotel.pmsConnected).length,
    disc: independentHotels.filter((hotel) => !hotel.pmsConnected).length,
  };
  const newFeedbackCount = (feedback ?? []).filter((item) => item.status === 'new').length;
  const viewCounts: Record<HotelsView, number> = {
    organizations: directory?.organizations.length ?? 0,
    independent: independentHotels.length,
    feedback: newFeedbackCount,
  };

  if (error) {
    return (
      <SurfaceShell glow="tealTL">
        <SurfaceHeader count={props?.length ?? 0} />
        <HotelsViewTabs active={view} counts={viewCounts} onChange={setView} />
        <div id="hotels-panel" role="tabpanel" aria-labelledby={`hotels-tab-${view}`}>
          <ErrorState message={error} onRetry={() => void load()} />
        </div>
      </SurfaceShell>
    );
  }
  if (!props || !directory) {
    return (
      <SurfaceShell glow="tealTL">
        <SurfaceHeader count={0} />
        <HotelsViewTabs active={view} counts={viewCounts} onChange={setView} disabled />
        <div id="hotels-panel" role="tabpanel" aria-labelledby={`hotels-tab-${view}`}>
          <HotelsLoadingState />
        </div>
      </SurfaceShell>
    );
  }

  return (
    <SurfaceShell glow="tealTL">
      <SurfaceHeader count={enriched.length} />
      <HotelsViewTabs active={view} counts={viewCounts} onChange={setView} />

      {!directory.schemaReady && (
        <div className="studio-hotels-schema-note" role="status">
          Organization grouping is still being prepared. Every hotel remains safely available under Independent Hotels.
        </div>
      )}

      <section
        id="hotels-panel"
        role="tabpanel"
        aria-labelledby={`hotels-tab-${view}`}
        className="studio-hotels-panel"
      >
        {view === 'organizations' && (
          <OrganizationsPanel
            organizations={visibleOrganizations}
            totalOrganizations={directory.organizations.length}
            propertyById={propertyById}
            search={organizationSearch}
            onSearchChange={setOrganizationSearch}
            status={organizationStatus}
            onStatusChange={setOrganizationStatus}
            onOpenHotel={setSel}
            schemaReady={directory.schemaReady}
            onCreateOrganization={() => setCreateOrganizationOpen(true)}
            onAssignHotel={(organizationId) => setAssignmentIntent({ organizationId })}
            onInviteLeader={setLeaderInviteOrganization}
            onMakeIndependent={(hotel, organizationName) => setMakeIndependentIntent({ hotel, organizationName })}
            hasIndependentHotels={independentHotels.length > 0}
          />
        )}

        {view === 'independent' && (
          <IndependentHotelsPanel
            hotels={pagedIndependentHotels}
            totalHotels={independentHotels.length}
            matchingHotels={visibleIndependentHotels.length}
            search={hotelSearch}
            onSearchChange={setHotelSearch}
            status={hotelStatus}
            onStatusChange={setHotelStatus}
            health={health}
            page={currentIndependentPage}
            totalPages={independentTotalPages}
            onPageChange={setPage}
            onAddHotel={() => setAddOpen(true)}
            onOpenHotel={setSel}
            onAssignCoverage={setPickerHotel}
            onSections={setSectionsHotel}
            onDelete={setDeleteHotel}
            canAssignOrganization={directory.schemaReady && directory.organizations.some((organization) => organization.status === 'active')}
            onAssignOrganization={(propertyId) => setAssignmentIntent({ propertyId })}
          />
        )}

        {view === 'feedback' && feedbackError ? (
          <ErrorState
            title="Feedback could not be loaded."
            message={feedbackError}
            onRetry={() => {
              setFeedback(null);
              void loadFeedback();
            }}
          />
        ) : view === 'feedback' && !feedback ? (
          <HotelsLoadingState label="Loading feedback inbox" message="Loading hotel feedback…" />
        ) : view === 'feedback' && feedback ? (
          <FeedbackPanel
            feedback={visibleFeedback}
            allFeedback={feedback}
            organizations={directory.organizations}
            organizationByProperty={organizationByProperty}
            hotelOptions={feedbackHotelOptions}
            organizationFilter={feedbackOrganization}
            onOrganizationFilterChange={setFeedbackOrganization}
            hotelFilter={feedbackHotel}
            onHotelFilterChange={setFeedbackHotel}
            statusFilter={feedbackStatus}
            onStatusFilterChange={setFeedbackStatus}
            onChanged={refreshFeedback}
          />
        ) : null}
      </section>

      {sel && (
        <MapDetail
          h={sel}
          onClose={() => setSel(null)}
          onPickCoverage={() => setPickerHotel(sel)}
          onOpenSections={() => setSectionsHotel(sel)}
          onDetached={() => { setSel(null); void load(); }}
          onRequestDelete={() => setDeleteHotel(sel)}
        />
      )}

      {pickerHotel && (
        <CoveragePickerModal
          propertyId={pickerHotel.id}
          currentPmsFamily={pickerHotel.pmsType}
          onClose={() => setPickerHotel(null)}
          onAssigned={() => { setPickerHotel(null); setSel(null); void load(); }}
        />
      )}

      {sectionsHotel && (
        <SectionsModal
          propertyId={sectionsHotel.id}
          currentSections={sectionsHotel.enabledSections}
          onClose={() => setSectionsHotel(null)}
          onSaved={() => { setSectionsHotel(null); setSel(null); void load(); }}
        />
      )}

      {addOpen && (
        <AddHotelModal
          onClose={() => setAddOpen(false)}
          onCreated={() => {
            setView('independent');
            setHotelSearch('');
            setHotelStatus('all');
            setPage(1);
            setReloadNonce((n) => n + 1);
          }}
        />
      )}

      {createOrganizationOpen && (
        <CreateOrganizationModal
          onClose={() => setCreateOrganizationOpen(false)}
          onCreated={() => { setCreateOrganizationOpen(false); void load(); }}
        />
      )}

      {assignmentIntent && (
        <AssignHotelModal
          organizations={directory.organizations}
          hotels={independentHotels}
          initialOrganizationId={assignmentIntent.organizationId}
          initialPropertyId={assignmentIntent.propertyId}
          onClose={() => setAssignmentIntent(null)}
          onAssigned={() => { setAssignmentIntent(null); void load(); }}
        />
      )}

      {leaderInviteOrganization && (
        <OrganizationLeaderInviteModal
          organization={leaderInviteOrganization}
          onClose={() => setLeaderInviteOrganization(null)}
          onFinished={() => { void load(); }}
        />
      )}

      {makeIndependentIntent && (
        <MakeIndependentModal
          hotel={makeIndependentIntent.hotel}
          organizationName={makeIndependentIntent.organizationName}
          onClose={() => setMakeIndependentIntent(null)}
          onChanged={() => { setMakeIndependentIntent(null); void load(); }}
        />
      )}

      {deleteHotel && (
        <DeleteHotelModal
          h={deleteHotel}
          onClose={() => setDeleteHotel(null)}
          onDeleted={() => { setDeleteHotel(null); setSel(null); void load(); }}
        />
      )}
    </SurfaceShell>
  );
}

// ── Hotels header + accessible subnavigation ────────────────────────────
function SurfaceHeader({ count }: { count: number }) {
  return (
    <header className="studio-hotels-header">
      <div style={{ minWidth: 0 }}>
        <span className="caps" style={{ color: dimWhite(.55) }}>Hotels · Network directory</span>
        <h1 style={{ fontFamily: FONT_SERIF, fontSize: 30, fontWeight: 400, letterSpacing: '-0.02em', margin: '4px 0 0', color: '#fff' }}>
          <HeroCount n={count} /> <span style={{ fontStyle: 'italic' }}>hotels across Staxis</span>
        </h1>
        <p className="studio-hotels-header-copy">Every property appears once: inside its primary organization or under Independent Hotels.</p>
      </div>
      <div className="studio-hotels-global-actions" aria-label="Hotel administration tools">
        <AccessPopover />
        <AIControlCenter />
        <TwoFactorSwitch />
      </div>
    </header>
  );
}

function HeroCount({ n }: { n: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => { countUp(ref.current, 0, n, { dur: 1000, fmt: (v) => String(Math.round(v)) }); }, [n]);
  return <SerifNum size={30} c="#fff"><span ref={ref}>{n}</span></SerifNum>;
}

function HotelsViewTabs({
  active, counts, onChange, disabled = false,
}: {
  active: HotelsView;
  counts: Record<HotelsView, number>;
  onChange: (view: HotelsView) => void;
  disabled?: boolean;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? HOTEL_VIEWS.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + HOTEL_VIEWS.length) % HOTEL_VIEWS.length;
    const nextView = HOTEL_VIEWS[nextIndex];
    onChange(nextView.id);
    refs.current[nextIndex]?.focus();
  };

  return (
    <div className="studio-hotels-tabs" role="tablist" aria-label="Hotels views">
      {HOTEL_VIEWS.map((item, index) => {
        const selected = item.id === active;
        const countLabel = item.id === 'feedback' ? `${counts[item.id]} new` : String(counts[item.id]);
        return (
          <button
            key={item.id}
            ref={(element) => { refs.current[index] = element; }}
            id={`hotels-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls="hotels-panel"
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            className="studio-hotels-tab"
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <span>{item.label}</span>
            <span className="studio-hotels-tab-count" aria-label={countLabel}>{counts[item.id]}</span>
          </button>
        );
      })}
    </div>
  );
}

function OrganizationsPanel({
  organizations,
  totalOrganizations,
  propertyById,
  search,
  onSearchChange,
  status,
  onStatusChange,
  onOpenHotel,
  schemaReady,
  hasIndependentHotels,
  onCreateOrganization,
  onAssignHotel,
  onInviteLeader,
  onMakeIndependent,
}: {
  organizations: OrganizationSummary[];
  totalOrganizations: number;
  propertyById: Map<string, EnrichedRow>;
  search: string;
  onSearchChange: (value: string) => void;
  status: OrganizationStatusFilter;
  onStatusChange: (value: OrganizationStatusFilter) => void;
  onOpenHotel: (hotel: EnrichedRow) => void;
  schemaReady: boolean;
  hasIndependentHotels: boolean;
  onCreateOrganization: () => void;
  onAssignHotel: (organizationId: string) => void;
  onInviteLeader: (organization: OrganizationSummary) => void;
  onMakeIndependent: (hotel: EnrichedRow, organizationName: string) => void;
}) {
  const hotelCount = organizations.reduce((sum, organization) => sum + organization.hotelCount, 0);
  const userCount = organizations.reduce((sum, organization) => sum + organization.userCount, 0);
  const warningCount = organizations.reduce((sum, organization) => sum + organization.warnings.length, 0);
  const hasFilters = search.trim().length > 0 || status !== 'all';

  return (
    <div>
      <div className="studio-hotels-toolbar studio-hotels-toolbar--with-action">
        <label className="studio-hotels-filter studio-hotels-filter--search">
          <span>Search organizations</span>
          <span className="studio-hotels-search-wrap">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Organization or hotel name"
            />
          </span>
        </label>
        <label className="studio-hotels-filter">
          <span>Organization status</span>
          <select value={status} onChange={(event) => onStatusChange(event.target.value as OrganizationStatusFilter)}>
            {ORGANIZATION_STATUS_OPTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <Btn
          size="lg"
          variant="forest"
          onClick={onCreateOrganization}
          disabled={!schemaReady}
          title={schemaReady ? 'Create a management organization' : 'Organization setup is still being prepared'}
          style={{ alignSelf: 'end' }}
        >
          + Create organization
        </Btn>
      </div>

      <div className="studio-hotels-summary-grid" aria-label="Organization summary">
        <DarkHealth label="Organizations" n={organizations.length} tone="teal" />
        <DarkHealth label="Grouped hotels" n={hotelCount} tone="forest" />
        <DarkHealth label="Active people" n={userCount} tone="forest" />
        <DarkHealth label="Warnings" n={warningCount} tone={warningCount > 0 ? 'gold' : 'muted'} />
      </div>

      {organizations.length === 0 ? (
        <div className="studio-hotels-empty-wrap">
          <DarkEmpty text={hasFilters
            ? 'No organizations match these filters.'
            : totalOrganizations === 0
              ? 'No management organizations yet. Organization groups will appear here once assigned.'
              : 'No organizations are available.'} />
        </div>
      ) : (
        <div className="studio-organization-list" role="list">
          {organizations.map((organization) => (
            <OrganizationDisclosure
              key={organization.id}
              organization={organization}
              propertyById={propertyById}
              onOpenHotel={onOpenHotel}
              onAssignHotel={() => onAssignHotel(organization.id)}
              onInviteLeader={() => onInviteLeader(organization)}
              canInviteLeader={schemaReady && organization.status === 'active'}
              canAssign={schemaReady && organization.status === 'active' && hasIndependentHotels}
              assignDisabledReason={!schemaReady
                ? 'Organization setup is still being prepared'
                : organization.status !== 'active'
                  ? 'Only active organizations can receive hotel assignments'
                : !hasIndependentHotels
                  ? 'No independent hotels are available to assign'
                  : undefined}
              onMakeIndependent={(hotel) => onMakeIndependent(hotel, organization.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OrganizationDisclosure({
  organization,
  propertyById,
  onOpenHotel,
  onAssignHotel,
  onInviteLeader,
  canInviteLeader,
  canAssign,
  assignDisabledReason,
  onMakeIndependent,
}: {
  organization: OrganizationSummary;
  propertyById: Map<string, EnrichedRow>;
  onOpenHotel: (hotel: EnrichedRow) => void;
  onAssignHotel: () => void;
  onInviteLeader: () => void;
  canInviteLeader: boolean;
  canAssign: boolean;
  assignDisabledReason?: string;
  onMakeIndependent: (hotel: EnrichedRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const panelId = `organization-hotels-${organization.id}`;
  const statusTone: DotTone = organization.status === 'active' ? 'forest' : organization.status === 'suspended' ? 'gold' : 'terracotta';

  return (
    <article className="studio-organization-card" role="listitem">
      <button
        type="button"
        className="studio-organization-trigger"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="studio-organization-identity">
          <span className="studio-organization-chevron" aria-hidden="true">{expanded ? '−' : '+'}</span>
          <span>
            <span className="studio-organization-name">{organization.name}</span>
            <span className="studio-organization-meta">
              <Dot tone={statusTone} size={7} />
              {organization.status.replaceAll('_', ' ')} · {formatOrganizationType(organization.type)}
            </span>
          </span>
        </span>
        <span className="studio-organization-metric"><strong>{organization.hotelCount}</strong><small>Hotels</small></span>
        <span className="studio-organization-metric"><strong>{organization.userCount}</strong><small>People</small></span>
        <span className={`studio-organization-warning${organization.warnings.length > 0 ? ' studio-organization-warning--active' : ''}`}>
          <strong>{organization.warnings.length}</strong><small>{organization.warnings.length === 1 ? 'Warning' : 'Warnings'}</small>
        </span>
      </button>

      {expanded && (
        <div id={panelId} className="studio-organization-properties" role="region" aria-label={`${organization.name} hotels`}>
          <div className="studio-organization-properties-head">
            <span className="caps" style={{ color: dimWhite(.48) }}>Assigned hotels</span>
            <div className="studio-organization-properties-actions">
              <Btn
                size="md"
                variant="ghost"
                onClick={onInviteLeader}
                disabled={!canInviteLeader}
                title={canInviteLeader
                  ? `Invite an owner or administrator to ${organization.name}`
                  : 'Only active organizations can receive leader invitations'}
                style={{ color: '#fff', borderColor: dimWhite(.24), minHeight: 40 }}
              >
                Invite company lead
              </Btn>
              <Btn
                size="md"
                variant="ghost"
                onClick={onAssignHotel}
                disabled={!canAssign}
                title={canAssign ? `Assign an independent hotel to ${organization.name}` : assignDisabledReason}
                style={{ color: '#fff', borderColor: dimWhite(.24), minHeight: 40 }}
              >
                Assign hotel
              </Btn>
            </div>
          </div>
          {organization.warnings.length > 0 && (
            <div className="studio-organization-warning-note" role="status">
              {organization.warnings.join(' · ')}
            </div>
          )}
          {organization.hotels.length === 0 ? (
            <DarkEmpty text="No hotels are assigned to this organization." />
          ) : (
            <div role="list" className="studio-organization-property-list">
              {organization.hotels.map((hotelLink) => {
                const hotel = propertyById.get(hotelLink.id);
                return (
                  <div key={hotelLink.id} role="listitem" className="studio-organization-property-row">
                    <button
                      type="button"
                      className="studio-organization-property"
                      disabled={!hotel}
                      onClick={() => { if (hotel) onOpenHotel(hotel); }}
                      aria-label={`Open ${hotelLink.name ?? 'unnamed hotel'} details`}
                    >
                      <span className="studio-organization-property-name">
                        <Dot tone={hotel ? cardTone(hotel) : 'muted'} size={7} />
                        <span>
                          <strong>{hotelLink.name ?? '(unnamed hotel)'}</strong>
                          <small>{formatRelationshipType(hotelLink.relationshipType)} relationship</small>
                        </span>
                      </span>
                      <span className="studio-organization-property-detail">{hotel?.totalRooms ?? '—'} rooms</span>
                      <span className="studio-organization-property-detail">{hotel?.staffCount ?? '—'} staff</span>
                      <span className="studio-organization-property-status">{hotelLink.status.replaceAll('_', ' ')}</span>
                      <span className="studio-organization-property-open" aria-hidden="true">Open →</span>
                    </button>
                    <button
                      type="button"
                      className="studio-organization-make-independent"
                      disabled={!hotel}
                      onClick={() => { if (hotel) onMakeIndependent(hotel); }}
                      aria-label={`Make ${hotelLink.name ?? 'unnamed hotel'} independent`}
                    >
                      Make independent
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function IndependentHotelsPanel({
  hotels,
  totalHotels,
  matchingHotels,
  search,
  onSearchChange,
  status,
  onStatusChange,
  health,
  page,
  totalPages,
  onPageChange,
  onAddHotel,
  onOpenHotel,
  onAssignCoverage,
  onSections,
  onDelete,
  canAssignOrganization,
  onAssignOrganization,
}: {
  hotels: EnrichedRow[];
  totalHotels: number;
  matchingHotels: number;
  search: string;
  onSearchChange: (value: string) => void;
  status: StatusFilter;
  onStatusChange: (value: StatusFilter) => void;
  health: { ok: number; watch: number; attn: number; disc: number };
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onAddHotel: () => void;
  onOpenHotel: (hotel: EnrichedRow) => void;
  onAssignCoverage: (hotel: EnrichedRow) => void;
  onSections: (hotel: EnrichedRow) => void;
  onDelete: (hotel: EnrichedRow) => void;
  canAssignOrganization: boolean;
  onAssignOrganization: (propertyId: string) => void;
}) {
  const hasFilters = search.trim().length > 0 || status !== 'all';
  return (
    <div>
      <div className="studio-hotels-toolbar studio-hotels-toolbar--with-action">
        <label className="studio-hotels-filter studio-hotels-filter--search">
          <span>Search independent hotels</span>
          <span className="studio-hotels-search-wrap">
            <span aria-hidden="true">⌕</span>
            <input type="search" value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Hotel name" />
          </span>
        </label>
        <label className="studio-hotels-filter">
          <span>Hotel status</span>
          <select value={status} onChange={(event) => onStatusChange(event.target.value as StatusFilter)}>
            {STATUS_OPTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <Btn size="lg" variant="forest" onClick={onAddHotel} style={{ alignSelf: 'end' }}>+ Add hotel</Btn>
      </div>

      <div className="studio-hotels-summary-grid" aria-label="Independent hotel health">
        <DarkHealth label="Healthy" n={health.ok} tone="forest" />
        <DarkHealth label="Watch" n={health.watch} tone="gold" />
        <DarkHealth label="Needs attention" n={health.attn} tone="terracotta" />
        <DarkHealth label="Disconnected PMS" n={health.disc} tone="terracotta" />
      </div>

      {hotels.length === 0 ? (
        <div className="studio-hotels-empty-wrap">
          <DarkEmpty text={hasFilters
            ? 'No independent hotels match these filters.'
            : totalHotels === 0
              ? 'No independent hotels. Every hotel is currently grouped under an organization.'
              : 'No independent hotels are available.'} />
        </div>
      ) : (
        <div className="studio-independent-grid" role="list" aria-label="Independent hotels">
          {hotels.map((hotel) => (
            <div key={hotel.id} role="listitem">
              <MapCard
                h={hotel}
                onOpen={() => onOpenHotel(hotel)}
                onAssign={() => onAssignCoverage(hotel)}
                onSections={() => onSections(hotel)}
                onDelete={() => onDelete(hotel)}
                onAssignOrganization={() => onAssignOrganization(hotel.id)}
                canAssignOrganization={canAssignOrganization}
              />
            </div>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <nav className="studio-hotels-pagination" aria-label="Independent hotels pages">
          <span className="mono">Page {page} / {totalPages} · {matchingHotels} matching hotels</span>
          <span>
            <button type="button" onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page <= 1}>Previous</button>
            <button type="button" onClick={() => onPageChange(Math.min(totalPages, page + 1))} disabled={page >= totalPages}>Next</button>
          </span>
        </nav>
      )}
    </div>
  );
}

function FeedbackPanel({
  feedback,
  allFeedback,
  organizations,
  organizationByProperty,
  hotelOptions,
  organizationFilter,
  onOrganizationFilterChange,
  hotelFilter,
  onHotelFilterChange,
  statusFilter,
  onStatusFilterChange,
  onChanged,
}: {
  feedback: FeedbackItem[];
  allFeedback: FeedbackItem[];
  organizations: OrganizationSummary[];
  organizationByProperty: Map<string, OrganizationSummary>;
  hotelOptions: EnrichedRow[];
  organizationFilter: string;
  onOrganizationFilterChange: (value: string) => void;
  hotelFilter: string;
  onHotelFilterChange: (value: string) => void;
  statusFilter: FeedbackStatusFilter;
  onStatusFilterChange: (value: FeedbackStatusFilter) => void;
  onChanged: () => Promise<void>;
}) {
  const newCount = allFeedback.filter((item) => item.status === 'new').length;
  const inProgressCount = allFeedback.filter((item) => item.status === 'in_progress').length;
  const resolvedCount = allFeedback.filter((item) => item.status === 'resolved').length;
  const hasFilters = organizationFilter !== 'all' || hotelFilter !== 'all' || statusFilter !== 'all';

  return (
    <div>
      <div className="studio-hotels-toolbar studio-feedback-toolbar">
        <label className="studio-hotels-filter">
          <span>Organization</span>
          <select value={organizationFilter} onChange={(event) => onOrganizationFilterChange(event.target.value)}>
            <option value="all">All organizations</option>
            <option value="independent">Independent Hotels</option>
            {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
          </select>
        </label>
        <label className="studio-hotels-filter">
          <span>Hotel</span>
          <select value={hotelFilter} onChange={(event) => onHotelFilterChange(event.target.value)}>
            <option value="all">All hotels</option>
            {hotelOptions.map((hotel) => <option key={hotel.id} value={hotel.id}>{hotel.name ?? '(unnamed hotel)'}</option>)}
          </select>
        </label>
        <label className="studio-hotels-filter">
          <span>Feedback status</span>
          <select value={statusFilter} onChange={(event) => onStatusFilterChange(event.target.value as FeedbackStatusFilter)}>
            {FEEDBACK_STATUS_OPTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>

      <div className="studio-hotels-summary-grid" aria-label="Feedback summary">
        <DarkHealth label="New" n={newCount} tone="gold" />
        <DarkHealth label="In progress" n={inProgressCount} tone="teal" />
        <DarkHealth label="Resolved" n={resolvedCount} tone="forest" />
        <DarkHealth label="Total" n={allFeedback.length} tone="muted" />
      </div>

      {feedback.length === 0 ? (
        <div className="studio-hotels-empty-wrap">
          <DarkEmpty text={hasFilters ? 'No feedback matches these filters.' : 'No feedback yet.'} />
        </div>
      ) : (
        <div className="studio-feedback-grid" role="list" aria-label="Hotel feedback">
          {feedback.map((item) => {
            const organizationName = item.property_id ? organizationByProperty.get(item.property_id)?.name : undefined;
            return (
              <div key={item.id} role="listitem">
                <FeedbackRow row={item} organizationName={organizationName} onChanged={onChanged} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ErrorState({ message, onRetry, title = 'Hotels could not be loaded.' }: {
  message: string;
  onRetry: () => void;
  title?: string;
}) {
  return (
    <div className="studio-hotels-error" role="alert">
      <div>
        <strong>{title}</strong>
        <span>{message}</span>
      </div>
      <button type="button" onClick={onRetry}>Retry</button>
    </div>
  );
}

function HotelsLoadingState({
  label = 'Loading hotel directory',
  message = 'Loading organizations and hotels…',
}: {
  label?: string;
  message?: string;
} = {}) {
  return (
    <div className="studio-hotels-loading" role="status" aria-label={label}>
      <DarkSpinner size={24} />
      <span>{message}</span>
      <div className="studio-hotels-skeleton" aria-hidden="true">
        {[0, 1, 2].map((item) => <span key={item} />)}
      </div>
    </div>
  );
}

function formatOrganizationType(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatRelationshipType(value: string): string {
  return value.replaceAll('_', ' ');
}

// ── Fleet-health big number ──────────────────────────────────────────────
function DarkHealth({ label, n, tone }: { label: string; n: number; tone: DotTone }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => { countUp(ref.current, 0, n, { dur: 1000, fmt: (v) => String(Math.round(v)) }); }, [n]);
  return (
    <div>
      <span className="caps" style={{ color: dimWhite(.45) }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
        <Dot tone={tone} size={9} />
        <SerifNum size={30} c="#fff"><span ref={ref}>{n}</span></SerifNum>
      </div>
    </div>
  );
}

// ── Independent hotel card ──────────────────────────────────────────────
function MapCard({
  h,
  onOpen,
  onAssign,
  onSections,
  onDelete,
  onAssignOrganization,
  canAssignOrganization,
}: {
  h: EnrichedRow;
  onOpen: () => void;
  onAssign: () => void;
  onSections: () => void;
  onDelete: () => void;
  onAssignOrganization: () => void;
  canAssignOrganization: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const tone = cardTone(h);
  const unassigned = h.pmsType === null;
  const sectionsOff = APP_SECTIONS.filter((s) => h.enabledSections[s] === false).length;
  useEffect(() => { riseIn(ref.current, { dy: 10, dur: 320 }); }, []);
  return (
    <article
      ref={ref}
      className="studio-independent-card"
      style={{
        border: `1px solid ${tone === 'forest' ? dimWhite(.14) : `var(--${tone})`}`,
      }}
    >
      <button
        type="button"
        onClick={onDelete}
        title="Delete this hotel"
        aria-label={`Delete ${h.name ?? 'this hotel'}`}
        className="studio-independent-card-delete"
      >
        Delete
      </button>
      <button type="button" className="studio-independent-card-open" onClick={onOpen}>
        <span className="studio-independent-card-title">
          <Dot tone={tone} size={7} />
          <strong>{h.name ?? '(unnamed hotel)'}</strong>
        </span>
        <span aria-hidden="true">Details →</span>
      </button>
      <div className="mono studio-independent-card-meta">{h.totalRooms ?? '—'} rooms · {h.staffCount} staff</div>
      <div className="studio-independent-card-status">
        <Pill tone={unassigned ? 'gold' : subTone(h.subscriptionStatus)} style={{ fontSize: 9, padding: '2px 6px' }}>
          {unassigned ? 'NO SYSTEM DETECTED' : (h.subscriptionStatus ?? 'unknown').toUpperCase()}
        </Pill>
        <span className="mono" style={{ color: syncColor(h) }}>
          {h.pmsConnected
            ? `${h.pmsType}${h.syncFreshnessMin !== null ? ` · ${freshLabel(h.syncFreshnessMin)}` : ''}`
            : unassigned ? 'coverage needed' : 'not connected'}
        </span>
      </div>
      <div className="studio-independent-card-actions">
        <Btn
          size="sm"
          variant="forest"
          onClick={onAssignOrganization}
          disabled={!canAssignOrganization}
          title={canAssignOrganization ? 'Assign this hotel to an organization' : 'An active organization is required before assigning this hotel'}
          style={{ fontSize: 9.5, padding: '3px 8px' }}
        >
          Assign organization
        </Btn>
        {unassigned && (
          <Btn size="sm" variant="ghost" onClick={onAssign} style={{ color: '#fff', borderColor: dimWhite(.25), fontSize: 9.5, padding: '3px 8px' }}>
            Assign coverage
          </Btn>
        )}
        <Btn size="sm" variant="ghost" onClick={onSections} style={{ color: '#fff', borderColor: dimWhite(.25), fontSize: 9.5, padding: '3px 8px' }}>
          Sections
        </Btn>
        <Btn size="sm" variant="ghost" href={`/admin/properties/${h.id}`} style={{ color: '#fff', borderColor: dimWhite(.25), fontSize: 9.5, padding: '3px 8px' }}>
          Property page
        </Btn>
        {sectionsOff > 0 && <Pill tone="terracotta" style={{ fontSize: 9, padding: '2px 6px' }}>{sectionsOff} off</Pill>}
      </div>
    </article>
  );
}

function useDialogKeyboard(
  dialogRef: React.RefObject<HTMLDivElement | null>,
  onClose: () => void,
  blocked: boolean,
) {
  const closeRef = useRef(onClose);
  const blockedRef = useRef(blocked);
  // Read the opener during render, before React commits any `autoFocus`
  // control inside the dialog. Capturing it in the passive effect is too late:
  // by then document.activeElement is already inside the newly mounted modal.
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => { blockedRef.current = blocked; }, [blocked]);

  useEffect(() => {
    const returnFocusElement = returnFocusRef.current;
    const focusableInDialog = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((element) => element.getClientRects().length > 0);

    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      focusableInDialog()[0]?.focus({ preventScroll: true });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const ownBackdrop = dialogRef.current?.closest('[data-studio-modal-backdrop]');
      const openBackdrops = document.querySelectorAll('[data-studio-modal-backdrop]');
      if (!ownBackdrop || openBackdrops[openBackdrops.length - 1] !== ownBackdrop) return;

      if (event.key === 'Escape' && !blockedRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableInDialog();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (returnFocusElement?.isConnected) {
        returnFocusElement.focus({ preventScroll: true });
      }
    };
  }, [dialogRef]);
}

function CreateOrganizationModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<(typeof ORGANIZATION_TYPES)[number][0]>('management_company');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanName = name.trim();

  useEffect(() => { riseIn(ref.current, { dy: 24, dur: 340 }); }, []);
  useDialogKeyboard(ref, onClose, saving);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!cleanName || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetchWithAuth('/api/admin/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cleanName, type }),
      });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) {
        setError(apiErrorMessage(payload, 'Could not create this organization.'));
        return;
      }
      onCreated();
    } catch (submitError) {
      setError(`Network error: ${(submitError as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const typeLabel = ORGANIZATION_TYPES.find(([value]) => value === type)?.[1] ?? 'Organization';
  return (
    <Backdrop onClose={() => { if (!saving) onClose(); }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-organization-title"
        aria-describedby="create-organization-description"
        onClick={(event) => event.stopPropagation()}
        style={{ ...MODAL_CARD, width: 500 }}
      >
        <Caps>Create organization</Caps>
        <h3 id="create-organization-title" style={{ fontFamily: FONT_SERIF, fontSize: 26, fontWeight: 400, letterSpacing: '-0.02em', margin: '6px 0 8px' }}>
          Add a new <span style={{ fontStyle: 'italic' }}>hotel group</span>
        </h3>
        <p id="create-organization-description" className="studio-modal-copy">
          Create the company record first. Hotels remain independent until you explicitly assign them.
        </p>
        <form onSubmit={submit}>
          <label className="studio-modal-field">
            <span>Organization name</span>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Example Hospitality Group" disabled={saving} />
          </label>
          <label className="studio-modal-field">
            <span>Organization type</span>
            <select value={type} onChange={(event) => setType(event.target.value as typeof type)} disabled={saving}>
              {ORGANIZATION_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>

          <div className="studio-modal-preview" aria-live="polite">
            <Caps size={9}>Review before creating</Caps>
            <p><strong>{cleanName || 'Unnamed organization'}</strong> will be created as a {typeLabel.toLowerCase()} with no hotels or people assigned.</p>
          </div>

          {error && <div className="studio-modal-error" role="alert">{error}</div>}
          <div className="studio-modal-actions">
            <Btn type="submit" variant="forest" size="lg" disabled={!cleanName || saving}>{saving ? 'Creating…' : 'Create organization'}</Btn>
            <Btn variant="ghost" size="lg" onClick={onClose} disabled={saving}>Cancel</Btn>
          </div>
        </form>
      </div>
    </Backdrop>
  );
}

function AssignHotelModal({
  organizations,
  hotels,
  initialOrganizationId,
  initialPropertyId,
  onClose,
  onAssigned,
}: {
  organizations: OrganizationSummary[];
  hotels: EnrichedRow[];
  initialOrganizationId?: string;
  initialPropertyId?: string;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const assignableOrganizations = useMemo(
    () => organizations.filter((organization) => organization.status === 'active'),
    [organizations],
  );
  const initialOrganization = assignableOrganizations.find((organization) => organization.id === initialOrganizationId)
    ?? assignableOrganizations[0];
  const [organizationId, setOrganizationId] = useState(initialOrganization?.id ?? '');
  const [propertyId, setPropertyId] = useState(initialPropertyId ?? hotels[0]?.id ?? '');
  const [relationshipType, setRelationshipType] = useState<(typeof RELATIONSHIP_TYPES)[number][0]>('operator');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const organization = assignableOrganizations.find((candidate) => candidate.id === organizationId);
  const hotel = hotels.find((candidate) => candidate.id === propertyId);
  const canAssign = organization?.status === 'active' && !!hotel && !saving;

  useEffect(() => { riseIn(ref.current, { dy: 24, dur: 340 }); }, []);
  useDialogKeyboard(ref, onClose, saving);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!organization || !hotel || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetchWithAuth('/api/admin/organizations/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId: organization.id,
          propertyId: hotel.id,
          relationshipType,
          isPrimary: true,
        }),
      });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) {
        setError(apiErrorMessage(payload, 'Could not assign this hotel.'));
        return;
      }
      onAssigned();
    } catch (submitError) {
      setError(`Network error: ${(submitError as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Backdrop onClose={() => { if (!saving) onClose(); }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="assign-hotel-title"
        aria-describedby="assign-hotel-description"
        onClick={(event) => event.stopPropagation()}
        style={{ ...MODAL_CARD, width: 520 }}
      >
        <Caps>Assign hotel</Caps>
        <h3 id="assign-hotel-title" style={{ fontFamily: FONT_SERIF, fontSize: 26, fontWeight: 400, letterSpacing: '-0.02em', margin: '6px 0 8px' }}>
          Move an independent hotel into an <span style={{ fontStyle: 'italic' }}>organization</span>
        </h3>
        <p id="assign-hotel-description" className="studio-modal-copy">
          This creates the hotel’s primary grouping relationship. The hotel will appear in only one directory section.
        </p>
        <form onSubmit={submit}>
          <label className="studio-modal-field">
            <span>Organization</span>
            <select autoFocus value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} disabled={saving || assignableOrganizations.length === 0}>
              {assignableOrganizations.length === 0 && <option value="">No active organizations available</option>}
              {assignableOrganizations.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
          </label>
          <label className="studio-modal-field">
            <span>Independent hotel</span>
            <select value={propertyId} onChange={(event) => setPropertyId(event.target.value)} disabled={saving || hotels.length === 0}>
              {hotels.length === 0 && <option value="">No independent hotels available</option>}
              {hotels.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name ?? '(unnamed hotel)'}</option>)}
            </select>
          </label>
          <label className="studio-modal-field">
            <span>Relationship</span>
            <select value={relationshipType} onChange={(event) => setRelationshipType(event.target.value as typeof relationshipType)} disabled={saving}>
              {RELATIONSHIP_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>

          <div className="studio-modal-preview" aria-live="polite">
            <Caps size={9}>Impact preview</Caps>
            {organization && hotel ? (
              <p><strong>{hotel.name ?? '(unnamed hotel)'}</strong> will move out of Independent Hotels and appear only under <strong>{organization.name}</strong>. Effective access will be recalculated and the assignment will be audited.</p>
            ) : (
              <p>Create an organization and keep at least one hotel independent before assigning.</p>
            )}
          </div>

          {error && <div className="studio-modal-error" role="alert">{error}</div>}
          <div className="studio-modal-actions">
            <Btn type="submit" variant="forest" size="lg" disabled={!canAssign}>{saving ? 'Assigning…' : 'Confirm assignment'}</Btn>
            <Btn variant="ghost" size="lg" onClick={onClose} disabled={saving}>Cancel</Btn>
          </div>
        </form>
      </div>
    </Backdrop>
  );
}

function MakeIndependentModal({
  hotel,
  organizationName,
  onClose,
  onChanged,
}: {
  hotel: EnrichedRow;
  organizationName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { riseIn(ref.current, { dy: 24, dur: 340 }); }, []);
  useDialogKeyboard(ref, onClose, saving);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!confirmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetchWithAuth('/api/admin/organizations/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId: null,
          propertyId: hotel.id,
          relationshipType: 'operator',
          isPrimary: true,
        }),
      });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) {
        setError(apiErrorMessage(payload, 'Could not make this hotel independent.'));
        return;
      }
      onChanged();
    } catch (submitError) {
      setError(`Network error: ${(submitError as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Backdrop onClose={() => { if (!saving) onClose(); }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="make-independent-title"
        aria-describedby="make-independent-description"
        onClick={(event) => event.stopPropagation()}
        style={{ ...MODAL_CARD, width: 500 }}
      >
        <Caps>Change hotel grouping</Caps>
        <h3 id="make-independent-title" style={{ fontFamily: FONT_SERIF, fontSize: 26, fontWeight: 400, letterSpacing: '-0.02em', margin: '6px 0 8px' }}>
          Make <span style={{ fontStyle: 'italic' }}>{hotel.name ?? '(unnamed hotel)'}</span> independent?
        </h3>
        <p id="make-independent-description" className="studio-modal-copy">
          This ends its primary relationship with {organizationName}. The hotel will move to Independent Hotels and will no longer appear under that organization.
        </p>
        <form onSubmit={submit}>
          <div className="studio-modal-preview">
            <Caps size={9}>Impact preview</Caps>
            <p>Organization-inherited access will be recalculated immediately. Direct hotel grants remain unchanged, and the relationship change is recorded in the immutable access audit.</p>
          </div>
          <label className="studio-modal-confirm">
            <input autoFocus type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={saving} />
            <span>I understand that organization-inherited access may be removed.</span>
          </label>
          {error && <div className="studio-modal-error" role="alert">{error}</div>}
          <div className="studio-modal-actions">
            <Btn type="submit" variant="terracotta" size="lg" disabled={!confirmed || saving}>{saving ? 'Updating…' : 'Make independent'}</Btn>
            <Btn variant="ghost" size="lg" onClick={onClose} disabled={saving}>Cancel</Btn>
          </div>
        </form>
      </div>
    </Backdrop>
  );
}

function apiErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const error = (payload as Record<string, unknown>).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
    return (error as Record<string, unknown>).message as string;
  }
  return fallback;
}

// ── Delete-hotel confirm (typed-exact-name gate; shared by the card delete
//    control + the detail modal). The server requires the same name match to
//    delete a LIVE hotel, so this is the accident guard for the live customer.
function DeleteHotelModal({ h, onClose, onDeleted }: {
  h: EnrichedRow;
  onClose: () => void;
  onDeleted: () => void;   // delete succeeded → refetch + close
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameMatches =
    (h.name ?? '').trim().length > 0 &&
    confirmText.trim().toLowerCase() === (h.name ?? '').trim().toLowerCase();
  useEffect(() => { riseIn(ref.current, { dy: 26, dur: 380 }); }, []);
  useDialogKeyboard(ref, onClose, deleting);

  const doDelete = async () => {
    if (deleting || !nameMatches) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/admin/properties/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: h.id, confirmName: confirmText.trim() }),
      });
      const json = await res.json();
      if (!json.ok) { setError(json.error ?? 'Could not delete this hotel. Please try again.'); return; }
      onDeleted();
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Backdrop onClose={() => { if (!deleting) onClose(); }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-hotel-title"
        aria-describedby="delete-hotel-description"
        aria-busy={deleting}
        onClick={(e) => e.stopPropagation()}
        style={{ ...MODAL_CARD, width: 440 }}
      >
        <Caps>Delete hotel</Caps>
        <h3 id="delete-hotel-title" style={{ fontFamily: FONT_SERIF, fontSize: 24, fontWeight: 400, letterSpacing: '-0.02em', margin: '6px 0 10px' }}>
          Permanently delete <span style={{ fontStyle: 'italic' }}>{h.name ?? '(unnamed)'}</span>?
        </h3>
        <p id="delete-hotel-description" style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.5, marginBottom: 12 }}>
          This erases the hotel and <strong>all</strong> its data — rooms, staff, schedules, messages, coverage — and frees the owner’s login. It <strong>cannot be undone</strong>. Type the hotel’s name to confirm.
        </p>
        <input
          autoFocus
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={h.name ?? 'hotel name'}
          onKeyDown={(e) => { if (e.key === 'Enter' && nameMatches && !deleting) void doDelete(); }}
          style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '9px 11px', border: '1px solid var(--rule)', borderRadius: 9, background: '#fff', color: 'var(--ink)', outline: 'none', marginBottom: 12 }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn variant="terracotta" onClick={doDelete} disabled={!nameMatches || deleting}>
            {deleting ? 'Deleting…' : 'Permanently delete'}
          </Btn>
          <Btn variant="ghost" onClick={onClose} disabled={deleting}>Cancel</Btn>
        </div>
        {error && (
          <div role="alert" style={{ marginTop: 12, padding: '11px 13px', background: 'var(--terracotta-dim)', border: '1px solid rgba(194,86,46,.3)', borderRadius: 12, color: 'var(--terracotta-deep)', fontSize: 12.5, lineHeight: 1.45 }}>
            {error}
          </div>
        )}
      </div>
    </Backdrop>
  );
}

// ── Hotel detail modal (light card on blurred ink) ───────────────────────
function MapDetail({ h, onClose, onPickCoverage, onOpenSections, onDetached, onRequestDelete }: {
  h: EnrichedRow;
  onClose: () => void;
  onPickCoverage: () => void;   // opens CoveragePickerModal (assign or switch)
  onOpenSections: () => void;   // opens SectionsModal for this hotel
  onDetached: () => void;       // detach succeeded → refetch + close
  onRequestDelete: () => void;  // open the shared DeleteHotelModal for this hotel
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hasSystem = h.pmsType !== null;
  const [detaching, setDetaching] = useState(false);
  const [detachError, setDetachError] = useState<string | null>(null);
  useEffect(() => { riseIn(ref.current, { dy: 26, dur: 440 }); }, []);
  useDialogKeyboard(ref, onClose, detaching);

  // Detach this hotel from its current coverage. Mirrors the FeedbackRow
  // fetch+envelope+busy pattern: POST through fetchWithAuth, read { ok }, and
  // on success let the parent refetch (load()) and close the modal.
  const detach = async () => {
    if (detaching || !hasSystem) return;
    setDetaching(true);
    setDetachError(null);
    try {
      const res = await fetchWithAuth('/api/admin/coverage/detach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pmsFamily: h.pmsType, propertyId: h.id }),
      });
      const json = await res.json();
      if (!json.ok) {
        setDetachError(json.error ?? 'Could not detach coverage. Please try again.');
        return;
      }
      onDetached();
    } catch (err) {
      setDetachError(`Network error: ${(err as Error).message}`);
    } finally {
      setDetaching(false);
    }
  };

  return (
    <Backdrop onClose={() => { if (!detaching) onClose(); }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hotel-detail-title"
        aria-describedby="hotel-detail-description"
        aria-busy={detaching}
        onClick={(e) => e.stopPropagation()}
        style={{ ...MODAL_CARD, width: 460 }}
      >
        <Caps>{h.pmsConnected ? (h.pmsType ?? 'PMS') : 'No PMS'}</Caps>
        <h3 id="hotel-detail-title" style={{ fontFamily: FONT_SERIF, fontSize: 26, fontWeight: 400, letterSpacing: '-0.02em', margin: '6px 0 12px' }}>
          <span style={{ fontStyle: 'italic' }}>{h.name ?? '(unnamed)'}</span>
        </h3>
        <div id="hotel-detail-description" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 14 }}>
          <Stat label="Rooms" v={h.totalRooms ?? '—'} />
          <Stat label="Staff" v={h.staffCount} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <Pill tone={hasSystem ? subTone(h.subscriptionStatus) : 'gold'}>
            {hasSystem ? (h.subscriptionStatus ?? 'unknown').toUpperCase() : 'NO SYSTEM DETECTED'}
          </Pill>
          <span className="mono" style={{ fontSize: 11, color: syncColor(h) }}>
            {h.pmsConnected ? `${h.pmsType}${h.syncFreshnessMin !== null ? ` · synced ${freshLabel(h.syncFreshnessMin)} ago` : ''}` : hasSystem ? 'PMS not connected' : 'No coverage assigned'}
          </span>
        </div>

        {/* Coverage actions — attach (no system) / switch + detach (has system) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: detachError ? 10 : 16, flexWrap: 'wrap' }}>
          {hasSystem ? (
            <>
              <Btn variant="ghost" onClick={onPickCoverage} disabled={detaching}>Switch coverage</Btn>
              <Btn variant="terracotta" onClick={detach} disabled={detaching}>
                {detaching ? 'Detaching…' : 'Detach'}
              </Btn>
            </>
          ) : (
            <Btn variant="forest" onClick={onPickCoverage}>Assign coverage</Btn>
          )}
        </div>
        {detachError && (
          <div role="alert" style={{ padding: '11px 13px', marginBottom: 16, background: 'var(--terracotta-dim)', border: '1px solid rgba(194,86,46,.3)', borderRadius: 12, color: 'var(--terracotta-deep)', fontSize: 12.5, lineHeight: 1.45 }}>
            {detachError}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn
            variant="forest"
            onClick={() => {
              localStorage.setItem('hotelops-active-property', h.id);
              window.location.href = '/home';
            }}
          >
            Open hotel →
          </Btn>
          <Btn variant="primary" href={`/admin/properties/${h.id}`}>Property page →</Btn>
          <Btn variant="ghost" onClick={onOpenSections}>
            Sections{APP_SECTIONS.filter((s) => h.enabledSections[s] === false).length > 0 ? ` · ${APP_SECTIONS.filter((s) => h.enabledSections[s] === false).length} off` : ''}
          </Btn>
          <Btn variant="ghost" onClick={onClose}>Close</Btn>
        </div>

        {/* Danger zone — opens the shared typed-name delete confirm. */}
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--rule)' }}>
          <button
            type="button"
            onClick={onRequestDelete}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--terracotta-deep)', fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 600, textDecoration: 'underline' }}
          >
            Delete this hotel…
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function Stat({ label, v, c }: { label: string; v: React.ReactNode; c?: string }) {
  return (
    <div style={{ background: 'var(--rule-soft)', borderRadius: 10, padding: '10px 12px' }}>
      <Caps size={9}>{label}</Caps>
      <div style={{ marginTop: 2 }}><SerifNum size={24} c={c || 'var(--ink)'}>{v}</SerifNum></div>
    </div>
  );
}


// ── Feedback inbox card — real PATCH + refetch ──────────────────────────
function FeedbackRow({
  row,
  organizationName,
  onChanged,
}: {
  row: FeedbackItem;
  organizationName?: string;
  onChanged: () => Promise<void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const open = row.status !== 'resolved' && row.status !== 'wontfix';

  const setStatus = async (status: string) => {
    if (updating) return;
    setUpdating(true);
    setUpdateError(null);
    try {
      const response = await fetchWithAuth('/api/admin/feedback', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, status }),
      });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) {
        const message = typeof payload?.error?.message === 'string'
          ? payload.error.message
          : typeof payload?.error === 'string'
            ? payload.error
            : 'Could not update this feedback item.';
        setUpdateError(message);
        return;
      }
      await onChanged();
    } catch (error) {
      setUpdateError(`Network error: ${(error as Error).message}`);
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div ref={ref} aria-busy={updating} style={{ background: dimWhite(.05), border: `1px solid ${row.status === 'new' ? 'rgba(201,154,46,.45)' : dimWhite(.12)}`, borderRadius: 13, padding: '13px 15px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span className="mono" style={{ fontSize: 10, color: dimWhite(.55) }}>{CAT[row.category] ?? '○ note'}</span>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: '#fff', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.user_display_name ?? row.user_email ?? 'Anonymous'}</span>
        {row.property_name && <span style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 12, color: dimWhite(.45), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {row.property_name}</span>}
        <Pill tone={fbTone(row.status)} style={{ marginLeft: 'auto', fontSize: 9.5, padding: '2px 7px' }}>{row.status.replace('_', ' ').toUpperCase()}</Pill>
      </div>
      {organizationName && <div className="mono" style={{ fontSize: 9.5, color: dimWhite(.45), marginBottom: 6 }}>{organizationName}</div>}
      <div style={{ fontSize: 12.5, color: dimWhite(.75), lineHeight: 1.5, marginBottom: open ? 10 : 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{row.message}</div>
      {open && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {row.status === 'new' && <Btn size="sm" variant="ghost" onClick={() => setStatus('in_progress')} disabled={updating} style={{ color: '#fff', borderColor: dimWhite(.25) }}>Mark in progress</Btn>}
          <Btn size="sm" variant="forest" onClick={() => setStatus('resolved')} disabled={updating}>Resolve</Btn>
          <Btn size="sm" variant="ghost" onClick={() => setStatus('wontfix')} disabled={updating} style={{ color: '#fff', borderColor: dimWhite(.25) }}>Won&apos;t fix</Btn>
        </div>
      )}
      {updateError && <div className="studio-feedback-error" role="alert">{updateError}</div>}
    </div>
  );
}
