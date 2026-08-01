'use client';

export const dynamic = 'force-dynamic';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  BedDouble,
  Building2,
  Database,
  GitBranch,
  RefreshCw,
  Search,
  Server,
  TriangleAlert,
  Users,
} from 'lucide-react';

import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { DataAtlasPayload } from '@/lib/admin-data-atlas';
import { APP_SECTIONS } from '@/lib/sections/registry';
import {
  FONT_SERIF,
  age,
} from '@/app/admin/_components/studio/kit';
import {
  DarkCard,
  DarkEmpty,
  DarkScope,
  DarkSpinner,
  SurfaceShell,
} from '@/app/admin/_components/studio/surface-kit';

import '@/app/admin/_components/studio/studio.css';
import styles from './DataAtlas.module.css';

const AUTO_REFRESH_MS = 60_000;

type HealthTone = 'good' | 'info' | 'warning' | 'bad' | 'muted';

type DataAtlasSnapshot = DataAtlasPayload;
type HotelReportSnapshot = DataAtlasPayload['hotels'][number]['report'];
type AtlasService = DataAtlasPayload['services'][number];

interface SystemServiceStatus {
  status: 'green' | 'yellow' | 'red';
  latency_ms?: number;
  message?: string;
}

interface SystemStatusSnapshot {
  generated_at: string;
  services: {
    web: SystemServiceStatus;
    ml: SystemServiceStatus;
    cua: SystemServiceStatus;
    supabase: SystemServiceStatus;
  };
}

type DisplayService = Omit<AtlasService, 'status'> & {
  status: string;
  live: boolean;
  latencyMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function apiErrorMessage(payload: unknown, status: number): string {
  if (isRecord(payload)) {
    const error = payload.error;
    if (typeof error === 'string' && error.trim()) return error;
    if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
      return error.message;
    }
  }
  return `The Database Atlas could not be loaded (${status}).`;
}

function isAtlasSnapshot(value: unknown): value is DataAtlasSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.generatedAt === 'string'
    && isRecord(value.schema)
    && isRecord(value.overview)
    && Array.isArray(value.hotels)
    && Array.isArray(value.domains)
    && isRecord(value.migrations);
}

function isSystemStatusSnapshot(value: unknown): value is SystemStatusSnapshot {
  return isRecord(value)
    && typeof value.generated_at === 'string'
    && isRecord(value.services)
    && isRecord(value.services.web)
    && isRecord(value.services.ml)
    && isRecord(value.services.supabase);
}

function titleCase(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  return value
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusLabel(status: string | null | undefined): string {
  switch ((status ?? '').toLowerCase()) {
    case 'green':
    case 'healthy':
      return 'Healthy';
    case 'yellow':
    case 'attention':
      return 'Needs attention';
    case 'red':
      return 'Problem';
    case 'learning':
      return 'Learning';
    case 'no_expectations':
      return 'Not expected';
    case 'unavailable':
      return 'Unavailable';
    case 'available':
      return 'Available';
    case 'past_due':
      return 'Past due';
    default:
      return titleCase(status);
  }
}

function toneFor(status: string | null | undefined): HealthTone {
  switch ((status ?? '').toLowerCase()) {
    case 'green':
    case 'healthy':
    case 'available':
    case 'active':
    case 'ready':
    case 'current':
    case 'live':
    case 'ok':
      return 'good';
    case 'learning':
    case 'setup':
      return 'info';
    case 'yellow':
    case 'attention':
    case 'trial':
    case 'late':
    case 'stale':
    case 'pending':
    case 'degraded':
      return 'warning';
    case 'red':
    case 'error':
    case 'failed':
    case 'past_due':
    case 'offline':
    case 'missing':
    case 'blocked':
      return 'bad';
    default:
      return 'muted';
  }
}

function formatCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value).toLocaleString('en-US')
    : '—';
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Not recorded';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function ageLabel(value: string | null | undefined): string {
  if (!value) return 'No signal yet';
  const result = age(value);
  return result === '—' ? 'Time unknown' : `${result} ago`;
}

function reportSummary(report: HotelReportSnapshot | null): string {
  if (!report) return 'No report status returned';
  if (report.state === 'no_expectations') return 'No scheduled feed is expected';
  if (report.state === 'learning') return 'Staxis is learning this report format';
  if (report.state === 'unavailable') return 'Scheduled feeds are turned off for this hotel';
  if (report.state === 'unknown') return 'Report status could not be checked';
  if (typeof report.minutesLate === 'number' && report.minutesLate > 0) {
    return `${formatCount(report.minutesLate)}m late · ${formatCount(report.feedCount)} scheduled feeds`;
  }
  if (report.lastSignalAt) {
    return `${ageLabel(report.lastSignalAt)} · ${formatCount(report.feedCount)} scheduled feeds`;
  }
  return `${formatCount(report.feedCount)} scheduled feeds`;
}

function friendlyLiveSummary(kind: 'web' | 'database' | 'ml', status: string): string {
  const tone = toneFor(status);
  if (kind === 'web') {
    return tone === 'good' ? 'The Staxis website is responding.' : 'The website check found something to look at.';
  }
  if (kind === 'database') {
    return tone === 'good' ? 'The Staxis database is responding.' : 'The database check found something to look at.';
  }
  return tone === 'good' ? 'The prediction service is responding.' : 'The prediction service needs attention.';
}

function friendlyAtlasSummary(service: AtlasService): string {
  if (service.id === 'admin-api') return 'This page reached the Staxis backend successfully.';
  return service.summary;
}

function mergeServices(
  atlasServices: AtlasService[] | undefined,
  system: SystemStatusSnapshot | null,
): DisplayService[] {
  const result: DisplayService[] = (atlasServices ?? []).map((service) => ({
    ...service,
    summary: friendlyAtlasSummary(service),
    live: false,
  }));
  if (!system) return result;

  const liveServices: Array<DisplayService & { aliases: string[] }> = [
    {
      id: 'web',
      aliases: ['web', 'app', 'vercel', 'admin-api'],
      label: 'Web app',
      summary: friendlyLiveSummary('web', system.services.web.status),
      status: system.services.web.status,
      latencyMs: system.services.web.latency_ms,
      live: true,
    },
    {
      id: 'database',
      aliases: ['database', 'supabase'],
      label: 'Database',
      summary: friendlyLiveSummary('database', system.services.supabase.status),
      status: system.services.supabase.status,
      latencyMs: system.services.supabase.latency_ms,
      live: true,
    },
    {
      id: 'ml',
      aliases: ['ml', 'ml_service', 'machine_learning'],
      label: 'Predictions',
      summary: friendlyLiveSummary('ml', system.services.ml.status),
      status: system.services.ml.status,
      latencyMs: system.services.ml.latency_ms,
      live: true,
    },
  ];

  liveServices.forEach(({ aliases, ...liveService }) => {
    const index = result.findIndex((service) => aliases.includes(service.id.toLowerCase()));
    if (index === -1) result.push(liveService);
    else result[index] = { ...result[index], ...liveService, id: result[index].id };
  });
  return result;
}

function toneClass(tone: HealthTone): string {
  if (tone === 'good') return styles.statusGood;
  if (tone === 'info') return styles.statusInfo;
  if (tone === 'warning') return styles.statusWarning;
  if (tone === 'bad') return styles.statusBad;
  return styles.statusMuted;
}

function StatusBadge({ status, label }: { status: string | null | undefined; label?: string }) {
  const tone = toneFor(status);
  return (
    <span className={`${styles.statusBadge} ${toneClass(tone)}`}>
      <span className={styles.statusDot} aria-hidden="true" />
      {label ?? statusLabel(status)}
    </span>
  );
}

function SummaryCard({
  label,
  value,
  note,
  icon,
  tone = 'muted',
}: {
  label: string;
  value: number | null | undefined;
  note: string;
  icon: React.ReactNode;
  tone?: HealthTone;
}) {
  return (
    <DarkCard style={{ minHeight: 132, padding: '16px 18px' }}>
      <div className={styles.summaryCard}>
        <div className={`${styles.summaryIcon} ${toneClass(tone)}`} aria-hidden="true">{icon}</div>
        <dl>
          <dt>{label}</dt>
          <dd style={{ fontFamily: FONT_SERIF }}>{formatCount(value)}</dd>
        </dl>
        <p>{note}</p>
      </div>
    </DarkCard>
  );
}

export default function DataAtlasPage() {
  const { user, loading: authLoading } = useAuth();
  const [snapshot, setSnapshot] = useState<DataAtlasSnapshot | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatusSnapshot | null>(null);
  const [systemCheckUnavailable, setSystemCheckUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);

    const atlasRequest = fetchWithAuth('/api/admin/data-atlas', {
      cache: 'no-store',
      signal: controller.signal,
    }).then(async (response) => ({
      response,
      payload: await response.json().catch(() => null) as unknown,
    }));
    const systemRequest = fetchWithAuth('/api/admin/system-status', {
      cache: 'no-store',
      signal: controller.signal,
    }).then(async (response) => ({
      response,
      payload: await response.json().catch(() => null) as unknown,
    }));

    try {
      const [atlasResult, systemResult] = await Promise.allSettled([
        atlasRequest,
        systemRequest,
      ]);
      if (requestRef.current !== requestId) return;

      if (atlasResult.status === 'rejected') throw atlasResult.reason;
      const atlasEnvelope = atlasResult.value;
      const atlasPayload = atlasEnvelope.payload;
      if (
        !atlasEnvelope.response.ok
        || !isRecord(atlasPayload)
        || atlasPayload.ok !== true
        || !isAtlasSnapshot(atlasPayload.data)
      ) {
        throw new Error(apiErrorMessage(atlasPayload, atlasEnvelope.response.status));
      }
      setSnapshot(atlasPayload.data);

      if (
        systemResult.status === 'fulfilled'
        && systemResult.value.response.ok
        && isSystemStatusSnapshot(systemResult.value.payload)
      ) {
        setSystemStatus(systemResult.value.payload);
        setSystemCheckUnavailable(false);
      } else {
        setSystemStatus(null);
        setSystemCheckUnavailable(true);
      }
    } catch (caught) {
      if (controller.signal.aborted || requestRef.current !== requestId) return;
      setError(caught instanceof Error ? caught.message : 'The Database Atlas could not be loaded.');
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading || user?.role !== 'admin') return undefined;
    void load();
    const interval = window.setInterval(() => { void load(); }, AUTO_REFRESH_MS);
    return () => {
      window.clearInterval(interval);
      abortRef.current?.abort();
    };
  }, [authLoading, load, user?.role]);

  const filteredHotels = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('en-US');
    if (!normalized) return snapshot?.hotels ?? [];
    return (snapshot?.hotels ?? []).filter((hotel) => (
      `${hotel.name ?? ''} ${hotel.id} ${hotel.subscriptionStatus ?? ''}`
        .toLocaleLowerCase('en-US')
        .includes(normalized)
    ));
  }, [query, snapshot?.hotels]);

  const domainSnapshots = useMemo(
    () => new Map((snapshot?.domains ?? []).map((domain) => [domain.id, domain])),
    [snapshot?.domains],
  );
  const services = useMemo(
    () => mergeServices(snapshot?.services, systemStatus),
    [snapshot?.services, systemStatus],
  );

  const initialLoading = authLoading || (loading && snapshot === null && error === null);
  const accessDenied = !authLoading && user?.role !== 'admin';

  return (
    <AppLayout>
      <DarkScope>
        <SurfaceShell glow="tealTL" style={{ padding: '24px clamp(16px, 3vw, 32px) 56px' }}>
          <main className={styles.page} aria-labelledby="atlas-title">
            <Link href="/admin/properties#live" className={styles.backLink}>
              <ArrowLeft size={14} aria-hidden="true" /> Back to Hotels
            </Link>

            <header className={styles.header}>
              <div className={styles.headerCopy}>
                <span className={styles.eyebrow}>Admin · Live backend view</span>
                <div className={styles.titleRow}>
                  <Database size={27} strokeWidth={1.7} aria-hidden="true" />
                  <h1 id="atlas-title">Database <em>Atlas</em></h1>
                </div>
                <p>
                  A simple, read-only window into what Staxis stores and what is happening behind the app.
                </p>
                <div className={styles.headerBadges} aria-label="Atlas behavior">
                  <StatusBadge
                    status={error ? (snapshot ? 'attention' : 'unavailable') : snapshot ? 'live' : 'unknown'}
                    label={error ? (snapshot ? 'Showing last snapshot' : 'Database unavailable') : snapshot ? 'Live database' : 'Checking database'}
                  />
                  <span className={styles.readOnlyBadge}>Read-only controls · this page cannot edit hotel data</span>
                </div>
              </div>
              <div className={styles.refreshArea}>
                <button
                  type="button"
                  className={styles.refreshButton}
                  onClick={() => { void load(); }}
                  disabled={loading || accessDenied}
                  aria-busy={loading}
                >
                  <RefreshCw className={loading ? styles.spinning : undefined} size={15} aria-hidden="true" />
                  {loading && snapshot ? 'Refreshing…' : 'Refresh now'}
                </button>
                <p aria-live="polite">
                  {snapshot
                    ? `Updated ${ageLabel(snapshot.generatedAt)} · refreshes every minute`
                    : 'Refreshes automatically every minute'}
                </p>
              </div>
            </header>

            {accessDenied ? (
              <div className={styles.errorPanel} role="alert">
                <TriangleAlert size={20} aria-hidden="true" />
                <div>
                  <strong>Admin access only</strong>
                  <p>This backend view is only available to the Staxis platform administrator.</p>
                </div>
              </div>
            ) : error && snapshot === null ? (
              <div className={styles.errorPanel} role="alert">
                <TriangleAlert size={20} aria-hidden="true" />
                <div>
                  <strong>The Atlas could not load</strong>
                  <p>{error}</p>
                  <button type="button" onClick={() => { void load(); }}>Try again</button>
                </div>
              </div>
            ) : initialLoading ? (
              <LoadingAtlas />
            ) : snapshot ? (
              <>
                {error ? (
                  <div className={styles.inlineWarning} role="alert">
                    The latest refresh failed. The page is still showing the last successful snapshot. {error}
                  </div>
                ) : null}

                <section className={styles.section} aria-labelledby="atlas-overview-title">
                  <SectionHeading
                    id="atlas-overview-title"
                    eyebrow="Right now"
                    title="Staxis at a glance"
                    description="These numbers come from the live database, so a new hotel appears here automatically."
                  />
                  <div className={styles.summaryGrid}>
                    <SummaryCard
                      label="Hotels"
                      value={snapshot.overview.hotels}
                      note={`${formatCount(snapshot.overview.organizations)} organizations`}
                      icon={<Building2 size={20} />}
                      tone="info"
                    />
                    <SummaryCard
                      label="Rooms configured"
                      value={snapshot.overview.roomsConfigured}
                      note="Rooms set up across every hotel"
                      icon={<BedDouble size={20} />}
                      tone="good"
                    />
                    <SummaryCard
                      label="Active people"
                      value={snapshot.overview.activeStaff}
                      note="Active hotel staff records"
                      icon={<Users size={20} />}
                      tone="good"
                    />
                    <SummaryCard
                      label="Warnings"
                      value={snapshot.overview.warnings.length}
                      note={snapshot.overview.warnings.length === 0 ? 'No Atlas data warnings in this snapshot' : 'Items worth looking at'}
                      icon={<TriangleAlert size={20} />}
                      tone={snapshot.overview.warnings.length === 0 ? 'good' : 'warning'}
                    />
                  </div>
                  {snapshot.overview.warnings.length > 0 ? (
                    <div className={styles.overviewWarnings} role="status">
                      <strong>What needs attention</strong>
                      <ul>
                        {snapshot.overview.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                      </ul>
                    </div>
                  ) : null}
                </section>

                <section className={styles.section} aria-labelledby="atlas-hotels-title">
                  <div className={styles.sectionHeadingWithTool}>
                    <SectionHeading
                      id="atlas-hotels-title"
                      eyebrow="Live hotel catalog"
                      title="Every hotel"
                      description="One row per hotel, with the useful backend facts translated into normal language."
                    />
                    <label className={styles.searchField}>
                      <span>Search hotels</span>
                      <span className={styles.searchInputWrap}>
                        <Search size={15} aria-hidden="true" />
                        <input
                          type="search"
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                          placeholder="Hotel name"
                          aria-describedby="atlas-hotel-results"
                        />
                      </span>
                    </label>
                  </div>
                  <p id="atlas-hotel-results" className={styles.resultCount} aria-live="polite">
                    Showing {formatCount(filteredHotels.length)} of {formatCount(snapshot.hotels.length)} hotels
                  </p>

                  {snapshot.hotels.length === 0 ? (
                    <div role="status"><DarkEmpty text="No hotels have been added yet." /></div>
                  ) : filteredHotels.length === 0 ? (
                    <div role="status"><DarkEmpty text={`No hotels match “${query.trim()}”.`} /></div>
                  ) : (
                    <div className={styles.tableScroller} role="region" aria-label="Hotel backend status" tabIndex={0}>
                      <table className={styles.hotelTable}>
                        <caption className={styles.srOnly}>Live backend status for every Staxis hotel</caption>
                        <thead>
                          <tr>
                            <th scope="col">Hotel</th>
                            <th scope="col">Rooms</th>
                            <th scope="col">People</th>
                            <th scope="col">Product</th>
                            <th scope="col">Scheduled feeds</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredHotels.map((hotel) => {
                            const warnings = hotel.report?.warnings ?? [];
                            return (
                              <tr key={hotel.id}>
                                <td data-label="Hotel">
                                  <Link href={`/admin/properties/${encodeURIComponent(hotel.id)}`} className={styles.hotelLink}>
                                    {hotel.name?.trim() || '(unnamed hotel)'}
                                  </Link>
                                  <span className={styles.cellMeta}>
                                    <StatusBadge status={hotel.subscriptionStatus} />
                                    <StatusBadge
                                      status={hotel.onboardingCompleted ? 'ready' : 'pending'}
                                      label={hotel.onboardingCompleted ? 'Ready' : 'Onboarding'}
                                    />
                                  </span>
                                </td>
                                <td data-label="Rooms">
                                  <strong className={styles.numeric}>{formatCount(hotel.totalRooms)}</strong>
                                  <span className={styles.cellSubtext}>configured</span>
                                </td>
                                <td data-label="People">
                                  <strong className={styles.numeric}>{formatCount(hotel.activeStaff)}</strong>
                                  <span className={styles.cellSubtext}>active staff</span>
                                </td>
                                <td data-label="Product">
                                  <strong className={styles.numeric}>{formatCount(hotel.enabledSectionCount)}</strong>
                                  <span className={styles.cellSubtext}>of {APP_SECTIONS.length} app areas on</span>
                                </td>
                                <td data-label="Scheduled feeds">
                                  <StatusBadge
                                    status={hotel.report?.state ?? 'unavailable'}
                                    label={hotel.report?.state === 'unavailable' ? 'Feeds off' : undefined}
                                  />
                                  <span className={styles.cellSubtext}>{reportSummary(hotel.report)}</span>
                                  {warnings.length > 0 ? (
                                    <span className={styles.warningText} title={warnings.join('\n')}>
                                      {warnings[0]}{warnings.length > 1 ? ` · +${warnings.length - 1} more` : ''}
                                    </span>
                                  ) : null}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                <section className={styles.section} aria-labelledby="atlas-data-title">
                  <SectionHeading
                    id="atlas-data-title"
                    eyebrow="The filing cabinets"
                    title="How the data is organized"
                    description={`${formatCount(snapshot.schema.tableCount)} database tables, grouped by what they do. Open a group only when you want the technical names.`}
                  />
                  <p className={styles.schemaNote}>
                    These are safety-setting counts, not a full security score. Some behind-the-scenes tables are intentionally hidden from everyone using the browser.
                  </p>
                  {snapshot.schema.domains.length === 0 ? (
                    <div role="status"><DarkEmpty text="The database groups could not be listed." /></div>
                  ) : (
                    <div className={styles.domainGrid}>
                      {snapshot.schema.domains.map((domain) => {
                        const liveDomain = domainSnapshots.get(domain.id);
                        const security = domain.security;
                        return (
                          <article className={styles.domainCard} key={domain.id}>
                            <div className={styles.domainTopline}>
                              <div>
                                <h3>{domain.label}</h3>
                                <p>{liveDomain?.description || domain.purpose}</p>
                              </div>
                              <StatusBadge status={liveDomain?.status ?? 'unavailable'} />
                            </div>
                            <dl className={styles.domainFacts}>
                              <div><dt>Tables</dt><dd>{formatCount(domain.tables.length)}</dd></div>
                              <div><dt>Data guard on</dt><dd>{formatCount(security?.rlsEnabled)}</dd></div>
                              <div><dt>Tables with rules</dt><dd>{formatCount(security?.withPolicies)}</dd></div>
                              <div><dt>Recognized tenant key</dt><dd>{formatCount(security?.directTenantColumn)}</dd></div>
                            </dl>
                            <details className={styles.tableDetails}>
                              <summary>Show technical table names</summary>
                              {domain.tables.length > 0 ? (
                                <ul>
                                  {domain.tables.map((table) => <li key={table}>{table}</li>)}
                                </ul>
                              ) : (
                                <p>No table names were returned for this group.</p>
                              )}
                            </details>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className={styles.section} aria-labelledby="atlas-systems-title">
                  <SectionHeading
                    id="atlas-systems-title"
                    eyebrow="The machinery"
                    title="Systems and database history"
                    description="Quick checks for the main services Staxis depends on, plus the database change receipt book."
                  />

                  {systemCheckUnavailable ? (
                    <div className={styles.inlineNotice} role="status">
                      The live system ping is unavailable. Service cards below use the Atlas snapshot when one exists.
                    </div>
                  ) : null}

                  <div className={styles.systemGrid}>
                    <div className={styles.servicesPanel}>
                      <div className={styles.panelTitle}>
                        <Server size={17} aria-hidden="true" />
                        <h3>Live systems</h3>
                      </div>
                      {services.length === 0 ? (
                        <DarkEmpty text="System checks are unavailable right now." />
                      ) : (
                        <ul className={styles.serviceList}>
                          {services.map((service) => (
                            <li key={service.id}>
                              <div>
                                <strong>{service.label}</strong>
                                <p>{service.summary}</p>
                              </div>
                              <div className={styles.serviceStatus}>
                                <StatusBadge status={service.status} />
                                {service.live && typeof service.latencyMs === 'number' ? (
                                  <span>{formatCount(service.latencyMs)}ms</span>
                                ) : null}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <article className={styles.migrationPanel}>
                      <div className={styles.panelTitle}>
                        <GitBranch size={17} aria-hidden="true" />
                        <h3>Database change history</h3>
                      </div>
                      <StatusBadge
                        status={snapshot.migrations.status}
                        label={snapshot.migrations.status === 'available' ? 'History available' : 'History unavailable'}
                      />
                      <dl className={styles.migrationFacts}>
                        <div>
                          <dt>Changes recorded</dt>
                          <dd>{formatCount(snapshot.migrations.appliedCount)}</dd>
                        </div>
                        <div>
                          <dt>Latest version</dt>
                          <dd>{snapshot.migrations.latestVersion || 'Not recorded'}</dd>
                        </div>
                        <div>
                          <dt>Latest recorded change</dt>
                          <dd>{formatDateTime(snapshot.migrations.latestAppliedAt)}</dd>
                        </div>
                      </dl>
                      <p className={styles.ledgerNote}>
                        Think of this as a receipt book. It shows recorded database changes; it does not claim that no code file is waiting to be applied.
                      </p>
                    </article>
                  </div>
                </section>
              </>
            ) : null}
          </main>
        </SurfaceShell>
      </DarkScope>
    </AppLayout>
  );
}

function SectionHeading({
  id,
  eyebrow,
  title,
  description,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className={styles.sectionHeading}>
      <span>{eyebrow}</span>
      <h2 id={id}>{title}</h2>
      <p>{description}</p>
    </div>
  );
}

function LoadingAtlas() {
  return (
    <div className={styles.loadingState} role="status" aria-live="polite">
      <DarkSpinner size={24} />
      <span>Reading the live Staxis backend…</span>
      <div className={styles.skeletonGrid} aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => <span key={index} />)}
      </div>
    </div>
  );
}
