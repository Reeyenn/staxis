/** Count-only complaint signal safe to return to the Dashboard browser. */
export type ComplaintDashboardSummary =
  | {
      visible: true;
      open: number;
      overdue: number;
      callbacksDue: number;
    }
  | {
      /** The caller reaches the hotel but not the intended complaint role/capability. */
      visible: false;
    };

export function isComplaintDashboardSummary(value: unknown): value is ComplaintDashboardSummary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ComplaintDashboardSummary> & Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (candidate.visible === false) {
    return keys.length === 1 && keys[0] === 'visible';
  }
  const allowedKeys = new Set(['visible', 'open', 'overdue', 'callbacksDue']);
  return candidate.visible === true
    && keys.length === allowedKeys.size
    && keys.every((key) => allowedKeys.has(key))
    && Number.isInteger(candidate.open) && Number(candidate.open) >= 0
    && Number.isInteger(candidate.overdue) && Number(candidate.overdue) >= 0
    && Number.isInteger(candidate.callbacksDue) && Number(candidate.callbacksDue) >= 0;
}
