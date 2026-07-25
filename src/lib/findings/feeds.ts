// ─── Feed loaders ────────────────────────────────────────────────────────────
//
// The only place in the findings layer that touches data. Each loader turns one
// existing subsystem into a plain value plus its honesty metadata (how many
// records, when the data was true, how old the weakest input is), and the
// runner loads the union of what the registered detectors declared — once per
// hotel, however many detectors read it.
//
// WHY THE THREE EXISTING SYSTEMS APPEAR HERE RATHER THAN BEING REWRITTEN
// The cleaning rules engine, the nudge checks and the operational-signal
// aggregators are called through their own published entry points, unchanged.
// Not one line of those modules moved. That is deliberate:
//
//   • Their EMITTED output must stay byte-identical. cleaning_tasks are still
//     written by the 5-minute rules-engine cron, nudges are still inserted by
//     the nudge cron, and drip questions still read the same signals. The
//     findings runner runs their DETECTION and records what it saw; it emits
//     nothing on their behalf, so there is nothing to double-write and nothing
//     to drift.
//   • The rules engine writes into housekeeping, which another workstream owns
//     and has just rebuilt. It is called here in DRY-RUN, which evaluates every
//     rule and writes nothing (engine.ts: the whole write block is behind
//     `if (!dryRun)`). Zero changes to housekeeping schema, UI or behaviour.

import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { gatherOperationalSignals } from '@/lib/agent/operational-signals';
import { checkOperationalAlerts } from '@/lib/agent/nudges';
import { runRulesEngineForProperty, type PropertyRunResult } from '@/lib/rules-engine';
import { isSectionEnabled, type EnabledSections } from '@/lib/sections/registry';
import { propertyLocalToday } from '@/lib/schedule/local-date';

import type { FeedId, FeedOutcome, FeedResult } from './types';

/** Everything the loaders share, resolved once per hotel per run. */
export interface FeedLoadEnv {
  propertyId: string;
  now: Date;
  timezone: string | null;
  businessDate: string;
  enabledSections: EnabledSections;
}

export type FeedLoader<K extends FeedId> = (env: FeedLoadEnv) => Promise<FeedResult<K>>;

const MS_PER_DAY = 86_400_000;

function ageDays(asOf: Date | null, now: Date): number | null {
  if (!asOf) return null;
  return Math.max(0, (now.getTime() - asOf.getTime()) / MS_PER_DAY);
}

/**
 * The hotel's own records — work orders, complaints, inspections, cleaning
 * times — aggregated over 30 days by the existing operational-signal layer.
 * Read live, so the data is true as of now; the 30-day window is part of each
 * signal's evidence, not part of its age.
 */
const loadOperationalSignals: FeedLoader<'operational_signals'> = async (env) => {
  const signals = await gatherOperationalSignals(env.propertyId);
  return {
    value: signals,
    recordCount: signals.length,
    asOf: env.now,
    weakestInputAgeDays: 0,
  };
};

/**
 * The nudge layer's operational alerts. It already refuses to speak when the
 * PMS feed is older than one report cycle (INV-34) and stamps each draft with
 * the capture time it reasoned from, so the age here is the DATA's age, not the
 * clock's.
 */
const loadNudgeDrafts: FeedLoader<'nudge_drafts'> = async (env) => {
  const drafts = await checkOperationalAlerts(env.propertyId);
  let asOf: Date | null = null;
  for (const draft of drafts) {
    const raw = (draft.payload as { asOf?: unknown }).asOf;
    if (typeof raw !== 'string') continue;
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) continue;
    // The weakest input is the OLDEST capture behind any draft.
    if (!asOf || at.getTime() < asOf.getTime()) asOf = at;
  }
  return {
    value: drafts,
    recordCount: drafts.length,
    asOf: asOf ?? env.now,
    weakestInputAgeDays: ageDays(asOf, env.now) ?? 0,
  };
};

/**
 * The cleaning rules engine, evaluated and NOT written. Respects the same
 * section gate the engine's own fleet runner applies, so a hotel with
 * housekeeping switched off is not quietly evaluated behind its back.
 */
const loadCleaningPlan: FeedLoader<'cleaning_plan'> = async (env) => {
  if (!isSectionEnabled(env.enabledSections, 'housekeeping')) {
    const empty: PropertyRunResult = {
      property_id: env.propertyId,
      business_date: env.businessDate,
      engine_run_id: '',
      rooms_evaluated: 0,
      tasks_upserted: 0,
      tasks_skipped_in_progress: 0,
      rooms_no_task: 0,
      errors: [],
      duration_ms: 0,
      outcomes: [],
      dry_run: true,
    };
    return { value: empty, recordCount: 0, asOf: env.now, weakestInputAgeDays: 0 };
  }
  const result = await runRulesEngineForProperty(env.propertyId, {
    now: env.now,
    dryRun: true,
    verbose: false,
  });
  return {
    value: result,
    recordCount: result.rooms_evaluated,
    asOf: env.now,
    weakestInputAgeDays: 0,
  };
};

export const FEED_LOADERS: { [K in FeedId]: FeedLoader<K> } = {
  operational_signals: loadOperationalSignals,
  nudge_drafts: loadNudgeDrafts,
  cleaning_plan: loadCleaningPlan,
};

/**
 * Load the requested feeds for one hotel. Failure-isolated: a feed that throws
 * becomes a recorded failure, and only the detectors that DECLARED it are
 * skipped. One broken source must not silence the whole night.
 */
export async function loadFeeds(
  feeds: readonly FeedId[],
  env: FeedLoadEnv,
): Promise<Partial<Record<FeedId, FeedOutcome>>> {
  const out: Partial<Record<FeedId, FeedOutcome>> = {};
  await Promise.all(
    feeds.map(async (feed) => {
      try {
        out[feed] = (await FEED_LOADERS[feed](env)) as FeedOutcome;
      } catch (e) {
        out[feed] = { error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  return out;
}

/** The per-hotel facts every loader needs. One read, not four. */
export async function resolveLoadEnv(propertyId: string, now: Date): Promise<FeedLoadEnv> {
  const { data } = await supabaseAdmin
    .from('properties')
    .select('timezone, enabled_sections')
    .eq('id', propertyId)
    .maybeSingle();
  const timezone = (data?.timezone as string | null) ?? null;
  return {
    propertyId,
    now,
    timezone,
    businessDate: propertyLocalToday(now, timezone),
    enabledSections: (data?.enabled_sections as EnabledSections) ?? null,
  };
}
