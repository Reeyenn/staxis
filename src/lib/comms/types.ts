// ═══════════════════════════════════════════════════════════════════════════
// Communications — shared types (server + client).
// ═══════════════════════════════════════════════════════════════════════════

import type { HousekeeperLocale } from '@/lib/translations';

/** The app-wide language a user can choose. Mirrors HousekeeperLocale. */
export type CommsLang = HousekeeperLocale; // 'en' | 'es' | 'ht' | 'tl' | 'vi'

export type ConversationKind = 'dm' | 'channel' | 'announcement';
export type ChannelKey = 'front_desk' | 'housekeeping' | 'maintenance' | 'all_staff';
export type MessageType =
  | 'text' | 'announcement' | 'handoff' | 'photo' | 'voice' | 'task' | 'system';
export type SenderKind = 'staff' | 'staxis' | 'system';

/** The four department channels, in display order. */
export const CHANNELS: readonly ChannelKey[] = [
  'all_staff', 'front_desk', 'housekeeping', 'maintenance',
];

/** English display labels for channels (translated client-side via t()/auto). */
export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  all_staff: 'All Staff',
  front_desk: 'Front Desk',
  housekeeping: 'Housekeeping',
  maintenance: 'Maintenance',
};

/** A conversation as returned to the client. */
export interface ConversationDTO {
  id: string;
  kind: ConversationKind;
  channelKey: ChannelKey | 'announcements' | null;
  title: string;            // resolved display title (other person / channel name / "Announcements")
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unread: number;
  /** For DMs: the other participant's staff id + name. */
  otherStaffId?: string | null;
}

/** A message as returned to the client (already translated into the reader's lang). */
export interface MessageDTO {
  id: string;
  conversationId: string;
  senderStaffId: string | null;
  senderKind: SenderKind;
  senderName: string;       // resolved display name ("Staxis" for assistant)
  body: string;             // translated into the reader's language
  originalBody: string;     // the message as originally written
  sourceLang: string | null;
  wasTranslated: boolean;   // true when body !== originalBody (UI offers "see original")
  msgType: MessageType;
  attachmentKind: 'photo' | 'voice' | null;
  attachmentUrl: string | null;  // short-lived signed URL (null if none)
  voiceDurationMs: number | null;
  handoffShift: string | null;
  handoffOutstanding: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
  mine: boolean;
  /** For the sender's own messages: who has seen it (read receipts). */
  seenBy?: { staffId: string; name: string }[];
}

/** A to-do item. */
export interface TaskDTO {
  id: string;
  title: string;
  notes: string | null;
  assignedStaffId: string | null;
  assignedStaffName: string | null;
  assignedDepartment: string | null;
  dueAt: string | null;
  status: 'open' | 'done';
  createdByStaffId: string | null;
  sourceMessageId: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** A staff entry for the directory / DM picker. */
export interface StaffLite {
  id: string;
  name: string;
  department: string | null;
  channel: ChannelKey;  // the department channel they belong to
}
