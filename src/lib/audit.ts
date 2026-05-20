// ─── Admin audit log helper ──────────────────────────────────────────────
// Wraps inserts into public.admin_audit_log. Routes call this for every
// account/auth/property action they perform; the per-hotel audit UI in
// /admin/properties/[id] reads back rows where metadata.hotel_id matches.
//
// Best-effort: log failures are warned but never block the action that
// triggered them. The audit feed is observability, not a transaction.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

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

// ─── Security-event helper (audit-grade visibility on failure) ──────────
// Distinct from writeAudit because the audit log above is observability,
// not a security control: writeAudit swallows insert failures with a
// console.warn so a Supabase hiccup never blocks an account mutation.
// That's the right behavior for routine ops events.
//
// Security events (skip_2fa bypass fired, trusted device revoked, cross-
// tenant attempt detected, etc.) need the OPPOSITE failure mode: if the
// insert fails, the operation has STILL HAPPENED and the trail is now
// missing. We have to surface that loudly so on-call knows the audit
// stream has gaps and can correlate with other signals.
//
// On success: row goes into app_events (high-frequency table; has a
// retention purge cron — `auth.*` actions should be added to the retain-
// long allowlist there).
//
// On failure: log.error() — which already routes to Sentry via log.ts —
// with subsystem='security' so the sentry tag-lifter buckets it. No
// silent-swallow. Caller never throws (the security action proceeds
// regardless; the alert lives in Sentry).
export interface SecurityEventInput {
  action: string;            // e.g. 'auth.skip_2fa_used', 'auth.trust_revoked', 'auth.cross_tenant_attempt'
  userId?: string;           // auth.users.id
  propertyId?: string;       // property_id when the event is tenant-scoped
  userRole?: string;         // denormalized for cheap filter
  metadata?: Record<string, unknown>;
  requestId?: string;        // correlation id from getOrMintRequestId
}

export async function logSecurityEvent(entry: SecurityEventInput): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('app_events').insert({
      property_id: entry.propertyId ?? null,
      user_id: entry.userId ?? null,
      user_role: entry.userRole ?? null,
      event_type: entry.action,
      metadata: entry.metadata ?? {},
    });
    if (error) throw error;
  } catch (err) {
    log.error('[security] event write failed — security action proceeded with no audit trail', {
      subsystem: 'security',
      requestId: entry.requestId,
      action: entry.action,
      userId: entry.userId,
      pid: entry.propertyId,
      err,
    });
  }
}
