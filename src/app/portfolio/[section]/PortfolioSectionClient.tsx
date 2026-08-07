'use client';

import React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { PortfolioQueueView, type PortfolioScope } from '@/components/concourse/PortfolioQueueView';
import {
  ContextBanner,
  PortfolioSectionSkeleton,
  PortfolioSectionView,
  type PortfolioFilterModel,
  type PortfolioMetric,
  type PortfolioModuleId,
  type PortfolioSectionItem,
  type PortfolioStatus,
} from '@/components/portfolio';
import portfolioStyles from '@/components/portfolio/PortfolioUI.module.css';
import { useLang } from '@/contexts/LanguageContext';
import { usePortfolio } from '@/contexts/PortfolioContext';
import { useAuth } from '@/contexts/AuthContext';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { buildPortfolioHotelSecondaryLabels } from '@/lib/portfolio-ui/context';
import { companyScopeHref } from '@/lib/portfolio-ui/acting-scope';
import type {
  PortfolioUiFreshness,
  PortfolioUiIndicator,
  PortfolioUiSection,
  PortfolioUiSectionHotel,
  PortfolioUiSectionSummary,
  PortfolioUiSectionV1,
} from '@/lib/portfolio-ui/contracts';

const PAGE_SIZE = 16;

const COPY: Record<PortfolioModuleId, {
  title: string;
  description: string;
  listTitle: string;
  listDescription: string;
}> = {
  staxis: {
    title: 'Staxis command center',
    description: 'Company-wide findings, approvals, assignments, follow-up, and awareness.',
    listTitle: 'Across your hotels',
    listDescription: 'Deduplicated findings at portfolio grain.',
  },
  dashboard: {
    title: 'Portfolio dashboard',
    description: 'Recent occupancy trends, authorized financial context, and data quality across hotels.',
    listTitle: 'Hotels in view',
    listDescription: 'Property summaries with clear freshness and missing-data signals.',
  },
  housekeeping: {
    title: 'Portfolio housekeeping',
    description: 'Completion, exceptions, and staffing signals by hotel, not a room-by-room dump.',
    listTitle: 'Housekeeping by hotel',
    listDescription: 'Open a hotel for its detailed rooms and assignments.',
  },
  communications: {
    title: 'Portfolio communications',
    description: 'Company announcements, escalations, and acknowledgement response summaries.',
    listTitle: 'Communication exceptions',
    listDescription: 'Private local message contents are not aggregated here.',
  },
  maintenance: {
    title: 'Portfolio maintenance',
    description: 'Open, critical, aging, and recurring work summarized by hotel.',
    listTitle: 'Maintenance by hotel',
    listDescription: 'Drill into the existing work-order workflow for detail.',
  },
  inventory: {
    title: 'Portfolio inventory',
    description: 'At-risk stock and closed-period spend comparisons only where the data supports them.',
    listTitle: 'Inventory by hotel',
    listDescription: 'Unknown counts remain unknown rather than being treated as zero.',
  },
  staff: {
    title: 'Portfolio staff',
    description: 'Leaders, coverage, and unfilled shift signals without cross-company employee detail.',
    listTitle: 'Staff coverage by hotel',
    listDescription: 'Open a hotel for its authorized schedule and people workflows.',
  },
  financials: {
    title: 'Portfolio financials',
    description: 'Authorized portfolio totals and hotel comparisons, with missing sources called out.',
    listTitle: 'Financial reporting by hotel',
    listDescription: 'Hotel-level financial detail remains behind its existing server authorization.',
  },
};

const HOTEL_PATH: Record<PortfolioModuleId, string> = {
  staxis: '/feed', dashboard: '/dashboard', housekeeping: '/housekeeping',
  communications: '/communications', maintenance: '/maintenance', inventory: '/inventory',
  staff: '/staff', financials: '/financials',
};

const LABELS: Record<string, string> = {
  occupied_rooms: 'Occupied rooms',
  available_rooms: 'Available rooms',
  occupancy_percent: 'Occupancy',
  recent_occupancy_percent: 'Recent 7-day occupancy',
  occupancy_change_points: 'Vs. prior 7 days',
  open_tasks: 'Open tasks',
  urgent_tasks: 'Urgent tasks',
  completed_tasks: 'Completed tasks',
  completion_percent: 'Completion',
  open_staffing_slots: 'Open staffing slots',
  staffing_coverage_percent: 'Staffing coverage',
  open_items: 'Open items',
  high_severity_items: 'High severity',
  announcements_30d: 'Announcements · 30 days',
  acknowledgement_responses: 'Acknowledgement responses',
  pending_acknowledgements: 'Pending acknowledgements',
  acknowledgement_percent: 'Acknowledged',
  open_work_orders: 'Open work orders',
  urgent_work_orders: 'Urgent work orders',
  high_priority_work_orders: 'High-priority work orders',
  aging_work_orders: 'Open 7+ days',
  recurring_equipment_issues: 'Recurring equipment · 90 days',
  degraded_equipment: 'Degraded equipment',
  tracked_items: 'Tracked items',
  low_stock_items: 'At-risk stock',
  uncounted_items: 'Uncounted items',
  last_closed_spend: 'Last closed-period spend',
  spend_variance_percent: 'Vs. previous closed month',
  assigned_shifts: 'Assigned shifts',
  open_shifts: 'Open shifts',
  scheduled_people: 'Scheduled people',
  active_staff: 'Active staff',
  key_leaders: 'Key operational leaders',
  departments_without_coverage: 'Departments without coverage',
  month_to_date_revenue: 'Month-to-date revenue',
  revenue_change_percent: 'Vs. prior month to date',
  adr: 'Average daily rate',
  revpar: 'Revenue per available room',
  gross_operating_profit: 'Gross operating profit',
};

const FRESHNESS_REASON: Record<string, string> = {
  no_source_record: 'No source record is available for this period.',
  source_record_is_stale: 'The newest source record is stale.',
  invalid_source_timestamp: 'The source timestamp could not be verified.',
  bounded_read_incomplete: 'This hotel is represented by an incomplete bounded read.',
  invalid_source_values: 'Some source values could not be compared safely.',
  insufficient_date_coverage: 'Expected daily coverage is incomplete, so period comparisons are unavailable.',
  section_policy_unavailable: 'The module policy could not be verified.',
  section_disabled: 'This module is disabled for the hotel.',
  capability_denied: 'This acting context cannot read this hotel detail.',
};

function humanize(value: string): string {
  return LABELS[value] ?? value.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function normalizeRegion(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? '';
}

function compareHotelName(
  left: PortfolioUiSectionHotel,
  right: PortfolioUiSectionHotel,
): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    || left.propertyId.localeCompare(right.propertyId);
}

function readableTimestamp(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function freshnessEvidence(freshness: PortfolioUiFreshness): string {
  const reason = freshness.reason
    ? FRESHNESS_REASON[freshness.reason] ?? humanize(freshness.reason)
    : freshness.state === 'fresh'
      ? 'Source is current.'
      : `${humanize(freshness.state)} source.`;
  const observed = readableTimestamp(freshness.observedAt);
  if (observed) return `${reason} Observed ${observed}.`;
  if (freshness.asOfDate) return `${reason} Represents ${freshness.asOfDate}.`;
  return `${reason} Source time is unavailable.`;
}

function focusSectionCollectionHeading(): void {
  window.requestAnimationFrame(() => {
    const heading = document.querySelector<HTMLElement>(
      '[data-view="section"] section[aria-labelledby] h2',
    );
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: false });
    heading.addEventListener('blur', () => heading.removeAttribute('tabindex'), { once: true });
  });
}

function valueFor(
  value: number | null,
  unit: PortfolioUiIndicator['unit'] = 'count',
  lowerBound = false,
): string {
  if (value === null) return 'Unavailable';
  const prefix = lowerBound ? 'At least ' : '';
  const formatted = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
  if (unit === 'percent') return `${prefix}${formatted}%`;
  if (unit === 'percentage_points') {
    const sign = value > 0 ? '+' : '';
    return `${prefix}${sign}${formatted} pp`;
  }
  if (unit === 'currency_cents') return `${prefix}${new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(value / 100)}`;
  return `${prefix}${new Intl.NumberFormat('en-US').format(value)}`;
}

function metric(
  id: string,
  label: string,
  value: number | null,
  unit?: PortfolioUiIndicator['unit'],
  supportingText?: string,
): PortfolioMetric {
  return {
    id,
    label,
    value: valueFor(value, unit),
    supportingText: supportingText
      ?? (value === null ? 'Source unavailable or not comparable' : undefined),
    tone: value === null ? 'neutral' : 'info',
  };
}

function metricsFor(summary: PortfolioUiSectionSummary): PortfolioMetric[] {
  const reporting = metric('reporting', 'Hotels reporting', summary.reportingHotels);
  switch (summary.kind) {
    case 'dashboard': return [
      reporting,
      metric('occupancy', 'Recent 7-day occupancy', summary.recentOccupancyPercent, 'percent'),
      metric(
        'occupancy_change',
        'Vs. prior 7 days',
        summary.occupancyChangePoints,
        'percentage_points',
        summary.occupancyComparisonHotels != null && summary.occupancyComparisonHotels > 0
          ? `${summary.occupancyComparisonHotels} comparable hotels`
          : undefined,
      ),
      metric(
        'revenue',
        'Month-to-date revenue',
        summary.monthToDateRevenueCents,
        'currency_cents',
        summary.financialReportingHotels != null && summary.financialReportingHotels > 0
          ? `${summary.financialReportingHotels} financially authorized reporting hotels`
          : undefined,
      ),
    ];
    case 'housekeeping': return [
      reporting, metric('completion', 'Task completion', summary.completionPercent, 'percent'),
      metric('urgent', 'Urgent tasks', summary.urgentTasks),
      metric('staffing_gap', 'Open staffing slots', summary.openStaffingSlots),
    ];
    case 'communications': {
      const responseSummary = summary.acknowledgementPercent != null
        ? metric(
            'acknowledgement_rate',
            'Acknowledged',
            summary.acknowledgementPercent,
            'percent',
            summary.acknowledgementResponses != null
              ? `${valueFor(summary.acknowledgementResponses)} responses`
              : undefined,
          )
        : summary.acknowledgementResponses != null
          ? metric(
              'acknowledgement_responses',
              'Acknowledgement responses',
              summary.acknowledgementResponses,
            )
          : null;
      return [
        reporting,
        metric('high', 'High-severity escalations', summary.highSeverityItems),
        metric('company_announcements', 'Company announcements · 30 days', summary.companyAnnouncements),
        metric('pending_ack', 'Pending acknowledgements', summary.pendingAcknowledgements),
        ...(responseSummary ? [responseSummary] : []),
      ];
    }
    case 'maintenance': return [
      reporting,
      metric('urgent', 'Urgent work orders', summary.urgentWorkOrders),
      metric('high_priority', 'High-priority work orders', summary.highPriorityWorkOrders),
      metric('aging', 'Open 7+ days', summary.agingWorkOrders),
      metric('recurring', 'Recurring equipment · 90 days', summary.recurringEquipmentIssues),
    ];
    case 'inventory': return [
      reporting, metric('tracked', 'Tracked items', summary.trackedItems),
      metric('low', 'At-risk stock', summary.lowStockItems),
      metric(
        'spend_variance',
        'Vs. previous closed month',
        summary.spendVariancePercent,
        'percent',
        summary.comparableSpendHotels != null && summary.comparableSpendHotels > 0
          ? `${summary.comparableSpendHotels} hotels with comparable closed periods`
          : undefined,
      ),
    ];
    case 'staff': return [
      reporting,
      metric('active', 'Active staff', summary.activeStaff),
      metric('leaders', 'Key operational leaders', summary.keyLeaders),
      metric('open', 'Unfilled shift slots', summary.openShifts),
    ];
    case 'financials': return [
      reporting,
      metric('revenue', 'Month-to-date revenue', summary.monthToDateRevenueCents, 'currency_cents'),
      metric(
        'revenue_change',
        'Vs. prior month to date',
        summary.revenueChangePercent,
        'percent',
        summary.comparisonHotels != null && summary.comparisonHotels > 0
          ? `${summary.comparisonHotels} comparable hotels`
          : undefined,
      ),
      metric('occupancy', 'Month-to-date occupancy', summary.occupancyPercent, 'percent'),
    ];
  }
}

function itemStatus(hotel: PortfolioUiSectionHotel): PortfolioStatus {
  if (hotel.indicators.some((indicator) => indicator.tone === 'critical')) {
    return { label: 'Critical', tone: 'critical' };
  }
  if (hotel.indicators.some((indicator) => indicator.tone === 'warning')) {
    return { label: 'Needs attention', tone: 'warning' };
  }
  if (hotel.partial || hotel.freshness.state !== 'fresh') {
    return { label: hotel.freshness.state === 'stale' ? 'Stale data' : 'Partial data', tone: 'neutral' };
  }
  return { label: 'Current', tone: 'neutral' };
}

function itemRank(item: PortfolioUiSectionHotel): number {
  const status = itemStatus(item);
  return status.tone === 'critical' ? 0 : status.tone === 'warning' ? 1 : item.partial ? 2 : 3;
}

function shortId(value: string): string {
  return value.replaceAll('-', '').slice(0, 8).toUpperCase();
}

function drilldownHref(
  section: PortfolioModuleId,
  propertyId: string,
  organizationId: string,
  returnTo: string,
): string {
  const params = new URLSearchParams({ scope: 'hotel', propertyId, organizationId, returnTo });
  return `${HOTEL_PATH[section]}?${params.toString()}`;
}

function StaxisPortfolio({ organizationId, organizationName }: { organizationId: string; organizationName: string }) {
  const { lang } = useLang();
  const { user, authorizationFingerprint } = useAuth();
  const [scope, setScope] = React.useState<PortfolioScope | null | undefined>(undefined);
  return (
    <>
      <div style={{ width: 'min(100% - 32px, 1180px)', margin: '18px auto 0' }}>
        <ContextBanner
          kind="portfolio"
          contextLabel="Portfolio"
          scopeName={organizationName}
          secondaryLabel="Company command center"
          switchAction={{ label: 'Open company view', href: companyScopeHref('/home', organizationId) }}
        />
      </div>
      {scope === undefined ? <PortfolioSectionSkeleton label="Staxis command center" /> : null}
      <PortfolioQueueView
        lang={lang}
        organizationId={organizationId}
        authorizationKey={JSON.stringify([
          user?.uid ?? null,
          user?.accountId ?? null,
          organizationId,
          authorizationFingerprint,
        ])}
        onScope={setScope}
      />
    </>
  );
}

export function PortfolioSectionClient({ section }: { section: PortfolioModuleId }) {
  const portfolio = usePortfolio();
  const { user, authorizationFingerprint, authorizationChecked } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const company = portfolio.data?.selectedCompany ?? null;
  const organizationId = company?.organizationId ?? portfolio.requestedOrganizationId;
  const endpoint = organizationId && section !== 'staxis'
    ? `/api/portfolio/v1/section?organizationId=${encodeURIComponent(organizationId)}&section=${encodeURIComponent(section)}`
    : '/api/portfolio/v1/section';
  const resource = useApiResource<PortfolioUiSectionV1>(endpoint, {
    enabled: Boolean(organizationId && section !== 'staxis'),
    identityKey: user
      ? JSON.stringify([
          user.uid,
          user.accountId,
          organizationId,
          authorizationChecked,
          authorizationFingerprint,
        ])
      : null,
    keepDataOnError: false,
    revalidateOnFocus: true,
    clearDataOnFocusRevalidate: true,
  });

  const [search, setSearch] = React.useState(() => searchParams.get('search') ?? '');
  const [region, setRegion] = React.useState(() => searchParams.get('region') ?? 'all');
  const [status, setStatus] = React.useState(() => searchParams.get('status') ?? 'all');
  const [sort, setSort] = React.useState(() => searchParams.get('sort') ?? 'attention');
  const [page, setPage] = React.useState(() => Math.max(1, Number(searchParams.get('page')) || 1));
  const [pageAnnouncement, setPageAnnouncement] = React.useState('');
  const locationQuery = searchParams.toString();

  // Back/forward navigation is a state transition, not just a URL decoration.
  // Rehydrate every visible control from the current location so a return from
  // hotel detail restores the same slice of the portfolio.
  React.useEffect(() => {
    setSearch(searchParams.get('search') ?? '');
    setRegion(searchParams.get('region') ?? 'all');
    setStatus(searchParams.get('status') ?? 'all');
    setSort(searchParams.get('sort') ?? 'attention');
    setPage(Math.max(1, Number(searchParams.get('page')) || 1));
  }, [locationQuery, searchParams]);

  React.useEffect(() => {
    if (!portfolio.loading && portfolio.data?.selection.state === 'needs_selection') {
      router.replace('/home');
    }
  }, [portfolio.data?.selection.state, portfolio.loading, router]);

  const updateLocation = React.useCallback((next: Record<string, string | number | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === '' || value === 'all' || (key === 'page' && value === 1)) params.delete(key);
      else params.set(key, String(value));
    }
    const query = params.toString();
    window.history.replaceState(null, '', `${pathname}${query ? `?${query}` : ''}`);
  }, [pathname, searchParams]);

  if (portfolio.loading || (!portfolio.data && !portfolio.error)) {
    return <PortfolioSectionSkeleton label={COPY[section].title} />;
  }

  if (portfolio.error) {
    return (
      <PortfolioSectionView
        module={section}
        context={{ kind: 'portfolio', contextLabel: 'Portfolio', scopeName: 'Unavailable' }}
        eyebrow="Portfolio"
        title={COPY[section].title}
        description={COPY[section].description}
        itemSectionTitle={COPY[section].listTitle}
        itemSectionDescription={COPY[section].listDescription}
        items={[]}
        state="error"
        stateContent={{
          title: 'Your portfolio context could not be loaded',
          description: portfolio.error,
          guidance: 'No hotel data has been substituted or shown.',
          action: { label: 'Try again', onActivate: () => void portfolio.reload() },
        }}
      />
    );
  }

  if (!company) {
    if (portfolio.data?.selection.state === 'needs_selection') {
      return <PortfolioSectionSkeleton label="Opening context chooser" />;
    }
    return (
      <PortfolioSectionView
        module={section}
        context={{ kind: 'portfolio', contextLabel: 'Portfolio', scopeName: 'Unavailable' }}
        eyebrow="Portfolio"
        title={COPY[section].title}
        description={COPY[section].description}
        itemSectionTitle={COPY[section].listTitle}
        items={[]}
        state="unauthorized"
        stateContent={{
          title: 'No authorized company context',
          description: 'Your access may have changed since this link was opened.',
          guidance: 'Open Home and pick a company from your account menu, or ask a company owner to review access.',
          action: { label: 'Go to Home', href: '/home' },
        }}
      />
    );
  }

  if (section === 'staxis') {
    if (!company.queueAvailable) {
      return (
        <PortfolioSectionView
          module="staxis"
          context={{
            kind: 'portfolio',
            contextLabel: 'Portfolio',
            scopeName: company.organizationName ?? 'Your company',
          }}
          eyebrow="Portfolio"
          title={COPY.staxis.title}
          description={COPY.staxis.description}
          itemSectionTitle={COPY.staxis.listTitle}
          items={[]}
          state="unauthorized"
          stateContent={{
            title: 'The company queue is not available in this scope',
            description: 'Your current receipt does not cover the whole selected company.',
            guidance: 'Open Home and pick another company from your account menu. Direct queue requests remain authorization-checked.',
            action: { label: 'Go to Home', href: '/home' },
          }}
        />
      );
    }
    return <StaxisPortfolio organizationId={company.organizationId} organizationName={company.organizationName ?? 'Your company'} />;
  }

  const responseMismatch = Boolean(resource.data && (
    resource.data.organizationId !== organizationId || resource.data.section !== section
  ));
  const data = responseMismatch ? null : resource.data;
  const resourceError = responseMismatch
    ? 'The section response did not match the requested company and module.'
    : resource.error;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filtered = [...(data?.hotels ?? [])].filter((hotel) => {
    const currentStatus = itemStatus(hotel);
    const matchesSearch = !normalizedSearch || [hotel.name, hotel.city, hotel.region, hotel.brand, hotel.propertyId]
      .filter(Boolean).join(' ').toLocaleLowerCase().includes(normalizedSearch);
    const matchesRegion = region === 'all'
      || normalizeRegion(hotel.region) === normalizeRegion(region);
    const matchesStatus = status === 'all'
      || (status === 'attention' ? currentStatus.tone === 'critical' || currentStatus.tone === 'warning' : status === 'partial' ? hotel.partial || hotel.freshness.state !== 'fresh' : currentStatus.label === 'Current');
    return matchesSearch && matchesRegion && matchesStatus;
  });
  filtered.sort((left, right) => {
    if (sort === 'name') return compareHotelName(left, right);
    if (sort === 'region') {
      return (normalizeRegion(left.region) || '\uffff').localeCompare(normalizeRegion(right.region) || '\uffff')
        || compareHotelName(left, right);
    }
    return itemRank(left) - itemRank(right) || compareHotelName(left, right);
  });

  const regionLabelsByKey = new Map<string, string>();
  for (const hotel of data?.hotels ?? []) {
    const label = hotel.region?.trim();
    if (!label) continue;
    const key = normalizeRegion(label);
    if (!regionLabelsByKey.has(key)) regionLabelsByKey.set(key, label);
  }
  const regions = [...regionLabelsByKey.values()].sort((left, right) => left.localeCompare(right));
  const resolvedRegion = region === 'all'
    ? 'all'
    : regions.find((candidate) => normalizeRegion(candidate) === normalizeRegion(region)) ?? region;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const resolvedPage = Math.min(page, pageCount);
  const rows = filtered.slice((resolvedPage - 1) * PAGE_SIZE, resolvedPage * PAGE_SIZE);
  const returnTo = `${pathname}${locationQuery ? `?${locationQuery}` : ''}`;
  const hotelSecondaryLabels = buildPortfolioHotelSecondaryLabels(data?.hotels ?? []);
  const items: PortfolioSectionItem[] = rows.map((hotel) => ({
    id: hotel.propertyId,
    title: hotel.name,
    scopeLabel: `Hotel · ${hotel.name}`,
    secondaryLabel: hotelSecondaryLabels[hotel.propertyId],
    description: freshnessEvidence(hotel.freshness),
    status: itemStatus(hotel),
    facts: hotel.indicators.map((indicator) => ({
      label: humanize(indicator.key),
      value: valueFor(indicator.value, indicator.unit, indicator.lowerBound),
      emphasis: indicator.tone === 'warning' || indicator.tone === 'critical',
    })),
    drilldown: {
      label: `Open ${COPY[section].listTitle.replace(' by hotel', '')}`,
      ariaLabel: `Open ${COPY[section].title} for ${hotel.name}`,
      href: drilldownHref(section, hotel.propertyId, company.organizationId, returnTo),
    },
  }));

  const hasActiveFilters = Boolean(
    search.trim() || region !== 'all' || status !== 'all' || sort !== 'attention',
  );
  const clearFilters = () => {
    setSearch('');
    setRegion('all');
    setStatus('all');
    setSort('attention');
    setPage(1);
    updateLocation({ search: null, region: null, status: null, sort: null, page: null });
  };

  const filters: PortfolioFilterModel = {
    search: {
      value: search, label: 'Search hotels', placeholder: 'Hotel, city, region, or ID',
      onChange: (value) => { setSearch(value); setPage(1); updateLocation({ search: value, page: 1 }); },
    },
    region: {
      value: resolvedRegion, label: 'Region',
      options: [{ value: 'all', label: 'All regions' }, ...regions.map((value) => ({ value, label: value }))],
      onChange: (value) => { setRegion(value); setPage(1); updateLocation({ region: value, page: 1 }); },
    },
    status: {
      value: status, label: 'Status',
      options: [
        { value: 'all', label: 'All statuses' },
        { value: 'attention', label: 'Needs attention' },
        { value: 'partial', label: 'Partial or stale' },
        { value: 'current', label: 'Current' },
      ],
      onChange: (value) => { setStatus(value); setPage(1); updateLocation({ status: value, page: 1 }); },
    },
    sort: {
      value: sort, label: 'Sort',
      options: [
        { value: 'attention', label: 'Attention first' },
        { value: 'name', label: 'Hotel name' },
        { value: 'region', label: 'Region' },
      ],
      onChange: (value) => {
        setSort(value);
        setPage(1);
        updateLocation({ sort: value, page: 1 });
      },
    },
    resultSummary: `${filtered.length} of ${data?.coverage.total ?? 0} authorized hotels`,
    clearAction: hasActiveFilters ? { label: 'Clear filters', onActivate: clearFilters } : undefined,
  };

  const unauthorized = section === 'financials' && company.capabilities.canViewFinancials !== true;
  const trueEmptyPortfolio = Boolean(data && data.coverage.total === 0);
  const allHotelRowsUnavailable = Boolean(data && data.coverage.total > 0 && data.hotels.length === 0);
  const state = unauthorized
    ? 'unauthorized'
    : resource.loading
      ? 'loading'
      : resourceError
        ? 'error'
        : trueEmptyPortfolio
          ? 'empty'
          : data?.partial
            ? 'partial'
            : 'ready';
  const missing = (data?.missingPropertyIds ?? []).map((propertyId) => {
    const hotel = portfolio.data?.hotels.find((candidate) => candidate.propertyId === propertyId);
    return hotel ? `${hotel.name} (${shortId(propertyId)})` : shortId(propertyId);
  });
  const noFilterMatches = Boolean(data && data.hotels.length > 0 && filtered.length === 0);

  return (
    <>
      <PortfolioSectionView
        module={section}
        context={{
          kind: 'portfolio', contextLabel: 'Portfolio', scopeName: company.organizationName ?? 'Your company',
          secondaryLabel: `${company.hotelCount} authorized ${company.hotelCount === 1 ? 'hotel' : 'hotels'}`,
          returnAction: { label: 'Portfolio Home', href: `/portfolio?organizationId=${encodeURIComponent(company.organizationId)}` },
          switchAction: { label: 'Open company view', href: companyScopeHref('/home', company.organizationId) },
        }}
        eyebrow={`Portfolio · ${company.organizationName ?? 'Company'}`}
        title={COPY[section].title}
        description={COPY[section].description}
        metrics={data ? metricsFor(data.summary) : []}
        itemSectionTitle={COPY[section].listTitle}
        itemSectionDescription={data
          ? `${COPY[section].listDescription} Generated ${readableTimestamp(data.generatedAt) ?? 'at an unavailable response time'}.`
          : COPY[section].listDescription}
        items={items}
        filters={data ? filters : undefined}
        pagination={data && pageCount > 1 ? {
          page: resolvedPage, pageCount, summary: `Page ${resolvedPage} of ${pageCount}`,
          previousLabel: 'Previous hotels', nextLabel: 'Next hotels', pageLabel: 'Hotel page',
          onPageChange: (next) => {
            setPage(next);
            updateLocation({ page: next });
            setPageAnnouncement(`Showing hotel page ${next} of ${pageCount}.`);
            focusSectionCollectionHeading();
          },
        } : undefined}
        state={state}
        collectionEmptyContent={noFilterMatches ? {
          title: 'No hotels match these filters',
          description: 'The authorized portfolio is still available.',
          guidance: 'Clear or adjust a filter to see other hotels.',
          action: { label: 'Clear filters', onActivate: clearFilters },
        } : allHotelRowsUnavailable ? {
          title: 'Hotel rows could not be loaded',
          description: 'Authorized hotels were omitted from this section response.',
          guidance: 'This is not an empty portfolio or a zero. Retry before drawing a conclusion.',
          action: { label: 'Retry', onActivate: () => void resource.reload() },
        } : undefined}
        stateContent={unauthorized ? {
          title: 'Financial access required',
          description: 'Your current company role does not include portfolio financials.',
          guidance: 'Direct links are denied by the server as well as hidden from navigation.',
        } : resourceError ? {
          title: `${COPY[section].title} could not be loaded`,
          description: resourceError,
          guidance: 'This is not a zero or an all-clear.',
          action: { label: 'Try again', onActivate: () => void resource.reload() },
        } : trueEmptyPortfolio ? {
          title: 'No reporting hotels',
          description: 'No authorized hotel has data for this section yet.',
          guidance: 'Missing data is not reported as zero.',
        } : data?.partial ? {
          title: 'This view is partial',
          description: missing.length > 0
            ? `Unavailable hotel IDs: ${missing.join(', ')}.`
            : 'At least one hotel source is stale, missing, or unavailable.',
          action: { label: 'Retry', onActivate: () => void resource.reload() },
        } : undefined}
      />
      <span
        className={portfolioStyles.visuallyHidden}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {pageAnnouncement}
      </span>
    </>
  );
}
