'use client';

import React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { PortfolioChat } from '@/components/agent/PortfolioChat';
import {
  PortfolioHomeView,
  type PortfolioFilterModel,
  type PortfolioHotelCardData,
  type PortfolioStatus,
} from '@/components/portfolio';
import portfolioStyles from '@/components/portfolio/PortfolioUI.module.css';
import { useAuth } from '@/contexts/AuthContext';
import { usePortfolio } from '@/contexts/PortfolioContext';
import { buildPortfolioHotelSecondaryLabels } from '@/lib/portfolio-ui/context';
import type {
  PortfolioUiCompanyContext,
  PortfolioUiHotel,
  PortfolioUiIndicator,
} from '@/lib/portfolio-ui/contracts';

const PAGE_SIZE = 12;

function firstName(displayName: string | null | undefined): string | undefined {
  return displayName?.trim().split(/\s+/)[0] || undefined;
}

function greeting(name: string | undefined, hour: number): string {
  const suffix = name ? `, ${name}` : '';
  if (hour < 12) return `Good morning${suffix}`;
  if (hour < 18) return `Good afternoon${suffix}`;
  return `Good evening${suffix}`;
}

const INDICATOR_LABELS: Record<string, string> = {
  active_findings: 'Current findings',
  open_findings: 'Open findings',
  critical_findings: 'Critical findings',
  open_work_orders: 'Open work orders',
  urgent_work_orders: 'Urgent work orders',
  occupied_rooms: 'Occupied rooms',
  occupancy_percent: 'Occupancy',
};

function words(value: string): string {
  return INDICATOR_LABELS[value]
    ?? value.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function indicatorValue(indicator: PortfolioUiIndicator): string {
  if (indicator.value === null) return 'Unavailable';
  const prefix = indicator.lowerBound ? 'At least ' : '';
  if (indicator.unit === 'percent') return `${prefix}${Math.round(indicator.value)}%`;
  if (indicator.unit === 'currency_cents') {
    return `${prefix}${new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', maximumFractionDigits: 0,
    }).format(indicator.value / 100)}`;
  }
  return `${prefix}${new Intl.NumberFormat('en-US').format(indicator.value)}`;
}

function hotelStatus(hotel: PortfolioUiHotel): PortfolioStatus {
  if (hotel.status === 'critical') return { label: 'Critical issue', tone: 'critical' };
  if (hotel.status === 'attention') return { label: 'Needs attention', tone: 'warning' };
  if (hotel.status === 'neutral') return { label: 'No current exception', tone: 'neutral' };
  return {
    label: hotel.freshness.state === 'stale' ? 'Data is stale' : 'Status unavailable',
    tone: 'neutral',
  };
}

function shortId(value: string): string {
  return value.replaceAll('-', '').slice(0, 8).toUpperCase();
}

function hotelHref(propertyId: string, organizationId: string, returnTo: string): string {
  const params = new URLSearchParams({ scope: 'hotel', propertyId, organizationId, returnTo });
  return `/home?${params.toString()}`;
}

function statusRank(status: PortfolioUiHotel['status']): number {
  return status === 'critical' ? 0 : status === 'attention' ? 1 : status === 'unknown' ? 2 : 3;
}

function normalizeRegion(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? '';
}

function compareHotelName(
  left: PortfolioUiHotel,
  right: PortfolioUiHotel,
  direction: 1 | -1 = 1,
): number {
  return direction * left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    || left.propertyId.localeCompare(right.propertyId);
}

function focusHomeCollectionHeading(): void {
  window.requestAnimationFrame(() => {
    const heading = document.querySelector<HTMLElement>(
      '[data-view="home"] section[aria-labelledby] h2',
    );
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: false });
    heading.addEventListener('blur', () => heading.removeAttribute('tabindex'), { once: true });
  });
}

function freshnessReason(reason: string | null): string {
  const copy: Record<string, string> = {
    no_recent_finding_run: 'no recent Staxis check',
    finding_runs_unavailable: 'Staxis check history unavailable',
    finding_runs_page_incomplete: 'Staxis check history was incomplete',
    detectors_skipped_or_failed: 'one or more checks did not finish',
    source_record_is_stale: 'source data is stale',
    invalid_source_timestamp: 'source timestamp is invalid',
    no_source_record: 'source has not reported',
  };
  return reason ? copy[reason] ?? reason.replaceAll('_', ' ') : 'data is incomplete';
}

function loadingHome() {
  return (
    <PortfolioHomeView
      context={{ kind: 'portfolio', contextLabel: 'Portfolio', scopeName: 'Loading company…' }}
      greeting="Welcome back"
      dateline="Loading your current portfolio"
      ask={<div className={portfolioStyles.skeletonAsk} aria-hidden="true" />}
      askLabel="Loading Ask Staxis"
      hotelSectionTitle="Your hotels"
      hotels={[]}
      state="loading"
    />
  );
}

export function PortfolioHomeClient() {
  const { user } = useAuth();
  const portfolio = usePortfolio();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [search, setSearch] = React.useState(() => searchParams.get('search') ?? '');
  const [region, setRegion] = React.useState(() => searchParams.get('region') ?? 'all');
  const [status, setStatus] = React.useState(() => searchParams.get('status') ?? 'all');
  const [sort, setSort] = React.useState(() => searchParams.get('sort') ?? 'attention');
  const [viewMode, setViewMode] = React.useState<'grid' | 'list'>(
    searchParams.get('view') === 'list' ? 'list' : 'grid',
  );
  const [page, setPage] = React.useState(() => Math.max(1, Number(searchParams.get('page')) || 1));
  const [pageAnnouncement, setPageAnnouncement] = React.useState('');
  const locationQuery = searchParams.toString();

  const data = portfolio.data;
  const company = data?.selectedCompany ?? null;

  React.useEffect(() => {
    setSearch(searchParams.get('search') ?? '');
    setRegion(searchParams.get('region') ?? 'all');
    setStatus(searchParams.get('status') ?? 'all');
    setSort(searchParams.get('sort') ?? 'attention');
    setViewMode(searchParams.get('view') === 'list' ? 'list' : 'grid');
    setPage(Math.max(1, Number(searchParams.get('page')) || 1));
  }, [locationQuery, searchParams]);

  React.useEffect(() => {
    if (portfolio.loading || portfolio.error || !data) return;
    if (data.selection.state === 'needs_selection') {
      router.replace('/portfolio/choose');
      return;
    }
    if (data.entry.mode === 'hotel') router.replace('/home');
  }, [data, portfolio.error, portfolio.loading, router]);

  const updateLocation = React.useCallback((next: Record<string, string | number | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === '' || value === 'all' || (key === 'page' && value === 1)) params.delete(key);
      else params.set(key, String(value));
    }
    const nextLocation = `${pathname}${params.size ? `?${params.toString()}` : ''}`;
    window.history.replaceState(null, '', nextLocation);
  }, [pathname, searchParams]);

  const setFilter = React.useCallback((key: string, value: string) => {
    if (key === 'search') setSearch(value);
    if (key === 'region') setRegion(value);
    if (key === 'status') setStatus(value);
    if (key === 'sort') setSort(value);
    setPage(1);
    updateLocation({ [key]: value, page: 1 });
  }, [updateLocation]);

  const regions = React.useMemo(() => {
    const labelsByKey = new Map<string, string>();
    for (const hotel of data?.hotels ?? []) {
      const label = hotel.region?.trim();
      if (!label) continue;
      const key = normalizeRegion(label);
      if (!labelsByKey.has(key)) labelsByKey.set(key, label);
    }
    return [...labelsByKey.values()].sort((left, right) => left.localeCompare(right));
  }, [data?.hotels]);
  const resolvedRegion = region === 'all'
    ? 'all'
    : regions.find((candidate) => normalizeRegion(candidate) === normalizeRegion(region)) ?? region;

  const filteredHotels = React.useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    const rows = [...(data?.hotels ?? [])].filter((hotel) => {
      const matchesSearch = !normalizedSearch || [
        hotel.name, hotel.city, hotel.region, hotel.brand, hotel.propertyId,
      ].filter(Boolean).join(' ').toLocaleLowerCase().includes(normalizedSearch);
      const matchesRegion = region === 'all'
        || normalizeRegion(hotel.region) === normalizeRegion(region);
      const matchesStatus = status === 'all'
        || (status === 'attention' ? hotel.status === 'attention' || hotel.status === 'critical' : hotel.status === status);
      return matchesSearch && matchesRegion && matchesStatus;
    });
    rows.sort((left, right) => {
      if (sort === 'name_desc') return compareHotelName(left, right, -1);
      if (sort === 'region') {
        return (normalizeRegion(left.region) || '\uffff').localeCompare(normalizeRegion(right.region) || '\uffff')
          || compareHotelName(left, right);
      }
      if (sort === 'attention') {
        return statusRank(left.status) - statusRank(right.status) || compareHotelName(left, right);
      }
      return compareHotelName(left, right);
    });
    return rows;
  }, [data?.hotels, region, search, sort, status]);

  const pageCount = Math.max(1, Math.ceil(filteredHotels.length / PAGE_SIZE));
  const resolvedPage = Math.min(page, pageCount);
  const pageRows = filteredHotels.slice((resolvedPage - 1) * PAGE_SIZE, resolvedPage * PAGE_SIZE);
  const returnTo = `${pathname}${locationQuery ? `?${locationQuery}` : ''}`;

  if (portfolio.loading || (!data && !portfolio.error)) {
    return loadingHome();
  }

  if (portfolio.error || !data || !company) {
    return (

        <PortfolioHomeView
          context={{ kind: 'portfolio', contextLabel: 'Portfolio', scopeName: 'Unavailable' }}
          greeting="Your portfolio could not be opened"
          dateline="No hotel data is being shown"
          ask={null}
          hotelSectionTitle="Your hotels"
          hotels={[]}
          state="error"
          stateContent={{
            title: 'Portfolio data is unavailable',
            description: portfolio.error ?? 'Your acting company could not be verified.',
            guidance: 'Do not read this as an empty portfolio.',
            action: { label: 'Try again', onActivate: () => void portfolio.reload() },
          }}
        />

    );
  }

  const filters: PortfolioFilterModel = {
    search: {
      value: search, label: 'Search hotels', placeholder: 'Name, city, region, or hotel ID',
      onChange: (value) => setFilter('search', value),
    },
    region: {
      value: resolvedRegion, label: 'Region',
      options: [{ value: 'all', label: 'All regions' }, ...regions.map((value) => ({ value, label: value }))],
      onChange: (value) => setFilter('region', value),
    },
    status: {
      value: status, label: 'Status',
      options: [
        { value: 'all', label: 'All statuses' },
        { value: 'attention', label: 'Needs attention' },
        { value: 'critical', label: 'Critical' },
        { value: 'neutral', label: 'No current exception' },
        { value: 'unknown', label: 'Unknown or stale' },
      ],
      onChange: (value) => setFilter('status', value),
    },
    sort: {
      value: sort, label: 'Sort',
      options: [
        { value: 'attention', label: 'Attention first' },
        { value: 'name', label: 'Name A–Z' },
        { value: 'name_desc', label: 'Name Z–A' },
        { value: 'region', label: 'Region' },
      ],
      onChange: (value) => setFilter('sort', value),
    },
    viewMode: {
      value: viewMode, label: 'View', gridLabel: 'Grid', listLabel: 'List',
      onChange: (value) => { setViewMode(value); updateLocation({ view: value }); },
    },
    resultSummary: `${filteredHotels.length} of ${data.coverage.total} authorized ${data.coverage.total === 1 ? 'hotel' : 'hotels'}`,
    clearAction: search || region !== 'all' || status !== 'all' || sort !== 'attention'
      ? {
          label: 'Clear filters',
          onActivate: () => {
            setSearch(''); setRegion('all'); setStatus('all'); setSort('attention'); setPage(1);
            updateLocation({ search: null, region: null, status: null, sort: null, page: null });
          },
        }
      : undefined,
  };

  const hotelSecondaryLabels = buildPortfolioHotelSecondaryLabels(data.hotels);
  const cards: PortfolioHotelCardData[] = pageRows.map((hotel) => ({
    id: hotel.propertyId,
    name: hotel.name,
    secondaryLabel: hotelSecondaryLabels[hotel.propertyId],
    description: hotel.freshness.reason ? freshnessReason(hotel.freshness.reason) : undefined,
    regionKey: hotel.region ?? undefined,
    regionLabel: hotel.region ?? undefined,
    status: hotelStatus(hotel),
    facts: hotel.indicators.slice(0, 2).map((indicator) => ({
      label: words(indicator.key), value: indicatorValue(indicator),
      emphasis: indicator.tone === 'critical' || indicator.tone === 'warning',
    })),
    drilldown: {
      label: `Open ${hotel.name}`,
      ariaLabel: `Open hotel view for ${hotel.name}, ${hotelSecondaryLabels[hotel.propertyId]}`,
      href: hotelHref(hotel.propertyId, company.organizationId, returnTo),
    },
  }));

  const today = new Date();
  const dateLabel = today.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  const attentionCount = data.hotels.filter((hotel) => hotel.status === 'attention' || hotel.status === 'critical').length;
  const unknownCount = data.hotels.filter((hotel) => hotel.status === 'unknown').length;
  const incompletePortfolio = data.partial || data.coverage.omitted > 0;
  const partialIds = data.missingPropertyIds.map(shortId);
  const partialHotels = data.hotels
    .filter((hotel) => hotel.partial)
    .map((hotel) => `${hotel.name} (${shortId(hotel.propertyId)}): ${freshnessReason(hotel.freshness.reason)}`);
  const partialDescription = [
    partialIds.length > 0 ? `Hotels omitted because their property records could not be read: ${partialIds.join(', ')}.` : null,
    partialHotels.length > 0 ? `Incomplete hotel sources: ${partialHotels.join('; ')}.` : null,
  ].filter(Boolean).join(' ');
  const noFilterMatches = data.hotels.length > 0 && filteredHotels.length === 0;
  const allHotelRowsUnavailable = data.coverage.total > 0 && data.hotels.length === 0;
  const trueEmptyPortfolio = data.coverage.total === 0;

  return (
    <>
      <PortfolioHomeView
        context={{
          kind: 'portfolio',
          contextLabel: 'Portfolio',
          scopeName: company.organizationName ?? 'Your company',
          secondaryLabel: `${company.hotelCount} authorized ${company.hotelCount === 1 ? 'hotel' : 'hotels'}`,
          switchAction: { label: 'Switch context', href: `/portfolio/choose?organizationId=${encodeURIComponent(company.organizationId)}` },
        }}
        greeting={greeting(firstName(user?.displayName), today.getHours())}
        dateline={`${dateLabel} · Portfolio · ${company.organizationName ?? 'Company'}`}
        ask={(
          <PortfolioChat
            key={company.organizationId}
            organizationId={company.organizationId}
            organizationName={company.organizationName ?? 'this company'}
            available={company.chat.state === 'available' && company.capabilities.canAskStaxis}
            unavailableReason={company.chat.reason}
          />
        )}
        askLabel={`Ask Staxis across ${company.organizationName ?? 'your portfolio'}`}
        statusCard={trueEmptyPortfolio ? {
          eyebrow: 'Staxis command center',
          title: 'No hotels to summarize',
          description: 'This company context is valid, but no authorized hotels are available for an operational summary.',
          status: { label: 'No hotel data', tone: 'neutral' },
          signals: [
            { id: 'authorized', label: 'Authorized hotels', value: '0', tone: 'neutral' },
            { id: 'coverage', label: 'Operational summary', value: 'Unavailable', tone: 'neutral' },
          ],
          asOfLabel: `Checked ${new Date(data.generatedAt).toLocaleString('en-US')}`,
          action: {
            label: 'Review My Portfolio',
            href: `/company?scope=portfolio&organizationId=${encodeURIComponent(company.organizationId)}`,
          },
        } : {
          eyebrow: 'Staxis command center',
          title: attentionCount > 0 ? `${attentionCount} ${attentionCount === 1 ? 'hotel needs' : 'hotels need'} a look` : 'Portfolio watchlist',
          description: attentionCount > 0
            ? 'Review current exceptions, evidence, owners, approvals, and follow-up in one queue.'
            : incompletePortfolio || unknownCount > 0
              ? 'No exception is being claimed for hotels with unavailable or stale data.'
              : 'Open the company queue for current findings and follow-up.',
          status: attentionCount > 0
            ? { label: 'Needs attention', tone: 'warning' }
            : incompletePortfolio || unknownCount > 0
              ? { label: 'Partial data', tone: 'neutral' }
              : { label: 'Current', tone: 'neutral' },
          signals: [
            {
              id: 'attention', label: 'Hotels needing attention',
              value: incompletePortfolio ? (attentionCount > 0 ? `At least ${attentionCount}` : 'Unavailable') : String(attentionCount),
              tone: attentionCount ? 'warning' : 'neutral',
            },
            {
              id: 'unknown', label: 'Unknown, stale, or omitted',
              value: String(unknownCount + data.coverage.omitted),
              tone: unknownCount + data.coverage.omitted > 0 ? 'warning' : 'neutral',
            },
          ],
          asOfLabel: `Generated ${new Date(data.generatedAt).toLocaleString('en-US')}`,
          action: company.queueAvailable ? {
            label: 'Open Staxis',
            href: `/portfolio/staxis?organizationId=${encodeURIComponent(company.organizationId)}`,
          } : {
            label: 'Review My Portfolio',
            href: `/company?scope=portfolio&organizationId=${encodeURIComponent(company.organizationId)}`,
          },
        }}
        hotelSectionTitle="Your hotels"
        hotelSectionDescription="Current exceptions and facts, without a manufactured score."
        hotels={cards}
        filters={filters}
        collectionEmptyContent={noFilterMatches ? {
          title: 'No hotels match these filters',
          description: 'The authorized portfolio is still available.',
          guidance: 'Clear or adjust a filter to see other hotels.',
        } : allHotelRowsUnavailable ? {
          title: 'Hotel rows could not be loaded',
          description: 'The company context is valid, but its authorized hotels are omitted from this response.',
          guidance: 'This is not an empty portfolio. Retry before drawing any operational conclusion.',
          action: { label: 'Retry', onActivate: () => void portfolio.reload() },
        } : undefined}
        pagination={pageCount > 1 ? {
          page: resolvedPage,
          pageCount,
          summary: `Page ${resolvedPage} of ${pageCount}`,
          previousLabel: 'Previous hotels',
          nextLabel: 'Next hotels',
          pageLabel: 'Hotel page',
          onPageChange: (next) => {
            setPage(next);
            updateLocation({ page: next });
            setPageAnnouncement(`Showing hotel page ${next} of ${pageCount}.`);
            focusHomeCollectionHeading();
          },
        } : undefined}
        portfolioAction={{
          label: 'My Portfolio',
          href: `/company?scope=portfolio&organizationId=${encodeURIComponent(company.organizationId)}`,
        }}
        portfolioDescription="Hotels, People, and Access"
        state={trueEmptyPortfolio ? 'empty' : incompletePortfolio ? 'partial' : 'ready'}
        stateContent={trueEmptyPortfolio ? {
          title: 'No hotels are in this portfolio yet',
          description: 'The company context is valid, but it currently has no authorized hotels.',
          guidance: 'This is different from a failed data read.',
        } : incompletePortfolio ? {
          title: 'Some hotel data is unavailable',
          description: partialDescription || 'At least one source could not provide a complete response.',
          action: { label: 'Retry', onActivate: () => void portfolio.reload() },
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
