import 'server-only';

// ─── Who may read the rulebook, who may write it ───────────────────────────
//
// TWO QUESTIONS, DELIBERATELY SEPARATE:
//
//   canViewCompanyRulebook   a COMPANY-scope job (owner / VP / finance), or a
//                            hotel GM while `gms_see_rulebook` is on. Founder's
//                            ruling: "GMs should know the policies they're
//                            governed by." Read-only. NOT line staff — see
//                            `rulebookStandingFor` for what leaked while it was.
//   canEditCompanyRulebook   a COMPANY-scope job, filtered by the company's own
//                            `rulebook_editors` choice. A GM never qualifies —
//                            a property-scope hat cannot rewrite the company.
//
// The access choices themselves live in `company_access_settings` and are read
// through `companyAccessSetting`, which returns a documented DEFAULT when no row
// exists. A company that never opened the setup screen therefore behaves
// exactly as the founder specified rather than as "nothing configured, deny
// everything" — a rulebook nobody can see is worse than no rulebook.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { loadHats, type MembershipHat } from '@/lib/company/access';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── The settings vocabulary ───────────────────────────────────────────────

export const COMPANY_ACCESS_KEYS = [
  'gms_see_rulebook',
  'cross_hotel_ai_chat',
  'rulebook_editors',
  'setup_completed_at',
] as const;
export type CompanyAccessKey = (typeof COMPANY_ACCESS_KEYS)[number];

export const RULEBOOK_EDITOR_CHOICES = ['owner_only', 'owner_and_vp', 'company_scope'] as const;
export type RulebookEditorChoice = (typeof RULEBOOK_EDITOR_CHOICES)[number];

export function isCompanyAccessKey(value: unknown): value is CompanyAccessKey {
  return typeof value === 'string' && (COMPANY_ACCESS_KEYS as readonly string[]).includes(value);
}

export function isRulebookEditorChoice(value: unknown): value is RulebookEditorChoice {
  return typeof value === 'string' && (RULEBOOK_EDITOR_CHOICES as readonly string[]).includes(value);
}

/**
 * THE DEFAULTS, which are the product until somebody chooses otherwise.
 *
 *  gms_see_rulebook    'true'  and LOCKED — migration 0365's CHECK refuses any
 *                      other value, so this cannot quietly become "no".
 *  cross_hotel_ai_chat 'false' — off until a company turns it on. Asking the
 *                      copilot about twenty hotels at once is a different
 *                      product surface and it should be a decision, not a
 *                      default.
 *  rulebook_editors    'owner_and_vp' — the VP is the person who actually
 *                      maintains a company book; owner-only would mean the
 *                      owner types every line.
 */
export const COMPANY_ACCESS_DEFAULTS: Record<CompanyAccessKey, string | null> = {
  gms_see_rulebook: 'true',
  cross_hotel_ai_chat: 'false',
  rulebook_editors: 'owner_and_vp',
  setup_completed_at: null,
};

/** Values a person may actually choose. `gms_see_rulebook` is not among them. */
export const EDITABLE_ACCESS_KEYS: readonly CompanyAccessKey[] = [
  'cross_hotel_ai_chat',
  'rulebook_editors',
];

/**
 * THE INTERFACE LATER AGENTS READ. One key, one company, the stored value or
 * the documented default. Never throws; a store that cannot answer returns the
 * default, which is the conservative answer for every key above.
 */
export async function companyAccessSetting(
  organizationId: string,
  key: CompanyAccessKey,
): Promise<string | null> {
  if (!UUID_RX.test(organizationId ?? '') || !isCompanyAccessKey(key)) {
    return COMPANY_ACCESS_DEFAULTS[key] ?? null;
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('company_access_settings')
      .select('setting_value')
      .eq('organization_id', organizationId)
      .eq('setting_key', key)
      .maybeSingle();
    if (error || !data) return COMPANY_ACCESS_DEFAULTS[key];
    const value = (data as { setting_value: string | null }).setting_value;
    return value ?? COMPANY_ACCESS_DEFAULTS[key];
  } catch {
    return COMPANY_ACCESS_DEFAULTS[key];
  }
}

/** Every setting for one company, defaults filled in. The setup screen's read. */
export async function companyAccessSettings(
  organizationId: string,
): Promise<Record<CompanyAccessKey, string | null>> {
  const out = { ...COMPANY_ACCESS_DEFAULTS };
  if (!UUID_RX.test(organizationId ?? '')) return out;
  const { data, error } = await supabaseAdmin
    .from('company_access_settings')
    .select('setting_key, setting_value')
    .eq('organization_id', organizationId);
  if (error || !Array.isArray(data)) return out;
  for (const row of data as Array<{ setting_key: string; setting_value: string }>) {
    if (isCompanyAccessKey(row.setting_key)) out[row.setting_key] = row.setting_value;
  }
  return out;
}

/**
 * Save the setup choices. `gms_see_rulebook` is deliberately NOT writable —
 * the founder locked it on, the database CHECK enforces it, and accepting the
 * key here would only create a path that fails at the constraint instead of
 * saying no in plain English.
 */
export async function saveCompanyAccessSettings(
  organizationId: string,
  choices: Partial<Record<CompanyAccessKey, string>>,
  actorAccountId: string | null,
): Promise<{ ok: boolean; saved: CompanyAccessKey[]; error?: string }> {
  if (!UUID_RX.test(organizationId ?? '')) return { ok: false, saved: [], error: 'bad id' };

  const rows: Array<Record<string, unknown>> = [];
  const saved: CompanyAccessKey[] = [];
  for (const key of EDITABLE_ACCESS_KEYS) {
    const value = choices[key];
    if (value === undefined) continue;
    if (key === 'cross_hotel_ai_chat' && value !== 'true' && value !== 'false') {
      return { ok: false, saved: [], error: 'cross_hotel_ai_chat must be true or false' };
    }
    if (key === 'rulebook_editors' && !isRulebookEditorChoice(value)) {
      return { ok: false, saved: [], error: 'unknown rulebook_editors choice' };
    }
    rows.push({
      organization_id: organizationId,
      setting_key: key,
      setting_value: value,
      updated_by_account_id: actorAccountId,
      updated_at: new Date().toISOString(),
    });
    saved.push(key);
  }
  if (rows.length === 0) return { ok: true, saved: [] };

  // The locked answer is written alongside the chosen ones, so the row exists
  // for later readers rather than living only as a code default.
  rows.push({
    organization_id: organizationId,
    setting_key: 'gms_see_rulebook',
    setting_value: 'true',
    updated_by_account_id: actorAccountId,
    updated_at: new Date().toISOString(),
  });
  rows.push({
    organization_id: organizationId,
    setting_key: 'setup_completed_at',
    setting_value: new Date().toISOString(),
    updated_by_account_id: actorAccountId,
    updated_at: new Date().toISOString(),
  });

  const { error } = await supabaseAdmin
    .from('company_access_settings')
    .upsert(rows, { onConflict: 'organization_id,setting_key' });
  if (error) return { ok: false, saved: [], error: error.message };
  return { ok: true, saved };
}

// ─── Who is standing at the door ───────────────────────────────────────────

export interface RulebookStanding {
  /** The company this person's job belongs to, or null when they have none. */
  organizationId: string | null;
  canView: boolean;
  canEdit: boolean;
  /** The strongest company-scope job they hold here. null for a GM. */
  companyRole: 'owner' | 'vp' | 'finance' | null;
  /** True when a property-scope job (a GM) is the only reason they can see it. */
  viewOnlyBecauseHotelJob: boolean;
}

const COMPANY_ROLE_STRENGTH = { owner: 3, vp: 2, finance: 1 } as const;

function strongestCompanyRole(hats: readonly MembershipHat[]): 'owner' | 'vp' | 'finance' | null {
  let best: 'owner' | 'vp' | 'finance' | null = null;
  for (const hat of hats) {
    if (hat.scope !== 'company') continue;
    if (hat.role !== 'owner' && hat.role !== 'vp' && hat.role !== 'finance') continue;
    if (!best || COMPANY_ROLE_STRENGTH[hat.role] > COMPANY_ROLE_STRENGTH[best]) best = hat.role;
  }
  return best;
}

function editorChoiceAdmits(choice: string | null, role: 'owner' | 'vp' | 'finance'): boolean {
  // The owner always edits their own company's book, whatever the choice says.
  if (role === 'owner') return true;
  switch (choice) {
    case 'owner_only': return false;
    case 'company_scope': return true;
    case 'owner_and_vp':
    default:
      return role === 'vp';
  }
}

/**
 * What may this person do with this company's rulebook?
 *
 * Answers from the person's HATS at this exact company — never from
 * `accounts.role`, which is a global word and would silently make a hotel owner
 * the owner of a management company they have never heard of.
 */
export async function rulebookStandingFor(
  accountId: string,
  organizationId: string,
): Promise<RulebookStanding> {
  const denied: RulebookStanding = {
    organizationId: null,
    canView: false,
    canEdit: false,
    companyRole: null,
    viewOnlyBecauseHotelJob: false,
  };
  if (!UUID_RX.test(accountId ?? '') || !UUID_RX.test(organizationId ?? '')) return denied;

  const hats = (await loadHats(accountId)).filter((hat) => hat.organizationId === organizationId);
  if (hats.length === 0) return denied;

  const companyRole = strongestCompanyRole(hats);
  const gmsSee = (await companyAccessSetting(organizationId, 'gms_see_rulebook')) !== 'false';
  const isGeneralManager = hats.some((hat) => (
    hat.scope === 'property' && hat.role === 'general_manager'
  ));

  // A company-scope job always sees the book. A hotel job sees it when the
  // company allows it AND that job is a GM's — which is exactly the founder's
  // ruling ("GMs should know the policies they're governed by"), and exactly
  // the setting's own name, `gms_see_rulebook`.
  //
  // IT USED TO BE ANY HAT. `canView` was `companyRole !== null || gmsSee`, and
  // `gmsSee` is locked ON, so every hat at the company passed — a front-desk
  // person or a housekeeper at one hotel could read the whole company rulebook.
  // That is not a policy list they are governed by; it is the company's money
  // rules, its vendor deals and its approval thresholds, plus (through the
  // route's own payload) the number of hotels in the portfolio. A GM needs
  // those to do the job. Line staff have no such need, and the ruling never
  // mentioned them.
  const canView = companyRole !== null || (gmsSee && isGeneralManager);
  if (!canView) return denied;

  let canEdit = false;
  if (companyRole) {
    const choice = await companyAccessSetting(organizationId, 'rulebook_editors');
    canEdit = editorChoiceAdmits(choice, companyRole);
  }

  return {
    organizationId,
    canView,
    canEdit,
    companyRole,
    viewOnlyBecauseHotelJob: companyRole === null,
  };
}
