import 'server-only';

// ─── Frozen authority rules ────────────────────────────────────────────────
//
// THE INTERFACE THE VP QUEUE PLUGS INTO:
//
//   authorityRuleFor(organizationId, actionKind, amountCents)
//     -> the rule that governs an amount, or null when nothing does
//
// Everything else in this file exists to get rules INTO the store correctly.
// The reader is the contract; keep its shape stable.
//
// WHY THE RULE IS FROZEN AT CONFIRM TIME
// "Orders over $500 need VP sign-off" is a sentence. A router that re-reads
// that sentence for every purchase order is a router whose answer can change
// because a model felt different today, and the thing it decides is who has to
// sign for money. So the sentence is read ONCE — deterministically, by
// `readAuthorityRule` in rulebook-policy.ts — in front of the person who
// confirms it, and the three numbers that come out are what routing sees
// forever after. Editing the fact re-reads it, in front of a human, again.
//
// TENANT WALL: every query below filters organization_id, and the only callers
// resolve that id from the caller's own hats or from `companyForProperty`.
// company_authority_rules is deny-all RLS; this filter IS the boundary.

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  isAuthorityActionKind,
  isAuthorityApproverRole,
  type AuthorityActionKind,
  type AuthorityApproverRole,
  type AuthorityReading,
} from '@/lib/company/rulebook-policy';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthorityRule {
  id: string;
  organizationId: string;
  actionKind: AuthorityActionKind;
  thresholdCents: number;
  thresholdInclusive: boolean;
  approverRole: AuthorityApproverRole;
  sourceFactId: string;
}

interface RawRule {
  id: string;
  organization_id: string;
  action_kind: string;
  threshold_cents: number | string;
  threshold_inclusive: boolean | null;
  approver_role: string;
  source_fact_id: string;
}

/** Strong-to-weak, for picking between two rules that both apply. */
const APPROVER_STRENGTH: Record<AuthorityApproverRole, number> = {
  owner: 3,
  vp: 2,
  finance: 1,
  general_manager: 0,
};

function mapRule(row: RawRule): AuthorityRule | null {
  if (!isAuthorityActionKind(row.action_kind)) return null;
  if (!isAuthorityApproverRole(row.approver_role)) return null;
  const cents = typeof row.threshold_cents === 'string'
    ? Number.parseInt(row.threshold_cents, 10)
    : row.threshold_cents;
  if (!Number.isFinite(cents)) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    actionKind: row.action_kind,
    thresholdCents: cents,
    thresholdInclusive: row.threshold_inclusive === true,
    approverRole: row.approver_role,
    sourceFactId: row.source_fact_id,
  };
}

const SELECT_COLS =
  'id, organization_id, action_kind, threshold_cents, threshold_inclusive, approver_role, source_fact_id';

/** Does this amount clear the rule's boundary? */
export function ruleApplies(rule: AuthorityRule, amountCents: number): boolean {
  return rule.thresholdInclusive
    ? amountCents >= rule.thresholdCents
    : amountCents > rule.thresholdCents;
}

/**
 * THE READER. Which rule governs `amountCents` of `actionKind` at this company?
 *
 * When several rules apply — "over $500 → VP", "over $5,000 → owner" — a $6,000
 * order is governed by the OWNER rule. The company wrote both because bigger
 * money needs a bigger signature, so the winner is the applicable rule with the
 * HIGHEST threshold, and a stronger approver breaks a tie. Returning the VP
 * rule for a $6,000 order would route around the owner entirely, which is the
 * one failure this function must never have.
 *
 * Returns null for: no rules, an amount under every threshold, a different
 * action kind, another company's rules, or a store that cannot answer. Null
 * means "nothing in the rulebook governs this" — never "approved".
 */
export async function authorityRuleFor(
  organizationId: string,
  actionKind: string,
  amountCents: number,
): Promise<AuthorityRule | null> {
  if (!UUID_RX.test(organizationId ?? '')) return null;
  if (!isAuthorityActionKind(actionKind)) return null;
  if (!Number.isFinite(amountCents) || amountCents < 0) return null;

  const { data, error } = await supabaseAdmin
    .from('company_authority_rules')
    .select(SELECT_COLS)
    .eq('organization_id', organizationId)
    .eq('action_kind', actionKind)
    .eq('is_active', true);
  if (error || !Array.isArray(data)) return null;

  let winner: AuthorityRule | null = null;
  for (const raw of data as RawRule[]) {
    const rule = mapRule(raw);
    if (!rule || !ruleApplies(rule, amountCents)) continue;
    if (!winner) { winner = rule; continue; }
    if (rule.thresholdCents > winner.thresholdCents) { winner = rule; continue; }
    if (rule.thresholdCents === winner.thresholdCents
      && APPROVER_STRENGTH[rule.approverRole] > APPROVER_STRENGTH[winner.approverRole]) {
      winner = rule;
    }
  }
  return winner;
}

/** Every live rule for a company — the rulebook screen's "what this means" list. */
export async function listAuthorityRules(organizationId: string): Promise<AuthorityRule[]> {
  if (!UUID_RX.test(organizationId ?? '')) return [];
  const { data, error } = await supabaseAdmin
    .from('company_authority_rules')
    .select(SELECT_COLS)
    .eq('organization_id', organizationId)
    .eq('is_active', true)
    .order('action_kind', { ascending: true })
    .order('threshold_cents', { ascending: true });
  if (error || !Array.isArray(data)) return [];
  return (data as RawRule[]).map(mapRule).filter((r): r is AuthorityRule => r !== null);
}

/**
 * Freeze a reading into a rule. Called ONLY from the confirm/edit path, after a
 * human has seen the read-back sentence — never from intake.
 *
 * Replaces the fact's previous rule rather than stacking a second one: one
 * confirmed fact is one rule, so re-confirming an edited sentence changes the
 * gate instead of leaving the old threshold quietly in force alongside it.
 */
export async function freezeAuthorityRule(
  organizationId: string,
  sourceFactId: string,
  reading: AuthorityReading,
  actorAccountId: string | null,
): Promise<{ ok: boolean; ruleId?: string; error?: string }> {
  if (!UUID_RX.test(organizationId ?? '') || !UUID_RX.test(sourceFactId ?? '')) {
    return { ok: false, error: 'bad id' };
  }
  const cleared = await clearAuthorityRuleForFact(organizationId, sourceFactId);
  if (!cleared.ok) return { ok: false, error: cleared.error };

  const { data, error } = await supabaseAdmin
    .from('company_authority_rules')
    .insert({
      organization_id: organizationId,
      action_kind: reading.actionKind,
      threshold_cents: reading.thresholdCents,
      threshold_inclusive: reading.thresholdInclusive,
      approver_role: reading.approverRole,
      source_fact_id: sourceFactId,
      created_by_account_id: actorAccountId,
    })
    .select('id')
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, ruleId: (data as { id: string } | null)?.id };
}

/**
 * Retire the rule frozen from a fact. Used when the fact is removed, when an
 * edit no longer reads as an approval requirement, and before re-freezing.
 *
 * Scoped by organization_id AND source_fact_id — the id came from our own read,
 * but the tenant filter is the guarantee, so it is never dropped.
 */
export async function clearAuthorityRuleForFact(
  organizationId: string,
  sourceFactId: string,
): Promise<{ ok: boolean; cleared: number; error?: string }> {
  if (!UUID_RX.test(organizationId ?? '') || !UUID_RX.test(sourceFactId ?? '')) {
    return { ok: false, cleared: 0, error: 'bad id' };
  }
  const { data, error } = await supabaseAdmin
    .from('company_authority_rules')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .eq('source_fact_id', sourceFactId)
    .eq('is_active', true)
    .select('id');
  if (error) return { ok: false, cleared: 0, error: error.message };
  return { ok: true, cleared: (data ?? []).length };
}
