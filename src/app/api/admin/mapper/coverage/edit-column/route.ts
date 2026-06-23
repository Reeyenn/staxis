/**
 * POST /api/admin/mapper/coverage/edit-column
 *   body: { propertyId, pmsFamily?, feedKey, op: 'delete' | 'add-custom',
 *           columnName?, columnKey?, headerIndex?, draftId? }
 *
 * feature/cua-column-editor — per-COLUMN edits within ONE feed, on the Coverage
 * Editor ("View what the robot captures"):
 *   - op 'delete'      — stop capturing a column (a known/typed column or a
 *                        founder-added custom one). Refuses the feed's core
 *                        contract columns (identity + page-context dates) and
 *                        refuses emptying the feed.
 *   - op 'add-custom'  — capture an EXTRA page column the warehouse has no slot
 *                        for. The founder picks a detected page header
 *                        (headerIndex) and names it (columnKey); the value lands
 *                        in the table's `raw` jsonb bucket. The selector is
 *                        authored here from the header's cell index.
 *
 * TWO write paths, mirroring delete-feed / draft-delete-feed:
 *   - LIVE (active) map  → a recipe change must be re-signed (RECIPE_SIGNING_KEY
 *     is Fly-only), so this enqueues a non-browser `mapper.edit_recipe` worker
 *     job (edit_op delete_column / add_custom_column). The UI polls
 *     GET /api/admin/mapper/live/[jobId].
 *   - PARKED DRAFT (draftId) → drafts are unsigned (verified only at promote
 *     time), so it's a plain in-place jsonb edit — no worker, instant.
 *
 * Guards here are fast-fail UX; the worker re-validates authoritatively against
 * the live active map (cua-service/src/recipe-edit.ts).
 *
 * Auth: requireAdmin. supabaseAdmin (pms_knowledge_files is deny-all-browser).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import {
  DRILLDOWN_ACTION_KEYS,
  UNDELETABLE_COLUMNS_BY_FEED,
  columnsFromAction,
  customColumnsFromAction,
  detectedColumnsFromAction,
  authorSelectorForIndex,
  customColumnKeyConflict,
} from '@/lib/pms/recipe-coverage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;
const FEED_KEY = /^[A-Za-z0-9_.-]{1,80}$/;
const CUSTOM_KEY = /^[a-z][a-z0-9_]{0,48}$/;

interface KnowledgeRow {
  id: string;
  version: number;
  status: string;
  pms_family: string;
  knowledge: { actions?: Record<string, unknown> };
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return err('Unauthorized', { requestId, status: 401, code: 'unauthorized' });

  let body: {
    propertyId?: unknown; pmsFamily?: unknown; feedKey?: unknown; op?: unknown;
    columnName?: unknown; columnKey?: unknown; headerIndex?: unknown; draftId?: unknown;
  };
  try { body = await req.json(); } catch {
    return err('Invalid JSON', { requestId, status: 400, code: 'bad_request' });
  }
  if (typeof body.propertyId !== 'string' || !UUID.test(body.propertyId)) {
    return err('propertyId must be a uuid', { requestId, status: 400, code: 'bad_request' });
  }
  if (typeof body.feedKey !== 'string' || !FEED_KEY.test(body.feedKey)) {
    return err('feedKey is required', { requestId, status: 400, code: 'bad_request' });
  }
  const op = body.op === 'delete' ? 'delete' : body.op === 'add-custom' ? 'add-custom' : null;
  if (!op) return err("op must be 'delete' or 'add-custom'", { requestId, status: 400, code: 'bad_request' });
  const feedKey = body.feedKey;
  const hasDraftId = typeof body.draftId === 'string' && UUID.test(body.draftId);
  if (body.draftId !== undefined && !hasDraftId) {
    return err('draftId must be a uuid', { requestId, status: 400, code: 'bad_request' });
  }

  // Drill-down feeds collapse to a list page and have no per-column editing.
  if (DRILLDOWN_ACTION_KEYS.has(feedKey)) {
    return err(`"${feedKey}" is a drill-down feed and can't have its columns edited.`, {
      requestId, status: 400, code: 'bad_request',
    });
  }

  // SECURITY (mirror edit-feed): derive pms_family from THIS property's session —
  // never trust the client's pmsFamily (a mismatch could edit the wrong family).
  const { data: sessionRow, error: sessErr } = await supabaseAdmin
    .from('property_sessions')
    .select('pms_family')
    .eq('property_id', body.propertyId)
    .maybeSingle();
  if (sessErr) return err(`could not load session: ${sessErr.message}`, { requestId, status: 500, code: 'db_error' });
  if (!sessionRow) return err('This property has no CUA session.', { requestId, status: 404, code: 'not_found' });
  const pmsFamily = sessionRow.pms_family as string;
  if (typeof body.pmsFamily === 'string' && body.pmsFamily && body.pmsFamily !== pmsFamily) {
    return err('This map changed since you opened it — refresh and try again.', { requestId, status: 409, code: 'conflict' });
  }

  // Resolve the recipe source: a parked DRAFT (draftId) or the family's ACTIVE map.
  let sourceRow: KnowledgeRow | null = null;
  if (hasDraftId) {
    const { data, error: e } = await supabaseAdmin
      .from('pms_knowledge_files')
      .select('id, version, status, pms_family, knowledge')
      .eq('id', body.draftId as string)
      .is('deleted_at', null)
      .maybeSingle<KnowledgeRow>();
    if (e) return err(`draft lookup failed: ${e.message}`, { requestId, status: 500, code: 'db_error' });
    if (!data) return err('The map no longer exists.', { requestId, status: 404, code: 'not_found' });
    if (data.pms_family !== pmsFamily) {
      return err('This map changed since you opened it — refresh and try again.', { requestId, status: 409, code: 'conflict' });
    }
    if (data.status === 'active') {
      return err('This map is already live — edit it from the live map instead.', { requestId, status: 409, code: 'conflict' });
    }
    sourceRow = data;
  } else {
    const { data, error: e } = await supabaseAdmin
      .from('pms_knowledge_files')
      .select('id, version, status, pms_family, knowledge')
      .eq('pms_family', pmsFamily)
      .eq('status', 'active')
      .is('deleted_at', null)
      .maybeSingle<KnowledgeRow>();
    if (e) return err(`could not load active map: ${e.message}`, { requestId, status: 500, code: 'db_error' });
    if (!data) return err(`no active map for ${pmsFamily} — there's nothing to edit yet.`, { requestId, status: 404, code: 'not_found' });
    sourceRow = data;
  }

  const actions = (sourceRow.knowledge?.actions ?? {}) as Record<string, unknown>;
  if (!(feedKey in actions)) {
    return err(`"${feedKey}" isn't a feed in this map.`, { requestId, status: 409, code: 'conflict' });
  }
  const action = actions[feedKey];
  const knownColumns = columnsFromAction(action);
  const customColumns = customColumnsFromAction(action);

  // ── op: delete ──────────────────────────────────────────────────────────
  if (op === 'delete') {
    const columnName = typeof body.columnName === 'string' ? body.columnName : '';
    if (!columnName) return err('columnName is required', { requestId, status: 400, code: 'bad_request' });

    const isKnown = columnName in knownColumns;
    const isCustom = columnName in customColumns;
    if (!isKnown && !isCustom) {
      return err(`"${columnName}" isn't a column on this feed.`, { requestId, status: 409, code: 'conflict' });
    }
    // A custom column is never a contract column. A known column gets the guard.
    if (isKnown && (UNDELETABLE_COLUMNS_BY_FEED[feedKey]?.has(columnName) ?? false)) {
      return err(`"${columnName}" is a core column this feed depends on and can't be removed.`, {
        requestId, status: 409, code: 'conflict',
      });
    }
    if (Object.keys(knownColumns).length + Object.keys(customColumns).length <= 1) {
      return err('This is the only column left — remove the whole feed instead.', {
        requestId, status: 409, code: 'conflict',
      });
    }

    // Parked draft → in-place jsonb edit (unsigned). Live → re-signing worker job.
    if (hasDraftId) {
      const next = mutateDeleteColumn(sourceRow.knowledge, feedKey, columnName);
      // Defense-in-depth: re-validate the mutated feed still has ≥1 column (the
      // worker enforces the same post-mutation invariant).
      const after = (next.actions as Record<string, unknown> | undefined)?.[feedKey];
      if (Object.keys(columnsFromAction(after)).length + Object.keys(customColumnsFromAction(after)).length === 0) {
        return err('This is the only column left — remove the whole feed instead.', { requestId, status: 409, code: 'conflict' });
      }
      return persistDraft(sourceRow.id, next, { removed: true, feedKey, columnName }, requestId);
    }
    return enqueue(body.propertyId, admin.accountId, pmsFamily, sourceRow.version, {
      edit_op: 'delete_column', feed_key: feedKey, column_name: columnName,
    }, `column_delete:${pmsFamily}:${feedKey}:${columnName}`, 'Removing the column and re-publishing the map…', requestId);
  }

  // ── op: add-custom ──────────────────────────────────────────────────────
  const columnKey = (typeof body.columnKey === 'string' ? body.columnKey : '').trim().toLowerCase();
  if (!CUSTOM_KEY.test(columnKey)) {
    return err('Give the column a short name using letters, numbers and underscores (e.g. rate_plan).', {
      requestId, status: 400, code: 'bad_request',
    });
  }
  if (typeof body.headerIndex !== 'number' || !Number.isInteger(body.headerIndex) || body.headerIndex < 1) {
    return err('Pick a column from the page to capture.', { requestId, status: 400, code: 'bad_request' });
  }
  const headerIndex = body.headerIndex;
  if (columnKey in knownColumns) {
    return err(`"${columnKey}" is already a captured column on this feed.`, { requestId, status: 409, code: 'conflict' });
  }
  if (columnKey in customColumns) {
    return err(`"${columnKey}" is already a custom column on this feed.`, { requestId, status: 409, code: 'conflict' });
  }
  // A custom column must NOT reuse a typed contract column name (it's captured
  // automatically) or a reserved/system name (the worker re-checks this too).
  const conflict = customColumnKeyConflict(feedKey, columnKey);
  if (conflict) return err(conflict, { requestId, status: 409, code: 'conflict' });
  // The chosen header must be one the robot actually saw on the page.
  const detected = detectedColumnsFromAction(action);
  if (detected.length === 0) {
    return err('The robot hasn’t listed this page’s columns yet — re-map this feed once, then add a column.', {
      requestId, status: 409, code: 'no_detected_columns',
    });
  }
  if (!detected.some((d) => d.index === headerIndex)) {
    return err('That column is no longer on the page — refresh and try again.', { requestId, status: 409, code: 'conflict' });
  }
  // Author the positional selector by templating off ANY existing clean
  // positional column (known OR custom — custom ones are authored this way too).
  const selector = authorSelectorForIndex({ ...knownColumns, ...customColumns }, headerIndex);
  if (!selector) {
    return err('Could not work out where that column is on the page.', { requestId, status: 409, code: 'conflict' });
  }

  if (hasDraftId) {
    const next = mutateAddCustomColumn(sourceRow.knowledge, feedKey, columnKey, selector);
    if (!next) return err('This feed isn’t a page table, so a custom column can’t be added.', { requestId, status: 409, code: 'conflict' });
    return persistDraft(sourceRow.id, next, { added: true, feedKey, columnKey }, requestId);
  }
  return enqueue(body.propertyId, admin.accountId, pmsFamily, sourceRow.version, {
    edit_op: 'add_custom_column', feed_key: feedKey, column_key: columnKey, selector,
  }, `column_add:${pmsFamily}:${feedKey}:${columnKey}`, 'Adding the column and re-publishing the map…', requestId);
}

/** Enqueue a re-signing worker job for a LIVE map edit. */
async function enqueue(
  propertyId: string,
  accountId: string,
  pmsFamily: string,
  fromVersion: number,
  payloadExtra: Record<string, unknown>,
  keyPrefix: string,
  note: string,
  requestId: string,
): Promise<Response> {
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('workflow_jobs')
    .insert({
      property_id: propertyId,
      kind: 'mapper.edit_recipe',
      idempotency_key: `mapper.${keyPrefix}:${Date.now()}`,
      max_attempts: 1,
      triggered_by: `admin:${accountId}:coverage-column`,
      payload: { pms_family: pmsFamily, property_id: propertyId, edited_from_version: fromVersion, ...payloadExtra },
    })
    .select('id')
    .single<{ id: string }>();
  if (insErr || !inserted) {
    return err(`could not start the edit: ${insErr?.message ?? 'unknown'}`, { requestId, status: 500, code: 'db_error' });
  }
  return ok({ jobId: inserted.id, fromVersion, note }, { requestId });
}

/** Plain jsonb UPDATE on a DRAFT (unsigned; scoped to non-active so a concurrent
 *  promote can't be overwritten). Mirrors draft/delete-feed. */
async function persistDraft(
  draftId: string,
  nextKnowledge: Record<string, unknown>,
  okData: Record<string, unknown>,
  requestId: string,
): Promise<Response> {
  const { data: updated, error: upErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .update({ knowledge: nextKnowledge })
    .eq('id', draftId)
    .neq('status', 'active')
    .select('id')
    .maybeSingle();
  if (upErr) return err(`could not save the draft: ${upErr.message}`, { requestId, status: 500, code: 'db_error' });
  if (!updated) {
    return err('This map just went live — edit it from the live map instead.', { requestId, status: 409, code: 'conflict' });
  }
  return ok(okData, { requestId });
}

/** Deep-clone the knowledge envelope (plain jsonb — no functions/dates). */
function cloneKnowledge(knowledge: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(knowledge ?? {})) as Record<string, unknown>;
}

/** Draft mutation: drop a column (known or custom) from one feed's parse hint. */
function mutateDeleteColumn(knowledge: unknown, feedKey: string, columnName: string): Record<string, unknown> {
  const next = cloneKnowledge(knowledge);
  const actions = (next.actions ?? {}) as Record<string, unknown>;
  const action = (actions[feedKey] ?? {}) as Record<string, unknown>;
  const parse = (action.parse ?? {}) as Record<string, unknown>;
  const hint = (parse.hint ?? {}) as Record<string, unknown>;
  const columns = (hint.columns ?? {}) as Record<string, unknown>;
  const custom = (hint.customColumns ?? {}) as Record<string, unknown>;
  const tiered = (hint.columnsTiered ?? {}) as Record<string, unknown>;
  const inlineFields = (parse.fields ?? {}) as Record<string, unknown>;

  if (columnName in columns) { delete columns[columnName]; delete tiered[columnName]; }
  if (columnName in custom) delete custom[columnName];
  if (columnName in inlineFields) delete inlineFields[columnName];

  if ('columns' in hint) hint.columns = columns;
  if (Object.keys(custom).length > 0) hint.customColumns = custom; else delete hint.customColumns;
  if (Object.keys(tiered).length > 0) hint.columnsTiered = tiered; else delete hint.columnsTiered;
  if ('hint' in parse) parse.hint = hint;
  if ('fields' in parse) parse.fields = inlineFields;
  action.parse = parse;
  actions[feedKey] = action;
  next.actions = actions;
  return next;
}

/** Draft mutation: add a custom column to one TABLE feed's parse hint. Returns
 *  null when the feed isn't a page table (custom columns are DOM cells). */
function mutateAddCustomColumn(
  knowledge: unknown, feedKey: string, columnKey: string, selector: string,
): Record<string, unknown> | null {
  const next = cloneKnowledge(knowledge);
  const actions = (next.actions ?? {}) as Record<string, unknown>;
  const action = (actions[feedKey] ?? {}) as Record<string, unknown>;
  const parse = (action.parse ?? {}) as Record<string, unknown>;
  if (parse.mode !== 'table') return null;
  const hint = (parse.hint ?? {}) as Record<string, unknown>;
  const custom = (hint.customColumns ?? {}) as Record<string, unknown>;
  custom[columnKey] = selector;
  hint.customColumns = custom;
  parse.hint = hint;
  action.parse = parse;
  actions[feedKey] = action;
  next.actions = actions;
  return next;
}
