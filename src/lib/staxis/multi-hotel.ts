import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { gatherAssignedByMeWithMeta } from '@/lib/worklist/core';
import { canManageTeam, isValidRole } from '@/lib/roles';
import { withPromiseDeadline } from '@/lib/fetch-deadline';
import { docVisibilityScope, canReadDocVisibility } from '@/lib/knowledge/search-helpers';
import { normalizeDept } from '@/lib/capabilities/dept-scope';
import {
  contactSentence,
  documentSentence,
  groupForMemorySource,
  plainSentence,
  sortKnowsItems,
  sopSentence,
  type KnowsItem,
} from '@/lib/knows/page-model';
import { validPropertyTimezone } from '@/lib/property-timezone';
import type { MemoryConfidence, MemoryScope, MemorySource } from '@/lib/db/agent-memory';
import type {
  MultiHotelAssignedItem,
  MultiHotelCoverage,
  MultiHotelKnowsItem,
  MultiHotelLabel,
  MultiHotelLogEntry,
  MultiHotelSurface,
  MultiHotelUnavailable,
} from './multi-hotel-types';
import type { MultiHotelScope, MultiHotelScopeHotel } from './multi-hotel-scope';
import type { LogReplyDTO } from '@/lib/comms/types';

const LOG_ENTRY_LIMIT = 200;
const ASSIGNED_LIMIT = 200;
const KNOWS_LIMIT = 500;
const LOG_REPLY_LIMIT = 1_000;
const DETAIL_REPLY_LIMIT = 500;
const READ_CONCURRENCY = 8;
/**
 * The aggregate must not silently skip hotels that are shown in its selector.
 * Every resolved hotel is attempted; a slow hotel is reported as unavailable
 * after its own deadline and remains visible in coverage/filter options.
 */
const TOTAL_READ_DEADLINE_MS = 30_000;
const PER_HOTEL_DEADLINE_MS = 7_000;
export const MAX_MULTI_HOTEL_RESPONSE_ROWS = 5_000;
export const MAX_MULTI_HOTEL_RESPONSE_BYTES = 3_000_000;
/** Reserve route/envelope bytes so the serialized API response stays bounded. */
const RESPONSE_WRAPPER_RESERVE_BYTES = 64 * 1024;
const RESPONSE_SCALAR_RESERVE_BYTES = 8 * 1024;

/**
 * Reply counts are bounded in proportion to the per-hotel entry window. A
 * 500-hotel read therefore cannot issue 500 requests each asking for 1,001
 * replies, while a one-hotel read keeps the historical 1,000-row cap.
 */
export function multiHotelReplyReadLimit(entryLimit: number): number {
  return Math.max(10, Math.min(LOG_REPLY_LIMIT, Math.max(1, entryLimit) * 5));
}

interface RawLogRow {
  id: string;
  title: string;
  body: string | null;
  category: string | null;
  author_staff_id: string | null;
  created_at: string;
  updated_at: string | null;
}

interface RawStaffRow {
  id: string;
  name: string | null;
}

interface RawMemoryRow {
  id: string;
  scope: MemoryScope;
  topic: string;
  content: string;
  source: MemorySource;
  confidence: MemoryConfidence;
  created_by_role: string | null;
  created_by_name: string | null;
  subject_account_id: string | null;
  updated_at: string;
  category: string | null;
  review_state: string | null;
  expires_at: string | null;
  is_active: boolean | null;
}

interface RawRuleRow {
  id: string;
  property_id: string;
  rule_text: string;
  created_at: string;
}

interface RawContactRow {
  id: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  category: string | null;
  created_at: string;
}

interface RawDocumentRow {
  id: string;
  title: string;
  visibility: 'all_staff' | 'dept' | 'managers';
  visible_dept: string | null;
  created_at: string;
}

interface RawArticleRow {
  id: string;
  title: string;
  visibility: 'all_staff' | 'managers';
  updated_at: string;
}

interface ReadResult<T> {
  ok: boolean;
  value: T;
  reason?: 'read_failed' | 'not_found';
  /** True when a bounded source window returned one extra sentinel row. */
  truncated?: boolean;
}

function labelFor(hotel: MultiHotelScopeHotel): MultiHotelLabel {
  return {
    propertyId: hotel.propertyId,
    hotelName: hotel.hotelName,
    timezone: validPropertyTimezone(hotel.timezone) ?? hotel.timezone ?? null,
  };
}

async function mapWithConcurrency<T, R>(
  input: readonly T[], worker: (value: T) => Promise<R>,
  concurrency = READ_CONCURRENCY,
): Promise<R[]> {
  const out = new Array<R>(input.length);
  let cursor = 0;
  async function run(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= input.length) return;
      out[index] = await worker(input[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, () => run()));
  return out;
}

function coverageFor(
  scope: MultiHotelScope,
  unavailable: MultiHotelUnavailable[],
  stats: {
    rowsReturned: number;
    rowsOmitted: number;
    responseBytesEstimated: number;
    sourceTruncated: boolean;
  },
): MultiHotelCoverage {
  const attempted = scope.hotels.length;
  const truncated = stats.rowsOmitted > 0
    || stats.sourceTruncated
    || stats.responseBytesEstimated > MAX_MULTI_HOTEL_RESPONSE_BYTES - RESPONSE_WRAPPER_RESERVE_BYTES;
  return {
    authorizedHotelCount: scope.authorizedPropertyIds.length,
    attemptedHotelCount: attempted,
    processedHotelCount: Math.max(0, attempted - unavailable.length),
    omittedHotelCount: Math.max(0, scope.authorizedPropertyIds.length - attempted),
    unavailableHotelCount: unavailable.length,
    unavailable,
    rowBudget: MAX_MULTI_HOTEL_RESPONSE_ROWS,
    rowsReturned: stats.rowsReturned,
    rowsOmitted: stats.rowsOmitted,
    responseByteBudget: MAX_MULTI_HOTEL_RESPONSE_BYTES,
    responseBytesEstimated: stats.responseBytesEstimated,
    truncated,
    complete: unavailable.length === 0
      && attempted === scope.authorizedPropertyIds.length
      && !truncated,
  };
}

function unavailableFor(
  hotel: MultiHotelScopeHotel,
  reason: MultiHotelUnavailable['reason'],
): MultiHotelUnavailable {
  return { propertyId: hotel.propertyId, hotelName: hotel.hotelName, reason };
}

export interface MultiHotelRowsPayload {
  coverage: MultiHotelCoverage;
  hotels: MultiHotelLabel[];
  entries: MultiHotelLogEntry[];
  assigned: MultiHotelAssignedItem[];
  items: MultiHotelKnowsItem[];
}

/**
 * Assemble an aggregate from only the hotels that were actually attempted.
 * Keeping this pure makes the security boundary testable: a row from a hotel
 * outside the resolved scope is dropped before it can reach the API response,
 * while authorized-but-unavailable hotels remain in labels and coverage.
 */
export function buildMultiHotelRowsPayload(input: {
  scope: MultiHotelScope;
  attemptedHotels: readonly MultiHotelScopeHotel[];
  unavailable: readonly MultiHotelUnavailable[];
  surface: MultiHotelSurface;
  entries?: readonly MultiHotelLogEntry[];
  assigned?: readonly MultiHotelAssignedItem[];
  items?: readonly MultiHotelKnowsItem[];
  /** Set when any bounded source window returned its extra sentinel row. */
  sourceTruncated?: boolean;
}): MultiHotelRowsPayload {
  const attemptedIds = new Set(input.attemptedHotels.map((hotel) => hotel.propertyId));
  const unavailableIds = new Set(input.unavailable.map((hotel) => hotel.propertyId));
  const readableIds = new Set(
    [...attemptedIds].filter((propertyId) => !unavailableIds.has(propertyId)),
  );
  const allEntries = (input.entries ?? [])
    .filter((entry) => readableIds.has(entry.propertyId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const allAssigned = (input.assigned ?? [])
    .filter((item) => readableIds.has(item.propertyId))
    .sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''));
  const allItems = (input.items ?? [])
    .filter((item) => readableIds.has(item.propertyId))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const allRows: Array<MultiHotelLogEntry | MultiHotelAssignedItem | MultiHotelKnowsItem> = input.surface === 'logbook'
    ? allEntries
    : input.surface === 'assigned-by-me'
      ? allAssigned
      : allItems;
  const hotels = input.scope.hotels.map(labelFor);
  const attemptedScope = { ...input.scope, hotels: [...input.attemptedHotels] };
  const unavailable = [...input.unavailable];
  const sourceTruncated = input.sourceTruncated === true;
  const rowsKey = input.surface === 'logbook'
    ? 'entries'
    : input.surface === 'assigned-by-me'
      ? 'assigned'
      : 'items';

  type ClientAggregatePayload = {
    surface: MultiHotelSurface;
    hotels: MultiHotelLabel[];
    coverage: MultiHotelCoverage;
    entries?: MultiHotelLogEntry[];
    assigned?: MultiHotelAssignedItem[];
    items?: MultiHotelKnowsItem[];
    ready: boolean;
  };

  function payloadFor(
    rows: typeof allRows,
    coverage: MultiHotelCoverage,
  ): ClientAggregatePayload {
    return {
      surface: input.surface,
      hotels,
      coverage,
      ...(rowsKey === 'entries' ? { entries: rows as MultiHotelLogEntry[] } : {}),
      ...(rowsKey === 'assigned' ? { assigned: rows as MultiHotelAssignedItem[] } : {}),
      ...(rowsKey === 'items' ? { items: rows as MultiHotelKnowsItem[] } : {}),
      ready: coverage.complete,
    };
  }

  function stabilize(rows: typeof allRows): {
    coverage: MultiHotelCoverage;
    bytes: number;
  } {
    const rowsOmitted = Math.max(allRows.length - rows.length, sourceTruncated ? 1 : 0);
    let responseBytesEstimated = 0;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const coverage = coverageFor(
        attemptedScope,
        unavailable,
        {
          rowsReturned: rows.length,
          rowsOmitted,
          responseBytesEstimated,
          sourceTruncated,
        },
      );
      const bytes = Buffer.byteLength(JSON.stringify(payloadFor(rows, coverage)), 'utf8');
      if (bytes === responseBytesEstimated) return { coverage, bytes };
      responseBytesEstimated = bytes;
    }
    // The response estimate is a scalar in the payload, so its UTF-8 JSON
    // width reaches a fixed point quickly. Keep the last measured payload only
    // as a defensive fallback; normal inputs return from the loop above with
    // coverage.responseBytesEstimated exactly equal to the serialized bytes.
    const coverage = coverageFor(
      attemptedScope,
      unavailable,
      {
        rowsReturned: rows.length,
        rowsOmitted,
        responseBytesEstimated: responseBytesEstimated,
        sourceTruncated,
      },
    );
    const bytes = Buffer.byteLength(JSON.stringify(payloadFor(rows, coverage)), 'utf8');
    return { coverage, bytes };
  }

  const internalBudget = Math.max(0, MAX_MULTI_HOTEL_RESPONSE_BYTES - RESPONSE_WRAPPER_RESERVE_BYTES);
  const rowBytes = allRows.map((row) => Buffer.byteLength(JSON.stringify(row), 'utf8'));
  const empty = stabilize([]);
  let selectedCount = 0;
  let selectedBytes = 0;
  const conservativeBudget = Math.max(0, internalBudget - RESPONSE_SCALAR_RESERVE_BYTES);
  while (selectedCount < allRows.length && selectedCount < MAX_MULTI_HOTEL_RESPONSE_ROWS) {
    const nextBytes = rowBytes[selectedCount]!;
    // Two bytes per row conservatively accounts for array brackets/commas;
    // exact payload sizing below is the final authority.
    if (empty.bytes + selectedBytes + nextBytes + (selectedCount + 1) * 2 > conservativeBudget) break;
    selectedBytes += nextBytes;
    selectedCount += 1;
  }
  let selectedRows = allRows.slice(0, selectedCount);
  let stabilized = stabilize(selectedRows);
  while (stabilized.bytes > internalBudget && selectedRows.length > 0) {
    selectedRows = selectedRows.slice(0, -1);
    stabilized = stabilize(selectedRows);
  }
  return {
    coverage: stabilized.coverage,
    hotels,
    entries: input.surface === 'logbook' ? selectedRows as MultiHotelLogEntry[] : [],
    assigned: input.surface === 'assigned-by-me' ? selectedRows as MultiHotelAssignedItem[] : [],
    items: input.surface === 'knows' ? selectedRows as MultiHotelKnowsItem[] : [],
  };
}

async function staffNames(pid: string, ids: readonly string[]): Promise<ReadResult<Map<string, string>>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return { ok: true, value: new Map() };
  const { data, error } = await supabaseAdmin
    .from('staff')
    .select('id, name')
    .eq('property_id', pid)
    .in('id', unique);
  if (error) return { ok: false, value: new Map() };
  return {
    ok: true,
    value: new Map(((data ?? []) as RawStaffRow[]).map((row) => [row.id, row.name ?? ''])),
  };
}

async function readLogbookForHotel(
  hotel: MultiHotelScopeHotel,
  entryLimit = LOG_ENTRY_LIMIT,
  replyLimit = multiHotelReplyReadLimit(entryLimit),
): Promise<ReadResult<MultiHotelLogEntry[]>> {
  const { data, error } = await supabaseAdmin
    .from('comms_log_entries')
    .select('id, title, body, category, author_staff_id, created_at, updated_at')
    .eq('property_id', hotel.propertyId)
    .order('created_at', { ascending: false })
    .limit(entryLimit + 1);
  if (error) return { ok: false, value: [] };
  const allRows = (data ?? []) as RawLogRow[];
  const sourceTruncated = allRows.length > entryLimit;
  const rows = allRows.slice(0, entryLimit);
  if (rows.length === 0) return { ok: true, value: [], truncated: sourceTruncated };
  const ids = rows.map((row) => row.id);
  const replies = await supabaseAdmin
    .from('comms_log_replies')
    .select('entry_id')
    .eq('property_id', hotel.propertyId)
    .in('entry_id', ids)
    .limit(replyLimit + 1);
  if (replies.error) return { ok: false, value: [] };
  const replyRows = (replies.data ?? []) as Array<{ entry_id: string }>;
  const replyCountComplete = replyRows.length <= replyLimit;
  const counts = new Map<string, number>();
  for (const row of replyRows.slice(0, replyLimit)) {
    counts.set(row.entry_id, (counts.get(row.entry_id) ?? 0) + 1);
  }
  const names = await staffNames(
    hotel.propertyId,
    rows.map((row) => row.author_staff_id).filter((id): id is string => !!id),
  );
  if (!names.ok) return { ok: false, value: [] };
  return {
    ok: true,
    value: rows.map((row) => ({
      id: row.id,
      propertyId: hotel.propertyId,
      hotelName: hotel.hotelName,
      timezone: hotel.timezone,
      title: row.title,
      body: row.body ?? '',
      category: row.category ?? null,
      authorStaffId: row.author_staff_id ?? null,
      authorName: row.author_staff_id ? names.value.get(row.author_staff_id) ?? null : null,
      replyCount: counts.get(row.id) ?? 0,
      replyCountComplete,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
    })),
    truncated: sourceTruncated || !replyCountComplete,
  };
}

/** Read-only detail path for a portfolio reader. Both the entry existence
 * check and replies are scoped to the exact selected hotel. */
export async function readLogRepliesForHotel(
  hotel: MultiHotelScopeHotel,
  entryId: string,
): Promise<ReadResult<LogReplyDTO[]>> {
  const entry = await supabaseAdmin
    .from('comms_log_entries')
    .select('id')
    .eq('id', entryId)
    .eq('property_id', hotel.propertyId)
    .maybeSingle();
  if (entry.error) return { ok: false, value: [], reason: 'read_failed' };
  if (!entry.data) return { ok: false, value: [], reason: 'not_found' };
  const { data, error } = await supabaseAdmin
    .from('comms_log_replies')
    .select('id, entry_id, body, author_staff_id, created_at')
    .eq('property_id', hotel.propertyId)
    .eq('entry_id', entryId)
    .order('created_at', { ascending: true })
    .limit(DETAIL_REPLY_LIMIT + 1);
  if (error) return { ok: false, value: [], reason: 'read_failed' };
  const allRows = (data ?? []) as Array<{
    id: string;
    entry_id: string;
    body: string;
    author_staff_id: string | null;
    created_at: string;
  }>;
  const truncated = allRows.length > DETAIL_REPLY_LIMIT;
  const rows = allRows.slice(0, DETAIL_REPLY_LIMIT);
  const names = await staffNames(
    hotel.propertyId,
    rows.map((row) => row.author_staff_id).filter((id): id is string => !!id),
  );
  if (!names.ok) return { ok: false, value: [], reason: 'read_failed' };
  return {
    ok: true,
    value: rows.map((row) => ({
      id: row.id,
      entryId: row.entry_id,
      body: row.body,
      authorStaffId: row.author_staff_id,
      authorName: row.author_staff_id ? names.value.get(row.author_staff_id) ?? null : null,
      createdAt: row.created_at,
    })),
    truncated,
  };
}

async function readAssignedForHotel(
  hotel: MultiHotelScopeHotel,
  limit = ASSIGNED_LIMIT,
): Promise<ReadResult<MultiHotelAssignedItem[]>> {
  // The dispatcher handles missing/ambiguous identities as unavailable. This
  // guard keeps the read-only resolver from ever creating a staff row.
  if (!hotel.staffId) return { ok: false, value: [], reason: 'read_failed' };
  try {
    const gathered = await gatherAssignedByMeWithMeta(
      hotel.propertyId,
      hotel.staffId,
      new Date(),
      limit,
      hotel.timezone,
    );
    return {
      ok: true,
      value: gathered.items.map((item) => ({
        ...item,
        propertyId: hotel.propertyId,
        hotelName: hotel.hotelName,
        timezone: hotel.timezone,
      })),
      truncated: gathered.sourceTruncated,
    };
  } catch {
    return { ok: false, value: [] };
  }
}

function memoryItem(row: RawMemoryRow): KnowsItem | null {
  const sentence = plainSentence(row.content);
  if (!sentence) return null;
  return {
    id: row.id,
    kind: 'fact',
    group: groupForMemorySource(row.source),
    sentence,
    tel: null,
    telText: null,
    at: row.updated_at,
  };
}

/** Property knowledge is shared only when it has no user/subject boundary. */
export function isSharedPropertyMemory(row: Pick<RawMemoryRow, 'scope' | 'subject_account_id' | 'is_active'>): boolean {
  return row.scope === 'property' && row.subject_account_id === null && row.is_active === true;
}

async function readKnowsForHotel(
  hotel: MultiHotelScopeHotel,
  itemLimit = KNOWS_LIMIT,
): Promise<ReadResult<MultiHotelKnowsItem[]>> {
  const role = hotel.standing?.operationalRole ?? null;
  const dept = normalizeDept(hotel.department);
  const isManager = role !== null && canManageTeam(role);
  const storeLimit = Math.max(1, Math.ceil(itemLimit / 5));
  const rulesLimit = Math.min(80, storeLimit);

  const rulesQuery = supabaseAdmin
    .from('hotel_standing_rules')
    .select('id, property_id, rule_text, created_at')
    .eq('property_id', hotel.propertyId)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(rulesLimit + 1);
  const contactsQuery = supabaseAdmin
    .from('knowledge_contacts')
    .select('id, name, company, phone, email, notes, category, created_at')
    .eq('property_id', hotel.propertyId)
    .order('category', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true })
    .limit(storeLimit + 1);
  let documentsQuery = supabaseAdmin
    .from('knowledge_documents')
    .select('id, title, visibility, visible_dept, created_at')
    .eq('property_id', hotel.propertyId);
  const docScope = role && isValidRole(role)
    ? docVisibilityScope(role, dept)
    : { kind: 'allStaffOnly' as const };
  if (docScope.kind === 'allStaffOnly') documentsQuery = documentsQuery.eq('visibility', 'all_staff');
  else if (docScope.kind === 'allStaffOrDept') {
    documentsQuery = documentsQuery.or(
      `visibility.eq.all_staff,and(visibility.eq.dept,visible_dept.eq.${docScope.dept})`,
    );
  }
  documentsQuery = documentsQuery.order('created_at', { ascending: false }).limit(storeLimit + 1);
  let articlesQuery = supabaseAdmin
    .from('knowledge_articles')
    .select('id, title, visibility, updated_at')
    .eq('property_id', hotel.propertyId)
    .order('updated_at', { ascending: false })
    .limit(storeLimit + 1);
  if (!isManager) articlesQuery = articlesQuery.eq('visibility', 'all_staff');
  const memoryQuery = isManager
    ? supabaseAdmin
      .from('agent_memory')
      .select('id, scope, topic, content, source, confidence, created_by_role, created_by_name, subject_account_id, updated_at, category, review_state, expires_at, is_active')
      .eq('property_id', hotel.propertyId)
      .eq('scope', 'property')
      .is('subject_account_id', null)
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
      .limit(storeLimit + 1)
    : null;

  const [rules, contacts, documents, articles, memory] = await Promise.all([
    rulesQuery,
    contactsQuery,
    documentsQuery,
    articlesQuery,
    memoryQuery ?? Promise.resolve({ data: [], error: null }),
  ]);
  if (rules.error || contacts.error || documents.error || articles.error || memory.error) {
    return { ok: false, value: [] };
  }

  const ruleRows = (rules.data ?? []) as RawRuleRow[];
  const contactRows = (contacts.data ?? []) as RawContactRow[];
  const documentRows = (documents.data ?? []) as RawDocumentRow[];
  const articleRows = (articles.data ?? []) as RawArticleRow[];
  const memoryRows = (memory.data ?? []) as RawMemoryRow[];
  const sourceTruncated = ruleRows.length > rulesLimit
    || contactRows.length > storeLimit
    || documentRows.length > storeLimit
    || articleRows.length > storeLimit
    || memoryRows.length > storeLimit;

  const items: KnowsItem[] = [];
  for (const row of ruleRows.slice(0, rulesLimit)) {
    const sentence = plainSentence(row.rule_text);
    if (sentence) items.push({ id: row.id, kind: 'rule', group: 'taught', sentence, tel: null, telText: null, at: row.created_at });
  }
  for (const row of contactRows.slice(0, storeLimit)) {
    const sentence = contactSentence({
      id: row.id,
      name: row.name,
      company: row.company,
      phone: row.phone,
      email: row.email,
      notes: row.notes,
      category: row.category,
      createdAt: row.created_at,
    });
    if (sentence) {
      items.push({
        id: row.id,
        kind: 'contact',
        group: 'taught',
        sentence,
        tel: row.phone ? `tel:${row.phone.replace(/[^+\d]/g, '')}` : null,
        telText: row.phone ? row.phone.replace(/\s+/g, ' ').trim() : null,
        at: row.created_at,
      });
    }
  }
  for (const row of documentRows.slice(0, storeLimit)) {
    if (!role || !isValidRole(role) || !canReadDocVisibility({ role, dept }, row.visibility, row.visible_dept)) continue;
    const sentence = documentSentence(row.title);
    if (sentence) items.push({ id: row.id, kind: 'document', group: 'taught', sentence, tel: null, telText: null, at: row.created_at });
  }
  for (const row of articleRows.slice(0, storeLimit)) {
    const sentence = sopSentence(row.title);
    if (sentence) items.push({ id: row.id, kind: 'sop', group: 'taught', sentence, tel: null, telText: null, at: row.updated_at });
  }
  if (isManager) {
    for (const row of memoryRows.slice(0, storeLimit)) {
      if (!isSharedPropertyMemory(row)) continue;
      const item = memoryItem(row);
      if (item) items.push(item);
    }
  }
  return {
    ok: true,
    value: sortKnowsItems(items).map((item) => ({ ...item, ...labelFor(hotel) })),
    truncated: sourceTruncated,
  };
}

export async function readMultiHotelSurface(
  scope: MultiHotelScope,
  surface: MultiHotelSurface,
): Promise<{
  coverage: MultiHotelCoverage;
  hotels: MultiHotelLabel[];
  entries?: MultiHotelLogEntry[];
  assigned?: MultiHotelAssignedItem[];
  items?: MultiHotelKnowsItem[];
}> {
  const unavailable: MultiHotelUnavailable[] = [];
  const attemptedHotels = scope.hotels;
  const deadlineAt = Date.now() + TOTAL_READ_DEADLINE_MS;
  const surfaceHotelLimit = surface === 'logbook'
    ? LOG_ENTRY_LIMIT
    : surface === 'assigned-by-me'
      ? ASSIGNED_LIMIT
      : KNOWS_LIMIT;
  const perHotelLimit = Math.max(
    1,
    Math.min(surfaceHotelLimit, Math.floor(MAX_MULTI_HOTEL_RESPONSE_ROWS / Math.max(1, attemptedHotels.length))),
  );
  const perHotelReplyLimit = multiHotelReplyReadLimit(perHotelLimit);
  const results = await mapWithConcurrency(attemptedHotels, async (hotel) => {
    if (surface === 'assigned-by-me' && hotel.identityAmbiguous) {
      return { hotel, result: { ok: false, value: [] }, reason: 'identity_unavailable' as const };
    }
    // A missing local identity cannot prove there were never legacy authored
    // rows, so it is unavailable rather than an empty result. Never create a
    // staff identity just to make the aggregate look complete.
    if (surface === 'assigned-by-me' && !hotel.staffId) {
      return { hotel, result: { ok: false, value: [] }, reason: 'identity_unavailable' as const };
    }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      return {
        hotel,
        result: { ok: false, value: [] },
        reason: 'read_failed' as const,
      };
    }
    try {
      const read = surface === 'logbook'
        ? readLogbookForHotel(hotel, perHotelLimit, perHotelReplyLimit) as Promise<ReadResult<unknown[]>>
        : surface === 'assigned-by-me'
          ? readAssignedForHotel(hotel, perHotelLimit) as Promise<ReadResult<unknown[]>>
          : readKnowsForHotel(hotel, perHotelLimit) as Promise<ReadResult<unknown[]>>;
      const result = await withPromiseDeadline(
        read,
        {
          timeoutMs: Math.min(PER_HOTEL_DEADLINE_MS, remainingMs),
          label: `multi-hotel ${surface}`,
        },
      );
      return {
        hotel,
        result,
        reason: result.ok
          ? null
          : result.reason === 'not_found'
            ? 'hotel_missing' as const
            : 'read_failed' as const,
      };
    } catch {
      return {
        hotel,
        result: { ok: false, value: [] },
        reason: 'read_failed' as const,
      };
    }
  });

  const entries: MultiHotelLogEntry[] = [];
  const assigned: MultiHotelAssignedItem[] = [];
  const items: MultiHotelKnowsItem[] = [];
  let sourceTruncated = false;
  for (const row of results) {
    if (row.reason) {
      unavailable.push(unavailableFor(row.hotel, row.reason));
      continue;
    }
    sourceTruncated ||= row.result.truncated === true;
    if (surface === 'logbook') entries.push(...(row.result.value as MultiHotelLogEntry[]));
    else if (surface === 'assigned-by-me') assigned.push(...(row.result.value as MultiHotelAssignedItem[]));
    else items.push(...(row.result.value as MultiHotelKnowsItem[]));
  }
  const payload = buildMultiHotelRowsPayload({
    scope,
    attemptedHotels,
    unavailable,
    surface,
    entries,
    assigned,
    items,
    sourceTruncated,
  });
  return {
    coverage: payload.coverage,
    hotels: payload.hotels,
    ...(surface === 'logbook' ? { entries: payload.entries } : {}),
    ...(surface === 'assigned-by-me' ? { assigned: payload.assigned } : {}),
    ...(surface === 'knows' ? { items: payload.items } : {}),
  };
}
