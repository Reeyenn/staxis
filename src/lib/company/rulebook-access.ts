import 'server-only';

// ─── Who may read the rulebook, who may write it ───────────────────────────
//
// TWO QUESTIONS, DELIBERATELY SEPARATE:
//
//   canViewCompanyRulebook   a COMPANY-scope job (owner / VP / finance), or a
//                            scoped portfolio/property manager while the legacy
//                            `gms_see_rulebook` switch is on. Founder's ruling:
//                            "GMs should know the policies they're governed by."
//                            Read-only. NOT line staff — see
//                            `rulebookStandingFor` for what leaked while it was.
//   canEditCompanyRulebook   a COMPANY-scope job, filtered by the company's own
//                            `rulebook_editors` choice. A scoped manager never
//                            qualifies merely from portfolio/property reach.
//
// The access choices themselves live in `company_access_settings` and are read
// through `companyAccessSetting`, which returns a documented DEFAULT when no row
// exists. A company that never opened the setup screen therefore behaves
// exactly as the founder specified rather than as "nothing configured, deny
// everything" — a rulebook nobody can see is worse than no rulebook.

import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AuthorizationScopeReceipt } from '@/lib/authorization';
import {
  listAuthoritativePropertyAccess,
  resolveAuthorizationScope,
  type AuthoritativePropertyEntitlement,
  type AuthoritativePropertyStanding,
} from '@/lib/authorization/server';

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
  companyRole: 'owner' | 'regional_manager' | null;
  /** True when a scoped portfolio/property manager is the only reason they can see it. */
  viewOnlyBecauseHotelJob: boolean;
}

const COMPANY_ROLE_STRENGTH = { owner: 2, regional_manager: 1 } as const;

type CompanyRole = 'owner' | 'regional_manager';

function entitlementCompanyRole(
  entitlement: AuthoritativePropertyEntitlement,
): CompanyRole | null {
  if (entitlement.scopeType === 'company'
    && (entitlement.staxisRole === 'owner'
      || entitlement.staxisRole === 'regional_manager')) {
    return entitlement.staxisRole;
  }
  if (entitlement.scopeType === 'organization') {
    if (entitlement.accessProfile === 'organization_owner') return 'owner';
    if (entitlement.accessProfile === 'organization_admin') return 'regional_manager';
  }
  return null;
}

/**
 * Match 0406's transactional editor gate: one broad entitlement must cover
 * every hotel in the exact current authority projection. A collection of narrow grants must
 * never add up to organization-wide rulebook authority.
 */
function strongestRoleFromCoverage(
  propertyIds: readonly string[],
  entries: readonly { propertyId: string; entitlement: AuthoritativePropertyEntitlement }[],
): CompanyRole | null {
  const coverage = new Map<string, { role: CompanyRole; propertyIds: Set<string> }>();
  for (const { propertyId, entitlement } of entries) {
    const role = entitlementCompanyRole(entitlement);
    if (!role) continue;
    const key = `${entitlement.entitlementId}\0${role}`;
    const current = coverage.get(key) ?? { role, propertyIds: new Set<string>() };
    current.propertyIds.add(propertyId);
    coverage.set(key, current);
  }
  let best: 'owner' | 'regional_manager' | null = null;
  for (const candidate of coverage.values()) {
    if (candidate.propertyIds.size !== propertyIds.length
      || propertyIds.some((propertyId) => !candidate.propertyIds.has(propertyId))) continue;
    if (!best || COMPANY_ROLE_STRENGTH[candidate.role] > COMPANY_ROLE_STRENGTH[best]) {
      best = candidate.role;
    }
  }
  return best;
}

function strongestCompanyRole(receipt: AuthorizationScopeReceipt): CompanyRole | null {
  return strongestRoleFromCoverage(
    receipt.propertyIds,
    receipt.provenance.entitlements.map((entitlement) => ({
      propertyId: entitlement.propertyId,
      entitlement: {
        kind: entitlement.entitlementKind,
        entitlementId: entitlement.entitlementId,
        organizationId: receipt.organizationId,
        membershipId: entitlement.membershipId,
        accessProfile: entitlement.accessProfile,
        staxisRole: entitlement.staxisRole,
        scopeType: entitlement.scopeType,
        portfolioId: entitlement.portfolioId,
      },
    })),
  );
}

function receiptHasScopedManagerStanding(receipt: AuthorizationScopeReceipt): boolean {
  return receipt.provenance.entitlements.some((entitlement) => (
    (entitlement.scopeType === 'property' && entitlement.staxisRole === 'general_manager')
      || entitlement.accessProfile === 'property_manager'
      || entitlement.accessProfile === 'portfolio_manager'
  ));
}

function hasHotelManagerStanding(standings: readonly AuthoritativePropertyStanding[]): boolean {
  return standings.some((standing) => standing.entitlements.some((entitlement) => (
    (entitlement.scopeType === 'property' && entitlement.staxisRole === 'general_manager')
      || (entitlement.scopeType === 'property' && entitlement.accessProfile === 'property_manager')
  )));
}

// `owner_and_vp` and `company_scope` are STORED setting values. 0461 left them
// alone on purpose: rewriting a company's saved choice is a change to what they
// chose, not a rename. With `finance` retired the two now admit exactly the same
// people (owner + regional manager), so the pair is redundant rather than wrong.
// Collapsing them is a product decision, not a migration one.
function editorChoiceAdmits(choice: string | null, role: 'owner' | 'regional_manager'): boolean {
  // The owner always edits their own company's book, whatever the choice says.
  if (role === 'owner') return true;
  switch (choice) {
    case 'owner_only': return false;
    case 'company_scope': return true;
    case 'owner_and_vp':
    default:
      return role === 'regional_manager';
  }
}

/**
 * What may this person do with this company's rulebook?
 *
 * Answers from one fresh authoritative receipt at this exact company — never
 * from `accounts.role`, which is a global word and would
 * silently make a hotel owner the owner of a management company they have
 * never heard of. This keeps normalized access grants, legacy hats and the
 * 0406 transaction gate on one fail-closed authority source. A one-hotel GM is
 * intentionally excluded from portfolio receipts, so that one narrow case
 * falls back to the same authoritative per-hotel projection used by hotel APIs.
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

  const resolved = await resolveAuthorizationScope({
    accountId,
    organizationId,
    selector: { type: 'all_authorized' },
    ttlSeconds: 60,
  });
  let companyRole: CompanyRole | null = null;
  let hasScopedManagerJob = false;
  if (resolved.ok) {
    companyRole = strongestCompanyRole(resolved.receipt);
    hasScopedManagerJob = receiptHasScopedManagerStanding(resolved.receipt);
  } else if (resolved.reason === 'no_company_job') {
    const access = await listAuthoritativePropertyAccess(accountId);
    if (!access || access.all) return denied;
    const standings = access.propertyStandings
      .map((standing) => ({
        ...standing,
        entitlements: standing.entitlements.filter(
          (entitlement) => entitlement.organizationId === organizationId,
        ),
      }))
      .filter((standing) => standing.entitlements.length > 0);
    if (standings.length === 0) return denied;
    hasScopedManagerJob = hasHotelManagerStanding(standings);
  } else {
    return denied;
  }
  const gmsSee = (await companyAccessSetting(organizationId, 'gms_see_rulebook')) !== 'false';

  // A company-scope job always sees the book. A scoped portfolio/property
  // manager sees only the confirmed book; this includes the founder's ruling
  // that "GMs should know the policies they're governed by" and keeps the
  // setting's historic `gms_see_rulebook` name.
  //
  // IT USED TO BE ANY HAT. `canView` was `companyRole !== null || gmsSee`, and
  // `gmsSee` is locked ON, so every hat at the company passed — a front-desk
  // person or a housekeeper at one hotel could read the whole company rulebook.
  // That is not a policy list they are governed by; it is the company's money
  // rules, its vendor deals and its approval thresholds, plus (through the
  // route's own payload) the number of hotels in the portfolio. A GM needs
  // those to do the job. Line staff have no such need, and the ruling never
  // mentioned them.
  const canView = companyRole !== null || (gmsSee && hasScopedManagerJob);
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
