import 'server-only';

// ═══════════════════════════════════════════════════════════════════════════
// The portfolio brief's server half: cache it against the company's day.
//
// NO CRON, for the same reason the hotel brief has none: every cron in this
// product is a switch the founder owns, and a screen that needs one flipped is
// a screen that does not work. The brief is built on the first load of the
// company's day and cached against that day.
//
// NO MODEL, unlike the hotel brief. Every line here is a template filled from
// stored numbers, so there is nothing for a wording pass to make safer and
// nothing to spend. If that changes, the machinery to bolt on is the hotel
// brief's `phraseBrief` — spend hold, shape contract, prose guard, deadline —
// and not a second copy of it.
//
// ─── WHY THE CACHE KEY INCLUDES THE PERSON ────────────────────────────────
// Two people at the same company do not get the same brief. "2 need you" counts
// the cards whose signature the RULEBOOK routed to that specific reader, so the
// owner's brief and the VP's brief legitimately differ on the same morning at
// the same company. A key without the account id would serve whichever of them
// loaded first to both, and the wrong one would be the one making decisions off
// a count that was never about them.
//
// WHAT THE CACHE IS FOR: stability. A summary that quietly rewrites itself as
// the day's cards are dealt with is not a morning brief, it is a live counter,
// and nobody trusts a counter that disagrees with what they remember reading.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { MORNING_BRIEFER_ID } from '@/lib/ai/employee-ids';
import { isEmployeeSwitchedOff } from '@/lib/ai/employee-switches';

import { buildPortfolioBrief, type PortfolioBrief, type PortfolioBriefInput } from './vp-brief';

const BRIEF_CACHE_ROUTE = 'company-brief';

/** Bumped whenever the stored shape changes. A cached brief from an older shape
 *  is ignored rather than rendered half-empty.
 *
 *  3 — English-only lines (`{ text }`, was `{ en, es }`). The bump is what makes
 *  today's already-cached bilingual briefs regenerate rather than render as a
 *  card full of blanks on the first morning after the ruling ships. */
const BRIEF_CACHE_VERSION = 3;

interface CachedEnvelope {
  v: number;
  organizationId: string;
  accountId: string;
  localDate: string;
  policyFingerprint: string;
  brief: PortfolioBrief;
}

/**
 * Derived server-side from the company, the reader and the company's own
 * calendar date. Never from caller input — the key IS the tenant boundary of
 * the cache, and it is re-checked against the payload on read.
 */
export function portfolioBriefCacheKey(
  organizationId: string,
  accountId: string,
  localDate: string,
  policyFingerprint: string,
): string {
  return `${BRIEF_CACHE_ROUTE}-${organizationId}-${accountId}-${localDate}-${policyFingerprint}`;
}

export interface PortfolioBriefResult {
  brief: PortfolioBrief | null;
  cached: boolean;
  /** True when the Morning Briefer is switched off and this call did no work.
   *  Same reason the hotel brief carries it: a null brief already means
   *  "nothing has been checked", and a stopped employee is a different fact. */
  stopped?: boolean;
}

export interface GetPortfolioBriefOptions {
  accountId: string;
  /** Section/money policy that authorized every sentence in this brief. */
  policyFingerprint: string;
  input: PortfolioBriefInput;
  /** Skip the cache entirely. Tests only. */
  noCache?: boolean;
}

/**
 * The day's portfolio brief for one person.
 *
 * Never throws. A brief is a summary of a queue that is already on screen below
 * it; a failure here must cost the summary and nothing else.
 */
export async function getPortfolioBrief(
  opts: GetPortfolioBriefOptions,
): Promise<PortfolioBriefResult> {
  const { input, accountId, policyFingerprint } = opts;

  // The Morning Briefer writes BOTH morning summaries — the manager's and this
  // one — so one switch stops both. Checked before the cache read: an employee
  // that is off does not serve this morning's stored copy either.
  if (await isEmployeeSwitchedOff(MORNING_BRIEFER_ID)) {
    return { brief: null, cached: false, stopped: true };
  }

  const key = portfolioBriefCacheKey(
    input.organizationId,
    accountId,
    input.localDate,
    policyFingerprint,
  );

  if (!opts.noCache) {
    const cached = await readCache(
      key,
      input.organizationId,
      accountId,
      policyFingerprint,
    ).catch(() => null);
    if (cached) return { brief: cached, cached: true };
  }

  const fresh = buildPortfolioBrief(input);
  // Never checked: no brief, and deliberately nothing cached, so the first
  // check of a brand-new company produces a brief the same day.
  if (!fresh) return { brief: null, cached: false };

  if (!opts.noCache) {
    const won = await claim(key).catch(() => false);
    // Losing the claim is not an error. The loser hands back the brief it just
    // built — the same deterministic text the winner is about to store.
    if (won) {
      await writeCache(
        key,
        input.organizationId,
        accountId,
        policyFingerprint,
        fresh,
      ).catch(() => {});
    }
  }
  return { brief: fresh, cached: false };
}

/**
 * Read the day's brief, or null.
 *
 * FOUR things are checked before a cached brief is trusted, and every one is a
 * tenant or identity guard rather than paranoia: the organization inside the
 * payload, the account inside the payload, the local date, and the shape
 * version. The key already contains all three identities, so a mismatch means
 * something is wrong in a way that could put one company's numbers on another
 * company's screen — and the right response to that is to regenerate, not to
 * render.
 */
async function readCache(
  key: string,
  organizationId: string,
  accountId: string,
  policyFingerprint: string,
): Promise<PortfolioBrief | null> {
  const { data, error } = await supabaseAdmin
    .from('idempotency_log')
    .select('response, expires_at')
    .eq('key', key)
    .eq('route', BRIEF_CACHE_ROUTE)
    .maybeSingle();
  if (error || !data) return null;

  const row = data as { response: unknown; expires_at: string | null };
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;

  const payload = row.response as Partial<CachedEnvelope> | null;
  if (!payload || typeof payload !== 'object') return null;
  if (payload.v !== BRIEF_CACHE_VERSION) return null;
  if (payload.organizationId !== organizationId) return null;
  if (payload.accountId !== accountId) return null;
  if (payload.policyFingerprint !== policyFingerprint) return null;
  const brief = payload.brief;
  if (!brief || brief.organizationId !== organizationId) return null;
  if (payload.localDate !== brief.localDate) return null;
  if (!Array.isArray(brief.lines) || brief.lines.length === 0) return null;
  return brief;
}

/**
 * Take the day's slot, atomically.
 *
 * `p_pid` is null: a company-scope brief belongs to no one hotel, and filing it
 * under an arbitrary one of the company's hotels would make it look like that
 * hotel's row. The key carries the identities.
 */
async function claim(key: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc('claim_idempotency_key', {
    p_key: key,
    p_route: BRIEF_CACHE_ROUTE,
    p_pid: null,
  });
  if (error) {
    log.warn('[vp-brief] could not claim the daily slot; the brief is rebuilt per load', {
      err: error.message,
    });
    return false;
  }
  const row = (Array.isArray(data) ? data[0] : data) as { claimed?: boolean } | null | undefined;
  return row?.claimed === true;
}

/**
 * Store the day's brief against the claim. The TTL runs past the end of
 * tomorrow so a brief generated at 6am cannot expire at 6am the next day —
 * mid-morning, on a day whose brief is keyed differently anyway.
 */
async function writeCache(
  key: string,
  organizationId: string,
  accountId: string,
  policyFingerprint: string,
  brief: PortfolioBrief,
): Promise<void> {
  const envelope: CachedEnvelope = {
    v: BRIEF_CACHE_VERSION,
    organizationId,
    accountId,
    localDate: brief.localDate,
    policyFingerprint,
    brief,
  };
  const { error } = await supabaseAdmin
    .from('idempotency_log')
    .update({
      response: envelope as unknown as Record<string, unknown>,
      status_code: 200,
      expires_at: new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString(),
    })
    .eq('key', key)
    .eq('route', BRIEF_CACHE_ROUTE);
  if (error) {
    // The reader still gets today's brief; tomorrow's load simply rebuilds it.
    log.warn('[vp-brief] cache write failed', { organizationId, err: error.message });
  }
}
