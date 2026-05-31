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
import { translateMessagesForReader } from './translate';
import type {
  ChannelKey, CommsLang, ConversationDTO, MessageDTO, TaskDTO, StaffLite,
} from './types';
import { CHANNEL_LABELS } from './types';

const ATTACHMENT_BUCKET = 'housekeeping-issue-photos'; // reuse existing private bucket
const SIGNED_URL_TTL = 60 * 60; // 1h read URLs

// ── Roles / departments ────────────────────────────────────────────────────

const MANAGER_ROLES = new Set(['admin', 'owner', 'general_manager']);
export function isManagerRole(role: string | null | undefined): boolean {
  return !!role && MANAGER_ROLES.has(role);
}

/** Map a staff.department value to its department channel (null = no dept channel). */
export function deptChannel(dept: string | null | undefined): ChannelKey | null {
  switch ((dept ?? '').toLowerCase()) {
    case 'front_desk': return 'front_desk';
    case 'maintenance': return 'maintenance';
    case 'housekeeping': return 'housekeeping';
    default: return null; // 'other' / unknown → all-staff only
  }
}

/** Channels a person can see. Managers see them all; staff see all-staff + their dept. */
export function channelsVisibleTo(opts: { dept: string | null; isManager: boolean }): ChannelKey[] {
  if (opts.isManager) return ['all_staff', 'front_desk', 'housekeeping', 'maintenance'];
  const out: ChannelKey[] = ['all_staff'];
  const dc = deptChannel(opts.dept);
  if (dc) out.push(dc);
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

/** Resolve an authenticated account → its staff identity + role for messaging. */
export async function resolveAccount(userId: string): Promise<{
  accountId: string; role: string; staffId: string | null; displayName: string;
  preferredLanguage: CommsLang;
} | null> {
  const { data } = await supabaseAdmin
    .from('accounts')
    .select('id, role, staff_id, display_name, preferred_language')
    .eq('data_user_id', userId)
    .maybeSingle();
  if (!data) return null;
  return {
    accountId: data.id as string,
    role: (data.role as string) ?? 'staff',
    staffId: (data.staff_id as string | null) ?? null,
    displayName: (data.display_name as string) ?? 'Manager',
    preferredLanguage: normalizeLang(data.preferred_language),
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
}

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
        .neq('sender_staff_id', staffId);
      if (lastRead) q = q.gt('created_at', lastRead);
      const { count } = await q;
      unread = count ?? 0;
    }

    let title = c.title ?? 'Conversation';
    let otherStaffId: string | null = null;
    if (c.kind === 'dm' && c.dmKey) {
      const [a, b] = c.dmKey.split(':');
      otherStaffId = a === staffId ? b : a;
      title = nameMap.get(otherStaffId) ?? 'Teammate';
    } else if (c.kind === 'announcement') {
      title = 'Announcements';
    } else if (c.kind === 'channel' && c.channelKey) {
      title = CHANNEL_LABELS[c.channelKey as ChannelKey] ?? c.channelKey;
    }

    out.push({
      id: c.id,
      kind: c.kind,
      channelKey: (c.channelKey as ConversationDTO['channelKey']) ?? null,
      title,
      lastMessageAt: c.lastAt,
      lastMessagePreview: lastMsg ? previewOf(lastMsg.body, lastMsg.msg_type) : null,
      unread,
      otherStaffId,
    });
  }

  // Sort: unread first, then most recent activity.
  out.sort((x, y) => {
    if ((y.unread > 0 ? 1 : 0) !== (x.unread > 0 ? 1 : 0)) return (y.unread > 0 ? 1 : 0) - (x.unread > 0 ? 1 : 0);
    return (y.lastMessageAt ?? '').localeCompare(x.lastMessageAt ?? '');
  });
  return out;
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
  return convos.reduce((sum, c) => sum + c.unread, 0);
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
    .select('id, conversation_id, sender_staff_id, sender_kind, body, source_lang, msg_type, attachment_path, attachment_kind, voice_duration_ms, handoff_shift, handoff_outstanding, meta, created_at')
    .eq('conversation_id', conversationId)
    .eq('property_id', pid)
    .order('created_at', { ascending: false })
    .limit(limit);
  const rows = ((data ?? []) as MessageRow[]).reverse(); // chronological
  if (rows.length === 0) return [];

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
      .neq('sender_staff_id', staffId)
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
  opts: { body: string; sourceLang: string; senderStaffId: string | null; senderAccountId: string | null; bodyEs?: string | null },
): Promise<{ id: string }> {
  const convoId = await ensureAnnouncementConversation(pid);
  const msg = await postMessage(pid, convoId, {
    senderStaffId: opts.senderStaffId,
    senderKind: 'staff',
    body: opts.body,
    sourceLang: opts.sourceLang,
    msgType: 'announcement',
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

// ── To-do list ──────────────────────────────────────────────────────────────

export async function createTask(
  pid: string,
  input: {
    title: string; notes?: string | null; assignedStaffId?: string | null;
    assignedDepartment?: string | null; dueAt?: string | null;
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
  return rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    notes: (r.notes as string | null) ?? null,
    assignedStaffId: (r.assigned_staff_id as string | null) ?? null,
    assignedStaffName: r.assigned_staff_id ? (nameMap.get(r.assigned_staff_id as string) ?? null) : null,
    assignedDepartment: (r.assigned_department as string | null) ?? null,
    dueAt: (r.due_at as string | null) ?? null,
    status: (r.status as 'open' | 'done'),
    createdByStaffId: (r.created_by_staff_id as string | null) ?? null,
    sourceMessageId: (r.source_message_id as string | null) ?? null,
    completedAt: (r.completed_at as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
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
    const { data } = await supabaseAdmin
      .from('rooms')
      .select('number, status, type, assigned_name, date')
      .eq('property_id', pid)
      .eq('number', roomNumber)
      .order('date', { ascending: false })
      .limit(1);
    const row = (data ?? [])[0] as { number: string; status: string | null; type: string | null; assigned_name: string | null } | undefined;
    if (!row) return null;
    const parts = [`Room ${row.number}: status ${row.status ?? 'unknown'}`];
    if (row.type) parts.push(`type ${row.type}`);
    if (row.assigned_name) parts.push(`assigned to ${row.assigned_name}`);
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
