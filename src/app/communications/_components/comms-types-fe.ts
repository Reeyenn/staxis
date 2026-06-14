// Front-end-only shared types for the Communications tab.
import type { ConversationDTO, StaffLite } from '@/lib/comms/types';

export type ViewMode = 'chats' | 'threads' | 'todo' | 'knowledge' | 'logbook';
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

/** Bilingual helper: pick English or Spanish copy. */
export type L = (en: string, es: string) => string;
