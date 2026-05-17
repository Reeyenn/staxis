/**
 * POST /api/ml/override
 *
 * P10 — Override ingestion path
 *
 * When Maria sees the optimizer's recommended headcount and decides to
 * override it with her own number, this endpoint records the override
 * as a training signal for the ML model. The override is high-value:
 * it tells the model "the truth was different from what you predicted."
 *
 * Body:
 *   {
 *     propertyId: string (uuid)
 *     date: string (YYYY-MM-DD)
 *     optimizerRecommendation: number (the model's suggestion)
 *     manualHeadcount: number (what Maria decided)
 *     reason?: string (optional reason from Maria)
 *   }
 *
 * Returns:
 *   {
 *     ok: true
 *     data: {
 *       id: string (the new override row id)
 *       date: string
 *       optimizerRecommendation: number
 *       manualHeadcount: number
 *     }
 *   }
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import {
  validateUuid, validateString, validateDateStr, validateInt, LIMITS,
} from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { writeErrorLog } from '@/lib/error-log';

interface RequestBody {
  propertyId: string;
  date: string;
  optimizerRecommendation: number;
  manualHeadcount: number;
  reason?: string;
}

interface OverrideResponse {
  id: string;
  date: string;
  optimizerRecommendation: number;
  manualHeadcount: number;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  // Auth: only authenticated users can create overrides
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  try {
    const body = await req.json().catch(() => null) as RequestBody | null;
    if (!body || typeof body !== 'object') {
      return err('Invalid JSON body', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }

    // ── Strict validation ───────────────────────────────────────────────────
    const propIdV = validateUuid(body.propertyId, 'propertyId');
    if (propIdV.error) {
      return err(propIdV.error, {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }

    const dateV = validateDateStr(body.date, {
      allowFutureDays: 1,
      allowPastDays: 30,
      label: 'date',
    });
    if (dateV.error) {
      return err(dateV.error, {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }

    const optimizerRecV = validateInt(body.optimizerRecommendation, {
      min: 1,
      max: 50,
      label: 'optimizerRecommendation',
    });
    if (optimizerRecV.error) {
      return err(optimizerRecV.error, {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }

    const manualHeadcountV = validateInt(body.manualHeadcount, {
      min: 1,
      max: 50,
      label: 'manualHeadcount',
    });
    if (manualHeadcountV.error) {
      return err(manualHeadcountV.error, {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }

    let reason: string | null = null;
    if (body.reason !== undefined) {
      const reasonV = validateString(body.reason, {
        max: 500,
        label: 'reason',
      });
      if (reasonV.error) {
        return err(reasonV.error, {
          requestId,
          status: 400,
          code: ApiErrorCode.ValidationFailed,
        });
      }
      reason = reasonV.value || null;
    }

    const propertyId = propIdV.value!;
    const date = dateV.value!;
    const optimizerRecommendation = optimizerRecV.value!;
    const manualHeadcount = manualHeadcountV.value!;

    // ── Authorization ──────────────────────────────────────────────────────
    // User must have access to this property (same owner-based RLS check)
    if (!(await userHasPropertyAccess(session.userId, propertyId))) {
      return err('forbidden', {
        requestId,
        status: 403,
        code: ApiErrorCode.Forbidden,
      });
    }

    // ── Validation: optimizer recommendation must match active result ───────
    // We don't accept stale overrides. The UI must use the *current* active
    // recommendation. This prevents user confusion where they think they're
    // overriding today's model but they're actually overriding yesterday's.
    const { data: optimizerResult } = await supabaseAdmin
      .from('optimizer_results')
      .select('id, recommended_headcount')
      .eq('property_id', propertyId)
      .eq('date', date)
      .maybeSingle();

    if (optimizerResult) {
      const activeRecommendation = optimizerResult.recommended_headcount as number;
      if (optimizerRecommendation !== activeRecommendation) {
        return err('Optimizer recommendation mismatch — override must match active result', {
          requestId,
          status: 400,
          code: ApiErrorCode.ValidationFailed,
          details: {
            expected: activeRecommendation,
            received: optimizerRecommendation,
          },
        });
      }
    }
    // If no optimizer result exists, we still allow the override (model might
    // not have run yet, or might be in shadow mode). Maria can still override
    // the *intended* recommendation even if the system hasn't officially
    // produced one yet.

    // ── Insert the override ────────────────────────────────────────────────
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('prediction_overrides')
      .insert({
        property_id: propertyId,
        date,
        optimizer_recommendation: optimizerRecommendation,
        manual_headcount: manualHeadcount,
        override_reason: reason,
        override_by: session.userId,
        optimizer_results_id: optimizerResult?.id ?? null,
        override_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (insertErr) throw insertErr;
    if (!inserted) throw new Error('Insert returned no row');

    const response: OverrideResponse = {
      id: inserted.id as string,
      date,
      optimizerRecommendation,
      manualHeadcount,
    };

    return ok(response, { requestId, status: 201 });
  } catch (caughtErr) {
    log.error('/api/ml/override error', { err: caughtErr, requestId });
    await writeErrorLog({
      source: '/api/ml/override',
      message: errToString(caughtErr),
      stack: caughtErr instanceof Error ? caughtErr.stack ?? null : null,
    });
    return err('Internal server error', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
