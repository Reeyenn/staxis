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
  /**
   * Require-ack announcements this person still has to confirm in this
   * conversation. Stays > 0 even after passive last_read_at clears `unread`,
   * so a mandatory read keeps demanding attention until it's acknowledged.
   * Only meaningful for the announcement feed; 0 elsewhere.
   */
  pendingAck?: number;
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
  // ── Require-acknowledgement (announcements only) ──────────────────────────
  /** true → this announcement demands an explicit "I read & understand". */
  requiresAck?: boolean;
  /** Whether the *reader* has already acknowledged it (drives button vs. ✓). */
  acked?: boolean;
  /** Set on the per-property copies of an org-wide mandatory-read campaign. */
  ackCampaignId?: string | null;
}

/** Live who-has / who-hasn't tracker for one require-ack announcement (manager view). */
export interface AckStatusDTO {
  messageId: string;
  requiresAck: boolean;
  total: number;                                  // staff expected to acknowledge
  acked: number;                                  // how many have
  ackedList: { staffId: string; name: string; at: string }[];
  pending: { staffId: string; name: string }[];   // who still hasn't
  campaignId?: string | null;
}

/** Aggregate completion of an org-wide mandatory-read campaign (across properties). */
export interface CampaignStatusDTO {
  campaignId: string;
  title: string | null;
  total: number;                                  // expected acks across all properties
  acked: number;                                  // received across all properties
  properties: {
    propertyId: string;
    propertyName: string;
    messageId: string | null;
    total: number;
    acked: number;
  }[];
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
