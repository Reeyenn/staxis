/**
 * Persist (or update) a schedule_alerts row from a Suggestion.
 *
 * Uses the unique index `schedule_alerts_active_unique` to dedupe open
 * alerts: at most one open alert per (property, date, dept, action) at any
 * time. When a recompute produces a Suggestion that matches an existing
 * open row, we UPDATE it in place (refreshed numbers + trigger_kind). When
 * the recompute produces nothing for an existing combo, we leave the open
 * row alone — the manager already saw the alert and will dismiss when
 * acted on; the next recompute will refresh it.
 *
 * Pure / DI: writer is a plain async fn that takes the row payload.
 */

import type { Suggestion } from './types';

export interface ScheduleAlertWriter {
  /** Upsert a row keyed by the active-unique index, returning the row id. */
  upsertOpenAlert(payload: AlertWritePayload): Promise<{ id: string; created: boolean }>;
}

export interface AlertWritePayload {
  propertyId: string;
  alertDate: string;
  department: string;
  severity: 'yellow' | 'red';
  suggestedAction: 'add_shift' | 'release_shift';
  gapMinutes: number;
  demandMinutes: number;
  scheduledMinutes: number;
  suggestedSavingsCents: number | null;
  triggerKind: string;
  context: Record<string, unknown>;
}

export async function createAlertFromSuggestion(
  s: Suggestion,
  writer: ScheduleAlertWriter,
): Promise<{ id: string; created: boolean }> {
  return writer.upsertOpenAlert({
    propertyId: s.propertyId,
    alertDate: s.alertDate,
    department: s.department,
    severity: s.severity,
    suggestedAction: s.suggestedAction,
    gapMinutes: s.gapMinutes,
    demandMinutes: s.demandMinutes,
    scheduledMinutes: s.scheduledMinutes,
    suggestedSavingsCents: s.suggestedSavingsCents ?? null,
    triggerKind: s.triggerKind,
    context: s.context,
  });
}
