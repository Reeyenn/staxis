/**
 * Complete, bounded PostgREST reads for Company Hub projections.
 *
 * Supabase may clamp a requested range below the client-side page size.  The
 * exact count is therefore load-bearing: advancing by the rows actually
 * returned avoids gaps, and a missing/changing count fails closed instead of
 * silently authorizing from a partial fact set.
 */

export const COMPANY_QUERY_PAGE_SIZE = 500;
export const COMPANY_QUERY_ID_CHUNK_SIZE = 50;

export interface CompanyProjectionQueryError {
  code?: string;
  message: string;
}

export interface CompanyProjectionPage<T> {
  data: T[] | null;
  error: CompanyProjectionQueryError | null;
  count: number | null;
}

export class IncompleteCompanyProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteCompanyProjectionError';
  }
}

export function chunkCompanyProjectionIds(values: readonly string[]): string[][] {
  const unique = [...new Set(values.filter(Boolean))];
  const chunks: string[][] = [];
  for (let index = 0; index < unique.length; index += COMPANY_QUERY_ID_CHUNK_SIZE) {
    chunks.push(unique.slice(index, index + COMPANY_QUERY_ID_CHUNK_SIZE));
  }
  return chunks;
}

export async function readCompleteCompanyPages<T>(
  readPage: (from: number, to: number) => PromiseLike<CompanyProjectionPage<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  let expectedCount: number | null = null;

  while (expectedCount === null || rows.length < expectedCount) {
    const from = rows.length;
    const result = await readPage(from, from + COMPANY_QUERY_PAGE_SIZE - 1);
    if (result.error) throw result.error;
    if (!Number.isSafeInteger(result.count) || (result.count ?? -1) < 0) {
      throw new IncompleteCompanyProjectionError(
        'Company projection query did not return an exact row count',
      );
    }
    const exactCount = result.count as number;
    if (expectedCount === null) expectedCount = exactCount;
    if (exactCount !== expectedCount) {
      throw new IncompleteCompanyProjectionError(
        'Company projection rows changed while a paged query was loading',
      );
    }
    const fixedCount = expectedCount;

    const page = result.data ?? [];
    if (page.length === 0 && rows.length < fixedCount) {
      throw new IncompleteCompanyProjectionError(
        `Company projection query stopped after ${rows.length} of ${fixedCount} rows`,
      );
    }
    if (rows.length + page.length > fixedCount) {
      throw new IncompleteCompanyProjectionError(
        'Company projection query returned more rows than its exact count',
      );
    }
    rows.push(...page);
  }

  return rows;
}

export async function readCompleteCompanyIdChunks<T>(
  ids: readonly string[],
  readChunkPage: (
    chunk: readonly string[],
    from: number,
    to: number,
  ) => PromiseLike<CompanyProjectionPage<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  for (const chunk of chunkCompanyProjectionIds(ids)) {
    rows.push(...await readCompleteCompanyPages((from, to) => (
      readChunkPage(chunk, from, to)
    )));
  }
  return rows;
}
