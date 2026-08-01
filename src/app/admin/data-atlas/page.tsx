'use client';

export const dynamic = 'force-dynamic';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, Search, TriangleAlert } from 'lucide-react';

import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { DataAtlasPayload } from '@/lib/admin-data-atlas';
import { age } from '@/app/admin/_components/studio/kit';
import {
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
type AtlasService = DataAtlasPayload['services'][number];

interface SystemServiceStatus {
  status: 'green' | 'yellow' | 'red';
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

interface DisplayService {
  id: 'web' | 'database' | 'predictions';
  label: string;
  status: string;
}

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
  return 'The Database Atlas could not be loaded (' + status + ').';
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
    case 'live':
      return 'Healthy';
    case 'yellow':
    case 'attention':
      return 'Attention';
    case 'red':
      return 'Down';
    case 'setup':
      return 'Setup';
    case 'retired':
      return 'Off';
    case 'past_due':
      return 'Past due';
    default:
      return titleCase(status);
  }
}

function feedLabel(status: string | null | undefined): string {
  switch ((status ?? '').toLowerCase()) {
    case 'live':
      return 'Current';
    case 'stale':
      return 'Late';
    case 'learning':
      return 'Learning';
    case 'no_expectations':
      return 'No feeds';
    case 'unavailable':
      return 'Off';
    default:
      return 'Unknown';
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

function ageLabel(value: string | null | undefined): string {
  if (!value) return 'unknown';
  const result = age(value);
  return result === '—' ? 'unknown' : result + ' ago';
}

function atlasStatus(services: AtlasService[] | undefined, aliases: string[]): string {
  return services?.find((service) => aliases.includes(service.id.toLowerCase()))?.status ?? 'unknown';
}

function servicesFor(
  atlasServices: AtlasService[] | undefined,
  system: SystemStatusSnapshot | null,
): DisplayService[] {
  return [
    {
      id: 'web',
      label: 'Web app',
      status: system?.services.web.status ?? atlasStatus(atlasServices, ['web', 'app', 'vercel', 'admin-api']),
    },
    {
      id: 'database',
      label: 'Database',
      status: system?.services.supabase.status ?? atlasStatus(atlasServices, ['database', 'supabase']),
    },
    {
      id: 'predictions',
      label: 'Predictions',
      status: system?.services.ml.status ?? atlasStatus(atlasServices, ['ml', 'ml_service', 'machine_learning']),
    },
  ];
}

function toneClass(tone: HealthTone): string {
  if (tone === 'good') return styles.statusGood;
  if (tone === 'info') return styles.statusInfo;
  if (tone === 'warning') return styles.statusWarning;
  if (tone === 'bad') return styles.statusBad;
  return styles.statusMuted;
}

function StatusBadge({
  status,
  label,
}: {
  status: string | null | undefined;
  label?: string;
}) {
  return (
    <span className={styles.statusBadge + ' ' + toneClass(toneFor(status))}>
      <span className={styles.statusDot} aria-hidden="true" />
      {label ?? statusLabel(status)}
    </span>
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
      (hotel.name + ' ' + hotel.id + ' ' + hotel.subscriptionStatus)
        .toLocaleLowerCase('en-US')
        .includes(normalized)
    ));
  }, [query, snapshot?.hotels]);

  const services = useMemo(
    () => servicesFor(snapshot?.services, systemStatus),
    [snapshot?.services, systemStatus],
  );

  const initialLoading = authLoading || (loading && snapshot === null && error === null);
  const accessDenied = !authLoading && user?.role !== 'admin';
  const pageStatus = accessDenied
    ? 'unavailable'
    : error ? (snapshot ? 'stale' : 'unavailable') : snapshot ? 'live' : 'unknown';
  const pageStatusLabel = accessDenied
    ? 'Admin only'
    : error ? (snapshot ? 'Stale' : 'Unavailable') : snapshot ? 'Live' : 'Loading';
  const isFiltering = query.trim().length > 0;

  return (
    <AppLayout>
      <DarkScope>
        <SurfaceShell glow="tealTL" style={{ padding: '24px clamp(16px, 3vw, 32px) 56px' }}>
          <main className={styles.page} aria-labelledby="atlas-title">
            <header className={styles.header}>
              <div className={styles.heading}>
                <Link href="/admin/properties#live" className={styles.backLink}>
                  <ArrowLeft size={15} aria-hidden="true" />
                  Hotels
                </Link>
                <h1 id="atlas-title">Database Atlas</h1>
              </div>
              <div className={styles.headerActions}>
                <div className={styles.liveMeta} aria-live="polite">
                  <StatusBadge status={pageStatus} label={pageStatusLabel} />
                  <span>{snapshot ? 'Updated ' + ageLabel(snapshot.generatedAt) : 'Not updated'}</span>
                </div>
                <button
                  type="button"
                  className={styles.refreshButton}
                  onClick={() => { void load(); }}
                  disabled={loading || accessDenied}
                  aria-busy={loading}
                >
                  <RefreshCw className={loading ? styles.spinning : undefined} size={16} aria-hidden="true" />
                  {loading && snapshot ? 'Refreshing' : 'Refresh'}
                </button>
              </div>
            </header>

            {accessDenied ? (
              <div className={styles.errorPanel} role="alert">
                <TriangleAlert size={19} aria-hidden="true" />
                <strong>Admin access only</strong>
              </div>
            ) : error && snapshot === null ? (
              <div className={styles.errorPanel} role="alert">
                <TriangleAlert size={19} aria-hidden="true" />
                <div>
                  <strong>Database Atlas could not load</strong>
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
                    Showing the last update. Refresh failed: {error}
                  </div>
                ) : null}

                <dl className={styles.metrics} aria-label="Database Atlas totals">
                  <div>
                    <dt>Hotels</dt>
                    <dd>{formatCount(snapshot.overview.hotels)}</dd>
                  </div>
                  <div>
                    <dt>Rooms</dt>
                    <dd>{formatCount(snapshot.overview.roomsConfigured)}</dd>
                  </div>
                  <div>
                    <dt>Staff</dt>
                    <dd>{formatCount(snapshot.overview.activeStaff)}</dd>
                  </div>
                </dl>

                {snapshot.overview.warnings.length > 0 ? (
                  <div className={styles.warningPanel} role="status">
                    <TriangleAlert size={18} aria-hidden="true" />
                    <div>
                      <strong>
                        {formatCount(snapshot.overview.warnings.length)}
                        {' '}
                        {snapshot.overview.warnings.length === 1 ? 'warning' : 'warnings'}
                      </strong>
                      <ul>
                        {snapshot.overview.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                      </ul>
                    </div>
                  </div>
                ) : null}

                <section className={styles.hotelsSection} aria-labelledby="atlas-hotels-title">
                  <div className={styles.sectionBar}>
                    <h2 id="atlas-hotels-title">Hotels</h2>
                    <label className={styles.searchField}>
                      <span className={styles.srOnly}>Search hotels</span>
                      <Search size={16} aria-hidden="true" />
                      <input
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search hotels"
                        aria-describedby="atlas-hotel-results"
                      />
                    </label>
                  </div>
                  <p
                    id="atlas-hotel-results"
                    className={isFiltering ? styles.resultCount : styles.srOnly}
                    aria-live="polite"
                  >
                    {isFiltering
                      ? formatCount(filteredHotels.length) + ' of ' + formatCount(snapshot.hotels.length) + ' hotels'
                      : formatCount(snapshot.hotels.length) + ' hotels'}
                  </p>

                  {snapshot.hotels.length === 0 ? (
                    <div role="status"><DarkEmpty text="No hotels have been added yet." /></div>
                  ) : filteredHotels.length === 0 ? (
                    <div role="status"><DarkEmpty text={'No hotels match “' + query.trim() + '”.'} /></div>
                  ) : (
                    <div className={styles.tableScroller} role="region" aria-label="Hotel backend status" tabIndex={0}>
                      <table className={styles.hotelTable}>
                        <caption className={styles.srOnly}>Live backend status for every Staxis hotel</caption>
                        <thead>
                          <tr>
                            <th scope="col">Hotel</th>
                            <th scope="col">Rooms</th>
                            <th scope="col">Staff</th>
                            <th scope="col">Setup</th>
                            <th scope="col">Data</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredHotels.map((hotel) => {
                            const warnings = hotel.report?.warnings ?? [];
                            const reportState = hotel.report?.state ?? 'unknown';
                            const needsAttention = !['live', 'no_expectations', 'unavailable'].includes(reportState)
                              || (reportState === 'live' && warnings.length > 0);
                            return (
                              <tr key={hotel.id}>
                                <td data-label="Hotel">
                                  <Link
                                    href={'/admin/properties/' + encodeURIComponent(hotel.id)}
                                    className={styles.hotelLink}
                                  >
                                    {hotel.name?.trim() || 'Unnamed hotel'}
                                  </Link>
                                  <StatusBadge status={hotel.subscriptionStatus} />
                                </td>
                                <td data-label="Rooms" className={styles.numberCell}>
                                  {formatCount(hotel.totalRooms)}
                                </td>
                                <td data-label="Staff" className={styles.numberCell}>
                                  {formatCount(hotel.activeStaff)}
                                </td>
                                <td data-label="Setup">
                                  <StatusBadge
                                    status={hotel.onboardingCompleted ? 'ready' : 'pending'}
                                    label={hotel.onboardingCompleted ? 'Ready' : 'Onboarding'}
                                  />
                                </td>
                                <td data-label="Data">
                                  <StatusBadge status={reportState} label={feedLabel(reportState)} />
                                  {needsAttention && warnings[0] ? (
                                    <span className={styles.warningText} title={warnings.join('\n')}>
                                      {warnings[0]}
                                      {warnings.length > 1 ? ' · +' + (warnings.length - 1) : ''}
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

                <section className={styles.backendGrid} aria-label="Backend status">
                  <article className={styles.systemsPanel}>
                    <div className={styles.panelHeader}>
                      <h2>Systems</h2>
                      {systemCheckUnavailable ? <span className={styles.checkWarning}>Live check unavailable</span> : null}
                    </div>
                    <ul className={styles.serviceList}>
                      {services.map((service) => (
                        <li key={service.id}>
                          <span>{service.label}</span>
                          <StatusBadge status={service.status} />
                        </li>
                      ))}
                    </ul>
                  </article>

                  <details className={styles.databaseDetails}>
                    <summary>
                      <span>Database details</span>
                      <span>
                        {snapshot.schema.status === 'unavailable'
                          ? 'Unavailable'
                          : formatCount(snapshot.schema.tableCount)
                            + ' tables · '
                            + formatCount(snapshot.schema.domains.length)
                            + ' areas'}
                      </span>
                    </summary>
                    <div className={styles.databaseBody}>
                      {snapshot.schema.status === 'unavailable' ? (
                        <div role="status"><DarkEmpty text="Database details are unavailable." /></div>
                      ) : snapshot.schema.domains.length === 0 ? (
                        <div role="status"><DarkEmpty text="No database areas were returned." /></div>
                      ) : (
                        snapshot.schema.domains.map((domain) => (
                          <details className={styles.areaDetails} key={domain.id}>
                            <summary>
                              <span>{domain.label}</span>
                              <span>{formatCount(domain.tables.length)}</span>
                            </summary>
                            {domain.tables.length > 0 ? (
                              <ul className={styles.tableNames}>
                                {domain.tables.map((table) => <li key={table}>{table}</li>)}
                              </ul>
                            ) : (
                              <p>No tables in this area.</p>
                            )}
                          </details>
                        ))
                      )}
                    </div>
                  </details>
                </section>
              </>
            ) : null}
          </main>
        </SurfaceShell>
      </DarkScope>
    </AppLayout>
  );
}

function LoadingAtlas() {
  return (
    <div className={styles.loadingState} role="status" aria-live="polite">
      <DarkSpinner size={22} />
      <span>Loading Database Atlas…</span>
    </div>
  );
}
