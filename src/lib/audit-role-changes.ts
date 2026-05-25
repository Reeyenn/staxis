/**
 * Structured role-change audit writer.
 *
 * Lives in its own module (not inside an /api/.../route.ts) so other
 * routes can import it without crossing the Next.js route-module
 * boundary. Next.js App Router treats route.ts as a route definition,
 * and while named exports from it technically resolve at import-time,
 * the pattern is fragile (future Router-Group bundling could break it
 * silently). One shared lib module avoids that risk entirely.
 *
 * Best-effort writer: a failure does NOT throw. Callers continue
 * (the action itself was already persisted to `accounts`; this is
 * just the structured audit trail).
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import type { AppRole } from '@/lib/roles';

export type RoleChangeKind =
  | 'role_change'
  | 'deactivate'
  | 'reactivate'
  | 'transfer_ownership';

export interface RoleChangeEntry {
  accountId: string;
  propertyId: string;
  changedByAccountId: string;
  oldRole: AppRole;
  newRole: AppRole;
  changeKind: RoleChangeKind;
  reason: string | null;
}

export async function writeRoleChange(entry: RoleChangeEntry): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from('role_changes')
      .insert({
        account_id: entry.accountId,
        property_id: entry.propertyId,
        changed_by_account_id: entry.changedByAccountId,
        old_role: entry.oldRole,
        new_role: entry.newRole,
        change_kind: entry.changeKind,
        reason: entry.reason,
      });
    if (error) {
      log.warn('[audit-role-changes] insert failed', {
        accountId: entry.accountId,
        err: error.message,
      });
    }
  } catch (e) {
    log.warn('[audit-role-changes] insert threw', {
      accountId: entry.accountId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}
