/**
 * Observational catalog for Staxis background jobs.
 *
 * This module describes repository-declared state; it does not prove external
 * deployment, generate scheduler files, or activate anything. `vercel.json`
 * and `.github/workflows/*` remain the runtime trigger definitions. It covers
 * every /api/cron route, heartbeat-writing API routes outside that folder, and
 * every GitHub workflow, including manual and event-driven operations.
 */

export type JobLifecycle = 'active' | 'event-driven' | 'staged' | 'manual-only' | 'retired';
export type JobRunner = 'vercel-cron' | 'github-actions' | 'manual' | 'none';
export type JobOwner =
  | 'agent'
  | 'ai-findings'
  | 'billing'
  | 'developer-tools'
  | 'hotel-operations'
  | 'inventory-ml'
  | 'platform'
  | 'pms';

export type JobSource =
  | { kind: 'vercel'; configFile: 'vercel.json' }
  | { kind: 'github'; workflowFile: string }
  | { kind: 'route-only' };

export type JobTarget =
  | { kind: 'route'; path: string }
  | { kind: 'workflow'; workflowFile: string };

export type JobHeartbeat = {
  name: string;
  visibility: 'mission-control' | 'record-only';
  cadenceDescription?: string;
};

export type JobMissionGroup = 'Reports' | 'Cleanup' | 'ML' | 'Inventory' | 'Agent' | 'Other';
export type JobMissionTier = 'ai' | 'prediction' | 'timer';

export interface JobMissionMetadata {
  description: string;
  group: JobMissionGroup;
  tier: JobMissionTier;
}

/**
 * A job this one cannot do anything useful without.
 *
 * ═══ WHY A HEARTBEAT IS NOT ENOUGH ═══
 * Every other signal in this file answers "did the route finish". None of them
 * answers "did it have anything to read". Those are different questions and
 * the gap between them is invisible from every screen: a job whose input table
 * stopped being written still runs, still returns 200, still writes its
 * heartbeat, and still reads "On time" in Mission Control forever.
 *
 * That is not hypothetical. On 2026-08-07 `plan_snapshots` held zero rows and
 * `daily_logs` had not gained one since 2026-07-18, because the only writer of
 * both is `/api/cron/seal-daily`, which has no scheduler. The two inventory ML
 * jobs that read them were green every single day through all of it, and
 * `ml-cron.yml`'s own header justified switching them on with the sentence
 * "the seal-daily cron projects tomorrow's occupancy into plan_snapshots".
 *
 * So the dependency is written down, and a test refuses the shape: an active
 * job whose producer is parked is a pipeline with a hole in the middle, and
 * somebody has to have decided that on purpose.
 */
export interface JobFeed {
  /** The `id` of the catalog row that writes what this job reads. */
  producerId: string;
  /** The table(s) the producer writes and this job reads. */
  tables: readonly string[];
}

export interface JobCatalogEntry {
  id: string;
  lifecycle: JobLifecycle;
  owner: JobOwner;
  runner: JobRunner;
  source: JobSource;
  target: JobTarget;
  /** Exact active cron expression, or null when no automatic trigger exists. */
  schedule: string | null;
  heartbeat: JobHeartbeat | null;
  description: string;
  mission?: JobMissionMetadata;
  /** What has to be running upstream for this job to mean anything. */
  fedBy?: readonly JobFeed[];
}

export interface MissionMonitoredJobCatalogEntry extends JobCatalogEntry {
  lifecycle: 'active';
  runner: 'vercel-cron' | 'github-actions';
  schedule: string;
  heartbeat: JobHeartbeat & {
    visibility: 'mission-control';
    cadenceDescription: string;
  };
  mission: JobMissionMetadata;
}

/** Jobs shown by Mission Control. Order is stable because its API preserves it. */
export const ACTIVE_MISSION_JOBS: ReadonlyArray<MissionMonitoredJobCatalogEntry> = [
  {
    id: 'agent-sweep-reservations',
    lifecycle: 'active',
    owner: 'agent',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/agent-sweep-reservations' },
    schedule: '*/5 * * * *',
    heartbeat: {
      name: 'agent-sweep-reservations',
      visibility: 'mission-control',
      cadenceDescription: 'every-5-min reserved-row sweeper (Vercel native cron, Codex round-5 R2)',
    },
    description: 'Releases stale AI cost reservations.',
    mission: { description: 'Frees up AI budget if a task crashes mid-way.', group: 'Agent', tier: 'timer' },
  },
  {
    id: 'sweep-account-lifecycle',
    lifecycle: 'active',
    owner: 'platform',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/sweep-account-lifecycle' },
    schedule: '*/5 * * * *',
    heartbeat: {
      name: 'sweep-account-lifecycle',
      visibility: 'mission-control',
      cadenceDescription: 'every-5-min recovery of durable account activation/deactivation intents',
    },
    description: 'Recovers interrupted account lifecycle changes.',
    mission: { description: 'Finishes interrupted login disable or reactivate changes.', group: 'Cleanup', tier: 'timer' },
  },
  {
    id: 'process-agent-schedules',
    lifecycle: 'active',
    owner: 'agent',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/process-agent-schedules' },
    schedule: '*/5 * * * *',
    heartbeat: {
      name: 'process-agent-schedules',
      visibility: 'mission-control',
      cadenceDescription: 'every-5-min delivery of due agent reminders and recurring Communications tasks',
    },
    description: 'Delivers due agent reminders and recurring tasks.',
    mission: { description: 'Delivers reminders and creates recurring team tasks.', group: 'Agent', tier: 'timer' },
  },
  {
    id: 'agent-summarize-long-conversations',
    lifecycle: 'active',
    owner: 'agent',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/agent-summarize-long-conversations' },
    schedule: '*/30 * * * *',
    heartbeat: {
      name: 'agent-summarize-long-conversations',
      visibility: 'mission-control',
      cadenceDescription: 'every-30-min summarization of long agent conversations (L4 part B)',
    },
    description: 'Summarizes long agent conversations.',
    mission: { description: 'Tidies up long AI chats so they stay fast.', group: 'Agent', tier: 'ai' },
  },
  {
    id: 'agent-consolidate-memory',
    lifecycle: 'active',
    owner: 'agent',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/agent-consolidate-memory' },
    schedule: '0 5 * * *',
    heartbeat: {
      name: 'agent-consolidate-memory',
      visibility: 'mission-control',
      cadenceDescription: 'nightly per-hotel memory consolidation — auto-learns durable facts from conversations (self-learning Move #2)',
    },
    description: 'Consolidates durable hotel memory.',
    mission: { description: "Cleans up the AI assistant's memory overnight.", group: 'Agent', tier: 'ai' },
  },
  {
    id: 'walkthrough-heal-stale',
    lifecycle: 'active',
    owner: 'platform',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/walkthrough-heal-stale' },
    schedule: '*/30 * * * *',
    heartbeat: {
      name: 'walkthrough-heal-stale',
      visibility: 'mission-control',
      cadenceDescription: 'every-30-min walkthrough recovery (heals stale runs left mid-walkthrough by crashed clients)',
    },
    description: 'Recovers interrupted product walkthroughs.',
    mission: { description: 'Cleans up show-me-how tutorials that got interrupted.', group: 'Other', tier: 'timer' },
  },
  {
    id: 'sweep-orphan-auth-users',
    lifecycle: 'active',
    owner: 'platform',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/sweep-orphan-auth-users' },
    schedule: '0 7 * * *',
    heartbeat: {
      name: 'sweep-orphan-auth-users',
      visibility: 'mission-control',
      cadenceDescription: 'daily orphan auth-user reconciler — deletes auth.users rows with no matching accounts row (audit fix #4; slowed from 30-min 2026-07-19, owner call)',
    },
    description: 'Reconciles incomplete account sign-ups.',
    mission: { description: 'Removes leftover half-finished sign-up accounts.', group: 'Cleanup', tier: 'timer' },
  },
  {
    id: 'sweep-mfa-verified-sessions',
    lifecycle: 'active',
    owner: 'platform',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/sweep-mfa-verified-sessions' },
    schedule: '0 */6 * * *',
    heartbeat: {
      name: 'sweep-mfa-verified-sessions',
      visibility: 'mission-control',
      cadenceDescription: 'every-6-hour sweep of mfa_verified_sessions rows older than 30 days — Phase 2B Door B fix',
    },
    description: 'Removes expired trusted-device verification sessions.',
    mission: { description: 'Clears out expired 2-factor sign-in sessions.', group: 'Cleanup', tier: 'timer' },
  },
  {
    id: 'ml-predict-inventory',
    lifecycle: 'active',
    owner: 'inventory-ml',
    runner: 'github-actions',
    source: { kind: 'github', workflowFile: 'ml-cron.yml' },
    target: { kind: 'route', path: '/api/cron/ml-predict-inventory' },
    schedule: '0 11 * * *',
    heartbeat: {
      name: 'ml-predict-inventory',
      visibility: 'mission-control',
      cadenceDescription: 'daily inventory predictions for tomorrow',
    },
    description: 'Predicts hotel inventory consumption rates.',
    mission: { description: 'Predicts which supplies each hotel will need.', group: 'Inventory', tier: 'prediction' },
    // The model's primary feature for tomorrow is that hotel's projected
    // occupancy, read from `plan_snapshots`
    // (ml-service/src/inference/inventory_rate.py). With no rows it falls back
    // to a 14-day historic mean and says nothing about having done so.
    fedBy: [{ producerId: 'seal-daily', tables: ['plan_snapshots'] }],
  },
  {
    id: 'purge-old-error-logs',
    lifecycle: 'active',
    owner: 'platform',
    runner: 'github-actions',
    source: { kind: 'github', workflowFile: 'purge-old-error-logs-cron.yml' },
    target: { kind: 'route', path: '/api/cron/purge-old-error-logs' },
    schedule: '30 9 * * *',
    heartbeat: {
      name: 'purge-old-error-logs',
      visibility: 'mission-control',
      cadenceDescription: 'daily error_logs retention sweep',
    },
    description: 'Applies retention to old application error logs.',
    mission: { description: 'Deletes old error logs to keep things tidy.', group: 'Cleanup', tier: 'timer' },
  },
  {
    id: 'agent-archive-stale-conversations',
    lifecycle: 'active',
    owner: 'agent',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/agent-archive-stale-conversations' },
    schedule: '0 3 * * *',
    heartbeat: {
      name: 'agent-archive-stale-conversations',
      visibility: 'mission-control',
      cadenceDescription: 'daily 3am archival of stale agent conversations (L4 part A)',
    },
    description: 'Archives stale agent conversations.',
    mission: { description: "Files away old AI chats you're done with.", group: 'Agent', tier: 'timer' },
  },
  {
    id: 'agent-heal-counters',
    lifecycle: 'active',
    owner: 'agent',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/agent-heal-counters' },
    schedule: '0 4 * * *',
    heartbeat: {
      name: 'agent-heal-counters',
      visibility: 'mission-control',
      cadenceDescription: 'daily 4am counter-drift heal (Round 12 T12.12, invariant doctrine safety net)',
    },
    description: 'Repairs agent conversation counter drift.',
    mission: { description: 'Fixes the AI usage counters if they drift.', group: 'Agent', tier: 'timer' },
  },
  {
    id: 'agent-costs-rollup',
    lifecycle: 'active',
    owner: 'agent',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/agent-costs-rollup' },
    schedule: '20 5 * * *',
    heartbeat: {
      name: 'agent-costs-rollup',
      visibility: 'mission-control',
      cadenceDescription: 'daily 5:20am AI-books rollup — folds agent_costs into agent_costs_monthly, verifies the fold, and prunes only verified months past the 6-month window (sole owner of agent_costs retention)',
    },
    description: 'Rolls up and safely prunes detailed agent costs.',
    mission: { description: 'Keeps a permanent monthly summary of what the AI cost, so old detail can be tidied away without changing any total.', group: 'Cleanup', tier: 'timer' },
  },
  {
    id: 'pms-auth-codes-purge',
    lifecycle: 'active',
    owner: 'pms',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/pms-auth-codes-purge' },
    schedule: '45 4 * * *',
    heartbeat: {
      name: 'pms-auth-codes-purge',
      visibility: 'mission-control',
      cadenceDescription: 'daily 4:45am purge of pms_auth_codes older than 7 days (Okta 2FA inbox, migration 0274)',
    },
    description: 'Applies retention and quarantine policy to PMS inbox data.',
    mission: { description: 'Deletes expired PMS inbox messages and report files, and shreds any report that arrived with a card number on it.', group: 'Cleanup', tier: 'timer' },
  },
  {
    id: 'pms-observations-purge',
    lifecycle: 'active',
    owner: 'pms',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/pms-observations-purge' },
    schedule: '40 5 * * *',
    heartbeat: {
      name: 'pms-observations-purge',
      visibility: 'mission-control',
      cadenceDescription: "daily 5:40am retention sweep for the five append-only PMS observation tables via 0343's sanctioned purge function (5-year window — a no-op until report ingestion restarts)",
    },
    description: 'Applies retention to append-only PMS observations.',
    mission: { description: 'Tidies away PMS readings older than five years.', group: 'Cleanup', tier: 'timer' },
  },
  {
    id: 'ml-train-inventory',
    lifecycle: 'active',
    owner: 'inventory-ml',
    runner: 'github-actions',
    source: { kind: 'github', workflowFile: 'ml-cron.yml' },
    target: { kind: 'route', path: '/api/cron/ml-train-inventory' },
    schedule: '0 9 * * 0',
    heartbeat: {
      name: 'ml-train-inventory',
      visibility: 'mission-control',
      cadenceDescription: 'weekly inventory training (Sunday)',
    },
    description: 'Retrains the inventory consumption-rate model.',
    mission: { description: 'Retrains the supply-prediction model each week.', group: 'Inventory', tier: 'prediction' },
    // The weekly fit's labels are the sealed day: occupancy, checkouts and
    // stayovers per (property, date) in `daily_logs`. A week with no new rows
    // is a retrain on the same data as last week.
    fedBy: [{ producerId: 'seal-daily', tables: ['daily_logs'] }],
  },
  {
    id: 'vercel-watchdog',
    lifecycle: 'active',
    owner: 'platform',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/vercel-watchdog' },
    schedule: '*/5 * * * *',
    heartbeat: {
      name: 'vercel-watchdog',
      visibility: 'mission-control',
      cadenceDescription: '5-min Vercel cron that polls /api/admin/doctor and alerts on fail (replaces scraper/vercel-watchdog.js post-v4)',
    },
    description: 'Polls the application health endpoint.',
    mission: { description: 'Health-checks the app every few minutes.', group: 'Other', tier: 'timer' },
  },

  // ─── The AI findings layer, switched on 2026-08-06 ───────────────────────
  //
  // These four were staged from the day they were written, by the founder's
  // standing ruling that nothing in this layer runs on a timer until a real
  // hotel is on it. They go on TOGETHER, in one act, which is the other half
  // of that ruling: on 2026-07-29 `run-management-patterns` was scheduled by
  // itself and the only effect it could have had was paid model runs against
  // the seeded demo company. It was parked the same day.
  //
  // The schedules are the ones docs/cron-triggers.md has carried all along,
  // and the order is the order the work depends on: the nightly pass at 6, the
  // weekly detector discovery at 7 on Monday, its retention sweep forty
  // minutes later, and the management-company pass at 8.
  {
    id: 'run-findings',
    lifecycle: 'active',
    owner: 'ai-findings',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/run-findings' },
    schedule: '0 6 * * *',
    heartbeat: {
      name: 'run-findings',
      visibility: 'mission-control',
      cadenceDescription: 'nightly 06:00 UTC pass: demote, detect, then one batched judge call per hotel inside its own spend cap',
    },
    description: 'Runs per-hotel findings: self-demotion, detection and the nightly judge.',
    mission: { description: 'Checks each hotel overnight and writes up what it found.', group: 'Reports', tier: 'ai' },
  },
  {
    id: 'findings-sweep',
    lifecycle: 'active',
    owner: 'ai-findings',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/findings-sweep' },
    schedule: '0 7 * * 1',
    heartbeat: {
      name: 'findings-sweep',
      visibility: 'mission-control',
      cadenceDescription: 'weekly Monday 07:00 UTC discovery of candidate detectors, one model call per sampled hotel',
    },
    description: 'Discovers candidate findings detectors across a sample of hotels.',
    mission: { description: 'Looks weekly for new kinds of problem worth watching.', group: 'Reports', tier: 'ai' },
  },
  {
    id: 'findings-janitor',
    lifecycle: 'active',
    owner: 'ai-findings',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/findings-janitor' },
    schedule: '40 7 * * 1',
    heartbeat: {
      name: 'findings-janitor',
      visibility: 'mission-control',
      cadenceDescription: 'weekly Monday 07:40 UTC retention for settled findings-engine run data, forty minutes behind the sweep it cleans up after',
    },
    description: 'Retention for settled findings-engine run data.',
    mission: { description: 'Clears out old check results once they are settled.', group: 'Cleanup', tier: 'timer' },
  },
  {
    id: 'run-management-patterns',
    lifecycle: 'active',
    owner: 'ai-findings',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/run-management-patterns' },
    schedule: '0 8 * * *',
    heartbeat: {
      name: 'run-management-patterns',
      visibility: 'mission-control',
      cadenceDescription: 'nightly 08:00 UTC management-company pass; scheduled discovery excludes companies whose whole portfolio is a test hotel (src/lib/company/demo-portfolio.ts)',
    },
    description: 'Refreshes management-company patterns for real portfolios.',
    mission: { description: 'Looks across a management company for patterns one hotel cannot show.', group: 'Reports', tier: 'ai' },
  },
  {
    id: 'companion-event-wake',
    lifecycle: 'active',
    owner: 'agent',
    runner: 'vercel-cron',
    source: { kind: 'vercel', configFile: 'vercel.json' },
    target: { kind: 'route', path: '/api/cron/companion-event-wake' },
    schedule: '*/10 * * * *',
    heartbeat: {
      name: 'companion-event-wake',
      visibility: 'mission-control',
      cadenceDescription: 'every-10-min deterministic look at activity_log per hotel; a model call only where flagged events landed, capped per hotel per day by both a wake counter and a dollar hold',
    },
    description: 'Notices flagged hotel events as they happen and prepares one note the companion may offer.',
    mission: { description: 'Spots something going wrong within minutes instead of overnight.', group: 'Agent', tier: 'ai' },
  },

  // ─── The nightly robot walkthrough ──────────────────────────────────────
  //
  // The odd one out on this list, in two ways worth writing down.
  //
  // Its RUNNER is not a route. Every other job here is a URL something calls on
  // a timer; this one is a real browser on a GitHub runner that signs into the
  // live site and uses it. The route it targets is where the browser REPORTS
  // to, which is also the thing that writes the heartbeat — so the catalog row
  // still lines up with the standing invariant that a heartbeat name matches a
  // writeCronHeartbeat call in the route at `target.path`.
  //
  // Its heartbeat means something stricter than the others'. The rest write one
  // whenever they finish; this one writes one only when EVERY step passed. So
  // "on time" here reads as "a manager could still do all thirteen things last
  // night", and two consecutive broken nights turn the row amber on their own,
  // underneath the Recent-errors entry that named the step the first night.
  {
    id: 'robot-walk',
    lifecycle: 'active',
    owner: 'platform',
    runner: 'github-actions',
    source: { kind: 'github', workflowFile: 'robot-walk.yml' },
    target: { kind: 'route', path: '/api/admin/robot-walk/report' },
    schedule: '0 10 * * *',
    heartbeat: {
      name: 'robot-walk',
      visibility: 'mission-control',
      cadenceDescription: 'nightly 10:00 UTC browser walkthrough of the live site at the seeded robot hotel; the heartbeat lands only when every step passed',
    },
    description: 'Signs into the live app and walks it end to end, reporting each step.',
    mission: { description: 'Signs into the live app every night and checks a manager can still use it.', group: 'Other', tier: 'ai' },
  },
];

const OTHER_JOBS: ReadonlyArray<JobCatalogEntry> = [
  // Active scheduler entries that intentionally are not Doctor heartbeat checks.
  {
    id: 'ml-aggregate-priors', lifecycle: 'active', owner: 'inventory-ml', runner: 'github-actions',
    source: { kind: 'github', workflowFile: 'ml-cron.yml' },
    target: { kind: 'route', path: '/api/cron/ml-aggregate-priors' }, schedule: '30 7 * * 0',
    heartbeat: { name: 'ml-aggregate-priors', visibility: 'record-only' },
    description: 'Aggregates cold-start cohort priors before inventory training.',
  },
  {
    id: 'dependency-audit', lifecycle: 'active', owner: 'platform', runner: 'github-actions',
    source: { kind: 'github', workflowFile: 'dependency-audit.yml' },
    target: { kind: 'workflow', workflowFile: 'dependency-audit.yml' }, schedule: '17 9 * * 1',
    heartbeat: null, description: 'Checks production dependencies for high and critical advisories.',
  },

  // Ready or intentionally parked routes. A staged row never implies a schedule.
  {
    id: 'agent-nudges-check', lifecycle: 'staged', owner: 'agent', runner: 'manual',
    source: { kind: 'route-only' }, target: { kind: 'route', path: '/api/agent/nudges/check' }, schedule: null,
    heartbeat: { name: 'agent-nudges-check', visibility: 'record-only' }, description: 'Runs per-hotel agent nudge checks; the route is retained but has no repository scheduler.',
  },
  {
    id: 'expire-trials', lifecycle: 'staged', owner: 'platform', runner: 'manual',
    source: { kind: 'route-only' }, target: { kind: 'route', path: '/api/cron/expire-trials' }, schedule: null,
    heartbeat: { name: 'expire-trials', visibility: 'record-only' }, description: 'Expires eligible trial accounts when trial operations are enabled.',
  },
  {
    id: 'lost-found-disposal-check', lifecycle: 'staged', owner: 'hotel-operations', runner: 'manual',
    source: { kind: 'route-only' }, target: { kind: 'route', path: '/api/cron/lost-found-disposal-check' }, schedule: null,
    heartbeat: { name: 'lost-found-disposal-check', visibility: 'record-only' }, description: 'Checks retained lost-and-found items for disposal eligibility.',
  },
  {
    id: 'run-auto-assign', lifecycle: 'staged', owner: 'hotel-operations', runner: 'manual',
    source: { kind: 'route-only' }, target: { kind: 'route', path: '/api/cron/run-auto-assign' }, schedule: null,
    heartbeat: { name: 'run-auto-assign', visibility: 'record-only' }, description: 'Runs automatic room assignment when hotel automation is enabled.',
  },
  {
    id: 'run-rules-engine', lifecycle: 'staged', owner: 'hotel-operations', runner: 'manual',
    source: { kind: 'route-only' }, target: { kind: 'route', path: '/api/cron/run-rules-engine' }, schedule: null,
    heartbeat: { name: 'run-rules-engine', visibility: 'record-only' }, description: 'Runs hotel operational automation rules.',
  },
  {
    id: 'schedule-auto-fill', lifecycle: 'staged', owner: 'hotel-operations', runner: 'manual',
    source: { kind: 'route-only' }, target: { kind: 'route', path: '/api/cron/schedule-auto-fill' }, schedule: null,
    heartbeat: { name: 'schedule-auto-fill', visibility: 'record-only' }, description: 'Builds automatic schedule assignments for opted-in hotels.',
  },
  {
    id: 'seal-daily', lifecycle: 'staged', owner: 'hotel-operations', runner: 'manual',
    source: { kind: 'route-only' }, target: { kind: 'route', path: '/api/cron/seal-daily' }, schedule: null,
    heartbeat: { name: 'seal-daily', visibility: 'record-only' }, description: 'Seals a hotel business day and its training projection.',
  },
  {
    id: 'webhook-dedup-purge', lifecycle: 'staged', owner: 'billing', runner: 'manual',
    source: { kind: 'route-only' }, target: { kind: 'route', path: '/api/cron/webhook-dedup-purge' }, schedule: null,
    heartbeat: { name: 'webhook-dedup-purge', visibility: 'record-only' }, description: 'Purges webhook deduplication rows after billing has a live producer.',
  },

  // Workflows deliberately available only through an operator action.
  {
    id: 'agent-consolidate-memory-sharded', lifecycle: 'manual-only', owner: 'agent', runner: 'github-actions',
    source: { kind: 'github', workflowFile: 'memory-consolidate-cron.yml' },
    target: { kind: 'workflow', workflowFile: 'memory-consolidate-cron.yml' }, schedule: null,
    heartbeat: null, description: 'Manual sharded alternate runner for the active nightly memory-consolidation route.',
  },
  {
    id: 'ml-retention-purge', lifecycle: 'manual-only', owner: 'inventory-ml', runner: 'github-actions',
    source: { kind: 'github', workflowFile: 'ml-retention-purge.yml' },
    target: { kind: 'route', path: '/api/cron/ml-retention-purge' }, schedule: null,
    heartbeat: { name: 'ml-retention-purge', visibility: 'record-only' }, description: 'Runs the ML retention purge after an operator reviews its dry run.',
  },
  {
    id: 'ml-run-inference', lifecycle: 'manual-only', owner: 'inventory-ml', runner: 'github-actions',
    source: { kind: 'github', workflowFile: 'ml-cron.yml' },
    target: { kind: 'route', path: '/api/cron/ml-run-inference' }, schedule: null,
    heartbeat: { name: 'ml-run-inference', visibility: 'record-only' }, description: 'Runs the parked housekeeping ML inference pipeline.',
  },
  {
    id: 'ml-train-demand', lifecycle: 'manual-only', owner: 'inventory-ml', runner: 'github-actions',
    source: { kind: 'github', workflowFile: 'ml-cron.yml' },
    target: { kind: 'route', path: '/api/cron/ml-train-demand' }, schedule: null,
    heartbeat: { name: 'ml-train-demand', visibility: 'record-only' }, description: 'Runs parked demand-model training.',
  },
  {
    id: 'ml-train-supply', lifecycle: 'manual-only', owner: 'inventory-ml', runner: 'github-actions',
    source: { kind: 'github', workflowFile: 'ml-cron.yml' },
    target: { kind: 'route', path: '/api/cron/ml-train-supply' }, schedule: null,
    heartbeat: { name: 'ml-train-supply', visibility: 'record-only' }, description: 'Runs parked supply-model training.',
  },
  {
    id: 'ml-smoke', lifecycle: 'manual-only', owner: 'inventory-ml', runner: 'github-actions',
    source: { kind: 'github', workflowFile: 'ml-smoke-nightly.yml' },
    target: { kind: 'workflow', workflowFile: 'ml-smoke-nightly.yml' }, schedule: null,
    heartbeat: null, description: 'Runs the production ML contract smoke manually; its nightly schedule is disabled.',
  },
  {
    id: 'sentry-test', lifecycle: 'manual-only', owner: 'platform', runner: 'github-actions',
    source: { kind: 'github', workflowFile: 'sentry-test.yml' },
    target: { kind: 'workflow', workflowFile: 'sentry-test.yml' }, schedule: null,
    heartbeat: null, description: 'Runs the explicit Sentry delivery test from the Actions UI.',
  },

  // CI and deployment checks triggered by repository events rather than time.
  {
    id: 'check-migrations-applied', lifecycle: 'event-driven', owner: 'platform', runner: 'github-actions',
    source: { kind: 'github', workflowFile: 'check-migrations-applied.yml' },
    target: { kind: 'workflow', workflowFile: 'check-migrations-applied.yml' }, schedule: null,
    heartbeat: null, description: 'Checks migration application state on its declared repository events.',
  },
  {
    id: 'post-deploy-smoke-test', lifecycle: 'event-driven', owner: 'platform', runner: 'github-actions',
    source: { kind: 'github', workflowFile: 'post-deploy-smoke-test.yml' },
    target: { kind: 'workflow', workflowFile: 'post-deploy-smoke-test.yml' }, schedule: null,
    heartbeat: null, description: 'Runs deployment smoke checks after its declared repository event.',
  },
  {
    id: 'tests', lifecycle: 'event-driven', owner: 'platform', runner: 'github-actions',
    source: { kind: 'github', workflowFile: 'tests.yml' },
    target: { kind: 'workflow', workflowFile: 'tests.yml' }, schedule: null,
    heartbeat: null, description: 'Runs the repository test workflow on push and pull request events.',
  },

  // Retained history or guarded routes with no supported automatic runtime.
  {
    id: 'claude-sessions-purge', lifecycle: 'retired', owner: 'developer-tools', runner: 'none',
    source: { kind: 'route-only' }, target: { kind: 'route', path: '/api/cron/claude-sessions-purge' }, schedule: null,
    heartbeat: { name: 'claude-sessions-purge', visibility: 'record-only' }, description: 'Historical cleanup for an unused developer-session table.',
  },
  {
    id: 'ml-shadow-evaluate', lifecycle: 'retired', owner: 'inventory-ml', runner: 'none',
    source: { kind: 'github', workflowFile: 'ml-shadow-evaluate-cron.yml' },
    target: { kind: 'route', path: '/api/cron/ml-shadow-evaluate' }, schedule: null,
    heartbeat: null, description: 'Retained manual workflow whose referenced API route is no longer present.',
  },
  {
    id: 'ml-auto-rollback', lifecycle: 'retired', owner: 'inventory-ml', runner: 'none',
    source: { kind: 'github', workflowFile: 'ml-cron.yml' },
    target: { kind: 'route', path: '/api/cron/ml-auto-rollback' }, schedule: null,
    heartbeat: null, description: 'Retained manual ML workflow job whose referenced API route is no longer present.',
  },
];

/** Complete inventory of cron-shaped routes and repository workflow operations. */
export const JOB_CATALOG: ReadonlyArray<JobCatalogEntry> = [
  ...ACTIVE_MISSION_JOBS,
  ...OTHER_JOBS,
];

export function cronCadenceHours(expr: string): number {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron "${expr}" does not have 5 fields`);
  const [minute, hour, dom, month, dow] = parts;

  const stepped = (field: string): number | null => {
    const match = /^\*\/(\d+)$/.exec(field);
    return match ? Number(match[1]) : null;
  };

  const minuteStep = stepped(minute);
  if (minuteStep !== null && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return minuteStep / 60;
  }
  if (minute === '*') throw new Error(`cron "${expr}" has unsupported every-minute cadence`);
  if (hour === '*' && dom === '*' && month === '*' && dow === '*') return 1;

  const hourStep = stepped(hour);
  if (hourStep !== null && dom === '*' && month === '*' && dow === '*') return hourStep;
  if (hour !== '*' && dom === '*' && month === '*' && dow === '*') return 24;
  if (hour !== '*' && dom === '*' && month === '*' && dow !== '*') return 168;

  throw new Error(`cron "${expr}" has unsupported cadence shape`);
}
