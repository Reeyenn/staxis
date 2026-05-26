/**
 * Activity log recorder — for events that don't have a dedicated source
 * table, or where app-level context (e.g., user agent, request id) is more
 * useful than what the trigger could synthesize.
 *
 * Most events are captured automatically by the triggers in migration
 * 0215 — you should NOT need to call this directly for cleaning_events,
 * cleaning_tasks, inspections, hk_assignments, callout_events, work
 * orders, room status, or account creations. Use this only when adding
 * a brand-new event source with no underlying table change to hook.
 *
 * Always called with supabaseAdmin (service-role only).
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import type { ActivityCategory, ActivitySource } from './types';

export interface RecordActivityInput {
  propertyId: string;
  occurredAt?: string;            // ISO; defaults to now()
  category: ActivityCategory;
  eventType: string;
  actorAccountId?: string | null;
  actorName?: string | null;
  actorRole?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  description: string;
  source?: ActivitySource;
  sourceEventId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Insert one activity_log row. Errors are caught + logged — recording
 * activity is observability, not load-bearing on the main request path.
 * Returns true on success, false on failure (caller can still proceed).
 */
export async function recordActivity(input: RecordActivityInput): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin.from('activity_log').insert({
      property_id: input.propertyId,
      occurred_at: input.occurredAt ?? new Date().toISOString(),
      event_category: input.category,
      event_type: input.eventType,
      actor_account_id: input.actorAccountId ?? null,
      actor_name: input.actorName ?? 'System',
      actor_role: input.actorRole ?? null,
      target_type: input.targetType ?? null,
      target_id: input.targetId ?? null,
      target_label: input.targetLabel ?? null,
      description: input.description,
      source: input.source ?? 'system',
      source_event_id: input.sourceEventId ?? null,
      metadata: input.metadata ?? {},
    });
    if (error) {
      log.warn('activity_log insert failed', { eventType: input.eventType, error: error.message });
      return false;
    }
    return true;
  } catch (e) {
    log.warn('activity_log insert threw', { eventType: input.eventType, error: errToString(e) });
    return false;
  }
}
