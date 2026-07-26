import 'server-only';

// ─── The portfolio door ─────────────────────────────────────────────────────
//
// WHAT THIS IS
// The ONE function that answers "may this person ask the copilot about a whole
// company, and which hotels does that mean". Everything about cross-hotel chat
// — the route's gate, every portfolio tool's re-verification, the prompt's
// hotel list — comes through here and nowhere else.
//
// THREE QUESTIONS, IN THIS ORDER, AND THE ORDER IS THE DESIGN
//   1. Does this person hold a COMPANY-scope job (owner / vp / finance)? A GM
//      does not, however many hotels their property hat happens to name — a
//      property-scope job is a job at named hotels, not a seat at the company.
//   2. Has that company TURNED CROSS-HOTEL CHAT ON? Default off (0365's
//      `cross_hotel_ai_chat`), and the default is respected absolutely: asking
//      the copilot about twenty hotels at once is a decision a company makes,
//      not something we switch on for them.
//   3. Which hotels does the company operate right now?
//
// WALL B, RESTATED FOR THIS SURFACE
// Coverage is read from `loadHats`, which draws only from
// `organization_property_relationships` rows belonging to the hat's OWN
// organization (INV-COMPANY-1). There is no query in this file that takes an
// organization id from the caller and turns it into hotels — the caller may
// only NARROW to a company they already wear a hat at. Company A's VP cannot
// name company B's id and receive company B's hotels, because the id is used
// as a FILTER over their own hats, never as a lookup key.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { loadHats, type MembershipHat } from '@/lib/company/access';
import { companyAccessSetting } from '@/lib/company/rulebook-access';
import { isCompanyScopeRole, type CompanyScopeRole } from '@/lib/company/roles';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why the door was closed. Each one is a DIFFERENT sentence to the user, which
 * is why they are not collapsed into a boolean: "you don't have a company job"
 * and "your company has this switched off" send a person to two different
 * places.
 */
export type PortfolioRefusal =
  /** No company-scope hat anywhere — a property-scope job, or no job at all. */
  | 'no_company_job'
  /** They hold company jobs at more than one company and named none of them. */
  | 'ambiguous_company'
  /** The company has not turned `cross_hotel_ai_chat` on (the default). */
  | 'cross_hotel_chat_off'
  /** The company operates no hotels right now, so there is no portfolio. */
  | 'no_hotels';

export interface PortfolioAccess {
  organizationId: string;
  organizationName: string | null;
  /** The strongest company-scope job this person holds at that company. */
  companyRole: CompanyScopeRole;
  /** Every hotel the company operates right now. Sorted, de-duplicated. */
  propertyIds: string[];
}

export type PortfolioAccessResult =
  | { ok: true; access: PortfolioAccess }
  | { ok: false; reason: PortfolioRefusal };

/** Plain-English refusal, for the route AND for a tool that re-verified. */
export const PORTFOLIO_REFUSAL_TEXT: Record<PortfolioRefusal, string> = {
  no_company_job:
    'Portfolio questions are for people with a company-wide job (owner, oversight or finance). '
    + 'Ask about one hotel at a time instead.',
  ambiguous_company:
    'You hold a company job at more than one company. Say which company you mean.',
  cross_hotel_chat_off:
    'This company has not turned on asking about all its hotels at once. '
    + 'A company owner or VP can switch it on in the company settings.',
  no_hotels:
    'This company does not operate any hotels right now, so there is nothing to compare.',
};

const COMPANY_ROLE_STRENGTH: Record<CompanyScopeRole, number> = {
  owner: 3,
  vp: 2,
  finance: 1,
};

/** Company-scope hats only, at one company, strongest first. */
function companyHatsAt(hats: readonly MembershipHat[], organizationId: string): MembershipHat[] {
  return hats
    .filter((hat) => (
      hat.scope === 'company'
      && isCompanyScopeRole(hat.role)
      && hat.organizationId === organizationId
    ))
    .sort((a, b) => (
      COMPANY_ROLE_STRENGTH[b.role as CompanyScopeRole]
      - COMPANY_ROLE_STRENGTH[a.role as CompanyScopeRole]
    ));
}

async function organizationName(organizationId: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('organizations')
      .select('name')
      .eq('id', organizationId)
      .maybeSingle();
    if (error || !data) return null;
    return (data as { name: string | null }).name ?? null;
  } catch {
    // A company we cannot name is still a company we can answer for. The name
    // is decoration on the prompt; the wall is the id.
    return null;
  }
}

/**
 * Resolve the portfolio door, hitting the database every time.
 *
 * @param accountId      the person asking.
 * @param organizationId optional NARROWING to one of the companies they already
 *                       hold a job at. Never a lookup key — see Wall B above.
 */
export async function resolvePortfolioAccessUncached(
  accountId: string,
  organizationId?: string | null,
): Promise<PortfolioAccessResult> {
  if (!UUID_RX.test(accountId ?? '')) return { ok: false, reason: 'no_company_job' };
  if (organizationId != null && !UUID_RX.test(organizationId)) {
    return { ok: false, reason: 'no_company_job' };
  }

  const hats = await loadHats(accountId);
  const companyOrganizationIds = [...new Set(
    hats
      .filter((hat) => hat.scope === 'company' && isCompanyScopeRole(hat.role))
      .map((hat) => hat.organizationId),
  )].sort();

  if (companyOrganizationIds.length === 0) return { ok: false, reason: 'no_company_job' };

  let targetId: string;
  if (organizationId) {
    // The narrowing case. A company they hold no company job at is not "the
    // wrong company" to them — it is a company they have never heard of, and
    // the honest answer is the same one a person with no company job gets.
    if (!companyOrganizationIds.includes(organizationId)) {
      return { ok: false, reason: 'no_company_job' };
    }
    targetId = organizationId;
  } else if (companyOrganizationIds.length === 1) {
    targetId = companyOrganizationIds[0];
  } else {
    return { ok: false, reason: 'ambiguous_company' };
  }

  const covering = companyHatsAt(hats, targetId);
  if (covering.length === 0) return { ok: false, reason: 'no_company_job' };

  // THE GATE. Default 'false' — a company that never opened the setup screen
  // does not get cross-hotel chat, and `companyAccessSetting` returns that
  // default rather than throwing when the store cannot answer.
  const setting = await companyAccessSetting(targetId, 'cross_hotel_ai_chat');
  if (setting !== 'true') return { ok: false, reason: 'cross_hotel_chat_off' };

  // A company hat's coverage IS every hotel the company operates right now
  // (access.ts), so this is already the company's portfolio — with no chance
  // of a second company's hotel in it.
  const propertyIds = [...new Set(covering.flatMap((hat) => hat.coveredPropertyIds))].sort();
  if (propertyIds.length === 0) return { ok: false, reason: 'no_hotels' };

  return {
    ok: true,
    access: {
      organizationId: targetId,
      organizationName: await organizationName(targetId),
      companyRole: covering[0].role as CompanyScopeRole,
      propertyIds,
    },
  };
}

// ─── The short cache ────────────────────────────────────────────────────────
//
// Every portfolio tool re-asks this question rather than trusting the context
// it was handed — that is the defense-in-depth half of the wall, and it is only
// affordable because of this cache. A turn can call six tools; six full
// hat+relationship+settings resolutions per turn would be twenty-odd queries
// for an answer that cannot change mid-sentence.
//
// FIFTEEN SECONDS, AND THE NUMBER MATTERS. This is a gate, so the staleness
// window is the window in which a company that just switched cross-hotel chat
// OFF still gets answers. Fifteen seconds is shorter than one model turn, so
// the worst case is finishing the reply that was already in flight. The ROUTE
// deliberately calls the UNCACHED path, so a new conversation never starts on a
// cached yes.

const ACCESS_TTL_MS = 15_000;

const cache = new Map<string, { result: PortfolioAccessResult; expiresAt: number }>();
const inflight = new Map<string, Promise<PortfolioAccessResult>>();

function cacheKey(accountId: string, organizationId?: string | null): string {
  return `${accountId}::${organizationId ?? '-'}`;
}

/** The cached read. Used by tools re-verifying inside a turn. */
export async function resolvePortfolioAccess(
  accountId: string,
  organizationId?: string | null,
): Promise<PortfolioAccessResult> {
  const key = cacheKey(accountId, organizationId);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.result;

  const existing = inflight.get(key);
  if (existing) return existing;

  const pending = resolvePortfolioAccessUncached(accountId, organizationId)
    .then((result) => {
      cache.set(key, { result, expiresAt: Date.now() + ACCESS_TTL_MS });
      return result;
    })
    // A door we cannot open is a closed door. Never a thrown turn, and never
    // an open one.
    .catch((): PortfolioAccessResult => ({ ok: false, reason: 'no_company_job' }))
    .finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

/** Test seam: forget every resolved door. */
export function clearPortfolioAccessCache(): void {
  cache.clear();
  inflight.clear();
}
