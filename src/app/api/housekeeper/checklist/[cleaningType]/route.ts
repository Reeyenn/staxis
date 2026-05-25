/**
 * GET /api/housekeeper/checklist/[cleaningType]?pid=...&staffId=...
 *
 * Returns the active checklist template for a cleaning type, with all
 * items grouped by area. Property-specific override wins over the
 * global default.
 *
 * No mutation — read-only. Same capability check as the rest of the
 * housekeeper surface so a leaked pid/staffId can't enumerate
 * non-housekeeping properties.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { getOrMintRequestId } from '@/lib/log';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const ALLOWED_CLEANING_TYPES = new Set([
  'departure',
  'stayover',
  'deep',
  'refresh',
  'inspection',
]);

interface ChecklistItem {
  id: string;
  area: string;
  itemEn: string;
  itemEs: string;
  sortOrder: number;
  isCritical: boolean;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ cleaningType: string }> },
): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };

  const { cleaningType } = await context.params;
  if (!ALLOWED_CLEANING_TYPES.has(cleaningType)) {
    return err('invalid cleaning type', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers,
    });
  }

  const { searchParams } = new URL(req.url);
  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers,
    });
  }
  const staffV = validateUuid(searchParams.get('staffId'), 'staffId');
  if (staffV.error) {
    return err(staffV.error, {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers,
    });
  }
  const pid = pidV.value!;
  const staffId = staffV.value!;

  const rl = await checkAndIncrementRateLimit(
    'housekeeper-checklist-read',
    hashToRateLimitKey(`${pid}:${staffId}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  // Capability check: staff on property.
  const { data: staff } = await supabaseAdmin
    .from('staff')
    .select('id, property_id')
    .eq('id', staffId)
    .maybeSingle();
  if (!staff || staff.property_id !== pid) {
    return err('Not found', {
      requestId,
      status: 404,
      code: ApiErrorCode.NotFound,
      headers,
    });
  }

  try {
    // Prefer property-specific template, fall back to default.
    const { data: templates, error: tplErr } = await supabaseAdmin
      .from('cleaning_checklist_templates')
      .select('id, property_id, cleaning_type, name_en, name_es, is_default, is_active')
      .or(`property_id.eq.${pid},and(property_id.is.null,is_default.eq.true)`)
      .eq('cleaning_type', cleaningType)
      .eq('is_active', true);
    if (tplErr) {
      log.error('checklist: template lookup failed', {
        requestId,
        err: errToString(tplErr),
      });
      return err('Internal server error', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
        headers,
      });
    }

    // Pick the property-specific one if present, else the default.
    type TemplateRow = {
      id: string;
      property_id: string | null;
      cleaning_type: string;
      name_en: string;
      name_es: string;
      is_default: boolean;
      is_active: boolean;
    };
    const list = (templates ?? []) as TemplateRow[];
    const propertyTemplate = list.find((t) => t.property_id === pid);
    const defaultTemplate = list.find((t) => t.property_id === null && t.is_default);
    const template = propertyTemplate ?? defaultTemplate;
    if (!template) {
      return ok(
        { template: null, items: [] as ChecklistItem[] },
        { requestId, headers },
      );
    }

    const { data: itemRows, error: itemErr } = await supabaseAdmin
      .from('cleaning_checklist_items')
      .select('id, area, item_en, item_es, sort_order, is_critical')
      .eq('template_id', template.id)
      .order('sort_order', { ascending: true });
    if (itemErr) {
      log.error('checklist: items lookup failed', {
        requestId,
        err: errToString(itemErr),
      });
      return err('Internal server error', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
        headers,
      });
    }

    type ItemRow = {
      id: string;
      area: string;
      item_en: string;
      item_es: string;
      sort_order: number;
      is_critical: boolean;
    };
    const items: ChecklistItem[] = (itemRows ?? []).map((r: ItemRow) => ({
      id: r.id,
      area: r.area,
      itemEn: r.item_en,
      itemEs: r.item_es,
      sortOrder: r.sort_order,
      isCritical: r.is_critical,
    }));

    return ok(
      {
        template: {
          id: template.id,
          cleaningType: template.cleaning_type,
          nameEn: template.name_en,
          nameEs: template.name_es,
          isPropertyOverride: template.property_id === pid,
        },
        items,
      },
      { requestId, headers },
    );
  } catch (caughtErr) {
    log.error('checklist: unexpected error', {
      requestId,
      err: errToString(caughtErr),
    });
    return err('Internal server error', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers,
    });
  }
}
