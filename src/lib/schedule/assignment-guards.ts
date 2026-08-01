type DatabaseErrorLike = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
};

export type StaffScheduleGuardConflict =
  | 'approved_time_off'
  | 'inactive_staff'
  | 'archived_history'
  | null;

/**
 * Classify the stable check-violation errors raised by migration 0412's
 * commit-time staff scheduling guards. PostgREST does not consistently expose
 * PostgreSQL's constraint field, so the migration's fixed English messages are
 * the wire contract in addition to SQLSTATE 23514.
 */
export function staffScheduleGuardConflict(
  error: DatabaseErrorLike | null | undefined,
): StaffScheduleGuardConflict {
  if (error?.code !== '23514') return null;
  const text = `${error.message ?? ''} ${error.details ?? ''}`.toLowerCase();
  if (text.includes('approved time off')) return 'approved_time_off';
  if (text.includes('inactive staff member')) return 'inactive_staff';
  if (text.includes('archived historical shift')) return 'archived_history';
  return null;
}
