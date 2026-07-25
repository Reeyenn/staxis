// ─── Knows-screen access check ──────────────────────────────────────────────
// Shared by /api/memory/knows and /api/memory/knows/intake. Both routes still
// call requireSession themselves — the session check belongs in the handler
// (and the tenant-scope lint audit reads it there); what is shared is the part
// that was genuinely duplicated: loading the caller's account row and deciding
// whether they manage the named property.
//
// agent_memory is deny-all RLS and every read/write goes through supabaseAdmin,
// so `callerManagesProperty` is not defense in depth — it IS the tenant
// boundary for this feature.

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AppRole } from '@/lib/roles';

export interface KnowsCaller {
  accountId: string;
  name: string | null;
  role: AppRole;
  propertyAccess: string[];
}

export async function loadKnowsCaller(authUserId: string): Promise<KnowsCaller | null> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id, name, role, property_access')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { id: string; name: string | null; role: string; property_access?: unknown };
  return {
    accountId: row.id,
    name: row.name ?? null,
    role: row.role as AppRole,
    propertyAccess: Array.isArray(row.property_access) ? (row.property_access as string[]) : [],
  };
}

export function callerManagesProperty(caller: KnowsCaller, propertyId: string): boolean {
  if (caller.role === 'admin') return true;
  if (caller.propertyAccess.includes('*')) return true;
  return caller.propertyAccess.includes(propertyId);
}
