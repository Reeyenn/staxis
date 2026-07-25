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
//
// HISTORY: this module used to carry its OWN `loadKnowsCaller`, selecting
// `accounts.name` — a column that does not exist. PostgREST errors on it, the
// call site reads the error as "no such account", and the Knows screen showed
// "Could not load what Staxis knows right now" to every single user, live,
// through a green build and a green test suite. It was the fourth instance of
// that bug class in a week, and it happened because two branches built the same
// account lookup at the same time: one fixed the bad column, the other
// reintroduced it. So there is now exactly ONE loader — `loadManagerCaller` —
// and this module deliberately has no query of its own to drift from it.

import 'server-only';
import { type ManagerCaller } from '@/lib/team-auth';

export function callerManagesProperty(caller: ManagerCaller, propertyId: string): boolean {
  if (caller.role === 'admin') return true;
  if (caller.propertyAccess.includes('*')) return true;
  return caller.propertyAccess.includes(propertyId);
}
