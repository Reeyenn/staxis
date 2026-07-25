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
import { env } from '@/lib/env';
import type { AppRole } from '@/lib/roles';
import { PROMPT_VERSION, FALLBACK_PROMPTS } from './prompts';

export type PromptRole =
  | 'base'
  | 'housekeeping'
  | 'general_manager'
  | 'owner'
  | 'admin'
  | 'summarizer'
  | 'family';

/** Chat-facing prompt roles. Excludes 'summarizer' because that one is
 *  consumed by the background summarizer cron, never composed with a
 *  base prompt for a user turn, and 'family' because the PMS-family row is
 *  an ADDENDUM keyed by pms_family — never a role a user can have.
 *  resolvePrompts() — the user-facing composer — takes ChatPromptRole only. */
type ChatPromptRole = Exclude<PromptRole, 'summarizer' | 'family'>;

interface CachedPrompt {
  role: PromptRole;
  version: string;
  content: string;
  /** A3 tiers: NULL for every global row; the PMS family key for role='family'
   *  rows. DB CHECK agent_prompts_tier_coherence_ck (0338) guarantees the two
   *  fields agree, so this is never half-specified. */
  pmsFamily: string | null;
}

interface CacheEntry {
  entries: CachedPrompt[];
  loadedAt: number;
}

const CACHE_TTL_MS = 30_000;
let cache: CacheEntry | null = null;

async function loadFromDb(): Promise<CachedPrompt[]> {
  // A3: the active filter moved server-side. It used to pull the table's whole
  // history and filter in JS — fine at 7 rows, but every prompt revision ever
  // written grows that payload, and the family tier multiplies revisions by the
  // number of PMS families. The partial unique index
  // agent_prompts_active_per_role_family_uq (0338) makes this at most one row
  // per (role, family).
  const query = (columns: string) => supabaseAdmin
    .from('agent_prompts')
    .select(columns)
    .eq('is_active', true)
    .order('role')
    .order('created_at', { ascending: false });

  let { data, error } = await query('role, version, content, pms_family');
  if (error && /pms_family/.test(error.message)) {
    // Deploy-order safety: if this code lands before migration 0338 is
    // applied, the column does not exist and PostgREST 400s. Without this
    // retry the whole chat would silently drop to the fail-soft CONSTANTS —
    // i.e. quietly older instructions than the live DB rows — for the length
    // of the window. Falling back to the two-tier read keeps behaviour exactly
    // as it is today. Safe to delete once 0338 is applied everywhere.
    ({ data, error } = await query('role, version, content'));
  }
  if (error) {
    throw new Error(`prompts-store DB load failed: ${error.message}`);
  }
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map(r => ({
    role: r.role as PromptRole,
    version: r.version as string,
    content: r.content as string,
    pmsFamily: (r.pms_family as string | null | undefined) ?? null,
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

export interface ResolvedFamilyPrompt {
  /** The PMS family this addendum belongs to (properties.pms_type). */
  pmsFamily: string;
  version: string;
  content: string;
}

export interface ResolvedPrompts {
  base: { version: string; content: string };
  role: { version: string; content: string };
  /** A3 tiers — the PMS-family addendum for this hotel, or null when the
   *  hotel has no resolvable family OR no family row is active for it.
   *
   *  There is deliberately NO fallback constant for this tier: family content
   *  only ever exists in the DB, so "DB down" and "no family row written yet"
   *  collapse to the same, safe, additive-zero behaviour. */
  family: ResolvedFamilyPrompt | null;
  /** Combined version stamp for telemetry: "<baseVer>+<roleVer>" or
   *  just the matching version when both are identical. The family segment is
   *  added by the prompt assembler, not here — see prompts.ts. */
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
  /** A3 tiers — the hotel's PMS family (HotelSnapshot.property.pmsFamily).
   *  null means "this hotel has no family tier"; the lookup is skipped
   *  entirely rather than matching rows with a NULL key. */
  pmsFamily: string | null = null,
): Promise<ResolvedPrompts> {
  const promptRole = mapAppRoleToPromptRole(appRole);
  const entries = await getCached();

  const baseFromDb = entries.find(e => e.role === 'base');
  const roleFromDb = entries.find(e => e.role === promptRole);
  const familyFromDb = !familyAddendumOverride && pmsFamily
    ? entries.find(e => e.role === 'family' && e.pmsFamily === pmsFamily)
    : undefined;

  const base = baseFromDb
    ? { version: baseFromDb.version, content: baseFromDb.content }
    : { version: PROMPT_VERSION, content: FALLBACK_PROMPTS.base };
  const role = roleFromDb
    ? { version: roleFromDb.version, content: roleFromDb.content }
    : { version: PROMPT_VERSION, content: FALLBACK_PROMPTS[promptRole] };

  const family: ResolvedFamilyPrompt | null = familyAddendumOverride
    ?? (familyFromDb && familyFromDb.pmsFamily
      ? {
          pmsFamily: familyFromDb.pmsFamily,
          version: familyFromDb.version,
          content: familyFromDb.content,
        }
      : null);

  const versionLabel = base.version === role.version
    ? base.version
    : `base:${base.version}+role:${role.version}`;

  return { base, role, family, versionLabel };
}

/** Test-only: clear the in-memory cache. Useful after the admin route
 *  Activate handler runs so the new active version is visible on the
 *  same function instance immediately, instead of waiting for TTL. */
export function invalidatePromptsCache(): void {
  cache = null;
}

// ─── Eval seam (INV-TIER-8) ────────────────────────────────────────────────
// "A family row may ADD or NARROW behaviour, never relax a global hard rule"
// is a property of natural-language text — no CHECK constraint can guarantee
// it. The only way to test it is to run the model with a deliberately hostile
// family addendum active, which means arming one without writing a row into
// the live table.
//
// This seam THROWS in production, so it can never become a live prompt-
// injection channel: even a mistaken call from a request path fails loudly on
// the deployed app instead of quietly rewriting every hotel's instructions.
let familyAddendumOverride: ResolvedFamilyPrompt | null = null;

export function setFamilyAddendumOverride(override: ResolvedFamilyPrompt | null): void {
  if (env.NODE_ENV === 'production') {
    throw new Error('[prompts-store] setFamilyAddendumOverride is an eval seam and is unavailable in production');
  }
  familyAddendumOverride = override;
}

/**
 * Eval/test seam: seed the in-process cache with FIXTURE prompt rows.
 *
 * The hermetic eval harness needs prompt assembly to be deterministic and
 * offline. Without this it would silently exercise the fail-soft constants in
 * prompts.ts (placeholder Supabase env ⇒ DB load fails ⇒ empty list ⇒
 * fallbacks), and every prompt-content assertion would be green-lighting text
 * that production may not serve, since prod resolves the admin-editable
 * `agent_prompts` rows. Seeding makes the prompt source EXPLICIT: the harness
 * asserts the resulting versionLabel is its own fixture version, so a case can
 * never accidentally assert against the fallback constants or a real DB row.
 *
 * Not exported through any route — callers are tests + evals only.
 */
export function seedPromptsCache(
  entries: Array<{ role: PromptRole; version: string; content: string }>,
): void {
  // pms_family is absent on fixture rows; every seeded row is a GLOBAL tier row
  // (the family tier is exercised through setFamilyAddendumOverride instead).
  cache = { entries: entries.map(e => ({ ...e, pmsFamily: null })), loadedAt: Date.now() };
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
export async function getActivePrompt(
  /** INV-TIER-4, compile-time: 'family' is rejected here. A family row is an
   *  addendum keyed by pms_family, not a standalone prompt — handing one to the
   *  summarizer (this function's only caller) would give background
   *  summarization PMS guidance it has no use for, and `find` would return an
   *  arbitrary family's row. `npx tsc --noEmit` is in the gate. */
  role: Exclude<PromptRole, 'family'>,
): Promise<ActivePrompt | null> {
  const entries = await getCached();
  const row = entries.find(e => e.role === role);
  if (!row) return null;
  return { version: row.version, content: row.content };
}
