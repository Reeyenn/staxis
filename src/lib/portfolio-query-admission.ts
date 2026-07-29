import 'server-only';

import { randomUUID } from 'node:crypto';

import { log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const PORTFOLIO_QUERY_ADMISSION_VERSION = 'portfolio-query-admission.v1';
export const PORTFOLIO_QUERY_LEASE_SECONDS = 75;

export type PortfolioQueryAdmission =
  | {
    ok: true;
    leaseToken: string;
    leaseExpiresAt: string;
  }
  | {
    ok: false;
    reason: 'rate_limited' | 'busy' | 'unavailable';
    retryAfterSeconds: number;
  };

interface AdmissionRpcRow {
  status?: unknown;
  contractVersion?: unknown;
  leaseExpiresAt?: unknown;
  retryAfterSeconds?: unknown;
}

function objectRow(value: unknown): AdmissionRpcRow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as AdmissionRpcRow;
}

/**
 * Atomically consumes the pre-query account+organization rate slot and claims
 * the distributed concurrency lease. Every malformed/error result fails
 * closed; callers must not load metadata before this returns `ok: true`.
 */
export async function acquirePortfolioQueryAdmission(input: {
  accountId: string;
  organizationId: string;
}): Promise<PortfolioQueryAdmission> {
  const leaseToken = randomUUID();
  try {
    const { data, error } = await supabaseAdmin.rpc('staxis_acquire_portfolio_query_lease', {
      p_account_id: input.accountId,
      p_organization_id: input.organizationId,
      p_lease_token: leaseToken,
      p_lease_seconds: PORTFOLIO_QUERY_LEASE_SECONDS,
    });
    if (error) {
      log.error('[agent/portfolio] pre-query admission unavailable — FAILING CLOSED', {
        accountId: input.accountId,
        organizationId: input.organizationId,
        code: error.code ?? 'portfolio_admission_rpc_failed',
      });
      return { ok: false, reason: 'unavailable', retryAfterSeconds: 30 };
    }
    const row = objectRow(data);
    if (!row || row.contractVersion !== PORTFOLIO_QUERY_ADMISSION_VERSION) {
      log.error('[agent/portfolio] malformed pre-query admission — FAILING CLOSED', {
        accountId: input.accountId,
        organizationId: input.organizationId,
      });
      return { ok: false, reason: 'unavailable', retryAfterSeconds: 30 };
    }
    if (row.status === 'admitted'
        && typeof row.leaseExpiresAt === 'string'
        && Number.isFinite(Date.parse(row.leaseExpiresAt))
        && Date.parse(row.leaseExpiresAt) > Date.now()) {
      return { ok: true, leaseToken, leaseExpiresAt: row.leaseExpiresAt };
    }
    if (row.status === 'rate_limited' || row.status === 'busy') {
      const retry = Number(row.retryAfterSeconds);
      return {
        ok: false,
        reason: row.status,
        retryAfterSeconds: Number.isSafeInteger(retry) && retry > 0
          ? Math.min(retry, 3_600)
          : 30,
      };
    }
    log.error('[agent/portfolio] refused invalid pre-query admission — FAILING CLOSED', {
      accountId: input.accountId,
      organizationId: input.organizationId,
      admissionStatus: typeof row.status === 'string' ? row.status : 'malformed',
    });
    return { ok: false, reason: 'unavailable', retryAfterSeconds: 30 };
  } catch (error) {
    log.error('[agent/portfolio] pre-query admission threw — FAILING CLOSED', {
      accountId: input.accountId,
      organizationId: input.organizationId,
      error,
    });
    return { ok: false, reason: 'unavailable', retryAfterSeconds: 30 };
  }
}

/** Release is deliberately independent of the request AbortSignal. A client
 * disconnect must stop reads, then still let this exact token release its DB
 * lease. A different/newer token can never be cleared by this call. */
export async function releasePortfolioQueryAdmission(input: {
  accountId: string;
  organizationId: string;
  leaseToken: string;
}): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.rpc('staxis_release_portfolio_query_lease', {
      p_account_id: input.accountId,
      p_organization_id: input.organizationId,
      p_lease_token: input.leaseToken,
    });
    const row = objectRow(data);
    if (error
        || !row
        || row.contractVersion !== PORTFOLIO_QUERY_ADMISSION_VERSION
        || (row.status !== 'released' && row.status !== 'lease_lost')) {
      log.error('[agent/portfolio] distributed query lease release failed', {
        accountId: input.accountId,
        organizationId: input.organizationId,
        code: error?.code ?? 'malformed_release_result',
      });
    }
  } catch (error) {
    // The bounded database TTL is the final recovery path. This log is a page-
    // worthy signal because callers will be temporarily busy until it expires.
    log.error('[agent/portfolio] distributed query lease release threw', {
      accountId: input.accountId,
      organizationId: input.organizationId,
      error,
    });
  }
}
