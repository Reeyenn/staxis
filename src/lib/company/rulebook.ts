import 'server-only';

// ─── The company rulebook — server-only data access ────────────────────────
//
// The company's own knowledge: "all our hotels use Ecolab", "orders over $500
// need VP sign-off". One level up from the per-hotel Knows screen, and the same
// life-cycle — open box → extract → confirm / edit / remove.
//
// SERVICE-ROLE ONLY. `company_knowledge` is deny-all RLS and supabaseAdmin
// bypasses it, so the `.eq('organization_id', …)` on every query below IS the
// per-tenant guarantee. Never drop it, and never look a row up by id alone
// "because ids are unguessable" — that is the same reasoning that would let one
// management company edit another's rulebook.
//
// WALL B: no function here takes a property id or resolves a company itself.
// Callers hand in an organizationId they got from `companyForProperty` or from
// the caller's own hats, both of which are in src/lib/company/access.ts. There
// is exactly one place that turns a hotel into a company, and it is not here.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { propertiesOfOrganization } from '@/lib/company/access';
import {
  coerceCompanyCategory,
  readAuthorityRule,
  readPolicyValue,
  type CompanyCategory,
  type ComparablePolicyKey,
  type HotelSettingSnapshot,
} from '@/lib/company/rulebook-policy';
import { clearAuthorityRuleForFact, freezeAuthorityRule } from '@/lib/company/authority';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** company_knowledge.content's column CHECK. */
export const COMPANY_FACT_MAX_CONTENT = 500;
/** company_knowledge.topic's column CHECK. */
export const COMPANY_FACT_MAX_TOPIC = 80;

export type CompanyFactSource = 'explicit_user' | 'inferred' | 'correction';
export type CompanyFactReviewState = 'unreviewed' | 'confirmed';

export interface CompanyFact {
  id: string;
  organizationId: string;
  topic: string;
  content: string;
  category: CompanyCategory;
  source: CompanyFactSource;
  reviewState: CompanyFactReviewState;
  /** Set only on a CONFIRMED fact that pins a comparable setting. */
  policyKey: string | null;
  policyValue: string | null;
  createdByName: string | null;
  updatedAt: string;
}

interface RawFact {
  id: string;
  organization_id: string;
  topic: string;
  content: string;
  category: string | null;
  source: string | null;
  review_state: string | null;
  policy_key: string | null;
  policy_value: string | null;
  created_by_name: string | null;
  updated_at: string;
}

// One string literal on purpose: supabase-js infers the row type from it, and
// splitting it across a `+` collapses that inference to GenericStringError[].
const SELECT_COLS =
  'id, organization_id, topic, content, category, source, review_state, policy_key, policy_value, created_by_name, updated_at';

function mapFact(row: RawFact): CompanyFact {
  return {
    id: row.id,
    organizationId: row.organization_id,
    topic: row.topic,
    content: row.content,
    category: coerceCompanyCategory(row.category),
    source: (row.source === 'inferred' || row.source === 'correction')
      ? row.source
      : 'explicit_user',
    // Anything but the explicit marker reads as established, matching the DB
    // default — a row that somehow carries NULL is never mistaken for pending.
    reviewState: row.review_state === 'unreviewed' ? 'unreviewed' : 'confirmed',
    policyKey: row.policy_key,
    policyValue: row.policy_value,
    createdByName: row.created_by_name,
    updatedAt: row.updated_at,
  };
}

/** Lower_snake_case slug, capped. Mirrors the hotel intake slugifier. */
export function slugifyCompanyTopic(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, COMPANY_FACT_MAX_TOPIC);
}

/** Every live fact in the book — the rulebook screen's list. */
export async function listCompanyFacts(organizationId: string, limit = 200): Promise<CompanyFact[]> {
  if (!UUID_RX.test(organizationId ?? '')) return [];
  const { data, error } = await supabaseAdmin
    .from('company_knowledge')
    .select(SELECT_COLS)
    .eq('organization_id', organizationId)
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as RawFact[]).map(mapFact);
}

/**
 * The facts that reach the copilot: live AND confirmed.
 *
 * The `review_state` filter is the whole guarantee behind the open box. A fact
 * pulled out of a pasted email must not act as company policy at twenty hotels
 * before a human has approved it. The badge on the card is the label; THIS is
 * the enforcement. Do not remove it to "give the model more context".
 *
 * Ordered by (category, topic) rather than by time: this text lands in the
 * CACHED half of the system prompt, so the byte order has to depend only on the
 * content, not on which fact was edited most recently.
 */
export async function getConfirmedCompanyFacts(organizationId: string): Promise<CompanyFact[]> {
  if (!UUID_RX.test(organizationId ?? '')) return [];
  const { data, error } = await supabaseAdmin
    .from('company_knowledge')
    .select(SELECT_COLS)
    .eq('organization_id', organizationId)
    .eq('is_active', true)
    .eq('review_state', 'confirmed')
    .order('category', { ascending: true })
    .order('topic', { ascending: true })
    .limit(200);
  if (error || !data) return [];
  return (data as RawFact[]).map(mapFact);
}

export interface StoreCompanyFactInput {
  organizationId: string;
  topic: string;
  content: string;
  category?: CompanyCategory;
  source?: CompanyFactSource;
  createdByAccountId?: string | null;
  createdByName?: string | null;
  createdByRole?: string | null;
}

export type StoreCompanyFactAction = 'inserted' | 'updated' | 'skipped' | 'company_full';

/**
 * Upsert a fact by topic, through the advisory-locked RPC.
 *
 * 'skipped' means a CONFIRMED fact already owns that topic and the incoming
 * write was an extraction — the company already decided what that line says.
 */
export async function storeCompanyFact(
  input: StoreCompanyFactInput,
): Promise<{ ok: boolean; action?: StoreCompanyFactAction; factId?: string | null; error?: string }> {
  const { data, error } = await supabaseAdmin.rpc('staxis_store_company_fact', {
    p_organization_id: input.organizationId,
    p_topic: input.topic,
    p_content: input.content,
    p_category: input.category ?? 'standards',
    p_source: input.source ?? 'explicit_user',
    p_created_by_account_id: input.createdByAccountId ?? null,
    p_created_by_name: input.createdByName ?? null,
    p_created_by_role: input.createdByRole ?? null,
  });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  return {
    ok: true,
    action: row?.action as StoreCompanyFactAction | undefined,
    factId: (row?.fact_id as string | null) ?? null,
  };
}

export interface CompanyFactActor {
  accountId: string | null;
  name: string | null;
  role: string | null;
}

/**
 * The structured reading a fact would get if confirmed right now. Shown next to
 * the Confirm button so the person approving sees exactly what will be frozen,
 * and stored by `applyStructuredReading` when they say yes.
 */
export function structuredReadingFor(content: string) {
  return {
    authority: readAuthorityRule(content),
    policy: readPolicyValue(content),
  };
}

/**
 * Confirm — "yes, that's right."
 *
 * Promotes the row to a human-authored fact (source explicit_user, confirmed),
 * which is what makes it reach every hotel's copilot, and freezes its structured
 * reading. The reading is written HERE and nowhere else: an unconfirmed fact
 * never produces an authority rule, so a pasted document cannot change who signs
 * for money without a person saying so.
 */
export async function confirmCompanyFact(
  organizationId: string,
  id: string,
  actor: CompanyFactActor,
): Promise<{ ok: boolean; confirmed: boolean; error?: string }> {
  if (!UUID_RX.test(organizationId ?? '') || !UUID_RX.test(id ?? '')) {
    return { ok: false, confirmed: false, error: 'bad id' };
  }
  const existing = await readLiveFact(organizationId, id);
  if (!existing) return { ok: true, confirmed: false };

  const { error } = await supabaseAdmin
    .from('company_knowledge')
    .update({
      source: 'explicit_user',
      review_state: 'confirmed',
      created_by_account_id: actor.accountId,
      created_by_name: actor.name,
      created_by_role: actor.role,
    })
    .eq('organization_id', organizationId)
    .eq('id', id)
    .eq('is_active', true);
  if (error) return { ok: false, confirmed: false, error: error.message };

  await applyStructuredReading(organizationId, id, existing.content, actor.accountId ?? null);
  return { ok: true, confirmed: true };
}

/**
 * Edit — the company rewrites the line.
 *
 * An edited fact is a CORRECTION: a human has now authored it, so it gets the
 * same promotion as Confirm, and its structured reading is re-derived from the
 * NEW words. A rule frozen from the old sentence is retired in the same call —
 * leaving it in force would mean the book says one thing and the gate does
 * another.
 */
export async function editCompanyFact(
  organizationId: string,
  id: string,
  patch: { content: string; category?: CompanyCategory },
  actor: CompanyFactActor,
): Promise<{ ok: boolean; updated: boolean; error?: string }> {
  if (!UUID_RX.test(organizationId ?? '') || !UUID_RX.test(id ?? '')) {
    return { ok: false, updated: false, error: 'bad id' };
  }
  const content = patch.content.trim();
  if (!content || content.length > COMPANY_FACT_MAX_CONTENT) {
    return { ok: false, updated: false, error: 'bad content' };
  }
  const { data, error } = await supabaseAdmin
    .from('company_knowledge')
    .update({
      content,
      ...(patch.category ? { category: patch.category } : {}),
      source: 'correction',
      review_state: 'confirmed',
      created_by_account_id: actor.accountId,
      created_by_name: actor.name,
      created_by_role: actor.role,
    })
    .eq('organization_id', organizationId)
    .eq('id', id)
    .eq('is_active', true)
    .select('id');
  if (error) return { ok: false, updated: false, error: error.message };
  if ((data ?? []).length === 0) return { ok: true, updated: false };

  await applyStructuredReading(organizationId, id, content, actor.accountId ?? null);
  return { ok: true, updated: true };
}

/**
 * Remove — permanent, and the copy on the screen says so.
 *
 * The row is retained (is_active=false) for the audit trail but leaves every
 * read, leaves the prompt, and takes its authority rule with it. Nothing in
 * this product writes a company fact automatically, so there is no consolidator
 * that could quietly bring it back; a later re-statement of the same subject
 * starts a fresh UNCONFIRMED row (the live-topic unique index is partial on
 * is_active), which is the honest behaviour — it comes back only if a human
 * approves it again.
 */
export async function removeCompanyFact(
  organizationId: string,
  id: string,
): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  if (!UUID_RX.test(organizationId ?? '') || !UUID_RX.test(id ?? '')) {
    return { ok: false, removed: false, error: 'bad id' };
  }
  const { data, error } = await supabaseAdmin
    .from('company_knowledge')
    .update({ is_active: false })
    .eq('organization_id', organizationId)
    .eq('id', id)
    .eq('is_active', true)
    .select('id');
  if (error) return { ok: false, removed: false, error: error.message };
  const removed = (data ?? []).length > 0;
  if (removed) await clearAuthorityRuleForFact(organizationId, id);
  return { ok: true, removed };
}

async function readLiveFact(organizationId: string, id: string): Promise<CompanyFact | null> {
  const { data, error } = await supabaseAdmin
    .from('company_knowledge')
    .select(SELECT_COLS)
    .eq('organization_id', organizationId)
    .eq('id', id)
    .eq('is_active', true)
    .maybeSingle();
  if (error || !data) return null;
  return mapFact(data as RawFact);
}

/**
 * Freeze (or retire) the structured reading of a fact that a human just
 * approved. Both halves are re-derived from the current words every time, so a
 * sentence that STOPS being an approval requirement stops being a gate.
 */
async function applyStructuredReading(
  organizationId: string,
  factId: string,
  content: string,
  actorAccountId: string | null,
): Promise<void> {
  const { authority, policy } = structuredReadingFor(content);

  if (authority) {
    await freezeAuthorityRule(organizationId, factId, authority, actorAccountId);
  } else {
    await clearAuthorityRuleForFact(organizationId, factId);
  }

  await supabaseAdmin
    .from('company_knowledge')
    .update({
      policy_key: policy?.key ?? null,
      policy_value: policy?.value ?? null,
    })
    .eq('organization_id', organizationId)
    .eq('id', factId)
    .eq('is_active', true);
}

// ─── The comparable half of a contradiction ────────────────────────────────

interface RawProperty {
  id: string;
  name: string | null;
  checkout_minutes: number | null;
  stayover_minutes: number | null;
  housekeeping_setup: unknown;
}

/**
 * Read each of the company's hotels' configured values for the comparable
 * settings. A hotel that has not configured something contributes NOTHING for
 * that key — absence is never a contradiction.
 */
export async function companyHotelSettings(organizationId: string): Promise<HotelSettingSnapshot[]> {
  const propertyIds = await propertiesOfOrganization(organizationId);
  if (propertyIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id, name, checkout_minutes, stayover_minutes, housekeeping_setup')
    .in('id', propertyIds);
  if (error || !Array.isArray(data)) return [];

  return (data as RawProperty[]).map((row) => {
    const values: Partial<Record<ComparablePolicyKey, string>> = {};

    const setup = row.housekeeping_setup;
    if (setup && typeof setup === 'object' && !Array.isArray(setup)) {
      const start = (setup as Record<string, unknown>).shiftStartTime;
      if (typeof start === 'string' && /^\d{2}:\d{2}$/.test(start)) {
        values.housekeeping_start_time = start;
      }
    }
    if (typeof row.checkout_minutes === 'number' && row.checkout_minutes > 0) {
      values.checkout_clean_minutes = String(row.checkout_minutes);
    }
    if (typeof row.stayover_minutes === 'number' && row.stayover_minutes > 0) {
      values.stayover_clean_minutes = String(row.stayover_minutes);
    }

    return {
      propertyId: row.id,
      propertyName: row.name ?? 'This hotel',
      values,
    };
  }).sort((a, b) => a.propertyName.localeCompare(b.propertyName));
}
