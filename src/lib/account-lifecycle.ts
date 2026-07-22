import 'server-only';

import { randomUUID } from 'node:crypto';

import { log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

export interface AccountLifecycleIntent {
  status: 'pending' | 'committed' | 'aborted' | 'not_found' | string;
  operationId: string;
  accountId: string;
  intentVersion: number;
  desiredActive: boolean;
  priorActive: boolean;
  authUserId: string;
  active: boolean;
  committedVersion: number;
  latestDesiredActive: boolean;
  latestIntentVersion: number;
  authBannedUntil: string | null;
  authSnapshotRecordedAt: string | null;
}

export type AccountLifecycleProcessResult =
  | {
      kind: 'committed';
      operationId: string;
      accountId: string;
      active: boolean;
      noop: boolean;
    }
  | {
      kind: 'pending';
      operationId: string;
      accountId?: string;
      reason: string;
    }
  | {
      kind: 'aborted' | 'conflict' | 'not_found';
      operationId: string;
      accountId?: string;
      reason: string;
    };

interface RpcObject {
  [key: string]: unknown;
}

function objectValue(value: unknown): RpcObject | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as RpcObject;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as RpcObject
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function parseIntent(value: unknown): AccountLifecycleIntent | null {
  const row = objectValue(value);
  if (!row) return null;
  const status = stringValue(row.status);
  if (!status) return null;
  return {
    status,
    operationId: stringValue(row.operation_id),
    accountId: stringValue(row.account_id),
    intentVersion: numberValue(row.intent_version),
    desiredActive: booleanValue(row.desired_active),
    priorActive: booleanValue(row.prior_active),
    authUserId: stringValue(row.auth_user_id),
    active: booleanValue(row.active),
    committedVersion: numberValue(row.committed_version),
    latestDesiredActive: row.latest_desired_active === undefined
      ? booleanValue(row.desired_active)
      : booleanValue(row.latest_desired_active),
    latestIntentVersion: row.latest_intent_version === undefined
      ? numberValue(row.intent_version)
      : numberValue(row.latest_intent_version),
    authBannedUntil: typeof row.auth_banned_until === 'string'
      ? row.auth_banned_until
      : null,
    authSnapshotRecordedAt: typeof row.auth_snapshot_recorded_at === 'string'
      ? row.auth_snapshot_recorded_at
      : null,
  };
}

export async function readAccountLifecycleIntent(operationId: string): Promise<{
  intent: AccountLifecycleIntent | null;
  error: unknown | null;
}> {
  try {
    const result = await supabaseAdmin.rpc('staxis_get_account_lifecycle_intent', {
      p_operation_id: operationId,
    });
    if (result.error) return { intent: null, error: result.error };
    return { intent: parseIntent(result.data), error: null };
  } catch (error) {
    return { intent: null, error };
  }
}

type AuthObservation =
  | {
      known: true;
      active: boolean;
      durablyInactive: boolean;
      bannedUntil: string | null;
    }
  | { known: false; error: unknown };

const DURABLE_DEACTIVATION_MS = 50 * 365.25 * 24 * 60 * 60 * 1000;
const AUTH_SNAPSHOT_EARLY_TOLERANCE_MS = 1_000;
const AUTH_SNAPSHOT_LATE_TOLERANCE_MS = 10_000;
const PROCESSOR_LEASE_SECONDS = 600;

function observeBannedUntil(value: unknown): AuthObservation {
  if (value === null || value === undefined || value === '') {
    return { known: true, active: true, durablyInactive: false, bannedUntil: null };
  }
  if (typeof value !== 'string') {
    return { known: false, error: new Error('Auth returned an invalid banned_until value') };
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return { known: false, error: new Error('Auth returned an unparseable banned_until value') };
  }
  return {
    known: true,
    active: timestamp <= Date.now(),
    durablyInactive: timestamp >= Date.now() + DURABLE_DEACTIVATION_MS,
    bannedUntil: value,
  };
}

function authMatchesDesired(observation: AuthObservation, desiredActive: boolean): boolean {
  if (!observation.known) return false;
  return desiredActive ? observation.active : observation.durablyInactive;
}

async function readAuthState(authUserId: string): Promise<AuthObservation> {
  try {
    const result = await supabaseAdmin.auth.admin.getUserById(authUserId);
    if (result.error || !result.data?.user) {
      return { known: false, error: result.error ?? new Error('Auth user not found') };
    }
    return observeBannedUntil(result.data.user.banned_until);
  } catch (error) {
    return { known: false, error };
  }
}

/** Every Auth write is followed by an authoritative read, including throws. */
async function writeAndVerifyAuth(
  authUserId: string,
  active: boolean,
): Promise<{ observation: AuthObservation; updateError: unknown | null }> {
  let updateError: unknown | null = null;
  try {
    const update = await supabaseAdmin.auth.admin.updateUserById(authUserId, {
      ban_duration: active ? 'none' : '876000h',
    });
    updateError = update.error ?? null;
  } catch (error) {
    updateError = error;
  }
  return {
    observation: await readAuthState(authUserId),
    updateError,
  };
}

function authMatchesSnapshot(
  observation: AuthObservation,
  bannedUntil: string | null,
): boolean {
  if (!observation.known) return false;
  if (!bannedUntil) return observation.active;
  const target = Date.parse(bannedUntil);
  if (!Number.isFinite(target)) return false;
  if (target <= Date.now()) return observation.active;
  if (!observation.bannedUntil) return false;
  const observed = Date.parse(observation.bannedUntil);
  const difference = observed - target;
  return Number.isFinite(observed)
    && !observation.active
    && difference >= -AUTH_SNAPSHOT_EARLY_TOLERANCE_MS
    && difference <= AUTH_SNAPSHOT_LATE_TOLERANCE_MS;
}

async function writeAndVerifyAuthSnapshot(
  authUserId: string,
  bannedUntil: string | null,
): Promise<{ observation: AuthObservation; updateError: unknown | null }> {
  const target = bannedUntil ? Date.parse(bannedUntil) : Number.NaN;
  const duration = Number.isFinite(target) && target > Date.now()
    ? `${Math.max(1, Math.ceil((target - Date.now()) / 1000))}s`
    : 'none';
  let updateError: unknown | null = null;
  try {
    const update = await supabaseAdmin.auth.admin.updateUserById(authUserId, {
      ban_duration: duration,
    });
    updateError = update.error ?? null;
  } catch (error) {
    updateError = error;
  }
  return {
    observation: await readAuthState(authUserId),
    updateError,
  };
}

async function notePending(operationId: string, reason: string): Promise<void> {
  try {
    await supabaseAdmin.rpc('staxis_note_account_lifecycle_attempt', {
      p_operation_id: operationId,
      p_error: reason.slice(0, 500),
    });
  } catch {
    // The durable intent already exists. A note failure must never cause an
    // unverified accounts.active write or hide the pending operation.
  }
}

async function claimLifecycleIntent(
  operationId: string,
  processorToken: string,
): Promise<{ status: string; error: unknown | null }> {
  try {
    const result = await supabaseAdmin.rpc('staxis_claim_account_lifecycle_intent', {
      p_operation_id: operationId,
      p_processor_token: processorToken,
      p_lease_seconds: PROCESSOR_LEASE_SECONDS,
    });
    if (result.error) return { status: '', error: result.error };
    return { status: stringValue(objectValue(result.data)?.status), error: null };
  } catch (error) {
    return { status: '', error };
  }
}

async function releaseLifecycleProcessor(
  operationId: string,
  processorToken: string,
): Promise<void> {
  try {
    await supabaseAdmin.rpc('staxis_release_account_lifecycle_processor', {
      p_operation_id: operationId,
      p_processor_token: processorToken,
    });
  } catch {
    // The bounded lease remains a safe fence and will expire automatically.
  }
}

function intentIsSuperseded(intent: AccountLifecycleIntent): boolean {
  return intent.latestIntentVersion > intent.intentVersion;
}

function supersededConflict(
  operationId: string,
  intent: AccountLifecycleIntent,
): AccountLifecycleProcessResult {
  return {
    kind: 'conflict',
    operationId,
    accountId: intent.accountId,
    reason: 'superseded',
  };
}

async function recordAuthSnapshot(
  operationId: string,
  bannedUntil: string | null,
  processorToken: string,
): Promise<unknown | null> {
  try {
    const result = await supabaseAdmin.rpc(
      'staxis_record_account_lifecycle_auth_snapshot',
      {
        p_operation_id: operationId,
        p_banned_until: bannedUntil,
        p_processor_token: processorToken,
      },
    );
    if (result.error) return result.error;
    const status = stringValue(objectValue(result.data)?.status);
    return status === 'pending'
      ? null
      : new Error(`Auth snapshot rejected: ${status || 'unknown'}`);
  } catch (error) {
    return error;
  }
}

function committedResult(
  operationId: string,
  intent: AccountLifecycleIntent,
  value: unknown,
): AccountLifecycleProcessResult {
  const row = objectValue(value);
  return {
    kind: 'committed',
    operationId,
    accountId: intent.accountId,
    active: row?.active === undefined ? intent.desiredActive : booleanValue(row.active),
    noop: row?.noop === undefined
      ? intent.priorActive === intent.desiredActive
      : booleanValue(row.noop),
  };
}

async function compensateAfterVerifiedRestore(
  intent: AccountLifecycleIntent,
  reason: string,
  processorToken: string,
): Promise<AccountLifecycleProcessResult> {
  try {
    const result = await supabaseAdmin.rpc(
      'staxis_compensate_account_lifecycle_intent',
      {
        p_operation_id: intent.operationId,
        p_reason: reason.slice(0, 500),
        p_processor_token: processorToken,
      },
    );
    const row = objectValue(result.data);
    if (result.error) {
      await notePending(intent.operationId, `compensation failed: ${errToString(result.error)}`);
      return {
        kind: 'pending',
        operationId: intent.operationId,
        accountId: intent.accountId,
        reason: 'compensation_failed',
      };
    }
    if (row?.status === 'committed') {
      await releaseLifecycleProcessor(intent.operationId, processorToken);
      return committedResult(intent.operationId, intent, row);
    }
    if (row?.status === 'superseded') {
      await releaseLifecycleProcessor(intent.operationId, processorToken);
      return {
        kind: 'conflict',
        operationId: intent.operationId,
        accountId: intent.accountId,
        reason: 'superseded',
      };
    }
    if (row?.status === 'aborted') {
      await releaseLifecycleProcessor(intent.operationId, processorToken);
      return {
        kind: 'aborted',
        operationId: intent.operationId,
        accountId: intent.accountId,
        reason,
      };
    }
    await notePending(intent.operationId, 'compensation returned an unknown state');
    return {
      kind: 'pending',
      operationId: intent.operationId,
      accountId: intent.accountId,
      reason: 'compensation_unknown',
    };
  } catch (error) {
    await notePending(intent.operationId, `compensation threw: ${errToString(error)}`);
    return {
      kind: 'pending',
      operationId: intent.operationId,
      accountId: intent.accountId,
      reason: 'compensation_failed',
    };
  }
}

async function restoreAndCompensate(
  intent: AccountLifecycleIntent,
  restoreBannedUntil: string | null,
  reason: string,
  processorToken: string,
): Promise<AccountLifecycleProcessResult> {
  const claim = await claimLifecycleIntent(intent.operationId, processorToken);
  if (claim.error || claim.status !== 'claimed') {
    return {
      kind: 'pending', operationId: intent.operationId, accountId: intent.accountId,
      reason: 'lease_lost',
    };
  }
  // This renewal is deliberately adjacent to the outbound Auth dispatch. The
  // only callers are the 60-second status route and 60-second cron worker, and
  // their 600-second lease prevents a second worker from writing during or
  // immediately after a platform timeout.
  const restored = await writeAndVerifyAuthSnapshot(
    intent.authUserId,
    restoreBannedUntil,
  );
  if (!restored.observation.known) {
    await notePending(
      intent.operationId,
      `Auth restore could not be verified: ${errToString(restored.observation.error)}`,
    );
    return {
      kind: 'pending', operationId: intent.operationId, accountId: intent.accountId,
      reason: 'auth_restore_unknown',
    };
  }
  if (!authMatchesSnapshot(restored.observation, restoreBannedUntil)) {
    await notePending(intent.operationId, 'Auth restore did not match the recorded snapshot');
    return {
      kind: 'pending', operationId: intent.operationId, accountId: intent.accountId,
      reason: 'auth_restore_mismatch',
    };
  }
  return compensateAfterVerifiedRestore(intent, reason, processorToken);
}

async function commitVerifiedIntent(
  intent: AccountLifecycleIntent,
  requestId: string,
  processorToken: string,
  restoreBannedUntil: string | null,
): Promise<AccountLifecycleProcessResult> {
  const claim = await claimLifecycleIntent(intent.operationId, processorToken);
  if (!claim.error && claim.status === 'superseded') {
    await releaseLifecycleProcessor(intent.operationId, processorToken);
    return supersededConflict(intent.operationId, intent);
  }
  if (claim.error || claim.status !== 'claimed') {
    const reread = await readAccountLifecycleIntent(intent.operationId);
    if (!reread.error && reread.intent?.status === 'committed'
        && intentIsSuperseded(reread.intent)) {
      return supersededConflict(intent.operationId, reread.intent);
    }
    if (!reread.error && reread.intent?.status === 'committed') {
      return committedResult(intent.operationId, reread.intent, null);
    }
    if (!reread.error && reread.intent?.status === 'aborted') {
      return {
        kind: 'aborted', operationId: intent.operationId, accountId: reread.intent.accountId,
        reason: 'intent_aborted',
      };
    }
    return {
      kind: 'pending', operationId: intent.operationId, accountId: intent.accountId,
      reason: 'lease_lost',
    };
  }
  let data: unknown = null;
  let error: unknown | null = null;
  try {
    const result = await supabaseAdmin.rpc('staxis_commit_account_lifecycle_intent', {
      p_operation_id: intent.operationId,
      p_request_id: requestId,
      p_processor_token: processorToken,
    });
    data = result.data;
    error = result.error ?? null;
  } catch (caught) {
    error = caught;
  }

  const row = objectValue(data);
  if (!error && row?.status === 'committed') {
    await releaseLifecycleProcessor(intent.operationId, processorToken);
    return committedResult(intent.operationId, intent, row);
  }
  if (!error && row?.status === 'aborted') {
    return {
      kind: 'aborted', operationId: intent.operationId, accountId: intent.accountId,
      reason: 'intent_aborted',
    };
  }

  // An RPC response can be lost after PostgreSQL commits. Re-read the durable
  // intent before deciding this is still pending; this makes retry response
  // loss idempotent and avoids a false compensation.
  const reread = await readAccountLifecycleIntent(intent.operationId);
  if (!reread.error && reread.intent?.status === 'committed') {
    if (intentIsSuperseded(reread.intent)) {
      return supersededConflict(intent.operationId, reread.intent);
    }
    await releaseLifecycleProcessor(intent.operationId, processorToken);
    return committedResult(intent.operationId, reread.intent, row);
  }
  if (!reread.error && reread.intent?.status === 'aborted') {
    return {
      kind: 'aborted', operationId: intent.operationId, accountId: intent.accountId,
      reason: 'intent_aborted',
    };
  }

  const status = stringValue(row?.status);
  if (!error && status === 'superseded') {
    await releaseLifecycleProcessor(intent.operationId, processorToken);
    return supersededConflict(intent.operationId, reread.intent ?? intent);
  }
  if (!error && status === 'invariant_conflict') {
    const latest = reread.intent ?? intent;
    if (intentIsSuperseded(latest) || latest.status !== 'pending') {
      return intentIsSuperseded(latest)
        ? supersededConflict(intent.operationId, latest)
        : {
            kind: latest.status === 'aborted' ? 'aborted' : 'conflict',
            operationId: intent.operationId,
            accountId: latest.accountId,
            reason: latest.status === 'aborted' ? 'intent_aborted' : 'terminal_conflict',
          };
    }
    // Auth was already verified to the requested state. Restore it to the
    // latest database-authoritative state before aborting this unusable intent.
    return restoreAndCompensate(
      latest,
      latest.authSnapshotRecordedAt
        ? latest.authBannedUntil
        : restoreBannedUntil,
      status,
      processorToken,
    );
  }

  const detail = error ? errToString(error) : `commit returned ${status || 'unknown'}`;
  await notePending(intent.operationId, `commit unresolved: ${detail}`);
  return {
    kind: 'pending', operationId: intent.operationId, accountId: intent.accountId,
    reason: 'commit_unknown',
  };
}

/**
 * Cross-system Auth writes are permitted only through this shared processor.
 * Production imports are restricted to the status route and lifecycle cron;
 * both declare maxDuration=60 while every claim requests a 600-second lease.
 * Every outbound Auth dispatch below is preceded immediately by a renewal.
 */
export async function processAccountLifecycleIntent(input: {
  operationId: string;
  requestId: string;
  source: 'route' | 'cron';
}): Promise<AccountLifecycleProcessResult> {
  const loaded = await readAccountLifecycleIntent(input.operationId);
  if (loaded.error || !loaded.intent) {
    log.error('[account-lifecycle] intent read failed', {
      requestId: input.requestId,
      operationId: input.operationId,
      source: input.source,
      msg: errToString(loaded.error),
    });
    return { kind: 'pending', operationId: input.operationId, reason: 'intent_read_failed' };
  }
  const intent = loaded.intent;
  if (intent.status === 'not_found') {
    return { kind: 'not_found', operationId: input.operationId, reason: 'not_found' };
  }
  if (intent.status === 'committed') {
    if (intentIsSuperseded(intent)) {
      return supersededConflict(input.operationId, intent);
    }
    return committedResult(input.operationId, intent, null);
  }
  if (intent.status === 'aborted') {
    return {
      kind: 'aborted', operationId: input.operationId, accountId: intent.accountId,
      reason: 'intent_aborted',
    };
  }
  if (intent.status !== 'pending' || !intent.accountId || !intent.authUserId) {
    return { kind: 'conflict', operationId: input.operationId, reason: 'invalid_intent' };
  }

  const processorToken = randomUUID();
  const initialClaim = await claimLifecycleIntent(intent.operationId, processorToken);
  if (initialClaim.error) {
    return {
      kind: 'pending', operationId: input.operationId, accountId: intent.accountId,
      reason: 'claim_unavailable',
    };
  }
  if (initialClaim.status === 'busy') {
    return {
      kind: 'pending', operationId: input.operationId, accountId: intent.accountId,
      reason: 'already_processing',
    };
  }
  if (initialClaim.status === 'superseded') {
    await releaseLifecycleProcessor(intent.operationId, processorToken);
    return supersededConflict(input.operationId, intent);
  }
  if (initialClaim.status === 'committed') {
    const reread = await readAccountLifecycleIntent(intent.operationId);
    if (reread.intent && intentIsSuperseded(reread.intent)) {
      return supersededConflict(input.operationId, reread.intent);
    }
    return reread.intent
      ? committedResult(input.operationId, reread.intent, null)
      : {
        kind: 'pending', operationId: input.operationId, accountId: intent.accountId,
        reason: 'terminal_read_failed',
      };
  }
  if (initialClaim.status === 'aborted') {
    return {
      kind: 'aborted', operationId: input.operationId, accountId: intent.accountId,
      reason: 'intent_aborted',
    };
  }
  if (initialClaim.status !== 'claimed') {
    return {
      kind: 'pending', operationId: input.operationId, accountId: intent.accountId,
      reason: 'claim_rejected',
    };
  }

  // Refuse to write Auth if it cannot first be read. This records the exact
  // pre-write ban snapshot for incident review and eliminates blind updates.
  const before = await readAuthState(intent.authUserId);
  if (!before.known) {
    await notePending(intent.operationId, `Auth pre-read failed: ${errToString(before.error)}`);
    return {
      kind: 'pending', operationId: input.operationId, accountId: intent.accountId,
      reason: 'auth_read_failed',
    };
  }
  const snapshotError = await recordAuthSnapshot(
    intent.operationId,
    before.bannedUntil,
    processorToken,
  );
  if (snapshotError) {
    await notePending(intent.operationId, `Auth snapshot failed: ${errToString(snapshotError)}`);
    return {
      kind: 'pending', operationId: input.operationId, accountId: intent.accountId,
      reason: 'auth_snapshot_failed',
    };
  }
  const restoreBannedUntil = intent.authSnapshotRecordedAt
    ? intent.authBannedUntil
    : before.bannedUntil;

  if (authMatchesDesired(before, intent.desiredActive)) {
    return commitVerifiedIntent(
      intent,
      input.requestId,
      processorToken,
      restoreBannedUntil,
    );
  }

  const renewed = await claimLifecycleIntent(intent.operationId, processorToken);
  if (renewed.error || renewed.status !== 'claimed') {
    return {
      kind: 'pending', operationId: input.operationId, accountId: intent.accountId,
      reason: 'lease_lost',
    };
  }
  // Keep this renewal adjacent to the dispatch; do not insert network work
  // between the lease check and updateUserById.
  const changed = await writeAndVerifyAuth(intent.authUserId, intent.desiredActive);
  if (!changed.observation.known) {
    await notePending(
      intent.operationId,
      `Auth update unknown after verification read: ${errToString(changed.observation.error)}`,
    );
    return {
      kind: 'pending', operationId: input.operationId, accountId: intent.accountId,
      reason: 'auth_update_unknown',
    };
  }
  if (authMatchesDesired(changed.observation, intent.desiredActive)) {
    return commitVerifiedIntent(
      intent,
      input.requestId,
      processorToken,
      restoreBannedUntil,
    );
  }

  // The failed update is now unambiguous because the follow-up read succeeded.
  // Restore/verify the still-committed database state before aborting.
  return restoreAndCompensate(
    intent,
    restoreBannedUntil,
    'Auth did not reach desired state',
    processorToken,
  );
}
