/**
 * GET /api/inventory/ai-status?propertyId=<uuid>
 *
 * Live status JSON for the AI Helper page (`/inventory/ai-helper`). Returns:
 *   - aiMode                     — 'off' | 'auto' | 'always-on'
 *   - daysSinceFirstCount
 *   - itemsTotal / itemsWithModel / itemsGraduated / itemsExpectedToGraduate
 *   - currentMaeRatio            — average of validation_mae/training_mae across active models
 *   - lastInferenceAt
 *
 * Auth: requireSession + userHasPropertyAccess. The page is reachable by any
 * authenticated user with property access (not just owner).
 *
 * The page renders these numbers in plain English for the GM:
 *   "Day 12. The AI has learned 23 of your 87 items well. 4 items are
 *    confident enough to auto-fill. We expect another 12 to graduate in
 *    the next 2 weeks."
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const propertyId = new URL(req.url).searchParams.get('propertyId');
  if (!isUuid(propertyId)) {
    return NextResponse.json({ ok: false, error: 'invalid_property_id' }, { status: 400 });
  }
  if (!(await userHasPropertyAccess(session.userId, propertyId))) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  try {
    // Use the service-role client so the multi-table aggregate doesn't fight
    // RLS. The auth check above guarantees the caller is authorized.
    const [propRes, countRes, itemsRes, runsRes, predRes] = await Promise.all([
      supabaseAdmin
        .from('properties')
        .select('inventory_ai_mode')
        .eq('id', propertyId)
        .maybeSingle(),
      supabaseAdmin
        .from('inventory_counts')
        .select('counted_at')
        .eq('property_id', propertyId)
        .order('counted_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from('inventory')
        .select('id', { count: 'exact', head: true })
        .eq('property_id', propertyId),
      supabaseAdmin
        .from('model_runs')
        .select('item_id,validation_mae,training_mae,auto_fill_enabled,training_row_count,consecutive_passing_runs')
        .eq('property_id', propertyId)
        .eq('layer', 'inventory_rate')
        .eq('is_active', true)
        .limit(2000),
      supabaseAdmin
        .from('inventory_rate_predictions')
        .select('predicted_at')
        .eq('property_id', propertyId)
        .order('predicted_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const aiMode = ((propRes.data?.inventory_ai_mode ?? 'auto') as string) as 'off' | 'auto' | 'always-on';
    const firstCountAt = countRes.data?.counted_at ? new Date(countRes.data.counted_at).getTime() : null;
    const daysSinceFirstCount = firstCountAt
      ? Math.max(0, Math.floor((Date.now() - firstCountAt) / 86400000))
      : 0;
    const itemsTotal = itemsRes.count ?? 0;
    const runs = runsRes.data ?? [];
    const itemsWithModel = runs.length;
    const itemsGraduated = runs.filter((r) => r.auto_fill_enabled).length;
    const itemsExpectedToGraduate = runs.filter((r) => {
      if (r.auto_fill_enabled) return false;
      const passes = Number(r.consecutive_passing_runs ?? 0);
      const enough = Number(r.training_row_count ?? 0) >= 30;
      return passes >= 3 || enough;
    }).length;

    let currentMaeRatio: number | null = null;
    const ratios: number[] = [];
    for (const r of runs) {
      const mae = r.validation_mae;
      const trainMae = r.training_mae;
      if (mae !== null && mae !== undefined && trainMae !== null && trainMae !== undefined && Number(trainMae) > 0) {
        ratios.push(Number(mae) / Number(trainMae));
      }
    }
    if (ratios.length > 0) {
      currentMaeRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    }

    return NextResponse.json({
      ok: true,
      requestId,
      data: {
        aiMode,
        daysSinceFirstCount,
        itemsTotal,
        itemsWithModel,
        itemsGraduated,
        itemsExpectedToGraduate,
        currentMaeRatio,
        lastInferenceAt: predRes.data?.predicted_at ?? null,
      },
    });
  } catch (e) {
    log.error('inventory/ai-status: failed', { requestId, err: e as Error });
    return NextResponse.json({ ok: false, error: 'internal_error', requestId }, { status: 500 });
  }
}
