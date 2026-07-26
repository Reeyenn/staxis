import 'server-only';

// ═══════════════════════════════════════════════════════════════════════════
// Running the portfolio checks: gather the company's hotels, ask the pure
// detectors, write the answers through the silencer.
//
// ─── WHY THERE IS NO CRON HERE ────────────────────────────────────────────
// Same reason the morning brief has none. Every cron in this product is a
// switch the founder owns and both findings crons are currently OFF; a screen
// that needs a new one flipped is a screen that does not work. So the checks
// run on the FIRST load of the company's day and are cached against that day
// through `claim_idempotency_key` — the same atomic claim the brief uses, so
// twelve tabs opening at 7am produce one run.
//
// The cost of that choice is one slower page load per company per day (two
// feed reads per hotel). The cost of the alternative is a feature that silently
// does nothing until somebody remembers to schedule it.
//
// ─── A COMPANY HAS NO TIMEZONE, SO IT BORROWS ONE ─────────────────────────
// "Once per day" needs a calendar, and a company that operates hotels in two
// zones does not have one. It borrows the zone MOST of its hotels are in, tied
// by the first property id — deterministic, stable across runs, and wrong by at
// most a few hours for the minority. The alternative, UTC, is wrong for
// everybody in the Americas by design.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { propertyLocalToday } from '@/lib/schedule/local-date';
import { propertiesOfOrganization } from '@/lib/company/access';
import { loadFeeds, resolveLoadEnv } from '@/lib/findings/feeds';
import { dedupeKeyFor, dedupeDrafts, capDrafts, evidenceMoved, shouldEscalate } from '@/lib/findings/silencer';
import { isFeedFailure } from '@/lib/findings/types';
import type { OperatingRhythmHistory, SupplySpendHistory } from '@/lib/findings/history';

import {
  PORTFOLIO_DETECTORS,
  type PortfolioContext,
  type PortfolioDetector,
  type PortfolioHotel,
} from './portfolio-checks';
import {
  escalateCompanyFinding,
  expireStaleCompanyFindings,
  loadActiveCompanyFindings,
  openCompanyFinding,
  refreshCompanyFinding,
  touchSilencedCompanyFinding,
  type PersistCompanyArgs,
} from './company-findings';

const CLAIM_ROUTE = 'company-portfolio-run';

/** Bumped when the checks change enough that a cached "already ran" is stale. */
const RUN_VERSION = 1;

export interface PortfolioRunSummary {
  organizationId: string;
  localDate: string;
  hotels: number;
  detectorsChecked: number;
  opened: number;
  updated: number;
  suppressed: number;
  escalated: number;
  expired: number;
  /** True when this call is the one that did the work. */
  ran: boolean;
  errors: Array<{ detectorId: string; error: string }>;
}

// ─── Gathering ──────────────────────────────────────────────────────────────

/**
 * The company's hotels with the two feeds the portfolio checks read.
 *
 * Failure-isolated per hotel and per feed: a hotel whose delivery log will not
 * load arrives with `supplySpend: null` and simply does not take part in the
 * comparison. A broken source at one hotel must not silence a company.
 */
export async function gatherPortfolio(
  organizationId: string,
  now: Date,
): Promise<PortfolioContext> {
  const propertyIds = await propertiesOfOrganization(organizationId);
  if (propertyIds.length === 0) {
    return { organizationId, hotels: [], now };
  }

  const names = await hotelNames(propertyIds);

  const hotels = await Promise.all(propertyIds.map(async (propertyId): Promise<PortfolioHotel> => {
    const fallback: PortfolioHotel = {
      propertyId,
      name: names.get(propertyId) ?? 'this hotel',
      businessDate: propertyLocalToday(now, null),
      supplySpend: null,
      rhythm: null,
    };
    try {
      const env = await resolveLoadEnv(propertyId, now);
      const feeds = await loadFeeds(['supply_spend_history', 'operating_rhythm'], env);
      const supply = feeds.supply_spend_history;
      const rhythm = feeds.operating_rhythm;
      return {
        propertyId,
        name: names.get(propertyId) ?? 'this hotel',
        businessDate: env.businessDate,
        supplySpend: supply && !isFeedFailure(supply)
          ? (supply.value as SupplySpendHistory)
          : null,
        rhythm: rhythm && !isFeedFailure(rhythm)
          ? (rhythm.value as OperatingRhythmHistory)
          : null,
      };
    } catch (e) {
      log.warn('[portfolio] a hotel could not be read; it sits out this comparison', {
        organizationId,
        propertyId,
        err: e instanceof Error ? e.message : String(e),
      });
      return fallback;
    }
  }));

  return { organizationId, hotels, now };
}

async function hotelNames(propertyIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id, name')
    .in('id', [...propertyIds]);
  if (error || !Array.isArray(data)) return out;
  for (const row of data as Array<{ id: string; name: string | null }>) {
    if (row.name) out.set(row.id, row.name);
  }
  return out;
}

/**
 * The company's own calendar day: the zone most of its hotels are in.
 * Deterministic — a tie goes to the first property id, so the same company
 * always gets the same clock.
 */
export async function companyLocalToday(
  organizationId: string,
  now: Date,
): Promise<{ localDate: string; timezone: string | null }> {
  const propertyIds = await propertiesOfOrganization(organizationId);
  if (propertyIds.length === 0) return { localDate: propertyLocalToday(now, null), timezone: null };

  const { data } = await supabaseAdmin
    .from('properties')
    .select('id, timezone')
    .in('id', [...propertyIds]);
  const rows = ((data ?? []) as Array<{ id: string; timezone: string | null }>)
    .filter((row) => !!row.timezone)
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.timezone!, (counts.get(row.timezone!) ?? 0) + 1);

  let winner: string | null = null;
  let best = 0;
  for (const row of rows) {
    const count = counts.get(row.timezone!) ?? 0;
    if (count > best) { best = count; winner = row.timezone!; }
  }
  return { localDate: propertyLocalToday(now, winner), timezone: winner };
}

// ─── Running ────────────────────────────────────────────────────────────────

/**
 * Run the portfolio checks for one company, at most once per company-day.
 *
 * Never throws. These checks produce EXTRA cards on a screen that is already
 * complete without them; a failure here must cost those cards and nothing else.
 */
export async function runPortfolioChecks(opts: {
  organizationId: string;
  now?: Date;
  /** Skip the once-a-day claim. Tests only — production always wants the claim. */
  force?: boolean;
}): Promise<PortfolioRunSummary> {
  const now = opts.now ?? new Date();
  const organizationId = opts.organizationId;
  const { localDate } = await companyLocalToday(organizationId, now);

  const summary: PortfolioRunSummary = {
    organizationId,
    localDate,
    hotels: 0,
    detectorsChecked: 0,
    opened: 0,
    updated: 0,
    suppressed: 0,
    escalated: 0,
    expired: 0,
    ran: false,
    errors: [],
  };

  if (!opts.force && !(await claimTheDay(organizationId, localDate))) return summary;

  try {
    const ctx = await gatherPortfolio(organizationId, now);
    summary.hotels = ctx.hotels.length;
    summary.ran = true;

    for (const detector of PORTFOLIO_DETECTORS) {
      try {
        await runOne(detector, ctx, summary, now);
        summary.detectorsChecked += 1;
      } catch (e) {
        summary.errors.push({
          detectorId: detector.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    summary.errors.push({
      detectorId: 'gather',
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return summary;
}

async function runOne(
  detector: PortfolioDetector,
  ctx: PortfolioContext,
  summary: PortfolioRunSummary,
  now: Date,
): Promise<void> {
  const drafts = capDrafts(dedupeDrafts(detector.detect(ctx)), detector.maxPerRun);
  const keys = drafts.map((draft) => dedupeKeyFor(detector.id, draft.key));
  const existing = await loadActiveCompanyFindings(ctx.organizationId, keys);

  for (const draft of drafts) {
    const dedupeKey = dedupeKeyFor(detector.id, draft.key);
    const args: PersistCompanyArgs = {
      organizationId: ctx.organizationId,
      detectorId: detector.id,
      dedupeKey,
      draft,
      receiptQueryId: detector.receiptQueryId,
      disposition: detector.defaultDisposition,
      now,
    };
    const row = existing.get(dedupeKey);

    // The SAME transition table the hotel ledger uses (silencer.ts), applied to
    // the company's rows. Written out rather than calling `decideAction`
    // because that takes a whole DetectorDeclaration, and manufacturing a fake
    // one to reach three fields would be a lie in the type system for the sake
    // of four lines.
    if (!row) {
      await openCompanyFinding(args);
      summary.opened += 1;
      continue;
    }
    if (row.status === 'muted') {
      await touchSilencedCompanyFinding(args, row.id);
      summary.suppressed += 1;
      continue;
    }
    if (row.status === 'known_problem') {
      if (shouldEscalate(detector.escalation, row.silencedAtMagnitude, draft.magnitude)) {
        await escalateCompanyFinding(args, row.id);
        summary.escalated += 1;
      } else {
        await touchSilencedCompanyFinding(args, row.id);
        summary.suppressed += 1;
      }
      continue;
    }
    const moved = evidenceMoved(
      { status: row.status, magnitude: row.magnitude, summary: row.summary, silencedAtMagnitude: row.silencedAtMagnitude },
      draft,
    );
    await refreshCompanyFinding(args, row.id, moved || row.status === 'updated' ? 'updated' : 'open');
    summary.updated += 1;
  }

  summary.expired += await expireStaleCompanyFindings(
    ctx.organizationId,
    detector.id,
    detector.staleAfterDays,
    now,
  );
}

// ─── The once-a-day claim ───────────────────────────────────────────────────

/**
 * Take the day's run slot, atomically. Returns true only for the caller that
 * won it; a claim that FAILS (database trouble) is treated as lost, so the
 * failure mode is "the portfolio checks did not run today" rather than "twelve
 * tabs each ran them".
 *
 * `p_pid` is deliberately null: a company-scope run belongs to no one hotel,
 * and filing the row under an arbitrary one of its hotels would make it look
 * like that hotel's. The KEY carries the organization id and is the tenant
 * boundary of the claim, exactly as the morning brief's key is.
 */
async function claimTheDay(organizationId: string, localDate: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin.rpc('claim_idempotency_key', {
      p_key: `${CLAIM_ROUTE}-v${RUN_VERSION}-${organizationId}-${localDate}`,
      p_route: CLAIM_ROUTE,
      p_pid: null,
    });
    if (error) return false;
    const row = (Array.isArray(data) ? data[0] : data) as { claimed?: boolean } | null | undefined;
    return row?.claimed === true;
  } catch {
    return false;
  }
}

/**
 * Hold the day's slot open for a full day once the run finished.
 *
 * The claim RPC writes a 5-minute pending row; without this the checks would
 * re-run every five minutes all day. Called after `runPortfolioChecks` returns
 * `ran: true`. Best-effort: the worst case is an extra run, not a wrong one,
 * because every write goes through the one-row-per-problem index either way.
 */
export async function holdPortfolioDay(
  organizationId: string,
  localDate: string,
  summary: PortfolioRunSummary,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('idempotency_log')
    .update({
      response: { ran: true, v: RUN_VERSION, organizationId, localDate, summary } as unknown as Record<string, unknown>,
      status_code: 200,
      expires_at: new Date(Date.now() + 30 * 60 * 60 * 1000).toISOString(),
    })
    .eq('key', `${CLAIM_ROUTE}-v${RUN_VERSION}-${organizationId}-${localDate}`)
    .eq('route', CLAIM_ROUTE);
  if (error) {
    log.warn('[portfolio] could not hold the day open; the checks may re-run', {
      organizationId,
      err: error.message,
    });
  }
}

export const PORTFOLIO_CLAIM_ROUTE = CLAIM_ROUTE;
