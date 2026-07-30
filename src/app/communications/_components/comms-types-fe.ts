// Front-end-only shared types for the Communications tab.
import type { ConversationDTO, StaffLite } from '@/lib/comms/types';

/**
 * Communications is Messages. To-do and the Log book left for the Staxis list
 * on 2026-07-30, so there is one view. Kept as a named type rather than
 * inlined: the shell still branches on it, and narrowing it here is what makes
 * a stray setMode('todo') a compile error instead of a blank pane.
 */
export type ViewMode = 'chats';
export type RightPanel = null | 'pinned' | 'members';

export interface Me {
  staffId: string;
  role: string;
  isManager: boolean;
  dept: string | null;
  lang: string;
  displayName: string;
  canOrgWide?: boolean;
}

export interface BootstrapData {
  me: Me;
  conversations: ConversationDTO[];
  staff: StaffLite[];
  unreadTotal: number;
  onlineStaffIds: string[];
}

/** English UI-copy helper shared by Communications components. */
export type L = (english: string) => string;
