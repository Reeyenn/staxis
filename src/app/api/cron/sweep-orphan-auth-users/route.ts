/**
 * GET /api/cron/sweep-orphan-auth-users
 *
 * ─── Why this cron exists ────────────────────────────────────────────────────
 *
 * Three signup flows (accept-invite, use-join-code, accounts.create) do a
 * two-step "auth.admin.createUser → INSERT into accounts" sequence. If
 * the second step fails, each flow rolls back the auth user. That
 * rollback CAN ALSO FAIL — it's a separate distributed call to
 * Supabase Auth, and supabase has incidents.
 *
 * Pre-2026-05-17 those rollback failures were `.catch(() => {})` — silent.
 * Now they log loudly + Sentry (commit 5 of fix/external-api-hardening).
 * But "log and move on" still leaves an orphan auth.users row with no
 * matching accounts row. The next signup with the same email then
 * fails because Supabase says "user already exists" — and the user is
 * stuck until manual cleanup.
 *
 * This reconciler is the load-bearing safety net. It scans auth users,
 * finds rows older than 10 minutes with no matching `accounts.data_user_id`,
 * and deletes them. 10 minutes is comfortably longer than any normal
 * signup window (sub-second between createUser and the INSERT), so we
 * won't race a real signup in progress.
 *
 * ─── Why a sweeper instead of bulletproof rollback ──────────────────────────
 *
 * "Just retry the rollback" is the bandage. The root cause is that the
 * auth + DB pair is a 2-phase commit across independent backends, and
 * the rollback path has the same failure modes as the original
 * operation. Stripe handles this exact pattern with a 3-day webhook
 * retry window + reconciler. We do the same here.
 *
 * ─── Boundaries ─────────────────────────────────────────────────────────────
 *
 * - Min age: 10 minutes. Anything younger is a normal in-progress signup.
 * - Max age: 7 days. Anything older might be intentional state we don't
 *   understand (admin intervention, manual seed, schema-migration leftover).
 *   We refuse to unilaterally delete it — it's emitted as a separate event
 *   for manual review.
 *
 * ─── Schedule ───────────────────────────────────────────────────────────────
 *
 * Configured in vercel.json. Default cadence: every 30 minutes.
 *
 * Auth: CRON_SECRET bearer.
 *
 * Returns: { swept, failed, skipped_too_new, skipped_too_old, total_auth_users }
 *
 * Kill switch: set DISABLE_ORPHAN_AUTH_SWEEP=true in Vercel env vars to
 * disable without a code change.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { captureException, captureMessage } from '@/lib/sentry';
import { recordAppEvent } from '@/lib/event-recorder';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MIN_AGE_MS = 10 * 60 * 1000; // 10 minutes
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PAGE_SIZE = 1000;
const MAX_PAGES = 50; // safety cap: scans up to 50k auth users per run

interface SweepResult {
  total_auth_users: number;
  swept: number;
  failed: number;
  skipped_too_new: number;
  skipped_too_old: number;
  has_account: number;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  // Kill switch — disable without a code deploy if the sweeper misbehaves.
  if (process.env.DISABLE_ORPHAN_AUTH_SWEEP === 'true') {
    log.info('[sweep-orphan-auth-users] disabled via DISABLE_ORPHAN_AUTH_SWEEP', { requestId });
    return ok({ disabled: true }, { requestId });
  }

  const result: SweepResult = {
    total_auth_users: 0,
    swept: 0,
    failed: 0,
    skipped_too_new: 0,
    skipped_too_old: 0,
    has_account: 0,
  };

  try {
    // Build a Set of data_user_ids that have matching accounts rows.
    // One bulk query is cheaper than N selects per auth user.
    const { data: accountsRows, error: accountsErr } = await supabaseAdmin
      .from('accounts')
      .select('data_user_id');
    if (accountsErr) {
      log.error('[sweep-orphan-auth-users] failed to read accounts', { requestId, accountsErr });
      return err(`Could not read accounts: ${accountsErr.message}`, {
        requestId, status: 500, code: ApiErrorCode.InternalError,
      });
    }
    const accountUserIds = new Set<string>(
      (accountsRows ?? [])
        .map(r => (r as { data_user_id: string | null }).data_user_id)
        .filter((id): id is string => typeof id === 'string'),
    );

    const now = Date.now();

    // Paginate auth users. listUsers returns at most perPage per call.
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, error: listErr } = await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage: PAGE_SIZE,
      });
      if (listErr) {
        log.error('[sweep-orphan-auth-users] listUsers failed', { requestId, page, listErr });
        return err(`listUsers failed: ${listErr.message}`, {
          requestId, status: 500, code: ApiErrorCode.InternalError,
        });
      }
      const users = data?.users ?? [];
      result.total_auth_users += users.length;

      for (const user of users) {
        // Skip if there's a matching account — the common case.
        if (accountUserIds.has(user.id)) {
          result.has_account += 1;
          continue;
        }

        const createdAt = user.created_at ? new Date(user.created_at).getTime() : 0;
        const age = now - createdAt;

        if (age < MIN_AGE_MS) {
          // Sub-10-minute orphan — likely a real signup mid-flight.
          result.skipped_too_new += 1;
          continue;
        }
        if (age > MAX_AGE_MS) {
          // Older than 7 days — refuse to unilaterally delete.
          result.skipped_too_old += 1;
          await recordAppEvent({
            property_id: null,
            user_id: null,
            user_role: 'system',
            event_type: 'orphan_auth_user_skipped_too_old',
            metadata: {
              auth_user_id: user.id,
              email_sha: emailHash(user.email),
              age_seconds: Math.floor(age / 1000),
              request_id: requestId,
            },
          });
          continue;
        }

        // 10 min < age < 7 days, no matching account → orphan, delete it.
        const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(user.id);
        if (delErr) {
          result.failed += 1;
          captureException(new Error(`orphan_auth_sweep_delete_failed: ${delErr.message}`), {
            subsystem: 'auth',
            failure_mode: 'orphan_sweep_delete_failed',
            auth_user_id: user.id,
          });
          continue;
        }
        result.swept += 1;
        await recordAppEvent({
          property_id: null,
          user_id: null,
          user_role: 'system',
          event_type: 'orphan_auth_user_swept',
          metadata: {
            auth_user_id: user.id,
            email_sha: emailHash(user.email),
            age_seconds: Math.floor(age / 1000),
            request_id: requestId,
          },
        });
      }

      // listUsers returns fewer than perPage when we've reached the tail.
      if (users.length < PAGE_SIZE) break;
    }

    if (result.swept > 0) {
      // Info-level heartbeat to Sentry so we know the sweeper is doing
      // something. Operationally, "0 sweeps for 30 days" might mean the
      // sweeper is broken — not silence-is-good.
      captureMessage('orphan_auth_users_swept', {
        subsystem: 'auth',
        ...result,
      });
    }

    await writeCronHeartbeat('sweep-orphan-auth-users', {
      requestId,
      notes: { ...result },
    });
    return ok(result, { requestId });
  } catch (caughtErr) {
    log.error('[sweep-orphan-auth-users] threw', { requestId, caughtErr });
    captureException(caughtErr, { subsystem: 'auth', failure_mode: 'sweeper_threw' });
    return err('sweeper failed', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}

/** SHA-256(email).slice(16) — privacy-safe identifier for logs. */
function emailHash(email: string | undefined): string | null {
  if (!email) return null;
  return createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16);
}
