// ═══════════════════════════════════════════════════════════════════════════
// Standing rules — "teach it your way".
//
// A manager says something like "always tell me before any order over $200",
// and from then on the copilot at THIS hotel knows it. The sentence is stored
// in the manager's own words, not paraphrased and not slugged, because the
// whole promise of a standing rule is that the person decided what it says.
//
// Backing table: hotel_standing_rules (migration 0417), deny-all RLS,
// service-role only. Reads and writes come through /api/companion/rules and the
// staxis_set_standing_rule tool, both of which check the session and property
// access before they get here.
//
// WHY NOT company_knowledge (0365): scope, authority and shape all differ. The
// argument is written out at the top of the migration and is not repeated here,
// but the short version is that a company rule binds every hotel a company
// operates and renders ABOVE the hotel's own facts, so putting a hotel's rule in
// that table would let one GM legislate for the group.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

export const STANDING_RULE_MIN_CHARS = 8;
export const STANDING_RULE_MAX_CHARS = 400;

/**
 * Most live rules one hotel may hold.
 *
 * A ceiling rather than a budget: the prompt block has its own character cap
 * that drops the overflow silently, and a hotel quietly past that cap would
 * have rules it can see in the list and the copilot never reads. Refusing the
 * write is the honest failure.
 */
export const STANDING_RULE_MAX_PER_HOTEL = 40;

export interface StandingRule {
  id: string;
  propertyId: string;
  ruleText: string;
  createdByAccountId: string | null;
  createdByName: string | null;
  createdByRole: string | null;
  createdAt: string;
}

interface RuleRow {
  id: string;
  property_id: string;
  rule_text: string;
  created_by_account_id: string | null;
  created_by_name: string | null;
  created_by_role: string | null;
  created_at: string;
}

function toRule(row: RuleRow): StandingRule {
  return {
    id: row.id,
    propertyId: row.property_id,
    ruleText: row.rule_text,
    createdByAccountId: row.created_by_account_id,
    createdByName: row.created_by_name,
    createdByRole: row.created_by_role,
    createdAt: row.created_at,
  };
}

/**
 * This hotel's live rules, oldest first.
 *
 * NEVER THROWS. A rule list that fails to load must not take down the chat turn
 * it was being assembled for: the copilot without a hotel's standing rules is
 * the copilot as it was last week, while a copilot that 500s is no copilot.
 * The list SCREEN reports its own failure separately, through the route.
 */
export async function listStandingRules(propertyId: string): Promise<StandingRule[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('hotel_standing_rules')
      .select('id, property_id, rule_text, created_by_account_id, created_by_name, created_by_role, created_at')
      .eq('property_id', propertyId)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(STANDING_RULE_MAX_PER_HOTEL * 2);
    if (error) {
      log.warn('[companion-rules] list failed', { propertyId, err: error.message });
      return [];
    }
    return ((data ?? []) as RuleRow[]).map(toRule);
  } catch (e) {
    log.warn('[companion-rules] list threw', {
      propertyId,
      err: e instanceof Error ? e.message : 'unknown',
    });
    return [];
  }
}

export type StandingRuleWrite =
  | { ok: true; rule: StandingRule }
  | { ok: false; reason: 'too_short' | 'too_long' | 'too_many' | 'rejected' | 'failed'; error: string };

/**
 * Store one rule.
 *
 * Validates in this module rather than trusting the route, because there are two
 * writers (the route and the agent tool) and a validation that lives in one
 * caller is a validation the other caller does not have. The database CHECKs
 * behind it are the third layer and the one that actually cannot be skipped.
 */
export async function storeStandingRule(input: {
  propertyId: string;
  ruleText: string;
  accountId: string;
  authorName: string | null;
  authorRole: string | null;
}): Promise<StandingRuleWrite> {
  const text = input.ruleText.trim().replace(/\s+/g, ' ');
  if (text.length < STANDING_RULE_MIN_CHARS) {
    return {
      ok: false,
      reason: 'too_short',
      error: 'That is too short to follow. Say it as a full sentence.',
    };
  }
  if (text.length > STANDING_RULE_MAX_CHARS) {
    return {
      ok: false,
      reason: 'too_long',
      error: `Keep a standing rule under ${STANDING_RULE_MAX_CHARS} characters. One rule at a time works best.`,
    };
  }

  const existing = await listStandingRules(input.propertyId);
  if (existing.length >= STANDING_RULE_MAX_PER_HOTEL) {
    return {
      ok: false,
      reason: 'too_many',
      error: `This hotel already has ${STANDING_RULE_MAX_PER_HOTEL} standing rules, which is as many as I can follow well. Remove one first.`,
    };
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('hotel_standing_rules')
      .insert({
        property_id: input.propertyId,
        rule_text: text,
        created_by_account_id: input.accountId,
        created_by_name: input.authorName,
        created_by_role: input.authorRole,
      })
      .select('id, property_id, rule_text, created_by_account_id, created_by_name, created_by_role, created_at')
      .single();
    if (error || !data) {
      // A CHECK refusal lands here. It is the marker-forgery guard or a length
      // the trim let through, and either way the honest answer is that nothing
      // was written rather than a generic failure.
      log.warn('[companion-rules] insert failed', {
        propertyId: input.propertyId,
        err: error?.message ?? 'no row',
      });
      return {
        ok: false,
        reason: 'rejected',
        error: 'I could not save that one. Try saying it in plain words, without any brackets or symbols.',
      };
    }
    clearStandingRulesCache(input.propertyId);
    return { ok: true, rule: toRule(data as RuleRow) };
  } catch (e) {
    log.warn('[companion-rules] insert threw', {
      propertyId: input.propertyId,
      err: e instanceof Error ? e.message : 'unknown',
    });
    return { ok: false, reason: 'failed', error: 'That did not save. Try again in a moment.' };
  }
}

/**
 * Reword one rule in place.
 *
 * Added for the Knows page's Adjust button, which had no seam to write to: a
 * rule could be created and retired but never fixed, so correcting a typo meant
 * deleting the rule and telling the companion the whole thing again.
 *
 * DELIBERATELY NARROW. It sets the text and nothing else — no reassignment of
 * authorship, no reactivation of a retired rule (`is_active` stays in the
 * filter, so an id that was removed a minute ago matches nothing). The same
 * length rules as `storeStandingRule` are applied here rather than trusted from
 * the caller, for the same reason they are applied there: there are now two
 * writers and a validation living in one of them is a validation the other does
 * not have.
 */
export async function updateStandingRule(input: {
  propertyId: string;
  ruleId: string;
  ruleText: string;
}): Promise<StandingRuleWrite> {
  const text = input.ruleText.trim().replace(/\s+/g, ' ');
  if (text.length < STANDING_RULE_MIN_CHARS) {
    return {
      ok: false,
      reason: 'too_short',
      error: 'That is too short to follow. Say it as a full sentence.',
    };
  }
  if (text.length > STANDING_RULE_MAX_CHARS) {
    return {
      ok: false,
      reason: 'too_long',
      error: `Keep a standing rule under ${STANDING_RULE_MAX_CHARS} characters. One rule at a time works best.`,
    };
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('hotel_standing_rules')
      .update({ rule_text: text, updated_at: new Date().toISOString() })
      .eq('id', input.ruleId)
      .eq('property_id', input.propertyId)
      .eq('is_active', true)
      .select('id, property_id, rule_text, created_by_account_id, created_by_name, created_by_role, created_at')
      .maybeSingle();
    if (error) {
      log.warn('[companion-rules] update failed', {
        propertyId: input.propertyId,
        err: error.message,
      });
      return {
        ok: false,
        reason: 'rejected',
        error: 'I could not save that one. Try saying it in plain words, without any brackets or symbols.',
      };
    }
    clearStandingRulesCache(input.propertyId);
    if (!data) return { ok: false, reason: 'failed', error: 'That rule is no longer here.' };
    return { ok: true, rule: toRule(data as RuleRow) };
  } catch (e) {
    log.warn('[companion-rules] update threw', {
      propertyId: input.propertyId,
      err: e instanceof Error ? e.message : 'unknown',
    });
    return { ok: false, reason: 'failed', error: 'That did not save. Try again in a moment.' };
  }
}

/**
 * Retire one rule.
 *
 * Soft: the row stays so a rule that stopped being followed can still be
 * accounted for. Scoped on property AND id, so an id from another hotel matches
 * nothing rather than deleting somebody else's rule.
 */
export async function removeStandingRule(input: {
  propertyId: string;
  ruleId: string;
  accountId: string;
}): Promise<{ ok: boolean; removed: StandingRule | null }> {
  try {
    const { data, error } = await supabaseAdmin
      .from('hotel_standing_rules')
      .update({
        is_active: false,
        removed_at: new Date().toISOString(),
        removed_by_account_id: input.accountId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.ruleId)
      .eq('property_id', input.propertyId)
      .eq('is_active', true)
      .select('id, property_id, rule_text, created_by_account_id, created_by_name, created_by_role, created_at')
      .maybeSingle();
    if (error) {
      log.warn('[companion-rules] remove failed', {
        propertyId: input.propertyId,
        err: error.message,
      });
      return { ok: false, removed: null };
    }
    clearStandingRulesCache(input.propertyId);
    return { ok: true, removed: data ? toRule(data as RuleRow) : null };
  } catch {
    return { ok: false, removed: null };
  }
}

// ─── Single-flight read for the prompt path ─────────────────────────────────
//
// Same posture as company-tier.ts and for the same reason: collapse concurrent
// reads within one turn, but never carry a rule list ACROSS turns. A settled
// cache would keep following a rule a manager deleted a minute ago, and "it
// still does the thing I told it to stop doing" is the single worst way for
// this feature to fail.

const inflight = new Map<string, Promise<StandingRule[]>>();
const seeded = new Map<string, StandingRule[]>();

export async function loadStandingRulesForPrompt(propertyId: string): Promise<StandingRule[]> {
  if (seeded.has(propertyId)) return seeded.get(propertyId) ?? [];
  const existing = inflight.get(propertyId);
  if (existing) return existing;
  const pending = listStandingRules(propertyId).finally(() => inflight.delete(propertyId));
  inflight.set(propertyId, pending);
  return pending;
}

/** Test and eval seam, mirroring seedCompanyRulebookCache. */
export function seedStandingRules(propertyId: string, rules: StandingRule[]): void {
  seeded.set(propertyId, rules);
}

export function clearStandingRulesCache(propertyId?: string): void {
  if (propertyId) {
    seeded.delete(propertyId);
    inflight.delete(propertyId);
    return;
  }
  seeded.clear();
  inflight.clear();
}
