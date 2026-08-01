import type { NextResponse } from 'next/server';

import { err, ApiErrorCode } from '@/lib/api-response';
import { fetchAllRows } from '@/lib/supabase-paginate';

/**
 * Identifies the dependency that made an inventory AI health read unavailable
 * without exposing the database's message to the browser.
 */
export class InventoryAiDependencyError extends Error {
  readonly cause: unknown;

  constructor(readonly dependency: string, cause: unknown) {
    super(`inventory AI dependency unavailable: ${dependency}`);
    this.name = 'InventoryAiDependencyError';
    this.cause = cause;
  }
}

export function requireInventoryAiResult<T>(
  dependency: string,
  result: { data: T; error: unknown },
): T {
  if (result.error) throw new InventoryAiDependencyError(dependency, result.error);
  return result.data;
}

/**
 * Page a potentially large PostgREST dependency through the project's 1,000
 * row response cap. Callers must put a stable, unique order on makePage.
 */
export async function fetchInventoryAiRows<T>(
  dependency: string,
  makePage: (
    fromRow: number,
    toRow: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown }>,
  maxRows: number,
): Promise<T[]> {
  try {
    const rows = await fetchAllRows(makePage, { maxRows: maxRows + 1 });
    if (rows.length > maxRows) {
      throw new Error(`inventory AI dependency exceeded ${maxRows} rows`);
    }
    return rows;
  } catch (cause) {
    throw new InventoryAiDependencyError(dependency, cause);
  }
}

export function inventoryAiUnavailableResponse(requestId: string): NextResponse {
  return err('inventory AI status is temporarily unavailable', {
    requestId,
    status: 503,
    code: ApiErrorCode.UpstreamFailure,
    headers: { 'Retry-After': '5' },
  });
}
