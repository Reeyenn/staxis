// ─── Admin audit log helper ──────────────────────────────────────────────
// Wraps inserts into public.admin_audit_log. Routes call this for every
// account/auth/property action they perform; the per-hotel audit UI in
// /admin/properties/[id] reads back rows where metadata.hotel_id matches.
//
// Best-effort: log failures are warned but never block the action that
// triggered them. The audit feed is observability, not a transaction.

import { supabaseAdmin } from '@/lib/supabase-admin';

export interface AuditLogInput {
  action: string;            // verb-style. e.g. 'account.create', 'invite.accept'
  actorUserId?: string;      // auth.users.id of who performed the action
  actorEmail?: string;       // denormalized so deleted users still show
  targetType?: string;       // 'account', 'invite', 'join_code', 'property', …
  targetId?: string;
  hotelId?: string;          // when applicable; surfaced in metadata for per-hotel filter
  metadata?: Record<string, unknown>;
}

export async function writeAudit(entry: AuditLogInput): Promise<void> {
  try {
    const md: Record<string, unknown> = { ...(entry.metadata ?? {}) };
    if (entry.hotelId) md.hotel_id = entry.hotelId;
    await supabaseAdmin.from('admin_audit_log').insert({
      actor_user_id: entry.actorUserId ?? null,
      actor_email: entry.actorEmail ?? null,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      metadata: md,
    });
  } catch (err) {
    console.warn('[audit] write failed', { action: entry.action, err });
  }
}
