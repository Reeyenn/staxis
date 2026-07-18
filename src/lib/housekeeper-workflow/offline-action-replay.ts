import { log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

interface OfflineActionReplayContext {
  actionId: string;
  propertyId: string;
  staffId: string;
  endpoint: string;
  requestId: string;
}

export type OfflineActionClaimResult =
  | { ok: true; duplicate: false }
  | { ok: true; duplicate: true; resultPayload: Record<string, unknown> }
  | { ok: false; reason: 'pending' | 'error' };

/**
 * Atomically claims a queued housekeeper action.
 *
 * PostgREST returns a row for a successful insert and SQLSTATE 23505 when the
 * action_id primary key already exists. No other database error is evidence of
 * a replay, so every other outcome fails closed instead of pretending the
 * original action succeeded.
 */
export async function claimOfflineAction(
  context: OfflineActionReplayContext,
): Promise<OfflineActionClaimResult> {
  const { actionId, propertyId, staffId, endpoint, requestId } = context;

  try {
    const { data: claimed, error: claimError } = await supabaseAdmin
      .from('offline_action_replays')
      .insert({
        action_id: actionId,
        property_id: propertyId,
        staff_id: staffId,
        endpoint,
        result_payload: {},
      })
      .select('action_id')
      .maybeSingle();

    if (!claimError && claimed) {
      return { ok: true, duplicate: false };
    }

    if (claimError?.code !== '23505') {
      log.error('housekeeper offline action claim failed', {
        requestId,
        actionId,
        endpoint,
        errorCode: claimError?.code,
        err: claimError ? errToString(claimError) : 'claim insert returned no row',
      });
      return { ok: false, reason: 'error' };
    }

    const { data: previous, error: lookupError } = await supabaseAdmin
      .from('offline_action_replays')
      .select('result_payload')
      .eq('action_id', actionId)
      .eq('property_id', propertyId)
      .eq('staff_id', staffId)
      .eq('endpoint', endpoint)
      .maybeSingle();

    const resultPayload = previous?.result_payload;
    if (
      lookupError ||
      !resultPayload ||
      typeof resultPayload !== 'object' ||
      Array.isArray(resultPayload)
    ) {
      log.error('housekeeper offline action replay lookup failed', {
        requestId,
        actionId,
        endpoint,
        errorCode: lookupError?.code,
        err: lookupError
          ? errToString(lookupError)
          : 'existing claim has no object result payload',
      });
      return { ok: false, reason: 'error' };
    }

    if (Object.keys(resultPayload).length === 0) {
      log.info('housekeeper offline action replay still pending', {
        requestId,
        actionId,
        endpoint,
      });
      return { ok: false, reason: 'pending' };
    }

    return {
      ok: true,
      duplicate: true,
      resultPayload: resultPayload as Record<string, unknown>,
    };
  } catch (caughtError) {
    log.error('housekeeper offline action claim threw', {
      requestId,
      actionId,
      endpoint,
      err: errToString(caughtError),
    });
    return { ok: false, reason: 'error' };
  }
}

/**
 * Releases a claim after the protected mutation fails, allowing a later
 * offline replay to retry. A returned PostgREST error is just as significant
 * as a thrown error, so both are logged and surfaced to the caller.
 */
export async function releaseOfflineActionClaim(
  context: OfflineActionReplayContext,
): Promise<boolean> {
  const { actionId, propertyId, staffId, endpoint, requestId } = context;

  try {
    const { data: released, error: releaseError } = await supabaseAdmin
      .from('offline_action_replays')
      .delete()
      .eq('action_id', actionId)
      .eq('property_id', propertyId)
      .eq('staff_id', staffId)
      .eq('endpoint', endpoint)
      .select('action_id')
      .maybeSingle();

    if (releaseError || !released) {
      log.error('housekeeper offline action claim release failed', {
        requestId,
        actionId,
        endpoint,
        errorCode: releaseError?.code,
        err: releaseError
          ? errToString(releaseError)
          : 'claim release matched no row',
      });
      return false;
    }

    return true;
  } catch (caughtError) {
    log.error('housekeeper offline action claim release threw', {
      requestId,
      actionId,
      endpoint,
      err: errToString(caughtError),
    });
    return false;
  }
}

/**
 * Persists the committed mutation's replay result. The update is idempotent,
 * so retry once for a transient PostgREST/network failure. If both attempts
 * fail, the claim remains in its pending state; callers must not delete it,
 * because the protected business mutation has already committed.
 */
export async function completeOfflineActionClaim(
  context: OfflineActionReplayContext,
  resultPayload: Record<string, unknown>,
): Promise<boolean> {
  const { actionId, propertyId, staffId, endpoint, requestId } = context;
  let lastError = 'completion update returned no row';

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const { data: completed, error: completionError } = await supabaseAdmin
        .from('offline_action_replays')
        .update({ result_payload: resultPayload })
        .eq('action_id', actionId)
        .eq('property_id', propertyId)
        .eq('staff_id', staffId)
        .eq('endpoint', endpoint)
        .select('action_id')
        .maybeSingle();

      if (!completionError && completed) {
        return true;
      }

      lastError = completionError
        ? errToString(completionError)
        : 'completion update returned no row';
    } catch (caughtError) {
      lastError = errToString(caughtError);
    }

    if (attempt === 1) {
      log.warn('housekeeper offline action completion retrying', {
        requestId,
        actionId,
        endpoint,
        err: lastError,
      });
    }
  }

  log.error('housekeeper offline action completion failed', {
    requestId,
    actionId,
    endpoint,
    err: lastError,
  });
  return false;
}
