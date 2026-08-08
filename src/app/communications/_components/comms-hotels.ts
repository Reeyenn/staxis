import type { Property } from '@/types';
import type { BootstrapData } from './comms-types-fe';
import type { ConversationDTO } from '@/lib/comms/types';

/** The value used by the hotel select for the aggregate view. */
export const ALL_HOTELS_FILTER = '__all_hotels__' as const;

export interface HotelScopeOption {
  propertyId: string;
  propertyName: string;
}

export interface HotelBootstrap {
  propertyId: string;
  propertyName: string;
  data: BootstrapData;
}

export type HotelConversation = ConversationDTO & {
  propertyId: string;
  propertyName: string;
};

/**
 * Return the exact hotel ids minted by PropertyContext's current scope.
 *
 * Company scope is already resolved from the server's authoritative receipt;
 * hotel scope intentionally stays one-property. `properties` supplies labels
 * only and is intersected here so a stale/missing property row cannot create a
 * new scope on the client.
 */
export function hotelScopeOptions(input: {
  activePropertyId: string | null;
  activeScope: { kind: string; propertyId?: string; scope?: { propertyIds: readonly string[] } };
  properties: Property[];
}): HotelScopeOption[] {
  const ids = input.activeScope.kind === 'company'
    ? input.activeScope.scope?.propertyIds ?? []
    : input.activeScope.kind === 'hotel' && input.activePropertyId
      ? [input.activePropertyId]
      : [];
  const byId = new Map(input.properties.map((property) => [property.id, property] as const));
  return ids
    .filter((id, index) => ids.indexOf(id) === index)
    .map((propertyId) => {
      const property = byId.get(propertyId);
      return property ? { propertyId, propertyName: property.name } : null;
    })
    .filter((option): option is HotelScopeOption => option !== null);
}

/** Attach server-returned hotel identity to every sidebar conversation. */
export function conversationsWithHotelContext(bootstrap: HotelBootstrap): HotelConversation[] {
  return bootstrap.data.conversations.map((conversation) => ({
    ...conversation,
    propertyId: bootstrap.propertyId,
    propertyName: bootstrap.propertyName,
  }));
}

export function hotelConversationKey(propertyId: string, conversationId: string): string {
  return `${propertyId}\u0000${conversationId}`;
}

export function visibleHotelConversations(
  conversations: HotelConversation[],
  filter: string,
): HotelConversation[] {
  return filter === ALL_HOTELS_FILTER
    ? conversations
    : conversations.filter((conversation) => conversation.propertyId === filter);
}

/**
 * Resolve the hotel for an interaction that must call a pid-scoped endpoint.
 *
 * A specific hotel filter is already an explicit choice. In All hotels mode,
 * only the selected conversation supplies a safe pid; with neither choice the
 * caller must ask the person to choose a hotel instead of guessing.
 */
export function resolveHotelActionPropertyId(input: {
  selectedPropertyId: string | null;
  hotelFilter: string;
  availablePropertyIds: readonly string[];
}): string | null {
  const available = Array.from(new Set(input.availablePropertyIds));
  if (input.hotelFilter !== ALL_HOTELS_FILTER) {
    return input.hotelFilter && available.includes(input.hotelFilter) ? input.hotelFilter : null;
  }
  if (input.selectedPropertyId && available.includes(input.selectedPropertyId)) return input.selectedPropertyId;
  return available.length === 1 ? available[0] : null;
}

/** Hotel labels are useful only when the visible view actually spans hotels. */
export function shouldShowHotelContext(input: {
  hotelFilter: string;
  availablePropertyIds: readonly string[];
}): boolean {
  return input.hotelFilter === ALL_HOTELS_FILTER
    && new Set(input.availablePropertyIds).size > 1;
}

/** Preserve the bootstrap's attention-first ordering across hotel buckets. */
export function sortHotelConversations(conversations: HotelConversation[]): HotelConversation[] {
  return conversations.slice().sort((left, right) => {
    const leftAttention = left.unread > 0 || (left.pendingAck ?? 0) > 0 ? 1 : 0;
    const rightAttention = right.unread > 0 || (right.pendingAck ?? 0) > 0 ? 1 : 0;
    if (leftAttention !== rightAttention) return rightAttention - leftAttention;
    return (right.lastMessageAt ?? '').localeCompare(left.lastMessageAt ?? '');
  });
}
