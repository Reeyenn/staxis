// ─── Prompts store ─────────────────────────────────────────────────────
// Loads prompts from the `agent_prompts` DB table, with an in-process
// 30s cache + canary-rollout selection by stable conversation hash.
//
// Longevity L2 (2026-05-13). Replaces the static-constant lookup that
// `buildSystemPrompt` previously did. The constants in prompts.ts are
// retained as the fail-soft baseline when the DB is unreachable.
//
// Design notes:
//
//   - One row per (role, version) in agent_prompts. is_active=true on
//     exactly one row per role at a time. canary_pct on the active row
//     decides what fraction of conversations get the NEXT version
//     during rollout (0 = no canary; 100 = full rollout to this row).
//
//   - Canary selection uses a stable hash of conversationId so the
//     same user keeps the same variant across all turns of one
//     conversation. The model doesn't switch mid-stream.
//
//   - Cache TTL is 30s. Each Vercel function instance reads the DB
//     at most every 30 seconds. After an admin activates a new
//     version, propagation takes up to 30s — acceptable for this scale.
//
//   - Fail-soft: any DB error short-circuits to the constant from
//     prompts.ts. Chat keeps working under a Supabase outage.

import crypto from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AppRole } from '@/lib/roles';
import { PROMPT_VERSION, FALLBACK_PROMPTS } from './prompts';

export type PromptRole = 'base' | 'housekeeping' | 'general_manager' | 'owner' | 'admin';

interface CachedPrompt {
  role: PromptRole;
  version: string;
  content: string;
  /** When canary_pct > 0, the OTHER (still-active) version for this
   *  role is the primary; the canary gets canary_pct of traffic. */
  canary_pct: number;
}

interface CacheEntry {
  entries: CachedPrompt[];
  loadedAt: number;
}

const CACHE_TTL_MS = 30_000;
let cache: CacheEntry | null = null;

async function loadFromDb(): Promise<CachedPrompt[]> {
  const { data, error } = await supabaseAdmin
    .from('agent_prompts')
    .select('role, version, content, canary_pct, is_active, created_at')
    .order('role')
    .order('created_at', { ascending: false });
  if (error) {
    throw new Error(`prompts-store DB load failed: ${error.message}`);
  }
  return (data ?? [])
    .filter(r => r.is_active === true)
    .map(r => ({
      role: r.role as PromptRole,
      version: r.version as string,
      content: r.content as string,
      canary_pct: Number(r.canary_pct ?? 0),
    }));
}

async function getCached(): Promise<CachedPrompt[]> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) {
    return cache.entries;
  }
  try {
    const entries = await loadFromDb();
    cache = { entries, loadedAt: now };
    return entries;
  } catch (err) {
    console.error('[prompts-store] DB load failed; using fail-soft constants', err);
    // Fail-soft: surface an empty list so the caller falls back to constants.
    return [];
  }
}

/** Stable 0-99 hash of a conversation id. Same id → same bucket every
 *  time, so a conversation that lands in the canary stays there for
 *  every turn (the model never switches prompts mid-stream). */
function canaryBucket(conversationId: string): number {
  const h = crypto.createHash('sha256').update(conversationId).digest('hex');
  return parseInt(h.slice(0, 8), 16) % 100;
}

/** Map AppRole → PromptRole (the DB enum). */
function mapAppRoleToPromptRole(role: AppRole): PromptRole {
  switch (role) {
    case 'housekeeping':    return 'housekeeping';
    case 'maintenance':     return 'housekeeping'; // similar floor-level role
    case 'general_manager': return 'general_manager';
    case 'front_desk':      return 'general_manager';
    case 'owner':           return 'owner';
    case 'admin':           return 'admin';
    default:                return 'housekeeping';
  }
}

export interface ResolvedPrompts {
  base: { version: string; content: string };
  role: { version: string; content: string };
  /** Combined version stamp for telemetry: "<baseVer>+<roleVer>" or
   *  just the matching version when both are identical. */
  versionLabel: string;
}

/**
 * Resolve the prompt content for a given AppRole + conversation. Picks
 * the active row from the DB cache; falls back to constants from
 * prompts.ts on DB outage. Canary logic applies when a row has
 * canary_pct > 0 (currently this is a future-facing field — the seed
 * has all rows at canary_pct=100 meaning they're the canonical version
 * for their role).
 */
export async function resolvePrompts(
  appRole: AppRole,
  conversationId: string,
): Promise<ResolvedPrompts> {
  const promptRole = mapAppRoleToPromptRole(appRole);
  const entries = await getCached();

  const baseFromDb = entries.find(e => e.role === 'base');
  const roleFromDb = entries.find(e => e.role === promptRole);

  // Future canary: when we have multiple active versions per role with
  // canary_pct on one of them, this bucket decides. With the current
  // single-active-per-role schema, this is a no-op — canary_pct on the
  // active row is purely informational until L2 v2 enables multi-row.
  const _bucket = canaryBucket(conversationId);
  void _bucket;

  const base = baseFromDb
    ? { version: baseFromDb.version, content: baseFromDb.content }
    : { version: PROMPT_VERSION, content: FALLBACK_PROMPTS.base };
  const role = roleFromDb
    ? { version: roleFromDb.version, content: roleFromDb.content }
    : { version: PROMPT_VERSION, content: FALLBACK_PROMPTS[promptRole] };

  const versionLabel = base.version === role.version
    ? base.version
    : `base:${base.version}+role:${role.version}`;

  return { base, role, versionLabel };
}

/** Test-only: clear the in-memory cache. Useful after the admin route
 *  Activate handler runs so the new active version is visible on the
 *  same function instance immediately, instead of waiting for TTL. */
export function invalidatePromptsCache(): void {
  cache = null;
}
