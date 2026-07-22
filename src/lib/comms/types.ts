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
  /** Department tint key for the Slack-style UI (channel colour / dept dot). */
  dept?: CommsDept;
  /** How many staff are in this conversation (header "N members" + members chip). */
  memberCount?: number;
}

/** Department buckets used purely for colour-coding the Slack-style UI. */
export type CommsDept = 'management' | 'front_desk' | 'housekeeping' | 'maintenance' | 'laundry';

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
  /** true → this announcement demands an explicit "I read & understand" (intrinsic flag; drives the manager tracker). */
  requiresAck?: boolean;
  /**
   * true → THIS reader actually owes an acknowledgement (a recipient: not the
   * author, employed when it was posted). Drives the recipient button. Separate
   * from requiresAck so a new hire isn't prompted for a pre-tenure read whose ack
   * the tracker would ignore anyway.
   */
  mustAck?: boolean;
  /** Whether the *reader* has already acknowledged it (drives button vs. ✓). */
  acked?: boolean;
  /** Set on the per-property copies of an org-wide mandatory-read campaign. */
  ackCampaignId?: string | null;
  // ── Slack-style threading / pinning / reactions ───────────────────────────
  /** null = top-level (shown in the main pane). Non-null = a reply (thread only). */
  parentMessageId?: string | null;
  /** Top-level only: how many threaded replies hang off this message. */
  replyCount?: number;
  /** Top-level only: timestamp of the most recent reply (for "Last reply …"). */
  lastReplyAt?: string | null;
  /** Top-level only: distinct reply-author staff ids (for the avatar stack), capped. */
  replyAuthorIds?: string[];
  /** Whether this message is pinned to the channel's pinned board. */
  pinned?: boolean;
  /** Count of ✓ acknowledgement reactions on this message. */
  ackCount?: number;
  /** Whether the reader has added their own ✓ acknowledgement reaction. */
  ackedByMe?: boolean;
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
  priority: 'normal' | 'high' | 'urgent';
  createdByStaffId: string | null;
  sourceMessageId: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** A Shift Log Book recap (titled free-text handoff, scoped per property). */
export interface LogEntryDTO {
  id: string;
  title: string;
  body: string;
  /** front_desk | housekeeping | maintenance | general — nullable. */
  category: string | null;
  authorStaffId: string | null;
  authorName: string | null;   // resolved via the staffNameMap join
  replyCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A threaded reply to a Shift Log Book recap. */
export interface LogReplyDTO {
  id: string;
  entryId: string;
  body: string;
  authorStaffId: string | null;
  authorName: string | null;   // resolved via the staffNameMap join
  createdAt: string;
}

/** A staff entry for the directory / DM picker. */
export interface StaffLite {
  id: string;
  name: string;
  department: string | null;
  channel: ChannelKey;  // the department channel they belong to
}

/** A member of a conversation, with live presence (members panel). */
export interface MemberDTO {
  staffId: string;
  name: string;
  department: string | null;
  dept: CommsDept;       // colour bucket
  onShift: boolean;      // online = activity heartbeat within the freshness window
  isMe: boolean;
}

/** A search hit (channels / people / messages palette). */
export interface SearchHitDTO {
  kind: 'channel' | 'person' | 'message';
  conversationId: string | null;   // where "jump" lands
  staffId: string | null;          // for people
  title: string;                   // channel name / person name / author name
  subtitle: string | null;         // member count / role / "in #channel · time"
  snippet: string | null;          // message body excerpt
  dept: CommsDept;
}
