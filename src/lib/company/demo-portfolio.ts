import 'server-only';

// ═══════════════════════════════════════════════════════════════════════════
// Which companies are DEMO companies, and why only the scheduled run cares.
//
// Founder ruling, 2026-07-29: "The fake demo company shouldn't get those runs."
// The seeded management company exists to be shown to investors. A background
// job quietly opening and expiring findings on it every morning spends real
// money for an audience of nobody, and it writes rows that later read like a
// customer's history.
//
// ─── SCHEDULED ONLY, AND THAT IS THE WHOLE POINT ──────────────────────────
// This deliberately does NOT live in portfolio-runner.ts. That runner has two
// callers: the cron and the VP-queue page-open fallback. Filtering there would
// break the demo itself, because somebody opening the company queue during a
// live walkthrough must still watch the checks produce cards. So the rule sits
// at the discovery step of the scheduled fleet pass and nowhere else. Three ways
// in, three answers:
//
//   scheduled discovery      excludes demo companies (this file)
//   ?organizationId=<uuid>   runs whatever it is told; an operator asked for it
//   page-open fallback       untouched, so live demos still generate findings
//
// ─── THE MARKER IS THE HOTELS, NOT THE COMPANY ────────────────────────────
// `organizations` has no is_test column, and adding one would be a second
// source of truth for a fact the hotels already carry. `properties.is_test` is
// the real tag: tests/exam/qa-seed-manifest.md says so in as many words ("This
// is the real tag; the string prefix always was belt-and-braces"), and the admin
// ML fleet views already hide test hotels by the same flag. So:
//
//   a company is a demo company when it governs at least one hotel and EVERY
//   hotel it governs is a test hotel.
//
// That needs no migration, and it self-corrects: the day a real hotel joins that
// company, the company is a real customer and starts running.
//
// ─── UNPROVEN MEANS REAL ──────────────────────────────────────────────────
// Every failure path answers "not proven demo", so an unreadable topology or a
// partial property read can never silently skip a paying customer's findings.
// Guessing wrong in this direction is bounded and LOUD: the company goes into
// the fleet pass, where the same unreadable topology makes its run `unavailable`,
// which the route counts as a failure and refuses to write a heartbeat for.
// Guessing wrong in the other direction is silent, and a findings engine that
// silently stops looking at a real hotel is the one failure it must never have.
// ═══════════════════════════════════════════════════════════════════════════

import { resolveOrganizationPropertyTopology } from '@/lib/company/access';
import { log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';

/**
 * The rule itself, over facts already gathered.
 *
 * A company with no hotels is NOT demo. It is an empty company, and calling it
 * demo would skip a brand-new real customer on the day they sign up, in the
 * window before their first hotel is attached.
 */
export function isDemoOnlyPortfolio(
  hotels: readonly { readonly isTest: boolean }[],
): boolean {
  return hotels.length > 0 && hotels.every((hotel) => hotel.isTest);
}

/**
 * True only when this organization is PROVEN to be a demo-only portfolio.
 *
 * Never throws. Anything unproven answers false, for the reason in the header.
 */
export async function isDemoOnlyOrganization(
  organizationId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const topology = await resolveOrganizationPropertyTopology(organizationId, now);
  if (!topology.ok) {
    log.warn('[demo-portfolio] company topology unreadable; treating it as a real company', {
      organizationId,
      reason: topology.reason,
    });
    return false;
  }

  const propertyIds = topology.topology.propertyIds;
  if (propertyIds.length === 0) return false;

  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id, is_test')
    .in('id', [...propertyIds]);
  if (error || !Array.isArray(data)) {
    log.warn('[demo-portfolio] hotel test flags unreadable; treating it as a real company', {
      organizationId,
      err: error?.message,
    });
    return false;
  }

  const flags = new Map(
    (data as Array<{ id: string; is_test: boolean | null }>)
      .map((row) => [row.id, Boolean(row.is_test)] as const),
  );

  // Every governed hotel has to be accounted for. A partial read that happened
  // to return only the test hotels must not be able to look like a demo company.
  if (propertyIds.some((propertyId) => !flags.has(propertyId))) {
    log.warn('[demo-portfolio] hotel test flags incomplete; treating it as a real company', {
      organizationId,
      governed: propertyIds.length,
      read: flags.size,
    });
    return false;
  }

  return isDemoOnlyPortfolio(
    propertyIds.map((propertyId) => ({ isTest: flags.get(propertyId) === true })),
  );
}
