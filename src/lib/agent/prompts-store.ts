// ─── Prompts store ─────────────────────────────────────────────────────
// Loads prompts from the `agent_prompts` DB table, with an in-process
// 30s cache.
//
// Longevity L2 (2026-05-13). Replaces the static-constant lookup that
// `buildSystemPrompt` previously did. The constants in prompts.ts are
// retained as the fail-soft baseline when the DB is unreachable.
//
// Round 11 T3 (2026-05-13): removed dead canary-rollout machinery.
// Product decision is to always flip prompts globally; an operator
// rolls back by re-activating the prior version. The earlier
// `canaryBucket()` + `canary_pct` schema column were never used by
// the resolver and have been ripped out (and the column dropped in
// migration 0107).
//
// Design notes:
//
//   - One row per (role, version) in agent_prompts. is_active=true on
//     exactly one row per role at a time, enforced by the partial
//     unique index on (role) WHERE is_active=true.
//
//   - Activation is atomic via the staxis_activate_prompt RPC (round
//     10 F5): deactivate-others + activate-target inside one
//     transaction. Readers never see a zero-active-rows window.
//
//   - Cache TTL is 30s. Each Vercel function instance reads the DB
//     at most every 30 seconds. After an admin activates a new
//     version, propagation takes up to 30s — acceptable for this scale.
//
//   - Fail-soft: any DB error short-circuits to the constant from
//     prompts.ts. Chat keeps working under a Supabase outage.

import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AppRole } from '@/lib/roles';
import { PROMPT_VERSION, FALLBACK_PROMPTS } from './prompts';

export type PromptRole = 'base' | 'housekeeping' | 'general_manager' | 'owner' | 'admin' | 'summarizer';

/** Chat-facing prompt roles. Excludes 'summarizer' because that one is
 *  consumed by the background summarizer cron, never composed with a
 *  base prompt for a user turn. resolvePrompts() — the user-facing
 *  composer — takes ChatPromptRole only. */
type ChatPromptRole = Exclude<PromptRole, 'summarizer'>;

interface CachedPrompt {
  role: PromptRole;
  version: string;
  content: string;
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
    .select('role, version, content, is_active, created_at')
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

/** Map AppRole → ChatPromptRole. Never returns 'summarizer'. */
function mapAppRoleToPromptRole(role: AppRole): ChatPromptRole {
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
 * prompts.ts on DB outage.
 *
 * The conversationId argument is preserved on the signature in case
 * we re-introduce per-conversation routing later (multi-active rows,
 * etc.), but is currently unused — the active row is global.
 */
export async function resolvePrompts(
  appRole: AppRole,
  _conversationId: string,
): Promise<ResolvedPrompts> {
  const promptRole = mapAppRoleToPromptRole(appRole);
  const entries = await getCached();

  const baseFromDb = entries.find(e => e.role === 'base');
  const roleFromDb = entries.find(e => e.role === promptRole);

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

export interface ActivePrompt {
  version: string;
  content: string;
}

/**
 * Fetch the single active prompt for a given role, without the
 * base+role composition that resolvePrompts does. Used by the
 * summarizer (Round 11 T1) which needs a standalone prompt, not a
 * user-facing base+role pair.
 *
 * Fail-soft: returns null on DB outage so callers can fall back to
 * their constant. Chat-path (resolvePrompts) handles this differently
 * because it has FALLBACK_PROMPTS — for the summarizer, the caller
 * holds its own constant.
 */
export async function getActivePrompt(role: PromptRole): Promise<ActivePrompt | null> {
  const entries = await getCached();
  const row = entries.find(e => e.role === role);
  if (!row) return null;
  return { version: row.version, content: row.content };
}
