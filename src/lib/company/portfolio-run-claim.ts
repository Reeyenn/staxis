/**
 * The atomic company-portfolio claim RPC returns an intentionally loose JSON
 * envelope. Keep its interpretation pure and closed so a malformed cached row
 * can never masquerade as a completed portfolio run.
 */

export type PortfolioDayClaim =
  | 'claimed'
  | 'held_complete'
  | 'held_incomplete'
  | 'in_progress'
  | 'unavailable';

export interface PortfolioClaimRow {
  claimed?: unknown;
  existing_response?: unknown;
  existing_status?: unknown;
  existing_route?: unknown;
}

export interface PortfolioClaimExpectation {
  route: string;
  runVersion: number;
  organizationId: string;
  localDate: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Classify one normalized RPC row. RPC errors and thrown reads are handled by
 * the caller and map to `unavailable`; this function fails closed for every
 * unknown or incompatible row shape.
 */
export function classifyPortfolioDayClaim(
  row: PortfolioClaimRow | null | undefined,
  expected: PortfolioClaimExpectation,
): PortfolioDayClaim {
  if (!isRecord(row)) return 'unavailable';
  if (row.claimed === true) return 'claimed';
  if (row.claimed !== false || row.existing_route !== expected.route) {
    return 'unavailable';
  }

  const response = row.existing_response;
  if (row.existing_status === 0) {
    return isRecord(response) && response.__pending__ === true
      ? 'in_progress'
      : 'unavailable';
  }
  if (row.existing_status !== 200 || !isRecord(response)) return 'unavailable';

  const summary = response.summary;
  if (response.ran !== true
    || response.v !== expected.runVersion
    || response.organizationId !== expected.organizationId
    || response.localDate !== expected.localDate
    || !isRecord(summary)
    || !Array.isArray(summary.errors)) {
    return 'unavailable';
  }

  if (summary.errors.length > 0) return 'held_incomplete';
  // A zero-error array alone is not a completion receipt. Requiring the
  // persisted terminal state prevents a malformed or pre-migration cache row
  // from suppressing today's run as though it had finished successfully.
  return summary.completion === 'completed' && summary.ran === true
    ? 'held_complete'
    : 'unavailable';
}
