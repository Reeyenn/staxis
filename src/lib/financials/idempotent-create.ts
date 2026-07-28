/**
 * Exact-retry support for non-idempotent Financials creates.
 *
 * The browser supplies one UUID for the lifetime of a create form. The UUID is
 * inserted as the row's primary key. If the first insert commits but its HTTP
 * response is lost, retrying the same frozen request reaches Postgres again,
 * receives 23505, and proves that the exact row already exists before treating
 * the retry as success. A different payload under the same UUID is a conflict,
 * never a second insert.
 */

export interface FinancialCreateDbError {
  code?: string;
  message?: string;
}

export interface FinancialCreateDbResult<T> {
  data: T | null;
  error: FinancialCreateDbError | null;
}

export class FinancialCreateConflictError extends Error {
  constructor() {
    super('The create operation ID was already used for different financial data.');
    this.name = 'FinancialCreateConflictError';
  }
}

export function isFinancialCreateConflict(error: unknown): error is FinancialCreateConflictError {
  return error instanceof FinancialCreateConflictError;
}

function sameScalar(left: unknown, right: unknown): boolean {
  if (left == null || right == null) return left == null && right == null;
  if (typeof left === 'number' || typeof right === 'number') {
    return Number(left) === Number(right);
  }
  return left === right;
}

/** Compare only the immutable canonical fields supplied by the create call. */
export function sameFinancialCreateFields(
  existing: Record<string, unknown>,
  expected: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every((field) => sameScalar(existing[field], expected[field]));
}

export async function settleFinancialCreateInsert<T extends Record<string, unknown>>({
  operationId,
  insert,
  lookup,
  matches,
}: {
  operationId: string;
  insert: () => PromiseLike<FinancialCreateDbResult<T>>;
  lookup: () => PromiseLike<FinancialCreateDbResult<T>>;
  matches: (existing: T) => boolean;
}): Promise<{ row: T; replayed: boolean }> {
  const inserted = await insert();
  if (!inserted.error && inserted.data) {
    return { row: inserted.data, replayed: false };
  }

  if (inserted.error?.code !== '23505') {
    throw inserted.error ?? new Error('Financial create returned no row.');
  }

  // A primary-key collision is safe only when the exact operation row exists
  // in this caller's property scope and still matches the canonical payload.
  // A failed verification stays an error; it must never be guessed successful.
  const existing = await lookup();
  if (existing.error) throw existing.error;
  if (!existing.data || !matches(existing.data)) {
    throw new FinancialCreateConflictError();
  }
  if (existing.data.id !== operationId) {
    throw new FinancialCreateConflictError();
  }
  return { row: existing.data, replayed: true };
}
