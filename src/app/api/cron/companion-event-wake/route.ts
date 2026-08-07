/**
 * GET | POST /api/cron/companion-event-wake — THE TEN-MINUTE LOOK.
 *
 * The companion used to notice things once a night. A work order opened at 9am
 * became news at 6am the next morning, by which time it had been fixed or
 * forgotten. This route is the other half of that fix: not a faster nightly
 * pass, and not a per-minute loop, but a cheap look every ten minutes at the
 * one table every part of the hotel already writes to.
 *
 * ─── WHAT IT COSTS ON A QUIET HOTEL ────────────────────────────────────────
 *
 * One indexed read. No model call, no reservation, no prompt, no row written.
 * That is a structural property rather than a hope: the decision to spend money
 * is made by `decideWake` (src/lib/companion/event-wake/events.ts), which is a
 * pure function over rows that a query already filtered, and a hotel where
 * nothing went wrong returns none.
 *
 * ─── WHAT IT COSTS ON A BUSY ONE ───────────────────────────────────────────
 *
 * At most MAX_WAKES_PER_DAY short calls per hotel per hotel-local day, each one
 * inside a per-hotel-per-day dollar hold that is the backstop when the counter
 * is lost. Both ceilings are real and both are visible: the counter is a column
 * an operator can read, and the dollar cap is a row in `findings_ai_spend`.
 *
 * ─── WHAT IT NEVER DOES ────────────────────────────────────────────────────
 *
 * Act on the hotel, and tell anybody anything. It PREPARES: at most one short
 * sentence, written into the companion's own record, which the companion may
 * offer later if and only if the manners engine allows it. Everything the
 * charter promises about a No, a daily budget and never speaking over somebody
 * applies unchanged, because this route adds no path around it.
 *
 * Query params:
 *   propertyId (optional, uuid) — sweep only this hotel, demo or not. An
 *                                 operator naming a hotel by id is intent; only
 *                                 the schedule's own discovery skips demo
 *                                 hotels.
 *
 * Auth: CRON_SECRET bearer (shared with the rest of /api/cron/*).
 */

import { NextRequest } from 'next/server';

import { requireCronSecret } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { isUuid } from '@/lib/api-validate';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { getOrMintRequestId, log } from '@/lib/log';
import { sweepAllProperties, type PropertySweepResult } from '@/lib/companion/event-wake/runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Outcomes that mean something is BROKEN rather than something is quiet.
 *  They are what turns the heartbeat yellow, so an operator can tell a hotel
 *  with nothing to say from a hotel nobody is looking at. */
const DEGRADED_OUTCOMES: ReadonlySet<PropertySweepResult['outcome']> = new Set([
  'no_cursor',
  'read_failed',
  'spend_unavailable',
  'model_unavailable',
]);

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  const url = new URL(req.url);
  const propertyId = url.searchParams.get('propertyId');
  if (propertyId !== null && !isUuid(propertyId)) {
    return err('propertyId must be a UUID', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  try {
    const summary = await sweepAllProperties({ propertyId: propertyId ?? undefined });

    const count = (outcome: PropertySweepResult['outcome']) =>
      summary.results.filter((result) => result.outcome === outcome).length;

    const totals = {
      propertiesConsidered: summary.propertiesConsidered,
      // The gate passing and the model being asked are counted apart from what
      // came back. "Woke 4 times and prepared nothing" and "never woke" are
      // very different weeks, and one number holding both would report them
      // identically.
      quiet: count('quiet'),
      // Looked at, and structurally undeliverable: the hotel switched off the
      // list a note would arrive on. Its cursor still advances, because a
      // skipped hotel is not an unwatched one, and the doctor's staleness
      // warning only means something while that stays true.
      listSwitchedOff: count('list_switched_off'),
      prepared: count('prepared'),
      observed: count('observed'),
      saidNothing: count('nothing'),
      // ── the LOUD skips ──
      // Every one of these is a hotel the sweep decided not to spend on, and
      // each is counted under its own name. A cap that ran out and a cap that
      // could not be read are different facts, and filing the second as the
      // first is how an outage becomes a budget line nobody investigates.
      dailyWakeCap: count('daily_wake_cap'),
      spendCap: count('spend_cap'),
      spendUnavailable: count('spend_unavailable'),
      modelUnavailable: count('model_unavailable'),
      noCursor: count('no_cursor'),
      readFailed: count('read_failed'),
      windowAlreadyClaimed: count('window_already_claimed'),
      windowsClamped: summary.results.filter((result) => result.windowClamped).length,
      costUsd: Math.round(summary.results.reduce((sum, r) => sum + r.costUsd, 0) * 10_000) / 10_000,
      switchedOff: summary.switchedOff,
      scoped: Boolean(propertyId),
    };

    const degraded = summary.results.some((result) => DEGRADED_OUTCOMES.has(result.outcome));
    if (degraded) {
      // Escalated so it reaches Sentry. A watcher that has silently stopped
      // watching is the one failure this feature must never have.
      log.error('[companion/event-wake] sweep degraded', {
        requestId,
        ...totals,
        degradedProperties: summary.results
          .filter((result) => DEGRADED_OUTCOMES.has(result.outcome))
          .map((result) => ({ property_id: result.propertyId, outcome: result.outcome })),
      });
    } else {
      log.info('[companion/event-wake] sweep completed', { requestId, ...totals });
    }

    await writeCronHeartbeat('companion-event-wake', {
      requestId,
      status: degraded ? 'degraded' : 'ok',
      notes: totals,
    });

    return ok({ totals, perProperty: summary.results }, { requestId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error('[companion/event-wake] sweep failed', { requestId, error: msg });
    return err(`companion event sweep failed: ${msg}`, {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}

/** Same handler, same auth, so a manual kick can use either verb. */
export async function POST(req: NextRequest) {
  return GET(req);
}
