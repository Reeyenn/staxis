/**
 * GET /api/admin/data-atlas
 *
 * A read-only founder view of Staxis's live backend shape. It returns safe
 * metadata and counts only: hotels, aggregate active-staff counts, canonical
 * report-feed health, public table names/RLS facts, and the migration ledger.
 * It never returns guest data, staff identity, report contents, credentials,
 * raw rows, or arbitrary client-selected tables/columns.
 */

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import {
  buildAtlasHotels,
  groupAtlasSchema,
  summarizeReportService,
  type AtlasPropertyHealthRow,
  type AtlasPropertyRow,
  type AtlasSchemaRow,
  type AtlasStaffRow,
  type DataAtlasPayload,
} from '@/lib/admin-data-atlas';
import { getOrMintRequestId, log } from '@/lib/log';
import { PMS_ROBOT_ENABLED } from '@/lib/pms/robot-status';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
} as const;
const PAGE_SIZE = 1_000;
const MAX_ROWS_PER_SECTION = 20_000;

type PagedResult<T> =
  | { data: T[]; error: null; truncated: boolean }
  | { data: null; error: string; truncated: false };

async function readProperties(): Promise<PagedResult<AtlasPropertyRow>> {
  const rows: AtlasPropertyRow[] = [];
  for (let offset = 0; offset < MAX_ROWS_PER_SECTION; offset += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from('properties')
      .select('id, name, total_rooms, subscription_status, property_kind, pms_type, onboarding_completed_at, enabled_sections, created_at, updated_at')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) return { data: null, error: error.message, truncated: false };
    const batch = (data ?? []) as AtlasPropertyRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { data: rows, error: null, truncated: false };
  }
  return { data: rows, error: null, truncated: true };
}

async function readActiveStaff(): Promise<PagedResult<AtlasStaffRow>> {
  const rows: AtlasStaffRow[] = [];
  for (let offset = 0; offset < MAX_ROWS_PER_SECTION; offset += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from('staff')
      .select('id, property_id')
      .eq('is_active', true)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) return { data: null, error: error.message, truncated: false };
    const batch = (data ?? []) as AtlasStaffRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { data: rows, error: null, truncated: false };
  }
  return { data: rows, error: null, truncated: true };
}

async function readPropertyHealth(): Promise<PagedResult<AtlasPropertyHealthRow>> {
  const rows: AtlasPropertyHealthRow[] = [];
  for (let offset = 0; offset < MAX_ROWS_PER_SECTION; offset += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from('pms_property_health_v1')
      .select('property_id, worst_state, feeds_total, feeds_live, feeds_stale, feeds_learning, feeds_unavailable, required_feeds_degraded, newest_signal_at, worst_minutes_late, open_quarantine_total, open_unmapped_total')
      .order('property_id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) return { data: null, error: error.message, truncated: false };
    const batch = (data ?? []) as AtlasPropertyHealthRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { data: rows, error: null, truncated: false };
  }
  return { data: rows, error: null, truncated: true };
}

async function readSchema(): Promise<PagedResult<AtlasSchemaRow>> {
  const rows: AtlasSchemaRow[] = [];
  for (let offset = 0; offset < MAX_ROWS_PER_SECTION; offset += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from('pg_tables_policy_coverage')
      .select('tablename, rls_enabled, policy_count, has_tenant_column')
      .order('tablename', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) return { data: null, error: error.message, truncated: false };
    const batch = (data ?? []) as AtlasSchemaRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { data: rows, error: null, truncated: false };
  }
  return { data: rows, error: null, truncated: true };
}

async function readOrganizationCount(): Promise<{ count: number | null; error: string | null }> {
  const { count, error } = await supabaseAdmin
    .from('organizations')
    .select('id', { count: 'exact', head: true });
  return error
    ? { count: null, error: error.message }
    : { count: typeof count === 'number' ? count : null, error: null };
}

async function readMigrationLedger(): Promise<{
  status: 'available' | 'unavailable';
  appliedCount: number | null;
  latestVersion: string | null;
  latestAppliedAt: string | null;
  error: string | null;
}> {
  const { data, count, error } = await supabaseAdmin
    .from('applied_migrations')
    .select('version, applied_at', { count: 'exact' })
    .order('applied_at', { ascending: false })
    .limit(1);
  if (error) {
    return {
      status: 'unavailable',
      appliedCount: null,
      latestVersion: null,
      latestAppliedAt: null,
      error: error.message,
    };
  }
  const latest = data?.[0] as { version?: unknown; applied_at?: unknown } | undefined;
  return {
    status: 'available',
    appliedCount: typeof count === 'number' ? count : null,
    latestVersion: typeof latest?.version === 'string' ? latest.version : null,
    latestAppliedAt: typeof latest?.applied_at === 'string' ? latest.applied_at : null,
    error: null,
  };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) {
    auth.response.headers.set('Cache-Control', NO_STORE_HEADERS['Cache-Control']);
    return auth.response;
  }

  const results = await Promise.allSettled([
    readProperties(),
    readActiveStaff(),
    readPropertyHealth(),
    readSchema(),
    readOrganizationCount(),
    readMigrationLedger(),
  ]);
  const rejectionMessage = (reason: unknown): string =>
    reason instanceof Error ? reason.message : 'database request failed';
  const properties = results[0].status === 'fulfilled'
    ? results[0].value
    : { data: null, error: rejectionMessage(results[0].reason), truncated: false } as const;
  const staff = results[1].status === 'fulfilled'
    ? results[1].value
    : { data: null, error: rejectionMessage(results[1].reason), truncated: false } as const;
  const propertyHealth = results[2].status === 'fulfilled'
    ? results[2].value
    : { data: null, error: rejectionMessage(results[2].reason), truncated: false } as const;
  const schemaRows = results[3].status === 'fulfilled'
    ? results[3].value
    : { data: null, error: rejectionMessage(results[3].reason), truncated: false } as const;
  const organizations = results[4].status === 'fulfilled'
    ? results[4].value
    : { count: null, error: rejectionMessage(results[4].reason) };
  const migrationLedger = results[5].status === 'fulfilled'
    ? results[5].value
    : {
        status: 'unavailable' as const,
        appliedCount: null,
        latestVersion: null,
        latestAppliedAt: null,
        error: rejectionMessage(results[5].reason),
      };

  if (properties.error || !properties.data || properties.truncated) {
    log.error('[admin/data-atlas] core hotel read failed', {
      requestId,
      route: '/api/admin/data-atlas',
      error: properties.error ?? (properties.truncated ? 'safety limit reached' : 'missing result'),
    });
    return err('The hotel atlas is unavailable right now. Please try again.', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
      headers: NO_STORE_HEADERS,
    });
  }

  const partialErrors = [
    ['active staff', staff.error],
    ['report health', propertyHealth.error],
    ['database table catalog', schemaRows.error],
    ['organization count', organizations.error],
    ['migration ledger', migrationLedger.error],
  ] as const;
  for (const [section, errorMessage] of partialErrors) {
    if (!errorMessage) continue;
    log.warn('[admin/data-atlas] optional section unavailable', {
      requestId,
      route: '/api/admin/data-atlas',
      section,
      error: errorMessage,
    });
  }

  const safeStaff = staff.error || staff.truncated ? null : staff.data;
  const safePropertyHealth = propertyHealth.error || propertyHealth.truncated
    ? null
    : propertyHealth.data;
  const safeSchemaRows = schemaRows.error || schemaRows.truncated ? null : schemaRows.data;
  const hotels = buildAtlasHotels({
    properties: properties.data,
    activeStaff: safeStaff,
    propertyHealth: safePropertyHealth,
  });
  const warnings: string[] = [];
  if (properties.truncated) warnings.push('The hotel list reached its safety limit.');
  if (staff.error) warnings.push('Active-staff totals are unavailable right now.');
  else if (staff.truncated) warnings.push('Active-staff totals reached their safety limit.');
  if (propertyHealth.error) warnings.push('Scheduled-report health is unavailable right now.');
  else if (propertyHealth.truncated) warnings.push('Scheduled-report health reached its safety limit.');
  if (schemaRows.error) warnings.push('The live database table catalog is unavailable right now.');
  else if (schemaRows.truncated) warnings.push('The table catalog reached its safety limit.');
  if (organizations.error) warnings.push('The organization total is unavailable right now.');
  if (migrationLedger.error) warnings.push('The database-change ledger is unavailable right now.');
  if (safePropertyHealth) {
    const reportAttentionCount = hotels.filter((hotel) => (
      (!['live', 'no_expectations', 'unavailable'].includes(hotel.report.state))
      || (hotel.report.state === 'live' && hotel.report.warnings.length > 0)
    )).length;
    if (reportAttentionCount > 0) {
      warnings.push(
        `${reportAttentionCount} hotel${reportAttentionCount === 1 ? '' : 's'} have scheduled-report data that needs attention.`,
      );
    }
  }

  const schemaDomains = safeSchemaRows ? groupAtlasSchema(safeSchemaRows) : [];
  const knownSchemaRows = safeSchemaRows?.filter(
    (row) => typeof row.tablename === 'string' && row.tablename.trim().length > 0,
  ) ?? [];
  const payload: DataAtlasPayload = {
    generatedAt: new Date().toISOString(),
    overview: {
      hotels: hotels.length,
      organizations: organizations.count,
      activeStaff: safeStaff?.length ?? null,
      roomsConfigured: hotels.reduce((total, hotel) => total + hotel.totalRooms, 0),
      warnings,
    },
    hotels,
    schema: {
      status: safeSchemaRows ? 'available' : 'unavailable',
      tableCount: safeSchemaRows ? knownSchemaRows.length : null,
      rlsEnabledCount: safeSchemaRows
        ? knownSchemaRows.filter((row) => row.rls_enabled === true).length
        : null,
      policyCoveredCount: safeSchemaRows
        ? knownSchemaRows.filter((row) => typeof row.policy_count === 'number' && row.policy_count > 0).length
        : null,
      directTenantColumnCount: safeSchemaRows
        ? knownSchemaRows.filter((row) => row.has_tenant_column === true).length
        : null,
      domains: schemaDomains,
      note: 'These are safety-setting counts, not a full security score. Some backend-only tables intentionally block every browser user.',
    },
    domains: schemaDomains.map((domain) => ({
      id: domain.id,
      label: domain.label,
      description: domain.purpose,
      status: 'catalogued' as const,
      rowCount: domain.tables.length,
    })),
    services: [
      {
        id: 'admin-api',
        label: 'Admin app & API',
        summary: 'This live atlas request completed successfully.',
        status: 'live',
      },
      {
        id: 'database',
        label: 'Database',
        summary: 'Hotel data is readable. The system-status check shows deeper connection health.',
        status: 'live',
      },
      summarizeReportService(safePropertyHealth),
      {
        id: 'pms-robot',
        label: 'PMS browser robot',
        summary: PMS_ROBOT_ENABLED
          ? 'The browser-based PMS connector is enabled.'
          : 'Retired by design. Its scheduled-report email replacement is not end-to-end yet.',
        status: PMS_ROBOT_ENABLED ? 'live' : 'retired',
      },
    ],
    migrations: {
      status: migrationLedger.status,
      appliedCount: migrationLedger.appliedCount,
      latestVersion: migrationLedger.latestVersion,
      latestAppliedAt: migrationLedger.latestAppliedAt,
      note: 'This is the database change ledger. Mission Control owns the deeper code-versus-database match check.',
    },
  };

  return ok(payload, { requestId, headers: NO_STORE_HEADERS });
}
