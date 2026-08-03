/**
 * /api/inventory/import — bring an inventory or occupancy file in, one batch
 * at a time, and take one back out.
 *
 * ONE ROUTE, FOUR ACTIONS, because they are one resource: this hotel's import
 * batches. Splitting them would mean four files repeating the same five gates.
 *
 *   GET  ?pid=…                     the batch list, for the undo row
 *   POST { pid, action: 'read'   }  read a file into a DRAFT. Writes NOTHING.
 *   POST { pid, action: 'commit' }  apply an approved draft as one batch
 *   POST { pid, action: 'undo'   }  remove a batch, and what it taught
 *
 * NOTHING IS EVER SAVED BY `read`. That is the point of the two-step: the
 * expensive, fallible, model-shaped half produces a list a person looks at, and
 * the half that writes takes only what the person approved. A `read` that
 * auto-committed would be a robot filling in a hotel's shelves from a photo.
 *
 * Authorization mirrors /api/inventory/scan-invoice exactly: an import carries
 * prices, spends provider money, and rewrites the item list, so it takes the
 * finance gate, the inventory-ordering capability, and an enabled Inventory
 * section. The `undo` action additionally refuses outside its window.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { captureException } from '@/lib/sentry';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { isUuid, validateString } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { requireFinanceAccess } from '@/lib/financials/api-gate';
import { capabilityDecisionForProperty } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { requireSectionEnabled } from '@/lib/sections/server';
import { assertAudioBudget, recordNonRequestCost } from '@/lib/agent/cost-controls';
import { AiFeatureDisabledError } from '@/lib/ai/runtime';
import {
  VisionImageInvalidError,
  VisionSchemaError,
  VisionTruncatedError,
  type VisionUsageReport,
} from '@/lib/vision-extract';
import { readImportWithModel } from '@/lib/inventory-import/read-model';
import { propertyLocalDate } from '@/lib/rules-engine/time-utils';

import {
  ImportSourceError,
  pastedTextSource,
  readImportSource,
  IMPORT_MAX_DECODED_BYTES,
  type ImportSource,
} from '@/lib/inventory-import/source-text';
import {
  inventoryImportPrompt,
  normalizeReaderSkipReason,
  validateInventorySheet,
  validateOccupancySheet,
  OCCUPANCY_IMPORT_PROMPT,
  type ExtractedInventorySheet,
  type ExtractedOccupancySheet,
} from '@/lib/inventory-import/extract';
import {
  buildImportDraft,
  buildSkippedSentence,
  pickAsOfDate,
  type BuiltInCategory,
  type ExistingItem,
  type RawImportRow,
} from '@/lib/inventory-import/draft';
import {
  buildImportCommitPlan,
  ImportCommitError,
  type ConfirmedLine,
} from '@/lib/inventory-import/commit';
import { normalizeOccupancyMonths, monthRangeLabel } from '@/lib/inventory-import/occupancy';
import { decideImportUndo } from '@/lib/inventory-import/undo';
import {
  applyInventoryImport,
  applyOccupancyImport,
  findBatchByRequestId,
  getImportBatch,
  listImportBatches,
  undoImportBatch,
} from '@/lib/db/inventory-imports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const AI_FEATURE = 'inventory.sheet_import' as const;

/** base64 is ~4/3 of the bytes it carries; refuse before decoding. */
const MAX_BASE64_CHARS = Math.ceil((IMPORT_MAX_DECODED_BYTES * 4) / 3) + 1024;

const MAX_PASTED_CHARS = 200_000;

interface PropertyFacts {
  timezone: string | null;
  totalRooms: number | null;
  isTest: boolean;
}

async function loadPropertyFacts(pid: string): Promise<PropertyFacts> {
  const { data } = await supabaseAdmin
    .from('properties')
    .select('timezone,total_rooms,is_test')
    .eq('id', pid)
    .maybeSingle();
  const row = (data ?? null) as { timezone?: string | null; total_rooms?: number | null; is_test?: boolean | null } | null;
  return {
    timezone: row?.timezone ?? null,
    totalRooms: typeof row?.total_rooms === 'number' ? row.total_rooms : null,
    isTest: Boolean(row?.is_test),
  };
}

function hotelToday(facts: PropertyFacts): string {
  const tz = facts.timezone ?? 'UTC';
  try {
    return propertyLocalDate(new Date(), tz);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function loadExistingItems(pid: string): Promise<ExistingItem[]> {
  const { data, error } = await supabaseAdmin
    .from('inventory')
    .select('id,name,unit,category,custom_category_id')
    .eq('property_id', pid)
    .is('archived_at', null)
    .limit(5_000);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ''),
    unit: (r.unit as string | null) ?? null,
    category: (r.category as string | null) ?? null,
    customCategoryId: (r.custom_category_id as string | null) ?? null,
  }));
}

async function loadCustomCategories(pid: string): Promise<Array<{ id: string; name: string }>> {
  const { data, error } = await supabaseAdmin
    .from('inventory_custom_categories')
    .select('id,name')
    .eq('property_id', pid)
    .limit(200);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id), name: String(r.name ?? ''),
  }));
}

// ─── The gate every verb shares ────────────────────────────────────────────

type GateResult =
  | { ok: true; pid: string; accountId: string; requestId: string; actorName: string | null }
  | { ok: false; response: Response };

async function gate(req: NextRequest, pid: unknown): Promise<GateResult> {
  if (!isUuid(pid)) {
    return {
      ok: false,
      response: err('invalid property', { requestId: 'unknown', status: 400, code: ApiErrorCode.ValidationFailed }),
    };
  }
  const finance = await requireFinanceAccess(req, pid);
  if (!finance.ok) return { ok: false, response: finance.response };

  const capability = await capabilityDecisionForProperty(
    { role: finance.role },
    'manage_inventory_orders',
    finance.pid,
  );
  if (capability === 'unavailable') {
    return { ok: false, response: capabilityUnavailableResponse(finance.requestId) };
  }
  if (capability === 'denied') {
    return {
      ok: false,
      response: err('forbidden', { requestId: finance.requestId, status: 403, code: ApiErrorCode.Forbidden }),
    };
  }
  const section = await requireSectionEnabled(req, finance.pid, 'inventory');
  if (!section.ok) return { ok: false, response: section.response };

  return {
    ok: true,
    pid: finance.pid,
    accountId: finance.accountId,
    requestId: finance.requestId,
    actorName: finance.name,
  };
}

// ─── GET: the batch list ───────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const g = await gate(req, searchParams.get('pid'));
  if (!g.ok) return g.response;
  try {
    const batches = await listImportBatches(g.pid);
    return ok({ batches }, { requestId: g.requestId });
  } catch (e) {
    log.error('[inventory-import] list failed', { requestId: g.requestId, pid: g.pid, err: errToString(e) });
    return err('Could not load your imports.', {
      requestId: g.requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}

// ─── POST ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    body = {};
  }

  const g = await gate(req, body.pid);
  if (!g.ok) return g.response;

  const action = typeof body.action === 'string' ? body.action : '';
  switch (action) {
    case 'read':   return handleRead(req, g, body);
    case 'commit': return handleCommit(g, body);
    case 'undo':   return handleUndo(g, body);
    default:
      return err('unknown action', {
        requestId: g.requestId, status: 400, code: ApiErrorCode.UnknownAction,
      });
  }
}

// ─── read: file in, draft out, nothing saved ───────────────────────────────

type GateOk = Extract<GateResult, { ok: true }>;

async function handleRead(
  req: NextRequest,
  g: GateOk,
  body: Record<string, unknown>,
): Promise<Response> {
  const kind = body.kind === 'occupancy' ? 'occupancy' : 'inventory';

  // Resolve the source before spending anything.
  let source: ImportSource;
  let sourceName: string;
  try {
    if (typeof body.text === 'string' && body.text.trim()) {
      if (body.text.length > MAX_PASTED_CHARS) {
        return err('That is more text than we can read at once. Split it and try again.', {
          requestId: g.requestId, status: 400, code: ApiErrorCode.FileTooBig,
        });
      }
      source = pastedTextSource(body.text);
      sourceName = 'Pasted text';
    } else {
      const fileName = validateString(body.fileName, { max: 200, min: 1, label: 'fileName' });
      if (fileName.error) {
        return err(fileName.error, {
          requestId: g.requestId, status: 400, code: ApiErrorCode.ValidationFailed,
        });
      }
      const base64 = typeof body.fileBase64 === 'string' ? body.fileBase64 : '';
      if (base64.length < 8) {
        return err('There was nothing to read. Pick a file or paste your list.', {
          requestId: g.requestId, status: 400, code: ApiErrorCode.NothingToRead,
        });
      }
      if (base64.length > MAX_BASE64_CHARS) {
        return err('That file is larger than 4 MB. Save it as a CSV, or split it, and try again.', {
          requestId: g.requestId, status: 400, code: ApiErrorCode.FileTooBig,
        });
      }
      sourceName = fileName.value!;
      source = await readImportSource({
        fileName: sourceName,
        declaredMime: typeof body.mimeType === 'string' ? body.mimeType : null,
        bytes: new Uint8Array(Buffer.from(base64, 'base64')),
      });
    }
  } catch (e) {
    if (e instanceof ImportSourceError) {
      return err(e.message, { requestId: g.requestId, status: 400, code: e.code });
    }
    log.error('[inventory-import] source read failed', { requestId: g.requestId, pid: g.pid, err: errToString(e) });
    return err('We could not read that file.', {
      requestId: g.requestId, status: 400, code: ApiErrorCode.FileUnreadable,
    });
  }

  const rl = await checkAndIncrementRateLimit('inventory-import', g.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec) as unknown as Response;

  const budget = await assertAudioBudget({ userId: g.accountId, propertyId: g.pid });
  if (!budget.ok) {
    return err(budget.message, {
      requestId: g.requestId, status: 429, code: ApiErrorCode.AiBudgetExhausted,
    });
  }

  const facts = await loadPropertyFacts(g.pid);
  const todayLocal = hotelToday(facts);
  const categories = kind === 'inventory' ? await loadCustomCategories(g.pid) : [];

  const usages: VisionUsageReport[] = [];
  const captureUsage = (u: VisionUsageReport): void => { usages.push(u); };
  const deadlineAt = Date.now() + 52_000;

  try {
    const prompt = kind === 'occupancy'
      ? OCCUPANCY_IMPORT_PROMPT
      : inventoryImportPrompt(categories.map((c) => c.name));

    const ledger = { userId: g.accountId, propertyId: g.pid, requestId: g.requestId };

    if (kind === 'occupancy') {
      const extracted = await readImportWithModel<ExtractedOccupancySheet>({
        source, prompt, validate: validateOccupancySheet, ledger,
        abortSignal: req.signal, deadlineAt, onVisionUsage: captureUsage,
      });
      const normalized = normalizeOccupancyMonths({
        rows: extracted.rows,
        propertyTotalRooms: facts.totalRooms,
        todayLocal,
      });
      const skipped = extracted.skipped.map((s) => ({
        rowIndex: s.row_index,
        reason: normalizeReaderSkipReason(s.reason),
        text: s.text ?? '',
      }));
      return ok(
        {
          kind: 'occupancy',
          sourceName,
          sourceKind: source.sourceKind,
          layout: extracted.layout,
          months: normalized.months,
          monthRange: monthRangeLabel(normalized.months.map((m) => m.monthStart)),
          issues: normalized.issues,
          skipped,
          skippedSentence: buildSkippedSentence(skipped),
          truncated: source.readAs === 'text' ? source.truncated : false,
          isTest: facts.isTest,
        },
        { requestId: g.requestId },
      );
    }

    const extracted = await readImportWithModel<ExtractedInventorySheet>({
      source, prompt, validate: validateInventorySheet, ledger,
      abortSignal: req.signal, deadlineAt, onVisionUsage: captureUsage,
    });

    const existingItems = await loadExistingItems(g.pid);
    const asOfDate = pickAsOfDate(extracted.as_of_date, todayLocal);
    const rows: RawImportRow[] = extracted.rows.map((r) => ({
      rowIndex: r.row_index,
      name: r.item_name,
      unit: r.unit,
      category: r.category,
      unitCost: r.unit_cost,
      quantity: r.quantity,
      parLevel: r.par_level,
      vendorName: r.vendor_name,
      asOfDate: r.as_of_date,
    }));
    const draft = buildImportDraft({
      rows,
      existingItems,
      customCategories: categories,
      asOfDate,
      todayLocal,
      readerSkipped: extracted.skipped.map((s) => ({
        rowIndex: s.row_index,
        reason: normalizeReaderSkipReason(s.reason),
        text: s.text ?? '',
      })),
    });

    return ok(
      {
        kind: 'inventory',
        sourceName,
        sourceKind: source.sourceKind,
        asOfDateDetected: extracted.as_of_date,
        asOfEvidence: extracted.as_of_evidence,
        draft,
        customCategories: categories,
        todayLocal,
        truncated: source.readAs === 'text' ? source.truncated : false,
        isTest: facts.isTest,
      },
      { requestId: g.requestId },
    );
  } catch (e) {
    if (e instanceof AiFeatureDisabledError) {
      return err('Sheet reading is switched off right now.', {
        requestId: g.requestId, status: 503, code: ApiErrorCode.AiDisabled,
      });
    }
    if (e instanceof VisionTruncatedError) {
      return err('That file has more rows than we can read in one pass. Split it into smaller files and try again.', {
        requestId: g.requestId, status: 422, code: 'file_too_complex',
      });
    }
    if (e instanceof VisionImageInvalidError) {
      return err(e.message, { requestId: g.requestId, status: 400, code: ApiErrorCode.FileMalformed });
    }
    if (e instanceof VisionSchemaError) {
      log.warn('[inventory-import] extraction failed schema', { requestId: g.requestId, pid: g.pid, reason: e.reason });
      return err('We could not make sense of that file. Try a plainer version, or paste the rows as text.', {
        requestId: g.requestId, status: 422, code: ApiErrorCode.FileUnreadable,
      });
    }
    const msg = errToString(e);
    log.error('[inventory-import] read failed', { requestId: g.requestId, pid: g.pid, err: msg });
    const unavailable = /api[_ ]?key|ANTHROPIC_API_KEY/i.test(msg);
    return err(unavailable ? 'The reader is unavailable right now.' : 'We could not read that file.', {
      requestId: g.requestId,
      status: unavailable ? 503 : 500,
      code: unavailable ? ApiErrorCode.AiUnavailable : ApiErrorCode.InternalError,
    });
  } finally {
    if (usages.length > 0) {
      const tokensIn = usages.reduce((s, u) => s + u.inputTokens, 0);
      const tokensOut = usages.reduce((s, u) => s + u.outputTokens, 0);
      const cachedInputTokens = usages.reduce((s, u) => s + u.cachedInputTokens, 0);
      const costUsd = usages.reduce((s, u) => s + u.costUsd, 0);
      const { model, modelId } = usages[0];
      try {
        await recordNonRequestCost({
          feature: AI_FEATURE,
          userId: g.accountId,
          propertyId: g.pid,
          conversationId: null,
          model, modelId, tokensIn, tokensOut, cachedInputTokens, costUsd,
          kind: 'vision',
        });
      } catch (costErr) {
        const errObj = costErr instanceof Error ? costErr : new Error(String(costErr));
        log.error('[inventory-import] cost-ledger write failed', {
          requestId: g.requestId, pid: g.pid, err: errObj,
          unrecorded: { tokensIn, tokensOut, costUsd, modelId },
        });
        captureException(errObj, {
          subsystem: 'cost-ledger', route: 'inventory-import', severity: 'high',
          pid: g.pid, cost_usd: costUsd,
        });
      }
    }
  }
}

// ─── commit: the approved draft becomes one batch ──────────────────────────

async function handleCommit(g: GateOk, body: Record<string, unknown>): Promise<Response> {
  const requestIdField = typeof body.requestId === 'string' && body.requestId.length >= 8
    ? body.requestId.slice(0, 100)
    : null;

  // A double-tapped Confirm must import once. The batch's unique index on
  // (property_id, request_id) is the real guard; this is the friendly half.
  if (requestIdField) {
    try {
      const prior = await findBatchByRequestId(g.pid, requestIdField);
      if (prior) return ok({ batch: prior, alreadyImported: true }, { requestId: g.requestId });
    } catch { /* fall through and let the index decide */ }
  }

  const facts = await loadPropertyFacts(g.pid);
  const todayLocal = hotelToday(facts);
  const timezone = facts.timezone ?? 'UTC';
  const sourceName = (typeof body.sourceName === 'string' && body.sourceName.trim())
    ? body.sourceName.trim().slice(0, 200)
    : 'Pasted text';
  const sourceKind = normalizeSourceKind(body.sourceKind);
  const skippedSummary = typeof body.skippedSummary === 'string' ? body.skippedSummary.slice(0, 400) : '';
  const kind = body.kind === 'occupancy' ? 'occupancy' : 'inventory';

  try {
    if (kind === 'occupancy') {
      const normalized = normalizeOccupancyMonths({
        rows: Array.isArray(body.months) ? (body.months as Array<{ month: string }>) : [],
        propertyTotalRooms: facts.totalRooms,
        todayLocal,
      });
      if (normalized.months.length === 0) {
        return err('There are no months left on this list to save.', {
          requestId: g.requestId, status: 400, code: ApiErrorCode.ValidationFailed,
        });
      }
      const result = await applyOccupancyImport({
        pid: g.pid,
        months: normalized.months,
        sourceName, sourceKind, skippedSummary,
        requestId: requestIdField,
        accountId: g.accountId,
        actorName: g.actorName,
        mayFeedTraining: !facts.isTest,
      });
      const batch = await getImportBatch(g.pid, result.batchId);
      return ok({ batch, result }, { requestId: g.requestId, status: 201 });
    }

    const lines = parseConfirmedLines(body.lines);
    const existingItems = await loadExistingItems(g.pid);
    const categories = await loadCustomCategories(g.pid);
    const lastCountedAtByItem = await loadLastCountedAt(g.pid, existingItems.map((i) => i.id));

    const plan = buildImportCommitPlan({
      propertyTimezone: timezone,
      asOfDate: typeof body.asOfDate === 'string' ? body.asOfDate : todayLocal,
      todayLocal,
      lines,
      skipped: Array.isArray(body.skipped)
        ? (body.skipped as Array<Record<string, unknown>>).map((s) => ({
          rowIndex: Number(s.rowIndex) || 0,
          reason: String(s.reason ?? 'note_row').slice(0, 60),
          text: String(s.text ?? '').slice(0, 300),
        }))
        : [],
      existingItemIds: new Set(existingItems.map((i) => i.id)),
      lastCountedAtByItem,
      customCategoryIds: new Set(categories.map((c) => c.id)),
    });

    const result = await applyInventoryImport({
      pid: g.pid,
      plan,
      sourceName, sourceKind, skippedSummary,
      requestId: requestIdField,
      accountId: g.accountId,
      actorName: g.actorName,
      mayFeedTraining: !facts.isTest,
    });
    const batch = await getImportBatch(g.pid, result.batchId);
    return ok({ batch, result, mode: plan.mode }, { requestId: g.requestId, status: 201 });
  } catch (e) {
    if (e instanceof ImportCommitError) {
      return err(e.message, { requestId: g.requestId, status: 400, code: e.code });
    }
    if ((e as { code?: string })?.code === '23505') {
      return err('That import was already saved.', {
        requestId: g.requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
      });
    }
    log.error('[inventory-import] commit failed', { requestId: g.requestId, pid: g.pid, err: errToString(e) });
    return err('We could not save that import.', {
      requestId: g.requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}

function normalizeSourceKind(v: unknown): 'xlsx' | 'csv' | 'text' | 'pdf' | 'photo' {
  const s = typeof v === 'string' ? v : '';
  return s === 'xlsx' || s === 'csv' || s === 'pdf' || s === 'photo' ? s : 'text';
}

function parseConfirmedLines(raw: unknown): ConfirmedLine[] {
  if (!Array.isArray(raw)) {
    throw new ImportCommitError('lines_required', 'There is nothing on this list to save.');
  }
  if (raw.length > 1_000) {
    throw new ImportCommitError('too_many_lines', 'That is more rows than we can save at once. Split the file and try again.');
  }
  const out: ConfirmedLine[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const decision = e.decision === 'merge' ? 'merge' : e.decision === 'skip' ? 'skip' : 'create';
    const category = e.category === 'maintenance' || e.category === 'breakfast'
      ? (e.category as BuiltInCategory)
      : 'housekeeping';
    const mergeItemId = typeof e.mergeItemId === 'string' && isUuid(e.mergeItemId) ? e.mergeItemId : null;
    const customCategoryId = typeof e.customCategoryId === 'string' && isUuid(e.customCategoryId)
      ? e.customCategoryId
      : null;
    out.push({
      key: String(e.key ?? `r${out.length + 1}`).slice(0, 60),
      rowIndex: Number.isFinite(Number(e.rowIndex)) ? Math.max(0, Math.trunc(Number(e.rowIndex))) : out.length + 1,
      name: String(e.name ?? '').slice(0, 200),
      unit: String(e.unit ?? 'each').slice(0, 40),
      category,
      customCategoryId,
      unitCostCents: Number.isInteger(e.unitCostCents) ? (e.unitCostCents as number) : null,
      vendorName: typeof e.vendorName === 'string' ? e.vendorName.slice(0, 120) : null,
      quantity: Number.isFinite(Number(e.quantity)) && e.quantity !== null && e.quantity !== ''
        ? Number(e.quantity)
        : null,
      parLevel: Number.isFinite(Number(e.parLevel)) && e.parLevel !== null && e.parLevel !== ''
        ? Number(e.parLevel)
        : null,
      asOfDate: typeof e.asOfDate === 'string' ? e.asOfDate : null,
      // Trusted only for its SHAPE. Every date is re-validated and clamped to
      // the batch's as-of date in buildImportCommitPlan, so a crafted point
      // dated tomorrow cannot smuggle a stock write out of an old sheet.
      historyPoints: Array.isArray(e.historyPoints)
        ? (e.historyPoints as Array<Record<string, unknown>>)
          .slice(0, 60)
          .filter((p) => typeof p?.asOfDate === 'string' && Number.isFinite(Number(p?.quantity)))
          .map((p) => ({ asOfDate: String(p.asOfDate), quantity: Number(p.quantity) }))
        : undefined,
      decision,
      mergeItemId,
    });
  }
  return out;
}

async function loadLastCountedAt(pid: string, itemIds: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (itemIds.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from('inventory')
    .select('id,last_counted_at')
    .eq('property_id', pid)
    .limit(5_000);
  if (error) throw error;
  for (const r of (data ?? []) as Array<{ id: string; last_counted_at: string | null }>) {
    out.set(r.id, r.last_counted_at);
  }
  return out;
}

// ─── undo ──────────────────────────────────────────────────────────────────

async function handleUndo(g: GateOk, body: Record<string, unknown>): Promise<Response> {
  const batchId = typeof body.batchId === 'string' ? body.batchId : '';
  if (!isUuid(batchId)) {
    return err('invalid import', { requestId: g.requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  try {
    const batch = await getImportBatch(g.pid, batchId);
    if (!batch) {
      return err('That import is not here any more.', {
        requestId: g.requestId, status: 404, code: ApiErrorCode.NotFound,
      });
    }
    const decision = decideImportUndo({ importedAt: batch.importedAt, undoneAt: batch.undoneAt });
    if (!decision.ok) {
      const message = decision.reason === 'already_undone'
        ? 'That import was already removed.'
        : 'That import is too old to remove in one step.';
      return err(message, { requestId: g.requestId, status: 409, code: decision.reason ?? 'undo_refused' });
    }
    const result = await undoImportBatch(g.pid, batchId);
    return ok({ result }, { requestId: g.requestId });
  } catch (e) {
    log.error('[inventory-import] undo failed', { requestId: g.requestId, pid: g.pid, batchId, err: errToString(e) });
    return err('We could not remove that import.', {
      requestId: g.requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
