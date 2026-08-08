import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { gatherAssignedByMe } from '@/lib/worklist/core';
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
const READ_CONCURRENCY = 8;
/**
 * The aggregate must not silently skip hotels that are shown in its selector.
 * Every resolved hotel is attempted; a slow hotel is reported as unavailable
 * after its own deadline and remains visible in coverage/filter options.
 */
const TOTAL_READ_DEADLINE_MS = 30_000;
const PER_HOTEL_DEADLINE_MS = 7_000;

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
): MultiHotelCoverage {
  const attempted = scope.hotels.length;
  return {
    authorizedHotelCount: scope.authorizedPropertyIds.length,
    attemptedHotelCount: attempted,
    processedHotelCount: Math.max(0, attempted - unavailable.length),
    omittedHotelCount: Math.max(0, scope.authorizedPropertyIds.length - attempted),
    unavailableHotelCount: unavailable.length,
    unavailable,
    complete: unavailable.length === 0 && attempted === scope.authorizedPropertyIds.length,
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
  entries?: readonly MultiHotelLogEntry[];
  assigned?: readonly MultiHotelAssignedItem[];
  items?: readonly MultiHotelKnowsItem[];
}): MultiHotelRowsPayload {
  const attemptedIds = new Set(input.attemptedHotels.map((hotel) => hotel.propertyId));
  const unavailableIds = new Set(input.unavailable.map((hotel) => hotel.propertyId));
  const readableIds = new Set(
    [...attemptedIds].filter((propertyId) => !unavailableIds.has(propertyId)),
  );
  const entries = (input.entries ?? [])
    .filter((entry) => readableIds.has(entry.propertyId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const assigned = (input.assigned ?? [])
    .filter((item) => readableIds.has(item.propertyId))
    .sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''));
  const items = (input.items ?? [])
    .filter((item) => readableIds.has(item.propertyId))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return {
    coverage: coverageFor({ ...input.scope, hotels: [...input.attemptedHotels] }, [...input.unavailable]),
    hotels: input.scope.hotels.map(labelFor),
    entries,
    assigned,
    items,
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
): Promise<ReadResult<MultiHotelLogEntry[]>> {
  const { data, error } = await supabaseAdmin
    .from('comms_log_entries')
    .select('id, title, body, category, author_staff_id, created_at, updated_at')
    .eq('property_id', hotel.propertyId)
    .order('created_at', { ascending: false })
    .limit(LOG_ENTRY_LIMIT);
  if (error) return { ok: false, value: [] };
  const rows = (data ?? []) as RawLogRow[];
  if (rows.length === 0) return { ok: true, value: [] };
  const ids = rows.map((row) => row.id);
  const replies = await supabaseAdmin
    .from('comms_log_replies')
    .select('entry_id')
    .eq('property_id', hotel.propertyId)
    .in('entry_id', ids);
  if (replies.error) return { ok: false, value: [] };
  const counts = new Map<string, number>();
  for (const row of (replies.data ?? []) as Array<{ entry_id: string }>) {
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
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
    })),
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
  if (entry.error || !entry.data) return { ok: !entry.error, value: [] };
  const { data, error } = await supabaseAdmin
    .from('comms_log_replies')
    .select('id, entry_id, body, author_staff_id, created_at')
    .eq('property_id', hotel.propertyId)
    .eq('entry_id', entryId)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) return { ok: false, value: [] };
  const rows = (data ?? []) as Array<{
    id: string;
    entry_id: string;
    body: string;
    author_staff_id: string | null;
    created_at: string;
  }>;
  const names = await staffNames(
    hotel.propertyId,
    rows.map((row) => row.author_staff_id).filter((id): id is string => !!id),
  );
  if (!names.ok) return { ok: false, value: [] };
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
  };
}

async function readAssignedForHotel(
  hotel: MultiHotelScopeHotel,
): Promise<ReadResult<MultiHotelAssignedItem[]>> {
  // A missing identity is an honest empty set: there cannot be a task authored
  // by this account in that hotel yet. Ambiguity is handled by the dispatcher
  // as unavailable. The scope resolver deliberately never creates a row.
  if (!hotel.staffId) return { ok: true, value: [] };
  try {
    const assigned = await gatherAssignedByMe(
      hotel.propertyId,
      hotel.staffId,
      new Date(),
      ASSIGNED_LIMIT,
      hotel.timezone,
    );
    return {
      ok: true,
      value: assigned.map((item) => ({
        ...item,
        propertyId: hotel.propertyId,
        hotelName: hotel.hotelName,
        timezone: hotel.timezone,
      })),
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
): Promise<ReadResult<MultiHotelKnowsItem[]>> {
  const role = hotel.standing?.operationalRole ?? null;
  const dept = normalizeDept(hotel.department);
  const isManager = role !== null && canManageTeam(role);

  const rulesQuery = supabaseAdmin
    .from('hotel_standing_rules')
    .select('id, property_id, rule_text, created_at')
    .eq('property_id', hotel.propertyId)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(80);
  const contactsQuery = supabaseAdmin
    .from('knowledge_contacts')
    .select('id, name, company, phone, email, notes, category, created_at')
    .eq('property_id', hotel.propertyId)
    .order('category', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true })
    .limit(KNOWS_LIMIT);
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
  documentsQuery = documentsQuery.order('created_at', { ascending: false }).limit(KNOWS_LIMIT);
  let articlesQuery = supabaseAdmin
    .from('knowledge_articles')
    .select('id, title, visibility, updated_at')
    .eq('property_id', hotel.propertyId)
    .order('updated_at', { ascending: false })
    .limit(KNOWS_LIMIT);
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
      .limit(KNOWS_LIMIT)
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

  const items: KnowsItem[] = [];
  for (const row of (rules.data ?? []) as RawRuleRow[]) {
    const sentence = plainSentence(row.rule_text);
    if (sentence) items.push({ id: row.id, kind: 'rule', group: 'taught', sentence, tel: null, telText: null, at: row.created_at });
  }
  for (const row of (contacts.data ?? []) as RawContactRow[]) {
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
  for (const row of (documents.data ?? []) as RawDocumentRow[]) {
    if (!role || !isValidRole(role) || !canReadDocVisibility({ role, dept }, row.visibility, row.visible_dept)) continue;
    const sentence = documentSentence(row.title);
    if (sentence) items.push({ id: row.id, kind: 'document', group: 'taught', sentence, tel: null, telText: null, at: row.created_at });
  }
  for (const row of (articles.data ?? []) as RawArticleRow[]) {
    const sentence = sopSentence(row.title);
    if (sentence) items.push({ id: row.id, kind: 'sop', group: 'taught', sentence, tel: null, telText: null, at: row.updated_at });
  }
  if (isManager) {
    for (const row of (memory.data ?? []) as RawMemoryRow[]) {
      if (!isSharedPropertyMemory(row)) continue;
      const item = memoryItem(row);
      if (item) items.push(item);
    }
  }
  return {
    ok: true,
    value: sortKnowsItems(items).map((item) => ({ ...item, ...labelFor(hotel) })),
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
  const results = await mapWithConcurrency(attemptedHotels, async (hotel) => {
    if (surface === 'assigned-by-me' && hotel.identityAmbiguous) {
      return { hotel, result: { ok: false, value: [] }, reason: 'identity_unavailable' as const };
    }
    // A missing local identity is an honest empty set: there cannot be a task
    // authored by this account in that hotel yet. It is not an error and does
    // not create a staff identity just to make the aggregate look complete.
    if (surface === 'assigned-by-me' && !hotel.staffId) {
      return { hotel, result: { ok: true, value: [] }, reason: null };
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
        ? readLogbookForHotel(hotel) as Promise<ReadResult<unknown[]>>
        : surface === 'assigned-by-me'
          ? readAssignedForHotel(hotel) as Promise<ReadResult<unknown[]>>
          : readKnowsForHotel(hotel) as Promise<ReadResult<unknown[]>>;
      const result = await withPromiseDeadline(
        read,
        {
          timeoutMs: Math.min(PER_HOTEL_DEADLINE_MS, remainingMs),
          label: `multi-hotel ${surface}`,
        },
      );
      return { hotel, result, reason: result.ok ? null : 'read_failed' as const };
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
  for (const row of results) {
    if (row.reason) {
      unavailable.push(unavailableFor(row.hotel, row.reason));
      continue;
    }
    if (surface === 'logbook') entries.push(...(row.result.value as MultiHotelLogEntry[]));
    else if (surface === 'assigned-by-me') assigned.push(...(row.result.value as MultiHotelAssignedItem[]));
    else items.push(...(row.result.value as MultiHotelKnowsItem[]));
  }
  const payload = buildMultiHotelRowsPayload({
    scope,
    attemptedHotels,
    unavailable,
    entries,
    assigned,
    items,
  });
  return {
    coverage: payload.coverage,
    hotels: payload.hotels,
    ...(surface === 'logbook' ? { entries: payload.entries } : {}),
    ...(surface === 'assigned-by-me' ? { assigned: payload.assigned } : {}),
    ...(surface === 'knows' ? { items: payload.items } : {}),
  };
}
