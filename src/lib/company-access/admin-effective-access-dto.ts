import type { AppRole } from '@/lib/roles';

export type AdminEffectiveAccessTarget =
  | { kind: 'hotel'; id: string; name: string; organizationId: string | null }
  | { kind: 'organization'; id: string; name: string; organizationId: string };

export interface AdminAccessHotelCoverage {
  id: string;
  name: string;
}

export type AdminAccessMutationKind = 'legacy_hotel' | 'membership_hat' | 'read_only';

export interface AdminEffectiveAccessRow {
  id: string;
  accountId: string;
  displayName: string;
  accountRole: AppRole;
  profile: string;
  role: string;
  scopeType: string;
  scopeLabel: string;
  hotels: AdminAccessHotelCoverage[];
  hotelAiEntitled: boolean;
  portfolioAiEntitled: boolean;
  financialHotels: AdminAccessHotelCoverage[];
  source: string;
  status: string;
  startsAt: string | null;
  expiresAt: string | null;
  mutation: {
    kind: AdminAccessMutationKind;
    allowed: boolean;
    label: string;
    hotelId: string | null;
    membershipId: string | null;
  };
}

export interface AdminEffectiveAccessAiControl {
  hotelFeature: {
    key: 'agent.ask_staxis';
    enabled: boolean;
  };
  portfolioFeature: {
    key: 'agent.portfolio_chat';
    enabled: boolean;
  };
  companySetting: {
    key: 'cross_hotel_ai_chat';
    organizationId: string;
    enabled: boolean;
    mutable: boolean;
  } | null;
}

export interface AdminEffectiveAccessData {
  target: AdminEffectiveAccessTarget;
  generatedAt: string;
  rows: AdminEffectiveAccessRow[];
  aiControl: AdminEffectiveAccessAiControl;
}
