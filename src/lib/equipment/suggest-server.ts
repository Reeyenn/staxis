// ─── The rows behind the equipment suggestion ────────────────────────────────
//
// The I/O half of ./suggest.ts, split the same way src/lib/findings/brief.ts is
// split from brief-server.ts: everything that DECIDES lives in the pure module
// and can be asserted directly, and this file only fetches.
//
// TENANCY. Both reads go through `scopedDb(propertyId)`, which pre-applies the
// hotel filter before handing back a builder — there is no unfiltered query in
// here to forget it on. `work_orders` and `equipment` are both reached through
// service-role, and the gate that decides which propertyId is legitimate is
// loadManagerCaller + managerManagesHotel in /api/memory/question.
//
// FAILURE IS SILENCE, NOT AN ERROR. A suggestion is a nicety on a screen a
// manager opened to do something else. Every failure path returns an empty list,
// exactly as findingAskCandidates does, so a broken read costs a question rather
// than the page it lives on.

import 'server-only';

import { scopedDb } from '@/lib/agent/scoped-db';
import { isSectionEnabled, type EnabledSections } from '@/lib/sections/registry';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import type { QuestionCandidate } from '@/lib/agent/drip-questions';

import {
  SUGGESTION_WINDOW_DAYS,
  equipmentSuggestionCandidates,
  type SuggestionSourceText,
} from './suggest';

/** Ceiling so one strange hotel cannot pull an unbounded result set. */
const MAX_ROWS = 5_000;

const MS_PER_DAY = 86_400_000;

/**
 * The terms this hotel keeps writing that it has no equipment entry for.
 *
 * SECTION-GATED. The equipment registry lives in Maintenance; a hotel that
 * turned that section off has said it does not use this part of Staxis, and
 * offering to create a row in a list it cannot see would be a question with
 * nowhere to land.
 */
export async function equipmentSuggestionQuestions(
  propertyId: string,
  now: Date = new Date(),
): Promise<QuestionCandidate[]> {
  try {
    const { data: property } = await supabaseAdmin
      .from('properties')
      .select('enabled_sections')
      .eq('id', propertyId)
      .maybeSingle();
    const enabledSections = (property?.enabled_sections as EnabledSections) ?? null;
    if (!isSectionEnabled(enabledSections, 'maintenance')) return [];

    const db = scopedDb(propertyId);
    const sinceIso = new Date(now.getTime() - SUGGESTION_WINDOW_DAYS * MS_PER_DAY).toISOString();

    const [ordersResult, equipmentResult] = await Promise.all([
      db
        .from('work_orders')
        .select('id, description, notes')
        .gte('created_at', sinceIso)
        .limit(MAX_ROWS),
      db.from('equipment').select('name').limit(MAX_ROWS),
    ]);

    if (ordersResult.error || equipmentResult.error) {
      log.warn('[equipment] suggestion read failed; no equipment questions this time', {
        propertyId,
        err: ordersResult.error?.message ?? equipmentResult.error?.message,
      });
      return [];
    }

    const sources: SuggestionSourceText[] = [];
    for (const row of (ordersResult.data ?? []) as Array<Record<string, unknown>>) {
      const id = typeof row.id === 'string' ? row.id : null;
      if (!id) continue;
      // Description AND notes: staff type the equipment word into whichever of
      // the two the form put in front of them, and a counter that read only one
      // would under-count exactly the hotels that use the other.
      const text = [row.description, row.notes]
        .filter((value): value is string => typeof value === 'string')
        .join(' ');
      if (!text.trim()) continue;
      sources.push({ id, text });
    }

    const equipmentNames = ((equipmentResult.data ?? []) as Array<Record<string, unknown>>)
      .map((row) => (typeof row.name === 'string' ? row.name : ''))
      .filter((name) => name.length > 0);

    return equipmentSuggestionCandidates({ sources, equipmentNames });
  } catch (e) {
    log.warn('[equipment] suggestion read threw; no equipment questions this time', {
      propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}
