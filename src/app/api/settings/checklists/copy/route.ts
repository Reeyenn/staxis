/**
 * POST /api/settings/checklists/copy
 *
 * Body: { sourceType: 'cleaning' | 'inspection', key, sourcePropertyId?, targetPropertyIds[] }
 *   - cleaning:   key = cleaning_type; sourcePropertyId = the property whose
 *                 effective checklist is copied.
 *   - inspection: key = the source checklist id (a global default or a
 *                 per-property checklist the caller can access).
 *
 * Copies the source checklist (with all items) onto each target property,
 * creating/overwriting that target's per-property override. Idempotent.
 *
 * Auth: manager/owner/admin. The caller must have access to the SOURCE AND to
 * EVERY target property — verified before any write. A single unauthorized
 * target rejects the whole request (no partial / cross-tenant writes).
 */

import type { NextRequest } from 'next/server';
import { err, ok } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateEnum, validateUuid } from '@/lib/api-validate';
import { callerCan, verifyTeamManager } from '@/lib/team-auth';
import { partitionTargets } from '@/lib/checklists/access';
import {
  CLEANING_TYPES,
  copyCleaningToProperties,
  copyInspectionToProperties,
  loadInspectionSource,
  type CleaningType,
} from '@/lib/db/checklists';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_TARGETS = 50;
const SOURCE_TYPES = ['cleaning', 'inspection'] as const;

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  try {
    const caller = await verifyTeamManager(req, { capability: 'manage_checklists' });
    if (!caller) {
      return err('Checklists are restricted to managers, owners, and admins.', {
        requestId, status: 403, code: 'forbidden',
      });
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const typeV = validateEnum(body.sourceType, SOURCE_TYPES, 'sourceType');
    if (typeV.error) return err(typeV.error, { requestId, status: 400, code: 'validation_failed' });
    const sourceType = typeV.value!;

    // Targets: 1..MAX_TARGETS valid UUIDs.
    if (!Array.isArray(body.targetPropertyIds) || body.targetPropertyIds.length === 0) {
      return err('Select at least one property to copy to.', { requestId, status: 400, code: 'validation_failed' });
    }
    if (body.targetPropertyIds.length > MAX_TARGETS) {
      return err(`Too many target properties (max ${MAX_TARGETS}).`, { requestId, status: 400, code: 'validation_failed' });
    }
    const rawTargets: string[] = [];
    for (let i = 0; i < body.targetPropertyIds.length; i++) {
      const v = validateUuid(body.targetPropertyIds[i], `targetPropertyIds[${i}]`);
      if (v.error) return err(v.error, { requestId, status: 400, code: 'validation_failed' });
      rawTargets.push(v.value!);
    }

    // Authorization isolation: split targets into ones the caller can manage
    // and ones they can't. A single unauthorized target rejects the request —
    // no cross-tenant writes, no partial application.
    const { authorized, denied } = partitionTargets(caller, rawTargets);
    if (denied.length > 0) {
      return err('You do not have access to one or more of the selected properties.', {
        requestId, status: 403, code: 'property_access_denied',
      });
    }
    if (authorized.length === 0) {
      return err('Select at least one property to copy to.', { requestId, status: 400, code: 'validation_failed' });
    }

    if (sourceType === 'cleaning') {
      const keyV = validateEnum(body.key, CLEANING_TYPES, 'key');
      if (keyV.error) return err(keyV.error, { requestId, status: 400, code: 'validation_failed' });
      const srcV = validateUuid(body.sourcePropertyId, 'sourcePropertyId');
      if (srcV.error) return err(srcV.error, { requestId, status: 400, code: 'validation_failed' });
      if (!(await callerCan(caller, 'manage_checklists', srcV.value!))) {
        return err('You do not have access to the source property.', {
          requestId, status: 403, code: 'property_access_denied',
        });
      }
      const outcomes = await copyCleaningToProperties(srcV.value!, keyV.value as CleaningType, authorized);
      return ok({ outcomes, copied: outcomes.filter((o) => o.ok).length }, { requestId });
    }

    // inspection — key is the source checklist id.
    const keyV = validateUuid(body.key, 'key');
    if (keyV.error) return err(keyV.error, { requestId, status: 400, code: 'validation_failed' });

    // Verify access to the SOURCE checklist's property (global defaults are
    // copyable by any manager; per-property sources need property access).
    const source = await loadInspectionSource(keyV.value!);
    if (!source) {
      return err('Source checklist not found.', { requestId, status: 404, code: 'not_found' });
    }
    if (source.propertyId !== null && !(await callerCan(caller, 'manage_checklists', source.propertyId))) {
      return err('You do not have access to the source checklist.', {
        requestId, status: 403, code: 'property_access_denied',
      });
    }

    const result = await copyInspectionToProperties(keyV.value!, authorized);
    if (!result) {
      return err('Source checklist not found.', { requestId, status: 404, code: 'not_found' });
    }
    return ok(
      { outcomes: result.outcomes, copied: result.outcomes.filter((o) => o.ok).length },
      { requestId },
    );
  } catch (e) {
    log.error('checklists copy failed', { requestId, error: e instanceof Error ? e.message : String(e) });
    return err('Failed to copy checklist.', { requestId, status: 500, code: 'internal_error' });
  }
}
