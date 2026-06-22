// ═══════════════════════════════════════════════════════════════════════════
// Communications — server-side core (service-role, supabaseAdmin only).
//
// Every read/write goes through here from /api/comms/* (authenticated) and
// /api/housekeeper/messages/* (pid+staffId capability). RLS is deny-all on
// the comms_* tables; this module bypasses it via supabaseAdmin AFTER the
// route has verified the caller. NO SMS — in-app only.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { todayStr } from '@/lib/utils';
import { mergePmsRoomsForDate } from '@/lib/pms-rooms-server';
import { translateMessagesForReader } from './translate';
import type {
  ChannelKey, CommsLang, CommsDept, ConversationDTO, MessageDTO, TaskDTO, StaffLite,
  AckStatusDTO, CampaignStatusDTO, MemberDTO, SearchHitDTO, LogEntryDTO, LogReplyDTO,
} from './types';
import { CHANNEL_LABELS } from './types';
import {
  canReachDeptContent,
  isManagerRole as deptIsManagerRole,
  normalizeDept,
} from '@/lib/capabilities/dept-scope';

const ATTACHMENT_BUCKET = 'housekeeping-issue-photos'; // reuse existing private bucket
const SIGNED_URL_TTL = 60 * 60; // 1h read URLs

// ── Roles / departments ────────────────────────────────────────────────────

// Manager detection lives in dept-scope (single source of truth); re-exported
// here so the many comms callers keep importing it from comms/core unchanged.
export function isManagerRole(role: string | null | undefined): boolean {
  return deptIsManagerRole(role);
}

/** Map a staff.department value to its department channel (null = no dept channel).
 *  Reuses the canonical dept normalization in dept-scope. */
export function deptChannel(dept: string | null | undefined): ChannelKey | null {
  return normalizeDept(dept);
}

/** Map a staff.department to a colour bucket for the Slack-style UI (dept dots / channel tints). */
export function commsDeptOf(dept: string | null | undefined): CommsDept {
  switch ((dept ?? '').toLowerCase()) {
    case 'front_desk': case 'frontdesk': case 'front desk': return 'front_desk';
    case 'housekeeping': return 'housekeeping';
    case 'maintenance': case 'engineering': return 'maintenance';
    case 'laundry': return 'laundry';
    default: return 'management'; // admin / owner / gm / other / null
  }
}

/** Colour bucket for a channel conversation. */
function channelDept(channelKey: ChannelKey | 'announcements' | null): CommsDept {
  switch (channelKey) {
    case 'front_desk': return 'front_desk';
    case 'housekeeping': return 'housekeeping';
    case 'maintenance': return 'maintenance';
    default: return 'management'; // all_staff / announcements
  }
}

/**
 * Membership (display only — access is still gated by canAccessConversation):
 * managers (the 'management' bucket) are in every channel; dept staff are in
 * their own channel + all-staff; everyone is in all-staff + announcements.
 */
function staffInChannel(channelKey: ChannelKey, dept: CommsDept): boolean {
  if (channelKey === 'all_staff') return true;
  if (dept === 'management') return true;
  return channelKey === (dept as unknown as ChannelKey);
}

/** Online if the activity heartbeat landed within this window. */
const PRESENCE_WINDOW_MS = 150_000; // 2.5 min — generous vs the ~8s client poll

/** Channels a person can see. Managers see them all; staff see all-staff + their
 *  dept. Re-expressed on the shared dept-scope checker so channel visibility and
 *  future per-dept content access can never diverge. */
export function channelsVisibleTo(opts: { dept: string | null; isManager: boolean }): ChannelKey[] {
  const out: ChannelKey[] = ['all_staff'];
  for (const ch of ['front_desk', 'housekeeping', 'maintenance'] as const) {
    if (canReachDeptContent({ isManager: opts.isManager, staffDept: opts.dept }, ch)) out.push(ch);
  }
  return out;
}

// ── Staff helpers ───────────────────────────────────────────────────────────

export interface StaffRow { id: string; name: string; department: string | null; is_active: boolean | null; language: string | null }

export async function getStaffRow(pid: string, staffId: string): Promise<StaffRow | null> {
  const { data } = await supabaseAdmin
    .from('staff')
    .select('id, name, department, is_active, language')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  return (data as StaffRow | null) ?? null;
}

export async function listStaff(pid: string): Promise<StaffLite[]> {
  const { data } = await supabaseAdmin
    .from('staff')
    .select('id, name, department, is_active')
    .eq('property_id', pid)
    .order('name', { ascending: true });
  return ((data ?? []) as StaffRow[])
    .filter((s) => s.is_active !== false)
    .map((s) => ({
      id: s.id,
      name: s.name,
      department: s.department,
      channel: deptChannel(s.department) ?? 'all_staff',
    }));
}

async function staffNameMap(pid: string, ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const { data } = await supabaseAdmin
    .from('staff')
    .select('id, name')
    .eq('property_id', pid)
    .in('id', unique);
  return new Map(((data ?? []) as { id: string; name: string }[]).map((r) => [r.id, r.name]));
}

async function staffDeptMap(pid: string, ids: string[]): Promise<Map<string, string | null>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const { data } = await supabaseAdmin
    .from('staff')
    .select('id, department')
    .eq('property_id', pid)
    .in('id', unique);
  return new Map(((data ?? []) as { id: string; department: string | null }[]).map((r) => [r.id, r.department]));
}

/** Resolve an authenticated account → its staff identity + role for messaging. */
export async function resolveAccount(userId: string): Promise<{
  accountId: string; role: string; staffId: string | null; displayName: string;
  preferredLanguage: CommsLang; propertyAccess: string[];
} | null> {
  const { data } = await supabaseAdmin
    .from('accounts')
    .select('id, role, staff_id, display_name, preferred_language, property_access')
    .eq('data_user_id', userId)
    .maybeSingle();
  if (!data) return null;
  return {
    accountId: data.id as string,
    role: (data.role as string) ?? 'staff',
    staffId: (data.staff_id as string | null) ?? null,
    displayName: (data.display_name as string) ?? 'Manager',
    preferredLanguage: normalizeLang(data.preferred_language),
    propertyAccess: (data.property_access as string[] | null) ?? [],
  };
}

/** Coerce any stored value to a supported language, defaulting to English. */
export function normalizeLang(v: unknown): CommsLang {
  return v === 'es' || v === 'ht' || v === 'tl' || v === 'vi' ? v : 'en';
}

function deptFromRole(role: string): string {
  switch (role) {
    case 'front_desk': return 'front_desk';
    case 'maintenance': return 'maintenance';
    case 'housekeeping': return 'housekeeping';
    default: return 'other'; // admin / owner / general_manager / staff
  }
}

/**
 * Resolve an account's staff identity *within a property* for messaging.
 * Every messaging participant is a staff.id; this guarantees one exists for
 * the account in `pid` (managers included), self-healing across properties:
 *   1. account.staff_id, if it lives in this property
 *   2. an existing active staff row matching the account's display name
 *   3. otherwise create a minimal staff row (so messaging always works)
 * Never mutates the accounts row (avoids side effects elsewhere).
 */
export async function resolveStaffIdForAccount(
  pid: string,
  account: { accountId: string; role: string; staffId: string | null; displayName: string },
): Promise<string> {
  if (account.staffId) {
    const row = await getStaffRow(pid, account.staffId);
    if (row) return row.id;
  }
  const byName = await supabaseAdmin
    .from('staff')
    .select('id, is_active')
    .eq('property_id', pid)
    .ilike('name', account.displayName)
    .limit(1)
    .maybeSingle();
  if (byName.data?.id && byName.data.is_active !== false) return byName.data.id as string;

  const created = await supabaseAdmin
    .from('staff')
    .insert({
      property_id: pid,
      name: account.displayName,
      department: deptFromRole(account.role),
      is_active: true,
      language: 'en',
    })
    .select('id')
    .single();
  if (created.error) { log.error('resolveStaffIdForAccount: create failed', { err: created.error.message }); throw created.error; }
  return created.data.id as string;
}

// ── Conversation ensure/lookup ──────────────────────────────────────────────

export function canonicalDmKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export async function ensureChannelConversation(pid: string, channelKey: ChannelKey): Promise<string> {
  const existing = await supabaseAdmin
    .from('comms_conversations')
    .select('id')
    .eq('property_id', pid)
    .eq('channel_key', channelKey)
    .maybeSingle();
  if (existing.data?.id) return existing.data.id as string;
  const ins = await supabaseAdmin
    .from('comms_conversations')
    .insert({ property_id: pid, kind: 'channel', channel_key: channelKey, title: CHANNEL_LABELS[channelKey] })
    .select('id')
    .maybeSingle();
  if (ins.data?.id) return ins.data.id as string;
  // race: someone inserted between our select and insert → re-select
  const again = await supabaseAdmin
    .from('comms_conversations').select('id')
    .eq('property_id', pid).eq('channel_key', channelKey).maybeSingle();
  if (again.data?.id) return again.data.id as string;
  throw new Error('ensureChannelConversation failed');
}

export async function ensureAnnouncementConversation(pid: string): Promise<string> {
  const existing = await supabaseAdmin
    .from('comms_conversations')
    .select('id')
    .eq('property_id', pid)
    .eq('channel_key', 'announcements')
    .maybeSingle();
  if (existing.data?.id) return existing.data.id as string;
  const ins = await supabaseAdmin
    .from('comms_conversations')
    .insert({ property_id: pid, kind: 'announcement', channel_key: 'announcements', title: 'Announcements' })
    .select('id')
    .maybeSingle();
  if (ins.data?.id) return ins.data.id as string;
  const again = await supabaseAdmin
    .from('comms_conversations').select('id')
    .eq('property_id', pid).eq('channel_key', 'announcements').maybeSingle();
  if (again.data?.id) return again.data.id as string;
  throw new Error('ensureAnnouncementConversation failed');
}

/** Open (or create) a 1:1 DM between two staff in a property. Returns convo id. */
export async function ensureDmConversation(pid: string, staffA: string, staffB: string): Promise<string> {
  if (staffA === staffB) throw new Error('cannot DM yourself');
  const key = canonicalDmKey(staffA, staffB);
  const existing = await supabaseAdmin
    .from('comms_conversations').select('id')
    .eq('property_id', pid).eq('dm_key', key).maybeSingle();
  let convoId = existing.data?.id as string | undefined;
  if (!convoId) {
    const ins = await supabaseAdmin
      .from('comms_conversations')
      .insert({ property_id: pid, kind: 'dm', dm_key: key })
      .select('id')
      .maybeSingle();
    convoId = ins.data?.id as string | undefined;
    if (!convoId) {
      const again = await supabaseAdmin
        .from('comms_conversations').select('id')
        .eq('property_id', pid).eq('dm_key', key).maybeSingle();
      convoId = again.data?.id as string | undefined;
    }
  }
  if (!convoId) throw new Error('ensureDmConversation failed');
  // Ensure both member rows exist (read cursors).
  await supabaseAdmin
    .from('comms_members')
    .upsert(
      [
        { property_id: pid, conversation_id: convoId, staff_id: staffA },
        { property_id: pid, conversation_id: convoId, staff_id: staffB },
      ],
      { onConflict: 'conversation_id,staff_id', ignoreDuplicates: true },
    );
  return convoId;
}

export interface ConversationRow {
  id: string; property_id: string; kind: 'dm' | 'channel' | 'announcement';
  channel_key: string | null; dm_key: string | null; title: string | null;
  last_message_at: string | null;
}

export async function getConversation(pid: string, conversationId: string): Promise<ConversationRow | null> {
  const { data } = await supabaseAdmin
    .from('comms_conversations')
    .select('id, property_id, kind, channel_key, dm_key, title, last_message_at')
    .eq('id', conversationId)
    .eq('property_id', pid)
    .maybeSingle();
  return (data as ConversationRow | null) ?? null;
}

/** Is `staffId` allowed to read/write this conversation? */
export async function canAccessConversation(
  pid: string,
  staffId: string,
  convo: ConversationRow,
  ctx: { isManager: boolean; dept: string | null },
): Promise<boolean> {
  if (convo.property_id !== pid) return false;
  if (convo.kind === 'announcement') return true; // everyone can read announcements
  if (convo.kind === 'channel') {
    const visible = channelsVisibleTo({ dept: ctx.dept, isManager: ctx.isManager });
    return visible.includes(convo.channel_key as ChannelKey);
  }
  // DM: staffId must be one of the pair.
  if (!convo.dm_key) return false;
  return convo.dm_key.split(':').includes(staffId);
}

// ── Members / read cursors ──────────────────────────────────────────────────

async function ensureMemberRow(
  pid: string, conversationId: string, staffId: string, markReadNow: boolean,
): Promise<void> {
  const { data } = await supabaseAdmin
    .from('comms_members')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('staff_id', staffId)
    .maybeSingle();
  if (data?.id) return;
  await supabaseAdmin
    .from('comms_members')
    .upsert(
      {
        property_id: pid,
        conversation_id: conversationId,
        staff_id: staffId,
        last_read_at: markReadNow ? new Date().toISOString() : null,
      },
      { onConflict: 'conversation_id,staff_id', ignoreDuplicates: true },
    );
}

export async function markConversationRead(pid: string, conversationId: string, staffId: string): Promise<void> {
  const now = new Date().toISOString();
  const { data } = await supabaseAdmin
    .from('comms_members')
    .update({ last_read_at: now })
    .eq('conversation_id', conversationId)
    .eq('staff_id', staffId)
    .select('id')
    .maybeSingle();
  if (!data) {
    await supabaseAdmin.from('comms_members').upsert(
      { property_id: pid, conversation_id: conversationId, staff_id: staffId, last_read_at: now },
      { onConflict: 'conversation_id,staff_id', ignoreDuplicates: false },
    );
  }
}

// ── Posting ─────────────────────────────────────────────────────────────────

export interface PostMessageInput {
  senderStaffId: string | null;
  senderKind?: 'staff' | 'staxis' | 'system';
  body: string;
  sourceLang?: string | null;
  msgType?: MessageDTO['msgType'];
  attachmentPath?: string | null;
  attachmentKind?: 'photo' | 'voice' | null;
  voiceDurationMs?: number | null;
  handoffShift?: string | null;
  handoffOutstanding?: string | null;
  meta?: Record<string, unknown>;
  /** Announcements only: demand an explicit "I read & understand" from recipients. */
  requiresAck?: boolean;
  /** Set on the per-property copies of an org-wide mandatory-read campaign. */
  ackCampaignId?: string | null;
  /** A threaded reply → the top-level message it answers. null = top-level. */
  parentMessageId?: string | null;
}

export async function postMessage(
  pid: string, conversationId: string, input: PostMessageInput,
): Promise<{ id: string; createdAt: string }> {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('comms_messages')
    .insert({
      property_id: pid,
      conversation_id: conversationId,
      sender_staff_id: input.senderStaffId,
      sender_kind: input.senderKind ?? 'staff',
      body: input.body ?? '',
      source_lang: input.sourceLang ?? null,
      msg_type: input.msgType ?? 'text',
      attachment_path: input.attachmentPath ?? null,
      attachment_kind: input.attachmentKind ?? null,
      voice_duration_ms: input.voiceDurationMs ?? null,
      handoff_shift: input.handoffShift ?? null,
      handoff_outstanding: input.handoffOutstanding ?? null,
      meta: input.meta ?? {},
      requires_ack: input.requiresAck ?? false,
      ack_campaign_id: input.ackCampaignId ?? null,
      parent_message_id: input.parentMessageId ?? null,
      created_at: now,
    })
    .select('id, created_at')
    .single();
  if (error) { log.error('comms.postMessage failed', { err: error.message }); throw error; }
  // Bump conversation ordering + auto-mark the sender as caught-up.
  await supabaseAdmin
    .from('comms_conversations')
    .update({ last_message_at: now, updated_at: now })
    .eq('id', conversationId);
  if (input.senderStaffId) {
    await markConversationRead(pid, conversationId, input.senderStaffId);
  }
  return { id: data.id as string, createdAt: data.created_at as string };
}

// ── Reading: conversation list with unread counts ────────────────────────────

interface MessageRow {
  id: string; conversation_id: string; sender_staff_id: string | null; sender_kind: string;
  body: string; source_lang: string | null; msg_type: string; attachment_path: string | null;
  attachment_kind: string | null; voice_duration_ms: number | null; handoff_shift: string | null;
  handoff_outstanding: string | null; meta: Record<string, unknown> | null; created_at: string;
  requires_ack: boolean | null; ack_campaign_id: string | null;
  parent_message_id: string | null; pinned_at: string | null;
}

const MESSAGE_COLUMNS =
  'id, conversation_id, sender_staff_id, sender_kind, body, source_lang, msg_type, attachment_path, attachment_kind, voice_duration_ms, handoff_shift, handoff_outstanding, meta, created_at, requires_ack, ack_campaign_id, parent_message_id, pinned_at';

/**
 * List the conversations a staff member can see (DMs they're in + visible
 * channels + announcements), each with unread count + last-message preview.
 * `floorMode=true` (housekeeper view) hides channels — only DMs + announcements.
 */
export async function listConversationsForStaff(
  pid: string,
  staffId: string,
  ctx: { isManager: boolean; dept: string | null; floorMode: boolean },
): Promise<ConversationDTO[]> {
  // 1) Channels/announcement this person can see → ensure they exist + member cursor.
  const out: ConversationDTO[] = [];
  const memberCursor = new Map<string, string | null>(); // conversationId → last_read_at

  // member rows (DM membership + cursors)
  const { data: memberRows } = await supabaseAdmin
    .from('comms_members')
    .select('conversation_id, last_read_at')
    .eq('property_id', pid)
    .eq('staff_id', staffId);
  for (const m of (memberRows ?? []) as { conversation_id: string; last_read_at: string | null }[]) {
    memberCursor.set(m.conversation_id, m.last_read_at);
  }

  const convoIds: { id: string; kind: ConversationRow['kind']; channelKey: string | null; dmKey: string | null; title: string | null; lastAt: string | null }[] = [];

  // Announcements (everyone)
  const annId = await ensureAnnouncementConversation(pid);
  if (!memberCursor.has(annId)) { await ensureMemberRow(pid, annId, staffId, true); memberCursor.set(annId, new Date().toISOString()); }

  // Channels (skip in floor mode)
  const channelIds: string[] = [];
  if (!ctx.floorMode) {
    for (const ck of channelsVisibleTo({ dept: ctx.dept, isManager: ctx.isManager })) {
      const cid = await ensureChannelConversation(pid, ck);
      channelIds.push(cid);
      if (!memberCursor.has(cid)) { await ensureMemberRow(pid, cid, staffId, true); memberCursor.set(cid, new Date().toISOString()); }
    }
  }

  // Pull the conversation rows for: announcement + channels + DMs the member is in.
  const dmConvoIds = Array.from(memberCursor.keys()).filter((id) => id !== annId && !channelIds.includes(id));
  const allIds = Array.from(new Set([annId, ...channelIds, ...dmConvoIds]));
  if (allIds.length === 0) return out;
  const { data: convoRows } = await supabaseAdmin
    .from('comms_conversations')
    .select('id, kind, channel_key, dm_key, title, last_message_at')
    .eq('property_id', pid)
    .in('id', allIds);
  for (const c of (convoRows ?? []) as ConversationRow[]) {
    convoIds.push({ id: c.id, kind: c.kind, channelKey: c.channel_key, dmKey: c.dm_key, title: c.title, lastAt: c.last_message_at });
  }

  // Resolve DM partner names.
  const dmPartnerIds: string[] = [];
  for (const c of convoIds) {
    if (c.kind === 'dm' && c.dmKey) {
      const [a, b] = c.dmKey.split(':');
      dmPartnerIds.push(a === staffId ? b : a);
    }
  }
  const nameMap = await staffNameMap(pid, dmPartnerIds);
  const partnerDeptMap = await staffDeptMap(pid, dmPartnerIds);

  // For each conversation, compute unread + last preview.
  for (const c of convoIds) {
    const lastRead = memberCursor.get(c.id) ?? null;
    // Last message preview (most recent).
    const { data: lastMsgRows } = await supabaseAdmin
      .from('comms_messages')
      .select('body, msg_type, created_at, sender_staff_id')
      .eq('conversation_id', c.id)
      .order('created_at', { ascending: false })
      .limit(1);
    const lastMsg = (lastMsgRows ?? [])[0] as { body: string; msg_type: string; created_at: string; sender_staff_id: string | null } | undefined;

    // Unread: messages after my cursor not authored by me.
    let unread = 0;
    if (lastMsg && (!lastRead || lastMsg.created_at > lastRead)) {
      let q = supabaseAdmin
        .from('comms_messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', c.id)
        // NULL-safe "not authored by me": PostgREST .neq drops NULL rows
        // (three-valued logic), so @Staxis/system messages (sender_staff_id
        // null) never lit the unread badge for other members. (Audit fix 2026-06-18.)
        .or(`sender_staff_id.is.null,sender_staff_id.neq.${staffId}`);
      if (lastRead) q = q.gt('created_at', lastRead);
      const { count } = await q;
      unread = count ?? 0;
    }

    let title = c.title ?? 'Conversation';
    let otherStaffId: string | null = null;
    let dept: CommsDept = channelDept(c.channelKey as ConversationDTO['channelKey']);
    if (c.kind === 'dm' && c.dmKey) {
      const [a, b] = c.dmKey.split(':');
      otherStaffId = a === staffId ? b : a;
      title = nameMap.get(otherStaffId) ?? 'Teammate';
      dept = commsDeptOf(partnerDeptMap.get(otherStaffId));
    } else if (c.kind === 'announcement') {
      title = 'Announcements';
    } else if (c.kind === 'channel' && c.channelKey) {
      title = CHANNEL_LABELS[c.channelKey as ChannelKey] ?? c.channelKey;
    }

    // Require-ack announcements keep demanding attention until the reader has
    // explicitly acknowledged — distinct from passive last_read_at "seen".
    const pendingAck = c.kind === 'announcement'
      ? await pendingAcksForStaff(pid, c.id, staffId)
      : 0;

    out.push({
      id: c.id,
      kind: c.kind,
      channelKey: (c.channelKey as ConversationDTO['channelKey']) ?? null,
      title,
      lastMessageAt: c.lastAt,
      lastMessagePreview: lastMsg ? previewOf(lastMsg.body, lastMsg.msg_type) : null,
      unread,
      pendingAck,
      otherStaffId,
      dept,
    });
  }

  // Sort: anything needing attention (unread OR a pending acknowledgement)
  // first, then most recent activity.
  const needsAttention = (c: ConversationDTO) => (c.unread > 0 || (c.pendingAck ?? 0) > 0) ? 1 : 0;
  out.sort((x, y) => {
    if (needsAttention(y) !== needsAttention(x)) return needsAttention(y) - needsAttention(x);
    return (y.lastMessageAt ?? '').localeCompare(x.lastMessageAt ?? '');
  });
  return out;
}

/**
 * Count require-ack announcements in a conversation that `staffId` has NOT yet
 * acknowledged (never counting the author's own posts). Used to keep a
 * mandatory read lit in the unread/badge logic even after last_read_at clears
 * the passive unread count.
 */
async function pendingAcksForStaff(pid: string, conversationId: string, staffId: string): Promise<number> {
  // You only owe announcements posted at/after you joined (point-in-time bound,
  // server-side so it survives any timestamp formatting).
  const { data: meRow } = await supabaseAdmin
    .from('staff').select('created_at').eq('id', staffId).maybeSingle();
  const since = (meRow?.created_at as string | null) ?? null;

  let q = supabaseAdmin
    .from('comms_messages')
    .select('id, sender_staff_id')
    .eq('property_id', pid)
    .eq('conversation_id', conversationId)
    .eq('requires_ack', true)
    .order('created_at', { ascending: false }) // deterministic newest-first under the cap
    .limit(500);
  if (since) q = q.gte('created_at', since);
  const { data: reqRows } = await q;

  // Author-exclusion via JS filter (NOT .neq) so org-wide posts — which have a
  // null per-property author — are still counted for everyone.
  const required = ((reqRows ?? []) as { id: string; sender_staff_id: string | null }[])
    .filter((r) => r.sender_staff_id !== staffId);
  if (required.length === 0) return 0;
  const ids = required.map((r) => r.id);
  const { data: ackRows } = await supabaseAdmin
    .from('comms_acknowledgements')
    .select('message_id')
    .eq('staff_id', staffId)
    .in('message_id', ids);
  const acked = new Set(((ackRows ?? []) as { message_id: string }[]).map((r) => r.message_id));
  return required.reduce((n, r) => n + (acked.has(r.id) ? 0 : 1), 0);
}

function previewOf(body: string, msgType: string): string {
  if (msgType === 'photo') return '📷 Photo';
  if (msgType === 'voice') return '🎤 Voice message';
  const t = (body ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 80 ? t.slice(0, 80) + '…' : t;
}

/** Total unread across all visible conversations (for the nav badge / dashboard tile). */
export async function totalUnread(
  pid: string, staffId: string, ctx: { isManager: boolean; dept: string | null; floorMode: boolean },
): Promise<number> {
  const convos = await listConversationsForStaff(pid, staffId, ctx);
  // max(): a fully-read-but-unacked required announcement (unread=0, pendingAck>0)
  // still lights the badge, without double-counting a brand-new one.
  return convos.reduce((sum, c) => sum + Math.max(c.unread, c.pendingAck ?? 0), 0);
}

// ── Reading: messages in a conversation (translated for the reader) ──────────

export async function getMessages(
  pid: string,
  conversationId: string,
  readerStaffId: string,
  readerLang: CommsLang,
  opts: { limit?: number; withReceipts?: boolean } = {},
): Promise<MessageDTO[]> {
  const limit = Math.min(opts.limit ?? 80, 200);
  const { data } = await supabaseAdmin
    .from('comms_messages')
    .select(MESSAGE_COLUMNS)
    .eq('conversation_id', conversationId)
    .eq('property_id', pid)
    .is('parent_message_id', null) // top-level only; replies live in the thread panel
    .order('created_at', { ascending: false })
    .limit(limit);
  const rows = ((data ?? []) as unknown as MessageRow[]).reverse(); // chronological
  if (rows.length === 0) return [];

  // ── Require-ack reachability + the reader's own ack state ───────────────────
  // The badge counts unacked required announcements across the whole feed, but
  // this window is only the newest `limit`. If the window is full, a pending
  // mandatory read could be older than it — pull those in so the "I read &
  // understand" button is always rendered (never a stuck, un-clearable badge).
  const windowIds = new Set(rows.map((r) => r.id));
  let ackedByReader = new Set<string>();
  if (rows.length >= limit) {
    // Possibly-truncated window → scan the whole conversation for required msgs.
    const { data: reqRows } = await supabaseAdmin
      .from('comms_messages')
      .select('id')
      .eq('property_id', pid)
      .eq('conversation_id', conversationId)
      .eq('requires_ack', true)
      .order('created_at', { ascending: false })
      .limit(500);
    const allRequiredIds = ((reqRows ?? []) as { id: string }[]).map((r) => r.id);
    if (allRequiredIds.length > 0) {
      const { data: ackRows } = await supabaseAdmin
        .from('comms_acknowledgements')
        .select('message_id')
        .eq('staff_id', readerStaffId)
        .in('message_id', allRequiredIds);
      ackedByReader = new Set(((ackRows ?? []) as { message_id: string }[]).map((r) => r.message_id));
      const missingIds = allRequiredIds.filter((id) => !ackedByReader.has(id) && !windowIds.has(id));
      if (missingIds.length > 0) {
        const { data: extra } = await supabaseAdmin
          .from('comms_messages')
          .select(MESSAGE_COLUMNS)
          .in('id', missingIds);
        rows.push(...((extra ?? []) as unknown as MessageRow[]));
        rows.sort((a, b) => a.created_at.localeCompare(b.created_at)); // chronological
      }
    }
  } else {
    // Window holds the whole conversation → just look up acks for in-window reqs.
    const requiredIds = rows.filter((r) => r.requires_ack).map((r) => r.id);
    if (requiredIds.length > 0) {
      const { data: ackRows } = await supabaseAdmin
        .from('comms_acknowledgements')
        .select('message_id')
        .eq('staff_id', readerStaffId)
        .in('message_id', requiredIds);
      ackedByReader = new Set(((ackRows ?? []) as { message_id: string }[]).map((r) => r.message_id));
    }
  }

  // The reader's own start date — used to tell whether they actually OWE each
  // require-ack announcement (a pre-tenure read isn't theirs to confirm, and its
  // ack wouldn't count in the tracker anyway). Only fetched when relevant.
  const hasRequired = rows.some((r) => r.requires_ack);
  let readerCreatedAt: string | null = null;
  if (hasRequired) {
    const { data: meRow } = await supabaseAdmin
      .from('staff').select('created_at').eq('id', readerStaffId).maybeSingle();
    readerCreatedAt = (meRow?.created_at as string | null) ?? null;
  }

  // Translate bodies into the reader's language (cache-first, best-effort).
  const translated = await translateMessagesForReader(
    rows.map((r) => ({ id: r.id, body: r.body, source_lang: r.source_lang })),
    readerLang,
  );

  // Resolve sender names.
  const senderIds = rows.map((r) => r.sender_staff_id).filter((x): x is string => !!x);
  const nameMap = await staffNameMap(pid, senderIds);

  // Signed URLs for attachments.
  const urlByPath = new Map<string, string>();
  for (const r of rows) {
    if (r.attachment_path && !urlByPath.has(r.attachment_path)) {
      const url = await attachmentSignedUrl(r.attachment_path);
      if (url) urlByPath.set(r.attachment_path, url);
    }
  }

  // Read receipts (optional, for the reader's own messages): who has seen each.
  let receiptsByTime: { staffId: string; name: string; lastReadAt: string }[] = [];
  if (opts.withReceipts) {
    const { data: members } = await supabaseAdmin
      .from('comms_members')
      .select('staff_id, last_read_at')
      .eq('conversation_id', conversationId)
      .not('last_read_at', 'is', null);
    const memberIds = ((members ?? []) as { staff_id: string; last_read_at: string }[]).map((m) => m.staff_id);
    const memberNames = await staffNameMap(pid, memberIds);
    receiptsByTime = ((members ?? []) as { staff_id: string; last_read_at: string }[])
      .filter((m) => m.staff_id !== readerStaffId)
      .map((m) => ({ staffId: m.staff_id, name: memberNames.get(m.staff_id) ?? 'Teammate', lastReadAt: m.last_read_at }));
  }

  // Threaded-reply rollups (count / last reply / first few authors) + ✓ reactions.
  const ids = rows.map((r) => r.id);
  const replyRollup = await replyRollupsFor(ids);
  const reactionRollup = await reactionsFor(ids, readerStaffId);

  return rows.map((r) => {
    const original = r.body;
    const body = translated.get(r.id) ?? r.body;
    const mine = r.sender_staff_id === readerStaffId;
    const dto: MessageDTO = {
      id: r.id,
      conversationId: r.conversation_id,
      senderStaffId: r.sender_staff_id,
      senderKind: r.sender_kind as MessageDTO['senderKind'],
      senderName: r.sender_kind === 'staxis' ? 'Staxis' : (r.sender_staff_id ? (nameMap.get(r.sender_staff_id) ?? 'Teammate') : 'System'),
      body,
      originalBody: original,
      sourceLang: r.source_lang,
      wasTranslated: body !== original,
      msgType: r.msg_type as MessageDTO['msgType'],
      attachmentKind: (r.attachment_kind as 'photo' | 'voice' | null) ?? null,
      attachmentUrl: r.attachment_path ? (urlByPath.get(r.attachment_path) ?? null) : null,
      voiceDurationMs: r.voice_duration_ms,
      handoffShift: r.handoff_shift,
      handoffOutstanding: r.handoff_outstanding,
      meta: r.meta ?? {},
      createdAt: r.created_at,
      mine,
      requiresAck: !!r.requires_ack,
      // The reader owes it iff it's required, not their own post, and it was
      // posted at/after they joined (matches the tracker's recipient rule).
      mustAck: !!r.requires_ack && !mine && (!readerCreatedAt || readerCreatedAt <= r.created_at),
      acked: r.requires_ack ? ackedByReader.has(r.id) : false,
      ackCampaignId: (r.ack_campaign_id as string | null) ?? null,
      parentMessageId: null,
      replyCount: replyRollup.get(r.id)?.count ?? 0,
      lastReplyAt: replyRollup.get(r.id)?.lastAt ?? null,
      replyAuthorIds: replyRollup.get(r.id)?.authorIds ?? [],
      pinned: !!r.pinned_at,
      ackCount: reactionRollup.get(r.id)?.count ?? 0,
      ackedByMe: reactionRollup.get(r.id)?.mine ?? false,
    };
    if (opts.withReceipts && mine) {
      dto.seenBy = receiptsByTime
        .filter((m) => m.lastReadAt >= r.created_at)
        .map((m) => ({ staffId: m.staffId, name: m.name }));
    }
    return dto;
  });
}

/** Recent messages (original text + sender name) as context for @Staxis. */
export async function getThreadForAssistant(
  pid: string, conversationId: string, limit = 25,
): Promise<{ sender: string; body: string }[]> {
  const { data } = await supabaseAdmin
    .from('comms_messages')
    .select('sender_staff_id, sender_kind, body')
    .eq('conversation_id', conversationId)
    .eq('property_id', pid)
    .order('created_at', { ascending: false })
    .limit(limit);
  const rows = ((data ?? []) as { sender_staff_id: string | null; sender_kind: string; body: string }[]).reverse();
  const ids = rows.map((r) => r.sender_staff_id).filter((x): x is string => !!x);
  const names = await staffNameMap(pid, ids);
  return rows
    .filter((r) => r.body && r.body.trim())
    .map((r) => ({
      sender: r.sender_kind === 'staxis' ? 'Staxis' : (r.sender_staff_id ? (names.get(r.sender_staff_id) ?? 'Teammate') : 'System'),
      body: r.body,
    }));
}

/** Gather a staff member's unread messages across conversations (for "what did I miss"). */
export async function getUnreadDigest(
  pid: string, staffId: string, ctx: { isManager: boolean; dept: string | null; floorMode: boolean },
): Promise<{ sender: string; body: string }[]> {
  const convos = (await listConversationsForStaff(pid, staffId, ctx)).filter((c) => c.unread > 0).slice(0, 10);
  const out: { sender: string; body: string }[] = [];
  for (const c of convos) {
    const { data: m } = await supabaseAdmin
      .from('comms_members').select('last_read_at')
      .eq('conversation_id', c.id).eq('staff_id', staffId).maybeSingle();
    const lastRead = (m?.last_read_at as string | null) ?? null;
    let q = supabaseAdmin
      .from('comms_messages')
      .select('sender_staff_id, body, created_at')
      .eq('conversation_id', c.id).eq('property_id', pid)
      // NULL-safe "not authored by me" — see listConversationsForStaff. .neq
      // would drop @Staxis/system (null-sender) messages from the digest.
      .or(`sender_staff_id.is.null,sender_staff_id.neq.${staffId}`)
      .order('created_at', { ascending: true }).limit(25);
    if (lastRead) q = q.gt('created_at', lastRead);
    const { data } = await q;
    const rows = (data ?? []) as { sender_staff_id: string | null; body: string }[];
    const ids = rows.map((r) => r.sender_staff_id).filter((x): x is string => !!x);
    const names = await staffNameMap(pid, ids);
    for (const r of rows) {
      if (!r.body || !r.body.trim()) continue;
      out.push({ sender: `[${c.title}] ${r.sender_staff_id ? (names.get(r.sender_staff_id) ?? 'Teammate') : 'System'}`, body: r.body });
      if (out.length >= 80) return out;
    }
  }
  return out;
}

export async function attachmentSignedUrl(path: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin.storage.from(ATTACHMENT_BUCKET).createSignedUrl(path, SIGNED_URL_TTL);
    return data?.signedUrl ?? null;
  } catch {
    return null;
  }
}

// ── Announcements (the ONE broadcast path; mirrors to legacy notice banner) ──

/**
 * Post an announcement to the property's announcement feed AND mirror it to
 * housekeeping_notices so the existing housekeeper notice banner keeps working
 * (one broadcast, two surfaces). `bodyEn`/`bodyEs` feed the legacy banner.
 */
export async function postAnnouncement(
  pid: string,
  opts: {
    body: string; sourceLang: string; senderStaffId: string | null;
    senderAccountId: string | null; bodyEs?: string | null;
    requiresAck?: boolean; ackCampaignId?: string | null;
  },
): Promise<{ id: string }> {
  const convoId = await ensureAnnouncementConversation(pid);
  const msg = await postMessage(pid, convoId, {
    senderStaffId: opts.senderStaffId,
    senderKind: 'staff',
    body: opts.body,
    sourceLang: opts.sourceLang,
    msgType: 'announcement',
    requiresAck: opts.requiresAck ?? false,
    ackCampaignId: opts.ackCampaignId ?? null,
  });
  // Mirror to the legacy housekeeping_notices banner (best-effort).
  try {
    await supabaseAdmin.rpc('staxis_post_notice', {
      p_property_id: pid,
      p_body_en: opts.body,
      p_body_es: opts.bodyEs ?? null,
      p_body_ht: null,
      p_body_tl: null,
      p_body_vi: null,
      p_pinned: false,
      p_expires_at: null,
      p_posted_by_account_id: opts.senderAccountId,
    });
  } catch (e) {
    log.warn('postAnnouncement: notice mirror failed (non-fatal)', {
      err: e instanceof Error ? e.message : String(e),
    });
  }
  return { id: msg.id };
}

// ── Require-acknowledgement: hard read-confirm + manager tracker + campaigns ──
//
// A require-ack announcement (requires_ack=true) demands an explicit
// "I read & understand" from every recipient — distinct from the passive
// last_read_at "seen" receipt. The set of people expected to acknowledge is the
// property's CURRENT active staff roster, minus the author (a manager never has
// to ack their own post). An org-wide blast posts one announcement copy per
// property under a single comms_ack_campaigns row so completion aggregates
// across properties.

/**
 * Active staff expected to acknowledge a required announcement: the active roster
 * minus the author, bounded to people already employed when it was posted
 * (`created_at <= postedAt`). The point-in-time bound means a new hire never
 * retroactively "owes" an old mandatory read and a campaign that read "12 of 12"
 * doesn't silently regress to "12 of 13" the next time someone is hired.
 */
async function getActiveAckRecipients(
  pid: string, excludeStaffId: string | null, postedAt: string,
): Promise<{ id: string; name: string }[]> {
  const { data } = await supabaseAdmin
    .from('staff')
    .select('id, name, is_active, created_at')
    .eq('property_id', pid)
    .lte('created_at', postedAt)
    .order('name', { ascending: true });
  return ((data ?? []) as { id: string; name: string; is_active: boolean | null }[])
    .filter((s) => s.is_active !== false && s.id !== excludeStaffId)
    .map((s) => ({ id: s.id, name: s.name }));
}

/** Create the grouping row for an org-wide mandatory-read blast. Returns its id. */
export async function createAckCampaign(accountId: string | null, title: string | null): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('comms_ack_campaigns')
    .insert({ created_by_account: accountId, title: title ? title.slice(0, 200) : null })
    .select('id')
    .single();
  if (error) { log.error('createAckCampaign failed', { err: error.message }); throw error; }
  return data.id as string;
}

export interface AckMessageRow {
  id: string; property_id: string; conversation_id: string;
  sender_staff_id: string | null; requires_ack: boolean | null; ack_campaign_id: string | null;
  created_at: string;
}

/** Fetch an announcement message scoped to `pid` (null if it isn't in this property). */
export async function getAckMessage(pid: string, messageId: string): Promise<AckMessageRow | null> {
  const { data } = await supabaseAdmin
    .from('comms_messages')
    .select('id, property_id, conversation_id, sender_staff_id, requires_ack, ack_campaign_id, created_at')
    .eq('id', messageId)
    .eq('property_id', pid)
    .maybeSingle();
  return (data as AckMessageRow | null) ?? null;
}

/**
 * Record `staffId`'s acknowledgement of a require-ack announcement. Idempotent:
 * the unique(message_id, staff_id) constraint means a double-tap / replay can
 * never double-count — a unique violation is reported back as `already: true`.
 */
export async function acknowledgeMessage(
  pid: string, messageId: string, staffId: string,
): Promise<{ ok: boolean; already: boolean; reason?: 'not_found' | 'not_required' }> {
  const msg = await getAckMessage(pid, messageId);
  if (!msg) return { ok: false, already: false, reason: 'not_found' };
  if (!msg.requires_ack) return { ok: false, already: false, reason: 'not_required' };

  const { error } = await supabaseAdmin
    .from('comms_acknowledgements')
    .insert({ message_id: messageId, property_id: pid, staff_id: staffId });
  if (error) {
    // 23505 = unique_violation → this person already acknowledged. Idempotent success.
    if ((error as { code?: string }).code === '23505') return { ok: true, already: true };
    log.error('acknowledgeMessage failed', { err: error.message });
    throw error;
  }
  return { ok: true, already: false };
}

/**
 * Live who-has / who-hasn't tracker for one require-ack announcement.
 * Denominator = the property's current active roster minus the author, so
 * "X of Y" is always coherent (X ≤ Y). Manager-gated at the route layer.
 */
export async function getAckStatus(pid: string, messageId: string): Promise<AckStatusDTO | null> {
  const msg = await getAckMessage(pid, messageId);
  if (!msg) return null;

  const recipients = await getActiveAckRecipients(pid, msg.sender_staff_id, msg.created_at);
  const { data: ackRows } = await supabaseAdmin
    .from('comms_acknowledgements')
    .select('staff_id, acknowledged_at')
    .eq('message_id', messageId);
  const ackMap = new Map(
    ((ackRows ?? []) as { staff_id: string; acknowledged_at: string }[]).map((r) => [r.staff_id, r.acknowledged_at]),
  );

  const ackedList: { staffId: string; name: string; at: string }[] = [];
  const pending: { staffId: string; name: string }[] = [];
  for (const r of recipients) {
    const at = ackMap.get(r.id);
    if (at) ackedList.push({ staffId: r.id, name: r.name, at });
    else pending.push({ staffId: r.id, name: r.name });
  }
  ackedList.sort((a, b) => a.at.localeCompare(b.at));

  return {
    messageId,
    requiresAck: !!msg.requires_ack,
    total: recipients.length,
    acked: ackedList.length,
    ackedList,
    pending,
    campaignId: msg.ack_campaign_id ?? null,
  };
}

/**
 * Aggregate completion of an org-wide mandatory-read campaign across the
 * properties the caller is allowed to see. Each property's copy contributes its
 * own active-roster denominator; the totals sum across properties.
 */
export async function getCampaignStatus(
  campaignId: string, allowedPropertyIds: string[],
): Promise<CampaignStatusDTO | null> {
  const { data: campaign } = await supabaseAdmin
    .from('comms_ack_campaigns')
    .select('id, title')
    .eq('id', campaignId)
    .maybeSingle();
  if (!campaign) return null;

  const title = (campaign.title as string | null) ?? null;
  // No accessible properties at all → treat as not-found (don't even leak the title).
  if (allowedPropertyIds.length === 0) return null;

  // Only this campaign's copies that live in a property the caller may see —
  // never leak acknowledgement data from a hotel they don't have access to.
  const { data: msgRows } = await supabaseAdmin
    .from('comms_messages')
    .select('id, property_id, sender_staff_id, created_at')
    .eq('ack_campaign_id', campaignId)
    .in('property_id', allowedPropertyIds);
  const msgs = (msgRows ?? []) as { id: string; property_id: string; sender_staff_id: string | null; created_at: string }[];
  // None of this campaign's copies are in the caller's scope → not-found, so a
  // guessed campaignId can never surface another tenant's title or breakdown.
  if (msgs.length === 0) return null;

  const propIds = Array.from(new Set(msgs.map((m) => m.property_id)));
  const { data: propRows } = propIds.length
    ? await supabaseAdmin.from('properties').select('id, name').in('id', propIds)
    : { data: [] as { id: string; name: string | null }[] };
  const propName = new Map(
    ((propRows ?? []) as { id: string; name: string | null }[]).map((p) => [p.id, p.name ?? 'Property']),
  );

  // Per-property completion, fetched concurrently (one roster + one ack query each).
  const properties = await Promise.all(msgs.map(async (m): Promise<CampaignStatusDTO['properties'][number]> => {
    const recipients = await getActiveAckRecipients(m.property_id, m.sender_staff_id, m.created_at);
    const recipientIds = new Set(recipients.map((r) => r.id));
    const { data: ackRows } = await supabaseAdmin
      .from('comms_acknowledgements')
      .select('staff_id')
      .eq('message_id', m.id);
    const ackedHere = ((ackRows ?? []) as { staff_id: string }[])
      .filter((a) => recipientIds.has(a.staff_id)).length;
    return {
      propertyId: m.property_id,
      propertyName: propName.get(m.property_id) ?? 'Property',
      messageId: m.id,
      total: recipients.length,
      acked: ackedHere,
    };
  }));
  properties.sort((a, b) => a.propertyName.localeCompare(b.propertyName));

  const total = properties.reduce((s, p) => s + p.total, 0);
  const acked = properties.reduce((s, p) => s + p.acked, 0);
  return { campaignId, title, total, acked, properties };
}

// ── To-do list ──────────────────────────────────────────────────────────────

export async function createTask(
  pid: string,
  input: {
    title: string; notes?: string | null; assignedStaffId?: string | null;
    assignedDepartment?: string | null; dueAt?: string | null;
    priority?: 'normal' | 'high' | 'urgent';
    createdByStaffId?: string | null; sourceMessageId?: string | null;
  },
): Promise<{ id: string }> {
  const { data, error } = await supabaseAdmin
    .from('comms_tasks')
    .insert({
      property_id: pid,
      title: input.title,
      notes: input.notes ?? null,
      assigned_staff_id: input.assignedStaffId ?? null,
      assigned_department: input.assignedDepartment ?? null,
      due_at: input.dueAt ?? null,
      priority: input.priority ?? 'normal',
      created_by_staff_id: input.createdByStaffId ?? null,
      source_message_id: input.sourceMessageId ?? null,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { id: data.id as string };
}

export async function listTasks(pid: string): Promise<TaskDTO[]> {
  const { data } = await supabaseAdmin
    .from('comms_tasks')
    .select('*')
    .eq('property_id', pid)
    .order('status', { ascending: true })
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(300);
  const rows = (data ?? []) as Record<string, unknown>[];
  const assigneeIds = rows.map((r) => r.assigned_staff_id as string | null).filter((x): x is string => !!x);
  const nameMap = await staffNameMap(pid, assigneeIds);
  const PRIO_WEIGHT: Record<string, number> = { urgent: 0, high: 1, normal: 2 };
  const out = rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    notes: (r.notes as string | null) ?? null,
    assignedStaffId: (r.assigned_staff_id as string | null) ?? null,
    assignedStaffName: r.assigned_staff_id ? (nameMap.get(r.assigned_staff_id as string) ?? null) : null,
    assignedDepartment: (r.assigned_department as string | null) ?? null,
    dueAt: (r.due_at as string | null) ?? null,
    status: (r.status as 'open' | 'done'),
    priority: ((r.priority as string | null) ?? 'normal') as 'normal' | 'high' | 'urgent',
    createdByStaffId: (r.created_by_staff_id as string | null) ?? null,
    sourceMessageId: (r.source_message_id as string | null) ?? null,
    completedAt: (r.completed_at as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
  // Stable urgency sort within the existing status/due ordering: urgent → high → normal.
  return out
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      if ((a.t.status === 'done') !== (b.t.status === 'done')) return a.t.status === 'done' ? 1 : -1;
      const pw = PRIO_WEIGHT[a.t.priority] - PRIO_WEIGHT[b.t.priority];
      return pw !== 0 ? pw : a.i - b.i;
    })
    .map(({ t }) => t);
}

export async function setTaskStatus(
  pid: string, taskId: string, status: 'open' | 'done', byStaffId: string | null,
): Promise<boolean> {
  const patch = status === 'done'
    ? { status, completed_at: new Date().toISOString(), completed_by_staff_id: byStaffId, updated_at: new Date().toISOString() }
    : { status, completed_at: null, completed_by_staff_id: null, updated_at: new Date().toISOString() };
  const { data } = await supabaseAdmin
    .from('comms_tasks')
    .update(patch)
    .eq('id', taskId)
    .eq('property_id', pid)
    .select('id')
    .maybeSingle();
  return !!data;
}

/** Delete a to-do. Creators can delete their own; managers can delete any. */
export async function deleteTask(
  pid: string, taskId: string, byStaffId: string | null, allowAny: boolean,
): Promise<boolean> {
  let q = supabaseAdmin.from('comms_tasks').delete().eq('id', taskId).eq('property_id', pid);
  if (!allowAny && byStaffId) q = q.eq('created_by_staff_id', byStaffId);
  const { data } = await q.select('id').maybeSingle();
  return !!data;
}

// ── Shift Log Book (recaps + threaded replies) ───────────────────────────────

const LOG_CATEGORIES = new Set(['front_desk', 'housekeeping', 'maintenance', 'general']);

export async function createLogEntry(
  pid: string,
  input: { authorStaffId?: string | null; title: string; body?: string | null; category?: string | null },
): Promise<{ id: string }> {
  const category = input.category && LOG_CATEGORIES.has(input.category) ? input.category : null;
  const { data, error } = await supabaseAdmin
    .from('comms_log_entries')
    .insert({
      property_id: pid,
      author_staff_id: input.authorStaffId ?? null,
      title: input.title,
      body: input.body ?? '',
      category,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { id: data.id as string };
}

export async function listLogEntries(pid: string): Promise<LogEntryDTO[]> {
  const { data } = await supabaseAdmin
    .from('comms_log_entries')
    .select('*')
    .eq('property_id', pid)
    .order('created_at', { ascending: false })
    .limit(200);
  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id as string);
  // Reply counts — one scoped read, tallied in JS (entry page is small).
  const { data: replyRows } = await supabaseAdmin
    .from('comms_log_replies')
    .select('entry_id')
    .eq('property_id', pid)
    .in('entry_id', ids);
  const counts = new Map<string, number>();
  for (const r of (replyRows ?? []) as { entry_id: string }[]) {
    counts.set(r.entry_id, (counts.get(r.entry_id) ?? 0) + 1);
  }

  const authorIds = rows.map((r) => r.author_staff_id as string | null).filter((x): x is string => !!x);
  const nameMap = await staffNameMap(pid, authorIds);

  return rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    body: (r.body as string | null) ?? '',
    category: (r.category as string | null) ?? null,
    authorStaffId: (r.author_staff_id as string | null) ?? null,
    authorName: r.author_staff_id ? (nameMap.get(r.author_staff_id as string) ?? null) : null,
    replyCount: counts.get(r.id as string) ?? 0,
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string | null) ?? (r.created_at as string),
  }));
}

/** Confirm a recap exists in THIS property (cross-tenant write guard for replies). */
async function logEntryInProperty(pid: string, entryId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('comms_log_entries')
    .select('id')
    .eq('id', entryId)
    .eq('property_id', pid)
    .maybeSingle();
  return !!data;
}

export async function listLogReplies(pid: string, entryId: string): Promise<LogReplyDTO[]> {
  const { data } = await supabaseAdmin
    .from('comms_log_replies')
    .select('*')
    .eq('property_id', pid)
    .eq('entry_id', entryId)
    .order('created_at', { ascending: true })
    .limit(500);
  const rows = (data ?? []) as Record<string, unknown>[];
  const authorIds = rows.map((r) => r.author_staff_id as string | null).filter((x): x is string => !!x);
  const nameMap = await staffNameMap(pid, authorIds);
  return rows.map((r) => ({
    id: r.id as string,
    entryId: r.entry_id as string,
    body: r.body as string,
    authorStaffId: (r.author_staff_id as string | null) ?? null,
    authorName: r.author_staff_id ? (nameMap.get(r.author_staff_id as string) ?? null) : null,
    createdAt: r.created_at as string,
  }));
}

/**
 * Post a reply to a recap. Returns null when the recap isn't in this property
 * (the route maps that to a 404) so a caller can't attach replies to another
 * hotel's log by guessing an entry id.
 */
export async function createLogReply(
  pid: string,
  entryId: string,
  input: { authorStaffId?: string | null; body: string },
): Promise<{ id: string } | null> {
  if (!(await logEntryInProperty(pid, entryId))) return null;
  const { data, error } = await supabaseAdmin
    .from('comms_log_replies')
    .insert({
      property_id: pid,
      entry_id: entryId,
      author_staff_id: input.authorStaffId ?? null,
      body: input.body,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { id: data.id as string };
}

// ── Message → action (reuse the work-order + complaint creation paths) ──────

function mapWorkOrderSeverity(s: string | null | undefined): string {
  const v = (s ?? '').toLowerCase();
  if (v === 'urgent' || v === 'high') return 'urgent';
  if (v === 'low') return 'low';
  return 'medium';
}

export async function createWorkOrderForComms(
  pid: string,
  input: { roomNumber?: string | null; description: string; severity?: string | null; byName: string },
): Promise<{ id: string }> {
  const { data, error } = await supabaseAdmin
    .from('work_orders')
    .insert({
      property_id: pid,
      room_number: (input.roomNumber && input.roomNumber.trim()) || 'Unknown',
      description: input.description.slice(0, 1000),
      severity: mapWorkOrderSeverity(input.severity),
      status: 'submitted',
      submitted_by_name: input.byName.slice(0, 120),
    })
    .select('id')
    .single();
  if (error) { log.error('createWorkOrderForComms failed', { err: error.message }); throw error; }
  return { id: data.id as string };
}

function mapComplaintSeverity(s: string | null | undefined): string {
  const v = (s ?? '').toLowerCase();
  if (v === 'high' || v === 'urgent') return 'high';
  if (v === 'low') return 'low';
  return 'medium';
}

export async function createComplaintForComms(
  pid: string,
  input: { guestName?: string | null; roomNumber?: string | null; description: string; severity?: string | null; category?: string | null; byName: string },
): Promise<{ id: string }> {
  const { data, error } = await supabaseAdmin
    .from('complaints')
    .insert({
      property_id: pid,
      guest_name: input.guestName ?? null,
      room_number: input.roomNumber ?? null,
      description: input.description.slice(0, 2000),
      severity: mapComplaintSeverity(input.severity),
      status: 'open',
      created_by_name: input.byName.slice(0, 120),
      ...(input.category ? { category: input.category } : {}),
    })
    .select('id')
    .single();
  if (error) { log.error('createComplaintForComms failed', { err: error.message }); throw error; }
  return { id: data.id as string };
}

/** Best-effort current status of a room by number (for @Staxis). */
export async function getRoomStatus(pid: string, roomNumber: string): Promise<string | null> {
  try {
    // pms_* merge is the single source. "Current" = today's board.
    const rooms = await mergePmsRoomsForDate(pid, todayStr());
    const room = rooms.find((r) => r.number === roomNumber);
    if (!room) return null;
    // Review pass (fake-empty hunter #7) — the merge's catch-all default is
    // 'dirty' for rooms with NO status signal; stating it as fact in chat
    // would be a confident wrong claim. statusSource carries provenance.
    const parts = [
      room.statusSource === 'default'
        ? `Room ${room.number}: no recent status signal from the PMS yet`
        : `Room ${room.number}: status ${room.status ?? 'unknown'}`,
    ];
    if (room.type) parts.push(`type ${room.type}`);
    if (room.assignedName) parts.push(`assigned to ${room.assignedName}`);
    return parts.join(', ');
  } catch {
    return null;
  }
}

// ── Attachment presign (shared by both surfaces) ────────────────────────────

export async function presignAttachment(
  pid: string, conversationId: string, kind: 'photo' | 'voice', filename: string,
): Promise<{ path: string; signedUrl: string; token: string } | null> {
  const ext = (filename.split('.').pop() ?? (kind === 'voice' ? 'webm' : 'jpg')).toLowerCase().replace(/[^a-z0-9]/g, '');
  const photoExt = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
  const voiceExt = new Set(['webm', 'm4a', 'mp3', 'mp4', 'ogg', 'wav', 'aac']);
  const allowed = kind === 'voice' ? voiceExt : photoExt;
  const safeExt = allowed.has(ext) ? ext : (kind === 'voice' ? 'webm' : 'jpg');
  const key = `${pid}/comms/${conversationId}/${crypto.randomUUID()}.${safeExt}`;
  try {
    const { data, error } = await supabaseAdmin.storage.from(ATTACHMENT_BUCKET).createSignedUploadUrl(key);
    if (error || !data) return null;
    return { path: key, signedUrl: data.signedUrl, token: data.token };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Slack-Classic redesign: threads · pinned · ✓ reactions · members · presence ·
// search. All additive; reached only via /api/comms/* after a route auth check.
// ═══════════════════════════════════════════════════════════════════════════

/** ✓-reaction counts (+ whether the reader reacted) for a set of messages. */
async function reactionsFor(
  messageIds: string[], readerStaffId: string,
): Promise<Map<string, { count: number; mine: boolean }>> {
  const out = new Map<string, { count: number; mine: boolean }>();
  const ids = Array.from(new Set(messageIds.filter(Boolean)));
  if (ids.length === 0) return out;
  const { data } = await supabaseAdmin
    .from('comms_reactions')
    .select('message_id, staff_id')
    .eq('kind', 'ack')
    .in('message_id', ids);
  for (const r of (data ?? []) as { message_id: string; staff_id: string }[]) {
    const cur = out.get(r.message_id) ?? { count: 0, mine: false };
    cur.count += 1;
    if (r.staff_id === readerStaffId) cur.mine = true;
    out.set(r.message_id, cur);
  }
  return out;
}

/** Reply rollups (count / last-reply time / first 3 distinct authors) per parent. */
async function replyRollupsFor(
  parentIds: string[],
): Promise<Map<string, { count: number; lastAt: string | null; authorIds: string[] }>> {
  const out = new Map<string, { count: number; lastAt: string | null; authorIds: string[] }>();
  const ids = Array.from(new Set(parentIds.filter(Boolean)));
  if (ids.length === 0) return out;
  const { data } = await supabaseAdmin
    .from('comms_messages')
    .select('parent_message_id, sender_staff_id, created_at')
    .in('parent_message_id', ids)
    .order('created_at', { ascending: true });
  for (const r of (data ?? []) as { parent_message_id: string; sender_staff_id: string | null; created_at: string }[]) {
    const cur = out.get(r.parent_message_id) ?? { count: 0, lastAt: null, authorIds: [] };
    cur.count += 1;
    cur.lastAt = r.created_at; // ascending → last row wins
    if (r.sender_staff_id && !cur.authorIds.includes(r.sender_staff_id) && cur.authorIds.length < 3) {
      cur.authorIds.push(r.sender_staff_id);
    }
    out.set(r.parent_message_id, cur);
  }
  return out;
}

/**
 * Hydrate raw message rows into reader-facing DTOs (translation + names +
 * attachment URLs + ✓ reactions, optional reply rollups). Used by the thread
 * panel + pinned board; the main feed's getMessages has its own pass because it
 * also resolves the require-ack reachability window.
 */
async function hydrateMessages(
  pid: string, rows: MessageRow[], readerStaffId: string, readerLang: CommsLang,
  opts: { withReplies?: boolean } = {},
): Promise<MessageDTO[]> {
  if (rows.length === 0) return [];
  const translated = await translateMessagesForReader(
    rows.map((r) => ({ id: r.id, body: r.body, source_lang: r.source_lang })), readerLang,
  );
  const nameMap = await staffNameMap(pid, rows.map((r) => r.sender_staff_id).filter((x): x is string => !!x));
  const urlByPath = new Map<string, string>();
  for (const r of rows) {
    if (r.attachment_path && !urlByPath.has(r.attachment_path)) {
      const url = await attachmentSignedUrl(r.attachment_path);
      if (url) urlByPath.set(r.attachment_path, url);
    }
  }
  const ids = rows.map((r) => r.id);
  const reactionRollup = await reactionsFor(ids, readerStaffId);
  const replyRollup = opts.withReplies ? await replyRollupsFor(ids) : new Map();
  return rows.map((r) => {
    const original = r.body;
    const body = translated.get(r.id) ?? r.body;
    const mine = r.sender_staff_id === readerStaffId;
    return {
      id: r.id,
      conversationId: r.conversation_id,
      senderStaffId: r.sender_staff_id,
      senderKind: r.sender_kind as MessageDTO['senderKind'],
      senderName: r.sender_kind === 'staxis' ? 'Staxis' : (r.sender_staff_id ? (nameMap.get(r.sender_staff_id) ?? 'Teammate') : 'System'),
      body,
      originalBody: original,
      sourceLang: r.source_lang,
      wasTranslated: body !== original,
      msgType: r.msg_type as MessageDTO['msgType'],
      attachmentKind: (r.attachment_kind as 'photo' | 'voice' | null) ?? null,
      attachmentUrl: r.attachment_path ? (urlByPath.get(r.attachment_path) ?? null) : null,
      voiceDurationMs: r.voice_duration_ms,
      handoffShift: r.handoff_shift,
      handoffOutstanding: r.handoff_outstanding,
      meta: r.meta ?? {},
      createdAt: r.created_at,
      mine,
      requiresAck: !!r.requires_ack,
      acked: false,
      ackCampaignId: (r.ack_campaign_id as string | null) ?? null,
      parentMessageId: (r.parent_message_id as string | null) ?? null,
      replyCount: replyRollup.get(r.id)?.count ?? 0,
      lastReplyAt: replyRollup.get(r.id)?.lastAt ?? null,
      replyAuthorIds: replyRollup.get(r.id)?.authorIds ?? [],
      pinned: !!r.pinned_at,
      ackCount: reactionRollup.get(r.id)?.count ?? 0,
      ackedByMe: reactionRollup.get(r.id)?.mine ?? false,
    } satisfies MessageDTO;
  });
}

/** A message's conversation + property scope (for pin/react access checks). */
export async function getMessageScope(
  pid: string, messageId: string,
): Promise<{ id: string; conversationId: string } | null> {
  const { data } = await supabaseAdmin
    .from('comms_messages')
    .select('id, conversation_id')
    .eq('id', messageId)
    .eq('property_id', pid)
    .maybeSingle();
  return data ? { id: data.id as string, conversationId: data.conversation_id as string } : null;
}

/** The parent message + its threaded replies, translated for the reader. */
export async function getThreadReplies(
  pid: string, conversationId: string, parentId: string, readerStaffId: string, readerLang: CommsLang,
): Promise<{ parent: MessageDTO | null; replies: MessageDTO[] }> {
  const { data: pData } = await supabaseAdmin
    .from('comms_messages')
    .select(MESSAGE_COLUMNS)
    .eq('id', parentId)
    .eq('property_id', pid)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (!pData) return { parent: null, replies: [] };
  const { data: rData } = await supabaseAdmin
    .from('comms_messages')
    .select(MESSAGE_COLUMNS)
    .eq('property_id', pid)
    .eq('parent_message_id', parentId)
    .order('created_at', { ascending: true })
    .limit(200);
  const [parentArr, replies] = await Promise.all([
    hydrateMessages(pid, [pData as unknown as MessageRow], readerStaffId, readerLang, { withReplies: true }),
    hydrateMessages(pid, (rData ?? []) as unknown as MessageRow[], readerStaffId, readerLang),
  ]);
  return { parent: parentArr[0] ?? null, replies };
}

/** Pin / unpin a message to its channel's pinned board. */
export async function setPinned(
  pid: string, messageId: string, staffId: string, pinned: boolean,
): Promise<boolean> {
  const patch = pinned
    ? { pinned_at: new Date().toISOString(), pinned_by_staff_id: staffId }
    : { pinned_at: null, pinned_by_staff_id: null };
  const { data } = await supabaseAdmin
    .from('comms_messages')
    .update(patch)
    .eq('id', messageId)
    .eq('property_id', pid)
    .select('id')
    .maybeSingle();
  return !!data;
}

/** The pinned board for a conversation (newest pin first). */
export async function listPinned(
  pid: string, conversationId: string, readerStaffId: string, readerLang: CommsLang,
): Promise<MessageDTO[]> {
  const { data } = await supabaseAdmin
    .from('comms_messages')
    .select(MESSAGE_COLUMNS)
    .eq('property_id', pid)
    .eq('conversation_id', conversationId)
    .not('pinned_at', 'is', null)
    .order('pinned_at', { ascending: false })
    .limit(50);
  return hydrateMessages(pid, (data ?? []) as unknown as MessageRow[], readerStaffId, readerLang);
}

/**
 * Toggle the reader's ✓ acknowledgement reaction on a message. Idempotent via
 * the unique(message_id, staff_id, kind) constraint: a present row is removed
 * (toggle off), an absent one is inserted (toggle on).
 */
export async function toggleReaction(
  pid: string, messageId: string, staffId: string,
): Promise<{ acked: boolean; count: number }> {
  const ins = await supabaseAdmin
    .from('comms_reactions')
    .insert({ property_id: pid, message_id: messageId, staff_id: staffId, kind: 'ack' })
    .select('id')
    .maybeSingle();
  let acked: boolean;
  if (ins.error) {
    if ((ins.error as { code?: string }).code === '23505') {
      await supabaseAdmin
        .from('comms_reactions')
        .delete()
        .eq('message_id', messageId)
        .eq('staff_id', staffId)
        .eq('kind', 'ack');
      acked = false;
    } else {
      log.error('toggleReaction failed', { err: ins.error.message });
      throw ins.error;
    }
  } else {
    acked = true;
  }
  const { count } = await supabaseAdmin
    .from('comms_reactions')
    .select('id', { count: 'exact', head: true })
    .eq('message_id', messageId)
    .eq('kind', 'ack');
  return { acked, count: count ?? 0 };
}

// ── Presence (activity heartbeat → "on shift / online" dots) ─────────────────

/** Mark a staff member active now (called on every Communications poll). */
export async function touchPresence(pid: string, staffId: string): Promise<void> {
  await supabaseAdmin
    .from('comms_presence')
    .upsert({ property_id: pid, staff_id: staffId, last_seen_at: new Date().toISOString() }, { onConflict: 'property_id,staff_id' });
}

/** Set of staff seen within the freshness window (= currently "on shift"/online). */
export async function listOnlineStaff(pid: string): Promise<Set<string>> {
  const since = new Date(Date.now() - PRESENCE_WINDOW_MS).toISOString();
  const { data } = await supabaseAdmin
    .from('comms_presence')
    .select('staff_id')
    .eq('property_id', pid)
    .gte('last_seen_at', since);
  return new Set(((data ?? []) as { staff_id: string }[]).map((r) => r.staff_id));
}

// ── Members panel (roster + live presence) ──────────────────────────────────

/** The roster of a conversation with live presence, on-shift first. */
export async function listMembers(
  pid: string, convo: ConversationRow, readerStaffId: string,
): Promise<{ members: MemberDTO[]; memberCount: number }> {
  const online = await listOnlineStaff(pid);
  let staffRows: { id: string; name: string; department: string | null; is_active: boolean | null }[] = [];
  if (convo.kind === 'dm' && convo.dm_key) {
    const ids = convo.dm_key.split(':');
    const { data } = await supabaseAdmin
      .from('staff').select('id, name, department, is_active')
      .eq('property_id', pid).in('id', ids);
    staffRows = (data ?? []) as typeof staffRows;
  } else {
    const { data } = await supabaseAdmin
      .from('staff').select('id, name, department, is_active')
      .eq('property_id', pid).order('name', { ascending: true });
    staffRows = ((data ?? []) as typeof staffRows).filter((s) => s.is_active !== false);
    if (convo.kind === 'channel' && convo.channel_key) {
      staffRows = staffRows.filter((s) => staffInChannel(convo.channel_key as ChannelKey, commsDeptOf(s.department)));
    }
    // announcement → the whole active roster (everyone receives announcements)
  }
  const members: MemberDTO[] = staffRows.map((s) => ({
    staffId: s.id,
    name: s.name,
    department: s.department,
    dept: commsDeptOf(s.department),
    onShift: online.has(s.id),
    isMe: s.id === readerStaffId,
  }));
  members.sort((a, b) => (b.onShift ? 1 : 0) - (a.onShift ? 1 : 0) || a.name.localeCompare(b.name));
  return { members, memberCount: members.length };
}

// ── Search palette (channels · people · messages) ───────────────────────────

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Every top-level message with replies across the caller's visible conversations (Threads view). */
export interface ThreadSummary { conversationId: string; conversationTitle: string; dept: CommsDept; parent: MessageDTO }
export async function listThreads(
  pid: string, staffId: string, readerLang: CommsLang, ctx: { isManager: boolean; dept: string | null },
): Promise<ThreadSummary[]> {
  const convos = await listConversationsForStaff(pid, staffId, { ...ctx, floorMode: false });
  const convoIds = convos.map((c) => c.id);
  if (convoIds.length === 0) return [];
  const meta = new Map(convos.map((c) => [c.id, { title: c.title, dept: (c.dept ?? 'management') as CommsDept }] as const));

  const { data: parentIdRows } = await supabaseAdmin
    .from('comms_messages')
    .select('parent_message_id')
    .in('conversation_id', convoIds)
    .not('parent_message_id', 'is', null)
    .limit(2000);
  const parentIds = Array.from(new Set(((parentIdRows ?? []) as { parent_message_id: string }[]).map((r) => r.parent_message_id)));
  if (parentIds.length === 0) return [];

  const { data: parentRows } = await supabaseAdmin
    .from('comms_messages')
    .select(MESSAGE_COLUMNS)
    .in('id', parentIds)
    .order('created_at', { ascending: false })
    .limit(100);
  const hydrated = await hydrateMessages(pid, (parentRows ?? []) as unknown as MessageRow[], staffId, readerLang, { withReplies: true });
  return hydrated
    .map((m) => ({
      conversationId: m.conversationId,
      conversationTitle: meta.get(m.conversationId)?.title ?? '',
      dept: meta.get(m.conversationId)?.dept ?? 'management',
      parent: m,
    }))
    .sort((a, b) => (b.parent.lastReplyAt ?? '').localeCompare(a.parent.lastReplyAt ?? ''));
}

/** Jump-to / search across the caller's visible channels, the staff directory, and message bodies. */
export async function searchComms(
  pid: string, staffId: string, q: string, ctx: { isManager: boolean; dept: string | null },
): Promise<SearchHitDTO[]> {
  const convos = await listConversationsForStaff(pid, staffId, { ...ctx, floorMode: false });
  const ql = q.trim().toLowerCase();
  const hits: SearchHitDTO[] = [];

  // Channels + announcements (always shown; filtered by name when typing).
  for (const c of convos.filter((c) => c.kind !== 'dm')) {
    if (!ql || c.title.toLowerCase().includes(ql)) {
      hits.push({
        kind: 'channel', conversationId: c.id, staffId: null,
        title: c.title, subtitle: c.memberCount != null ? `${c.memberCount} members` : null,
        snippet: null, dept: c.dept ?? 'management',
      });
    }
  }

  // People (the staff directory).
  const staff = await listStaff(pid);
  for (const s of staff.filter((s) => s.id !== staffId)) {
    if (!ql || s.name.toLowerCase().includes(ql) || (s.department ?? '').toLowerCase().includes(ql)) {
      hits.push({
        kind: 'person', conversationId: null, staffId: s.id,
        title: s.name, subtitle: s.department, snippet: null, dept: commsDeptOf(s.department),
      });
    }
  }

  // Messages — only when there's a query, across conversations the caller can see.
  if (ql) {
    const convoIds = convos.map((c) => c.id);
    const titleById = new Map(convos.map((c) => [c.id, c.title] as const));
    const deptById = new Map(convos.map((c) => [c.id, c.dept ?? 'management'] as const));
    if (convoIds.length > 0) {
      const { data } = await supabaseAdmin
        .from('comms_messages')
        .select('id, conversation_id, sender_staff_id, body, created_at')
        .in('conversation_id', convoIds)
        .is('parent_message_id', null)
        .ilike('body', `%${escapeLike(ql)}%`)
        .order('created_at', { ascending: false })
        .limit(12);
      const rows = (data ?? []) as { id: string; conversation_id: string; sender_staff_id: string | null; body: string; created_at: string }[];
      const names = await staffNameMap(pid, rows.map((r) => r.sender_staff_id).filter((x): x is string => !!x));
      for (const r of rows) {
        const author = r.sender_staff_id ? (names.get(r.sender_staff_id) ?? 'Teammate') : 'System';
        hits.push({
          kind: 'message', conversationId: r.conversation_id, staffId: null,
          title: author,
          subtitle: `${titleById.get(r.conversation_id) ?? 'Conversation'}`,
          snippet: r.body.length > 140 ? r.body.slice(0, 140) + '…' : r.body,
          dept: deptById.get(r.conversation_id) ?? 'management',
        });
      }
    }
  }
  return hits;
}
