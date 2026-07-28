import { MANAGEMENT_PATTERN_ENGINE_VERSION } from './definitions';

export const MANAGEMENT_PATTERN_WEEKLY_DAY_UTC = 1; // Monday
export const MANAGEMENT_PATTERN_WEEKLY_HOUR_UTC = 8;

function validInstant(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
  return new Date(value.getTime());
}

/**
 * Stable weekly decision instant. A delayed or repeated cron invocation gets
 * the same logical run instead of smuggling wall-clock milliseconds into the
 * evidence identity.
 */
export function latestManagementPatternWeeklyEvaluationAt(nowInput: Date): Date {
  const now = validInstant(nowInput, 'now');
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    MANAGEMENT_PATTERN_WEEKLY_HOUR_UTC,
  ));
  const daysSinceMonday = (
    candidate.getUTCDay() - MANAGEMENT_PATTERN_WEEKLY_DAY_UTC + 7
  ) % 7;
  candidate.setUTCDate(candidate.getUTCDate() - daysSinceMonday);
  if (candidate.getTime() > now.getTime()) candidate.setUTCDate(candidate.getUTCDate() - 7);
  return candidate;
}

export type ManagementPatternRunMode = 'scheduled' | 'manual' | 'backfill' | 'replay';

/** Human-readable, tenant-scoped idempotency identity; input conflicts revise it explicitly. */
export function managementPatternRunKey(input: {
  mode: ManagementPatternRunMode;
  evaluationAt: Date;
  revisionHash?: string | null;
}): string {
  const evaluationAt = validInstant(input.evaluationAt, 'evaluationAt').toISOString();
  const revision = input.revisionHash?.trim() ?? '';
  if (revision && !/^[0-9a-f]{64}$/.test(revision)) {
    throw new TypeError('revisionHash must be a lowercase SHA-256 digest');
  }
  return [
    input.mode,
    MANAGEMENT_PATTERN_ENGINE_VERSION,
    evaluationAt,
    ...(revision ? [`revision-${revision}`] : []),
  ].join(':');
}
