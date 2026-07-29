// Front-end-only shared types for the Communications tab.
import type { ConversationDTO, StaffLite } from '@/lib/comms/types';

export type ViewMode = 'chats' | 'todo' | 'logbook';
export type RightPanel = null | 'pinned' | 'members';
/** The two views inside the To-do destination. Calendar has no nav item of its own. */
export type TodoView = 'list' | 'calendar';

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
