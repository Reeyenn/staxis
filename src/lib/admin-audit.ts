/**
 * Helper for writing admin_audit_log entries from any admin route.
 *
 * Usage:
 *   import { writeAuditLog } from '@/lib/admin-audit';
 *   await writeAuditLog({
 *     actorUserId: auth.userId,
 *     actorEmail: auth.email,
 *     action: 'prospect.update',
 *     targetType: 'prospect',
 *     targetId: id,
 *     metadata: { from: oldStatus, to: newStatus },
 *   });
 *
 * Failures are logged but never thrown — auditing should not block the
 * underlying operation.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';

export interface AuditLogEntry {
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
  try {
    await supabaseAdmin.from('admin_audit_log').insert({
      actor_user_id: entry.actorUserId ?? null,
      actor_email: entry.actorEmail ?? null,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      metadata: entry.metadata ?? {},
    });
  } catch (err) {
    console.error('[admin-audit] failed to write entry', { entry, err });
  }
}
